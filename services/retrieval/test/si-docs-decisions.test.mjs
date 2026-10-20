// SI2 dispatch (docs/FIRECRAWL_PI_SEARCH_INTELLIGENCE_SPEC.md §8.2, §15, §18.2): the documentation and decision adapters go
// through the same metered dispatch as the general engines, so one failed call is one breaker verdict, against fixture
// servers that speak Context7's and OpenRouter's documented wire formats.
import { test } from "node:test";
import assert from "node:assert/strict";
import { harness, request } from "./si-helpers.mjs";
import { makeContext7 } from "../src/search-intelligence/adapters/context7.mjs";
import { makeDecisions, OUTPUT_TOKENS_PER_QUESTION } from "../src/search-intelligence/decisions.mjs";
import { JEV_MODEL } from "../src/budget.mjs";
import { microUsd } from "../src/search-intelligence/adapters/common.mjs";
import { parseBraveRateHeaders } from "../src/search-intelligence/availability.mjs";

const limitsOf = (h) => () => h.policy.search.intelligence;
const docsRequest = (q) => request({ originalQuery: q, intelligence: { documentation: "required", libraries: [{ name: "vue" }] } });
const jevBody = (q) => ({ model: JEV_MODEL, state: { query: q }, questions: { relevant: { type: "noul", instructions: "Is state.query about software?", criteria: { true: "yes", false: "no" } } } });

test("a Jev call that gets no answer is one breaker verdict: two cut connections leave the breaker closed", async () => {
  const h = await harness({ handlers: { openrouter: () => "destroy" } });
  try {
    const decisions = makeDecisions({ dispatch: h.dispatch, store: h.store, limits: limitsOf(h), permits: h.permits });
    const { sub, pre } = decisions.preflight("fixture", "fcpi-fixture-jev");
    assert.equal(pre.eligible, true);
    for (let i = 0; i < 2; i++) {
      const req = docsRequest(`jev cut ${i}`);
      const r = await decisions.decide({ body: jevBody(req.originalQuery), kind: "decision", purpose: "rerank", request: req, sub, pre, signal: new AbortController().signal, deadlineAt: Date.now() + 5000, selection: "fixture" });
      assert.equal(r.ok, false);
    }
    assert.equal(h.servers.openrouter.seen.length, 2);
    assert.equal(h.dispatch.breakerState("fixture-openrouter"), "closed");
  } finally { await h.close(); }
});

test("a Context7 scope that gets no answer is one breaker verdict: two cut connections leave the breaker closed", async () => {
  const h = await harness({ handlers: { context7: () => "destroy" } });
  try {
    const context7 = makeContext7({ dispatch: h.dispatch, limits: limitsOf(h) });
    const sub = h.dispatch.subject("documentationSearches", "fcpi-fixture-context7");
    const pre = h.dispatch.preflight(sub, { selection: "fixture" });
    assert.equal(pre.eligible, true);
    for (let i = 0; i < 2; i++) {
      const o = await context7.search(docsRequest(`context7 cut ${i}`), { sub, pre, signal: new AbortController().signal, deadlineAt: Date.now() + 5000, selection: "fixture" });
      assert.equal(o.status, "failed");
      assert.deepEqual([o.dispatchState, o.usage], ["possibly_sent", { requests: 0, uncertain: 1 }], "a cut connection was possibly sent and is held, not counted as spent");
    }
    assert.equal(h.servers.context7.seen.length, 2);
    assert.equal(h.dispatch.breakerState("fixture-context7"), "closed");
  } finally { await h.close(); }
});

