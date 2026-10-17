// M5's ledger SQL against a throwaway PostgreSQL (FCPI_TEST_PG): concurrent reservations that cannot pass
// a cap, settlement and release giving back what they held, an uncertain reservation staying counted, a
// released call key reserved again, the paid total's cap, the notification threshold, and the search
// admission cap under concurrent queries.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import pg from "pg";
import { Store } from "../src/store.mjs";

const HOST = process.env.FCPI_TEST_PG;
const opts = { skip: HOST ? false : "no test database (FCPI_TEST_PG unset)" };
async function fresh() {
  const admin = new pg.Client({ host: HOST, user: "postgres", database: "postgres" });
  await admin.connect();
  await admin.query("CREATE SCHEMA IF NOT EXISTS nuq");
  await admin.query(readFileSync(new URL("../schema.sql", import.meta.url), "utf8"));
  await admin.query("TRUNCATE fcpi_retrieval.budget_usage, fcpi_retrieval.budget_reservation, fcpi_retrieval.search_cache, fcpi_retrieval.search_query, fcpi_retrieval.parse_cache");
  await admin.end();
  const store = new Store({ host: HOST, database: "postgres", user: "fcpi_retrieval" });
  await store.ready({ url: 2, browser: 1 });
  return store;
}
const base = (over = {}) => ({ id: crypto.randomUUID(), callKey: `k:${crypto.randomUUID()}`, logicalId: "L", category: "fixture_race", caps: { day: 100000 }, paidTotalCap: null,
  provider: "fixture-model", subject: "fcpi-fixture-race", kind: "extract", unit: "micro_usd", rateCard: "card", requestHash: "h", amount: 30000, day: "2026-09-26", month: "2026-09-01", notifyAt: 0.8, ...over });
const usage = async (store) => (await store.budgetUsage("2026-09-26", "2026-09-01")).map((u) => `${u.category}/${u.period}:${u.reserved}+${u.settled}`);

test("finite search credits serialize reservations across months and survive pruning", opts, async () => {
  const store = await fresh();
  const reservation = (n) => base({ category: "serper_trial", kind: "search", unit: "credits", amount: 1, caps: { month: 10 }, lifetimeCap: 3, day: `2026-${n % 2 ? "10" : "11"}-15`, month: `2026-${n % 2 ? "10" : "11"}-01` });
  try {
    const rs = await Promise.all(Array.from({ length: 12 }, (_, i) => store.reserveBudget(reservation(i))));
    const rows = rs.filter((r) => r.reservation).map((r) => r.reservation);
    assert.equal(rows.length, 3); assert.equal(rs.filter((r) => r.exhausted?.period === "allocation").length, 9);
    await store.settleBudget(rows[0].id, 1, {});
    await store.markBudgetUncertain(rows[1].id, "sent without answer");
    await store.pool.query("UPDATE fcpi_retrieval.budget_reservation SET created_at = now() - interval '100 days'");
    await store.prune(); assert.equal((await store.reserveBudget(reservation(1))).exhausted.period, "allocation");
    await store.releaseBudget(rows[2].id, "not sent");
    assert.ok((await store.reserveBudget(reservation(1))).reservation);
  } finally { await store.close(); }
});

test("twelve concurrent reservations against a cap that holds three: exactly three succeed (CLAUDE.md §11, AC25)", opts, async () => {
  const store = await fresh();
  try {
    const rs = await Promise.all(Array.from({ length: 12 }, () => store.reserveBudget(base())));
    assert.equal(rs.filter((r) => r.reservation).length, 3);
    assert.equal(rs.filter((r) => r.exhausted).length, 9);
    assert.deepEqual(await usage(store), ["fixture_race/day:90000+0"]);
    assert.ok(rs.find((r) => r.exhausted).exhausted.used >= 90000);
  } finally { await store.close(); }
});

