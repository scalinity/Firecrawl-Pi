// SI5's degraded-operation matrix (docs/FIRECRAWL_PI_SEARCH_INTELLIGENCE_SPEC.md §23.3, F02): each general engine, Context7, Ref
// and Jev made unconfigured, circuit-open, rate-limited, quota-exhausted, refused authentication, cut off, answered in an unknown
// shape, validly empty, past its deadline, or cancelled, one at a time (Serper's quota is its fixed allocation spent, refused by
// the ledger); then the combinations, among them one validly empty provider with every other discovery provider failed,
// documentation included. Each cell asserts the search's honest outcome, the provider's attributed reason, and that only a
// service failure can open a breaker.
import { test } from "node:test";
import assert from "node:assert/strict";
import { harness, request, answers, json, refFixture, defaultRefTool } from "./si-helpers.mjs";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const delayed = (ms, a) => async (...x) => { await sleep(ms); return typeof a === "function" ? a(...x) : a; };
const run = (h, over = {}, signal = new AbortController().signal) => h.coordinator.search(request(over), { signal });
const missing = (s, provider) => [...s.coverage.general.missing, ...s.coverage.documentation.missing].find((m) => m.provider === provider);
const unconfigured = (provider) => (b) => { b.providers[provider].credential = "fcpi_missing_credential_file"; };
const oneFailure = (b) => { b.breaker = { ...b.breaker, failures: 1 }; };

// Each general engine's documented refusals (the Brave authentication refusal is the 422 live Brave answered, SI5 smoke).
const GENERAL = {
  serper: { empty: () => ({ status: 200, body: { credits: 1, organic: [] } }), rate: () => ({ status: 429, body: { message: "Too many requests" }, headers: { "retry-after": "30" } }),
    auth: () => ({ status: 403, body: { message: "Unauthorized." } }), contract: () => ({ status: 200, body: { results: [] } }) },
  brave: { empty: (q) => ({ status: 200, body: { query: { original: q }, web: { type: "search", results: [] } } }), rate: () => ({ status: 429, body: { error: { code: "RATE_LIMITED" } }, headers: { "retry-after": "30" } }),
    quota: () => ({ status: 429, body: { error: { code: "QUOTA_LIMITED" } } }), auth: () => ({ status: 422, body: { error: { code: "SUBSCRIPTION_TOKEN_INVALID", detail: "invalid" } } }), contract: () => ({ status: 200, body: { web: { results: "nope" } } }) },
  exa: { empty: () => ({ status: 200, body: { requestId: "x", results: [], costDollars: { total: 0.005 } } }), rate: () => ({ status: 429, body: { error: "rate" }, headers: { "retry-after": "30" } }),
    quota: () => ({ status: 402, body: { requestId: "x", error: "Out of credits", tag: "NO_MORE_CREDITS" } }), auth: () => ({ status: 401, body: { requestId: "x", error: "bad key", tag: "INVALID_API_KEY" } }), contract: () => ({ status: 200, body: { results: "nope" } }) },
  deepseek: { empty: () => ({ status: 200, body: { results: [] } }), rate: () => ({ status: 429, body: { error: { message: "rate" } }, headers: { "retry-after": "30" } }),
    quota: () => ({ status: 402, body: { error: { message: "Insufficient Balance" } } }), auth: () => ({ status: 401, body: { error: { message: "bad key", type: "invalid_request_error" } } }), contract: () => ({ status: 200, body: { results: 5 } }) },
  tavily: { empty: (q) => ({ status: 200, body: { query: q, results: [], usage: { credits: 2 }, request_id: "t" } }), rate: () => ({ status: 429, body: { detail: { error: "rate" } }, headers: { "retry-after": "30" } }),
    quota: () => ({ status: 432, body: { detail: { error: "plan limit" } } }), auth: () => ({ status: 401, body: { detail: { error: "bad key" } } }), contract: () => ({ status: 200, body: { results: {} } }) },
};

