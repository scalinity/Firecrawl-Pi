// SI3's native chain (docs/FIRECRAWL_PI_SEARCH_INTELLIGENCE_SPEC.md §19.2, §12, §14): the patched core's compiled search code,
// from the image built with patch 0011, against the real retrieval coordinator on fixture providers, both in one throwaway
// container on loopback. Run by scripts/si3/native-chain.sh; prints one JSON record of every check, and exits nonzero when one
// fails. No live provider is reachable from the container (it has no network), so fixture selection is the only one possible.
// Besides fcpi.js's own exports it runs the compiled upstream call sites the patch changes that load without the core's
// services (the scrape merge and the strict request schema); the controller's header parsing and executeSearch run only in
// the full core, which this chain does not start.
import http from "node:http";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { randomUUID, randomBytes, createHash } from "node:crypto";
import { harness, refFixture } from "./test/si-helpers.mjs";
import { makeEvidence } from "./src/search-intelligence/evidence.mjs";
import { queryTerms as retrievalTerms } from "./src/search-intelligence/rank.mjs";
import { STATUS, failureOf } from "./src/failures.mjs";

const PORT = 3310;
const TOKEN = randomBytes(24).toString("hex");
// The core's config is read when its module loads: the retrieval route and its credential first.
process.env.PI_RETRIEVAL_URL = `http://127.0.0.1:${PORT}`;
process.env.PI_RETRIEVAL_TOKEN = TOKEN;
const core = createRequire("/app/")("/app/dist/src/search/fcpi.js");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const checks = [];
const check = (id, ok, detail = {}) => { checks.push({ id, result: ok ? "PASS" : "FAIL", ...detail }); };
const hex16 = () => randomBytes(8).toString("hex");

// Fixture answers: Exa slow enough, with Jev after it, that one search runs past fifteen seconds within its deadline.
let exaDelay = 0, jevDelay = 0;
const exa = async () => { await sleep(exaDelay); return { status: 200, body: { requestId: "exa-chain", results: [1, 2, 3].map((i) => ({ id: `e${i}`, title: `Exa chain ${i}`, url: `https://exa.example.org/chain/${i}`, highlights: ["chain highlight"] })), costDollars: { total: 0.005 } } }; };
const openrouter = async (q, entry) => {
  await sleep(jevDelay);
  const answers = {};
  for (const [key, question] of Object.entries(entry.body.questions)) answers[key] = question.type === "score" ? { type: "score", score: 3 } : question.type === "noul" ? { type: "noul", noul: 0.8 } : { type: "choice", choice: Object.keys(question.criteria)[0] };
  return { status: 200, body: { model: "typesafe/jev-1.14-20261001", answers, usage: { input_tokens: 100, output_tokens: 10 } } };
};
// Context7: a snippet with a real source URL and one without (its pageId is no URL), which must reach the core whole.
const context7 = () => ({ status: 200, body: {
  codeSnippets: [{ libraryId: "/vuejs/docs", codeTitle: "Declaring reactive state", codeDescription: "Use ref().", codeLanguage: "javascript", codeList: [{ language: "javascript", code: "const n = ref(0)" }],
    codeId: "https://vuejs.org/guide/essentials/reactivity-fundamentals.html", pageTitle: "Reactivity Fundamentals" }],
  infoSnippets: [{ libraryId: "/vuejs/docs", content: "Watchers run after the component updates by default.", pageId: "vue-docs:watchers" }] } });

const h = await harness({ handlers: { exa, openrouter, context7, ref: refFixture() } });
const evidence = makeEvidence({ decisions: h.decisions, limits: () => h.policy.search.intelligence });
const fixtures = () => Object.values(h.servers);

