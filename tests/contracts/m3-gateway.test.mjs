// Contract suite for the M3 access gateway (services/access): the real server against a fake core that
// answers like the pinned v2 routes, with a throwaway PostgreSQL per harness. Run on the workstation
// from a copy with node_modules, and on the Pi inside the gateway image (scripts/m3/pi-gateway-tests.sh):
//   FCPI_TEST_PG=<host[:port]> FCPI_GATEWAY_DIR=<dir holding server.mjs and node_modules> node --test m3-gateway.test.mjs
// FCPI_TEST_MANIFEST and FCPI_TEST_SCHEMA locate deploy/policies/capabilities.json and
// deploy/nuq-postgres/fcpi-platform-schema.sql when the repository layout is not around the test.
// Without FCPI_TEST_PG the suite fails rather than skips.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer, request } from "node:http";
import { spawn } from "node:child_process";
import { connect } from "node:net";
import { createHash, randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, renameSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const GW_DIR = process.env.FCPI_GATEWAY_DIR ?? join(HERE, "../../services/access");
const MANIFEST = JSON.parse(readFileSync(process.env.FCPI_TEST_MANIFEST ?? join(HERE, "../../deploy/policies/capabilities.json"), "utf8"));
const SCHEMA = readFileSync(process.env.FCPI_TEST_SCHEMA ?? join(HERE, "../../deploy/nuq-postgres/fcpi-platform-schema.sql"), "utf8").split("\n").filter((l) => !l.startsWith("\\")).join("\n");
const pg = createRequire(join(GW_DIR, "package.json"))("pg");
const [PGHOST, PGPORT = "5432"] = (process.env.FCPI_TEST_PG ?? "").split(":");
const HOST = "127.0.0.1:3380", ORIGIN = `http://${HOST}`;
const tok = (label) => `fcpi_${label}_${createHash("sha256").update(label).digest("hex")}`;
const T = { a: tok("a"), b: tok("b"), ro: tok("ro"), rev: tok("rev") };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const waitFor = async (fn, ms = 15000, what = "condition") => { const end = Date.now() + ms; for (;;) { const v = await fn(); if (v) return v; if (Date.now() > end) throw new Error(`timed out waiting for ${what}`); await sleep(50); } };

// A manifest with small admission limits, so overload is reachable in a test.
const testManifest = (over = {}) => {
  const m = structuredClone(MANIFEST);
  m.limits.auth.failuresPerMinute = 5;
  m.limits.admission.maxSyncInFlight = 2;
  m.limits.admission.maxOpenJobs = over.maxOpenJobs ?? 20;
  return m;
};
const clientsText = (labels) => labels.map(([l, p, s]) => `${l} ${p} ${s} sha256:${createHash("sha256").update(T[l]).digest("hex")}`).join("\n") + "\n";
const ALL = "read,scrape,map,crawl,batch,cancel";

async function admin(db) { const c = new pg.Client({ host: PGHOST, port: Number(PGPORT), user: "postgres", database: db }); await c.connect(); return c; }

// ---- the fake core -----------------------------------------------------------------------------------
function fakeCore(dbName) {
  const s = { jobs: new Map(), requests: [], mode: "ok", server: null, port: 0, db: null, held: [] };
  const docOf = (id, i) => ({ markdown: `# page ${i}`, metadata: { sourceURL: `http://m3.fixture.fcpi.test:8080/p${i}`, scrapeId: `${id.slice(0, 8)}-doc-${i}`, statusCode: 200 } });
  const persist = async (kind, id, body) => {
    const data = kind === "crawl" ? { mode: "kickoff", origin: body.origin, crawl_id: id } : { mode: "single_urls", origin: "api", scrapeOptions: { origin: body.origin }, crawl_id: id };
    await s.db.query("INSERT INTO nuq.queue_scrape (id, data, group_id) VALUES ($1, $2, $3)", [randomUUID(), data, id]);
    s.jobs.set(id, { kind, status: "scraping", docs: [], errors: [], body, cancelled: false });
  };
  const handler = (req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", async () => {
      const raw = Buffer.concat(chunks).toString();
      let body = null; try { body = raw ? JSON.parse(raw) : null; } catch { /* not JSON */ }
      const u = new URL(req.url, "http://core");
      s.requests.push({ method: req.method, url: req.url, headers: req.headers, body });
      const send = (st, b, h = {}) => { res.writeHead(st, { "content-type": "application/json", ...h }); res.end(JSON.stringify(b)); };
      let m;
      if (req.method === "GET" && u.pathname === "/v0/health/liveness") return send(200, { status: "ok" });
      if (req.method === "POST" && (u.pathname === "/v2/scrape" || u.pathname === "/v2/map")) {
        if (/slow/.test(body?.url ?? "")) await sleep(1500);
        // As the pinned core answers: its Cloud challenge, and cors()'s wildcard on every response.
        const cloud = { "www-authenticate": 'Bearer resource_metadata="https://www.firecrawl.dev/.well-known/oauth-protected-resource"', "access-control-allow-origin": "*", "x-powered-by": "Express" };
        return send(200, u.pathname === "/v2/scrape" ? { success: true, data: { markdown: "# fixture", metadata: { sourceURL: body.url } } } : { success: true, links: [{ url: body.url }] }, cloud);
      }
      if (req.method === "POST" && (m = u.pathname.match(/^\/v2\/(crawl|batch\/scrape)$/))) {
        const kind = m[1] === "crawl" ? "crawl" : "batch";
        const id = randomUUID();
        if (s.mode === "reject") return send(400, { success: false, error: "Invalid regular expression in includePaths" });
        if (s.mode === "hang") { s.held.push({ res }); return; }
        await persist(kind, id, body);
        if (s.mode === "persist-hang") { s.held.push({ res, answer: () => send(200, { success: true, id, url: `http://firecrawl-core:3002/v2/${m[1]}/${id}` }) }); return; }
        if (s.mode === "lose-answer") return res.socket.destroy();
        return send(200, { success: true, id, url: `http://firecrawl-core:3002/v2/${m[1]}/${id}` });
      }
      if ((m = u.pathname.match(/^\/v2\/(crawl|batch\/scrape)\/([0-9a-f-]{36})(\/errors)?$/))) {
        const j = s.jobs.get(m[2]);
        if (!j) return send(404, { success: false, error: "Job not found" });
        if (req.method === "DELETE") { if (j.status === "completed") return send(409, { error: "Crawl is already completed" }); j.status = "cancelled"; j.cancelled = true; return send(200, { status: "cancelled" }); }
        if (m[3]) return send(200, { errors: j.errors, robotsBlocked: [] });
        const skip = Number(u.searchParams.get("skip") ?? 0), limit = Number(u.searchParams.get("limit") ?? 100);
        const data = j.docs.slice(skip, skip + limit);
        const next = j.status !== "completed" || j.docs.length > skip + data.length ? `http://firecrawl-core:3002/v2/${m[1]}/${m[2]}?skip=${skip + data.length}` : undefined;
        return send(200, { success: true, status: j.status, completed: j.docs.length, total: j.docs.length, creditsUsed: -1, expiresAt: new Date(Date.now() + 86400000).toISOString(), next, data });
      }
      send(404, { success: false, error: "not found" });
    });
  };
  s.start = async (port = 0) => { s.server = createServer(handler); await new Promise((r) => s.server.listen(port, "127.0.0.1", r)); s.port = s.server.address().port; };
  s.stop = async () => { for (const h of s.held) h.res.socket?.destroy(); s.held = []; s.server.closeAllConnections(); await new Promise((r) => s.server.close(r)); };
  // Answers every held submission that the core created (persist-hang), as it would have.
  s.release = () => { const n = s.held.filter((h) => h.answer).length; for (const h of s.held) h.answer?.(); s.held = []; return n; };
  s.complete = (id, n, errs = 0) => { const j = s.jobs.get(id); j.docs = Array.from({ length: n }, (_, i) => docOf(id, i)); j.errors = Array.from({ length: errs }, (_, i) => ({ id: randomUUID(), url: `http://m3.fixture.fcpi.test:8080/missing${i}`, error: "Not found", code: "SCRAPE_NOT_FOUND" })); j.status = "completed"; };
  s.upstreamOf = async (jobId) => (await s.db.query("SELECT upstream_id FROM fcpi_platform.job WHERE id = $1", [jobId])).rows[0]?.upstream_id;
  s.submissions = () => s.requests.filter((r) => r.method === "POST" && /^\/v2\/(crawl|batch\/scrape)$/.test(r.url));
  s.connectDb = async () => { s.db = await admin(dbName); };
  return s;
}

