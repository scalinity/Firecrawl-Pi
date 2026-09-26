// Integration tests for the MCP gateway (services/mcp/server.mjs): the real server, started as a process,
// against a fake access gateway that records every request it receives, spoken to over raw HTTP so the
// wire (status codes, JSON-RPC error codes, headers, JSON or SSE) is asserted exactly, in both eras.
// Runs on the workstation and inside the image on the Pi (scripts/m4/pi-mcp-tests.sh); FCPI_TEST_MANIFEST
// locates deploy/policies/capabilities.json when the repository layout is not around the test.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer, request } from "node:http";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";

const MANIFEST_PATH = process.env.FCPI_TEST_MANIFEST ?? fileURLToPath(new URL("../../../deploy/policies/capabilities.json", import.meta.url));
const SERVER = fileURLToPath(new URL("../server.mjs", import.meta.url));
const TOK = "fcpi_m4t_" + "a".repeat(64), TOK_RO = "fcpi_m4ro_" + "b".repeat(64);
const HOST = "127.0.0.1:3380";
const MODERN = "2026-07-28", LEGACY = "2025-11-25";
const META = { "io.modelcontextprotocol/protocolVersion": MODERN, "io.modelcontextprotocol/clientCapabilities": {}, "io.modelcontextprotocol/clientInfo": { name: "fcpi-test", version: "1" } };
const JOB = "0f8fad5b-d9cb-469f-a165-70867728950e";
const JOB_BIG = "1f8fad5b-d9cb-469f-a165-70867728950e", JOB_HUGE = "2f8fad5b-d9cb-469f-a165-70867728950e";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- the fake access gateway --------------------------------------------------------------------------
const seen = [];
const fake = createServer((req, res) => {
  const chunks = [];
  const rec = { method: req.method, url: req.url, headers: req.headers, body: null, closedEarly: false };
  seen.push(rec);
  req.on("data", (c) => chunks.push(c));
  req.on("end", async () => {
    rec.body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : null;
    const send = (st, b) => { if (!res.destroyed) { res.writeHead(st, { "content-type": "application/json", "x-request-id": randomUUID() }); res.end(JSON.stringify(b)); } };
    res.on("close", () => { if (!res.writableFinished) rec.closedEarly = true; });
    const u = new URL(req.url, "http://gw");
    if (req.headers.authorization === `Bearer ${TOK_RO}` && req.method === "POST") return send(403, { success: false, code: "INSUFFICIENT_SCOPE", error: "This token lacks the 'scrape' scope." });
    // A malformed gateway answer that makes shaping throw: links an object, not a list.
    if (req.method === "POST" && u.pathname === "/v2/map" && /badlinks/.test(rec.body.url)) return send(200, { success: true, links: { length: 5, pad: "y".repeat(300000) } });
    if (req.method === "POST" && u.pathname === "/v2/scrape") {
      if (/slow/.test(rec.body.url)) { await sleep(3000); return send(200, { success: true, data: { markdown: "late" } }); }
      if (/big/.test(rec.body.url)) return send(200, { success: true, data: { markdown: "x".repeat(700000), metadata: { sourceURL: rec.body.url } } });
      if (/hugemeta/.test(rec.body.url)) return send(200, { success: true, data: { markdown: "# small", metadata: Object.fromEntries(Array.from({ length: 3000 }, (_, i) => [`og:tag${i}`, "v".repeat(100)])) } });
      return send(200, { success: true, data: { markdown: "# fixture page", metadata: { sourceURL: rec.body.url, statusCode: 200 } } });
    }
    if (req.method === "POST" && u.pathname === "/v2/crawl" && /dropme/.test(rec.body.url)) return req.socket.destroy();   // recorded, answer lost
    if (req.method === "POST" && u.pathname === "/v2/crawl") return send(200, { success: true, id: JOB, url: `http://${req.headers.host}/v2/crawl/${JOB}` });
    // A page over the MCP answer cap unless read one document at a time; and one whose single document is.
    if (req.method === "GET" && (u.pathname === `/v2/crawl/${JOB_BIG}` || u.pathname === `/v2/crawl/${JOB_HUGE}`)) {
      const one = u.searchParams.get("limit") === "1" && u.pathname.endsWith(JOB_BIG);
      return send(200, { success: true, status: "completed", completed: 3, total: 3, data: one ? [{ markdown: "small" }] : Array.from({ length: 3 }, () => ({ markdown: "x".repeat(1600000) })) });
    }
    if (req.method === "GET" && u.pathname === `/v2/crawl/${JOB}`) return send(200, { success: true, status: "completed", completed: 2, total: 2, creditsUsed: 2, expiresAt: "2026-10-03T00:00:00.000Z", data: [{ markdown: "a" }, { markdown: "b" }] });
    if (req.method === "GET" && u.pathname === "/platform/v1/status") return send(200, { success: true, service: "access-gateway" });
    send(404, { success: false, error: "Job not found" });
  });
});