// The retrieval routes the core calls, behind the core's bearer credential, as server.mjs serves them and with its failure
// table. A few queries ask for an answer the real routes give only in failure: an untyped 401, a stalled body, a refusal.
const readJson = async (req) => { let t = ""; for await (const c of req) t += c; return JSON.parse(t); };
const send = (res, status, body) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(body)); };
let lastEvidencePayload = null;
const server = http.createServer(async (req, res) => {
  try {
    if (req.headers.authorization !== `Bearer ${TOKEN}`) return send(res, 401, { error: "unauthorized" });
    const ac = new AbortController();
    res.on("close", () => { if (!res.writableEnded) ac.abort(); });
    if (req.url === "/internal/search") {
      const body = await readJson(req);
      if (body.originalQuery === "answer untyped 401") return send(res, 401, { error: "unauthorized" });
      if (body.originalQuery === "stall the body") { res.writeHead(200, { "content-type": "application/json" }); res.write("{\"web\":["); return; }
      const r = await h.coordinator.search(body, { signal: ac.signal });
      return send(res, r.status, r.body);
    }
    if (req.url === "/internal/search/evidence") {
      const body = await readJson(req);
      lastEvidencePayload = body;
      if (body.originalQuery === "refuse evidence") return send(res, 400, { failure: { class: "INVALID_REQUEST", detail: "refused" } });
      return send(res, 200, await evidence.evaluate(body, { signal: ac.signal, selection: "fixture", decisionSubject: "fcpi-fixture-jev" }));
    }
    return send(res, 404, { error: "not_found" });
  } catch (e) { return send(res, STATUS[e.failureClass] ?? 502, failureOf(e)); }
});
await new Promise((r) => server.listen(PORT, "127.0.0.1", r));

// The core's own context, from the headers the gateway builds (a complete, well-formed set), and its search call.
const trustedHeaders = (deadlineHeader) => ({ "x-fcpi-search-request-id": `req-${randomUUID()}`, "x-fcpi-search-id": randomUUID(), "x-fcpi-search-owner": hex16(), "x-fcpi-search-deadline-ms": deadlineHeader });
const contextFor = (body, deadlineMs, signal = new AbortController().signal) => core.fcpiSearchContext(trustedHeaders(String(Date.now() + deadlineMs)), body, `job-${randomUUID()}`, signal);
const failureOfCall = async (p) => { try { await p; return null; } catch (e) { return e.failureClass ?? e.name; } };
const timed = (fn) => { const t0 = process.hrtime.bigint(); const out = fn(); return { out, ms: Number(process.hrtime.bigint() - t0) / 1e6 }; };

