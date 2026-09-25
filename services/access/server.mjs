// FCPI access gateway, M1 scope: the only host-published service.
//   - every route requires a bearer token whose SHA-256 is in the hash file; the
//     gateway never holds a plaintext token;
//   - 401 bodies and challenges are the gateway's own; an upstream WWW-Authenticate
//     (which names Firecrawl Cloud's resource metadata) is never passed through;
//   - only POST /v1/scrape and POST /v2/scrape are routed; /admin/* never is, because
//     upstream's /admin/integration/* proxies to integrations.firecrawl.dev unauthenticated;
//   - until M2's guarded retrieval exists, a scrape target must be one of the
//     configured fixture origins (M1 permits only test-target traffic);
//   - request bodies are capped at 1 MiB before parsing (spec §20.3).
// Full token lifecycle, scopes and Host/Origin policy belong to M3. Node built-ins only.
import { createServer, request as httpRequest } from "node:http";
import { createHash, timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";

const KNOWN = new Set(["PI_GATEWAY_LISTEN_PORT", "PI_CORE_URL", "PI_GATEWAY_TOKEN_HASHES_FILE", "PI_PERMITTED_TARGET_ORIGINS", "PI_CORE_TIMEOUT_MS"]);
function loadConfig(env) {
  const unknown = Object.keys(env).filter((k) => k.startsWith("PI_") && !KNOWN.has(k));
  if (unknown.length) throw new Error(`unknown configuration keys: ${unknown.join(", ")}`);
  const upstream = new URL(env.PI_CORE_URL ?? "");
  if (upstream.protocol !== "http:" || upstream.pathname !== "/") throw new Error("PI_CORE_URL must be an http origin");
  const origins = (env.PI_PERMITTED_TARGET_ORIGINS ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  if (!origins.length || origins.some((o) => new URL(o).origin !== o)) throw new Error("PI_PERMITTED_TARGET_ORIGINS must list exact origins");
  const hashes = readFileSync(env.PI_GATEWAY_TOKEN_HASHES_FILE, "utf8").split("\n").map((l) => l.trim()).filter((l) => l && !l.startsWith("#")).map((l) => {
    const m = l.match(/^([A-Za-z0-9._-]{1,64})\s+sha256:([0-9a-f]{64})$/);
    if (!m) throw new Error("token hash file: each line must be '<label> sha256:<64 hex>'");
    return { label: m[1], digest: Buffer.from(m[2], "hex") };
  });
  if (!hashes.length) throw new Error("token hash file holds no hashes");
  return {
    port: Number(env.PI_GATEWAY_LISTEN_PORT ?? 3300),
    upstream,
    origins: new Set(origins),
    hashes,
    upstreamTimeoutMs: Number(env.PI_CORE_TIMEOUT_MS ?? 120000),
  };
}
const cfg = loadConfig(process.env);

const BODY_CAP = 1024 * 1024;
const DRAIN_CAP = 8 * BODY_CAP;
const ROUTES = new Set(["POST /v1/scrape", "POST /v2/scrape"]);
const HOP = new Set(["connection", "keep-alive", "transfer-encoding", "upgrade", "proxy-authenticate", "proxy-authorization", "te", "trailer", "www-authenticate"]);

// Returns the matching token's label, or null. Every stored digest is compared, in constant time.
function authenticate(header) {
  const m = /^Bearer ([\x21-\x7e]{16,512})$/.exec(header ?? "");
  if (!m) return null;
  const digest = createHash("sha256").update(m[1]).digest();
  let label = null;
  for (const h of cfg.hashes) if (timingSafeEqual(digest, h.digest) && label === null) label = h.label;
  return label;
}

function send(res, status, body, extra = {}) {
  const buf = Buffer.from(JSON.stringify(body));
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "content-length": buf.length, "cache-control": "no-store", ...extra });
  res.end(buf);
}

// Over the cap, stop buffering and reject; the handler answers 413 and closes the
// connection. The remainder is read and discarded (up to DRAIN_CAP) rather than left
// unread, because closing a socket with unread input sends a reset that can destroy the
// 413 before the client reads it. This holds for a declared Content-Length and for a
// chunked body alike.
function readBody(req) {
  return new Promise((resolve, reject) => {
    const tooLarge = () => Object.assign(new Error("too large"), { status: 413 });
    const chunks = [];
    let size = 0;
    let over = Number(req.headers["content-length"] ?? 0) > BODY_CAP;
    req.on("data", (c) => {
      size += c.length;
      if (over) { if (size > DRAIN_CAP) req.destroy(); return; }
      if (size <= BODY_CAP) return chunks.push(c);
      over = true;
      chunks.length = 0;
      reject(tooLarge());
    });
    req.on("end", () => (over ? reject(tooLarge()) : resolve(Buffer.concat(chunks))));
    req.on("error", reject);
    if (over) reject(tooLarge());
  });
}

function targetPermitted(body) {
  let url;
  try { url = new URL(JSON.parse(body.toString("utf8")).url); } catch { return false; }
  return cfg.origins.has(url.origin) && !url.username && !url.password;
}

function forward(req, res, body, log) {
  const up = httpRequest({
    host: cfg.upstream.hostname, port: cfg.upstream.port || 80, method: req.method, path: req.url,
    headers: { "content-type": "application/json", "content-length": body.length, accept: "application/json" },
    timeout: cfg.upstreamTimeoutMs,
  }, (ur) => {
    const headers = {};
    for (const [k, v] of Object.entries(ur.headers)) if (!HOP.has(k)) headers[k] = v;
    res.writeHead(ur.statusCode, headers);
    ur.pipe(res);
    ur.on("end", () => log(ur.statusCode));
  });
  up.on("timeout", () => up.destroy(new Error("upstream timeout")));
  up.on("error", () => { if (!res.headersSent) send(res, 502, { error: "upstream_unavailable" }); log(502); });
  up.end(body);
}

const server = createServer(async (req, res) => {
  const start = process.hrtime.bigint();
  const path = (req.url ?? "").split("?")[0];
  let label = null;
  const log = (status) => console.log(JSON.stringify({ utc: new Date().toISOString(), service: "access-gateway", method: req.method, path, status, client: label, ms: Number(process.hrtime.bigint() - start) / 1e6 }));

  label = authenticate(req.headers.authorization);
  if (!label) { send(res, 401, { error: "unauthorized" }, { "www-authenticate": 'Bearer realm="fcpi"' }); return log(401); }
  if (path === "/admin" || path.startsWith("/admin/") || !ROUTES.has(`${req.method} ${path}`)) { send(res, 404, { error: "not_found" }); return log(404); }

  let body;
  try { body = await readBody(req); } catch (e) { send(res, e.status ?? 400, { error: e.status === 413 ? "body_too_large" : "bad_request" }, { connection: "close" }); return log(e.status ?? 400); }
  if (!targetPermitted(body)) { send(res, 403, { error: "target_not_permitted", detail: "M1 permits only the configured fixture origins" }); return log(403); }
  forward(req, res, body, log);
});
server.headersTimeout = 10000;
server.requestTimeout = cfg.upstreamTimeoutMs + 10000;
server.listen(cfg.port, "0.0.0.0", () => console.log(JSON.stringify({ utc: new Date().toISOString(), service: "access-gateway", listening: cfg.port, tokens: cfg.hashes.length, target_origins: [...cfg.origins] })));
for (const sig of ["SIGTERM", "SIGINT"]) process.on(sig, () => server.close(() => process.exit(0)));