for (const [p, refusal] of Object.entries(GENERAL)) {
  test(`degraded ${p}: each failure class is attributed, the others still answer, and only a service failure trips its breaker`, async () => {
    const cells = [
      ["unconfigured", { mutateBudget: unconfigured(`fixture-${p}`) }, "not_configured"],
      ["rate limited", { handlers: { [p]: refusal.rate } }, "rate_limited"],
      ...(refusal.quota ? [["quota exhausted", { handlers: { [p]: refusal.quota } }, "quota_exhausted"]] : []),
      ["authentication refused", { handlers: { [p]: refusal.auth } }, "auth_failed"],
      ["cut off", { handlers: { [p]: () => "destroy" } }, "temporarily_unavailable"],
      ["unknown shape", { handlers: { [p]: refusal.contract } }, "contract_failure"],
    ];
    for (const [label, opts, reason] of cells) {
      const h = await harness(opts);
      try {
        const s = (await run(h)).body.search;
        assert.equal(s.outcome, "partial", `${p} ${label}`);
        assert.equal(missing(s, p)?.reason, reason, `${p} ${label}: the exclusion is attributed`);
        assert.equal(s.coverage.general.successful, 4, `${p} ${label}: the other engines still answered`);
        if (label !== "cut off") assert.equal(h.dispatch.breakerState(`fixture-${p}`), "closed", `${p} ${label}: no breaker trips on it`);
      } finally { await h.close(); }
    }
    // Valid empty is a success, never a failure.
    const e = await harness({ handlers: { [p]: refusal.empty } });
    try { const s = (await run(e)).body.search; assert.deepEqual([s.outcome, s.providers[p].status], ["complete", "success_empty"]); } finally { await e.close(); }
    // A breaker opened by a service failure is the next search's exclusion.
    let n = 0;
    const b = await harness({ mutateBudget: oneFailure, handlers: { [p]: (...x) => (n++ === 0 ? "destroy" : answers[p](...x)) } });
    try {
      await run(b, { originalQuery: "breaker one" });
      assert.equal(missing((await run(b, { originalQuery: "breaker two" })).body.search, p)?.reason, "breaker_open", `${p}: circuit open`);
    } finally { await b.close(); }
    // Past its deadline: the lane is cut at the search's discovery bound, the rest are kept.
    const d = await harness({ handlers: { [p]: delayed(6000, answers[p]) } });
    try { const s = (await run(d, { absoluteDeadlineMs: Date.now() + 2500 })).body.search; assert.equal(missing(s, p)?.reason, "timeout", `${p}: deadline`); } finally { await d.close(); }
  });
}

test("degraded documentation: Context7 and Ref each fail on their own without touching the other or the engines", async () => {
  const docs = { intelligence: { documentation: "required" } };
  const c7ok = () => ({ status: 200, body: { codeSnippets: [{ libraryId: "/x/docs", codeTitle: "t", codeDescription: "d", codeLanguage: "js", codeList: [{ language: "js", code: "x()" }], codeId: "https://docs.example.org/x" }], infoSnippets: [] } });
  const cells = [
    ["context7", "unconfigured", { mutateBudget: unconfigured("fixture-context7"), handlers: { context7: c7ok, ref: refFixture() } }, "not_configured"],
    ["context7", "rate limited", { handlers: { context7: () => ({ status: 429, body: { error: "rate" }, headers: { "retry-after": "30" } }), ref: refFixture() } }, "rate_limited"],
    ["context7", "quota exhausted", { handlers: { context7: () => ({ status: 402, body: { error: "quota" } }), ref: refFixture() } }, "quota_exhausted"],
    ["context7", "authentication refused", { handlers: { context7: () => ({ status: 401, body: { error: "invalid_api_key" } }), ref: refFixture() } }, "auth_failed"],
    ["context7", "cut off", { handlers: { context7: () => "destroy", ref: refFixture() } }, "temporarily_unavailable"],
    ["context7", "unknown shape", { handlers: { context7: () => ({ status: 200, body: { results: [] } }), ref: refFixture() } }, "contract_failure"],
    ["ref", "unconfigured", { mutateBudget: unconfigured("fixture-ref"), handlers: { context7: c7ok, ref: refFixture() } }, "not_configured"],
    ["ref", "rate limited", { handlers: { context7: c7ok, ref: refFixture({ tool: () => ({ status: 429 }) }) } }, "rate_limited"],
    ["ref", "quota exhausted", { handlers: { context7: c7ok, ref: refFixture({ tool: () => ({ content: [{ type: "text", text: "Not enough credits to complete this search." }] }) }) } }, "quota_exhausted"],
    ["ref", "authentication refused", { handlers: { context7: c7ok, ref: refFixture({ initialize: () => ({ status: 401 }) }) } }, "auth_failed"],
    ["ref", "cut off", { handlers: { context7: c7ok, ref: refFixture({ tool: () => "destroy" }) } }, "temporarily_unavailable"],
    ["ref", "unknown shape", { handlers: { context7: c7ok, ref: refFixture({ tool: () => ({ content: [{ type: "text", text: "A format nobody documented" }] }) }) } }, "contract_failure"],
  ];
  for (const [p, label, opts, reason] of cells) {
    const h = await harness(opts);
    try {
      const s = (await run(h, docs)).body.search;
      assert.equal(s.outcome, "partial", `${p} ${label}`);
      assert.equal(missing(s, p)?.reason, reason, `${p} ${label}`);
      const other = p === "context7" ? "ref" : "context7";
      assert.equal(s.providers[other].status, "success_results", `${p} ${label}: the other documentation provider is unaffected`);
      assert.equal(s.coverage.general.successful, 5);
      if (label !== "cut off") assert.equal(h.dispatch.breakerState(`fixture-${p}`), "closed");
    } finally { await h.close(); }
  }
  // Validly empty documentation is a success for each provider.
  for (const [p, opts] of [["context7", { handlers: { context7: () => ({ status: 404, body: { error: "no_documentation_found" } }), ref: refFixture() } }],
    ["ref", { handlers: { context7: c7ok, ref: refFixture({ tool: () => ({ content: [{ type: "text", text: "No results found" }] }) }) } }]]) {
    const h = await harness(opts);
    try { const s = (await run(h, docs)).body.search; assert.deepEqual([s.outcome, s.providers[p].status], ["complete", "success_empty"], `${p} valid empty`); } finally { await h.close(); }
  }
  // Past their deadline: each documentation lane is cut at the discovery bound on its own.
  for (const [p, opts] of [["context7", { handlers: { context7: delayed(6000, c7ok), ref: refFixture() } }],
    ["ref", { handlers: { context7: c7ok, ref: refFixture({ tool: delayed(6000, () => ({ content: [{ type: "text", text: "No results found" }] })) }) } }]]) {
    const h = await harness(opts);
    try { const s = (await run(h, { ...docs, absoluteDeadlineMs: Date.now() + 2500 })).body.search; assert.equal(missing(s, p)?.reason, "timeout", `${p} deadline`); } finally { await h.close(); }
  }
});

