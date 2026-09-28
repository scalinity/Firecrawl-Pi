// FCPI retrieval service (FIRECRAWL_PI_SPEC.md §7.1, §8.3): the only acquisition path in the deployment,
// and (M5) the home of the search, model and parser adapters and their budgets.
// On the core's listener (fcpi_acquire), the core's credential:
//   POST /internal/acquire  one logical page for the core's pi-resilient engine (JSON in, JSON out)
//   POST /internal/fetch    one auxiliary download (sitemap, document, discovery), body streamed back
//   POST /internal/parse    M5: a PDF the core's native parser could not read well, to the complex-document
//                           parser (the PDF's bytes in, markdown or a typed failure out)
//   GET  /searxng/search    the SearXNG-compatible route the core's search uses (src/search.mjs); on this
//                           internal network only, as upstream's search client sends no credential
//   GET  /healthz, /readyz  liveness; readiness of the database, the policy and the local networks, with the
//                           browser, the search backend and each provider reported on their own
// On the gateway's listener (fcpi_model, M5), the gateway's credential:
//   POST /internal/extract   one structured extraction over documents the gateway scraped (src/extract.mjs)
//   GET  /internal/providers the providers' states, credentials present (yes/no), the selection and budgets
//   GET  /internal/routes    M6: whether the residential route can be had now, and why not
//   POST /internal/route-hold, /internal/route-release   M6: a bulk job's finite route hold on its domains
//   POST /internal/proxy/reconcile   M6: reconcile one proxy provider's day against its usage report (src/reconcile.mjs)
//   POST /internal/webhook/check, /internal/webhook/deliver   M7: whether a webhook destination is approved, and one signed
//                           delivery attempt for the gateway's outbox (src/webhook.mjs)
// The browser worker's forward proxy listens on the browser network alone, SearXNG's search proxy on the
// search network alone (src/proxy.mjs). Credentials are compared by SHA-256.
import http from "node:http";
import { readFileSync } from "node:fs";
import { createHash, createHmac, timingSafeEqual, randomUUID } from "node:crypto";
import { loadEnv, loadPolicy, loadLocalCidrs, loadSelection, defaultSelection, readSecret, parseSha256 } from "./policy.mjs";
import { loadBudgetPolicy, periodStarts } from "./budget.mjs";
import { Store } from "./store.mjs";
import { makePublicResolver } from "./resolve.mjs";
import { ProxySessions, startProxy } from "./proxy.mjs";
import { makeBrowserClient } from "./browser.mjs";
import { makeAcquirer, makeFetcher, makeUrlHmac, domainOf } from "./acquire.mjs";
import { makeResidential } from "./residential.mjs";
import { reconcileDay } from "./reconcile.mjs";
import { makeSearcher } from "./search.mjs";
import { makeModelAdapter, makeExtractor, ExtractionFailure } from "./extract.mjs";
import { makeParser } from "./parse.mjs";
import { makeEnhanced } from "./enhanced.mjs";
import { makeWebhooks } from "./webhook.mjs";
import { readCredential } from "./provider.mjs";
import { Denied, hostMatches, parseTarget } from "./ssrf.mjs";
import { makeAdmission } from "./admission.mjs";

const env = loadEnv(process.env);
const BUILD = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version;
const log = (o) => console.log(JSON.stringify({ utc: new Date().toISOString(), service: "retrieval", build: BUILD, ...o }));

const basePolicy = loadPolicy(readFileSync(env.policyFile, "utf8"));
const budget = loadBudgetPolicy(readFileSync(env.budgetFile, "utf8"));
const budgetSha256 = createHash("sha256").update(readFileSync(env.budgetFile)).digest("hex");
let localCidrs = null;
function reloadLocal() {
  try {
    const l = loadLocalCidrs(readFileSync(env.localCidrsFile, "utf8"));
    if (!localCidrs || l.count !== localCidrs.count) log({ event: "local_networks_loaded", count: l.count });
    localCidrs = l;
  } catch (e) {
    if (localCidrs) log({ event: "local_networks_unavailable", error: e.message });
    localCidrs = null;
  }
}
// The host's selection: absent or unreadable, search stays on the fixture engines (live egress held).
let selection = defaultSelection(budget), selectionSource = "default";
function reloadSelection() {
  let next = defaultSelection(budget), source = "default";
  try { next = loadSelection(readFileSync(env.selectionFile, "utf8"), basePolicy, budget); source = "file"; }
  catch (e) { if (e.code !== "ENOENT") { source = "invalid"; log({ event: "selection_invalid", error: e.message }); } }
  if (JSON.stringify(next) !== JSON.stringify(selection) || source !== selectionSource) log({ event: "selection_loaded", source, ...next });
  selection = next; selectionSource = source;
}
reloadLocal();
reloadSelection();
setInterval(() => { reloadLocal(); reloadSelection(); }, 60000).unref();
const getPolicy = () => ({ ...basePolicy, localCidrs: localCidrs?.list });
const getLocalReady = () => localCidrs !== null;
const getBudget = () => budget;
const getSelection = () => selection;