// ---- a harness: database, artifact root, clients, fake core and gateway --------------------------------
const harnesses = [];
async function harness({ manifest = testManifest(), settleMs = 800, extraEnv = {} } = {}) {
  const dbName = `fcpi_test_${randomUUID().replace(/-/g, "").slice(0, 12)}`;
  const root = await admin("postgres");
  await root.query(`CREATE DATABASE ${dbName}`);
  await root.end();
  const db = await admin(dbName);
  await db.query(`CREATE SCHEMA nuq; CREATE SCHEMA fcpi_retrieval;
    CREATE TABLE nuq.queue_scrape (id uuid PRIMARY KEY, data jsonb, created_at timestamptz NOT NULL DEFAULT now(), group_id uuid);
    CREATE TABLE nuq.queue_scrape_backlog (id uuid PRIMARY KEY, data jsonb, created_at timestamptz NOT NULL DEFAULT now(), group_id uuid);`);
  await db.query(SCHEMA);
  const dir = mkdtempSync(join(tmpdir(), "fcpi-m3-"));
  writeFileSync(join(dir, "manifest.json"), JSON.stringify(manifest));
  writeFileSync(join(dir, "clients"), clientsText([["a", "pa", ALL], ["b", "pb", ALL], ["ro", "pa", "read"], ["rev", "pa", ALL]]));
  const art = join(dir, "art"); const cred = join(dir, "cred");
  mkdirSync(art); mkdirSync(cred);
  writeFileSync(join(art, ".fcpi-artifact-root"), "test\n");
  writeFileSync(join(cred, "gateway_postgres_password"), "p".repeat(40));
  const core = fakeCore(dbName);
  await core.connectDb();
  await core.start();
  const h = { db, dir, core, dbName, gw: null, port: 0, logs: [] };
  h.env = () => ({ PATH: process.env.PATH, PI_GATEWAY_LISTEN_PORT: "0", PI_CORE_URL: `http://127.0.0.1:${core.port}`, PI_CORE_TIMEOUT_MS: "5000",
    PI_GATEWAY_CLIENTS_FILE: join(dir, "clients"), PI_ALLOWED_HOSTS: `${ORIGIN},http://localhost:3380`, PI_CAPABILITIES_FILE: join(dir, "manifest.json"),
    PI_ARTIFACT_ROOT: art, PI_CREDENTIALS_DIR: cred, PI_POSTGRES_HOST: PGHOST, PI_POSTGRES_DB: dbName, PI_POSTGRES_USER: "fcpi_gateway",
    PI_GATEWAY_SUBMIT_TIMEOUT_MS: "1500", PI_GATEWAY_SUBMIT_SETTLE_MS: String(settleMs), PI_GATEWAY_POLL_MS: "100", PGPORT, ...extraEnv });
  h.start = async () => { const r = await startGateway(h.env(), h.logs); h.gw = r.proc; h.port = r.port; };
  h.kill = async () => { h.gw.kill("SIGKILL"); await new Promise((r) => (h.gw.exitCode !== null ? r() : h.gw.once("exit", r))); };
  h.call = (method, path, opts = {}) => call(h.port, method, path, opts);
  h.job = async (id) => (await db.query("SELECT * FROM fcpi_platform.job WHERE id = $1", [id])).rows[0];
  h.events = async (id) => (await db.query("SELECT from_state, to_state, detail FROM fcpi_platform.job_event WHERE job_id = $1 ORDER BY at, id", [id])).rows;
  h.stop = async () => { h.gw?.kill("SIGKILL"); await core.stop().catch(() => {}); await core.db.end(); await db.end(); rmSync(dir, { recursive: true, force: true }); const r = await admin("postgres"); await r.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`); await r.end(); };
  await h.start();
  harnesses.push(h);
  return h;
}

function startGateway(env, logs) {
  const proc = spawn(process.execPath, [join(GW_DIR, "server.mjs")], { env, stdio: ["ignore", "pipe", "pipe"] });
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { proc.kill(); reject(new Error("gateway did not start within 15 s")); }, 15000);
    let buf = "";
    proc.stdout.on("data", (d) => {
      buf += d;
      for (;;) {
        const i = buf.indexOf("\n");
        if (i < 0) break;
        const l = buf.slice(0, i); buf = buf.slice(i + 1);
        try { const o = JSON.parse(l); logs?.push(o); if (o.event === "listening") { clearTimeout(timer); resolve({ proc, port: o.port }); } } catch { /* not JSON */ }
      }
    });
    proc.stderr.on("data", (d) => logs?.push({ stderr: String(d) }));
    proc.on("exit", (c) => { clearTimeout(timer); reject(new Error(`gateway exited ${c}`)); });
  });
}

function call(port, method, path, { token, body, headers = {}, host = HOST } = {}) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? undefined : Buffer.from(typeof body === "string" ? body : JSON.stringify(body));
    const req = request({ host: "127.0.0.1", port, method, path, headers: { host, ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(data ? { "content-type": "application/json", "content-length": data.length } : {}), ...headers } }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => { const text = Buffer.concat(chunks).toString(); let json = null; try { json = JSON.parse(text); } catch { /* not JSON */ } resolve({ status: res.statusCode, headers: res.headers, text, json }); });
      res.on("error", reject);
    });
    req.on("error", reject);
    req.end(data);
  });
}
function raw(port, text) {
  return new Promise((resolve) => {
    const s = connect(port, "127.0.0.1");
    const got = [];
    s.on("data", (d) => got.push(d));
    s.on("error", () => {});
    s.on("close", () => resolve(Buffer.concat(got).toString()));
    s.write(text);
  });
}
const crawlBody = (extra = {}) => ({ url: "http://m3.fixture.fcpi.test:8080/", ...extra });

let H;
before(async () => {
  assert.ok(PGHOST, "FCPI_TEST_PG must name the throwaway PostgreSQL (host[:port])");
  H = await harness();
});
after(async () => { for (const h of harnesses) await h.stop().catch(() => {}); });

// ---- authentication, Host, Origin, routes ------------------------------------------------------------
test("missing and malformed tokens get 401 with the gateway's own challenge; nothing reaches the core", async () => {
  const n = H.core.requests.length;
  for (const token of [undefined, "fcpi_nope_" + "0".repeat(64)]) {
    const r = await H.call("POST", "/v2/scrape", { token, body: { url: "https://example.com" } });
    assert.equal(r.status, 401);
    assert.equal(r.json.code, "UNAUTHORIZED");
    assert.equal(r.headers["www-authenticate"], 'Bearer realm="fcpi"');
  }
  const r = await H.call("POST", "/v2/scrape", { headers: { authorization: `Basic ${T.a}` }, body: {} });
  assert.equal(r.status, 401);
  assert.equal(H.core.requests.length, n);
});

test("a valid token scrapes; upstream's Cloud challenge is stripped; only the gateway's headers reach the core", async () => {
  const r = await H.call("POST", "/v2/scrape?url=https://api.firecrawl.dev/", { token: T.a, body: { url: "http://m3.fixture.fcpi.test:8080/p01", origin: "js-sdk@4.31.1" },
    headers: { "x-fcpi-principal": "pb", "x-forwarded-for": "10.0.0.1", "x-idempotency-key": "spoofed-key-1", cookie: "c=1", "x-fcpi-request-id": "spoof" } });
  assert.equal(r.status, 200);
  assert.equal(r.headers["www-authenticate"], undefined);
  assert.equal(r.headers["access-control-allow-origin"], undefined, "no CORS header, although the core sends one");
  assert.equal(r.headers["x-powered-by"], undefined);
  assert.match(r.headers["content-type"], /^application\/json/);
  assert.match(r.headers["x-request-id"], /^[0-9a-f-]{36}$/);
  const up = H.core.requests.at(-1);
  assert.equal(up.url, "/v2/scrape");
  assert.deepEqual(Object.keys(up.headers).sort(), ["accept", "connection", "content-length", "content-type", "host"]);
  assert.deepEqual(up.body, { url: "http://m3.fixture.fcpi.test:8080/p01" }, "only accepted options, origin dropped");
  const map = await H.call("POST", "/v2/map", { token: T.a, body: { url: "http://m3.fixture.fcpi.test:8080/" } });
  assert.equal(map.status, 200);
  assert.equal(map.headers["access-control-allow-origin"], undefined);
});

test("Host must be a served origin and a browser Origin is refused", async () => {
  assert.equal((await H.call("GET", "/platform/v1/status", { token: T.a, host: "evil.example" })).status, 421);
  assert.equal((await H.call("GET", "/platform/v1/status", { token: T.a, host: "localhost:3380" })).status, 200);
  const o = await H.call("GET", "/platform/v1/status", { token: T.a, headers: { origin: "https://evil.example" } });
  assert.equal(o.status, 403);
  assert.equal(o.json.code, "ORIGIN_NOT_ALLOWED");
  assert.equal(o.headers["access-control-allow-origin"], undefined);
});

test("a missing scope is 403; admin, unlisted and absolute-form paths are 404; known native routes not enabled are 501", async () => {
  const n = H.core.requests.length;
  const s = await H.call("POST", "/v2/crawl", { token: T.ro, body: crawlBody() });
  assert.equal(s.status, 403);
  assert.equal(s.json.code, "INSUFFICIENT_SCOPE");
  for (const p of ["/admin/integration/create-user", "//v2/scrape", "/%76%32/scrape", "/v2/scrape/../crawl", "/v0/health/liveness"]) assert.equal((await H.call("POST", p, { token: T.a, body: {} })).status, 404, p);
  assert.equal((await H.call("POST", "/v2/search", { token: T.a, body: { query: "x" } })).status, 501);
  assert.equal((await H.call("GET", "/v2/crawl/ongoing", { token: T.a })).status, 501);
  assert.match(await raw(H.port, `POST http://gw/v2/scrape HTTP/1.1\r\nhost: ${HOST}\r\nconnection: close\r\nauthorization: Bearer ${T.a}\r\ncontent-type: application/json\r\ncontent-length: 2\r\n\r\n{}`), /^HTTP\/1\.1 404 /);
  assert.equal(H.core.requests.length, n);
});

