// The model adapter and the extraction engine (src/extract.mjs) against the loopback fixture model:
// refusals before any spend, the one repair, provider failures classified and their reservations
// released or kept, the breaker, a retried logical unit reusing its settled call and never re-sending an
// uncertain one, chunking with provenance, nulls kept and conflicts reported.
import { test } from "node:test";
import assert from "node:assert/strict";
import { makeModelAdapter, makeExtractor, makeGate } from "../src/extract.mjs";
import { fixtures, serve, policyFor, lookupFixture, budgetFor, providersDir, FakeLedger } from "./m5-helpers.mjs";

const SCHEMA = { type: "object", properties: { product: { type: "string" }, price: { type: "number" }, in_stock: { type: "boolean" }, feature: { type: "array", items: { type: "string" } } }, required: ["product"] };
const DOC = (extra = "") => ({ url: "http://m5.fixture.fcpi.test:8080/extract/product.html", markdown: `# Fixture Widget\n\nProduct: Fixture Widget\n\nPrice: 42.50\n\nIn stock: yes\n\nFeature[]: sturdy\n\n${extra}` });

async function rig({ mutate, paidDispatch = false, creds = {}, timeoutMs } = {}) {
  const srv = await serve(fixtures.modelHandler);
  fixtures.resetStats();
  const budget = budgetFor({ modelPort: srv.port, mutate: (b) => { if (timeoutMs) b.extraction.requestTimeoutMs = timeoutMs; mutate?.(b); } });
  const store = new FakeLedger();
  const logs = [];
  const adapter = makeModelAdapter({ store, getBudget: () => budget, paidDispatch, providersDir: providersDir(creds), getPolicy: () => policyFor({ "model.fixture.fcpi.test": srv.port }),
    resolvePublic: async () => { throw new Error("no public resolution in tests"); }, lookupFixture, log: (o) => logs.push(o), gate: makeGate() });
  const extract = makeExtractor({ adapter, getBudget: () => budget, getSelection: () => ({ extractionModel: "fcpi-fixture-model" }), log: (o) => logs.push(o) });
  return { srv, budget, store, adapter, extract, logs, calls: () => fixtures.providerStats().model.calls };
}
const req = (over = {}) => ({ logicalId: `test:${crypto.randomUUID()}`, schema: SCHEMA, documents: [DOC()], ...over });

test("a schema-valid extraction settles from the provider's usage, keeps nulls and names its source", async () => {
  const r = await rig();
  try {
    const out = await r.extract(req({ documents: [{ url: "http://x.fixture.fcpi.test/s", markdown: "Product: Sparse Thing\n\nNo price here." }] }));
    assert.equal(out.ok, true);
    assert.deepEqual(out.data, { product: "Sparse Thing", price: null, in_stock: null, feature: null });
    assert.deepEqual(out.sources["$"], ["http://x.fixture.fcpi.test/s"]);
    assert.deepEqual(out.missingRequired, []);
    assert.equal(r.calls(), 1);
    assert.equal(out.usage.calls, 1);
    assert.ok(out.usage.promptTokens > 0 && out.usage.completionTokens > 0);
    const row = [...r.store.rows.values()][0];
    assert.equal(row.state, "SETTLED");
    // Settled at the rate card from the counts the provider reported, below the byte-bounded reservation.
    assert.equal(row.actual, Math.ceil((out.usage.promptTokens * 400000 + out.usage.completionTokens * 1600000) / 1e6));
    assert.ok(row.actual < row.reserved);
    assert.equal(r.store.used("fixture"), row.actual);
  } finally { await r.srv.close(); }
});

test("an invalid answer gets exactly one repair, in the same logical budget", async () => {
  const r = await rig();
  try {
    const once = await r.extract(req({ prompt: "fcpi-mode=invalid-once" }));
    assert.equal(once.ok, true);
    assert.equal(r.calls(), 2);
    assert.deepEqual([...r.store.rows.values()].map((x) => x.kind), ["extract", "repair"]);
    const always = await r.extract(req({ prompt: "fcpi-mode=invalid-always" }));
    assert.equal(always.ok, false);
    assert.equal(always.failure.class, "EXTRACTION_INVALID_OUTPUT");
    assert.equal(r.calls(), 4, "two calls for the second request: its extraction and one repair, no more");
  } finally { await r.srv.close(); }
});

