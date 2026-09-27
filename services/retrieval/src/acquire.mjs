// One logical acquisition (FIRECRAWL_PI_SPEC.md §8.3, §9, §10): validate, choose the route the first attempt
// starts on (route.mjs), then direct or residential HTTP, a browser attempt on the same route for a script
// shell, and - for an "auto" request - the residential route after a public-content challenge on the direct
// one. A transient target failure gets at most one same-tier retry. Every attempt is reserved against the
// logical page's persisted budget before dispatch (four in all, however many times upstream or NuQ asks), the
// acquisition holds one of the global URL permits, a browser attempt also holds the browser permit, and every
// navigation is paced per registrable domain on every route. A residential attempt first reserves its maximum
// proxy spend and settles at the bytes its tunnels carried (residential.mjs). Work that needs the residential
// route and cannot have it fails as PROXY_REQUIRED, and a challenge nothing further may answer as
// BLOCKED_PUBLIC_CONTENT: neither is ever retried from the home connection. Enhanced retrieval is M7's.
import { randomUUID, createHmac, createHash } from "node:crypto";
import { getDomain } from "tldts";
import { parseTarget, Denied } from "./ssrf.mjs";
import { guardedFetch, CookieJar, USER_AGENT } from "./httpfetch.mjs";
import { classify, isTextual } from "./quality.mjs";
import { ROUTES, startTier, startsInBrowser } from "./route.mjs";
import { Meter, sessionIdFor } from "./residential.mjs";

const PURPOSES = new Set(["page", "robots", "sitemap"]);
const EXPECTS = new Set(["html", "pdf", "document"]);
// A URL is logged and stored only as a keyed hash (spec §25). The key is the service's own and
// lasts across restarts (server.mjs), so the rows and log lines of one URL can be correlated
// whenever they were written (review finding S5).
export const makeUrlHmac = (key) => (url) => createHmac("sha256", key).update(url).digest("hex").slice(0, 32);
// Pacing, cooldowns and routing records are keyed by registrable domain; a fixture by its exact host.
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
// Without a residential provider wired in (unit tests of the direct path), the route is simply unavailable.
const NO_ROUTE = Object.freeze({ state: () => ({ available: false, reason: "NO_PROXY_SELECTED" }), availability: async () => ({ available: false, reason: "NO_PROXY_SELECTED" }) });
const RETRYABLE_ROUTE = new Set(["PROVIDER_UNAVAILABLE", "BUDGET_EXHAUSTED"]);
export const proxyRequired = (st, why) => ({ class: "PROXY_REQUIRED", detail: `${why} needs the residential route, which is unavailable (${st.reason})`,
  retryable: RETRYABLE_ROUTE.has(st.reason), retryAfter: st.retryAfter ?? null, route: { residential: st.reason } });

