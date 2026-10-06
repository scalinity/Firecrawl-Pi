// Contract suite for the M3 access gateway (services/access): the real server against a fake core that
// answers like the pinned v2 routes, with a throwaway PostgreSQL per harness. Run on the workstation
// from a copy with node_modules, and on the Pi inside the gateway image (scripts/m3/pi-gateway-tests.sh):
//   FCPI_TEST_PG=<host[:port]> FCPI_GATEWAY_DIR=<dir holding server.mjs and node_modules> node --test m3-gateway.test.mjs
// FCPI_TEST_MANIFEST and FCPI_TEST_SCHEMA locate deploy/policies/capabilities.json and
// deploy/nuq-postgres/fcpi-platform-schema.sql when the repository layout is not around the test.
// Without FCPI_TEST_PG the suite fails rather than skips.
import { test, before, after, afterEach } from "node:test";
import assert from "node:assert/strict";
import { createServer, request } from "node:http";
import { spawn } from "node:child_process";
import { connect } from "node:net";
import { createHash, randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, renameSync, rmSync, statfsSync, readdirSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const GW_DIR = process.env.FCPI_GATEWAY_DIR ?? join(HERE, "../../services/access");
const MANIFEST = JSON.parse(readFileSync(process.env.FCPI_TEST_MANIFEST ?? join(HERE, "../../deploy/policies/capabilities.json"), "utf8"));
const SCHEMA = readFileSync(process.env.FCPI_TEST_SCHEMA ?? join(HERE, "../../deploy/nuq-postgres/fcpi-platform-schema.sql"), "utf8").split("\n").filter((l) => !l.startsWith("\\")).join("\n");
const pg = createRequire(join(GW_DIR, "package.json"))("pg");
// M7: the marker a job's upstream request carries is its submission key behind its principal's owner tag (src/auth.mjs); every
// job in this suite that reaches the core is principal pa's.
const { originFor } = await import(pathToFileURL(join(GW_DIR, "src/auth.mjs")).href);
const marker = (id, principal = "pa") => originFor(principal, `fcpi:${id}`);
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
  if (over.archiveResponseMaxBytes) m.limits.results.archiveResponseMaxBytes = over.archiveResponseMaxBytes;
  if (over.pageMaxBytes) m.limits.results.pageMaxBytes = over.pageMaxBytes;
  if (over.maxStatusReadsInFlight) m.limits.admission.maxStatusReadsInFlight = over.maxStatusReadsInFlight;
  return m;
};
const clientsText = (labels) => labels.map(([l, p, s]) => `${l} ${p} ${s} sha256:${createHash("sha256").update(T[l]).digest("hex")}`).join("\n") + "\n";
const ALL = "read,scrape,map,crawl,batch,cancel";

async function admin(db) { const c = new pg.Client({ host: PGHOST, port: Number(PGPORT), user: "postgres", database: db }); await c.connect(); return c; }

// ---- the fake core -----------------------------------------------------------------------------------
function fakeCore(dbName) {
  const s = { jobs: new Map(), requests: [], mode: "ok", server: null, port: 0, db: null, held: [], errorsFail: 0, errorsGone: false, pagesFailFrom: null, pageDelayMs: 0 };
  const docOf = (id, i, big = false) => ({ markdown: `# page ${i}${big ? "x".repeat(8192) : ""}`, metadata: { sourceURL: `http://m3.fixture.fcpi.test:8080/p${i}`, scrapeId: `${id.slice(0, 8)}-doc-${i}`, statusCode: 200 } });
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
        // M7: a target URL's st parameter is the page's status, as the core reports it in metadata.statusCode.
        let st = null; try { st = Number(new URL(body.url).searchParams.get("st")) || null; } catch { /* not a URL */ }
        return send(200, u.pathname === "/v2/scrape" ? { success: true, data: { markdown: "# fixture", metadata: { sourceURL: body.url, ...(st ? { statusCode: st } : {}) } } } : { success: true, links: [{ url: body.url }] }, cloud);
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
        if (m[3]) {
          if (s.errorsFail > 0) { s.errorsFail -= 1; return send(503, { success: false, error: "unavailable" }); }
          if (s.errorsGone) return send(404, { success: false, error: "Job not found" });
          return send(200, { errors: j.errors, robotsBlocked: [] });
        }
        const skip = Number(u.searchParams.get("skip") ?? 0), limit = Number(u.searchParams.get("limit") ?? 100);
        if (s.pagesFailFrom !== null && skip >= s.pagesFailFrom && skip < 1000000000) return send(500, { success: false, error: "internal" });
        if (s.pageDelayMs && skip < 1000000000) await sleep(s.pageDelayMs);
        // A finished page without a stored document is counted in next but not listed, as upstream does.
        const page = j.docs.slice(skip, skip + limit), data = page.filter(Boolean);
        const next = j.status !== "completed" || j.docs.length > skip + page.length ? `http://firecrawl-core:3002/v2/${m[1]}/${m[2]}?skip=${skip + page.length}` : undefined;
        return send(200, { success: true, status: j.status, completed: j.docs.length, total: j.docs.length, creditsUsed: -1, expiresAt: new Date(Date.now() + 86400000).toISOString(), next, data });
      }
      send(404, { success: false, error: "not found" });
    });
  };
  s.start = async (port = 0) => { s.server = createServer(handler); await new Promise((r) => s.server.listen(port, "127.0.0.1", r)); s.port = s.server.address().port; };
  s.stop = async () => { for (const h of s.held) h.res.socket?.destroy(); s.held = []; s.server.closeAllConnections(); await new Promise((r) => s.server.close(r)); };
  // Answers every held submission that the core created (persist-hang), as it would have.
  s.release = () => { const n = s.held.filter((h) => h.answer).length; for (const h of s.held) h.answer?.(); s.held = []; return n; };
  // n documents, after `holes` finished pages that have no stored document.
  s.complete = (id, n, errs = 0, holes = 0, big = []) => { const j = s.jobs.get(id); j.docs = [...Array(holes).fill(null), ...Array.from({ length: n }, (_, i) => docOf(id, i, big.includes(i)))]; j.errors = Array.from({ length: errs }, (_, i) => ({ id: randomUUID(), url: `http://m3.fixture.fcpi.test:8080/missing${i}`, error: "Not found", code: "SCRAPE_NOT_FOUND" })); j.status = "completed"; };
  s.upstreamOf = async (jobId) => (await s.db.query("SELECT upstream_id FROM fcpi_platform.job WHERE id = $1", [jobId])).rows[0]?.upstream_id;
  s.submissions = () => s.requests.filter((r) => r.method === "POST" && /^\/v2\/(crawl|batch\/scrape)$/.test(r.url));
  s.connectDb = async () => { s.db = await admin(dbName); };
  return s;
}

