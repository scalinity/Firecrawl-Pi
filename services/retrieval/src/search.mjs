// GET /searxng/search (FIRECRAWL_PI_SPEC.md §13): the core's search, answered by the private SearXNG, whose
// own requests to search engines leave only through this service's search proxy (proxy.mjs). What the
// core is told is always one of four things, never a failure dressed as an empty list (review finding S6):
//   results       200 with the results, and the engines that did not answer, if any (partial);
//   true empty    200 with no results, when at least one engine answered and found nothing;
//   engine failure 502 SEARCH_ENGINES_FAILED, when no engine answered;
//   backend failure 503 SEARCH_BACKEND_UNAVAILABLE / 502 SEARCH_BACKEND_ERROR / 504 SEARCH_TIMEOUT.
// Identical normalized queries are answered from the cache for 15 minutes; only a complete answer (every
// engine answered) is stored, so neither an outage nor a partial list is ever replayed as the truth. At most
// 60 queries an hour reach the backend (SEARCH_RATE_LIMITED past that). The engines are the deployment's
// choice, from the policy and the host's selection (fixture or live), never the caller's. A selected engine the
// backend has not loaded (SearXNG skips it without a word: an engine its defaults mark inactive is never loaded)
// is reported as not answering, so a search served by fewer engines than chosen says so.
import http from "node:http";
import { createHash } from "node:crypto";
import { Denied } from "./ssrf.mjs";

const sha = (s) => createHash("sha256").update(s).digest("hex");

export function normalizeQuery(q) { return q.normalize("NFC").trim().replace(/\s+/g, " ").toLowerCase(); }

// One request to the SearXNG backend; resolves { status, body } or rejects with a Denied naming the failure.
function backendGet(url, deadlineMs, signal) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const done = (fn, v) => { if (!settled) { settled = true; clearTimeout(timer); fn(v); } };
    const req = http.get(url, { agent: false, headers: { accept: "application/json" } }, (res) => {
      const chunks = [];
      let n = 0;
      res.on("data", (c) => { n += c.length; if (n > 4 * 1048576) { res.destroy(); done(reject, new Denied("SEARCH_BACKEND_ERROR", "the search backend's answer exceeds 4 MiB")); } else chunks.push(c); });
      res.on("end", () => done(resolve, { status: res.statusCode, body: Buffer.concat(chunks) }));
      res.on("error", () => done(reject, new Denied("SEARCH_BACKEND_ERROR", "the search backend's answer was cut off", { retryable: true })));
    });
    const timer = setTimeout(() => { req.destroy(); done(reject, new Denied("SEARCH_TIMEOUT", `the search backend did not answer within ${deadlineMs} ms`, { retryable: true })); }, deadlineMs);
    // A stopped backend's address stops answering, so a connection to it hangs rather than being refused:
    // no connection within 2 s is the backend being down, told apart from one that connects and stalls.
    const connectTimer = setTimeout(() => { req.destroy(); done(reject, new Denied("SEARCH_BACKEND_UNAVAILABLE", "the search backend did not accept a connection within 2000 ms", { retryable: true })); }, Math.min(2000, deadlineMs));
    req.on("socket", (s) => { if (!s.connecting) clearTimeout(connectTimer); else s.once("connect", () => clearTimeout(connectTimer)); });
    const clear = () => clearTimeout(connectTimer);
    req.on("response", clear); req.on("error", clear); req.on("close", clear);
    req.on("error", (e) => done(reject, new Denied("SEARCH_BACKEND_UNAVAILABLE", `the search backend could not be reached (${e.code ?? e.message})`, { retryable: true })));
    signal?.addEventListener("abort", () => { req.destroy(); done(reject, new Denied("CANCELLED", "the caller cancelled")); }, { once: true });
  });
}

