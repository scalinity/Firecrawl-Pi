// Ref over MCP (docs/FIRECRAWL_PI_SEARCH_INTELLIGENCE_SPEC.md §6.2, §14.1, §15, §18.2) against a fixture speaking Streamable
// HTTP MCP: the bridge's bounded streaming, its receive-stream slots apart from the request permits, one session per logical
// search with at most two reads, a withdrawn call that is never sent late, and one verdict and one closing per call.
import { test } from "node:test";
import assert from "node:assert/strict";
import { setTimeout as sleep } from "node:timers/promises";
import { harness, request, refFixture, refBlocks } from "./si-helpers.mjs";
import { mcpFailure } from "../src/search-intelligence/adapters/common.mjs";
import { ProviderError } from "../src/provider.mjs";

const docsRequest = (q) => request({ originalQuery: q, intelligence: { documentation: "required" } });
const refCtx = (h, over = {}) => {
  const sub = h.dispatch.subject("documentationSearches", "fcpi-fixture-ref");
  const pre = h.dispatch.preflight(sub, { selection: "fixture" });
  assert.equal(pre.eligible, true, "the fixture Ref is eligible on the fixture selection");
  return { sub, pre, signal: new AbortController().signal, deadlineAt: Date.now() + 8000, selection: "fixture", ...over };
};
const rows = (h, kind = null) => [...h.store.rows.values()].filter((r) => r.provider === "fixture-ref" && (!kind || r.kind === kind));
const calls = (fx, tool) => fx.log.filter((e) => e.tool === tool);

test("a Ref result on an SSE stream the server keeps open is used at once, and the request permit is returned", async () => {
  const fx = refFixture({ holdOpen: true });
  const h = await harness({ handlers: { ref: fx } });
  try {
    const t0 = Date.now();
    const o = await h.docs.ref.search(docsRequest("ref held stream"), refCtx(h));
    assert.equal(o.status, "success_results");
    assert.ok(Date.now() - t0 < 3000, "the result was used before the server ended its stream");
    const call = calls(fx, "ref_search_documentation")[0];
    assert.ok(call, "the search reached Ref");
    assert.equal(call.key, "fixture-credential", "the bridge adds the key to the wire");
    assert.equal(call.headers["x-fcpi-operation"], undefined, "the operation tag never leaves the host");
    assert.equal(h.permits.snapshot().api.held["provider:fixture-ref"], undefined, "no request permit is left held by the stream the server keeps open");
    assert.deepEqual(rows(h).map((r) => [r.state, r.actual]), [["SETTLED", 1]]);
    await o.lease.close();
    assert.ok(fx.log.some((e) => e.method === "DELETE" && e.closed), "the session's goodbye ends the remote session");
  } finally { await h.close(); }
});

test("four sessions holding receive streams leave every tool call its permit; a fifth works without a stream", async () => {
  const fx = refFixture();
  const h = await harness({ handlers: { ref: fx } });
  try {
    const out = await Promise.all([0, 1, 2, 3, 4].map((i) => h.docs.ref.search(docsRequest(`ref session ${i}`), refCtx(h))));
    assert.deepEqual(out.map((o) => o.status), Array(5).fill("success_results"), "no tool call waited behind an open stream");
    await sleep(50);
    assert.equal(fx.log.filter((e) => e.method === "GET").length, 4, "four receive streams opened; the fifth session was answered 405 without a request");
    assert.equal(h.permits.snapshot().refStreams.held["ref-stream"], 4);
    assert.equal(h.permits.snapshot().api.held["provider:fixture-ref"], undefined, "the open streams hold no request permit");
    await Promise.all(out.map((o) => o.lease.close()));
    await sleep(50);
    assert.deepEqual(h.permits.snapshot().refStreams.held, {}, "closing the sessions returns their stream slots");
    assert.equal(fx.open.size, 0, "and ends the streams");
  } finally { await h.close(); }
});