const coreTokenHash = parseSha256(readSecret(env.credentialsDir, "retrieval_core_token_sha256"), "retrieval_core_token_sha256");
const gatewayTokenHash = parseSha256(readSecret(env.credentialsDir, "retrieval_gateway_token_sha256"), "retrieval_gateway_token_sha256");
const store = new Store({ ...env.postgres, password: readSecret(env.credentialsDir, "retrieval_postgres_password") });
let storeReady = false;
(async function connect() {
  try { await store.ready(env.permits); storeReady = true; log({ event: "store_ready" }); }
  catch (e) { log({ event: "store_unavailable", error: e.code ?? e.message }); setTimeout(connect, 2000); }
})();
setInterval(() => store.prune().catch((e) => log({ event: "prune_failed", error: e.code ?? e.message })), 3600000).unref();

const resolvePublic = makePublicResolver({ server: env.resolver });
// M6: the residential proxy route (spec §10), shared by pages, auxiliary downloads, the browser and search.
const residential = makeResidential({ getBudget, getPolicy, getSelection, providersDir: env.providersDir, paidDispatch: env.paidDispatch, store, resolvePublic, log });
const sessions = new ProxySessions();
startProxy({ listen: env.proxyListen, sessions, getPolicy, resolvePublic, log });
// The URL-hash key, derived under its own label from the browser credential, whose plaintext only
// this service holds (the worker keeps its SHA-256): stable across restarts, changed only with that
// credential, and no further secret to keep.
const urlHmac = makeUrlHmac(createHmac("sha256", readSecret(env.credentialsDir, "retrieval_browser_token")).update("fcpi.retrieval.url-hmac.v1").digest());
// SearXNG's engine requests: fixture engines while the selection is "fixture", only the live engines'
// hosts while it is "live". M6 (F11): a host the policy routes residential gets a leg of its own per tunnel, its
// maximum reserved first and settled at the bytes it carried, under a session sticky per host for ten minutes; when
// the residential route cannot be had the request is refused (PROXY_REQUIRED), never sent from the home connection.
const searchSessions = new ProxySessions();
const searchUpstream = residential.searchUpstream({ engineRoutes: basePolicy.search.engineRoutes, liveHosts: basePolicy.search.engineHosts.live, key: urlHmac });
searchSessions.fixed("searxng", parseSha256(readSecret(env.credentialsDir, "retrieval_searxng_proxy_sha256"), "retrieval_searxng_proxy_sha256"), {
  fixture: () => selection.search === "fixture",
  allow: (t) => (selection.search === "fixture" ? !!t.fixture : !t.fixture && basePolicy.search.engineHosts.live.some((h) => hostMatches(t.host, h))),
  upstreamFor: searchUpstream,
});
startProxy({ listen: env.searchProxyListen, sessions: searchSessions, getPolicy, resolvePublic, log });
const browser = makeBrowserClient({ url: env.browserUrl, token: readSecret(env.credentialsDir, "retrieval_browser_token"),
  proxyServer: `http://${env.proxyListen.host}:${env.proxyListen.port}`, sessions, getPolicy });

// M7: the enhanced provider, the waterfall's last tier (spec §11), and the browser extras behind their switch.
const enhanced = makeEnhanced({ getBudget, getPolicy, getSelection, providersDir: env.providersDir, paidDispatch: env.paidDispatch, store, resolvePublic, log });
const acquire = makeAcquirer({ store, getPolicy, getLocalReady, permits: env.permits, resolvePublic, browser, urlHmac, log, residential, getBudget, enhanced, extras: env.browserExtras,
  admission: makeAdmission(env.admissionFile) });
