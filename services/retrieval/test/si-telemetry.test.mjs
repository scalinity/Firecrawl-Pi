// SI4's operational records (docs/FIRECRAWL_PI_SEARCH_INTELLIGENCE_SPEC.md §21): the bounded candidate trace, privacy of what
// is kept, a lost telemetry write that never touches the search, and against a throwaway PostgreSQL (FCPI_TEST_PG) the run and
// event rows, an idempotent daily reduction behind its watermark, late settlement, retention and schema reapplication.
// Unset FCPI_TEST_PG skips the database tests; a skip is not a pass.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { randomUUID, createHash } from "node:crypto";
import pg from "pg";
import { Store } from "../src/store.mjs";
import { makeTelemetry, boundedTrace, TRACE_BYTES, safeUrl, fingerprint } from "../src/search-intelligence/telemetry.mjs";

const KEY = Buffer.from("si-telemetry-test-fingerprint-key");

const HOST = process.env.FCPI_TEST_PG;
const opts = { skip: HOST ? false : "no test database (FCPI_TEST_PG unset)" };
const SCHEMA = new URL("../schema.sql", import.meta.url);
async function admin(fn) {
  const c = new pg.Client({ host: HOST, user: "postgres", database: "postgres" });
  await c.connect();
  try { return await fn(c); } finally { await c.end(); }
}
async function fresh() {
  await admin(async (c) => {
    await c.query("CREATE SCHEMA IF NOT EXISTS nuq");
    await c.query(readFileSync(SCHEMA, "utf8"));
    await c.query("TRUNCATE fcpi_retrieval.budget_usage, fcpi_retrieval.budget_reservation, fcpi_retrieval.search_run, fcpi_retrieval.search_event, fcpi_retrieval.search_daily, fcpi_retrieval.search_reduction");
  });
  const store = new Store({ host: HOST, database: "postgres", user: "fcpi_retrieval" });
  await store.ready({ url: 2, browser: 1 });
  return store;
}
const SECRET_QUERY = "my private question about acme internal roadmap";
const request = (over = {}) => ({ schema: "fcpi.search-request/v1", requestId: `req-${randomUUID()}`, logicalSearchId: randomUUID(), principalId: "owner", originalQuery: SECRET_QUERY, limit: 5, language: "en",
  constraints: { includeDomains: [], excludeDomains: [] }, intelligence: { documentation: "auto", evidence: "auto" }, resultMode: "links", absoluteDeadlineMs: Date.now() + 30000, ...over });
const docOf = (i, over = {}) => ({ documentId: String(i).padStart(24, "0"), canonicalUrl: `https://site${i}.example.org/page?token=SECRET${i}#frag`, observations: [{ provider: "brave", rank: i + 1, fromCache: false }],
  presemanticRank: i + 1, semanticRank: null, finalRank: null, passages: [{ text: "page text that must not be kept" }], ...over });
const lane = (provider, over = {}) => ({ provider, kind: "search", status: "success_results", durationMs: 120, queueMs: 3, startedAt: new Date().toISOString(), dispatchState: "response_received",
  upstreamResultCount: 3, candidates: [{}, {}, {}], usage: { requests: 1 }, detail: null, ...over });

test("a run's trace keeps the final selection first, at most 128 documents and 64 KiB, and marks what it trimmed", () => {
  const pool = Array.from({ length: 200 }, (_, i) => docOf(i, { title: "x".repeat(400) }));
  const final = [pool[150], pool[3]];
  final.forEach((d, i) => { d.finalRank = i + 1; });
  const { trace, truncated } = boundedTrace(pool, final);
  assert.equal(truncated, true);
  assert.deepEqual(trace.documents.slice(0, 2).map((d) => d.id), [pool[150].documentId, pool[3].documentId], "the final selection survives, in its order");
  assert.ok(trace.documents.length <= 128);
  assert.ok(Buffer.byteLength(JSON.stringify(trace)) <= TRACE_BYTES);
  assert.equal(trace.truncated.poolSize, 200);
  assert.equal(trace.relevanceBasis, "jev_runtime_advice", "runtime advice is never presented as a judged label");
  const tight = boundedTrace(pool, final, 2000);
  assert.ok(Buffer.byteLength(JSON.stringify(tight.trace)) <= 2000 || tight.trace.documents.length === final.length);
  assert.deepEqual(tight.trace.final, final.map((d) => d.documentId));
  assert.equal(safeUrl("https://user:pw@x.example.org/a/b?token=1#f"), "https://x.example.org/a/b", "no credentials, query string or fragment");
});