test("refusals before any spend: unknown model, stale rate card, paid dispatch off, missing credential, zero cap", async () => {
  const r = await rig();
  try {
    const cases = [
      [{ model: "gpt-4o" }, "MODEL_NOT_ALLOWED"],
      [{ model: "fcpi-fixture-stale" }, "RATE_CARD_MISSING"],
      [{ model: "gpt-4.1-mini-2025-04-14" }, "PAID_DISPATCH_DISABLED"],
    ];
    for (const [over, cls] of cases) {
      const out = await r.extract(req(over));
      assert.equal(out.ok, false, cls);
      assert.equal(out.failure.class, cls);
    }
    assert.equal(r.calls(), 0);
    assert.equal(r.store.rows.size, 0, "nothing was reserved");
  } finally { await r.srv.close(); }
  const p = await rig({ paidDispatch: true });
  try {
    const out = await p.extract(req({ model: "gpt-4.1-mini-2025-04-14" }));
    assert.equal(out.failure.class, "BLOCKED_CREDENTIAL");
  } finally { await p.srv.close(); }
  // With paid dispatch on and a credential present, the zero cap still refuses before any request leaves.
  const z = await rig({ paidDispatch: true, creds: { openai_api_key: "sk-test-not-a-real-key-0000000000" } });
  try {
    const out = await z.extract(req({ model: "gpt-4.1-mini-2025-04-14" }));
    assert.equal(out.failure.class, "BUDGET_EXHAUSTED");
    assert.match(out.failure.detail, /llm day budget has 0 of 0/);
    assert.equal(z.store.rows.size, 0);
  } finally { await z.srv.close(); }
});

test("provider refusals are classified: a refused request is released, an answered one settled", async () => {
  for (const [mode, cls, state] of [["http-401", "PROVIDER_AUTH_FAILED", "RELEASED"], ["http-402", "PROVIDER_BILLING", "RELEASED"], ["quota-429", "PROVIDER_BILLING", "RELEASED"],
    ["http-429", "PROVIDER_RATE_LIMITED", "RELEASED"], ["http-400", "PROVIDER_REJECTED", "RELEASED"], ["http-500", "PROVIDER_ERROR", "RELEASED"],
    // A proxy's 502 after delivery leaves the outcome unknown: the reservation stays counted (review W11).
    ["http-502", "PROVIDER_UNCERTAIN", "UNCERTAIN"], ["refuse", "EXTRACTION_REFUSED", "SETTLED"], ["length", "EXTRACTION_OUTPUT_LIMIT", "SETTLED"]]) {
    const r = await rig();
    try {
      const out = await r.extract(req({ prompt: `fcpi-mode=${mode}` }));
      assert.equal(out.failure.class, cls, mode);
      assert.deepEqual(r.store.states(), [state], mode);
      assert.equal(r.calls(), 1, `${mode}: one request, no retry`);
      if (state === "RELEASED") assert.equal(r.store.used("fixture"), 0, `${mode}: nothing counted`);
      if (state === "UNCERTAIN") assert.equal(r.store.used("fixture"), [...r.store.rows.values()][0].reserved, `${mode}: the whole reservation counted`);
    } finally { await r.srv.close(); }
  }
});

test("three provider failures open the breaker: the next call is refused without a request", async () => {
  const r = await rig();
  try {
    for (let i = 0; i < 3; i++) assert.equal((await r.extract(req({ prompt: "fcpi-mode=http-500" }))).failure.class, "PROVIDER_ERROR");
    const before = r.calls();
    const out = await r.extract(req());
    assert.equal(out.failure.class, "PROVIDER_UNAVAILABLE");
    assert.ok(out.failure.retryAfter > 0);
    assert.equal(r.calls(), before);
    assert.equal(r.adapter.breakerState("fixture-model"), "open");
  } finally { await r.srv.close(); }
});

test("a half-open probe that ends without a verdict hands the probe back (review W10)", async () => {
  const r = await rig({ mutate: (b) => { b.breaker.openMs = 1000; } });
  try {
    for (let i = 0; i < 3; i++) await r.extract(req({ prompt: "fcpi-mode=http-500" }));
    assert.equal(r.adapter.breakerState("fixture-model"), "open");
    await new Promise((res) => setTimeout(res, 1100));
    // The probe's reservation fails in the database: no provider verdict is recorded.
    const reserve = r.store.reserveBudget.bind(r.store);
    r.store.reserveBudget = async () => { r.store.reserveBudget = reserve; throw new Error("connection terminated"); };
    await assert.rejects(r.extract(req()), /connection terminated/);
    // The next call is admitted as the probe, succeeds and closes the breaker.
    const out = await r.extract(req());
    assert.equal(out.ok, true);
    assert.equal(r.adapter.breakerState("fixture-model"), "closed");
  } finally { await r.srv.close(); }
});

