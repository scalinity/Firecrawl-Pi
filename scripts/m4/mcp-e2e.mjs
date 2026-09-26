#!/usr/bin/env node
// M4's live evidence driver (docs/FIRECRAWL_PI_MILESTONES.md, M4 "Automated Verification"). It runs on the
// workstation, the machine the owner's agents run on, and reaches /mcp the way they do: through an SSH
// forward of the gateway's loopback publication (127.0.0.1:3380 here to 127.0.0.1:3380 on the Pi), or, in
// the tailnet phase, through Tailscale Serve over TLS. Actions on the Pi (stopping and restarting the MCP
// container, reading logs and the ledger) run over SSH. It prints sectioned JSON lines;
// scripts/m4/verify.mjs recomputes every verdict from them.
//   node scripts/m4/mcp-e2e.mjs <phase> > evidence/M4/raw/e2e-<phase>.txt
// Phases: wire, sdk, cancel, restart, stopped, tailnet.
// Two kinds of client: raw HTTP (node:http, a new TCP connection for every request, the wire exact),
// and the official SDK client 2.1.0 (services/mcp's dev dependency), pinned to 2026-07-28 or left at
// its 2025-11-25 default. Tokens come from /etc/firecrawl-pi/secrets/clients over SSH into memory; none
// is printed, written or put on a command line. Nothing printed carries the Pi's LAN address, SSH target
// or tailnet name.
import { execFileSync, spawn } from "node:child_process";
import { request } from "node:http";
import { request as httpsRequest } from "node:https";
import net, { connect } from "node:net";
import dns from "node:dns";
import { createHash, randomUUID } from "node:crypto";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");
const phase = process.argv[2];
const T = Object.fromEntries(readFileSync(join(ROOT, "scripts/m1/pi-target.conf"), "utf8").split("\n").filter((l) => /^PI_\w+=/.test(l)).map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1).replace("$HOME", process.env.HOME)]));
const SSH = ["-i", T.PI_SSH_KEY, "-o", "IdentitiesOnly=yes", "-o", "BatchMode=yes", "-o", "ConnectTimeout=15"];
const STATE = join(ROOT, "evidence/M4/raw/e2e-state.json");   // ids later phases reuse (no secrets)
const HOST = "127.0.0.1:3380", ORIGIN = `http://${HOST}`, FX = "http://m3.fixture.fcpi.test:8080";
const MODERN = "2026-07-28", LEGACY = "2025-11-25";
const META = { "io.modelcontextprotocol/protocolVersion": MODERN, "io.modelcontextprotocol/clientCapabilities": {}, "io.modelcontextprotocol/clientInfo": { name: "fcpi-m4-raw", version: "1" } };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sha = (s) => createHash("sha256").update(s).digest("hex");
const { Client, StreamableHTTPClientTransport } = await import(pathToFileURL(join(ROOT, "services/mcp/node_modules/@modelcontextprotocol/client/dist/index.mjs")).href);
const clientPkg = JSON.parse(readFileSync(join(ROOT, "services/mcp/node_modules/@modelcontextprotocol/client/package.json"), "utf8"));

// ---- output ----------------------------------------------------------------------------------------
let tailnetHost = null;   // set in the tailnet phase; replaced in everything printed
const hideIds = (s) => [[T.PI_SSH_KEY, "<pi-ssh-key>"], [T.PI_SSH_TARGET, "<pi-ssh-target>"], [T.PI_LAN_ADDRESS, "<pi-lan-address>"], [tailnetHost, "<pi-tailnet-name-host>"], [process.env.HOME, "<home>"]]
  .reduce((x, [a, b]) => (a ? x.split(a).join(b) : x), s)
  .replace(/\b100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.\d{1,3}\.\d{1,3}\b/g, "<tailnet-address>").replace(/\b[a-z0-9-]+\.ts\.net\b/gi, "<pi-tailnet-name-host>");
let current = null;
function out(section, rec) {
  if (section !== current) { process.stdout.write(`### ${section}\n`); current = section; }
  process.stdout.write(`${hideIds(JSON.stringify({ utc: new Date().toISOString(), ...rec }))}\n`);
}

// Every TCP connection the process opens (raw http, https and the SDK's fetch alike) and every name it
// looks up, so a connection to any other host, Firecrawl Cloud's among them, would show.
const seen = [], looked = [];
const origConnect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function (...args) {
  const o = Array.isArray(args[0]) ? args[0][0] : args[0];
  seen.push(o && typeof o === "object" ? (o.path ? `unix:${o.path}` : `${o.host ?? "localhost"}:${o.port}`) : `${typeof args[1] === "string" ? args[1] : "localhost"}:${o}`);
  return origConnect.apply(this, args);
};
const origLookup = dns.lookup;
dns.lookup = function (host, ...rest) { looked.push(String(host)); return origLookup.call(this, host, ...rest); };

// ---- the Pi ----------------------------------------------------------------------------------------
const pi = (cmd, input) => execFileSync("ssh", [...SSH, T.PI_SSH_TARGET, cmd], { encoding: "utf8", input, maxBuffer: 64 * 1024 * 1024 });
const D = (args) => pi(`sudo -n docker ${args}`);
const cname = (svc) => `fcpi-${svc}-1`;
const sql = (q) => pi(`sudo -n docker exec -i ${cname("nuq-postgres")} psql -U postgres -d postgres -q -At -X -F '|' -v ON_ERROR_STOP=1`, q).trim().split("\n").filter(Boolean);
const tokens = {};
const token = (label) => (tokens[label] ??= pi(`sudo -n cat /etc/firecrawl-pi/secrets/clients/${label}.token`).trim());
const health = (svc) => D(`inspect -f '{{.State.Status}} {{if .State.Health}}{{.State.Health.Status}}{{end}}' ${cname(svc)}`).trim();
const startedAt = (svc) => D(`inspect -f '{{.State.StartedAt}}' ${cname(svc)}`).trim();
async function waitHealthy(svc, ms = 180000) {
  const end = Date.now() + ms;
  for (;;) { const h = health(svc); if (h === "running healthy") return h; if (Date.now() > end) throw new Error(`${svc} not healthy: ${h}`); await sleep(1000); }
}
const piNow = () => pi("date -u +%Y-%m-%dT%H:%M:%S.%3NZ").trim();
const jsonLog = (svc, since) => pi(`sudo -n docker logs ${since ? `--since ${since} ` : ""}${cname(svc)} 2>&1`).split("\n").filter((l) => l.startsWith("{")).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
const fixtureLog = (since) => jsonLog("fixture-m3", since).filter((l) => l.path);
const mcpLog = (since) => jsonLog("mcp-gateway", since).filter((l) => l.service === "mcp-gateway");
const gwLog = (since) => jsonLog("access-gateway", since).filter((l) => l.service === "access-gateway");
const resources = (label) => { try { out("resources", JSON.parse(pi(`bash /opt/firecrawl-pi/scripts/m4/pi-resources.sh ${label}`))); } catch (e) { out("error", { message: `resources ${label}: ${e.message}` }); } };
const state = () => (existsSync(STATE) ? JSON.parse(readFileSync(STATE, "utf8")) : {});
const saveState = (o) => writeFileSync(STATE, JSON.stringify({ ...state(), ...o }, null, 2) + "\n");

