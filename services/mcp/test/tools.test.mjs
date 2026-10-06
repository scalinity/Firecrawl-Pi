// Unit tests for the tool set derived from the capability manifest (services/mcp/src/tools.mjs) and the
// manifest checks (src/config.mjs). FCPI_TEST_MANIFEST locates deploy/policies/capabilities.json when the
// repository layout is not around the test (inside the image on the Pi).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { makeTools, fitDocument } from "../src/tools.mjs";
import { checkMcpManifest } from "../src/config.mjs";

const MANIFEST = JSON.parse(readFileSync(process.env.FCPI_TEST_MANIFEST ?? new URL("../../../deploy/policies/capabilities.json", import.meta.url), "utf8"));
const m = () => structuredClone(MANIFEST);
const byName = (ts) => Object.fromEntries(ts.map((t) => [t.name, t]));

test("the catalog is the manifest's tools, sorted by name, each on its route", () => {
  const ts = makeTools(m());
  assert.deepEqual(ts.map((t) => t.name), [...MANIFEST.mcp.tools.map((t) => t.name)].sort());
  for (const t of ts) assert.equal(t.route.id, MANIFEST.mcp.tools.find((x) => x.name === t.name).route);
  // Reordering the manifest does not reorder the catalog.
  const r = m(); r.mcp.tools.reverse();
  assert.deepEqual(makeTools(r).map((t) => t.name), ts.map((t) => t.name));
});

test("a sync tool's schema is its route's body: the same fields, bounds and enums, nothing else", () => {
  const T = byName(makeTools(m()));
  const s = T.firecrawl_scrape.config.inputSchema;
  assert.equal(s.additionalProperties, false);
  assert.deepEqual(s.required, ["url"]);
  assert.equal(s.properties.origin, undefined, "the submission marker is the gateway's, never a caller's");
  // M5: the scrape tool's formats are the names, or the json object with its schema (the only object format).
  assert.deepEqual(s.properties.formats.items.anyOf[0].enum, MANIFEST.formats.allowed.filter((n) => !MANIFEST.formats.objects[n]));
  const json = s.properties.formats.items.anyOf[1];
  assert.deepEqual(json.properties.type, { const: "json" });
  assert.deepEqual(json.required, ["type", "schema"]);
  assert.equal(json.additionalProperties, false);
  assert.equal(json.properties.prompt.maxLength, MANIFEST.formats.objects.json.prompt.maxLength);
  assert.deepEqual(s.properties.proxy.enum, MANIFEST.fieldsets.scrapeOptions.proxy.values);
  assert.deepEqual(s.properties.mobile, { const: false });
  assert.equal(s.properties.timeout.maximum, MANIFEST.fieldsets.scrapeOptions.timeout.max);
  const fields = Object.keys({ ...MANIFEST.fieldsets.scrapeOptions, ...MANIFEST.bodies.scrape.fields }).filter((k) => k !== "origin");
  assert.deepEqual(Object.keys(s.properties).sort(), fields.sort());
  const mp = T.firecrawl_map.config.inputSchema;
  assert.equal(mp.properties.limit.maximum, MANIFEST.bodies.map.fields.limit.max);
  assert.deepEqual(mp.properties.sitemap.enum, MANIFEST.bodies.map.fields.sitemap.values);
});

test("a submit tool adds only idempotencyKey; crawl nests scrapeOptions; batch bounds its URLs", () => {
  const T = byName(makeTools(m()));
  const c = T.firecrawl_crawl.config.inputSchema;
  assert.ok(c.properties.idempotencyKey.pattern);
  assert.equal(c.properties.limit.maximum, MANIFEST.bodies.crawl.fields.limit.max);
  assert.equal(c.properties.delay.exclusiveMinimum, 0);
  assert.equal(c.properties.scrapeOptions.additionalProperties, false);
  assert.ok(c.properties.scrapeOptions.properties.formats);
  const b = T.firecrawl_batch_scrape.config.inputSchema;
  assert.equal(b.properties.urls.maxItems, MANIFEST.limits.batch.maxUrls);
  assert.deepEqual(b.required, ["urls"]);
  // The key travels as the gateway's header, not in the body.
  const q = T.firecrawl_crawl.request({ url: "https://example.com/", limit: 3, idempotencyKey: "key-12345" });
  assert.deepEqual(q, { method: "POST", path: "/v2/crawl", body: { url: "https://example.com/", limit: 3 }, idemKey: "key-12345" });
});

