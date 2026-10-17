import { test } from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import { providerRequest } from "../src/provider.mjs";
import { serve, policyFor } from "./m5-helpers.mjs";

test("a provider request turns on TCP keep-alive probes, because a reasoning model sends nothing for minutes", async (t) => {
  const setKeepAlive = t.mock.method(net.Socket.prototype, "setKeepAlive");
  const s = await serve((_q, r) => r.end("ok"));
  try {
    const out = await providerRequest({ baseUrl: `http://model.fixture.fcpi.test:${s.port}`, path: "/", body: Buffer.from("x"), timeoutMs: 5000,
      getPolicy: () => policyFor({ "model.fixture.fcpi.test": s.port }), lookupFixture: async () => ["127.0.0.1"], resolvePublic: async () => [] });
    assert.equal(out.status, 200);
    assert.ok(setKeepAlive.mock.calls.some((c) => c.arguments[0] === true && c.arguments[1] === 30000), "the request's socket got setKeepAlive(true, 30000)");
  } finally { await s.close(); }
});

test("a streamed answer is ended when nothing arrives for idleMs after the send, and each chunk restarts that clock", async () => {
  const at = (port, extra) => providerRequest({ baseUrl: `http://model.fixture.fcpi.test:${port}`, path: "/", body: Buffer.from("x"), timeoutMs: 10000, idleMs: 300,
    getPolicy: () => policyFor({ "model.fixture.fcpi.test": port }), lookupFixture: async () => ["127.0.0.1"], resolvePublic: async () => [], ...extra });
  // Chunks 100 ms apart for 1.2 s: never 300 ms of silence, though the whole takes four times that, so the answer completes.
  const steady = await serve(async (q, r) => { for await (const _ of q) { /* drain */ } r.writeHead(200); for (let i = 0; i < 12; i++) { r.write("."); await new Promise((res) => setTimeout(res, 100)); } r.end("done"); });
  try { const out = await at(steady.port); assert.equal(out.body.toString(), "............done"); } finally { await steady.close(); }
  // One chunk, then silence: ended as sent with no answer.
  const stalled = await serve(async (q, r) => { for await (const _ of q) { /* drain */ } r.writeHead(200); r.write("."); await new Promise((res) => setTimeout(res, 2000)); r.end(); });
  try {
    await assert.rejects(at(stalled.port), (e) => e.code === "PROVIDER_UNCERTAIN" && e.sent === true && /nothing arrived for 300 ms/.test(e.message));
  } finally { await stalled.close(); }
});

test("a connection that never completes ends unsent within idleMs, so its reservation is released", async () => {
  // 192.0.2.1 (TEST-NET-1) never answers: the connection either hangs until idleMs or fails at once, and neither is a send.
  const policy = { ...policyFor({}), fixtures: [{ host: "model.fixture.fcpi.test", port: 8080, cidr: "192.0.2.0/24", limits: "fixture" }] };
  const t0 = Date.now();
  await assert.rejects(providerRequest({ baseUrl: "http://model.fixture.fcpi.test:8080", path: "/", body: Buffer.from("x"), timeoutMs: 10000, idleMs: 400,
    getPolicy: () => policy, lookupFixture: async () => ["192.0.2.1"], resolvePublic: async () => [] }),
    (e) => e.code === "PROVIDER_UNREACHABLE" && e.sent === false);
  assert.ok(Date.now() - t0 < 2000, `ended after ${Date.now() - t0} ms, not at the 10 s ceiling`);
});
