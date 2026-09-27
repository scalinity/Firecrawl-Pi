// M7's gateway ledger SQL (services/access/src/store.mjs) against a throwaway PostgreSQL, as the gateway's own role:
// a job's webhook events raised in its transitions' own transactions, once per type and only those asked for; the
// outbox's lease, backoff, dead letter and delivery; cache reads bound to principal, request and freshness; artifacts
// bound to their principal and their expiry; every content table counted by the quota and kept by the sweep; and
// retention. Run on the Pi in the gateway image (scripts/m7/pi-suites.sh):
//   FCPI_TEST_PG=<host[:port]> FCPI_GATEWAY_DIR=<dir holding src and node_modules> FCPI_TEST_SCHEMA=<schema file> FCPI_TEST_MANIFEST=<manifest> node --test m7-gateway-store.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { randomUUID } from "node:crypto";

const HERE = dirname(fileURLToPath(import.meta.url));
const GW_DIR = process.env.FCPI_GATEWAY_DIR ?? join(HERE, "../../services/access");
const SCHEMA = readFileSync(process.env.FCPI_TEST_SCHEMA ?? join(HERE, "../../deploy/nuq-postgres/fcpi-platform-schema.sql"), "utf8").split("\n").filter((l) => !l.startsWith("\\")).join("\n");
const MANIFEST = JSON.parse(readFileSync(process.env.FCPI_TEST_MANIFEST ?? join(HERE, "../../deploy/policies/capabilities.json"), "utf8"));
const pg = createRequire(join(GW_DIR, "package.json"))("pg");
const { makeStore } = await import(pathToFileURL(join(GW_DIR, "src/store.mjs")).href);
const [PGHOST, PGPORT = "5432"] = (process.env.FCPI_TEST_PG ?? "").split(":");
const sha = (c) => c.repeat(64);

