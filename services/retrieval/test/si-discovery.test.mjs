// SI1 (docs/FIRECRAWL_PI_SEARCH_INTELLIGENCE_SPEC.md §5, §8, §10, §11.1, §14, §15, §16, §24.1): the five-engine fan-out, its
// outcomes and the deterministic pieces, against fixture servers that speak each provider's documented wire format.
import { test } from "node:test";
import assert from "node:assert/strict";
import { harness, request, json, serve, answers } from "./si-helpers.mjs";
import { validateSearchRequest } from "../src/search-intelligence/contracts.mjs";
import { normalizeUrl, normalizeQueryText, hostMatches, buildPool, prepareCandidates } from "../src/search-intelligence/normalize.mjs";
import { fuse, shortlist, selectFinal } from "../src/search-intelligence/rank.mjs";
import { compileDeepseek } from "../src/search-intelligence/adapters/deepseek.mjs";
import { compileBrave } from "../src/search-intelligence/adapters/brave.mjs";
import { parseBraveRateHeaders, parseRetryAfter } from "../src/search-intelligence/availability.mjs";
import { providerRequest } from "../src/provider.mjs";
import { policyFor } from "./m5-helpers.mjs";

// ---- request contract ---------------------------------------------------------------------------------------------------------
test("the trusted request: both domain lists, reversed dates, conflicting docs options and far deadlines are refused", () => {
  const ok = validateSearchRequest(request({ constraints: { includeDomains: ["Vuejs.ORG.", "vuejs.org"] } }));
  assert.deepEqual(ok.constraints.includeDomains, ["vuejs.org"]);
  assert.equal(ok.intelligence.documentation, "off");
  for (const bad of [
    { constraints: { includeDomains: ["a.example"], excludeDomains: ["b.example"] } },
    { constraints: { publishedAfter: "2026-02-01T00:00:00Z", publishedBefore: "2026-01-01T00:00:00Z" } },
    { constraints: { publishedAfter: "2026-02-01" } },
    { constraints: { includeDomains: ["https://example.com/path"] } },
    { intelligence: { documentation: "off", libraries: [{ name: "vue" }] } },
    { intelligence: { documentation: "auto", libraries: [{ name: "a" }, { name: "b" }, { name: "c" }, { name: "d" }, { name: "e" }] } },
    { absoluteDeadlineMs: Date.now() - 1 }, { absoluteDeadlineMs: Date.now() + 120000 }, { limit: 11 }, { originalQuery: " " }, { surprise: 1 },
  ]) assert.throws(() => validateSearchRequest(request(bad)), (e) => e.failureClass === "INVALID_REQUEST", JSON.stringify(bad));
});

// ---- normalization -------------------------------------------------------------------------------------------------------------
test("queries keep case, quotes and negation; URLs lose only listed tracking parameters; hosts match at label boundaries", () => {
  assert.equal(normalizeQueryText("  R   vs  r \"two  spaces\"  -noise "), 'R vs r "two  spaces" -noise');
  const u = normalizeUrl("https://Example.COM:443/Path/To?utm_source=x&b=2&a=1&gclid=z#section-3");
  assert.deepEqual(u, { url: "https://example.com/Path/To?b=2&a=1", fragment: "section-3", host: "example.com" });
  assert.equal(normalizeUrl("http://example.com/a/").url, "http://example.com/a/");
  assert.notEqual(normalizeUrl("http://example.com/x").url, normalizeUrl("https://example.com/x").url);
  assert.equal(normalizeUrl("https://user:pw@example.com/"), null);
  assert.equal(normalizeUrl("javascript:alert(1)"), null);
  assert.equal(normalizeUrl("https://bücher.example/a").host, "xn--bcher-kva.example");
  assert.ok(hostMatches("docs.example.com", "example.com"));
  assert.ok(!hostMatches("example.com.evil.test", "example.com"));
  assert.ok(!hostMatches("notexample.com", "example.com"));
});

test("strict publication needs a timestamp identified as publication; freshness filters nothing", () => {
  const strict = { includeDomains: [], excludeDomains: [], publishedAfter: "2026-01-01T00:00:00.000Z", dateMode: "strict_publication" };
  const cands = [
    { url: "https://a.example/1", rank: 1, publication: { at: "2026-03-01T00:00:00Z", meaning: "published", basis: "provider_estimate" } },
    { url: "https://a.example/2", rank: 2, publication: { at: "2026-03-01T00:00:00Z", meaning: "published_or_updated", basis: "provider_estimate" } },
    { url: "https://a.example/3", rank: 3 },
    { url: "https://a.example/4", rank: 4, publication: { at: "2025-12-31T23:59:59Z", meaning: "published", basis: "source" } }];
  const s = prepareCandidates("exa", cands, strict);
  assert.deepEqual(s.kept.map((k) => k.url), ["https://a.example/1"]);
  assert.deepEqual(s.dropped.constraint, { publication_unverified: 2, publication_out_of_range: 1 });
  assert.equal(prepareCandidates("exa", cands, { ...strict, dateMode: "freshness" }).kept.length, 4);
});

// ---- fusion and selection -----------------------------------------------------------------------------------------------------
test("RRF: one vote per provider at its best rank, SearXNG at 0.75, three rank-one votes normalize to 1", () => {
  const lane = (provider, urls) => ({ provider, retrievedAt: "t", fromCache: false, kept: prepareCandidates(provider, urls.map((url, i) => ({ url, title: url, rank: i + 1 })), { includeDomains: [], excludeDomains: [] }).kept });
  const { pool } = buildPool([lane("serper", ["https://a.example/x", "https://a.example/x?utm_source=dup"]), lane("brave", ["https://a.example/x"]), lane("exa", ["https://a.example/x"]), lane("searxng", ["https://b.example/y"])],
    { poolMax: 128, workingSetBytes: 2 ** 21 });
  fuse(pool);
  const a = pool.find((d) => d.canonicalUrl === "https://a.example/x"), b = pool.find((d) => d.canonicalUrl === "https://b.example/y");
  assert.equal(a.observations.length, 3, "the tracking-parameter copy is the same document and serper votes once");
  assert.equal(a.observations.find((o) => o.provider === "serper").rank, 1);
  assert.ok(Math.abs(a.fusion.rrf - 3 / 61) < 1e-12 && a.fusion.normalized === 1);
  assert.ok(Math.abs(b.fusion.rrf - 0.75 / 61) < 1e-12 && Math.abs(b.fusion.normalized - 0.25) < 1e-12);
});

test("the pool is chosen fairly by provider rank, independent of arrival order", () => {
  const mk = (provider, n) => ({ provider, retrievedAt: "t", fromCache: false, kept: prepareCandidates(provider, Array.from({ length: n }, (_, i) => ({ url: `https://${provider}.example/${i}`, title: "", rank: i + 1 })), { includeDomains: [], excludeDomains: [] }).kept });
  const lanes = [mk("serper", 10), mk("brave", 20), mk("exa", 20), mk("deepseek", 20), mk("tavily", 20)];
  const a = buildPool(lanes, { poolMax: 12, workingSetBytes: 2 ** 21 }).pool.map((d) => d.canonicalUrl);
  const b = buildPool([...lanes].reverse(), { poolMax: 12, workingSetBytes: 2 ** 21 }).pool.map((d) => d.canonicalUrl);
  assert.deepEqual(a, b);
  for (const p of ["serper", "brave", "exa", "deepseek", "tavily"]) assert.ok(a.includes(`https://${p}.example/0`) && a.includes(`https://${p}.example/1`), p);
});

