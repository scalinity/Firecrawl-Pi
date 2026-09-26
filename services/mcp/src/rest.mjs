// Calls to the access gateway's REST routes, the MCP gateway's one destination (FIRECRAWL_PI_SPEC.md
// §20.1). Each call carries the caller's own bearer token, so the gateway authenticates, scopes and
// owner-binds it exactly as it would a REST client's; and the Host the caller used, so the result
// addresses the gateway returns name the origin the caller reached it at. A keep-alive pool is the
// only state shared between requests (spec §17.2). An aborted MCP request aborts its REST call, and
// the gateway, seeing its client go, cancels the core request behind it.
import { request, Agent } from "node:http";

export class RestError extends Error {
  constructor(message, code) { super(message); this.code = code; }
}

export function makeRest(cfg) {
  const L = cfg.manifest.mcp.limits;
  const agent = new Agent({ keepAlive: true, maxSockets: L.maxToolCalls * 2 });
  const base = { host: cfg.rest.hostname, port: Number(cfg.rest.port || 80) };

  // Resolves { status, json, headers, bytes }; rejects with a RestError coded ABORTED, TIMEOUT,
  // TOO_LARGE or UNAVAILABLE.
  function call({ method, path, token, host, body, idemKey, signal }) {
    return new Promise((resolve, reject) => {
      if (signal?.aborted) return reject(new RestError("the MCP request was cancelled", "ABORTED"));
      const data = body === undefined ? null : Buffer.from(JSON.stringify(body));
      let settled = false;
      const done = (fn, v) => { if (!settled) { settled = true; signal?.removeEventListener("abort", onAbort); fn(v); } };
      const req = request({ ...base, agent, method, path, timeout: L.restTimeoutMs, headers: {
        host, authorization: `Bearer ${token}`, accept: "application/json",
        ...(idemKey ? { "x-idempotency-key": idemKey } : {}),
        ...(data ? { "content-type": "application/json", "content-length": data.length } : {}) } }, (res) => {
        const len = Number(res.headers["content-length"] ?? NaN);
        if (Number.isFinite(len) && len > L.restResponseMaxBytes) { done(reject, new RestError(`the gateway's answer of ${len} bytes exceeds ${L.restResponseMaxBytes}`, "TOO_LARGE")); return res.destroy(); }
        const chunks = [];
        let size = 0;
        res.on("data", (c) => {
          size += c.length;
          if (size > L.restResponseMaxBytes) { done(reject, new RestError(`the gateway's answer exceeds ${L.restResponseMaxBytes} bytes`, "TOO_LARGE")); res.destroy(); } else chunks.push(c);
        });
        res.on("end", () => {
          const buf = Buffer.concat(chunks);
          let json = null;
          try { json = buf.length ? JSON.parse(buf.toString("utf8")) : null; } catch { /* not JSON */ }
          done(resolve, { status: res.statusCode, json, headers: res.headers, bytes: buf.length });
        });
        res.on("error", (e) => done(reject, new RestError(e.message, "UNAVAILABLE")));
        res.on("aborted", () => done(reject, new RestError("the gateway's answer was cut", "UNAVAILABLE")));
      });
      function onAbort() { req.destroy(); done(reject, new RestError("the MCP request was cancelled", "ABORTED")); }
      signal?.addEventListener("abort", onAbort, { once: true });
      req.on("timeout", () => { req.destroy(); done(reject, new RestError(`the gateway did not answer within ${L.restTimeoutMs} ms`, "TIMEOUT")); });
      req.on("error", (e) => done(reject, new RestError(e.message, "UNAVAILABLE")));
      req.end(data ?? undefined);
    });
  }
  return { call, close: () => agent.destroy() };
}