export function validateAcquireRequest(b) {
  const bad = (why) => { throw new Denied("INVALID_REQUEST", why); };
  if (!b || typeof b !== "object") bad("body must be an object");
  const str = (k, max) => { if (typeof b[k] !== "string" || !b[k] || b[k].length > max) bad(`${k} must be a string of at most ${max}`); return b[k]; };
  const out = {
    requestId: str("requestId", 128), logicalAcquisitionId: str("logicalAcquisitionId", 256), url: str("url", 8192),
    purpose: b.purpose ?? "page", expect: b.expect ?? "html", headers: b.headers ?? {}, waitFor: b.waitFor ?? 0, fast: b.fast === true,
    principalId: b.principalId ?? null, jobId: b.jobId ?? null, crawlId: b.crawlId ?? null, route: b.route ?? "auto",
  };
  const d = Date.parse(b.deadline);
  if (!Number.isFinite(d)) bad("deadline must be an ISO-8601 time");
  out.deadline = d;
  if (!PURPOSES.has(out.purpose)) bad("purpose must be page, robots or sitemap");
  if (!EXPECTS.has(out.expect)) bad("expect must be html, pdf or document");
  if (!ROUTES.has(out.route)) bad("route must be auto, basic or stealth");
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

// Releases each held resource on its own: one failed release (the database briefly away) must not
// skip the others; a lease that could not be released still expires (review finding W3).
async function releaseAll(log, releases) {
  const rs = await Promise.allSettled(releases.filter(Boolean).map((f) => f()));
  for (const r of rs) if (r.status === "rejected") log?.({ event: "release_failed", error: r.reason?.code ?? r.reason?.message });
}

// Pacing shared by every acquisition path and route (spec §10.2, §23.1): pace() takes one navigation's
// decision; pacedFetch() paces every hop of a redirect chain, so a redirect to another registrable domain meets
// that domain's gap, hold and caps (review finding C4). tier: the navigation's egress; the direct caps count
// only direct navigations.
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
  async function pace(target, holder, deadline, signal, tier = "direct") {
    const policy = getPolicy();
    const domain = domainOf(target);
    const limits = target.fixture?.limits === "fixture" ? policy.fixtureLimits : policy.direct;
    for (;;) {
      if (signal?.aborted) return { domain, failure: CANCELLED };
      const d = await store.paceDirect(domain, holder, limits, policy.attempts.browserAttemptMs, !!target.fixture, tier);
      if (d.go) return { domain };
      if (d.failure) return { domain, failure: d.failure };
      if (Date.now() + d.waitMs > deadline || signal?.aborted) return { domain, failure: { class: "DEADLINE_EXCEEDED", detail: "the domain's pacing would pass the deadline", retryable: true, retryAfter: null } };
      await sleep(d.waitMs, signal);
    }
  }
  // firstDomain: the domain the caller already paced for hop 0. Each later hop to another domain
  // releases the previous hold and is paced itself, on the same route; the last hold is released on return.
  async function pacedFetch(firstDomain, args, holder, deadline, signal, tier = "direct") {
    let held = firstDomain;
    try {
      return await guardedFetch({ ...args, policy: getPolicy(), resolvePublic, lookupFixture, signal, onHop: async ({ hop, target: t }) => {
        if (hop === 0 || domainOf(t) === held) return;
        if (held) await releaseAll(log, [() => store.releaseDomain(held, holder)]);
        held = null;
        const p = await pace(t, holder, deadline, signal, tier);
        if (p.failure) throw new Denied(p.failure.class, `redirect to ${p.domain}: ${p.failure.detail}`, p.failure);
        held = p.domain;
      } });
    } finally {
      if (held) await releaseAll(log, [() => store.releaseDomain(held, holder)]);
    }
  }
  return { holdPermit, pace, pacedFetch };
}

// The residential leg of one attempt: the route's state, the reservation of its maximum spend, and residential.leg's
// meter, sticky session and tunnel opener, bounded by the attempt's deadline and signal. open() refuses
// (PROXY_REQUIRED, BUDGET_EXHAUSTED) before anything is sent; close() settles at the measured bytes.
function makeLegs({ residential, urlHmac, getBudget }) {
  async function open({ logicalId, attemptId, why, deadline, signal }) {
    const st = await residential.availability();
    if (!st.available) return { failure: proxyRequired(st, why) };
    const bytes = getBudget().proxying.maxAttemptBytes;
    const r = await residential.reserve(st, { callKey: `proxy:${attemptId}`, logicalId, bytes });
    if (r.failure) return { failure: r.failure };
    return { leg: { ...residential.leg(st, { meter: new Meter(bytes), sessionId: sessionIdFor(urlHmac, logicalId), deadline, signal }), reservation: r.reservation, attemptId } };
  }
  // Settles a leg once, whoever asks: an explicit settlement and the finally that guards it share one result. A
  // settlement that fails leaves the reservation UNCERTAIN, still counted, rather than RESERVED for good (review W9).
  function close(leg, detail) {
    leg.closed ??= residential.settle(leg.st, leg.reservation, leg.meter, detail).catch(async (e) => {
      await residential.markUncertain(leg.reservation, leg.meter, `its settlement failed (${e.code ?? e.message}); ${detail}`).catch(() => {});
      throw e;
    });
    return leg.closed;
  }
  // Every leg a call opened and has not settled - an exception came between the reservation and its settlement - is
  // settled when the call ends (review W9).
  async function closeOpen(opened, log) {
    for (const leg of opened) if (!leg.closed) await close(leg, "interrupted before its settlement").catch((e) => log?.({ event: "leg_settle_failed", error: e.code ?? e.message }));
  }
  return { open, close, closeOpen };
}

