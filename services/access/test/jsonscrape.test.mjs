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
function rig({ core = page, extract, scopes = ["scrape", "extract"], cfg = {} } = {}) {
  const calls = { core: [], extract: [] };
  const run = makeJsonScrape({ cfg: { coreTimeoutMs: 20000, ...cfg }, M,
    upstream: { call: async (method, path, opts) => { calls.core.push(opts.body); return core(opts.body); } },
    extractor: { extract: async (body, timeoutMs, signal) => { calls.extract.push({ body, timeoutMs, signal }); return extract(body); } } });
  const sent = {};
  const ctx = { id: "req-1", client: { scopes: new Set(scopes) }, send: (status, body, headers = {}) => Object.assign(sent, { status, body, headers }) };
  return { go: async (body = BODY) => { await run(ctx, body, body.formats.find((f) => typeof f === "object")); return sent; }, calls };
}
const answer = (over = {}) => ({ status: 200, json: { ok: true, model: "m", data: { price: 1 }, sources: { "$": ["https://a.example/p"] }, warnings: [], missingRequired: [],
  units: [{ url: "https://a.example/p", part: 1, ok: true }], usage: { calls: 1 }, ...over } });

test("a request that names its model gets the extra time for its extraction; every other request keeps the core timeout alone", async () => {
  const named = { ...BODY.formats[0], model: "claude-opus-5-5", reasoningEffort: "high" };
  for (const [label, body, extra] of [["named model", { ...BODY, formats: [named] }, 300000], ["default model", BODY, 0]]) {
    const r = rig({ cfg: { modelExtractExtraMs: 300000 }, extract: () => answer() });
    const t0 = Date.now();
    const out = await r.go(body);
    assert.equal(out.status, 200, label);
    const { body: sent, timeoutMs } = r.calls.extract[0];
    const window = Date.parse(sent.deadline) - t0;
    // The page's own deadline is the core timeout plus ten seconds (20 s here); the named model adds its extra on top.
    assert.ok(window >= 30000 + extra - 2000 && window <= 30000 + extra + 2000, `${label}: extraction window ${window} ms`);
    assert.equal(timeoutMs - window >= 4900, true, `${label}: the gateway still waits five seconds past the deadline it sends`);
  }
  // Without the setting a named model gets what every request gets.
  const none = rig({ extract: () => answer() });
  const t1 = Date.now();
  await none.go({ ...BODY, formats: [named] });
  const w = Date.parse(none.calls.extract[0].body.deadline) - t1;
  assert.ok(w <= 32000, `no setting, no extra: ${w} ms`);
});

test("the gateway aborts a request 15 s past the core timeout, and a request that names its model only after the extra time as well", async (t) => {
  // The abort timer is the outer bound the MCP service and the Agent are sized against (tests/timeout-chain.test.mjs), so its value is
  // pinned here on a mocked clock: the extraction's signal must stay live right up to the bound and be cancelled at it.
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  const named = { ...BODY.formats[0], model: "claude-opus-5-5", reasoningEffort: "high" };
  const settle = () => new Promise((resolve) => setImmediate(resolve));
  for (const [label, body, cfg, abortAt] of [["a request that names its model", { ...BODY, formats: [named] }, { modelExtractExtraMs: 300000 }, 20000 + 15000 + 300000],
    ["a default request", BODY, { modelExtractExtraMs: 300000 }, 20000 + 15000], ["a named model with no extra configured", { ...BODY, formats: [named] }, {}, 20000 + 15000]]) {
    const start = Date.now();
    let release;
    const r = rig({ cfg, extract: () => new Promise((resolve) => { release = () => resolve(answer()); }) });
    const done = r.go(body);
    await settle();
    assert.equal(r.calls.extract.length, 1, `${label}: the extraction started`);
    const { signal } = r.calls.extract[0];
    t.mock.timers.tick(abortAt - 1 - (Date.now() - start));
    await settle();
    assert.equal(signal.aborted, false, `${label}: not aborted a millisecond before ${abortAt} ms`);
    t.mock.timers.tick(1);
    assert.equal(signal.aborted, true, `${label}: aborted at ${abortAt} ms`);
    release();
    const out = await done;
    assert.equal(out.status, 504, label);
    assert.equal(out.body.code, "REQUEST_TIMEOUT", label);
  }
});

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
  assert.equal(Object.hasOwn(body, "model"), false, "ordinary extraction keeps the adapter's configured default model");
  assert.equal(Object.hasOwn(body, "reasoningEffort"), false, "ordinary extraction does not enable reasoning implicitly");
  assert.equal(timeoutMs - (Date.parse(body.deadline) - t0) >= 4900, true, "the gateway waits five seconds past the deadline it sends");
});

