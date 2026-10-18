// Evidence advice on pages already acquired (docs/FIRECRAWL_PI_SEARCH_INTELLIGENCE_SPEC.md §12): the hook's payload bounds,
// exact passages at their offsets in the rendition, the deterministic fallback, Jev's advisory signals within its batch bounds,
// and large multi-byte text accepted up to the byte limit and refused one byte past it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID, createHash } from "node:crypto";
import { harness } from "./si-helpers.mjs";
import { makeEvidence, validateEvidencePayload } from "../src/search-intelligence/evidence.mjs";

const sha = (s) => createHash("sha256").update(s).digest("hex");
const docId = (i) => createHash("sha256").update(`doc${i}`).digest("hex").slice(0, 24);
// A document as the core sends it: windows that are exact substrings of the rendition at their UTF-16 offsets.
function doc(i, text, windows = [[0, text.length]]) {
  return { documentId: docId(i), url: `https://site${i}.example.org/page`, sourceUrl: `https://site${i}.example.org/page`, contentSha256: sha(text), totalLength: text.length, basis: "markdown",
    windows: windows.map(([start, end]) => ({ start, end, text: text.slice(start, end) })), droppedBytes: 0, droppedWindows: 0 };
}
const payload = (documents, over = {}) => ({ schema: "fcpi.search-evidence/v1", requestId: `req-${randomUUID()}`, logicalSearchId: randomUUID(), principalId: "test-principal",
  originalQuery: "vite proxy timeout option", intelligence: { documentation: "auto", evidence: "auto" }, absoluteDeadlineMs: Date.now() + 20000, documents, ...over });
const PAGE = "# Server options\n\nVite is a build tool for the web.\n\n## server.proxy\n\nThe proxy option forwards requests; set timeout in milliseconds to bound each proxied request.\n\nUnrelated paragraph about logos and colour themes for the site.";
const run = (h, raw, over = {}) => makeEvidence({ decisions: h.decisions, limits: () => h.policy.search.intelligence })
  .evaluate(raw, { signal: new AbortController().signal, selection: "fixture", decisionSubject: "fcpi-fixture-jev", ...over });
const jev = (fn) => (q, entry) => {
  const answers = {};
  for (const [key, question] of Object.entries(entry.body.questions)) answers[key] = { type: "noul", noul: fn(key, entry.body.state) };
  return { status: 200, body: { model: "typesafe/jev-1.14-20261001", answers, usage: { input_tokens: 50, output_tokens: 5 } } };
};

test("the hook refuses what the core would never send: a window off its offsets, too many documents, a wrong schema", async () => {
  const L = (await import("./si-helpers.mjs")).egress.search.intelligence.evidence;
  const good = payload([doc(1, PAGE)]);
  assert.equal(validateEvidencePayload(good, L), good);
  // A window whose text is not the rendition's text between its offsets (one unit short).
  const offset = { ...doc(1, PAGE), windows: [{ start: 0, end: 10, text: PAGE.slice(0, 9) }] };
  assert.throws(() => validateEvidencePayload(payload([offset]), L), /offsets do not match/);
  assert.throws(() => validateEvidencePayload(payload(Array.from({ length: 11 }, (_, i) => doc(i, PAGE))), L), /at most 10/);
  assert.throws(() => validateEvidencePayload({ ...good, schema: "other" }, L), /schema/);
  assert.throws(() => validateEvidencePayload(payload([{ ...doc(1, PAGE), documentId: "not-an-id" }]), L), /documentId/);
  assert.throws(() => validateEvidencePayload(payload([doc(1, PAGE, [[40, 60], [10, 50]])]), L), /offsets do not match/, "overlapping or unordered windows are refused");
});

test("large multi-byte evidence is accepted up to the byte bounds and refused one byte past them", async () => {
  const L = (await import("./si-helpers.mjs")).egress.search.intelligence.evidence;
  // "界" is three UTF-8 bytes and one UTF-16 unit; "😀" four bytes and two units: offsets stay UTF-16, bounds stay bytes.
  const full = (i) => doc(i, "界".repeat(L.maxDocumentBytes / 3));
  const docs = Array.from({ length: L.maxDocuments }, (_, i) => full(i));
  const bytesOf = (d) => d.windows.reduce((n, w) => n + Buffer.byteLength(w.text), 0);
  assert.ok(docs.every((d) => bytesOf(d) === L.maxDocumentBytes), "each document holds exactly its bound");
  assert.ok(docs[0].totalLength === L.maxDocumentBytes / 3, "while its offsets count a third as many UTF-16 units");
  const p = payload(docs);
  assert.ok(Buffer.byteLength(JSON.stringify(p)) <= L.maxBodyBytes, "ten full documents still fit the 768 KiB body");
  assert.equal(validateEvidencePayload(p, L), p);
  const emoji = doc(1, "😀 vite proxy timeout 😀");
  assert.equal(emoji.windows[0].end, emoji.totalLength, "a surrogate pair counts two UTF-16 units");
  assert.equal(validateEvidencePayload(payload([emoji]), L).documents[0].windows[0].text, "😀 vite proxy timeout 😀");
  const over = doc(1, "界".repeat(L.maxDocumentBytes / 3) + "a");
  assert.throws(() => validateEvidencePayload(payload([over]), L), /more than 49152 bytes/, "one byte past the document bound is refused");
});

