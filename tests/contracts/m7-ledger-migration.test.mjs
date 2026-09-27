// The gateway ledger's migration from schema version 2 (M5, M6) to version 3 (M7's artifacts, scrape cache, page
// versions and webhook outbox), against a throwaway PostgreSQL: a ledger in version 2's shape, holding a job, gains
// the four tables and version 3 when deploy/nuq-postgres/fcpi-platform-schema.sql is applied again, keeps its rows,
// and the gateway's role may use the new tables and nothing more. Run on the Pi in the gateway image
// (scripts/m7/pi-suites.sh):
//   FCPI_TEST_PG=<host[:port]> FCPI_GATEWAY_DIR=<dir holding node_modules> FCPI_TEST_SCHEMA=<schema file> node --test m7-ledger-migration.test.mjs
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
const M7 = ["artifact", "page_cache", "page_version", "webhook_event"];

test("a version-2 ledger gains M7's four tables and version 3 in place, keeps its jobs, and the gateway may use them", async () => {
  assert.ok(PGHOST, "FCPI_TEST_PG names the throwaway database");
  const name = `fcpi_m7_migration_${process.pid}`;
  const root = await client("postgres");
  await root.query(`CREATE DATABASE ${name}`);
  const db = await client(name);
  try {
    await db.query(`CREATE SCHEMA nuq; CREATE SCHEMA fcpi_retrieval;
      CREATE TABLE nuq.queue_scrape (id uuid PRIMARY KEY, data jsonb, created_at timestamptz NOT NULL DEFAULT now(), group_id uuid);
      CREATE TABLE nuq.queue_scrape_backlog (id uuid PRIMARY KEY, data jsonb, created_at timestamptz NOT NULL DEFAULT now(), group_id uuid);`);
    await db.query(SCHEMA);
    // Version 2's shape: none of M7's tables, version 3 not recorded, and a job in the ledger.
    await db.query(`${M7.map((t) => `DROP TABLE fcpi_platform.${t};`).join(" ")} DELETE FROM fcpi_platform.schema_version WHERE version = 3;`);
    const id = randomUUID();
    await db.query(`INSERT INTO fcpi_platform.job (id, principal, client_label, kind, state, submission_key, request_hash, request, units, metadata_expire_at)
      VALUES ($1, 'p', 'l', 'crawl', 'RECEIVED', $2, 'h', '{}', 1, now() + interval '30 days')`, [id, `fcpi:${id}`]);
    assert.equal((await db.query("SELECT max(version) AS v FROM fcpi_platform.schema_version")).rows[0].v, 2);
    await db.query(SCHEMA);
    assert.equal((await db.query("SELECT max(version) AS v FROM fcpi_platform.schema_version")).rows[0].v, 3);
    const tables = (await db.query("SELECT relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE nspname = 'fcpi_platform' AND relkind = 'r' AND relname = ANY($1) ORDER BY relname", [M7])).rows.map((r) => r.relname);
    assert.deepEqual(tables, [...M7].sort());
    assert.equal((await db.query("SELECT count(*)::int AS n FROM fcpi_platform.job WHERE id = $1", [id])).rows[0].n, 1, "the job is kept");
    for (const t of M7) {
      const rights = (await db.query("SELECT has_table_privilege('fcpi_gateway', $1, 'SELECT,INSERT,UPDATE,DELETE') AS dml, has_table_privilege('fcpi_gateway', $1, 'TRUNCATE') AS trunc", [`fcpi_platform.${t}`])).rows[0];
      assert.deepEqual(rights, { dml: true, trunc: false }, t);
    }
    // The outbox allows one event per job and type.
    const ev = (eid) => db.query("INSERT INTO fcpi_platform.webhook_event (id, job_id, principal, type, destination, body, state) VALUES ($1, $2, 'p', 'crawl.completed', 'http://h/', '{}', 'PENDING')", [eid, id]);
    await ev(randomUUID());
    await assert.rejects(ev(randomUUID()), /duplicate key/);
    // Its type is one the gateway raises and its attempts never negative (review S8); the schema still applies again
    // over a table that has the checks, and the event already stored satisfies them.
    const odd = (type, attempts = 0) => db.query("INSERT INTO fcpi_platform.webhook_event (id, job_id, principal, type, destination, body, state, attempts) VALUES ($1, $2, 'p', $3, 'http://h/', '{}', 'PENDING', $4)", [randomUUID(), id, type, attempts]);
    await assert.rejects(odd("crawl.exploded"), /webhook_event_type_check/);
    await assert.rejects(odd("crawl.started", -1), /webhook_event_attempts_check/);
    await odd("batch_scrape.started");
    await db.query(SCHEMA);
    await assert.rejects(odd("extract.page"), /webhook_event_type_check/);
  } finally {
    await db.end();
    await root.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
    await root.end();
  }
});