// ---- the forward -----------------------------------------------------------------------------------
let tunnel = null, tunnelExit = null;
async function openTunnel() {
  const free = await new Promise((r) => { const s = connect(3380, "127.0.0.1"); s.on("connect", () => { s.destroy(); r(false); }); s.on("error", () => r(true)); });
  if (!free) throw new Error("127.0.0.1:3380 is already in use on the workstation");
  tunnel = spawn("ssh", [...SSH, "-N", "-o", "ExitOnForwardFailure=yes", "-L", "127.0.0.1:3380:127.0.0.1:3380", T.PI_SSH_TARGET], { stdio: "ignore" });
  tunnel.on("exit", (code, signal) => { tunnelExit = { code, signal }; });
  for (let i = 0; i < 60; i++) {
    if (await new Promise((r) => { const s = connect(3380, "127.0.0.1"); s.on("connect", () => { s.destroy(); r(true); }); s.on("error", () => r(false)); })) return;
    await sleep(250);
  }
  throw new Error("the SSH forward did not open");
}

// ---- raw HTTP: one new TCP connection per request ---------------------------------------------------
// `base` is the origin (the forward, or the tailnet's https origin); the Host header is the origin's
// unless a case overrides it.
let BASE = ORIGIN;
function raw(method, { tok, headers = {}, body, path = "/mcp", signal, abortAfterMs } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(path, BASE);
    const data = body === undefined ? undefined : Buffer.isBuffer(body) ? body : Buffer.from(typeof body === "string" ? body : JSON.stringify(body));
    const mod = u.protocol === "https:" ? httpsRequest : request;
    let localPort = null;
    const req = mod({ host: u.hostname, port: u.port, method, path: u.pathname, agent: false, servername: u.hostname, timeout: 180000,
      headers: { host: u.host, accept: "application/json, text/event-stream", ...(tok ? { authorization: `Bearer ${token(tok)}` } : {}), ...(data ? { "content-type": "application/json", "content-length": data.length } : {}), ...headers } }, (res) => {
      const chunks = [], times = [];
      res.on("data", (c) => { chunks.push(c); times.push(Date.now()); });
      res.on("end", () => {
        const text = Buffer.concat(chunks).toString();
        const sse = /text\/event-stream/.test(res.headers["content-type"] ?? "");
        let messages = [];
        try { messages = sse ? text.split("\n").filter((l) => l.startsWith("data: ")).map((l) => JSON.parse(l.slice(6))) : text ? [JSON.parse(text)] : []; } catch { /* not JSON */ }
        resolve({ status: res.statusCode, headers: res.headers, sse, messages, last: messages.at(-1) ?? null, text, localPort, chunks: times.length, spreadMs: times.length ? times.at(-1) - times[0] : 0,
          tls: res.socket?.getProtocol?.() ?? null, tlsAuthorized: res.socket?.authorized ?? null, cert: res.socket?.getPeerCertificate?.()?.subject?.CN ?? null });
      });
    });
    req.on("socket", (s) => s.on("connect", () => { localPort = s.localPort; }));
    signal?.addEventListener("abort", () => req.destroy(new Error("aborted")));
    if (abortAfterMs) setTimeout(() => req.destroy(new Error("aborted")), abortAfterMs);
    req.on("timeout", () => req.destroy(new Error("timeout")));
    req.on("error", (e) => (/aborted/.test(e.message) ? resolve({ aborted: true, localPort }) : reject(e)));
    req.end(data);
  });
}
const modern = (method, params = {}, { tok = "m4a", headers = {}, id = 1, meta = META, ...o } = {}) => raw("POST", { tok, ...o,
  headers: { "mcp-protocol-version": MODERN, "mcp-method": method, ...(method === "tools/call" ? { "mcp-name": params.name } : {}), ...headers },
  body: { jsonrpc: "2.0", id, method, params: { ...params, _meta: { ...meta, ...(params._meta ?? {}) } } } });
const call = (name, args, o = {}) => modern("tools/call", { name, arguments: args, ...(o.progress ? { _meta: { progressToken: o.progress } } : {}) }, o);
const legacyPost = (method, params, { tok = "m4a", id = 1, init = false, abortAfterMs } = {}) => raw("POST", { tok, abortAfterMs, headers: init ? {} : { "mcp-protocol-version": LEGACY }, body: { jsonrpc: "2.0", id, method, ...(params ? { params } : {}) } });
const toolText = (r) => r?.last?.result?.content?.[0]?.text ?? null;
const payloadOf = (r) => { try { return JSON.parse(toolText(r)); } catch { return null; } };
const sentinel = (s) => (String(s ?? "").match(/fcpi-m3-[a-z0-9]+-[0-9a-f]{4}/) ?? [null])[0];
// A raw exchange, as recorded: status, the gateway's request id, content type, SSE or not, the session
// header, the JSON-RPC error code, the tool result's error flag, and the connection's local port.
const wire = (r, extra = {}) => r.aborted ? { aborted: true, local_port: r.localPort, ...extra } : ({ status: r.status, request_id: r.headers["x-request-id"] ?? null, content_type: r.headers["content-type"] ?? null, sse: r.sse,
  session_header: r.headers["mcp-session-id"] ?? null, www_authenticate: r.headers["www-authenticate"] ?? null, acao: r.headers["access-control-allow-origin"] ?? null, code: r.last?.code ?? null,
  rpc_error: r.last?.error && typeof r.last.error === "object" ? { code: r.last.error.code, message: String(r.last.error.message).slice(0, 160) } : null, result_type: r.last?.result?.resultType ?? null,
  is_error: r.last?.result?.isError ?? null, local_port: r.localPort, ...extra });

