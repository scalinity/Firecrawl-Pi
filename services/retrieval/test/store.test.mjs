// The Store's SQL against a throwaway PostgreSQL (FCPI_TEST_PG names its host; the runner starts
// the pinned postgres image on an internal network with trust authentication and removes it after).
// Skipped when no test database is named, so the rest of the suite runs anywhere.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import pg from "pg";
import { Store } from "../src/store.mjs";

const HOST = process.env.FCPI_TEST_PG;
const opts = { skip: HOST ? false : "no test database (FCPI_TEST_PG unset)" };
const direct = { perDomainInFlight: 1, minNavigationGapMs: 0, perDomainPerHour: 20, platformPerDay: 200 };

async function fresh() {
  const admin = new pg.Client({ host: HOST, user: "postgres", database: "postgres" });
  await admin.connect();
  await admin.query("CREATE SCHEMA IF NOT EXISTS nuq");
  await admin.query(readFileSync(new URL("../schema.sql", import.meta.url), "utf8"));
  await admin.query("TRUNCATE fcpi_retrieval.acquisition, fcpi_retrieval.attempt, fcpi_retrieval.permit, fcpi_retrieval.domain_state, fcpi_retrieval.direct_nav");
  await admin.end();
  const store = new Store({ host: HOST, database: "postgres", user: "fcpi_retrieval", password: "unused-under-trust" });
  await store.ready({ url: 2, browser: 1 });
  return store;
}
const sql = async (q, a = []) => { const c = new pg.Client({ host: HOST, user: "postgres", database: "postgres" }); await c.connect(); try { return (await c.query(q, a)).rows; } finally { await c.end(); } };

test("the platform's daily cap holds under concurrent pacers of different domains (review finding W4)", opts, async () => {
  const store = await fresh();
  try {
    await sql("INSERT INTO fcpi_retrieval.direct_nav (domain, fixture) SELECT 'old-' || g || '.example', false FROM generate_series(1, 199) g");
    const results = await Promise.all(Array.from({ length: 6 }, (_, i) => store.paceDirect(`d${i}.example`, crypto.randomUUID(), direct, 30000, false)));
    assert.equal(results.filter((r) => r.go).length, 1);
    assert.equal(results.filter((r) => r.failure?.class === "PROXY_REQUIRED").length, 5);
    assert.equal(Number((await sql("SELECT count(*) FROM fcpi_retrieval.direct_nav WHERE NOT fixture"))[0].count), 200);
  } finally { await store.close(); }
});

test("permits: slot 0 is a slot, a full kind answers null, an expired lease is free again (review finding W9)", opts, async () => {
  const store = await fresh();
  try {
    const [a, b] = [crypto.randomUUID(), crypto.randomUUID()];
    assert.equal(await store.takePermit("url", a, 2, 60000), 0);
    assert.equal(await store.takePermit("url", b, 2, 60000), 1);
    assert.equal(await store.takePermit("url", crypto.randomUUID(), 2, 60000), null);
    await store.releasePermit("url", a);
    assert.equal(await store.takePermit("url", crypto.randomUUID(), 2, 60000), 0);
    assert.equal(await store.takePermit("browser", crypto.randomUUID(), 1, 1), 0);
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(await store.takePermit("browser", crypto.randomUUID(), 1, 60000), 0);
  } finally { await store.close(); }
});

test("ten concurrent reservations on one logical page get exactly four attempts", opts, async () => {
  const store = await fresh();
  try {
    await store.openAcquisition("race-1", "h", new Date(Date.now() + 60000));
    const r = await Promise.all(Array.from({ length: 10 }, () => store.reserveAttempt({ logicalId: "race-1", attemptId: crypto.randomUUID(), requestId: "r", purpose: "page", strategy: "direct_http", domain: "d", maxAttempts: 4 })));
    assert.deepEqual(r.filter((x) => x !== null).sort(), [1, 2, 3, 4]);
  } finally { await store.close(); }
});

