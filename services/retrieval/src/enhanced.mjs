// The enhanced-retrieval provider (FIRECRAWL_PI_SPEC.md §11, §28.3): the last tier of a logical page's waterfall, one
// dispatch per page at most, drawn from the same four-attempt budget as every other tier (acquire.mjs reserves the
// attempt). Which provider the host's selection names and whether it may be used now are checked in one order, every
// refusal named, before anything is reserved or sent:
//   1. an enhancer is selected (the host's selection; the budget policy's default otherwise);
//   2. its rate card is in effect;
//   3. a paid provider needs PI_PAID_DISPATCH_ENABLED (a key present is not an authorization to spend);
//   4. its credential file is present;
//   5. its breaker is not open;
//   6. its category has room for one request at the card's price (a zero cap has none).
//
// The contract is Zyte API's (docs.zyte.com, "HTTP requests" and "Errors", checked 2026-09-27): POST /v1/extract with
// Basic authentication (the key as the user name, no password) and { url, httpResponseBody, httpResponseHeaders } for a
// raw response or { url, browserHtml } for a rendered one; the answer is { url (final, after redirects), statusCode (the
// target's), httpResponseBody (base64), httpResponseHeaders [{ name, value }], browserHtml }. A target's own 404 or 403
// comes back as an API 200 carrying that status: the target's outcome is judged by quality.mjs like any other tier's,
// never by the provider's 200. Only successful responses are charged; an unsuccessful one is free:
//   520 the target banned the provider        BLOCKED_PUBLIC_CONTENT, released, the breaker untouched
//   421 the target's domain is unreachable    TARGET_UNREACHABLE, released, untouched
//   451 the provider refuses the domain        ENHANCED_DOMAIN_FORBIDDEN, released, untouched
//   400/422 the request was refused            PROVIDER_REJECTED, released, untouched
//   401/403 key unknown or account suspended   PROVIDER_AUTH_FAILED, released, counted on the breaker
//   402                                        PROVIDER_BILLING, released, counted
//   429/503 rate limited                       PROVIDER_RATE_LIMITED, released, counted
//   500/521 the provider failed                PROVIDER_ERROR, released, counted
// A request that may have reached the provider with no answer (a timeout or reset after sending, a 502 or 504 from a
// proxy in front of it, any other status) leaves the charge unknown: the whole reservation stays counted (UNCERTAIN)
// and the page's dispatch is never sent again.
//
// Price: Zyte charges a request by the target's tier, which no answer reports, so a successful response settles at the
// card's highest-tier price for its type (spec §28.3: a conservative maximum, never an undercount). The reservation's
// call key is the logical page's own: a page retried by upstream or NuQ finds its earlier dispatch, and a settled one's
// answer, when small enough to keep, is used again instead of paying twice.
import { createHash, randomUUID } from "node:crypto";
import { Breaker, rateCardFor, periodStarts } from "./budget.mjs";
import { providerRequest, readCredential, ProviderError } from "./provider.mjs";
import { parseTarget, Denied } from "./ssrf.mjs";
import { resolveTarget } from "./resolve.mjs";

// A settled answer up to this size is kept on its ledger row for a retry of the page (the row's result is dropped after
// seven days with the others'); a larger one is not, and a retry then fails rather than paying again.
export const REUSE_MAX_BYTES = 4 * 1048576;
const FREE = {
  520: ["BLOCKED_PUBLIC_CONTENT", "the target banned the enhanced provider (520)", "neutral", false],
  421: ["TARGET_UNREACHABLE", "the enhanced provider could not reach the target's domain (421)", "neutral", true],
  451: ["ENHANCED_DOMAIN_FORBIDDEN", "the enhanced provider does not serve this domain (451)", "neutral", false],
  400: ["PROVIDER_REJECTED", "the enhanced provider refused the request as invalid (400)", "neutral", false],
  422: ["PROVIDER_REJECTED", "the enhanced provider refused the request's parameters (422)", "neutral", false],
  401: ["PROVIDER_AUTH_FAILED", "the enhanced provider refused the credential (401)", "failure", false],
  403: ["PROVIDER_AUTH_FAILED", "the enhanced provider's account is suspended (403)", "failure", false],
  402: ["PROVIDER_BILLING", "the enhanced provider refused for lack of funds (402)", "failure", false],
  429: ["PROVIDER_RATE_LIMITED", "the enhanced provider rate-limited the request (429)", "failure", true],
  503: ["PROVIDER_RATE_LIMITED", "the enhanced provider is over its global limit (503)", "failure", true],
  500: ["PROVIDER_ERROR", "the enhanced provider failed or timed out (500)", "failure", true],
  521: ["PROVIDER_ERROR", "the enhanced provider hit a permanent error for this request (521)", "failure", false],
};
const failure = (cls, detail, extra = {}) => ({ failure: { class: cls, detail, retryable: false, retryAfter: null, ...extra } });

