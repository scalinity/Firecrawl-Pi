// SI3's native chain (docs/FIRECRAWL_PI_SEARCH_INTELLIGENCE_SPEC.md §19.2, §12, §14): the patched core's compiled search code,
// from the image built with patch 0011, against the real retrieval coordinator on fixture providers, both in one throwaway
// container on loopback. Run by scripts/si3/native-chain.sh; prints one JSON record of every check, and exits nonzero when one
// fails. No live provider is reachable from the container (it has no network), so fixture selection is the only one possible.
import http from "node:http";
import { createRequire } from "node:module";
import { randomUUID, randomBytes, createHash } from "node:crypto";
import { harness, refFixture } from "./test/si-helpers.mjs";
import { makeEvidence } from "./src/search-intelligence/evidence.mjs";

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

// The retrieval routes the core calls, behind the core's bearer credential, as server.mjs serves them.
const readJson = async (req) => { let t = ""; for await (const c of req) t += c; return JSON.parse(t); };
const send = (res, status, body) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(body)); };
const server = http.createServer(async (req, res) => {
  try {
    if (req.headers.authorization !== `Bearer ${TOKEN}`) return send(res, 401, { error: "unauthorized" });
    const ac = new AbortController();
    res.on("close", () => { if (!res.writableEnded) ac.abort(); });
    if (req.url === "/internal/search") { const r = await h.coordinator.search(await readJson(req), { signal: ac.signal }); return send(res, r.status, r.body); }
    if (req.url === "/internal/search/evidence") return send(res, 200, await evidence.evaluate(await readJson(req), { signal: ac.signal, selection: "fixture", decisionSubject: "fcpi-fixture-jev" }));
    return send(res, 404, { error: "not_found" });
  } catch (e) { return send(res, e.failureClass === "INVALID_REQUEST" ? 400 : 502, { failure: { class: e.failureClass ?? "INTERNAL", detail: String(e.detail ?? e.message).slice(0, 200) } }); }
});
await new Promise((r) => server.listen(PORT, "127.0.0.1", r));

// The core's own context, from the headers the gateway builds (a complete, well-formed set), and its search call.
const contextFor = (body, deadlineMs, signal = new AbortController().signal) => core.fcpiSearchContext({
  "x-fcpi-search-request-id": `req-${randomUUID()}`, "x-fcpi-search-id": randomUUID(), "x-fcpi-search-owner": hex16(), "x-fcpi-search-deadline-ms": String(Date.now() + deadlineMs) }, body, `job-${randomUUID()}`, signal);

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
  const payload = core.evidencePayload(evCtx, rows);
  const bytes = Buffer.byteLength(JSON.stringify(payload));
  const exact = payload.documents.every((d, i) => d.windows.every((w) => page(i).slice(w.start, w.end) === w.text) && d.contentSha256 === createHash("sha256").update(page(i)).digest("hex"));
  const perDoc = payload.documents.map((d) => d.windows.reduce((n, w) => n + Buffer.byteLength(w.text), 0));
  check("evidence_payload_bounded_and_exact", payload.documents.length === rows.length && bytes <= 786432 && perDoc.every((b) => b <= 49152) && exact, { bodyBytes: bytes, perDocBytes: perDoc, exact });
  const response = { web: rows };
  await core.attachFcpiEvidence(evCtx, response);
  const modes = response.web.map((w) => w.fcpi?.search?.evidence?.mode ?? null);
  check("evidence_annotates_acquired_rows", modes.length > 0 && modes.every((m) => m === "jev" || m === "jev_partial"), { modes });
  const off = { web: rows.map((r) => ({ ...r, fcpi: { search: { ...r.fcpi.search, evidence: undefined } } })) };
  await core.attachFcpiEvidence({ ...evCtx, intelligence: { ...evCtx.intelligence, evidence: "off" } }, off);
  check("evidence_off_evaluates_nothing", off.web.every((w) => w.fcpi.search.evidence === undefined), {});
} finally {
  server.close();
  await h.close();
}

const failed = checks.filter((c) => c.result !== "PASS");
console.log(JSON.stringify({ schema: "fcpi.si3-native-chain/v1", utc: new Date().toISOString(), node: process.version, checks, passed: checks.length - failed.length, failed: failed.length }, null, 2));
process.exit(failed.length ? 1 : 0);
