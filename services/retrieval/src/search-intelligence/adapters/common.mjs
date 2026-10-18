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
import { providerRequest, ProviderError } from "../../provider.mjs";
import { credentialEpoch } from "../availability.mjs";
import { outcome } from "../contracts.mjs";

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

  // Admission and the reservation, shared by call() and meter(): the breaker's admission, the shared monetary cap's valuation
  // check, then the reservation under the operation's stable call key. { ok: true, close, t0 } or a refusal, never sent.
  async function reserve({ sub, pre, kind, callKey, logicalId, requestHash, amount }) {
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
    return { ok: true, close: closer(r.reservation, sub, pre), t0 };
  }

  // One metered HTTP operation. Returns { ok: true, response, close, queueMs, startedAt } for an answer (the caller parses it and
  // closes the reservation), or { ok: false, reason, detail, dispatchState, queueMs } with the reservation already closed.
  async function call({ sub, pre, kind, callKey, logicalId, searchId, requestHash, amount, signal, deadlineAt, timeoutMs, maxBytes, http, rate = null }) {
    const m = await reserve({ sub, pre, kind, callKey, logicalId, requestHash, amount });
    if (!m.ok) return m;
    const { close, t0 } = m;
    const br = breakerFor(sub.provider);
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
        // The rate token is taken last, just before the send. Taken before the permit, tokens could wait out a permit and then
        // be spent together, bursting past the provider's documented rate on the wire; the per-provider permit cap bounds what
        // this order costs: at most perProvider global permits wait on the token, none longer than perProvider/QPS seconds.
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

  // A metered operation whose transport is not call()'s own (Ref's tool calls, sent by the MCP client through the policy-checked
  // bridge): the same admission and reservation, and fail(), the one verdict and the one closing for a call that got no usable
  // answer. An answer the caller can read is closed and reported by the caller, as after call().
  async function meter({ sub, pre, kind, callKey, logicalId, requestHash, amount }) {
    const m = await reserve({ sub, pre, kind, callKey, logicalId, requestHash, amount });
    if (!m.ok) return m;
    const { close } = m;
    // sent: whether the operation's request was written. cancelled: the caller's own cancellation ended it.
    async function fail(e, { sent, cancelled = false }) {
      const v = mcpFailure(e, { sent, cancelled });
      const br = breakerFor(sub.provider);
      if (v.breaker === "failure") br.failure(); else br.neutral();
      if (v.dispatchState === "not_sent") await close.release(`not sent: ${v.detail}`);
      else await close.uncertain(v.dispatchState === "response_received" ? `answered without a result (${v.detail}); whether it charged is unknown` : `dispatch outcome unknown: ${v.detail}`);
      return { reason: v.reason, detail: v.detail, dispatchState: v.dispatchState };
    }
    return { ok: true, close, fail };
  }

  // A failed exchange that is not a metered operation (an MCP session's initialize or tool listing): it took no admission, so
  // it can count a failure against the service but never returns a probe slot it does not hold; availability learns the rest.
  async function observe(sub, epoch, v) {
    if (v.breaker === "failure") breakerFor(sub.provider).failure();
    await report(sub, epoch, { reason: v.reason, providerCode: v.detail, detail: v.detail }, { answered: false });
  }

  return { subject, preflight, report, call, meter, observe, closeUnclosed, breakerState: (provider) => breakerFor(provider).state(), breakers: () => Object.fromEntries([...breakers].map(([k, v]) => [k, v.state()])),
    counters: () => ({ accountingFailures }) };
}

// What a failed MCP exchange means (an outbound MCP session: Ref, spec §6.2, §15): { reason, detail, dispatchState, breaker }.
//   answered  an HTTP refusal of the endpoint, a JSON-RPC error or an answer the client could not read: the provider spoke;
//   not sent  the request was never written: only an unreachable service is a failure of it;
//   unknown   written and no answer: a timeout or a dropped connection counts against its service.
export function mcpFailure(e, { sent, cancelled = false }) {
  const code = typeof e?.code === "string" ? e.code : null;
  // Our own transport says what happened on the wire; an HTTP status it carries (a 200 cut off midway) is not an answer.
  if (e instanceof ProviderError) {
    if (code === "PROVIDER_RESPONSE_TOO_LARGE") return { reason: "contract_failure", detail: "provider_response_too_large", dispatchState: "response_received", breaker: "neutral" };
  } else if (Number.isInteger(e?.status)) {
    const s = e.status;
    const reason = s === 401 || s === 403 ? "auth_failed" : s === 429 ? "rate_limited" : s === 402 ? "quota_exhausted" : s >= 500 ? "temporarily_unavailable" : "contract_failure";
    return { reason, detail: `http_${s}`, dispatchState: "response_received", breaker: reason === "temporarily_unavailable" ? "failure" : "neutral" };
  }
  // A JSON-RPC error is the server's answer, unless the client raised it before writing anything (an invalid tool schema).
  if (Number.isInteger(e?.code)) return { reason: "contract_failure", detail: `jsonrpc_${e.code}`, dispatchState: sent ? "response_received" : "not_sent", breaker: "neutral" };
  if (code && /^(INVALID_RESULT|UNSUPPORTED_RESULT_TYPE)$|UNEXPECTED_CONTENT/.test(code)) return { reason: "contract_failure", detail: code.toLowerCase(), dispatchState: "response_received", breaker: "neutral" };
  const reason = cancelled || code === "CANCELLED" ? "cancelled" : e?.capacity ? "capacity_unavailable" : e?.timedOut || code === "REQUEST_TIMEOUT" ? "timeout"
    : code === "PAID_DISPATCH_DISABLED" ? "platform_restricted" : "temporarily_unavailable";
  if (!sent) return { reason, detail: code ?? "not_sent", dispatchState: "not_sent", breaker: code === "PROVIDER_UNREACHABLE" ? "failure" : "neutral" };
  return { reason, detail: code ?? "possibly_sent", dispatchState: "possibly_sent", breaker: reason === "timeout" || reason === "temporarily_unavailable" ? "failure" : "neutral" };
}

