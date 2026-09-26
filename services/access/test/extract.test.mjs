// The gateway's extraction runner (src/extract.mjs) against an in-memory ledger, a real archive in a
// temporary root, a stand-in core and a stand-in extraction service: the states a job ends in, the
// failures it names, a resumed job reusing the pages it archived, and an unreachable extraction service
// leaving the job to be tried again.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openArchive, MARKER } from "../src/archive.mjs";
import { makeExtractJobs } from "../src/extract.mjs";
import { ExtractorError } from "../src/extractor.mjs";

const M = { limits: { extract: { maxUrls: 10, deadlineMinutes: 20, scrapeTimeoutMs: 60000, maxDocumentBytes: 1048576 } } };
class Ledger {
  constructor(job) { this.job = { state: "RECEIVED", dispatch_attempts: 0, ...job }; this.docs = []; this.finished = null; }
  async claimExtract() {
    if (this.job.state === "RUNNING") return { ...this.job };
    if (this.job.state !== "RECEIVED") return null;
    Object.assign(this.job, { state: "RUNNING", dispatch_attempts: this.job.dispatch_attempts + 1, deadline: this.job.deadline ?? new Date(Date.now() + 600000) });
    return { ...this.job, overdue: this.job.overdueAtClaim ?? false };
  }
  async documentKeys() { return this.docs.map((d) => ({ doc_key: d.docKey, ordinal: d.ordinal, sha256: d.sha256, bytes: d.bytes })); }
  async addDocuments(_id, rows) { for (const r of rows) if (!this.docs.some((d) => d.docKey === r.docKey)) this.docs.push(r); }
  async finishExtract(_id, to, f, detail) { this.job.state = to; this.finished = { to, ...f, detail }; return this.job; }
}
async function rig({ job, core, extract }) {
  const root = mkdtempSync(join(tmpdir(), "fcpi-extract-"));
  writeFileSync(join(root, MARKER), "");
  const archive = await openArchive(root);
  const store = new Ledger({ id: "0190f1a0-0000-7000-8000-000000000001", submission_key: "fcpi:0190f1a0-0000-7000-8000-000000000001", ...job });
  const calls = { scrape: [], extract: [] };
  const upstream = { call: async (method, path, { body }) => { calls.scrape.push(body.url); return core(body); } };
  const extractor = { extract: async (body) => { calls.extract.push(body); return extract(body); } };
  const logs = [];
  const runner = makeExtractJobs({ cfg: { manifest: M, coreTimeoutMs: 110000, pollMs: 60000 }, store, upstream, archive, extractor, log: (o) => logs.push(o) });
  return { store, calls, logs, run: () => runner.kick(), archive };
}
const page = (url, md) => ({ status: 200, json: { success: true, data: { markdown: md, metadata: { url, sourceURL: url, statusCode: 200 } } } });
const ok = (body) => ({ status: 200, json: { ok: true, model: "fcpi-fixture-model", data: { price: 1 }, sources: { "$": [body.documents[0].url] }, warnings: [], missingRequired: [],
  units: body.documents.map((d) => ({ url: d.url, part: 1, ok: true })), usage: { calls: 1, reused: 0, promptTokens: 10, completionTokens: 5, costMicroUsd: 12 } } });
const REQ = { urls: ["https://a.example/1", "https://a.example/2"], schema: { type: "object", properties: { price: { type: "number" } } }, prompt: "p" };

test("every page scraped and extracted: SUCCEEDED, the result archived, the submission key as the logical id", async () => {
  const r = await rig({ job: { request: REQ }, core: (b) => page(b.url, `Price: 1 on ${b.url}`), extract: ok });
  await r.run();
  assert.equal(r.store.finished.to, "SUCCEEDED");
  assert.equal(r.store.finished.completed, 2);
  assert.equal(r.calls.extract[0].logicalId, "fcpi:0190f1a0-0000-7000-8000-000000000001");
  assert.deepEqual(r.calls.extract[0].documents.map((d) => d.url), REQ.urls);
  const result = r.store.docs.find((d) => d.docKey === "result");
  assert.deepEqual(JSON.parse((await r.archive.read(result.sha256)).toString()).data, { price: 1 });
  assert.deepEqual(r.store.docs.map((d) => d.docKey).sort(), ["result", "source:0", "source:1"]);
});

