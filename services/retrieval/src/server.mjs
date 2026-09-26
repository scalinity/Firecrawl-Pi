// FCPI retrieval service (FIRECRAWL_PI_SPEC.md §8.3): the only acquisition path in the deployment.
//   POST /internal/acquire  one logical page for the core's pi-resilient engine (JSON in, JSON out)
//   POST /internal/fetch    one auxiliary download (sitemap, document, discovery), body streamed back
//   GET  /searxng/search    the SearXNG-compatible route the core's search uses (fixture backend in M2)
//   GET  /healthz, /readyz  liveness; readiness of the database, the policy and the local networks,
//                           with the browser tier reported on its own
// The two /internal routes take only the core's credential, compared by SHA-256 hash. The browser
// worker's forward proxy (src/proxy.mjs) listens on the browser network alone.
import http from "node:http";
import { readFileSync } from "node:fs";
import { createHash, timingSafeEqual } from "node:crypto";
import { loadEnv, loadPolicy, loadLocalCidrs, readSecret } from "./policy.mjs";
import { Store } from "./store.mjs";
import { makePublicResolver } from "./resolve.mjs";
import { ProxySessions, startProxy } from "./proxy.mjs";
import { makeBrowserClient } from "./browser.mjs";
import { makeAcquirer, makeFetcher, makeSearcher } from "./acquire.mjs";
import { Denied } from "./ssrf.mjs";

const env = loadEnv(process.env);
const BUILD = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version;
const log = (o) => console.log(JSON.stringify({ utc: new Date().toISOString(), service: "retrieval", build: BUILD, ...o }));

const basePolicy = loadPolicy(readFileSync(env.policyFile, "utf8"));
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
reloadLocal();
setInterval(reloadLocal, 60000).unref();
const getPolicy = () => ({ ...basePolicy, localCidrs: localCidrs?.list });
const getLocalReady = () => localCidrs !== null;

const coreTokenHash = Buffer.from(readSecret(env.credentialsDir, "retrieval_core_token_sha256").replace(/^sha256:/, ""), "hex");
const store = new Store({ ...env.postgres, password: readSecret(env.credentialsDir, "retrieval_postgres_password") });
let storeReady = false;
(async function connect() {
  try { await store.ready(env.permits); storeReady = true; log({ event: "store_ready" }); }
  catch (e) { log({ event: "store_unavailable", error: e.code ?? e.message }); setTimeout(connect, 2000); }
})();
setInterval(() => store.prune().catch((e) => log({ event: "prune_failed", error: e.code ?? e.message })), 3600000).unref();

const resolvePublic = makePublicResolver({ server: env.resolver });
const sessions = new ProxySessions();
startProxy({ listen: env.proxyListen, sessions, getPolicy, resolvePublic, log });
const browser = makeBrowserClient({ url: env.browserUrl, token: readSecret(env.credentialsDir, "retrieval_browser_token"),
  proxyServer: `http://${env.proxyListen.host}:${env.proxyListen.port}`, sessions, getPolicy });
const acquire = makeAcquirer({ store, getPolicy, getLocalReady, permits: env.permits, resolvePublic, browser, log });
const fetchOnce = makeFetcher({ store, getPolicy, getLocalReady, permits: env.permits, resolvePublic, log });
const search = makeSearcher({ store, getPolicy, getLocalReady, permits: env.permits, resolvePublic, log });

const STATUS = { SEARCH_UNAVAILABLE: 503, SSRF_DENIED: 403, CLOUD_DENIED: 403, INVALID_URL: 400, INVALID_REQUEST: 400, RATE_LIMITED: 429, PROXY_REQUIRED: 429,
  RESOURCE_BUSY: 429, TIMEOUT: 504, DEADLINE_EXCEEDED: 504, SIZE_LIMIT: 413, ATTEMPT_BUDGET_EXHAUSTED: 409, RETRIEVAL_NOT_READY: 503 };