test("the trace's byte bound holds with its marker, marks dropped duplicate pairs, and comes from the policy", async () => {
  // Entries of about 600 bytes (long paths survive safeUrl up to 512 characters), so the bytes, not the count, decide.
  const pool = Array.from({ length: 120 }, (_, i) => docOf(i, { canonicalUrl: `https://site${i}.example.org/${"p".repeat(480)}`, duplicateOf: i < 30 ? [{ documentId: "d".repeat(24), assessment: { choice: "same", confidence: 0.9 } }] : [] }));
  const final = [pool[7]];
  for (const bound of [4096, 9000, 30000, 65536]) {
    const { trace, truncated } = boundedTrace(pool, final, bound);
    assert.ok(truncated);
    assert.ok(trace.documents.length > final.length, `${bound}: documents beyond the final selection fit`);
    assert.ok(Buffer.byteLength(JSON.stringify(trace)) <= bound, `${bound}: the trace with its marker is within its bound`);
    assert.ok(Buffer.byteLength(JSON.stringify(trace)) > bound - 700, `${bound}: and no entry more was dropped than needed`);
    assert.equal(trace.truncated.documentsDropped, 120 - trace.documents.length);
    assert.equal(trace.truncated.duplicatesDropped, 10, "pairs past 20 are counted as dropped");
  }
  const rows = [], store = { searchRunStarted: async () => {}, searchRunFinished: async (r) => { rows.push(r); }, searchEvents: async () => 0 };
  const t = makeTelemetry({ fingerprintKey: KEY, store, limits: () => ({ traceMaxBytes: 4096 }) });
  t.runFinished({ request: request(), outcome: "complete", pool, final });
  await t.drain();
  assert.ok(Buffer.byteLength(JSON.stringify(rows[0].trace)) <= 4096, "the policy's traceMaxBytes bounds the stored trace");
});

test("what is kept is private: no query text, no page text, no URL query strings", async () => {
  const rows = [], events = [];
  const store = { searchRunStarted: async (r) => rows.push(r), searchRunFinished: async (r) => rows.push(r), searchEvents: async (e) => events.push(...e) };
  const t = makeTelemetry({ fingerprintKey: KEY, store });
  const req = request();
  t.runStarted({ request: req, selection: "fixture", admittedAt: Date.now(), configHashes: { budgetSha256: "b" } });
  const pool = [docOf(0), docOf(1)];
  t.runFinished({ request: req, outcome: "complete", lanes: [lane("brave"), lane("exa", { status: "failed", reason: "rate_limited", detail: "http_429", retryAt: Date.now() + 1000 })], pool, final: [pool[0]],
    ranking: { mode: "rrf_fallback", reason: "jev_timeout", scored: 0 }, activation: { active: false, reason: "nontechnical", signals: [] }, timings: { totalMs: 900 } });
  assert.equal(await t.drain(), 0);
  const all = JSON.stringify([rows, events]);
  assert.ok(!all.includes("private question"), "the query is kept only as its fingerprint");
  assert.ok(!all.includes("SECRET"), "URL query strings are dropped");
  assert.ok(!all.includes("page text that must not be kept"));
  assert.equal(rows.at(-1).outcome, "complete");
  assert.match(rows.at(-1).fingerprint, /^[0-9a-f]{64}$/);
  assert.deepEqual(events.filter((e) => e.type === "lane").map((e) => [e.provider, e.status, e.reason, e.code]), [["brave", "success_results", null, null], ["exa", "failed", "rate_limited", "http_429"]]);
  assert.ok(events.some((e) => e.type === "decision" && e.status === "rrf_fallback" && e.reason === "jev_timeout"), "a fallback from a configured decision layer is recorded");
  assert.ok(events.some((e) => e.type === "docs_activation" && e.reason === "nontechnical"));
});