test("a uniquely found document is seeded into the shortlist although consensus documents outrank it", () => {
  const consensus = Array.from({ length: 60 }, (_, i) => ({ documentId: `c${String(i).padStart(3, "0")}`, observations: ["serper", "brave", "tavily"].map((provider) => ({ provider, rank: i + 1 })), literal: 0.5 }));
  const sentinel = { documentId: "zzz-sentinel", observations: [{ provider: "exa", rank: 1 }], literal: 0 };
  const docs = [...consensus, sentinel];
  fuse(docs);
  const s = shortlist(docs, { max: 48, seedPerProvider: 4, providers: ["serper", "brave", "exa", "deepseek", "tavily"] });
  assert.equal(s.length, 48);
  assert.ok(s.includes(sentinel));
  assert.ok(Math.min(...consensus.map((d) => d.fusion.rrf)) > sentinel.fusion.rrf * 0.5, "the sentinel is not shortlisted by its fused score");
});

test("diversity: a second result from one host pays 0.08, an explicit single-domain search pays nothing", () => {
  const d = (id, host, score) => ({ documentId: id, host, score });
  const docs = [d("a", "docs.example.com", 0.9), d("b", "www.example.com", 0.85), d("c", "other.org", 0.8)];
  assert.deepEqual(selectFinal(docs.map((x) => ({ ...x })), 2).map((x) => x.documentId), ["a", "c"]);
  assert.deepEqual(selectFinal(docs.map((x) => ({ ...x })), 2, { singleDomain: true }).map((x) => x.documentId), ["a", "b"]);
});

// ---- provider contracts -------------------------------------------------------------------------------------------------------
test("DeepSeek: 128 code points fit, 129 are unsupported (never truncated); operators that do not fit fall back to postfiltering", () => {
  const astral = "𝔸".repeat(128);
  assert.equal(astral.length, 256, "UTF-16 units are not code points");
  assert.ok(!compileDeepseek(validateSearchRequest(request({ originalQuery: astral }))).unsupported);
  assert.equal(compileDeepseek(validateSearchRequest(request({ originalQuery: `${astral}x` }))).unsupported, "query_too_long");
  const c = compileDeepseek(validateSearchRequest(request({ originalQuery: "q".repeat(120), constraints: { includeDomains: ["example.com"] } })));
  assert.deepEqual([c.query, c.constraintMode], ["q".repeat(120), "postfilter"]);
  const n = compileDeepseek(validateSearchRequest(request({ originalQuery: "vue async", constraints: { includeDomains: ["vuejs.org", "github.com"] } })));
  assert.equal(n.query, "vue async site:github.com OR site:vuejs.org");
  assert.equal(n.oriQuestion, "vue async");
});

test("Brave: 600 characters and 75 words both bound the query", () => {
  assert.equal(compileBrave(validateSearchRequest(request({ originalQuery: "w ".repeat(76).trim() }))).unsupported, "too_many_words");
  assert.ok(!compileBrave(validateSearchRequest(request({ originalQuery: "w ".repeat(75).trim() }))).unsupported);
  assert.equal(compileBrave(validateSearchRequest(request({ originalQuery: "x".repeat(500) }))).q.length, 500);
});

test("Brave rate windows: reset values are relative seconds; only exhausted windows count; a long window exhausted is quota", () => {
  const now = 1_000_000;
  const burst = parseBraveRateHeaders({ "x-ratelimit-limit": "1, 15000", "x-ratelimit-policy": "1;w=1, 15000;w=2592000", "x-ratelimit-remaining": "0, 14523", "x-ratelimit-reset": "1, 1234567" }, now);
  assert.deepEqual([burst.state, burst.retryAt], ["rate_limited", now + 1000]);
  const month = parseBraveRateHeaders({ "x-ratelimit-limit": "1, 15000", "x-ratelimit-policy": "1;w=1, 15000;w=2592000", "x-ratelimit-remaining": "1, 0", "x-ratelimit-reset": "1, 86400" }, now);
  assert.deepEqual([month.state, month.retryAt], ["quota_exhausted", now + 86400000]);
  const both = parseBraveRateHeaders({ "x-ratelimit-limit": "1, 15000", "x-ratelimit-policy": "1;w=1, 15000;w=2592000", "x-ratelimit-remaining": "0, 0", "x-ratelimit-reset": "1, 5000" }, now);
  assert.deepEqual([both.state, both.retryAt], ["quota_exhausted", now + 5000000]);
  assert.equal(parseBraveRateHeaders({ "x-ratelimit-limit": "1", "x-ratelimit-policy": "1;w=1, 15000;w=2592000", "x-ratelimit-remaining": "0, 1", "x-ratelimit-reset": "1, 1" }, now), null);
  assert.equal(parseRetryAfter("12", now), now + 12000);
  assert.equal(parseRetryAfter("soon", now), null);
});

test("each provider's wire request is the documented one", async () => {
  const h = await harness();
  try {
    const r = await h.coordinator.search(request({ originalQuery: "Rust tokio::select! cancellation", constraints: { includeDomains: ["docs.rs"] } }), { signal: new AbortController().signal });
    assert.equal(r.status, 200);
    const s = h.servers;
    assert.deepEqual(s.serper.seen[0].body, { q: "Rust tokio::select! cancellation", num: 10, hl: "en" });
    assert.equal(s.serper.seen[0].headers["x-api-key"], "synthetic-serper-key");
    const brave = new URL(s.brave.seen[0].url, "http://x");
    assert.equal(brave.pathname, "/res/v1/web/search");
    assert.deepEqual(Object.fromEntries(brave.searchParams), { q: "Rust tokio::select! cancellation site:docs.rs", count: "20", offset: "0", result_filter: "web", extra_snippets: "true", text_decorations: "false" });
    assert.deepEqual(s.exa.seen[0].body, { query: "Rust tokio::select! cancellation", type: "auto", numResults: 20, contents: { highlights: { maxCharacters: 1600 } }, includeDomains: ["docs.rs"] });
    assert.deepEqual(s.deepseek.seen[0].body, { query: "Rust tokio::select! cancellation site:docs.rs", count: 20, need_content: false, ori_question: "Rust tokio::select! cancellation" });
    assert.match(s.deepseek.seen[0].headers.authorization, /^Bearer /);
    assert.deepEqual(s.tavily.seen[0].body, { query: "Rust tokio::select! cancellation", search_depth: "advanced", max_results: 20, chunks_per_source: 3, include_answer: false, include_raw_content: false,
      include_usage: true, include_published_date: true, auto_parameters: false, include_domains: ["docs.rs"], include_domains_mode: "restrict" });
    // Every general provider's answer fell outside docs.rs, so each is a validated, filtered empty and the search is complete and empty.
    assert.equal(r.body.search.outcome, "complete");
    assert.equal(r.body.search.empty, true);
    assert.equal(r.body.search.filteredEmpty, true);
    assert.equal(r.body.web.length, 0);
  } finally { await h.close(); }
});

test("provider snippets become the result's passages and count toward literal relevance; a snippet equal to the description is not repeated", async () => {
  const h = await harness({ handlers: {
    brave: (q) => ({ status: 200, body: { query: { original: q }, web: { type: "search", results: [{ title: "Brave page", url: "https://snippets.example.org/brave", description: "general text", extra_snippets: ["the zebra quokka detail lives here"] }] } } }),
    exa: () => ({ status: 200, body: { requestId: "r", results: [{ id: "e0", title: "Exa page", url: "https://snippets.example.org/exa", highlights: ["only highlight"] }], costDollars: { total: 0.01 } } }),
  } });
  try {
    const r = await h.coordinator.search(request({ originalQuery: "zebra quokka", limit: 10 }), { signal: new AbortController().signal });
    const row = (u) => r.body.web.find((w) => w.url === u).fcpi.search;
    const brave = row("https://snippets.example.org/brave");
    assert.deepEqual(brave.passages.map((p) => [p.kind, p.provider, p.text]), [["provider_snippet", "brave", "the zebra quokka detail lives here"]]);
    assert.ok(brave.scores.literal > 0, "the query's terms are found in the snippet");
    assert.deepEqual(row("https://snippets.example.org/exa").passages, [], "Exa's highlight is already its description");
  } finally { await h.close(); }
});