const send = (res, status, body, extra = {}) => {
  const buf = Buffer.from(JSON.stringify(body));
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "content-length": buf.length, "cache-control": "no-store", ...extra }).end(buf);
};
function authorized(req) {
  const m = /^Bearer ([\x21-\x7e]{32,512})$/.exec(req.headers.authorization ?? "");
  return !!m && timingSafeEqual(createHash("sha256").update(m[1]).digest(), coreTokenHash);
}
function readJson(req, cap = 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let n = 0;
    req.on("data", (c) => { n += c.length; if (n > cap) { reject(new Denied("INVALID_REQUEST", "body exceeds 1 MiB")); req.destroy(); } else chunks.push(c); });
    req.on("end", () => { try { resolve(JSON.parse(Buffer.concat(chunks).toString("utf8"))); } catch { reject(new Denied("INVALID_REQUEST", "body is not JSON")); } });
    req.on("error", reject);
  });
}

// Requests in flight, so a stop can let them release their permits before the pool closes.
let inflight = 0;
const server = http.createServer(async (req, res) => {
  inflight++;
  res.on("close", () => { inflight--; });
  const path = (req.url ?? "").split("?")[0];
  // A caller that goes away cancels its acquisition: the render, the fetch and every wait stop.
  const abort = new AbortController();
  res.on("close", () => { if (!res.writableFinished) abort.abort(); });
  try {
    if (req.method === "GET" && path === "/healthz") return send(res, 200, { ok: true });
    if (req.method === "GET" && path === "/readyz") {
      const b = await browser.health();
      const ok = storeReady && getLocalReady();
      return send(res, ok ? 200 : 503, { ok, store: storeReady, local_networks: getLocalReady(), browser: b.ok === true ? "up" : "down" });
    }
    if (req.method === "GET" && path === "/searxng/search") {
      if (!storeReady) return send(res, 503, { failure: { class: "RETRIEVAL_NOT_READY", detail: "the database is not reachable", retryable: true, retryAfter: null } });
      const r = await search(req.url, abort.signal);
      return res.writeHead(r.status, { "content-type": r.headers["content-type"] ?? "application/json", "content-length": r.body.length }).end(r.body);
    }
    if (path !== "/internal/acquire" && path !== "/internal/fetch") return send(res, 404, { error: "not_found" });
    if (req.method !== "POST") return send(res, 405, { error: "method_not_allowed" });
    if (!authorized(req)) return send(res, 401, { error: "unauthorized" });
    if (!storeReady) return send(res, 503, { failure: { class: "RETRIEVAL_NOT_READY", detail: "the database is not reachable", retryable: true, retryAfter: null } });
    const body = await readJson(req);
    if (path === "/internal/acquire") return send(res, 200, await acquire(body, abort.signal));
    const r = await fetchOnce(body, abort.signal);
    res.writeHead(200, { "content-type": r.headers["content-type"] ?? "application/octet-stream", "content-length": r.body.length,
      "x-fcpi-target-status": String(r.status), "x-fcpi-final-url": r.finalUrl,
      ...(r.headers["content-length"] ? { "x-fcpi-target-content-length": String(r.body.length) } : {}) });
    res.end(r.body);
  } catch (e) {
    if (e instanceof Denied) return send(res, STATUS[e.failureClass] ?? 502, { failure: { class: e.failureClass, detail: e.detail, retryable: e.retryable, retryAfter: e.retryAfter } });
    log({ event: "error", path, error: e.message });
    if (!res.headersSent) send(res, 500, { failure: { class: "RETRIEVAL_ERROR", detail: "internal error", retryable: true, retryAfter: null } });
    else res.destroy();
  }
});

server.listen(env.listen.port, env.listen.host, () => log({ event: "listening", listen: `${env.listen.host}:${env.listen.port}`, proxy: `${env.proxyListen.host}:${env.proxyListen.port}` }));
// On stop: take no new request, cancel the ones in flight (their callers see CANCELLED) and wait up
// to 8 s for them to release what they hold, then close the pool (review finding W3).
let stopping = false;
for (const sig of ["SIGTERM", "SIGINT"]) process.on(sig, async () => {
  if (stopping) return;
  stopping = true;
  server.close();
  server.closeAllConnections?.();
  const until = Date.now() + 8000;
  while (inflight > 0 && Date.now() < until) await new Promise((r) => setTimeout(r, 100));
  store.close().finally(() => process.exit(0));
});