export function makeEnhanced({ getBudget, getPolicy, getSelection, providersDir, paidDispatch, store, resolvePublic, lookupFixture, log }) {
  const breakers = new Map();
  const breakerFor = (name) => breakers.get(name) ?? breakers.set(name, new Breaker(getBudget().breaker)).get(name);

  // Checks 1-5 (synchronous, no reservation).
  function state() {
    const budget = getBudget(), subject = getSelection().enhanced ?? null;
    if (!subject) return { available: false, reason: "NO_ENHANCER_SELECTED", subject: null };
    const s = budget.enhancers[subject], provider = budget.providers[s.provider], category = budget.categories[s.category];
    const base = { subject, providerName: s.provider, provider, categoryName: s.category, category, paid: provider.paid };
    const card = rateCardFor(budget, subject);
    if (!card) return { ...base, available: false, reason: "RATE_CARD_MISSING" };
    if (provider.paid && !paidDispatch) return { ...base, card, available: false, reason: "PAID_DISPATCH_DISABLED" };
    if (!readCredential(providersDir, provider.credential)) return { ...base, card, available: false, reason: "BLOCKED_CREDENTIAL" };
    const b = breakerFor(s.provider);
    if (b.state() === "open") return { ...base, card, available: false, reason: "PROVIDER_UNAVAILABLE", retryAfter: b.retryAfterS() };
    return { ...base, card, credential: "present", available: true, reason: null };
  }
  const priceOf = (card, mode) => (mode === "browser" ? card.microUsdPerBrowserRequest : card.microUsdPerHttpRequest);

  // Check 6 as well, read from the ledger. Advisory: the reservation is the transactional check.
  async function availability(mode = "browser") {
    const st = state();
    if (!st.available) return st;
    const need = priceOf(st.card, mode);
    const { day, month } = periodStarts();
    const rows = await store.budgetUsage(day, month);
    for (const [period, cap] of Object.entries(st.category.caps)) {
      const r = rows.find((x) => x.category === st.categoryName && x.period === period);
      if ((r ? r.reserved + r.settled : 0) + need > cap) return { ...st, available: false, reason: "BUDGET_EXHAUSTED", period, cap };
    }
    if (st.paid) {
      const r = rows.find((x) => x.category === "_paid_total" && x.period === "day");
      if ((r ? r.reserved + r.settled : 0) + need > getBudget().paidTotal.caps.day) return { ...st, available: false, reason: "BUDGET_EXHAUSTED", period: "day", cap: getBudget().paidTotal.caps.day };
    }
    return st;
  }

  // An earlier dispatch of this page, found by its call key: its kept answer, or why it cannot be used again.
  function earlier(row) {
    if (row.state === "SETTLED" && row.result?.answer) return { reused: true, answer: row.result.answer, charge: { state: "SETTLED", reserved: Number(row.reserved), actual: Number(row.actual), reused: true } };
    if (row.state === "SETTLED") return failure("ENHANCED_ALREADY_DISPATCHED", "this page's one enhanced dispatch was made and its answer was not kept; it is not sent again");
    return failure("ENHANCED_UNCERTAIN", `this page's one enhanced dispatch was sent and its outcome is ${row.state === "RESERVED" ? "still in flight" : "unknown"}; it is not sent again`);
  }

  // The page's one dispatch. target: the validated target of the requested URL; mode: http | browser. Resolves
  // { answer, charge } (answer: { status, finalUrl, contentType, body: Buffer } for http, { ..., html } for browser),
  // { reused: true, answer, charge }, or { failure } (with unavailable: the state, when the tier could not be had).
  async function dispatch({ logicalId, target, url, mode, deadline, signal }) {
    const budget = getBudget(), E = budget.enhancing, policy = getPolicy();
    const st = await availability(mode);
    if (!st.available) return { ...failure("ENHANCED_REQUIRED", `the enhanced provider is unavailable (${st.reason})`, { retryable: ["PROVIDER_UNAVAILABLE", "BUDGET_EXHAUSTED"].includes(st.reason), retryAfter: st.retryAfter ?? null }), unavailable: st };
    // The target is validated and resolved as for a direct fetch before the provider is asked for it: the provider is
    // no SSRF workaround (spec §9.2), and a target the direct route would refuse is refused here unsent.
    try { await resolveTarget(target, { resolvePublic, policy, lookupFixture }); }
    catch (e) { if (e instanceof Denied) return failure(e.failureClass, e.detail); throw e; }
    if (signal?.aborted) return failure("CANCELLED", "the caller cancelled the acquisition");
    const b = breakerFor(st.providerName);
    if (!b.admit()) return failure("PROVIDER_UNAVAILABLE", "the enhanced provider's breaker is open", { retryable: true, retryAfter: b.retryAfterS() });
    let verdict = "neutral";
    try {
      const amount = priceOf(st.card, mode);
      const { day, month } = periodStarts();
      const requestHash = createHash("sha256").update(`${mode}\n${url}`).digest("hex");
      const r = await store.reserveBudget({ id: randomUUID(), callKey: `enhanced:${logicalId}`, logicalId, category: st.categoryName, provider: st.providerName, subject: st.subject,
        kind: "enhanced", unit: "micro_usd", rateCard: st.card.id, requestHash, amount, caps: st.category.caps, paidTotalCap: st.paid ? budget.paidTotal.caps.day : null, paidTotalRate: 1,
        day, month, notifyAt: budget.notifyAtFraction });
      for (const n of r.notices ?? []) log({ event: "budget_notice", category: n.category, period: n.period, used: n.used, cap: n.cap });
      if (r.existing) return earlier(r.existing);
      if (r.exhausted) return failure("BUDGET_EXHAUSTED", `the ${r.exhausted.category} ${r.exhausted.period} cap (${r.exhausted.cap} micro-USD) has no room for this dispatch's ${amount} micro-USD`);
      const res = r.reservation;
      const key = readCredential(providersDir, st.provider.credential);
      const timeoutMs = Math.min(E.requestTimeoutMs, deadline - Date.now());
      if (!key || timeoutMs < 1000) {
        await store.releaseBudget(res.id, key ? "no time left to dispatch" : "the credential went away");
        return key ? failure("DEADLINE_EXCEEDED", "no time left for the enhanced dispatch") : failure("ENHANCED_REQUIRED", "the enhanced provider is unavailable (BLOCKED_CREDENTIAL)");
      }
      // Once sent, the dispatch runs to its answer even if the caller leaves (no signal): the answer is settled and kept, so a
      // retry of the page uses it instead of finding an UNCERTAIN charge and nothing to show for it.
      const started = Date.now();
      const request = mode === "browser" ? { url, browserHtml: true } : { url, httpResponseBody: true, httpResponseHeaders: true };
      let resp;
      try {
        resp = await providerRequest({ baseUrl: st.provider.baseUrl, path: "/v1/extract", method: "POST", body: Buffer.from(JSON.stringify(request)), timeoutMs, maxBytes: E.maxResponseBytes,
          headers: { authorization: `Basic ${Buffer.from(`${key}:`).toString("base64")}`, "content-type": "application/json", accept: "application/json" }, getPolicy, resolvePublic, lookupFixture });
      } catch (e) {
        if (!(e instanceof ProviderError)) throw e;
        verdict = e.code === "CANCELLED" ? "neutral" : "failure";
        if (!e.sent) {
          await store.releaseBudget(res.id, `not sent: ${e.code}`);
          return e.code === "CANCELLED" ? failure("CANCELLED", "the caller cancelled the acquisition") : failure("PROVIDER_UNREACHABLE", e.message, { retryable: true, provider: true });
        }
        await store.markBudgetUncertain(res.id, `${e.code}: ${e.message}`);
        return failure("ENHANCED_UNCERTAIN", `the enhanced request may have been processed and no answer came (${e.code}); its ${amount} micro-USD stay reserved and it is not sent again`, { provider: true });
      }
      const requestId = String(resp.headers["zyte-request-id"] ?? resp.headers["x-request-id"] ?? "").slice(0, 128) || null;
      const say = (o) => log({ event: "enhanced", logical_id: logicalId, provider: st.providerName, subject: st.subject, mode, provider_status: resp.status, provider_request_id: requestId, ms: Date.now() - started, ...o });
      if (resp.status !== 200) {
        const free = FREE[resp.status];
        if (!free) {
          verdict = "failure";
          await store.markBudgetUncertain(res.id, `the provider answered ${resp.status}`);
          say({ outcome: "UNCERTAIN" });
          return failure("ENHANCED_UNCERTAIN", `the enhanced provider answered HTTP ${resp.status}; whether it ran is unknown, so its ${amount} micro-USD stay reserved`, { provider: true });
        }
        const [cls, detail, v, retryable] = free;
        verdict = v;
        await store.releaseBudget(res.id, `provider answered ${resp.status} (not charged)`);
        say({ outcome: cls });
        return failure(cls, detail, { retryable, provider: v === "failure" });
      }
      // A 200 is a charged response, whatever it holds.
      const charge = { state: "SETTLED", reserved: amount, actual: amount, requestId };
      let a;
      try { a = readAnswer(JSON.parse(resp.body.toString("utf8")), mode, policy.maxBodyBytes); } catch (e) { a = { error: e.message }; }
      if (a.error) {
        verdict = "failure";
        await store.settleBudget(res.id, amount, { usage: { requests: 1, mode }, detail: `charged at the card's highest tier; the answer was unusable (${a.error})` });
        say({ outcome: "MALFORMED" });
        return { ...failure("PROVIDER_ERROR", `the enhanced provider's answer was unusable: ${a.error}`, { provider: true }), charge };
      }
      verdict = "success";
      const bytes = a.body ? a.body.length : Buffer.byteLength(a.html);
      const answer = { status: a.status, finalUrl: a.finalUrl, contentType: a.contentType, ...(a.body ? { bodyBase64: a.body.toString("base64") } : { html: a.html }) };
      await store.settleBudget(res.id, amount, { usage: { requests: 1, mode, bytes, targetStatus: a.status, requestId },
        result: bytes <= REUSE_MAX_BYTES ? { answer } : { kept: false, bytes }, detail: `a successful ${mode} response, charged at the card's highest tier (the tier is not reported)` });
      say({ outcome: "SETTLED", target_status: a.status, bytes, micro_usd: amount });
      return { answer, charge };
    } finally {
      // An outcome that is not the provider's hands a half-open breaker's probe back without a verdict.
      if (verdict === "success") b.success(); else if (verdict === "failure") b.failure(); else b.neutral();
    }
  }

  return { state, availability, dispatch, breakerState: (name) => breakerFor(name).state() };
}