// The engines the backend has loaded, from SearXNG's /config (a disabled engine is listed, since a request may name
// it; an inactive one is not loaded at all). A read is kept ten minutes; a failed one, from which nothing is concluded,
// thirty seconds. Concurrent searches share one read, which no single caller's cancellation ends (review R13).
export const LOADED_TTL_MS = 10 * 60e3, LOADED_RETRY_MS = 30e3;
// A search tries to gather the spec's largest result count (§13: ten) before it asks a fallback engine.
export const FILL_TO = 10;
export function makeSearcher({ store, getPolicy, getSelection, searchUrl, log, clock = Date.now }) {
  let loaded = { until: -Infinity, names: null }, reading = null;
  function loadedEngines() {
    if (clock() < loaded.until) return Promise.resolve(loaded.names);
    reading ??= (async () => {
      let names = null;
      try {
        const r = await backendGet(new URL("/config", searchUrl), 2000, null);
        const cfg = r.status === 200 ? JSON.parse(r.body.toString("utf8")) : null;
        if (Array.isArray(cfg?.engines)) names = new Set(cfg.engines.map((e) => e?.name).filter((n) => typeof n === "string"));
      } catch { /* unreadable: nothing is concluded */ }
      loaded = { until: clock() + (names ? LOADED_TTL_MS : LOADED_RETRY_MS), names };
      return names;
    })().finally(() => { reading = null; });
    return reading;
  }
  return async function search(inboundUrl, signal) {
    const policy = getPolicy(), S = policy.search;
    const inbound = new URL(inboundUrl, "http://x");
    const q = inbound.searchParams.get("q") ?? "";
    if (!q.trim() || q.length > 500) throw new Denied("INVALID_REQUEST", "the query must be 1-500 characters");
    // Only the first page: SearXNG skips engines that cannot page for a later one without naming them, so an
    // empty later page could not be told from a true empty answer. The core asks for page 1 alone (review S14).
    const pageno = Number(inbound.searchParams.get("pageno") ?? "1");
    if (pageno !== 1) throw new Denied("INVALID_REQUEST", "only the first page of results is served (pageno=1)");
    const language = inbound.searchParams.get("language") || "auto";
    if (!/^[A-Za-z-]{1,16}$/.test(language)) throw new Denied("INVALID_REQUEST", "language must be a language tag");
    const selection = getSelection().search;
    const engines = S.engines[selection];
    const key = sha(JSON.stringify([normalizeQuery(q), language, pageno, engines]));
    const t0 = Date.now();
    const done = (outcome, extra = {}) => log({ event: "search", selection, engines, query_sha256: key.slice(0, 16), outcome, ms: Date.now() - t0, ...extra });
    const cached = await store.searchCacheGet(key);
    if (cached) { done("cache_hit", { results: cached.results.length }); return { status: 200, body: { ...cached, fcpi: { ...cached.fcpi, cache: "hit" } } }; }
    const adm = await store.admitSearchQuery(S.perHour);
    if (!adm.admitted) { done("rate_limited"); throw new Denied("SEARCH_RATE_LIMITED", `${S.perHour} searches reached the backend in the last hour (spec §13)`, { retryable: true, retryAfter: 60 }); }
    // A search asks the selection's engines first, with their second page when the first holds fewer than FILL_TO
    // results, and the fallback engines (those the home connection cannot reach, on the residential route) only when the
    // first engines failed or still answered fewer: a search spends nothing while the home connection's engines answer it
    // (review R8). The phases share the backend deadline.
    const fallback = S.fallbackEngines?.[selection] ?? [];
    const deadline = t0 + S.deadlineMs;
    async function ask(engs, page) {
      const url = new URL(searchUrl);
      url.searchParams.set("q", q);
      url.searchParams.set("format", "json");
      url.searchParams.set("pageno", String(page));
      url.searchParams.set("language", language);
      url.searchParams.set("engines", engs.join(","));
      const r = await backendGet(url, Math.max(1, deadline - Date.now()), signal);
      if (r.status !== 200) throw new Denied("SEARCH_BACKEND_ERROR", `the search backend answered HTTP ${r.status}`, { retryable: r.status >= 500 });
      let data;
      try { data = JSON.parse(r.body.toString("utf8")); } catch { throw new Denied("SEARCH_BACKEND_ERROR", "the search backend's answer is not JSON"); }
      if (!data || !Array.isArray(data.results)) throw new Denied("SEARCH_BACKEND_ERROR", "the search backend's answer has no results list");
      const failed = new Map();
      for (const u of Array.isArray(data.unresponsive_engines) ? data.unresponsive_engines : []) {
        const [name, why] = Array.isArray(u) ? u : [u?.name ?? u, u?.error ?? ""];
        if (engs.includes(name)) failed.set(name, String(why ?? "").slice(0, 120));
      }
      const results = data.results
        .filter((x) => x && typeof x.url === "string" && /^https?:\/\//i.test(x.url) && x.url.length <= 2048)
        .map((x) => ({ url: x.url, title: typeof x.title === "string" ? x.title.slice(0, 500) : "", content: typeof x.content === "string" ? x.content.slice(0, 2000) : "" }));
      return { results, failed };
    }
    const loadedNow = loadedEngines();
    const results = [], seen = new Set(), failed = new Map(), queried = [...engines];
    const add = (rs) => { for (const x of rs) if (!seen.has(x.url) && results.length < S.maxResults) { seen.add(x.url); results.push(x); } };
    const notLoaded = (engs, names) => { for (const e of engs) if (names && !names.has(e) && !failed.has(e)) failed.set(e, "not loaded by the search backend"); };
    let first;
    try { first = await ask(engines, 1); } catch (e) { done(e.failureClass); throw e; }
    add(first.results);
    for (const [k, v] of first.failed) failed.set(k, v);
    const names = await loadedNow;
    notLoaded(engines, names);
    const live = engines.filter((e) => !failed.has(e));
    let pages = 1;
    if (results.length < FILL_TO && live.length && first.results.length && deadline - Date.now() > 1000) {
      try { add((await ask(live, 2)).results); pages = 2; }
      catch (e) { if (e.failureClass === "CANCELLED") { done("CANCELLED"); throw e; } /* the first page's answer stands */ }
    }
    if (fallback.length && (results.length < FILL_TO || !live.length) && deadline - Date.now() > 1000) {
      queried.push(...fallback);
      try {
        const extra = await ask(fallback, 1);
        add(extra.results);
        for (const [k, v] of extra.failed) failed.set(k, v);
        notLoaded(fallback, names);
      } catch (e) {
        if (e.failureClass === "CANCELLED") { done("CANCELLED"); throw e; }
        for (const f of fallback) failed.set(f, String(e.detail ?? e.failureClass).slice(0, 120));
      }
    }
    const answered = queried.filter((e) => !failed.has(e));
    const unresponsive = [...failed].map(([engine, reason]) => ({ engine, reason }));
    if (!results.length && !answered.length) {
      done("engines_failed", { unresponsive: unresponsive.length });
      throw new Denied("SEARCH_ENGINES_FAILED", `no search engine answered: ${unresponsive.map((u) => `${u.engine} (${u.reason || "no reason"})`).join(", ")}`, { retryable: true, retryAfter: 60 });
    }
    const usedFallback = queried.length > engines.length;
    const body = { results, unresponsive_engines: unresponsive, fcpi: { cache: "miss", engines: queried, answered, partial: unresponsive.length > 0, empty: results.length === 0, pages, fallback: usedFallback } };
    if (!unresponsive.length) await store.searchCachePut(key, body, S.cacheSeconds);
    done(results.length ? (unresponsive.length ? "partial" : "results") : (unresponsive.length ? "empty_partial" : "empty"), { results: results.length, unresponsive: unresponsive.length, pages, fallback: usedFallback });
    return { status: 200, body };
  };
}