const fetchOnce = makeFetcher({ store, getPolicy, getLocalReady, permits: env.permits, resolvePublic, urlHmac, log, residential, getBudget });
const search = makeSearcher({ store, getPolicy, getSelection, searchUrl: env.searchUrl, log });
const common = { store, getBudget, paidDispatch: env.paidDispatch, providersDir: env.providersDir, getPolicy, resolvePublic, log };
const adapter = makeModelAdapter(common);
const extract = makeExtractor({ adapter, getBudget, getSelection, log });
const parse = makeParser({ ...common, getSelection });
// A provider's breaker lives in the adapter of its kind (review W6).
const breakerState = (name, p) => (p.kind === "parser" ? parse.breakerState(name) : p.kind === "proxy" ? residential.breakerState(name) : p.kind === "enhanced" ? enhanced.breakerState(name) : adapter.breakerState(name));
// M7: webhook delivery for the gateway's outbox (src/webhook.mjs); the signing secret is read at each use, so one placed
// later needs no restart.
const webhooks = makeWebhooks({ getPolicy, resolvePublic, getSecret: () => readCredential(env.credentialsDir, "webhook_signing_secret"), delivery: env.webhookDelivery, log });
log({ event: "budget_loaded", budget_sha256: budgetSha256, paid_dispatch: env.paidDispatch, models: Object.keys(budget.models), parsers: Object.keys(budget.parsers), proxies: Object.keys(budget.proxies), enhancers: Object.keys(budget.enhancers), browser_extras: env.browserExtras, webhook_delivery: env.webhookDelivery });
// The residential route as others see it: no secret, only whether it can be used now and why not.
const routeView = (st) => ({ available: st.available, reason: st.reason, subject: st.subject ?? null, provider: st.providerName ?? null, paid: st.paid ?? null, ...(st.retryAfter ? { retryAfter: st.retryAfter } : {}) });
// Hourly, the selected paid proxy's last closed UTC day is reconciled against its usage report, when paid dispatch is
// on, it has a report and the report's credential is present (spec §10.3). Only a closed day: today's report moves
// while attempts are in flight (review C1); repeating the same day charges nothing new.
setInterval(async () => {
  const st = residential.state();
  if (!env.paidDispatch || !st.providerName || !st.paid || !st.provider?.usageUrl || !readCredential(env.providersDir, st.provider.usageCredential)) return;
  for (const day of [periodStarts(new Date(Date.now() - 86400e3)).day]) {
    await reconcileDay({ store, getBudget, providersDir: env.providersDir, providerName: st.providerName, day, getPolicy, resolvePublic, log })
      .catch((e) => log({ event: "proxy_reconcile_failed", provider: st.providerName, day, error: e.code ?? e.message }));
  }
}, 3600000).unref();

const STATUS = { SEARCH_UNAVAILABLE: 503, SSRF_DENIED: 403, CLOUD_DENIED: 403, INVALID_URL: 400, INVALID_REQUEST: 400, RATE_LIMITED: 429, PROXY_REQUIRED: 429,
  RESOURCE_BUSY: 429, TIMEOUT: 504, DEADLINE_EXCEEDED: 504, SIZE_LIMIT: 413, ATTEMPT_BUDGET_EXHAUSTED: 409, RETRIEVAL_NOT_READY: 503,
  // M5: search
  SEARCH_BACKEND_UNAVAILABLE: 503, SEARCH_BACKEND_ERROR: 502, SEARCH_TIMEOUT: 504, SEARCH_ENGINES_FAILED: 502, SEARCH_RATE_LIMITED: 429, CANCELLED: 499,
  // M5: extraction and parsing
  MODEL_NOT_ALLOWED: 400, PARSER_NOT_ALLOWED: 400, RATE_CARD_MISSING: 503, PAID_DISPATCH_DISABLED: 402, BUDGET_EXHAUSTED: 402, BLOCKED_CREDENTIAL: 503,
  PARSER_REQUIRED: 422, PROVIDER_UNAVAILABLE: 503, PROVIDER_UNREACHABLE: 503, PROVIDER_UNCERTAIN: 502, PROVIDER_AUTH_FAILED: 502, PROVIDER_BILLING: 502,
  PROVIDER_RATE_LIMITED: 503, PROVIDER_ERROR: 502, PROVIDER_REJECTED: 502, EXTRACTION_UNCERTAIN: 409, EXTRACTION_IN_FLIGHT: 409, LOGICAL_ID_CONFLICT: 409,
  SCHEMA_INVALID: 400, SCHEMA_TOO_LARGE: 400, SCHEMA_TOO_DEEP: 400, SCHEMA_UNSUPPORTED: 400, INPUT_TOO_LARGE: 413, NO_CONTENT: 422, RESULT_TOO_LARGE: 413,
  DOCUMENT_TOO_LARGE: 413, DOCUMENT_TOO_MANY_PAGES: 413, UNSUPPORTED_CONTENT: 415, PARSE_FAILED: 502, PARSE_EMPTY: 502,
  // M6: proxy reconciliation
  RECONCILE_IN_FLIGHT: 409, RECONCILE_SCOPE_UNKNOWN: 409,
  // M7: browser extras
  UNSUPPORTED_CAPABILITY: 422 };