// ---- the fan-out ----------------------------------------------------------------------------------------------------------------
test("all five general engines are dispatched before any completes, and arrival order changes nothing", async () => {
  // Each server holds its answer until all five requests have arrived: a coordinator that awaited one before launching the next
  // would deadlock here.
  let arrived = 0, release;
  const gate = new Promise((r) => { release = r; });
  const held = (name, delay) => async (q, entry) => { if (++arrived === 5) release(); await gate; await new Promise((r) => setTimeout(r, delay)); return answers[name](q, entry); };
  const runWith = async (delays) => {
    arrived = 0;
    const h = await harness({ handlers: Object.fromEntries(Object.entries(delays).map(([n, d]) => [n, held(n, d)])) });
    try { return await h.coordinator.search(request({ originalQuery: "aggregate fan out" }), { signal: new AbortController().signal }); } finally { await h.close(); }
  };
  const a = await runWith({ serper: 5, brave: 60, exa: 30, deepseek: 90, tavily: 10 });
  const b = await runWith({ serper: 90, brave: 5, exa: 60, deepseek: 10, tavily: 30 });
  assert.equal(a.body.search.coverage.general.successful, 5);
  assert.equal(a.body.search.outcome, "complete");
  assert.deepEqual(a.body.web.map((w) => w.url), b.body.web.map((w) => w.url));
  assert.deepEqual(a.body.web.map((w) => w.fcpi.search.documentId), b.body.web.map((w) => w.fcpi.search.documentId));
});

test("a lane waiting out a short rate limit holds back no other lane", async () => {
  const h = await harness();
  // Exa is rate limited for 1.2 s: within the two seconds a lane waits rather than skips.
  h.store.avail.set("fixture-exa", { provider: "fixture-exa", profile: "default", state: "rate_limited", reason: "rate_limited", provider_code: null,
    retry_at: new Date(Date.now() + 1200), retry_basis: "documented", credential_epoch: null, contract_failures: 0 });
  try {
    const t0 = Date.now();
    const r = await h.coordinator.search(request({ originalQuery: "one lane waits" }), { signal: new AbortController().signal });
    assert.equal(r.body.search.coverage.general.successful, 5, "Exa ran once its limit lifted");
    for (const n of ["serper", "brave", "deepseek", "tavily"]) assert.ok(h.servers[n].seen[0].at - t0 < 500, `${n} was dispatched without waiting for Exa`);
    assert.ok(h.servers.exa.seen[0].at - t0 >= 1100, "Exa waited out its limit");
  } finally { await h.close(); }
});

test("a failed engine leaves a partial answer naming it; a valid empty engine is still coverage", async () => {
  const h = await harness({ handlers: { exa: () => ({ status: 500, body: { requestId: "r", error: "boom", tag: "INTERNAL" } }), tavily: (q) => ({ status: 200, body: { query: q, results: [], usage: { credits: 2 } } }) } });
  try {
    const r = await h.coordinator.search(request(), { signal: new AbortController().signal });
    const s = r.body.search;
    assert.equal(s.outcome, "partial");
    assert.deepEqual(s.coverage.general.missing, [{ provider: "exa", status: "failed", reason: "temporarily_unavailable" }]);
    assert.equal(s.providers.tavily.status, "success_empty");
    assert.equal(s.coverage.general.successful, 4);
    assert.match(r.body.warning, /Exa unavailable/);
    // A 500's charge is undocumented: Exa's reservation stays whole (uncertain); Tavily's empty answer settles its reported credits.
    const rows = [...h.store.rows.values()];
    assert.equal(rows.find((x) => x.provider === "fixture-exa").state, "UNCERTAIN");
    assert.deepEqual([rows.find((x) => x.provider === "fixture-tavily").state, rows.find((x) => x.provider === "fixture-tavily").actual], ["SETTLED", 2]);
    assert.equal(h.store.searchCache.size, 4, "four provider entries; no complete aggregate entry for a partial search");
  } finally { await h.close(); }
});

test("no validated provider at all is SEARCH_ENGINES_FAILED, never an empty success; SearXNG runs once as fallback", async () => {
  const down = () => ({ status: 503, body: {} });
  let sxCalls = 0;
  const h = await harness({ handlers: { serper: down, brave: down, exa: down, deepseek: down, tavily: down },
    searxng: (req, res) => { sxCalls++; json(res, 200, { results: [], unresponsive_engines: [["fcpi fixture", "timeout"], ["fcpi fixture b", "timeout"], ["fcpi fixture r", "timeout"]] }); } });
  try {
    await assert.rejects(h.coordinator.search(request(), { signal: new AbortController().signal }), (e) => e.failureClass === "SEARCH_ENGINES_FAILED");
    assert.equal(sxCalls >= 1, true);
    assert.equal(h.store.admissions, 1);
    assert.equal(h.servers.serper.seen.length, 1, "Serper is asked once");
  } finally { await h.close(); }
});

test("SearXNG fallback answers when every general engine fails: one admission, one Serper call, one orchestration, partial", async () => {
  const down = () => ({ status: 503, body: {} });
  let sxRequests = 0;
  const h = await harness({ handlers: { serper: down, brave: down, exa: down, deepseek: down, tavily: down },
    searxng: (req, res) => { if (req.url.startsWith("/search")) sxRequests++; json(res, 200, { results: [{ url: "https://searx.example/a", title: "A", content: "a", engines: ["fcpi fixture"] }], unresponsive_engines: [] }); } });
  try {
    const r = await h.coordinator.search(request(), { signal: new AbortController().signal });
    assert.equal(r.body.search.outcome, "partial");
    assert.equal(r.body.search.coverage.searxng.used, true);
    assert.deepEqual(r.body.web.map((w) => w.url), ["https://searx.example/a"]);
    assert.equal(h.store.admissions, 1);
    assert.equal(h.servers.serper.seen.length, 1);
    assert.ok(sxRequests >= 1 && sxRequests <= 2, "one orchestration: page one and at most its second page");
  } finally { await h.close(); }
});

test("quota exhaustion suppresses only that provider, does not trip its breaker, and survives into the next search", async () => {
  const h = await harness({ handlers: { tavily: () => ({ status: 432, body: { detail: { error: "Plan limit" } } }) } });
  try {
    for (let i = 0; i < 4; i++) {
      const r = await h.coordinator.search(request({ originalQuery: `quota probe ${i}` }), { signal: new AbortController().signal });
      assert.equal(r.body.search.coverage.general.successful, 4);
      assert.equal(r.body.search.providers.tavily.reason, "quota_exhausted");
      assert.equal(r.body.search.providers.tavily.status, i === 0 ? "failed" : "skipped");
    }
    assert.equal(h.servers.tavily.seen.length, 1, "after the 432 no further Tavily call is sent");
    assert.equal(h.dispatch.breakerState("fixture-tavily"), "closed");
    assert.equal(h.store.avail.get("fixture-tavily").state, "quota_exhausted");
    // Whether a failed Tavily search is charged is not documented: the answered 432 keeps its reservation.
    assert.equal([...h.store.rows.values()].find((x) => x.provider === "fixture-tavily").state, "UNCERTAIN");
  } finally { await h.close(); }
});

test("an answered refusal keeps its reservation unless the provider documents it as unbilled", async () => {
  const state = (h, p) => [...h.store.rows.values()].find((x) => x.provider === p)?.state;
  const refused = await harness({ handlers: { exa: () => ({ status: 401, body: { requestId: "r", error: "bad key", tag: "INVALID_API_KEY" } }),
    brave: () => ({ status: 429, body: { type: "ErrorResponse", error: { code: "RATE_LIMITED", status: 429 } } }) } });
  try {
    await refused.coordinator.search(request({ originalQuery: "billing of refusals" }), { signal: new AbortController().signal });
    assert.equal(state(refused, "fixture-exa"), "UNCERTAIN", "Exa documents only its 503 as unbilled");
    assert.equal(state(refused, "fixture-brave"), "RELEASED", "Brave bills successful requests only");
  } finally { await refused.close(); }
  const overloaded = await harness({ handlers: { exa: () => ({ status: 503, body: { requestId: "r", error: "overloaded", tag: "SERVICE_OVERLOADED" } }) } });
  try {
    await overloaded.coordinator.search(request({ originalQuery: "billing of overload" }), { signal: new AbortController().signal });
    assert.equal(state(overloaded, "fixture-exa"), "RELEASED", "Exa's 503 is documented as not processed and not billed");
  } finally { await overloaded.close(); }
});