test("settlement moves the reservation to its actual cost; release gives it all back; uncertain keeps it whole", opts, async () => {
  const store = await fresh();
  try {
    const a = (await store.reserveBudget(base())).reservation;
    const b = (await store.reserveBudget(base())).reservation;
    const c = (await store.reserveBudget(base())).reservation;
    await store.settleBudget(a.id, 1234, { usage: { promptTokens: 10, completionTokens: 5 }, result: { content: "{}" } });
    await store.releaseBudget(b.id, "not sent");
    await store.markBudgetUncertain(c.id, "no answer");
    assert.deepEqual(await usage(store), ["fixture_race/day:30000+1234"]);
    // Neither a settled nor a released reservation can be closed twice.
    assert.equal(await store.settleBudget(a.id, 1, {}), null);
    assert.equal(await store.releaseBudget(b.id, "again"), null);
    // An uncertain one can still be settled once its outcome is known (reconciliation).
    assert.equal((await store.settleBudget(c.id, 2000, {})).state, "SETTLED");
    assert.deepEqual(await usage(store), ["fixture_race/day:0+3234"]);
  } finally { await store.close(); }
});

test("a retried call key finds its reservation; a released one may be reserved again", opts, async () => {
  const store = await fresh();
  try {
    const key = "L:0:extract";
    const first = await store.reserveBudget(base({ callKey: key }));
    assert.ok(first.reservation);
    const dup = await store.reserveBudget(base({ callKey: key }));
    assert.equal(dup.existing.id, first.reservation.id);
    await store.releaseBudget(first.reservation.id, "not sent");
    const again = await store.reserveBudget(base({ callKey: key }));
    assert.ok(again.reservation && again.reservation.id !== first.reservation.id);
    // The released attempt is kept, with what it was released for (review S4).
    const kept = (await store.reservationsFor("L")).find((x) => x.call_key === `${key}#released-${first.reservation.id}`);
    assert.equal(kept?.state, "RELEASED");
    assert.equal(kept?.detail, "not sent");
    // Two concurrent reservations of one key: one reserves, the other finds it.
    const k2 = "L:1:extract";
    const pair = await Promise.all([store.reserveBudget(base({ callKey: k2 })), store.reserveBudget(base({ callKey: k2 }))]);
    assert.equal(pair.filter((r) => r.reservation).length, 1);
    assert.equal(pair.filter((r) => r.existing).length, 1);
  } finally { await store.close(); }
});

test("a paid category also draws on the paid total's daily cap; a zero cap refuses everything", opts, async () => {
  const store = await fresh();
  try {
    const r = await store.reserveBudget(base({ category: "llm", caps: { day: 1000000, month: 1000000 }, paidTotalCap: 50000, amount: 40000 }));
    assert.ok(r.reservation);
    const over = await store.reserveBudget(base({ category: "llm", caps: { day: 1000000, month: 1000000 }, paidTotalCap: 50000, amount: 20000 }));
    assert.deepEqual(over.exhausted, { category: "_paid_total", period: "day", cap: 50000, used: 40000 });
    const zero = await store.reserveBudget(base({ category: "llm", caps: { day: 0, month: 0 }, paidTotalCap: 0, amount: 1 }));
    assert.equal(zero.exhausted.cap, 0);
    // The refused reservations left nothing behind.
    assert.deepEqual((await usage(store)).sort(), ["_paid_total/day:40000+0", "llm/day:40000+0", "llm/month:40000+0"]);
  } finally { await store.close(); }
});

test("a paid category with no shared cap (null or undefined) draws on no shared row and records none; a shared cap of zero still refuses", opts, async () => {
  const store = await fresh();
  try {
    // An absent cap must never reach PostgreSQL as NULL: a NULL cap would compare as unknown and refuse or admit by accident.
    for (const paidTotalCap of [null, undefined]) {
      const r = await store.reserveBudget(base({ category: "llm", caps: { day: 1000000, month: 1000000 }, paidTotalCap, amount: 10000 }));
      assert.ok(r.reservation, `paidTotalCap ${paidTotalCap}`);
      assert.equal(r.reservation.paid_total, false);
    }
    assert.deepEqual((await usage(store)).sort(), ["llm/day:20000+0", "llm/month:20000+0"], "no shared row exists");
    const zero = await store.reserveBudget(base({ category: "llm", caps: { day: 1000000, month: 1000000 }, paidTotalCap: 0, amount: 1 }));
    assert.equal(zero.exhausted.category, "_paid_total", "a cap of zero is a cap");
  } finally { await store.close(); }
});

