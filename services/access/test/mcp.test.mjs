// Unit tests for the gateway's /mcp route (services/access/src/mcp.mjs): the proxy on its own, between a
// test client and a fake MCP service, with the gateway's checks already passed (as server.mjs calls it).
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { createServer, request } from "node:http";
import { randomUUID } from "node:crypto";
import { makeMcpProxy } from "../src/mcp.mjs";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const upstream = { seen: [], mode: "json", server: null };
upstream.server = createServer((req, res) => {
  const chunks = [];
  const rec = { method: req.method, headers: req.headers, body: null, closedEarly: false };
  upstream.seen.push(rec);
  req.on("data", (c) => chunks.push(c));
  req.on("end", async () => {
    rec.body = Buffer.concat(chunks).toString();
    res.on("close", () => { if (!res.writableFinished) rec.closedEarly = true; });
    if (upstream.mode === "sse") {
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", "mcp-session-id": "must-not-pass", "set-cookie": "x=1" });
      res.write('event: message\ndata: {"jsonrpc":"2.0","method":"notifications/progress","params":{}}\n\n');
      await sleep(400);
      res.end('event: message\ndata: {"jsonrpc":"2.0","id":1,"result":{}}\n\n');
      return;
    }
    if (upstream.mode === "hang") return;          // never answers: the client gives up
    if (upstream.mode === "headers-then-hang") { res.writeHead(200, { "content-type": "text/event-stream" }); res.write(": started\n\n"); return; }
    res.writeHead(200, { "content-type": "application/json", "mcp-session-id": "must-not-pass" });
    res.end('{"jsonrpc":"2.0","id":1,"result":{}}');
  });
});
await new Promise((r) => upstream.server.listen(0, "127.0.0.1", r));

const logged = [];
function gateway(proxy) {
  const s = createServer((req, res) => {
    const ctx = { id: randomUUID(), req, res, client: { label: "m4a", principal: "owner", scopes: new Set(["scrape", "read"]) }, done: false };
    ctx.logged = (status) => { if (!ctx.done) { ctx.done = true; logged.push({ status, ...ctx.extra }); } };
    ctx.send = (status, body, extra = {}) => { res.writeHead(status, { "content-type": "application/json", ...extra }); res.end(JSON.stringify(body)); ctx.logged(status); };
    proxy.handle(ctx).catch((e) => ctx.send(e.status ?? 500, { code: e.code }));
  });
  return new Promise((r) => s.listen(0, "127.0.0.1", () => r(s)));
}
const readBody = (req) => new Promise((resolve) => { const c = []; req.on("data", (x) => c.push(x)); req.on("end", () => resolve(Buffer.concat(c))); });
const send = (ctx, status, body, extra) => ctx.send(status, body, extra);
const limits = { maxInFlight: 2, exchangeTimeoutMs: 5000 };
const proxy = makeMcpProxy({ url: new URL(`http://127.0.0.1:${upstream.server.address().port}`), limits, readBody, send });
const gw = await gateway(proxy);
const dead = await gateway(makeMcpProxy({ url: new URL("http://127.0.0.1:9"), limits, readBody, send }));
after(() => { upstream.server.close(); gw.close(); dead.close(); });

function post(server, { headers = {}, body = '{"jsonrpc":"2.0","id":1,"method":"tools/list"}', onFirstChunk, abortAfterMs } = {}) {
  return new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port: server.address().port, method: "POST", path: "/mcp", headers: { host: "127.0.0.1:3380", "content-type": "application/json", accept: "application/json, text/event-stream", authorization: "Bearer fcpi_m4a_" + "c".repeat(64), ...headers } }, (res) => {
      const chunks = [], times = [];
      res.on("data", (c) => { chunks.push(c); times.push(Date.now()); onFirstChunk?.(); onFirstChunk = null; });
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, text: Buffer.concat(chunks).toString(), times }));
      // A stream the gateway cuts never ends: it is reported as cut, with what arrived.
      res.on("aborted", () => resolve({ status: res.statusCode, cut: true, text: Buffer.concat(chunks).toString(), times }));
      res.on("error", () => resolve({ status: res.statusCode, cut: true, text: Buffer.concat(chunks).toString(), times }));
    });
    req.on("error", (e) => (abortAfterMs ? resolve({ aborted: true }) : reject(e)));
    if (abortAfterMs) setTimeout(() => req.destroy(), abortAfterMs);
    req.end(body);
  });
}

