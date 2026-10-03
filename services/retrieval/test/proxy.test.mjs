// The browser's forward proxy against loopback servers: credentials, refusals and a target that
// answers what Node cannot relay. The policy is built here with a loopback fixture subnet, which
// the deployed policy loader never accepts; it lets the real proxy run with no network.
import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import net from "node:net";
import { createHash } from "node:crypto";
import { BlockList } from "node:net";
import { ProxySessions, startProxy } from "../src/proxy.mjs";

const lan = new BlockList();
lan.addSubnet("45.33.20.0", 24, "ipv4");
const policyFor = (port) => ({ ports: [80, 443], localCidrs: lan, cloudDenylist: ["*.firecrawl.dev", "firecrawl.dev"], maxRedirects: 3,
  fixtures: [{ host: "fx.fixture.fcpi.test", port, cidr: "127.0.0.0/24", limits: "fixture" }] });
const listening = (srv) => new Promise((r) => (srv.listening ? r() : srv.once("listening", r)));

async function withProxy(upstreamPort, fn) {
  const sessions = new ProxySessions();
  const logs = [];
  const proxy = startProxy({ listen: { host: "127.0.0.1", port: 0 }, sessions, getPolicy: () => policyFor(upstreamPort), resolvePublic: async () => [],
    lookupFixture: async () => ["127.0.0.1"], log: (o) => logs.push(o) });
  await listening(proxy);
  try { return await fn({ port: proxy.address().port, sessions, logs }); } finally { proxy.close(); }
}
function viaProxy(proxyPort, target, cred) {
  return new Promise((resolve, reject) => {
    const headers = cred ? { "proxy-authorization": `Basic ${Buffer.from(`${cred.username}:${cred.password}`).toString("base64")}` } : {};
    const req = http.request({ host: "127.0.0.1", port: proxyPort, method: "GET", path: target, headers }, (res) => {
      let body = ""; res.on("data", (c) => (body += c)); res.on("end", () => resolve({ status: res.statusCode, body }));
    });
    req.on("error", reject);
    req.end();
  });
}

test("a public page's requests cannot reach a fixture host (review finding S1)", async () => {
  const hits = [];
  const fx = http.createServer((q, r) => { hits.push(q.url); r.end("fixture"); }).listen(0, "127.0.0.1");
  await listening(fx);
  try {
    await withProxy(fx.address().port, async ({ port, sessions }) => {
      const pub = sessions.open("public-page", { expiresAt: Date.now() + 10000, maxBytes: 1 << 20 });
      const r = await viaProxy(port, `http://fx.fixture.fcpi.test:${fx.address().port}/slow`, pub);
      assert.equal(r.status, 403);
      assert.deepEqual(sessions.close("public-page").denied, [{ host: `fx.fixture.fcpi.test:${fx.address().port}`, class: "SSRF_DENIED",
        urlHash: createHash("sha256").update(`http://fx.fixture.fcpi.test:${fx.address().port}/slow`).digest("hex") }]);
      const own = sessions.open("fixture-page", { fixture: true, expiresAt: Date.now() + 10000, maxBytes: 1 << 20 });
      assert.deepEqual(await viaProxy(port, `http://fx.fixture.fcpi.test:${fx.address().port}/ok`, own), { status: 200, body: "fixture" });
      sessions.close("fixture-page");
    });
    assert.deepEqual(hits, ["/ok"]);
  } finally { fx.close(); }
});

test("a target status Node cannot relay is a 502, and the proxy keeps serving (review finding C2)", async () => {
  const bad = net.createServer((s) => s.once("data", () => s.end("HTTP/1.1 099 Odd\r\ncontent-length: 0\r\n\r\n"))).listen(0, "127.0.0.1");
  const good = http.createServer((q, r) => r.end("fine")).listen(0, "127.0.0.1");
  await Promise.all([listening(bad), listening(good)]);
  try {
    await withProxy(bad.address().port, async ({ port, sessions }) => {
      const cred = sessions.open("attempt-1", { fixture: true, expiresAt: Date.now() + 10000, maxBytes: 1 << 20 });
      const r = await viaProxy(port, `http://fx.fixture.fcpi.test:${bad.address().port}/x`, cred);
      assert.equal(r.status, 502);
      assert.deepEqual(sessions.close("attempt-1").denied, [{ host: `fx.fixture.fcpi.test:${bad.address().port}`, class: "PROXY_ERROR" }]);
    });
    await withProxy(good.address().port, async ({ port, sessions }) => {
      const cred = sessions.open("attempt-2", { fixture: true, expiresAt: Date.now() + 10000, maxBytes: 1 << 20 });
      const r = await viaProxy(port, `http://fx.fixture.fcpi.test:${good.address().port}/`, cred);
      assert.deepEqual(r, { status: 200, body: "fine" });
    });
  } finally { bad.close(); good.close(); }
});

test("no credential, a wrong one or an expired one gets 407; a refused target 403 with the attempt named", async () => {
  const good = http.createServer((q, r) => r.end("fine")).listen(0, "127.0.0.1");
  await listening(good);
  try {
    await withProxy(good.address().port, async ({ port, sessions, logs }) => {
      const url = `http://fx.fixture.fcpi.test:${good.address().port}/`;
      assert.equal((await viaProxy(port, url, null)).status, 407);
      const cred = sessions.open("attempt-3", { fixture: true, expiresAt: Date.now() + 10000, maxBytes: 1 << 20 });
      assert.equal((await viaProxy(port, url, { ...cred, password: "0".repeat(48) })).status, 407);
      const old = sessions.open("attempt-4", { fixture: true, expiresAt: Date.now() - 1, maxBytes: 1 << 20 });
      assert.equal((await viaProxy(port, url, old)).status, 407);
      assert.equal((await viaProxy(port, "http://127.0.0.1:6379/", cred)).status, 403);
      assert.equal(logs.find((l) => l.event === "proxy_denied")?.attempt_id, "attempt-3");
      assert.equal((await viaProxy(port, url, cred)).status, 200);
    });
  } finally { good.close(); }
});

