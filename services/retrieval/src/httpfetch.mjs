// Guarded HTTP retrieval: one request per hop, each hop's URL validated (parseTarget), resolved
// and pinned (resolveTarget, pinnedLookup) before its connection, redirects followed here (never
// by a library) up to the policy's limit, and the body bounded before and after decompression.
// TLS certificates are always verified. Caller-supplied Authorization and Cookie headers go only
// to the first origin; a per-acquisition cookie jar keeps cookies per host across redirects.
import http from "node:http";
import https from "node:https";
import zlib from "node:zlib";
import { parseTarget, Denied } from "./ssrf.mjs";
import { resolveTarget, pinnedLookup } from "./resolve.mjs";

export const USER_AGENT = "Mozilla/5.0 (X11; Linux aarch64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/153.0.0.0 Safari/537.36";
const REDIRECTS = new Set([301, 302, 303, 307, 308]);
// Headers a caller may set; everything else (Host, hop-by-hop, Proxy-*, forwarding and internal
// identity headers) is dropped.
const CALLER_HEADERS = new Set(["accept", "accept-language", "authorization", "cookie", "referer", "user-agent", "cache-control", "pragma"]);
const ORIGIN_BOUND = new Set(["authorization", "cookie"]);
const TLS_ERRORS = new Set(["CERT_HAS_EXPIRED", "UNABLE_TO_VERIFY_LEAF_SIGNATURE", "ERR_TLS_CERT_ALTNAME_INVALID", "DEPTH_ZERO_SELF_SIGNED_CERT",
  "SELF_SIGNED_CERT_IN_CHAIN", "UNABLE_TO_GET_ISSUER_CERT_LOCALLY", "CERT_NOT_YET_VALID", "ERR_SSL_WRONG_VERSION_NUMBER", "EPROTO"]);
const NET_ERRORS = new Set(["ECONNREFUSED", "ECONNRESET", "EHOSTUNREACH", "ENETUNREACH", "ETIMEDOUT", "EPIPE", "ECONNABORTED", "EAI_AGAIN", "HPE_INVALID_CONSTANT"]);

export function callerHeaders(headers) {
  const out = {};
  let size = 0;
  for (const [k, v] of Object.entries(headers ?? {})) {
    const key = k.toLowerCase();
    if (!CALLER_HEADERS.has(key) || typeof v !== "string") continue;
    size += key.length + v.length;
    if (size > 16384) throw new Denied("INVALID_REQUEST", "caller headers exceed 16 KiB");
    out[key] = v;
  }
  return out;
}

export class CookieJar {
  #byHost = new Map();
  header(url) {
    const c = this.#byHost.get(url.hostname);
    return c && c.size ? [...c].map(([k, v]) => `${k}=${v}`).join("; ") : null;
  }
  store(url, setCookie) {
    for (const line of [].concat(setCookie ?? [])) {
      const [pair] = String(line).split(";");
      const eq = pair.indexOf("=");
      if (eq <= 0) continue;
      const c = this.#byHost.get(url.hostname) ?? this.#byHost.set(url.hostname, new Map()).get(url.hostname);
      if (c.size < 64) c.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim());
    }
  }
}

function decoderFor(encoding) {
  switch ((encoding ?? "").trim().toLowerCase()) {
    case "": case "identity": return null;
    case "gzip": case "x-gzip": return zlib.createGunzip();
    case "deflate": return zlib.createInflate();
    case "br": return zlib.createBrotliDecompress();
    default: throw new Denied("UNSUPPORTED_CONTENT", `content-encoding ${encoding}`);
  }
}