const ledgerRow = (h, provider) => [...h.store.rows.values()].find((x) => x.provider === provider);

test("each answer closes its reservation as the provider documents its billing", async () => {
  const h = await harness({ handlers: {
    deepseek: () => ({ status: 200, body: { results: [] } }),
    exa: () => ({ status: 200, body: { requestId: "r", results: [{ id: "e0", title: "Exa", url: "https://exa.example.org/doc/1", highlights: ["h"] }] } }),
    tavily: () => ({ status: 500, body: { detail: { error: "internal" } } }),
    brave: () => ({ status: 429, body: { type: "ErrorResponse", error: { id: "x", status: 429, code: "QUOTA_LIMITED" } } }),
  } });
  try {
    const r = await h.coordinator.search(request({ originalQuery: "ledger closings" }), { signal: new AbortController().signal });
    const p = r.body.search.providers;
    // DeepSeek documents an empty search as free.
    assert.equal(p.deepseek.status, "success_empty");
    assert.deepEqual([ledgerRow(h, "fixture-deepseek").state, ledgerRow(h, "fixture-deepseek").actual], ["SETTLED", 0]);
    // Exa without a reported cost settles at the reservation's documented maximum, labelled an estimate.
    const exa = ledgerRow(h, "fixture-exa");
    assert.deepEqual([exa.state, exa.actual], ["SETTLED", exa.reserved]);
    assert.equal(r.body.search.usage.find((u) => u.provider === "exa").basis, "estimated");
    // A Tavily server error may have been charged.
    assert.equal(ledgerRow(h, "fixture-tavily").state, "UNCERTAIN");
    // Brave is classified by its error code before its status (a 429 carrying QUOTA_LIMITED is quota), and released.
    assert.deepEqual([p.brave.reason, ledgerRow(h, "fixture-brave").state], ["quota_exhausted", "RELEASED"]);
  } finally { await h.close(); }
});

test("a DeepSeek 200 that is not the documented shape keeps its reservation uncertain and is a contract failure", async () => {
  const h = await harness({ handlers: { deepseek: () => ({ status: 200, body: { unexpected: true } }) } });
  try {
    const r = await h.coordinator.search(request({ originalQuery: "malformed answer" }), { signal: new AbortController().signal });
    assert.deepEqual([r.body.search.providers.deepseek.status, r.body.search.providers.deepseek.reason], ["failed", "contract_failure"]);
    assert.equal(ledgerRow(h, "fixture-deepseek").state, "UNCERTAIN");
  } finally { await h.close(); }
});

test("stopping the service mid-search closes an in-flight reservation as uncertain, never leaves it reserved", async () => {
  let release, arrived;
  const gate = new Promise((r) => { release = r; }), sent = new Promise((r) => { arrived = r; });
  const h = await harness({ handlers: { exa: async (q, e) => { arrived(); await gate; return answers.exa(q, e); } } });
  try {
    const search = h.coordinator.search(request({ originalQuery: "drained" }), { signal: new AbortController().signal }).catch((e) => e);
    await sent;
    assert.equal(ledgerRow(h, "fixture-exa").state, "RESERVED", "the control: the request is in flight");
    assert.equal(await h.coordinator.drain(2000), 0, "every tracked task finished within the drain");
    assert.equal(ledgerRow(h, "fixture-exa").state, "UNCERTAIN", "sent and cut off by the stop: the charge is unknown");
    assert.equal((await search).failureClass, "CANCELLED");
  } finally { release(); await h.close(); }
});

test("identical searches in different deadline classes run as separate executions", async () => {
  let release;
  const gate = new Promise((r) => { release = r; });
  const slow = (name) => async (q, e) => { await gate; return answers[name](q, e); };
  const h = await harness({ handlers: Object.fromEntries(["serper", "brave", "exa", "deepseek", "tavily"].map((n) => [n, slow(n)])) });
  try {
    const normal = h.coordinator.search(request({ originalQuery: "two classes", absoluteDeadlineMs: Date.now() + 30000 }), { signal: new AbortController().signal });
    const short = h.coordinator.search(request({ originalQuery: "two classes", absoluteDeadlineMs: Date.now() + 15000 }), { signal: new AbortController().signal });
    await new Promise((r) => setTimeout(r, 50));
    release();
    const [a, b] = await Promise.all([normal, short]);
    for (const r of [a, b]) {
      assert.equal(r.body.search.coverage.general.successful, 5);
      assert.equal(r.body.search.coalesced, undefined);
    }
    assert.equal(h.store.admissions, 2);
    assert.equal(h.servers.serper.seen.length, 2, "each execution makes its own Serper operation under its own logical id");
  } finally { await h.close(); }
});

test("Serper's availability is the fixture provider's own: a 429 cools fixture-serper down and never touches the live row", async () => {
  const h = await harness({ handlers: { serper: () => ({ status: 429, body: { message: "Too many requests" } }) } });
  try {
    for (let i = 0; i < 2; i++) {
      const r = await h.coordinator.search(request({ originalQuery: `serper cool ${i}` }), { signal: new AbortController().signal });
      assert.deepEqual([r.body.search.providers.serper.status, r.body.search.providers.serper.reason], [i === 0 ? "failed" : "skipped", "rate_limited"]);
    }
    assert.equal(h.servers.serper.seen.length, 1, "the cooled-down fixture Serper is not called again");
    assert.equal(h.store.avail.get("fixture-serper").state, "rate_limited");
    assert.equal(h.store.avail.has("serper"), false, "the live provider's row is never written by fixture traffic");
  } finally { await h.close(); }
});

test("the lifetime allocation is live Serper's alone: the fixture reserves without it and its rows are not kept forever", async () => {
  const { allocationCategories } = await import("../src/serper.mjs");
  const h = await harness();
  const reserves = [];
  const reserve = h.store.reserveBudget.bind(h.store);
  h.store.reserveBudget = async (r) => { reserves.push(r); return reserve(r); };
  try {
    await h.coordinator.search(request({ originalQuery: "allocation scope" }), { signal: new AbortController().signal });
    const serper = reserves.find((r) => r.provider === "fixture-serper");
    assert.equal(serper.lifetimeCap, undefined, "a fixture spends no real credits");
    const kept = allocationCategories(h.budget);
    const live = h.budget.searches[h.budget.searching.defaultSearch].category;
    assert.ok(kept.includes(live), `the live category ${live} is kept`);
    assert.equal(kept.includes(serper.category), false, "the fixture category is pruned as usual");
  } finally { await h.close(); }
});

test("a retry whose Serper operation is already recorded says so, sends nothing, and is never called quota exhaustion", async () => {
  const h = await harness({ handlers: { serper: () => ({ status: 500, body: {} }) } });
  try {
    const req = request({ originalQuery: "retried search" });
    const first = await h.coordinator.search(req, { signal: new AbortController().signal });
    assert.equal(first.body.search.providers.serper.reason, "temporarily_unavailable");
    assert.equal([...h.store.rows.values()].find((x) => x.provider === "fixture-serper").state, "UNCERTAIN");
    const again = await h.coordinator.search({ ...req, requestId: `${req.requestId}-retry` }, { signal: new AbortController().signal });
    const s = again.body.search.providers.serper;
    assert.deepEqual([s.status, s.reason, s.detail, s.dispatchState], ["failed", "internal_failure", "operation_already_recorded", "possibly_sent"]);
    assert.equal(h.servers.serper.seen.length, 1, "the recorded operation is not sent again");
    assert.doesNotMatch(again.body.warning ?? "", /quota/i);
  } finally { await h.close(); }
});