// ---- the SDK client ----------------------------------------------------------------------------------
// The transport's fetch is wrapped to record each exchange's headers and outcome (never the token).
function sdkClient(name, { tok, pin, base = BASE }) {
  const exchanges = [];
  // Recorded before the request is sent and completed when it answers, so an aborted call is recorded too.
  const recFetch = async (url, init = {}) => {
    const h = new Headers(init.headers);
    let body = null; try { body = typeof init.body === "string" ? JSON.parse(init.body) : null; } catch { /* not JSON */ }
    const x = { http_method: init.method ?? "GET", mcp_method: h.get("mcp-method"), mcp_name: h.get("mcp-name"), protocol_header: h.get("mcp-protocol-version"),
      body_method: Array.isArray(body) ? "batch" : body?.method ?? null, body_id: body?.id ?? null, envelope_version: body?.params?._meta?.["io.modelcontextprotocol/protocolVersion"] ?? null,
      status: null, content_type: null, session_header: null, request_id: null, failed: null };
    exchanges.push(x);
    try {
      const r = await fetch(url, init);
      Object.assign(x, { status: r.status, content_type: r.headers.get("content-type"), session_header: r.headers.get("mcp-session-id"), request_id: r.headers.get("x-request-id") });
      return r;
    } catch (e) { x.failed = e.name; throw e; }
  };
  const client = new Client({ name, version: "1" }, pin ? { versionNegotiation: { mode: { pin } } } : {});
  const transport = new StreamableHTTPClientTransport(new URL("/mcp", base), { fetch: recFetch, requestInit: { headers: { authorization: `Bearer ${token(tok)}` } } });
  return { client, transport, exchanges, connect: (opts) => client.connect(transport, opts) };
}
const sdkPayload = (res) => { try { return JSON.parse(res.content[0].text); } catch { return null; } };
async function pollSdk(c, tool, id, ms = 600000) {
  const end = Date.now() + ms;
  for (;;) {
    const p = sdkPayload(await c.callTool({ name: tool, arguments: { id, limit: 20 } }));
    if (["completed", "failed", "cancelled"].includes(p?.status)) return p;
    if (Date.now() > end) throw new Error(`${tool} ${id} did not finish (last ${p?.status})`);
    await sleep(2000);
  }
}
async function pollRaw(tool, id, tok = "m4a", ms = 600000) {
  const end = Date.now() + ms, ports = [];
  for (;;) {
    const r = await call(tool, { id, limit: 20 }, { tok });
    ports.push(r.localPort);
    const p = payloadOf(r);
    if (["completed", "failed", "cancelled"].includes(p?.status)) return { r, p, ports };
    if (Date.now() > end) throw new Error(`${tool} ${id} did not finish (last ${p?.status})`);
    await sleep(2000);
  }
}
const toolRecs = (since, pred = () => true) => mcpLog(since).filter((l) => l.event === "tool" && pred(l));

