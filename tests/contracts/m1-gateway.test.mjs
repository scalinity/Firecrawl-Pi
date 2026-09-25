// Contract tests for services/access/server.mjs (M1 scope). Node built-ins only:
//   node --test tests/contracts/m1-gateway.test.mjs
// A fake upstream records what reaches it and answers like the native API would,
// including a Cloud-pointing WWW-Authenticate challenge the gateway must not pass on.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer, request } from "node:http";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const GATEWAY = join(dirname(fileURLToPath(import.meta.url)), "../../services/access/server.mjs");
const TOKEN = "fcpi_test_" + "a".repeat(40);
const FIXTURE = "http://m1.fixture.fcpi.test:8080";
const seen = [];
let upstream, gw, dir, gwPort;

function call(method, path, { token, body, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? undefined : Buffer.from(typeof body === "string" ? body : JSON.stringify(body));
    const req = request({ host: "127.0.0.1", port: gwPort, method, path, headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(data ? { "content-type": "application/json", "content-length": data.length } : {}),
      ...headers,
    } }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString() }));
    });
    req.on("error", reject);
    req.end(data);
  });
}

before(async () => {
  upstream = createServer((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      seen.push({ method: req.method, url: req.url, headers: req.headers, body: Buffer.concat(chunks).toString() });
      res.writeHead(200, { "content-type": "application/json", "www-authenticate": 'Bearer resource_metadata="https://www.firecrawl.dev/.well-known/oauth-protected-resource"' });
      res.end(JSON.stringify({ success: true }));
    });
  });
  await new Promise((r) => upstream.listen(0, "127.0.0.1", r));
  dir = mkdtempSync(join(tmpdir(), "fcpi-gw-"));
  writeFileSync(join(dir, "hashes"), `# test\nm1-test sha256:${createHash("sha256").update(TOKEN).digest("hex")}\n`);
  gwPort = 20000 + Math.floor(Math.random() * 20000);
  gw = spawn(process.execPath, [GATEWAY], { env: {
    FCPI_LISTEN_PORT: String(gwPort), FCPI_UPSTREAM: `http://127.0.0.1:${upstream.address().port}`,
    FCPI_TOKEN_HASHES_FILE: join(dir, "hashes"), FCPI_ALLOWED_TARGET_ORIGINS: FIXTURE,
  }, stdio: ["ignore", "pipe", "inherit"] });
  await new Promise((resolve, reject) => {
    gw.stdout.on("data", (d) => { if (String(d).includes('"listening"')) resolve(); });
    gw.on("exit", (c) => reject(new Error(`gateway exited ${c}`)));
  });
});
after(() => { gw?.kill(); upstream?.close(); if (dir) rmSync(dir, { recursive: true }); });

test("missing token: 401 with the gateway's own challenge, nothing forwarded", async () => {
  const n = seen.length;
  const r = await call("POST", "/v2/scrape", { body: { url: `${FIXTURE}/static.html` } });
  assert.equal(r.status, 401);
  assert.deepEqual(JSON.parse(r.body), { error: "unauthorized" });
  assert.equal(r.headers["www-authenticate"], 'Bearer realm="fcpi"');
  assert.equal(seen.length, n);
});

test("wrong token and malformed schemes: 401, never the upstream challenge", async () => {
  for (const headers of [{ authorization: `Bearer ${"b".repeat(50)}` }, { authorization: `Basic ${TOKEN}` }, { authorization: `Bearer ${TOKEN} x` }, { authorization: "Bearer " }]) {
    const r = await call("POST", "/v2/scrape", { headers, body: { url: `${FIXTURE}/static.html` } });
    assert.equal(r.status, 401);
    assert.doesNotMatch(r.headers["www-authenticate"], /firecrawl\.dev/);
  }
});

test("authenticated fixture scrape is forwarded without the client's token or extra headers", async () => {
  const n = seen.length;
  const r = await call("POST", "/v2/scrape", { token: TOKEN, body: { url: `${FIXTURE}/static.html` }, headers: { "x-forwarded-for": "10.0.0.1", "x-fcpi-principal": "spoof" } });
  assert.equal(r.status, 200);
  assert.equal(r.headers["www-authenticate"], undefined, "upstream challenge stripped");
  const up = seen.at(-1);
  assert.equal(seen.length, n + 1);
  assert.equal(up.url, "/v2/scrape");
  assert.equal(up.headers.authorization, undefined);
  assert.equal(up.headers["x-forwarded-for"], undefined);
  assert.equal(up.headers["x-fcpi-principal"], undefined);
});

test("/admin/* is never routed, even authenticated", async () => {
  const n = seen.length;
  for (const p of ["/admin/integration/create-user", "/admin", "/admin/x/queues", "//admin/integration/create-user", "/%61dmin/integration/create-user"]) {
    const r = await call("POST", p, { token: TOKEN, body: {} });
    assert.equal(r.status, 404, p);
  }
  assert.equal(seen.length, n);
});

test("routes outside the allowlist are 404 and not forwarded", async () => {
  const n = seen.length;
  for (const [m, p] of [["GET", "/v2/scrape"], ["POST", "/v2/crawl"], ["POST", "/v2/search"], ["GET", "/"], ["GET", "/v0/health/liveness"], ["POST", "/v2/scrape/../crawl"]]) {
    const r = await call(m, p, { token: TOKEN, body: { url: `${FIXTURE}/static.html` } });
    assert.equal(r.status, 404, `${m} ${p}`);
  }
  assert.equal(seen.length, n);
});

test("non-fixture targets are refused before forwarding", async () => {
  const n = seen.length;
  for (const url of ["https://api.firecrawl.dev/v2/scrape", "http://nuq-postgres:5432/", "http://10.231.1.5:6379/", "http://user:pw@m1.fixture.fcpi.test:8080/static.html", "not a url"]) {
    const r = await call("POST", "/v2/scrape", { token: TOKEN, body: { url } });
    assert.equal(r.status, 403, url);
  }
  assert.equal((await call("POST", "/v2/scrape", { token: TOKEN, body: "{broken" })).status, 403);
  assert.equal(seen.length, n);
});

test("bodies over 1 MiB are refused with 413", async () => {
  const n = seen.length;
  const r = await call("POST", "/v2/scrape", { token: TOKEN, body: { url: `${FIXTURE}/static.html`, pad: "x".repeat(1024 * 1024) } });
  assert.equal(r.status, 413);
  assert.equal(seen.length, n);
});

test("unknown FCPI_* configuration keys stop startup", async () => {
  const code = await new Promise((resolve) => {
    const p = spawn(process.execPath, [GATEWAY], { env: { FCPI_UPSTREAM: "http://127.0.0.1:1", FCPI_TOKEN_HASHES_FILE: join(dir, "hashes"), FCPI_ALLOWED_TARGET_ORIGINS: FIXTURE, FCPI_TYPO: "1" }, stdio: "ignore" });
    p.on("exit", resolve);
  });
  assert.notEqual(code, 0);
});