test("the query fingerprint is keyed: the same query under another key, or unkeyed, gives another value", () => {
  const req = request();
  assert.equal(fingerprint(req, KEY), fingerprint({ ...req, requestId: "other-request-id" }, KEY), "stable for one query under one key");
  assert.notEqual(fingerprint(req, KEY), fingerprint(req, Buffer.from("another-key")));
  const plain = createHash("sha256").update(JSON.stringify({ q: SECRET_QUERY, lang: req.language, c: req.constraints, si: req.intelligence, limit: req.limit, mode: req.resultMode })).digest("hex");
  assert.notEqual(fingerprint(req, KEY), plain, "a guessed query cannot be checked by hashing it");
  assert.throws(() => makeTelemetry({ store: {} }), /fingerprint key/);
});

test("a telemetry write that fails is logged and counted and never reaches the caller", async () => {
  const logs = [];
  const store = { searchRunStarted: async () => { throw Object.assign(new Error("db down"), { code: "ECONNREFUSED" }); }, searchRunFinished: async () => { throw new Error("db down"); }, searchEvents: async () => { throw new Error("db down"); } };
  const t = makeTelemetry({ fingerprintKey: KEY, store, log: (o) => logs.push(o) });
  const req = request();
  assert.doesNotThrow(() => t.runStarted({ request: req, selection: "fixture", admittedAt: Date.now() }));
  assert.doesNotThrow(() => t.runFinished({ request: req, outcome: "partial", lanes: [lane("brave")] }));
  assert.equal(await t.drain(), 0);
  assert.deepEqual(t.counters(), { telemetryLost: 3, telemetryWritten: 0, telemetryPending: 0 });
  assert.equal(logs.filter((l) => l.event === "si_telemetry_degraded").length, 3);
  assert.ok(logs.every((l) => !JSON.stringify(l).includes("private question")));
});

test("writes waiting on a stalled database are bounded: past 256 a write is counted lost, not queued", async () => {
  const never = new Promise(() => {});
  const store = { searchRunStarted: () => never, searchRunFinished: () => never, searchEvents: () => never };
  const t = makeTelemetry({ fingerprintKey: KEY, store });
  for (let i = 0; i < 300; i++) t.event({ type: "breaker", provider: "p", status: "open" });
  const c = t.counters();
  assert.equal(c.telemetryPending, 256);
  assert.equal(c.telemetryLost, 44);
});

test("a throw while building a record is counted and logged, never the search's", () => {
  const logs = [], store = { searchRunStarted: async () => {}, searchRunFinished: async () => {}, searchEvents: async () => 0 };
  const t = makeTelemetry({ fingerprintKey: KEY, store, log: (o) => logs.push(o) });
  const req = request();
  // A pool document of a shape the trace does not expect, a missing request and a missing event.
  assert.doesNotThrow(() => t.runFinished({ request: req, outcome: "complete", pool: [{ documentId: "x", observations: null }], final: [] }));
  assert.doesNotThrow(() => t.runStarted({ request: null, selection: "live", admittedAt: Date.now() }));
  assert.doesNotThrow(() => t.event(null));
  assert.equal(t.counters().telemetryLost, 3);
  assert.deepEqual(logs.map((l) => `${l.event}:${l.what}`), ["si_telemetry_degraded:run_finished", "si_telemetry_degraded:run_started", "si_telemetry_degraded:event"]);
});