test("answered Jev and Context7 refusals keep their reservations, since neither documents a failed call as unbilled", async () => {
  const row = (h, p) => [...h.store.rows.values()].filter((x) => x.provider === p);
  const h = await harness({ handlers: {
    openrouter: () => ({ status: 402, body: { error: { code: 402, message: "Insufficient credits", metadata: { limit_source: "openrouter_credits" } } } }),
    context7: (q, e) => /nodocs/.test(new URL(e.url, "http://x").searchParams.get("query") ?? "") ? { status: 404, body: { error: "no_documentation_found", message: "No documentation matched" } } : { status: 400, body: { error: "validation_error", message: "bad" } },
  } });
  try {
    const decisions = makeDecisions({ dispatch: h.dispatch, store: h.store, limits: limitsOf(h), permits: h.permits });
    const { sub, pre } = decisions.preflight("fixture", "fcpi-fixture-jev");
    const req = docsRequest("jev refused");
    const r = await decisions.decide({ body: jevBody(req.originalQuery), kind: "decision", purpose: "rerank", request: req, sub, pre, signal: new AbortController().signal, deadlineAt: Date.now() + 5000, selection: "fixture" });
    assert.deepEqual([r.ok, r.reason], [false, "quota_exhausted"]);
    assert.deepEqual(row(h, "fixture-openrouter").map((x) => x.state), ["UNCERTAIN"]);
    const context7 = makeContext7({ dispatch: h.dispatch, limits: limitsOf(h) });
    const csub = h.dispatch.subject("documentationSearches", "fcpi-fixture-context7");
    const cpre = h.dispatch.preflight(csub, { selection: "fixture" });
    await context7.search(docsRequest("context7 refused"), { sub: csub, pre: cpre, signal: new AbortController().signal, deadlineAt: Date.now() + 5000, selection: "fixture" });
    await context7.search(docsRequest("context7 nodocs"), { sub: csub, pre: cpre, signal: new AbortController().signal, deadlineAt: Date.now() + 5000, selection: "fixture" });
    const c7 = row(h, "fixture-context7").map((x) => [x.state, x.actual]);
    assert.deepEqual(c7, [["UNCERTAIN", null], ["SETTLED", 1]], "the refusal is uncertain; the documented no-match counts one request");
  } finally { await h.close(); }
});

// A Context7 v3 answer for vue whose version record says what was served (spec §6.1: requested and observed are separate).
const vueAnswer = (version) => ({ status: 200, body: { ...(version ? { version: { libraries: [{ libraryId: "/vuejs/docs", ...version }] } } : {}),
  codeSnippets: [{ libraryId: "/vuejs/docs", codeTitle: "ref()", codeDescription: "Declare reactive state", codeLanguage: "javascript", codeList: [{ language: "javascript", code: "const n = ref(0)" }],
    codeId: "https://vuejs.org/guide/essentials/reactivity-fundamentals.html", pageTitle: "Reactivity Fundamentals" }], infoSnippets: [] } });
const versionRequest = (q) => request({ originalQuery: q, intelligence: { documentation: "required", libraries: [{ name: "vue", version: "3.5" }] } });
const queryOf = (e) => new URL(e.url, "http://x").searchParams.get("query") ?? "";

test("Context7's version scope: another served version is left out and said so; a verified one is observed; none stays unknown", async () => {
  const h = await harness({ handlers: { context7: (q, e) => /mismatch/.test(queryOf(e)) ? vueAnswer({ served: "3.4.0", status: "fallback" })
    : /verified/.test(queryOf(e)) ? vueAnswer({ served: "3.5.2", status: "verified" }) : vueAnswer(null) } });
  try {
    const context7 = makeContext7({ dispatch: h.dispatch, limits: limitsOf(h) });
    const sub = h.dispatch.subject("documentationSearches", "fcpi-fixture-context7");
    const run = async (q) => context7.search(versionRequest(q), { sub, pre: h.dispatch.preflight(sub, { selection: "fixture" }), signal: new AbortController().signal, deadlineAt: Date.now() + 5000, selection: "fixture" });
    const mismatch = await run("vue reactivity mismatch");
    assert.equal(mismatch.status, "success_empty", "nothing of another version is presented as 3.5");
    assert.match(mismatch.detail, /mismatched version left out/);
    assert.equal(mismatch.suboperations[0].versionVerdict, "no_match", "only another version came back, so the scope says there is no match");
    assert.equal(new URL(h.servers.context7.seen[0].url, "http://x").searchParams.get("version"), "3.5", "one library with a version is a strict scope");
    const verified = await run("vue reactivity verified");
    const scope = verified.candidates[0].documentation.scopes[0];
    assert.deepEqual([scope.requestedVersion, scope.observedVersion, scope.status, scope.basis], ["3.5", "3.5.2", "scope_only", "provider_scope"]);
    assert.equal(verified.suboperations[0].versionVerdict, "confirmed");
    const unknown = await run("vue reactivity unknown");
    const u = unknown.candidates[0].documentation.scopes[0];
    assert.deepEqual([u.requestedVersion, u.observedVersion, u.status], ["3.5", null, "unknown"], "a requested version is never reported as observed");
    assert.equal(unknown.candidates[0].passages[0].observedVersion, null);
    assert.equal(unknown.suboperations[0].versionVerdict, "unconfirmed", "nothing said which version it is, so it is not claimed");
  } finally { await h.close(); }
});

