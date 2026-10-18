// SI2's deterministic pieces (docs/FIRECRAWL_PI_SEARCH_INTELLIGENCE_SPEC.md §6, §7, §13): Ref's answer parsing, Context7's
// scope planning, Jev's batching, answer validation and envelope checks, and documentation activation's deterministic rules.
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseRefSearch, parseRefRead, refQuery, NO_RESULTS } from "../src/search-intelligence/adapters/ref.mjs";
import { context7Scopes } from "../src/search-intelligence/adapters/context7.mjs";
import { makeBatches, checkAnswer, checkEnvelope, excerptOf, RELEVANCE_LEVELS, SOURCE_KINDS } from "../src/search-intelligence/decisions.mjs";
import { analyzeQuery, makeDocumentation } from "../src/search-intelligence/documentation.mjs";
import { validateSearchRequest } from "../src/search-intelligence/contracts.mjs";
import { request } from "./si-helpers.mjs";

const text = (...t) => ({ content: t.map((x) => ({ type: "text", text: x })) });

test("Ref: legacy result blocks are hits; the exact no-results sentinel is empty; error texts and unknown text are never hits or empties", () => {
  const ok = parseRefSearch(text("overview: How to stream\nurl: https://docs.example.com/stream#part\nmoduleId: example/docs", "overview: Second\nurl: https://docs.example.com/b\nmoduleId: "));
  assert.deepEqual(ok, { kind: "results", docs: [{ url: "https://docs.example.com/stream#part", overview: "How to stream", moduleId: "example/docs" }, { url: "https://docs.example.com/b", overview: "Second", moduleId: "" }] });
  assert.deepEqual(parseRefSearch(text(NO_RESULTS)), { kind: "empty" });
  assert.equal(parseRefSearch(text("No results found.")).kind, "contract", "only the exact sentinel is empty");
  assert.deepEqual(parseRefSearch(text("Please verify your email at https://ref.tools/dashboard to search documentation")), { kind: "error", reason: "auth_failed", detail: "ref_auth_text" });
  // An error naming a URL is an error, not a hit.
  assert.equal(parseRefSearch(text("Error during documentation search: overview: x\nurl: https://evil.example/\nmoduleId: y")).kind, "error");
  assert.equal(parseRefSearch(text("Some new hosted format we do not know")).kind, "contract");
  assert.equal(parseRefSearch({ isError: true, content: [{ type: "text", text: "boom" }] }).kind, "error");
  assert.equal(parseRefSearch({ structuredContent: { results: [{ url: "https://x.example" }] } }).kind, "contract", "no invented JSON envelope");
  assert.equal(parseRefSearch(text("overview: bad\nurl: javascript:alert(1)\nmoduleId: x")).kind, "contract");
  assert.deepEqual(parseRefRead(text("page excerpt"), 4), { kind: "text", text: "page", truncated: true });
  assert.equal(parseRefRead(text("Error reading URL: 404"), 100).kind, "error");
});

test("Ref: documentation that quotes refusal phrases is a result or a page, never a refusal of this account", () => {
  const hit = (overview) => parseRefSearch(text(`overview: ${overview}\nurl: https://docs.example.com/a\nmoduleId: m`));
  for (const o of ["Handling 401 Unauthorized responses with interceptors", "Stripe returns an error when an invalid API key is used", "Twilio: insufficient credits error 20003",
    "Please verify your email before signing in (Supabase auth)"]) assert.equal(hit(o).kind, "results", o);
  for (const page of ["The request is rejected as Unauthorized (401) when the token expires.", "Setup\n\nPlease verify your email at https://ref.tools/dashboard to read URLs is shown to unverified users.",
    "Billing\n\nInsufficient credits: top up from the dashboard.", "Unauthorized\n\nThis page explains the 401 status.", "Error: this guide covers error handling."])
    assert.equal(parseRefRead(text(page), 4000).kind, "text", page.slice(0, 40));
  // Ref's own refusals, as whole leading messages, still count.
  assert.equal(parseRefRead(text("Please verify your email at https://ref.tools/dashboard to read URLs"), 100).reason, "auth_failed");
  assert.equal(parseRefSearch(text("Ref is not correctly configured. Reach out to hello@ref.tools for help.")).reason, "auth_failed");
});