test("id tools take a UUID; status tools page within the MCP bounds", () => {
  const T = byName(makeTools(m()));
  const s = T.firecrawl_check_crawl_status.config.inputSchema;
  assert.deepEqual(s.required, ["id"]);
  assert.equal(s.properties.limit.maximum, MANIFEST.mcp.limits.statusPageMax);
  const id = "0f8fad5b-d9cb-469f-a165-70867728950e";
  assert.deepEqual(T.firecrawl_check_crawl_status.request({ id }), { method: "GET", path: `/v2/crawl/${id}?skip=0&limit=${MANIFEST.mcp.limits.statusPageDefault}` });
  assert.deepEqual(T.firecrawl_batch_status.request({ id, skip: 7, limit: 2 }), { method: "GET", path: `/v2/batch/scrape/${id}?skip=7&limit=2` });
  assert.deepEqual(T.firecrawl_cancel_crawl.request({ id }), { method: "DELETE", path: `/v2/crawl/${id}` });
  assert.deepEqual(T.firecrawl_cancel_batch.request({ id }), { method: "DELETE", path: `/v2/batch/scrape/${id}` });
  assert.equal(T.firecrawl_cancel_batch.config.annotations.destructiveHint, true);
  assert.deepEqual(T.firecrawl_get_result.request({ id }), { method: "GET", path: `/platform/v1/jobs/${id}` });
  assert.deepEqual(T.firecrawl_capabilities.config.inputSchema, { type: "object", properties: {}, additionalProperties: false });
});

test("annotations are the manifest's, and only submit and sync tools report progress", () => {
  const T = byName(makeTools(m()));
  assert.equal(T.firecrawl_cancel_crawl.config.annotations.destructiveHint, true);
  assert.equal(T.firecrawl_scrape.config.annotations.readOnlyHint, true);
  assert.deepEqual(makeTools(m()).filter((t) => t.long).map((t) => t.name), ["firecrawl_batch_scrape", "firecrawl_crawl", "firecrawl_extract", "firecrawl_map", "firecrawl_scrape", "firecrawl_search"]);
});

test("the manifest checks refuse a tool on an unknown route and an omission the gateway serves", () => {
  checkMcpManifest(m());
  const a = m(); a.mcp.tools[0].route = "nope";
  assert.throws(() => checkMcpManifest(a), /unknown route/);
  const b = m(); b.mcp.omitted.push({ name: "firecrawl_x", method: "POST", path: "/v2/scrape" });
  assert.throws(() => checkMcpManifest(b), /not a not_enabled route/);
  const c = m(); c.mcp.tools.push({ ...c.mcp.tools[0] });
  assert.throws(() => checkMcpManifest(c), /invalid or repeated/);
  const d = m(); d.mcp.protocol.legacyServing = "sessionful";
  assert.throws(() => checkMcpManifest(d), /stateless/);
});

test("capabilities name the omitted tools with their not_enabled reasons; since M5 the manifest omits none", () => {
  const T = byName(makeTools(m()));
  const r = T.firecrawl_capabilities.shape({ status: 200, json: { success: true, service: "access-gateway" }, headers: {} }, {});
  assert.deepEqual(r.payload.mcp.omitted, []);
  assert.equal(r.payload.success, undefined);
  const x = m();
  x.not_enabled.push({ method: "POST", path: "/v2/something", reason: "a reason" });
  x.mcp.omitted = [{ name: "firecrawl_something", method: "POST", path: "/v2/something" }];
  const r2 = byName(makeTools(x)).firecrawl_capabilities.shape({ status: 200, json: { success: true }, headers: {} }, {});
  assert.deepEqual(r2.payload.mcp.omitted, [{ name: "firecrawl_something", reason: "a reason" }]);
});