// ---- phases ----------------------------------------------------------------------------------------
const PHASES = {
  // The raw wire matrix: authorization and boundary cases, discovery, the catalog, JSON and SSE, header
  // and body validation, the 2025-era fallback, subscriptions, scopes and the payload bound.
  async wire() {
    const since = piNow();
    const rejectedIds = [];
    for (const [c, opts] of [["missing", {}], ["invalid", { headers: { authorization: `Bearer fcpi_zz_${randomUUID().replace(/-/g, "").repeat(2)}` } }],
      ["basic_scheme", { headers: { authorization: `Basic ${Buffer.from("m4a:x").toString("base64")}` } }]]) {
      const r = await modern("tools/list", {}, { tok: null, ...opts });
      rejectedIds.push(r.headers["x-request-id"]);
      out("boundary", { case: `token_${c}`, ...wire(r) });
    }
    for (const [c, headers] of [["foreign_host", { host: "rebind.example:3380" }], ["foreign_origin", { origin: "https://evil.example" }], ["null_origin", { origin: "null" }]]) {
      const r = await modern("tools/list", {}, { headers });
      rejectedIds.push(r.headers["x-request-id"]);
      out("boundary", { case: c, ...wire(r) });
    }
    // Over the gateway's 1 MiB cap: refused before anything is parsed (D5 obligation 2).
    const big = Buffer.from(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: { _meta: META, pad: "x".repeat(1048576) } }));
    const b = await raw("POST", { tok: "m4a", headers: { "mcp-protocol-version": MODERN, "mcp-method": "tools/list" }, body: big });
    rejectedIds.push(b.headers["x-request-id"]);
    out("boundary", { case: "body_over_cap", body_bytes: big.length, ...wire(b) });
    // A client's own identity headers never reach the MCP service: the gateway sends the validated one.
    const spoof = await modern("tools/list", {}, { headers: { "x-fcpi-principal": "m4-other", "x-fcpi-client": "forged", "x-fcpi-scopes": "read" } });
    out("boundary", { case: "spoofed_identity_headers", ...wire(spoof) });
    const ok = await modern("tools/list", {});
    out("boundary", { case: "valid_control", ...wire(ok) });

    // Discovery and the catalog.
    const d = await modern("server/discover");
    const dr = d.last?.result ?? {};
    out("discovery", { case: "server_discover", ...wire(d), supported_versions: dr.supportedVersions ?? null, capabilities: dr.capabilities ?? null, ttl_ms: dr.ttlMs ?? null, cache_scope: dr.cacheScope ?? null,
      server_info: dr._meta?.["io.modelcontextprotocol/serverInfo"] ?? null, instructions_sha256: dr.instructions ? sha(dr.instructions) : null });
    const lists = [await modern("tools/list", {}, { id: 2 }), await modern("tools/list", {}, { id: 3, tok: "m4b" })];
    await legacyPost("initialize", { protocolVersion: LEGACY, capabilities: {}, clientInfo: { name: "fcpi-m4-raw-legacy", version: "1" } }, { id: 0, init: true });
    lists.push(await legacyPost("tools/list", undefined, { id: 4 }));
    for (const [i, r] of lists.entries()) {
      const tools = r.last?.result?.tools ?? [];
      out("catalog", { case: ["modern_m4a", "modern_m4b", "legacy_m4a"][i], ...wire(r), tools: tools.map((t) => t.name), tools_sha256: sha(JSON.stringify(tools)), ttl_ms: r.last?.result?.ttlMs ?? null, cache_scope: r.last?.result?.cacheScope ?? null,
        annotations: Object.fromEntries(tools.map((t) => [t.name, t.annotations ?? null])), schema_keys: Object.fromEntries(tools.map((t) => [t.name, Object.keys(t.inputSchema?.properties ?? {}).sort()])) });
    }

    // A direct tools/call on a fresh connection, with no discovery or initialize on it: JSON.
    const s = await call("firecrawl_scrape", { url: `${FX}/p02`, formats: ["markdown"] });
    out("calls", { case: "direct_modern_scrape", ...wire(s), sentinel: sentinel(payloadOf(s)?.data?.markdown), server_info: s.last?.result?._meta?.["io.modelcontextprotocol/serverInfo"] ?? null });
    // A caller that asks for progress: a request-scoped SSE stream, the notification before the result.
    const p = await call("firecrawl_scrape", { url: `${FX}/p03`, formats: ["markdown"] }, { progress: "m4-progress-1" });
    out("calls", { case: "progress_sse_scrape", ...wire(p), messages: p.messages.map((m) => m.method ?? (m.result ? "result" : "error")), progress_token: p.messages[0]?.params?.progressToken ?? null, sentinel: sentinel(payloadOf(p)?.data?.markdown) });

    // Malformed, missing and mismatched modern metadata: each rejected by the modern path. Every case
    // names a fixture URL with its own marker; none may reach the fixture (the control's does).
    const args = (m) => ({ name: "firecrawl_scrape", arguments: { url: `${FX}/p04?m4=${m}` } });
    const body = (params, id = 5) => ({ jsonrpc: "2.0", id, method: "tools/call", params });
    const H = (h) => ({ ...h });
    const cases = [
      ["missing_protocol_version_header", (m) => [H({ "mcp-method": "tools/call", "mcp-name": "firecrawl_scrape" }), body({ ...args(m), _meta: META })]],
      ["missing_method_header", (m) => [H({ "mcp-protocol-version": MODERN, "mcp-name": "firecrawl_scrape" }), body({ ...args(m), _meta: META })]],
      ["method_header_mismatch", (m) => [H({ "mcp-protocol-version": MODERN, "mcp-method": "tools/list", "mcp-name": "firecrawl_scrape" }), body({ ...args(m), _meta: META })]],
      ["name_header_mismatch", (m) => [H({ "mcp-protocol-version": MODERN, "mcp-method": "tools/call", "mcp-name": "firecrawl_map" }), body({ ...args(m), _meta: META })]],
      ["version_header_body_mismatch", (m) => [H({ "mcp-protocol-version": LEGACY, "mcp-method": "tools/call", "mcp-name": "firecrawl_scrape" }), body({ ...args(m), _meta: META })]],
      ["modern_header_without_envelope", (m) => [H({ "mcp-protocol-version": MODERN, "mcp-method": "tools/call", "mcp-name": "firecrawl_scrape" }), body(args(m))]],
      ["malformed_envelope", (m) => [H({ "mcp-protocol-version": MODERN, "mcp-method": "tools/call", "mcp-name": "firecrawl_scrape" }), body({ ...args(m), _meta: { ...META, "io.modelcontextprotocol/clientCapabilities": "all" } })]],
      ["unsupported_revision", (m) => [H({ "mcp-protocol-version": "2099-01-01", "mcp-method": "tools/call", "mcp-name": "firecrawl_scrape" }), body({ ...args(m), _meta: { ...META, "io.modelcontextprotocol/protocolVersion": "2099-01-01" } })]],
      ["not_json", () => [H({ "mcp-protocol-version": MODERN, "mcp-method": "tools/call" }), "{not json"]],
    ];
    const markers = {};
    for (const [c, make] of cases) {
      const m = `${c}-${randomUUID().slice(0, 8)}`;
      markers[c] = m;
      const [headers, bd] = make(m);
      const r = await raw("POST", { tok: "m4a", headers, body: bd });
      out("validation", { case: c, marker: m, ...wire(r) });
    }
    const control = `control-${randomUUID().slice(0, 8)}`;
    const cr = await call("firecrawl_scrape", { url: `${FX}/p04?m4=${control}` });
    out("validation", { case: "well_formed_control", marker: control, ...wire(cr), sentinel: sentinel(payloadOf(cr)?.data?.markdown) });

    // The 2025-11-25 fallback on the same endpoint: initialize, then calls with no session.
    const init = await legacyPost("initialize", { protocolVersion: LEGACY, capabilities: {}, clientInfo: { name: "fcpi-m4-raw-legacy", version: "1" } }, { id: 0, init: true });
    out("legacy", { case: "initialize", ...wire(init), protocol_version: init.last?.result?.protocolVersion ?? null, server_info: init.last?.result?.serverInfo ?? null, capabilities: init.last?.result?.capabilities ?? null });
    const ls = await legacyPost("tools/call", { name: "firecrawl_scrape", arguments: { url: `${FX}/p05` } }, { id: 1 });
    out("legacy", { case: "tools_call_scrape", ...wire(ls), sentinel: sentinel(payloadOf(ls)?.data?.markdown) });
    for (const m of ["GET", "DELETE"]) out("legacy", { case: `http_${m.toLowerCase()}`, ...wire(await raw(m, { tok: "m4a", headers: { "mcp-protocol-version": LEGACY } })) });
    out("legacy", { case: "modern_get", ...wire(await raw("GET", { tok: "m4a", headers: { "mcp-protocol-version": MODERN } })) });
    out("subscriptions", { case: "listen_refused", ...wire(await modern("subscriptions/listen", { notifications: { toolsListChanged: true } })) });

    // Scopes: the gateway's own refusal comes back as a tool error; the read-only token's read works.
    const ro = await call("firecrawl_scrape", { url: `${FX}/p06` }, { tok: "m4ro" });
    out("scopes", { case: "read_only_scrape", ...wire(ro), error: payloadOf(ro)?.error ?? null });
    const roOk = await call("firecrawl_capabilities", {}, { tok: "m4ro" });
    const caps = payloadOf(roOk);
    out("scopes", { case: "read_only_capabilities", ...wire(roOk), core_live: caps?.core?.live ?? null, omitted: caps?.mcp?.omitted ?? null, mcp_tools: caps?.mcp?.tools ?? null });
    const invalid = await call("firecrawl_scrape", { url: `${FX}/p06`, formats: ["screenshot"] });
    out("scopes", { case: "schema_refused_option", ...wire(invalid), text: toolText(invalid)?.slice(0, 200) ?? null });

    // The payload bound: a 100 KiB page in three formats (about 300 KiB) comes back cut, and says what was
    // cut. (A 600 KiB page aborts the core's API process at its heap cap: evidence/M4/raw/core-heap-probe*.txt.)
    const bg = await call("firecrawl_scrape", { url: `${FX}/big?kb=100`, formats: ["markdown", "html", "rawHtml"] });
    const bp = payloadOf(bg);
    out("bound", { case: "big_page", ...wire(bg), text_bytes: Buffer.byteLength(toolText(bg) ?? ""), truncated: bp?.truncated?.fields ?? null, sentinel: sentinel(bp?.data?.markdown) });

    // What the Pi saw: the fixture requests, the MCP service's records for the rejected requests, and the
    // gateway's records.
    await sleep(1500);
    const fx = fixtureLog(since);
    out("pi_view", { case: "fixture_markers", seen: Object.fromEntries([...Object.entries(markers), ["well_formed_control", control]].map(([c, m]) => [c, fx.filter((l) => (l.query ?? "").includes(m)).length])) });
    const ml = mcpLog(since);
    out("pi_view", { case: "mcp_records_for_gateway_refusals", request_ids: rejectedIds.length, mcp_records: ml.filter((l) => rejectedIds.includes(l.request_id)).length, mcp_exchanges_in_window: ml.filter((l) => l.event === "exchange").length });
    const spoofRec = ml.find((l) => l.event === "exchange" && l.request_id === spoof.headers["x-request-id"]);
    out("pi_view", { case: "spoofed_identity_as_logged", client: spoofRec?.client ?? null, principal: spoofRec?.principal ?? null });
    out("pi_view", { case: "tool_records", records: ml.filter((l) => l.event === "tool").map((l) => ({ request_id: l.request_id, era: l.era, protocol_version: l.protocol_version, tool: l.tool, client: l.client, outcome: l.outcome, downstream: l.downstream })) });
    out("pi_view", { case: "exchange_records", records: ml.filter((l) => l.event === "exchange").map((l) => ({ request_id: l.request_id, http_method: l.http_method, mcp_method: l.mcp_method, protocol_version: l.protocol_version, status: l.status, content_type: l.content_type, session_header_sent: l.session_header_sent })) });
    out("pi_view", { case: "serve_records", eras: ml.filter((l) => l.event === "serve").reduce((a, l) => ({ ...a, [l.era]: (a[l.era] ?? 0) + 1 }), {}) });
    const gl = gwLog(since).filter((l) => l.request_id);
    out("pi_view", { case: "gateway_records", records: gl.map((l) => ({ request_id: l.request_id, method: l.method, route: l.route, status: l.status, code: l.code, client: l.client, mcp_method: l.mcp_method ?? null })) });
  },

  // The official SDK client in both eras, two independent clients at once, idempotency and owner isolation.
  async sdk() {
    const since = piNow();
    const A = sdkClient("fcpi-m4-modern", { tok: "m4a", pin: MODERN });
    await A.connect();
    out("modern", { case: "connected", client: `${clientPkg.name}@${clientPkg.version}`, negotiated: A.client.getNegotiatedProtocolVersion?.() ?? null, server: A.client.getServerVersion?.() ?? null, capabilities: A.client.getServerCapabilities?.() ?? null });
    const tl = await A.client.listTools();
    out("modern", { case: "list_tools", tools: tl.tools.map((t) => t.name), tools_sha256: sha(JSON.stringify(tl.tools)) });
    const sc = sdkPayload(await A.client.callTool({ name: "firecrawl_scrape", arguments: { url: `${FX}/p07`, formats: ["markdown", "links"] } }));
    out("modern", { case: "scrape", sentinel: sentinel(sc?.data?.markdown), links: sc?.data?.links?.length ?? null });
    const mp = sdkPayload(await A.client.callTool({ name: "firecrawl_map", arguments: { url: `${FX}/` } }));
    out("modern", { case: "map", links: (mp?.links ?? []).map((l) => (typeof l === "string" ? l : l.url)).sort() });
    const key = `m4-sdk-${randomUUID().slice(0, 12)}`;
    const c1 = sdkPayload(await A.client.callTool({ name: "firecrawl_crawl", arguments: { url: `${FX}/`, limit: 4, sitemap: "include", idempotencyKey: key } }));
    const c2 = sdkPayload(await A.client.callTool({ name: "firecrawl_crawl", arguments: { url: `${FX}/`, limit: 4, sitemap: "include", idempotencyKey: key } }));
    out("modern", { case: "crawl_twice_same_key", id: c2?.id ?? null, first_id: c1?.id ?? null, results_on_private_origin: String(c1?.results ?? "").startsWith(`${ORIGIN}/v2/crawl/`) });
    const conflict = await A.client.callTool({ name: "firecrawl_crawl", arguments: { url: `${FX}/`, limit: 3, sitemap: "include", idempotencyKey: key } });
    out("modern", { case: "same_key_other_arguments", is_error: conflict.isError ?? false, error: sdkPayload(conflict)?.error ?? null });
    const st = await pollSdk(A.client, "firecrawl_check_crawl_status", c1.id);
    out("modern", { case: "crawl_status", id: c1.id, status: st.status, completed: st.completed, returned: st.returned, next_skip: st.nextSkip, sentinels: st.data.map((d) => sentinel(d.markdown)).sort() });
    saveState({ finishedCrawl: c1.id });
    // The ledger finishes a job on its next poll after the core does: read the receipt until it has.
    let rc = null;
    for (let i = 0; i < 60; i++) { rc = sdkPayload(await A.client.callTool({ name: "firecrawl_get_result", arguments: { id: c1.id } })); if (["SUCCEEDED", "PARTIAL", "FAILED", "CANCELLED"].includes(rc?.state)) break; await sleep(2000); }
    out("modern", { case: "receipt", id: rc?.id ?? null, state: rc?.state ?? null, transitions: (rc?.events ?? []).map((e) => `${e.from ?? "-"}>${e.to}`) });
    const ledger = sql(`SELECT count(*) FROM fcpi_platform.idempotency WHERE key = '${key}';`)[0];
    out("modern", { case: "ledger_jobs_for_key", key_rows: Number(ledger) });
    out("modern_wire", { exchanges: A.exchanges });

    // The 2025-11-25 client: its own principal.
    const L = sdkClient("fcpi-m4-legacy", { tok: "m4b" });
    await L.connect();
    out("legacy", { case: "connected", negotiated: L.client.getNegotiatedProtocolVersion?.() ?? null, server: L.client.getServerVersion?.() ?? null });
    const ll = await L.client.listTools();
    out("legacy", { case: "list_tools", tools: ll.tools.map((t) => t.name), tools_sha256: sha(JSON.stringify(ll.tools)) });
    const ls = sdkPayload(await L.client.callTool({ name: "firecrawl_scrape", arguments: { url: `${FX}/p08` } }));
    out("legacy", { case: "scrape", sentinel: sentinel(ls?.data?.markdown) });
    const lc = sdkPayload(await L.client.callTool({ name: "firecrawl_crawl", arguments: { url: `${FX}/`, limit: 2, sitemap: "include" } }));
    const lst = await pollSdk(L.client, "firecrawl_check_crawl_status", lc.id);
    out("legacy", { case: "crawl_status", id: lc.id, status: lst.status, completed: lst.completed, returned: lst.returned });
    // Another principal's job answers exactly as an unknown id does.
    const foreign = await L.client.callTool({ name: "firecrawl_check_crawl_status", arguments: { id: c1.id } });
    const unknown = await L.client.callTool({ name: "firecrawl_check_crawl_status", arguments: { id: randomUUID() } });
    out("legacy", { case: "other_principals_job", is_error: foreign.isError ?? false, error: sdkPayload(foreign)?.error ?? null, unknown_error: sdkPayload(unknown)?.error ?? null, identical: JSON.stringify(sdkPayload(foreign)?.error) === JSON.stringify(sdkPayload(unknown)?.error) });
    out("legacy_wire", { exchanges: L.exchanges });

    // Two independent clients on the same endpoint at once: a modern one and a second modern one on
    // another principal, each with its own token and connection pool.
    const B = sdkClient("fcpi-m4-modern-b", { tok: "m4b", pin: MODERN });
    await B.connect();
    const t = (c, url) => (async () => { const t0 = Date.now(); const p = sdkPayload(await c.client.callTool({ name: "firecrawl_scrape", arguments: { url } })); return { t0, t1: Date.now(), sentinel: sentinel(p?.data?.markdown) }; })();
    const [ra, rb] = await Promise.all([t(A, `${FX}/p09`), t(B, `${FX}/p10`)]);
    out("concurrent", { case: "two_clients", a: ra, b: rb, overlap_ms: Math.min(ra.t1, rb.t1) - Math.max(ra.t0, rb.t0) });
    await sleep(1500);
    const tr = toolRecs(since);
    out("pi_view", { case: "tool_records", records: tr.map((l) => ({ era: l.era, protocol_version: l.protocol_version, tool: l.tool, client: l.client, principal: l.principal, outcome: l.outcome, downstream: l.downstream })) });
    out("pi_view", { case: "serve_records", eras: mcpLog(since).filter((l) => l.event === "serve").reduce((a, l) => ({ ...a, [l.era]: (a[l.era] ?? 0) + 1 }), {}) });
    await Promise.all([A.client.close(), L.client.close(), B.client.close()]);
  },

  // Request-local cancellation in both eras (the modern one on request id 0, D5 obligation 3), and the
  // durable crawl cancellation. The fixture logs a request when it answers, so its start is that time
  // less the page's known delay; every compared time is the Pi's clock.
  async cancel() {
    // A pinned client adopting a discover result it already holds sends no probe, so its first request
    // is tools/call with id 0.
    const d = await modern("server/discover");
    const C = sdkClient("fcpi-m4-cancel", { tok: "m4a", pin: MODERN });
    await C.connect({ prior: { kind: "modern", discover: d.last.result } });
    const DELAY = 10000;   // under the retrieval service's 15 s HTTP attempt ceiling (spec §9.3)
    // The modern client closes its request's stream; the 2025-era SDK client sends notifications/cancelled
    // instead (its protocol has no per-request abort), which stateless serving hands to a fresh instance
    // that holds nothing of the running request: that one runs on, and the record says so.
    for (const [era, cl] of [["modern", C], ["legacy_sdk_notification", null]]) {
      const client = cl ?? sdkClient("fcpi-m4-cancel-legacy", { tok: "m4a" });
      if (!cl) await client.connect();
      const marker = `cancel-${era}-${randomUUID().slice(0, 8)}`;
      const since = piNow();
      const ac = new AbortController();
      const p = client.client.callTool({ name: "firecrawl_scrape", arguments: { url: `${FX}/delay?ms=${DELAY}&m4=${marker}` } }, { signal: ac.signal }).then(() => "answered", (e) => `rejected:${e.name}`);
      await sleep(3000);
      const abortAt = piNow();
      ac.abort();
      const outcome = await p;
      await sleep(DELAY);   // the fixture answers its held request and logs it
      const ex = client.exchanges.filter((e) => e.body_method === "tools/call").at(-1);
      const rec = toolRecs(since, (l) => l.tool === "firecrawl_scrape").at(-1);
      const gw = gwLog(since);
      out("request_cancel", { case: era, marker, abort_at: abortAt, client_outcome: outcome, body_id: ex?.body_id ?? null, exchange_failed: ex?.failed ?? null,
        fixture: fixtureLog(since).filter((l) => (l.query ?? "").includes(marker)).map((l) => ({ answered: l.utc, started: new Date(Date.parse(l.utc) - DELAY).toISOString() })),
        mcp_tool_record: rec ? { request_id: rec.request_id, jsonrpc_id: rec.jsonrpc_id, era: rec.era, outcome: rec.outcome, downstream: rec.downstream, utc: rec.utc } : null,
        gateway_mcp_exchanges: gw.filter((l) => l.route === "mcp" && l.request_id === rec?.request_id).map((l) => ({ status: l.status, mcp_method: l.mcp_method })),
        gateway_scrape_records: gw.filter((l) => l.route === "scrape").map((l) => ({ status: l.status, client: l.client, utc: l.utc })),
        cancel_notifications: gw.filter((l) => l.route === "mcp" && l.status === 202 && Date.parse(l.utc) >= Date.parse(abortAt)).length });
      if (!cl) await client.client.close();
    }
    await C.client.close();
    // A 2025-era request whose connection closes mid-call is cancelled like a modern one: the transport's
    // own semantics, through the gateway.
    {
      const marker = `cancel-legacy-close-${randomUUID().slice(0, 8)}`;
      const since = piNow();
      const r = await legacyPost("tools/call", { name: "firecrawl_scrape", arguments: { url: `${FX}/delay?ms=${DELAY}&m4=${marker}` } }, { id: 0, abortAfterMs: 3000 });
      const abortAt = piNow();
      await sleep(DELAY);
      const rec = toolRecs(since, (l) => l.tool === "firecrawl_scrape").at(-1);
      const gw = gwLog(since);
      out("request_cancel", { case: "legacy_connection_close", marker, abort_at: abortAt, client_outcome: r.aborted ? "closed" : `answered:${r.status}`,
        fixture: fixtureLog(since).filter((l) => (l.query ?? "").includes(marker)).map((l) => ({ answered: l.utc, started: new Date(Date.parse(l.utc) - DELAY).toISOString() })),
        mcp_tool_record: rec ? { request_id: rec.request_id, jsonrpc_id: rec.jsonrpc_id, era: rec.era, outcome: rec.outcome, downstream: rec.downstream, utc: rec.utc } : null,
        gateway_mcp_exchanges: gw.filter((l) => l.route === "mcp" && l.request_id === rec?.request_id).map((l) => ({ status: l.status, mcp_method: l.mcp_method })),
        gateway_scrape_records: gw.filter((l) => l.route === "scrape").map((l) => ({ status: l.status, client: l.client, utc: l.utc })) });
    }
    // The durable crawl cancellation, as M3's J07 measures it: no slow page starts more than 2.5 s after
    // the cancel. Each slow page answers after 2 s.
    const since = piNow();
    const cr = await call("firecrawl_crawl", { url: `${FX}/slow/`, limit: 30, sitemap: "skip" });
    const id = payloadOf(cr)?.id;
    await sleep(6000);
    const cancelAt = piNow();
    const k1 = await call("firecrawl_cancel_crawl", { id });
    const k2 = await call("firecrawl_cancel_crawl", { id });
    let st = null, rc = null;
    for (let i = 0; i < 60; i++) { st = payloadOf(await call("firecrawl_check_crawl_status", { id })); if (st?.status === "cancelled") break; await sleep(1000); }
    for (let i = 0; i < 60; i++) { rc = payloadOf(await call("firecrawl_get_result", { id })); if (rc?.state === "CANCELLED") break; await sleep(1000); }
    await sleep(5000);
    const pages = fixtureLog(since).filter((l) => /^\/slow\/s\d+$/.test(l.path)).map((l) => ({ path: l.path, answered: l.utc, started: new Date(Date.parse(l.utc) - 2000).toISOString() }));
    out("crawl_cancel", { case: "slow_crawl", id, cancel_at: cancelAt, cancel: payloadOf(k1), cancel_again: payloadOf(k2), status: st?.status ?? null, receipt_state: rc?.state ?? null,
      archived: rc?.archived ?? null, completed: rc?.completed ?? null, fixture_requests: pages });
    // A finished crawl cannot be cancelled: the gateway's 409, as a tool error.
    const done = state().finishedCrawl;
    const fin = done ? await call("firecrawl_cancel_crawl", { id: done }) : null;
    out("crawl_cancel", { case: "finished_crawl", id: done ?? null, ...(fin ? wire(fin) : {}), error: fin ? payloadOf(fin)?.error ?? null : null });
  },

  // The MCP service restarted between a crawl and its status, and every related call on its own TCP
  // connection: the job handle is resolved by the new process, with no session to recover.
  async restart() {
    const since = piNow();
    const A = sdkClient("fcpi-m4-restart", { tok: "m4a", pin: MODERN });
    await A.connect();
    const before = { started_at: startedAt("mcp-gateway"), gateway_started_at: startedAt("access-gateway") };
    const cr = await call("firecrawl_crawl", { url: `${FX}/slow/`, limit: 6, sitemap: "skip" });
    const id = payloadOf(cr)?.id;
    const sdkCrawl = sdkPayload(await A.client.callTool({ name: "firecrawl_crawl", arguments: { url: `${FX}/`, limit: 3, sitemap: "include" } }));
    out("before_restart", { case: "crawl_started", id, sdk_id: sdkCrawl?.id ?? null, ...wire(cr), ...before });
    resources("before-mcp-restart");
    D(`restart -t 10 ${cname("mcp-gateway")}`);
    const restartedAt = new Date().toISOString();
    // REST keeps serving while the MCP service comes back.
    const rest = await raw("GET", { tok: "m4a", path: `/v2/crawl/${id}` });
    out("during_restart", { case: "rest_crawl_status", status: rest.status, body_status: JSON.parse(rest.text || "{}").status ?? null });
    await waitHealthy("mcp-gateway");
    const after = { started_at: startedAt("mcp-gateway"), gateway_started_at: startedAt("access-gateway") };
    out("after_restart", { case: "restarted", restarted_at: restartedAt, ...after, started_changed: after.started_at !== before.started_at, gateway_unchanged: after.gateway_started_at === before.gateway_started_at });
    const { r, p, ports } = await pollRaw("firecrawl_check_crawl_status", id);
    out("after_restart", { case: "status_new_connection", id, ...wire(r), status: p.status, completed: p.completed, returned: p.returned, crawl_local_port: cr.localPort, status_local_ports: ports });
    // The client that existed before the restart carries on with the handle it holds: nothing to rebuild.
    const sst = await pollSdk(A.client, "firecrawl_check_crawl_status", sdkCrawl.id);
    out("after_restart", { case: "sdk_client_across_restart", id: sdkCrawl.id, status: sst.status, completed: sst.completed, exchanges_with_session: A.exchanges.filter((e) => e.session_header).length, initialize_sent: A.exchanges.some((e) => e.body_method === "initialize") });
    await sleep(1500);
    const tr = toolRecs(since, (l) => l.job === id);
    const instances = [...new Set(mcpLog(since).filter((l) => l.event === "listening").map((l) => l.instance))];
    const crawlRec = tr.find((l) => l.tool === "firecrawl_crawl"), statusRecs = tr.filter((l) => l.tool === "firecrawl_check_crawl_status");
    out("pi_view", { case: "instances", crawl_instance: crawlRec?.instance ?? null, status_instances: [...new Set(statusRecs.map((l) => l.instance))], started_instances: instances });
    resources("end-restart");
    await A.client.close();
    saveState({ restartCrawl: id });
  },

  // The MCP service stopped: /mcp answers 503 at once, and every REST route keeps working, a durable
  // job included; started again, /mcp serves as before.
  async stopped() {
    const gwBefore = startedAt("access-gateway");
    resources("before-mcp-stop");
    D(`stop -t 10 ${cname("mcp-gateway")}`);
    out("stopped", { case: "mcp_state", state: health("mcp-gateway") });
    const t0 = Date.now();
    const m = await modern("tools/list", {});
    out("stopped", { case: "mcp_request", ...wire(m), ms: Date.now() - t0 });
    const s = await raw("POST", { tok: "m4a", path: "/v2/scrape", headers: { "content-type": "application/json" }, body: { url: `${FX}/p11`, formats: ["markdown"] } });
    out("stopped", { case: "rest_scrape", status: s.status, sentinel: sentinel(JSON.parse(s.text || "{}").data?.markdown) });
    const ps = await raw("GET", { tok: "m4a", path: "/platform/v1/status" });
    out("stopped", { case: "rest_platform_status", status: ps.status, core_live: JSON.parse(ps.text || "{}").core?.live ?? null });
    const prior = state().restartCrawl;
    const pr = prior ? await raw("GET", { tok: "m4a", path: `/v2/crawl/${prior}` }) : null;
    out("stopped", { case: "rest_prior_job", id: prior ?? null, status: pr?.status ?? null, body_status: pr ? JSON.parse(pr.text || "{}").status ?? null : null });
    const c = await raw("POST", { tok: "m4a", path: "/v2/crawl", headers: { "content-type": "application/json" }, body: { url: `${FX}/`, limit: 2, sitemap: "include" } });
    const cid = JSON.parse(c.text || "{}").id;
    let cs = null;
    for (let i = 0; i < 150; i++) { cs = JSON.parse((await raw("GET", { tok: "m4a", path: `/v2/crawl/${cid}` })).text || "{}"); if (["completed", "failed", "cancelled"].includes(cs.status)) break; await sleep(2000); }
    out("stopped", { case: "rest_crawl_while_stopped", submit_status: c.status, id: cid ?? null, status: cs?.status ?? null, docs: cs?.data?.length ?? null });
    D(`start ${cname("mcp-gateway")}`);
    await waitHealthy("mcp-gateway");
    const back = await modern("tools/list", {});
    out("started", { case: "mcp_request", ...wire(back), tools: (back.last?.result?.tools ?? []).length, gateway_unchanged: startedAt("access-gateway") === gwBefore });
    resources("end-stopped");
  },

  // The same endpoint over the tailnet, through Tailscale Serve's TLS: modern and legacy SDK clients, SSE
  // through Serve, and the boundary's refusals. The origin is read from the Pi's served-origins file and
  // never printed.
  async tailnet() {
    const origins = pi("sudo -n cat /etc/firecrawl-pi/secrets/gateway/served-origins").split("\n").map((l) => l.trim()).filter((l) => /^https:\/\//.test(l));
    if (origins.length !== 1) throw new Error(`expected one https served origin, found ${origins.length}`);
    BASE = origins[0];
    tailnetHost = new URL(BASE).hostname;
    seen.length = 0; looked.length = 0;
    const d = await modern("server/discover");
    out("tailnet", { case: "discover", ...wire(d), tls: d.tls, tls_authorized: d.tlsAuthorized, cert_matches_host: d.cert === tailnetHost || (d.cert ?? "").startsWith("*.") });
    const A = sdkClient("fcpi-m4-tailnet-modern", { tok: "m4a", pin: MODERN, base: BASE });
    await A.connect();
    const tl = await A.client.listTools();
    const progress = [];
    const sc = sdkPayload(await A.client.callTool({ name: "firecrawl_scrape", arguments: { url: `${FX}/p02` } }, { onprogress: (p) => progress.push(p.message ?? null) }));
    const cr = sdkPayload(await A.client.callTool({ name: "firecrawl_crawl", arguments: { url: `${FX}/`, limit: 2, sitemap: "include" } }));
    const st = await pollSdk(A.client, "firecrawl_check_crawl_status", cr.id);
    out("tailnet", { case: "modern_sdk", negotiated: A.client.getNegotiatedProtocolVersion?.() ?? null, tools: tl.tools.length, sentinel: sentinel(sc?.data?.markdown), progress_messages: progress.length,
      sse_exchanges: A.exchanges.filter((e) => /event-stream/.test(e.content_type ?? "")).length, crawl_status: st.status, results_on_tailnet_origin: String(cr.results ?? "").startsWith(`${BASE}/v2/crawl/`), sessions: A.exchanges.filter((e) => e.session_header).length });
    const L = sdkClient("fcpi-m4-tailnet-legacy", { tok: "m4b", base: BASE });
    await L.connect();
    const ls = sdkPayload(await L.client.callTool({ name: "firecrawl_scrape", arguments: { url: `${FX}/p03` } }));
    out("tailnet", { case: "legacy_sdk", negotiated: L.client.getNegotiatedProtocolVersion?.() ?? null, sentinel: sentinel(ls?.data?.markdown), sessions: L.exchanges.filter((e) => e.session_header).length });
    out("tailnet", { case: "no_token", ...wire(await modern("tools/list", {}, { tok: null })) });
    out("tailnet", { case: "foreign_host", ...wire(await modern("tools/list", {}, { headers: { host: "rebind.example" } })) });
    await Promise.all([A.client.close(), L.client.close()]);
    out("tailnet_connections", { hosts: [...new Set(seen)], total: seen.length, lookups: [...new Set(looked)] });
  },
};

