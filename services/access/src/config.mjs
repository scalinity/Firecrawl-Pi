// The gateway's configuration (FIRECRAWL_PI_SPEC.md §29): read once at startup, every value checked,
// and any unknown PI_* key stops the process. Limits come from the capability manifest, the one
// statement of the contract; this file only locates it.
import { readFileSync } from "node:fs";

const KNOWN = new Set([
  "PI_GATEWAY_LISTEN_PORT", "PI_CORE_URL", "PI_CORE_TIMEOUT_MS", "PI_GATEWAY_CLIENTS_FILE", "PI_ALLOWED_HOSTS",
  "PI_ALLOWED_ORIGINS", "PI_CAPABILITIES_FILE", "PI_ARTIFACT_ROOT", "PI_CREDENTIALS_DIR", "PI_POSTGRES_HOST",
  "PI_POSTGRES_DB", "PI_POSTGRES_USER", "PI_GATEWAY_SUBMIT_TIMEOUT_MS", "PI_GATEWAY_SUBMIT_SETTLE_MS",
  "PI_GATEWAY_POLL_MS", "PI_CLOUD_ACCESS_ENABLED",
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
  const browserOrigins = new Set(servedOrigins(env.PI_ALLOWED_ORIGINS, "PI_ALLOWED_ORIGINS").values());
  for (const k of ["PI_GATEWAY_CLIENTS_FILE", "PI_CAPABILITIES_FILE", "PI_ARTIFACT_ROOT", "PI_CREDENTIALS_DIR", "PI_POSTGRES_HOST", "PI_POSTGRES_DB", "PI_POSTGRES_USER"]) {
    if (!env[k]) throw new Error(`${k} is required`);
  }
  const manifest = JSON.parse(readFileSync(env.PI_CAPABILITIES_FILE, "utf8"));
  checkManifest(manifest);
  const pw = readFileSync(`${env.PI_CREDENTIALS_DIR}/gateway_postgres_password`, "utf8").trim();
  if (pw.length < 32) throw new Error("gateway_postgres_password is shorter than 32 characters");
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
    db: { host: env.PI_POSTGRES_HOST, database: env.PI_POSTGRES_DB, user: env.PI_POSTGRES_USER, password: pw },
    build: process.env.FCPI_SOURCE_COMMIT ?? "unknown",
  };
}

// The manifest's limits are checked here, so a mistyped cap stops startup instead of opening a gap.
export function checkManifest(m) {
  if (m.schema !== "fcpi.capabilities/v1") throw new Error("capability manifest: unknown schema");
  const L = m.limits;
  const pos = (v, name, max = Infinity) => { if (!Number.isInteger(v) || v < 1 || v > max) throw new Error(`capability manifest: ${name} must be an integer from 1 to ${max}`); };
  pos(L.bodyBytes, "limits.bodyBytes", 1048576);
  pos(L.crawl.deadlineMinutes, "limits.crawl.deadlineMinutes", 30);
  pos(L.batch.hardMaxUrls, "limits.batch.hardMaxUrls", 100);
  pos(L.batch.maxUrls, "limits.batch.maxUrls", L.batch.hardMaxUrls);
  pos(L.batch.deadlineMinutes, "limits.batch.deadlineMinutes", 30);
  pos(L.admission.maxOpenJobs, "limits.admission.maxOpenJobs", 20);
  pos(L.admission.maxOpenUnits, "limits.admission.maxOpenUnits", 500);
  pos(L.admission.activeUpstreamJobs, "limits.admission.activeUpstreamJobs", 1);
  pos(L.admission.maxSyncInFlight, "limits.admission.maxSyncInFlight", 16);
  pos(L.results.pageMaxLimit, "limits.results.pageMaxLimit", 1000);
  pos(L.results.pageDefaultLimit, "limits.results.pageDefaultLimit", L.results.pageMaxLimit);
  pos(L.results.pageMaxBytes, "limits.results.pageMaxBytes", 10485760);
  pos(L.results.retentionDays, "limits.results.retentionDays", 30);
  pos(L.results.metadataDays, "limits.results.metadataDays", 90);
  pos(L.results.idempotencyHours, "limits.results.idempotencyHours", 72);
  pos(L.results.archiveResponseMaxBytes, "limits.results.archiveResponseMaxBytes", 32 * 1048576);
  pos(L.auth.failuresPerMinute, "limits.auth.failuresPerMinute", 600);
  const crawl = m.bodies.crawl.fields;
  if (crawl.limit.max > 200 || crawl.maxDiscoveryDepth.max > 3) throw new Error("capability manifest: crawl limits exceed spec §23.1's hard caps");
  if (m.bodies.map.fields.limit.max > 1000) throw new Error("capability manifest: map limit exceeds spec §23.1's 1,000");
  for (const r of m.routes) if (!m.scopes.includes(r.scope)) throw new Error(`capability manifest: route ${r.id} names unknown scope ${r.scope}`);
}