test("each logical search gets its own Ref session; its reads use it, at most two, and nothing after it closes", async () => {
  const fx = refFixture();
  const h = await harness({ handlers: { ref: fx } });
  try {
    const a = await h.docs.ref.search(docsRequest("ref isolation a"), refCtx(h));
    const b = await h.docs.ref.search(docsRequest("ref isolation b"), refCtx(h));
    const [sa, sb] = calls(fx, "ref_search_documentation").map((e) => e.session);
    assert.ok(sa && sb && sa !== sb, "two searches, two sessions");
    const opts = () => ({ signal: new AbortController().signal, deadlineAt: Date.now() + 4000 });
    const [r1, r2] = await Promise.all([a.lease.read("https://ref.example.org/docs/1", opts()), a.lease.read("https://ref.example.org/docs/2", opts())]);
    assert.equal(r1.ok && r2.ok, true);
    assert.equal(r1.passage.kind, "ref_context_excerpt");
    assert.equal(r1.passage.completeness, "excerpt", "a read is a query-conditioned excerpt, never a full document");
    assert.deepEqual(calls(fx, "ref_read_url").map((e) => e.session), [sa, sa], "the reads ran in the search's own session");
    assert.deepEqual(calls(fx, "ref_read_url").map((e) => e.args.url).sort(), ["https://ref.example.org/docs/1", "https://ref.example.org/docs/2"], "the exact provider URL is read");
    assert.deepEqual(await a.lease.read("https://ref.example.org/docs/3", opts()), { ok: false, reason: "platform_restricted", detail: "read_slots_used" });
    await b.lease.close();
    assert.equal((await b.lease.read("https://ref.example.org/docs/1", opts())).detail, "session_closed");
    assert.equal(calls(fx, "ref_read_url").length, 2, "neither refused read was sent");
    const keys = rows(h).map((r) => r.call_key);
    assert.equal(new Set(keys).size, 4, "two searches and two reads: four operations, each under its own key");
    assert.equal(keys.filter((k) => /:ref:read:/.test(k)).length, 2);
    assert.ok(rows(h).every((r) => r.state === "SETTLED" && r.actual === 1));
    await a.lease.close();
  } finally { await h.close(); }
});

test("a read cancelled while it waits for a permit is never sent, even once capacity frees, and is released", async () => {
  const fx = refFixture();
  const h = await harness({ handlers: { ref: fx } });
  try {
    const o = await h.docs.ref.search(docsRequest("ref queued read"), refCtx(h));
    const held = await Promise.all([1, 2, 3, 4].map(() => h.permits.api("fixture-ref", "another-search")));
    const ac = new AbortController();
    const pending = o.lease.read("https://ref.example.org/docs/1", { signal: ac.signal, deadlineAt: Date.now() + 5000 });
    await sleep(100);
    ac.abort();
    const r = await pending;
    assert.deepEqual([r.ok, r.reason, r.dispatchState], [false, "cancelled", "not_sent"]);
    for (const release of held) release();
    await sleep(200);
    assert.equal(calls(fx, "ref_read_url").length, 0, "the withdrawn request never went out");
    assert.deepEqual(rows(h, "docs_read").map((x) => x.state), ["RELEASED"]);
    assert.equal(h.dispatch.breakerState("fixture-ref"), "closed");
    // Positive control: the session's other read slot still reads once capacity is free.
    const r2 = await o.lease.read("https://ref.example.org/docs/2", { signal: new AbortController().signal, deadlineAt: Date.now() + 4000 });
    assert.equal(r2.ok, true);
    assert.equal(calls(fx, "ref_read_url").length, 1);
    await o.lease.close();
  } finally { await h.close(); }
});

test("a read whose deadline passes while it waits for capacity is never sent late", async () => {
  const fx = refFixture();
  const h = await harness({ handlers: { ref: fx } });
  try {
    const o = await h.docs.ref.search(docsRequest("ref late read"), refCtx(h));
    const held = await Promise.all([1, 2, 3, 4].map(() => h.permits.api("fixture-ref", "another-search")));
    const r = await o.lease.read("https://ref.example.org/docs/1", { signal: new AbortController().signal, deadlineAt: Date.now() + 300 });
    assert.equal(r.ok, false);
    assert.equal(r.dispatchState, "not_sent");
    for (const release of held) release();
    await sleep(300);
    assert.equal(calls(fx, "ref_read_url").length, 0, "zero late sends");
    assert.deepEqual(rows(h, "docs_read").map((x) => x.state), ["RELEASED"]);
    await o.lease.close();
  } finally { await h.close(); }
});

