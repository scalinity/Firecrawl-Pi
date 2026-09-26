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
