// Shared by the search-intelligence tests: fixture servers speaking each provider's wire format, an in-memory Store with the
// search-intelligence methods over m5-helpers' FakeLedger (the SQL is tested against PostgreSQL in si-store.test.mjs), and
// the coordinator assembled as server.mjs assembles it, on the fixture selection (fixture providers only: no live call).
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { FakeLedger, budgetFor, providersDir, policyFor, lookupFixture, serve } from "./m5-helpers.mjs";
import { loadPolicy } from "../src/policy.mjs";
import { makeSerper } from "../src/serper.mjs";
import { makeSearxngBackend } from "../src/search.mjs";
import { makeAvailability } from "../src/search-intelligence/availability.mjs";
import { makePermits } from "../src/search-intelligence/permits.mjs";
import { makeDispatch } from "../src/search-intelligence/adapters/common.mjs";
import { makeSerperLane } from "../src/search-intelligence/adapters/serper.mjs";
import { makeBrave } from "../src/search-intelligence/adapters/brave.mjs";
import { makeExa } from "../src/search-intelligence/adapters/exa.mjs";
import { makeDeepseek } from "../src/search-intelligence/adapters/deepseek.mjs";
import { makeTavily } from "../src/search-intelligence/adapters/tavily.mjs";
import { makeSearxngLane } from "../src/search-intelligence/adapters/searxng.mjs";
import { makeCoordinator } from "../src/search-intelligence/coordinator.mjs";
import { makeContext7 } from "../src/search-intelligence/adapters/context7.mjs";
import { makeRef, makeRefSessionFactory } from "../src/search-intelligence/adapters/ref.mjs";
import { makeRefBridge } from "../src/search-intelligence/adapters/ref-bridge.mjs";
import { makeDocumentation } from "../src/search-intelligence/documentation.mjs";
import { makeDecisions } from "../src/search-intelligence/decisions.mjs";
import { makeTelemetry, availabilityEvent, breakerEvent } from "../src/search-intelligence/telemetry.mjs";

export { serve, providersDir, budgetFor, lookupFixture };
export const egress = loadPolicy(readFileSync(new URL("../policy/egress.json", import.meta.url), "utf8"));
export const json = (res, status, body, headers = {}) => { res.writeHead(status, { "content-type": "application/json", ...headers }); res.end(JSON.stringify(body)); };
export const readBody = async (req) => { let t = ""; for await (const c of req) t += c; return t; };
// Polls until cond() holds or timeoutMs passes; resolves to whether it held, so a slower host only waits longer.
export async function waitFor(cond, { timeoutMs = 3000, everyMs = 10 } = {}) {
  const until = Date.now() + timeoutMs;
  while (!(await cond())) { if (Date.now() > until) return false; await new Promise((r) => setTimeout(r, everyMs)); }
  return true;
}

export class FakeStore extends FakeLedger {
  constructor() { super(); this.searchCache = new Map(); this.admissions = 0; this.avail = new Map(); this.failCacheWrite = false; this.failReserve = false; this.runs = new Map(); this.events = []; this.failTelemetry = false; }
  async reserveBudget(r) { if (this.failReserve) throw Object.assign(new Error("db down"), { code: "ECONNREFUSED" }); this.lastReserve = r; return super.reserveBudget(r); }
  async searchCacheEntry(k) { const e = this.searchCache.get(k); return e && e.expiresAt > new Date() ? structuredClone(e) : null; }
  async searchCacheGet(k) { return (await this.searchCacheEntry(k))?.response ?? null; }
  async searchCachePut(k, response, ttl) { if (this.failCacheWrite) throw new Error("cache write failed"); this.searchCache.set(k, { response: structuredClone(response), createdAt: new Date(), expiresAt: new Date(Date.now() + ttl * 1000) }); }
  async admitSearchQuery(perHour) { this.admissions++; return { admitted: this.admissions <= perHour, count: this.admissions }; }
  async availabilityRows() { return [...this.avail.values()]; }
  async setAvailability(r) {
    const row = { provider: r.provider, profile: r.profile ?? "default", state: r.state, reason: r.reason, provider_code: r.providerCode ?? null, retry_at: r.retryAt ?? null, retry_basis: r.retryBasis ?? "unknown",
      credential_epoch: r.credentialEpoch ?? null, contract_failures: r.contractFailures ?? 0 };
    this.avail.set(r.provider, row);
    return row;
  }
  // The operational records (store.mjs has the SQL, tested in si-telemetry.test.mjs against PostgreSQL).
  async searchRunStarted(r) { if (this.failTelemetry) throw new Error("telemetry write failed"); if (!this.runs.has(r.logicalId)) this.runs.set(r.logicalId, structuredClone(r)); }
  async searchRunFinished(r) { if (this.failTelemetry) throw new Error("telemetry write failed"); this.runs.set(r.logicalId, structuredClone(r)); }
  async searchEvents(events) { if (this.failTelemetry) throw new Error("telemetry write failed"); for (const e of events) if (!this.events.some((x) => x.eventId === e.eventId)) this.events.push(structuredClone(e)); return events.length; }
}

