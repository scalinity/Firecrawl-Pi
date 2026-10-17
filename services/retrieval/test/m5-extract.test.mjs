// The model adapter and the extraction engine (src/extract.mjs) against the loopback fixture model:
// refusals before any spend, the one repair, provider failures classified and their reservations
// released or kept, the breaker, a retried logical unit reusing its settled call and never re-sending an
// uncertain one, chunking with provenance, nulls kept and conflicts reported.
import { test } from "node:test";
import assert from "node:assert/strict";
import { makeModelAdapter, makeExtractor } from "../src/extract.mjs";
import { fixtures, serve, policyFor, lookupFixture, budgetFor, providersDir, FakeLedger } from "./m5-helpers.mjs";

const SCHEMA = { type: "object", properties: { product: { type: "string" }, price: { type: "number" }, in_stock: { type: "boolean" }, feature: { type: "array", items: { type: "string" } } }, required: ["product"] };
const DOC = (extra = "") => ({ url: "http://m5.fixture.fcpi.test:8080/extract/product.html", markdown: `# Fixture Widget\n\nProduct: Fixture Widget\n\nPrice: 42.50\n\nIn stock: yes\n\nFeature[]: sturdy\n\n${extra}` });

async function rig({ mutate, paidDispatch = false, creds = {}, timeoutMs, handler = fixtures.modelHandler } = {}) {
  const srv = await serve(handler);
  fixtures.resetStats();
  const budget = budgetFor({ modelPort: srv.port, mutate: (b) => { if (timeoutMs) b.extraction.requestTimeoutMs = timeoutMs; mutate?.(b); } });
  const store = new FakeLedger();
  const logs = [];
  const adapter = makeModelAdapter({ store, getBudget: () => budget, paidDispatch, providersDir: providersDir(creds), getPolicy: () => policyFor({ "model.fixture.fcpi.test": srv.port }),
    resolvePublic: async () => { throw new Error("no public resolution in tests"); }, lookupFixture, log: (o) => logs.push(o) });
  const extract = makeExtractor({ adapter, getBudget: () => budget, getSelection: () => ({ extractionModel: "fcpi-fixture-model" }), log: (o) => logs.push(o) });
  return { srv, budget, store, adapter, extract, logs, calls: () => fixtures.providerStats().model.calls };
}
const req = (over = {}) => ({ logicalId: `test:${crypto.randomUUID()}`, schema: SCHEMA, documents: [DOC()], ...over });

test("a model lease expiring after its reservation sends nothing and releases its reservation (PRE-M9 C1)", async () => {
  const r = await rig({ paidDispatch: true });
  try {
    r.budget.providers["fixture-model"].paid = true;
    r.budget.paidTotal.caps.day = 1000000;
    r.budget.validationExpiresAt = new Date(Date.now() + 60000).toISOString();
    const reserve = r.store.reserveBudget.bind(r.store);
    r.store.reserveBudget = async (x) => { const out = await reserve(x); r.budget.validationExpiresAt = new Date(0).toISOString(); return out; };
    const out = await r.extract(req());
    assert.equal(out.failure.class, "PAID_DISPATCH_DISABLED");
    assert.equal(r.calls(), 0);
    assert.deepEqual(r.store.states(), ["RELEASED"]);
  } finally { await r.srv.close(); }
});

test("model calls from separate requests run at the same time; none waits for another", async () => {
  let open = 0, most = 0;
  const r = await rig({ mutate: messagesApi(), handler: async (q, s) => {
    for await (const _ of q) { /* drain */ }
    most = Math.max(most, ++open);
    await new Promise((res) => setTimeout(res, 300));
    open--;
    answerWith()(s);
  } });
  try {
    const t0 = Date.now();
    const outs = await Promise.all([1, 2, 3].map(() => r.extract(req())));
    assert.deepEqual(outs.map((o) => o.ok), [true, true, true]);
    assert.equal(most, 3, "all three were in flight together");
    assert.ok(Date.now() - t0 < 800, `three 300 ms calls took ${Date.now() - t0} ms`);
    assert.deepEqual(r.store.states(), ["SETTLED", "SETTLED", "SETTLED"]);
  } finally { await r.srv.close(); }
});

test("malformed HTTP 200 model answers settle conservatively and exhaust only the one repair (PRE-M9 W1)", async () => {
  for (const body of ["null", "{not-json"]) {
    let calls = 0;
    const r = await rig({ handler: async (q, s) => {
      for await (const _ of q) { /* drain the request */ }
      calls++;
      s.writeHead(200, { "content-type": "application/json" }).end(body);
    } });
    try {
      const out = await r.extract(req());
      assert.equal(out.ok, false);
      assert.equal(out.failure.class, "EXTRACTION_INVALID_OUTPUT");
      assert.equal(calls, 2);
      for (const row of r.store.rows.values()) {
        assert.equal(row.state, "SETTLED");
        assert.equal(row.actual, row.reserved);
        assert.equal(row.usage, null);
        assert.equal(row.result.resolvedModel, null);
      }
    } finally { await r.srv.close(); }
  }
});