test("Ref's query carries the caller's library, version and language hints that the query lacks", () => {
  const r = validateSearchRequest(request({ originalQuery: "how do async components work", intelligence: { documentation: "required", libraries: [{ name: "vue", version: "3.5" }], programmingLanguage: "typescript" } }));
  assert.equal(refQuery(r), "how do async components work vue 3.5 typescript");
  assert.equal(refQuery(validateSearchRequest(request({ originalQuery: "Vue 3.5 async", intelligence: { documentation: "auto", libraries: [{ name: "vue", version: "3.5" }] } }))), "Vue 3.5 async");
});

test("Context7 scopes: one strict request per library with a version, one shared request for the rest, unrepresentable versions refused", () => {
  const s = context7Scopes(validateSearchRequest(request({ intelligence: { documentation: "required", libraries: [{ name: "next.js", version: "15" }, { name: "react", version: "19.1" }, { name: "zod" }, { name: "vue", version: "3.x" }] } })));
  assert.deepEqual(s.map((x) => [x.libraries, x.version, x.representable]), [[["next.js"], "15", true], [["react"], "19.1", true], [["vue"], "3.x", false], [["zod"], null, true]]);
  assert.equal(new Set(s.map((x) => x.key)).size, 4);
  assert.deepEqual(context7Scopes(validateSearchRequest(request({ intelligence: { documentation: "required" } }))).map((x) => [x.libraries, x.version]), [[[], null]]);
});

const doc = (i, provider, extra = {}) => ({ documentId: `d${String(i).padStart(3, "0")}`, canonicalUrl: `https://site${i}.example/page`, title: `Title ${i}`, description: "d".repeat(400), passages: [], snippets: [],
  observations: [{ provider, rank: i + 1 }], ...extra });

test("Jev batches: at most eight candidates and 24,000 serialized bytes each, fair across providers, ids bound in every instruction", () => {
  const r = validateSearchRequest(request({ originalQuery: "how to cancel a tokio task" }));
  const docs = [...Array.from({ length: 12 }, (_, i) => doc(i, "serper")), ...Array.from({ length: 4 }, (_, i) => doc(100 + i, "exa", { description: "é".repeat(1400) }))];
  const batches = makeBatches(docs, r, { maxCandidates: 8, maxBytes: 24000 });
  for (const b of batches) {
    assert.ok(b.docs.length <= 8);
    assert.ok(Buffer.byteLength(JSON.stringify(b.body)) <= 24000, `batch of ${Buffer.byteLength(JSON.stringify(b.body))} bytes`);
    for (const { id } of b.docs) for (const k of ["relevance", "directness", "evidence", "source_kind"]) assert.match(b.body.questions[`${id}_${k}`].instructions, new RegExp(`candidates\\.${id}\\b`));
    assert.equal(b.body.model, "typesafe/jev-1.14");
    assert.ok(!JSON.stringify(b.body.state).includes("serper") && !JSON.stringify(b.body.state).includes("rank"), "no provider name or rank in the state");
  }
  assert.equal(batches.reduce((n, b) => n + b.docs.length, 0), 16);
  assert.ok(batches[0].docs.some(({ d }) => d.observations[0].provider === "exa"), "the first batch is not all one provider's");
  // A candidate too large alone is shortened, and that is recorded.
  const huge = [doc(1, "brave", { title: "t", description: "x".repeat(200000) })];
  const hb = makeBatches(huge, r, { maxCandidates: 8, maxBytes: 6000 });
  assert.equal(hb[0].docs.length, 1);
  assert.equal(hb[0].docs[0].truncated, true);
  assert.equal(excerptOf({ description: "abc", snippets: ["def"], passages: [{ text: "ghi" }] }, 5).text, "abc\nd");
});

test("Jev answers: types, ranges and offered labels are checked; zero is a valid answer; optional metadata may be absent", () => {
  const score = { type: "score", criteria: RELEVANCE_LEVELS }, noul = { type: "noul" }, choice = { type: "choice", criteria: SOURCE_KINDS };
  assert.deepEqual(checkAnswer(score, { type: "score", score: 0 }), { score: 0, confidence: null, probabilities: null });
  assert.deepEqual(checkAnswer(score, { type: "score", score: 3.6, confidence: 0.67, probabilities: { 0: 0, 1: 0, 2: 0.05, 3: 0.3, 4: 0.65 } }).score, 3.6);
  assert.equal(checkAnswer(score, { type: "score", score: 4.2 }), null);
  assert.equal(checkAnswer(score, { type: "score", score: 2, probabilities: { 5: 0.1 } }), null);
  assert.equal(checkAnswer(score, { type: "noul", noul: 0.5 }), null);
  assert.deepEqual(checkAnswer(noul, { type: "noul", noul: 0 }), { noul: 0 });
  assert.equal(checkAnswer(noul, { type: "noul", noul: 1.2 }), null);
  assert.equal(checkAnswer(noul, { type: "noul", noul: Number.NaN }), null);
  assert.equal(checkAnswer(choice, { type: "choice", choice: "official_docs" }).choice, "official_docs");
  assert.equal(checkAnswer(choice, { type: "choice", choice: "trusted" }), null, "a label not offered is invalid");
  assert.equal(checkAnswer(choice, { type: "choice", choice: "independent", probabilities: { surprise: 0.2 } }), null);
});

