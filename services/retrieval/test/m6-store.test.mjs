// M6's store SQL against a throwaway PostgreSQL (FCPI_TEST_PG): routing records, the exclusive probe, route holds,
// residential pacing beside the direct caps, proxy reservations racing one cap, and reconciliation's adjustment and
// settlement of uncertain rows. Skipped when no test database is named.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import pg from "pg";
import { Store } from "../src/store.mjs";

const HOST = process.env.FCPI_TEST_PG;
const opts = { skip: HOST ? false : "no test database (FCPI_TEST_PG unset)" };
const routing = { maxRecords: 3, observationsToChange: 2, ttlHours: 24, maxTtlDays: 7, probeMinutes: 5 };
async function fresh() {
  const admin = new pg.Client({ host: HOST, user: "postgres", database: "postgres" });
  await admin.connect();
  await admin.query("CREATE SCHEMA IF NOT EXISTS nuq");
  await admin.query(readFileSync(new URL("../schema.sql", import.meta.url), "utf8"));
  await admin.query("TRUNCATE fcpi_retrieval.domain_route, fcpi_retrieval.route_hold, fcpi_retrieval.domain_state, fcpi_retrieval.direct_nav, fcpi_retrieval.budget_usage, fcpi_retrieval.budget_reservation, fcpi_retrieval.proxy_reconciliation");
  await admin.end();
  const store = new Store({ host: HOST, database: "postgres", user: "fcpi_retrieval" });
  await store.ready({ url: 2, browser: 1 });
  return store;
}
const sql = async (q, a = []) => { const c = new pg.Client({ host: HOST, user: "postgres", database: "postgres" }); await c.connect(); try { return (await c.query(q, a)).rows; } finally { await c.end(); } };

test("routing records: two challenges set a preference; auth outcomes only count; the table stays within its bound", opts, async () => {
  const store = await fresh();
  try {
    const obs = { tier: "direct", mode: "http", outcome: "challenge" };
    await store.learnRoute("a.example", obs, routing, { success: false, failureClass: "BLOCKED_PUBLIC_CONTENT" });
    assert.equal((await store.routeRecord("a.example")).preferred, null);
    const r = await store.learnRoute("a.example", obs, routing, { success: false, failureClass: "BLOCKED_PUBLIC_CONTENT" });
    assert.equal(r.row.preferred, "residential");
    assert.equal(r.row.last_reason, "consistent_challenges");
    assert.equal(Number(r.row.failures), 2);
    const [{ hours }] = await sql("SELECT round(extract(epoch FROM expires_at - set_at) / 3600) AS hours FROM fcpi_retrieval.domain_route WHERE domain = 'a.example'");
    assert.equal(Number(hours), 24);
    // An auth gate is a failure counted, never a preference.
    await store.learnRoute("gate.example", null, routing, { success: false, failureClass: "AUTH_REQUIRED" });
    const g = await store.routeRecord("gate.example");
    assert.equal(g.preferred, null);
    assert.equal(g.last_failure_class, "AUTH_REQUIRED");
    // maxRecords 3: a fourth domain removes the least recently updated.
    await store.learnRoute("b.example", null, routing, { success: true });
    await store.learnRoute("c.example", null, routing, { success: true });
    const [{ n }] = await sql("SELECT count(*)::int AS n FROM fcpi_retrieval.domain_route");
    assert.equal(n, 3);
    assert.equal(await store.routeRecord("a.example"), null, "the oldest row went");
  } finally { await store.close(); }
});

