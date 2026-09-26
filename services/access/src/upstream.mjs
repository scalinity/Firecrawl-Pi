// Calls to the core's native API. The gateway builds every upstream request from scratch: no client
// header, query string or credential is forwarded, and upstream authentication challenges never
// reach a client (FIRECRAWL_PI_SPEC.md §20.3, §20.4).
import { request as httpRequest } from "node:http";

// Response headers never passed on: hop-by-hop headers and upstream's Cloud-pointing challenge.
const HOP = new Set(["connection", "keep-alive", "transfer-encoding", "upgrade", "proxy-authenticate", "proxy-authorization", "te", "trailer", "www-authenticate"]);

export class UpstreamError extends Error {
  // delivered: false when no connection to the core was ever established, so the request cannot
  // have reached it; true once connected, when its fate is unknown unless an answer arrived.
  constructor(message, { delivered, code }) { super(message); this.delivered = delivered; this.code = code; }
}

export function makeUpstream(cfg) {
  const base = { host: cfg.core.hostname, port: Number(cfg.core.port || 80) };

  // A JSON call, buffered, with a response-size ceiling checked against Content-Length before the
  // body is read. Each call uses its own connection, so `delivered` is exact.
  function call(method, path, { body, timeoutMs, maxBytes = 16 * 1048576 } = {}) {
    return new Promise((resolve, reject) => {
      const data = body === undefined ? null : Buffer.from(JSON.stringify(body));
      let connected = false, settled = false;
      const done = (fn, v) => { if (!settled) { settled = true; fn(v); } };
      const req = httpRequest({ ...base, method, path, agent: false, timeout: timeoutMs,
        headers: { accept: "application/json", ...(data ? { "content-type": "application/json", "content-length": data.length } : {}) } }, (res) => {
        const len = Number(res.headers["content-length"] ?? NaN);
        if (Number.isFinite(len) && len > maxBytes) {
          res.destroy();
          return done(reject, new UpstreamError(`upstream response of ${len} bytes exceeds ${maxBytes}`, { delivered: true, code: "TOO_LARGE" }));
        }
        const chunks = [];
        let size = 0;
        res.on("data", (c) => {
          size += c.length;
          if (size > maxBytes) { res.destroy(); done(reject, new UpstreamError(`upstream response exceeds ${maxBytes} bytes`, { delivered: true, code: "TOO_LARGE" })); } else chunks.push(c);
        });
        res.on("end", () => {
          const buf = Buffer.concat(chunks);
          let json = null;
          try { json = buf.length ? JSON.parse(buf.toString("utf8")) : null; } catch { /* not JSON */ }
          done(resolve, { status: res.statusCode, json, bytes: buf.length });
        });
        res.on("error", (e) => done(reject, new UpstreamError(e.message, { delivered: true, code: "RESET" })));
        res.on("aborted", () => done(reject, new UpstreamError("upstream response aborted", { delivered: true, code: "RESET" })));
      });
      req.on("socket", (s) => { if (!s.connecting) connected = true; else s.once("connect", () => { connected = true; }); });
      req.on("timeout", () => req.destroy(new UpstreamError("upstream timeout", { delivered: connected, code: "TIMEOUT" })));
      req.on("error", (e) => done(reject, e instanceof UpstreamError ? e : new UpstreamError(e.message, { delivered: connected, code: e.code ?? "ERROR" })));
      req.end(data ?? undefined);
    });
  }

  // A synchronous route: the answer is streamed back as it arrives (a scrape can carry megabytes).
  // Failures before upstream headers are the gateway's own 502/504; after them the client response
  // can only be cut. A client that goes away cancels the upstream request.
  function forward(res, path, body, log, extraHeaders) {
    let settled = false, timedOut = false;
    const finish = (status) => { if (!settled) { settled = true; log(status); } };
    const fail = () => {
      if (settled) return;
      const status = timedOut ? 504 : 502;
      if (res.headersSent) res.destroy();
      else sendJson(res, status, { success: false, code: timedOut ? "UPSTREAM_TIMEOUT" : "UPSTREAM_UNAVAILABLE", error: timedOut ? "The core did not answer in time." : "The core is unavailable." }, extraHeaders);
      finish(status);
    };
    const data = Buffer.from(JSON.stringify(body));
    const up = httpRequest({ ...base, method: "POST", path, timeout: cfg.coreTimeoutMs,
      headers: { "content-type": "application/json", "content-length": data.length, accept: "application/json" } }, (ur) => {
      const headers = { ...extraHeaders };
      for (const [k, v] of Object.entries(ur.headers)) if (!HOP.has(k)) headers[k] = v;
      res.writeHead(ur.statusCode, headers);
      ur.pipe(res);
      ur.on("end", () => finish(ur.statusCode));
      ur.on("error", fail);
      ur.on("close", () => { if (!ur.complete) fail(); });
    });
    up.on("timeout", () => { timedOut = true; up.destroy(new Error("upstream timeout")); });
    up.on("error", fail);
    res.on("close", () => { if (!res.writableFinished && !settled) { up.destroy(); finish(499); } });
    up.end(data);
  }

  return { call, forward };
}

export function sendJson(res, status, body, extra = {}) {
  const buf = Buffer.from(JSON.stringify(body));
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "content-length": buf.length, "cache-control": "no-store", ...extra });
  res.end(buf);
}