// Default answers in each provider's documented shape; each takes the query and returns { status, body, headers? }.
const site = (p, n) => Array.from({ length: n }, (_, i) => `https://${p}.example.org/doc/${i + 1}`);
export const answers = {
  serper: (q) => ({ status: 200, body: { credits: 1, organic: site("serper", 3).map((link, i) => ({ title: `Serper ${i + 1} ${q}`, link, snippet: "serper snippet" })) } }),
  brave: (q) => ({ status: 200, body: { query: { original: q }, web: { type: "search", results: site("brave", 3).map((url, i) => ({ title: `Brave ${i + 1}`, url, description: "brave description", extra_snippets: ["extra"] })) } } }),
  exa: () => ({ status: 200, body: { requestId: "exa-req", results: site("exa", 3).map((url, i) => ({ id: `e${i}`, title: `Exa ${i + 1}`, url, highlights: ["exa highlight"], publishedDate: "2026-01-02T00:00:00.000Z" })), costDollars: { total: 0.012 } } }),
  deepseek: () => ({ status: 200, body: { results: site("deepseek", 3).map((url, i) => ({ title: `DeepSeek ${i + 1}`, url, snippet: "deepseek snippet", summary: "summary", content: "", date: null, rerank_score: 2, authority: 1, site_name: null, site_icon: null })) } }),
  tavily: (q) => ({ status: 200, body: { query: q, results: site("tavily", 3).map((url, i) => ({ title: `Tavily ${i + 1}`, url, content: "tavily content", score: 0.9 - i / 10 })), usage: { credits: 2 }, request_id: "tv-req", response_time: 1.2 } }),
};
export const HOSTS = { serper: "serper.fixture.fcpi.test", brave: "brave.fixture.fcpi.test", exa: "exa.fixture.fcpi.test", deepseek: "deepseek.fixture.fcpi.test", tavily: "tavily.fixture.fcpi.test" };
// Documentation and decision fixtures: started only when a test gives their handler.
export const EXTRA_HOSTS = { context7: "context7.fixture.fcpi.test", ref: "ref.fixture.fcpi.test", openrouter: "openrouter.fixture.fcpi.test" };

// Ref's legacy text blocks (SI0 contract evidence §6) for the given URLs.
export const refBlocks = (urls) => ({ content: urls.map((url, i) => ({ type: "text", text: `overview: Ref overview ${i + 1}\nurl: ${url}\nmoduleId: module-${i + 1}` })) });
const defaultRefTool = (name, args) => name === "ref_search_documentation"
  ? refBlocks([1, 2, 3].map((i) => `https://ref.example.org/docs/${i}`))
  : { content: [{ type: "text", text: `Excerpt of ${args.url}: ${"documented behavior and parameters. ".repeat(12)}` }] };