test("a page the core could not scrape makes the job PARTIAL, with the page and its code named", async () => {
  const r = await rig({ job: { request: REQ }, core: (b) => (b.url.endsWith("/2") ? { status: 500, json: { success: false, code: "SCRAPE_FCPI_RETRIEVAL", error: "Retrieval failed: TIMEOUT." } } : page(b.url, "Price: 1")), extract: ok });
  await r.run();
  assert.equal(r.store.finished.to, "PARTIAL");
  assert.equal(r.store.finished.errors.errors[0].url, "https://a.example/2");
  assert.equal(r.store.finished.errors.errors[0].code, "SCRAPE_FCPI_RETRIEVAL");
  assert.equal(r.calls.extract[0].documents.length, 1);
});

test("no page scraped: FAILED NO_PAGES, and the model is never asked", async () => {
  const r = await rig({ job: { request: REQ }, core: () => ({ status: 403, json: { success: false, code: "SSRF_DENIED", error: "refused" } }), extract: ok });
  await r.run();
  assert.equal(r.store.finished.to, "FAILED");
  assert.equal(r.store.finished.errorCode, "NO_PAGES");
  assert.equal(r.calls.extract.length, 0);
});

test("the extraction service's typed refusal closes the job FAILED with its class (paid caps at zero, for one)", async () => {
  const r = await rig({ job: { request: REQ }, core: (b) => page(b.url, "Price: 1"),
    extract: () => ({ status: 402, json: { failure: { class: "PAID_DISPATCH_DISABLED", detail: "'gpt-4.1-mini-2025-04-14' is a paid model and paid dispatch is disabled", retryable: false, retryAfter: null } } }) });
  await r.run();
  assert.equal(r.store.finished.to, "FAILED");
  assert.equal(r.store.finished.errorCode, "PAID_DISPATCH_DISABLED");
  assert.match(r.store.finished.error, /paid dispatch is disabled/);
});

test("an unreachable extraction service leaves the job RUNNING; the next round resumes from the archived pages without scraping again", async () => {
  let up = false;
  const r = await rig({ job: { request: REQ }, core: (b) => page(b.url, "Price: 1"), extract: (body) => { if (!up) throw new ExtractorError("connect ECONNREFUSED", { code: "ECONNREFUSED", delivered: false }); return ok(body); } });
  await r.run();
  assert.equal(r.store.job.state, "RUNNING");
  assert.equal(r.calls.scrape.length, 2);
  up = true;
  await r.run();
  assert.equal(r.store.finished.to, "SUCCEEDED");
  assert.equal(r.calls.scrape.length, 2, "the pages came from the archive the second time");
  assert.equal(r.calls.extract.length, 2);
});

test("a job past its deadline is closed FAILED without any work", async () => {
  const r = await rig({ job: { request: REQ, overdueAtClaim: true }, core: () => { throw new Error("no scrape expected"); }, extract: ok });
  await r.run();
  assert.equal(r.store.finished.errorCode, "JOB_DEADLINE_EXCEEDED");
  assert.equal(r.calls.scrape.length, 0);
});

test("a page whose target answered an error is a named page failure, not text to extract from", async () => {
  const r = await rig({ job: { request: REQ }, core: (b) => (b.url.endsWith("/2") ? { status: 200, json: { success: true, data: { markdown: "not found", metadata: { url: b.url, statusCode: 404 } } } } : page(b.url, "Price: 1")), extract: ok });
  await r.run();
  assert.equal(r.store.finished.to, "PARTIAL");
  assert.deepEqual(r.store.finished.errors.errors.map((e) => [e.url, e.code]), [["https://a.example/2", "TARGET_HTTP_404"]]);
  assert.deepEqual(r.calls.extract[0].documents.map((d) => d.url), ["https://a.example/1"]);
});

test("a page's markdown is cut to the extraction limit as it lands, archived and sent cut, and the cut is said (review W4)", async () => {
  const big = `Price: 1\n${"x".repeat(3 * 1048576)}`;
  const r = await rig({ job: { request: REQ }, core: (b) => page(b.url, big), extract: ok });
  await r.run();
  assert.equal(r.store.finished.to, "SUCCEEDED");
  for (const d of r.calls.extract[0].documents) assert.equal(Buffer.byteLength(d.markdown), 1048576);
  const src = r.store.docs.find((d) => d.docKey === "source:0");
  assert.ok(src.bytes < 1.1 * 1048576, "the archive holds the cut page");
  const result = JSON.parse((await r.archive.read(r.store.docs.find((d) => d.docKey === "result").sha256)).toString());
  assert.equal(result.warnings.filter((w) => /cut at 1048576 bytes/.test(w)).length, 2);
});