test("run and event rows round-trip; an event written twice is kept once", opts, async () => {
  const store = await fresh();
  try {
    const t = makeTelemetry({ fingerprintKey: KEY, store });
    const req = request({ jobId: "job-0123456789" });
    t.runStarted({ request: req, selection: "live", admittedAt: Date.now(), configHashes: { budgetSha256: "b" } });
    t.runFinished({ request: req, outcome: "partial", search: { cache: { mode: "miss" }, coverage: { general: { successful: 4 } }, providers: {}, warnings: ["exa_rate_limited"], usage: [] },
      lanes: [lane("brave"), lane("exa", { status: "failed", reason: "rate_limited" })], pool: [docOf(0)], final: [docOf(0)], ranking: { mode: "hybrid", reason: "complete", model: "typesafe/jev-1.14-x" },
      activation: { active: true, reason: "deterministic_signal", signals: ["api_symbol"] }, timings: { totalMs: 1200 } });
    assert.equal(await t.drain(), 0);
    const run = (await store.pool.query("SELECT * FROM fcpi_retrieval.search_run WHERE logical_id = $1", [req.logicalSearchId])).rows[0];
    assert.deepEqual([run.outcome, run.cache_mode, run.docs_active, run.ranking_mode, run.selection], ["partial", "miss", true, "hybrid", "live"]);
    assert.equal(run.job_id, "job-0123456789", "the run joins the core's job, which its acquisitions share");
    assert.equal(run.summary.warnings[0], "exa_rate_limited");
    const evs = (await store.pool.query("SELECT event_type, provider, status FROM fcpi_retrieval.search_event WHERE logical_id = $1 ORDER BY event_type, provider", [req.logicalSearchId])).rows;
    assert.deepEqual(evs.map((e) => `${e.event_type}:${e.provider}:${e.status}`), ["decision:jev:hybrid", "docs_activation:classifier:active", "lane:brave:success_results", "lane:exa:failed"]);
    const e = { eventId: randomUUID(), provider: "tavily", type: "availability", observedAt: new Date(), status: "quota_exhausted" };
    assert.equal(await store.searchEvents([e]), 1);
    assert.equal(await store.searchEvents([e]), 0, "an event id seen before is not written again");
  } finally { await store.close(); }
});