// ---- M5: search and extraction -------------------------------------------------------------------------
test("search and extract tools: their schemas are their routes' bodies, json only on scrape, extract bounded to its own URL limit", () => {
  const T = byName(makeTools(m()));
  const s = T.firecrawl_search.config.inputSchema;
  assert.deepEqual(s.required, ["query"]);
  assert.equal(s.properties.limit.maximum, 10);
  for (const k of ["tbs", "country", "categories", "sources"]) assert.equal(s.properties[k], undefined, k);
  assert.deepEqual(s.properties.scrapeOptions.properties.formats.items.enum, MANIFEST.formats.allowed.filter((n) => !MANIFEST.formats.scrapeOnly.includes(n)), "no scrape-only format (json, M7's screenshot) on search's scraped results");
  const e = T.firecrawl_extract.config.inputSchema;
  assert.deepEqual(e.required.sort(), ["schema", "urls"]);
  assert.equal(e.properties.urls.maxItems, MANIFEST.limits.extract.maxUrls);
  assert.equal(e.properties.schema.type, "object");
  assert.ok(e.properties.idempotencyKey);
  for (const k of ["enableWebSearch", "allowExternalLinks", "agent"]) assert.equal(e.properties[k], undefined, k);
  assert.equal(T.firecrawl_batch_scrape.config.inputSchema.properties.urls.maxItems, MANIFEST.limits.batch.maxUrls);
  assert.deepEqual(T.firecrawl_extract_status.config.inputSchema.required, ["id"]);
});

test("search results fit the payload limit, a search failure is a tool error, and an extraction is polled with its own tool", () => {
  const T = byName(makeTools(m()));
  const web = Array.from({ length: 10 }, (_, i) => ({ url: `https://r.example/${i}`, title: "t", description: "d", markdown: "m".repeat(60000) }));
  const r = T.firecrawl_search.shape({ status: 200, json: { success: true, data: { web }, warning: "Partial search result: 1 engine(s) did not answer (bing: timeout)." }, headers: {} }, {});
  assert.ok(Buffer.byteLength(JSON.stringify(r.payload)) <= MANIFEST.mcp.limits.toolTextMaxBytes);
  assert.equal(r.payload.truncated.results.originalCount, 10);
  assert.match(r.payload.warning, /Partial/);
  const f = T.firecrawl_search.shape({ status: 502, json: { success: false, code: "SEARCH_ENGINES_FAILED", error: "no search engine answered" }, headers: { "retry-after": "60" } }, {});
  assert.equal(f.isError, true);
  assert.equal(f.payload.error.code, "SEARCH_ENGINES_FAILED");
  assert.equal(f.payload.error.retryAfterSeconds, 60);
  const sub = T.firecrawl_extract.shape({ status: 200, json: { success: true, id: "0190f1a0-0000-7000-8000-000000000000", urlTrace: [] }, headers: {} }, { idempotencyKey: "k-12345678" });
  assert.match(sub.payload.next, /firecrawl_extract_status/);
  const st = T.firecrawl_extract_status.shape({ status: 200, json: { success: true, status: "completed", data: { a: 1 }, sources: { "$": ["https://a.example/"] }, fcpi: { units: [] } }, headers: {} }, { id: "x" });
  assert.deepEqual(st.payload, { id: "x", status: "completed", data: { a: 1 }, sources: { "$": ["https://a.example/"] }, fcpi: { units: [] } });
});

test("gateway refusals become tool errors carrying the gateway's code and message", () => {
  const T = byName(makeTools(m()));
  const r = T.firecrawl_scrape.shape({ status: 403, json: { success: false, code: "INSUFFICIENT_SCOPE", error: "This token lacks the 'scrape' scope." }, headers: {} }, {});
  assert.equal(r.isError, true);
  assert.deepEqual(r.payload, { error: { httpStatus: 403, code: "INSUFFICIENT_SCOPE", message: "This token lacks the 'scrape' scope." } });
  const u = T.firecrawl_crawl.shape({ status: 503, json: { success: false, code: "SUBMISSION_UNCERTAIN", id: "x", receipt: "http://h/platform/v1/jobs/x", error: "…" }, headers: { "retry-after": "10" } }, {});
  assert.equal(u.payload.error.id, "x");
  assert.equal(u.payload.error.retryAfterSeconds, 10);
});

test("an oversized scrape is cut field by field, largest first, and says so", () => {
  const T = byName(makeTools(m()));
  const big = { markdown: "m".repeat(200000), rawHtml: "r".repeat(400000), metadata: { sourceURL: "https://example.com/" } };
  const r = T.firecrawl_scrape.shape({ status: 200, json: { success: true, data: big }, headers: {} }, {});
  const len = Buffer.byteLength(JSON.stringify(r.payload));
  assert.ok(len <= MANIFEST.mcp.limits.toolTextMaxBytes, `${len} bytes`);
  assert.equal(r.payload.truncated.fields.rawHtml.originalBytes, 400000);
  assert.ok(r.payload.data.metadata.sourceURL);
  // A page that fits is returned whole.
  const small = T.firecrawl_scrape.shape({ status: 200, json: { success: true, data: { markdown: "# hi" } }, headers: {} }, {});
  assert.equal(small.payload.truncated, undefined);
});

