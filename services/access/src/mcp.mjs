// The /mcp route (FIRECRAWL_PI_SPEC.md §17.2, §20.1): the gateway has already checked the Host, the
// Origin and the bearer token when this runs, so no unauthenticated or foreign request reaches the MCP
// service, and an authentication failure can never be answered as a protocol downgrade. It then:
//   - reads the body under the gateway's cap (413 before anything is parsed);
//   - forwards the request to the MCP service's fixed address with a header set it builds itself: the
//     MCP protocol headers the client sent, the client's own Authorization (the credential the MCP
//     service presents back to the REST routes, which authorize every call again), the validated Host,
//     and the validated identity as x-fcpi-* headers, so a client's own x-fcpi-* headers never pass;
//   - streams the answer back as it arrives (JSON or request-scoped SSE), passing only content-type
//     and cache-control;
//   - cancels the MCP request when its client goes away (spec §17.3), and answers 503 MCP_UNAVAILABLE
//     when the MCP service is stopped, so the REST routes never depend on it.
import { request as httpRequest } from "node:http";

const FORWARD = new Set(["content-type", "accept", "mcp-protocol-version", "mcp-method", "mcp-name"]);
const PARAM = /^mcp-param-[a-z0-9-]{1,64}$/;
const PASS = new Set(["content-type", "cache-control"]);

export function makeMcpProxy({ url, limits, readBody, send }) {
  const base = { host: url.hostname, port: Number(url.port || 80) };
  let inFlight = 0;
  return {
    get inFlight() { return inFlight; },
    async handle(ctx) {
      const { req, res } = ctx;
      const method = req.headers["mcp-method"];
      ctx.extra = { mcp_method: typeof method === "string" && /^[a-z/_]{1,64}$/.test(method) ? method : method === undefined ? null : "invalid" };
      const body = req.method === "POST" ? await readBody(req) : null;
      if (inFlight >= limits.maxInFlight) return send(ctx, 503, { success: false, code: "OVERLOADED", error: `${inFlight} MCP requests are already in flight (limit ${limits.maxInFlight}); retry shortly.` }, { "retry-after": "5" });
      inFlight += 1;
      const headers = { host: req.headers.host, authorization: req.headers.authorization, "x-request-id": ctx.id,
        "x-fcpi-client": ctx.client.label, "x-fcpi-principal": ctx.client.principal, "x-fcpi-scopes": [...ctx.client.scopes].sort().join(",") };
      for (const [k, v] of Object.entries(req.headers)) if (FORWARD.has(k) || PARAM.test(k)) headers[k] = v;
      if (body) headers["content-length"] = body.length;
      let settled = false;
      const finish = (status) => { if (!settled) { settled = true; inFlight -= 1; clearTimeout(timer); ctx.logged(status); } };
      const up = httpRequest({ ...base, method: req.method, path: "/mcp", headers, agent: false });
      // One deadline for the whole exchange, streamed or not: past it the exchange is cut.
      const timer = setTimeout(() => up.destroy(new Error("exchange deadline")), limits.exchangeTimeoutMs);
      const unavailable = () => {
        if (settled) return;
        if (res.headersSent) { res.destroy(); return finish(502); }
        settled = true; inFlight -= 1; clearTimeout(timer);
        send(ctx, 503, { success: false, code: "MCP_UNAVAILABLE", error: "The MCP service is not answering; the REST routes are unaffected. Retry shortly." }, { "retry-after": "5" });
      };
      up.on("response", (ur) => {
        const out = { "x-request-id": ctx.id };
        for (const [k, v] of Object.entries(ur.headers)) if (PASS.has(k)) out[k] = v;
        res.writeHead(ur.statusCode, out);
        ur.pipe(res);
        ur.on("end", () => finish(ur.statusCode));
        ur.on("error", unavailable);
        ur.on("close", () => { if (!ur.complete) unavailable(); });
      });
      up.on("error", unavailable);
      // A stopped MCP container leaves its fixed address unanswered: give up on connecting after 2 s.
      up.on("socket", (s) => { if (s.connecting) { const t = setTimeout(() => up.destroy(new Error("connect timeout")), 2000); s.once("connect", () => clearTimeout(t)); } });
      // The client went away before the answer ended: the MCP request is cancelled with it.
      res.on("close", () => { if (!res.writableFinished && !settled) { up.destroy(); finish(499); } });
      up.end(body ?? undefined);
    },
  };
}
