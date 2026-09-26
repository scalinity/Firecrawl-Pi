// Unit tests for the MCP service's gateway client (services/mcp/src/rest.mjs): every way a call ends, against
// a local server: an answer, an answer over the size cap (declared or streamed), no answer in time, no
// server at all, and a cancelled MCP request.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { makeRest } from "../src/rest.mjs";

const CAP = 64 * 1024;
const srv = createServer((req, res) => {
  if (req.url === "/ok") { res.writeHead(200, { "content-type": "application/json", "x-request-id": "r1" }); return res.end('{"success":true,"n":1}'); }
  if (req.url === "/declared") { res.writeHead(200, { "content-type": "application/json", "content-length": CAP + 1 }); return res.end("x".repeat(CAP + 1)); }
  if (req.url === "/streamed") { res.writeHead(200, { "content-type": "application/json" }); res.write("x".repeat(CAP)); return res.end("x".repeat(1024)); }
  if (req.url === "/hang") return;   // never answers
  res.writeHead(404); res.end();
});
await new Promise((r) => srv.listen(0, "127.0.0.1", r));
after(() => srv.close());
const cfg = (port = srv.address().port, restTimeoutMs = 400) => ({ rest: new URL(`http://127.0.0.1:${port}`), manifest: { mcp: { limits: { maxToolCalls: 2, restTimeoutMs, restResponseMaxBytes: CAP } } } });
const rest = makeRest(cfg());
after(() => rest.close());
const call = (path, extra = {}, r = rest) => r.call({ method: "GET", path, token: "t".repeat(20), host: "127.0.0.1:3380", ...extra });

test("an answer resolves with its status, parsed JSON and headers", async () => {
  const r = await call("/ok");
  assert.equal(r.status, 200);
  assert.deepEqual(r.json, { success: true, n: 1 });
  assert.equal(r.headers["x-request-id"], "r1");
});

test("an answer over the size cap is TOO_LARGE, whether declared or streamed", async () => {
  await assert.rejects(call("/declared"), (e) => e.code === "TOO_LARGE" && /exceeds/.test(e.message));
  await assert.rejects(call("/streamed"), (e) => e.code === "TOO_LARGE");
});

test("no answer in time is TIMEOUT; no server is UNAVAILABLE", async () => {
  await assert.rejects(call("/hang"), (e) => e.code === "TIMEOUT");
  const dead = makeRest(cfg(9));
  await assert.rejects(call("/ok", {}, dead), (e) => e.code === "UNAVAILABLE");
  dead.close();
});

test("a cancelled MCP request is ABORTED, before the call and during it", async () => {
  const done = new AbortController(); done.abort();
  await assert.rejects(call("/ok", { signal: done.signal }), (e) => e.code === "ABORTED");
  const ac = new AbortController();
  const p = call("/hang", { signal: ac.signal });
  setTimeout(() => ac.abort(), 50);
  await assert.rejects(p, (e) => e.code === "ABORTED");
});