test("chat-completions request parameters and cache-write usage stay inside the reservation", async () => {
  let sent;
  const r = await rig({ mutate: (b) => {
    b.models["fcpi-fixture-model"].reasoningEffort = "none";
    Object.assign(b.rateCards.find((c) => c.subject === "fcpi-fixture-model"), { inputPerMTok: 100000, cachedInputPerMTok: 10000, cacheWritePerMTok: 125000, outputPerMTok: 500000 });
  }, handler: async (q, s) => {
    const chunks = []; for await (const c of q) chunks.push(c);
    sent = JSON.parse(Buffer.concat(chunks));
    s.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ product: "Fixture Widget", price: null, in_stock: null, feature: null }) }, finish_reason: "stop" }],
      usage: { prompt_tokens: 100, completion_tokens: 20, prompt_tokens_details: { cached_tokens: 10, cache_write_tokens: 40 } } }));
  } });
  try {
    const out = await r.extract(req());
    assert.equal(out.ok, true);
    assert.equal(sent.reasoning_effort, "none");
    assert.deepEqual(sent.prompt_cache_options, { mode: "explicit" });
    assert.equal(sent.service_tier, "default");
    assert.equal(sent.store, false);
    assert.equal(sent.response_format.json_schema.strict, true);
    const row = [...r.store.rows.values()][0];
    assert.deepEqual(row.usage, { promptTokens: 100, completionTokens: 20, cachedTokens: 10, cacheWriteTokens: 40 });
    assert.equal(row.actual, 21);
    assert.ok(row.reserved >= row.actual);
  } finally { await r.srv.close(); }
});

test("xhigh extraction uses the selected policy, omits temperature, and reserves its larger output allowance", async () => {
  let sent;
  const r = await rig({ mutate: b => {
    Object.assign(b.models["fcpi-fixture-model"], { reasoningEffort: "xhigh", maxOutputTokens: 16000, requestTimeoutMs: 90000 });
  }, handler: async (q, s) => {
    const chunks = []; for await (const chunk of q) chunks.push(chunk);
    sent = JSON.parse(Buffer.concat(chunks));
    s.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ model: "fcpi-fixture-model", choices: [{ message: { content: JSON.stringify({ product: "Fixture Widget", price: null, in_stock: null, feature: null }) }, finish_reason: "stop" }],
      usage: { prompt_tokens: 100, completion_tokens: 20 } }));
  } });
  try {
    const out = await r.extract(req({ reasoningEffort: "xhigh" }));
    assert.equal(out.ok, true);
    assert.equal(out.reasoningEffort, "xhigh");
    assert.equal(sent.reasoning_effort, "xhigh");
    assert.equal(sent.max_completion_tokens, 16000);
    assert.equal(Object.hasOwn(sent, "temperature"), false);
    assert.deepEqual(sent.prompt_cache_options, { mode: "explicit" });
    assert.equal(sent.service_tier, "default");
    assert.equal(sent.store, false);
    const row = [...r.store.rows.values()][0];
    assert.ok(row.reserved >= 16000 * 1600000 / 1e6);
    assert.ok(row.actual < row.reserved);
    assert.equal(out.usage.completionTokens, 20);
    const event = r.logs.find(event => event.event === "model_call" && event.outcome === "answered");
    assert.equal(event.reasoning_effort, "xhigh");
    assert.equal(event.output_cap_tokens, 16000);
  } finally { await r.srv.close(); }
});

test("a mismatched requested reasoning effort is refused before any provider request or reservation", async () => {
  const r = await rig({ mutate: b => { b.models["fcpi-fixture-model"].reasoningEffort = "none"; } });
  try {
    await assert.rejects(r.extract(req({ reasoningEffort: "xhigh" })), error => error.failureClass === "INVALID_REQUEST");
    assert.equal(r.calls(), 0);
    assert.equal(r.store.rows.size, 0);
  } finally { await r.srv.close(); }
});

test("a provider returning another model is accounted but never accepted or repaired", async () => {
  let calls = 0;
  const r = await rig({ mutate: b => { b.extraction.maxInputTokens = 1000; }, handler: async (q, s) => {
    for await (const _ of q) { /* drain */ }
    calls++;
    s.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ model: "a-different-model", choices: [{ message: { content: JSON.stringify({ product: "Fixture Widget", price: null, in_stock: null, feature: null }) }, finish_reason: "stop" }],
      usage: { prompt_tokens: 100, completion_tokens: 20 } }));
  } });
  try {
    const out = await r.extract(req({ documents: [DOC("Extra content.\n\n".repeat(500))] }));
    assert.equal(out.ok, false);
    assert.equal(out.failure.class, "MODEL_MISMATCH");
    assert.equal(out.model, "a-different-model");
    assert.equal(out.requestedModel, "fcpi-fixture-model");
    assert.equal(out.usage.calls, 1);
    assert.ok(out.units.length > 1);
    assert.ok(out.units.every(unit => unit.failure.class === "MODEL_MISMATCH"));
    assert.equal(calls, 1);
    assert.deepEqual(r.store.states(), ["SETTLED"]);
  } finally { await r.srv.close(); }
});