test("after expiry one probe is claimed at a time, and a hold is finite and released by its job", opts, async () => {
  const store = await fresh();
  try {
    await sql("INSERT INTO fcpi_retrieval.domain_route (domain, preferred, set_at, expires_at) VALUES ('p.example', 'residential', now() - interval '25 hours', now() - interval '1 hour')");
    const claims = await Promise.all(Array.from({ length: 5 }, () => store.claimProbe("p.example", 5)));
    assert.equal(claims.filter(Boolean).length, 1);
    await sql("UPDATE fcpi_retrieval.domain_route SET probe_at = now() - interval '6 minutes' WHERE domain = 'p.example'");
    assert.equal(await store.claimProbe("p.example", 5), true, "a probe that never reported lapses");
    // A live preference is not probed.
    await sql("INSERT INTO fcpi_retrieval.domain_route (domain, preferred, set_at, expires_at) VALUES ('live.example', 'residential', now(), now() + interval '1 hour')");
    assert.equal(await store.claimProbe("live.example", 5), false);

    await store.holdRoutes("job-1", ["h.example", "i.example"], new Date(Date.now() + 60000), "bulk");
    assert.equal(await store.routeHeld("h.example"), true);
    await store.holdRoutes("job-2", ["j.example"], new Date(Date.now() - 1000), "bulk");
    assert.equal(await store.routeHeld("j.example"), false, "a hold past its end holds nothing");
    assert.equal(await store.releaseRoutes("job-1"), 2);
    assert.equal(await store.routeHeld("h.example"), false);
  } finally { await store.close(); }
});

test("residential navigations share the domain's gap and hold but are not counted against the direct caps", opts, async () => {
  const store = await fresh();
  try {
    const limits = { perDomainInFlight: 1, minNavigationGapMs: 0, perDomainPerHour: 1, platformPerDay: 200 };
    const h1 = randomUUID();
    assert.equal((await store.paceDirect("r.example", h1, limits, 30000, false, "direct")).go, true);
    // The direct cap (1 an hour) is spent, and the domain is still held: a residential navigation waits for the hold.
    const held = await store.paceDirect("r.example", randomUUID(), limits, 30000, false, "residential");
    assert.ok(held.waitMs > 0);
    await store.releaseDomain("r.example", h1);
    assert.equal((await store.paceDirect("r.example", randomUUID(), limits, 30000, false, "residential")).go, true);
    const capped = await store.paceDirect("r.example", randomUUID(), limits, 30000, false, "direct");
    assert.equal(capped.failure?.class, "PROXY_REQUIRED");
    assert.equal(capped.failure.directCap, "domain_hour");
    const [{ n }] = await sql("SELECT count(*)::int AS n FROM fcpi_retrieval.direct_nav WHERE domain = 'r.example'");
    assert.equal(n, 1, "only the direct navigation was counted");
  } finally { await store.close(); }
});

test("eight concurrent proxy reservations on a cap with room for three: exactly three", opts, async () => {
  const store = await fresh();
  try {
    const day = new Date().toISOString().slice(0, 10), month = `${day.slice(0, 7)}-01`;
    const rs = await Promise.all(Array.from({ length: 8 }, (_, i) => store.reserveBudget({ id: randomUUID(), callKey: `proxy:${i}`, logicalId: `l${i}`, category: "fixture_proxy_race", provider: "fixture-proxy",
      subject: "fcpi-fixture-proxy-race", kind: "proxy", unit: "micro_usd", rateCard: "fixture/fcpi-fixture-proxy-race@2026-09-26", requestHash: "bytes:10000000", amount: 40000,
      caps: { day: 130000 }, paidTotalCap: null, paidTotalRate: 1, day, month, notifyAt: 0.8 })));
    assert.equal(rs.filter((r) => r.reservation).length, 3);
    assert.equal(rs.filter((r) => r.exhausted).length, 5);
  } finally { await store.close(); }
});

