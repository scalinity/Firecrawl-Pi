// The search route (src/search.mjs) against a loopback stand-in for SearXNG's JSON API: results, a true
// empty answer, every engine failing, a partial answer, the backend down, erroring or stalled, the cache
// that never stores a failure or a partial answer, and the hourly cap (review finding S6, spec §13).
import { test } from "node:test";
import assert from "node:assert/strict";
import { makeSearcher, normalizeQuery } from "../src/search.mjs";
import { serve } from "./m5-helpers.mjs";

const POLICY = { search: { engines: { fixture: ["fcpi fixture"], live: ["duckduckgo", "bing", "brave"] }, engineHosts: { live: ["www.bing.com"] }, perHour: 60, cacheSeconds: 900, deadlineMs: 1500, maxResults: 20 } };
class MemStore {
  constructor(perHourUsed = 0) { this.cache = new Map(); this.sent = perHourUsed; this.puts = 0; }
  async searchCacheGet(k) { return this.cache.get(k) ?? null; }
  async searchCachePut(k, v) { this.puts++; this.cache.set(k, v); }
  async admitSearchQuery(perHour) { if (this.sent >= perHour) return { admitted: false }; this.sent++; return { admitted: true }; }
}
// The fake backend answers by the query: SearXNG's JSON shape, with unresponsive_engines as [name, reason] pairs.
// /config lists the engines the backend loaded when a test sets backend.loaded; otherwise it is absent (404), as on a
// backend that does not serve it, and nothing is concluded from it.
function backend(req, res) {
  const u = new URL(req.url, "http://x");
  const send = (status, body) => { const b = Buffer.from(typeof body === "string" ? body : JSON.stringify(body)); res.writeHead(status, { "content-type": "application/json" }).end(b); };
  if (u.pathname === "/config") { backend.configReads = (backend.configReads ?? 0) + 1; return backend.loaded ? send(200, { engines: backend.loaded.map((name) => ({ name, enabled: false })) }) : send(404, "Not Found"); }
  const q = u.searchParams.get("q"), engines = u.searchParams.get("engines").split(",");
  if (q === "down500") return send(500, "Internal Server Error");
  if (q === "notjson") return send(200, "<html>");
  if (q === "stall") return; // never answers
  const results = q === "nothing" || q === "allfail" || q === "emptypartial" ? [] : [{ url: "https://example.org/a", title: "A", content: "a", engine: engines[0] }, { url: "javascript:alert(1)", title: "bad" }];
  const unresponsive = q === "allfail" ? engines.map((e) => [e, "timeout"]) : q === "partial" || q === "emptypartial" ? [[engines[0], "CAPTCHA"]] : [];
  send(200, { query: q, number_of_results: results.length, results, unresponsive_engines: unresponsive });
}
async function rig(selection = "live", store = new MemStore()) {
  const srv = await serve(backend);
  const logs = [];
  const search = makeSearcher({ store, getPolicy: () => POLICY, getSelection: () => ({ search: selection }), searchUrl: `http://127.0.0.1:${srv.port}/search`, log: (o) => logs.push(o) });
  return { srv, store, logs, q: (query) => search(`/searxng/search?q=${encodeURIComponent(query)}&format=json&pageno=1`) };
}

test("results come back with their engines; a non-http(s) result is dropped; a complete answer is cached", async () => {
  const r = await rig();
  try {
    const a = await r.q("widgets");
    assert.equal(a.status, 200);
    assert.deepEqual(a.body.results.map((x) => x.url), ["https://example.org/a"]);
    assert.deepEqual(a.body.fcpi.engines, ["duckduckgo", "bing", "brave"]);
    assert.equal(a.body.fcpi.cache, "miss");
    const b = await r.q("  WIDGETS ");
    assert.equal(b.body.fcpi.cache, "hit", "the normalized query is served from the cache");
    assert.equal(r.store.sent, 1, "the cache hit reached no backend");
  } finally { await r.srv.close(); }
});

test("a true empty answer is a 200 with no results; every engine failing is SEARCH_ENGINES_FAILED, never an empty list", async () => {
  const r = await rig();
  try {
    const e = await r.q("nothing");
    assert.equal(e.status, 200);
    assert.deepEqual(e.body.results, []);
    assert.equal(e.body.fcpi.empty, true);
    assert.deepEqual(e.body.unresponsive_engines, []);
    await assert.rejects(r.q("allfail"), (x) => x.failureClass === "SEARCH_ENGINES_FAILED" && /duckduckgo \(timeout\)/.test(x.detail));
    assert.equal(r.store.puts, 1, "only the complete empty answer was cached");
  } finally { await r.srv.close(); }
});