let proc, port, logs = [];
before(async () => {
  await new Promise((r) => fake.listen(0, "127.0.0.1", r));
  proc = spawn(process.execPath, [SERVER], { env: { PATH: process.env.PATH, PI_MCP_LISTEN_PORT: "0", PI_MCP_REST_URL: `http://127.0.0.1:${fake.address().port}`, PI_CAPABILITIES_FILE: MANIFEST_PATH, PI_CLOUD_ACCESS_ENABLED: "false", FCPI_SOURCE_COMMIT: "0".repeat(40) }, stdio: ["ignore", "pipe", "inherit"] });
  let buf = "";
  port = await new Promise((resolve, reject) => {
    proc.stdout.on("data", (c) => {
      buf += c;
      let i;
      while ((i = buf.indexOf("\n")) >= 0) { const l = buf.slice(0, i); buf = buf.slice(i + 1); try { const o = JSON.parse(l); logs.push(o); if (o.event === "listening") resolve(o.port); } catch { /* not a record */ } }
    });
    proc.on("exit", (c) => reject(new Error(`server exited ${c}`)));
  });
});
after(() => { proc?.kill(); fake.close(); });

// ---- the wire -----------------------------------------------------------------------------------------
const identity = (tok = TOK) => ({ host: HOST, authorization: `Bearer ${tok}`, "x-fcpi-client": "m4t", "x-fcpi-principal": "tester", "x-fcpi-scopes": "read,scrape,map,crawl,batch,cancel", "x-request-id": randomUUID() });
function http(method, { headers = {}, body, signal } = {}) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? undefined : Buffer.from(typeof body === "string" ? body : JSON.stringify(body));
    const req = request({ host: "127.0.0.1", port, method, path: "/mcp", headers: { ...(data ? { "content-type": "application/json", "content-length": data.length } : {}), accept: "application/json, text/event-stream", ...headers } }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => {
        const text = Buffer.concat(chunks).toString();
        const sse = /text\/event-stream/.test(res.headers["content-type"] ?? "");
        const messages = sse ? text.split("\n").filter((l) => l.startsWith("data: ")).map((l) => JSON.parse(l.slice(6))) : text ? [JSON.parse(text)] : [];
        resolve({ status: res.statusCode, headers: res.headers, sse, messages, last: messages.at(-1) });
      });
    });
    signal?.addEventListener("abort", () => req.destroy(new Error("aborted")));
    req.on("error", reject);
    req.end(data);
  });
}
const modern = (method, params = {}, { tok, headers = {}, id = 1, meta = META, signal } = {}) => http("POST", { signal, headers: { ...identity(tok), "mcp-protocol-version": MODERN, "mcp-method": method,
  ...(method === "tools/call" ? { "mcp-name": params.name } : {}), ...headers }, body: { jsonrpc: "2.0", id, method, params: { ...params, _meta: { ...meta, ...(params._meta ?? {}) } } } });
const call = (name, args, opts) => modern("tools/call", { name, arguments: args }, opts);
const payload = (r) => JSON.parse(r.last.result.content[0].text);
const restCalls = (pred) => seen.filter(pred).length;

// ---- tests --------------------------------------------------------------------------------------------
test("a request that did not come through the gateway is refused before the SDK sees it", async () => {
  const r = await http("POST", { headers: { host: HOST, "mcp-protocol-version": MODERN, "mcp-method": "tools/list" }, body: { jsonrpc: "2.0", id: 1, method: "tools/list", params: { _meta: META } } });
  assert.equal(r.status, 401);
  assert.equal(r.last.code, "NO_GATEWAY_IDENTITY");
});

