// Requests to provider APIs (FIRECRAWL_PI_SPEC.md §7.1, §20.1, §20.4): only the base URLs the budget
// policy lists, each checked by the same target rules as any fetch (the Cloud denylist, public
// addresses only, TLS verified), resolved once and connected to exactly that address, no redirect
// followed, the answer size-capped. A fixture provider is reached only on the fixture network.
// What the caller must know for its reservation is which side of the send a failure fell on:
//   sent: false  the request never left (no connection, or refused before a byte was written): the
//                reservation is released;
//   sent: true   the request may have reached the provider and no answer came: the outcome is
//                unknown and the reservation stays counted (spec §24.2).
// timeoutMs bounds the whole exchange. idleMs, for a streamed answer, also ends one that is silent for that long: from the
// request's creation (so a stalled connection or handshake ends unsent), then from the send and each chunk received.
import http from "node:http";
import https from "node:https";
import { readFileSync } from "node:fs";
import { parseTarget, Denied } from "./ssrf.mjs";
import { resolveTarget, pinnedLookup } from "./resolve.mjs";

export class ProviderError extends Error {
  constructor(code, message, { sent, status = null } = {}) { super(message); this.code = code; this.sent = sent; this.status = status; }
}

// The credential file for a provider, read at each call so a key placed later needs no restart; null
// when it is absent (the provider is then BLOCKED_CREDENTIAL, never "configured").
export function readCredential(dir, name) {
  if (!name) return null;
  try { const v = readFileSync(`${dir}/${name}`, "utf8").trim(); return v || null; } catch { return null; }
}

export async function providerRequest({ baseUrl, path, method = "POST", headers = {}, body = null, timeoutMs, idleMs = null, maxBytes = 4 * 1048576, getPolicy, resolvePublic, lookupFixture, signal, authorize }) {
  const url = new URL(baseUrl.replace(/\/$/, "") + path);
  const policy = getPolicy();
  if (!policy.localCidrs) throw new ProviderError("NOT_READY", "the host's local-network list is not loaded", { sent: false });
  let target, address;
  try {
    target = parseTarget(url.toString(), policy);
    address = await resolveTarget(target, { resolvePublic, policy, lookupFixture });
  } catch (e) {
    if (e instanceof Denied) throw new ProviderError(e.failureClass === "DNS_FAILURE" ? "PROVIDER_UNREACHABLE" : "PROVIDER_DENIED", e.detail, { sent: false });
    throw e;
  }
  const mod = url.protocol === "https:" ? https : http;
  if (authorize && !authorize()) throw new ProviderError("PAID_DISPATCH_DISABLED", "the paid dispatch lease expired before connection", { sent: false });
  // The body is one buffer or a list of buffers written in order (a multipart upload's parts).
  const parts = body === null ? null : Array.isArray(body) ? body : [body];
  const length = parts ? parts.reduce((n, p) => n + p.length, 0) : 0;
  return new Promise((resolve, reject) => {
    let written = false, settled = false;
    let idle = null;
    const done = (fn, v) => { if (!settled) { settled = true; clearTimeout(timer); clearTimeout(idle); fn(v); } };
    const quiet = () => {
      if (!idleMs || settled) return;
      clearTimeout(idle);
      idle = setTimeout(() => { req.destroy(new Error("idle")); done(reject, new ProviderError(written ? "PROVIDER_UNCERTAIN" : "PROVIDER_UNREACHABLE", `${written ? "nothing arrived" : "no connection"} for ${idleMs} ms`, { sent: written })); }, idleMs);
    };
    const req = mod.request({ host: target.host, port: target.port, method, path: url.pathname + url.search, agent: false, lookup: pinnedLookup(address),
      servername: target.literal ? undefined : target.host, rejectUnauthorized: true,
      headers: { ...headers, host: url.host, ...(parts ? { "content-length": length } : {}) } }, (res) => {
      const chunks = [];
      let n = 0;
      res.on("data", (c) => { quiet(); n += c.length; if (n > maxBytes) { res.destroy(); done(reject, new ProviderError("PROVIDER_RESPONSE_TOO_LARGE", `the provider's answer exceeds ${maxBytes} bytes`, { sent: true, status: res.statusCode })); } else chunks.push(c); });
      res.on("end", () => done(resolve, { status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
      res.on("error", () => done(reject, new ProviderError("PROVIDER_UNCERTAIN", "the provider's answer was cut off", { sent: true, status: res.statusCode })));
      res.on("aborted", () => done(reject, new ProviderError("PROVIDER_UNCERTAIN", "the provider's answer was cut off", { sent: true, status: res.statusCode })));
    });
    quiet();
    // Send only after connection/TLS and the final authorization check. Do not buffer credential-bearing
    // headers or a billable body across the handshake while a validation lease can expire.
    const send = () => {
      if (settled) return;
      if (authorize && !authorize()) {
        done(reject, new ProviderError("PAID_DISPATCH_DISABLED", "the paid dispatch lease expired before send", { sent: false }));
        req.destroy();
        return;
      }
      written = true;
      quiet();
      for (const p of parts?.slice(0, -1) ?? []) req.write(p);
      req.end(parts ? parts.at(-1) : undefined);
    };
    req.on("socket", (s) => {
      // A non-streamed answer from a model that reasons sends nothing until it has finished: keep the idle connection alive through NAT.
      s.setKeepAlive(true, 30000);
      s.once("connect", () => { if (s.remoteAddress && s.remoteAddress !== address) req.destroy(new Error("peer changed")); else if (mod === http) send(); });
      if (mod === https) s.once("secureConnect", send);
    });
    const timer = setTimeout(() => { req.destroy(new Error("timeout")); done(reject, new ProviderError(written ? "PROVIDER_UNCERTAIN" : "PROVIDER_UNREACHABLE", `no answer within ${timeoutMs} ms`, { sent: written })); }, timeoutMs);
    req.on("error", (e) => done(reject, new ProviderError(written ? "PROVIDER_UNCERTAIN" : "PROVIDER_UNREACHABLE", `${url.host}: ${e.code ?? e.message}`, { sent: written })));
    signal?.addEventListener("abort", () => { req.destroy(new Error("cancelled")); done(reject, new ProviderError(written ? "PROVIDER_UNCERTAIN" : "CANCELLED", "the caller cancelled", { sent: written })); }, { once: true });
  });
}