try {
  // 1. A native aggregate search past the old fifteen-second ceiling, within its own deadline.
  exaDelay = 9500; jevDelay = 6500;
  const ctx = contextFor({ query: "vue reactivity ref", limit: 5, searchIntelligence: { documentation: "required" } }, 30000);
  check("trusted_context", ctx.principalId !== "legacy-internal" && /^req-/.test(ctx.requestId) && ctx.intelligence.documentation === "required", { principalId: ctx.principalId.length });
  let t0 = Date.now(), long = null, error = null;
  try { long = await core.piIntelligentSearch(ctx); } catch (e) { error = { code: e.code ?? e.name, message: String(e.message).slice(0, 200) }; }
  const longMs = Date.now() - t0;
  check("long_search_succeeds_past_15s", !!long && longMs > 15000 && longMs < 30000, { elapsedMs: longMs, error });
  if (long) {
    const s = long.fcpiSearch;
    check("long_search_all_engines_dispatched", ["serper", "brave", "exa", "deepseek", "tavily"].every((p) => h.servers[p].seen.length >= 1), { dispatched: Object.fromEntries(["serper", "brave", "exa", "deepseek", "tavily"].map((p) => [p, h.servers[p].seen.length])) });
    // Jev advice blended in, whole or for part of the shortlist: at 6.5 s an answer, two requests a search, the semantic budget
    // of 8 s may not cover a third round, and those candidates keep their deterministic order (spec §11.2).
    check("long_search_ranked_by_jev", ["hybrid", "hybrid_partial"].includes(s.ranking.mode) && s.ranking.scored > 0, { ranking: s.ranking.mode, reason: s.ranking.reason, scored: s.ranking.scored, shortlisted: s.ranking.shortlisted });
    check("rows_carry_fcpi_search", long.web.length > 0 && long.web.every((w) => w.fcpi?.search?.documentId), { rows: long.web.length });
    const aux = (s.documentation?.auxiliaryContext ?? []).find((a) => a.provider === "context7");
    check("sourceless_context7_snippet_reaches_core", !!aux && aux.sourceUrl === null && aux.sourceIdentifier === "vue-docs:watchers" && /Watchers run after/.test(aux.text), { found: !!aux });
    check("documentation_both_lanes", s.coverage.documentation.requested === 2 && s.providers.context7?.status === "success_results" && s.providers.ref?.status === "success_results",
      { context7: s.providers.context7?.status, ref: s.providers.ref?.status });
  }

  // 2. A shorter deadline: the answer comes before it, partial, and no provider is asked anything after it.
  exaDelay = 9500; jevDelay = 0;
  const before = new Map(fixtures().map((f) => [f.name, f.seen.length]));
  const shortCtx = contextFor({ query: "short deadline search", limit: 5 }, 4000);
  t0 = Date.now();
  let short = null, shortError = null;
  try { short = await core.piIntelligentSearch(shortCtx); } catch (e) { shortError = { code: e.code ?? e.name, message: String(e.message).slice(0, 200) }; }
  const shortMs = Date.now() - t0, deadline = shortCtx.absoluteDeadlineMs;
  check("short_search_answers_by_its_deadline", !!short && Date.now() <= deadline + 250 && short.fcpiSearch.outcome === "partial", { elapsedMs: shortMs, outcome: short?.fcpiSearch?.outcome, error: shortError });
  check("short_search_positive_send_control", fixtures().filter((f) => ["serper", "brave", "exa", "deepseek", "tavily"].includes(f.name)).every((f) => f.seen.length > before.get(f.name)), {});
  await sleep(Math.max(0, deadline - Date.now()) + 6000);
  const late = fixtures().flatMap((f) => f.seen.slice(before.get(f.name)).filter((e) => e.at > deadline).map((e) => ({ provider: f.name, msAfter: e.at - deadline })));
  check("short_search_zero_late_sends", late.length === 0, { late });

  // 3. Untrusted or incomplete headers are a legacy internal search with local correlation, never a fabricated user.
  const legacy = core.fcpiSearchContext({ "x-fcpi-search-id": randomUUID(), "x-fcpi-search-owner": "not-hex" }, { query: "x" }, `job-${randomUUID()}`, new AbortController().signal);
  check("incomplete_trusted_headers_are_legacy", legacy.principalId === "legacy-internal" && /^core-job-/.test(legacy.requestId), {});

  // 4. The scrape merge keeps both namespaces: the scraped document's own fcpi and the result's search metadata.
  const row = long?.web?.[0] ?? { url: "https://x.example/", title: "x", description: "", fcpi: { search: { documentId: "a".repeat(24) } } };
  const merged = core.mergeWithFcpi(row, { url: row.url, markdown: "# Page", metadata: { statusCode: 200 }, fcpi: { retrieval: { route: "direct" } } });
  check("scrape_merge_keeps_both_namespaces", merged.fcpi?.search?.documentId === row.fcpi.search.documentId && merged.fcpi?.retrieval?.route === "direct" && merged.markdown === "# Page", {});

  // 5. Evidence on acquired pages, through the core's payload builder and the real evaluation: large multi-byte pages
  //    are cut to the bounds, every window is the rendition's own text at its offsets, and each row gets its advice.
  const page = (i) => `# 文書 ${i}\n\n` + Array.from({ length: 400 }, (_, k) => `段落 ${k}: vue reactivity ref の説明と例 ${"界".repeat(40)} 😀`).join("\n\n");
  const rows = (long?.web ?? []).slice(0, 2).map((w, i) => core.mergeWithFcpi(w, { url: w.url, markdown: page(i), metadata: { statusCode: 200, sourceURL: w.url } }));
  const evCtx = contextFor({ query: "vue reactivity ref", limit: 5, scrapeOptions: { formats: ["markdown"] } }, 20000);
  const payload = core.evidencePayload(evCtx, rows, Date.now() + 4000);
  const bytes = Buffer.byteLength(JSON.stringify(payload));
  const exact = payload.documents.every((d, i) => d.windows.every((w) => page(i).slice(w.start, w.end) === w.text) && d.contentSha256 === createHash("sha256").update(page(i)).digest("hex"));
  const perDoc = payload.documents.map((d) => d.windows.reduce((n, w) => n + Buffer.byteLength(w.text), 0));
  check("evidence_payload_windows_bounded_and_exact", payload.documents.length === rows.length && perDoc.every((b) => b <= 49152) && payload.documents.every((d) => d.windows.length <= 48) && exact,
    { bodyBytes: bytes, perDocBytes: perDoc, windows: payload.documents.map((d) => d.windows.length), exact });
  const response = { web: rows };
  await core.attachFcpiEvidence(evCtx, response);
  const modes = response.web.map((w) => w.fcpi?.search?.evidence?.mode ?? null);
  check("evidence_annotates_acquired_rows", modes.length > 0 && modes.every((m) => m === "jev" || m === "jev_partial"), { modes });
  check("evidence_payload_carries_the_core_deadline", Number.isFinite(lastEvidencePayload?.evidenceDeadlineMs) && lastEvidencePayload.evidenceDeadlineMs <= evCtx.absoluteDeadlineMs - 250,
    { headroomMs: lastEvidencePayload ? evCtx.absoluteDeadlineMs - lastEvidencePayload.evidenceDeadlineMs : null });
  const off = { web: rows.map((r) => ({ ...r, fcpi: { search: { ...r.fcpi.search, evidence: undefined } } })) };
  await core.attachFcpiEvidence({ ...evCtx, intelligence: { ...evCtx.intelligence, evidence: "off" } }, off);
  check("evidence_off_evaluates_nothing", off.web.every((w) => w.fcpi.search.evidence === undefined), {});

  // 6. The evidence call's other ends: a refusal, a cancellation, no time left, and a row whose acquisition failed.
  const fresh = () => rows.map((r) => ({ ...r, fcpi: { search: { ...r.fcpi.search, evidence: undefined } } }));
  const reasonOf = async (ctxOver, web = fresh()) => { const resp = { web }; await core.attachFcpiEvidence({ ...evCtx, ...ctxOver }, resp); return resp.web.map((w) => w.fcpi.search.evidence?.reason ?? w.fcpi.search.evidence?.mode); };
  const aborted = new AbortController(); aborted.abort();
  const failedRow = [{ ...fresh()[0] }, { ...fresh()[1], metadata: { statusCode: 500, sourceURL: rows[1].url } }];
  const branches = { refused: await reasonOf({ originalQuery: "refuse evidence" }), cancelled: await reasonOf({ signal: aborted.signal }),
    noTime: await reasonOf({ absoluteDeadlineMs: Date.now() + 600 }), acquisitionFailed: await reasonOf({}, failedRow) };
  check("evidence_branches", branches.refused.every((r) => r === "evidence_unavailable") && branches.cancelled.every((r) => r === "cancelled") && branches.noTime.every((r) => r === "no_time")
    && branches.acquisitionFailed[1] === "acquisition_failed" && branches.acquisitionFailed[0] !== "acquisition_failed", { branches });

  // 7. The trim path (review SI3 C1): ten documents whose windows serialize past the 768 KiB body (quotes double in JSON). The
  //    body is cut to fit, by dropping each document's lowest-priority windows: its best paragraph, placed last, survives.
  const quoted = (i) => Array.from({ length: 60 }, (_, k) => k === 59 ? `vue reactivity ref computed watch ${'"'.repeat(900)} ${i}` : `vue ${'"'.repeat(1000)} ${i}.${k}`).join("\n\n");
  const heavy = Array.from({ length: 10 }, (_, i) => ({ url: `https://heavy${i}.example.org/`, title: "", description: "", markdown: quoted(i), metadata: { statusCode: 200 }, fcpi: { search: { documentId: createHash("sha256").update(`h${i}`).digest("hex").slice(0, 24) } } }));
  const trim = timed(() => core.evidencePayload(evCtx, heavy, Date.now() + 4000));
  const trimmedBytes = Buffer.byteLength(JSON.stringify(trim.out));
  const bestKept = trim.out.documents.every((d, i) => d.windows.some((w) => w.text.startsWith("vue reactivity ref computed watch") && w.text.endsWith(` ${i}`)));
  check("evidence_trim_fits_and_keeps_priority", trimmedBytes <= 786432 && trim.out.documents.some((d) => d.droppedWindows > 0) && bestKept && trim.ms < 1000,
    { bodyBytes: trimmedBytes, ms: Math.round(trim.ms), dropped: trim.out.documents.map((d) => d.droppedWindows), bestKept });
  // The measured hostile case: pages of short paragraphs that each hold a common word. Stop words are no terms, and windows
  // are capped, so the build stays fast.
  const shortParas = Array.from({ length: 3 }, (_, i) => ({ url: `https://short${i}.example.org/`, title: "", description: "", markdown: Array.from({ length: 20000 }, (_, k) => `the fetch ${k}`).join("\n\n"), metadata: { statusCode: 200 }, fcpi: { search: { documentId: createHash("sha256").update(`s${i}`).digest("hex").slice(0, 24) } } }));
  const hostile = timed(() => core.evidencePayload(contextFor({ query: "how to use the fetch api", limit: 10, scrapeOptions: { formats: ["markdown"] } }, 20000), shortParas, Date.now() + 4000));
  check("evidence_hostile_paragraphs_bounded", hostile.ms < 1000 && hostile.out.documents.every((d) => d.windows.length <= 48), { ms: Math.round(hostile.ms), windows: hostile.out.documents.map((d) => d.windows.length) });

  // 8. The HTML-derived rendition: linear on unclosed blocks and stray "<", script text removed, an escaped entity kept.
  const unclosed = timed(() => core.renditionOf({ rawHtml: "<p>start</p>" + "<style>".repeat(40000) + "<p>end</p>" }));
  const strays = timed(() => core.renditionOf({ rawHtml: "<p>" + "<a ".repeat(200000) + "</p>" }));
  const plain = core.renditionOf({ html: "<p>a &amp;lt; b</p><SCRIPT>var x = 1</script ><p>c &amp; d</p>" });
  check("html_rendition_linear_and_exact", unclosed.ms < 500 && strays.ms < 500 && plain?.basis === "text_derived_from_html" && /a &lt; b/.test(plain.text) && /c & d/.test(plain.text) && !/var x/.test(plain.text),
    { unclosedMs: Math.round(unclosed.ms), straysMs: Math.round(strays.ms), text: plain?.text });

  // 9. One term rule on both sides of the boundary, over the frozen corpus's 120 queries (the core keeps at most 32).
  const corpus = JSON.parse(readFileSync("./corpus-v1.json", "utf8")).queries.map((q) => q.query);
  const terms = typeof core.queryTerms === "function" ? core.queryTerms : null;
  const differ = terms ? corpus.filter((q) => JSON.stringify(terms(q)) !== JSON.stringify(retrievalTerms(q).slice(0, 32))) : corpus;
  check("query_terms_match_the_retrieval_service", !!terms && corpus.length === 120 && differ.length === 0 && !terms("the use of how").length && !terms("vue -react").includes("-react"),
    { exported: !!terms, differ: differ.slice(0, 3) });

  // 10. The trusted deadline: a past one is kept (the search times out unsent), a distant one ignored for the request's own.
  const sentBefore = fixtures().reduce((n, f) => n + f.seen.length, 0);
  const past = core.fcpiSearchContext(trustedHeaders(String(Date.now() - 1000)), { query: "past deadline", timeout: 60000 }, `job-${randomUUID()}`, new AbortController().signal);
  const pastFailure = await failureOfCall(core.piIntelligentSearch(past));
  const distant = core.fcpiSearchContext(trustedHeaders(String(Date.now() + 600000)), { query: "distant", timeout: 30000 }, `job-${randomUUID()}`, new AbortController().signal);
  check("trusted_deadline_never_restarts", past.absoluteDeadlineMs < Date.now() && pastFailure === "SEARCH_TIMEOUT" && fixtures().reduce((n, f) => n + f.seen.length, 0) === sentBefore
    && Math.abs(distant.absoluteDeadlineMs - (Date.now() + 30000)) < 2000, { pastFailure });

  // 11. The core's reading of the retrieval service's answer: an untyped refusal is the backend's fault (502), and a body cut
  //     by the caller's cancellation is a cancellation.
  const untyped = await failureOfCall(core.piIntelligentSearch(contextFor({ query: "answer untyped 401", limit: 5 }, 10000)));
  const stallAc = new AbortController();
  setTimeout(() => stallAc.abort(), 300);
  const stalled = await failureOfCall(core.piIntelligentSearch(contextFor({ query: "stall the body", limit: 5 }, 10000, stallAc.signal)));
  check("answer_mapping", untyped === "SEARCH_BACKEND_ERROR" && stalled === "CANCELLED", { untyped, stalled });

  // 12. The compiled upstream call sites the patch changes that load on their own: the scrape merge and the strict schema.
  let merge = null, schema = null;
  try {
    const upstream = createRequire("/app/");
    const { mergeScrapedContent } = upstream("/app/dist/src/search/scrape.js");
    const sr = { web: [{ url: "https://a.example/", title: "A", description: "", fcpi: { search: { documentId: "b".repeat(24) } } }] };
    mergeScrapedContent(sr, [{ scrapeInput: { url: "https://a.example/" } }], [{ document: { markdown: "# A", metadata: { statusCode: 200 }, fcpi: { retrieval: { route: "direct" } } } }]);
    merge = { search: sr.web[0].fcpi?.search?.documentId === "b".repeat(24), retrieval: sr.web[0].fcpi?.retrieval?.route === "direct", markdown: sr.web[0].markdown === "# A" };
    const { searchRequestSchema } = upstream("/app/dist/src/controllers/v2/types.js");
    schema = { valid: searchRequestSchema.safeParse({ query: "q", searchIntelligence: { documentation: "required", libraries: [{ name: "vue", version: "3.5" }], evidence: "off" } }).success,
      unknownRefused: !searchRequestSchema.safeParse({ query: "q", searchIntelligence: { ranking: "x" } }).success,
      impossibleDateRefused: !searchRequestSchema.safeParse({ query: "q", searchIntelligence: { publishedAfter: "2026-02-30T00:00:00Z" } }).success };
  } catch (e) { merge ??= { error: String(e.message).slice(0, 200) }; schema ??= { error: String(e.message).slice(0, 200) }; }
  check("compiled_scrape_merge_keeps_row_metadata", !!merge && merge.search === true && merge.retrieval === true && merge.markdown === true, { merge });
  check("compiled_schema_is_strict", !!schema && schema.valid === true && schema.unknownRefused === true && schema.impossibleDateRefused === true, { schema });
} finally {
  server.close();
  await h.close();
}

const failed = checks.filter((c) => c.result !== "PASS");
console.log(JSON.stringify({ schema: "fcpi.si3-native-chain/v1", utc: new Date().toISOString(), node: process.version, checks, passed: checks.length - failed.length, failed: failed.length }, null, 2));
process.exit(failed.length ? 1 : 0);