test("a restart reclaims every lease and domain hold (review finding W3)", opts, async () => {
  const store = await fresh();
  await store.takePermit("url", crypto.randomUUID(), 2, 600000);
  await store.paceDirect("held.example", crypto.randomUUID(), direct, 600000, false);
  await store.close();
  const again = new Store({ host: HOST, database: "postgres", user: "fcpi_retrieval", password: "unused-under-trust" });
  try {
    await again.ready({ url: 2, browser: 1 });
    assert.equal(Number((await sql("SELECT count(*) FROM fcpi_retrieval.permit WHERE holder IS NOT NULL"))[0].count), 0);
    assert.equal(Number((await sql("SELECT count(*) FROM fcpi_retrieval.domain_state WHERE holder IS NOT NULL"))[0].count), 0);
  } finally { await again.close(); }
});

test("cooldowns: 60 s, then doubled on a recurrence; a short Retry-After does not seed the bare one (review finding W14)", opts, async () => {
  const store = await fresh();
  try {
    const s = async (d) => Number((await sql("SELECT cooldown_s FROM fcpi_retrieval.domain_state WHERE domain = $1", [d]))[0].cooldown_s);
    await store.coolDown("a.example", null); assert.equal(await s("a.example"), 60);
    await store.coolDown("a.example", null); assert.equal(await s("a.example"), 120);
    await store.coolDown("b.example", 1); assert.equal(await s("b.example"), 1);
    await store.coolDown("b.example", null); assert.equal(await s("b.example"), 60);
    await sql("UPDATE fcpi_retrieval.domain_state SET cooldown_s = 3600, cooldown_until = now() - interval '2 hours' WHERE domain = 'a.example'");
    await store.coolDown("a.example", null); assert.equal(await s("a.example"), 60);
  } finally { await store.close(); }
});

test("the pool connects within 5 s and bounds each statement at 10 s (review finding S13)", opts, async () => {
  const store = await fresh();
  try {
    assert.equal(store.pool.options.connectionTimeoutMillis, 5000);
    assert.equal((await store.pool.query("SHOW statement_timeout")).rows[0].statement_timeout, "10s");
  } finally { await store.close(); }
});

test("the prune removes only pacing rows that hold nothing a decision reads, and pacing recreates them (review finding S5)", opts, async () => {
  const store = await fresh();
  try {
    await sql(`INSERT INTO fcpi_retrieval.domain_state (domain, holder, hold_until, last_nav_at, cooldown_until, cooldown_s) VALUES
      ('idle.example', NULL, NULL, now() - interval '3 days', now() - interval '2 hours', 60),
      ('recent.example', NULL, NULL, now() - interval '1 hour', NULL, NULL),
      ('cooling.example', NULL, NULL, now() - interval '3 days', now() - interval '10 minutes', 120),
      ('held.example', gen_random_uuid(), now() + interval '60 seconds', now() - interval '3 days', NULL, NULL)`);
    await store.prune();
    assert.deepEqual((await sql("SELECT domain FROM fcpi_retrieval.domain_state ORDER BY domain")).map((r) => r.domain), ["cooling.example", "held.example", "recent.example"]);
    assert.equal((await store.paceDirect("idle.example", crypto.randomUUID(), direct, 30000, false)).go, true);
    assert.equal((await sql("SELECT count(*) FROM fcpi_retrieval.domain_state WHERE domain = 'idle.example'"))[0].count, "1");
    assert.equal((await sql("SELECT count(*) FROM pg_indexes WHERE schemaname = 'fcpi_retrieval' AND indexname = 'acquisition_updated_at'"))[0].count, "1");
  } finally { await store.close(); }
});

test("releasing a domain restarts its navigation gap", opts, async () => {
  const store = await fresh();
  try {
    const gap = { ...direct, minNavigationGapMs: 1500 }, h = crypto.randomUUID();
    assert.equal((await store.paceDirect("gap.example", h, gap, 30000, false)).go, true);
    await sql("UPDATE fcpi_retrieval.domain_state SET last_nav_at = now() - interval '10 seconds' WHERE domain = 'gap.example'"); // a decision long past
    await store.releaseDomain("gap.example", h);
    const d = await store.paceDirect("gap.example", crypto.randomUUID(), gap, 30000, false);
    assert.ok(d.waitMs > 1000, `the next navigation may go after ${d.waitMs ?? 0} ms`);
  } finally { await store.close(); }
});
