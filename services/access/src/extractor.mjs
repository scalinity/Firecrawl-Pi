// The gateway's client for the retrieval service's extraction listener (FIRECRAWL_PI_SPEC.md §14, §20.1;
// M5): one fixed address on fcpi_model, the gateway's own credential, and the documents the gateway
// scraped through the core. The model adapter, its provider credential and its budget are the retrieval
// service's; the gateway holds none of them.
import { request } from "node:http";

export class ExtractorError extends Error {
  // delivered: whether the request may have reached the service (its reservations are keyed by the
  // logical id, so a retry of a delivered request reuses what was settled and never re-sends what is
  // uncertain).
  constructor(message, { code, delivered }) { super(message); this.code = code; this.delivered = delivered; }
}

export function makeExtractor({ url, token }) {
  const base = new URL(url);
  function call(method, path, body, timeoutMs) {
    return new Promise((resolve, reject) => {
      const data = body === undefined ? null : Buffer.from(JSON.stringify(body));
      let connected = false, settled = false;
      const done = (fn, v) => { if (!settled) { settled = true; fn(v); } };
      const req = request({ host: base.hostname, port: Number(base.port || 80), method, path, agent: false, timeout: timeoutMs,
        headers: { authorization: `Bearer ${token}`, accept: "application/json", ...(data ? { "content-type": "application/json", "content-length": data.length } : {}) } }, (res) => {
        const chunks = [];
        let n = 0;
        res.on("data", (c) => { n += c.length; if (n > 8 * 1048576) { res.destroy(); done(reject, new ExtractorError("answer exceeds 8 MiB", { code: "TOO_LARGE", delivered: true })); } else chunks.push(c); });
        res.on("end", () => { let json = null; try { json = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { /* not JSON */ } done(resolve, { status: res.statusCode, json }); });
        res.on("error", () => done(reject, new ExtractorError("answer cut off", { code: "RESET", delivered: true })));
      });
      req.on("socket", (s) => { if (!s.connecting) connected = true; else s.once("connect", () => { connected = true; }); });
      req.on("timeout", () => req.destroy(new ExtractorError("timeout", { code: "TIMEOUT", delivered: connected })));
      req.on("error", (e) => done(reject, e instanceof ExtractorError ? e : new ExtractorError(e.message, { code: e.code ?? "ERROR", delivered: connected })));
      req.end(data ?? undefined);
    });
  }
  return {
    extract: (body, timeoutMs) => call("POST", "/internal/extract", body, timeoutMs),
    providers: () => call("GET", "/internal/providers", undefined, 5000),
  };
}
