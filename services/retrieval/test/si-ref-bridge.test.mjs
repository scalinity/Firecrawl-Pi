// The Ref bridge's egress rules (docs/FIRECRAWL_PI_SEARCH_INTELLIGENCE_SPEC.md §6.2; CLAUDE.md §13): the MCP client's only
// route out reaches its session's endpoint alone, with the methods Streamable HTTP uses, follows no redirect, and writes
// nothing the paid-dispatch authority refuses. Each refusal has its positive control: the same bridge reaches the fixture
// when the request is allowed.
import { test } from "node:test";
import assert from "node:assert/strict";
import { harness, refFixture, lookupFixture } from "./si-helpers.mjs";
import { makeRefBridge } from "../src/search-intelligence/adapters/ref-bridge.mjs";

const INIT = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "bridge-test", version: "1" } } });
function bridgeOf(h, { makeFetch = h.makeFetch, paid = false } = {}) {
  const real = h.dispatch.subject("documentationSearches", "fcpi-fixture-ref");
  const sub = paid ? { ...real, prov: { ...real.prov, paid: true } } : real;
  const endpoint = new URL(`${sub.prov.baseUrl.replace(/\/$/, "")}/mcp`);
  return { endpoint, bridge: makeFetch({ sub, key: "fixture-credential", searchId: "bridge-test", endpoint, signal: new AbortController().signal, deadlineAt: Date.now() + 5000 }) };
}
const post = (body = INIT) => ({ method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream" }, body });

test("the bridge serves only its session's endpoint, with the methods Streamable HTTP uses", async () => {
  const fx = refFixture();
  const h = await harness({ handlers: { ref: fx } });
  try {
    const { endpoint, bridge } = bridgeOf(h);
    await assert.rejects(bridge.fetch("http://other.fixture.fcpi.test:8080/mcp", post()), TypeError, "another host");
    await assert.rejects(bridge.fetch(`${endpoint.origin}/other`, post()), TypeError, "another path");
    await assert.rejects(bridge.fetch(`${endpoint.href}?apiKey=x`, post()), TypeError, "a query string");
    await assert.rejects(bridge.fetch(endpoint, { ...post(), method: "PUT" }), TypeError, "a method Streamable HTTP does not use");
    assert.equal(fx.log.length, 0, "nothing refused reached the network");
    const ok = await bridge.fetch(endpoint, post());
    assert.equal(ok.status, 200, "positive control: the endpoint itself is reached");
    await ok.text();
    assert.deepEqual(fx.log.map((e) => [e.method, e.url, e.key]), [["POST", "/mcp", "fixture-credential"]], "with the key added on the wire");
  } finally { await h.close(); }
});

test("a redirect reaches the client as an answer and is never followed", async () => {
  const fx = refFixture({ initialize: () => ({ status: 302, headers: { location: "/elsewhere" } }) });
  const h = await harness({ handlers: { ref: fx } });
  try {
    const { endpoint, bridge } = bridgeOf(h);
    const r = await bridge.fetch(endpoint, post());
    assert.equal(r.status, 302);
    assert.equal(r.headers.get("location"), "/elsewhere");
    await r.text();
    assert.deepEqual(fx.log.map((e) => e.url), ["/mcp"], "the Location was not requested");
    const sub = h.dispatch.subject("documentationSearches", "fcpi-fixture-ref");
    const o = await h.docs.ref.search({ schema: "fcpi.search-request/v1", requestId: "req-redirect-00", logicalSearchId: "6f1c7a52-0d1e-4c4b-9a7e-0e5f1d2c3b4a", principalId: "p", originalQuery: "redirect",
      limit: 5, language: "en", constraints: { includeDomains: [], excludeDomains: [] }, intelligence: { documentation: "required" }, resultMode: "links", absoluteDeadlineMs: Date.now() + 8000 },
      { sub, pre: h.dispatch.preflight(sub, { selection: "fixture" }), signal: new AbortController().signal, deadlineAt: Date.now() + 5000, selection: "fixture" });
    assert.deepEqual([o.status, o.reason], ["failed", "contract_failure"], "a session answered with a redirect does not open");
    assert.ok(!fx.log.some((e) => e.url === "/elsewhere"));
  } finally { await h.close(); }
});

test("a request the paid-dispatch authority refuses is never written", async () => {
  const fx = refFixture();
  const h = await harness({ handlers: { ref: fx } });
  try {
    const off = makeRefBridge({ permits: h.permits, getPolicy: h.getPolicy, resolvePublic: async () => ["127.0.0.1"], lookupFixture, getBudget: h.getBudget, paidDispatch: false, limits: () => h.policy.search.intelligence });
    const { endpoint, bridge } = bridgeOf(h, { makeFetch: off, paid: true });
    await assert.rejects(bridge.fetch(endpoint, post()), (e) => e.code === "PAID_DISPATCH_DISABLED" && e.sent === false);
    assert.equal(fx.log.length, 0);
    assert.equal(h.permits.snapshot().api.held["provider:fixture-ref"], undefined, "its permit came back");
    // Positive control: the same paid subject with the authority on is sent.
    const on = makeRefBridge({ permits: h.permits, getPolicy: h.getPolicy, resolvePublic: async () => ["127.0.0.1"], lookupFixture, getBudget: h.getBudget, paidDispatch: true, limits: () => h.policy.search.intelligence });
    const allowed = bridgeOf(h, { makeFetch: on, paid: true });
    const r = await allowed.bridge.fetch(allowed.endpoint, post());
    await r.text();
    assert.equal(fx.log.length, 1);
  } finally { await h.close(); }
});