test("a reasoning-model extraction cannot claim its requested identity when the provider omits the model", async () => {
  let calls = 0;
  const r = await rig({ mutate: b => {
    b.models["fcpi-fixture-reasoner"] = { ...b.models["fcpi-fixture-model"], reasoningEffort: "xhigh" };
    b.rateCards.push({ ...b.rateCards.find(c => c.subject === "fcpi-fixture-model"), id: "fixture/fcpi-fixture-reasoner@2026-09-26", subject: "fcpi-fixture-reasoner" });
  }, handler: async (q, s) => {
    for await (const _ of q) { /* drain */ }
    calls++;
    s.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ product: "Fixture Widget", price: null, in_stock: null, feature: null }) }, finish_reason: "stop" }],
      usage: { prompt_tokens: 100, completion_tokens: 20 } }));
  } });
  try {
    const out = await r.extract(req({ model: "fcpi-fixture-reasoner", reasoningEffort: "xhigh" }));
    assert.equal(out.ok, false);
    assert.equal(out.failure.class, "MODEL_IDENTITY_UNVERIFIED");
    assert.equal(out.model, null);
    assert.equal(out.requestedModel, "fcpi-fixture-reasoner");
    assert.equal(calls, 1);
  } finally { await r.srv.close(); }
});

test("missing provider token usage remains unknown while conservative settlement stays visible", async () => {
  const r = await rig();
  try {
    const out = await r.extract(req({ prompt: "fcpi-mode=no-usage" }));
    assert.equal(out.ok, true);
    assert.equal(out.usage.promptTokens, null);
    assert.equal(out.usage.completionTokens, null);
    assert.equal(out.usage.cachedTokens, null);
    assert.equal(out.usage.cacheWriteTokens, null);
    assert.equal(out.usage.calls, 1);
    assert.ok(out.usage.costMicroUsd > 0);
    assert.match(out.warnings.join(" "), /usage was not reported/);
    const row = [...r.store.rows.values()][0];
    assert.equal(out.usage.costMicroUsd, row.reserved);
  } finally { await r.srv.close(); }
});

test("disconnect after a settled invalid answer sends no repair and retains its accounting", async () => {
  const r = await rig();
  const controller = new AbortController();
  const call = r.adapter.call.bind(r.adapter);
  r.adapter.call = async args => { const answer = await call(args); controller.abort(); return answer; };
  try {
    const out = await r.extract(req({ prompt: "fcpi-mode=invalid-once" }), controller.signal);
    assert.equal(out.ok, false);
    assert.equal(out.failure.class, "CANCELLED");
    assert.equal(r.calls(), 1);
    assert.equal(out.usage.calls, 1);
    assert.deepEqual(r.store.states(), ["SETTLED"]);
  } finally { await r.srv.close(); }
});

test("disconnect after a settled first chunk sends no later model calls", async () => {
  const r = await rig({ mutate: b => { b.extraction.maxInputTokens = 1000; } });
  const controller = new AbortController();
  const call = r.adapter.call.bind(r.adapter);
  r.adapter.call = async args => { const answer = await call(args); controller.abort(); return answer; };
  try {
    const out = await r.extract(req({ documents: [DOC("Extra content.\n\n".repeat(500))] }), controller.signal);
    assert.ok(out.units.length > 1);
    assert.equal(out.units[0].ok, true);
    assert.ok(out.units.slice(1).every(unit => unit.failure.class === "CANCELLED"));
    assert.equal(r.calls(), 1);
    assert.equal(out.usage.calls, 1);
    assert.deepEqual(r.store.states(), ["SETTLED"]);
  } finally { await r.srv.close(); }
});

test("a repair denied before dispatch preserves the already-settled first call's usage", async () => {
  const r = await rig();
  const call = r.adapter.call.bind(r.adapter);
  r.adapter.call = async args => {
    const answer = await call(args);
    r.budget.categories.fixture.caps.day = r.store.used("fixture");
    return answer;
  };
  try {
    const out = await r.extract(req({ prompt: "fcpi-mode=invalid-once" }));
    assert.equal(out.ok, false);
    assert.equal(out.failure.class, "BUDGET_EXHAUSTED");
    assert.equal(r.calls(), 1);
    assert.equal(out.usage.calls, 1);
    assert.ok(out.usage.promptTokens > 0);
    assert.equal(out.usage.costMicroUsd, [...r.store.rows.values()][0].actual);
  } finally { await r.srv.close(); }
});

test("settled model calls cannot be reused after reasoning or output policy changes", async () => {
  for (const update of [model => { model.reasoningEffort = "xhigh"; }, model => { model.maxOutputTokens = 3000; }]) {
    const r = await rig({ mutate: b => { b.models["fcpi-fixture-model"].reasoningEffort = "none"; } });
    try {
      const input = req();
      assert.equal((await r.extract(input)).ok, true);
      update(r.budget.models["fcpi-fixture-model"]);
      const repeated = await r.extract(input);
      assert.equal(repeated.ok, false);
      assert.equal(repeated.failure.class, "LOGICAL_ID_CONFLICT");
      assert.equal(r.calls(), 1);
    } finally { await r.srv.close(); }
  }
});

