// SI1's ledger and state SQL against a throwaway PostgreSQL (FCPI_TEST_PG; docs/FIRECRAWL_PI_SEARCH_INTELLIGENCE_SPEC.md §18,
// §24.2): reporting periods for uncapped categories, the request unit, startup recovery of search/docs/decision operations,
// availability rows, lifetime-allocation retention, and the schema applied over a populated baseline database and again.
// Unset FCPI_TEST_PG skips these tests; a skip is not a pass.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import pg from "pg";
import { Store } from "../src/store.mjs";

const HOST = process.env.FCPI_TEST_PG;
const opts = { skip: HOST ? false : "no test database (FCPI_TEST_PG unset)" };
const SCHEMA = new URL("../schema.sql", import.meta.url);
const BASELINE = new URL("../fixtures/si/fcpi-retrieval-schema-baseline.sql", import.meta.url);
async function admin(fn) {
  const c = new pg.Client({ host: HOST, user: "postgres", database: "postgres" });
  await c.connect();
  try { return await fn(c); } finally { await c.end(); }
}
async function fresh() {
  await admin(async (c) => {
    await c.query("CREATE SCHEMA IF NOT EXISTS nuq");
    await c.query(readFileSync(SCHEMA, "utf8"));
    await c.query("TRUNCATE fcpi_retrieval.budget_usage, fcpi_retrieval.budget_reservation, fcpi_retrieval.search_cache, fcpi_retrieval.search_query, fcpi_retrieval.provider_availability");
  });
  const store = new Store({ host: HOST, database: "postgres", user: "fcpi_retrieval" });
  await store.ready({ url: 2, browser: 1 });
  return store;
}
const res = (over = {}) => ({ id: crypto.randomUUID(), callKey: `search:${crypto.randomUUID()}:brave:search:v1`, logicalId: "L", category: "search_brave", caps: {}, reportingPeriods: ["day", "month"],
  paidTotalCap: null, provider: "brave", subject: "brave-web", kind: "search", unit: "requests", rateCard: "brave/web-search@2026-10-17", requestHash: "h", amount: 1, day: "2026-10-17", month: "2026-10-01", notifyAt: 0.8, ...over });
const usage = async (store, day = "2026-10-17", month = "2026-10-01") => Object.fromEntries((await store.budgetUsage(day, month)).map((u) => [`${u.category}/${u.period}`, `${u.reserved}+${u.settled}`]));

test("an uncapped category totals day and month with no ceiling; settlement and release return exactly what was taken", opts, async () => {
  const store = await fresh();
  try {
    const rs = await Promise.all(Array.from({ length: 25 }, () => store.reserveBudget(res())));
    assert.equal(rs.filter((r) => r.reservation).length, 25, "no cap refuses a reporting-only category");
    assert.deepEqual(rs[0].reservation.periods, ["day", "month"]);
    assert.deepEqual(await usage(store), { "search_brave/day": "25+0", "search_brave/month": "25+0" });
    await store.settleBudget(rs[0].reservation.id, 1, {});
    await store.releaseBudget(rs[1].reservation.id, "refused, not billed");
    await store.releaseBudget(rs[1].reservation.id, "again");
    await store.markBudgetUncertain(rs[2].reservation.id, "sent, no answer");
    assert.deepEqual(await usage(store), { "search_brave/day": "23+1", "search_brave/month": "23+1" });
    // A reporting-only period never notifies: there is no cap to cross.
    assert.equal((await store.pool.query("SELECT bool_or(notified) AS n FROM fcpi_retrieval.budget_usage")).rows[0].n, false);
  } finally { await store.close(); }
});

test("a reservation made in one month settles into that month's rows, whatever day it settles on", opts, async () => {
  const store = await fresh();
  try {
    const r = (await store.reserveBudget(res({ category: "search_exa", unit: "micro_usd", amount: 37000, day: "2026-10-31", month: "2026-10-01" }))).reservation;
    await store.settleBudget(r.id, 12000, { usage: { costDollars: { total: 0.012 } } });
    assert.deepEqual(await usage(store, "2026-10-31", "2026-10-01"), { "search_exa/day": "0+12000", "search_exa/month": "0+12000" });
    assert.deepEqual(await usage(store, "2026-11-01", "2026-11-01"), {});
  } finally { await store.close(); }
});