test("degraded Jev: every failure leaves the deterministic ranking, full discovery coverage, and no empty answer", async () => {
  const ok = (q, entry) => {
    const a = {};
    for (const [k, question] of Object.entries(entry.body.questions)) a[k] = question.type === "score" ? { type: "score", score: 2 } : question.type === "noul" ? { type: "noul", noul: 0.5 } : { type: "choice", choice: Object.keys(question.criteria)[0] };
    return { status: 200, body: { model: "typesafe/jev-1.14-20261014", answers: a, usage: { input_tokens: 10, output_tokens: 1 } } };
  };
  const cells = [
    ["unconfigured", { mutateBudget: unconfigured("fixture-openrouter"), handlers: { openrouter: ok } }, /^jev_not_configured$/],
    ["rate limited", { handlers: { openrouter: () => ({ status: 429, body: { error: { code: 429, message: "rate" } }, headers: { "retry-after": "30" } }) } }, /^jev_rate_limited$/],
    ["in-flight budget", { handlers: { openrouter: () => ({ status: 402, body: { error: { code: 402, message: "busy", metadata: { limit_source: "openrouter_in_flight_budget" } } } }) } }, /^jev_rate_limited$/],
    ["credits exhausted", { handlers: { openrouter: () => ({ status: 402, body: { error: { code: 402, message: "Insufficient credits", metadata: { limit_source: "openrouter_credits" } } } }) } }, /^jev_quota_exhausted$/],
    ["authentication refused", { handlers: { openrouter: () => ({ status: 401, body: { error: { code: 401, message: "No auth" } } }) } }, /^jev_auth_failed$/],
    ["cut off", { handlers: { openrouter: () => "destroy" } }, /^jev_temporarily_unavailable$/],
    ["another model", { handlers: { openrouter: (q, e) => ({ ...ok(q, e), body: { ...ok(q, e).body, model: "typesafe/jev-1.13" } }) } }, /^jev_contract_failure$/],
    ["past the semantic budget", { mutatePolicy: (pol) => { pol.search.intelligence.semanticMs = 1000; }, handlers: { openrouter: delayed(3000, ok) } }, /^jev_timeout$/],
  ];
  for (const [label, opts, reason] of cells) {
    const h = await harness(opts);
    try {
      const r = await run(h);
      const s = r.body.search;
      assert.equal(s.ranking.mode, "rrf_fallback", `Jev ${label}`);
      assert.match(s.ranking.reason, reason, `Jev ${label}`);
      assert.deepEqual([s.outcome, s.coverage.general.successful], ["complete", 5], `Jev ${label}: discovery coverage is untouched`);
      assert.ok(r.body.web.length > 0, `Jev ${label}: useful deterministic results remain`);
      if (!["cut off", "past the semantic budget"].includes(label)) assert.equal(h.dispatch.breakerState("fixture-openrouter"), "closed", `Jev ${label}`);
    } finally { await h.close(); }
  }
  // A breaker Jev's service failures opened: the next search ranks deterministically, saying why.
  // Every call of the first search fails (a later success there would rightly close the breaker again).
  let down = true;
  const b = await harness({ mutateBudget: oneFailure, handlers: { openrouter: (q, e) => (down ? "destroy" : ok(q, e)) } });
  try {
    await run(b, { originalQuery: "jev breaker one" });
    down = false;
    const s = (await run(b, { originalQuery: "jev breaker two" })).body.search;
    assert.deepEqual([s.ranking.mode, s.ranking.reason], ["rrf_fallback", "jev_breaker_open"]);
  } finally { await b.close(); }
});