test("a model-specific request timeout extends only that model's provider wait", async () => {
  const r = await rig({ timeoutMs: 1000, mutate: b => {
    Object.assign(b.models["fcpi-fixture-model"], { reasoningEffort: "xhigh", requestTimeoutMs: 3000 });
  }, handler: async (q, s) => {
    for await (const _ of q) { /* drain */ }
    await new Promise(resolve => setTimeout(resolve, 1200));
    s.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ model: "fcpi-fixture-model", choices: [{ message: { content: JSON.stringify({ product: "Fixture Widget", price: null, in_stock: null, feature: null }) }, finish_reason: "stop" }],
      usage: { prompt_tokens: 100, completion_tokens: 20 } }));
  } });
  try {
    assert.equal((await r.extract(req())).ok, true);
    assert.equal(r.budget.extraction.requestTimeoutMs, 1000);
  } finally { await r.srv.close(); }
});

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
      [{ model: "claude-haiku-5-5" }, "PAID_DISPATCH_DISABLED"],
      [{ model: "claude-opus-5-5", reasoningEffort: "high" }, "PAID_DISPATCH_DISABLED"],
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
    const out = await p.extract(req({ model: "claude-haiku-5-5" }));
    assert.equal(out.failure.class, "BLOCKED_CREDENTIAL");
  } finally { await p.srv.close(); }
  // Each Anthropic key unlocks only its own model: the Agent's key cannot run extraction, nor the other way round.
  for (const [model, creds] of [["claude-haiku-5-5", { agent_anthropic_api_key: "sk-ant-test-not-a-real-key-000000" }], ["claude-opus-5-5", { anthropic_api_key: "sk-ant-test-not-a-real-key-000000" }]]) {
    const w = await rig({ paidDispatch: true, creds });
    try {
      const out = await w.extract(req({ model, ...(model === "claude-opus-5-5" ? { reasoningEffort: "high" } : {}) }));
      assert.equal(out.failure.class, "BLOCKED_CREDENTIAL", model);
      assert.equal(w.store.rows.size, 0);
    } finally { await w.srv.close(); }
  }
  // With paid dispatch on and a credential present, the zero cap still refuses before any request leaves.
  const z = await rig({ paidDispatch: true, creds: { anthropic_api_key: "sk-ant-test-not-a-real-key-000000" },
    mutate: (b) => { b.categories.llm.caps = { day: 0, month: 0 }; } });
  try {
    const out = await z.extract(req({ model: "claude-haiku-5-5" }));
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

test("a logical unit retried under a different input cap is refused rather than merged from other chunks (review S11)", async () => {
  const r = await rig();
  try {
    const q = req();
    assert.equal((await r.extract(q)).ok, true);
    const smaller = budgetFor({ modelPort: r.srv.port, mutate: (b) => { b.extraction.maxInputTokens -= 1000; } });
    const extract2 = makeExtractor({ adapter: r.adapter, getBudget: () => smaller, getSelection: () => ({ extractionModel: "fcpi-fixture-model" }), log: () => {} });
    const out = await extract2(q);
    assert.equal(out.failure.class, "LOGICAL_ID_CONFLICT");
    assert.equal(r.calls(), 1);
  } finally { await r.srv.close(); }
});

test("no request is started with less than a second of the deadline left (review W14)", async () => {
  const r = await rig();
  try {
    const out = await r.extract(req({ deadline: new Date(Date.now() + 500).toISOString() }));
    assert.equal(out.failure.class, "DEADLINE_EXCEEDED");
    assert.equal(r.calls(), 0);
    assert.equal(r.store.rows.size, 0, "nothing reserved");
  } finally { await r.srv.close(); }
});

test("a model that reasons is not started with less than a minute left (or its whole timeout, when shorter); one that does not reason is", async () => {
  // A reasoning call that the deadline cuts off keeps its whole reservation as uncertain and is never resent, so the floor is
  // the cost of starting one that cannot finish. The Messages-API fixture here answers at once; only the floor decides.
  const deadlineIn = (ms) => new Date(Date.now() + ms).toISOString();
  for (const { timeout, tooShort, enough, floor } of [{ timeout: 90000, tooShort: 20000, enough: 65000, floor: /less than 60 s/ }, { timeout: 30000, tooShort: 20000, enough: 40000, floor: /less than 30 s/ }]) {
    const seen = {};
    const r = await rig({ mutate: (b) => { messagesApi({ "fcpi-fixture-model": "high" })(b); Object.assign(b.models["fcpi-fixture-model"], { maxOutputTokens: 16000, requestTimeoutMs: timeout }); },
      handler: recording(answerWith(), seen) });
    try {
      const cut = await r.extract(req({ reasoningEffort: "high", deadline: deadlineIn(tooShort) }));
      assert.equal(cut.failure.class, "DEADLINE_EXCEEDED", `${timeout} ms model, ${tooShort} ms left`);
      assert.match(cut.failure.detail, floor);
      assert.equal(seen.calls ?? 0, 0, "nothing was sent");
      assert.equal(r.store.rows.size, 0, "nothing was reserved");
      const ok = await r.extract(req({ reasoningEffort: "high", deadline: deadlineIn(enough) }));
      assert.equal(ok.ok, true, `${timeout} ms model, ${enough} ms left`);
      assert.equal(seen.calls, 1);
    } finally { await r.srv.close(); }
  }
  const seen = {};
  const quick = await rig({ mutate: messagesApi(), handler: recording(answerWith(), seen) });
  try {
    const ok = await quick.extract(req({ deadline: deadlineIn(5000) }));
    assert.equal(ok.ok, true, "a model with no reasoning effort needs only a second");
    assert.equal(seen.calls, 1);
  } finally { await quick.srv.close(); }
});

test("a unit retried while its call is still in flight is EXTRACTION_IN_FLIGHT, retryable, then reuses the answer (review W13)", async () => {
  const r = await rig();
  try {
    const q = req({ prompt: "fcpi-mode=delay" });
    const first = r.extract(q);
    await new Promise((res) => setTimeout(res, 500));
    const second = await r.extract(q);
    assert.equal(second.failure.class, "EXTRACTION_IN_FLIGHT");
    assert.equal(second.failure.retryable, true);
    assert.equal((await first).ok, true);
    const third = await r.extract(q);
    assert.equal(third.ok, true);
    assert.equal(third.usage.reused, 1);
    assert.equal(r.calls(), 1);
  } finally { await r.srv.close(); }
});

test("a reuse-only extraction returns stored answers and sends nothing new (review S12)", async () => {
  const r = await rig();
  try {
    const q = req();
    assert.equal((await r.extract(q)).ok, true);
    const again = await r.extract({ ...q, reuseOnly: true });
    assert.equal(again.ok, true);
    assert.equal(again.usage.reused, 1);
    const fresh = await r.extract(req({ reuseOnly: true }));
    assert.equal(fresh.failure.class, "DEADLINE_EXCEEDED");
    assert.equal(r.calls(), 1, "only the first extraction reached the provider");
    assert.equal([...r.store.rows.values()].at(-1).state, "RELEASED");
  } finally { await r.srv.close(); }
});

test("a rate limit stops the extraction's later units: the provider is asked once (review S8)", async () => {
  const r = await rig();
  try {
    const out = await r.extract(req({ prompt: "fcpi-mode=http-429", documents: [DOC(), { ...DOC(), url: "http://m5.fixture.fcpi.test:8080/extract/second.html" }] }));
    assert.equal(r.calls(), 1);
    assert.deepEqual(out.units.map((u) => u.failure?.class), ["PROVIDER_RATE_LIMITED", "PROVIDER_RATE_LIMITED"]);
    assert.equal(out.failure.retryAfter, 7);
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
    assert.equal(out.usage.calls, null);
    assert.equal(out.usage.costMicroUsd, null);
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

// ---- the Messages API (src/anthropic.mjs) through the same adapter ---------------------------------------
// The fixture model switched to the Messages API's shape: an origin base URL, no chat-only settings, and an
// effort stated on every model that uses it.
const messagesApi = (efforts = {}) => (b) => {
  const p = b.providers["fixture-model"];
  p.api = "anthropic-messages"; p.baseUrl = p.baseUrl.replace(/\/v1$/, ""); delete p.maxTokensParam; delete p.store;
  for (const name of ["fcpi-fixture-model", "fcpi-fixture-race", "fcpi-fixture-stale"]) b.models[name].reasoningEffort = efforts[name] ?? "none";
};
const ANSWER = { product: "Fixture Widget", price: null, in_stock: null, feature: null };
const messagesBody = (over = {}) => JSON.stringify({ id: "msg_fixture", type: "message", role: "assistant", model: "fcpi-fixture-model", stop_reason: "end_turn",
  content: [{ type: "thinking", thinking: "", signature: "sig" }, { type: "text", text: JSON.stringify(ANSWER) }],
  usage: { input_tokens: 60, cache_creation_input_tokens: 30, cache_read_input_tokens: 10, output_tokens: 20 }, ...over });
const JSON_HEADERS = { "content-type": "application/json" };
const answerWith = (over) => (s) => s.writeHead(200, JSON_HEADERS).end(messagesBody(over));
// Records what the adapter sent, then lets the test reply.
const recording = (reply, seen = {}) => async (q, s) => {
  const chunks = []; for await (const c of q) chunks.push(c);
  Object.assign(seen, { url: q.url, headers: q.headers, sent: JSON.parse(Buffer.concat(chunks)), calls: (seen.calls ?? 0) + 1 });
  reply(s);
};

test("Messages API request: path, key header, top-level system, thinking off, no sampling, cached usage inside the reservation", async () => {
  const seen = {};
  const r = await rig({ paidDispatch: true, creds: { anthropic_api_key: "sk-ant-test-not-a-real-key-000000" },
    mutate: (b) => { messagesApi()(b); Object.assign(b.rateCards.find((c) => c.subject === "fcpi-fixture-model"), { inputPerMTok: 100000, cachedInputPerMTok: 10000, cacheWritePerMTok: 125000, outputPerMTok: 500000 }); },
    handler: recording((s) => s.writeHead(200, { ...JSON_HEADERS, "request-id": "req_fixture_answered" }).end(messagesBody()), seen) });
  try {
    Object.assign(r.budget.providers["fixture-model"], { paid: true, credential: "anthropic_api_key" });
    r.budget.paidTotal.caps.day = 1000000;
    const out = await r.extract(req());
    assert.equal(out.ok, true);
    assert.equal(out.model, "fcpi-fixture-model");
    assert.equal(seen.url, "/v1/messages");
    assert.equal(seen.headers["x-api-key"], "sk-ant-test-not-a-real-key-000000");
    assert.equal(seen.headers.authorization, undefined, "the chat API\x27s bearer header is not sent");
    assert.equal(seen.headers["anthropic-version"], "2023-06-01");
    const { sent } = seen;
    assert.equal(sent.max_tokens, 4000);
    assert.match(sent.system, /^You extract structured data/);
    assert.deepEqual(sent.messages.map((m) => m.role), ["user"]);
    assert.deepEqual(sent.thinking, { type: "disabled" });
    for (const key of ["temperature", "top_p", "top_k", "n", "store", "response_format", "reasoning_effort"]) assert.equal(Object.hasOwn(sent, key), false, key);
    assert.deepEqual(Object.keys(sent.output_config), ["format"]);
    assert.equal(sent.output_config.format.type, "json_schema");
    assert.equal(sent.output_config.format.schema.additionalProperties, false);
    const row = [...r.store.rows.values()][0];
    assert.deepEqual(row.usage, { promptTokens: 100, completionTokens: 20, cachedTokens: 10, cacheWriteTokens: 30 }, "input_tokens excludes the cached tokens that the adapter\x27s prompt count includes");
    assert.equal(row.actual, 20);
    assert.ok(row.reserved >= row.actual);
    assert.equal(r.logs.find((l) => l.event === "model_call" && l.outcome === "answered").grammar, "schema");
    assert.equal(r.logs.find((l) => l.event === "model_call" && l.outcome === "answered").provider_request_id, "req_fixture_answered", "the provider's request id is logged to match a charge in its console");
  } finally { await r.srv.close(); }
});

test("Messages API: a schema with enums is sent so the grammar compiler can accept it (no node pairs a type array with an enum)", async () => {
  const seen = {};
  const schema = { type: "object", properties: { action: { type: "string", enum: ["visit", "search", "finish"] }, level: { type: "integer", enum: [1, 2] }, note: { type: "string" } }, required: ["action"] };
  const r = await rig({ mutate: messagesApi(), handler: recording(answerWith({ content: [{ type: "text", text: JSON.stringify({ action: "visit", level: null, note: null }) }] }), seen) });
  try {
    const out = await r.extract(req({ schema }));
    assert.equal(out.ok, true);
    assert.equal(out.data.action, "visit", "the answer is validated against the schema as the engine holds it");
    const walk = (s) => (!s || typeof s !== "object") ? [] : [s, ...Object.values(s.properties ?? {}).flatMap(walk), ...walk(s.items), ...(s.anyOf ?? []).flatMap(walk)];
    const nodes = walk(seen.sent.output_config.format.schema);
    assert.ok(nodes.some((n) => Array.isArray(n.enum)), "the enums are still in the grammar");
    assert.equal(nodes.filter((n) => Array.isArray(n.type) && Array.isArray(n.enum)).length, 0);
  } finally { await r.srv.close(); }
});

test("Messages API at high effort sends the effort and the model\x27s own output cap, and never a thinking switch", async () => {
  const seen = {};
  const r = await rig({ mutate: (b) => { messagesApi({ "fcpi-fixture-model": "high" })(b); Object.assign(b.models["fcpi-fixture-model"], { maxOutputTokens: 16000, requestTimeoutMs: 90000 }); },
    handler: recording(answerWith(), seen) });
  try {
    const out = await r.extract(req({ reasoningEffort: "high" }));
    assert.equal(out.ok, true);
    assert.equal(out.reasoningEffort, "high");
    assert.equal(seen.sent.output_config.effort, "high");
    assert.equal(seen.sent.output_config.format.type, "json_schema");
    assert.equal(Object.hasOwn(seen.sent, "thinking"), false, "a model that always thinks is never sent a thinking switch");
    assert.equal(seen.sent.max_tokens, 16000);
    assert.ok([...r.store.rows.values()][0].reserved >= 16000 * 1600000 / 1e6);
  } finally { await r.srv.close(); }
});

test("with no shared daily cap a paid call is still bounded by its own category; with one it is also bounded by that", async () => {
  // A reservation of at least two million micro-USD: 20,000 output tokens at $100 per million.
  const dear = (b) => { Object.assign(b.models["fcpi-fixture-model"], { reasoningEffort: "xhigh", maxOutputTokens: 20000, requestTimeoutMs: 300000 });
    Object.assign(b.rateCards.find((c) => c.subject === "fcpi-fixture-model"), { outputPerMTok: 100000000 }); };
  const free = await rig({ paidDispatch: true, mutate: dear });
  try {
    free.budget.providers["fixture-model"].paid = true;
    const out = await free.extract(req({ reasoningEffort: "xhigh" }));
    assert.equal(out.ok, true, "the deployed policy has no shared cap");
    const row = [...free.store.rows.values()][0];
    assert.ok(row.reserved >= 2000000, `reserved ${row.reserved}`);
    assert.equal(row.paid_total, false, "no shared row is kept when there is no shared cap");
  } finally { await free.srv.close(); }
  // The same call against a category cap below its reservation: refused by the category, with no shared cap involved.
  const tight = await rig({ paidDispatch: true, mutate: (b) => { dear(b); b.categories.fixture.caps.day = 1000000; } });
  try {
    tight.budget.providers["fixture-model"].paid = true;
    assert.equal(tight.budget.paidTotal.caps.day, undefined, "precondition: no shared cap");
    const out = await tight.extract(req({ reasoningEffort: "xhigh" }));
    assert.equal(out.ok, false);
    assert.equal(out.failure.class, "BUDGET_EXHAUSTED");
    assert.match(out.failure.detail, /fixture day budget/);
    assert.equal(tight.store.rows.size, 0, "nothing was reserved");
  } finally { await tight.srv.close(); }
  const capped = await rig({ paidDispatch: true, mutate: dear });
  try {
    capped.budget.providers["fixture-model"].paid = true;
    capped.budget.paidTotal.caps.day = 1000000;
    const out = await capped.extract(req({ reasoningEffort: "xhigh" }));
    assert.equal(out.ok, false);
    assert.equal(out.failure.class, "BUDGET_EXHAUSTED");
    assert.match(out.failure.detail, /_paid_total day budget/);
    assert.equal(capped.store.rows.size, 0, "nothing was reserved");
  } finally { await capped.srv.close(); }
});

test("Messages API: a reasoning model must report its identity, and a different identity is refused", async () => {
  for (const [over, cls] of [[{ model: undefined }, "MODEL_IDENTITY_UNVERIFIED"], [{ model: "claude-something-else" }, "MODEL_MISMATCH"]]) {
    const r = await rig({ mutate: messagesApi({ "fcpi-fixture-model": "high" }), handler: recording(answerWith(over)) });
    try {
      const out = await r.extract(req({ reasoningEffort: "high" }));
      assert.equal(out.ok, false);
      assert.equal(out.failure.class, cls);
      assert.deepEqual(r.store.states(), ["SETTLED"], "the answered call is billed and kept");
    } finally { await r.srv.close(); }
  }
});

test("Messages API: even a model that does not reason must report which model answered; the chat API's fixture need not", async () => {
  // Effort none is the production default model's setting: its identity is checked because the API provides it.
  const r = await rig({ mutate: messagesApi(), handler: recording(answerWith({ model: undefined })) });
  try {
    const out = await r.extract(req());
    assert.equal(out.ok, false);
    assert.equal(out.failure.class, "MODEL_IDENTITY_UNVERIFIED");
    assert.deepEqual(r.store.states(), ["SETTLED"], "the answered call is billed and kept");
  } finally { await r.srv.close(); }
  // The same answer on the chat API at effort none is accepted, as before.
  const chat = await rig({ handler: async (q, s) => {
    for await (const _ of q) { /* drain */ }
    s.writeHead(200, JSON_HEADERS).end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(ANSWER) }, finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: 5 } }));
  } });
  try { assert.equal((await chat.extract(req())).ok, true); } finally { await chat.srv.close(); }
});

