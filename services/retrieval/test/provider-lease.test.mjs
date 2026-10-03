import { test } from "node:test";
import assert from "node:assert/strict";
import { providerRequest } from "../src/provider.mjs";
import { serve, policyFor } from "./m5-helpers.mjs";

test("expiry during DNS or the connection handshake sends no HTTP request (PRE-M9 C1)", async () => {
  let hits = 0;
  const s = await serve((_q, r) => { hits++; r.end("ok"); });
  try {
    for (const afterDns of [false, true]) {
      let active = true, checks = 0;
      await assert.rejects(providerRequest({ baseUrl: `http://model.fixture.fcpi.test:${s.port}`, path: "/",
        body: Buffer.from("billable"), timeoutMs: 1000, getPolicy: () => policyFor({ "model.fixture.fcpi.test": s.port }),
        lookupFixture: async () => { if (!afterDns) active = false; return ["127.0.0.1"]; },
        resolvePublic: async () => [], authorize: () => { checks++; return active && (!afterDns || checks === 1); } }),
      (e) => e.code === "PAID_DISPATCH_DISABLED" && e.sent === false);
    }
    assert.equal(hits, 0);
  } finally { await s.close(); }
});