test("a status page carries the documents that fit and the skip to continue from", () => {
  const T = byName(makeTools(m()));
  const doc = (i) => ({ markdown: `${i}`.repeat(60000), metadata: { sourceURL: `https://example.com/${i}` } });
  const id = "0f8fad5b-d9cb-469f-a165-70867728950e";
  const r = T.firecrawl_check_crawl_status.shape({ status: 200, json: { success: true, status: "completed", completed: 12, total: 12, data: [0, 1, 2, 3, 4, 5].map(doc) }, headers: {} }, { id, skip: 4, limit: 6 });
  assert.ok(r.payload.returned >= 1 && r.payload.returned < 6);
  assert.equal(r.payload.nextSkip, 4 + r.payload.returned);
  assert.ok(Buffer.byteLength(JSON.stringify(r.payload)) <= MANIFEST.mcp.limits.toolTextMaxBytes);
  // The last page: every document fits and nothing remains.
  const last = T.firecrawl_check_crawl_status.shape({ status: 200, json: { success: true, status: "completed", completed: 2, total: 2, data: [{ markdown: "a" }, { markdown: "b" }] }, headers: {} }, { id, skip: 0 });
  assert.equal(last.payload.returned, 2);
  assert.equal(last.payload.nextSkip, null);
  // More remain past this page (the gateway's next): continue after it.
  const more = T.firecrawl_check_crawl_status.shape({ status: 200, json: { success: true, status: "scraping", completed: 9, total: 9, next: "http://h/v2/crawl/x?skip=2", data: [{ markdown: "a" }, { markdown: "b" }] }, headers: {} }, { id, skip: 0, limit: 2 });
  assert.equal(more.payload.nextSkip, 2);
  // A single document over the limit comes back cut, marked with its index.
  const one = T.firecrawl_batch_status.shape({ status: 200, json: { success: true, status: "completed", completed: 1, total: 1, data: [{ html: "h".repeat(600000) }] }, headers: {} }, { id, skip: 0 });
  assert.equal(one.payload.returned, 1);
  assert.equal(one.payload.truncated.document, 0);
  assert.ok(Buffer.byteLength(JSON.stringify(one.payload)) <= MANIFEST.mcp.limits.toolTextMaxBytes);
});

test("fitDocument halves a link list when no string field is left to cut", () => {
  const doc = { links: Array.from({ length: 5000 }, (_, i) => `https://example.com/${i}`) };
  const payload = { data: doc };
  const cuts = fitDocument(payload, doc, 20000);
  assert.ok(Buffer.byteLength(JSON.stringify(payload)) <= 20000);
  assert.equal(cuts.links.originalCount, 5000);
});

test("a map answer cut to fit stays under the limit with its marker in place", () => {
  const T = byName(makeTools(m()));
  // Adversarial by construction: a title length at which 500 links fit the limit but 500 links and the
  // marker do not, so halving from 1,000 lands exactly where a marker added afterwards would overflow.
  const mk = (n, len, pad = 0) => Array.from({ length: n }, (_, i) => ({ url: `https://example.com/${String(i).padStart(4, "0")}`, title: "t".repeat(len + (i === 0 ? pad : 0)) }));
  const B = MANIFEST.mcp.limits.toolTextMaxBytes, size = (n, len, pad) => Buffer.byteLength(JSON.stringify({ links: mk(n, len, pad) }));
  const len = Math.floor((B - 60 - size(500, 0)) / 500), pad = B - 60 - size(500, len);
  assert.equal(size(500, len, pad), B - 60, "500 links leave 60 bytes, less than the marker needs");
  const links = mk(1000, len, pad);
  const r = T.firecrawl_map.shape({ status: 200, json: { success: true, links }, headers: {} }, {});
  assert.ok(Buffer.byteLength(JSON.stringify(r.payload)) <= MANIFEST.mcp.limits.toolTextMaxBytes, `${Buffer.byteLength(JSON.stringify(r.payload))} bytes`);
  assert.equal(r.payload.truncated.links.originalCount, 1000);
  assert.equal(r.payload.truncated.links.returnedCount, r.payload.links.length);
  const small = T.firecrawl_map.shape({ status: 200, json: { success: true, links: links.slice(0, 3) }, headers: {} }, {});
  assert.equal(small.payload.truncated, undefined);
});