test("modern discovery: capabilities without listChanged, private 60 s cache, server identity, no session", async () => {
  const r = await modern("server/discover");
  assert.equal(r.status, 200);
  assert.equal(r.headers["mcp-session-id"], undefined);
  const res = r.last.result;
  assert.deepEqual(res.capabilities.tools, { listChanged: false });
  assert.ok(res.supportedVersions.includes(MODERN));
  assert.equal(res.ttlMs, 60000);
  assert.equal(res.cacheScope, "private");
  assert.equal(res._meta["io.modelcontextprotocol/serverInfo"].name, "fcpi-mcp-gateway");
});

test("the catalog is deterministic and sorted, and cacheable privately for 60 s", async () => {
  const a = await modern("tools/list"), b = await modern("tools/list", {}, { id: 9 });
  const names = a.last.result.tools.map((t) => t.name);
  assert.deepEqual(names, [...names].sort());
  assert.equal(names.length, 9);
  assert.deepEqual(a.last.result.tools, b.last.result.tools);
  assert.equal(a.last.result.ttlMs, 60000);
  assert.equal(a.last.result.cacheScope, "private");
});

test("a direct modern tools/call, with no discovery or initialize first, reaches the gateway with the caller's token and host", async () => {
  const before = seen.length;
  const r = await call("firecrawl_scrape", { url: "https://example.com/page", formats: ["markdown"] });
  assert.equal(r.status, 200);
  assert.equal(r.sse, false, "no progress was asked for, so one JSON body");
  assert.equal(r.headers["mcp-session-id"], undefined);
  assert.equal(r.last.result.resultType, "complete");
  assert.equal(payload(r).data.markdown, "# fixture page");
  const q = seen.slice(before).find((s) => s.url === "/v2/scrape");
  assert.equal(q.headers.authorization, `Bearer ${TOK}`);
  assert.equal(q.headers.host, HOST);
  assert.deepEqual(q.body, { url: "https://example.com/page", formats: ["markdown"] });
  for (const k of Object.keys(q.headers)) assert.ok(!/^x-fcpi-|^mcp-/.test(k), `${k} must not reach the gateway's REST route`);
});

test("malformed, missing and mismatched modern metadata is rejected by the modern path, and no tool runs", async () => {
  const before = restCalls((s) => s.url === "/v2/scrape");
  const args = { name: "firecrawl_scrape", arguments: { url: "https://example.com/never" } };
  const body = (params, id = 5) => ({ jsonrpc: "2.0", id, method: "tools/call", params });
  const cases = [
    ["missing MCP-Protocol-Version", { "mcp-method": "tools/call", "mcp-name": args.name }, body({ ...args, _meta: META }), 400, -32020],
    ["missing Mcp-Method", { "mcp-protocol-version": MODERN, "mcp-name": args.name }, body({ ...args, _meta: META }), 400, -32020],
    ["Mcp-Method disagrees", { "mcp-protocol-version": MODERN, "mcp-method": "tools/list", "mcp-name": args.name }, body({ ...args, _meta: META }), 400, -32020],
    ["Mcp-Name disagrees", { "mcp-protocol-version": MODERN, "mcp-method": "tools/call", "mcp-name": "firecrawl_map" }, body({ ...args, _meta: META }), 400, -32020],
    ["header and envelope versions disagree", { "mcp-protocol-version": LEGACY, "mcp-method": "tools/call", "mcp-name": args.name }, body({ ...args, _meta: META }), 400, -32020],
    ["modern header without the envelope", { "mcp-protocol-version": MODERN, "mcp-method": "tools/call", "mcp-name": args.name }, body(args), 400, -32602],
    ["malformed envelope", { "mcp-protocol-version": MODERN, "mcp-method": "tools/call", "mcp-name": args.name }, body({ ...args, _meta: { ...META, "io.modelcontextprotocol/clientCapabilities": "all" } }), 400, -32602],
    ["unsupported revision", { "mcp-protocol-version": "2099-01-01", "mcp-method": "tools/call", "mcp-name": args.name }, body({ ...args, _meta: { ...META, "io.modelcontextprotocol/protocolVersion": "2099-01-01" } }), 400, -32022],
  ];
  for (const [name, h, b, status, code] of cases) {
    const r = await http("POST", { headers: { ...identity(), ...h }, body: b });
    assert.equal(r.status, status, name);
    assert.equal(r.last.error?.code, code, name);
  }
  assert.equal(restCalls((s) => s.url === "/v2/scrape"), before, "no rejected request reached the gateway");
});

