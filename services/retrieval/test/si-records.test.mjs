// SI4's operational records from the logical search (docs/FIRECRAWL_PI_SEARCH_INTELLIGENCE_SPEC.md §21): one run row whatever
// its end (complete, a stored answer reused, all providers failed, cancelled), an event per lane outcome, availability and
// breaker transitions, and a lost telemetry write that never changes the search's answer.
import { test } from "node:test";
import assert from "node:assert/strict";
import { harness, request, waitFor } from "./si-helpers.mjs";
import { Breaker } from "../src/budget.mjs";

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
    for (const e of lanes) {
      assert.equal(e.callKeys.length, 1, `${e.provider}: one metered call`);
      assert.ok(e.callKeys[0].startsWith(`search:${row.logicalId}:${e.provider}:`), `${e.provider}: its call key names the run and the provider`);
      assert.ok(h.store.rows.has(e.callKeys[0]), `${e.provider}: and is a reservation in the ledger`);
    }
    assert.ok(!JSON.stringify(r.body).includes(`search:${row.logicalId}:`), "call keys never reach the response");
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
    await settle(h2);
    const c = runsOf(h2).find((x) => x.outcome === "cancelled");
    const lanes = h2.store.events.filter((e) => e.logicalId === c.logicalId && e.type === "lane");
    assert.deepEqual(lanes.map((e) => e.provider).sort(), ["brave", "deepseek", "exa", "serper", "tavily"], "every dispatched lane is recorded, the ones that answered too");
    assert.ok(lanes.some((e) => e.status === "success_results"), "a lane that answered before the cancellation keeps its outcome");
  } finally { await h2.close(); }
});

test("an account's exhaustion and a breaker opening are recorded as transitions", async () => {
  const h = await harness({ telemetry: true, handlers: {
    tavily: () => ({ status: 432, body: { detail: { error: "This request exceeds your plan's set usage limit." } } }),
    deepseek: () => "destroy", serper: () => "destroy" } });
  try {
    for (let i = 0; i < 3; i++) await run(h, { originalQuery: `records transitions ${i}` });
    await settle(h);
    const t = (type, provider) => h.store.events.filter((e) => e.type === type && e.provider === provider).map((e) => e.status);
    assert.deepEqual(t("availability", "fixture-tavily"), ["quota_exhausted"], "the quota transition, once");
    assert.deepEqual(t("breaker", "fixture-deepseek"), ["open"], "three cut connections open DeepSeek's breaker");
    assert.deepEqual(t("breaker", "fixture-serper"), ["open"], "Serper's own breaker is recorded the same way");
    assert.ok(h.store.events.find((e) => e.type === "breaker" && e.provider === "fixture-serper").detail.retryAfterS > 0, "with when it may be tried again");
  } finally { await h.close(); }
});

test("a breaker reports each transition its verdicts cause, once", () => {
  let now = 0;
  const seen = [];
  const b = new Breaker({ failures: 2, windowMs: 1000, openMs: 5000 }, () => now, (t) => seen.push(`${t.from}>${t.to}`));
  b.failure(); b.success(); b.failure(); b.failure();
  now = 6000;
  assert.equal(b.state(), "half_open");
  assert.ok(b.admit());
  b.failure();
  now = 12000;
  assert.ok(b.admit());
  b.success(); b.success();
  assert.deepEqual(seen, ["closed>open", "half_open>open", "half_open>closed"], "no report for a verdict that changes nothing");
});

test("a caller that joined another's execution, a refused admission and an expired deadline each leave their run", async () => {
  const slow = (ms) => () => new Promise((r) => setTimeout(() => r({ status: 200, body: { credits: 1, organic: [{ link: "https://slow.example.org/a", title: "a", snippet: "a" }] } }), ms));
  const h = await harness({ telemetry: true, perHour: 2, handlers: { serper: slow(300) } });
  try {
    const q = { originalQuery: "records joined caller" };
    const first = request(q), second = request(q);
    const p1 = h.coordinator.search(first, { signal: new AbortController().signal });
    await new Promise((r) => setTimeout(r, 50));
    const [a, b] = await Promise.all([p1, h.coordinator.search(second, { signal: new AbortController().signal })]);
    assert.equal(b.body.search.coalesced, true);
    await settle(h);
    const joinedRun = h.store.runs.get(second.logicalSearchId);
    assert.ok(joinedRun, "the joined caller has a run under its own logical id");
    assert.deepEqual([joinedRun.cacheMode, joinedRun.outcome, joinedRun.summary.usage], ["coalesced", a.body.search.outcome, []], "no usage: the spend stays with the run that executed");
    assert.equal(h.store.events.filter((e) => e.logicalId === second.logicalSearchId).length, 0, "and no lanes of its own");
    // Two admissions are used; the third distinct search is refused, and recorded.
    await run(h, { originalQuery: "records second admission" });
    const refused = request({ originalQuery: "records refused admission" });
    await assert.rejects(h.coordinator.search(refused, { signal: new AbortController().signal }), (e) => e.failureClass === "SEARCH_RATE_LIMITED");
    await settle(h);
    assert.equal(h.store.runs.get(refused.logicalSearchId)?.outcome, "refused");
  } finally { await h.close(); }
  // An execution that overruns its deadline (here its admission outlasts it) is closed by the deadline's backstop: a timeout.
  // Every lane ending at its own bound instead is all-discovery-failed, recorded as failed.
  const h2 = await harness({ telemetry: true });
  try {
    const admit = h2.store.admitSearchQuery.bind(h2.store);
    h2.store.admitSearchQuery = async (n) => { await new Promise((r) => setTimeout(r, 1700)); return admit(n); };
    const late = request({ originalQuery: "records deadline", absoluteDeadlineMs: Date.now() + 1500 });
    await assert.rejects(h2.coordinator.search(late, { signal: new AbortController().signal }));
    assert.ok(await waitFor(() => h2.store.runs.get(late.logicalSearchId)?.outcome), "the run is recorded");
    assert.equal(h2.store.runs.get(late.logicalSearchId).outcome, "timeout", "a deadline's end is a timeout, not a cancellation");
  } finally { await h2.close(); }
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