test("a scrape the core stopped answering (502) advises against an unchanged retry; other errors do not", () => {
  const T = byName(makeTools(m()));
  const r = T.firecrawl_scrape.shape({ status: 502, json: { success: false, code: "UPSTREAM_UNAVAILABLE", error: "The core is unavailable." }, headers: {} }, {});
  assert.equal(r.isError, true);
  assert.match(r.payload.error.advice, /do not retry it unchanged/);
  const other = T.firecrawl_scrape.shape({ status: 503, json: { success: false, code: "OVERLOADED", error: "busy" }, headers: {} }, {});
  assert.equal(other.payload.error.advice, undefined);
  const map = T.firecrawl_map.shape({ status: 502, json: { success: false, error: "x" }, headers: {} }, {});
  assert.equal(map.payload.error.advice, undefined);
});

test("a running job's page resumes after what it returned; a finished job's last page ends", () => {
  const T = byName(makeTools(m()));
  const id = "0f8fad5b-d9cb-469f-a165-70867728950e";
  const running = T.firecrawl_check_crawl_status.shape({ status: 200, json: { success: true, status: "scraping", completed: 2, total: 9, data: [{ markdown: "a" }, { markdown: "b" }] }, headers: {} }, { id, skip: 3 });
  assert.equal(running.payload.nextSkip, 5);
  const empty = T.firecrawl_check_crawl_status.shape({ status: 200, json: { success: true, status: "scraping", completed: 0, total: 0, data: [] }, headers: {} }, { id, skip: 0 });
  assert.equal(empty.payload.nextSkip, 0);
  const done = T.firecrawl_check_crawl_status.shape({ status: 200, json: { success: true, status: "completed", completed: 2, total: 2, data: [{ markdown: "a" }, { markdown: "b" }] }, headers: {} }, { id, skip: 0 });
  assert.equal(done.payload.nextSkip, null);
});

test("M7: the scrape tool takes the action subset, the screenshot format and the cache options; jobs take a webhook; nothing looser than the gateway", () => {
  const T = byName(makeTools(m()));
  const s = T.firecrawl_scrape.config.inputSchema.properties;
  const actions = s.actions.items.anyOf.map((a) => a.properties.type.const);
  assert.deepEqual(actions, ["wait", "click", "scroll", "screenshot", "scrape"]);
  assert.equal(s.actions.maxItems, 10);
  assert.equal(s.actions.items.anyOf.find((a) => a.properties.type.const === "click").properties.all, undefined, "click's all is left out");
  assert.ok(s.formats.items.anyOf.some((f) => f.properties?.type?.const === "screenshot" && f.properties.fullPage?.type === "boolean"));
  assert.deepEqual([s.maxAge.maximum, s.storeInCache.type], [3600000, "boolean"]);
  assert.ok(s.proxy.enum.includes("enhanced"));
  for (const t of ["firecrawl_crawl", "firecrawl_batch_scrape", "firecrawl_extract"]) {
    const w = T[t].config.inputSchema.properties.webhook;
    assert.deepEqual(w.required, ["url"], t);
    assert.deepEqual(w.properties.events.items.enum, ["started", "completed", "failed"], t);
    assert.equal(w.additionalProperties, false, t);
  }
  assert.equal(T.firecrawl_crawl.config.inputSchema.properties.scrapeOptions.properties.actions, undefined, "actions are on scrape alone");
});

test("fitDocument cuts content captures too, largest first, and names each cut (M7 review W8)", () => {
  const doc = { markdown: "", actions: { screenshots: [], scrapes: [{ url: "https://a.example/", html: "a".repeat(200000) }, { url: "https://a.example/", html: "b".repeat(200000) }] } };
  const payload = { data: doc };
  const cuts = fitDocument(payload, doc, 262144);
  assert.ok(Buffer.byteLength(JSON.stringify(payload)) <= 262144, "the payload fits the tool limit");
  assert.equal(cuts["actions.scrapes[0].html"].originalBytes, 200000);
  assert.ok(cuts["actions.scrapes[0].html"].returnedBytes < 200000);
  assert.equal(doc.actions.scrapes[1].html.length, 200000, "only as much as needed is cut");
});

