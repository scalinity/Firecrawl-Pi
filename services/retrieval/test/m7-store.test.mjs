// M7's ledger SQL against a throwaway PostgreSQL (FCPI_TEST_PG): the enhanced kind is accepted, a page's one dispatch
// cannot be reserved twice however many callers race on it, and its settled answer is read back for a retry. Skipped
// when no test database is named.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import pg from "pg";
import { Store } from "../src/store.mjs";

const HOST = process.env.FCPI_TEST_PG;
const opts = { skip: HOST ? false : "no test database (FCPI_TEST_PG unset)" };
async function fresh() {
  const admin = new pg.Client({ host: HOST, user: "postgres", database: "postgres" });
  await admin.connect();
  await admin.query("CREATE SCHEMA IF NOT EXISTS nuq");
  await admin.query(readFileSync(new URL("../schema.sql", import.meta.url), "utf8"));
  await admin.query("TRUNCATE fcpi_retrieval.budget_usage, fcpi_retrieval.budget_reservation");
  await admin.end();
  const store = new Store({ host: HOST, database: "postgres", user: "fcpi_retrieval" });
  await store.ready({ url: 2, browser: 1 });
  return store;
}

test("one logical page, eight racing callers: one enhanced reservation, the rest find it; its settled answer is read back", opts, async () => {
  const store = await fresh();
  try {
    const day = new Date().toISOString().slice(0, 10), month = `${day.slice(0, 7)}-01`;
    const base = { callKey: "enhanced:page-x", logicalId: "page-x", category: "fixture_enhanced", provider: "fixture-zyte", subject: "fcpi-fixture-zyte", kind: "enhanced", unit: "micro_usd",
      rateCard: "fixture/fcpi-fixture-zyte@2026-09-27", requestHash: "h", amount: 16080, caps: { day: 5000000 }, paidTotalCap: null, paidTotalRate: 1, day, month, notifyAt: 0.8 };
    const all = await Promise.all(Array.from({ length: 8 }, () => store.reserveBudget({ ...base, id: randomUUID() })));
    assert.equal(all.filter((r) => r.reservation).length, 1);
    assert.equal(all.filter((r) => r.existing).length, 7);
    const res = all.find((r) => r.reservation).reservation;
    const answer = { status: 200, finalUrl: "http://m7esc.fixture.fcpi.test:8080/tough", contentType: "text/html", html: "<main>ok</main>" };
    await store.settleBudget(res.id, 16080, { usage: { requests: 1, mode: "browser" }, result: { answer }, detail: "fixture" });
    const again = await store.reserveBudget({ ...base, id: randomUUID() });
    assert.equal(again.existing.state, "SETTLED");
    assert.deepEqual(again.existing.result.answer, answer);
    const [{ settled }] = (await store.budgetUsage(day, month)).filter((r) => r.category === "fixture_enhanced" && r.period === "day");
    assert.equal(settled, 16080, "the page was charged once");
  } finally { await store.close(); }
});