test("failed authentications past their budget get 429 while a valid token still works", async () => {
  const h = await harness();
  const statuses = [];
  for (let i = 0; i < 8; i++) statuses.push((await h.call("GET", "/platform/v1/status", { token: "fcpi_bad_" + String(i).repeat(64) })).status);
  assert.deepEqual(statuses, [401, 401, 401, 401, 401, 429, 429, 429]);
  assert.equal((await h.call("GET", "/platform/v1/status", { token: T.a })).status, 200);
});

// ---- limits and refusals before work -------------------------------------------------------------------
test("oversized bodies are 413 (declared and chunked); Content-Length with Transfer-Encoding is 400", async () => {
  const n = H.core.requests.length;
  assert.equal((await H.call("POST", "/v2/scrape", { token: T.a, body: { url: "https://example.com", pad: "x".repeat(1048576) } })).status, 413);
  const chunk = "x".repeat(65536);
  let text = `POST /v2/scrape HTTP/1.1\r\nhost: ${HOST}\r\nauthorization: Bearer ${T.a}\r\ncontent-type: application/json\r\ntransfer-encoding: chunked\r\n\r\n`;
  for (let i = 0; i < 18; i++) text += `${chunk.length.toString(16)}\r\n${chunk}\r\n`;
  assert.match(await raw(H.port, text + "0\r\n\r\n"), /^HTTP\/1\.1 413 /);
  assert.match(await raw(H.port, `POST /v2/scrape HTTP/1.1\r\nhost: ${HOST}\r\nconnection: close\r\nauthorization: Bearer ${T.a}\r\ncontent-type: application/json\r\ncontent-length: 2\r\ntransfer-encoding: chunked\r\n\r\n2\r\n{}\r\n0\r\n\r\n`), /^HTTP\/1\.1 400 /);
  assert.equal(H.core.requests.length, n);
});

