// Calls to the core's native API. The gateway builds every upstream request from scratch: no client
// header, query string or credential is forwarded, and upstream authentication challenges never
// reach a client (FIRECRAWL_PI_SPEC.md §20.3, §20.4).
import { request as httpRequest } from "node:http";

// The only upstream response headers passed on. Everything else stays behind: hop-by-hop headers,
// upstream's Cloud-pointing challenge, and the `Access-Control-Allow-Origin: *` its cors() middleware
// adds to every answer (apps/api/src/index.ts), since the gateway sends no CORS headers.
const PASS = new Set(["content-type", "content-length", "retry-after"]);

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
          // Settle first: destroying an unfinished response emits "aborted" at once, which would settle it as RESET.
          done(reject, new UpstreamError(`upstream response of ${len} bytes exceeds ${maxBytes}`, { delivered: true, code: "TOO_LARGE" }));
          return res.destroy();
        }
        const chunks = [];
        let size = 0;
        res.on("data", (c) => {
          size += c.length;
          if (size > maxBytes) { done(reject, new UpstreamError(`upstream response exceeds ${maxBytes} bytes`, { delivered: true, code: "TOO_LARGE" })); res.destroy(); } else chunks.push(c);
        });
        res.on("end", () => {
          // The chunks, then the joined buffer, are let go before the parse, so an answer is held at most twice at once
          // (text and parsed object), not four times (review W10).
          let buf = Buffer.concat(chunks, size);
          chunks.length = 0;
          const bytes = buf.length;
          let text = bytes ? buf.toString("utf8") : null;
          buf = null;
          let json = null;
          try { json = text ? JSON.parse(text) : null; } catch { /* not JSON */ }
          text = null;
          done(resolve, { status: res.statusCode, json, bytes });
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
  // Failures before upstream headers are the gateway's own 503/504, never 502, which a client library retries by
  // resubmitting (a new job, and for an enhanced scrape a second paid dispatch: review W14); after them the client
  // response can only be cut. A client that goes away cancels the upstream request. M7: keep, when given, is told the whole
  // answer once it has been sent (keep.onComplete(status, buffer), the buffer null past keep.maxBytes), and nothing when
  // the answer failed; the stream to the client is never held back for it.
  function forward(res, path, body, log, extraHeaders, keep = null) {
    let settled = false, timedOut = false;
    const finish = (status) => { if (!settled) { settled = true; log(status); } };
    const fail = () => {
      if (settled) return;
      const status = timedOut ? 504 : 503;
      if (res.headersSent) res.destroy();
      else sendJson(res, status, { success: false, code: timedOut ? "UPSTREAM_TIMEOUT" : "UPSTREAM_UNAVAILABLE", error: timedOut ? "The core did not answer in time." : "The core is unavailable." }, { ...extraHeaders, ...(timedOut ? {} : { "retry-after": "10" }) });
      finish(status);
    };
    const data = Buffer.from(JSON.stringify(body));
    const up = httpRequest({ ...base, method: "POST", path, timeout: cfg.coreTimeoutMs,
      headers: { "content-type": "application/json", "content-length": data.length, accept: "application/json" } }, (ur) => {
      const headers = { ...extraHeaders };
      for (const [k, v] of Object.entries(ur.headers)) if (PASS.has(k)) headers[k] = v;
      res.writeHead(ur.statusCode, headers);
      const kept = [];
      let keptBytes = 0;
      if (keep) ur.on("data", (c) => { keptBytes += c.length; if (keptBytes <= keep.maxBytes) kept.push(c); });
      ur.pipe(res);
      ur.on("end", () => { finish(ur.statusCode); if (keep) Promise.resolve(keep.onComplete(ur.statusCode, keptBytes <= keep.maxBytes ? Buffer.concat(kept) : null)).catch(() => {}); });
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