// ---- run ----------------------------------------------------------------------------------------------
if (!PHASES[phase]) { console.error(`usage: mcp-e2e.mjs <${Object.keys(PHASES).join("|")}>`); process.exit(2); }
out("meta", { phase, platform: process.platform, node: process.version, client: `${clientPkg.name}@${clientPkg.version}`, deployed_commit: pi("cat /opt/firecrawl-pi/.fcpi-source-commit").trim(), pi_utc: piNow() });
let code = 0;
try {
  if (phase !== "tailnet") { await openTunnel(); out("forward", { pid: tunnel.pid }); }
  seen.length = 0; looked.length = 0;
  // A sample before the phase does any work, so a container restart anywhere in it shows (M01).
  resources(`start-${phase}`);
  await PHASES[phase]();
  if (phase !== "tailnet") out("connections", { hosts: [...new Set(seen)], total: seen.length, lookups: [...new Set(looked)] });
  if (!["restart", "stopped"].includes(phase)) resources(`end-${phase}`);
} catch (e) {
  out("error", { message: String(e?.stack ?? e).slice(0, 600) });
  code = 1;
}
if (tunnel) out("forward", { pid: tunnel.pid, exited_before_end: tunnelExit !== null });
tunnel?.kill();
out("end", { exit: code });
process.exit(code);