test("refused options are answered before any receipt or upstream request", async () => {
  const n = H.core.requests.length, jobs = (await H.db.query("SELECT count(*)::int AS n FROM fcpi_platform.job")).rows[0].n;
  for (const [path, body, opt] of [["/v2/scrape", { url: "https://example.com", formats: ["screenshot"] }, "formats.screenshot"], ["/v2/crawl", crawlBody({ webhook: "https://h.example" }), "webhook"],
    ["/v2/batch/scrape", { urls: ["https://example.com"], appendToId: randomUUID() }, "appendToId"], ["/v2/crawl", crawlBody({ scrapeOptions: { actions: [{ type: "click", selector: "a" }] } }), "scrapeOptions.actions"],
    ["/v2/map", { url: "https://example.com", location: { country: "us" } }, "location"]]) {
    const r = await H.call("POST", path, { token: T.a, body });
    assert.equal(r.status, 400, path);
    assert.equal(r.json.code, "UNSUPPORTED_OPTION");
    assert.equal(r.json.option, opt);
  }
  assert.equal((await H.call("POST", "/v2/crawl", { token: T.a, body: crawlBody({ limit: 201 }) })).json.code, "BAD_REQUEST");
  assert.equal(H.core.requests.length, n);
  assert.equal((await H.db.query("SELECT count(*)::int AS n FROM fcpi_platform.job")).rows[0].n, jobs);
});