test("a capped category keeps its cap when it is also reported", opts, async () => {
  const store = await fresh();
  try {
    const rs = await Promise.all(Array.from({ length: 6 }, () => store.reserveBudget(res({ category: "capped", caps: { day: 3 } }))));
    assert.equal(rs.filter((r) => r.reservation).length, 3);
    assert.deepEqual(await usage(store), { "capped/day": "3+0", "capped/month": "3+0" });
  } finally { await store.close(); }
});

test("the request unit is accepted; an unknown unit is refused by the schema", opts, async () => {
  const store = await fresh();
  try {
    assert.ok((await store.reserveBudget(res())).reservation);
    await assert.rejects(store.reserveBudget(res({ unit: "tokens" })), /budget_reservation_unit_check/);
    for (const kind of ["docs_search", "docs_read", "decision"]) assert.ok((await store.reserveBudget(res({ kind }))).reservation, kind);
  } finally { await store.close(); }
});

test("at start, search, documentation and decision operations left RESERVED become UNCERTAIN, never released or replayed", opts, async () => {
  const store = await fresh();
  const kinds = ["search", "docs_search", "docs_read", "decision"];
  try {
    for (const kind of kinds) await store.reserveBudget(res({ kind }));
    const settled = (await store.reserveBudget(res())).reservation;
    await store.settleBudget(settled.id, 1, {});
  } finally { await store.close(); }
  const again = new Store({ host: HOST, database: "postgres", user: "fcpi_retrieval" });
  try {
    const swept = await again.ready({ url: 2, browser: 1 }, new Date(Date.now() + 1000));
    assert.equal(swept.orphaned, 0, "no model calls among them");
    assert.deepEqual(Object.values(swept.orphanedOperations).reduce((n, x) => n + x.count, 0), 4);
    const states = (await again.pool.query("SELECT kind, state FROM fcpi_retrieval.budget_reservation ORDER BY kind, state")).rows.map((r) => `${r.kind}:${r.state}`);
    assert.deepEqual(states, ["decision:UNCERTAIN", "docs_read:UNCERTAIN", "docs_search:UNCERTAIN", "search:SETTLED", "search:UNCERTAIN"]);
    assert.deepEqual(await usage(again), { "search_brave/day": "4+1", "search_brave/month": "4+1" }, "uncertain operations keep their whole reservation");
  } finally { await again.close(); }
});

test("provider availability survives a restart and is replaced whole, keeping a balance observation until a new one", opts, async () => {
  const store = await fresh();
  try {
    await store.setAvailability({ provider: "tavily", state: "quota_exhausted", reason: "plan_or_key_limit", providerCode: "plan_or_key_limit", credentialEpoch: "e1", balance: { value: 0, unit: "credits", source: "provider_reported_remaining" } });
    await store.setAvailability({ provider: "brave", state: "rate_limited", retryAt: new Date(Date.now() + 1000), retryBasis: "documented", credentialEpoch: "e2" });
  } finally { await store.close(); }
  const again = new Store({ host: HOST, database: "postgres", user: "fcpi_retrieval" });
  try {
    const rows = await again.availabilityRows();
    assert.deepEqual(rows.map((r) => `${r.provider}:${r.state}:${r.retry_basis}`), ["brave:rate_limited:documented", "tavily:quota_exhausted:unknown"]);
    await again.setAvailability({ provider: "tavily", state: "available", reason: "operator_reenable" });
    const t = (await again.availabilityRows()).find((r) => r.provider === "tavily");
    assert.deepEqual([t.state, t.reason, t.balance.source], ["available", "operator_reenable", "provider_reported_remaining"]);
    await assert.rejects(again.setAvailability({ provider: "x", state: "exhausted-ish" }), /provider_availability_state_check/);
  } finally { await again.close(); }
});