test("a search about authentication errors is a billed success and leaves Ref available", async () => {
  const fx = refFixture({ tool: () => ({ content: [{ type: "text", text: "overview: Handle 401 Unauthorized responses with an interceptor\nurl: https://axios-http.com/docs/interceptors\nmoduleId: axios" }] }) });
  const h = await harness({ handlers: { ref: fx } });
  try {
    const o = await h.docs.ref.search(docsRequest("axios interceptor refresh token on 401 unauthorized"), refCtx(h));
    assert.equal(o.status, "success_results");
    assert.deepEqual(rows(h).map((r) => [r.state, r.actual]), [["SETTLED", 1]]);
    const again = h.dispatch.preflight(h.dispatch.subject("documentationSearches", "fcpi-fixture-ref"), { selection: "fixture" });
    assert.equal(again.eligible, true, "the account is not held by a document's words");
    await o.lease.close();
  } finally { await h.close(); }
});

test("a session closed after its search's deadline, or after its cancellation, still says goodbye", async () => {
  const fx = refFixture();
  const h = await harness({ handlers: { ref: fx } });
  try {
    const late = await h.docs.ref.search(docsRequest("ref late goodbye"), refCtx(h, { deadlineAt: Date.now() + 1200 }));
    const ac = new AbortController();
    const cancelled = await h.docs.ref.search(docsRequest("ref cancelled goodbye"), refCtx(h, { signal: ac.signal }));
    await sleep(1300);
    ac.abort();
    await late.lease.close();
    await cancelled.lease.close();
    const sessions = fx.log.filter((e) => e.tool === "ref_search_documentation").map((e) => e.session);
    assert.deepEqual(sessions.map((s) => fx.log.some((e) => e.method === "DELETE" && e.session === s && e.closed)), [true, true], "both remote sessions are ended");
    assert.equal(fx.sessions.size, 0);
  } finally { await h.close(); }
});

test("an answer that breaks after its headers fails at once: too large is a contract failure, a cut stream counts against the service", async () => {
  let mode = "big";
  const fx = refFixture({ tool: () => (mode === "big" ? { content: [{ type: "text", text: "x".repeat(1200 * 1024) }] } : mode) });
  const h = await harness({ handlers: { ref: fx } });
  try {
    const run = async () => { const t0 = Date.now(); const o = await h.docs.ref.search(docsRequest(`ref broken ${mode}`), refCtx(h, { deadlineAt: Date.now() + 6000 })); return { o, ms: Date.now() - t0 }; };
    const big = await run();
    assert.deepEqual([big.o.status, big.o.reason, big.o.dispatchState], ["failed", "contract_failure", "response_received"]);
    assert.ok(big.ms < 3000, `an oversized answer is judged when it overflows, not at the deadline (${big.ms} ms)`);
    assert.equal(h.dispatch.breakerState("fixture-ref"), "closed");
    for (mode of ["sse_cut", "json_cut"]) {
      const cut = await run();
      assert.deepEqual([cut.o.status, cut.o.reason, cut.o.dispatchState], ["failed", "temporarily_unavailable", "possibly_sent"], mode);
      assert.ok(cut.ms < 3000, `${mode}: no wait for the deadline (${cut.ms} ms)`);
    }
    assert.equal(h.dispatch.breakerState("fixture-ref"), "closed", "two cut answers are two failures, below the threshold");
    assert.deepEqual(rows(h).map((r) => r.state), ["UNCERTAIN", "UNCERTAIN", "UNCERTAIN"], "answered or possibly sent: never released");
    assert.equal(h.permits.snapshot().api.held["provider:fixture-ref"], undefined, "every request permit came back");
  } finally { await h.close(); }
});