test("synchronous requests past the in-flight limit get 503 OVERLOADED with Retry-After", async () => {
  const rs = await Promise.all([1, 2, 3].map(() => H.call("POST", "/v2/scrape", { token: T.a, body: { url: "https://slow.example.com/" } })));
  const over = rs.filter((r) => r.status === 503);
  assert.equal(over.length, 1, rs.map((r) => r.status).join(","));
  assert.equal(over[0].json.code, "OVERLOADED");
  assert.ok(Number(over[0].headers["retry-after"]) > 0);
  assert.equal(rs.filter((r) => r.status === 200).length, 2);
});

// ---- the crawl lifecycle: receipt, mapping, progress, archive, pagination, expiry of native state -----
test("a crawl is admitted, mapped, archived and paginated from the archive after the core forgets it", async () => {
  const r = await H.call("POST", "/v2/crawl", { token: T.a, body: crawlBody({ origin: "js-sdk@4.31.1" }) });
  assert.equal(r.status, 200);
  assert.equal(r.json.success, true);
  assert.equal(r.json.url, `${ORIGIN}/v2/crawl/${r.json.id}`);
  const id = r.json.id;
  const sub = H.core.submissions().at(-1);
  assert.equal(sub.body.origin, `fcpi:${id}`, "the submission key travels in origin");
  assert.equal(sub.body.limit, 50);
  assert.equal(sub.body.maxDiscoveryDepth, 3);
  const up = await H.core.upstreamOf(id);
  assert.ok(up && up !== id, "the external id is not the upstream id");
  // Running: proxied, with `next` only when documents remain past the page.
  const running = await H.call("GET", `/v2/crawl/${id}`, { token: T.a });
  assert.equal(running.json.status, "scraping");
  assert.equal(running.json.next, undefined);
  H.core.complete(up, 12, 1);
  const done = await waitFor(async () => { const j = await H.job(id); return ["SUCCEEDED", "PARTIAL"].includes(j.state) && j; }, 15000, "archive");
  assert.equal(done.state, "PARTIAL");
  assert.equal(done.archived, 12);
  // The core forgets the job (its group expiry): NuQ rows and its state go.
  H.core.jobs.delete(up);
  await H.db.query("DELETE FROM nuq.queue_scrape WHERE group_id = $1", [up]);
  const seen = [];
  let next = `/v2/crawl/${id}?limit=5`, pages = 0;
  while (next) {
    const p = await H.call("GET", next, { token: T.a });
    assert.equal(p.status, 200);
    assert.equal(p.json.status, "completed");
    seen.push(...p.json.data.map((d) => d.metadata.scrapeId));
    pages += 1;
    if (p.json.next) { assert.ok(p.json.next.startsWith(`${ORIGIN}/v2/crawl/${id}?skip=`), p.json.next); next = p.json.next.slice(ORIGIN.length); } else next = null;
  }
  assert.equal(pages, 3);
  assert.equal(seen.length, 12);
  assert.equal(new Set(seen).size, 12);
  const errs = await H.call("GET", `/v2/crawl/${id}/errors`, { token: T.a });
  assert.equal(errs.json.errors.length, 1);
  const rec = await H.call("GET", `/platform/v1/jobs/${id}`, { token: T.a });
  assert.deepEqual(rec.json.job.events.map((e) => e.to), ["RECEIVED", "SUBMITTING", "QUEUED", "RUNNING", "PARTIAL"]);
  assert.equal(rec.json.job.upstreamId, up);
});

test("the same idempotency key returns the same job; another request under it is 409; another principal's key is separate", async () => {
  const key = `idem-${randomUUID()}`;
  const n = H.core.submissions().length;
  const one = await H.call("POST", "/v2/batch/scrape", { token: T.a, body: { urls: ["https://a.example.com", "ftp://bad"] }, headers: { "x-idempotency-key": key } });
  assert.equal(one.status, 200);
  assert.deepEqual(one.json.invalidURLs, ["ftp://bad"]);
  const two = await H.call("POST", "/v2/batch/scrape", { token: T.a, body: { urls: ["https://a.example.com", "ftp://bad"] }, headers: { "x-idempotency-key": key } });
  assert.equal(two.json.id, one.json.id);
  assert.equal(H.core.submissions().length, n + 1);
  const clash = await H.call("POST", "/v2/batch/scrape", { token: T.a, body: { urls: ["https://b.example.com"] }, headers: { "x-idempotency-key": key } });
  assert.equal(clash.status, 409);
  assert.equal(clash.json.code, "IDEMPOTENCY_CONFLICT");
  // Finish A's batch so the next job may run.
  H.core.complete(await H.core.upstreamOf(one.json.id), 1);
  await waitFor(async () => (await H.job(one.json.id)).state === "SUCCEEDED", 15000, "batch done");
  const other = await H.call("POST", "/v2/batch/scrape", { token: T.b, body: { urls: ["https://a.example.com"] }, headers: { "x-idempotency-key": key } });
  assert.equal(other.status, 200);
  assert.notEqual(other.json.id, one.json.id);
  H.core.complete(await waitFor(() => H.core.upstreamOf(other.json.id), 15000, "mapping"), 1);
  await waitFor(async () => (await H.job(other.json.id)).state === "SUCCEEDED", 15000, "batch done");
});