test("a rate limit with Retry-After cools the provider down until that time; transport failures do trip the breaker", async () => {
  const h = await harness({ handlers: { exa: () => ({ status: 429, body: { requestId: "r", error: "slow down", tag: "RATE_LIMIT_EXCEEDED" }, headers: { "retry-after": "120" } }), deepseek: () => "destroy" } });
  try {
    for (let i = 0; i < 3; i++) await h.coordinator.search(request({ originalQuery: `rate probe ${i}` }), { signal: new AbortController().signal });
    assert.equal(h.servers.exa.seen.length, 1);
    const row = h.store.avail.get("fixture-exa");
    assert.equal(row.state, "rate_limited");
    assert.equal(row.retry_basis, "documented");
    assert.equal(h.dispatch.breakerState("fixture-exa"), "closed");
    assert.equal(h.dispatch.breakerState("fixture-deepseek"), "open", "three cut connections in a minute open DeepSeek's breaker");
    assert.equal(h.servers.deepseek.seen.length, 3, "each cut connection counts once: the breaker opens on the third, not the second");
  } finally { await h.close(); }
});

test("one failed call is one breaker verdict: two transport failures leave the breaker closed", async () => {
  const h = await harness({ handlers: { deepseek: () => "destroy" } });
  try {
    for (let i = 0; i < 2; i++) await h.coordinator.search(request({ originalQuery: `two failures ${i}` }), { signal: new AbortController().signal });
    assert.equal(h.servers.deepseek.seen.length, 2);
    assert.equal(h.dispatch.breakerState("fixture-deepseek"), "closed");
  } finally { await h.close(); }
});

test("a half-open breaker admits one probe while siblings are refused, and the probe's failure reopens it", async () => {
  let probeGate = null;
  const h = await harness({ mutateBudget: (b) => { b.breaker = { ...b.breaker, failures: 1, openMs: 1000 }; },
    handlers: { exa: async () => { if (probeGate) await probeGate; return "destroy"; } } });
  try {
    await h.coordinator.search(request({ originalQuery: "open it" }), { signal: new AbortController().signal });
    assert.equal(h.dispatch.breakerState("fixture-exa"), "open");
    await new Promise((r) => setTimeout(r, 1050));
    assert.equal(h.dispatch.breakerState("fixture-exa"), "half_open");
    let release;
    probeGate = new Promise((r) => { release = r; });
    const probe = h.coordinator.search(request({ originalQuery: "probe" }), { signal: new AbortController().signal });
    await new Promise((r) => setTimeout(r, 30));
    // Siblings arrive one after another while the probe is in flight: each is refused at the breaker, and a refused sibling's
    // report never returns the probe's slot (were it returned, the second sibling would be admitted as a second probe).
    const siblings = [];
    for (const i of [1, 2]) siblings.push(await h.coordinator.search(request({ originalQuery: `sibling ${i}` }), { signal: new AbortController().signal }));
    for (const s of siblings) assert.equal(s.body.search.providers.exa.reason, "breaker_open");
    assert.equal(h.servers.exa.seen.length, 2, "the opening failure and one probe: no second probe went out");
    release();
    await probe;
    assert.equal(h.dispatch.breakerState("fixture-exa"), "open", "the failed probe reopens the breaker");
  } finally { await h.close(); }
});

test("a local refusal before send judges no provider: the metered breakers stay closed", async () => {
  const h = await harness({ mutatePolicy: (p) => { delete p.localCidrs; } });
  try {
    for (let i = 0; i < 3; i++) await h.coordinator.search(request({ originalQuery: `not ready ${i}` }), { signal: new AbortController().signal }).catch(() => null);
    // The control: each metered lane reached its reservation and was refused at the transport, before send.
    const metered = [...h.store.rows.values()].filter((r) => r.provider !== "fixture-serper");
    assert.equal(metered.length, 12, "four metered lanes in each of three searches reserved");
    for (const r of metered) assert.deepEqual([r.state, r.detail], ["RELEASED", "not sent: NOT_READY"]);
    for (const n of ["brave", "exa", "deepseek", "tavily"]) {
      assert.equal(h.servers[n].seen.length, 0, `${n} was never sent`);
      assert.equal(h.dispatch.breakerState(`fixture-${n}`), "closed", n);
    }
    // Serper keeps its own breaker: the same local refusal is neutral there too.
    const serperRows = [...h.store.rows.values()].filter((r) => r.provider === "fixture-serper");
    assert.equal(serperRows.length, 3);
    for (const r of serperRows) assert.equal(r.state, "RELEASED");
    assert.equal(h.servers.serper.seen.length, 0);
    assert.equal(h.serper.breakerState("fixture-serper"), "closed");
  } finally { await h.close(); }
});

test("the paid-dispatch switch and a missing credential are explicit exclusions, and the search says so", async () => {
  const h = await harness({ mutateBudget: (b) => { b.providers["fixture-serper"].credential = "absent_serper_key"; } });
  try {
    const r = await h.coordinator.search(request(), { signal: new AbortController().signal });
    assert.deepEqual([r.body.search.providers.serper.status, r.body.search.providers.serper.reason], ["skipped", "not_configured"]);
    assert.equal(h.servers.serper.seen.length, 0);
    assert.equal(r.body.search.outcome, "partial");
  } finally { await h.close(); }
});

test("a roster subject with no adapter is skipped under its lane id, never its budget provider's name", async () => {
  const h = await harness();
  try {
    const { makeCoordinator } = await import("../src/search-intelligence/coordinator.mjs");
    const { brave, ...general } = h.general;
    const c = makeCoordinator({ store: h.store, getBudget: h.getBudget, getPolicy: h.getPolicy, getSelection: h.getSelection, dispatch: h.dispatch, general, availability: h.availability });
    const r = await c.search(request({ originalQuery: "missing adapter" }), { signal: new AbortController().signal });
    const s = r.body.search;
    assert.deepEqual([s.providers.brave?.status, s.providers.brave?.reason, s.providers.brave?.detail], ["skipped", "not_configured", "adapter_missing"]);
    assert.equal(s.providers["fixture-brave"], undefined);
    assert.match(r.body.warning, /Brave/);
  } finally { await h.close(); }
});

test("a reservation an adapter leaves open when it throws is marked uncertain as the lane ends, never left reserved", async () => {
  const h = await harness();
  try {
    const { makeCoordinator } = await import("../src/search-intelligence/coordinator.mjs");
    const real = h.general.brave;
    // Brave's call is answered, then the adapter throws before closing its reservation.
    const throwing = { ...real, async search(request, ctx) {
      const res = await h.dispatch.call({ sub: ctx.sub, pre: ctx.pre, kind: "search", callKey: `search:${request.logicalSearchId}:brave:search:v1`, logicalId: request.logicalSearchId, searchId: request.logicalSearchId,
        requestHash: "x", amount: 1, signal: ctx.signal, deadlineAt: ctx.deadlineAt, timeoutMs: 2000, maxBytes: 1 << 20, http: { method: "GET", path: "/res/v1/web/search?q=x", headers: {} } });
      assert.equal(res.ok, true);
      throw new Error("parser bug");
    } };
    const c = makeCoordinator({ store: h.store, getBudget: h.getBudget, getPolicy: h.getPolicy, getSelection: h.getSelection, dispatch: h.dispatch, general: { ...h.general, brave: throwing }, availability: h.availability, log: (o) => h.logs.push(o) });
    const r = await c.search(request({ originalQuery: "adapter throws" }), { signal: new AbortController().signal });
    assert.deepEqual([r.body.search.providers.brave.reason, r.body.search.providers.brave.detail], ["internal_failure", "adapter_threw"]);
    assert.equal([...h.store.rows.values()].find((x) => x.provider === "fixture-brave").state, "UNCERTAIN");
    assert.equal(h.logs.filter((l) => l.event === "si_unclosed_reservation").length, 1);
  } finally { await h.close(); }
});

