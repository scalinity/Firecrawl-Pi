// Search-intelligence fixture providers (docs/FIRECRAWL_PI_SEARCH_INTELLIGENCE_SPEC.md §24): each new API in its documented
// wire shape, chosen by the fixture host the request names (brave., exa., deepseek., tavily., context7., ref., openrouter.,
// serper.fixture.fcpi.test), so one server answers the whole fixture roster. Answers are deterministic functions of the
// request; behavior switches ride on the query text ("fixture:empty", "fixture:fail", "fixture:nodocs", ...) or on the
// options passed in, never on hidden state. Used by the retrieval tests and by the Pi's fixture stack; it never calls out.
import { createHash, randomUUID } from "node:crypto";

const sha = (s) => createHash("sha256").update(s).digest("hex");
const json = (res, status, body, headers = {}) => { res.writeHead(status, { "content-type": "application/json", ...headers }); res.end(JSON.stringify(body)); };
const readBody = async (req) => { let t = ""; for await (const c of req) t += c; return t; };
const has = (q, flag) => String(q).includes(`fixture:${flag}`);
// Three results per provider on the page base (the M2 fixture's site on the Pi, a placeholder elsewhere), plus one URL every
// provider shares, so fusion and deduplication have work to do.
const results = (provider, q, base) => [`${base}/si/${provider}/a`, `${base}/si/${provider}/b`, `${base}/si/shared`].map((url, i) => ({ url, title: `${provider} ${i + 1}: ${q}`.slice(0, 120), snippet: `${provider} snippet about ${q}`.slice(0, 200) }));