test("another principal's job looks exactly like an unknown one", async () => {
  const mine = (await H.db.query("SELECT id FROM fcpi_platform.job WHERE principal = 'pa' ORDER BY created_at LIMIT 1")).rows[0].id;
  for (const [method, path] of [["GET", `/v2/crawl/${mine}`], ["GET", `/v2/crawl/${mine}/errors`], ["DELETE", `/v2/crawl/${mine}`], ["GET", `/platform/v1/jobs/${mine}`]]) {
    const theirs = await H.call(method, path, { token: T.b });
    const unknown = await H.call(method, path.replace(mine, randomUUID()), { token: T.b });
    assert.equal(theirs.status, 404, path);
    assert.equal(theirs.text, unknown.text, path);
  }
  assert.equal((await H.call("GET", `/v2/crawl/${mine}`, { token: T.a })).status, 200);
  assert.ok(!(await H.call("GET", "/platform/v1/jobs", { token: T.b })).json.jobs.some((j) => j.id === mine));
});

test("a revoked token stops working within two seconds, without a restart", async () => {
  assert.equal((await H.call("GET", "/platform/v1/status", { token: T.rev })).status, 200);
  writeFileSync(join(H.dir, "clients.next"), clientsText([["a", "pa", ALL], ["b", "pb", ALL], ["ro", "pa", "read"]]));
  renameSync(join(H.dir, "clients.next"), join(H.dir, "clients"));
  await sleep(1200);
  assert.equal((await H.call("GET", "/platform/v1/status", { token: T.rev })).status, 401);
  assert.equal((await H.call("GET", "/platform/v1/status", { token: T.a })).status, 200);
});

test("cancellation: a queued job never reaches the core; a running one is cancelled upstream; a finished one is 409", async () => {
  const first = await H.call("POST", "/v2/crawl", { token: T.a, body: crawlBody({ limit: 3 }) });
  const second = await H.call("POST", "/v2/crawl", { token: T.a, body: crawlBody({ limit: 4 }) });
  assert.equal(second.status, 200);
  assert.equal((await H.job(second.json.id)).state, "RECEIVED", "one upstream job at a time: the second waits");
  const n = H.core.submissions().length;
  assert.deepEqual((await H.call("DELETE", `/v2/crawl/${second.json.id}`, { token: T.a })).json, { status: "cancelled" });
  assert.equal((await H.job(second.json.id)).state, "CANCELLED");
  const up = await H.core.upstreamOf(first.json.id);
  assert.equal((await H.call("DELETE", `/v2/crawl/${first.json.id}`, { token: T.ro })).status, 403, "cancel needs its own scope");
  assert.deepEqual((await H.call("DELETE", `/v2/crawl/${first.json.id}`, { token: T.a })).json, { status: "cancelled" });
  assert.equal(H.core.jobs.get(up).cancelled, true);
  await waitFor(async () => (await H.job(first.json.id)).state === "CANCELLED", 90000, "cancelled");
  assert.equal(H.core.submissions().length, n, "the cancelled queued job was never submitted");
  const done = (await H.db.query("SELECT id FROM fcpi_platform.job WHERE state = 'SUCCEEDED' AND kind = 'batch' AND principal = 'pa' LIMIT 1")).rows[0].id;
  assert.equal((await H.call("DELETE", `/v2/batch/scrape/${done}`, { token: T.a })).status, 409);
});

// ---- crash and recovery around submission -------------------------------------------------------------
test("never delivered: with the core down the job is acknowledged, kept, and submitted once when the core returns", async () => {
  const h = await harness();
  const port = h.core.port;
  await h.core.stop();
  const r = await h.call("POST", "/v2/crawl", { token: T.a, body: crawlBody(), headers: { "x-idempotency-key": "k-never-delivered" } });
  assert.equal(r.status, 200, r.text);
  const j = await h.job(r.json.id);
  assert.equal(j.state, "RECEIVED");
  assert.match((await h.events(r.json.id)).map((e) => e.detail).join(" "), /not delivered/);
  await h.kill();
  await h.core.start(port);
  await h.start();
  await waitFor(async () => ["QUEUED", "RUNNING"].includes((await h.job(r.json.id)).state), 15000, "submitted after the core returned");
  assert.equal(h.core.submissions().length, 1);
  assert.equal((await h.db.query("SELECT count(DISTINCT group_id)::int AS n FROM nuq.queue_scrape WHERE data->>'origin' = $1", [`fcpi:${r.json.id}`])).rows[0].n, 1);
});

test("answer lost after the core created the job: reconciled by its submission key, never resubmitted", async () => {
  const h = await harness();
  h.core.mode = "lose-answer";
  const r = await h.call("POST", "/v2/crawl", { token: T.a, body: crawlBody(), headers: { "x-idempotency-key": "k-lost-answer" } });
  assert.equal(r.status, 200, r.text);
  assert.ok(["QUEUED", "RUNNING"].includes((await h.job(r.json.id)).state));
  assert.deepEqual((await h.events(r.json.id)).map((e) => e.to_state).slice(0, 4), ["RECEIVED", "SUBMITTING", "SUBMISSION_UNCERTAIN", "QUEUED"]);
  assert.equal(h.core.submissions().length, 1);
});

