// Contract suite for the gateway's /mcp route (M4): the real services/access/server.mjs with PI_MCP_URL
// pointing at a recording fake MCP service, so the order that matters is tested on the real server: the
// Host, Origin, token and body checks run before anything reaches the MCP service, the identity it
// receives is the one the gateway validated, and without PI_MCP_URL /mcp is no route at all. Needs a
// throwaway PostgreSQL, as the M3 contract suite does; runs on the Pi in the gateway image
// (scripts/m4/pi-mcp-tests.sh):
//   FCPI_TEST_PG=<host[:port]> FCPI_GATEWAY_DIR=<dir holding server.mjs and node_modules> node --test m4-gateway-mcp.test.mjs
// Without FCPI_TEST_PG the suite fails rather than skips.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer, request } from "node:http";
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const GW_DIR = process.env.FCPI_GATEWAY_DIR ?? join(HERE, "../../services/access");
const MANIFEST = readFileSync(process.env.FCPI_TEST_MANIFEST ?? join(HERE, "../../deploy/policies/capabilities.json"), "utf8");
const SCHEMA = readFileSync(process.env.FCPI_TEST_SCHEMA ?? join(HERE, "../../deploy/nuq-postgres/fcpi-platform-schema.sql"), "utf8").split("\n").filter((l) => !l.startsWith("\\")).join("\n");
const pg = createRequire(join(GW_DIR, "package.json"))("pg");
const [PGHOST, PGPORT = "5432"] = (process.env.FCPI_TEST_PG ?? "").split(":");
const HOST = "127.0.0.1:3380";
const tok = (label) => `fcpi_${label}_${createHash("sha256").update(`m4-${label}`).digest("hex")}`;
const T = { a: tok("a"), ro: tok("ro") };
const clients = [["a", "pa", "read,scrape,map,crawl,batch,cancel"], ["ro", "pa", "read"]].map(([l, p, s]) => `${l} ${p} ${s} sha256:${createHash("sha256").update(T[l]).digest("hex")}`).join("\n") + "\n";
const admin = async (db) => { const c = new pg.Client({ host: PGHOST, port: Number(PGPORT), user: "postgres", database: db }); await c.connect(); return c; };

// ---- the fake MCP service: records what reaches it -----------------------------------------------------
const mcpSeen = [];
const mcp = createServer((req, res) => {
  const chunks = [];
  req.on("data", (c) => chunks.push(c));
  req.on("end", () => { mcpSeen.push({ method: req.method, url: req.url, headers: req.headers, body: Buffer.concat(chunks).toString() }); res.writeHead(200, { "content-type": "application/json" }); res.end('{"jsonrpc":"2.0","id":1,"result":{}}'); });
});
const core = createServer((req, res) => { res.writeHead(req.url === "/v0/health/liveness" ? 200 : 404, { "content-type": "application/json" }); res.end("{}"); });

const dbName = `fcpi_m4_${randomUUID().replace(/-/g, "").slice(0, 12)}`;
const dir = mkdtempSync(join(tmpdir(), "fcpi-m4-"));
const gws = [];
function startGateway(extraEnv) {
  const art = join(dir, "art"), cred = join(dir, "cred");
  const env = { PATH: process.env.PATH, PI_GATEWAY_LISTEN_PORT: "0", PI_CORE_URL: `http://127.0.0.1:${core.address().port}`, PI_GATEWAY_CLIENTS_FILE: join(dir, "clients"),
    PI_ALLOWED_HOSTS: `http://${HOST}`, PI_CAPABILITIES_FILE: join(dir, "manifest.json"), PI_ARTIFACT_ROOT: art, PI_CREDENTIALS_DIR: cred, PI_POSTGRES_HOST: PGHOST,
    PI_POSTGRES_DB: dbName, PI_POSTGRES_USER: "fcpi_gateway", PGPORT, ...extraEnv };
  const proc = spawn(process.execPath, [join(GW_DIR, "server.mjs")], { env, stdio: ["ignore", "pipe", "pipe"] });
  gws.push(proc);
  const logs = [];
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("gateway did not start within 15 s")), 15000);
    let buf = "";
    proc.stdout.on("data", (d) => {
      buf += d;
      let i;
      while ((i = buf.indexOf("\n")) >= 0) { const l = buf.slice(0, i); buf = buf.slice(i + 1); try { const o = JSON.parse(l); logs.push(o); if (o.event === "listening") { clearTimeout(timer); resolve({ port: o.port, logs }); } } catch { /* not JSON */ } }
    });
    proc.on("exit", (c) => { clearTimeout(timer); reject(new Error(`gateway exited ${c}`)); });
  });
}
function call(port, { token, host = HOST, headers = {}, body = '{"jsonrpc":"2.0","id":1,"method":"tools/list"}', method = "POST" } = {}) {
  return new Promise((resolve, reject) => {
    const data = Buffer.from(body);
    const req = request({ host: "127.0.0.1", port, method, path: "/mcp", headers: { host, "content-type": "application/json", "content-length": data.length, accept: "application/json, text/event-stream",
      ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers } }, (res) => {
      const c = []; res.on("data", (x) => c.push(x)); res.on("end", () => { let json = null; try { json = JSON.parse(Buffer.concat(c).toString()); } catch { /* not JSON */ } resolve({ status: res.statusCode, headers: res.headers, json }); });
    });
    req.on("error", reject);
    req.end(data);
  });
}