test("a complete answer is cached whole and served again without admission or dispatch, labelled reuse", async () => {
  const h = await harness();
  try {
    const firstReq = request({ originalQuery: "cache me" });
    const first = await h.coordinator.search(firstReq, { signal: new AbortController().signal });
    // No decision layer is configured: the deterministic ranking is the full ranking, and the complete answer is stored whole.
    assert.deepEqual([first.body.search.ranking.mode, first.body.search.ranking.reason], ["rrf_fallback", "jev_not_configured"]);
    const secondReq = request({ originalQuery: "cache me" });
    const second = await h.coordinator.search(secondReq, { signal: new AbortController().signal });
    const s = second.body.search;
    assert.equal(s.cache.mode, "hit");
    assert.ok(s.cache.storedAt && s.cache.expiresAt && s.cache.servedAt);
    assert.equal(h.store.admissions, 1, "a complete aggregate hit precedes admission");
    assert.equal(Object.values(h.servers).reduce((n, srv) => n + srv.seen.length, 0), 5, "no provider was called again");
    assert.deepEqual(s.usage, [], "a reused answer spends nothing");
    assert.equal(s.reuseOf, firstReq.logicalSearchId);
    assert.equal(s.logicalSearchId, secondReq.logicalSearchId);
    assert.ok(Object.values(s.providers).every((p) => p.fromCache));
    assert.deepEqual(second.body.web.map((w) => w.url), first.body.web.map((w) => w.url));
    // The legacy facade maps the same reuse to its own cache label.
    const legacyFirst = await h.coordinator.legacyGet("/searxng/search?q=legacy+cache&format=json", new AbortController().signal);
    const legacyAgain = await h.coordinator.legacyGet("/searxng/search?q=legacy+cache&format=json", new AbortController().signal);
    assert.deepEqual([legacyFirst.body.fcpi.cache, legacyAgain.body.fcpi.cache], ["miss", "hit"]);
  } finally { await h.close(); }
});

test("an answer whose configured decision layer fell back is degraded and never stored whole", async () => {
  const decisions = { identity: () => "jev-stub", rerank: async () => ({ ranking: { mode: "rrf_fallback", reason: "jev_timeout" } }) };
  const h = await harness({ decisions });
  try {
    for (let i = 0; i < 2; i++) {
      const r = await h.coordinator.search(request({ originalQuery: "degraded ranking" }), { signal: new AbortController().signal });
      assert.equal(r.body.search.ranking.mode, "rrf_fallback");
      assert.notEqual(r.body.search.cache.mode, "hit");
      // The second execution reuses every lane from the provider cache: a new execution, no new provider call.
      if (i === 1) assert.equal(r.body.search.cache.mode, "partial_reuse");
    }
    assert.equal(h.store.admissions, 2, "each degraded answer is a new execution");
    assert.equal(Object.values(h.servers).reduce((n, srv) => n + srv.seen.length, 0), 5);
  } finally { await h.close(); }
});

test("concurrent identical searches share one execution; one caller's cancellation leaves the other's answer intact", async () => {
  let release;
  const gate = new Promise((r) => { release = r; });
  const slow = (name) => async (q, e) => { await gate; return answers[name](q, e); };
  const h = await harness({ handlers: Object.fromEntries(["serper", "brave", "exa", "deepseek", "tavily"].map((n) => [n, slow(n)])) });
  try {
    const leaving = new AbortController();
    const a = h.coordinator.search(request({ originalQuery: "shared" }), { signal: leaving.signal });
    const b = h.coordinator.search(request({ originalQuery: "shared" }), { signal: new AbortController().signal });
    await new Promise((r) => setTimeout(r, 50));
    leaving.abort();
    await assert.rejects(a, (e) => e.failureClass === "CANCELLED");
    release();
    const r = await b;
    assert.equal(r.body.search.coverage.general.successful, 5);
    assert.equal(r.body.search.coalesced, true);
    assert.equal(h.store.admissions, 1);
    assert.equal(Object.values(h.servers).reduce((n, s) => n + s.seen.length, 0), 5);
  } finally { await h.close(); }
});

test("a shared execution's spend is reported once: the joining caller carries none and names the search that does", async () => {
  let release;
  const gate = new Promise((r) => { release = r; });
  const slow = (name) => async (q, e) => { await gate; return answers[name](q, e); };
  const h = await harness({ handlers: Object.fromEntries(["serper", "brave", "exa", "deepseek", "tavily"].map((n) => [n, slow(n)])) });
  try {
    const firstReq = request({ originalQuery: "shared spend" }), joinReq = request({ originalQuery: "shared spend" });
    const first = h.coordinator.search(firstReq, { signal: new AbortController().signal });
    const joined = h.coordinator.search(joinReq, { signal: new AbortController().signal });
    await new Promise((r) => setTimeout(r, 50));
    release();
    const [a, b] = await Promise.all([first, joined]);
    assert.ok(a.body.search.usage.length >= 4, "the execution's own search reports what it spent");
    assert.equal(a.body.search.usageOf, undefined);
    assert.deepEqual([b.body.search.coalesced, b.body.search.usage, b.body.search.usageOf], [true, [], firstReq.logicalSearchId]);
  } finally { await h.close(); }
});

test("an abandoned search is never joined: an identical search arriving as it winds down runs anew, and nothing new starts for it", async () => {
  let release;
  const gate = new Promise((r) => { release = r; });
  const slow = (name) => async (q, e) => { await gate; return answers[name](q, e); };
  // A slow SearXNG: were the abandoned search to launch its fallback, it would linger long enough to be joined.
  let sxRequests = 0;
  const h = await harness({ handlers: Object.fromEntries(["serper", "brave", "exa", "deepseek", "tavily"].map((n) => [n, slow(n)])),
    searxng: (req, res) => { if (req.url.startsWith("/search")) sxRequests++; setTimeout(() => json(res, 200, { results: [], unresponsive_engines: [] }), 500); } });
  try {
    const leaving = new AbortController();
    const a = h.coordinator.search(request({ originalQuery: "abandoned" }), { signal: leaving.signal });
    await new Promise((r) => setTimeout(r, 50));
    leaving.abort();
    await assert.rejects(a, (e) => e.failureClass === "CANCELLED");
    await new Promise((r) => setTimeout(r, 50));
    const b = h.coordinator.search(request({ originalQuery: "abandoned" }), { signal: new AbortController().signal });
    await new Promise((r) => setTimeout(r, 50));
    release();
    const r = await b;
    assert.equal(r.body.search.coverage.general.successful, 5);
    assert.equal(r.body.search.coalesced, undefined, "the second caller ran its own execution");
    assert.equal(h.store.admissions, 2);
    assert.equal(sxRequests, 0, "the abandoned search launched no SearXNG fallback");
  } finally { await h.close(); }
});

test("a ledger outage stops dispatch: no reservation, no request", async () => {
  const h = await harness();
  h.store.failReserve = true;
  try {
    await assert.rejects(h.coordinator.search(request(), { signal: new AbortController().signal }), (e) => e.failureClass === "SEARCH_ENGINES_FAILED");
    assert.equal(Object.values(h.servers).reduce((n, s) => n + s.seen.length, 0), 0, "no provider, Serper included, was called without a reservation");
    assert.equal(h.store.rows.size, 0);
  } finally { await h.close(); }
});

test("a monetary cap that appears after preflight refuses a call with no stated valuation: no reservation, no request", async () => {
  const h = await harness();
  try {
    // Live Brave is a paid provider whose money per request is unknown; the fixture subject plays it (a fixture provider is
    // never paid in a validated budget, so the flag is set on this subject's copy only).
    const fixture = h.dispatch.subject("searches", "fcpi-fixture-brave");
    const sub = { ...fixture, prov: { ...fixture.prov, paid: true } };
    const pre = h.dispatch.preflight(sub, { selection: "fixture" });
    assert.equal(pre.eligible, true, "the control: no monetary cap at preflight");
    assert.equal(sub.card.microUsdPerRequest ?? null, null, "Brave's money per request is unknown");
    h.budget.paidTotal.caps.day = 1_000_000; // a reload adds a daily monetary cap
    const res = await h.dispatch.call({ sub, pre, kind: "search", callKey: "search:cap-reload:brave:search:v1", logicalId: "cap-reload", searchId: "cap-reload", requestHash: "x", amount: 1,
      signal: new AbortController().signal, deadlineAt: Date.now() + 2000, timeoutMs: 2000, maxBytes: 1 << 20, http: { method: "GET", path: "/res/v1/web/search?q=x", headers: {} } });
    assert.deepEqual([res.ok, res.reason, res.detail, res.dispatchState], [false, "platform_restricted", "valuation_unavailable", "not_sent"]);
    assert.equal(h.store.rows.size, 0);
    assert.equal(h.servers.brave.seen.length, 0);
  } finally { await h.close(); }
});