// A library id that names a version says which version its documents are for when the answer carries no scope record of its own: Context7
// answered a request for Python 4.0, which does not exist, with pages from /websites/python_3_10 and said nothing else.
const idAnswer = (libraryId) => ({ status: 200, body: { codeSnippets: [{ libraryId, codeTitle: "What's new", codeDescription: "Release notes", codeLanguage: "python", codeList: [{ language: "python", code: "print(1)" }],
  codeId: "https://docs.python.org/3.10/whatsnew/3.10.html", pageTitle: "What's New In Python 3.10" }], infoSnippets: [] } });
const pyRequest = (q, version) => request({ originalQuery: q, intelligence: { documentation: "required", libraries: [{ name: "python", ...(version ? { version } : {}) }] } });

test("Context7's library id names a version: another one is left out and the scope says no match, the requested one confirms it, a plain id and a documented no-match say so", async () => {
  const h = await harness({ handlers: { context7: (q, e) => { const t = queryOf(e);
    return /plain/.test(t) ? idAnswer("/python/cpython") : /gone/.test(t) ? { status: 404, body: { error: "no_documentation_found" } } : idAnswer("/websites/python_3_10"); } } });
  try {
    const context7 = makeContext7({ dispatch: h.dispatch, limits: limitsOf(h) });
    const sub = h.dispatch.subject("documentationSearches", "fcpi-fixture-context7");
    const run = async (q, version) => context7.search(pyRequest(q, version), { sub, pre: h.dispatch.preflight(sub, { selection: "fixture" }), signal: new AbortController().signal, deadlineAt: Date.now() + 5000, selection: "fixture" });
    const other = await run("python whats new", "4.0");
    assert.equal(other.status, "success_empty", "pages of 3.10 are not presented as 4.0");
    assert.match(other.detail, /mismatched version left out/);
    assert.equal(other.suboperations[0].versionVerdict, "no_match");
    const same = await run("python whats new", "3.10");
    const scope = same.candidates[0].documentation.scopes[0];
    assert.deepEqual([scope.requestedVersion, scope.observedVersion, scope.status, scope.basis], ["3.10", "3.10", "scope_only", "library_id"]);
    assert.equal(same.suboperations[0].versionVerdict, "confirmed");
    const plain = await run("python plain", "4.0");
    assert.deepEqual([plain.candidates[0].documentation.scopes[0].status, plain.suboperations[0].versionVerdict], ["unknown", "unconfirmed"]);
    const gone = await run("python gone", "4.0");
    assert.deepEqual([gone.status, gone.suboperations[0].versionVerdict], ["success_empty", "no_match"], "the documented no-match is a no-match for the version asked");
    const unscoped = await run("python whats new");
    assert.equal("versionVerdict" in unscoped.suboperations[0], false, "a request with no version has no version to confirm");
  } finally { await h.close(); }
});

test("Context7's quota and rate refusals hold only its account, keep their reservations, and never trip the breaker", async () => {
  const rowsOf = (h) => [...h.store.rows.values()].filter((x) => x.provider === "fixture-context7");
  for (const [mode, answer] of [["quota", { status: 402, body: { error: "quota_exceeded", message: "Monthly quota reached" } }],
    ["rate", { status: 429, body: { error: "rate_limited", message: "slow down" }, headers: { "retry-after": "30" } }]]) {
    const h = await harness({ handlers: { context7: () => answer } });
    try {
      const context7 = makeContext7({ dispatch: h.dispatch, limits: limitsOf(h) });
      const sub = h.dispatch.subject("documentationSearches", "fcpi-fixture-context7");
      const t0 = Date.now();
      const o = await context7.search(docsRequest(`context7 ${mode}`), { sub, pre: h.dispatch.preflight(sub, { selection: "fixture" }), signal: new AbortController().signal, deadlineAt: Date.now() + 5000, selection: "fixture" });
      const reason = mode === "quota" ? "quota_exhausted" : "rate_limited";
      assert.deepEqual([o.status, o.reason], ["failed", reason]);
      assert.deepEqual([o.dispatchState, o.usage], ["response_received", { requests: 0, uncertain: 1 }], `${mode}: an answered refusal is a response, its charge uncertain`);
      const pre = h.dispatch.preflight(sub, { selection: "fixture" });
      assert.deepEqual([pre.eligible, pre.reason], [false, reason], `${mode}: the account is held`);
      if (mode === "rate") assert.ok(pre.retryAt >= t0 + 29000 && pre.retryAt <= Date.now() + 31000, "Retry-After sets when it may be asked again");
      assert.equal(h.dispatch.breakerState("fixture-context7"), "closed");
      assert.deepEqual(rowsOf(h).map((x) => x.state), ["UNCERTAIN"], `${mode}: whether the refused call counted is not documented`);
    } finally { await h.close(); }
  }
});

