// Search intelligence at the gateway (docs/FIRECRAWL_PI_SEARCH_INTELLIGENCE_SPEC.md §9.1, §19.1, §19.2): the additive
// searchIntelligence options are validated with their bounds and cross-field rules before any work, and the search's trusted
// context reaches the core only through the four allowlisted headers the gateway builds itself.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { validateBody, RequestError } from "../src/validate.mjs";
import { makeUpstream } from "../src/upstream.mjs";

const M = JSON.parse(readFileSync(process.env.FCPI_TEST_MANIFEST ?? new URL("../../../deploy/policies/capabilities.json", import.meta.url), "utf8"));
const refused = (body, re) => assert.throws(() => validateBody("search", body, M), (e) => e instanceof RequestError && e.status === 400 && (!re || re.test(e.message)), JSON.stringify(body));

test("searchIntelligence is additive: an old request is unchanged, a new one keeps exactly its validated options", () => {
  assert.deepEqual(validateBody("search", { query: "q" }, M).body, { query: "q", limit: 5 });
  const si = { documentation: "required", libraries: [{ name: "vue", version: "3.5" }, { name: "pinia" }], programmingLanguage: "typescript",
    publishedAfter: "2026-01-01T00:00:00Z", publishedBefore: "2026-10-01T00:00:00.000Z", dateMode: "strict_publication", evidence: "off" };
  assert.deepEqual(validateBody("search", { query: "vue async components", includeDomains: ["vuejs.org"], searchIntelligence: si }, M).body,
    { query: "vue async components", includeDomains: ["vuejs.org"], searchIntelligence: si, limit: 5 });
});

test("searchIntelligence is refused before any work when it conflicts, is malformed, or names what is not offered", () => {
  refused({ query: "q", includeDomains: ["a.example"], excludeDomains: ["b.example"] }, /cannot both/);
  refused({ query: "q", searchIntelligence: { documentation: "off", libraries: [{ name: "vue" }] } }, /documentation other than off/);
  refused({ query: "q", searchIntelligence: { documentation: "off", programmingLanguage: "go" } }, /documentation other than off/);
  refused({ query: "q", searchIntelligence: { publishedAfter: "2026-02-01T00:00:00Z", publishedBefore: "2026-02-01T00:00:00Z" } }, /precede/);
  refused({ query: "q", searchIntelligence: { publishedAfter: "2026-02-01" } }, /UTC instant/);
  refused({ query: "q", searchIntelligence: { publishedAfter: "2026-02-01T00:00:00+02:00" } }, /UTC instant/);
  refused({ query: "q", searchIntelligence: { libraries: [{ name: "a" }, { name: "b" }, { name: "c" }, { name: "d" }, { name: "e" }] } }, /at most 4/);
  refused({ query: "q", searchIntelligence: { libraries: [{ name: "   " }] } }, /non-blank/);
  refused({ query: "q", searchIntelligence: { libraries: [{ version: "1.0" }] } }, /name' is required/);
  refused({ query: "q", searchIntelligence: { libraries: [{ name: "x".repeat(201) }] } }, /at most 200/);
  refused({ query: "q", searchIntelligence: { libraries: [{ name: "vue", version: "v".repeat(81) }] } }, /at most 80/);
  refused({ query: "q", searchIntelligence: { libraries: [{ name: "vue", url: "https://x" }] } }, /Unrecognized key/);
  refused({ query: "q", searchIntelligence: { documentation: "always" } }, /one of auto, required, off/);
  refused({ query: "q", searchIntelligence: { providers: ["exa"] } }, /Unrecognized key/);
  refused({ query: "q", searchIntelligence: { model: "x" } }, /Unrecognized key/);
  refused({ query: "q", searchIntelligence: [] }, /must be a JSON object/);
});

test("the core receives the search's trusted context only through the four allowlisted headers", async () => {
  const seen = [];
  const core = createServer((req, res) => { seen.push(req.headers); res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ success: true, data: { web: [] } })); });
  await new Promise((r) => core.listen(0, "127.0.0.1", r));
  const up = makeUpstream({ core: new URL(`http://127.0.0.1:${core.address().port}`), coreTimeoutMs: 5000 });
  const front = createServer((req, res) => up.forward(res, "/v2/search", { query: "q" }, () => {}, { "x-request-id": "r" }, null, {
    "x-fcpi-search-request-id": "0190f1a0-0000-7000-8000-000000000001", "x-fcpi-search-id": "0190f1a0-0000-4000-8000-000000000002", "x-fcpi-search-owner": "0123456789abcdef",
    "x-fcpi-search-deadline-ms": "1999999999999", "x-fcpi-owner": "spoof", authorization: "Bearer spoof", "x-fcpi-search-bad": "x", "x-fcpi-search-id\r\nx": "y" }));
  await new Promise((r) => front.listen(0, "127.0.0.1", r));
  try {
    const r = await fetch(`http://127.0.0.1:${front.address().port}/`, { headers: { "x-fcpi-search-owner": "ffffffffffffffff" } });
    assert.equal(r.status, 200);
    const h = seen[0];
    assert.equal(h["x-fcpi-search-owner"], "0123456789abcdef");
    assert.equal(h["x-fcpi-search-id"], "0190f1a0-0000-4000-8000-000000000002");
    for (const k of ["x-fcpi-owner", "authorization", "x-fcpi-search-bad"]) assert.equal(h[k], undefined, k);
    assert.deepEqual(Object.keys(h).filter((k) => k.startsWith("x-fcpi")).sort(), ["x-fcpi-search-deadline-ms", "x-fcpi-search-id", "x-fcpi-search-owner", "x-fcpi-search-request-id"]);
  } finally { core.close(); front.close(); }
});
