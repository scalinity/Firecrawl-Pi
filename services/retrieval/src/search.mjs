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
// choice, from the policy and the host's selection (fixture or live), never the caller's.
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
    req.on("error", (e) => done(reject, new Denied("SEARCH_BACKEND_UNAVAILABLE", `the search backend could not be reached (${e.code ?? e.message})`, { retryable: true })));
    signal?.addEventListener("abort", () => { req.destroy(); done(reject, new Denied("CANCELLED", "the caller cancelled")); }, { once: true });
  });
}

export function makeSearcher({ store, getPolicy, getSelection, searchUrl, log }) {
  return async function search(inboundUrl, signal) {
    const policy = getPolicy(), S = policy.search;
    const inbound = new URL(inboundUrl, "http://x");
    const q = inbound.searchParams.get("q") ?? "";
    if (!q.trim() || q.length > 500) throw new Denied("INVALID_REQUEST", "the query must be 1-500 characters");
    const pageno = Number(inbound.searchParams.get("pageno") ?? "1");
    if (!Number.isInteger(pageno) || pageno < 1 || pageno > 5) throw new Denied("INVALID_REQUEST", "pageno must be 1-5");
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
    const url = new URL(searchUrl);
    url.searchParams.set("q", q);
    url.searchParams.set("format", "json");
    url.searchParams.set("pageno", String(pageno));
    url.searchParams.set("language", language);
    url.searchParams.set("engines", engines.join(","));
    let r;
    try { r = await backendGet(url, S.deadlineMs, signal); } catch (e) { done(e.failureClass); throw e; }
    if (r.status !== 200) { done("backend_error", { status: r.status }); throw new Denied("SEARCH_BACKEND_ERROR", `the search backend answered HTTP ${r.status}`, { retryable: r.status >= 500 }); }
    let data;
    try { data = JSON.parse(r.body.toString("utf8")); } catch { done("backend_error"); throw new Denied("SEARCH_BACKEND_ERROR", "the search backend's answer is not JSON"); }
    if (!data || !Array.isArray(data.results)) { done("backend_error"); throw new Denied("SEARCH_BACKEND_ERROR", "the search backend's answer has no results list"); }
    const results = data.results
      .filter((x) => x && typeof x.url === "string" && /^https?:\/\//i.test(x.url) && x.url.length <= 2048)
      .slice(0, S.maxResults)
      .map((x) => ({ url: x.url, title: typeof x.title === "string" ? x.title.slice(0, 500) : "", content: typeof x.content === "string" ? x.content.slice(0, 2000) : "" }));
    const failed = new Map();
    for (const u of Array.isArray(data.unresponsive_engines) ? data.unresponsive_engines : []) {
      const [name, why] = Array.isArray(u) ? u : [u?.name ?? u, u?.error ?? ""];
      if (engines.includes(name)) failed.set(name, String(why ?? "").slice(0, 120));
    }
    const answered = engines.filter((e) => !failed.has(e));
    const unresponsive = [...failed].map(([engine, reason]) => ({ engine, reason }));
    if (!results.length && !answered.length) {
      done("engines_failed", { unresponsive: unresponsive.length });
      throw new Denied("SEARCH_ENGINES_FAILED", `no search engine answered: ${unresponsive.map((u) => `${u.engine} (${u.reason || "no reason"})`).join(", ")}`, { retryable: true, retryAfter: 60 });
    }
    const body = { results, unresponsive_engines: unresponsive, fcpi: { cache: "miss", engines, answered, partial: unresponsive.length > 0, empty: results.length === 0 } };
    if (!unresponsive.length) await store.searchCachePut(key, body, S.cacheSeconds);
    done(results.length ? (unresponsive.length ? "partial" : "results") : (unresponsive.length ? "empty_partial" : "empty"), { results: results.length, unresponsive: unresponsive.length });
    return { status: 200, body };
  };
}
