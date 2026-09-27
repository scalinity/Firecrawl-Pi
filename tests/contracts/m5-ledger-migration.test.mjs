// The gateway ledger's migration from schema version 1 (M3, M4) to version 2 (M5's extraction jobs), against
// a throwaway PostgreSQL: a ledger in version 1's shape, holding a job, gains the extract kind and version 2
// when deploy/nuq-postgres/fcpi-platform-schema.sql is applied again, and keeps its rows. Run on the Pi in
// the gateway image (scripts/m5/pi-suites.sh):
//   FCPI_TEST_PG=<host[:port]> FCPI_GATEWAY_DIR=<dir holding node_modules> FCPI_TEST_SCHEMA=<schema file> node --test m5-ledger-migration.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";

const HERE = dirname(fileURLToPath(import.meta.url));
const GW_DIR = process.env.FCPI_GATEWAY_DIR ?? join(HERE, "../../services/access");
const SCHEMA = readFileSync(process.env.FCPI_TEST_SCHEMA ?? join(HERE, "../../deploy/nuq-postgres/fcpi-platform-schema.sql"), "utf8").split("\n").filter((l) => !l.startsWith("\\")).join("\n");
const pg = createRequire(join(GW_DIR, "package.json"))("pg");
const [PGHOST, PGPORT = "5432"] = (process.env.FCPI_TEST_PG ?? "").split(":");
const client = async (database) => { const c = new pg.Client({ host: PGHOST, port: Number(PGPORT), user: "postgres", database }); await c.connect(); return c; };

test("a version-1 ledger gains the extract kind and version 2 in place, and keeps its jobs (review W15)", async () => {
  assert.ok(PGHOST, "FCPI_TEST_PG names the throwaway database");
  const name = `fcpi_m5_migration_${process.pid}`;
  const root = await client("postgres");
  await root.query(`CREATE DATABASE ${name}`);
  const db = await client(name);
  try {
    await db.query(`CREATE SCHEMA nuq; CREATE SCHEMA fcpi_retrieval;
      CREATE TABLE nuq.queue_scrape (id uuid PRIMARY KEY, data jsonb, created_at timestamptz NOT NULL DEFAULT now(), group_id uuid);
      CREATE TABLE nuq.queue_scrape_backlog (id uuid PRIMARY KEY, data jsonb, created_at timestamptz NOT NULL DEFAULT now(), group_id uuid);`);
    await db.query(SCHEMA);
    // Version 1's shape: crawl and batch jobs only, version 2 not yet recorded, and a job in the ledger.
    await db.query(`ALTER TABLE fcpi_platform.job DROP CONSTRAINT job_kind_check;
      ALTER TABLE fcpi_platform.job ADD CONSTRAINT job_kind_check CHECK (kind IN ('crawl', 'batch'));
      DELETE FROM fcpi_platform.schema_version WHERE version >= 2;`);
    const insert = (kind) => db.query(`INSERT INTO fcpi_platform.job (id, principal, client_label, kind, state, submission_key, request_hash, request, units, metadata_expire_at)
      VALUES ($1, 'p', 'l', $2, 'RECEIVED', $3, 'h', '{}', 1, now() + interval '30 days')`, [randomUUID(), kind, `fcpi:${randomUUID()}`]);
    await insert("crawl");
    await assert.rejects(insert("extract"), /job_kind_check/, "version 1 has no extract kind");
    assert.equal((await db.query("SELECT max(version) AS v FROM fcpi_platform.schema_version")).rows[0].v, 1);
    // The schema applied again, as scripts/m3/pi-platform-db.sh applies it at every bring-up.
    await db.query(SCHEMA);
    // Version 2 is recorded (later versions, M7's 3 among them, are recorded beside it).
    assert.equal((await db.query("SELECT count(*)::int AS n FROM fcpi_platform.schema_version WHERE version = 2")).rows[0].n, 1);
    await insert("extract");
    assert.deepEqual((await db.query("SELECT kind FROM fcpi_platform.job ORDER BY kind")).rows.map((r) => r.kind), ["crawl", "extract"]);
  } finally {
    await db.end();
    await root.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
    await root.end();
  }
});