test("calls of uncertain outcome are listed by category with what they hold, for the month they were made in and no other", opts, async () => {
  const store = await fresh();
  try {
    const caps = { day: 1000000, month: 1000000 };
    const a = await store.reserveBudget(base({ category: "llm", caps, amount: 40000 }));
    const b = await store.reserveBudget(base({ category: "llm", caps, amount: 25000 }));
    await store.reserveBudget(base({ category: "llm", caps, amount: 5000 }));
    const other = await store.reserveBudget(base({ category: "proxy", caps, amount: 700 }));
    for (const r of [a, b, other]) await store.markBudgetUncertain(r.reservation.id, "no answer came");
    assert.deepEqual(await store.uncertainHolds("2026-09-01"), [{ category: "llm", count: 2, reserved: 65000 }, { category: "proxy", count: 1, reserved: 700 }],
      "the call still in flight (RESERVED) is not listed");
    assert.deepEqual(await store.uncertainHolds("2026-10-01"), [], "a month in which nothing was made lists nothing");
  } finally { await store.close(); }
});

test("settlements and reservations running at once on one category's day, month and paid-total rows all complete (review W2)", opts, async () => {
  const store = await fresh();
  try {
    const paid = (over = {}) => base({ category: "llm", caps: { month: 10000000, day: 10000000 }, paidTotalCap: 10000000, amount: 1000, ...over });
    const held = [];
    for (let i = 0; i < 20; i++) held.push((await store.reserveBudget(paid())).reservation);
    // Twenty settlements and twenty new reservations interleaved: the caps' order in the policy (month first
    // here) does not decide the lock order, so none waits on another's rows in the opposite order.
    const out = await Promise.all([...held.map((r) => store.settleBudget(r.id, 400, {})), ...held.map(() => store.reserveBudget(paid()))]);
    assert.equal(out.slice(0, 20).filter((r) => r?.state === "SETTLED").length, 20);
    assert.equal(out.slice(20).filter((r) => r.reservation).length, 20);
    assert.deepEqual((await usage(store)).sort(), ["_paid_total/day:20000+8000", "llm/day:20000+8000", "llm/month:20000+8000"]);
  } finally { await store.close(); }
});

test("a settlement gives back only the period rows its reservation took, whatever the caps are now (review W2)", opts, async () => {
  const store = await fresh();
  try {
    const dayOnly = (await store.reserveBudget(base({ caps: { day: 100000 }, amount: 5000 }))).reservation;
    assert.deepEqual(dayOnly.periods, ["day"]);
    // The category later gains a month cap, and another reservation draws on it.
    await store.reserveBudget(base({ caps: { day: 100000, month: 100000 }, amount: 7000 }));
    await store.settleBudget(dayOnly.id, 1000, {});
    assert.deepEqual((await usage(store)).sort(), ["fixture_race/day:7000+1000", "fixture_race/month:7000+0"]);
  } finally { await store.close(); }
});

test("a paid parser's credits count against the paid total's day in micro-USD (review W3)", opts, async () => {
  const store = await fresh();
  try {
    const parse = (over = {}) => base({ category: "parser", caps: { month: 1000 }, paidTotalCap: 50000, paidTotalRate: 1250, unit: "credits", amount: 30, ...over });
    const a = (await store.reserveBudget(parse())).reservation;
    assert.deepEqual((await usage(store)).sort(), ["_paid_total/day:37500+0", "parser/month:30+0"]);
    // 30 more credits would be 37,500 more micro-USD, past the 50,000 day total though within the credit cap.
    assert.deepEqual((await store.reserveBudget(parse())).exhausted, { category: "_paid_total", period: "day", cap: 50000, used: 37500 });
    await store.settleBudget(a.id, 12, {});
    assert.deepEqual((await usage(store)).sort(), ["_paid_total/day:0+15000", "parser/month:0+12"]);
  } finally { await store.close(); }
});

