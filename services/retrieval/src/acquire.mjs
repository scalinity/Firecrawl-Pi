// One logical acquisition (FIRECRAWL_PI_SPEC.md §8.3, §9): validate, then direct HTTP, then at most
// one browser attempt for a JS shell, with at most one same-tier retry for a transient target
// failure. Every attempt is reserved against the logical page's persisted budget before dispatch
// (four in all, however many times upstream or NuQ asks), the acquisition holds one of the global
// URL permits, the browser attempt also holds the browser permit, and every direct navigation is
// paced per registrable domain. There is no proxy or enhanced tier before M6/M7: work that would
// need one fails as PROXY_REQUIRED or BLOCKED_PUBLIC_CONTENT instead of using the home connection.
import { randomUUID, createHmac, createHash } from "node:crypto";
import { getDomain } from "tldts";
import { parseTarget, Denied } from "./ssrf.mjs";
import { guardedFetch, CookieJar, USER_AGENT } from "./httpfetch.mjs";
import { classify, isTextual } from "./quality.mjs";

const PURPOSES = new Set(["page", "robots", "sitemap"]);
const EXPECTS = new Set(["html", "pdf", "document"]);
// A URL is logged and stored only as a keyed hash (spec §25). The key is the service's own and
// lasts across restarts (server.mjs), so the rows and log lines of one URL can be correlated
// whenever they were written (review finding S5).
export const makeUrlHmac = (key) => (url) => createHmac("sha256", key).update(url).digest("hex").slice(0, 32);
// Pacing and cooldowns are keyed by registrable domain; a fixture by its exact host.
export const domainOf = (t) => (t.fixture ? t.host : (getDomain(t.host) ?? t.host));
// A caller that has gone away cancels the acquisition at the next step, not at its deadline: every
// wait resolves at once for an aborted signal, and each step checks it (review finding W2).
const CANCELLED = Object.freeze({ class: "CANCELLED", detail: "the caller cancelled the acquisition", retryable: false, retryAfter: null });
// The abort listener goes when the wait ends either way, so a long pacing loop adds none per turn.
const sleep = (ms, signal) => new Promise((r) => {
  if (signal?.aborted) return r();
  const end = () => { clearTimeout(t); signal?.removeEventListener("abort", end); r(); };
  const t = setTimeout(end, ms);
  signal?.addEventListener("abort", end, { once: true });
});

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