test("the daily reduction is idempotent, follows late settlement from the ledger, and gates event pruning", opts, async () => {
  const store = await fresh();
  try {
    const day = (n) => { const d = new Date(); d.setUTCHours(12, 0, 0, 0); d.setUTCDate(d.getUTCDate() - n); return d; };
    const iso = (d) => d.toISOString().slice(0, 10);
    const runs = [];
    for (const [ago, outcome] of [[20, "complete"], [20, "partial"], [2, "complete"]]) {
      const r = { logicalId: randomUUID(), requestId: `req-${randomUUID()}`, principalId: "owner", fingerprint: "f".repeat(64), profile: "aggregate", selection: "live", resultMode: "links",
        acceptedAt: day(ago), versions: {} };
      await store.searchRunFinished({ ...r, completedAt: new Date(day(ago).getTime() + 1500), outcome, cacheMode: "miss", docsActive: false, trace: { v: 1, final: [] } });
      await store.searchEvents([{ eventId: randomUUID(), logicalId: r.logicalId, provider: "brave", type: "lane", observedAt: day(ago), durationMs: 300, status: "success_results" }]);
      runs.push(r);
    }
    // A Brave request of the first run, still uncertain when the day is first reduced.
    const resv = await store.reserveBudget({ id: randomUUID(), callKey: `search:${runs[0].logicalId}:brave:search:v1`, logicalId: runs[0].logicalId, category: "search_brave", caps: {}, reportingPeriods: ["day", "month"],
      paidTotalCap: null, provider: "brave", subject: "brave-web", kind: "search", unit: "requests", rateCard: "brave/web-search@2026-10-17", requestHash: "h", amount: 1, day: iso(day(20)), month: `${iso(day(20)).slice(0, 7)}-01` });
    await store.markBudgetUncertain(resv.reservation.id, "possibly sent");
    // A backlog is reduced at most seven days a pass, each pass starting at the last one's watermark.
    const first = await store.reduceSearchDaily();
    assert.deepEqual([first.from, first.through], [iso(day(20)), iso(day(14))]);
    let pass = first;
    while (pass.through !== iso(day(1))) {
      const next = await store.reduceSearchDaily();
      assert.equal(next.from, pass.through, "a pass starts at the previous watermark");
      assert.ok(Date.parse(next.through) - Date.parse(next.from) <= 6 * 86400000, "at most seven days a pass");
      pass = next;
    }
    const snapshot = async () => (await store.pool.query("SELECT day::text, profile, provider, metric, n, total_ms, histogram, amount::float8 FROM fcpi_retrieval.search_daily ORDER BY 1, 2, 3, 4")).rows;
    const a = await snapshot();
    const get = (rows, d, provider, metric) => rows.find((r) => r.day === iso(d) && r.provider === provider && r.metric === metric);
    assert.equal(get(a, day(20), "*", "runs.complete").n, "1");
    assert.equal(get(a, day(20), "*", "runs.partial").n, "1");
    assert.equal(get(a, day(20), "*", "runs.complete").total_ms, "1500");
    assert.deepEqual(get(a, day(20), "brave", "lane.success_results").histogram, { 2: 2 }, "two 300 ms lanes under key 2: two edges (100, 250 ms) at or below them");
    assert.equal(get(a, day(20), "brave", "usage.search.requests.uncertain").amount, 1, "an uncertain reservation is held at its reserved amount");
    assert.equal(get(a, day(20), "brave", "usage.search.requests.uncertain").profile, "search/search_brave", "usage is labelled from its ledger row");
    const again = await store.reduceSearchDaily();
    assert.deepEqual(await snapshot(), a, "a repeated reduction changes nothing");
    assert.equal(again.from, iso(day(1)), "the next reduction starts at its watermark");
    // Reconciled much later: the day's usage follows the ledger, not the moment of the first reduction.
    await store.settleBudget(resv.reservation.id, 1, { usage: { requests: 1 }, detail: "reconciled" });
    await store.reduceSearchDaily();
    const b = await snapshot();
    assert.equal(get(b, day(20), "brave", "usage.search.requests.settled").amount, 1);
    assert.equal(get(b, day(20), "brave", "usage.search.requests.uncertain"), undefined);
    // Pruning: the reduced 20-day-old events go; the 2-day-old ones and every daily row stay; a trace goes after 14 days.
    await store.prune();
    const left = (await store.pool.query("SELECT (observed_at AT TIME ZONE 'UTC')::date::text AS d FROM fcpi_retrieval.search_event ORDER BY 1")).rows.map((r) => r.d);
    assert.deepEqual(left, [iso(day(2))]);
    assert.deepEqual(await snapshot(), b, "aggregates outlive the events they were reduced from");
    assert.equal((await store.pool.query("SELECT count(*)::int AS n FROM fcpi_retrieval.budget_reservation")).rows[0].n, 1, "the ledger keeps its own retention");
    const traces = (await store.pool.query("SELECT (accepted_at AT TIME ZONE 'UTC')::date::text AS d, trace IS NOT NULL AS kept FROM fcpi_retrieval.search_run ORDER BY 1, 2")).rows;
    assert.deepEqual(traces.map((r) => `${r.d}:${r.kept}`), [`${iso(day(20))}:false`, `${iso(day(20))}:false`, `${iso(day(2))}:true`], "the run stays 30 days, its trace 14");
  } finally { await store.close(); }
});

test("an unreduced old event is kept, and the schema reapplies over populated operational tables", opts, async () => {
  const store = await fresh();
  try {
    const old = new Date(Date.now() - 20 * 86400000);
    await store.searchEvents([{ eventId: randomUUID(), provider: "ref", type: "breaker", observedAt: old, status: "open" }]);
    await store.prune();
    assert.equal((await store.pool.query("SELECT count(*)::int AS n FROM fcpi_retrieval.search_event")).rows[0].n, 1, "no reduction has covered its day yet");
    await admin((c) => c.query(readFileSync(SCHEMA, "utf8")));
    assert.equal((await store.pool.query("SELECT count(*)::int AS n FROM fcpi_retrieval.search_event")).rows[0].n, 1, "reapplying the schema keeps the rows");
  } finally { await store.close(); }
});