test("2025-11-25 through the stateless fallback: initialize, then calls with no session", async () => {
  const h = (extra = {}) => ({ ...identity(), ...extra });
  const init = await http("POST", { headers: h(), body: { jsonrpc: "2.0", id: 0, method: "initialize", params: { protocolVersion: LEGACY, capabilities: {}, clientInfo: { name: "legacy", version: "1" } } } });
  assert.equal(init.status, 200);
  assert.equal(init.headers["mcp-session-id"], undefined);
  assert.equal(init.last.result.protocolVersion, LEGACY);
  assert.deepEqual(init.last.result.capabilities.tools, { listChanged: false });
  const list = await http("POST", { headers: h({ "mcp-protocol-version": LEGACY }), body: { jsonrpc: "2.0", id: 1, method: "tools/list" } });
  assert.equal(list.last.result.tools.length, 9);
  const r = await http("POST", { headers: h({ "mcp-protocol-version": LEGACY }), body: { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "firecrawl_scrape", arguments: { url: "https://example.com/legacy" } } } });
  assert.equal(JSON.parse(r.last.result.content[0].text).data.markdown, "# fixture page");
  assert.equal(r.last.result.resultType, undefined, "2025-era results carry no resultType");
  const g = await http("GET", { headers: h({ "mcp-protocol-version": LEGACY }) });
  assert.equal(g.status, 405);
  const d = await http("DELETE", { headers: h({ "mcp-protocol-version": LEGACY }) });
  assert.equal(d.status, 405);
});

test("a subscription stream is refused in-band rather than held open", async () => {
  const r = await modern("subscriptions/listen", { notifications: { toolsListChanged: true } });
  assert.equal(r.last.error.code, -32603);
});

test("a caller that asks for progress gets a request-scoped SSE stream: the notification, then the result", async () => {
  const r = await modern("tools/call", { name: "firecrawl_scrape", arguments: { url: "https://example.com/sse" }, _meta: { progressToken: "p1" } });
  assert.equal(r.sse, true);
  assert.equal(r.messages[0].method, "notifications/progress");
  assert.equal(r.messages[0].params.progressToken, "p1");
  assert.equal(JSON.parse(r.last.result.content[0].text).data.markdown, "# fixture page");
});

test("closing the request cancels it: the tool's gateway call is aborted, with request id 0", async () => {
  const ac = new AbortController();
  const p = call("firecrawl_scrape", { url: "https://example.com/slow" }, { id: 0, signal: ac.signal }).catch((e) => e);
  await sleep(600);
  ac.abort();
  await p;
  await sleep(300);
  const q = seen.find((s) => s.url === "/v2/scrape" && s.body?.url === "https://example.com/slow");
  assert.ok(q, "the call reached the gateway before it was cancelled");
  assert.equal(q.closedEarly, true, "the gateway saw its request closed before answering");
  const rec = logs.find((l) => l.event === "tool" && l.outcome === "cancelled");
  assert.ok(rec, "the tool record says cancelled");
  assert.equal(rec.jsonrpc_id, 0);
});

test("gateway refusals come back as tool errors, and invalid arguments never reach the gateway", async () => {
  const ro = await call("firecrawl_scrape", { url: "https://example.com/x" }, { tok: TOK_RO });
  assert.equal(ro.last.result.isError, true);
  assert.equal(payload(ro).error.code, "INSUFFICIENT_SCOPE");
  const before = seen.length;
  const bad = await call("firecrawl_scrape", { url: "https://example.com/x", formats: ["screenshot"] });
  assert.equal(bad.last.result.isError, true);
  assert.match(bad.last.result.content[0].text, /Input validation error/);
  const extra = await call("firecrawl_scrape", { url: "https://example.com/x", origin: "fcpi:forged" });
  assert.equal(extra.last.result.isError, true);
  assert.equal(seen.length, before);
});