// ---- a harness: database, artifact root, clients, fake core and gateway --------------------------------
// The running test's harnesses, stopped when it ends (afterEach): the suite holds one test's
// connections at a time (PostgreSQL allows 100), and a failed test leaves no gateway, fake core or
// open connection behind. H, which many tests share, is stopped after the last one.
const harnesses = [];
async function harness({ manifest = testManifest(), settleMs = 800, extraEnv = {}, shared = false } = {}) {
  const dbName = `fcpi_test_${randomUUID().replace(/-/g, "").slice(0, 12)}`;
  // Registered before anything can fail, so whatever was made gets cleaned up.
  const h = { dbName, gw: null, port: 0, logs: [] };
  h.stop = async () => {
    h.gw?.kill("SIGKILL");
    await h.core?.stop().catch(() => {});
    await h.core?.db?.end().catch(() => {});
    await h.db?.end().catch(() => {});
    if (h.dir) rmSync(h.dir, { recursive: true, force: true });
    const r = await admin("postgres");
    try { await r.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`); } finally { await r.end(); }
  };
  if (!shared) harnesses.push(h);
  const root = await admin("postgres");
  try { await root.query(`CREATE DATABASE ${dbName}`); } finally { await root.end(); }
  const db = h.db = await admin(dbName);
  await db.query(`CREATE SCHEMA nuq; CREATE SCHEMA fcpi_retrieval;
    CREATE TABLE nuq.queue_scrape (id uuid PRIMARY KEY, data jsonb, created_at timestamptz NOT NULL DEFAULT now(), group_id uuid);
    CREATE TABLE nuq.queue_scrape_backlog (id uuid PRIMARY KEY, data jsonb, created_at timestamptz NOT NULL DEFAULT now(), group_id uuid);`);
  await db.query(SCHEMA);
  const dir = h.dir = mkdtempSync(join(tmpdir(), "fcpi-m3-"));
  writeFileSync(join(dir, "manifest.json"), JSON.stringify(manifest));
  writeFileSync(join(dir, "clients"), clientsText([["a", "pa", ALL], ["b", "pb", ALL], ["ro", "pa", "read"], ["rev", "pa", ALL]]));
  const art = join(dir, "art"); const cred = join(dir, "cred");
  mkdirSync(art); mkdirSync(cred);
  writeFileSync(join(art, ".fcpi-artifact-root"), "test\n");
  writeFileSync(join(cred, "gateway_postgres_password"), "p".repeat(40));
  // Read only when extraEnv names PI_EXTRACT_URL (a stand-in retrieval service, as fakeRoutes() gives).
  writeFileSync(join(cred, "gateway_retrieval_token"), "r".repeat(40));
  const core = h.core = fakeCore(dbName);
  await core.connectDb();
  await core.start();
  h.env = () => ({ PATH: process.env.PATH, PI_GATEWAY_LISTEN_PORT: "0", PI_CORE_URL: `http://127.0.0.1:${core.port}`, PI_CORE_TIMEOUT_MS: "5000",
    PI_GATEWAY_CLIENTS_FILE: join(dir, "clients"), PI_ALLOWED_HOSTS: `${ORIGIN},http://localhost:3380`, PI_CAPABILITIES_FILE: join(dir, "manifest.json"),
    PI_ARTIFACT_ROOT: art, PI_CREDENTIALS_DIR: cred, PI_POSTGRES_HOST: PGHOST, PI_POSTGRES_DB: dbName, PI_POSTGRES_USER: "fcpi_gateway",
    PI_GATEWAY_SUBMIT_TIMEOUT_MS: "1500", PI_GATEWAY_SUBMIT_SETTLE_MS: String(settleMs), PI_GATEWAY_POLL_MS: "100", PGPORT, ...extraEnv });
  h.start = async () => { const r = await startGateway(h.env(), h.logs); h.gw = r.proc; h.port = r.port; };
  h.kill = async () => { h.gw.kill("SIGKILL"); await new Promise((r) => (h.gw.exitCode !== null ? r() : h.gw.once("exit", r))); };
  h.call = (method, path, opts = {}) => call(h.port, method, path, opts);
  h.job = async (id) => (await db.query("SELECT * FROM fcpi_platform.job WHERE id = $1", [id])).rows[0];
  h.events = async (id) => (await db.query("SELECT from_state, to_state, detail FROM fcpi_platform.job_event WHERE job_id = $1 ORDER BY at, id", [id])).rows;
  await h.start();
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
  H = await harness({ shared: true });
});
afterEach(async () => { for (const h of harnesses.splice(0)) await h.stop().catch(() => {}); });
after(async () => { await H?.stop().catch(() => {}); });

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
  assert.deepEqual(up.body, { url: "http://m3.fixture.fcpi.test:8080/p01", origin: originFor("pa", "scrape") }, "only accepted options; the client's origin replaced by the principal's owner tag (M7)");
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
  // Since M5 search and extraction are served; /v2/parse stays not enabled.
  assert.equal((await H.call("POST", "/v2/parse", { token: T.a, body: { url: "https://example.com/a.pdf" } })).status, 501);
  assert.equal((await H.call("GET", "/v2/crawl/ongoing", { token: T.a })).status, 501);
  for (const m of ["POST", "DELETE"]) {
    const i = await H.call(m, `/v2/scrape/${randomUUID()}/interact`, { token: T.a, body: {} });
    assert.equal(i.status, 501, `${m} interact`);
    assert.equal(i.json.code, "CAPABILITY_NOT_ENABLED");
  }
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
  for (const [path, body, opt] of [["/v2/batch/scrape", { urls: ["https://example.com"], formats: ["screenshot"] }, "formats.screenshot"], ["/v2/crawl", crawlBody({ webhook: { url: "https://h.example", headers: { a: "b" } } }), "webhook.headers"],
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
  assert.equal(sub.body.origin, marker(id), "the submission key travels in origin, behind the owner tag");
  assert.equal(sub.body.limit, 20, "a crawl without a limit takes the manifest's default, spec §10.2's bulk threshold");
  assert.equal(sub.body.maxDiscoveryDepth, 3);
  const up = await H.core.upstreamOf(id);
  assert.ok(up && up !== id, "the external id is not the upstream id");
  // Running: proxied, with `next` only when documents remain past the page.
  const running = await H.call("GET", `/v2/crawl/${id}`, { token: T.a });
  assert.equal(running.json.status, "scraping");
  assert.equal(running.json.next, undefined);
  assert.equal(running.json.fcpi, undefined, "a running job's outcome is not yet known");
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
    // "completed" also names a job one of whose pages failed: its outcome says so, and why.
    assert.deepEqual(p.json.fcpi, { state: "PARTIAL", failed: 1, failures: [{ class: "SCRAPE_NOT_FOUND", count: 1, detail: "Not found", urls: ["http://m3.fixture.fcpi.test:8080/missing0"] }] });
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

test("archival follows upstream's next past pages whose documents were not stored, and stops on a cancelled job's last page", async () => {
  const h = await harness();
  const r = await h.call("POST", "/v2/crawl", { token: T.a, body: crawlBody() });
  const up = await waitFor(() => h.core.upstreamOf(r.json.id), 15000, "mapping");
  h.core.complete(up, 3, 0, 12);
  const done = await waitFor(async () => { const j = await h.job(r.json.id); return j.state === "SUCCEEDED" && j; }, 15000, "archive");
  assert.equal(done.archived, 3, "the documents after twelve unstored pages are archived");
  const page = await h.call("GET", `/v2/crawl/${r.json.id}`, { token: T.a });
  assert.deepEqual(page.json.data.map((d) => d.metadata.scrapeId), [0, 1, 2].map((i) => `${up.slice(0, 8)}-doc-${i}`));
  // A cancelled job: upstream keeps `next` on every page, so the end is a `next` that does not move.
  const c = await h.call("POST", "/v2/crawl", { token: T.a, body: crawlBody({ limit: 7 }) });
  const cup = await waitFor(() => h.core.upstreamOf(c.json.id), 15000, "mapping");
  h.core.complete(cup, 2);
  h.core.jobs.get(cup).status = "cancelled";
  const cj = await waitFor(async () => { const j = await h.job(c.json.id); return j.state === "CANCELLED" && j; }, 15000, "cancelled job archived");
  assert.equal(cj.archived, 2);
});

test("per-item errors the core fails to serve are fetched again, never read as none; errors the core has forgotten are recorded as unknown", async () => {
  const h = await harness();
  const r = await h.call("POST", "/v2/crawl", { token: T.a, body: crawlBody() });
  const up = await waitFor(() => h.core.upstreamOf(r.json.id), 15000, "mapping");
  h.core.errorsFail = 3;
  h.core.complete(up, 2, 1);
  const done = await waitFor(async () => { const j = await h.job(r.json.id); return ["SUCCEEDED", "PARTIAL"].includes(j.state) && j; }, 15000, "archive");
  assert.equal(done.state, "PARTIAL", "the upstream error arrived after three failed fetches");
  assert.equal(h.core.errorsFail, 0);
  assert.deepEqual(done.errors.errors.map((e) => e.code), ["SCRAPE_NOT_FOUND"]);
  assert.ok(h.logs.some((l) => l.action === "archive_interrupted" && /errors status 503/.test(l.reason)));
  const g = await h.call("POST", "/v2/crawl", { token: T.a, body: crawlBody({ limit: 3 }) });
  const gup = await waitFor(() => h.core.upstreamOf(g.json.id), 15000, "mapping");
  h.core.errorsGone = true;
  h.core.complete(gup, 2);
  const gone = await waitFor(async () => { const j = await h.job(g.json.id); return ["SUCCEEDED", "PARTIAL"].includes(j.state) && j; }, 15000, "archive");
  assert.equal(gone.state, "PARTIAL");
  assert.equal(gone.archived, 2);
  assert.deepEqual(gone.errors.errors.map((e) => e.code), ["UPSTREAM_ERRORS_LOST"]);
});

test("a page over the archive's size cap falls back to one document at a time, and a document over it is skipped and recorded", async () => {
  const h = await harness({ manifest: testManifest({ archiveResponseMaxBytes: 4096 }) });
  const r = await h.call("POST", "/v2/crawl", { token: T.a, body: crawlBody() });
  const up = await waitFor(() => h.core.upstreamOf(r.json.id), 15000, "mapping");
  h.core.complete(up, 3, 1002, 0, [1]);
  const done = await waitFor(async () => { const j = await h.job(r.json.id); return ["SUCCEEDED", "PARTIAL"].includes(j.state) && j; }, 15000, "archive");
  assert.equal(done.state, "PARTIAL");
  assert.equal(done.archived, 2, "the documents either side of the large one are kept");
  const pages = h.core.requests.filter((q) => q.method === "GET" && q.url.startsWith(`/v2/crawl/${up}?`) && !q.url.includes("skip=1000000000")).map((q) => q.url.split("?")[1]);
  assert.ok(pages.includes("skip=0&limit=10") && pages.includes("skip=0&limit=1") && pages.includes("skip=1&limit=1"), pages.join(" "));
  assert.ok(!h.logs.some((l) => l.action === "archive_interrupted"), "an oversized answer is TOO_LARGE, not an interruption");
  // The gateway's own entries have upstream's shape, and the cut of upstream's 1,002 errors to 1,000 is recorded.
  const errs = (await h.call("GET", `/v2/crawl/${r.json.id}/errors`, { token: T.a })).json.errors;
  assert.equal(errs.length, 1002, "1,000 of upstream's and the gateway's two");
  const mine = errs.filter((e) => e.id.startsWith(`fcpi:${r.json.id}:`));
  assert.deepEqual(mine.map((e) => e.code), ["ARCHIVE_DOCUMENT_TOO_LARGE", "ERRORS_TRUNCATED"]);
  for (const e of mine) assert.ok(typeof e.url === "string" && typeof e.error === "string" && !Number.isNaN(Date.parse(e.timestamp)), JSON.stringify(e));
  assert.match(mine[1].error, /^2 further per-item errors/);
});

test("a job whose reconciliation fails does not stop the round: a running job is still archived", async () => {
  const h = await harness();
  const r = await h.call("POST", "/v2/crawl", { token: T.a, body: crawlBody() });
  const up = await waitFor(() => h.core.upstreamOf(r.json.id), 15000, "mapping");
  // An uncertain job whose marker lookup fails on every round.
  const stuck = randomUUID();
  await h.db.query(`INSERT INTO fcpi_platform.job (id, principal, client_label, kind, state, submission_key, request_hash, request, units, metadata_expire_at, submit_started_at)
    VALUES ($1, 'pa', 'a', 'crawl', 'SUBMISSION_UNCERTAIN', $2, 'x', '{}', 1, now() + interval '1 day', now())`, [stuck, `fcpi:${stuck}`]);
  await h.db.query("REVOKE EXECUTE ON FUNCTION fcpi_platform.upstream_groups_for_marker(text) FROM fcpi_gateway");
  await waitFor(() => h.logs.some((l) => /permission denied for function/.test(l.error ?? "")), 5000, "the lookup failing");
  h.core.complete(up, 2);
  await waitFor(async () => (await h.job(r.json.id)).state === "SUCCEEDED", 15000, "archived while the other job's lookup fails");
  await h.db.query("GRANT EXECUTE ON FUNCTION fcpi_platform.upstream_groups_for_marker(text) TO fcpi_gateway");
  await h.db.query("DELETE FROM fcpi_platform.job WHERE id = $1", [stuck]);
});

test("a job still open past its deadline and the grace period is closed with what was archived, and frees the upstream slot", async () => {
  const h = await harness();
  const r = await h.call("POST", "/v2/crawl", { token: T.a, body: crawlBody() });
  const up = await waitFor(() => h.core.upstreamOf(r.json.id), 15000, "mapping");
  h.core.pagesFailFrom = 10;
  h.core.complete(up, 12);
  await waitFor(async () => (await h.job(r.json.id)).archived === 10 && h.logs.some((l) => l.action === "archive_interrupted" && l.job === r.json.id), 15000, "the first page archived, the second failing");
  const waiting = await h.call("POST", "/v2/crawl", { token: T.a, body: crawlBody({ limit: 3 }) });
  assert.equal((await h.job(waiting.json.id)).state, "RECEIVED", "the slot is held");
  await h.db.query("UPDATE fcpi_platform.job SET deadline = now() - interval '31 minutes' WHERE id = $1", [r.json.id]);
  const closed = await waitFor(async () => { const j = await h.job(r.json.id); return j.state === "PARTIAL" && j; }, 15000, "closed");
  assert.equal(closed.error_code, "ARCHIVE_INCOMPLETE");
  assert.equal(closed.archived, 10);
  assert.deepEqual(closed.errors.errors.map((e) => e.code), ["ARCHIVE_INCOMPLETE"]);
  const served = await h.call("GET", `/v2/crawl/${r.json.id}?limit=100`, { token: T.a });
  assert.equal(served.json.data.length, 10, "the archived documents are served");
  await waitFor(async () => ["QUEUED", "RUNNING"].includes((await h.job(waiting.json.id)).state), 15000, "the waiting job dispatched");
});

test("archival stops at the result quota with what it holds, and admission then refuses new jobs with STORAGE_QUOTA", async () => {
  const h = await harness();
  const r = await h.call("POST", "/v2/crawl", { token: T.a, body: crawlBody() });
  const up = await waitFor(() => h.core.upstreamOf(r.json.id), 15000, "mapping");
  // The ledger's measure of the store is filled to within one and a half documents of the quota.
  const s = statfsSync(join(h.dir, "art"));
  const quota = Math.min(10 * 1024 ** 3, Math.floor(s.blocks * s.bsize * 0.2));
  const doc = JSON.stringify({ markdown: "# page 0", metadata: { sourceURL: "http://m3.fixture.fcpi.test:8080/p0", scrapeId: `${up.slice(0, 8)}-doc-0`, statusCode: 200 } });
  const filler = randomUUID(), fill = async (bytes, from) => {
    for (let left = bytes, i = from; left > 0; i++) { const b = Math.min(left, 2e9); await h.db.query("INSERT INTO fcpi_platform.job_document (job_id, ordinal, doc_key, sha256, bytes) VALUES ($1, $2, $3, $4, $5)", [filler, i, `f${i}`, "0".repeat(64), b]); left -= b; }
  };
  await fill(quota - Math.floor(doc.length * 1.5), 0);
  h.core.complete(up, 3);
  const done = await waitFor(async () => { const j = await h.job(r.json.id); return ["SUCCEEDED", "PARTIAL", "FAILED"].includes(j.state) && j; }, 15000, "archive");
  assert.equal(done.state, "PARTIAL");
  assert.equal(done.error_code, "STORAGE_QUOTA");
  assert.equal(done.archived, 1, "the document that fitted is kept");
  assert.deepEqual(done.errors.errors.map((e) => e.code), ["STORAGE_QUOTA"]);
  await fill(doc.length, 1000);
  const refused = await h.call("POST", "/v2/crawl", { token: T.a, body: crawlBody({ limit: 3 }) });
  assert.equal(refused.status, 503);
  assert.equal(refused.json.code, "STORAGE_QUOTA");
  assert.equal(refused.headers["retry-after"], "300");
});

test("status reads of a running job are bounded in size and in number", async () => {
  const h = await harness({ manifest: testManifest({ pageMaxBytes: 4096, maxStatusReadsInFlight: 1 }) });
  const r = await h.call("POST", "/v2/crawl", { token: T.a, body: crawlBody() });
  const up = await waitFor(() => h.core.upstreamOf(r.json.id), 15000, "mapping");
  // Two documents so far, the first over the page cap, and the job still running.
  h.core.complete(up, 2, 0, 0, [0]);
  h.core.jobs.get(up).status = "scraping";
  const big = await h.call("GET", `/v2/crawl/${r.json.id}`, { token: T.a });
  assert.equal(big.status, 503);
  assert.equal(big.json.code, "RESULT_TOO_LARGE");
  assert.equal(big.headers["retry-after"], "30");
  const small = await h.call("GET", `/v2/crawl/${r.json.id}?skip=1`, { token: T.a });
  assert.equal(small.status, 200);
  assert.equal(small.json.data.length, 1);
  // One buffered read at a time: a second one meanwhile is 503 OVERLOADED, and the slot comes back.
  h.core.pageDelayMs = 800;
  const both = await Promise.all([1, 2].map(() => h.call("GET", `/v2/crawl/${r.json.id}?skip=1`, { token: T.a })));
  assert.deepEqual(both.map((x) => x.status).sort(), [200, 503]);
  const over = both.find((x) => x.status === 503);
  assert.equal(over.json.code, "OVERLOADED");
  assert.equal(over.headers["retry-after"], "5");
  h.core.pageDelayMs = 0;
  assert.equal((await h.call("GET", `/v2/crawl/${r.json.id}?skip=1`, { token: T.a })).status, 200);
});

// A stand-in for the retrieval service's route endpoints (M6): the residential route available, every hold granted.
// M7: its webhook check answers as out.webhook says: "allow", "deny" or "down" (a 500).
async function fakeRoutes() {
  const calls = [];
  const out = { webhook: "allow" };
  const s = createServer((req, res) => {
    let b = ""; req.on("data", (c) => (b += c)); req.on("end", () => {
      calls.push({ method: req.method, path: req.url, auth: req.headers.authorization, body: b ? JSON.parse(b) : null });
      const json = (o) => res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(o));
      if (req.url === "/internal/routes") return json({ residential: { available: true, reason: null }, bulkPages: 20, holdMaxMinutes: 90 });
      if (req.url === "/internal/route-hold") return json({ held: true, domains: 1, until: new Date(Date.now() + 3600000).toISOString() });
      if (req.url === "/internal/route-release") return json({ released: 1 });
      if (req.url === "/internal/webhook/check") {
        if (out.webhook === "down") return res.writeHead(500).end();
        return json(out.webhook === "allow" ? { allowed: true, reason: null, delivery: "enabled" } : { allowed: false, reason: "NOT_APPROVED" });
      }
      res.writeHead(404).end();
    });
  });
  await new Promise((r) => s.listen(0, "127.0.0.1", r));
  return Object.assign(out, { calls, port: s.address().port, close: () => new Promise((r) => { s.closeAllConnections(); s.close(r); }) });
}

test("M7: a webhook destination is checked before any receipt; a retry of an accepted job gets its receipt whatever the check says now; a reused key is 409", async (t) => {
  const routes = await fakeRoutes();
  t.after(routes.close);
  const h = await harness({ extraEnv: { PI_EXTRACT_URL: `http://127.0.0.1:${routes.port}/` } });
  const hook = { url: "https://hooks.example/receive" }, key = `idem-${randomUUID()}`;
  const withKey = (body) => ({ token: T.a, body, headers: { "x-idempotency-key": key } });
  const first = await h.call("POST", "/v2/crawl", withKey(crawlBody({ limit: 5, webhook: hook })));
  assert.equal(first.status, 200, first.text);
  const n = h.core.submissions().length;
  // The check cannot be made: a new job is refused, nothing written; the accepted job's retry gets its receipt (review S10).
  routes.webhook = "down";
  const down = await h.call("POST", "/v2/crawl", { token: T.a, body: crawlBody({ limit: 5, webhook: hook }) });
  assert.deepEqual([down.status, down.json.code, down.headers["retry-after"]], [503, "WEBHOOK_CHECK_UNAVAILABLE", "10"]);
  const replayDown = await h.call("POST", "/v2/crawl", withKey(crawlBody({ limit: 5, webhook: hook })));
  assert.deepEqual([replayDown.status, replayDown.json.id], [200, first.json.id]);
  // The destination is no longer approved: a new job is refused by name; the retry still gets its receipt; the key
  // reused for another request is 409, not the refusal.
  routes.webhook = "deny";
  const denied = await h.call("POST", "/v2/crawl", { token: T.a, body: crawlBody({ limit: 5, webhook: hook }) });
  assert.deepEqual([denied.status, denied.json.code, denied.json.option], [400, "UNSUPPORTED_OPTION", "webhook.url"]);
  const replayDenied = await h.call("POST", "/v2/crawl", withKey(crawlBody({ limit: 5, webhook: hook })));
  assert.deepEqual([replayDenied.status, replayDenied.json.id], [200, first.json.id]);
  const conflict = await h.call("POST", "/v2/crawl", withKey(crawlBody({ limit: 6, webhook: hook })));
  assert.deepEqual([conflict.status, conflict.json.code], [409, "IDEMPOTENCY_CONFLICT"]);
  assert.equal(h.core.submissions().length, n, "nothing new reached the core");
});

test("a page of a hundred archived documents is served whole, without piling listeners on the response", async (t) => {
  // Every crawl the manifest admits is within one domain's hourly direct allowance (spec §10.2's 300): the largest is
  // sent as it was asked, and holds nothing.
  const routes = await fakeRoutes();
  t.after(routes.close);
  const h = await harness({ extraEnv: { PI_EXTRACT_URL: `http://127.0.0.1:${routes.port}/` } });
  const big = await h.call("POST", "/v2/crawl", { token: T.a, body: crawlBody({ limit: 200 }) });
  assert.equal(big.status, 200);
  assert.equal(h.core.submissions().at(-1).body.scrapeOptions?.proxy, undefined, "a large crawl starts on the home connection");
  const bigUp = await waitFor(() => h.core.upstreamOf(big.json.id), 15000, "mapping");
  assert.equal(routes.calls.some((c) => c.path === "/internal/route-hold" && c.body.jobId === big.json.id), false);
  // One upstream job runs at a time: this one finishes before the next is sent.
  h.core.complete(bigUp, 1);
  await waitFor(async () => (await h.job(big.json.id)).state === "SUCCEEDED", 15000, "the large crawl archived");
  // A crawl whose pages ask for the residential route is admitted only with it, and holds its domain.
  const r = await h.call("POST", "/v2/crawl", { token: T.a, body: crawlBody({ limit: 100, scrapeOptions: { proxy: "stealth" } }) });
  assert.equal(r.status, 200);
  assert.equal(h.core.submissions().at(-1).body.scrapeOptions.proxy, "stealth", "its pages ask for the residential route");
  const up = await waitFor(() => h.core.upstreamOf(r.json.id), 15000, "mapping");
  h.core.complete(up, 100);
  await waitFor(async () => (await h.job(r.json.id)).state === "SUCCEEDED", 15000, "archived");
  const p = await h.call("GET", `/v2/crawl/${r.json.id}?limit=100`, { token: T.a });
  assert.equal(p.status, 200);
  assert.ok(p.json, "the answer is complete JSON");
  assert.equal(p.json.data.length, 100);
  assert.equal(new Set(p.json.data.map((d) => d.metadata.scrapeId)).size, 100);
  await sleep(200);
  assert.ok(!h.logs.some((l) => /MaxListenersExceededWarning/.test(l.stderr ?? "")), "no listener warning");
  const hold = routes.calls.find((c) => c.path === "/internal/route-hold");
  assert.equal(hold?.body.jobId, r.json.id);
  assert.equal(hold.auth, `Bearer ${"r".repeat(40)}`);
  await waitFor(() => routes.calls.some((c) => c.path === "/internal/route-release" && c.body.jobId === r.json.id), 5000, "the hold released");
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
  const h = await harness();
  const mine = (await h.call("POST", "/v2/crawl", { token: T.a, body: crawlBody() })).json.id;
  for (const [method, path] of [["GET", `/v2/crawl/${mine}`], ["GET", `/v2/crawl/${mine}/errors`], ["DELETE", `/v2/crawl/${mine}`], ["GET", `/platform/v1/jobs/${mine}`]]) {
    const theirs = await h.call(method, path, { token: T.b });
    const unknown = await h.call(method, path.replace(mine, randomUUID()), { token: T.b });
    assert.equal(theirs.status, 404, path);
    assert.equal(theirs.text, unknown.text, path);
  }
  assert.equal((await h.call("GET", `/v2/crawl/${mine}`, { token: T.a })).status, 200);
  assert.ok((await h.call("GET", "/platform/v1/jobs", { token: T.a })).json.jobs.some((j) => j.id === mine), "the owner's list holds it (the control)");
  assert.ok(!(await h.call("GET", "/platform/v1/jobs", { token: T.b })).json.jobs.some((j) => j.id === mine));
});

test("a revoked token stops working within two seconds, without a restart", async () => {
  assert.equal((await H.call("GET", "/platform/v1/status", { token: T.rev })).status, 200);
  writeFileSync(join(H.dir, "clients.next"), clientsText([["a", "pa", ALL], ["b", "pb", ALL], ["ro", "pa", "read"]]));
  renameSync(join(H.dir, "clients.next"), join(H.dir, "clients"));
  // Polled up to the spec's two seconds, not slept past the reload; only the final 401 counts against
  // the failure budget, since every poll before it is still a valid token.
  const t0 = Date.now();
  let st;
  do { await sleep(50); st = (await H.call("GET", "/platform/v1/status", { token: T.rev })).status; } while (st === 200 && Date.now() - t0 < 2000);
  assert.equal(st, 401);
  assert.ok(Date.now() - t0 <= 2100, `refused after ${Date.now() - t0} ms`);
  assert.equal((await H.call("GET", "/platform/v1/status", { token: T.a })).status, 200);
});

test("cancellation: a queued job never reaches the core; a running one is cancelled upstream; a finished one is 409", async () => {
  const h = await harness();
  const first = await h.call("POST", "/v2/crawl", { token: T.a, body: crawlBody({ limit: 3 }) });
  const second = await h.call("POST", "/v2/crawl", { token: T.a, body: crawlBody({ limit: 4 }) });
  assert.equal(second.status, 200);
  assert.equal((await h.job(second.json.id)).state, "RECEIVED", "one upstream job at a time: the second waits");
  const n = h.core.submissions().length;
  assert.deepEqual((await h.call("DELETE", `/v2/crawl/${second.json.id}`, { token: T.a })).json, { status: "cancelled" });
  assert.equal((await h.job(second.json.id)).state, "CANCELLED");
  const up = await h.core.upstreamOf(first.json.id);
  assert.equal((await h.call("DELETE", `/v2/crawl/${first.json.id}`, { token: T.ro })).status, 403, "cancel needs its own scope");
  assert.deepEqual((await h.call("DELETE", `/v2/crawl/${first.json.id}`, { token: T.a })).json, { status: "cancelled" });
  assert.equal(h.core.jobs.get(up).cancelled, true);
  await waitFor(async () => (await h.job(first.json.id)).state === "CANCELLED", 90000, "cancelled");
  assert.equal(h.core.submissions().length, n, "the cancelled queued job was never submitted");
  // A finished job of this test's own.
  const batch = await h.call("POST", "/v2/batch/scrape", { token: T.a, body: { urls: ["https://a.example.com"] } });
  h.core.complete(await waitFor(() => h.core.upstreamOf(batch.json.id), 15000, "mapping"), 1);
  await waitFor(async () => (await h.job(batch.json.id)).state === "SUCCEEDED", 15000, "finished");
  assert.equal((await h.call("DELETE", `/v2/batch/scrape/${batch.json.id}`, { token: T.a })).status, 409);
});

test("a waiting job whose cancellation was asked closes while another job holds the upstream slot", async () => {
  const h = await harness();
  const first = await h.call("POST", "/v2/crawl", { token: T.a, body: crawlBody({ limit: 2 }) });
  await waitFor(() => h.core.upstreamOf(first.json.id), 15000, "mapping");
  // As after a cancellation that raced a claim and a requeue: RECEIVED, cancellation asked, not closed.
  const second = await h.call("POST", "/v2/crawl", { token: T.a, body: crawlBody({ limit: 3 }) });
  await h.db.query("UPDATE fcpi_platform.job SET cancel_requested_at = now() WHERE id = $1", [second.json.id]);
  await waitFor(async () => (await h.job(second.json.id)).state === "CANCELLED", 5000, "closed while the slot is held");
  assert.ok(["QUEUED", "RUNNING"].includes((await h.job(first.json.id)).state), "the first job still holds the slot");
  assert.equal(h.core.submissions().length, 1, "the cancelled job never reached the core");
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
  assert.equal((await h.db.query("SELECT count(DISTINCT group_id)::int AS n FROM nuq.queue_scrape WHERE data->>'origin' = $1", [marker(r.json.id)])).rows[0].n, 1);
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
  // The settle window must outlast the kill and restart with room to spare on a loaded Pi.
  const h = await harness({ settleMs: 8000, extraEnv: { PI_GATEWAY_SUBMIT_TIMEOUT_MS: "20000" } });
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
  assert.equal((await h.db.query("SELECT count(DISTINCT group_id)::int AS n FROM nuq.queue_scrape WHERE data->>'origin' = $1", [marker(id)])).rows[0].n, 1, "one upstream job carries the key");
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
  assert.equal((await h.db.query("SELECT count(DISTINCT group_id)::int AS n FROM nuq.queue_scrape WHERE data->>'origin' = $1", [marker(id)])).rows[0].n, 1);
  await pending;
  // The upstream slot frees when the job ends, and the next job is submitted.
  await h.call("POST", "/v2/crawl", { token: T.a, body: crawlBody({ limit: 2 }) });
  h.core.complete(await h.core.upstreamOf(id), 1);
  await waitFor(async () => (await h.job(id)).state === "SUCCEEDED", 15000, "finished");
  const next = (await h.db.query("SELECT id FROM fcpi_platform.job WHERE id <> $1", [id])).rows[0].id;
  await waitFor(async () => ["QUEUED", "RUNNING"].includes((await h.job(next)).state), 15000, "the next job dispatched");
});

test("an uncertain submission's answer says what a retry would do: with a key, without one, and for a read", async () => {
  for (const keyed of [true, false]) {
    const h = await harness({ settleMs: 60000 });
    h.core.mode = "hang";
    const headers = keyed ? { "x-idempotency-key": `k-uncertain-${randomUUID()}` } : {};
    const r = await h.call("POST", "/v2/crawl", { token: T.a, body: crawlBody(), headers });
    assert.equal(r.status, 503);
    assert.equal(r.json.code, "SUBMISSION_UNCERTAIN");
    assert.match(r.json.error, keyed ? /Retry this request with the same idempotency key/ : /without an idempotency key, this request would create a second job/);
    const read = await h.call("GET", `/v2/crawl/${r.json.id}`, { token: T.a });
    assert.equal(read.json.code, "SUBMISSION_UNCERTAIN");
    assert.match(read.json.error, /Retry shortly, or read the receipt/);
    assert.doesNotMatch(read.json.error, /idempotency key/);
  }
});

test("a job past its deadline is cancelled upstream and ends FAILED with JOB_DEADLINE_EXCEEDED", async () => {
  const h = await harness();
  const r = await h.call("POST", "/v2/crawl", { token: T.a, body: crawlBody() });
  const up = await waitFor(() => h.core.upstreamOf(r.json.id), 15000, "mapping");
  await h.db.query("UPDATE fcpi_platform.job SET deadline = now() - interval '1 second' WHERE id = $1", [r.json.id]);
  const j = await waitFor(async () => { const x = await h.job(r.json.id); return x.state === "FAILED" && x; }, 15000, "stopped at the deadline");
  assert.equal(j.error_code, "JOB_DEADLINE_EXCEEDED");
  assert.equal(h.core.jobs.get(up).cancelled, true, "the core was told to stop");
  assert.ok(h.logs.some((l) => l.action === "deadline_cancel_sent" && l.job === r.json.id));
});

test("reconciliation that finds two upstream jobs for one submission keeps the earliest and cancels the other", async () => {
  const h = await harness({ extraEnv: { PI_GATEWAY_SUBMIT_TIMEOUT_MS: "20000" } });
  h.core.mode = "persist-hang";
  const pending = h.call("POST", "/v2/crawl", { token: T.a, body: crawlBody() }).catch((e) => ({ error: e.code }));
  await waitFor(() => h.core.submissions().length === 1, 5000, "submission at the core");
  const id = (await h.db.query("SELECT id FROM fcpi_platform.job ORDER BY created_at DESC LIMIT 1")).rows[0].id;
  await h.kill();
  await pending;
  const first = (await h.db.query("SELECT group_id FROM nuq.queue_scrape WHERE data->>'origin' = $1", [marker(id)])).rows[0].group_id;
  // A later upstream job carrying the same marker, as a duplicate submission would leave.
  const dup = randomUUID();
  await h.db.query("INSERT INTO nuq.queue_scrape (id, data, group_id, created_at) VALUES ($1, $2, $3, now() + interval '1 second')", [randomUUID(), { mode: "kickoff", origin: marker(id), crawl_id: dup }, dup]);
  h.core.jobs.set(dup, { kind: "crawl", status: "scraping", docs: [], errors: [], body: {}, cancelled: false });
  h.core.mode = "ok";
  await h.start();
  const j = await waitFor(async () => { const x = await h.job(id); return ["QUEUED", "RUNNING"].includes(x.state) && x; }, 15000, "reconciled");
  assert.equal(j.upstream_id, first, "the earliest upstream job is kept");
  await waitFor(() => h.core.jobs.get(dup).cancelled, 5000, "the duplicate cancelled");
  assert.ok(h.logs.some((l) => l.action === "reconciled" && l.duplicates === 1));
  assert.equal(h.core.jobs.get(first).cancelled, false);
});

test("a submission the core refuses is FAILED and answered like upstream's refusal", async () => {
  const h = await harness();
  h.core.mode = "reject";
  const r = await h.call("POST", "/v2/crawl", { token: T.a, body: crawlBody() });
  assert.equal(r.status, 400);
  assert.match(r.json.error, /includePaths/);
  const j = (await h.db.query("SELECT * FROM fcpi_platform.job")).rows[0];
  assert.equal(j.state, "FAILED");
  // Refused after the acknowledgement (it waited behind another job): its status is success true with
  // status "failed", which the official client ends on, rather than success false, which it retries.
  h.core.mode = "ok";
  const first = await h.call("POST", "/v2/crawl", { token: T.a, body: crawlBody({ limit: 2 }) });
  const later = await h.call("POST", "/v2/crawl", { token: T.a, body: crawlBody({ limit: 3 }) });
  assert.equal(later.status, 200);
  h.core.mode = "reject";
  h.core.complete(await h.core.upstreamOf(first.json.id), 1);
  await waitFor(async () => (await h.job(later.json.id)).state === "FAILED", 15000, "refused after the acknowledgement");
  const st = await h.call("GET", `/v2/crawl/${later.json.id}`, { token: T.a });
  assert.equal(st.status, 200);
  assert.equal(st.json.success, true);
  assert.equal(st.json.status, "failed");
  assert.match(st.json.error, /includePaths/);
});

test("open-job admission caps answer 503 OVERLOADED with Retry-After", async () => {
  const h = await harness({ manifest: testManifest({ maxOpenJobs: 2 }) });
  const rs = [];
  for (let i = 0; i < 3; i++) rs.push(await h.call("POST", "/v2/crawl", { token: T.a, body: crawlBody({ limit: 2 + i }) }));
  assert.deepEqual(rs.map((r) => r.status), [200, 200, 503]);
  assert.equal(rs[2].json.code, "OVERLOADED");
  assert.equal(rs[2].headers["retry-after"], "30");
  assert.equal((await h.db.query("SELECT count(*)::int AS n FROM fcpi_platform.job")).rows[0].n, 2, "the refused submission left no receipt");
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

test("retention: expired results leave the manifest and their files go; old metadata goes whole with its events; expired idempotency keys go", async () => {
  const h = await harness();
  const key = `k-retention-${randomUUID()}`;
  const r = await h.call("POST", "/v2/crawl", { token: T.a, body: crawlBody(), headers: { "x-idempotency-key": key } });
  const up = await waitFor(() => h.core.upstreamOf(r.json.id), 15000, "mapping");
  h.core.complete(up, 2);
  await waitFor(async () => (await h.job(r.json.id)).state === "SUCCEEDED", 15000, "archived");
  const shas = (await h.db.query("SELECT sha256 FROM fcpi_platform.job_document WHERE job_id = $1", [r.json.id])).rows.map((x) => x.sha256);
  const files = () => readdirSync(join(h.dir, "art", "results"), { recursive: true }).filter((f) => shas.some((s) => f.endsWith(`${s}.json`)));
  assert.equal(files().length, 2);
  // Results past retention: the job is EXPIRED, its manifest rows go, and its files once they are an hour old.
  await h.db.query("UPDATE fcpi_platform.job SET results_expire_at = now() - interval '1 second' WHERE id = $1", [r.json.id]);
  const old = new Date(Date.now() - 2 * 3600000);
  for (const f of files()) utimesSync(join(h.dir, "art", "results", f), old, old);
  await h.kill(); await h.start();
  await waitFor(async () => (await h.job(r.json.id)).state === "EXPIRED", 10000, "expired");
  await waitFor(() => files().length === 0, 10000, "files swept");
  assert.equal((await h.db.query("SELECT count(*)::int AS n FROM fcpi_platform.job_document WHERE job_id = $1", [r.json.id])).rows[0].n, 0);
  // Metadata past its thirty days: the row, its events and its documents go in one statement, so a
  // failure part-way (here: no right to delete documents) leaves all of them.
  await h.db.query("UPDATE fcpi_platform.job SET metadata_expire_at = now() - interval '1 second' WHERE id = $1", [r.json.id]);
  await h.db.query("UPDATE fcpi_platform.idempotency SET expires_at = now() - interval '1 second' WHERE key = $1", [key]);
  await h.db.query("REVOKE DELETE ON fcpi_platform.job_document FROM fcpi_gateway");
  await h.kill(); await h.start();
  await waitFor(() => h.logs.some((l) => l.action === "sweep_failed"), 10000, "the sweep failing");
  assert.ok(await h.job(r.json.id), "the job row stays when its documents cannot be deleted");
  assert.ok((await h.events(r.json.id)).length > 0, "and so do its events");
  await h.db.query("GRANT DELETE ON fcpi_platform.job_document TO fcpi_gateway");
  await h.kill(); await h.start();
  await waitFor(async () => !(await h.job(r.json.id)), 10000, "metadata deleted");
  assert.equal((await h.events(r.json.id)).length, 0);
  assert.equal((await h.db.query("SELECT count(*)::int AS n FROM fcpi_platform.idempotency WHERE key = $1", [key])).rows[0].n, 0);
});

test("the ledger's times follow the manifest: deadline, results retention, metadata retention and idempotency window", async () => {
  const h = await harness();
  const r = await h.call("POST", "/v2/crawl", { token: T.a, body: crawlBody(), headers: { "x-idempotency-key": "k-ledger-times" } });
  const up = await waitFor(() => h.core.upstreamOf(r.json.id), 15000, "mapping");
  h.core.complete(up, 1);
  await waitFor(async () => (await h.job(r.json.id)).state === "SUCCEEDED", 15000, "archived");
  const t = (await h.db.query(`SELECT extract(epoch FROM j.deadline - j.submitted_at) AS deadline, extract(epoch FROM j.results_expire_at - j.finished_at) AS results,
      extract(epoch FROM j.metadata_expire_at - j.created_at) AS metadata, extract(epoch FROM i.expires_at - i.created_at) AS idem
    FROM fcpi_platform.job j JOIN fcpi_platform.idempotency i ON i.job_id = j.id WHERE j.id = $1`, [r.json.id])).rows[0];
  const L = MANIFEST.limits, near = (v, s) => Math.abs(Number(v) - s) < 5;
  assert.ok(near(t.deadline, L.crawl.deadlineMinutes * 60), `deadline ${t.deadline}`);
  assert.ok(near(t.results, L.results.retentionDays * 86400), `results ${t.results}`);
  assert.ok(near(t.metadata, L.results.metadataDays * 86400), `metadata ${t.metadata}`);
  assert.ok(near(t.idem, L.results.idempotencyHours * 3600), `idempotency ${t.idem}`);
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
  assert.ok(s.json.capabilities.notEnabled.includes("POST /v2/parse"));
  assert.ok(s.json.capabilities.routes.includes("POST /v2/search") && s.json.capabilities.routes.includes("POST /v2/extract"));
});

test("shutdown claims nothing: a job that comes due while open requests finish is left for the next process", async () => {
  const h = await harness();
  const id = randomUUID();
  await h.db.query(`INSERT INTO fcpi_platform.job (id, principal, client_label, kind, state, submission_key, request_hash, request, units, metadata_expire_at, next_dispatch_at)
    VALUES ($1, 'pa', 'a', 'crawl', 'RECEIVED', $2, 'x', $3, 1, now() + interval '1 day', now() + interval '500 milliseconds')`, [id, `fcpi:${id}`, JSON.stringify(crawlBody())]);
  const slow = h.call("POST", "/v2/scrape", { token: T.a, body: { url: "https://slow.example.com/" } });
  await sleep(100);
  const exited = new Promise((r) => h.gw.once("exit", r));
  h.gw.kill("SIGTERM");
  assert.equal((await slow).status, 200, "the open request finishes");
  await exited;
  assert.equal(h.core.submissions().length, 0, "nothing was submitted during shutdown");
  assert.equal((await h.job(id)).state, "RECEIVED");
  await h.start();
  await waitFor(async () => ["QUEUED", "RUNNING"].includes((await h.job(id)).state), 15000, "dispatched by the next process");
});

test("a ledger schema this build was not written for stops startup; an unreachable ledger is waited for", async () => {
  const h = await harness();
  await h.kill();
  const run = (env, ms = 15000) => new Promise((resolve) => {
    const p = spawn(process.execPath, [join(GW_DIR, "server.mjs")], { env, stdio: ["ignore", "pipe", "pipe"] });
    let out = ""; p.stdout.on("data", (d) => { out += d; }); p.stderr.on("data", (d) => { out += d; });
    const t = setTimeout(() => { p.kill("SIGKILL"); resolve({ code: "running", out }); }, ms);
    p.on("exit", (code) => { clearTimeout(t); resolve({ code, out }); });
  });
  // A ledger one version past the build's (version 3 since M7's artifacts, cache, page versions and outbox).
  await h.db.query("INSERT INTO fcpi_platform.schema_version (version) VALUES (4)");
  const newer = await run(h.env());
  assert.equal(newer.code, 1);
  assert.match(newer.out, /schema version is 4, this build needs 3; refusing to start/);
  assert.doesNotMatch(newer.out, /"event":"listening"/);
  await h.db.query("DROP TABLE fcpi_platform.schema_version");
  const none = await run(h.env());
  assert.equal(none.code, 1);
  assert.match(none.out, /schema version cannot be read/);
  // Nothing listening on the ledger's port: startup waits, logging, rather than exiting.
  const away = await run({ ...h.env(), PGPORT: "1" }, 7000);
  assert.equal(away.code, "running");
  assert.match(away.out, /"event":"ledger_unreachable_at_start"/);
  assert.doesNotMatch(away.out, /"event":"listening"/);
});

// ---- M7: the scrape cache -----------------------------------------------------------------------------------
test("M7: a 2xx answer is stored marked as the hit it will be and sent back as stored; error pages, storeInCache false and a plain scrape store nothing", async () => {
  const scrapes = () => H.core.requests.filter((r) => r.method === "POST" && r.url === "/v2/scrape").length;
  const cached = async () => Number((await H.db.query("SELECT count(*) AS n FROM fcpi_platform.page_cache")).rows[0].n);
  const settle = async (n) => { for (let i = 0; i < 40 && (await cached()) < n; i++) await sleep(50); };
  const url = `https://cache.example/p?st=200&n=${randomUUID()}`;
  const n0 = scrapes(), c0 = await cached();
  const miss = await H.call("POST", "/v2/scrape", { token: T.a, body: { url, maxAge: 600000 } });
  assert.deepEqual([miss.status, miss.headers["x-fcpi-cache"], miss.json.data.metadata.cacheState], [200, "miss", undefined], "the miss's own answer is the core's");
  await settle(c0 + 1);
  assert.equal(await cached(), c0 + 1);
  const hit = await H.call("POST", "/v2/scrape", { token: T.a, body: { url, maxAge: 600000 } });
  assert.deepEqual([hit.status, hit.headers["x-fcpi-cache"], hit.json.data.metadata.cacheState], [200, "hit", "hit"]);
  assert.match(hit.json.data.metadata.cachedAt, /^\d{4}-\d\d-\d\dT/);
  assert.match(hit.headers["x-fcpi-cached-at"], /^\d{4}-\d\d-\d\dT/);
  assert.equal(hit.json.data.markdown, "# fixture");
  assert.equal(scrapes(), n0 + 1, "a hit never reaches the core");
  // Another principal's same request is its own miss.
  assert.equal((await H.call("POST", "/v2/scrape", { token: T.b, body: { url, maxAge: 600000 } })).headers["x-fcpi-cache"], "miss");
  await settle(c0 + 2);
  // Not stored: a 404 page, a 500 page, storeInCache false.
  const c1 = await cached();
  for (const [u, extra] of [[`https://cache.example/p?st=404&n=${randomUUID()}`, { maxAge: 600000 }], [`https://cache.example/p?st=500&n=${randomUUID()}`, { storeInCache: true }], [`https://cache.example/p?st=200&n=${randomUUID()}`, { maxAge: 600000, storeInCache: false }],
    [`https://cache.example/p?st=200&n=${randomUUID()}`, {}]]) {
    const r = await H.call("POST", "/v2/scrape", { token: T.a, body: { url: u, ...extra } });
    assert.equal(r.status, 200);
    await sleep(300);
    assert.equal((await H.call("POST", "/v2/scrape", { token: T.a, body: { url: u, ...extra, maxAge: 600000 } })).headers["x-fcpi-cache"], "miss", u);
  }
  assert.equal(await cached(), c1);
  // Asked for with storeInCache alone, a 2xx answer is stored (review S3: a plain scrape, the last case above, is not).
  const kept = `https://cache.example/p?st=200&n=${randomUUID()}`;
  await H.call("POST", "/v2/scrape", { token: T.a, body: { url: kept, storeInCache: true } });
  await settle(c1 + 1);
  assert.equal((await H.call("POST", "/v2/scrape", { token: T.a, body: { url: kept, maxAge: 600000 } })).headers["x-fcpi-cache"], "hit");
});

test("configuration that is unknown, unsafe or missing its data mount stops startup", async () => {
  const base = H.env();
  // Each case must stop for its own reason, named in what the process prints, not merely exit non-zero.
  for (const [env, why] of [[{ ...base, PI_TYPO: "1" }, /unknown configuration keys: PI_TYPO/], [{ ...base, PI_CLOUD_ACCESS_ENABLED: "true" }, /PI_CLOUD_ACCESS_ENABLED must be false/],
    [{ ...base, PI_ARTIFACT_ROOT: mkdtempSync(join(tmpdir(), "fcpi-shadow-")) }, /lacks \.fcpi-artifact-root: refusing to write outside the project's data mount/], [{ ...base, PI_ALLOWED_HOSTS: "" }, /PI_ALLOWED_HOSTS must list the origins/]]) {
    const { code, err } = await new Promise((resolve) => {
      const p = spawn(process.execPath, [join(GW_DIR, "server.mjs")], { env, stdio: ["ignore", "ignore", "pipe"] });
      let err = ""; p.stderr.on("data", (d) => { err += d; });
      p.on("exit", (code) => resolve({ code, err }));
    });
    assert.notEqual(code, 0, String(why));
    assert.match(err, why);
  }
});

test("M8: while the host holds dispatch, new work is 503 HOST_PRESSURE with a Retry-After and reaches neither the core nor the ledger; reads answer; open or stale, work is served", async () => {
  const dir = mkdtempSync(join(tmpdir(), "fcpi-adm-")), file = join(dir, "admission.json");
  const put = (o) => { writeFileSync(join(dir, "a.tmp"), JSON.stringify(o)); renameSync(join(dir, "a.tmp"), file); };
  put({ utc: new Date().toISOString(), dispatch: "paused", browser: "paused", reasons: ["memory"] });
  try {
    const h = await harness({ extraEnv: { PI_ADMISSION_FILE: file } });
    const before = h.core.requests.length;
    const s = await h.call("POST", "/v2/scrape", { token: T.a, body: { url: "http://m3.fixture.fcpi.test:8080/p1" } });
    assert.deepEqual([s.status, s.json.code, s.headers["retry-after"]], [503, "HOST_PRESSURE", "60"]);
    assert.match(s.json.error, /memory/);
    const c = await h.call("POST", "/v2/crawl", { token: T.a, body: { url: "http://m3.fixture.fcpi.test:8080/" } });
    assert.deepEqual([c.status, c.json.code], [503, "HOST_PRESSURE"]);
    assert.equal(h.core.requests.length, before, "nothing reached the core");
    assert.equal((await h.db.query("SELECT count(*)::int AS n FROM fcpi_platform.job")).rows[0].n, 0, "nothing reached the ledger");
    const st = await h.call("GET", "/platform/v1/status", { token: T.ro });
    assert.deepEqual([st.status, st.json.admission.dispatch, st.json.admission.state], [200, "paused", "fresh"]);
    assert.equal((await h.call("GET", "/platform/v1/jobs", { token: T.a })).status, 200);
    // The positive control: open again (past the gateway's two-second cache), the same scrape is served.
    put({ utc: new Date().toISOString(), dispatch: "open", browser: "open", reasons: [] });
    await sleep(2100);
    assert.equal((await h.call("POST", "/v2/scrape", { token: T.a, body: { url: "http://m3.fixture.fcpi.test:8080/p1" } })).status, 200);
    // A paused file older than three minutes is a stopped tick's: open.
    put({ utc: new Date(Date.now() - 200000).toISOString(), dispatch: "paused", browser: "paused", reasons: ["memory"] });
    await sleep(2100);
    const stale = await h.call("POST", "/v2/scrape", { token: T.a, body: { url: "http://m3.fixture.fcpi.test:8080/p1" } });
    assert.equal(stale.status, 200);
    assert.equal((await h.call("GET", "/platform/v1/status", { token: T.ro })).json.admission.state, "stale");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