// One request to one pinned address. Resolves { status, headers, body (Buffer), wireBytes }.
function requestOnce({ target, address, method, headers, maxBytes, deadline, signal, onPeer }) {
  return new Promise((resolve, reject) => {
    const remaining = deadline - Date.now();
    if (remaining <= 0) return reject(new Denied("DEADLINE_EXCEEDED", "no time left for the request"));
    const tls = target.url.protocol === "https:";
    let settled = false;
    const fail = (e) => { if (!settled) { settled = true; req.destroy(); reject(e); } };
    const req = (tls ? https : http).request({
      host: target.host, port: target.port, method, path: target.url.pathname + target.url.search,
      headers: { host: target.url.host, "user-agent": USER_AGENT, accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "accept-encoding": "gzip, deflate, br", ...headers },
      lookup: pinnedLookup(address), agent: false, ...(tls ? { servername: target.host, rejectUnauthorized: true } : {}),
    });
    const timer = setTimeout(() => fail(new Denied("TIMEOUT", `no complete response within ${remaining} ms`)), remaining);
    const onAbort = () => fail(new Denied("CANCELLED", "the caller cancelled the acquisition"));
    signal?.addEventListener("abort", onAbort, { once: true });
    const done = () => { clearTimeout(timer); signal?.removeEventListener("abort", onAbort); };
    req.on("socket", (socket) => {
      const check = () => {
        // The peer must be the address that was validated; anything else is refused.
        if (socket.remoteAddress && socket.remoteAddress !== address) fail(new Denied("SSRF_DENIED", `connected peer ${socket.remoteAddress} is not the validated ${address}`));
        else onPeer?.(socket.remoteAddress);
      };
      if (socket.remoteAddress) check(); else socket.once("connect", check);
    });
    req.on("error", (e) => {
      done();
      if (e instanceof Denied) return fail(e);
      const code = e.code ?? "";
      if (TLS_ERRORS.has(code)) return fail(new Denied("TLS_FAILURE", `${target.host}: ${code}`));
      if (NET_ERRORS.has(code)) return fail(new Denied("TARGET_UNREACHABLE", `${target.host}: ${code}`));
      fail(new Denied("TARGET_UNREACHABLE", `${target.host}: ${code || e.message}`));
    });
    req.on("response", (res) => {
      const declared = Number(res.headers["content-length"] ?? NaN);
      if (Number.isFinite(declared) && declared > maxBytes) { done(); return fail(new Denied("SIZE_LIMIT", `declared length ${declared} exceeds ${maxBytes}`)); }
      if (method === "HEAD" || REDIRECTS.has(res.statusCode) || res.statusCode === 204 || res.statusCode === 304) {
        res.resume();
        res.on("end", () => { done(); if (!settled) { settled = true; resolve({ status: res.statusCode, headers: res.headers, body: Buffer.alloc(0), wireBytes: 0 }); } });
        return;
      }
      let decoder;
      try { decoder = decoderFor(res.headers["content-encoding"]); } catch (e) { done(); return fail(e); }
      let wire = 0, out = 0;
      const chunks = [];
      res.on("data", (c) => { wire += c.length; if (wire > maxBytes) { done(); fail(new Denied("SIZE_LIMIT", `body exceeds ${maxBytes} bytes`)); } });
      const sink = decoder ? res.pipe(decoder) : res;
      sink.on("data", (c) => {
        out += c.length;
        if (out > maxBytes) { done(); return fail(new Denied("SIZE_LIMIT", `decoded body exceeds ${maxBytes} bytes`)); }
        chunks.push(c);
      });
      sink.on("error", () => { done(); fail(new Denied("UNSUPPORTED_CONTENT", "the body could not be decoded")); });
      sink.on("end", () => { done(); if (!settled) { settled = true; resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks), wireBytes: wire }); } });
      res.on("error", (e) => { done(); fail(new Denied("TARGET_UNREACHABLE", `${target.host}: ${e.code ?? e.message}`)); });
    });
    req.end();
  });
}

// Fetch a URL under the policy. Resolves { finalUrl, status, headers, body, bytes, redirects }.
// Throws Denied for every refusal or network failure; the class says which.
export async function guardedFetch({ url, method = "GET", headers, maxBytes, deadline, policy, resolvePublic, lookupFixture, jar = new CookieJar(), signal, onHop }) {
  const redirects = [];
  let current = url, verb = method;
  let extra = callerHeaders(headers);
  const firstOrigin = new URL(url).origin;
  for (let hop = 0; ; hop++) {
    const target = parseTarget(current, policy);
    const address = await resolveTarget(target, { resolvePublic, policy, lookupFixture });
    await onHop?.({ hop, target, address });
    const cookie = jar.header(target.url);
    const sent = { ...extra };
    if (target.url.origin !== firstOrigin) for (const k of ORIGIN_BOUND) delete sent[k];
    if (cookie) sent.cookie = sent.cookie ? `${sent.cookie}; ${cookie}` : cookie;
    const res = await requestOnce({ target, address, method: verb, headers: sent, maxBytes, deadline, signal });
    jar.store(target.url, res.headers["set-cookie"]);
    redirects.push({ url: current, status: res.status, address });
    if (REDIRECTS.has(res.status) && res.headers.location) {
      if (hop >= policy.maxRedirects) throw new Denied("TOO_MANY_REDIRECTS", `more than ${policy.maxRedirects} redirects`);
      let next;
      try { next = new URL(res.headers.location, current).toString(); } catch { throw new Denied("INVALID_URL", "unparseable redirect location"); }
      if (res.status === 303 || ((res.status === 301 || res.status === 302) && verb === "POST")) verb = "GET";
      current = next;
      continue;
    }
    return { finalUrl: current, status: res.status, headers: res.headers, body: res.body, bytes: res.wireBytes, redirects };
  }
}