test("Messages API: usage that reports only some counts is unusable, and the call settles at its whole reservation", async () => {
  for (const usage of [{ output_tokens: 20 }, { input_tokens: 60 }, { input_tokens: "60", output_tokens: 20 }, { input_tokens: 60, output_tokens: -1 }]) {
    const r = await rig({ mutate: messagesApi(), handler: recording(answerWith({ usage })) });
    try {
      const out = await r.extract(req());
      assert.equal(out.ok, true, JSON.stringify(usage));
      const row = [...r.store.rows.values()][0];
      assert.equal(row.usage, null, JSON.stringify(usage));
      assert.equal(row.actual, row.reserved, "never less than the call could have cost");
      assert.equal(out.usage.promptTokens, null);
      assert.match(out.warnings.join(" "), /usage was not reported/);
    } finally { await r.srv.close(); }
  }
});

test("Messages API: a refusal and a token-cap stop are settled calls with their own failure class", async () => {
  for (const [over, cls, detail] of [
    [{ stop_reason: "refusal", stop_details: { type: "refusal", category: "cyber", explanation: null }, content: [] }, "EXTRACTION_REFUSED", /cyber/],
    [{ stop_reason: "max_tokens", content: [{ type: "text", text: "{\"product\":" }] }, "EXTRACTION_OUTPUT_LIMIT", /4000-token output cap/],
  ]) {
    const seen = {};
    const r = await rig({ mutate: messagesApi(), handler: recording(answerWith(over), seen) });
    try {
      const out = await r.extract(req());
      assert.equal(out.failure.class, cls);
      assert.match(out.failure.detail, detail);
      assert.equal(seen.calls, 1, "neither is repaired");
      assert.deepEqual(r.store.states(), ["SETTLED"]);
    } finally { await r.srv.close(); }
  }
});

