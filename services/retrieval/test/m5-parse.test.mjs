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
  return { srv, store, parse, stats: () => fixtures.providerStats().parser };
}
const req = (bytes, over = {}) => ({ logicalId: `scrape:${crypto.randomUUID()}`, owner: "owner-a", bytes, pages: 1, reason: "scan_only", ...over });

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
    await r.parse(req(bytes, { owner: "owner-b" }));
    assert.equal(r.stats().uploads, 2);
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
  const z = await rig({ parser: "llamaparse-cost-effective", paidDispatch: true, creds: { llamaparse_api_key: "llx-test-0000000000000000" } });
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

test("an upload answered without a job id counts against the breaker; its credits stay reserved (review W10)", async () => {
  const r = await rig();
  try {
    for (let i = 0; i < 3; i++) await assert.rejects(r.parse(req(withMode("no-job-id"))), (e) => e.failureClass === "PROVIDER_UNCERTAIN");
    const uploads = r.stats().uploads;
    await assert.rejects(r.parse(req(docs.scanPdfBytes())), (e) => e.failureClass === "PROVIDER_UNAVAILABLE");
    assert.equal(r.stats().uploads, uploads, "the open breaker sent nothing");
    assert.deepEqual(r.store.states(), ["UNCERTAIN", "UNCERTAIN", "UNCERTAIN"]);
  } finally { await r.srv.close(); }
});

test("provider refusals release the credits; a failed or unfinished job keeps them reserved until reconciled", async () => {
  for (const [mode, cls, state] of [["http-401", "PROVIDER_AUTH_FAILED", "RELEASED"], ["http-402", "PROVIDER_BILLING", "RELEASED"], ["http-500", "PROVIDER_ERROR", "RELEASED"],
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
