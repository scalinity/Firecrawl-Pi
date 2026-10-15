import { test } from "node:test";
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { makeSerper } from "../src/serper.mjs";
import { loadBudgetPolicy } from "../src/budget.mjs";
import { budgetFor, FakeLedger, providersDir, policyFor, lookupFixture, serve } from "./m5-helpers.mjs";
const pause = (ms) => new Promise((r) => setTimeout(r, ms));

test("Serper wire contract, credit settlement, URL filtering, and no LLM or retries", async () => {
  let calls = 0;
  const srv = await serve(async (req, res) => {
    calls++;
    assert.equal(req.url, "/search"); assert.equal(req.method, "POST");
    assert.equal(req.headers["x-api-key"], "synthetic-serper-key");
    let text = ""; for await (const c of req) text += c;
    assert.deepEqual(JSON.parse(text), { q: "web retrieval", num: 10, hl: "en" });
    res.end(JSON.stringify({ credits: 1, organic: [{ title: "Result", link: "https://example.org/a", snippet: "text" }, { link: "javascript:alert(1)" }, { link: "https://secret@example.org" }] }));
  });
  const b = budgetFor({ mutate: (b) => { b.providers.serper.baseUrl = `http://serper.fixture.fcpi.test:${srv.port}`; } });
  const dir = providersDir({ serper_api_key: "synthetic-serper-key" }), store = new FakeLedger();
  try {
    const google = makeSerper({ store, getBudget: () => b, getPolicy: () => policyFor({ "serper.fixture.fcpi.test": srv.port }), providersDir: dir, lookupFixture, log: () => {} });
    const result = await google.search("web retrieval", "en-US");
    assert.deepEqual(result, [{ url: "https://example.org/a", title: "Result", content: "text" }]);
    assert.equal(calls, 1); assert.equal([...store.rows.values()][0].actual, 1);
    assert.equal([...store.rows.values()][0].state, "SETTLED");
  } finally { rmSync(dir, { recursive: true }); await srv.close(); }
});

test("refusals and malformed answers retain credit; pre-send failure releases; no retries", async () => {
  for (const scenario of ["refusal", "malformed", "network"]) {
    const store = new FakeLedger(), b = budgetFor(), dir = providersDir({ serper_api_key: "synthetic-serper-key" });
    let calls = 0;
    const request = async () => { calls++; if (scenario === "network") throw Object.assign(new Error("not sent"), { sent: false }); return { status: scenario === "refusal" ? 429 : 200, body: Buffer.from("{}") }; };
    try {
      const google = makeSerper({ store, getBudget: () => b, providersDir: dir, request, log: () => {} });
      await assert.rejects(google.search("query", "auto"));
      assert.equal(calls, 1);
      assert.equal([...store.rows.values()][0].state, scenario === "network" ? "RELEASED" : "UNCERTAIN");
    } finally { rmSync(dir, { recursive: true }); }
  }
});

test("missing credential and pre-cancelled requests never dispatch", async () => {
  const b = budgetFor(), dir = providersDir(), store = new FakeLedger(); let calls = 0;
  const google = makeSerper({ store, getBudget: () => b, providersDir: dir, request: async () => { calls++; }, log: () => {} });
  try {
    await assert.rejects(google.search("query", "auto"), (e) => e.failureClass === "BLOCKED_CREDENTIAL");
    const abort = new AbortController(); abort.abort();
    await assert.rejects(google.search("query", "auto", { signal: abort.signal }), (e) => e.failureClass === "CANCELLED");
    assert.equal(calls, 0); assert.equal(store.rows.size, 0);
  } finally { rmSync(dir, { recursive: true }); }
});

test("exhausted allocation refuses with credentials present and never dispatches", async () => {
  const b = budgetFor(), dir = providersDir({ serper_api_key: "synthetic-serper-key" }); let calls = 0;
  const store = { reserveBudget: async () => ({ exhausted: { period: "allocation", cap: 2443, used: 2443 } }) };
  try {
    const google = makeSerper({ store, getBudget: () => b, providersDir: dir, request: async () => { calls++; }, log: () => {} });
    await assert.rejects(google.search("query", "auto"), (e) => e.failureClass === "SEARCH_CREDITS_EXHAUSTED");
    assert.equal(calls, 0);
  } finally { rmSync(dir, { recursive: true }); }
});