let gw, bare;
before(async () => {
  await new Promise((r) => mcp.listen(0, "127.0.0.1", r));
  await new Promise((r) => core.listen(0, "127.0.0.1", r));
  const root = await admin("postgres");
  try { await root.query(`CREATE DATABASE ${dbName}`); } finally { await root.end(); }
  const db = await admin(dbName);
  try {
    await db.query(`CREATE SCHEMA nuq; CREATE SCHEMA fcpi_retrieval;
      CREATE TABLE nuq.queue_scrape (id uuid PRIMARY KEY, data jsonb, created_at timestamptz NOT NULL DEFAULT now(), group_id uuid);
      CREATE TABLE nuq.queue_scrape_backlog (id uuid PRIMARY KEY, data jsonb, created_at timestamptz NOT NULL DEFAULT now(), group_id uuid);`);
    await db.query(SCHEMA);
  } finally { await db.end(); }
  writeFileSync(join(dir, "manifest.json"), MANIFEST);
  writeFileSync(join(dir, "clients"), clients);
  mkdirSync(join(dir, "art")); mkdirSync(join(dir, "cred"));
  writeFileSync(join(dir, "art", ".fcpi-artifact-root"), "test\n");
  writeFileSync(join(dir, "cred", "gateway_postgres_password"), "p".repeat(40));
  gw = await startGateway({ PI_MCP_URL: `http://127.0.0.1:${mcp.address().port}` });
  bare = await startGateway({});
});
after(async () => {
  for (const p of gws) p.kill("SIGKILL");
  mcp.close(); core.close();
  const r = await admin("postgres");
  try { await r.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`); } finally { await r.end(); }
  rmSync(dir, { recursive: true, force: true });
});

test("every refusal on /mcp happens at the gateway: nothing reaches the MCP service", async () => {
  const n = mcpSeen.length;
  const cases = [
    [{}, 401, "UNAUTHORIZED"],
    [{ token: "fcpi_zz_" + "0".repeat(64) }, 401, "UNAUTHORIZED"],
    [{ token: T.a, host: "rebind.example:3380" }, 421, "MISDIRECTED"],
    [{ token: T.a, headers: { origin: "https://evil.example" } }, 403, "ORIGIN_NOT_ALLOWED"],
    [{ token: T.a, headers: { origin: "null" } }, 403, "ORIGIN_NOT_ALLOWED"],
    [{ token: T.a, body: JSON.stringify({ pad: "x".repeat(1048577) }) }, 413, "BODY_TOO_LARGE"],
  ];
  for (const [opts, status, code] of cases) {
    const r = await call(gw.port, opts);
    assert.equal(r.status, status, JSON.stringify({ ...opts, token: !!opts.token, body: opts.body?.length }));
    assert.equal(r.json?.code, code);
  }
  const unauth = await call(gw.port, {});
  assert.equal(unauth.headers["www-authenticate"], 'Bearer realm="fcpi"');
  assert.equal(mcpSeen.length, n, "no refused request reached the MCP service");
});

test("an authenticated request reaches the MCP service with the gateway's identity, never the client's", async () => {
  const n = mcpSeen.length;
  const r = await call(gw.port, { token: T.a, headers: { "x-fcpi-principal": "pb", "x-fcpi-client": "b", "x-fcpi-scopes": "read", "mcp-protocol-version": "2026-07-28", "mcp-method": "tools/list" } });
  assert.equal(r.status, 200);
  assert.equal(mcpSeen.length, n + 1);
  const h = mcpSeen.at(-1).headers;
  assert.equal(h["x-fcpi-client"], "a");
  assert.equal(h["x-fcpi-principal"], "pa");
  assert.equal(h["x-fcpi-scopes"], "batch,cancel,crawl,map,read,scrape");
  assert.equal(h.authorization, `Bearer ${T.a}`);
  assert.equal(h["mcp-method"], "tools/list");
  assert.equal(mcpSeen.at(-1).url, "/mcp");
  // A read-only token reaches it too: every tool call is authorized again by the REST route it calls.
  const ro = await call(gw.port, { token: T.ro });
  assert.equal(ro.status, 200);
  assert.equal(mcpSeen.at(-1).headers["x-fcpi-scopes"], "read");
});

test("without PI_MCP_URL, /mcp is no route and the REST routes still serve", async () => {
  const n = mcpSeen.length;
  const r = await call(bare.port, { token: T.a });
  assert.equal(r.status, 404);
  assert.equal(r.json?.code, "NOT_FOUND");
  assert.equal(mcpSeen.length, n);
  const s = await new Promise((resolve) => { const q = request({ host: "127.0.0.1", port: bare.port, method: "GET", path: "/platform/v1/status", headers: { host: HOST, authorization: `Bearer ${T.ro}` } }, (res) => { res.resume(); res.on("end", () => resolve(res.statusCode)); }); q.end(); });
  assert.equal(s, 200);
});
