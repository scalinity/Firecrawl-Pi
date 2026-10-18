// Provider availability (docs/FIRECRAWL_PI_SEARCH_INTELLIGENCE_SPEC.md §15, §16): an account's condition, kept apart from the
// service breaker, the call's outcome and its ledger settlement. Quota exhausted, rate limited, authentication failed and a
// held contract each stop new dispatch to that provider alone and survive a restart (provider_availability); none of them
// touches the breaker, which stays a judgment of service health. Recovery follows what is known:
//   - a documented reset (Retry-After, Brave's window reset, a provider's reset header) re-admits at that time, the next
//     ordinary search being the probe;
//   - a transient throttle with no reset gets an estimated 30 s cooldown, labelled estimated;
//   - quota or authentication with no documented reset waits for a new credential (a new epoch) or an operator re-enable:
//     nothing polls a paid search to discover a top-up;
//   - three identical contract failures in a row hold the adapter 15 minutes, then one ordinary probe.
import { createHash } from "node:crypto";

export const ESTIMATED_COOLDOWN_MS = 30000, CONTRACT_HOLD_MS = 15 * 60000, CONTRACT_HOLD_AFTER = 3;
export const credentialEpoch = (value) => (value ? createHash("sha256").update(`fcpi.si.epoch:${value}`).digest("hex").slice(0, 16) : null);

// Retry-After: delta seconds or an HTTP date. Null when absent or malformed.
export function parseRetryAfter(value, now = Date.now()) {
  if (typeof value !== "string" || !value.trim()) return null;
  if (/^\d{1,7}$/.test(value.trim())) return now + Number(value.trim()) * 1000;
  const t = Date.parse(value);
  return Number.isFinite(t) && /[a-z]/i.test(value) ? t : null;
}

// Brave's aligned rate-limit lists (X-RateLimit-Limit/Policy/Remaining/Reset; reset in RELATIVE seconds). Only exhausted
// windows count; a window of a day or longer exhausted is the plan's allowance (quota), a shorter one a burst limit. With
// both exhausted, the classification is quota and the retry waits for every exhausted window. Malformed or misaligned
// headers say nothing (null): no balance or time is invented.
export function parseBraveRateHeaders(headers, now = Date.now()) {
  const list = (h) => (typeof headers?.[h] === "string" ? headers[h].split(",").map((s) => s.trim()) : null);
  const limit = list("x-ratelimit-limit"), policy = list("x-ratelimit-policy"), remaining = list("x-ratelimit-remaining"), reset = list("x-ratelimit-reset");
  if (!limit || !policy || !remaining || !reset) return null;
  const n = limit.length;
  if (![policy.length, remaining.length, reset.length].every((x) => x === n)) return null;
  const windows = [];
  for (let i = 0; i < n; i++) {
    const w = /^(\d+);w=(\d+)$/.exec(policy[i]);
    if (!w || !/^\d+$/.test(limit[i]) || !/^\d+$/.test(remaining[i]) || !/^\d+$/.test(reset[i]) || Number(w[1]) !== Number(limit[i])) return null;
    windows.push({ limit: Number(limit[i]), windowS: Number(w[2]), remaining: Number(remaining[i]), resetS: Number(reset[i]) });
  }
  // A window with a limit of 0 sets no allowance: live Brave reports its monthly window as 0;w=2678400 with 0 remaining on a
  // successful call (SI5 live contract smoke, 2026-10-18), so it can never be the window a refusal exhausted.
  const exhausted = windows.filter((x) => x.limit > 0 && x.remaining === 0);
  if (!exhausted.length) return { windows, exhausted: [], state: null, retryAt: null };
  const quota = exhausted.some((x) => x.windowS >= 86400);
  // A reset beyond a monthly window's span (35 days) is held to it, never trusted to park the provider indefinitely.
  return { windows, exhausted, state: quota ? "quota_exhausted" : "rate_limited", retryAt: now + Math.min(Math.max(...exhausted.map((x) => x.resetS)), 35 * 86400) * 1000 };
}