test("a settlement the ledger refuses is counted as an accounting failure and the reservation stays durable, never zero", async () => {
  const h = await harness();
  const settle = h.store.settleBudget.bind(h.store);
  h.store.settleBudget = async (id, actual, f) => { const r = [...h.store.rows.values()].find((x) => x.id === id); if (r?.provider !== "fixture-serper") throw Object.assign(new Error("db down"), { code: "ECONNRESET" }); return settle(id, actual, f); };
  try {
    assert.equal(h.coordinator.counters().accountingFailures, 0);
    await h.coordinator.search(request({ originalQuery: "ledger refuses settlement" }), { signal: new AbortController().signal });
    assert.equal(h.coordinator.counters().accountingFailures, 4, "one per metered lane whose settlement failed");
    const metered = [...h.store.rows.values()].filter((x) => x.provider !== "fixture-serper");
    assert.deepEqual(metered.map((x) => x.state), ["RESERVED", "RESERVED", "RESERVED", "RESERVED"], "held at the reservation, swept to UNCERTAIN at the next start");
    assert.equal(h.logs.filter((l) => l.event === "si_accounting_failed").length, 4);
  } finally { await h.close(); }
});

test("a provider's retryAt is one ISO instant whether its lane failed on the refusal or was skipped while cooling down", async () => {
  const h = await harness({ handlers: { exa: () => ({ status: 429, body: { requestId: "r", error: "slow down", tag: "RATE_LIMIT_EXCEEDED" }, headers: { "retry-after": "120" } }) } });
  try {
    const ISO = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/;
    const failed = (await h.coordinator.search(request({ originalQuery: "retry at one" }), { signal: new AbortController().signal })).body.search.providers.exa;
    const skipped = (await h.coordinator.search(request({ originalQuery: "retry at two" }), { signal: new AbortController().signal })).body.search.providers.exa;
    assert.deepEqual([failed.status, skipped.status], ["failed", "skipped"]);
    assert.match(failed.retryAt, ISO);
    assert.match(skipped.retryAt, ISO);
    assert.equal(failed.retryAt, skipped.retryAt, "the same documented reset");
  } finally { await h.close(); }
});

test("an answer stored under one set of limits is not served after a limit that shapes it changes", async () => {
  const h = await harness();
  try {
    const first = await h.coordinator.search(request({ originalQuery: "limits shape answers" }), { signal: new AbortController().signal });
    assert.notEqual(first.body.search.cache.mode, "hit");
    h.policy.search.intelligence.candidates.shortlistMax -= 1;
    const second = await h.coordinator.search(request({ originalQuery: "limits shape answers" }), { signal: new AbortController().signal });
    assert.notEqual(second.body.search.cache.mode, "hit", "a changed limit is a new answer");
    const third = await h.coordinator.search(request({ originalQuery: "limits shape answers" }), { signal: new AbortController().signal });
    assert.equal(third.body.search.cache.mode, "hit", "the control: unchanged limits are served the stored answer");
    assert.equal(h.store.admissions, 2);
  } finally { await h.close(); }
});

// ---- deadlines and late DNS -------------------------------------------------------------------------------------------------------
test("a deadline that passes while DNS is pending sends nothing when DNS later answers; the uncancelled control connects", async () => {
  let connections = 0;
  const srv = await serve((req, res) => { json(res, 200, { ok: true }); });
  srv.port && (await new Promise((r) => setTimeout(r, 1)));
  const counting = (await import("node:net")).createServer((sock) => { connections++; sock.destroy(); });
  await new Promise((r) => counting.listen(0, "127.0.0.1", r));
  const port = counting.address().port;
  const policy = policyFor({ "dns.fixture.fcpi.test": port });
  try {
    let answer;
    const lookup = () => new Promise((r) => { answer = r; });
    const abort = new AbortController();
    const p = providerRequest({ baseUrl: `http://dns.fixture.fcpi.test:${port}`, path: "/x", body: Buffer.from("{}"), timeoutMs: 5000, getPolicy: () => policy, lookupFixture: lookup, signal: abort.signal, deadlineAt: Date.now() + 5000 });
    await new Promise((r) => setTimeout(r, 20));
    abort.abort();
    await assert.rejects(p, (e) => e.code === "CANCELLED" && e.sent === false);
    answer(["127.0.0.1"]);
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(connections, 0, "no socket after cancellation");
    const late = providerRequest({ baseUrl: `http://dns.fixture.fcpi.test:${port}`, path: "/x", body: Buffer.from("{}"), timeoutMs: 5000, getPolicy: () => policy,
      lookupFixture: () => new Promise((r) => setTimeout(() => r(["127.0.0.1"]), 300)), deadlineAt: Date.now() + 100 });
    await assert.rejects(late, (e) => e.code === "PROVIDER_TIMEOUT" && e.sent === false && e.timedOut);
    await new Promise((r) => setTimeout(r, 400));
    assert.equal(connections, 0, "no socket after the deadline");
    // Positive control: the same request, uncancelled, reaches the server.
    await providerRequest({ baseUrl: `http://dns.fixture.fcpi.test:${port}`, path: "/x", body: Buffer.from("{}"), timeoutMs: 2000, getPolicy: () => policy, lookupFixture: async () => ["127.0.0.1"], deadlineAt: Date.now() + 2000 }).catch(() => {});
    assert.equal(connections, 1);
  } finally { await srv.close(); await new Promise((r) => counting.close(r)); }
});

test("a lane that outlives its provider deadline is reported as a timeout and its reservation is not lost", async () => {
  const h = await harness({ handlers: { exa: async (q, e) => { await new Promise((r) => setTimeout(r, 3000)); return answers.exa(q, e); } },
    mutatePolicy: (p) => { p.search.intelligence.providerTimeoutsMs.exa = 1000; } });
  try {
    const t0 = Date.now();
    const r = await h.coordinator.search(request(), { signal: new AbortController().signal });
    assert.ok(Date.now() - t0 < 2500, "the search did not wait for the stalled provider");
    assert.deepEqual([r.body.search.providers.exa.status, r.body.search.providers.exa.reason], ["failed", "timeout"]);
    await new Promise((res) => setTimeout(res, 300));
    assert.equal([...h.store.rows.values()].find((x) => x.provider === "fixture-exa").state, "UNCERTAIN", "sent and unanswered: the charge is unknown");
  } finally { await h.close(); }
});

test("a stalled Serper is a timeout that may have been sent, whichever of its own timer and the search's deadline ends it", async () => {
  const h = await harness({ handlers: { serper: async (q, e) => { await new Promise((r) => setTimeout(r, 3000)); return answers.serper(q, e); } },
    mutatePolicy: (p) => { p.search.intelligence.providerTimeoutsMs.serper = 1000; } });
  try {
    const r = await h.coordinator.search(request(), { signal: new AbortController().signal });
    const s = r.body.search.providers.serper;
    assert.deepEqual([s.status, s.reason, s.dispatchState], ["failed", "timeout", "possibly_sent"]);
    await new Promise((res) => setTimeout(res, 300));
    assert.equal([...h.store.rows.values()].find((x) => x.provider === "fixture-serper").state, "UNCERTAIN");
  } finally { await h.close(); }
});