test("a finished job's outcome reaches the agent beside its native status; a core's -1 credits are left out", () => {
  const T = byName(makeTools(m()));
  const fcpi = { state: "PARTIAL", failed: 19, failures: [{ class: "DIRECT_LIMIT", count: 19, detail: "300 direct navigations to this domain in the last hour", urls: ["https://b.example/1"], retryAt: "2026-10-06T10:08:55.530Z" }] };
  const r = T.firecrawl_check_crawl_status.shape({ status: 200, json: { success: true, status: "completed", completed: 1, total: 20, creditsUsed: -1, data: [{ markdown: "x" }], fcpi }, headers: {} }, { id: "0190f1a0-0000-7000-8000-000000000000" });
  assert.deepEqual(r.payload.fcpi, fcpi);
  assert.equal(r.payload.status, "completed");
  assert.equal("creditsUsed" in r.payload, false);
  const b = T.firecrawl_batch_status.shape({ status: 200, json: { success: true, status: "completed", completed: 2, total: 2, creditsUsed: 2, data: [], fcpi: { state: "SUCCEEDED", failed: 0 } }, headers: {} }, { id: "0190f1a0-0000-7000-8000-000000000000" });
  assert.deepEqual([b.payload.creditsUsed, b.payload.fcpi], [2, { state: "SUCCEEDED", failed: 0 }]);
});

test("map passes on how many links each source gave and the core's warning", () => {
  const T = byName(makeTools(m()));
  const fcpi = { sources: { sitemap: 0, page: 2 }, note: "No sitemap listed links here." };
  const r = T.firecrawl_map.shape({ status: 200, json: { success: true, links: [{ url: "https://a.example/1" }, { url: "https://a.example/2" }], warning: "Only 1 result(s) found.", fcpi }, headers: {} }, {});
  assert.deepEqual(r.payload, { links: [{ url: "https://a.example/1" }, { url: "https://a.example/2" }], warning: "Only 1 result(s) found.", fcpi });
});

test("in-page anchors are reduced to their text in every document an agent reads; links elsewhere are kept as written", async () => {
  const { dropInPageLinks } = await import("../src/tools.mjs");
  const page = "https://w.example/wiki/Pi";
  const md = `[Jump to content](${page}#bodyContent)\nThe Pi 5 has 16 GB.[\\[72\\]](${page}#cite_note-72) See [ARM](https://w.example/wiki/ARM "ARM") and [Pi](${page}) and [other](https://w.example/wiki/Other#History).\n1. [↑](${page}#cite_ref-1) ![img](https://w.example/i.png)`;
  const doc = { markdown: md, metadata: { url: page, sourceURL: `${page}?x` } };
  dropInPageLinks(doc);
  assert.equal(doc.markdown, `Jump to content\nThe Pi 5 has 16 GB.\\[72\\] See [ARM](https://w.example/wiki/ARM "ARM") and [Pi](${page}) and [other](https://w.example/wiki/Other#History).\n1. ↑ ![img](https://w.example/i.png)`);
  // A document without its own URL, or without markdown, is left alone.
  const bare = { markdown: `[a](${page}#x)` };
  dropInPageLinks(bare);
  assert.equal(bare.markdown, `[a](${page}#x)`);
  // Through the scrape, search and status answers.
  const T = byName(makeTools(m()));
  const s = T.firecrawl_scrape.shape({ status: 200, json: { success: true, data: { markdown: `x[\\[1\\]](${page}#c1)`, metadata: { url: page } } }, headers: {} }, {});
  assert.equal(s.payload.data.markdown, "x\\[1\\]");
  const q = T.firecrawl_search.shape({ status: 200, json: { success: true, data: { web: [{ url: page, markdown: `y[n](${page}#n)`, metadata: { url: page } }] } }, headers: {} }, {});
  assert.equal(q.payload.data.web[0].markdown, "yn");
  const st = T.firecrawl_check_crawl_status.shape({ status: 200, json: { success: true, status: "completed", completed: 1, total: 1, data: [{ markdown: `z[t](${page}#t)`, metadata: { sourceURL: page } }] }, headers: {} }, { id: "0190f1a0-0000-7000-8000-000000000000" });
  assert.equal(st.payload.data[0].markdown, "zt");
});
