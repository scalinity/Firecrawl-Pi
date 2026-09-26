// The MCP gateway's configuration (FIRECRAWL_PI_SPEC.md §29): read once at startup, every value checked,
// and any unknown PI_* key stops the process. The REST gateway it calls is a fixed destination (spec
// §20.1); the tools, their limits and the routes they call come from the capability manifest.
import { readFileSync } from "node:fs";

const KNOWN = new Set(["PI_MCP_LISTEN_PORT", "PI_MCP_REST_URL", "PI_CAPABILITIES_FILE", "PI_CLOUD_ACCESS_ENABLED"]);

export function loadConfig(env) {
  const unknown = Object.keys(env).filter((k) => k.startsWith("PI_") && !KNOWN.has(k));
  if (unknown.length) throw new Error(`unknown configuration keys: ${unknown.join(", ")}`);
  if ((env.PI_CLOUD_ACCESS_ENABLED ?? "false") !== "false") throw new Error("PI_CLOUD_ACCESS_ENABLED must be false");
  const rest = new URL(env.PI_MCP_REST_URL ?? "");
  if (rest.protocol !== "http:" || rest.pathname !== "/" || rest.search || rest.username || rest.password) throw new Error("PI_MCP_REST_URL must be an http origin");
  if (!env.PI_CAPABILITIES_FILE) throw new Error("PI_CAPABILITIES_FILE is required");
  const raw = env.PI_MCP_LISTEN_PORT ?? "3400";
  if (!/^\d+$/.test(raw) || Number(raw) > 65535) throw new Error("PI_MCP_LISTEN_PORT must be a port number");
  const manifest = JSON.parse(readFileSync(env.PI_CAPABILITIES_FILE, "utf8"));
  checkMcpManifest(manifest);
  return { port: Number(raw), rest, manifest, build: process.env.FCPI_SOURCE_COMMIT ?? "unknown" };
}

// The manifest's MCP section is checked here, so a tool naming a route that does not exist, or an
// omission that names a route the gateway serves, stops startup instead of registering a broken tool.
export function checkMcpManifest(m) {
  if (m.schema !== "fcpi.capabilities/v1") throw new Error("capability manifest: unknown schema");
  const mcp = m.mcp;
  if (!mcp || mcp.path !== "/mcp") throw new Error("capability manifest: mcp.path must be /mcp");
  if (mcp.protocol?.modern !== "2026-07-28" || mcp.protocol?.legacy !== "2025-11-25" || mcp.protocol?.legacyServing !== "stateless") throw new Error("capability manifest: mcp.protocol must name 2026-07-28, 2025-11-25 and stateless legacy serving");
  const L = mcp.limits ?? {};
  const pos = (k, max) => { if (!Number.isInteger(L[k]) || L[k] < 1 || L[k] > max) throw new Error(`capability manifest: mcp.limits.${k} must be an integer from 1 to ${max}`); };
  pos("maxInFlight", 64); pos("maxToolCalls", 16); pos("exchangeTimeoutMs", 600000); pos("restTimeoutMs", L.exchangeTimeoutMs - 1);
  pos("restResponseMaxBytes", 33554432); pos("toolTextMaxBytes", 1048576); pos("statusPageMax", m.limits.results.pageMaxLimit); pos("statusPageDefault", L.statusPageMax); pos("catalogTtlMs", 3600000);
  const names = new Set();
  for (const t of mcp.tools ?? []) {
    if (!/^firecrawl_[a-z_]{1,48}$/.test(t.name ?? "") || names.has(t.name)) throw new Error(`capability manifest: tool name ${t.name} is invalid or repeated`);
    names.add(t.name);
    if (!m.routes.some((r) => r.id === t.route)) throw new Error(`capability manifest: tool ${t.name} names unknown route ${t.route}`);
    if (typeof t.title !== "string" || typeof t.description !== "string" || !t.annotations) throw new Error(`capability manifest: tool ${t.name} lacks a title, description or annotations`);
  }
  if (!names.size) throw new Error("capability manifest: mcp.tools is empty");
  for (const o of mcp.omitted ?? []) {
    if (names.has(o.name)) throw new Error(`capability manifest: ${o.name} is both a tool and omitted`);
    if (!m.not_enabled.some((r) => r.method === o.method && r.path === o.path)) throw new Error(`capability manifest: omitted ${o.name} names ${o.method} ${o.path}, which is not a not_enabled route`);
  }
}