test("gateway killed mid-submission after the core created the job: the next process maps it without resubmitting", async () => {
  const h = await harness({ extraEnv: { PI_GATEWAY_SUBMIT_TIMEOUT_MS: "20000" } });
  h.core.mode = "persist-hang";
  const pending = h.call("POST", "/v2/crawl", { token: T.a, body: crawlBody(), headers: { "x-idempotency-key": "k-persist-hang" } }).catch((e) => ({ error: e.code }));
  await waitFor(() => h.core.submissions().length === 1, 5000, "submission at the core");
  const id = (await h.db.query("SELECT id FROM fcpi_platform.job ORDER BY created_at DESC LIMIT 1")).rows[0].id;
  assert.equal((await h.job(id)).state, "SUBMITTING");
  await h.kill();
  assert.ok((await pending).error, "the client saw the connection end, not an acknowledgement");
  h.core.mode = "ok";
  await h.start();
  await waitFor(async () => ["QUEUED", "RUNNING"].includes((await h.job(id)).state), 15000, "reconciled");
  assert.deepEqual((await h.events(id)).map((e) => e.to_state).slice(0, 4), ["RECEIVED", "SUBMITTING", "SUBMISSION_UNCERTAIN", "QUEUED"]);
  assert.equal(h.core.submissions().length, 1, "no second submission");
  const retry = await h.call("POST", "/v2/crawl", { token: T.a, body: crawlBody(), headers: { "x-idempotency-key": "k-persist-hang" } });
  assert.equal(retry.json.id, id);
});

test("gateway killed mid-submission that never reached the core: uncertain until the settle window, then submitted once", async () => {
  const h = await harness({ settleMs: 3000, extraEnv: { PI_GATEWAY_SUBMIT_TIMEOUT_MS: "20000" } });
  h.core.mode = "hang";
  const pending = h.call("POST", "/v2/crawl", { token: T.a, body: crawlBody(), headers: { "x-idempotency-key": "k-hang-never-reached" } }).catch((e) => ({ error: e.code }));
  await waitFor(() => h.core.submissions().length === 1, 5000, "submission at the core");
  const id = (await h.db.query("SELECT id FROM fcpi_platform.job ORDER BY created_at DESC LIMIT 1")).rows[0].id;
  await h.kill();
  await pending;
  h.core.mode = "ok";
  for (const x of h.core.held) x.res.socket?.destroy();
  await h.start();
  await waitFor(async () => (await h.job(id)).state === "SUBMISSION_UNCERTAIN", 5000, "uncertain");
  const during = await h.call("GET", `/v2/crawl/${id}`, { token: T.a });
  assert.equal(during.status, 503);
  assert.equal(during.json.code, "SUBMISSION_UNCERTAIN");
  assert.equal(during.json.receipt, `${ORIGIN}/platform/v1/jobs/${id}`);
  await waitFor(async () => ["QUEUED", "RUNNING"].includes((await h.job(id)).state), 15000, "resubmitted after the settle window");
  assert.equal(h.core.submissions().length, 2);
  assert.equal((await h.db.query("SELECT count(DISTINCT group_id)::int AS n FROM nuq.queue_scrape WHERE data->>'origin' = $1", [`fcpi:${id}`])).rows[0].n, 1, "one upstream job carries the key");
  assert.deepEqual((await h.events(id)).map((e) => e.to_state).slice(0, 6), ["RECEIVED", "SUBMITTING", "SUBMISSION_UNCERTAIN", "RECEIVED", "SUBMITTING", "QUEUED"]);
});

test("the ledger fails after the core accepted a claimed job: the running gateway reconciles it by marker, without a restart or a second submission", async () => {
  const h = await harness({ extraEnv: { PI_GATEWAY_SUBMIT_TIMEOUT_MS: "20000" } });
  h.core.mode = "persist-hang";
  const pending = h.call("POST", "/v2/crawl", { token: T.a, body: crawlBody(), headers: { "x-idempotency-key": "k-ledger-fails" } }).catch((e) => ({ error: e.code }));
  await waitFor(() => h.core.submissions().length === 1, 5000, "submission at the core");
  const id = (await h.db.query("SELECT id FROM fcpi_platform.job ORDER BY created_at DESC LIMIT 1")).rows[0].id;
  // The answer arrives while the ledger refuses the gateway's writes (as during a PostgreSQL restart).
  await h.db.query("REVOKE UPDATE ON fcpi_platform.job FROM fcpi_gateway");
  const failedBefore = h.logs.filter((l) => l.action === "tick_failed").length;
  assert.equal(h.core.release(), 1);
  await waitFor(() => h.logs.filter((l) => l.action === "tick_failed").length > failedBefore, 5000, "the ledger write failing");
  assert.equal((await h.job(id)).state, "SUBMITTING", "the claim outlived the failed write");
  await h.db.query("GRANT UPDATE ON fcpi_platform.job TO fcpi_gateway");
  h.core.mode = "ok";
  await waitFor(async () => ["QUEUED", "RUNNING"].includes((await h.job(id)).state), 15000, "reconciled by the running process");
  assert.equal(h.gw.exitCode, null, "no restart");
  assert.deepEqual((await h.events(id)).map((e) => e.to_state).slice(0, 4), ["RECEIVED", "SUBMITTING", "SUBMISSION_UNCERTAIN", "QUEUED"]);
  assert.equal(h.core.submissions().length, 1, "no second submission");
  assert.equal((await h.db.query("SELECT count(DISTINCT group_id)::int AS n FROM nuq.queue_scrape WHERE data->>'origin' = $1", [`fcpi:${id}`])).rows[0].n, 1);
  await pending;
  // The upstream slot frees when the job ends, and the next job is submitted.
  await h.call("POST", "/v2/crawl", { token: T.a, body: crawlBody({ limit: 2 }) });
  h.core.complete(await h.core.upstreamOf(id), 1);
  await waitFor(async () => (await h.job(id)).state === "SUCCEEDED", 15000, "finished");
  const next = (await h.db.query("SELECT id FROM fcpi_platform.job WHERE id <> $1", [id])).rows[0].id;
  await waitFor(async () => ["QUEUED", "RUNNING"].includes((await h.job(next)).state), 15000, "the next job dispatched");
});