test("degraded combinations: both docs down, all engines down with and without SearXNG, everything down, one valid empty among failures", async () => {
  const down = () => "destroy";
  const allDown = { serper: down, brave: down, exa: down, deepseek: down, tavily: down };
  // Both documentation providers down: the engines' results stand, both are named.
  let h = await harness({ handlers: { context7: down, ref: refFixture({ tool: () => "destroy" }) } });
  try {
    const s = (await run(h, { intelligence: { documentation: "required" } })).body.search;
    assert.deepEqual([s.outcome, s.coverage.general.successful, s.coverage.documentation.missing.map((m) => m.provider).sort()], ["partial", 5, ["context7", "ref"]]);
  } finally { await h.close(); }
  // Every engine down, SearXNG answering: partial, from SearXNG.
  h = await harness({ handlers: allDown, searxng: (req, res) => json(res, 200, { results: [{ url: "https://searx.example/a", title: "A", content: "a", engines: ["fcpi fixture"] }], unresponsive_engines: [] }) });
  try {
    const r = await run(h);
    assert.deepEqual([r.body.search.outcome, r.body.search.coverage.searxng.used, r.body.web.map((w) => w.url)], ["partial", true, ["https://searx.example/a"]]);
  } finally { await h.close(); }
  // Every engine down and no SearXNG: a typed failure, never an empty success.
  h = await harness({ handlers: allDown });
  try { await assert.rejects(run(h), (e) => e.failureClass === "SEARCH_ENGINES_FAILED"); } finally { await h.close(); }
  // Every discovery provider down, documentation included: still a failure.
  h = await harness({ handlers: { ...allDown, context7: down, ref: refFixture({ tool: () => "destroy" }) } });
  try { await assert.rejects(run(h, { intelligence: { documentation: "required" } }), (e) => e.failureClass === "SEARCH_ENGINES_FAILED"); } finally { await h.close(); }
  // One validly empty provider among failures: an honest empty answer, partial, not a failure.
  h = await harness({ handlers: { ...allDown, tavily: GENERAL.tavily.empty } });
  try {
    const s = (await run(h)).body.search;
    assert.deepEqual([s.outcome, s.empty, s.providers.tavily.status, s.coverage.general.successful], ["partial", true, "success_empty", 1]);
  } finally { await h.close(); }
  // The caller cancels while engines are still answering: the search ends cancelled, and nothing more is asked of any provider.
  h = await harness({ handlers: { serper: delayed(1500, answers.serper), brave: delayed(1500, answers.brave), exa: delayed(1500, answers.exa), deepseek: delayed(1500, answers.deepseek), tavily: delayed(1500, answers.tavily) } });
  try {
    const ac = new AbortController();
    const pending = run(h, { originalQuery: "cancelled mid search" }, ac.signal);
    await sleep(100);
    ac.abort();
    await assert.rejects(pending, (e) => e.failureClass === "CANCELLED");
    const asked = Object.fromEntries(Object.entries(h.servers).map(([p, s]) => [p, s.seen.length]));
    await sleep(2000);
    assert.deepEqual(Object.fromEntries(Object.entries(h.servers).map(([p, s]) => [p, s.seen.length])), asked, "no request after the cancellation");
  } finally { await h.close(); }
});