test("the MCP service gets the protocol headers, the token, the Host and the validated identity, and nothing else", async () => {
  upstream.mode = "json";
  const r = await post(gw, { headers: { "mcp-protocol-version": "2026-07-28", "mcp-method": "tools/list", "mcp-param-region": "x", "x-fcpi-principal": "someone-else", "x-fcpi-client": "forged", origin: "https://evil.example", cookie: "a=b", "x-forwarded-for": "1.2.3.4" } });
  assert.equal(r.status, 200);
  const h = upstream.seen.at(-1).headers;
  assert.equal(h["x-fcpi-principal"], "owner");
  assert.equal(h["x-fcpi-client"], "m4a");
  assert.equal(h["x-fcpi-scopes"], "read,scrape");
  assert.equal(h["mcp-protocol-version"], "2026-07-28");
  assert.equal(h["mcp-method"], "tools/list");
  assert.equal(h["mcp-param-region"], "x");
  assert.equal(h.host, "127.0.0.1:3380");
  assert.match(h.authorization, /^Bearer fcpi_m4a_/);
  for (const k of ["origin", "cookie", "x-forwarded-for"]) assert.equal(h[k], undefined, `${k} must not pass`);
  // Only content-type and cache-control come back, with the gateway's request id.
  assert.equal(r.headers["mcp-session-id"], undefined);
  assert.equal(r.headers["content-type"], "application/json");
  assert.match(r.headers["x-request-id"], /^[0-9a-f-]{36}$/);
  assert.equal(logged.at(-1).mcp_method, "tools/list");
});

test("an SSE answer streams through as it is written, not when it ends", async () => {
  upstream.mode = "sse";
  const r = await post(gw);
  assert.equal(r.headers["content-type"], "text/event-stream");
  assert.equal(r.headers["set-cookie"], undefined);
  assert.ok(r.times.length >= 2 && r.times.at(-1) - r.times[0] >= 300, `chunks arrived ${r.times.map((t) => t - r.times[0]).join(",")} ms apart`);
  assert.match(r.text, /notifications\/progress[\s\S]*"result"/);
});

test("a client that goes away cancels the MCP request behind it", async () => {
  upstream.mode = "hang";
  const n = upstream.seen.length;
  const r = await post(gw, { abortAfterMs: 300 });
  assert.equal(r.aborted, true);
  await sleep(200);
  assert.equal(upstream.seen[n].closedEarly, true);
  assert.equal(logged.at(-1).status, 499);
  assert.equal(proxy.inFlight, 0);
});

test("a stopped MCP service is 503 MCP_UNAVAILABLE, promptly", async () => {
  const t0 = Date.now();
  const r = await post(dead);
  assert.equal(r.status, 503);
  assert.equal(JSON.parse(r.text).code, "MCP_UNAVAILABLE");
  assert.equal(r.headers["retry-after"], "5");
  assert.ok(Date.now() - t0 < 3000);
});

test("past the in-flight cap the gateway answers 503 OVERLOADED without forwarding", async () => {
  upstream.mode = "hang";
  const held = [post(gw, { abortAfterMs: 1500 }), post(gw, { abortAfterMs: 1500 })];
  await sleep(200);
  const n = upstream.seen.length;
  const r = await post(gw);
  assert.equal(r.status, 503);
  assert.equal(JSON.parse(r.text).code, "OVERLOADED");
  assert.equal(upstream.seen.length, n);
  await Promise.all(held);
  await sleep(100);
  assert.equal(proxy.inFlight, 0);
});

test("the exchange deadline ends an MCP request that never answers, and cuts one that stops mid-stream", async () => {
  const quick = makeMcpProxy({ url: new URL(`http://127.0.0.1:${upstream.server.address().port}`), limits: { maxInFlight: 2, exchangeTimeoutMs: 300 }, readBody, send });
  const g = await gateway(quick);
  try {
    upstream.mode = "hang";
    const t0 = Date.now();
    const r = await post(g);
    assert.equal(r.status, 503);
    assert.equal(JSON.parse(r.text).code, "MCP_UNAVAILABLE");
    assert.ok(Date.now() - t0 < 2000);
    upstream.mode = "headers-then-hang";
    const cut = await post(g);
    assert.equal(cut.status, 200);
    assert.equal(cut.cut, true, "the stream was started, then cut");
    assert.match(cut.text, /: started/);
    await sleep(100);
    assert.equal(logged.at(-1).status, 502);
    assert.equal(quick.inFlight, 0);
  } finally { g.close(); }
});

test("the manifest's MCP section is checked only when the gateway serves /mcp", async () => {
  const { checkManifest } = await import("../src/config.mjs");
  const { readFileSync } = await import("node:fs");
  const m = JSON.parse(readFileSync(process.env.FCPI_TEST_MANIFEST ?? new URL("../../../deploy/policies/capabilities.json", import.meta.url), "utf8"));
  checkManifest(m, { mcp: true });
  const broken = structuredClone(m); broken.mcp.limits.maxInFlight = 0;
  assert.throws(() => checkManifest(broken, { mcp: true }), /mcp\.limits\.maxInFlight/);
  checkManifest(broken);                 // REST alone: the MCP section cannot stop it
  const none = structuredClone(m); delete none.mcp;
  checkManifest(none);
  assert.throws(() => checkManifest(none, { mcp: true }), /mcp\.path/);
});