test("pruning clears a week-old settled call's stored answer and keeps its amounts (review W9)", opts, async () => {
  const store = await fresh();
  try {
    const old = (await store.reserveBudget(base())).reservation, recent = (await store.reserveBudget(base())).reservation;
    await store.settleBudget(old.id, 100, { usage: { promptTokens: 1, completionTokens: 1 }, result: { content: "page text" } });
    await store.settleBudget(recent.id, 100, { result: { content: "page text" } });
    const admin = new pg.Client({ host: HOST, user: "postgres", database: "postgres" });
    await admin.connect();
    await admin.query("UPDATE fcpi_retrieval.budget_reservation SET settled_at = now() - interval '8 days' WHERE id = $1", [old.id]);
    await store.prune();
    const rows = (await admin.query("SELECT id, result, actual, usage FROM fcpi_retrieval.budget_reservation")).rows;
    await admin.end();
    const byId = Object.fromEntries(rows.map((x) => [x.id, x]));
    assert.equal(byId[old.id].result, null);
    assert.equal(Number(byId[old.id].actual), 100);
    assert.deepEqual(byId[old.id].usage, { promptTokens: 1, completionTokens: 1 });
    assert.deepEqual(byId[recent.id].result, { content: "page text" });
  } finally { await store.close(); }
});

test("the 80% threshold is noticed once per period", opts, async () => {
  const store = await fresh();
  try {
    const a = await store.reserveBudget(base({ amount: 50000 }));
    assert.deepEqual(a.notices, []);
    const b = await store.reserveBudget(base({ amount: 30000 }));
    assert.deepEqual(b.notices, [{ category: "fixture_race", period: "day", used: 80000, cap: 100000 }]);
    const c = await store.reserveBudget(base({ amount: 10000 }));
    assert.deepEqual(c.notices, []);
  } finally { await store.close(); }
});

test("search admission holds its hourly cap under concurrent queries; the cache expires", opts, async () => {
  const store = await fresh();
  try {
    const rs = await Promise.all(Array.from({ length: 10 }, () => store.admitSearchQuery(6)));
    assert.equal(rs.filter((r) => r.admitted).length, 6);
    await store.searchCachePut("k", { results: [] }, 0);
    assert.equal(await store.searchCacheGet("k"), null, "a zero-second entry is already expired");
    await store.searchCachePut("k2", { results: [1] }, 60);
    assert.deepEqual(await store.searchCacheGet("k2"), { results: [1] });
    await store.parseCachePut({ key: "p", owner: "o", bytesSha256: "a".repeat(64), parser: "x", pages: 2, markdown: "# m", days: 7 });
    assert.deepEqual(await store.parseCacheGet("p"), { pages: 2, markdown: "# m" });
  } finally { await store.close(); }
});

test("at start, a model call left RESERVED by a stopped service becomes UNCERTAIN and is listed; later and other rows are not touched", opts, async () => {
  const store = await fresh();
  try {
    const caps = { month: 10000000 };
    const orphan = (await store.reserveBudget(base({ category: "llm", caps, amount: 5000 }))).reservation;
    const repair = (await store.reserveBudget(base({ category: "llm", caps, amount: 3000, kind: "repair" }))).reservation;
    const proxy = (await store.reserveBudget(base({ category: "proxy", caps, amount: 700, kind: "proxy" }))).reservation;
    const settled = (await store.reserveBudget(base({ category: "llm", caps, amount: 100 }))).reservation;
    await store.settleBudget(settled.id, 50, {});
    await store.pool.query("UPDATE fcpi_retrieval.budget_reservation SET created_at = now() - interval '1 hour'");
    const startedAt = new Date();
    const live = (await store.reserveBudget(base({ category: "llm", caps, amount: 2000 }))).reservation;
    assert.deepEqual(await store.ready({ url: 2, browser: 1 }, startedAt), { orphaned: 2, orphanedReserved: 8000 });
    const state = async (id) => (await store.pool.query("SELECT state, detail FROM fcpi_retrieval.budget_reservation WHERE id = $1", [id])).rows[0];
    for (const r of [orphan, repair]) assert.deepEqual(await state(r.id), { state: "UNCERTAIN", detail: "the retrieval service stopped while the call was in flight" });
    assert.equal((await state(proxy.id)).state, "RESERVED", "only model calls are swept");
    assert.equal((await state(live.id)).state, "RESERVED", "a call this process made is left alone");
    assert.equal((await state(settled.id)).state, "SETTLED");
    assert.deepEqual(await store.uncertainHolds("2026-09-01"), [{ category: "llm", count: 2, reserved: 8000 }]);
    assert.deepEqual(await store.ready({ url: 2, browser: 1 }, startedAt), { orphaned: 0, orphanedReserved: 0 }, "a second start finds nothing more");
  } finally { await store.close(); }
});