test("without Jev the passages are exact substrings at their offsets, labelled deterministic_fallback, in the documents' order", async () => {
  const h = await harness();
  try {
    const p = payload([doc(1, PAGE), doc(2, "Nothing here mentions the subject at all, only unrelated material about gardening.")]);
    const r = await run(h, p);
    assert.deepEqual([r.mode, r.reason], ["deterministic_fallback", "jev_not_configured"]);
    assert.deepEqual(r.documents.map((d) => d.documentId), [docId(1), docId(2)], "the selected-result order is kept");
    const ev = r.documents[0].evidence;
    assert.ok(ev.passages.length > 0 && ev.passages.length <= 6);
    for (const s of ev.passages) assert.equal(PAGE.slice(s.start, s.end).startsWith(s.text.slice(0, 50)), true, "each passage is the rendition's own text at its offsets");
    assert.ok(ev.passages.some((s) => /set timeout in milliseconds/.test(s.text)), "the passage matching the query's terms is chosen");
    assert.ok(ev.passages.every((s) => s.status === "not_observable"));
    assert.equal(ev.adequacy, "not_observable", "without advice nothing is claimed about adequacy");
    assert.equal(ev.contentSha256, sha(PAGE));
  } finally { await h.close(); }
});

test("Jev's signals mark passages relevant or insufficient, within its batch bounds, and never as statements of truth", async () => {
  const h = await harness({ handlers: { openrouter: jev((key, state) => (/timeout in milliseconds/.test(state.passages[key.split("_")[0]] ?? "") ? 0.9 : 0.1)) } });
  try {
    const r = await run(h, payload([doc(1, PAGE), doc(2, "Gardening notes about tomatoes and soil, at length, with nothing about build tools.")]));
    assert.equal(r.mode, "jev");
    const [a, b] = r.documents.map((d) => d.evidence);
    assert.equal(a.adequacy, "appears_relevant");
    assert.equal(b.adequacy, "appears_insufficient", "acquired but without relevant evidence: a semantic limitation, not a failed acquisition");
    assert.equal(a.evidenceRank, 1);
    assert.equal(b.evidenceRank, 2, "assessed documents are ranked; the insufficient one comes after");
    assert.equal(a.model, "typesafe/jev-1.14-20261001");
    for (const e of h.servers.openrouter.seen) {
      assert.ok(Buffer.byteLength(JSON.stringify(e.body)) <= 24000);
      assert.ok(Object.keys(e.body.state.passages).length <= 8);
      assert.equal(e.body.model, "typesafe/jev-1.14");
      for (const q of Object.values(e.body.questions)) assert.ok(!q.instructions.includes("tomatoes"), "passage text is state, never an instruction");
    }
  } finally { await h.close(); }
});

test("a Jev failure keeps every deterministic passage and says why; nothing becomes an acquisition failure", async () => {
  const h = await harness({ handlers: { openrouter: () => ({ status: 503, body: { error: { code: 503, message: "unavailable" } } }) } });
  try {
    const r = await run(h, payload([doc(1, PAGE)]));
    assert.equal(r.mode, "deterministic_fallback");
    assert.match(r.reason, /^jev_/);
    assert.ok(r.documents[0].evidence.passages.length > 0);
    assert.notEqual(r.documents[0].evidence.adequacy, "acquisition_failed");
  } finally { await h.close(); }
});

test("an evidence call is recorded with its timing", async () => {
  const h = await harness({ telemetry: true, handlers: { openrouter: jev(() => 0.9) } });
  try {
    const raw = payload([doc(1, PAGE)]);
    const r = await h.coordinator.evaluateEvidence(raw, { signal: new AbortController().signal });
    assert.equal(r.status, 200);
    await h.telemetry.drain(2000);
    const e = h.store.events.find((x) => x.type === "evidence" && x.logicalId === raw.logicalSearchId);
    assert.ok(e, "the evidence call is an event");
    assert.ok(Number.isInteger(e.durationMs) && e.durationMs >= 0 && e.startedAt instanceof Date, "with when it started and how long it took");
  } finally { await h.close(); }
});

test("a Jev slower than the core's evidence budget still answers deterministic passages before the core gives up", async () => {
  const slowJev = (q, entry) => new Promise((r) => setTimeout(() => r(jev(() => 0.9)(q, entry)), 4000));
  const h = await harness({ handlers: { openrouter: slowJev } });
  try {
    const t0 = Date.now(), coreGivesUpAt = t0 + 1500;
    const r = await run(h, payload([doc(1, PAGE)], { evidenceDeadlineMs: coreGivesUpAt }));
    assert.ok(Date.now() < coreGivesUpAt, `answered at ${Date.now() - t0} ms, before the core's ${coreGivesUpAt - t0} ms`);
    assert.equal(r.mode, "deterministic_fallback", "the passages are the deterministic ones, not an unavailable evidence call");
    assert.ok(r.documents[0].evidence.passages.length > 0);
    assert.throws(() => validateEvidencePayload(payload([doc(1, PAGE)], { evidenceDeadlineMs: Date.now() + 200000 }), h.policy.search.intelligence.evidence), /evidenceDeadlineMs/);
  } finally { await h.close(); }
});