async function rig() {
  assert.ok(PGHOST, "FCPI_TEST_PG names the throwaway database");
  const name = `fcpi_m7_store_${process.pid}_${Math.floor(Math.random() * 1e6)}`;
  const root = new pg.Client({ host: PGHOST, port: Number(PGPORT), user: "postgres", database: "postgres" });
  await root.connect();
  await root.query(`CREATE DATABASE ${name}`);
  const admin = new pg.Client({ host: PGHOST, port: Number(PGPORT), user: "postgres", database: name });
  await admin.connect();
  await admin.query(`CREATE SCHEMA nuq; CREATE SCHEMA fcpi_retrieval;
    CREATE TABLE nuq.queue_scrape (id uuid PRIMARY KEY, data jsonb, created_at timestamptz NOT NULL DEFAULT now(), group_id uuid);
    CREATE TABLE nuq.queue_scrape_backlog (id uuid PRIMARY KEY, data jsonb, created_at timestamptz NOT NULL DEFAULT now(), group_id uuid);`);
  await admin.query(SCHEMA);
  const store = makeStore({ db: { host: PGHOST, port: Number(PGPORT), database: name, user: "fcpi_gateway", password: "unused-with-trust" }, manifest: MANIFEST });
  const sql = async (q, a = []) => (await admin.query(q, a)).rows;
  const close = async () => { await store.close(); await admin.end(); await root.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`); await root.end(); };
  return { store, sql, close };
}
const INSTANCE = randomUUID();
const admit = (store, principal, body, kind = "crawl") => store.admit({ principal, clientLabel: "t", kind, body, hash: randomUUID(), units: 1, idemKey: undefined, quotaBytes: 1e12 });

test("a job's webhook events are raised in its transitions, once per type, only those asked for, and never for a job without one", async () => {
  const { store, sql, close } = await rig();
  try {
    const hook = { url: "http://hooks.fixture.fcpi.test:8080/receive", metadata: { run: "m7" } };
    const { job } = await admit(store, "owner", { url: "https://a.example/", webhook: hook });
    const claimed = await store.claimNext(INSTANCE);
    assert.equal(claimed.id, job.id);
    await store.markSubmitted(job.id, randomUUID(), 30, "ok");
    await store.progress(job.id, { status: "scraping", completed: 0, total: 1, creditsUsed: 0 });
    await store.finish(job.id, "SUCCEEDED", { status: "completed", completed: 1, total: 1 }, "done");
    const events = await sql("SELECT type, state, principal, destination, body FROM fcpi_platform.webhook_event WHERE job_id = $1 ORDER BY created_at", [job.id]);
    assert.deepEqual(events.map((e) => e.type), ["crawl.started", "crawl.completed"], "QUEUED then RUNNING raise one started");
    assert.deepEqual(JSON.parse(events[1].body).metadata, { run: "m7" });
    assert.equal(JSON.parse(events[1].body).id, job.id);
    assert.ok(events.every((e) => e.state === "PENDING" && e.principal === "owner" && e.destination === hook.url));
    // Only the events asked for; a failed job's failure is in its event.
    const { job: j2 } = await admit(store, "owner", { url: "https://b.example/", webhook: { ...hook, events: ["failed"] } });
    await store.claimNext(INSTANCE);
    await store.markRejected(j2.id, 400, "BAD", "refused by the core");
    const e2 = await sql("SELECT type, body FROM fcpi_platform.webhook_event WHERE job_id = $1", [j2.id]);
    assert.deepEqual(e2.map((e) => e.type), ["crawl.failed"]);
    assert.equal(JSON.parse(e2[0].body).error, "refused by the core");
    const { job: j3 } = await admit(store, "owner", { url: "https://c.example/" });
    await store.claimNext(INSTANCE);
    await store.markRejected(j3.id, 400, "BAD", "x");
    assert.equal((await sql("SELECT count(*)::int AS n FROM fcpi_platform.webhook_event WHERE job_id = $1", [j3.id]))[0].n, 0);
  } finally { await close(); }
});

test("the outbox: a claim leases its events, a failure backs off and dies after its attempts, a delivery ends the event", async () => {
  const { store, sql, close } = await rig();
  try {
    const { job } = await admit(store, "owner", { url: "https://a.example/", webhook: { url: "http://h/", events: ["started"] } });
    await store.claimNext(INSTANCE);
    await store.markSubmitted(job.id, randomUUID(), 30, "ok");
    const [e] = await store.claimWebhooks(5, 60);
    assert.equal(e.type, "crawl.started");
    assert.deepEqual(await store.claimWebhooks(5, 60), [], "a leased event is not claimed twice");
    await store.webhookFailed(e.id, { status: 500, error: "WEBHOOK_REFUSED", maxAttempts: 2, retryBaseS: 30 });
    let [row] = await sql("SELECT state, attempts, last_status, extract(epoch FROM next_at - now())::int AS wait FROM fcpi_platform.webhook_event WHERE id = $1", [e.id]);
    assert.deepEqual([row.state, row.attempts, row.last_status], ["PENDING", 1, 500]);
    assert.ok(row.wait >= 28 && row.wait <= 30, `the first retry waits the base (${row.wait} s)`);
    await store.webhookFailed(e.id, { status: 500, error: "WEBHOOK_REFUSED", maxAttempts: 2, retryBaseS: 30 });
    [row] = await sql("SELECT state, attempts FROM fcpi_platform.webhook_event WHERE id = $1", [e.id]);
    assert.deepEqual([row.state, row.attempts], ["DEAD", 2], "dead after its attempts, and kept");
    assert.equal((await store.jobWebhooks(job.id))[0].state, "DEAD");
    // A deferral counts no attempt; a delivery ends the event.
    await sql("UPDATE fcpi_platform.webhook_event SET state = 'PENDING', attempts = 0, next_at = now() WHERE id = $1", [e.id]);
    await store.webhookDefer(e.id, 60, "WEBHOOKS_SUPPRESSED");
    [row] = await sql("SELECT attempts FROM fcpi_platform.webhook_event WHERE id = $1", [e.id]);
    assert.equal(row.attempts, 0);
    await store.webhookDelivered(e.id, 200);
    [row] = await sql("SELECT state, attempts, delivered_at IS NOT NULL AS at FROM fcpi_platform.webhook_event WHERE id = $1", [e.id]);
    assert.deepEqual([row.state, row.attempts, row.at], ["DELIVERED", 1, true]);
  } finally { await close(); }
});

test("the cache is read only by its principal, for its request, within the freshness asked; artifacts only by their principal, and not once expired", async () => {
  const { store, sql, close } = await rig();
  try {
    const key = sha("a");
    await store.cachePut("owner", key, sha("1"), 100, 3600);
    assert.ok(await store.cacheGet("owner", key, 60000));
    assert.equal(await store.cacheGet("guest", key, 60000), null, "another principal's request never reads it");
    assert.equal(await store.cacheGet("owner", sha("b"), 60000), null, "another request never reads it");
    await sql("UPDATE fcpi_platform.page_cache SET created_at = now() - interval '2 minutes'");
    assert.equal(await store.cacheGet("owner", key, 60000), null, "older than maxAge");
    assert.ok(await store.cacheGet("owner", key, 180000));
    await sql("UPDATE fcpi_platform.page_cache SET expires_at = now() - interval '1 second'");
    assert.equal(await store.cacheGet("owner", key, 3600000), null, "past its lifetime");
    const id = randomUUID();
    await store.addArtifacts([{ id, principal: "owner", sha256: sha("2"), bytes: 10, mime: "image/png", width: 1280, height: 800, truncated: false }]);
    assert.equal((await store.getArtifact(id, "owner")).expired, false);
    assert.equal(await store.getArtifact(id, "guest"), null);
    await sql("UPDATE fcpi_platform.artifact SET expires_at = now() - interval '1 second'");
    assert.equal((await store.getArtifact(id, "owner")).expired, true);
  } finally { await close(); }
});

test("every content table is counted by the quota and kept by the archive's sweep; expired rows go at retention", async () => {
  const { store, sql, close } = await rig();
  try {
    await store.addArtifacts([{ id: randomUUID(), principal: "o", sha256: sha("3"), bytes: 7, mime: "image/png", width: 1, height: 1, truncated: false }]);
    await store.cachePut("o", sha("c"), sha("4"), 11, 3600);
    await store.versionPut({ principal: "o", key: sha("d"), url: "https://a.example/", sha256: sha("5"), bytes: 13, normalizedSha256: sha("6") });
    assert.equal(await store.archiveBytes(), 31);
    assert.deepEqual([...(await store.referenced([sha("3"), sha("4"), sha("5"), sha("9")]))].sort(), [sha("3"), sha("4"), sha("5")]);
    await sql("UPDATE fcpi_platform.artifact SET expires_at = now() - interval '1 second'");
    await sql("UPDATE fcpi_platform.page_cache SET expires_at = now() - interval '1 second'");
    const r = await store.sweep();
    assert.deepEqual([r.artifact, r.page_cache, r.page_version], [1, 1, 0]);
    assert.equal(await store.archiveBytes(), 13);
    assert.equal(await store.schemaVersion(), 3);
  } finally { await close(); }
});
