// The complex-document parser adapter (src/parse.mjs) against the loopback LlamaParse-compatible fixture:
// credits reserved and settled from the pages returned, the cache by bytes/parser/version/owner, the
// uploaded file deleted, PARSER_REQUIRED without a credential, and provider refusals and failures.
import { test } from "node:test";
import assert from "node:assert/strict";
import { makeParser } from "../src/parse.mjs";
import { fixtures, serve, policyFor, lookupFixture, budgetFor, providersDir, FakeLedger } from "./m5-helpers.mjs";

const docs = await import("../fixtures/m5/documents.mjs");
const withMode = (mode) => Buffer.concat([docs.scanPdfBytes(), Buffer.from(`%fcpi-parser-mode=${mode}\n`)]);

async function rig({ parser = "fcpi-fixture-parser", mutate, paidDispatch = false, creds = {} } = {}) {
  const srv = await serve(fixtures.parserHandler);
  fixtures.resetStats();
  const budget = budgetFor({ parserPort: srv.port, mutate: (b) => { b.parsing.jobTimeoutMs = 6000; mutate?.(b); } });
  const store = new FakeLedger();
  const parse = makeParser({ store, getBudget: () => budget, getSelection: () => ({ parser }), paidDispatch, providersDir: providersDir(creds),
    getPolicy: () => policyFor({ "parser.fixture.fcpi.test": srv.port }), resolvePublic: async () => { throw new Error("no public resolution"); }, lookupFixture, log: () => {} });
  return { srv, budget, store, parse, stats: () => fixtures.providerStats().parser };
}
// Owners are the gateway's tags for principals (sixteen hex digits; patch 0010).
const OWNER_A = "a1a1a1a1a1a1a1a1", OWNER_B = "b2b2b2b2b2b2b2b2";
const req = (bytes, over = {}) => ({ logicalId: `scrape:${crypto.randomUUID()}`, owner: OWNER_A, bytes, pages: 1, reason: "scan_only", ...over });

test("a parser lease expiring during reservation sends no upload and releases credits (PRE-M9 C1)", async () => {
  const r = await rig({ paidDispatch: true });
  try {
    r.budget.providers["fixture-parser"].paid = true;
    r.budget.paidTotal.caps.day = 1000000;
    r.budget.validationExpiresAt = new Date(Date.now() + 60000).toISOString();
    const reserve = r.store.reserveBudget.bind(r.store);
    r.store.reserveBudget = async (x) => { const row = await reserve(x); r.budget.validationExpiresAt = new Date(0).toISOString(); return row; };
    await assert.rejects(r.parse(req(docs.scanPdfBytes())), (e) => e.failureClass === "PAID_DISPATCH_DISABLED");
    assert.equal(r.stats().uploads, 0);
    assert.deepEqual(r.store.states(), ["RELEASED"]);
  } finally { await r.srv.close(); }
});

test("a paid parser with no shared daily cap reserves against its category alone and keeps no shared row", async () => {
  const r = await rig({ paidDispatch: true });
  try {
    r.budget.providers["fixture-parser"].paid = true;
    assert.equal(r.budget.paidTotal.caps.day, undefined, "precondition: the deployed policy has no shared cap");
    const asked = [];
    const reserve = r.store.reserveBudget.bind(r.store);
    r.store.reserveBudget = async (x) => { asked.push(x.paidTotalCap); return reserve(x); };
    const out = await r.parse(req(docs.scanPdfBytes()));
    assert.equal(out.ok, true);
    assert.deepEqual(asked, [null], "the ledger is asked for no shared cap, not for an undefined one");
    const [row] = [...r.store.rows.values()];
    assert.equal(row.state, "SETTLED");
    assert.equal(row.paid_total, false);
  } finally { await r.srv.close(); }
});

test("a scan-only page is parsed, its credits settled from the pages returned, cached, and its upload deleted", async () => {
  const r = await rig();
  try {
    const bytes = docs.scanPdfBytes();
    const out = await r.parse(req(bytes));
    assert.equal(out.ok, true);
    assert.match(out.markdown, /FCPI SCAN 42/);
    assert.equal(out.pages, 1);
    assert.equal(out.credits, 3);
    assert.match(out.file, /delete answered 204/);
    assert.equal(r.store.used("fixture_parser"), 3);
    const again = await r.parse(req(bytes));
    assert.equal(again.cached, true);
    assert.equal(r.stats().uploads, 1, "the second parse of the same bytes was a cache hit");
    // Another owner's request for the same bytes is its own parse (the cache is owner-scoped).
    await r.parse(req(bytes, { owner: OWNER_B }));
    assert.equal(r.stats().uploads, 2);
    // M7 (M5 review S1): a parse with no owner, or with anything but an owner tag, neither reads nor fills the cache.
    for (const owner of [null, "", "team-1"]) assert.equal((await r.parse(req(bytes, { owner }))).cached, false);
    assert.equal(r.stats().uploads, 5);
  } finally { await r.srv.close(); }
});

test("without its credential the complex-document parser answers PARSER_REQUIRED, with no request and no reservation", async () => {
  const r = await rig({ parser: "llamaparse-cost-effective" });
  try {
    await assert.rejects(r.parse(req(docs.scanPdfBytes())), (e) => e.failureClass === "PARSER_REQUIRED");
    assert.equal(r.stats().uploads, 0);
    assert.equal(r.store.rows.size, 0);
  } finally { await r.srv.close(); }
  // With the credential but paid dispatch off, and with both but a zero credit allowance: refused before any upload.
  const p = await rig({ parser: "llamaparse-cost-effective", creds: { llamaparse_api_key: "llx-test-0000000000000000" } });
  try { await assert.rejects(p.parse(req(docs.scanPdfBytes())), (e) => e.failureClass === "PAID_DISPATCH_DISABLED"); } finally { await p.srv.close(); }
  // The zero is set here, whatever the committed policy approves.
  const z = await rig({ parser: "llamaparse-cost-effective", paidDispatch: true, creds: { llamaparse_api_key: "llx-test-0000000000000000" }, mutate: (b) => { b.categories.parser.caps = { month: 0 }; } });
  try { await assert.rejects(z.parse(req(docs.scanPdfBytes())), (e) => e.failureClass === "BUDGET_EXHAUSTED" && /0 of 0 credits/.test(e.detail)); } finally { await z.srv.close(); }
});