// Reads the provider's 200 answer; throws on anything the contract does not allow.
export function readAnswer(j, mode, maxBodyBytes) {
  if (!j || typeof j !== "object") throw new Error("not a JSON object");
  if (!Number.isInteger(j.statusCode) || j.statusCode < 100 || j.statusCode > 599) throw new Error("statusCode is not an HTTP status");
  if (typeof j.url !== "string" || !/^https?:\/\//i.test(j.url)) throw new Error("url is not an http(s) URL");
  if (mode === "browser") {
    if (typeof j.browserHtml !== "string") throw new Error("browserHtml is missing");
    if (Buffer.byteLength(j.browserHtml) > maxBodyBytes) throw new Error(`browserHtml exceeds ${maxBodyBytes} bytes`);
    return { status: j.statusCode, finalUrl: j.url, contentType: "text/html; charset=utf-8", html: j.browserHtml };
  }
  if (typeof j.httpResponseBody !== "string" || !/^[A-Za-z0-9+/]*={0,2}$/.test(j.httpResponseBody)) throw new Error("httpResponseBody is not base64");
  if (Math.floor((j.httpResponseBody.length * 3) / 4) > maxBodyBytes + 2) throw new Error(`httpResponseBody exceeds ${maxBodyBytes} bytes`);
  const body = Buffer.from(j.httpResponseBody, "base64");
  if (body.length > maxBodyBytes) throw new Error(`httpResponseBody exceeds ${maxBodyBytes} bytes`);
  const headers = Array.isArray(j.httpResponseHeaders) ? j.httpResponseHeaders : [];
  const ct = headers.find((h) => h && typeof h.name === "string" && h.name.toLowerCase() === "content-type" && typeof h.value === "string");
  return { status: j.statusCode, finalUrl: j.url, contentType: ct ? ct.value.slice(0, 256) : null, body };
}

// The final URL an enhanced answer ended at, checked like any target (the Cloud denylist, ports, literal addresses): an
// answer that ended somewhere this deployment may not go is not content (acquire.mjs).
export function finalTarget(url, policy) {
  try { parseTarget(url, policy); return null; } catch (e) { if (e instanceof Denied) return { class: e.failureClass, detail: `the enhanced provider's answer ended at a URL this deployment refuses: ${e.detail}` }; throw e; }
}