test("an unanswered call stays reserved and is never sent again; a settled one is reused without a charge", async () => {
  const r = await rig({ timeoutMs: 1500 });
  try {
    const logicalId = `test:${crypto.randomUUID()}`;
    const out = await r.extract(req({ logicalId, prompt: "fcpi-mode=slow" }));
    assert.equal(out.failure.class, "PROVIDER_UNCERTAIN");
    assert.deepEqual(r.store.states(), ["UNCERTAIN"]);
    const used = r.store.used("fixture");
    assert.ok(used > 0, "the whole reservation stays counted");
    const again = await r.extract(req({ logicalId, prompt: "fcpi-mode=slow" }));
    assert.equal(again.failure.class, "EXTRACTION_UNCERTAIN");
    assert.equal(r.calls(), 1, "the uncertain call was not sent a second time");
    assert.equal(r.store.used("fixture"), used);
    const ok = `test:${crypto.randomUUID()}`;
    const first = await r.extract(req({ logicalId: ok }));
    const second = await r.extract(req({ logicalId: ok }));
    assert.deepEqual(second.data, first.data);
    assert.equal(second.usage.reused, 1);
    assert.equal(r.calls(), 2, "the retry reused the settled call");
    // The same logical id with a different request is refused, not answered from another's call.
    assert.equal((await r.extract(req({ logicalId: ok, prompt: "a different task" }))).failure.class, "LOGICAL_ID_CONFLICT");
  } finally { await r.srv.close(); }
});

test("long documents are chunked under the input cap and merged with each part's provenance; conflicts are reported", async () => {
  const r = await rig();
  try {
    const filler = Array.from({ length: 2600 }, (_, i) => `Paragraph ${i} carries no facts at all, only words to fill the page.`).join("\n\n");
    const long = { url: "http://m5.fixture.fcpi.test:8080/extract/long.html", markdown: `Product: Long Widget\n\n${filler}\n\nFeature[]: late-feature\n\nPrice: 99.95` };
    const other = { url: "http://m5.fixture.fcpi.test:8080/extract/other.html", markdown: "Product: Long Widget\n\nPrice: 44\n\nFeature[]: blue" };
    const out = await r.extract(req({ documents: [long, other] }));
    assert.equal(out.ok, true);
    const parts = out.units.filter((u) => u.url === long.url).length;
    assert.ok(parts >= 2, `the long page took ${parts} units`);
    assert.equal(out.data.product, "Long Widget");
    assert.equal(out.data.price, 99.95, "the first non-null value in document order is kept");
    assert.deepEqual(out.data.feature, ["late-feature", "blue"]);
    assert.ok(out.sources["$.feature"].some((s) => s.startsWith(`${long.url}#part=`)));
    assert.ok(out.sources["$.feature"].includes(other.url));
    assert.ok(out.warnings.some((w) => /\$\.price: parts disagree/.test(w)));
    for (const row of r.store.rows.values()) assert.ok(row.usage.promptTokens <= 32000, "every unit's prompt stayed within 32,000 tokens");
  } finally { await r.srv.close(); }
});

test("a required value that no document holds stays null and is named, not invented", async () => {
  const r = await rig();
  try {
    const out = await r.extract(req({ documents: [{ url: "http://x.fixture.fcpi.test/n", markdown: "Price: 3.00\n\nNothing names the product." }] }));
    assert.equal(out.ok, true);
    assert.equal(out.data.product, null);
    assert.deepEqual(out.missingRequired, ["$.product"]);
    assert.ok(out.warnings.some((w) => /\$\.product: required, but no document held a value/.test(w)));
  } finally { await r.srv.close(); }
});

test("schemas beyond the supported subset are refused before any request", async () => {
  const r = await rig();
  try {
    for (const [schema, cls] of [
      [{ type: "object", properties: { a: { $ref: "https://evil.example/schema.json" } } }, "SCHEMA_UNSUPPORTED"],
      [{ type: "object", properties: { a: { type: "string", pattern: "(a+)+$" } } }, "SCHEMA_UNSUPPORTED"],
      [{ type: "array", items: { type: "string" } }, "SCHEMA_INVALID"],
      [{ type: "object", properties: { a: { type: "object", properties: { b: { type: "object", properties: { c: { type: "object", properties: { d: { type: "object", properties: { e: { type: "object", properties: { f: { type: "string" } } } } } } } } } } } } }, "SCHEMA_TOO_DEEP"],
      [{ type: "object", properties: Object.fromEntries(Array.from({ length: 101 }, (_, i) => [`p${i}`, { type: "string" }])) }, "SCHEMA_TOO_LARGE"],
    ]) await assert.rejects(r.extract(req({ schema })), (e) => e.failureClass === cls);
    assert.equal(r.calls(), 0);
  } finally { await r.srv.close(); }
});