const send = (res, status, body, extra = {}) => {
  const buf = Buffer.from(JSON.stringify(body));
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "content-length": buf.length, "cache-control": "no-store", ...extra });
  res.end(buf);
};
const failureOf = (e) => ({ failure: { class: e.failureClass, detail: e.detail, retryable: e.retryable, retryAfter: e.retryAfter } });
function authorized(req, hash) {
  const m = /^Bearer ([\x21-\x7e]{32,512})$/.exec(req.headers.authorization ?? "");
  return !!m && timingSafeEqual(createHash("sha256").update(m[1]).digest(), hash);
}
function readBody(req, cap, overflowClass = "INVALID_REQUEST") {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let n = 0;
    req.on("data", (c) => { n += c.length; if (n > cap) { reject(new Denied(overflowClass, `body exceeds ${cap} bytes`)); req.destroy(); } else chunks.push(c); });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}
async function readJson(req, cap = 1024 * 1024) {
  const buf = await readBody(req, cap);
  try { return JSON.parse(buf.toString("utf8")); } catch { throw new Denied("INVALID_REQUEST", "body is not JSON"); }
}

// The providers' states for readiness and the gateway's status: no secret, only whether each is present.
async function providerStatus() {
  const { day, month } = periodStarts();
  const usage = storeReady ? await store.budgetUsage(day, month).catch(() => null) : null;
  return {
    selection: { ...selection, source: selectionSource },
    paidDispatch: env.paidDispatch,
    budgetPolicySha256: budgetSha256,
    providers: Object.fromEntries(Object.entries(budget.providers).map(([name, p]) => [name, { kind: p.kind, paid: p.paid,
      credential: p.credential ? (readCredential(env.providersDir, p.credential) ? "present" : "absent") : "not_required",
      breaker: breakerState(name, p) }])),
    budgets: usage,
    caps: Object.fromEntries(Object.entries(budget.categories).map(([k, c]) => [k, { paid: c.paid, unit: c.unit, caps: c.caps }])),
  };
}

// Requests in flight, so a stop can let them release their permits before the pool closes.
let inflight = 0;
function track(req, res) {
  inflight++;
  res.on("close", () => { inflight--; });
  // A caller that goes away cancels its work: the render, the fetch, the search and every wait stop.
  const abort = new AbortController();
  res.on("close", () => { if (!res.writableFinished) abort.abort(); });
  return abort;
}
function onError(res, path, e) {
  if (e instanceof Denied) return send(res, STATUS[e.failureClass] ?? 502, failureOf(e));
  if (e instanceof ExtractionFailure) return send(res, STATUS[e.failureClass] ?? 502, failureOf(e));
  log({ event: "error", path, error: e.message });
  if (!res.headersSent) send(res, 500, { failure: { class: "RETRIEVAL_ERROR", detail: "internal error", retryable: true, retryAfter: null } });
  else res.destroy();
}
const notReady = (res) => send(res, 503, { failure: { class: "RETRIEVAL_NOT_READY", detail: "the database is not reachable", retryable: true, retryAfter: null } });