export function decodeText(buf, contentType) {
  const header = (contentType?.match(/charset\s*=\s*["']?([^;"'\s]+)/i) ?? [])[1];
  const meta = (buf.subarray(0, 4096).toString("latin1").match(/<meta\b[^>]*charset\s*=\s*["']?([^"'\s/>]+)/i) ?? [])[1];
  for (const label of [header, meta, "utf-8"]) {
    if (!label) continue;
    try { return new TextDecoder(label).decode(buf); } catch { /* unknown label: next */ }
  }
  return buf.toString("utf8");
}

// Direct-egress pacing shared by every acquisition path (spec §10.2, §23.1): pace() takes one
// navigation's decision; pacedFetch() paces every hop of a redirect chain, so a redirect to
// another registrable domain meets that domain's gap, hold and caps (review finding C4).
// Releases each held resource on its own: one failed release (the database briefly away) must not
// skip the others; a lease that could not be released still expires (review finding W3).
async function releaseAll(log, releases) {
  const rs = await Promise.allSettled(releases.filter(Boolean).map((f) => f()));
  for (const r of rs) if (r.status === "rejected") log?.({ event: "release_failed", error: r.reason?.code ?? r.reason?.message });
}

export function makePacer({ store, getPolicy, resolvePublic, lookupFixture, log }) {
  // Wait for one of `slots` permits of `kind` until the deadline; the lease covers the longest
  // acquisition and is freed explicitly, or by expiry if this process dies holding it.
  async function holdPermit(kind, holder, slots, deadline, signal) {
    for (;;) {
      if (signal?.aborted) return false;
      if ((await store.takePermit(kind, holder, slots, getPolicy().permitLeaseMs)) !== null) return true;
      if (Date.now() + 250 > deadline || signal?.aborted) return false;
      await sleep(250, signal);
    }
  }
  async function pace(target, holder, deadline, signal) {
    const policy = getPolicy();
    const domain = domainOf(target);
    const limits = target.fixture?.limits === "fixture" ? policy.fixtureLimits : policy.direct;
    for (;;) {
      if (signal?.aborted) return { domain, failure: CANCELLED };
      const d = await store.paceDirect(domain, holder, limits, policy.attempts.browserAttemptMs, !!target.fixture);
      if (d.go) return { domain };
      if (d.failure) return { domain, failure: d.failure };
      if (Date.now() + d.waitMs > deadline || signal?.aborted) return { domain, failure: { class: "DEADLINE_EXCEEDED", detail: "the domain's pacing would pass the deadline", retryable: true, retryAfter: null } };
      await sleep(d.waitMs, signal);
    }
  }
  // firstDomain: the domain the caller already paced for hop 0. Each later hop to another domain
  // releases the previous hold and is paced itself; the last hold is released on return.
  async function pacedFetch(firstDomain, args, holder, deadline, signal) {
    let held = firstDomain;
    try {
      return await guardedFetch({ ...args, policy: getPolicy(), resolvePublic, lookupFixture, signal, onHop: async ({ hop, target: t }) => {
        if (hop === 0 || domainOf(t) === held) return;
        if (held) await releaseAll(log, [() => store.releaseDomain(held, holder)]);
        held = null;
        const p = await pace(t, holder, deadline, signal);
        if (p.failure) throw new Denied(p.failure.class, `redirect to ${p.domain}: ${p.failure.detail}`, p.failure);
        held = p.domain;
      } });
    } finally {
      if (held) await releaseAll(log, [() => store.releaseDomain(held, holder)]);
    }
  }
  return { holdPermit, pace, pacedFetch };
}

export function makeAcquirer({ store, getPolicy, getLocalReady, permits, resolvePublic, lookupFixture, browser, urlHmac, log }) {
  const { holdPermit, pace, pacedFetch } = makePacer({ store, getPolicy, resolvePublic, lookupFixture, log });

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
    if (!(await holdPermit("url", holder, permits.url, deadline, signal))) return fail(signal?.aborted ? CANCELLED : { class: "RESOURCE_BUSY", detail: "no URL acquisition permit before the deadline", retryable: true });
    try {
      const jar = new CookieJar();
      let httpRes = null, sameTierRetried = false;
      // Direct HTTP, with at most one same-tier retry for a transient target failure.
      for (;;) {
        if (signal?.aborted) return fail(CANCELLED); // no attempt is reserved for a caller that left
        const attemptId = randomUUID();
        const ordinal = await store.reserveAttempt({ logicalId: req.logicalAcquisitionId, attemptId, requestId: req.requestId, purpose: req.purpose, strategy: "direct_http", domain: target.host, maxAttempts: policy.attempts.maxPerPage });
        if (ordinal === null) return fail({ class: "ATTEMPT_BUDGET_EXHAUSTED", detail: `the page's ${policy.attempts.maxPerPage} attempts are spent` });
        result.attemptId = attemptId; result.attemptsUsed = ordinal; result.strategies.push("direct_http"); result.strategy = "direct_http";
        const paced = await pace(target, attemptId, deadline, signal);
        if (paced.failure) { await store.finishAttempt(attemptId, { outcome: paced.failure.class }); return fail(paced.failure); }
        try {
          httpRes = await pacedFetch(paced.domain, { url: req.url, headers: req.headers, maxBytes: policy.maxBodyBytes,
            deadline: Math.min(deadline, Date.now() + policy.attempts.httpAttemptMs), jar }, attemptId, deadline, signal);
        } catch (e) {
          await store.finishAttempt(attemptId, { outcome: e.failureClass ?? "ERROR" });
          if (!(e instanceof Denied)) throw e;
          const transient = e.failureClass === "TARGET_UNREACHABLE";
          if (transient && !sameTierRetried && Date.now() + 3000 < deadline) { sameTierRetried = true; await sleep(700 + Math.floor(Math.random() * 600), signal); continue; }
          return fail({ class: e.failureClass, detail: e.detail, retryable: e.retryable || transient || e.failureClass === "TIMEOUT", retryAfter: e.retryAfter });
        }
        // The bytes decide the type where they are unambiguous (spec §15: MIME from bytes as well as
        // headers): a PDF served as text is a PDF, and an HTML page served as a PDF is HTML.
        const declared = httpRes.headers["content-type"] ?? null;
        const ct = sniffContentType(httpRes.body, declared);
        if (ct !== declared) result.contentTypeDeclared = declared;
        const text = isTextual(ct) ? decodeText(httpRes.body, ct) : null;
        const verdict = classify({ status: httpRes.status, contentType: ct, body: text, finalUrl: httpRes.finalUrl, requestedUrl: req.url,
          retryAfter: retryAfterSeconds(httpRes.headers["retry-after"]) });
        await store.finishAttempt(attemptId, { outcome: verdict.failure?.class ?? verdict.verdict, targetStatus: httpRes.status, bytes: httpRes.bytes });
        Object.assign(result, { finalUrl: httpRes.finalUrl, targetStatus: httpRes.status, contentType: ct ?? null, bytes: httpRes.bytes, redirects: httpRes.redirects.map((r) => ({ url: r.url, status: r.status })), quality: { verdict: verdict.verdict, reasons: verdict.reasons ?? [] } });
        if (verdict.verdict === "target_error" && !sameTierRetried && Date.now() + 3000 < deadline) { sameTierRetried = true; await sleep(700 + Math.floor(Math.random() * 600), signal); continue; }
        // The cooldown belongs to the host that answered 429, wherever the chain began.
        if (verdict.verdict === "rate_limited") await store.coolDown(domainOf(parseTarget(httpRes.finalUrl, policy)), verdict.failure.retryAfter);
        if (verdict.failure) return fail(verdict.failure);
        if (verdict.verdict !== "js_shell" || req.purpose !== "page" || req.expect !== "html" || req.fast) {
          return finish({ ok: true, ...(text !== null ? { body: text } : { bodyBase64: httpRes.body.toString("base64") }) });
        }
        break;
      }

      // One browser attempt for a JS shell (spec §9.1), on the same permitted direct egress. It
      // renders where the direct attempt ended, a chain already paced hop by hop.
      if (signal?.aborted) return fail(CANCELLED);
      const renderUrl = httpRes.finalUrl;
      const renderTarget = parseTarget(renderUrl, policy);
      const attemptId = randomUUID();
      const ordinal = await store.reserveAttempt({ logicalId: req.logicalAcquisitionId, attemptId, requestId: req.requestId, purpose: req.purpose, strategy: "direct_browser", domain: target.host, maxAttempts: policy.attempts.maxPerPage });
      if (ordinal === null) return fail({ class: "ATTEMPT_BUDGET_EXHAUSTED", detail: `the page's ${policy.attempts.maxPerPage} attempts are spent before its browser attempt` });
      result.attemptId = attemptId; result.attemptsUsed = ordinal; result.strategies.push("direct_browser"); result.strategy = "direct_browser";
      const browserDeadline = Math.min(deadline, Date.now() + policy.attempts.browserAttemptMs);
      if (!(await holdPermit("browser", attemptId, permits.browser, browserDeadline, signal))) {
        await store.finishAttempt(attemptId, { outcome: "RESOURCE_BUSY" });
        return fail(signal?.aborted ? CANCELLED : { class: "RESOURCE_BUSY", detail: "no browser permit before the deadline", retryable: true });
      }
      let paced = null;
      try {
        // Paced inside the try, so a database error while pacing still frees the browser permit.
        paced = await pace(renderTarget, attemptId, browserDeadline, signal);
        if (paced.failure) { await store.finishAttempt(attemptId, { outcome: paced.failure.class }); return fail(paced.failure); }
        const r = await browser.render({ attemptId, url: renderUrl, deadline: browserDeadline, waitFor: req.waitFor, userAgent: USER_AGENT, signal, fixture: !!renderTarget.fixture });
        // A result without its final URL (a worker fault) is read as ending where it began, not
        // parsed as a URL it is not.
        const finalUrl = typeof r.finalUrl === "string" && r.finalUrl ? r.finalUrl : renderUrl;
        // The worker refuses main-frame navigations to another host, but a server redirect only the
        // browser followed is not seen until it happened: it is counted against its domain.
        if (finalUrl !== renderUrl) {
          let t = null;
          try { t = parseTarget(finalUrl, policy); } catch { /* refused by the proxy already */ }
          if (t && domainOf(t) !== paced.domain) { await store.recordNavigation(domainOf(t), !!t.fixture); log({ event: "browser_redirect_counted", attempt_id: attemptId, domain: domainOf(t) }); }
        }
        const verdict = r.ok ? classify({ status: r.status, contentType: r.contentType ?? "text/html", body: r.html, finalUrl, requestedUrl: req.url }) : null;
        // A page whose own structure still says "rendered by script" after its one browser attempt
        // is no content (spec §9.4); a page that is merely short is the page (review finding C5).
        const shell = verdict?.verdict === "js_shell" && verdict.structural === true;
        // A render that hit its subresource, request or byte cap loaded only part of the page: that is
        // a resource-limit result, not a success (spec §12; review finding W6).
        const limited = r.ok && (r.subresources?.overLimit > 0 || r.proxy?.capped === true)
          ? { class: "RESOURCE_LIMIT", detail: `the page passed its browser budget (${r.subresources?.requests ?? 0} subresources, ${r.proxy?.requests ?? 0} proxied requests, ${r.proxy?.bytes ?? 0} bytes)`, retryable: false, retryAfter: null } : null;
        const failure = !r.ok ? r.failure : limited ?? verdict.failure ?? (shell
          ? { class: "RENDER_INCOMPLETE", detail: `the page was still a script shell after rendering (${(verdict.reasons ?? []).join("; ")})` } : null);
        await store.finishAttempt(attemptId, { outcome: failure ? failure.class : "rendered", targetStatus: r.status ?? null, bytes: r.proxy?.bytes ?? null, subresources: r.subresources?.requests ?? null });
        if (verdict?.verdict === "rate_limited") { try { await store.coolDown(domainOf(parseTarget(finalUrl, policy)), verdict.failure.retryAfter); } catch { /* unparseable final URL */ } }
        if (failure) return fail(failure);
        return finish({ ok: true, body: r.html, finalUrl, targetStatus: r.status, contentType: r.contentType ?? "text/html; charset=utf-8",
          bytes: r.proxy?.bytes ?? 0, redirects: r.redirects ?? [], quality: { verdict: verdict.verdict === "js_shell" ? "adequate" : verdict.verdict, reasons: verdict.reasons ?? [] },
          subresources: r.subresources, proxyDenied: r.proxy?.denied ?? [] });
      } finally {
        await releaseAll(log, [paced && (() => store.releaseDomain(paced.domain, attemptId)), () => store.releasePermit("browser", attemptId)]);
      }
    } finally {
      await releaseAll(log, [() => store.releasePermit("url", holder)]);
    }
  };
}

// The content type the body's own bytes show, where they settle it; the declared type otherwise. A body is a
// PDF when it starts with the magic (after a BOM or whitespace), or when it is declared a PDF or an opaque
// type and the magic lies in the first KiB, as PDF readers allow: an HTML page that merely mentions
// "%PDF-" near its top stays HTML (review W5).
const PDF_MAGIC = Buffer.from("%PDF-");
export function sniffContentType(body, declared) {
  const head = body.subarray(0, 1024);
  if (/^(\xEF\xBB\xBF)?\s*%PDF-/.test(head.toString("latin1"))) return "application/pdf";
  if (declared && /^application\/pdf\b/i.test(declared) && /^\s*(<!doctype html|<html|<head|<body)/i.test(head.toString("latin1"))) return "text/html";
  if ((!declared || /^application\/(pdf|octet-stream)\b/i.test(declared)) && head.includes(PDF_MAGIC)) return "application/pdf";
  return declared;
}

export function retryAfterSeconds(v) {
  if (!v) return null;
  if (/^\d+$/.test(v)) return Number(v);
  const t = Date.parse(v);
  return Number.isFinite(t) ? Math.max(0, Math.ceil((t - Date.now()) / 1000)) : null;
}

// POST /internal/fetch: one direct attempt for an auxiliary download (sitemap, document,
// discovery), under the same target, pacing, permit and size rules, without the quality check or
// the browser. Resolves { status, headers, body, finalUrl } or throws Denied; finalUrl is the
// serialized URL, which a response header can carry (a raw one may hold characters it cannot:
// review finding S10).
// Its logical id is the caller's, or one derived from the purpose, method, URL and a ten-minute
// window, so repeated downloads of one URL (upstream retries, NuQ requeues, a second crawl of the
// same site) share one budget of attempts (review finding W1).
export const FETCH_WINDOW_MS = 10 * 60 * 1000;
export function fetchLogicalId(b, now = Date.now()) {
  if (typeof b.logicalAcquisitionId === "string" && b.logicalAcquisitionId && b.logicalAcquisitionId.length <= 256) return `fetch:${b.logicalAcquisitionId}`;
  const key = createHash("sha256").update(`${b.purpose} ${b.method === "HEAD" ? "HEAD" : "GET"} ${b.url}`).digest("hex").slice(0, 32);
  return `fetch:${key}:${Math.floor(now / FETCH_WINDOW_MS)}`;
}
export function makeFetcher({ store, getPolicy, getLocalReady, permits, resolvePublic, lookupFixture, urlHmac, log }) {
  const { holdPermit, pace, pacedFetch } = makePacer({ store, getPolicy, resolvePublic, lookupFixture, log });
  return async function fetchOnce(b, signal) {
    const policy = getPolicy();
    if (!b || typeof b.url !== "string" || typeof b.requestId !== "string") throw new Denied("INVALID_REQUEST", "url and requestId are required");
    if (!["sitemap", "document", "discovery"].includes(b.purpose)) throw new Denied("INVALID_REQUEST", "purpose must be sitemap, document or discovery");
    const method = b.method === "HEAD" ? "HEAD" : "GET";
    const target = parseTarget(b.url, policy);
    if (!getLocalReady()) throw new Denied("RETRIEVAL_NOT_READY", "the host's local-network list is not loaded");
    const deadline = Math.min(Date.parse(b.deadline) || Date.now() + 30000, Date.now() + 30000);
    const maxBytes = Math.min(Number.isInteger(b.maxBytes) ? b.maxBytes : policy.maxBodyBytes, policy.maxBodyBytes);
    const logicalId = fetchLogicalId(b);
    await store.openAcquisition(logicalId, urlHmac(b.url), new Date(deadline));
    // A download is one of the global URL acquisitions, like a page (spec §23.1).
    const holder = randomUUID();
    if (!(await holdPermit("url", holder, permits.url, deadline, signal))) throw signal?.aborted ? new Denied("CANCELLED", CANCELLED.detail) : new Denied("RESOURCE_BUSY", "no URL acquisition permit before the deadline", { retryable: true });
    try {
      const attemptId = randomUUID();
      const ordinal = await store.reserveAttempt({ logicalId, attemptId, requestId: b.requestId, purpose: b.purpose, strategy: "direct_http", domain: target.host, maxAttempts: policy.attempts.maxPerPage });
      if (ordinal === null) throw new Denied("ATTEMPT_BUDGET_EXHAUSTED", `this download's ${policy.attempts.maxPerPage} attempts are spent`);
      const paced = await pace(target, attemptId, deadline, signal);
      if (paced.failure) { await store.finishAttempt(attemptId, { outcome: paced.failure.class }); throw new Denied(paced.failure.class, paced.failure.detail, paced.failure); }
      let r;
      try {
        r = await pacedFetch(paced.domain, { url: b.url, method, headers: b.headers, maxBytes, deadline }, attemptId, deadline, signal);
      } catch (e) {
        await store.finishAttempt(attemptId, { outcome: e.failureClass ?? "ERROR" });
        throw e;
      }
      await store.finishAttempt(attemptId, { outcome: "fetched", targetStatus: r.status, bytes: r.bytes });
      if (r.status === 429) await store.coolDown(domainOf(parseTarget(r.finalUrl, policy)), retryAfterSeconds(r.headers["retry-after"]));
      log({ event: "fetch", request_id: b.requestId, purpose: b.purpose, url_hmac: urlHmac(b.url), target_status: r.status, bytes: r.bytes });
      return { ...r, finalUrl: new URL(r.finalUrl).href };
    } finally {
      await releaseAll(log, [() => store.releasePermit("url", holder)]);
    }
  };
}
