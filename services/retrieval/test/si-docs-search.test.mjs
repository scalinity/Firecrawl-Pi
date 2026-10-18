// The documentation layer inside the logical search (docs/FIRECRAWL_PI_SEARCH_INTELLIGENCE_SPEC.md §6, §13, §14.2, §17): both
// documentation providers beside all five general engines, failures isolated, source-less snippets carried as auxiliary context,
// at most two selected Ref reads in the discovery's own session, a fresh context session for a cached discovery, and every Ref
// session closed when its search ends.
import { test } from "node:test";
import assert from "node:assert/strict";
import { setTimeout as sleep } from "node:timers/promises";
import { randomUUID } from "node:crypto";
import { harness, request, refFixture, answers } from "./si-helpers.mjs";

const context7 = () => ({ status: 200, body: {
  codeSnippets: [{ libraryId: "/vuejs/docs", codeTitle: "Declaring reactive state", codeDescription: "Use ref() to declare reactive state.", codeLanguage: "javascript",
    codeList: [{ language: "javascript", code: "const count = ref(0)" }], codeId: "https://vuejs.org/guide/essentials/reactivity-fundamentals.html", pageTitle: "Reactivity Fundamentals" }],
  infoSnippets: [{ libraryId: "/vuejs/docs", content: "Watchers run after the component updates by default.", pageId: "vue-docs:watchers", breadcrumb: "Guide > Watchers" }] } });
const empty = { serper: () => ({ status: 200, body: { credits: 1, organic: [] } }), brave: (q) => ({ status: 200, body: { query: { original: q }, web: { type: "search", results: [] } } }),
  exa: () => ({ status: 200, body: { requestId: "x", results: [], costDollars: { total: 0.005 } } }), deepseek: () => ({ status: 200, body: { results: [] } }),
  tavily: (q) => ({ status: 200, body: { query: q, results: [], usage: { credits: 2 }, request_id: "t" } }) };
const docsRequest = (q, over = {}) => request({ originalQuery: q, intelligence: { documentation: "required" }, ...over });
const reads = (fx) => fx.log.filter((e) => e.tool === "ref_read_url");
const searches = (fx) => fx.log.filter((e) => e.tool === "ref_search_documentation");

test("required documentation runs Context7 and Ref beside all five engines, carries a source-less snippet, and closes Ref's session", async () => {
  const fx = refFixture();
  const h = await harness({ handlers: { context7, ref: fx } });
  try {
    const r = await h.coordinator.search(docsRequest("vue reactive state ref"), { signal: new AbortController().signal });
    const s = r.body.search;
    assert.deepEqual([s.outcome, s.coverage.documentation.activated, s.coverage.documentation.requested, s.coverage.documentation.successful], ["complete", true, 2, 2]);
    for (const p of ["serper", "brave", "exa", "deepseek", "tavily"]) assert.equal(h.servers[p].seen.length, 1, `${p} was dispatched`);
    assert.equal(s.coverage.general.successful, 5, "documentation never means the general engines stop");
    assert.equal(h.servers.context7.seen.length, 1);
    assert.equal(searches(fx).length, 1);
    const aux = s.documentation.auxiliaryContext.find((a) => a.provider === "context7");
    assert.ok(aux, "the snippet without an original URL is delivered, not dropped");
    assert.deepEqual([aux.sourceUrl, aux.sourceIdentifier, aux.libraryId, aux.kind], [null, "vue-docs:watchers", "/vuejs/docs", "documentation_text"]);
    assert.match(aux.text, /Watchers run after/);
    assert.ok(r.body.web.some((w) => w.url === "https://vuejs.org/guide/essentials/reactivity-fundamentals.html"), "a snippet with a real source URL joins the results");
    assert.ok(!r.body.web.some((w) => w.url.startsWith("vue-docs:")), "no citation is fabricated from a provider identifier");
    await sleep(100);
    assert.ok(fx.log.some((e) => e.method === "DELETE" && e.session === searches(fx)[0].session && e.closed), "the Ref session is closed when the search ends");
  } finally { await h.close(); }
});

test("at most two Ref documents without an excerpt are read, in the discovery's own session, and their excerpts join the rows", async () => {
  const fx = refFixture();
  const h = await harness({ handlers: { ...empty, ref: fx } });
  try {
    const r = await h.coordinator.search(docsRequest("ref reads in session"), { signal: new AbortController().signal });
    const s = r.body.search;
    assert.equal(reads(fx).length, 2, "three Ref hits lack an excerpt; two are read");
    assert.deepEqual([...new Set(reads(fx).map((e) => e.session))], [searches(fx)[0].session], "the reads ran in the discovery's session");
    assert.deepEqual(s.documentation.enrichment, { selected: 2, read: 2, contextInit: false });
    const enriched = r.body.web.filter((w) => w.fcpi.search.passages.some((p) => p.kind === "ref_context_excerpt"));
    assert.equal(enriched.length, 2);
    assert.deepEqual(enriched.map((w) => reads(fx).some((e) => e.args.url === w.url)), [true, true], "each excerpt is the read of that row's exact URL");
    assert.equal(s.usage.filter((u) => u.provider === "ref" && u.operation === "read").length, 2, "each read is reported as its own spend");
    assert.deepEqual([...h.store.rows.values()].filter((x) => x.provider === "fixture-ref").map((x) => x.state), ["SETTLED", "SETTLED", "SETTLED"]);
  } finally { await h.close(); }
});

