// Search intelligence through MCP (docs/FIRECRAWL_PI_SEARCH_INTELLIGENCE_SPEC.md §19.1, §19.3): the search tool's input schema
// carries the additive options with their bounds, and its answer keeps fcpi.search; over the tool payload limit, optional search
// detail is shortened first and counted, while coverage, provider outcomes, sources, version qualifications and cache
// provenance stay, and a partial answer never becomes an apparently complete one.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { makeTools } from "../src/tools.mjs";

const MANIFEST = JSON.parse(readFileSync(process.env.FCPI_TEST_MANIFEST ?? new URL("../../../deploy/policies/capabilities.json", import.meta.url), "utf8"));
const tool = () => makeTools(structuredClone(MANIFEST)).find((t) => t.name === "firecrawl_search");
const LIMIT = MANIFEST.mcp.limits.toolTextMaxBytes;

test("the search tool's input schema carries searchIntelligence with its bounds", () => {
  const s = tool().config.inputSchema.properties.searchIntelligence;
  assert.equal(s.type, "object");
  assert.equal(s.additionalProperties, false);
  assert.deepEqual(s.properties.documentation.enum, ["auto", "required", "off"]);
  assert.equal(s.properties.libraries.type, "array");
  assert.equal(s.properties.libraries.maxItems, 4);
  assert.deepEqual(s.properties.libraries.items.required, ["name"]);
  assert.equal(s.properties.libraries.items.properties.name.maxLength, 200);
  assert.equal(s.properties.libraries.items.properties.name.minLength, 1);
  assert.equal(s.properties.libraries.items.properties.version.maxLength, 80);
  assert.match("2026-01-01T00:00:00Z", new RegExp(s.properties.publishedAfter.pattern));
  assert.doesNotMatch("2026-01-01", new RegExp(s.properties.publishedAfter.pattern));
  assert.deepEqual(s.properties.dateMode.enum, ["freshness", "strict_publication"]);
  assert.deepEqual(s.properties.evidence.enum, ["auto", "off"]);
  for (const k of ["providers", "model", "endpoint", "budget"]) assert.equal(s.properties[k], undefined, k);
});

const searchMeta = () => ({ schema: "fcpi.search/v1", logicalSearchId: "0190f1a0-0000-4000-8000-000000000002", outcome: "partial", empty: false,
  coverage: { general: { requested: 5, successful: 4, missing: [{ provider: "brave", status: "skipped", reason: "quota_exhausted" }] } },
  providers: { brave: { status: "skipped", reason: "quota_exhausted", fromCache: false, suboperations: Array.from({ length: 12 }, (_, i) => ({ engine: `e${i}`, status: "answered" })) },
    exa: { status: "success_results", reason: null, fromCache: true } },
  documentation: { activation: { active: true, reason: "explicit_required" }, auxiliaryContext: [{ provider: "context7", libraryId: "/vuejs/docs", requestedVersion: "3.5", observedVersion: null, passageId: "p1", sourceUrl: null, text: "x".repeat(1500) }] },
  ranking: { mode: "hybrid", reason: "complete" }, cache: { mode: "partial_reuse", servedAt: "2026-10-17T00:00:00.000Z", originalRetrievedAt: "2026-10-17T00:00:00.000Z" } });
const row = (i) => ({ url: `https://r.example/${i}`, title: "t", description: "d", markdown: "m".repeat(30000),
  fcpi: { search: { documentId: `d${i}`, canonicalUrl: `https://r.example/${i}`, originalUrls: [`https://r.example/${i}?utm_source=x`],
    observations: [{ provider: "exa", rank: i + 1 }], documentation: { scopes: [{ requestedVersion: "3.5", observedVersion: null, status: "unknown" }] },
    passages: Array.from({ length: 3 }, (_, k) => ({ passageId: `p${i}${k}`, kind: "documentation_text", provider: "context7", text: "y".repeat(600) })),
    scores: { rrf: 0.03, normalized: 0.6, literal: 0.5, semantic: { relevance: 0.9 }, final: 0.7 } } } });

test("a search answer keeps fcpi.search, and a large one loses optional detail before any result, with what was cut counted", () => {
  const small = tool().shape({ status: 200, json: { success: true, data: { web: [row(0)] }, warning: "Partial search coverage: Brave quota exhausted.", fcpi: { search: searchMeta() } }, headers: {} }, {});
  assert.deepEqual(small.payload.fcpi.search, searchMeta());
  assert.equal(small.payload.data.web[0].fcpi.search.passages[0].text.length, 600);
  assert.equal(small.payload.truncated, undefined);

  const web = Array.from({ length: 10 }, (_, i) => row(i));
  const big = tool().shape({ status: 200, json: { success: true, data: { web }, warning: "Partial search coverage: Brave quota exhausted.", fcpi: { search: searchMeta() } }, headers: {} }, {});
  const p = big.payload, s = p.fcpi.search;
  assert.ok(Buffer.byteLength(JSON.stringify(p)) <= LIMIT);
  assert.ok(p.truncated.fcpi.passageText > 0, "passage text was shortened and counted");
  // What must survive does.
  assert.equal(s.outcome, "partial");
  assert.deepEqual(s.coverage.general.missing, [{ provider: "brave", status: "skipped", reason: "quota_exhausted" }]);
  assert.deepEqual([s.providers.brave.status, s.providers.brave.reason, s.providers.exa.fromCache], ["skipped", "quota_exhausted", true]);
  assert.equal(s.cache.mode, "partial_reuse");
  assert.equal(s.documentation.auxiliaryContext[0].passageId, "p1");
  assert.equal(s.documentation.auxiliaryContext[0].requestedVersion, "3.5");
  for (const w of p.data.web) {
    assert.ok(w.fcpi.search.canonicalUrl && w.fcpi.search.originalUrls.length);
    assert.equal(w.fcpi.search.documentation.scopes[0].status, "unknown");
  }
  assert.match(p.warning, /Partial/);
});