test("reconciliation: an adjustment settles past the cap, uncertain rows settle at their measured bytes", opts, async () => {
  const store = await fresh();
  try {
    const day = new Date().toISOString().slice(0, 10), month = `${day.slice(0, 7)}-01`;
    const base = { provider: "fixture-proxy", subject: "fcpi-fixture-proxy", kind: "proxy", unit: "micro_usd", rateCard: "fixture/fcpi-fixture-proxy@2026-09-26", requestHash: "bytes:1", caps: { day: 100000 }, paidTotalCap: null, paidTotalRate: 1, day, month, notifyAt: 0.8, category: "fixture_proxy" };
    const a = await store.reserveBudget({ ...base, id: randomUUID(), callKey: "proxy:a", logicalId: "a", amount: 40000 });
    await store.settleBudget(a.reservation.id, 400, { usage: { bytes: 100000 } });
    const b = await store.reserveBudget({ ...base, id: randomUUID(), callKey: "proxy:b", logicalId: "b", amount: 40000 });
    await store.markBudgetUncertain(b.reservation.id, "broke", { bytes: 50000 });
    const d = await store.proxyDay("fixture-proxy", day);
    assert.deepEqual([d.settledBytes, d.uncertainBytes, d.uncertain], [100000, 50000, 1]);
    await store.recordAdjustment({ id: randomUUID(), callKey: `reconcile:fixture-proxy:${day}:x`, category: "fixture_proxy", provider: "fixture-proxy", subject: "fcpi-fixture-proxy",
      rateCard: "fixture/fcpi-fixture-proxy@2026-09-26", amount: 90000, day, paidTotal: false, usage: { reportedBytes: 1, measuredBytes: 0 } });
    const n = await store.settleUncertainProxy("fixture-proxy", day, (bytes) => Math.ceil(bytes * 4000000 / 1e9));
    assert.equal(n, 1);
    const [u] = await sql("SELECT reserved::int, settled::int FROM fcpi_retrieval.budget_usage WHERE category = 'fixture_proxy' AND period = 'day'");
    assert.equal(u.reserved, 0);
    assert.equal(u.settled, 400 + 90000 + 200, "the adjustment counts even past the 100,000 cap");
    const states = (await sql("SELECT kind, state FROM fcpi_retrieval.budget_reservation ORDER BY created_at")).map((r) => `${r.kind}:${r.state}`);
    assert.deepEqual(states, ["proxy:SETTLED", "proxy:SETTLED", "reconcile:SETTLED"]);
  } finally { await store.close(); }
});

test("reconciling a day twice charges its difference once; a later report charges only what it added; a day in flight waits (review C1)", opts, async () => {
  const { startFixture, m6Policy, m6Budget, CRED } = await import("./m6-helpers.mjs");
  const { providersDir } = await import("./m5-helpers.mjs");
  const { reconcileDay } = await import("../src/reconcile.mjs");
  const store = await fresh();
  const fx = await startFixture();
  try {
    const day = new Date().toISOString().slice(0, 10), month = `${day.slice(0, 7)}-01`;
    const budget = m6Budget(fx), policy = m6Policy(fx);
    const args = { store, getBudget: () => budget, providersDir: providersDir({ fixture_proxy: CRED }), providerName: "fixture-proxy", day, getPolicy: () => policy,
      resolvePublic: async () => [], lookupFixture: async () => ["127.0.0.1"], log: () => {} };
    const base = { provider: "fixture-proxy", subject: "fcpi-fixture-proxy", kind: "proxy", unit: "micro_usd", rateCard: "fixture/fcpi-fixture-proxy@2026-09-26", requestHash: "bytes:1", caps: { day: 20000000 }, paidTotalCap: null, paidTotalRate: 1, day, month, notifyAt: 0.8, category: "fixture_proxy" };
    const a = await store.reserveBudget({ ...base, id: randomUUID(), callKey: "proxy:a", logicalId: "a", amount: 40000 });
    await store.settleBudget(a.reservation.id, 400, { usage: { bytes: 100000 } });
    fx.state.usageByDay.set(day, 1100000);
    const first = await reconcileDay(args);
    assert.equal(first.adjustmentMicroUsd, 4000);
    const second = await reconcileDay(args);
    assert.equal(second.adjustmentMicroUsd, 0, "the same report charges nothing the second time");
    fx.state.usageByDay.set(day, 1350000);
    const third = await reconcileDay(args);
    assert.equal(third.adjustmentMicroUsd, 1000, "only the 250,000 bytes the report added");
    const rows = await sql("SELECT (usage->>'bytes')::bigint AS b FROM fcpi_retrieval.budget_reservation WHERE kind = 'reconcile' ORDER BY created_at");
    assert.deepEqual(rows.map((r) => Number(r.b)), [1000000, 250000]);
    await store.reserveBudget({ ...base, id: randomUUID(), callKey: "proxy:b", logicalId: "b", amount: 40000 });
    await assert.rejects(reconcileDay(args), (e) => e.failureClass === "RECONCILE_IN_FLIGHT");
  } finally { await fx.close(); await store.close(); }
});
