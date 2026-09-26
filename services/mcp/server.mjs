// FCPI MCP gateway (FIRECRAWL_PI_SPEC.md §16.3, §17, §18): the official SDK's request factory
// (createMcpHandler) on Node's http server through toNodeHandler. A fresh McpServer serves every HTTP
// request, and nothing but a REST connection pool lives between requests: no session, no
// Mcp-Session-Id, no event store. 2026-07-28 requests are served on the modern path; 2025-era requests
// by the SDK's stateless legacy fallback (`legacy: 'stateless'`) from the same factory.
//   - It listens only on the internal network it shares with the access gateway, which has already
//     checked the Host, the Origin, the bearer token and the body size, and forwards the validated
//     identity in x-fcpi-* headers it builds itself. Those headers are descriptive (logs, authInfo);
//     authority stays with the token, which every tool presents to the gateway again.
//   - A request without that identity did not come through the gateway and gets 401.
//   - Nothing is logged from arguments or results: the era, protocol version, method, tool, validated
//     client, the gateway's answer (route, status, code, its request id) and timings.
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { createMcpHandler, McpServer, fromJsonSchema } from "@modelcontextprotocol/server";
import { toNodeHandler } from "@modelcontextprotocol/node";
import { loadConfig } from "./src/config.mjs";
import { makeRest } from "./src/rest.mjs";
import { makeTools } from "./src/tools.mjs";

const cfg = loadConfig(process.env);
const M = cfg.manifest, L = M.mcp.limits;
const instance = randomUUID();
const log = (o) => console.log(JSON.stringify({ utc: new Date().toISOString(), service: "mcp-gateway", build: cfg.build, instance, ...o }));
const pkg = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8"));
const SERVER_INFO = { name: "fcpi-mcp-gateway", title: "Firecrawl Pi platform", version: `${pkg.version}+${cfg.build.slice(0, 12)}` };
const INSTRUCTIONS = "A private, self-hosted Firecrawl platform. firecrawl_scrape and firecrawl_map answer directly. firecrawl_crawl and firecrawl_batch_scrape start durable jobs and return an id at once: poll it with the matching status tool, which returns one bounded page of documents and a nextSkip while more remain. Job ids stay valid across restarts and new connections. firecrawl_capabilities describes what this deployment supports.";
const HINT = { ttlMs: L.catalogTtlMs, cacheScope: "private" };
const rest = makeRest(cfg);
const tools = makeTools(M).map((t) => ({ ...t, config: { ...t.config, inputSchema: fromJsonSchema(t.config.inputSchema) } }));
let toolCalls = 0;

// Client-sent header text is logged only as the value its grammar allows, else "invalid" (null when absent),
// as the gateway logs Mcp-Method: a client cannot put arbitrary text into the log.
const LOGGED = { method: /^[a-z/_]{1,64}$/, name: /^[A-Za-z0-9_./-]{1,128}$/, version: /^\d{4}-\d{2}-\d{2}$/ };
const logged = (v, re) => (v === undefined || v === null ? null : re.test(String(v)) ? String(v) : "invalid");
// A client's own name and version (clientInfo): descriptive only, never identity (spec §20.3), logged so a
// real client shows by name beside its token's label.
const INFO = /^[A-Za-z0-9 ._@\/+:-]{1,64}$/;
const clientInfo = (i) => (i && typeof i === "object" ? { name: logged(i.name, INFO), version: logged(i.version, INFO) } : null);

const text = (payload, isError) => ({ content: [{ type: "text", text: JSON.stringify(payload) }], ...(isError ? { isError: true } : {}) });

