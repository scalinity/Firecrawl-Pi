// The gateway's configuration (FIRECRAWL_PI_SPEC.md §29): read once at startup, every value checked,
// and any unknown PI_* key stops the process. Limits come from the capability manifest, the one
// statement of the contract; this file only locates it.
import { readFileSync, existsSync } from "node:fs";

const KNOWN = new Set([
  "PI_GATEWAY_LISTEN_PORT", "PI_CORE_URL", "PI_CORE_TIMEOUT_MS", "PI_GATEWAY_CLIENTS_FILE", "PI_ALLOWED_HOSTS", "PI_ALLOWED_HOSTS_FILE",
  "PI_ALLOWED_ORIGINS", "PI_CAPABILITIES_FILE", "PI_ARTIFACT_ROOT", "PI_CREDENTIALS_DIR", "PI_POSTGRES_HOST",
  "PI_POSTGRES_DB", "PI_POSTGRES_USER", "PI_GATEWAY_SUBMIT_TIMEOUT_MS", "PI_GATEWAY_SUBMIT_SETTLE_MS",
  "PI_GATEWAY_POLL_MS", "PI_CLOUD_ACCESS_ENABLED", "PI_MCP_URL",
  // M5: the retrieval service's extraction listener.
  "PI_EXTRACT_URL",
  // M8: the host's admission file (src/admission.mjs).
  "PI_ADMISSION_FILE",
  "PI_INCIDENT_GRANTS_DIR", "PI_INCIDENT_REQUESTS_DIR", "PI_INCIDENT_KEY_FILE", "PI_INCIDENT_REPORTS_DIR", "PI_INCIDENT_OWNER_FILE",
]);

const int = (env, key, dflt, min, max) => {
  const raw = env[key] ?? String(dflt);
  if (!/^\d+$/.test(raw)) throw new Error(`${key} must be an integer`);
  const n = Number(raw);
  if (n < min || n > max) throw new Error(`${key} must be between ${min} and ${max}`);
  return n;
};

// A served origin is scheme://host[:port] with nothing after it; its host[:port] is the Host header
// a request through it carries.
function servedOrigins(list, key) {
  const out = new Map();
  for (const s of (list ?? "").split(",").map((x) => x.trim()).filter(Boolean)) {
    const u = new URL(s);
    if (!["http:", "https:"].includes(u.protocol) || u.origin !== s || u.username || u.password) throw new Error(`${key}: '${s}' is not an exact http(s) origin`);
    out.set(u.host.toLowerCase(), u.origin);
  }
  return out;
}