test("Jev envelopes: the requested release's builds pass; another model, a missing usage or a bad cost invalidates the batch", () => {
  const usage = { input_tokens: 800, output_tokens: 80 };
  assert.ok(checkEnvelope({ model: "typesafe/jev-1.14", answers: {}, usage }).ok);
  assert.ok(checkEnvelope({ model: "typesafe/jev-1.14-20261014", answers: {}, usage: { ...usage, cost: 0.0000336 } }).ok);
  assert.ok(checkEnvelope({ model: "jev-1.14-20261014", answers: {}, usage }).ok);
  assert.equal(checkEnvelope({ model: "typesafe/jev-1.15", answers: {}, usage }).why, "model_mismatch");
  assert.equal(checkEnvelope({ model: "typesafe/jev-1.140", answers: {}, usage }).why, "model_mismatch");
  assert.equal(checkEnvelope({ model: "typesafe/jev-1.14", answers: {} }).why, "usage");
  assert.equal(checkEnvelope({ model: "typesafe/jev-1.14", answers: {}, usage: { ...usage, cost: -1 } }).why, "usage_cost");
  assert.equal(checkEnvelope({ model: "typesafe/jev-1.14", answers: [], usage }).why, "envelope");
});

test("documentation activation: explicit modes, deterministic signals, the spec's examples, and the classifier's fallback", async () => {
  assert.equal(analyzeQuery("React to this poem").decision, "none");
  assert.equal(analyzeQuery("React 19 use() migration").decision, "positive");
  assert.equal(analyzeQuery("Where is the requests timeout configured?").decision, "positive");
  assert.equal(analyzeQuery("```py\nraise ValueError\n``` why does this fail").decision, "positive");
  assert.equal(analyzeQuery("best hiking trails in Utah").decision, "none");
  assert.equal(analyzeQuery("latest news about OpenAI").decision, "weak");
  const docs = makeDocumentation({ decisions: { classifyDocs: async () => ({ ok: true, probability: 0.21, model: "typesafe/jev-1.14" }) } });
  const ctx = { signal: new AbortController().signal, deadlineAt: Date.now() + 800, selection: "fixture", decisionSubject: "fcpi-fixture-jev" };
  const act = (q, si = { documentation: "auto" }) => docs.activate(validateSearchRequest(request({ originalQuery: q, intelligence: si })), ctx);
  assert.deepEqual([(await act("hiking", { documentation: "off" })).active, (await act("hiking", { documentation: "off" })).reason], [false, "explicit_off"]);
  assert.equal((await act("hiking", { documentation: "required" })).reason, "explicit_required");
  assert.equal((await act("hiking", { documentation: "auto", libraries: [{ name: "vue" }] })).reason, "explicit_libraries");
  assert.equal((await act("vue api reference for defineProps")).reason, "explicit_docs_request");
  assert.equal((await act("best hiking trails in Utah")).active, false);
  const weak = await act("latest news about OpenAI");
  assert.deepEqual([weak.active, weak.reason, weak.uncertainty], [true, "classifier_positive", 0.21]);
  const low = makeDocumentation({ decisions: { classifyDocs: async () => ({ ok: true, probability: 0.19 }) } });
  assert.equal((await low.activate(validateSearchRequest(request({ originalQuery: "latest news about OpenAI", intelligence: { documentation: "auto" } })), ctx)).active, false);
  const down = makeDocumentation({ decisions: { classifyDocs: async () => ({ ok: false, reason: "timeout" }) } });
  const fb = await down.activate(validateSearchRequest(request({ originalQuery: "latest news about OpenAI", intelligence: { documentation: "auto" } })), ctx);
  assert.deepEqual([fb.active, fb.reason], [true, "classifier_timeout_possibly_technical"]);
});