test("limits are checked before any spend: pages, size, type", async () => {
  const r = await rig();
  try {
    await assert.rejects(r.parse(req(docs.manyPagesPdfBytes(), { pages: 101 })), (e) => e.failureClass === "DOCUMENT_TOO_MANY_PAGES");
    await assert.rejects(r.parse(req(Buffer.alloc(26 * 1048576, 32))), (e) => e.failureClass === "DOCUMENT_TOO_LARGE");
    await assert.rejects(r.parse(req(Buffer.from("<html>not a pdf</html>"))), (e) => e.failureClass === "UNSUPPORTED_CONTENT");
    assert.equal(r.stats().uploads, 0);
  } finally { await r.srv.close(); }
});

test("the provider is held to the reserved pages, and pages past them are settled and said so (review W1)", async () => {
  const r = await rig();
  try {
    // The core counted one page; the document holds three. The upload asks for one, and one is billed.
    const held = await r.parse(req(docs.manyPagesPdfBytes(3), { reason: "complex_layout" }));
    assert.equal(held.pages, 1);
    assert.equal(held.credits, 3);
    // A provider that parses all three anyway is settled at all three, above the reservation.
    const over = Buffer.concat([docs.manyPagesPdfBytes(3), Buffer.from("%fcpi-parser-mode=ignore-max-pages\n")]);
    const out = await r.parse(req(over, { reason: "complex_layout" }));
    assert.equal(out.pages, 3);
    assert.equal(out.credits, 9);
    const row = [...r.store.rows.values()].at(-1);
    assert.equal(row.reserved, 3);
    assert.equal(row.actual, 9);
    assert.match(row.detail, /settled above the reservation by 6/);
    assert.equal(r.store.used("fixture_parser"), 12);
  } finally { await r.srv.close(); }
});

test("a retried parse that returned no text is PARSE_EMPTY again, with no second upload (review W12)", async () => {
  const r = await rig();
  try {
    const q = req(withMode("empty"));
    await assert.rejects(r.parse(q), (e) => e.failureClass === "PARSE_EMPTY");
    await assert.rejects(r.parse(q), (e) => e.failureClass === "PARSE_EMPTY");
    assert.equal(r.stats().uploads, 1);
  } finally { await r.srv.close(); }
});

test("a parse reused under its logical id must be the same request: another owner's is refused (review S2)", async () => {
  const r = await rig();
  try {
    const q = req(docs.scanPdfBytes());
    await r.parse(q);
    await assert.rejects(r.parse({ ...q, owner: OWNER_B }), (e) => e.failureClass === "LOGICAL_ID_CONFLICT");
    assert.equal(r.stats().uploads, 1);
  } finally { await r.srv.close(); }
});

test("an upload accepted with a 202 starts its job like a 200 (review W11)", async () => {
  const r = await rig();
  try {
    const out = await r.parse(req(withMode("accepted-202")));
    assert.match(out.markdown, /FCPI SCAN 42/);
    assert.deepEqual(r.store.states(), ["SETTLED"]);
  } finally { await r.srv.close(); }
});

test("an upload answered without a job id counts against the breaker; its credits stay reserved (review W10)", async () => {
  const r = await rig();
  try {
    for (let i = 0; i < 3; i++) await assert.rejects(r.parse(req(withMode("no-job-id"))), (e) => e.failureClass === "PROVIDER_UNCERTAIN");
    const uploads = r.stats().uploads;
    await assert.rejects(r.parse(req(docs.scanPdfBytes())), (e) => e.failureClass === "PROVIDER_UNAVAILABLE");
    assert.equal(r.stats().uploads, uploads, "the open breaker sent nothing");
    // Readiness reads the parser's own breaker (review W6).
    assert.equal(r.parse.breakerState("fixture-parser"), "open");
    assert.equal(r.parse.breakerState("llamaparse"), "closed");
    assert.deepEqual(r.store.states(), ["UNCERTAIN", "UNCERTAIN", "UNCERTAIN"]);
  } finally { await r.srv.close(); }
});

test("provider refusals release the credits; a failed or unfinished job keeps them reserved until reconciled", async () => {
  for (const [mode, cls, state] of [["http-401", "PROVIDER_AUTH_FAILED", "RELEASED"], ["http-402", "PROVIDER_BILLING", "RELEASED"], ["http-500", "PROVIDER_ERROR", "RELEASED"], ["http-502", "PROVIDER_UNCERTAIN", "UNCERTAIN"],
    ["job-fails", "PARSE_FAILED", "UNCERTAIN"], ["never-finishes", "PROVIDER_UNCERTAIN", "UNCERTAIN"], ["empty", "PARSE_EMPTY", "SETTLED"]]) {
    const r = await rig();
    try {
      await assert.rejects(r.parse(req(withMode(mode))), (e) => e.failureClass === cls, mode);
      assert.deepEqual(r.store.states(), [state], mode);
      if (state === "RELEASED") assert.equal(r.store.used("fixture_parser"), 0, mode);
      else assert.equal(r.store.used("fixture_parser"), 3, mode);
    } finally { await r.srv.close(); }
  }
});
