// One logical acquisition (FIRECRAWL_PI_SPEC.md §8.3, §9): validate, then direct HTTP, then at most
// one browser attempt for a JS shell, with at most one same-tier retry for a transient target
// failure. Every attempt is reserved against the logical page's persisted budget before dispatch
// (four in all, however many times upstream or NuQ asks), the acquisition holds one of the global
// URL permits, the browser attempt also holds the browser permit, and every direct navigation is
// paced per registrable domain. There is no proxy or enhanced tier before M6/M7: work that would
// need one fails as PROXY_REQUIRED or BLOCKED_PUBLIC_CONTENT instead of using the home connection.
import { randomUUID, createHmac, randomBytes } from "node:crypto";
import { getDomain } from "tldts";
import { parseTarget, Denied } from "./ssrf.mjs";
import { guardedFetch, CookieJar, USER_AGENT } from "./httpfetch.mjs";
import { classify, isTextual, isHtml } from "./quality.mjs";

const PURPOSES = new Set(["page", "robots", "sitemap"]);
const EXPECTS = new Set(["html", "pdf", "document"]);
const HMAC_KEY = randomBytes(32); // per process: log correlation without a guessable URL hash (spec §25)
export const urlHmac = (url) => createHmac("sha256", HMAC_KEY).update(url).digest("hex").slice(0, 32);
const sleep = (ms, signal) => new Promise((r) => { const t = setTimeout(r, ms); signal?.addEventListener("abort", () => { clearTimeout(t); r(); }, { once: true }); });

export function validateAcquireRequest(b) {
  const bad = (why) => { throw new Denied("INVALID_REQUEST", why); };
  if (!b || typeof b !== "object") bad("body must be an object");
  const str = (k, max) => { if (typeof b[k] !== "string" || !b[k] || b[k].length > max) bad(`${k} must be a string of at most ${max}`); return b[k]; };
  const out = {
    requestId: str("requestId", 128), logicalAcquisitionId: str("logicalAcquisitionId", 256), url: str("url", 8192),
    purpose: b.purpose ?? "page", expect: b.expect ?? "html", headers: b.headers ?? {}, waitFor: b.waitFor ?? 0, fast: b.fast === true,
    principalId: b.principalId ?? null, jobId: b.jobId ?? null, crawlId: b.crawlId ?? null,
  };
  const d = Date.parse(b.deadline);
  if (!Number.isFinite(d)) bad("deadline must be an ISO-8601 time");
  out.deadline = d;
  if (!PURPOSES.has(out.purpose)) bad("purpose must be page, robots or sitemap");
  if (!EXPECTS.has(out.expect)) bad("expect must be html, pdf or document");
  if (typeof out.headers !== "object" || Array.isArray(out.headers)) bad("headers must be an object");
  if (!Number.isInteger(out.waitFor) || out.waitFor < 0 || out.waitFor > 15000) bad("waitFor must be 0..15000 ms (spec §12)");
  return out;
}