// The manager: reads the rows once per search, keeps the last good read if the database read fails (a database outage stops
// the ledger anyway), and records each transition, which the telemetry hook persists as an event.
export function makeAvailability({ store, log = () => {}, clock = Date.now, onTransition = () => {} }) {
  let rows = new Map(), loadedAt = 0;
  // Writes by sequence, and those still in flight: a read that started before a write cannot replace the row it wrote.
  let writes = 0;
  const lastWrite = new Map(), inFlight = new Map();
  const key = (provider, profile = "default") => `${provider}|${profile}`;
  async function refresh() {
    const seq = writes;
    try {
      const next = new Map((await store.availabilityRows()).map((r) => [key(r.provider, r.profile), r]));
      for (const [k, r] of rows) if (inFlight.has(k) || (lastWrite.get(k) ?? 0) > seq) next.set(k, r);
      rows = next;
      loadedAt = clock();
    }
    catch (e) { log({ event: "availability_read_failed", error: e.code ?? e.message }); }
    return rows;
  }
  // Whether a provider may be dispatched now: { eligible: true, probe } or { eligible: false, reason, retryAt }.
  function check(provider, epoch, now = clock()) {
    const r = rows.get(key(provider));
    if (!r || r.state === "available") return { eligible: true, probe: false };
    const retryAt = r.retry_at ? new Date(r.retry_at).getTime() : null;
    const newEpoch = epoch && r.credential_epoch && epoch !== r.credential_epoch;
    switch (r.state) {
      case "rate_limited": return retryAt !== null && now < retryAt ? { eligible: false, reason: "rate_limited", retryAt, basis: r.retry_basis } : { eligible: true, probe: true };
      case "quota_exhausted": return newEpoch || (retryAt !== null && now >= retryAt) ? { eligible: true, probe: true } : { eligible: false, reason: "quota_exhausted", retryAt, basis: r.retry_basis };
      case "auth_failed": return newEpoch ? { eligible: true, probe: true } : { eligible: false, reason: "auth_failed", retryAt: null, basis: "unknown" };
      case "contract_hold": return retryAt !== null && now >= retryAt ? { eligible: true, probe: true } : { eligible: false, reason: "contract_failure", retryAt, basis: "estimated" };
      default: return { eligible: true, probe: false };
    }
  }
  async function set(provider, next, why) {
    const prior = rows.get(key(provider));
    const row = { provider, profile: "default", ...next };
    const k = key(provider);
    rows.set(k, { ...prior, provider, profile: "default", state: next.state, reason: next.reason ?? null, provider_code: next.providerCode ?? null, retry_at: next.retryAt ? new Date(next.retryAt) : null,
      retry_basis: next.retryBasis ?? "unknown", credential_epoch: next.credentialEpoch ?? null, contract_failures: next.contractFailures ?? 0, observed_at: new Date(clock()) });
    lastWrite.set(k, ++writes);
    inFlight.set(k, (inFlight.get(k) ?? 0) + 1);
    // A provider with no row is available: a first write that keeps it available is no transition.
    if ((prior?.state ?? "available") !== next.state) onTransition({ provider, from: prior?.state ?? "available", to: next.state, reason: next.reason ?? why, retryAt: next.retryAt ?? null, retryBasis: next.retryBasis ?? "unknown" });
    try { await store.setAvailability({ ...row, retryAt: next.retryAt ? new Date(next.retryAt) : null }); }
    catch (e) { log({ event: "availability_write_failed", provider, error: e.code ?? e.message }); }
    finally { const n = inFlight.get(k) - 1; if (n) inFlight.set(k, n); else inFlight.delete(k); }
  }
  // What a dispatched call taught about the account. outcome: { reason, retryAt?, retryBasis?, providerCode? } or a success,
  // { success: true, dispatchedAt } (ISO or ms): a call dispatched before the current refusal was observed proves nothing about it.
  async function observe(provider, epoch, result, now = clock()) {
    const prior = rows.get(key(provider));
    if (result.success) {
      const at = result.dispatchedAt == null ? null : new Date(result.dispatchedAt).getTime();
      if (prior?.observed_at && at !== null && new Date(prior.observed_at).getTime() > at) return;
      if (prior && (prior.state !== "available" || prior.contract_failures)) await set(provider, { state: "available", credentialEpoch: epoch, reason: "observed_success" }, "observed_success");
      return;
    }
    switch (result.reason) {
      case "quota_exhausted": return set(provider, { state: "quota_exhausted", reason: result.detail ?? "quota_exhausted", providerCode: result.providerCode, retryAt: result.retryAt ?? null, retryBasis: result.retryAt ? (result.retryBasis ?? "documented") : "unknown", credentialEpoch: epoch });
      case "rate_limited": {
        const retryAt = result.retryAt ?? now + ESTIMATED_COOLDOWN_MS;
        return set(provider, { state: "rate_limited", reason: result.detail ?? "rate_limited", providerCode: result.providerCode, retryAt, retryBasis: result.retryAt ? (result.retryBasis ?? "documented") : "estimated", credentialEpoch: epoch });
      }
      case "auth_failed": return set(provider, { state: "auth_failed", reason: result.detail ?? "auth_failed", providerCode: result.providerCode, credentialEpoch: epoch });
      case "contract_failure": {
        // Only a repeated, identical wire failure holds the adapter; a request-specific refusal (unsupported_request) never does.
        const same = prior?.provider_code === (result.providerCode ?? null);
        const n = (same ? prior?.contract_failures ?? 0 : 0) + 1;
        return n >= CONTRACT_HOLD_AFTER ? set(provider, { state: "contract_hold", reason: result.detail ?? "repeated contract failure", providerCode: result.providerCode, retryAt: now + CONTRACT_HOLD_MS, retryBasis: "estimated", credentialEpoch: epoch, contractFailures: n })
          : set(provider, { state: prior?.state === "contract_hold" ? "contract_hold" : "available", providerCode: result.providerCode ?? null, credentialEpoch: epoch, contractFailures: n, retryAt: prior?.retry_at ?? null, retryBasis: prior?.retry_basis ?? "unknown" });
      }
      default: return undefined;
    }
  }
  // An operator's explicit re-enable (spec §16.3): the next ordinary search is the one probe.
  async function reenable(provider) { await set(provider, { state: "available", reason: "operator_reenable" }, "operator_reenable"); }
  return { refresh, check, observe, reenable, rows: () => [...rows.values()], loadedAt: () => loadedAt };
}