test("Messages API failures are classified: a refused request is released, a proxy 502 keeps its reservation", async () => {
  const error = (type, message) => ({ type: "error", error: { type, message } });
  for (const [status, body, cls, state, retryable] of [
    [401, error("authentication_error", "invalid x-api-key"), "PROVIDER_AUTH_FAILED", "RELEASED", false],
    [402, error("billing_error", "Payment required"), "PROVIDER_BILLING", "RELEASED", false],
    [400, error("invalid_request_error", "Your credit balance is too low to access the Anthropic API."), "PROVIDER_BILLING", "RELEASED", false],
    // The error type alone marks a billing refusal: no 402 status and no words about a balance.
    [400, error("billing_error", "Account problem"), "PROVIDER_BILLING", "RELEASED", false],
    [429, error("rate_limit_error", "Number of request tokens has exceeded your rate limit"), "PROVIDER_RATE_LIMITED", "RELEASED", true],
    [529, error("overloaded_error", "Overloaded"), "PROVIDER_ERROR", "RELEASED", true],
    [400, error("invalid_request_error", "Schemas contains too many parameters with union types (17 parameters with type arrays or anyOf)."), "PROVIDER_REJECTED", "RELEASED", false],
    [502, error("api_error", "Bad gateway"), "PROVIDER_UNCERTAIN", "UNCERTAIN", false],
  ]) {
    const r = await rig({ mutate: messagesApi(), handler: recording((s) => s.writeHead(status, { ...JSON_HEADERS, "request-id": `req_fixture_${status}` }).end(JSON.stringify(body))) });
    try {
      const out = await r.extract(req());
      assert.equal(out.failure.class, cls, `${status} ${body.error.type}`);
      assert.equal(r.logs.find((l) => l.event === "model_call" && l.outcome === `http_${status}`)?.provider_request_id, `req_fixture_${status}`, "refused and uncertain calls carry the id too");
      assert.equal(out.failure.retryable, retryable, `${status} ${body.error.type}`);
      assert.deepEqual(r.store.states(), [state], `${status} ${body.error.type}`);
      if (cls === "PROVIDER_REJECTED") assert.match(out.failure.detail, /union types/, "the provider\x27s reason for refusing the request is kept");
    } finally { await r.srv.close(); }
  }
});