export function makeSiProviders({ pageBase = "http://pages.example.invalid", refSse = false, log = () => {} } = {}) {
  const sessions = new Map(), seen = [];
  const handlers = {
    serper: async (req, res, body) => {
      const q = body?.q ?? "";
      if (has(q, "fail")) return json(res, 503, {});
      json(res, 200, { credits: 1, organic: has(q, "empty") ? [] : results("serper", q, pageBase).map((r, i) => ({ title: r.title, link: r.url, snippet: r.snippet, position: i + 1 })) });
    },
    brave: async (req, res) => {
      const q = new URL(req.url, "http://x").searchParams.get("q") ?? "";
      if (has(q, "fail")) return json(res, 500, { type: "ErrorResponse", error: { id: "x", status: 500, code: "INTERNAL" } });
      if (has(q, "quota")) return json(res, 429, { type: "ErrorResponse", error: { id: "x", status: 429, code: "QUOTA_LIMITED" } },
        { "x-ratelimit-limit": "1, 2000", "x-ratelimit-policy": "1;w=1, 2000;w=2592000", "x-ratelimit-remaining": "1, 0", "x-ratelimit-reset": "1, 86400" });
      json(res, 200, has(q, "empty") ? { type: "search", query: { original: q } } : { type: "search", query: { original: q }, web: { type: "search", results: results("brave", q, pageBase).map((r) => ({ title: r.title, url: r.url, description: r.snippet })) } });
    },
    exa: async (req, res, body) => {
      const q = body?.query ?? "";
      if (has(q, "fail")) return json(res, 503, { requestId: "f", error: "overloaded", tag: "SERVICE_OVERLOADED" });
      json(res, 200, { requestId: `exa-${sha(q).slice(0, 8)}`, results: has(q, "empty") ? [] : results("exa", q, pageBase).map((r, i) => ({ id: `e${i}`, title: r.title, url: r.url, highlights: [r.snippet] })), costDollars: { total: 0.012 } });
    },
    deepseek: async (req, res, body) => {
      const q = body?.query ?? "";
      if (has(q, "fail")) return json(res, 500, { error: { message: "internal", type: "server_error", param: null, code: "server_error" } });
      json(res, 200, { results: has(q, "empty") ? [] : results("deepseek", q, pageBase).map((r) => ({ title: r.title, url: r.url, snippet: r.snippet, summary: `summary: ${r.snippet}`, content: "", date: null, rerank_score: 2, authority: 1, site_name: null, site_icon: null })) });
    },
    tavily: async (req, res, body) => {
      const q = body?.query ?? "";
      if (has(q, "fail")) return json(res, 500, { detail: { error: "internal" } });
      json(res, 200, { query: q, results: has(q, "empty") ? [] : results("tavily", q, pageBase).map((r, i) => ({ title: r.title, url: r.url, content: r.snippet, score: 0.9 - i * 0.1 })), usage: { credits: 2 }, request_id: "tv", response_time: 0.4 });
    },
    // Context7 v3: one sourced code snippet and one source-less info snippet (auxiliary context), or the documented no-match.
    context7: async (req, res) => {
      const u = new URL(req.url, "http://x"), q = u.searchParams.get("query") ?? "", libs = u.searchParams.getAll("library"), version = u.searchParams.get("version");
      if (u.searchParams.get("type") !== "json") return json(res, 400, { error: "validation_error", message: "type must be json in this fixture" });
      if (has(q, "nodocs")) return json(res, 404, { error: "no_documentation_found", message: "No documentation matched" });
      if (has(q, "docsfail")) return json(res, 503, { error: "search_failed", message: "The search couldn't be completed." });
      const lib = libs[0] ? `/fixture/${libs[0]}` : "/fixture/lib";
      json(res, 200, {
        codeSnippets: [{ libraryId: lib, codeTitle: `Example for ${q}`.slice(0, 80), codeDescription: "How the API is called", codeLanguage: "typescript", codeTokens: 40,
          codeId: `${pageBase}/si/docs/code${version ? `-${version}` : ""}`, pageTitle: "Fixture API reference", codeList: [{ language: "typescript", code: "export const answer = 42;" }] }],
        infoSnippets: [{ libraryId: lib, content: `A documented behavior relevant to ${q}`.slice(0, 200), contentTokens: 12, breadcrumb: "Guide > Behavior" }],
        ...(version ? { version: { requested: version, status: has(q, "versionfallback") ? "unverified" : "verified", libraries: [{ libraryId: lib, requested: version, served: has(q, "versionfallback") ? "99.0" : version, status: has(q, "versionfallback") ? "unverified" : "verified" }] } } : {}),
      });
    },
    // Ref: a minimal Streamable HTTP MCP server (JSON responses, or SSE that stays open after the result when refSse is set).
    ref: async (req, res, body) => {
      if (req.method === "GET") { res.writeHead(405); return res.end(); }
      if (req.method === "DELETE") { sessions.delete(req.headers["mcp-session-id"]); res.writeHead(200); return res.end(); }
      if (req.headers["x-ref-api-key"] === undefined) return json(res, 401, { error: "no key" });
      const msg = body ?? {};
      if (msg.method === "initialize") {
        const sid = randomUUID();
        sessions.set(sid, { searches: [] });
        return json(res, 200, { jsonrpc: "2.0", id: msg.id, result: { protocolVersion: msg.params?.protocolVersion ?? "2025-11-25", capabilities: { tools: {} }, serverInfo: { name: "ref-fixture", version: "1" } } }, { "mcp-session-id": sid });
      }
      const sid = req.headers["mcp-session-id"], session = sessions.get(sid);
      if (!session) return json(res, 404, { jsonrpc: "2.0", id: msg.id ?? null, error: { code: -32001, message: "session not found" } });
      if (msg.method === "notifications/initialized") { res.writeHead(202); return res.end(); }
      let result;
      if (msg.method === "tools/list") result = { tools: [
        { name: "ref_search_documentation", description: "Search documentation", inputSchema: { type: "object", properties: { query: { type: "string" } }, required: ["query"] } },
        { name: "ref_read_url", description: "Read a URL", inputSchema: { type: "object", properties: { url: { type: "string" } }, required: ["url"] } }] };
      else if (msg.method === "tools/call" && msg.params?.name === "ref_search_documentation") {
        const q = msg.params.arguments?.query ?? "";
        session.searches.push(q);
        seen.push({ session: sid, op: "search", query: q });
        result = has(q, "refempty") ? { content: [{ type: "text", text: "No results found" }] }
          : has(q, "referror") ? { content: [{ type: "text", text: "Error during documentation search: upstream unavailable" }] }
          : { content: [{ type: "text", text: `overview: Reference for ${q}\nurl: ${pageBase}/si/ref/doc\nmoduleId: fixture/docs` }, { type: "text", text: `overview: Guide\nurl: ${pageBase}/si/shared\nmoduleId: fixture/guide` }] };
      } else if (msg.method === "tools/call" && msg.params?.name === "ref_read_url") {
        seen.push({ session: sid, op: "read", url: msg.params.arguments?.url, after: [...session.searches] });
        result = { content: [{ type: "text", text: `Excerpt of ${msg.params.arguments?.url} for ${session.searches.at(-1) ?? "no search"}: the documented parameter is timeoutMs.` }] };
      } else return json(res, 200, { jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: "method not found" } });
      const reply = { jsonrpc: "2.0", id: msg.id, result };
      if (refSse && msg.method === "tools/call") {
        // The result arrives as an SSE event and the stream stays open: a client must not wait for the end of the body.
        res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
        res.write(`event: message\ndata: ${JSON.stringify(reply)}\n\n`);
        return; // left open on purpose; the client's session close ends it
      }
      return json(res, 200, reply);
    },
    // OpenRouter Decisions: deterministic answers. Relevance rises with the query words a candidate's text holds; a candidate whose
    // excerpt contains "fixture:irrelevant" scores zero; "fixture:jevfail" in the query fails the request.
    openrouter: async (req, res, body) => {
      if (req.url !== "/api/alpha/decisions" || req.method !== "POST") return json(res, 404, { error: { code: 404, message: "Resource not found" } });
      const q = String(body?.state?.query ?? "");
      if (has(q, "jevfail")) return json(res, 503, { error: { code: 503, message: "unavailable" } });
      if (has(q, "jevquota")) return json(res, 402, { error: { code: 402, message: "Insufficient credits", metadata: { limit_source: "openrouter_credits" } } });
      const words = q.toLowerCase().split(/\W+/).filter((w) => w.length > 2 && !w.startsWith("fixture"));
      const answers = {};
      for (const [key, question] of Object.entries(body?.questions ?? {})) {
        const id = /candidates\.(\w+)/.exec(question.instructions ?? "")?.[1];
        const c = body?.state?.candidates?.[id] ?? {};
        const text = `${c.title ?? ""} ${c.excerpt ?? ""}`.toLowerCase();
        const hit = text.includes("fixture:irrelevant") ? 0 : words.length ? words.filter((w) => text.includes(w)).length / words.length : 0.5;
        if (question.type === "score") answers[key] = { type: "score", score: Math.round(hit * 4 * 100) / 100, confidence: 0.6 };
        else if (question.type === "noul") answers[key] = { type: "noul", noul: key === "needs_documentation" ? (/(api|docs?|sdk|config|vue|react)/i.test(q) ? 0.8 : 0.05) : Math.min(1, hit) };
        else if (question.type === "choice") answers[key] = { type: "choice", choice: Object.hasOwn(question.criteria ?? {}, "same_document") ? "independent" : "unknown", confidence: 0.5 };
      }
      const inputTokens = Math.ceil(JSON.stringify(body ?? {}).length / 4);
      json(res, 200, { id: `gen-${sha(JSON.stringify(body)).slice(0, 8)}`, model: "typesafe/jev-1.14-fixture", provider: "fixture", answers, usage: { input_tokens: inputTokens, output_tokens: 10, cost: (inputTokens * 0.042) / 1e6 } });
    },
  };
  return {
    seen, sessions,
    handler: async (req, res) => {
      const host = String(req.headers.host ?? "").split(".")[0];
      const h = handlers[host];
      if (!h) return json(res, 404, { error: `no fixture provider for ${req.headers.host}` });
      const text = await readBody(req);
      let body = null;
      try { body = text ? JSON.parse(text) : null; } catch { body = null; }
      try { await h(req, res, body); } catch (e) { log({ fixture: host, error: e.message }); if (!res.headersSent) json(res, 500, { error: "fixture failed" }); }
    },
  };
}