test("a decision body over the 24,000-byte bound by any amount is refused before anything is reserved", async () => {
  const h = await harness({ handlers: { openrouter: () => ({ status: 200, body: {} }) } });
  try {
    const decisions = makeDecisions({ dispatch: h.dispatch, store: h.store, limits: limitsOf(h), permits: h.permits });
    const { sub, pre } = decisions.preflight("fixture", "fcpi-fixture-jev");
    const max = h.policy.search.intelligence.decisionBatch.maxBytes;
    const body = (n) => { const b = jevBody("bound"); b.state.pad = ""; const over = n - Buffer.byteLength(JSON.stringify(b)); b.state.pad = "x".repeat(Math.max(0, over)); return b; };
    assert.equal(Buffer.byteLength(JSON.stringify(body(max + 1))), max + 1);
    const r = await decisions.decide({ body: body(max + 1), kind: "decision", purpose: "rerank", request: docsRequest("bound"), sub, pre, signal: new AbortController().signal, deadlineAt: Date.now() + 5000, selection: "fixture" });
    assert.deepEqual([r.ok, r.detail], [false, "batch_over_bound"]);
    assert.equal(h.servers.openrouter.seen.length, 0);
    assert.equal(h.store.rows.size, 0, "nothing reserved");
  } finally { await h.close(); }
});

test("Jev's reservation covers its input and a bounded output per question at the card's output price", async () => {
  const card = (b) => b.rateCards.find((c) => c.subject === "fcpi-fixture-jev");
  const h = await harness({ mutateBudget: (b) => { card(b).outputPerMTok = 1000000; }, handlers: { openrouter: () => ({ status: 200, body: { model: JEV_MODEL, answers: { relevant: { type: "noul", noul: 1 } }, usage: { input_tokens: 10, output_tokens: 2 } } }) } });
  try {
    const decisions = makeDecisions({ dispatch: h.dispatch, store: h.store, limits: limitsOf(h), permits: h.permits });
    const { sub, pre } = decisions.preflight("fixture", "fcpi-fixture-jev");
    const body = jevBody("output allowance");
    await decisions.decide({ body, kind: "decision", purpose: "rerank", request: docsRequest("output allowance"), sub, pre, signal: new AbortController().signal, deadlineAt: Date.now() + 5000, selection: "fixture" });
    const bytes = Buffer.byteLength(JSON.stringify(body));
    assert.equal(h.store.lastReserve.amount, Math.ceil((bytes * 42000 + 1 * OUTPUT_TOKENS_PER_QUESTION * 1000000) / 1e6), "input bytes at the input rate plus 64 tokens for the one question");
  } finally { await h.close(); }
});

test("a Jev answer settles at its reported cost, else at its tokens at the card's rate", async () => {
  let usage = { input_tokens: 1000, output_tokens: 10, cost: 0.000123 };
  const h = await harness({ handlers: { openrouter: () => ({ status: 200, body: { model: JEV_MODEL, answers: { relevant: { type: "noul", noul: 1 } }, usage } }) } });
  try {
    const decisions = makeDecisions({ dispatch: h.dispatch, store: h.store, limits: limitsOf(h), permits: h.permits });
    const { sub, pre } = decisions.preflight("fixture", "fcpi-fixture-jev");
    const run = (q) => decisions.decide({ body: jevBody(q), kind: "decision", purpose: "rerank", request: docsRequest(q), sub, pre, signal: new AbortController().signal, deadlineAt: Date.now() + 5000, selection: "fixture" });
    const a = await run("settle at cost");
    assert.deepEqual(a.usage, { microUsd: 123, basis: "provider_reported", inputTokens: 1000 });
    usage = { input_tokens: 1000, output_tokens: 10 };
    const b = await run("settle at tokens");
    assert.deepEqual(b.usage, { microUsd: 42, basis: "tokens_at_rate_card", inputTokens: 1000 }, "1,000 input tokens at 42,000 micro-USD per million; output priced at zero");
    assert.deepEqual([...h.store.rows.values()].map((x) => [x.state, x.actual]), [["SETTLED", 123], ["SETTLED", 42]]);
  } finally { await h.close(); }
});

