#!/usr/bin/env node
// SI5's bounded live contract smoke (docs/FIRECRAWL_PI_SEARCH_INTELLIGENCE_SPEC.md §24.2, §30.2): one coordinated live search
// that reaches every configured integration once (the five general engines, Context7, Ref's search and Jev), one explicit Ref
// search and read of one of its results (a coordinated search reads only when a Ref result lacks a useful excerpt), then one
// call per provider with a deliberately invalid key for the hosted refusal shapes (no spend). It runs the
// retrieval service's own adapters with the deployed budget and egress policies, the live selection, and a ledger in its own
// database on the disposable PostgreSQL (FCPI_TEST_PG, database fcpi_si5_smoke: the retrieval suites truncate "postgres", and
// the collection has its own). Credentials are copied from the workstation's .env into owner-only files for the run and
// removed on exit or signal; no value is ever printed, and the record is refused if any value appears in it. It records shapes only:
// status, content type, rate-limit headers, the key structure of each JSON body, usage figures and the parsed outcomes; no
// result text. Never used to exhaust anything: one search, one explicit Ref search and read, a handful of decision requests.
// It fails (exit 4, the gaps on stderr, the record still printed) when a configured integration has no settled live exchange
// or Ref has no settled read: a smoke that cannot fail proves nothing.
//   node scripts/si5/live-smoke.mjs > evidence/search-intelligence/SI5/live-smoke.json
import { readFileSync, writeFileSync, mkdtempSync, rmSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { BlockList } from "node:net";
import { createRequire } from "node:module";
// The retrieval package's own dependency, as its store loads it.
const pg = createRequire(new URL("../../services/retrieval/package.json", import.meta.url))("pg");

const root = new URL("../../", import.meta.url).pathname;
const R = (p) => new URL(`../../services/retrieval/src/${p}`, import.meta.url).href;
const [{ loadPolicy }, { loadBudgetPolicy }, { Store }, { makePublicResolver }, { providerRequest, providerStreamRequest, readCredential }, { makeSerper }] = await Promise.all(
  ["policy.mjs", "budget.mjs", "store.mjs", "resolve.mjs", "provider.mjs", "serper.mjs"].map((p) => import(R(p))));
const si = (p) => import(R(`search-intelligence/${p}`));
const { validateSearchRequest } = await si("contracts.mjs");
const [{ makeAvailability }, { makePermits }, common, { makeSerperLane }, { makeBrave }, { makeExa }, { makeDeepseek }, { makeTavily }, { makeContext7 }, { makeRef, makeRefSessionFactory },
  { makeRefBridge }, { makeDocumentation }, { makeDecisions }, { makeCoordinator }, { makeTelemetry }] = await Promise.all(["availability.mjs", "permits.mjs", "adapters/common.mjs", "adapters/serper.mjs",
  "adapters/brave.mjs", "adapters/exa.mjs", "adapters/deepseek.mjs", "adapters/tavily.mjs", "adapters/context7.mjs", "adapters/ref.mjs", "adapters/ref-bridge.mjs", "documentation.mjs", "decisions.mjs",
  "coordinator.mjs", "telemetry.mjs"].map(si));

const HOST = process.env.FCPI_TEST_PG;
if (!HOST) { console.error("FCPI_TEST_PG must name the disposable PostgreSQL"); process.exit(2); }
// The .env names (SI0 BASELINE) and the budget policy's credential files they become.
const NAMES = { SERPER_API_KEY: "serper_api_key", BRAVE_API_KEY: "brave_api_key", EXA_API_KEY: "exa_api_key", DEEPSEEK_API_KEY: "deepseek_api_key", TAVILY_API_KEY: "tavily_api_key",
  CONTEXT7_API_KEY: "context7_api_key", REF_API_KEY: "ref_api_key", OPENROUTER_API_KEY: "openrouter_api_key" };
const env = Object.fromEntries(readFileSync(join(root, ".env"), "utf8").split("\n").map((l) => /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(l)).filter(Boolean)
  .map(([, k, v]) => [k, v.replace(/^(['"])(.*)\1$/, "$2")]).filter(([k, v]) => NAMES[k] && v));
const secrets = Object.values(env);
const dirs = [];
function providersDir(valueOf) {
  const d = mkdtempSync(join(tmpdir(), "fcpi-si5-keys-"));
  chmodSync(d, 0o700);
  dirs.push(d);
  for (const [k, file] of Object.entries(NAMES)) { const v = valueOf(k); if (v) { writeFileSync(join(d, file), v, { mode: 0o600 }); } }
  return d;
}
const cleanup = () => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); };
process.on("exit", cleanup);
// A signal's default ends the process without its exit handlers: exit instead, so the key files go with it.
for (const s of ["SIGINT", "SIGTERM", "SIGHUP"]) process.on(s, () => process.exit(130));

// The policies as deployed, the host's private ranges as local networks, the system resolver.
const policy = loadPolicy(readFileSync(join(root, "deploy/policies/egress.json"), "utf8"));
const local = new BlockList();
for (const [net, bits] of [["10.0.0.0", 8], ["172.16.0.0", 12], ["192.168.0.0", 16], ["127.0.0.0", 8], ["169.254.0.0", 16], ["100.64.0.0", 10]]) local.addSubnet(net, bits, "ipv4");
const getPolicy = () => ({ ...policy, localCidrs: local });
const budget = loadBudgetPolicy(readFileSync(join(root, "deploy/policies/budget.json"), "utf8"));
const getBudget = () => budget, getSelection = () => ({ search: "live" });
const resolvePublic = makePublicResolver({});

// Shapes, never values: types and keys to depth 4; a few usage figures are kept as numbers since they are the contract.
const USAGE_KEYS = /^(credits|costDollars|total|search|contents|summary|usage|input_tokens|output_tokens|cost|requests)$/;
function shapeOf(v, depth = 0, key = "") {
  if (v === null) return "null";
  if (Array.isArray(v)) return { array: v.length, item: v.length && depth < 4 ? shapeOf(v[0], depth + 1) : undefined };
  if (typeof v === "object") return depth >= 4 ? "object" : Object.fromEntries(Object.entries(v).slice(0, 40).map(([k, x]) => [k, shapeOf(x, depth + 1, k)]));
  if (typeof v === "number" && USAGE_KEYS.test(key)) return v;
  return typeof v;
}
const RATE = /ratelimit|retry-after|x-ratelimit|request-id|x-request-id/i;
// A rate-limit policy can carry a partition key (Ref: pk=:<base64>:) that identifies the account: never recorded.
const pickHeaders = (h) => Object.fromEntries(Object.entries(h ?? {}).filter(([k]) => RATE.test(k) && !/request-id/i.test(k)).map(([k, v]) => [k, String(v).replace(/pk=:[^:]*:/g, "pk=:<redacted>:").slice(0, 80)]));
function capturing(log) {
  return {
    request: async (o) => {
      const base = { host: new URL(o.baseUrl).host, path: o.path.split("?")[0], method: o.method ?? "POST" }, t0 = Date.now();
      try { const r = await providerRequest(o); let body = null; try { body = shapeOf(JSON.parse(r.body.toString("utf8"))); } catch { body = `non-json(${r.body.length})`; }
        log.push({ ...base, status: r.status, ms: Date.now() - t0, contentType: r.headers["content-type"] ?? null, rateHeaders: pickHeaders(r.headers), body }); return r; }
      catch (e) { log.push({ ...base, error: e.code ?? e.message, ms: Date.now() - t0 }); throw e; }
    },
    stream: async (o) => {
      const base = { host: new URL(o.baseUrl).host, path: o.path, method: o.method }, t0 = Date.now();
      try { const r = await providerStreamRequest(o); log.push({ ...base, status: r.status, ms: Date.now() - t0, contentType: r.headers["content-type"] ?? null, rateHeaders: pickHeaders(r.headers), session: !!r.headers["mcp-session-id"] }); return r; }
      catch (e) { log.push({ ...base, error: e.code ?? e.message, ms: Date.now() - t0 }); throw e; }
    },
  };
}

const DB = "fcpi_si5_smoke";
async function freshStore() {
  const admin = new pg.Client({ host: HOST, user: "postgres", database: "postgres" });
  await admin.connect();
  try { if (!(await admin.query("SELECT 1 FROM pg_database WHERE datname = $1", [DB])).rowCount) await admin.query(`CREATE DATABASE ${DB}`); }
  finally { await admin.end(); }
  const c = new pg.Client({ host: HOST, user: "postgres", database: DB });
  await c.connect();
  // A clean slate on the disposable database: no cached provider answer, admission count, availability or ledger row from an
  // earlier run may stand in for this run's live calls.
  try { await c.query("CREATE SCHEMA IF NOT EXISTS nuq"); await c.query(readFileSync(join(root, "deploy/nuq-postgres/fcpi-retrieval-schema.sql"), "utf8"));
    await c.query("TRUNCATE fcpi_retrieval.search_cache, fcpi_retrieval.search_query, fcpi_retrieval.provider_availability, fcpi_retrieval.budget_usage, fcpi_retrieval.budget_reservation, fcpi_retrieval.search_run, fcpi_retrieval.search_event"); }
  finally { await c.end(); }
  const store = new Store({ host: HOST, database: DB, user: "fcpi_retrieval" });
  await store.ready({ url: 2, browser: 1 });
  return store;
}

// The retrieval service's assembly (server.mjs) around one providers directory and one capture log.
function assemble(store, keysDir, wire) {
  const log = [];
  const logs = (o) => log.push(o);
  const telemetry = makeTelemetry({ store, log: logs });
  const availability = makeAvailability({ store, log: logs });
  const limits = () => policy.search.intelligence;
  const permits = makePermits(policy.search.intelligence);
  const dispatch = common.makeDispatch({ store, getBudget, getPolicy, resolvePublic, readKey: (n) => readCredential(keysDir, n), paidDispatch: true, permits, availability, request: wire.request, log: logs });
  const serper = makeSerper({ store, getBudget, paidDispatch: true, providersDir: keysDir, getPolicy, resolvePublic, log: logs });
  const general = { serper: makeSerperLane({ serper, limits, permits, availability }), brave: makeBrave({ dispatch, limits }), exa: makeExa({ dispatch, limits }),
    deepseek: makeDeepseek({ dispatch, limits, permits }), tavily: makeTavily({ dispatch, limits }) };
  const makeFetch = makeRefBridge({ permits, getPolicy, resolvePublic, getBudget, paidDispatch: true, limits, request: wire.stream });
  const docs = { context7: makeContext7({ dispatch, limits }), ref: makeRef({ dispatch, limits, openSession: makeRefSessionFactory({ makeFetch, log: logs }), log: logs }) };
  const decisions = makeDecisions({ dispatch, store, limits, permits, log: logs });
  const coordinator = makeCoordinator({ store, getBudget, getPolicy, getSelection, dispatch, general, searxng: null, docs, documentation: makeDocumentation({ decisions, log: logs }), decisions, availability, telemetry, log: logs });
  return { coordinator, dispatch, general, docs, decisions, availability, telemetry, log };
}

const { execFileSync } = await import("node:child_process");
const git = (...a) => execFileSync("git", ["-C", root, ...a], { encoding: "utf8" }).trim();
const record = { schema: "fcpi.si5-live-smoke/v1", utc: new Date().toISOString(), node: process.version, repositoryCommit: git("rev-parse", "HEAD"),
  codeDirty: git("status", "--porcelain", "--", ".", ":(exclude)evidence").length > 0, configured: Object.keys(env).map((k) => NAMES[k]).sort() };
const store = await freshStore();
try {
  // 1. One live search reaching every configured integration.
  const liveLog = [];
  const live = assemble(store, providersDir((k) => env[k]), capturing(liveLog));
  const q = { schema: "fcpi.search-request/v1", requestId: `si5-smoke-${randomUUID()}`, logicalSearchId: randomUUID(), principalId: "si5-live-smoke", originalQuery: "How do I declare reactive state with ref() in Vue 3.5?",
    limit: 5, language: "en", constraints: {}, intelligence: { documentation: "required", libraries: [{ name: "vue", version: "3.5" }] }, resultMode: "links", absoluteDeadlineMs: Date.now() + 60000 };
  const t0 = Date.now();
  let answer = null, failure = null;
  try { answer = await live.coordinator.search(q, { signal: new AbortController().signal }); } catch (e) { failure = { class: e.failureClass ?? e.code, detail: String(e.detail ?? e.message).slice(0, 300) }; }
  await live.telemetry.drain(5000);
  const s = answer?.body?.search;
  record.search = { elapsedMs: Date.now() - t0, failure, outcome: s?.outcome ?? null, empty: s?.empty ?? null, returned: answer?.body?.web?.length ?? 0,
    providers: s ? Object.fromEntries(Object.entries(s.providers).map(([p, o]) => [p, { status: o.status, reason: o.reason ?? null, detail: o.detail ?? null, fromCache: !!o.fromCache, resultCount: o.resultCount ?? null, eligible: o.eligibleCount ?? null, dispatchState: o.dispatchState, elapsedMs: o.elapsedMs }])) : null,
    documentation: s ? { activation: s.documentation.activation.reason, enrichment: s.documentation.enrichment ?? null, auxiliaryEntries: s.documentation.auxiliaryContext.length } : null,
    ranking: s ? { mode: s.ranking.mode, reason: s.ranking.reason, model: s.ranking.model, scored: s.ranking.scored, shortlisted: s.ranking.shortlisted } : null,
    warnings: s?.warnings ?? [], usage: s?.usage ?? [] };
  record.liveExchanges = liveLog;

  // 1b. One explicit Ref search and a read of its first result, in that search's session (two credits): the read's hosted
  // answer shape is checked live, which a coordinated search reaches only when a Ref result lacks a useful excerpt.
  try {
    const sub = live.dispatch.subject("documentationSearches", "ref-context");
    const o = await live.docs.ref.search(validateSearchRequest({ ...q, requestId: `si5-smoke-${randomUUID()}`, logicalSearchId: randomUUID(), absoluteDeadlineMs: Date.now() + 60000 }, Date.now()),
      { sub, pre: live.dispatch.preflight(sub, { selection: "live" }), signal: new AbortController().signal, deadlineAt: Date.now() + 15000, selection: "live", kind: "docs_search" });
    const first = o.candidates?.[0];
    let read = null;
    if (o.lease && first) {
      const r = await o.lease.read(first.providerUrl, { signal: new AbortController().signal, deadlineAt: Date.now() + 15000 });
      read = r.ok ? { ok: true, kind: r.passage.kind, chars: r.passage.text.length, truncated: r.passage.truncated, usage: r.usage } : { ok: false, reason: r.reason ?? null, detail: r.detail ?? null };
    }
    await o.lease?.close?.();
    record.refRead = { search: { status: o.status, reason: o.reason ?? null, results: o.candidates?.length ?? 0 }, read };
  } catch (e) { record.refRead = { threw: String(e?.code ?? e?.message ?? e).slice(0, 160) }; }
  record.ledger = (await store.pool.query("SELECT provider, kind, unit, state, reserved::float8 AS reserved, actual::float8 AS actual FROM fcpi_retrieval.budget_reservation ORDER BY provider, kind, created_at")).rows;

  // 2. One call per provider with a deliberately invalid key: the hosted refusal shapes and their classification, no spend.
  const badLog = [];
  const refused = assemble(store, providersDir((k) => `fcpi-si5-invalid-${k.toLowerCase().slice(0, 8)}-0000000000000000`), capturing(badLog));
  // Adapters take the validated request, as the coordinator gives it to them.
  const qb = (over = {}) => validateSearchRequest({ ...q, requestId: `si5-smoke-${randomUUID()}`, logicalSearchId: randomUUID(), originalQuery: "vue ref reactivity", absoluteDeadlineMs: Date.now() + 60000, ...over }, Date.now());
  record.invalidKey = {};
  // Each call on its own: one adapter's failure is recorded, never the end of the record.
  const attempt = async (name, fn) => { try { record.invalidKey[name] = await fn(); } catch (e) { record.invalidKey[name] = { threw: String(e?.code ?? e?.message ?? e).slice(0, 160) }; } };
  for (const [map, name, adapter] of [["searches", "brave-web", refused.general.brave], ["searches", "exa-search", refused.general.exa], ["searches", "deepseek-search", refused.general.deepseek],
    ["searches", "tavily-search", refused.general.tavily], ["documentationSearches", "context7-docs", refused.docs.context7], ["documentationSearches", "ref-context", refused.docs.ref]]) {
    await attempt(name, async () => {
      const sub = refused.dispatch.subject(map, name), pre = refused.dispatch.preflight(sub, { selection: "live" });
      const o = await adapter.search(qb(), { sub, pre, signal: new AbortController().signal, deadlineAt: Date.now() + 15000, selection: "live" });
      await o.lease?.close?.();
      return { status: o.status, reason: o.reason ?? null, detail: o.detail ?? null, dispatchState: o.dispatchState };
    });
  }
  await attempt("serper-google", async () => {
    const sub = refused.dispatch.subject("searches", "serper-google");
    const o = await refused.general.serper.search(qb(), { sub, pre: refused.dispatch.preflight(sub, { selection: "live", breakerState: refused.general.serper.breakerState }), signal: new AbortController().signal, deadlineAt: Date.now() + 15000, selection: "live" });
    return { status: o.status, reason: o.reason ?? null, detail: o.detail ?? null, dispatchState: o.dispatchState };
  });
  await attempt("jev-1.14", async () => {
  const jp = refused.decisions.preflight("live", "jev-1.14");
  const jr = await refused.decisions.decide({ body: { model: "typesafe/jev-1.14", state: { query: "vue" }, questions: { q: { type: "noul", instructions: "Is state.query about software?", criteria: { true: "yes", false: "no" } } } },
    kind: "decision", purpose: "smoke", request: qb(), sub: jp.sub, pre: jp.pre, signal: new AbortController().signal, deadlineAt: Date.now() + 15000, selection: "live" });
  return { ok: jr.ok, reason: jr.reason ?? null, detail: jr.detail ?? null };
  });
  record.invalidKeyExchanges = badLog;
} catch (e) {
  // Whatever escaped is recorded; the run's record is still printed.
  record.error = String(e?.code ?? e?.message ?? e).slice(0, 200);
} finally {
  await store.close();
  cleanup();
}


const out = JSON.stringify(record, null, 2);
// The record never carries a credential: refused whole if any value appears in it.
if (secrets.some((v) => v.length >= 8 && out.includes(v))) { console.error("refused: a credential value appears in the record"); process.exit(3); }
console.log(out);
// Every configured integration had a settled live exchange, and Ref a settled read; otherwise the smoke fails, saying what.
const providerOf = Object.fromEntries(Object.values(budget.providers).filter((p) => p.credential).map((p) => [p.credential, p]));
const settled = (fn) => (record.ledger ?? []).some((r) => r.state === "SETTLED" && fn(r));
const gaps = record.configured.filter((file) => { const id = Object.entries(budget.providers).find(([, p]) => p.credential === file)?.[0]; return id && providerOf[file] && !settled((r) => r.provider === id); })
  .map((file) => `${file}: no settled live exchange`);
if (record.configured.includes("ref_api_key") && !settled((r) => r.kind === "docs_read")) gaps.push("ref_api_key: no settled read");
if (record.error) gaps.push(`run: ${record.error}`);
if (gaps.length) { console.error(`smoke gaps: ${gaps.join("; ")}`); process.exit(4); }