export function loadConfig(env) {
  const unknown = Object.keys(env).filter((k) => k.startsWith("PI_") && !KNOWN.has(k));
  if (unknown.length) throw new Error(`unknown configuration keys: ${unknown.join(", ")}`);
  if ((env.PI_CLOUD_ACCESS_ENABLED ?? "false") !== "false") throw new Error("PI_CLOUD_ACCESS_ENABLED must be false");
  const core = new URL(env.PI_CORE_URL ?? "");
  if (core.protocol !== "http:" || core.pathname !== "/" || core.search) throw new Error("PI_CORE_URL must be an http origin");
  const hosts = servedOrigins(env.PI_ALLOWED_HOSTS, "PI_ALLOWED_HOSTS");
  if (!hosts.size) throw new Error("PI_ALLOWED_HOSTS must list the origins the gateway is served at");
  // Origins that name the owner's own infrastructure (the tailnet's host name) live in a host-side
  // file, one per line, so they never enter the repository. An absent file adds none.
  if (env.PI_ALLOWED_HOSTS_FILE && existsSync(env.PI_ALLOWED_HOSTS_FILE)) {
    const lines = readFileSync(env.PI_ALLOWED_HOSTS_FILE, "utf8").split("\n").map((l) => l.trim()).filter((l) => l && !l.startsWith("#"));
    for (const [h, o] of servedOrigins(lines.join(","), "PI_ALLOWED_HOSTS_FILE")) hosts.set(h, o);
  }
  const browserOrigins = new Set(servedOrigins(env.PI_ALLOWED_ORIGINS, "PI_ALLOWED_ORIGINS").values());
  for (const k of ["PI_GATEWAY_CLIENTS_FILE", "PI_CAPABILITIES_FILE", "PI_ARTIFACT_ROOT", "PI_CREDENTIALS_DIR", "PI_POSTGRES_HOST", "PI_POSTGRES_DB", "PI_POSTGRES_USER"]) {
    if (!env[k]) throw new Error(`${k} is required`);
  }
  const manifest = JSON.parse(readFileSync(env.PI_CAPABILITIES_FILE, "utf8"));
  checkManifest(manifest, { mcp: !!env.PI_MCP_URL });
  // The MCP service (M4): a fixed http origin on the internal network the two share. Absent, /mcp is no route.
  const mcpUrl = env.PI_MCP_URL ? new URL(env.PI_MCP_URL) : null;
  if (mcpUrl && (mcpUrl.protocol !== "http:" || mcpUrl.pathname !== "/" || mcpUrl.search || mcpUrl.username || mcpUrl.password)) throw new Error("PI_MCP_URL must be an http origin");
  // The extraction service (M5): a fixed http origin on fcpi_model, reached with the gateway's own credential.
  // Absent, the json format and extraction answer 503 EXTRACTION_UNAVAILABLE and every other route serves as
  // before: an unconfigured provider must not take REST down with it (spec §20, AC23).
  const extractUrl = env.PI_EXTRACT_URL ? new URL(env.PI_EXTRACT_URL) : null;
  if (extractUrl && (extractUrl.protocol !== "http:" || extractUrl.pathname !== "/" || extractUrl.search || !/^\d+\.\d+\.\d+\.\d+$/.test(extractUrl.hostname))) throw new Error("PI_EXTRACT_URL must be an http origin at a fixed address");
  const extractToken = extractUrl ? readFileSync(`${env.PI_CREDENTIALS_DIR}/gateway_retrieval_token`, "utf8").trim() : null;
  if (extractUrl && !/^[\x21-\x7e]{32,512}$/.test(extractToken)) throw new Error("gateway_retrieval_token must be 32-512 printable characters");
  const pw = readFileSync(`${env.PI_CREDENTIALS_DIR}/gateway_postgres_password`, "utf8").trim();
  if (pw.length < 32) throw new Error("gateway_postgres_password is shorter than 32 characters");
  const incidentKeys = ["PI_INCIDENT_GRANTS_DIR", "PI_INCIDENT_REQUESTS_DIR", "PI_INCIDENT_KEY_FILE", "PI_INCIDENT_REPORTS_DIR", "PI_INCIDENT_OWNER_FILE"];
  const incidentEnabled = incidentKeys.some(k => env[k]);
  if (incidentEnabled && incidentKeys.some(k => !env[k]?.startsWith("/"))) throw new Error("All incident paths must be absolute and configured together");
  return {
    port: int(env, "PI_GATEWAY_LISTEN_PORT", 3300, 0, 65535),
    core,
    coreTimeoutMs: int(env, "PI_CORE_TIMEOUT_MS", 110000, 100, 300000),
    submitTimeoutMs: int(env, "PI_GATEWAY_SUBMIT_TIMEOUT_MS", 60000, 100, 300000),
    submitSettleMs: int(env, "PI_GATEWAY_SUBMIT_SETTLE_MS", 180000, 0, 3600000),
    pollMs: int(env, "PI_GATEWAY_POLL_MS", 5000, 50, 60000),
    clientsFile: env.PI_GATEWAY_CLIENTS_FILE,
    hosts,
    browserOrigins,
    manifest,
    artifactRoot: env.PI_ARTIFACT_ROOT,
    mcpUrl,
    extractUrl, extractToken,
    db: { host: env.PI_POSTGRES_HOST, database: env.PI_POSTGRES_DB, user: env.PI_POSTGRES_USER, password: pw },
    admissionFile: env.PI_ADMISSION_FILE || null,
    incidents: incidentEnabled ? { grantsDir: env.PI_INCIDENT_GRANTS_DIR, requestsDir: env.PI_INCIDENT_REQUESTS_DIR, keyFile: env.PI_INCIDENT_KEY_FILE, reportsDir: env.PI_INCIDENT_REPORTS_DIR, ownerFile: env.PI_INCIDENT_OWNER_FILE } : null,
    build: process.env.FCPI_SOURCE_COMMIT ?? "unknown",
  };
}

