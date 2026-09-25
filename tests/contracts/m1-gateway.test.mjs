// Contract tests for services/access/server.mjs (M1 scope). Node built-ins only:
//   node --test tests/contracts/m1-gateway.test.mjs
// A fake upstream records what reaches it and answers like the native API would,
// including a Cloud-pointing WWW-Authenticate challenge the gateway must not pass on.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer, request } from "node:http";
import { spawn } from "node:child_process";
import { connect } from "node:net";
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
      const body = Buffer.concat(chunks).toString();
      seen.push({ method: req.method, url: req.url, headers: req.headers, body });
      let mode = null;
      try { mode = JSON.parse(body).fakeUpstream ?? null; } catch { /* not JSON */ }
      res.writeHead(200, { "content-type": "application/json", "www-authenticate": 'Bearer resource_metadata="https://www.firecrawl.dev/.well-known/oauth-protected-resource"' });
      // The core dying mid-response: headers and part of a body, then the socket drops.
      if (mode === "abort-after-headers") { res.write('{"partial":'); setTimeout(() => res.socket.destroy(), 50); return; }
      res.end(JSON.stringify({ success: true }));
    });
  });
  await new Promise((r) => upstream.listen(0, "127.0.0.1", r));
  dir = mkdtempSync(join(tmpdir(), "fcpi-gw-"));
  writeFileSync(join(dir, "hashes"), `# test\nm1-test sha256:${createHash("sha256").update(TOKEN).digest("hex")}\n`);
  ({ proc: gw, port: gwPort } = await startGateway({ PI_CORE_URL: `http://127.0.0.1:${upstream.address().port}` }));
});

// Starts a gateway on an OS-assigned port (PI_GATEWAY_LISTEN_PORT=0) and resolves with the
// port it reports, or rejects if it exits or does not start listening within 10 s.
function startGateway(env) {
  const proc = spawn(process.execPath, [GATEWAY], { env: {
    PI_GATEWAY_LISTEN_PORT: "0", PI_GATEWAY_TOKEN_HASHES_FILE: join(dir, "hashes"), PI_PERMITTED_TARGET_ORIGINS: FIXTURE, ...env,
  }, stdio: ["ignore", "pipe", "inherit"] });
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { proc.kill(); reject(new Error("gateway did not start listening within 10 s")); }, 10000);
    proc.stdout.on("data", (d) => {
      const line = String(d).split("\n").find((l) => l.includes('"listening"'));
      if (line) { clearTimeout(timer); resolve({ proc, port: JSON.parse(line).listening }); }
    });
    proc.on("exit", (c) => { clearTimeout(timer); reject(new Error(`gateway exited ${c}`)); });
  });
}
after(() => { gw?.kill(); upstream?.closeAllConnections(); upstream?.close(); if (dir) rmSync(dir, { recursive: true }); });

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

test("a chunked body over 1 MiB (no Content-Length) gets a 413 response, not a reset", async () => {
  const n = seen.length;
  const reply = await new Promise((resolve) => {
    const s = connect(gwPort, "127.0.0.1");
    const got = [];
    s.on("data", (d) => got.push(d));
    s.on("error", () => {}); // late writes after the gateway closes may fail; the reply is what matters
    s.on("close", () => resolve(Buffer.concat(got).toString()));
    s.write(`POST /v2/scrape HTTP/1.1\r\nhost: gw\r\nauthorization: Bearer ${TOKEN}\r\ncontent-type: application/json\r\ntransfer-encoding: chunked\r\n\r\n`);
    const chunk = Buffer.alloc(64 * 1024, 0x78);
    for (let sent = 0; sent <= 1024 * 1024; sent += chunk.length) s.write(`${chunk.length.toString(16)}\r\n${chunk}\r\n`);
    s.end("0\r\n\r\n");
  });
  assert.match(reply, /^HTTP\/1\.1 413 /);
  assert.match(reply, /"error":"body_too_large"/);
  assert.equal(seen.length, n);
});

test("an upstream that dies after its headers ends the client response instead of hanging it", { timeout: 10000 }, async () => {
  const outcome = await new Promise((resolve) => {
    const data = Buffer.from(JSON.stringify({ url: `${FIXTURE}/static.html`, fakeUpstream: "abort-after-headers" }));
    const timer = setTimeout(() => resolve("hung"), 5000);
    const req = request({ host: "127.0.0.1", port: gwPort, method: "POST", path: "/v2/scrape", headers: {
      authorization: `Bearer ${TOKEN}`, "content-type": "application/json", "content-length": data.length } }, (res) => {
      res.on("data", () => {});
      res.on("error", () => {});
      res.on("close", () => { clearTimeout(timer); resolve(res.complete ? "complete" : "cut"); });
    });
    req.on("error", () => { clearTimeout(timer); resolve("cut"); });
    req.end(data);
  });
  assert.equal(outcome, "cut");
});

test("unknown PI_* configuration keys stop startup", async () => {
  const code = await new Promise((resolve) => {
    const p = spawn(process.execPath, [GATEWAY], { env: { PI_CORE_URL: "http://127.0.0.1:1", PI_GATEWAY_TOKEN_HASHES_FILE: join(dir, "hashes"), PI_PERMITTED_TARGET_ORIGINS: FIXTURE, PI_TYPO: "1" }, stdio: "ignore" });
    p.on("exit", resolve);
  });
  assert.notEqual(code, 0);
});