test("a session past its request or byte cap is refused and marked capped (review finding W6)", async () => {
  const big = http.createServer((q, r) => r.end("x".repeat(64 * 1024))).listen(0, "127.0.0.1");
  await listening(big);
  try {
    await withProxy(big.address().port, async ({ port, sessions }) => {
      const url = `http://fx.fixture.fcpi.test:${big.address().port}/`;
      const byReq = sessions.open("req-cap", { fixture: true, expiresAt: Date.now() + 10000, maxBytes: 1 << 24, maxRequests: 2 });
      assert.equal((await viaProxy(port, url, byReq)).status, 200);
      assert.equal((await viaProxy(port, url, byReq)).status, 200);
      assert.equal((await viaProxy(port, url, byReq)).status, 403);
      const a = sessions.close("req-cap");
      assert.equal(a.capped, true);
      assert.deepEqual(a.denied.map((d) => d.class), ["RESOURCE_LIMIT"]);
      const byBytes = sessions.open("byte-cap", { fixture: true, expiresAt: Date.now() + 10000, maxBytes: 1024, maxRequests: 50 });
      await viaProxy(port, url, byBytes).catch(() => null);
      assert.equal(sessions.close("byte-cap").capped, true);
    });
  } finally { big.close(); }
});

test("the proxy answers 503 while the local-network list is not loaded (review finding W7)", async () => {
  const good = http.createServer((q, r) => r.end("fine")).listen(0, "127.0.0.1");
  await listening(good);
  const sessions = new ProxySessions();
  const proxy = startProxy({ listen: { host: "127.0.0.1", port: 0 }, sessions, getPolicy: () => ({ ...policyFor(good.address().port), localCidrs: undefined }),
    resolvePublic: async () => [], lookupFixture: async () => ["127.0.0.1"], log: () => {} });
  await listening(proxy);
  try {
    const cred = sessions.open("not-ready", { fixture: true, expiresAt: Date.now() + 10000, maxBytes: 1 << 20 });
    assert.equal((await viaProxy(proxy.address().port, `http://fx.fixture.fcpi.test:${good.address().port}/`, cred)).status, 503);
    assert.deepEqual(sessions.close("not-ready").denied.map((d) => d.class), ["RETRIEVAL_NOT_READY"]);
  } finally { proxy.close(); good.close(); }
});

test("malformed credentials, CONNECT to a non-443 port, forwarded proxy credentials and a closed session (review finding W9)", async () => {
  let seenAuth = "unset", hold = null;
  const up = http.createServer((q, r) => {
    seenAuth = q.headers["proxy-authorization"] ?? null;
    if (q.url === "/slow") { hold = r; r.writeHead(200); r.write("partial"); } else r.end("fine");
  }).listen(0, "127.0.0.1");
  await listening(up);
  try {
    await withProxy(up.address().port, async ({ port, sessions }) => {
      const url = `http://fx.fixture.fcpi.test:${up.address().port}`;
      const malformed = await new Promise((resolve) => http.request({ host: "127.0.0.1", port, path: `${url}/`, headers: { "proxy-authorization": "Basic %%%" } }, (r) => resolve(r.statusCode)).end());
      assert.equal(malformed, 407);
      const cred = sessions.open("edge", { fixture: true, expiresAt: Date.now() + 10000, maxBytes: 1 << 20 });
      assert.equal((await viaProxy(port, `${url}/`, cred)).status, 200);
      assert.equal(seenAuth, null); // the attempt's credential never reaches the target
      const connect = await new Promise((resolve) => {
        const s = net.connect(port, "127.0.0.1", () => s.write(`CONNECT example.com:80 HTTP/1.1\r\nhost: example.com:80\r\nproxy-authorization: Basic ${Buffer.from(`${cred.username}:${cred.password}`).toString("base64")}\r\n\r\n`));
        let d = ""; s.on("data", (c) => { d += c; }); s.on("end", () => resolve(d)); s.on("error", () => resolve(d));
      });
      assert.match(connect, /^HTTP\/1\.1 403/);
      // Closing the session tears down its open connections.
      const partial = new Promise((resolve) => {
        const req = http.request({ host: "127.0.0.1", port, path: `${url}/slow`, headers: { "proxy-authorization": `Basic ${Buffer.from(`${cred.username}:${cred.password}`).toString("base64")}` } }, (r) => {
          r.on("data", () => sessions.close("edge"));
          r.on("close", () => resolve("closed")); r.on("error", () => resolve("closed"));
        });
        req.on("error", () => resolve("closed"));
        req.end();
      });
      assert.equal(await partial, "closed");
    });
  } finally { hold?.destroy(); up.close(); }
});

test("a standing session's refusals are logged by host and not kept, so it cannot grow (review S5)", async () => {
  await withProxy(1, async ({ port, sessions, logs }) => {
    const cred = "standing-session-credential";
    sessions.fixed("searxng", createHash("sha256").update(cred).digest(), { allow: () => false, fixture: false });
    for (let i = 0; i < 3; i++) assert.equal((await viaProxy(port, "http://engine.example.org/search", { username: "searxng", password: cred })).status, 403);
    assert.equal(logs.filter((l) => l.event === "proxy_denied" && l.attempt_id === "searxng" && l.failure === "DESTINATION_NOT_ALLOWED").length, 3);
    assert.deepEqual(sessions.close("searxng").denied, []);
  });
});