const server = http.createServer(async (req, res) => {
  const abort = track(req, res);
  const path = (req.url ?? "").split("?")[0];
  try {
    if (req.method === "GET" && path === "/healthz") return send(res, 200, { ok: true });
    if (req.method === "GET" && path === "/readyz") {
      const b = await browser.health();
      const ok = storeReady && getLocalReady();
      // Search, models and parsers are optional to acquisition: reported, never folded into ok (spec §20, AC23).
      return send(res, ok ? 200 : 503, { ok, store: storeReady, local_networks: getLocalReady(), browser: b.ok === true ? "up" : "down",
        search_selection: selection.search, providers: Object.fromEntries(Object.entries(budget.providers).map(([n, p]) => [n, breakerState(n, p)])), residential: routeView(residential.state()),
        enhanced: routeView(enhanced.state()), browser_extras: env.browserExtras, webhook_delivery: env.webhookDelivery });
    }
    if (req.method === "GET" && path === "/searxng/search") {
      if (!storeReady) return notReady(res);
      const r = await search(req.url, abort.signal);
      return send(res, r.status, r.body);
    }
    if (!["/internal/acquire", "/internal/fetch", "/internal/parse"].includes(path)) return send(res, 404, { error: "not_found" });
    if (req.method !== "POST") return send(res, 405, { error: "method_not_allowed" });
    if (!authorized(req, coreTokenHash)) return send(res, 401, { error: "unauthorized" });
    if (!storeReady) return notReady(res);
    if (path === "/internal/parse") {
      // A document past the parser's limit is DOCUMENT_TOO_LARGE, and a page count that is not a number is a
      // malformed request rather than a count of zero (review S10).
      const h = (k) => { const v = req.headers[k]; return typeof v === "string" ? v : null; };
      if (!/^[0-9]{1,6}$/.test(h("x-fcpi-pages") ?? "")) throw new Denied("INVALID_REQUEST", "x-fcpi-pages must be the document's page count");
      const bytes = await readBody(req, budget.parsing.maxBytes, "DOCUMENT_TOO_LARGE");
      const r = await parse({ logicalId: h("x-fcpi-logical-id"), owner: h("x-fcpi-owner"), pages: Number(h("x-fcpi-pages")), reason: h("x-fcpi-reason"), bytes }, abort.signal);
      return send(res, 200, r);
    }
    const body = await readJson(req);
    if (path === "/internal/acquire") return send(res, 200, await acquire(body, abort.signal));
    const r = await fetchOnce(body, abort.signal);
    res.writeHead(200, { "content-type": r.headers["content-type"] ?? "application/octet-stream", "content-length": r.body.length,
      "x-fcpi-target-status": String(r.status), "x-fcpi-final-url": r.finalUrl,
      ...(r.headers["content-length"] ? { "x-fcpi-target-content-length": String(r.body.length) } : {}) });
    res.end(r.body);
  } catch (e) { onError(res, path, e); }
});