async function runTool(t, args, extra, era) {
  const t0 = Date.now();
  const auth = extra.http?.authInfo;
  const hdr = (k) => extra.http?.req?.headers?.get?.(k) ?? null;
  const rec = { event: "tool", request_id: auth?.extra?.requestId ?? null, era, protocol_version: logged(hdr("mcp-protocol-version"), LOGGED.version), jsonrpc_id: extra.mcpReq?.id ?? null, client_info: clientInfo(extra.mcpReq?.envelope?.["io.modelcontextprotocol/clientInfo"]),
    tool: t.name, client: auth?.clientId ?? null, principal: auth?.extra?.principal ?? null };
  // The job a call names or starts (spec §24: job id when applicable), never its arguments.
  let job = typeof args?.id === "string" ? args.id : null;
  const finish = (result, downstream, outcome) => { log({ ...rec, job, downstream, outcome, is_error: !!result?.isError, text_bytes: result ? Buffer.byteLength(result.content[0].text) : null, ms: Date.now() - t0 }); return result; };
  if (!auth?.token) return finish(text({ error: { code: "NO_GATEWAY_IDENTITY", message: "This request did not arrive through the access gateway." } }, true), null, "refused");
  if (toolCalls >= L.maxToolCalls) return finish(text({ error: { code: "OVERLOADED", message: `${toolCalls} tool calls are already running (limit ${L.maxToolCalls}); retry shortly.`, retryAfterSeconds: 5 } }, true), null, "overloaded");
  toolCalls += 1;
  const signal = extra.mcpReq?.signal;
  try {
    // A long call tells a client that asked for progress that it is under way; the answer then
    // streams (request-scoped SSE) instead of arriving as one JSON body.
    const progressToken = extra.mcpReq?._meta?.progressToken;
    if (t.long && progressToken !== undefined) await extra.mcpReq.notify({ method: "notifications/progress", params: { progressToken, progress: 0, message: `Sent to ${t.route.method} ${t.route.path}; waiting for the gateway.` } });
    // Every submission carries an idempotency key (spec §16.2, §17.3): the caller's own, or one made here.
    // The gateway commits a receipt before it answers, so an answer lost on its way back leaves a job the
    // caller cannot see; retried under the same key, the call returns that job instead of starting another.
    if (t.kind === "submit") args = { ...args, idempotencyKey: args.idempotencyKey ?? `mcp:${randomUUID()}` };
    const q = t.request(args);
    let r;
    const send = (qq) => rest.call({ ...qq, token: auth.token, host: auth.extra.host, signal });
    try {
      try { r = await send(q); }
      catch (e) {
        // A status page over the answer cap is read again one document at a time, as the gateway itself
        // does for running jobs; a single document still over it is reported with where it is served whole.
        if (t.kind !== "status" || e.code !== "TOO_LARGE" || (args.limit ?? L.statusPageDefault) <= 1) throw e;
        args = { ...args, limit: 1 };
        r = await send(t.request(args));
      }
    } catch (e) {
      const downstream = { route: t.route.id, status: null, code: e.code ?? "UNAVAILABLE", request_id: null };
      if (e.code === "ABORTED") { finish(null, downstream, "cancelled"); e.recorded = true; throw e; }
      if (t.kind === "submit" && e.code !== "TOO_LARGE") {
        return finish(text({ error: { code: "SUBMISSION_UNCERTAIN", idempotencyKey: args.idempotencyKey, message: `The gateway's answer was lost (${e.message}), so whether it recorded this job is unknown. Call ${t.name} again with the same arguments and this idempotencyKey: it returns the job if it was recorded and starts it once if it was not.` } }, true), downstream, "uncertain");
      }
      const message = e.code === "TOO_LARGE" ? `The gateway's answer is larger than this service carries (${L.restResponseMaxBytes} bytes). ${t.kind === "status" ? `The document at skip ${args.skip ?? 0} alone is that large: read it whole from the job's REST results route with limit=1.` : "Ask for fewer formats."}` : `The gateway did not answer: ${e.message}.`;
      return finish(text({ error: { code: e.code === "TOO_LARGE" ? "RESULT_TOO_LARGE" : "GATEWAY_UNAVAILABLE", message } }, true), downstream, "failed");
    }
    const { payload, isError } = t.shape(r, args);
    if (t.kind === "submit" && typeof payload?.id === "string") job = payload.id;
    const downstream = { route: t.route.id, status: r.status, code: r.json?.code ?? null, request_id: r.headers["x-request-id"] ?? null };
    const out = text(payload, isError);
    // The payload bound, once, for every answer (spec §16.3): shaping cuts the fields it knows how to cut;
    // an answer still over the limit (its bulk in a field such as metadata) is refused, never sent whole.
    if (Buffer.byteLength(out.content[0].text) > L.toolTextMaxBytes) {
      return finish(text({ error: { code: "RESULT_TOO_LARGE", message: `The answer exceeds the ${L.toolTextMaxBytes}-byte tool payload limit in fields this service does not cut${t.kind === "status" ? "; the document is served whole by the job's REST results route" : ""}.` } }, true), downstream, "too_large");
    }
    return finish(out, downstream, isError ? "error" : "ok");
  } catch (e) {
    // Anything else that ends the call (the progress notification or shaping the answer) still leaves a
    // tool record, so every call the gateway saw can be matched to one (O01).
    if (!e?.recorded) finish(null, { route: t.route.id, status: null, code: "EXCEPTION", request_id: null }, "failed");
    throw e;
  } finally { toolCalls -= 1; }
}

// The instance serving each request, by the gateway's request id, until that request closes: a 2025-era
// initialize names its client only to the instance that serves it, and the exchange record reads it there.
// Nothing outlives its own request, so this is not session state.
const serving = new Map();

