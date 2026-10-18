// SI4's operational records from the logical search (docs/FIRECRAWL_PI_SEARCH_INTELLIGENCE_SPEC.md §21): one run row whatever
// its end (complete, a stored answer reused, all providers failed, cancelled), an event per lane outcome, availability and
// breaker transitions, and a lost telemetry write that never changes the search's answer.
import { test } from "node:test";
import assert from "node:assert/strict";
import { harness, request, waitFor } from "./si-helpers.mjs";

const run = (h, over = {}, signal = new AbortController().signal) => h.coordinator.search(request(over), { signal });
const runsOf = (h) => [...h.store.runs.values()];
const settle = (h) => h.telemetry.drain(2000);

test("a complete search is one run row with an event per lane; a stored answer served again is a run of its own", async () => {
  const h = await harness({ telemetry: true });
  try {
    const q = { originalQuery: "records complete run" };
    const r = await run(h, q);
    await settle(h);
    const row = h.store.runs.get(r.body.search.logicalSearchId);
    assert.deepEqual([row.outcome, row.selection, row.cacheMode], [r.body.search.outcome, "fixture", "miss"]);
    assert.match(row.fingerprint, /^[0-9a-f]{64}$/);
    assert.ok(!JSON.stringify(row).includes("records complete run"), "the query is kept only as its fingerprint");
    const lanes = h.store.events.filter((e) => e.logicalId === row.logicalId && e.type === "lane");
    assert.deepEqual(lanes.map((e) => e.provider).sort(), ["brave", "deepseek", "exa", "serper", "tavily"]);
    assert.ok(row.trace.final.length === r.body.web.length, "the final selection is in the trace");
    const again = await run(h, q);
    await settle(h);
    assert.equal(again.body.search.cache.mode, "hit");
    assert.equal(h.store.runs.get(again.body.search.logicalSearchId).cacheMode, "hit", "reuse is recorded as reuse");
    assert.equal(runsOf(h).length, 2);
  } finally { await h.close(); }
});

test("a search no provider answered, and a cancelled one, are each recorded with their end", async () => {
  const cut = () => "destroy";
  const h = await harness({ telemetry: true, handlers: { serper: cut, brave: cut, exa: cut, deepseek: cut, tavily: cut } });
  try {
    await assert.rejects(run(h, { originalQuery: "records all failed" }), (e) => e.failureClass === "SEARCH_ENGINES_FAILED" || e.code === "SEARCH_ENGINES_FAILED" || /no search provider/.test(e.message));
    await settle(h);
    const failed = runsOf(h).find((x) => x.outcome === "failed");
    assert.ok(failed, "a failed run is recorded");
    assert.equal(h.store.events.filter((e) => e.logicalId === failed.logicalId && e.type === "lane" && e.status === "failed").length, 5);
  } finally { await h.close(); }
  const slow = () => new Promise((r) => setTimeout(() => r({ status: 200, body: { credits: 1, organic: [] } }), 400));
  const h2 = await harness({ telemetry: true, handlers: { serper: slow } });
  try {
    const ac = new AbortController();
    const p = run(h2, { originalQuery: "records cancelled" }, ac.signal);
    setTimeout(() => ac.abort(), 50);
    await assert.rejects(p);
    assert.ok(await waitFor(() => runsOf(h2).some((x) => x.outcome === "cancelled")), "the cancelled execution is recorded as cancelled");
  } finally { await h2.close(); }
});

test("an account's exhaustion and a breaker opening are recorded as transitions", async () => {
  const h = await harness({ telemetry: true, handlers: {
    tavily: () => ({ status: 432, body: { detail: { error: "This request exceeds your plan's set usage limit." } } }),
    deepseek: () => "destroy" } });
  try {
    for (let i = 0; i < 3; i++) await run(h, { originalQuery: `records transitions ${i}` });
    await settle(h);
    const t = (type, provider) => h.store.events.filter((e) => e.type === type && e.provider === provider).map((e) => e.status);
    assert.deepEqual(t("availability", "fixture-tavily"), ["quota_exhausted"], "the quota transition, once");
    assert.deepEqual(t("breaker", "fixture-deepseek"), ["open"], "three cut connections open DeepSeek's breaker");
  } finally { await h.close(); }
});

test("a telemetry write that fails is counted and logged, and the search's answer is unchanged", async () => {
  const h = await harness({ telemetry: true });
  try {
    const baseline = await run(h, { originalQuery: "records lost write a" });
    h.store.failTelemetry = true;
    const r = await run(h, { originalQuery: "records lost write b" });
    await settle(h);
    assert.equal(r.status, 200);
    assert.deepEqual(r.body.web.length, baseline.body.web.length, "the answer is whole");
    assert.ok(h.telemetry.counters().telemetryLost >= 2, "the run and its events were lost, and counted");
    assert.ok(h.logs.some((l) => l.event === "si_telemetry_degraded"));
  } finally { await h.close(); }
});