test("links mode with automatic documentation reads nothing: discovery text is enough unless documentation is required", async () => {
  const fx = refFixture();
  const h = await harness({ handlers: { ...empty, ref: fx } });
  try {
    const r = await h.coordinator.search(request({ originalQuery: "how do I configure vite proxy options", intelligence: { documentation: "auto" } }), { signal: new AbortController().signal });
    assert.equal(r.body.search.coverage.documentation.activated, true, "a technical query activates documentation");
    assert.equal(searches(fx).length, 1);
    assert.equal(reads(fx).length, 0);
    assert.equal(r.body.search.documentation.enrichment, undefined);
  } finally { await h.close(); }
});

test("a cached Ref discovery that needs reads opens one fresh session whose context search is metered first", async () => {
  const fx = refFixture();
  const h = await harness({ handlers: { ...empty, ref: fx } });
  try {
    await h.coordinator.search(docsRequest("ref cached discovery", { limit: 5 }), { signal: new AbortController().signal });
    // A different limit is a different answer (no aggregate hit) over the same provider calls (provider cache hits).
    const r = await h.coordinator.search(docsRequest("ref cached discovery", { limit: 4 }), { signal: new AbortController().signal });
    const s = r.body.search;
    assert.equal(s.providers.ref.fromCache, true);
    const sessions = [...new Set(searches(fx).map((e) => e.session))];
    assert.equal(sessions.length, 2, "the second search's reads needed a new session");
    const second = fx.log.filter((e) => e.session === sessions[1] && e.tool);
    assert.deepEqual(second.map((e) => e.tool), ["ref_search_documentation", "ref_read_url", "ref_read_url"], "the context search runs in the new session before its reads");
    assert.deepEqual(s.documentation.enrichment, { selected: 2, read: 2, contextInit: true });
    const keys = [...h.store.rows.values()].filter((x) => x.provider === "fixture-ref").map((x) => x.call_key);
    assert.equal(keys.filter((k) => /:ref:context_init:/.test(k)).length, 1, "one context initialization, metered as its own operation");
    assert.ok(s.usage.some((u) => u.provider === "ref" && u.operation === "context_init"));
  } finally { await h.close(); }
});

test("a Ref outage leaves Context7 and the general results: the search is partial and says why, never failed", async () => {
  const fx = refFixture({ initialize: () => ({ status: 503 }) });
  const h = await harness({ handlers: { context7, ref: fx } });
  try {
    const r = await h.coordinator.search(docsRequest("vue reactive state outage"), { signal: new AbortController().signal });
    const s = r.body.search;
    assert.equal(s.outcome, "partial");
    assert.deepEqual(s.coverage.documentation.missing, [{ provider: "ref", status: "failed", reason: "temporarily_unavailable" }]);
    assert.equal(s.providers.context7.status, "success_results", "the sibling documentation lane is unaffected");
    assert.ok(r.body.web.length > 0);
    assert.ok(s.warnings.includes("ref_temporarily_unavailable"));
    assert.match(r.body.warning, /Ref unavailable/);
  } finally { await h.close(); }
});

test("a re-executed logical search whose Ref discovery is cached reads in its fresh session, never paying for a context it cannot use", async () => {
  const fx = refFixture();
  const h = await harness({ handlers: { ...empty, ref: fx } });
  try {
    const logicalSearchId = randomUUID();
    await h.coordinator.search(docsRequest("ref re-executed search", { logicalSearchId, limit: 5 }), { signal: new AbortController().signal });
    const r = await h.coordinator.search(docsRequest("ref re-executed search", { logicalSearchId, limit: 4 }), { signal: new AbortController().signal });
    assert.equal(r.body.search.providers.ref.fromCache, true);
    assert.deepEqual(r.body.search.documentation.enrichment, { selected: 2, read: 2, contextInit: true }, "the fresh session's reads are its own operations");
    const keys = [...h.store.rows.values()].filter((x) => x.provider === "fixture-ref").map((x) => x.call_key);
    assert.equal(keys.length, 6, "discovery and two reads, then a context search and two reads in the new session");
    assert.equal(new Set(keys).size, 6);
  } finally { await h.close(); }
});

test("documentation off calls neither documentation provider", async () => {
  const fx = refFixture();
  const h = await harness({ handlers: { context7, ref: fx } });
  try {
    const r = await h.coordinator.search(request({ originalQuery: "react useEffect cleanup docs", intelligence: { documentation: "off" } }), { signal: new AbortController().signal });
    assert.deepEqual([r.body.search.coverage.documentation.activated, r.body.search.coverage.documentation.reason], [false, "explicit_off"]);
    assert.equal(h.servers.context7.seen.length, 0);
    assert.equal(fx.log.length, 0);
    assert.equal(r.body.search.coverage.general.successful, 5);
  } finally { await h.close(); }
});
