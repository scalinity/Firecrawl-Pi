// SI2 dispatch (docs/FIRECRAWL_PI_SEARCH_INTELLIGENCE_SPEC.md §8.2, §15, §18.2): the documentation and decision adapters go
// through the same metered dispatch as the general engines, so one failed call is one breaker verdict, against fixture
// servers that speak Context7's and OpenRouter's documented wire formats.
import { test } from "node:test";
import assert from "node:assert/strict";
import { harness, request } from "./si-helpers.mjs";
import { makeContext7 } from "../src/search-intelligence/adapters/context7.mjs";
import { makeDecisions } from "../src/search-intelligence/decisions.mjs";
import { JEV_MODEL } from "../src/budget.mjs";

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