test("reported dollars become whole micro-USD, rounded up, without the product's float error adding a unit", () => {
  assert.equal(0.000123 * 1e6 > 123, true, "the float product itself overshoots");
  assert.equal(microUsd(0.000123), 123);
  assert.equal(microUsd(0.0000336), 34, "a real fraction of a micro-USD still counts in full");
  assert.equal(microUsd(0.012), 12000);
  assert.equal(microUsd(0.017), 17000);
  assert.equal(microUsd(0), 0);
});

test("a Context7 429 with its monthly allowance spent is quota, held until the reset it reports; otherwise a burst", async () => {
  const now = Math.floor(Date.now() / 1000), reset = now + 86400;
  // [remaining, reset header, expected]: only a whole 0 with a reset ahead and within a monthly span is the allowance spent;
  // a past or absent reset, an empty count, or a reset in milliseconds (decades ahead read as seconds) is a burst.
  for (const [remaining, resetHeader, expected] of [["0", String(reset), "quota_exhausted"], ["12", String(reset), "rate_limited"], ["0", String(now - 3600), "rate_limited"],
    ["0", null, "rate_limited"], ["", String(reset), "rate_limited"], ["0", String(reset * 1000), "rate_limited"]]) {
    const h = await harness({ handlers: { context7: () => ({ status: 429, body: { error: "rate_limited", message: "slow down" },
      headers: { "ratelimit-limit": "1000", "ratelimit-remaining": remaining, ...(resetHeader === null ? {} : { "ratelimit-reset": resetHeader }), ...(expected === "quota_exhausted" ? {} : { "retry-after": "5" }) } }) } });
    try {
      const context7 = makeContext7({ dispatch: h.dispatch, limits: limitsOf(h) });
      const sub = h.dispatch.subject("documentationSearches", "fcpi-fixture-context7");
      const o = await context7.search(docsRequest(`context7 allowance ${remaining || "empty"} ${resetHeader ?? "none"}`), { sub, pre: h.dispatch.preflight(sub, { selection: "fixture" }), signal: new AbortController().signal, deadlineAt: Date.now() + 5000, selection: "fixture" });
      assert.equal(o.reason, expected, `remaining ${JSON.stringify(remaining)}, reset ${resetHeader}`);
      const pre = h.dispatch.preflight(sub, { selection: "fixture" });
      assert.equal(pre.reason, expected);
      if (expected === "quota_exhausted") assert.equal(pre.retryAt, reset * 1000, "held until the reported reset, an absolute epoch");
      else assert.ok(pre.retryAt <= Date.now() + 6000, "a burst waits for its Retry-After");
    } finally { await h.close(); }
  }
});

test("a Brave window's reported reset is held to a monthly span: an absurd reset never parks the provider indefinitely", () => {
  const now = Date.now();
  const r = parseBraveRateHeaders({ "x-ratelimit-limit": "1, 2000", "x-ratelimit-policy": "1;w=1, 2000;w=2678400", "x-ratelimit-remaining": "1, 0", "x-ratelimit-reset": "1, 999999999" }, now);
  assert.equal(r.state, "quota_exhausted");
  assert.equal(r.retryAt, now + 35 * 86400 * 1000);
  const ok = parseBraveRateHeaders({ "x-ratelimit-limit": "1, 2000", "x-ratelimit-policy": "1;w=1, 2000;w=2678400", "x-ratelimit-remaining": "1, 0", "x-ratelimit-reset": "1, 86400" }, now);
  assert.equal(ok.retryAt, now + 86400 * 1000, "a reset within the span is taken as reported");
});