test("a submission the core refuses is FAILED and answered like upstream's refusal", async () => {
  const h = await harness();
  h.core.mode = "reject";
  const r = await h.call("POST", "/v2/crawl", { token: T.a, body: crawlBody() });
  assert.equal(r.status, 400);
  assert.match(r.json.error, /includePaths/);
  const j = (await h.db.query("SELECT * FROM fcpi_platform.job")).rows[0];
  assert.equal(j.state, "FAILED");
});

test("open-job admission caps answer 503 OVERLOADED with Retry-After", async () => {
  const h = await harness({ manifest: testManifest({ maxOpenJobs: 2 }) });
  const codes = [];
  for (let i = 0; i < 3; i++) codes.push((await h.call("POST", "/v2/crawl", { token: T.a, body: crawlBody({ limit: 2 + i }) })).json?.code ?? "ok");
  assert.deepEqual(codes, ["ok", "ok", "OVERLOADED"]);
});

test("a job the core forgets before finishing fails as UPSTREAM_STATE_LOST; results past retention are 410", async () => {
  const h = await harness();
  const r = await h.call("POST", "/v2/crawl", { token: T.a, body: crawlBody() });
  const up = await h.core.upstreamOf(r.json.id);
  h.core.jobs.delete(up);
  await waitFor(async () => (await h.job(r.json.id)).state === "FAILED", 10000, "lost");
  assert.equal((await h.job(r.json.id)).error_code, "UPSTREAM_STATE_LOST");
  await h.db.query("UPDATE fcpi_platform.job SET results_expire_at = now() - interval '1 second' WHERE id = $1", [r.json.id]);
  await h.kill();
  await h.start();
  await waitFor(async () => (await h.job(r.json.id)).state === "EXPIRED", 10000, "expired by the sweep");
  const g = await h.call("GET", `/v2/crawl/${r.json.id}`, { token: T.a });
  assert.equal(g.status, 410);
  assert.equal(g.json.code, "EXPIRED");
});

test("an origin from the host-side file is served, and names the URLs the gateway returns", async () => {
  const dir = mkdtempSync(join(tmpdir(), "fcpi-origins-"));
  writeFileSync(join(dir, "served-origins"), "# the tailnet origin\nhttps://gw.example-tailnet.ts.net:8443\n");
  const h = await harness({ extraEnv: { PI_ALLOWED_HOSTS_FILE: join(dir, "served-origins") } });
  const host = "gw.example-tailnet.ts.net:8443";
  assert.equal((await h.call("GET", "/platform/v1/status", { token: T.a, host })).status, 200);
  assert.equal((await h.call("GET", "/platform/v1/status", { token: T.a, host: "gw.other-tailnet.ts.net:8443" })).status, 421);
  const r = await h.call("POST", "/v2/crawl", { token: T.a, body: crawlBody(), host });
  assert.equal(r.json.url, `https://${host}/v2/crawl/${r.json.id}`);
  const absent = await harness({ extraEnv: { PI_ALLOWED_HOSTS_FILE: join(dir, "absent") } });
  assert.equal((await absent.call("GET", "/platform/v1/status", { token: T.a, host })).status, 421);
  assert.equal((await absent.call("GET", "/platform/v1/status", { token: T.a })).status, 200);
  rmSync(dir, { recursive: true });
});

test("the platform status reports the core, the ledger and the capabilities", async () => {
  const s = await H.call("GET", "/platform/v1/status", { token: T.ro });
  assert.equal(s.status, 200);
  assert.equal(s.json.core.live, true);
  assert.equal(s.json.ledger.ok, true);
  assert.ok(s.json.capabilities.routes.includes("POST /v2/crawl"));
  assert.ok(s.json.capabilities.notEnabled.includes("POST /v2/search"));
});

test("configuration that is unknown, unsafe or missing its data mount stops startup", async () => {
  const base = H.env();
  const exits = [];
  for (const env of [{ ...base, PI_TYPO: "1" }, { ...base, PI_CLOUD_ACCESS_ENABLED: "true" }, { ...base, PI_ARTIFACT_ROOT: mkdtempSync(join(tmpdir(), "fcpi-shadow-")) }, { ...base, PI_ALLOWED_HOSTS: "" }]) {
    exits.push(await new Promise((resolve) => { const p = spawn(process.execPath, [join(GW_DIR, "server.mjs")], { env, stdio: "ignore" }); p.on("exit", resolve); }));
  }
  assert.ok(exits.every((c) => c !== 0), exits.join(","));
});