test("degraded single cells: each documentation circuit, each lone provider cancelled, Serper's allocation spent, one empty among every failure", async () => {
  const docs = { intelligence: { documentation: "required" } };
  const c7ok = () => ({ status: 200, body: { codeSnippets: [{ libraryId: "/x/docs", codeTitle: "t", codeDescription: "d", codeLanguage: "js", codeList: [{ language: "js", code: "x()" }], codeId: "https://docs.example.org/x" }], infoSnippets: [] } });
  const jevOk = (q, entry) => {
    const a = {};
    for (const [k, question] of Object.entries(entry.body.questions)) a[k] = question.type === "score" ? { type: "score", score: 2 } : question.type === "noul" ? { type: "noul", noul: 0.5 } : { type: "choice", choice: Object.keys(question.criteria)[0] };
    return { status: 200, body: { model: "typesafe/jev-1.14-20261014", answers: a, usage: { input_tokens: 10, output_tokens: 1 } } };
  };
  // A circuit a service failure opened is each documentation provider's next exclusion, the other untouched. Every call of the
  // first search fails, so no later success in it closes the breaker again.
  for (const p of ["context7", "ref"]) {
    let down = true;
    const handlers = p === "context7" ? { context7: (...x) => (down ? "destroy" : c7ok(...x)), ref: refFixture() } : { context7: c7ok, ref: refFixture({ tool: (...x) => (down ? "destroy" : defaultRefTool(...x)) }) };
    const h = await harness({ mutateBudget: oneFailure, handlers });
    try {
      await run(h, { ...docs, originalQuery: `${p} breaker one` });
      down = false;
      const s = (await run(h, { ...docs, originalQuery: `${p} breaker two` })).body.search;
      assert.equal(missing(s, p)?.reason, "breaker_open", `${p}: circuit open`);
      assert.equal(s.providers[p === "context7" ? "ref" : "context7"].status, "success_results", `${p}: the other documentation provider is unaffected`);
      assert.equal(s.coverage.general.successful, 5, `${p}: the engines are unaffected`);
    } finally { await h.close(); }
  }
  // The caller cancels while one provider alone is still answering: the search ends cancelled and that provider is asked
  // nothing more (a Ref session's close is not a question; its tool calls are counted).
  const ref = refFixture({ tool: delayed(1500, (...x) => defaultRefTool(...x)) });
  for (const [p, handlers, over, wait, asked] of [
    ["context7", { context7: delayed(1500, c7ok), ref: refFixture() }, docs, 150, (h) => h.servers.context7.seen.length],
    ["ref", { context7: c7ok, ref }, docs, 150, () => ref.log.filter((e) => e.tool).length],
    ["openrouter", { openrouter: delayed(1500, jevOk) }, {}, 500, (h) => h.servers.openrouter.seen.length]]) {
    const h = await harness({ handlers });
    try {
      const ac = new AbortController();
      const pending = run(h, { ...over, originalQuery: `cancel ${p}` }, ac.signal);
      await sleep(wait);
      assert.ok(asked(h) > 0, `${p}: it was asked before the cancellation`);
      ac.abort();
      await assert.rejects(pending, (e) => e.failureClass === "CANCELLED", `${p}: cancelled`);
      const before = asked(h);
      await sleep(2000);
      assert.equal(asked(h), before, `${p}: no request after the cancellation`);
    } finally { await h.close(); }
  }
  // Serper's fixed allocation spent (the ledger refuses its reservation): excluded as quota, nothing sent, the others answer.
  let h = await harness();
  const reserve = h.store.reserveBudget.bind(h.store);
  h.store.reserveBudget = async (r) => (r.provider === "fixture-serper" ? { reservation: null } : reserve(r));
  try {
    const s = (await run(h, { originalQuery: "serper allocation spent" })).body.search;
    assert.deepEqual([s.outcome, missing(s, "serper")?.reason, s.coverage.general.successful], ["partial", "quota_exhausted", 4]);
    assert.equal(h.servers.serper.seen.length, 0, "nothing is sent past a spent allocation");
    assert.equal(h.dispatch.breakerState("fixture-serper"), "closed");
  } finally { await h.close(); }
  // One validly empty engine with every other discovery provider failed, documentation active: an honest partial empty answer.
  const down = () => "destroy";
  h = await harness({ handlers: { serper: down, brave: down, exa: down, deepseek: down, tavily: GENERAL.tavily.empty, context7: down, ref: refFixture({ tool: () => "destroy" }) } });
  try {
    const s = (await run(h, docs)).body.search;
    assert.deepEqual([s.outcome, s.empty, s.providers.tavily.status, s.coverage.general.successful, s.coverage.documentation.missing.map((m) => m.provider).sort()],
      ["partial", true, "success_empty", 1, ["context7", "ref"]]);
  } finally { await h.close(); }
});