// The manifest's limits are checked here, so a mistyped cap stops startup instead of opening a gap.
export function checkManifest(m, { mcp = false } = {}) {
  if (m.schema !== "fcpi.capabilities/v1") throw new Error("capability manifest: unknown schema");
  const L = m.limits;
  const pos = (v, name, max = Infinity) => { if (!Number.isInteger(v) || v < 1 || v > max) throw new Error(`capability manifest: ${name} must be an integer from 1 to ${max}`); };
  pos(L.bodyBytes, "limits.bodyBytes", 1048576);
  pos(L.crawl.deadlineMinutes, "limits.crawl.deadlineMinutes", 30);
  pos(L.batch.hardMaxUrls, "limits.batch.hardMaxUrls", 100);
  pos(L.batch.maxUrls, "limits.batch.maxUrls", L.batch.hardMaxUrls);
  pos(L.batch.deadlineMinutes, "limits.batch.deadlineMinutes", 30);
  // M6: spec §10.2's bulk threshold, and a hold that outlasts a job's deadline and its stall grace, within the
  // retrieval service's own ceiling (residential.holdMaxMinutes, 90).
  if (!L.proxy || L.proxy.bulkPages !== 300) throw new Error("capability manifest: limits.proxy.bulkPages is spec §10.2's 300");
  // The residential route answers a block of the home connection, never volume (spec §35), so no job the manifest
  // admits is bulk (review R21).
  if ((m.bodies.crawl?.fields.limit.max ?? 0) > L.proxy.bulkPages || L.batch.hardMaxUrls > L.proxy.bulkPages) throw new Error("capability manifest: the largest crawl and batch must stay within limits.proxy.bulkPages, so no admitted job is bulk");
  pos(L.proxy.holdMinutes, "limits.proxy.holdMinutes", 90);
  if (L.proxy.holdMinutes < Math.max(L.crawl.deadlineMinutes, L.batch.deadlineMinutes) + 30) throw new Error("capability manifest: limits.proxy.holdMinutes must outlast a job's deadline and its 30-minute stall grace");
  if (L.extract) {
    pos(L.extract.maxUrls, "limits.extract.maxUrls", 25);
    pos(L.extract.deadlineMinutes, "limits.extract.deadlineMinutes", 60);
    pos(L.extract.scrapeTimeoutMs, "limits.extract.scrapeTimeoutMs", 90000);
    pos(L.extract.maxDocumentBytes, "limits.extract.maxDocumentBytes", 4 * 1048576);
  }
  if (m.routes.some((r) => r.kind === "extract") && !L.extract) throw new Error("capability manifest: an extract route needs limits.extract");
  if (m.bodies.search && m.bodies.search.fields.limit.max > 10) throw new Error("capability manifest: search limit exceeds spec §13's maximum of 10");
  pos(L.admission.maxOpenJobs, "limits.admission.maxOpenJobs", 20);
  pos(L.admission.maxOpenUnits, "limits.admission.maxOpenUnits", 500);
  pos(L.admission.activeUpstreamJobs, "limits.admission.activeUpstreamJobs", 1);
  pos(L.admission.maxSyncInFlight, "limits.admission.maxSyncInFlight", 16);
  pos(L.admission.maxStatusReadsInFlight, "limits.admission.maxStatusReadsInFlight", 4);
  pos(L.results.pageMaxLimit, "limits.results.pageMaxLimit", 1000);
  pos(L.results.pageDefaultLimit, "limits.results.pageDefaultLimit", L.results.pageMaxLimit);
  pos(L.results.pageMaxBytes, "limits.results.pageMaxBytes", 10485760);
  pos(L.results.retentionDays, "limits.results.retentionDays", 30);
  pos(L.results.metadataDays, "limits.results.metadataDays", 90);
  pos(L.results.idempotencyHours, "limits.results.idempotencyHours", 72);
  pos(L.results.archiveResponseMaxBytes, "limits.results.archiveResponseMaxBytes", 32 * 1048576);
  pos(L.auth.failuresPerMinute, "limits.auth.failuresPerMinute", 600);
  // M7: the scrape cache's lifetime (spec §21.3's one hour at most) bounds the freshness a caller may ask for; the
  // browser extras' answers are buffered one at a time within the gateway's memory; the webhook outbox's retries are
  // finite (spec §12, §31.3).
  pos(L.cache?.lifetimeSeconds, "limits.cache.lifetimeSeconds", 3600);
  const scrape = m.bodies.scrape.fields;
  if (scrape.maxAge && scrape.maxAge.max > L.cache.lifetimeSeconds * 1000) throw new Error("capability manifest: scrape maxAge may not exceed the cache's lifetime");
  if (scrape.actions && (scrape.actions.maxItems > 10 || scrape.actions.maxWaitMs > 15000)) throw new Error("capability manifest: actions exceed spec §12's ten actions and 15 s of waiting");
  pos(L.extras?.responseMaxBytes, "limits.extras.responseMaxBytes", 48 * 1048576);
  pos(L.extras?.inFlight, "limits.extras.inFlight", 2);
  pos(L.webhooks?.maxAttempts, "limits.webhooks.maxAttempts", 10);
  pos(L.webhooks?.retryBaseSeconds, "limits.webhooks.retryBaseSeconds", 600);
  pos(L.webhooks?.pollSeconds, "limits.webhooks.pollSeconds", 60);
  const crawl = m.bodies.crawl.fields;
  if (crawl.limit.max > 200 || crawl.maxDiscoveryDepth.max > 3) throw new Error("capability manifest: crawl limits exceed spec §23.1's hard caps");
  if (m.bodies.map.fields.limit.max > 1000) throw new Error("capability manifest: map limit exceeds spec §23.1's 1,000");
  for (const r of m.routes) if (!m.scopes.includes(r.scope)) throw new Error(`capability manifest: route ${r.id} names unknown scope ${r.scope}`);
  // The MCP section, only when the gateway serves /mcp (PI_MCP_URL set): its path, in-flight cap and
  // exchange deadline. Without it, nothing in that section can stop the REST routes from starting.
  if (!mcp) return;
  if (m.mcp?.path !== "/mcp") throw new Error("capability manifest: mcp.path must be /mcp");
  pos(m.mcp.limits?.maxInFlight, "mcp.limits.maxInFlight", 64);
  pos(m.mcp.limits?.exchangeTimeoutMs, "mcp.limits.exchangeTimeoutMs", 600000);
}
