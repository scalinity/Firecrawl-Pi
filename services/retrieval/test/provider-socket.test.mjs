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