function decodeText(buf, contentType) {
  const header = (contentType?.match(/charset\s*=\s*["']?([^;"'\s]+)/i) ?? [])[1];
  const meta = (buf.subarray(0, 4096).toString("latin1").match(/<meta\b[^>]*charset\s*=\s*["']?([^"'\s/>]+)/i) ?? [])[1];
  for (const label of [header, meta, "utf-8"]) {
    if (!label) continue;
    try { return new TextDecoder(label).decode(buf); } catch { /* unknown label: next */ }
  }
  return buf.toString("utf8");
}

export function makeAcquirer({ store, getPolicy, getLocalReady, permits, resolvePublic, lookupFixture, browser, log }) {
  // Wait for a permit until the deadline; the lease covers the longest acquisition, and is freed
  // explicitly, or by expiry if this process dies holding it.
  async function holdPermit(kind, holder, slots, deadline, signal) {
    for (;;) {
      if (await store.takePermit(kind, holder, slots, getPolicy().permitLeaseMs)) return true;
      if (Date.now() + 250 > deadline || signal?.aborted) return false;
      await sleep(250, signal);
    }
  }

  // Pace one direct navigation; resolves null when it may go, or a failure.
  async function pace(target, holder, deadline, signal) {
    const policy = getPolicy();
    const domain = target.fixture ? target.host : (getDomain(target.host) ?? target.host);
    const limits = target.fixture?.limits === "fixture" ? policy.fixtureLimits : policy.direct;
    for (;;) {
      const d = await store.paceDirect(domain, holder, limits, policy.attempts.browserAttemptMs, !!target.fixture);
      if (d.go) return { domain };
      if (d.failure) return { domain, failure: d.failure };
      if (Date.now() + d.waitMs > deadline || signal?.aborted) return { domain, failure: { class: "DEADLINE_EXCEEDED", detail: "the domain's pacing would pass the deadline", retryable: true, retryAfter: null } };
      await sleep(d.waitMs, signal);
    }
  }

  return async function acquire(body, signal) {
    const started = Date.now();
    const policy = getPolicy();
    const req = validateAcquireRequest(body);
    const result = { ok: false, logicalAcquisitionId: req.logicalAcquisitionId, attemptId: null, attemptsUsed: 0, strategy: null, strategies: [],
      finalUrl: req.url, targetStatus: 0, contentType: null, bytes: 0, redirects: [], quality: null, failure: null, costEstimate: 0, provider: null };
    const finish = (extra) => {
      Object.assign(result, extra);
      log({ event: "acquisition", request_id: req.requestId, logical_id: req.logicalAcquisitionId, purpose: req.purpose, url_hmac: urlHmac(req.url),
        attempts_used: result.attemptsUsed, strategies: result.strategies, target_status: result.targetStatus, verdict: result.quality?.verdict ?? null,
        failure: result.failure?.class ?? null, bytes: result.bytes, ms: Date.now() - started });
      return result;
    };
    const fail = (f) => finish({ ok: false, failure: { retryable: false, retryAfter: null, ...f } });

    let target;
    try { target = parseTarget(req.url, policy); } catch (e) { if (e instanceof Denied) return fail({ class: e.failureClass, detail: e.detail }); throw e; }
    if (!getLocalReady()) return fail({ class: "RETRIEVAL_NOT_READY", detail: "the host's local-network list is not loaded", retryable: true });

    const acq = await store.openAcquisition(req.logicalAcquisitionId, urlHmac(req.url), new Date(Math.min(req.deadline, Date.now() + policy.attempts.acquisitionDeadlineMs)));
    const deadline = Math.min(acq.deadline.getTime(), acq.first_seen.getTime() + policy.attempts.acquisitionDeadlineMs);
    result.attemptsUsed = acq.attempts;
    if (Date.now() >= deadline) return fail({ class: "DEADLINE_EXCEEDED", detail: "the logical page's 90 s acquisition deadline has passed", retryable: false });

    const holder = randomUUID();
    if (!(await holdPermit("url", holder, permits.url, deadline, signal))) return fail({ class: "RESOURCE_BUSY", detail: "no URL acquisition permit before the deadline", retryable: true });
    try {
      const jar = new CookieJar();
      let httpRes = null, sameTierRetried = false;
      // Direct HTTP, with at most one same-tier retry for a transient target failure.
      for (;;) {
        const attemptId = randomUUID();
        const ordinal = await store.reserveAttempt({ logicalId: req.logicalAcquisitionId, attemptId, requestId: req.requestId, purpose: req.purpose, strategy: "direct_http", domain: target.host, maxAttempts: policy.attempts.maxPerPage });
        if (ordinal === null) return fail({ class: "ATTEMPT_BUDGET_EXHAUSTED", detail: `the page's ${policy.attempts.maxPerPage} attempts are spent` });
        result.attemptId = attemptId; result.attemptsUsed = ordinal; result.strategies.push("direct_http"); result.strategy = "direct_http";
        const paced = await pace(target, attemptId, deadline, signal);
        if (paced.failure) { await store.finishAttempt(attemptId, { outcome: paced.failure.class }); return fail(paced.failure); }
        try {
          httpRes = await guardedFetch({ url: req.url, headers: req.headers, maxBytes: policy.maxBodyBytes, deadline: Math.min(deadline, Date.now() + policy.attempts.httpAttemptMs),
            policy, resolvePublic, lookupFixture, jar, signal });
        } catch (e) {
          await store.finishAttempt(attemptId, { outcome: e.failureClass ?? "ERROR" });
          if (!(e instanceof Denied)) throw e;
          const transient = e.failureClass === "TARGET_UNREACHABLE";
          if (transient && !sameTierRetried && Date.now() + 3000 < deadline) { sameTierRetried = true; await sleep(700 + Math.floor(Math.random() * 600), signal); continue; }
          return fail({ class: e.failureClass, detail: e.detail, retryable: transient || e.failureClass === "TIMEOUT" });
        } finally {
          await store.releaseDomain(paced.domain, attemptId);
        }
        const ct = httpRes.headers["content-type"] ?? null;
        const text = isTextual(ct) ? decodeText(httpRes.body, ct) : null;
        const verdict = classify({ status: httpRes.status, contentType: ct, body: text, finalUrl: httpRes.finalUrl, requestedUrl: req.url,
          retryAfter: retryAfterSeconds(httpRes.headers["retry-after"]) });
        await store.finishAttempt(attemptId, { outcome: verdict.failure?.class ?? verdict.verdict, targetStatus: httpRes.status, bytes: httpRes.bytes });
        Object.assign(result, { finalUrl: httpRes.finalUrl, targetStatus: httpRes.status, contentType: ct, bytes: httpRes.bytes, redirects: httpRes.redirects.map((r) => ({ url: r.url, status: r.status })), quality: { verdict: verdict.verdict, reasons: verdict.reasons ?? [] } });
        if (verdict.verdict === "target_error" && !sameTierRetried && Date.now() + 3000 < deadline) { sameTierRetried = true; await sleep(700 + Math.floor(Math.random() * 600), signal); continue; }
        if (verdict.verdict === "rate_limited") await store.coolDown(target.fixture ? target.host : (getDomain(target.host) ?? target.host), verdict.failure.retryAfter);
        if (verdict.failure) return fail(verdict.failure);
        if (verdict.verdict !== "js_shell" || req.purpose !== "page" || req.expect !== "html" || req.fast) {
          return finish({ ok: true, ...(text !== null ? { body: text } : { bodyBase64: httpRes.body.toString("base64") }) });
        }
        break;
      }

      // One browser attempt for a JS shell (spec §9.1), on the same permitted direct egress.
      const attemptId = randomUUID();
      const ordinal = await store.reserveAttempt({ logicalId: req.logicalAcquisitionId, attemptId, requestId: req.requestId, purpose: req.purpose, strategy: "direct_browser", domain: target.host, maxAttempts: policy.attempts.maxPerPage });
      if (ordinal === null) return fail({ class: "ATTEMPT_BUDGET_EXHAUSTED", detail: `the page's ${policy.attempts.maxPerPage} attempts are spent before its browser attempt` });
      result.attemptId = attemptId; result.attemptsUsed = ordinal; result.strategies.push("direct_browser"); result.strategy = "direct_browser";
      const browserDeadline = Math.min(deadline, Date.now() + policy.attempts.browserAttemptMs);
      if (!(await holdPermit("browser", attemptId, permits.browser, browserDeadline, signal))) {
        await store.finishAttempt(attemptId, { outcome: "RESOURCE_BUSY" });
        return fail({ class: "RESOURCE_BUSY", detail: "no browser permit before the deadline", retryable: true });
      }
      const paced = await pace(target, attemptId, browserDeadline, signal);
      try {
        if (paced.failure) { await store.finishAttempt(attemptId, { outcome: paced.failure.class }); return fail(paced.failure); }
        const r = await browser.render({ attemptId, url: req.url, deadline: browserDeadline, waitFor: req.waitFor, userAgent: USER_AGENT, signal });
        await store.finishAttempt(attemptId, { outcome: r.ok ? "rendered" : r.failure.class, targetStatus: r.status ?? null, bytes: r.proxy?.bytes ?? null, subresources: r.subresources?.requests ?? null });
        if (!r.ok) return fail(r.failure);
        const verdict = classify({ status: r.status, contentType: r.contentType ?? "text/html", body: r.html, finalUrl: r.finalUrl, requestedUrl: req.url });
        if (verdict.failure) return fail(verdict.failure);
        return finish({ ok: true, body: r.html, finalUrl: r.finalUrl, targetStatus: r.status, contentType: r.contentType ?? "text/html; charset=utf-8",
          bytes: r.proxy?.bytes ?? 0, redirects: r.redirects ?? [], quality: { verdict: verdict.verdict === "js_shell" ? "js_shell_after_render" : verdict.verdict, reasons: verdict.reasons ?? [] },
          subresources: r.subresources, proxyDenied: r.proxy?.denied ?? [] });
      } finally {
        await store.releaseDomain(paced.domain, attemptId);
        await store.releasePermit("browser", attemptId);
      }
    } finally {
      await store.releasePermit("url", holder);
    }
  };
}

export function retryAfterSeconds(v) {
  if (!v) return null;
  if (/^\d+$/.test(v)) return Number(v);
  const t = Date.parse(v);
  return Number.isFinite(t) ? Math.max(0, Math.ceil((t - Date.now()) / 1000)) : null;
}

// POST /internal/fetch: one direct attempt for an auxiliary download (sitemap, document,
// discovery), under the same target, pacing and size rules, without the quality check or the
// browser. Resolves { status, headers, body, finalUrl } or throws Denied.
export function makeFetcher({ store, getPolicy, getLocalReady, resolvePublic, lookupFixture, log }) {
  return async function fetchOnce(b, signal) {
    const policy = getPolicy();
    if (!b || typeof b.url !== "string" || typeof b.requestId !== "string") throw new Denied("INVALID_REQUEST", "url and requestId are required");
    if (!["sitemap", "document", "discovery"].includes(b.purpose)) throw new Denied("INVALID_REQUEST", "purpose must be sitemap, document or discovery");
    const method = b.method === "HEAD" ? "HEAD" : "GET";
    const target = parseTarget(b.url, policy);
    if (!getLocalReady()) throw new Denied("RETRIEVAL_NOT_READY", "the host's local-network list is not loaded");
    const deadline = Math.min(Date.parse(b.deadline) || Date.now() + 30000, Date.now() + 30000);
    const maxBytes = Math.min(Number.isInteger(b.maxBytes) ? b.maxBytes : policy.maxBodyBytes, policy.maxBodyBytes);
    const logicalId = `fetch:${b.requestId}`;
    await store.openAcquisition(logicalId, urlHmac(b.url), new Date(deadline));
    const attemptId = randomUUID();
    const ordinal = await store.reserveAttempt({ logicalId, attemptId, requestId: b.requestId, purpose: b.purpose, strategy: "direct_http", domain: target.host, maxAttempts: 1 });
    if (ordinal === null) throw new Denied("ATTEMPT_BUDGET_EXHAUSTED", "this download was already attempted");
    const domain = target.fixture ? target.host : (getDomain(target.host) ?? target.host);
    const limits = target.fixture?.limits === "fixture" ? policy.fixtureLimits : policy.direct;
    for (;;) {
      const d = await store.paceDirect(domain, attemptId, limits, 30000, !!target.fixture);
      if (d.go) break;
      if (d.failure) { await store.finishAttempt(attemptId, { outcome: d.failure.class }); throw new Denied(d.failure.class, d.failure.detail); }
      if (Date.now() + d.waitMs > deadline) { await store.finishAttempt(attemptId, { outcome: "DEADLINE_EXCEEDED" }); throw new Denied("DEADLINE_EXCEEDED", "pacing would pass the deadline"); }
      await sleep(d.waitMs, signal);
    }
    try {
      const r = await guardedFetch({ url: b.url, method, headers: b.headers, maxBytes, deadline, policy, resolvePublic, lookupFixture, signal });
      await store.finishAttempt(attemptId, { outcome: "fetched", targetStatus: r.status, bytes: r.bytes });
      log({ event: "fetch", request_id: b.requestId, purpose: b.purpose, url_hmac: urlHmac(b.url), target_status: r.status, bytes: r.bytes });
      return r;
    } catch (e) {
      await store.finishAttempt(attemptId, { outcome: e.failureClass ?? "ERROR" });
      throw e;
    } finally {
      await store.releaseDomain(domain, attemptId);
    }
  };
}

export { isHtml };