test("an MCP failure's verdict: the provider's answer, our transport's error, or a request never written", () => {
  const v = (e, sent) => { const r = mcpFailure(e, { sent }); return [r.reason, r.dispatchState, r.breaker]; };
  assert.deepEqual(v({ code: -32602, message: "invalid params" }, true), ["contract_failure", "response_received", "neutral"]);
  assert.deepEqual(v({ code: -32602, message: "invalid outputSchema" }, false), ["contract_failure", "not_sent", "neutral"], "raised by the client before writing: released");
  assert.deepEqual(v({ status: 401, code: "CLIENT_HTTP_NOT_IMPLEMENTED" }, true), ["auth_failed", "response_received", "neutral"]);
  assert.deepEqual(v({ status: 503, code: "CLIENT_HTTP_NOT_IMPLEMENTED" }, true), ["temporarily_unavailable", "response_received", "failure"]);
  assert.deepEqual(v(new ProviderError("PROVIDER_UNCERTAIN", "cut off", { sent: true, status: 200 }), true), ["temporarily_unavailable", "possibly_sent", "failure"], "a 200 cut midway is no answer");
  assert.deepEqual(v(new ProviderError("PROVIDER_RESPONSE_TOO_LARGE", "big", { sent: true, status: 200 }), true), ["contract_failure", "response_received", "neutral"]);
  assert.deepEqual(v(new ProviderError("PROVIDER_UNREACHABLE", "dns", { sent: false }), false), ["temporarily_unavailable", "not_sent", "failure"]);
  assert.deepEqual(v(Object.assign(new ProviderError("PROVIDER_TIMEOUT", "capacity", { sent: false, timedOut: true }), { capacity: true }), false), ["capacity_unavailable", "not_sent", "neutral"]);
  assert.deepEqual(v({ code: "REQUEST_TIMEOUT" }, true), ["timeout", "possibly_sent", "failure"]);
});

test("Ref's answered refusals are kept uncertain and inform availability without tripping the breaker", async () => {
  let mode = "auth_text";
  const fx = refFixture({ tool: (name) => mode === "auth_text" ? { content: [{ type: "text", text: "Please verify your email at https://ref.tools/dashboard to search documentation" }] }
    : mode === "http_401" ? { status: 401 } : { content: [{ type: "text", text: "Something unexpected" }] } });
  const h = await harness({ handlers: { ref: fx } });
  try {
    const first = await h.docs.ref.search(docsRequest("ref auth text"), refCtx(h));
    assert.deepEqual([first.status, first.reason, first.candidates.length], ["failed", "auth_failed", 0], "the dashboard URL in the error is not a hit");
    assert.deepEqual(rows(h).map((r) => r.state), ["UNCERTAIN"]);
    const again = h.dispatch.preflight(h.dispatch.subject("documentationSearches", "fcpi-fixture-ref"), { selection: "fixture" });
    assert.deepEqual([again.eligible, again.reason], [false, "auth_failed"], "the account is held until its credential changes");
    assert.equal(h.dispatch.breakerState("fixture-ref"), "closed");
  } finally { await h.close(); }
  for (const m of ["http_401", "unknown_text"]) {
    mode = m;
    const h2 = await harness({ handlers: { ref: fx } });
    try {
      const o = await h2.docs.ref.search(docsRequest(`ref ${m}`), refCtx(h2));
      assert.equal(o.status, "failed");
      assert.equal(o.reason, m === "http_401" ? "auth_failed" : "contract_failure");
      assert.deepEqual(rows(h2).map((r) => r.state), ["UNCERTAIN"], `${m}: whether Ref charged is not documented`);
      assert.equal(h2.dispatch.breakerState("fixture-ref"), "closed");
      if (m === "http_401") {
        assert.ok(h2.logs.some((l) => l.event === "si_ref_client_error" && l.status === 401), "the client's error is logged by its code and status");
        assert.ok(!JSON.stringify(h2.logs).includes("refused"), "never with the provider's response body");
      }
    } finally { await h2.close(); }
  }
});

test("a Ref call cut off after it was written is uncertain and is one failure: two leave the breaker closed, a third opens it", async () => {
  const fx = refFixture({ tool: () => "destroy" });
  const h = await harness({ handlers: { ref: fx } });
  try {
    for (let i = 0; i < 2; i++) {
      const o = await h.docs.ref.search(docsRequest(`ref cut ${i}`), refCtx(h));
      assert.deepEqual([o.status, o.dispatchState], ["failed", "possibly_sent"]);
    }
    assert.equal(h.dispatch.breakerState("fixture-ref"), "closed", "each cut-off call counted once");
    await h.docs.ref.search(docsRequest("ref cut 2"), refCtx(h));
    assert.equal(h.dispatch.breakerState("fixture-ref"), "open", "the third failure in the window opens it");
    assert.deepEqual(rows(h).map((r) => r.state), ["UNCERTAIN", "UNCERTAIN", "UNCERTAIN"], "possibly sent: never released");
  } finally { await h.close(); }
});