// One McpServer per HTTP request: the same factory serves both eras.
const factory = (ctx) => {
  const requestId = ctx.authInfo?.extra?.requestId ?? null;
  log({ event: "serve", request_id: requestId, era: ctx.era });
  const s = new McpServer(SERVER_INFO, { capabilities: { tools: { listChanged: false } }, instructions: INSTRUCTIONS, cacheHints: { "tools/list": HINT, "server/discover": HINT } });
  for (const t of tools) s.registerTool(t.name, t.config, (args, extra) => runTool(t, args, extra, ctx.era));
  if (requestId) serving.set(requestId, s);
  return s;
};

// No subscription stream is ever useful here (the catalog never changes while a server runs), so
// subscriptions/listen is refused in-band rather than held open.
const handler = createMcpHandler(factory, { legacy: "stateless", maxSubscriptions: 0, maxRequestBodySize: M.limits.bodyBytes,
  onerror: (e) => log({ event: "rejected", reason: String(e.message).slice(0, 240) }) });
const node = toNodeHandler(handler, { maxRequestBodySize: M.limits.bodyBytes, onerror: (e) => log({ event: "adapter_error", error: String(e.message).slice(0, 240) }) });

const IDENTITY = { client: /^[a-z0-9]{1,32}$/, principal: /^[a-z0-9][a-z0-9-]{0,62}$/, scopes: /^(?=[a-z,]{1,256}$)[a-z]+(?:,[a-z]+)*$/, request: /^[0-9a-f-]{36}$/ };
const server = createServer({ maxHeaderSize: 16384 }, (req, res) => {
  const path = (req.url ?? "").split("?")[0];
  if (req.method === "GET" && path === "/health") {
    res.writeHead(200, { "content-type": "application/json" });
    return res.end(JSON.stringify({ live: true, service: "mcp-gateway", build: cfg.build, instance, tools: tools.length }));
  }
  const send = (status, code, message) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify({ success: false, code, error: message })); };
  if (path !== M.mcp.path) return send(404, "NOT_FOUND", "No such route.");
  const h = req.headers;
  const bearer = /^Bearer ([\x21-\x7e]{16,512})$/.exec(h.authorization ?? "");
  const ok = bearer && IDENTITY.client.test(h["x-fcpi-client"] ?? "") && IDENTITY.principal.test(h["x-fcpi-principal"] ?? "") && IDENTITY.scopes.test(h["x-fcpi-scopes"] ?? "") && IDENTITY.request.test(h["x-request-id"] ?? "") && h.host;
  if (!ok) { log({ event: "exchange", status: 401, code: "NO_GATEWAY_IDENTITY" }); return send(401, "NO_GATEWAY_IDENTITY", "Requests reach this service only through the access gateway."); }
  req.auth = { token: bearer[1], clientId: h["x-fcpi-client"], scopes: h["x-fcpi-scopes"].split(","), extra: { principal: h["x-fcpi-principal"], host: h.host, requestId: h["x-request-id"] } };
  const t0 = Date.now();
  let status = null, contentType = null, sessionHeader = false;
  const writeHead = res.writeHead;
  res.writeHead = function (s, hs, ...rest) {
    status = s;
    const o = hs && typeof hs === "object" && !Array.isArray(hs) ? hs : typeof rest[0] === "object" ? rest[0] : {};
    contentType = Object.entries(o).find(([k]) => k.toLowerCase() === "content-type")?.[1] ?? null;
    sessionHeader = Object.keys(o).some((k) => k.toLowerCase() === "mcp-session-id") || res.hasHeader("mcp-session-id");
    return writeHead.call(this, s, hs, ...rest);
  };
  res.on("close", () => {
    const inst = serving.get(h["x-request-id"]);
    serving.delete(h["x-request-id"]);
    exchangeLog(inst);
  });
  const exchangeLog = (inst) => log({ event: "exchange", request_id: h["x-request-id"], client_info: clientInfo(inst?.server?.getClientVersion?.()), http_method: req.method, mcp_method: logged(h["mcp-method"], LOGGED.method), mcp_name: logged(h["mcp-name"], LOGGED.name),
    protocol_version: logged(h["mcp-protocol-version"], LOGGED.version), status, content_type: contentType, session_header_sent: sessionHeader, completed: res.writableFinished,
    client: h["x-fcpi-client"], principal: h["x-fcpi-principal"], ms: Date.now() - t0 });
  node(req, res);
});

server.headersTimeout = 10000;
server.requestTimeout = L.exchangeTimeoutMs;
server.listen(cfg.port, "0.0.0.0", () => log({ event: "listening", port: server.address().port, tools: tools.map((t) => t.name), rest: cfg.rest.origin, modern: M.mcp.protocol.modern, legacy: M.mcp.protocol.legacy }));
for (const sig of ["SIGTERM", "SIGINT"]) process.on(sig, () => {
  server.close(async () => { await handler.close().catch(() => {}); rest.close(); process.exit(0); });
  setTimeout(() => process.exit(0), 8000).unref();
});