test("a schema over the grammar limit goes to the model as prompt text, and a fenced answer is still checked and accepted", async () => {
  const names = ["product", ...Array.from({ length: 19 }, (_, i) => `field_${i}`)];
  const wide = { type: "object", properties: Object.fromEntries(names.map((k) => [k, { type: "string" }])), required: ["product"] };
  const answer = Object.fromEntries(names.map((k) => [k, k === "product" ? "Fixture Widget" : null]));
  const seen = {};
  const r = await rig({ mutate: messagesApi(), handler: recording(answerWith({ content: [{ type: "text", text: `\`\`\`json\n${JSON.stringify(answer)}\n\`\`\`` }] }), seen) });
  try {
    const out = await r.extract(req({ schema: wide }));
    assert.equal(out.ok, true);
    assert.equal(out.data.product, "Fixture Widget");
    assert.equal(Object.hasOwn(seen.sent, "output_config"), false, "no grammar, and no effort to send at effort none");
    assert.match(seen.sent.system, /matches this JSON Schema/);
    assert.ok(seen.sent.system.includes("\"field_18\""), "the whole schema is in the prompt");
    assert.equal(seen.calls, 1);
    assert.equal(r.logs.find((l) => l.event === "model_call" && l.outcome === "answered").grammar, "none");
  } finally { await r.srv.close(); }
  // Unconstrained is not unchecked: an answer that breaks the schema is repaired once, then refused.
  const bad = await rig({ mutate: messagesApi(), handler: recording(answerWith({ content: [{ type: "text", text: "{\"product\": 7}" }] })) });
  try {
    const out = await bad.extract(req({ schema: wide }));
    assert.equal(out.failure.class, "EXTRACTION_INVALID_OUTPUT");
    assert.equal(bad.store.states().length, 2, "the one repair, no more");
  } finally { await bad.srv.close(); }
});

