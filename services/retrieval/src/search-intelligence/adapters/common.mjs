// The metered dispatch every search, documentation and decision adapter shares (docs/FIRECRAWL_PI_SEARCH_INTELLIGENCE_SPEC.md
// §8.2, §15, §18). One operation is: eligibility, a reservation under its stable call key, the outbound permit (and a
// provider's rate token), a last authority check, the send under the search's absolute deadline, then exactly one closing
// of the reservation. What the closing is follows what is known:
//   released   never sent, or refused by the provider in a way its documentation says is not billed;
//   settled    answered: at the measured or documented amount (zero for a documented free outcome);
//   uncertain  possibly sent and no answer: the reservation stays whole and is never resent.
// The breaker judges service health only: quota, rate limits, authentication, a request the provider cannot represent and
// contract failures never trip it (they go to availability.mjs); a probe that ends without a verdict returns its slot.
import { randomUUID } from "node:crypto";
import { Breaker, periodStarts, rateCardFor, paidDispatchActive } from "../../budget.mjs";
import { providerRequest } from "../../provider.mjs";
import { credentialEpoch } from "../availability.mjs";

const FIXTURE = /\.fixture\.fcpi\.test$/;

export function makeDispatch({ store, getBudget, getPolicy, resolvePublic, lookupFixture, readKey, paidDispatch, permits, availability, request = providerRequest, log = () => {} }) {
  const breakers = new Map();
  const breakerFor = (provider) => breakers.get(provider) ?? breakers.set(provider, new Breaker(getBudget().breaker)).get(provider);
  // Ledger closings that failed (spec §18.2: recorded as an operational accounting failure, never reported as zero cost).
  let accountingFailures = 0;
  // Reservations not yet closed, by the lane that opened them (its preflight object): what an adapter leaves open when it
  // ends, by a throw or an oversight, is marked uncertain at once rather than waiting for the next start's sweep.
  const openBy = new WeakMap();

  // A subject of one of the budget policy's maps (searches, documentationSearches, decisions), or null when it is not listed.
  function subject(map, name) {
    const b = getBudget(), s = b[map]?.[name];
    if (!s) return null;
    const prov = b.providers[s.provider];
    return { name, map, provider: s.provider, prov, category: s.category, cat: b.categories[s.category], card: rateCardFor(b, name), model: s.model ?? null, fixture: FIXTURE.test(new URL(prov.baseUrl).hostname) };
  }

  // Whether the subject may be dispatched now (spec §15): { eligible, key, epoch, probe } or { eligible: false, reason, detail, retryAt }.
  // breakerState, when given, is the provider's own breaker (Serper keeps its accepted one in serper.mjs).
  function preflight(sub, { selection, breakerState = null }) {
    if (!sub) return { eligible: false, reason: "not_configured", detail: "subject_not_listed" };
    // A fixture selection never reaches a live provider, and a live one never a fixture (spec §19.2: fixture fences).
    if ((selection === "fixture") !== sub.fixture) return { eligible: false, reason: "platform_restricted", detail: selection === "fixture" ? "fixture_selection" : "fixture_provider_on_live_selection" };
    if (!sub.card) return { eligible: false, reason: "platform_restricted", detail: "rate_card_missing" };
    const key = sub.prov.credential ? readKey(sub.prov.credential) : sub.fixture ? "fixture-credential" : null;
    if (!key) return { eligible: false, reason: "not_configured", detail: "credential_absent" };
    const b = getBudget();
    if (sub.prov.paid && !paidDispatchActive(b, paidDispatch)) return { eligible: false, reason: "platform_restricted", detail: "paid_dispatch_disabled" };
    // An existing shared monetary cap is evaluated only in micro-USD: a unit without a stated valuation cannot be weighed against
    // it, so it is refused rather than converted by assertion (spec §18.1). No cap, no restriction.
    if (sub.prov.paid && b.paidTotal.caps.day !== undefined && sub.cat.unit !== "micro_usd" && !(sub.card.microUsdPerCredit || sub.card.microUsdPerRequest)) return { eligible: false, reason: "platform_restricted", detail: "valuation_unavailable" };
    const epoch = credentialEpoch(key);
    const avail = availability.check(sub.provider, epoch);
    if (!avail.eligible) return { eligible: false, reason: avail.reason, detail: `availability:${avail.reason}`, retryAt: avail.retryAt ?? null, retryBasis: avail.basis ?? null };
    const br = breakerFor(sub.provider);
    if ((breakerState ? breakerState(sub.provider) : br.state()) === "open") return { eligible: false, reason: "breaker_open", detail: "breaker_open", retryAt: breakerState ? null : Date.now() + br.retryAfterS() * 1000 };
    return { eligible: true, key, epoch, probe: avail.probe };
  }

  // The verdict a call's answer gives the provider's service and account. call() has already judged the breaker for a result it
  // returns ok:false (answered: false): reporting that result again only informs availability, so one call is one verdict and a
  // sibling refused at a half-open breaker never returns the probe's slot.
  async function report(sub, epoch, result, { answered = true } = {}) {
    const br = breakerFor(sub.provider);
    if (result.success) { br.success(); await availability.observe(sub.provider, epoch, { success: true, dispatchedAt: result.dispatchedAt ?? null }); return; }
    if (answered) {
      if (["timeout", "temporarily_unavailable"].includes(result.reason)) br.failure();
      else br.neutral();
    }
    if (["quota_exhausted", "rate_limited", "auth_failed", "contract_failure"].includes(result.reason)) await availability.observe(sub.provider, epoch, result);
  }

  // A reservation's one closing; each method acts once and swallows nothing silently: a ledger failure is logged and counted,
  // and the reservation stays durable (RESERVED, swept to UNCERTAIN at the next start), never reported as zero.
  function closer(reservation, sub, owner = null) {
    let closed = false;
    const self = {};
    const once = (fn, what) => async (...args) => {
      if (closed) return null;
      closed = true;
      if (owner) openBy.get(owner)?.delete(self);
      try { return await fn(...args); }
      catch (e) { log({ event: "si_accounting_failed", provider: sub.provider, subject: sub.name, step: what, error: e.code ?? e.message }); accountingFailures++; return null; }
    };
    Object.assign(self, {
      settle: once((actual, fields = {}) => store.settleBudget(reservation.id, actual, fields), "settle"),
      release: once((detail) => store.releaseBudget(reservation.id, detail), "release"),
      uncertain: once((detail, usage = null) => store.markBudgetUncertain(reservation.id, detail, usage), "uncertain"),
      get closed() { return closed; }, reservation,
    });
    if (owner) { if (!openBy.has(owner)) openBy.set(owner, new Set()); openBy.get(owner).add(self); }
    return self;
  }

  // Marks every reservation the owner left open as uncertain (its call may have been sent); returns how many there were.
  async function closeUnclosed(owner, detail) {
    const open = owner ? [...(openBy.get(owner) ?? [])] : [];
    for (const c of open) await c.uncertain(detail);
    return open.length;
  }

  const reasonOfTransport = (e) => e.code === "CANCELLED" ? "cancelled" : e.capacity ? "capacity_unavailable" : e.timedOut ? "timeout" : e.code === "PAID_DISPATCH_DISABLED" ? "platform_restricted"
    : e.code === "PROVIDER_RESPONSE_TOO_LARGE" ? "contract_failure" : "temporarily_unavailable";

  // One metered HTTP operation. Returns { ok: true, response, close, queueMs, startedAt } for an answer (the caller parses it and
  // closes the reservation), or { ok: false, reason, detail, dispatchState, queueMs } with the reservation already closed.
  async function call({ sub, pre, kind, callKey, logicalId, searchId, requestHash, amount, signal, deadlineAt, timeoutMs, maxBytes, http, rate = null }) {
    const t0 = Date.now();
    const b = getBudget();
    const br = breakerFor(sub.provider);
    if (!br.admit()) return { ok: false, reason: "breaker_open", detail: "breaker_open", dispatchState: "not_sent", queueMs: 0 };
    // A shared monetary cap is weighed only in micro-USD: with no stated valuation for this unit the call is refused, never
    // counted at an assumed one micro-USD per unit (spec §18.1). Preflight refuses it first; the budget can reload in between.
    const paidTotalCap = sub.prov.paid ? (b.paidTotal.caps.day ?? null) : null;
    const paidTotalRate = sub.cat.unit === "micro_usd" ? 1 : (sub.card.microUsdPerCredit ?? sub.card.microUsdPerRequest ?? null);
    if (paidTotalCap !== null && paidTotalRate === null) { br.neutral(); return { ok: false, reason: "platform_restricted", detail: "valuation_unavailable", dispatchState: "not_sent", queueMs: 0 }; }
    let r;
    try {
      const { day, month } = periodStarts();
      r = await store.reserveBudget({ id: randomUUID(), callKey, logicalId, category: sub.category, provider: sub.provider, subject: sub.name, kind, unit: sub.cat.unit, rateCard: sub.card.id,
        requestHash, amount, day, month, caps: sub.cat.caps, reportingPeriods: ["day", "month"], paidTotalCap, paidTotalRate,
        notifyAt: b.notifyAtFraction });
    } catch (e) {
      // No reservation, no dispatch: a ledger outage never authorizes an unaccounted call.
      br.neutral();
      log({ event: "si_reservation_failed", provider: sub.provider, error: e.code ?? e.message });
      return { ok: false, reason: "internal_failure", detail: "ledger_unavailable", dispatchState: "not_sent", queueMs: Date.now() - t0 };
    }
    if (r.exhausted) { br.neutral(); return { ok: false, reason: "platform_restricted", detail: `cap:${r.exhausted.category}/${r.exhausted.period}`, dispatchState: "not_sent", queueMs: Date.now() - t0 }; }
    if (r.existing) { br.neutral(); return { ok: false, reason: "internal_failure", detail: "operation_already_recorded", dispatchState: r.existing.state === "RELEASED" ? "not_sent" : "possibly_sent", queueMs: Date.now() - t0 }; }
    for (const notice of r.notices ?? []) log({ event: "budget_threshold", ...notice });
    const close = closer(r.reservation, sub, pre);
    let releasePermit = null;
    // Not sent: an unreachable service (DNS or connection failure) is a genuine transport failure (spec §15); a capacity wait,
    // the caller's cancellation, a deadline that passed and a local refusal before send (NOT_READY, an SSRF denial, the paid
    // lease) judge nothing about the provider.
    const unsentFailure = async (e) => {
      if (e.code === "PROVIDER_UNREACHABLE") br.failure(); else br.neutral();
      await close.release(`not sent: ${e.code ?? e.message}`);
      return { ok: false, reason: reasonOfTransport(e), detail: e.code ?? "not_sent", dispatchState: "not_sent", queueMs: Date.now() - t0 };
    };
    try {
      try {
        releasePermit = await permits.api(sub.provider, searchId, { signal, deadlineAt });
        if (rate) await rate.take({ signal, deadlineAt });
      } catch (e) { return await unsentFailure(e); }
      const queueMs = Date.now() - t0, startedAt = new Date().toISOString();
      const authorize = () => !signal?.aborted && (!sub.prov.paid || paidDispatchActive(getBudget(), paidDispatch));
      let response;
      try {
        response = await request({ baseUrl: sub.prov.baseUrl, path: http.path, method: http.method ?? "POST", headers: http.headers, body: http.body ?? null, timeoutMs, maxBytes,
          getPolicy, resolvePublic, lookupFixture, signal, deadlineAt, authorize });
      } catch (e) {
        if (e.sent === false) return await unsentFailure(e);
        // Possibly sent, no answer: the outcome is unknown and the reservation stays counted.
        await close.uncertain(`dispatch outcome unknown: ${e.code ?? e.message}`);
        const reason = reasonOfTransport(e);
        if (reason === "timeout" || reason === "temporarily_unavailable") br.failure(); else br.neutral();
        return { ok: false, reason, detail: e.code ?? "possibly_sent", dispatchState: "possibly_sent", queueMs };
      }
      return { ok: true, response, close, queueMs, startedAt };
    } finally {
      releasePermit?.();
    }
  }

  return { subject, preflight, report, call, closeUnclosed, breakerState: (provider) => breakerFor(provider).state(), breakers: () => Object.fromEntries([...breakers].map(([k, v]) => [k, v.state()])),
    counters: () => ({ accountingFailures }) };
}

// A provider's JSON answer, or null when it is not JSON (a contract failure for the caller to name).
export function parseJson(buf) { try { return JSON.parse(buf.toString("utf8")); } catch { return null; } }
// A string field bounded to max characters, or the fallback when absent or not a string.
export const str = (v, max, fallback = "") => (typeof v === "string" ? v.slice(0, max) : fallback);
