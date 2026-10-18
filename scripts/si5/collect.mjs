#!/usr/bin/env node
// SI5's corpus collection (docs/FIRECRAWL_PI_SEARCH_INTELLIGENCE_SPEC.md §23.1-23.2). For each query of the frozen corpus, in id
// order:
//   D            one live search of the complete system (five engines, Jev, automatic Context7/Ref activation), under the
//                disposable database's real hourly admission and the providers' own limits, paced to at most --per-hour searches;
//   B, C, D-C7, D-Ref  the same request through the same coordinator code, fed the provider answers D received. The answers are
//                held in memory, so no cache lifetime can expire them, and a replay can never dispatch discovery: an answer D did
//                not get is a failed lane, counted as a miss. A replay is admitted whatever D's later calls did to a provider's
//                availability or breaker (it sends nothing), and a lane that still did not take D's answer is recorded as a
//                divergence. C and the documentation ablations ask Jev live (its decision cache applies as in service). Ref's
//                enrichment reads belong to a live session the replay does not hold, so a replay never reads: a read D-Ref
//                would have made is recorded (enrichmentNotReplayed) and its ranking has no read passage. Replays dispatch no
//                discovery provider, so they are not counted by the hourly admission, which governs collection;
//   A            the legacy Serper-first selection: Serper's organic order from D's own Serper answer, first ten. The legacy core
//                sends domain constraints as site: operators, so for such a query A makes its own legacy-shaped Serper request
//                (recorded as an unmatched baseline acquisition); with no Serper answer the legacy SearXNG fallback is not
//                available here, and A is recorded unmatched and empty.
// Each profile's internal top 20 comes from its pool before public truncation (benchmark instrumentation: the coordinator's own
// run record, ranked by its scores and selected with its own diversity rule; the public limit stays 10).
// Writes one private record per query (provider text, kept out of Git) and a sanitized one (URLs, titles, ranks, outcomes,
// usage; provider text only as hashes, except the titles and URLs that identify each document). Restartable: a query with both
// records is skipped. A restart on a different commit is recorded in frozen.json as a collector revision, and needs
// --revision-reason; the ranking files must still match the freeze. A trial (--only) writes to eval/trials/, never runs/.
// The collection has its own database on the disposable server (FCPI_SI5_DB, default fcpi_si5_eval): the retrieval suites
// that share FCPI_TEST_PG's "postgres" database truncate its tables and drop its schema. Credentials are handled as in
// live-smoke.mjs: copied to owner-only files for the run, never printed, removed on exit or signal, and a record holding any
// value is refused.
//   FCPI_TEST_PG=127.0.0.1 PGPORT=55432 node scripts/si5/collect.mjs [--fresh] [--only Q001,Q002] [--per-hour 50] [--revision-reason "…"]
import { readFileSync, writeFileSync, mkdirSync, mkdtempSync, rmSync, chmodSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { BlockList } from "node:net";
import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";

const pg = createRequire(new URL("../../services/retrieval/package.json", import.meta.url))("pg");
const root = new URL("../../", import.meta.url).pathname;
const R = (p) => new URL(`../../services/retrieval/src/${p}`, import.meta.url).href;
const [{ loadPolicy }, { loadBudgetPolicy }, { Store }, { makePublicResolver }, { providerRequest, providerStreamRequest, readCredential }, { makeSerper }] = await Promise.all(
  ["policy.mjs", "budget.mjs", "store.mjs", "resolve.mjs", "provider.mjs", "serper.mjs"].map((p) => import(R(p))));
const si = (p) => import(R(`search-intelligence/${p}`));
const [{ validateSearchRequest, failed, VERSIONS }, { normalizeUrl, sha256 }, { selectFinal, WEIGHTS, RRF_K }, { makeAvailability }, { makePermits }, common, { makeSerperLane }, { makeBrave }, { makeExa },
  { makeDeepseek }, { makeTavily }, { makeContext7 }, { makeRef, makeRefSessionFactory }, { makeRefBridge }, { makeDocumentation }, { makeDecisions }, { makeCoordinator }] = await Promise.all(
  ["contracts.mjs", "normalize.mjs", "rank.mjs", "availability.mjs", "permits.mjs", "adapters/common.mjs", "adapters/serper.mjs", "adapters/brave.mjs", "adapters/exa.mjs", "adapters/deepseek.mjs",
    "adapters/tavily.mjs", "adapters/context7.mjs", "adapters/ref.mjs", "adapters/ref-bridge.mjs", "documentation.mjs", "decisions.mjs", "coordinator.mjs"].map(si));

const arg = (name, dflt) => { const i = process.argv.indexOf(`--${name}`); return i < 0 ? dflt : process.argv[i + 1]; };
const FRESH = process.argv.includes("--fresh"), ONLY = arg("only", null)?.split(","), PER_HOUR = Number(arg("per-hour", "50"));
const REVISION_REASON = arg("revision-reason", null);
const HOST = process.env.FCPI_TEST_PG;
if (!HOST) { console.error("FCPI_TEST_PG must name the disposable PostgreSQL"); process.exit(2); }
if (!(PER_HOUR >= 1 && PER_HOUR <= 60)) { console.error("--per-hour must be 1-60 (the deployed admission is 60 an hour)"); process.exit(2); }
const DB = process.env.FCPI_SI5_DB ?? "fcpi_si5_eval";
if (!/^fcpi_si5_[a-z0-9_]{1,40}$/.test(DB)) { console.error("FCPI_SI5_DB must name an fcpi_si5_* database (never the suites' postgres)"); process.exit(2); }

const EVAL = join(root, "evidence/search-intelligence/SI5/eval");
const OUT = join(EVAL, ONLY ? "trials" : "runs"), PRIVATE = join(EVAL, ONLY ? "private/trials" : "private/runs");
mkdirSync(OUT, { recursive: true }); mkdirSync(PRIVATE, { recursive: true });
const corpus = JSON.parse(readFileSync(join(root, "evidence/search-intelligence/SI0/corpus/corpus-v1.json"), "utf8"));
const git = (...a) => execFileSync("git", ["-C", root, ...a], { encoding: "utf8" }).trim();
const commit = git("rev-parse", "HEAD"), codeDirty = git("status", "--porcelain", "--", ".", ":(exclude)evidence").length > 0;
// A full collection runs from committed code only; a trial (--only) may not.
if (codeDirty && !ONLY) { console.error("refused: commit the code first (a full collection records one clean commit)"); process.exit(2); }

// ---- credentials, policies, store (as live-smoke.mjs) ------------------------------------------------------------------------
const NAMES = { SERPER_API_KEY: "serper_api_key", BRAVE_API_KEY: "brave_api_key", EXA_API_KEY: "exa_api_key", DEEPSEEK_API_KEY: "deepseek_api_key", TAVILY_API_KEY: "tavily_api_key",
  CONTEXT7_API_KEY: "context7_api_key", REF_API_KEY: "ref_api_key", OPENROUTER_API_KEY: "openrouter_api_key" };
const env = Object.fromEntries(readFileSync(join(root, ".env"), "utf8").split("\n").map((l) => /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(l)).filter(Boolean)
  .map(([, k, v]) => [k, v.replace(/^(['"])(.*)\1$/, "$2")]).filter(([k, v]) => NAMES[k] && v));
const secrets = Object.values(env);
const keysDir = mkdtempSync(join(tmpdir(), "fcpi-si5-keys-"));
chmodSync(keysDir, 0o700);
for (const [k, file] of Object.entries(NAMES)) if (env[k]) writeFileSync(join(keysDir, file), env[k], { mode: 0o600 });
process.on("exit", () => rmSync(keysDir, { recursive: true, force: true }));
// A signal's default ends the process without its exit handlers: exit instead, so the key files go with it.
for (const s of ["SIGINT", "SIGTERM", "SIGHUP"]) process.on(s, () => process.exit(130));

const policy = loadPolicy(readFileSync(join(root, "deploy/policies/egress.json"), "utf8"));
const local = new BlockList();
for (const [net, bits] of [["10.0.0.0", 8], ["172.16.0.0", 12], ["192.168.0.0", 16], ["127.0.0.0", 8], ["169.254.0.0", 16], ["100.64.0.0", 10]]) local.addSubnet(net, bits, "ipv4");
const getPolicy = () => ({ ...policy, localCidrs: local });
const budget = loadBudgetPolicy(readFileSync(join(root, "deploy/policies/budget.json"), "utf8"));
const getBudget = () => budget, getSelection = () => ({ search: "live" });
const resolvePublic = makePublicResolver({});
const L = policy.search.intelligence;

// The frozen configuration (spec §23.1): what decides every profile's ranking, fixed before any held-out label exists. Written by
// the first run and checked by every restart, so the whole collection provably ran on one configuration.
const fileHash = (p) => sha256(readFileSync(join(root, p)));
const tracked = git("ls-files", "services/retrieval/src").split("\n").filter((p) => p.endsWith(".mjs"));
const frozen = { schema: "fcpi.si5-frozen/v1", repositoryCommit: commit, versions: VERSIONS, weights: WEIGHTS, rrfK: RRF_K,
  searchIntelligence: sha256(JSON.stringify(policy.search.intelligence)), searching: sha256(JSON.stringify(budget.searching)),
  jev: { subject: budget.searching.decisionSubject, model: budget.decisions?.[budget.searching.decisionSubject]?.model ?? null },
  limits: { candidates: L.candidates, cacheSeconds: L.cacheSeconds, discoveryMs: L.discoveryMs, semanticMs: L.semanticMs },
  files: Object.fromEntries([...tracked, "deploy/policies/egress.json", "deploy/policies/budget.json", "evidence/search-intelligence/SI0/corpus/corpus-v1.json"].map((p) => [p, fileHash(p)])) };
const frozenPath = join(EVAL, "frozen.json");
// What runs the collection rather than ranks it. A restart on another commit is a recorded revision, from the next query on.
const collectorFiles = ["scripts/si5/collect.mjs", "services/retrieval/package-lock.json", "deploy/nuq-postgres/fcpi-retrieval-schema.sql"];
const nextQuery = corpus.queries.find((q) => !(existsSync(join(OUT, `${q.id}.json`)) && existsSync(join(PRIVATE, `${q.id}.json`))))?.id ?? null;
const revisionNow = { repositoryCommit: commit, database: DB, files: Object.fromEntries(collectorFiles.map((p) => [p, fileHash(p)])) };
if (!ONLY) {
  if (existsSync(frozenPath)) {
    const was = JSON.parse(readFileSync(frozenPath, "utf8"));
    const changed = Object.keys({ ...was.files, ...frozen.files }).filter((p) => was.files[p] !== frozen.files[p]);
    if (changed.length || was.searchIntelligence !== frozen.searchIntelligence || was.searching !== frozen.searching) { console.error(`refused: the frozen configuration changed (${changed.slice(0, 5).join(", ") || "policy"})`); process.exit(2); }
    // The freeze's own collector, from its commit, when the manifest predates revisions (it ran on the suites' database).
    const revisions = was.collectorRevisions ?? [{ repositoryCommit: was.repositoryCommit, database: "postgres", fromQuery: corpus.queries[0].id, utc: was.frozenAt,
      files: Object.fromEntries(collectorFiles.map((p) => [p, sha256(execFileSync("git", ["-C", root, "show", `${was.repositoryCommit}:${p}`]))])) }];
    const last = revisions.at(-1);
    if (last.repositoryCommit !== commit || last.database !== DB) {
      if (!REVISION_REASON) { console.error(`refused: the collector changed since ${last.repositoryCommit.slice(0, 7)}; say why with --revision-reason`); process.exit(2); }
      revisions.push({ ...revisionNow, fromQuery: nextQuery, utc: new Date().toISOString(), reason: REVISION_REASON });
    }
    if (!was.collectorRevisions || revisions.length !== was.collectorRevisions.length) writeFileSync(frozenPath, JSON.stringify({ ...was, collectorRevisions: revisions }, null, 1) + "\n");
  } else writeFileSync(frozenPath, JSON.stringify({ ...frozen, frozenAt: new Date().toISOString(), collectorRevisions: [{ ...revisionNow, fromQuery: nextQuery, utc: new Date().toISOString(), reason: "the freeze" }] }, null, 1) + "\n");
}

async function openStore() {
  const admin = new pg.Client({ host: HOST, user: "postgres", database: "postgres" });
  await admin.connect();
  try { if (!(await admin.query("SELECT 1 FROM pg_database WHERE datname = $1", [DB])).rowCount) await admin.query(`CREATE DATABASE ${DB}`); }
  finally { await admin.end(); }
  const c = new pg.Client({ host: HOST, user: "postgres", database: DB });
  await c.connect();
  try {
    await c.query("CREATE SCHEMA IF NOT EXISTS nuq"); await c.query(readFileSync(join(root, "deploy/nuq-postgres/fcpi-retrieval-schema.sql"), "utf8"));
    // A fresh collection starts from a clean slate: no earlier admission, availability, cache or ledger row stands in for it.
    if (FRESH) await c.query("TRUNCATE fcpi_retrieval.search_cache, fcpi_retrieval.search_query, fcpi_retrieval.provider_availability, fcpi_retrieval.budget_usage, fcpi_retrieval.budget_reservation, fcpi_retrieval.search_run, fcpi_retrieval.search_event");
  } finally { await c.end(); }
  const store = new Store({ host: HOST, database: DB, user: "fcpi_retrieval" });
  await store.ready({ url: 2, browser: 1 });
  return store;
}

// ---- the stores each profile sees --------------------------------------------------------------------------------------------
const wrap = (store, over) => new Proxy(store, { get: (t, k) => (k in over ? over[k] : typeof t[k] === "function" ? t[k].bind(t) : t[k]) });
// D: every provider and aggregate answer is fresh (collection never reuses an earlier one), and each provider answer it would
// store is kept for the replays. Decision cache, admission, availability and the ledger are the store's own.
const liveStore = (store, answers) => wrap(store, {
  searchCacheEntry: async (key) => (key.startsWith("si.provider/") || key.startsWith("si.aggregate/") ? null : store.searchCacheEntry(key)),
  searchCachePut: async (key, value, ttl) => { if (key.startsWith("si.provider/")) answers.set(key, value); else if (!key.startsWith("si.aggregate/")) await store.searchCachePut(key, value, ttl); },
});
// A replay: D's provider answers, no aggregate reuse, no admission (no discovery is dispatched); decisions cached as in service.
const replayStore = (store, answers) => wrap(store, {
  searchCacheEntry: async (key) => (key.startsWith("si.provider/") ? (answers.has(key) ? { response: answers.get(key), createdAt: new Date(), expiresAt: new Date(Date.now() + 3600e3) } : null)
    : key.startsWith("si.aggregate/") ? null : store.searchCacheEntry(key)),
  searchCachePut: async (key, value, ttl) => { if (key.startsWith("si.decision/")) await store.searchCachePut(key, value, ttl); },
  admitSearchQuery: async () => ({ admitted: true, replay: true }),
});

// The service's assembly (server.mjs), once. Telemetry is the benchmark's instrumentation: it keeps each run's record.
const runs = new Map();
const telemetry = { runStarted() {}, runFinished(a) { runs.set(a.request.logicalSearchId, a); }, event() {}, counters: () => ({}), drain: async () => 0 };
const logs = [];
const log = (o) => { if (logs.length < 5000) logs.push(o); };
function assemble(store) {
  const availability = makeAvailability({ store, log });
  const limits = () => policy.search.intelligence;
  const permits = makePermits(policy.search.intelligence);
  const dispatch = common.makeDispatch({ store, getBudget, getPolicy, resolvePublic, readKey: (n) => readCredential(keysDir, n), paidDispatch: true, permits, availability, request: providerRequest, log });
  const serper = makeSerper({ store, getBudget, paidDispatch: true, providersDir: keysDir, getPolicy, resolvePublic, log });
  const general = { serper: makeSerperLane({ serper, limits, permits, availability }), brave: makeBrave({ dispatch, limits }), exa: makeExa({ dispatch, limits }),
    deepseek: makeDeepseek({ dispatch, limits, permits }), tavily: makeTavily({ dispatch, limits }) };
  const makeFetch = makeRefBridge({ permits, getPolicy, resolvePublic, getBudget, paidDispatch: true, limits, request: providerStreamRequest });
  const docs = { context7: makeContext7({ dispatch, limits }), ref: makeRef({ dispatch, limits, openSession: makeRefSessionFactory({ makeFetch, log }), log }) };
  const decisions = makeDecisions({ dispatch, store, limits, permits, log });
  return { dispatch, availability, serper, general, docs, decisions, documentation: makeDocumentation({ decisions, log }) };
}

// An adapter whose discovery is never dispatched in a replay: a missing answer is a failed lane, counted. Its enrichment runs
// with no lease and no admission, so it selects what it would read and reads nothing; a selection is recorded, never sent.
const misses = [], unreadEnrichments = [];
const replayed = (a) => Object.assign(Object.create(a), { search: async (request, ctx) => { misses.push(a.id); return failed(a.id, "internal_failure", "replay_answer_missing", { kind: ctx?.kind ?? "search" }); },
  ...(typeof a.enrich === "function" ? { enrich: async (o) => {
    const r = await a.enrich.call(a, { ...o, lease: null, admit: () => null });
    if (!r.attempted) return r;
    unreadEnrichments.push({ provider: a.id, selected: r.attempted });
    return { ...r, limitation: "replay_not_dispatched", record: r.record ? { ...r.record, limitation: "replay_not_dispatched" } : r.record };
  } } : {}) });
// The replays' dispatch: D's later calls may have changed a provider's availability or breaker, but a replayed lane sends
// nothing, so that live state never refuses it (the answer, or a counted miss, decides). Every other refusal stands.
const replayDispatch = (base) => Object.assign(Object.create(base), { preflight: (sub, o) => {
  const p = base.preflight(sub, o);
  return !p.eligible && (p.reason === "breaker_open" || String(p.detail ?? "").startsWith("availability:")) ? { eligible: true, key: null, epoch: null, probe: false } : p;
} });
// A replay lane that did not take D's answer although D's own lane succeeded: an integrity failure, recorded beside the misses.
const diverged = (p, d) => p.lanes.filter((l) => !(l.reason === "not_configured" && l.detail === "adapter_missing") && !(l.fromCache && /^success_/.test(l.status))
  && d.lanes.some((x) => x.provider === l.provider && /^success_/.test(x.status))).map((l) => `${l.provider}:${l.status}:${l.reason ?? ""}`);

// ---- the legacy baseline's query (the pinned core's search-query-builder: bare site: operators) ---------------------------------
const legacyQuery = (q, c) => q + (c.includeDomains?.length ? " " + c.includeDomains.map((d) => `site:${d}`).join(" OR ") : "") + (c.excludeDomains?.length ? " " + c.excludeDomains.map((d) => `-site:${d}`).join(" ") : "");

// ---- one query -------------------------------------------------------------------------------------------------------------
const hash = (s) => sha256(String(s ?? "")).slice(0, 16);
const requestOf = (q) => {
  const c = q.constraints ?? {};
  return validateSearchRequest({ schema: "fcpi.search-request/v1", requestId: `si5-eval-${q.id}-${randomUUID().slice(0, 8)}`, logicalSearchId: randomUUID(), principalId: "si5-eval", originalQuery: q.query,
    limit: 10, language: "en", constraints: Object.fromEntries(Object.entries(c).filter(([, v]) => v !== undefined)), intelligence: q.searchIntelligence ?? {}, resultMode: "links",
    absoluteDeadlineMs: Date.now() + 60000 }, Date.now());
};
const docOf = (d) => ({ canonicalUrl: d.canonicalUrl, displayUrl: d.displayUrl, host: d.host, title: d.title, description: d.description,
  providers: d.observations.map((o) => [o.provider, o.rank]), passages: (d.passages ?? []).map((p) => ({ kind: p.kind ?? null, provider: p.provider ?? null, text: p.text ?? null, locator: p.locator ?? null })),
  documentation: d.documentation ? { scopes: (d.documentation.scopes ?? []).slice(0, 4).map((s) => ({ library: s.libraryId ?? s.libraryName ?? null, requested: s.requestedVersion ?? null, observed: s.observedVersion ?? null, status: s.status ?? null })) } : null,
  ranks: { presemantic: d.presemanticRank ?? null, semantic: d.semanticRank ?? null }, score: d.score ?? null,
  semantic: d.semantic?.complete ? { relevance: d.semantic.relevance, directness: d.semantic.directness ?? null, evidence: d.semantic.evidence ?? null } : null });
// The internal top 20 (benchmark-only): the run's pool ranked by its own scores, then its own selection rule; its first ten are
// the public answer, which is checked.
function top20(run) {
  if (!run?.pool?.length) return { docs: [], matchesPublic: run?.final?.length === 0 };
  const ranked = [...run.pool].map((d) => ({ ...d })).sort((a, b) => b.score - a.score || (a.documentId < b.documentId ? -1 : 1));
  const out = selectFinal(ranked, 20, { singleDomain: run.request.constraints.includeDomains.length === 1 });
  return { docs: out.map(docOf), matchesPublic: out.slice(0, run.final.length).map((d) => d.documentId).join() === run.final.map((d) => d.documentId).join() };
}
const laneOf = (o) => ({ provider: o.provider, kind: o.kind ?? null, status: o.status, reason: o.reason ?? null, detail: o.detail ?? null, fromCache: !!o.fromCache, durationMs: o.durationMs ?? null,
  dispatchState: o.dispatchState ?? null, resultCount: o.upstreamResultCount ?? null, usage: o.usage ?? null,
  candidates: (o.candidates ?? []).map((c) => ({ url: c.url, rank: c.rank, title: c.title ?? null, description: c.description ?? null, snippets: c.snippets ?? [], publication: c.publication ?? null })) });

async function profile(name, coordinator, request) {
  const t0 = Date.now(), missBefore = misses.length, unreadBefore = unreadEnrichments.length;
  let body = null, failure = null;
  try { ({ body } = await coordinator.search(request, { signal: new AbortController().signal })); }
  catch (e) { failure = { class: e.failureClass ?? e.code ?? "error", detail: String(e.detail ?? e.message).slice(0, 300) }; }
  const run = runs.get(request.logicalSearchId) ?? null;
  runs.delete(request.logicalSearchId);
  const s = body?.search;
  const t = top20(run);
  return {
    profile: name, elapsedMs: Date.now() - t0, failure, replayMisses: misses.slice(missBefore), enrichmentNotReplayed: unreadEnrichments.slice(unreadBefore),
    outcome: s?.outcome ?? run?.outcome ?? null, empty: s?.empty ?? null, publicCount: body?.web?.length ?? 0, top20MatchesPublic: t.matchesPublic,
    coverage: s?.coverage ?? null, providers: s?.providers ?? null, warnings: s?.warnings ?? [], timings: s?.timings ?? run?.timings ?? null,
    ranking: s ? { mode: s.ranking.mode, reason: s.ranking.reason, model: s.ranking.model, scored: s.ranking.scored, shortlisted: s.ranking.shortlisted } : null,
    documentation: s ? { activation: { active: s.documentation.activation.active, reason: s.documentation.activation.reason, signals: s.documentation.activation.signals ?? null },
      enrichment: s.documentation.enrichment ?? null, auxiliary: s.documentation.auxiliaryContext ?? [] } : null,
    usage: s?.usage ?? [], pool: s?.pool ?? null, lanes: (run?.lanes ?? []).map(laneOf), top20: t.docs,
  };
}

// The ledger of one query: the reservations made since it started (its D search, the replays' Jev decisions and A's own
// request), each in its state at the end of the query.
async function ledgerOf(store, since) {
  const r = await store.pool.query("SELECT provider, kind, unit, state, count(*)::int AS n, coalesce(sum(actual), 0)::float8 AS actual, coalesce(sum(reserved), 0)::float8 AS reserved FROM fcpi_retrieval.budget_reservation WHERE created_at >= $1 GROUP BY 1, 2, 3, 4 ORDER BY 1, 2, 3, 4", [since]);
  return r.rows;
}
const dbNow = async (store) => (await store.pool.query("SELECT clock_timestamp() AS t")).rows[0].t;

// The sanitized record: identities, titles, ranks, outcomes and usage; provider text only as hashes.
const sanitizeDoc = (d) => ({ canonicalUrl: d.canonicalUrl, title: d.title, descriptionHash: hash(d.description), providers: d.providers, passages: d.passages.map((p) => ({ kind: p.kind, provider: p.provider, textHash: hash(p.text) })),
  documentation: d.documentation, ranks: d.ranks, score: d.score, semantic: d.semantic });
const sanitizeProfile = (p) => ({ ...p, lanes: p.lanes.map((l) => ({ ...l, candidates: l.candidates.map((c) => ({ url: c.url, rank: c.rank, title: c.title, descriptionHash: hash(c.description), snippetHashes: c.snippets.map(hash), publication: c.publication })) })),
  top20: p.top20.map(sanitizeDoc), documentation: p.documentation ? { ...p.documentation, auxiliary: p.documentation.auxiliary.map((a) => ({ provider: a.provider ?? null, kind: a.kind ?? null, textHash: hash(a.text ?? a.content ?? JSON.stringify(a)) })) } : null });

function writeChecked(path, value) {
  const out = JSON.stringify(value, null, 1);
  if (secrets.some((v) => v.length >= 8 && out.includes(v))) throw new Error(`refused: a credential value appears in ${path}`);
  writeFileSync(path, out + "\n");
}

// ---- the run ----------------------------------------------------------------------------------------------------------------
const store = await openStore();
const live = assemble(store);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const say = (o) => process.stderr.write(`${new Date().toISOString()} ${JSON.stringify(o)}\n`);
let lastLiveStart = 0;
try {
  const queries = corpus.queries.filter((q) => !ONLY || ONLY.includes(q.id));
  for (const q of queries) {
    const pubPath = join(OUT, `${q.id}.json`), privPath = join(PRIVATE, `${q.id}.json`);
    if (existsSync(pubPath) && existsSync(privPath)) continue;
    const wait = lastLiveStart + 3600e3 / PER_HOUR - Date.now();
    if (wait > 0) await sleep(wait);
    const answers = new Map();
    const D = makeCoordinator({ store: liveStore(store, answers), getBudget, getPolicy, getSelection, dispatch: live.dispatch, general: live.general, searxng: null, docs: live.docs,
      documentation: live.documentation, decisions: live.decisions, availability: live.availability, telemetry, log });
    const since = await dbNow(store);
    const record = { schema: "fcpi.si5-eval-run/v1", id: q.id, category: q.category, split: q.split, utc: new Date().toISOString(), repositoryCommit: commit, codeDirty, database: DB, profiles: {} };
    // D, under the real admission: a refused admission waits a minute and asks again.
    let d;
    for (let attempt = 0; attempt < 30; attempt++) {
      lastLiveStart = Date.now();
      d = await profile("D", D, requestOf(q));
      if (d.failure?.class !== "SEARCH_RATE_LIMITED") break;
      say({ id: q.id, admission: "refused", retryInS: 60 });
      await sleep(60e3);
    }
    record.profiles.D = d;
    // The replays, from D's answers.
    const rs = replayStore(store, answers);
    const g = Object.fromEntries(Object.entries(live.general).map(([k, a]) => [k, replayed(a)]));
    const coord = (over) => makeCoordinator({ store: rs, getBudget, getPolicy, getSelection, dispatch: replayDispatch(live.dispatch), general: g, searxng: null, docs: {}, documentation: null, decisions: null,
      availability: live.availability, telemetry, log, ...over });
    record.profiles.B = await profile("B", coord({}), requestOf(q));
    record.profiles.C = await profile("C", coord({ decisions: live.decisions }), requestOf(q));
    record.profiles["D-C7"] = await profile("D-C7", coord({ decisions: live.decisions, documentation: live.documentation, docs: { context7: replayed(live.docs.context7) } }), requestOf(q));
    record.profiles["D-Ref"] = await profile("D-Ref", coord({ decisions: live.decisions, documentation: live.documentation, docs: { ref: replayed(live.docs.ref) } }), requestOf(q));
    for (const p of ["B", "C", "D-C7", "D-Ref"]) record.profiles[p].divergence = diverged(record.profiles[p], d);
    // A: the legacy selection.
    const serperLane = d.lanes.find((l) => l.provider === "serper");
    const c = q.constraints ?? {};
    let A;
    if (c.includeDomains?.length || c.excludeDomains?.length) {
      const legacyQ = legacyQuery(q.query, c);
      try {
        const results = await live.serper.search(legacyQ, "en", { signal: new AbortController().signal, timeoutMs: L.providerTimeoutsMs.serper });
        A = { source: "legacy_request", unmatched: "legacy query carries site: operators", query: legacyQ, results: results.map((r, i) => ({ url: r.url, rank: i + 1, title: r.title ?? null, description: r.content ?? null })) };
      } catch (e) { A = { source: "legacy_request", unmatched: "legacy query carries site: operators", query: legacyQ, failure: String(e.failureClass ?? e.code ?? e.message).slice(0, 120), results: [] }; }
    } else if (serperLane && ["success_results", "success_empty"].includes(serperLane.status)) {
      A = { source: "d_serper_answer", unmatched: null, results: [...serperLane.candidates].sort((x, y) => x.rank - y.rank).map((r) => ({ url: r.url, rank: r.rank, title: r.title, description: r.description })) };
    } else A = { source: "none", unmatched: `serper ${serperLane?.status ?? "absent"}; legacy SearXNG fallback not available to the benchmark`, results: [] };
    A.top = A.results.slice(0, 10).map((r) => ({ canonicalUrl: normalizeUrl(r.url)?.url ?? null, displayUrl: r.url, title: r.title, description: r.description })).filter((r) => r.canonicalUrl);
    record.profiles.A = A;
    record.ledgerBasis = "reservations_created_during_query";
    record.ledger = await ledgerOf(store, since);
    writeChecked(privPath, record);
    writeChecked(pubPath, { ...record, profiles: { ...Object.fromEntries(["D", "B", "C", "D-C7", "D-Ref"].map((p) => [p, sanitizeProfile(record.profiles[p])])),
      A: { ...A, results: A.results.map((r) => ({ url: r.url, rank: r.rank, title: r.title, descriptionHash: hash(r.description) })), top: A.top.map((r) => ({ canonicalUrl: r.canonicalUrl, title: r.title })) } } });
    say({ id: q.id, D: d.outcome, failure: d.failure?.class ?? null, ms: d.elapsedMs, top20: d.top20.length, misses: Object.values(record.profiles).flatMap((p) => p.replayMisses ?? []).length,
      divergence: Object.values(record.profiles).flatMap((p) => p.divergence ?? []).length, unread: Object.values(record.profiles).flatMap((p) => p.enrichmentNotReplayed ?? []).length,
      ranking: d.ranking?.mode ?? null, docs: d.documentation?.activation?.active ?? null });
  }
} finally {
  await store.close();
}