test("a partial answer names the engines that failed and is not cached; an empty answer from the engines that answered is still a 200", async () => {
  const r = await rig();
  try {
    const p = await r.q("partial");
    assert.equal(p.body.fcpi.partial, true);
    assert.deepEqual(p.body.unresponsive_engines, [{ engine: "duckduckgo", reason: "CAPTCHA" }]);
    assert.deepEqual(p.body.fcpi.answered, ["bing", "brave"]);
    const ep = await r.q("emptypartial");
    assert.equal(ep.status, 200);
    assert.equal(ep.body.fcpi.empty, true);
    assert.equal(r.store.puts, 0);
  } finally { await r.srv.close(); }
});

test("backend failures are typed: unreachable, erroring, not JSON, stalled", async () => {
  const r = await rig();
  try {
    await assert.rejects(r.q("down500"), (x) => x.failureClass === "SEARCH_BACKEND_ERROR");
    await assert.rejects(r.q("notjson"), (x) => x.failureClass === "SEARCH_BACKEND_ERROR");
    await assert.rejects(r.q("stall"), (x) => x.failureClass === "SEARCH_TIMEOUT" && x.retryable === true);
  } finally { await r.srv.close(); }
  const dead = makeSearcher({ store: new MemStore(), getPolicy: () => POLICY, getSelection: () => ({ search: "live" }), searchUrl: "http://127.0.0.1:9/search", log: () => {} });
  await assert.rejects(dead("/searxng/search?q=x"), (x) => x.failureClass === "SEARCH_BACKEND_UNAVAILABLE");
});

test("the hourly cap refuses before the backend, and invalid queries are refused", async () => {
  const r = await rig("live", new MemStore(60));
  try {
    await assert.rejects(r.q("anything"), (x) => x.failureClass === "SEARCH_RATE_LIMITED" && x.retryAfter === 60);
    await assert.rejects(r.q(""), (x) => x.failureClass === "INVALID_REQUEST");
    await assert.rejects(r.q("x".repeat(501)), (x) => x.failureClass === "INVALID_REQUEST");
  } finally { await r.srv.close(); }
});

test("only the first page is served: a later one could look like a true empty answer (review S14)", async () => {
  const r = await rig();
  try {
    const search = makeSearcher({ store: r.store, getPolicy: () => POLICY, getSelection: () => ({ search: "live" }), searchUrl: "http://127.0.0.1:1/search", log: () => {} });
    await assert.rejects(search("/searxng/search?q=widgets&format=json&pageno=2"), (x) => x.failureClass === "INVALID_REQUEST" && /first page/.test(x.detail));
  } finally { await r.srv.close(); }
});

test("the engines are the selection's, never the caller's; the query is logged only as a hash", async () => {
  const r = await rig("fixture");
  try {
    const a = await r.q("secret project name");
    assert.deepEqual(a.body.fcpi.engines, ["fcpi fixture"]);
    assert.ok(r.logs.every((l) => !JSON.stringify(l).includes("secret project")));
    assert.equal(normalizeQuery(" A  b\tC "), "a b c");
  } finally { await r.srv.close(); }
});

test("a selected engine the backend has not loaded is reported as not answering, the answer is partial and not cached; /config is read once a while", async () => {
  backend.loaded = ["duckduckgo", "brave"]; // bing, selected, was never loaded
  backend.configReads = 0;
  const r = await rig();
  try {
    const a = await r.q("widgets");
    assert.deepEqual(a.body.unresponsive_engines, [{ engine: "bing", reason: "not loaded by the search backend" }]);
    assert.deepEqual(a.body.fcpi.answered, ["duckduckgo", "brave"]);
    assert.equal(a.body.fcpi.partial, true);
    assert.equal(r.store.puts, 0, "a partial answer is never cached");
    await r.q("gadgets");
    assert.equal(backend.configReads, 1, "the loaded set is read at most every ten minutes");
  } finally { backend.loaded = null; await r.srv.close(); }
});

test("concurrent searches share one /config read; a failed read is retried after thirty seconds, a good one kept ten minutes (review R13)", async () => {
  let t = 1_000_000;
  backend.loaded = null; // /config answers 404 first
  backend.configReads = 0;
  const srv = await serve(backend);
  try {
    const search = makeSearcher({ store: new MemStore(), getPolicy: () => POLICY, getSelection: () => ({ search: "live" }), searchUrl: `http://127.0.0.1:${srv.port}/search`, log: () => {}, clock: () => t });
    const q = (x) => search(`/searxng/search?q=${x}&format=json&pageno=1`);
    await Promise.all([q("a1"), q("a2"), q("a3")]);
    assert.equal(backend.configReads, 1, "one shared read");
    backend.loaded = ["duckduckgo", "brave"];
    t += 29e3; await q("b");
    assert.equal(backend.configReads, 1, "a failed read is kept thirty seconds");
    t += 2e3;
    const c = await q("c");
    assert.equal(backend.configReads, 2);
    assert.deepEqual(c.body.unresponsive_engines, [{ engine: "bing", reason: "not loaded by the search backend" }]);
    t += 9 * 60e3; await q("d");
    assert.equal(backend.configReads, 2, "a good read is kept ten minutes");
  } finally { backend.loaded = null; await srv.close(); }
});