// The skeleton every metered HTTP search adapter shares (Brave, Exa, DeepSeek, Tavily): one dispatch, one closing of the
// reservation, one breaker verdict and the outcome. The adapter supplies its provider's contract:
//   refusal(response, data)  a non-200 answer: { reason, retryAt?, providerCode, errorCode?, close: "release" | "uncertain", note }
//   closing(data)            a 200 answer, judged before its shape: { settle, usage, note, fields? } or { uncertain: note }
//   results(data)            the result list, or null when the answer is not the documented shape
//   candidate(x, i)          one candidate, or null for an invalid row
//   answered(data, response) fields every answered outcome carries (a provider request id)
//   success(data, list)      fields of the successful outcome (its usage)
export async function meteredSearch({ dispatch, ctx, id, base, call, refusal, closing, results, candidate, answered = () => ({}), success = () => ({}) }) {
  const res = await dispatch.call(call);
  if (!res.ok) {
    // call() has already judged the breaker: this report only informs availability.
    await dispatch.report(ctx.sub, ctx.pre.epoch, { reason: res.reason }, { answered: false });
    return outcome({ ...base, status: "failed", reason: res.reason, detail: res.detail, dispatchState: res.dispatchState, queueMs: res.queueMs });
  }
  const { response, close } = res, data = parseJson(response.body);
  const common = { ...base, queueMs: res.queueMs, startedAt: res.startedAt, dispatchState: "response_received", ...answered(data, response) };
  if (response.status !== 200) {
    const r = refusal(response, data);
    if (r.close === "release") await close.release(r.note); else await close.uncertain(r.note);
    const retryAt = r.retryAt ?? null;
    await dispatch.report(ctx.sub, ctx.pre.epoch, { reason: r.reason, retryAt, retryBasis: retryAt ? "documented" : null, providerCode: r.providerCode, detail: r.providerCode });
    return outcome({ ...common, status: "failed", reason: r.reason, detail: r.providerCode, retryAt,
      error: { httpStatus: response.status, providerCode: r.errorCode === undefined ? r.providerCode : r.errorCode, retryable: r.reason !== "auth_failed", messageCode: `${id}_${r.reason}` } });
  }
  // A 200 is closed before its shape is judged: what it was billed does not depend on whether it was usable.
  const c = closing(data);
  if (c.uncertain) await close.uncertain(c.uncertain);
  else await close.settle(c.settle, { usage: c.usage, detail: c.note });
  const after = { ...common, ...(c.fields ?? {}) };
  const contractFailure = async (code, detail) => {
    await dispatch.report(ctx.sub, ctx.pre.epoch, { reason: "contract_failure", providerCode: code });
    return outcome({ ...after, status: "failed", reason: "contract_failure", detail });
  };
  const list = results(data);
  if (!list) return contractFailure(`${id}_shape`, `${id}_response_shape`);
  const candidates = list.flatMap((x, i) => { const one = x ? candidate(x, i) : null; return one ? [one] : []; });
  if (list.length && !candidates.length) return contractFailure(`${id}_results_invalid`, `${id}_results_invalid`);
  await dispatch.report(ctx.sub, ctx.pre.epoch, { success: true, dispatchedAt: res.startedAt });
  return outcome({ ...after, status: candidates.length ? "success_results" : "success_empty", upstreamResultCount: list.length, candidates, ...success(data, list) });
}

// A provider's JSON answer, or null when it is not JSON (a contract failure for the caller to name).
export function parseJson(buf) { try { return JSON.parse(buf.toString("utf8")); } catch { return null; } }
// A provider's reported dollars as whole micro-USD, rounded up: a real fraction of a micro-USD counts in full, but the float
// error of the product (0.000123 * 1e6 is 123.00000000000001) never adds a unit, so it is rounded to nano-USD first.
export const microUsd = (dollars) => Math.ceil(Math.round(dollars * 1e9) / 1e3);
// A string field bounded to max characters, or the fallback when absent or not a string.
export const str = (v, max, fallback = "") => (typeof v === "string" ? v.slice(0, max) : fallback);