test("a job handle round trip: crawl, then status by id, bounded and paged", async () => {
  const c = await call("firecrawl_crawl", { url: "https://example.com/", limit: 2, idempotencyKey: "m4-test-key-1" });
  const id = payload(c).id;
  assert.equal(id, JOB);
  assert.equal(seen.filter((s) => s.url === "/v2/crawl").at(-1).headers["x-idempotency-key"], "m4-test-key-1");
  const s = await call("firecrawl_check_crawl_status", { id });
  assert.equal(payload(s).status, "completed");
  assert.equal(payload(s).returned, 2);
  assert.equal(payload(s).nextSkip, null);
});

test("a result over the payload limit is cut and marked, never silently", async () => {
  const r = await call("firecrawl_scrape", { url: "https://example.com/big" });
  assert.ok(Buffer.byteLength(r.last.result.content[0].text) <= 262144);
  assert.equal(payload(r).truncated.fields.markdown.originalBytes, 700000);
});

test("capabilities list the omitted tools with their reasons", async () => {
  const r = await call("firecrawl_capabilities", {});
  assert.deepEqual(payload(r).mcp.omitted.map((o) => o.name), ["firecrawl_search", "firecrawl_extract", "firecrawl_extract_status"]);
});

test("the log records era, method, tool, client and the gateway's answer, and nothing secret or targeted", async () => {
  await sleep(200);
  const text = logs.map((l) => JSON.stringify(l)).join("\n");
  for (const bad of [TOK, TOK_RO, "Bearer", "example.com", "fixture page"]) assert.ok(!text.includes(bad), `the log holds ${bad}`);
  const tool = logs.find((l) => l.event === "tool" && l.tool === "firecrawl_scrape" && l.outcome === "ok");
  assert.equal(tool.era, "modern");
  assert.equal(tool.protocol_version, MODERN);
  assert.equal(tool.client, "m4t");
  assert.equal(tool.downstream.route, "scrape");
  assert.match(tool.downstream.request_id, /^[0-9a-f-]{36}$/);
  assert.ok(logs.some((l) => l.event === "tool" && l.era === "legacy" && l.protocol_version === LEGACY));
  assert.ok(logs.some((l) => l.event === "exchange" && l.status === 400 && l.mcp_method === "tools/call"));
  assert.ok(logs.filter((l) => l.event === "exchange").every((l) => l.session_header_sent !== true));
});

test("an answer still over the limit after every cut is refused as RESULT_TOO_LARGE, never sent whole", async () => {
  const r = await call("firecrawl_scrape", { url: "https://example.com/hugemeta" });
  assert.equal(r.last.result.isError, true);
  assert.equal(payload(r).error.code, "RESULT_TOO_LARGE");
  assert.ok(Buffer.byteLength(r.last.result.content[0].text) < 1024);
  await sleep(100);
  assert.ok(logs.some((l) => l.event === "tool" && l.outcome === "too_large"));
});

test("every submission carries an idempotency key, and a lost answer returns it for the retry", async () => {
  const k = await call("firecrawl_crawl", { url: "https://example.com/keyless", limit: 2 });
  const sent = seen.filter((s) => s.url === "/v2/crawl").at(-1).headers["x-idempotency-key"];
  assert.match(sent, /^mcp:[0-9a-f-]{36}$/);
  assert.equal(payload(k).idempotencyKey, sent);
  const lost = await call("firecrawl_crawl", { url: "https://example.com/dropme", limit: 2 });
  assert.equal(lost.last.result.isError, true);
  assert.equal(payload(lost).error.code, "SUBMISSION_UNCERTAIN");
  const key = payload(lost).error.idempotencyKey;
  assert.match(key, /^mcp:[0-9a-f-]{36}$/);
  assert.equal(seen.filter((s) => s.url === "/v2/crawl").at(-1).headers["x-idempotency-key"], key, "the key given back is the one the gateway received");
  await call("firecrawl_crawl", { url: "https://example.com/dropme", limit: 2, idempotencyKey: key });
  assert.equal(seen.filter((s) => s.url === "/v2/crawl").at(-1).headers["x-idempotency-key"], key, "the retry carries the same key");
  await sleep(100);
  assert.ok(logs.some((l) => l.event === "tool" && l.outcome === "uncertain"));
});