test("a lane stuck past a deadline that ends the search still leaves time to answer: partial, not SEARCH_TIMEOUT", async () => {
  // Exa stalls, and the ledger then hangs while marking its call uncertain, so the lane's own bound is what ends it. The
  // request's deadline (3 s) binds discovery, so the lane's deadline is the search's last moment before its response margin.
  const h = await harness({ handlers: { exa: async (q, e) => { await new Promise((r) => setTimeout(r, 4000)); return answers.exa(q, e); } } });
  const mark = h.store.markBudgetUncertain.bind(h.store);
  h.store.markBudgetUncertain = async (id, detail) => { await new Promise((r) => setTimeout(r, 2500)); return mark(id, detail); };
  try {
    const r = await h.coordinator.search(request({ originalQuery: "stuck lane", absoluteDeadlineMs: Date.now() + 3000 }), { signal: new AbortController().signal });
    assert.equal(r.body.search.outcome, "partial");
    assert.deepEqual([r.body.search.providers.exa.reason, r.body.search.providers.exa.detail], ["timeout", "lane_deadline"]);
  } finally { await h.close(); }
});

test("the legacy profile is the rollback: the new route serves the accepted search in the new shape and runs no aggregate lane", async () => {
  const { makeCoordinator } = await import("../src/search-intelligence/coordinator.mjs");
  const h = await harness({ mutateBudget: (b) => { b.searching.profile = "legacy"; } });
  let legacyCalls = 0;
  const legacy = async (url) => { legacyCalls++; assert.match(url, /^\/searxng\/search\?q=rollback\+check&language=en$/);
    return { status: 200, body: { results: [{ url: "https://legacy.example/a", title: "A", content: "c" }], unresponsive_engines: [{ engine: "google (Serper)", reason: "SEARCH_PROVIDER_HTTP_500" }], fcpi: { cache: "miss", engines: ["google (Serper)", "yahoo"], answered: ["yahoo"] } } }; };
  const coordinator = makeCoordinator({ store: h.store, getBudget: () => h.budget, getPolicy: () => h.policy, getSelection: () => ({ search: "fixture" }), dispatch: h.dispatch, general: {}, availability: h.availability, legacy });
  try {
    const r = await coordinator.search(request({ originalQuery: "rollback check" }), { signal: new AbortController().signal });
    assert.equal(legacyCalls, 1);
    assert.equal(r.body.search.profile, "legacy");
    assert.equal(r.body.search.outcome, "partial");
    assert.deepEqual(r.body.web, [{ url: "https://legacy.example/a", title: "A", description: "c" }]);
    assert.match(r.body.warning, /google \(Serper\): SEARCH_PROVIDER_HTTP_500/);
    assert.equal(Object.values(h.servers).reduce((n, s) => n + s.seen.length, 0), 0);
    assert.equal(h.store.admissions, 0, "the legacy search does its own admission");
  } finally { await h.close(); }
});

test("the legacy rollback forwards a language the legacy facade accepts: es-419 as es, zh-Hant unchanged", async () => {
  const { makeCoordinator } = await import("../src/search-intelligence/coordinator.mjs");
  const h = await harness({ mutateBudget: (b) => { b.searching.profile = "legacy"; } });
  const seen = [];
  const legacy = async (url) => { seen.push(new URL(url, "http://x").searchParams.get("language")); return { status: 200, body: { results: [], unresponsive_engines: [], fcpi: { cache: "miss" } } }; };
  const coordinator = makeCoordinator({ store: h.store, getBudget: () => h.budget, getPolicy: () => h.policy, getSelection: () => ({ search: "fixture" }), dispatch: h.dispatch, general: {}, availability: h.availability, legacy });
  try {
    for (const language of ["es-419", "zh-Hant", "auto"]) await coordinator.search(request({ originalQuery: "language check", language }), { signal: new AbortController().signal });
    assert.deepEqual(seen, ["es", "zh-Hant", "auto"]);
    for (const l of seen) assert.match(l, /^[A-Za-z-]{1,16}$/, "every forwarded tag passes the legacy facade's own check");
  } finally { await h.close(); }
});

test("Brave's live monthly window of limit 0 sets no allowance: a burst 429 is a rate limit of one second, not a 14-day quota", () => {
  // The headers live Brave sent with a successful call (SI5 live contract smoke, 2026-10-18), here on a burst refusal.
  const now = 1_000_000;
  const live = parseBraveRateHeaders({ "x-ratelimit-limit": "50, 0", "x-ratelimit-policy": "50;w=1, 0;w=2678400", "x-ratelimit-remaining": "0, 0", "x-ratelimit-reset": "1, 1205222" }, now);
  assert.deepEqual([live.state, live.retryAt], ["rate_limited", now + 1000]);
  const fine = parseBraveRateHeaders({ "x-ratelimit-limit": "50, 0", "x-ratelimit-policy": "50;w=1, 0;w=2678400", "x-ratelimit-remaining": "49, 0", "x-ratelimit-reset": "1, 1205222" }, now);
  assert.equal(fine.state, null, "nothing is exhausted when only the zero-limit window shows 0 remaining");
});

test("the legacy profile keeps hard constraints: domain lists become site: operators and filter the rows; strict dates are refused", async () => {
  const { makeCoordinator } = await import("../src/search-intelligence/coordinator.mjs");
  const h = await harness({ mutateBudget: (b) => { b.searching.profile = "legacy"; } });
  const asked = [];
  const legacy = async (url) => { asked.push(new URL(url, "http://x").searchParams.get("q"));
    return { status: 200, body: { results: [{ url: "https://vuejs.org/guide/a", title: "A", content: "a" }, { url: "https://evil.example/vuejs.org", title: "B", content: "b" }, { url: "https://docs.vuejs.org/c", title: "C", content: "c" }],
      unresponsive_engines: [], fcpi: { cache: "miss", engines: ["google (Serper)"], answered: ["google (Serper)"] } } }; };
  const coordinator = makeCoordinator({ store: h.store, getBudget: () => h.budget, getPolicy: () => h.policy, getSelection: () => ({ search: "fixture" }), dispatch: h.dispatch, general: {}, availability: h.availability, legacy });
  try {
    const inc = await coordinator.search(request({ originalQuery: "ref api", constraints: { includeDomains: ["vuejs.org"] } }), { signal: new AbortController().signal });
    assert.equal(asked[0], "ref api site:vuejs.org");
    assert.deepEqual(inc.body.web.map((w) => w.url), ["https://vuejs.org/guide/a", "https://docs.vuejs.org/c"], "an off-domain row is never returned");
    const exc = await coordinator.search(request({ originalQuery: "ref api", constraints: { excludeDomains: ["vuejs.org"] } }), { signal: new AbortController().signal });
    assert.equal(asked[1], "ref api -site:vuejs.org");
    assert.deepEqual(exc.body.web.map((w) => w.url), ["https://evil.example/vuejs.org"]);
    await assert.rejects(coordinator.search(request({ originalQuery: "ref api", constraints: { publishedAfter: "2026-01-01T00:00:00Z", dateMode: "strict_publication" } }), { signal: new AbortController().signal }),
      (e) => e.failureClass === "UNSUPPORTED_CAPABILITY");
    const fresh = await coordinator.search(request({ originalQuery: "ref api", constraints: { publishedAfter: "2026-01-01T00:00:00Z" } }), { signal: new AbortController().signal });
    assert.deepEqual(fresh.body.search.warnings, ["legacy_freshness_ignored"]);
    assert.match(fresh.body.warning, /ignores the freshness preference/);
  } finally { await h.close(); }
});

test("the internal contract refuses an instant that does not exist, as the gateway and the core do", () => {
  for (const v of ["2026-02-30T00:00:00Z", "2026-10-17T24:00:00Z"]) assert.throws(() => validateSearchRequest(request({ constraints: { publishedAfter: v } }), Date.now()), /publishedAfter must be an ISO-8601/);
  assert.equal(validateSearchRequest(request({ constraints: { publishedAfter: "2028-02-29T00:00:00Z" } }), Date.now()).constraints.publishedAfter, "2028-02-29T00:00:00.000Z");
});