// The gateway's listener: extraction and the providers' status only.
const extractServer = http.createServer(async (req, res) => {
  const abort = track(req, res);
  const path = (req.url ?? "").split("?")[0];
  try {
    if (!authorized(req, gatewayTokenHash)) return send(res, 401, { error: "unauthorized" });
    if (req.method === "GET" && path === "/internal/providers") return send(res, 200, await providerStatus());
    if (req.method === "GET" && path === "/internal/routes") {
      if (!storeReady) return notReady(res);
      return send(res, 200, { residential: routeView(await residential.availability()), enhanced: routeView(await enhanced.availability()), bulkPages: basePolicy.residential.bulkPages, holdMaxMinutes: basePolicy.residential.holdMaxMinutes });
    }
    if (req.method === "POST" && (path === "/internal/route-hold" || path === "/internal/route-release" || path === "/internal/proxy/reconcile")) {
      if (!storeReady) return notReady(res);
      const b = await readJson(req, 65536);
      if (path === "/internal/proxy/reconcile") return send(res, 200, await reconcileDay({ store, getBudget, providersDir: env.providersDir, providerName: String(b.provider ?? ""), day: String(b.day ?? ""), getPolicy, resolvePublic, log }));
      if (typeof b.jobId !== "string" || !/^[A-Za-z0-9:_-]{1,128}$/.test(b.jobId)) throw new Denied("INVALID_REQUEST", "jobId must be 1-128 letters, digits, colons, dashes or underscores");
      if (path === "/internal/route-release") { const n = await store.releaseRoutes(b.jobId); log({ event: "route_released", job_id: b.jobId, rows: n }); return send(res, 200, { released: n }); }
      // A hold is placed only while the route can be had: a job that would need it now is refused instead.
      if (!Array.isArray(b.urls) || b.urls.length === 0 || b.urls.length > 200) throw new Denied("INVALID_REQUEST", "urls must list 1 to 200 URLs");
      const minutes = Math.min(Number.isInteger(b.minutes) && b.minutes > 0 ? b.minutes : basePolicy.residential.holdMaxMinutes, basePolicy.residential.holdMaxMinutes);
      const domains = [...new Set(b.urls.map((u) => domainOf(parseTarget(String(u), getPolicy()))))];
      const st = await residential.availability();
      if (!st.available) { log({ event: "route_hold_refused", job_id: b.jobId, reason: st.reason }); return send(res, 409, { held: false, residential: routeView(st), failure: { class: "PROXY_REQUIRED", detail: `the residential route is unavailable (${st.reason})`, retryable: false, retryAfter: st.retryAfter ?? null } }); }
      const until = new Date(Date.now() + minutes * 60000);
      await store.holdRoutes(b.jobId, domains, until, String(b.reason ?? "bulk").slice(0, 64));
      log({ event: "route_held", job_id: b.jobId, domains: domains.length, until: until.toISOString(), reason: String(b.reason ?? "bulk").slice(0, 64) });
      return send(res, 200, { held: true, domains: domains.length, until: until.toISOString() });
    }
    // M7: webhook destinations are checked before a job naming one is accepted, and each outbox attempt is made here.
    if (req.method === "POST" && (path === "/internal/webhook/check" || path === "/internal/webhook/deliver")) {
      const b = await readJson(req, 131072);
      if (!b || typeof b !== "object" || Array.isArray(b)) throw new Denied("INVALID_REQUEST", "the body must be a JSON object");
      if (path === "/internal/webhook/check") return send(res, 200, webhooks.check(b.url));
      return send(res, 200, await webhooks.deliver({ eventId: b.eventId, url: b.url, body: b.body }));
    }
    if (path !== "/internal/extract") return send(res, 404, { error: "not_found" });
    if (req.method !== "POST") return send(res, 405, { error: "method_not_allowed" });
    if (!storeReady) return notReady(res);
    const X = budget.extraction;
    const body = await readJson(req, X.maxDocuments * X.maxDocumentBytes * 2 + 1048576);
    // An extraction no unit of which succeeded answers with its failure's own status (402 for a budget or the
    // paid-dispatch switch, 502 for a provider, and so on), the result body carrying every unit's outcome.
    const out = await extract(body, abort.signal);
    return send(res, out.ok ? 200 : (STATUS[out.failure?.class] ?? 502), out);
  } catch (e) { onError(res, path, e); }
});
extractServer.requestTimeout = 0; // an extraction runs for minutes; its own deadline bounds it

server.listen(env.listen.port, env.listen.host, () => log({ event: "listening", listen: `${env.listen.host}:${env.listen.port}`, proxy: `${env.proxyListen.host}:${env.proxyListen.port}`,
  search_proxy: `${env.searchProxyListen.host}:${env.searchProxyListen.port}`, extract: `${env.extractListen.host}:${env.extractListen.port}` }));
extractServer.listen(env.extractListen.port, env.extractListen.host);
// On stop: take no new request, cancel the ones in flight (their callers see CANCELLED) and wait up
// to 8 s for them to release what they hold, then close the pool (review finding W3).
let stopping = false;
for (const sig of ["SIGTERM", "SIGINT"]) process.on(sig, async () => {
  if (stopping) return;
  stopping = true;
  for (const s of [server, extractServer]) { s.close(); s.closeAllConnections?.(); }
  const until = Date.now() + 8000;
  while (inflight > 0 && Date.now() < until) await new Promise((r) => setTimeout(r, 100));
  store.close().finally(() => process.exit(0));
});