test("a Ref session that cannot open is not metered; a 503 counts once against the service, a 401 only against the account", async () => {
  let status = 503;
  const fx = refFixture({ initialize: () => ({ status }) });
  const h = await harness({ handlers: { ref: fx } });
  try {
    for (let i = 0; i < 2; i++) {
      const o = await h.docs.ref.search(docsRequest(`ref open ${i}`), refCtx(h));
      assert.deepEqual([o.status, o.reason, o.dispatchState], ["failed", "temporarily_unavailable", "not_sent"]);
    }
    assert.equal(h.dispatch.breakerState("fixture-ref"), "closed", "two failed opens, two failures, below the threshold");
    status = 401;
    const o = await h.docs.ref.search(docsRequest("ref open auth"), refCtx(h));
    assert.equal(o.reason, "auth_failed");
    assert.equal(h.dispatch.breakerState("fixture-ref"), "closed", "an authentication refusal is not a service failure");
    assert.equal(rows(h).length, 0, "no billable operation was reserved");
    assert.equal(calls(fx, "ref_search_documentation").length, 0);
  } finally { await h.close(); }
});

test("a session open is judged by the request that failed: an unsupported handshake is a contract failure, an unsent listing no failure", async () => {
  let version = "1999-01-01", held = [], h;
  const fx = refFixture({ initialize: () => (version ? { protocolVersion: version } : null),
    // Once the session is initialized, every request permit is taken, so the tool listing that follows is never written.
    notified: () => { for (let i = 0; i < 4; i++) h.permits.api("fixture-ref", "another-search").then((r) => held.push(r)); } });
  h = await harness({ handlers: { ref: fx } });
  try {
    const bad = await h.docs.ref.search(docsRequest("ref old handshake"), refCtx(h));
    assert.deepEqual([bad.status, bad.reason], ["failed", "contract_failure"]);
    version = null;
    for (let i = 0; i < 3; i++) {
      const o = await h.docs.ref.search(docsRequest(`ref unsent listing ${i}`), refCtx(h, { deadlineAt: Date.now() + 700 }));
      assert.equal(o.status, "failed");
      assert.equal(o.dispatchState, "not_sent");
      for (const r of held.splice(0)) r();
      await sleep(20);
      for (const r of held.splice(0)) r();
    }
    assert.equal(fx.log.filter((e) => e.message?.method === "tools/list").length, 0, "the listings were never written");
    assert.equal(h.dispatch.breakerState("fixture-ref"), "closed", "three opens whose failing request never left are no service failure");
    assert.equal(rows(h).length, 0);
  } finally { for (const r of held) r(); await h.close(); }
});

test("Ref blocks with a usable URL are hits; a session without both tools is a contract failure, never an empty search", async () => {
  const fx = refFixture({ tools: ["ref_search_documentation"], tool: () => refBlocks(["https://ref.example.org/docs/1"]) });
  const h = await harness({ handlers: { ref: fx } });
  try {
    const o = await h.docs.ref.search(docsRequest("ref tools"), refCtx(h));
    assert.deepEqual([o.status, o.reason, o.detail], ["failed", "contract_failure", "ref_tools_missing"]);
    assert.equal(calls(fx, "ref_search_documentation").length, 0);
    assert.ok(fx.log.some((e) => e.method === "DELETE"), "the session is closed");
    // A fresh context session for a cached discovery is held to the same check, before anything is metered.
    assert.equal(await h.docs.ref.contextLease(docsRequest("ref tools context"), refCtx(h)), null);
    assert.equal(calls(fx, "ref_search_documentation").length, 0);
    assert.equal(rows(h).length, 0, "no reservation for a call the session could not take");
    assert.equal(fx.log.filter((e) => e.method === "DELETE").length, 2);
  } finally { await h.close(); }
});