test("Messages API: a repair after an answer with no text shows the model a placeholder, because the API refuses an empty assistant turn", async () => {
  for (const first of [{ content: [] }, { content: [{ type: "text", text: " \n " }] }]) {
    const sentBodies = [];
    const r = await rig({ mutate: messagesApi(), handler: async (q, s) => {
      const chunks = []; for await (const c of q) chunks.push(c);
      const sent = JSON.parse(Buffer.concat(chunks));
      sentBodies.push(sent);
      // What the real API does with a blank assistant turn.
      if (sent.messages.some((m) => m.role === "assistant" && !String(m.content).trim())) {
        return s.writeHead(400, JSON_HEADERS).end(JSON.stringify({ type: "error", error: { type: "invalid_request_error", message: "messages: all messages must have non-empty content except for the optional final assistant message" } }));
      }
      answerWith(sentBodies.length === 1 ? first : {})(s);
    } });
    try {
      const out = await r.extract(req());
      assert.equal(out.ok, true, JSON.stringify(first));
      assert.equal(sentBodies.length, 2, "the one repair");
      assert.deepEqual(sentBodies[1].messages.map((m) => m.role), ["user", "assistant", "user"]);
      assert.equal(sentBodies[1].messages[1].content, "(no answer)");
      assert.deepEqual(r.store.states(), ["SETTLED", "SETTLED"]);
    } finally { await r.srv.close(); }
  }
});