// A Ref fixture speaking Streamable HTTP MCP in the 2025 era, as the official client's default handshake expects: initialize
// issues a session id, tools/list lists the tools, tools/call answers through tool(name, args, entry) on an SSE stream (held
// open after its result when holdOpen) or as JSON; GET opens a receive stream that stays open; DELETE ends the session.
// tool may return "destroy" (cut the connection after the request arrived) or { status } (an HTTP refusal). Records everything.
// "sse_cut" and "json_cut" answer with headers and part of a body, then cut the connection.
export function refFixture({ tool = defaultRefTool, sse = true, holdOpen = false, receiveStream = true, tools = ["ref_search_documentation", "ref_read_url"], initialize = null, notified = null } = {}) {
  const log = [], sessions = new Map(), open = new Set();
  let n = 0;
  // A response's close is its connection's end (a request's close only means its body was read).
  const hold = (req, res) => { open.add(res); res.on("close", () => open.delete(res)); };
  const raw = async (req, res) => {
    const text = await readBody(req);
    const entry = { method: req.method, url: req.url, session: req.headers["mcp-session-id"] ?? null, key: req.headers["x-ref-api-key"] ?? null, headers: req.headers, at: Date.now() };
    log.push(entry);
    if (req.method === "GET") {
      if (!receiveStream) { res.writeHead(405); return res.end(); }
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(": receive stream\n\n");
      return hold(req, res);
    }
    if (req.method === "DELETE") { entry.closed = sessions.delete(entry.session); res.writeHead(200); return res.end(); }
    const msg = JSON.parse(text);
    entry.message = msg;
    if (msg.method === "initialize") {
      const a = initialize?.(entry);
      if (a?.delayMs) await new Promise((r) => setTimeout(r, a.delayMs));
      if (a?.status) { res.writeHead(a.status, a.headers ?? {}); return res.end(); }
      const id = `ref-session-${++n}`;
      sessions.set(id, { calls: [] });
      res.writeHead(200, { "content-type": "application/json", "mcp-session-id": id });
      return res.end(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: a?.protocolVersion ?? msg.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "ref-fixture", version: "1" } } }));
    }
    if (msg.id === undefined) { notified?.(entry); res.writeHead(202); return res.end(); }
    if (!sessions.has(entry.session)) { res.writeHead(404); return res.end(); }
    let result;
    if (msg.method === "tools/list") {
      result = { tools: tools.map((name) => ({ name, inputSchema: { type: "object", properties: { [name === "ref_read_url" ? "url" : "query"]: { type: "string" } }, required: [name === "ref_read_url" ? "url" : "query"] }, annotations: { readOnlyHint: true } })) };
    } else if (msg.method === "tools/call") {
      entry.tool = msg.params.name; entry.args = msg.params.arguments;
      sessions.get(entry.session).calls.push({ tool: entry.tool, args: entry.args });
      result = await tool(msg.params.name, msg.params.arguments, entry);
      if (result === "destroy") return res.destroy();
      if (result === "sse_cut" || result === "json_cut") {
        res.writeHead(200, { "content-type": result === "sse_cut" ? "text/event-stream" : "application/json" });
        res.write(result === "sse_cut" ? ": working\n\n" : "{\"jsonrpc\":\"2.0\",");
        setTimeout(() => res.destroy(), 20);
        return;
      }
      if (result?.status) { res.writeHead(result.status, { "content-type": "text/plain" }); return res.end("refused"); }
    } else {
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(JSON.stringify({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: "Method not found" } }));
    }
    const body = { jsonrpc: "2.0", id: msg.id, result };
    if (!sse || msg.method !== "tools/call") { res.writeHead(200, { "content-type": "application/json" }); return res.end(JSON.stringify(body)); }
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write(`event: message\ndata: ${JSON.stringify(body)}\n\n`);
    if (holdOpen) hold(req, res); else res.end();
  };
  return { raw, log, sessions, open };
}

// A fixture server for one provider: records every request (method, url, headers, parsed body) and answers through handler.
// A handler with raw (a Ref fixture) serves the exchange itself.
export async function providerServer(name, handler = null) {
  if (handler?.raw) { const srv = await serve(handler.raw); return { ...srv, seen: handler.log ?? [], fixture: handler, host: HOSTS[name] ?? EXTRA_HOSTS[name], name }; }
  const seen = [];
  const srv = await serve(async (req, res) => {
    const text = await readBody(req);
    let body = null;
    try { body = text ? JSON.parse(text) : null; } catch { body = text; }
    const entry = { method: req.method, url: req.url, headers: req.headers, body, at: Date.now() };
    seen.push(entry);
    const q = body?.q ?? body?.query ?? new URL(req.url, "http://x").searchParams.get("q") ?? "";
    const a = await (handler ?? answers[name])(q, entry, seen);
    if (a === "destroy") return res.destroy();
    json(res, a.status, a.body, a.headers ?? {});
  });
  return { ...srv, seen, host: HOSTS[name] ?? EXTRA_HOSTS[name], name };
}