test("past maxToolCalls a tool call is refused as OVERLOADED at once, and the running one completes", async () => {
  const { mkdtempSync, writeFileSync, readFileSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const m = JSON.parse(readFileSync(MANIFEST_PATH, "utf8"));
  m.mcp.limits.maxToolCalls = 1;
  const p = join(mkdtempSync(join(tmpdir(), "fcpi-mcp-")), "capabilities.json");
  writeFileSync(p, JSON.stringify(m));
  const one = spawn(process.execPath, [SERVER], { env: { PATH: process.env.PATH, PI_MCP_LISTEN_PORT: "0", PI_MCP_REST_URL: `http://127.0.0.1:${fake.address().port}`, PI_CAPABILITIES_FILE: p, PI_CLOUD_ACCESS_ENABLED: "false" }, stdio: ["ignore", "pipe", "inherit"] });
  try {
    const onePort = await new Promise((resolve, reject) => { let b = ""; one.stdout.on("data", (c) => { b += c; const m2 = b.match(/"event":"listening"[^\n]*"port":(\d+)/); if (m2) resolve(Number(m2[1])); }); one.on("exit", (c) => reject(new Error(`exited ${c}`))); });
    const saved = port;
    port = onePort;
    try {
      const slow = call("firecrawl_scrape", { url: "https://example.com/slow" });
      await sleep(300);
      const t0 = Date.now();
      const refused = await call("firecrawl_scrape", { url: "https://example.com/x" });
      assert.ok(Date.now() - t0 < 1000, "refused at once");
      assert.equal(payload(refused).error.code, "OVERLOADED");
      assert.equal(payload(refused).error.retryAfterSeconds, 5);
      assert.equal((await slow).last.result.isError, undefined, "the running call completes");
    } finally { port = saved; }
  } finally { one.kill(); }
});

test("a status page over the answer cap is read again one document at a time; a document still over it says where it is served whole", async () => {
  const n = seen.length;
  const r = await call("firecrawl_check_crawl_status", { id: JOB_BIG });
  assert.equal(r.last.result.isError, undefined);
  assert.equal(payload(r).returned, 1);
  assert.deepEqual(seen.slice(n).map((s) => new URL(s.url, "http://g").searchParams.get("limit")), [String(JSON.parse(readFileSync(MANIFEST_PATH, "utf8")).mcp.limits.statusPageDefault), "1"]);
  const h = await call("firecrawl_check_crawl_status", { id: JOB_HUGE });
  assert.equal(payload(h).error.code, "RESULT_TOO_LARGE");
  assert.match(payload(h).error.message, /REST results route/);
});

test("client header text reaches the log only as its grammar allows", async () => {
  const hostile = "firecrawl_scrape\"}<script>" + "x".repeat(500);
  const r = await http("POST", { headers: { ...identity(), "mcp-protocol-version": "not-a-date", "mcp-method": "tools/call", "mcp-name": hostile },
    body: { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "firecrawl_scrape", arguments: { url: "https://example.com/x" }, _meta: META } } });
  assert.equal(r.status, 400);
  await sleep(100);
  const ex = logs.filter((l) => l.event === "exchange").at(-1);
  assert.equal(ex.mcp_name, "invalid");
  assert.equal(ex.protocol_version, "invalid");
  assert.equal(ex.mcp_method, "tools/call");
  assert.ok(!JSON.stringify(logs).includes("<script>"));
});

test("a call that fails while its answer is shaped still leaves a tool record, and frees its slot", async () => {
  const r = await call("firecrawl_map", { url: "https://example.com/badlinks" });
  assert.ok(r.last.error || r.last.result?.isError, "the call fails");
  await sleep(100);
  const rec = logs.filter((l) => l.event === "tool" && l.tool === "firecrawl_map").at(-1);
  assert.equal(rec.outcome, "failed");
  assert.equal(rec.downstream.code, "EXCEPTION");
  const after = await call("firecrawl_capabilities", {});
  assert.equal(after.last.result.isError, undefined, "no slot is left held");
});