test("pruning keeps every row of a lifetime-allocation category and prunes old settled rows of the others", opts, async () => {
  const store = await fresh();
  try {
    const serper = (await store.reserveBudget(res({ category: "serper_trial", unit: "credits", caps: { month: 2443 }, reportingPeriods: undefined, lifetimeCap: 2443, provider: "serper", subject: "serper-google" }))).reservation;
    const brave = (await store.reserveBudget(res())).reservation;
    await store.settleBudget(serper.id, 1, {});
    await store.settleBudget(brave.id, 1, {});
    await store.pool.query("UPDATE fcpi_retrieval.budget_reservation SET created_at = now() - interval '120 days'");
    await store.prune({ retainCategories: ["serper_trial"] });
    const left = (await store.pool.query("SELECT category FROM fcpi_retrieval.budget_reservation")).rows.map((r) => r.category);
    assert.deepEqual(left, ["serper_trial"]);
    // The spent credit still counts against the allocation.
    const again = await store.reserveBudget(res({ category: "serper_trial", unit: "credits", caps: { month: 2443 }, reportingPeriods: undefined, lifetimeCap: 1, provider: "serper", subject: "serper-google" }));
    assert.equal(again.exhausted?.period, "allocation");
  } finally { await store.close(); }
});

test("the schema applies over a populated baseline database and again, keeping every historical row", opts, async () => {
  await admin(async (c) => {
    await c.query("DROP SCHEMA IF EXISTS fcpi_retrieval CASCADE");
    await c.query("CREATE SCHEMA IF NOT EXISTS nuq");
    await c.query(readFileSync(BASELINE, "utf8"));
    await c.query(`INSERT INTO fcpi_retrieval.budget_reservation (id, call_key, logical_id, category, provider, subject, kind, unit, rate_card, request_hash, reserved, actual, state, day_start, month_start, paid_total, periods)
      VALUES (gen_random_uuid(), 'search:old', 'old', 'serper_trial', 'serper', 'serper-google', 'search', 'credits', 'serper/trial-search@2026-10-15', 'h', 1, 1, 'SETTLED', '2026-10-15', '2026-10-01', false, '{month}'),
             (gen_random_uuid(), 'extract:old', 'old2', 'llm', 'anthropic', 'claude-haiku-5-5', 'extract', 'micro_usd', 'card', 'h', 500, null, 'UNCERTAIN', '2026-10-15', '2026-10-01', true, '{month}')`);
    await c.query("INSERT INTO fcpi_retrieval.search_cache (key, response, expires_at) VALUES ('legacy-key', '{\"results\":[]}', now() + interval '1 hour')");
    await c.query(readFileSync(SCHEMA, "utf8"));
    await c.query(readFileSync(SCHEMA, "utf8"));
    const kept = (await c.query("SELECT call_key, state FROM fcpi_retrieval.budget_reservation ORDER BY call_key")).rows.map((r) => `${r.call_key}:${r.state}`);
    assert.deepEqual(kept, ["extract:old:UNCERTAIN", "search:old:SETTLED"]);
    assert.equal((await c.query("SELECT count(*)::int AS n FROM fcpi_retrieval.search_cache")).rows[0].n, 1);
    const checks = (await c.query("SELECT conname, pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conrelid = 'fcpi_retrieval.budget_reservation'::regclass AND conname IN ('budget_reservation_kind_check', 'budget_reservation_unit_check') ORDER BY conname")).rows;
    assert.match(checks[0].def, /docs_search.*docs_read.*decision/);
    assert.match(checks[1].def, /requests/);
    // The service's role has DML on the new table and nothing more.
    const grants = (await c.query("SELECT privilege_type FROM information_schema.role_table_grants WHERE grantee = 'fcpi_retrieval' AND table_name = 'provider_availability' ORDER BY 1")).rows.map((r) => r.privilege_type);
    assert.deepEqual(grants, ["DELETE", "INSERT", "SELECT", "UPDATE"]);
  });
});