// The harness: fixture servers for the five general providers (handlers override defaults), a SearXNG backend fixture, the
// fixture roster's budget pointed at them, and the coordinator. selection is "fixture" throughout. A context7 or ref handler adds
// that documentation lane (and documentation activation); an openrouter handler adds Jev's decisions.
export async function harness({ handlers = {}, searxng = null, mutateBudget = () => {}, mutatePolicy = () => {}, perHour = 60, paidDispatch = true, decisions = null, telemetry: withTelemetry = false } = {}) {
  const servers = {};
  for (const n of Object.keys(HOSTS)) servers[n] = await providerServer(n, handlers[n] ?? null);
  for (const n of Object.keys(EXTRA_HOSTS)) if (handlers[n]) servers[n] = await providerServer(n, handlers[n]);
  const sx = searxng ? await serve(searxng) : null;
  let budget;
  try {
    budget = budgetFor({ mutate: (b) => {
      for (const [n, s] of Object.entries(servers)) b.providers[`fixture-${n}`].baseUrl = `http://${s.host}:${s.port}`;
      mutateBudget(b);
    } });
  } catch (e) {
    // A setup failure fails its test; the servers already listening must not keep the process alive.
    for (const s of Object.values(servers)) await s.close();
    await sx?.close();
    throw e;
  }
  const policy = { ...policyFor(Object.fromEntries(Object.values(servers).map((s) => [s.host, s.port]))), search: structuredClone(egress.search) };
  policy.search.perHour = perHour;
  mutatePolicy(policy);
  const dir = providersDir({ fixture_serper: "synthetic-serper-key" });
  const store = new FakeStore(), logs = [];
  const log = (o) => logs.push(o);
  const getBudget = () => budget, getPolicy = () => policy, getSelection = () => ({ search: "fixture" });
  // Operational records wired as server.mjs wires them: availability and breaker transitions, and every run.
  const telemetry = withTelemetry ? makeTelemetry({ store, log, limits: () => policy.search.intelligence, fingerprintKey: Buffer.from("si-helpers-fingerprint-key") }) : null;
  const availability = makeAvailability({ store, log, onTransition: (t) => telemetry?.event(availabilityEvent(t)) });
  const permits = makePermits(policy.search.intelligence);
  const readKey = (name) => { try { return readFileSync(`${dir}/${name}`, "utf8").trim() || null; } catch { return null; } };
  const dispatch = makeDispatch({ store, getBudget, getPolicy, resolvePublic: async () => ["127.0.0.1"], lookupFixture, readKey, paidDispatch, permits, availability, log,
    onBreaker: (t) => telemetry?.event(breakerEvent(t)) });
  const limits = () => policy.search.intelligence;
  const serper = makeSerper({ store, getBudget, getPolicy, providersDir: dir, lookupFixture, log, onBreaker: (t) => telemetry?.event(breakerEvent(t)) });
  const general = { serper: makeSerperLane({ serper, limits, permits, availability }), brave: makeBrave({ dispatch, limits }), exa: makeExa({ dispatch, limits }),
    deepseek: makeDeepseek({ dispatch, limits, permits }), tavily: makeTavily({ dispatch, limits }) };
  const backend = sx ? makeSearxngBackend({ getPolicy, getSelection, searchUrl: `http://127.0.0.1:${sx.port}/search` }) : null;
  const resolvePublic = async () => ["127.0.0.1"];
  const makeFetch = makeRefBridge({ permits, getPolicy, resolvePublic, lookupFixture, getBudget, paidDispatch, limits });
  const docs = {};
  if (servers.context7) docs.context7 = makeContext7({ dispatch, limits });
  if (servers.ref) docs.ref = makeRef({ dispatch, limits, openSession: makeRefSessionFactory({ makeFetch, log }), log });
  const jev = decisions ?? (servers.openrouter ? makeDecisions({ dispatch, store, limits, permits, log }) : null);
  const documentation = Object.keys(docs).length ? makeDocumentation({ decisions: jev, log }) : null;
  const coordinator = makeCoordinator({ store, getBudget, getPolicy, getSelection, dispatch, general, searxng: backend ? makeSearxngLane({ backend, limits }) : null, availability, docs, documentation, decisions: jev, telemetry, log });
  return { coordinator, store, servers, sx, budget, policy, logs, dispatch, availability, permits, serper, general, docs, decisions: jev, makeFetch, telemetry, getBudget, getPolicy, getSelection,
    close: async () => { for (const s of Object.values(servers)) await s.close(); await sx?.close(); } };
}

export const request = (over = {}) => ({ schema: "fcpi.search-request/v1", requestId: `req-${randomUUID()}`, logicalSearchId: randomUUID(), principalId: "test-principal", originalQuery: "web retrieval",
  limit: 5, language: "en", constraints: {}, intelligence: { documentation: "off" }, resultMode: "links", absoluteDeadlineMs: Date.now() + 30000, ...over });