test("explicit Opus/high reaches only the budgeted extractor and returns its measured identity, effort and usage", async () => {
  const usage = { calls: 1, promptTokens: 32, completionTokens: 8, costMicroUsd: 17 };
  const r = rig({ extract: () => answer({ model: "claude-opus-5-5", reasoningEffort: "high", usage }) });
  const json = { ...BODY.formats[0], prompt: "Read the price", model: "claude-opus-5-5", reasoningEffort: "high" };
  const out = await r.go({ ...BODY, formats: ["markdown", json] });
  assert.equal(out.status, 200);
  assert.equal(r.calls.core.length, 1);
  assert.equal(r.calls.extract.length, 1);
  assert.deepEqual(r.calls.core[0].formats, ["markdown"], "the upstream native model path receives no JSON format or model options");
  assert.equal(r.calls.core[0].model, undefined);
  assert.equal(r.calls.core[0].reasoningEffort, undefined);
  const request = r.calls.extract[0].body;
  assert.equal(request.model, "claude-opus-5-5");
  assert.equal(request.reasoningEffort, "high");
  assert.equal(request.prompt, "Read the price");
  assert.deepEqual(request.schema, SCHEMA);
  assert.deepEqual(request.documents, [{ url: BODY.url, markdown: "Price: 1" }]);
  assert.equal(out.body.fcpi.extraction.model, "claude-opus-5-5");
  assert.equal(out.body.fcpi.extraction.reasoningEffort, "high");
  assert.deepEqual(out.body.fcpi.extraction.usage, usage);
});

test("JSON extraction metadata reports the adapter's actual model and effort rather than echoing requested values", async () => {
  const r = rig({ extract: () => answer({ model: "reported-model", reasoningEffort: null }) });
  const out = await r.go({ ...BODY, formats: [{ ...BODY.formats[0], model: "claude-opus-5-5", reasoningEffort: "high" }] });
  assert.equal(out.body.fcpi.extraction.model, "reported-model");
  assert.equal(out.body.fcpi.extraction.reasoningEffort, null);
});

test("a denied repair preserves the initial paid call's actual model, effort and settled usage on failure", async () => {
  const usage = { calls: 1, reused: 0, promptTokens: 80, completionTokens: 24, cachedTokens: 0, cacheWriteTokens: 0, costMicroUsd: 31 };
  const units = [{ url: BODY.url, part: 1, ok: false, failure: { class: "BUDGET_EXHAUSTED" } }];
  const r = rig({ extract: () => ({ status: 402, json: { ok: false, model: "claude-opus-5-5", requestedModel: "claude-opus-5-5",
    reasoningEffort: "high", usage, units, failure: { class: "BUDGET_EXHAUSTED", detail: "repair reservation denied" } } }) });
  const out = await r.go({ ...BODY, formats: [{ ...BODY.formats[0], model: "claude-opus-5-5", reasoningEffort: "high" }] });
  assert.equal(out.status, 402);
  assert.equal(out.body.success, false);
  assert.equal(out.body.code, "BUDGET_EXHAUSTED");
  assert.equal(out.body.fcpi.extraction.model, "claude-opus-5-5");
  assert.equal(out.body.fcpi.extraction.reasoningEffort, "high");
  assert.deepEqual(out.body.fcpi.extraction.usage, usage);
  assert.deepEqual(out.body.fcpi.extraction.units, units);
});

test("an acquisition that exhausts the request deadline cannot start fresh extraction", async t => {
  let now = Date.now();
  t.mock.method(Date, "now", () => now);
  const r = rig({ core: () => { now += 30001; return page(); }, extract: () => answer() });
  const out = await r.go();
  assert.equal(out.status, 504);
  assert.equal(out.body.code, "REQUEST_TIMEOUT");
  assert.equal(r.calls.core.length, 1);
  assert.equal(r.calls.extract.length, 0);
});

test("an unsuccessful extraction without a typed failure stays failed and retains unknown metadata", async () => {
  const out = await rig({ extract: () => ({ status: 200, json: { ok: false } }) }).go();
  assert.equal(out.status, 500);
  assert.equal(out.body.success, false);
  assert.equal(out.body.code, "EXTRACTION_FAILED");
  assert.equal(out.body.fcpi.extraction.usage, null);
  assert.equal(out.body.fcpi.extraction.model, null);
  assert.equal(out.body.fcpi.extraction.reasoningEffort, null);
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

test("a model call still running at the deadline is a 504 with no retry offered, because a repeat cannot reuse it and would pay again", async () => {
  const r = rig({ extract: () => ({ status: 504, json: { ok: false, units: [{ url: "https://a.example/p", part: 1, ok: false }], usage: { calls: 1, costMicroUsd: null },
    failure: { class: "EXTRACTION_STILL_RUNNING", detail: "the model call was still running", retryable: true, retryAfter: 30 } } }) });
  const sent = await r.go();
  assert.equal(sent.status, 504);
  assert.equal(sent.body.code, "EXTRACTION_STILL_RUNNING");
  assert.match(sent.body.error, /repeating this request starts a new paid call/);
  assert.equal(sent.headers["retry-after"], undefined, "no retry is invited");
  assert.equal(sent.body.fcpi.extraction.usage.costMicroUsd, null, "the running call's cost is not reported as known");
});