test("a stalled reduction loses no source: prune keeps what the watermark has not passed, and usage keeps its label", opts, async () => {
  const store = await fresh();
  try {
    const day = (n) => { const d = new Date(); d.setUTCHours(12, 0, 0, 0); d.setUTCDate(d.getUTCDate() - n); return d; };
    const iso = (d) => d.toISOString().slice(0, 10);
    // The reduction last succeeded 35 days ago and has failed since.
    await store.pool.query("INSERT INTO fcpi_retrieval.search_reduction (name, reduced_through) VALUES ('daily', $1)", [iso(day(35))]);
    const runAt = async (ago) => {
      const r = { logicalId: randomUUID(), requestId: `req-${randomUUID()}`, principalId: "owner", fingerprint: "f".repeat(64), profile: "aggregate", selection: "live", resultMode: "links", acceptedAt: day(ago), versions: {} };
      await store.searchRunFinished({ ...r, completedAt: new Date(day(ago).getTime() + 900), outcome: "complete", cacheMode: "miss", docsActive: false });
      await store.searchEvents([{ eventId: randomUUID(), logicalId: r.logicalId, provider: "exa", type: "lane", observedAt: day(ago), durationMs: 900, status: "success_results" }]);
      return r;
    };
    await runAt(36);
    await runAt(35);
    const unreduced = await runAt(32);
    const resv = await store.reserveBudget({ id: randomUUID(), callKey: `search:${unreduced.logicalId}:exa:search:v1`, logicalId: unreduced.logicalId, category: "search_exa", caps: {}, reportingPeriods: ["day", "month"],
      paidTotalCap: null, provider: "exa", subject: "exa-search", kind: "search", unit: "micro_usd", rateCard: "exa/search@2026-10-17", requestHash: "h", amount: 17000, day: iso(day(32)), month: `${iso(day(32)).slice(0, 7)}-01` });
    await store.settleBudget(resv.reservation.id, 17000, { usage: { costDollars: 0.017 }, detail: "settled" });
    await store.prune();
    const days = async (table, col) => (await store.pool.query(`SELECT (${col} AT TIME ZONE 'UTC')::date::text AS d FROM fcpi_retrieval.${table} ORDER BY 1`)).rows.map((r) => r.d);
    assert.deepEqual(await days("search_run", "accepted_at"), [iso(day(35)), iso(day(32))], "only the run before the watermark goes; its day and later wait for the reduction");
    assert.deepEqual(await days("search_event", "observed_at"), [iso(day(35)), iso(day(32))], "events on the watermark's day and after are kept");
    // The reduction recovers and rebuilds those days from whole sources.
    const p = await store.reduceSearchDaily();
    assert.deepEqual([p.from, p.through], [iso(day(35)), iso(day(29))]);
    const daily = (await store.pool.query("SELECT day::text, profile, provider, metric, n FROM fcpi_retrieval.search_daily ORDER BY 1, 3, 4")).rows;
    const at = (d, metric) => daily.find((r) => r.day === iso(d) && r.metric === metric);
    assert.equal(at(day(35), "runs.complete").n, "1");
    assert.equal(at(day(32), "runs.complete").n, "1");
    assert.equal(at(day(32), "lane.success_results").n, "1");
    // Pruned at last, the run takes nothing from its day's usage: the label comes from the ledger row.
    await store.pool.query("UPDATE fcpi_retrieval.search_reduction SET reduced_through = $1 WHERE name = 'daily'", [iso(day(1))]);
    await store.prune();
    assert.deepEqual(await days("search_run", "accepted_at"), [], "past 30 days and reduced, the runs go");
    await store.reduceSearchDaily();
    const usage = (await store.pool.query("SELECT profile, amount::float8 AS amount FROM fcpi_retrieval.search_daily WHERE day = $1 AND metric = 'usage.search.micro_usd.settled'", [iso(day(32))])).rows;
    assert.deepEqual(usage, [{ profile: "search/search_exa", amount: 17000 }]);
  } finally { await store.close(); }
});
