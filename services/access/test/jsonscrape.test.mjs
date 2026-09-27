// The json scrape format (src/jsonscrape.mjs) between a stand-in core and a stand-in extraction service:
// the scope it needs, the typed failures it passes on with their status and Retry-After, an unreachable
// extraction service, the deadline and margin it gives, and the parts of a page no answer came for.
import { test } from "node:test";
import assert from "node:assert/strict";
import { makeJsonScrape } from "../src/jsonscrape.mjs";
import { ExtractorError } from "../src/extractor.mjs";

const M = { limits: { extract: { maxDocumentBytes: 1048576 } } };
const SCHEMA = { type: "object", properties: { price: { type: "number" } } };
const BODY = { url: "https://a.example/p", formats: [{ type: "json", schema: SCHEMA }] };
const page = () => ({ status: 200, json: { success: true, data: { markdown: "Price: 1", metadata: { url: "https://a.example/p", statusCode: 200 } } } });
function rig({ core = page, extract, scopes = ["scrape", "extract"] } = {}) {
  const calls = { core: [], extract: [] };
  const run = makeJsonScrape({ cfg: { coreTimeoutMs: 20000 }, M,
    upstream: { call: async (method, path, opts) => { calls.core.push(opts.body); return core(opts.body); } },
    extractor: { extract: async (body, timeoutMs) => { calls.extract.push({ body, timeoutMs }); return extract(body); } } });
  const sent = {};
  const ctx = { id: "req-1", client: { scopes: new Set(scopes) }, send: (status, body, headers = {}) => Object.assign(sent, { status, body, headers }) };
  return { go: async (body = BODY) => { await run(ctx, body, body.formats.find((f) => typeof f === "object")); return sent; }, calls };
}
const answer = (over = {}) => ({ status: 200, json: { ok: true, model: "m", data: { price: 1 }, sources: { "$": ["https://a.example/p"] }, warnings: [], missingRequired: [],
  units: [{ url: "https://a.example/p", part: 1, ok: true }], usage: { calls: 1 }, ...over } });

test("the json format needs the 'extract' scope, and nothing is scraped without it (review W7)", async () => {
  const r = rig({ scopes: ["read", "scrape"], extract: () => answer() });
  const out = await r.go();
  assert.equal(out.status, 403);
  assert.equal(out.body.code, "INSUFFICIENT_SCOPE");
  assert.equal(r.calls.core.length, 0);
});

test("an extracted page: its json, markdown only when asked, the logical id, and a deadline the gateway waits past (review W14)", async () => {
  const r = rig({ extract: () => answer() });
  const t0 = Date.now();
  const out = await r.go();
  assert.equal(out.status, 200);
  assert.deepEqual(out.body.data.json, { price: 1 });
  assert.equal("markdown" in out.body.data, false);
  assert.deepEqual(r.calls.core[0].formats, ["markdown"]);
  const { body, timeoutMs } = r.calls.extract[0];
  assert.equal(body.logicalId, "scrape:req-1");
  assert.equal(timeoutMs - (Date.parse(body.deadline) - t0) >= 4900, true, "the gateway waits five seconds past the deadline it sends");
});

test("a part of the page no answer came for is named in a warning and the units are returned (review S9)", async () => {
  const r = rig({ extract: () => answer({ units: [{ url: "https://a.example/p", part: 1, ok: true }, { url: "https://a.example/p", part: 2, ok: false, failure: { class: "BUDGET_EXHAUSTED" } }] }) });
  const out = await r.go({ ...BODY, formats: [...BODY.formats, "markdown"] });
  assert.equal(out.status, 200);
  assert.match(out.body.data.warning, /part 2 of the page was not extracted \(BUDGET_EXHAUSTED\)/);
  assert.equal(out.body.fcpi.extraction.units.length, 2);
  assert.equal(out.body.data.markdown, "Price: 1");
});

test("typed failures keep their class, status and Retry-After; an unreachable service is 503 (review W15)", async () => {
  let out = await rig({ extract: () => ({ status: 402, json: { ok: false, failure: { class: "PAID_DISPATCH_DISABLED", detail: "paid dispatch is disabled", retryAfter: null } } }) }).go();
  assert.deepEqual([out.status, out.body.code], [402, "PAID_DISPATCH_DISABLED"]);
  out = await rig({ extract: () => ({ status: 503, json: { ok: false, failure: { class: "PROVIDER_RATE_LIMITED", detail: "rate-limited", retryAfter: 7 } } }) }).go();
  assert.deepEqual([out.status, out.body.code, out.headers["retry-after"]], [503, "PROVIDER_RATE_LIMITED", "7"]);
  out = await rig({ extract: () => { throw new ExtractorError("connect ECONNREFUSED", { code: "ECONNREFUSED", delivered: false }); } }).go();
  assert.deepEqual([out.status, out.body.code, out.headers["retry-after"]], [503, "EXTRACTION_UNAVAILABLE", "10"]);
  // The core's own refusal reaches the caller as it answered.
  out = await rig({ core: () => ({ status: 403, json: { success: false, code: "SSRF_DENIED", error: "refused" } }), extract: () => answer() }).go();
  assert.deepEqual([out.status, out.body.code], [403, "SSRF_DENIED"]);
});

test("the gateway's own failures are never 502, which a client library retries by resubmitting (review W14)", async () => {
  const unreachable = () => { throw Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" }); };
  let out = await rig({ core: unreachable, extract: () => answer() }).go();
  assert.deepEqual([out.status, out.body.code, out.headers["retry-after"]], [503, "UPSTREAM_UNAVAILABLE", "10"]);
  out = await rig({ core: () => { throw Object.assign(new Error("upstream timeout"), { code: "TIMEOUT" }); }, extract: () => answer() }).go();
  assert.deepEqual([out.status, out.body.code], [504, "UPSTREAM_TIMEOUT"]);
  out = await rig({ core: () => ({ status: 200, json: { success: false } }), extract: () => answer() }).go();
  assert.equal(out.status, 500);
  out = await rig({ extract: () => ({ status: 200, json: { ok: false, failure: { class: "EXTRACTION_FAILED", detail: "no answer" } } }) }).go();
  assert.deepEqual([out.status, out.body.code], [500, "EXTRACTION_FAILED"]);
});