export function makeAcquirer({ store, getPolicy, getLocalReady, permits, resolvePublic, lookupFixture, browser, urlHmac, log, residential = NO_ROUTE, getBudget = null }) {
  const { holdPermit, pace, pacedFetch } = makePacer({ store, getPolicy, resolvePublic, lookupFixture, log });
  const legs = makeLegs({ residential, urlHmac, getBudget });

  return async function acquire(body, signal) {
    const started = Date.now();
    const policy = getPolicy();
    const req = validateAcquireRequest(body);
    const result = { ok: false, logicalAcquisitionId: req.logicalAcquisitionId, attemptId: null, attemptsUsed: 0, strategy: null, strategies: [],
      initialStrategy: null, finalStrategy: null, route: { requested: req.route, start: null, reason: null, escalations: [] },
      finalUrl: req.url, targetStatus: 0, contentType: null, bytes: 0, redirects: [], quality: null, failure: null, costEstimate: 0, provider: null, proxy: null };
    const spent = []; // the residential legs of this call, settled
    const finish = (extra) => {
      Object.assign(result, extra);
      result.initialStrategy = result.strategies[0] ?? null;
      result.finalStrategy = result.strategies.at(-1) ?? null;
      if (spent.length) {
        const micro = spent.reduce((n, s) => n + (s.actual ?? s.reserved), 0);
        result.proxy = { subject: spent[0].subject, provider: spent[0].provider, bytes: spent.reduce((n, s) => n + s.bytes, 0), microUsd: micro, legs: spent };
        result.provider = spent[0].provider;
        result.costEstimate = micro / 1e6;
      }
      log({ event: "acquisition", request_id: req.requestId, logical_id: req.logicalAcquisitionId, purpose: req.purpose, url_hmac: urlHmac(req.url),
        attempts_used: result.attemptsUsed, strategies: result.strategies, initial_strategy: result.initialStrategy, final_strategy: result.finalStrategy,
        route_requested: req.route, route_start: result.route.start, route_reason: result.route.reason, escalations: result.route.escalations,
        target_status: result.targetStatus, verdict: result.quality?.verdict ?? null, failure: result.failure?.class ?? null, bytes: result.bytes,
        proxy_bytes: result.proxy?.bytes ?? 0, proxy_micro_usd: result.proxy?.microUsd ?? 0, proxy_states: spent.map((s) => s.state), ms: Date.now() - started });
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
    const openedLegs = [];
    try {
      const domain = domainOf(target);
      const [record, held] = await Promise.all([store.routeRecord(domain), store.routeHeld(domain)]);
      let start = startTier({ route: req.route, record, held, proxyFirst: policy.residential.proxyFirstDomains.includes(domain), routing: policy.routing });
      if (start.probe && !(await store.claimProbe(domain, policy.routing.probeMinutes))) start = { tier: "residential", reason: "probe_in_progress" };
      Object.assign(result.route, { start: start.tier, reason: start.reason });
      const probe = start.probe === true;
      // A route that needs the residential proxy is refused before any attempt when the proxy cannot be had.
      if (start.tier === "residential") {
        const st = await residential.availability();
        if (!st.available) return fail(proxyRequired(st, `this acquisition (${start.reason})`));
      }
      // Observations are learned under the domain that answered, after any redirect, as the 429 cooldown is (review W6);
      // the probe after an expired preference is the requested domain's, so it counts only when that domain answered.
      const learn = (d, obs, outcome) => store.learnRoute(d, obs, policy.routing, outcome)
        .catch((e) => log({ event: "route_learn_failed", domain_hash: urlHmac(d), error: e.code ?? e.message }));
      const answering = (url) => { try { return domainOf(parseTarget(url, policy)); } catch { return domain; } };
      // The direct limits are spent: an auto request moves this same attempt to the residential route, or stops; the
      // home connection is never used past them (spec §10.2). One helper for the HTTP and browser steps (review S1, S17).
      async function escalateAtCap(attemptId, mode, cap, legDeadline) {
        const o = await legs.open({ logicalId: req.logicalAcquisitionId, attemptId, why: `past the direct limits (${cap.directCap}), this acquisition`, deadline: legDeadline, signal });
        if (o.failure) { await store.finishAttempt(attemptId, { outcome: o.failure.class }); return { failure: o.failure }; }
        const leg = track(o.leg);
        await store.setAttemptStrategy(attemptId, `residential_${mode}`);
        result.strategies[result.strategies.length - 1] = result.strategy = `residential_${mode}`;
        result.route.escalations.push(`direct_cap:${cap.directCap}`);
        return { leg };
      }
      const jar = new CookieJar();
      const page = req.purpose === "page" && req.expect === "html" && !req.fast;
      const retried = { direct: false, residential: false };
      const note = (attemptId, ordinal, strategy) => { result.attemptId = attemptId; result.attemptsUsed = ordinal; result.strategies.push(strategy); result.strategy = strategy; };
      const opened = openedLegs;
      const settle = async (leg, detail) => {
        const first = !leg.closed;
        const s = await legs.close(leg, detail);
        if (first) spent.push({ attemptId: leg.attemptId, subject: leg.st.subject, provider: leg.st.providerName, rateCard: leg.st.card.id, bytes: s.bytes, reserved: s.reserved, actual: s.actual, state: s.state, tunnels: leg.meter.tunnels });
        return s;
      };
      const track = (leg) => { opened.push(leg); return leg; };

      // One HTTP attempt on `tier`. Returns { done }, { fail }, { retry }, { browser, renderUrl } or { escalate }.
      async function httpStep(tier) {
        const attemptId = randomUUID();
        const ordinal = await store.reserveAttempt({ logicalId: req.logicalAcquisitionId, attemptId, requestId: req.requestId, purpose: req.purpose, strategy: `${tier}_http`, domain: target.host, maxAttempts: policy.attempts.maxPerPage });
        if (ordinal === null) return { fail: { class: "ATTEMPT_BUDGET_EXHAUSTED", detail: `the page's ${policy.attempts.maxPerPage} attempts are spent` } };
        note(attemptId, ordinal, `${tier}_http`);
        let leg = null, paced;
        if (tier === "direct") {
          paced = await pace(target, attemptId, deadline, signal, "direct");
          if (paced.failure?.directCap && req.route === "auto") {
            const e = await escalateAtCap(attemptId, "http", paced.failure, deadline);
            if (e.failure) return { fail: e.failure };
            leg = e.leg; tier = "residential";
            paced = await pace(target, attemptId, deadline, signal, "residential");
          }
        } else {
          const o = await legs.open({ logicalId: req.logicalAcquisitionId, attemptId, why: "this attempt", deadline, signal });
          if (o.failure) { await store.finishAttempt(attemptId, { outcome: o.failure.class }); return { fail: o.failure }; }
          leg = track(o.leg);
          paced = await pace(target, attemptId, deadline, signal, "residential");
        }
        if (paced.failure) {
          if (leg) await settle(leg, `not sent: ${paced.failure.class}`);
          await store.finishAttempt(attemptId, { outcome: paced.failure.class });
          return { fail: paced.failure, tier };
        }
        let httpRes;
        try {
          httpRes = await pacedFetch(paced.domain, { url: req.url, headers: req.headers, maxBytes: leg ? Math.min(policy.maxBodyBytes, leg.meter.cap) : policy.maxBodyBytes,
            deadline: Math.min(deadline, Date.now() + policy.attempts.httpAttemptMs), jar, via: leg ? residential.via(leg) : null }, attemptId, deadline, signal, tier);
        } catch (err) {
          // A cut at the attempt's byte reservation may surface through TLS as a reset; it is the cap, whatever the
          // error says, and never earns a same-tier retry (review S12).
          const e = leg?.meter.capped ? new Denied("SIZE_LIMIT", "the attempt passed its proxy byte budget") : err;
          const s = leg ? await settle(leg, `failed: ${e.failureClass ?? "ERROR"}`) : null;
          await store.finishAttempt(attemptId, { outcome: e.failureClass ?? "ERROR", bytes: s?.bytes ?? null });
          if (!(e instanceof Denied)) throw e;
          // A provider's failure is the provider's (its breaker counted it): no domain learning, no other route.
          if (e.provider) return { fail: { class: e.failureClass, detail: e.detail, retryable: e.retryable, retryAfter: e.retryAfter, provider: true }, tier };
          const transient = e.failureClass === "TARGET_UNREACHABLE";
          if (transient && !retried[tier] && Date.now() + 3000 < deadline) { retried[tier] = true; return { retry: true, tier }; }
          return { fail: { class: e.failureClass, detail: e.detail, retryable: e.retryable || transient || e.failureClass === "TIMEOUT", retryAfter: e.retryAfter }, tier };
        }
        const s = leg ? await settle(leg, `fetched ${httpRes.status}`) : null;
        // The bytes decide the type where they are unambiguous (spec §15: MIME from bytes as well as
        // headers): a PDF served as text is a PDF, and an HTML page served as a PDF is HTML.
        const declared = httpRes.headers["content-type"] ?? null;
        const ct = sniffContentType(httpRes.body, declared);
        if (ct !== declared) result.contentTypeDeclared = declared;
        const text = isTextual(ct) ? decodeText(httpRes.body, ct) : null;
        const verdict = classify({ status: httpRes.status, contentType: ct, body: text, finalUrl: httpRes.finalUrl, requestedUrl: req.url,
          retryAfter: retryAfterSeconds(httpRes.headers["retry-after"]) });
        await store.finishAttempt(attemptId, { outcome: verdict.failure?.class ?? verdict.verdict, targetStatus: httpRes.status, bytes: s?.bytes ?? httpRes.bytes });
        Object.assign(result, { finalUrl: httpRes.finalUrl, targetStatus: httpRes.status, contentType: ct ?? null, bytes: httpRes.bytes, redirects: httpRes.redirects.map((r) => ({ url: r.url, status: r.status })), quality: { verdict: verdict.verdict, reasons: verdict.reasons ?? [] } });
        if (verdict.verdict === "target_error" && !retried[tier] && Date.now() + 3000 < deadline) { retried[tier] = true; return { retry: true, tier }; }
        // The cooldown belongs to the host that answered 429, wherever the chain began, and holds on every route:
        // a rate limit is respected, never rotated around (spec §9.2).
        if (verdict.verdict === "rate_limited") await store.coolDown(domainOf(parseTarget(httpRes.finalUrl, policy)), verdict.failure.retryAfter);
        const answered = answering(httpRes.finalUrl), probed = probe && tier === "direct" && answered === domain;
        if (verdict.verdict === "challenge") {
          await learn(answered, { tier, mode: "http", outcome: "challenge", probe: probed }, { success: false, failureClass: "BLOCKED_PUBLIC_CONTENT" });
          if (tier === "direct" && req.route === "auto") return { escalate: true, mode: "http", from: "direct_http", detail: "the target served a bot interstitial to the direct route", tier };
          return { fail: { ...verdict.failure, detail: tier === "residential" ? "the target served a bot interstitial on the residential route; enhanced retrieval is not available (M7)" : "the target served a bot interstitial, and a local-only (basic) request does not escalate" }, tier };
        }
        if (verdict.failure) { await learn(answered, null, { success: false, failureClass: verdict.failure.class }); return { fail: verdict.failure, tier }; }
        if (verdict.verdict !== "js_shell" || !page) {
          // A script shell returned unrendered (fast mode, a non-page purpose) still needed a browser: it teaches nothing
          // that would undo the browser learning (review S15).
          if (!["not_found", "target_error", "js_shell"].includes(verdict.verdict)) await learn(answered, { tier, mode: "http", outcome: "adequate", probe: probed }, { success: true });
          return { done: finish({ ok: true, ...(text !== null ? { body: text } : { bodyBase64: httpRes.body.toString("base64") }) }) };
        }
        return { browser: true, renderUrl: httpRes.finalUrl, tier };
      }

      // One browser attempt on `tier`. shellTier: the tier on which the HTTP attempt just saw a script shell.
      async function browserStep(tier, renderUrl, shellTier) {
        if (signal?.aborted) return { fail: CANCELLED };
        const renderTarget = parseTarget(renderUrl, policy);
        const strategy = `${tier}_browser`;
        const attemptId = randomUUID();
        const ordinal = await store.reserveAttempt({ logicalId: req.logicalAcquisitionId, attemptId, requestId: req.requestId, purpose: req.purpose, strategy, domain: target.host, maxAttempts: policy.attempts.maxPerPage });
        if (ordinal === null) return { fail: { class: "ATTEMPT_BUDGET_EXHAUSTED", detail: `the page's ${policy.attempts.maxPerPage} attempts are spent before its browser attempt` } };
        note(attemptId, ordinal, strategy);
        const browserDeadline = Math.min(deadline, Date.now() + policy.attempts.browserAttemptMs);
        if (!(await holdPermit("browser", attemptId, permits.browser, browserDeadline, signal))) {
          await store.finishAttempt(attemptId, { outcome: "RESOURCE_BUSY" });
          return { fail: signal?.aborted ? CANCELLED : { class: "RESOURCE_BUSY", detail: "no browser permit before the deadline", retryable: true } };
        }
        let paced = null, leg = null;
        try {
          if (tier === "residential") {
            const o = await legs.open({ logicalId: req.logicalAcquisitionId, attemptId, why: "this browser attempt", deadline: browserDeadline, signal });
            if (o.failure) { await store.finishAttempt(attemptId, { outcome: o.failure.class }); return { fail: o.failure }; }
            leg = track(o.leg);
          }
          // Paced inside the try, so a database error while pacing still frees the browser permit.
          paced = await pace(renderTarget, attemptId, browserDeadline, signal, tier);
          if (paced.failure?.directCap && req.route === "auto" && tier === "direct") {
            const e = await escalateAtCap(attemptId, "browser", paced.failure, browserDeadline);
            if (e.failure) return { fail: e.failure };
            leg = e.leg; tier = "residential";
            paced = await pace(renderTarget, attemptId, browserDeadline, signal, "residential");
          }
          if (paced.failure) {
            if (leg) await settle(leg, `not sent: ${paced.failure.class}`);
            await store.finishAttempt(attemptId, { outcome: paced.failure.class });
            return { fail: paced.failure };
          }
          // Every request the page makes - the document, its redirects and subresources - leaves through this
          // service's forward proxy; on the residential route each is tunnelled on the attempt's leg, under one session.
          const r = await browser.render({ attemptId, url: renderUrl, deadline: browserDeadline, waitFor: req.waitFor, userAgent: USER_AGENT, signal, fixture: !!renderTarget.fixture, upstream: leg });
          const s = leg ? await settle(leg, `rendered ${r.status ?? r.failure?.class ?? ""}`) : null;
          // A result without its final URL (a worker fault) is read as ending where it began, not
          // parsed as a URL it is not.
          const finalUrl = typeof r.finalUrl === "string" && r.finalUrl ? r.finalUrl : renderUrl;
          // The worker refuses main-frame navigations to another host, but a server redirect only the
          // browser followed is not seen until it happened: a direct one is counted against its domain.
          if (finalUrl !== renderUrl && tier === "direct") {
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
          // A residential render whose leg passed its byte reservation loaded only part of the page too (review W2).
          const limited = r.ok && (r.subresources?.overLimit > 0 || r.proxy?.capped === true || leg?.meter.capped === true)
            ? { class: "RESOURCE_LIMIT", detail: `the page passed its browser budget (${r.subresources?.requests ?? 0} subresources, ${r.proxy?.requests ?? 0} proxied requests, ${r.proxy?.bytes ?? 0} bytes)`, retryable: false, retryAfter: null } : null;
          // A render that failed because the provider refused its tunnels is the provider's failure, not the page's.
          const providerFailure = !r.ok && r.proxy?.upstreamFailure ? { ...r.proxy.upstreamFailure, provider: true } : null;
          const failure = providerFailure ?? (!r.ok ? r.failure : limited ?? verdict.failure ?? (shell
            ? { class: "RENDER_INCOMPLETE", detail: `the page was still a script shell after rendering (${(verdict.reasons ?? []).join("; ")})` } : null));
          await store.finishAttempt(attemptId, { outcome: failure ? failure.class : "rendered", targetStatus: r.status ?? null, bytes: s?.bytes ?? r.proxy?.bytes ?? null, subresources: r.subresources?.requests ?? null });
          if (verdict?.verdict === "rate_limited") { try { await store.coolDown(domainOf(parseTarget(finalUrl, policy)), verdict.failure.retryAfter); } catch { /* unparseable final URL */ } }
          const answered = answering(finalUrl), probed = probe && tier === "direct" && answered === domain;
          if (verdict?.verdict === "challenge") {
            await learn(answered, { tier, mode: "browser", outcome: "challenge", probe: probed }, { success: false, failureClass: "BLOCKED_PUBLIC_CONTENT" });
            if (tier === "direct" && req.route === "auto") return { escalate: true, mode: "browser", from: "direct_browser", detail: "the rendered page was a bot interstitial on the direct route", renderUrl };
            return { fail: { ...verdict.failure, detail: tier === "residential" ? "the rendered page was a bot interstitial on the residential route; enhanced retrieval is not available (M7)" : "the rendered page was a bot interstitial, and a local-only (basic) request does not escalate" } };
          }
          if (failure) {
            if (!failure.provider && verdict?.failure) await learn(answered, null, { success: false, failureClass: failure.class });
            return { fail: failure };
          }
          await learn(answered, { tier, mode: "browser", outcome: "adequate", probe: probed }, { success: true });
          if (shellTier === tier) await learn(answered, { tier, mode: "browser", outcome: "js_rendered" });
          return { done: finish({ ok: true, body: r.html, finalUrl, targetStatus: r.status, contentType: r.contentType ?? "text/html; charset=utf-8",
            bytes: r.proxy?.bytes ?? 0, redirects: r.redirects ?? [], quality: { verdict: verdict.verdict === "js_shell" ? "adequate" : verdict.verdict, reasons: verdict.reasons ?? [] },
            subresources: r.subresources, proxyDenied: r.proxy?.denied ?? [] }) };
        } finally {
          await releaseAll(log, [paced && (() => store.releaseDomain(paced.domain, attemptId)), () => store.releasePermit("browser", attemptId)]);
        }
      }

      let tier = start.tier, renderUrl = req.url, shellTier = null;
      let mode = page && startsInBrowser(record) ? "browser" : "http";
      if (mode === "browser") result.route.escalations.push("learned_js");
      for (;;) {
        if (signal?.aborted) return fail(CANCELLED); // no attempt is reserved for a caller that left
        const s = mode === "http" ? await httpStep(tier) : await browserStep(tier, renderUrl, shellTier);
        if (s.done) return s.done;
        if (s.fail) return fail(s.fail);
        tier = s.tier ?? tier;
        if (s.retry) { await sleep(700 + Math.floor(Math.random() * 600), signal); continue; }
        if (s.browser) { mode = "browser"; renderUrl = s.renderUrl; shellTier = tier; continue; }
        if (s.escalate) {
          const st = await residential.availability();
          if (!st.available) return fail({ class: "BLOCKED_PUBLIC_CONTENT", detail: `${s.detail}; the residential route is unavailable (${st.reason})`, retryable: false, route: { residential: st.reason } });
          result.route.escalations.push(`${s.from}->residential_${s.mode}`);
          tier = "residential"; mode = s.mode; renderUrl = s.renderUrl ?? renderUrl;
          continue;
        }
        throw new Error("acquire: a step returned no outcome");
      }
    } finally {
      await legs.closeOpen(openedLegs, log);
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

// POST /internal/fetch: one attempt for an auxiliary download (sitemap, document, discovery), under the
// same target, pacing, permit, size and route rules, without the quality check or the browser. A domain held
// for a job, listed proxy-first or learned to block the home connection is fetched on the residential route or
// refused as PROXY_REQUIRED, like a page; an auxiliary download is never the probe after a preference expires.
// The request carries no route of its own (the core sends none), so it never escalates to the paid route: past
// the direct limits it is refused as PROXY_REQUIRED, and a basic job's downloads never pay (review W7). Resolves { status, headers, body, finalUrl } or throws Denied; finalUrl is the serialized URL,
// which a response header can carry (a raw one may hold characters it cannot: review finding S10).
// Its logical id is the caller's, or one derived from the purpose, method, URL and a ten-minute
// window, so repeated downloads of one URL (upstream retries, NuQ requeues, a second crawl of the
// same site) share one budget of attempts (review finding W1).
export const FETCH_WINDOW_MS = 10 * 60 * 1000;
export function fetchLogicalId(b, now = Date.now()) {
  if (typeof b.logicalAcquisitionId === "string" && b.logicalAcquisitionId && b.logicalAcquisitionId.length <= 256) return `fetch:${b.logicalAcquisitionId}`;
  const key = createHash("sha256").update(`${b.purpose} ${b.method === "HEAD" ? "HEAD" : "GET"} ${b.url}`).digest("hex").slice(0, 32);
  return `fetch:${key}:${Math.floor(now / FETCH_WINDOW_MS)}`;
}
export function makeFetcher({ store, getPolicy, getLocalReady, permits, resolvePublic, lookupFixture, urlHmac, log, residential = NO_ROUTE, getBudget = null }) {
  const { holdPermit, pace, pacedFetch } = makePacer({ store, getPolicy, resolvePublic, lookupFixture, log });
  const legs = makeLegs({ residential, urlHmac, getBudget });
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
    const domain = domainOf(target);
    const [record, held] = await Promise.all([store.routeRecord(domain), store.routeHeld(domain)]);
    const start = startTier({ route: "auto", record, held, proxyFirst: policy.residential.proxyFirstDomains.includes(domain), routing: policy.routing });
    let tier = start.probe ? "residential" : start.tier;
    if (tier === "residential") {
      const st = await residential.availability();
      if (!st.available) { const f = proxyRequired(st, `this ${b.purpose} download (${start.probe ? "probe_pending" : start.reason})`); throw new Denied(f.class, f.detail, f); }
    }
    // A download is one of the global URL acquisitions, like a page (spec §23.1).
    const holder = randomUUID();
    if (!(await holdPermit("url", holder, permits.url, deadline, signal))) throw signal?.aborted ? new Denied("CANCELLED", CANCELLED.detail) : new Denied("RESOURCE_BUSY", "no URL acquisition permit before the deadline", { retryable: true });
    let leg = null;
    try {
      const attemptId = randomUUID();
      const ordinal = await store.reserveAttempt({ logicalId, attemptId, requestId: b.requestId, purpose: b.purpose, strategy: `${tier}_http`, domain: target.host, maxAttempts: policy.attempts.maxPerPage });
      if (ordinal === null) throw new Denied("ATTEMPT_BUDGET_EXHAUSTED", `this download's ${policy.attempts.maxPerPage} attempts are spent`);
      let paced;
      if (tier === "direct") {
        paced = await pace(target, attemptId, deadline, signal, "direct");
      } else {
        const o = await legs.open({ logicalId, attemptId, why: `this ${b.purpose} download`, deadline, signal });
        if (o.failure) { await store.finishAttempt(attemptId, { outcome: o.failure.class }); throw new Denied(o.failure.class, o.failure.detail, o.failure); }
        leg = o.leg;
        paced = await pace(target, attemptId, deadline, signal, "residential");
      }
      if (paced.failure) {
        if (leg) { await legs.close(leg, `not sent: ${paced.failure.class}`); leg = null; }
        await store.finishAttempt(attemptId, { outcome: paced.failure.class });
        throw new Denied(paced.failure.class, paced.failure.detail, paced.failure);
      }
      let r;
      try {
        r = await pacedFetch(paced.domain, { url: b.url, method, headers: b.headers, maxBytes: leg ? Math.min(maxBytes, leg.meter.cap) : maxBytes, deadline, via: leg ? residential.via(leg) : null }, attemptId, deadline, signal, tier);
      } catch (err) {
        const e = leg?.meter.capped ? new Denied("SIZE_LIMIT", "the download passed its proxy byte budget") : err;
        const s = leg ? await legs.close(leg, `failed: ${e.failureClass ?? "ERROR"}`) : null;
        leg = null;
        await store.finishAttempt(attemptId, { outcome: e.failureClass ?? "ERROR", bytes: s?.bytes ?? null });
        throw e;
      }
      const s = leg ? await legs.close(leg, `fetched ${r.status}`) : null;
      leg = null;
      await store.finishAttempt(attemptId, { outcome: "fetched", targetStatus: r.status, bytes: s?.bytes ?? r.bytes });
      if (r.status === 429) await store.coolDown(domainOf(parseTarget(r.finalUrl, policy)), retryAfterSeconds(r.headers["retry-after"]));
      log({ event: "fetch", request_id: b.requestId, purpose: b.purpose, url_hmac: urlHmac(b.url), target_status: r.status, bytes: r.bytes, strategy: `${tier}_http`,
        route_reason: start.reason, proxy_bytes: s?.bytes ?? 0, proxy_micro_usd: s ? (s.actual ?? s.reserved) : 0 });
      return { ...r, finalUrl: new URL(r.finalUrl).href };
    } finally {
      if (leg) await legs.closeOpen([leg], log);
      await releaseAll(log, [() => store.releasePermit("url", holder)]);
    }
  };
}