test("sent and unspecified-send failures retain their reservation", async () => {
  for (const sent of [true, undefined]) {
    const b = budgetFor(), store = new FakeLedger(), dir = providersDir({ serper_api_key: "synthetic-serper-key" });
    try {
      const google = makeSerper({ store, getBudget: () => b, providersDir: dir, request: async () => { throw Object.assign(new Error("unknown"), { sent }); }, log: () => {} });
      await assert.rejects(google.search("query", "auto"));
      assert.equal([...store.rows.values()][0].state, "UNCERTAIN");
    } finally { rmSync(dir, { recursive: true }); }
  }
});

test("deadline covers slow admission and DNS; neither can dispatch late", async () => {
  let calls = 0;
  const srv = await serve((req, res) => { calls++; res.end(JSON.stringify({ credits: 1, organic: [] })); });
  const dir = providersDir({ serper_api_key: "synthetic-serper-key" });
  try {
    for (const delayed of ["admission", "dns"]) {
      const b = budgetFor({ mutate: (b) => { b.providers.serper.baseUrl = `http://serper.fixture.fcpi.test:${srv.port}`; } }), store = new FakeLedger();
      if (delayed === "admission") { const reserve = store.reserveBudget.bind(store); store.reserveBudget = async (r) => { await pause(100); return reserve(r); }; }
      const google = makeSerper({ store, getBudget: () => b, getPolicy: () => policyFor({ "serper.fixture.fcpi.test": srv.port }), providersDir: dir,
        lookupFixture: async () => { if (delayed === "dns") await pause(100); return ["127.0.0.1"]; }, log: () => {} });
      const started = Date.now();
      await assert.rejects(google.search("query", "auto", { timeoutMs: 20 }), (e) => e.failureClass === "SEARCH_PROVIDER_TIMEOUT");
      assert.ok(Date.now() - started < 90, "the caller does not wait for delayed admission or DNS");
      await pause(130);
      assert.equal(calls, 0); assert.equal([...store.rows.values()][0].state, "RELEASED");
    }
  } finally { rmSync(dir, { recursive: true }); await srv.close(); }
});

test("cancelling after send retains credit and does not retry", async () => {
  const abort = new AbortController(); let calls = 0;
  const srv = await serve(async (req) => { for await (const _ of req) {} calls++; abort.abort(); });
  const b = budgetFor({ mutate: (b) => { b.providers.serper.baseUrl = `http://serper.fixture.fcpi.test:${srv.port}`; } }), store = new FakeLedger(), dir = providersDir({ serper_api_key: "synthetic-serper-key" });
  try {
    const google = makeSerper({ store, getBudget: () => b, getPolicy: () => policyFor({ "serper.fixture.fcpi.test": srv.port }), providersDir: dir, lookupFixture, log: () => {} });
    await assert.rejects(google.search("query", "auto", { signal: abort.signal }), (e) => e.failureClass === "CANCELLED");
    await pause(10); assert.equal(calls, 1); assert.equal([...store.rows.values()][0].state, "UNCERTAIN");
  } finally { rmSync(dir, { recursive: true }); await srv.close(); }
});

test("half-open breaker recovers when settlement and uncertainty writes both fail", async () => {
  const b = budgetFor(); b.breaker = { failures: 1, windowMs: 1000, openMs: 10 };
  const store = new FakeLedger(), dir = providersDir({ serper_api_key: "synthetic-serper-key" }); let calls = 0;
  const settle = store.settleBudget.bind(store), uncertain = store.markBudgetUncertain.bind(store);
  const google = makeSerper({ store, getBudget: () => b, providersDir: dir, log: () => {}, request: async () => { calls++; if (calls === 1) throw Object.assign(new Error("unreachable"), { sent: false }); return { status: 200, body: Buffer.from(JSON.stringify({ credits: 1, organic: [] })) }; } });
  try {
    await assert.rejects(google.search("query", "auto")); await pause(15);
    store.settleBudget = async () => { throw new Error("DB offline"); };
    store.markBudgetUncertain = async () => { throw new Error("DB offline"); };
    await assert.rejects(google.search("query", "auto"));
    store.settleBudget = settle; store.markBudgetUncertain = uncertain; await pause(15);
    assert.deepEqual(await google.search("query", "auto"), []); assert.equal(calls, 3);
    assert.equal(google.breakerState("serper"), "closed");
  } finally { rmSync(dir, { recursive: true }); }
});

test("search policy rejects arbitrary origins, paid search and allocation increases", () => {
  for (const mutate of [(b) => { b.providers.serper.baseUrl = "https://example.org"; }, (b) => { b.providers.serper.paid = true; }, (b) => { b.searching.allocationCredits = 2444; }, (b) => { b.rateCards.find((r) => r.subject === "serper-google").creditsPerSearch = 0; }]) {
    const b = budgetFor(); mutate(b); assert.throws(() => loadBudgetPolicy(JSON.stringify(b)));
  }
});
