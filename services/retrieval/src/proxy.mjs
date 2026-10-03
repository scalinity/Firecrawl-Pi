// The browser's only way out (FIRECRAWL_PI_SPEC.md §12, §20.2). The browser worker sits on an
// internal network whose only other member is this service, and Chromium sends every request
// through this forward proxy with the credential of the attempt it belongs to. Each request -
// the page, its redirects and every subresource - is validated with the same rules as a direct
// fetch, resolved once and connected to exactly the checked address; bytes are counted per
// attempt and cut off at the page's limit. An unknown or expired credential gets 407; a refused
// target gets 403 and is counted.
// M6: a session may chain through the residential provider. A browser attempt on the residential route carries its
// leg (upstream: residential.leg's meter and tunnel opener, whose streams are already metered), so the page and
// every subresource leave under one sticky session; SearXNG's standing session asks, per engine host, for a leg of
// its own (upstreamFor), so an engine the policy routes residential never leaves from the home connection (F11).
// Every request is still validated and resolved here first.
import http from "node:http";
import net from "node:net";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { parseTarget, Denied, scopeFixtures } from "./ssrf.mjs";
import { resolveTarget, pinnedLookup } from "./resolve.mjs";

const HOP = new Set(["connection", "keep-alive", "proxy-authorization", "proxy-authenticate", "proxy-connection", "te", "trailer", "transfer-encoding", "upgrade"]);
const digest = (s) => createHash("sha256").update(s).digest();

export class ProxySessions {
  #s = new Map();
  // A session for one browser attempt; returns the credential the browser presents.
  // maxRequests bounds what the page may ask for through the proxy (WebSockets and preconnects never
  // reach the worker's own subresource count); a session past either cap is marked capped.
  // fixture: the page is a fixture, so its requests may reach fixture hosts; otherwise none may.
  open(attemptId, { expiresAt, maxBytes, maxRequests = 250, fixture = false, upstream = null }) {
    const password = randomBytes(24).toString("hex");
    this.#s.set(attemptId, { attemptId, hash: digest(password), expiresAt, maxBytes, maxRequests, fixture, upstream, upstreamFailure: null, bytes: 0, requests: 0, capped: false, denied: [], sockets: new Set() });
    return { username: attemptId, password };
  }
  // A standing session for a service rather than an attempt (M5: SearXNG's engine requests): its
  // credential's SHA-256 comes from a secret file, it does not expire, and allow(target) decides each
  // request by the host's current selection. Each of its requests is logged by host (logEach), so every
  // search-engine connection is attributable.
  // upstreamFor(target): null for a direct connection, or a leg ({ open, meter, done }) for a residential one; it
  // throws a Denied (PROXY_REQUIRED, BUDGET_EXHAUSTED) when the host must go residential and cannot.
  fixed(username, passwordSha256, { allow, fixture, upstreamFor = null }) {
    this.#s.set(username, { attemptId: username, hash: passwordSha256, expiresAt: Infinity, maxBytes: Infinity, maxRequests: Infinity, fixture, allow, upstreamFor, logEach: true,
      bytes: 0, requests: 0, capped: false, denied: [], sockets: new Set() });
  }
  auth(header) {
    const m = /^Basic ([A-Za-z0-9+/=]+)$/.exec(header ?? "");
    if (!m) return null;
    const [user, pass] = Buffer.from(m[1], "base64").toString("utf8").split(":");
    const s = this.#s.get(user ?? "");
    if (!s || !pass || Date.now() > s.expiresAt) return null;
    return timingSafeEqual(s.hash, digest(pass)) ? s : null;
  }
  // Ends a session: its open connections are destroyed and its counters returned.
  close(attemptId) {
    const s = this.#s.get(attemptId);
    if (!s) return null;
    this.#s.delete(attemptId);
    for (const sock of s.sockets) sock.destroy();
    return { requests: s.requests, bytes: s.bytes, capped: s.capped, denied: s.denied, upstreamFailure: s.upstreamFailure };
  }
  sweep() { for (const [id, s] of this.#s) if (Date.now() > s.expiresAt + 5000) this.close(id); }
}

export function startProxy({ listen, sessions, getPolicy, resolvePublic, lookupFixture, log }) {
  // An attempt's refusals are returned when it closes; a standing session never closes, so it keeps none
  // and each refusal is only logged (review S5).
  const refuse = (s, target, e, rawUrl = null) => {
    if (!s.logEach) {
      const denied = { host: target, class: e.failureClass ?? "PROXY_ERROR" };
      // Correlate HTTP navigation refusals without retaining URL/query text.
      if (rawUrl && ["SSRF_DENIED", "CLOUD_DENIED"].includes(denied.class)) {
        try { const url = new URL(rawUrl); url.hash = ""; denied.urlHash = digest(url.href).toString("hex"); } catch { /* invalid target */ }
      }
      s.denied.push(denied);
    }
    log({ event: "proxy_denied", attempt_id: s.attemptId, target_host: target, failure: e.failureClass ?? "PROXY_ERROR", detail: e.detail ?? e.message });
  };
  const count = (s, n, ...socks) => {
    s.bytes += n;
    if (s.bytes > s.maxBytes) { s.capped = true; for (const x of socks) x.destroy(); }
  };
  // Past the session's request cap every further request is refused (review finding W6).
  const overRequests = (s) => { if (s.requests <= s.maxRequests) return false; s.capped = true; return true; };

  // The residential leg a request travels, if any: a browser attempt's own, or one the standing session asks for
  // per host (which refuses, as PROXY_REQUIRED, a host that must go residential and cannot). done() settles a
  // per-request leg's reservation once its connection has closed.
  const legFor = async (s, target) => (s.upstream ? { open: s.upstream.open, meter: s.upstream.meter, done: null } : s.upstreamFor ? await s.upstreamFor(target) : null);
  // The first provider refusal of an attempt is kept, so a render that failed on it is reported as the provider's.
  const upstreamFailed = (s, e) => { if (e?.provider && !s.upstreamFailure) s.upstreamFailure = { class: e.failureClass, detail: e.detail, retryable: e.retryable, retryAfter: e.retryAfter }; };
  const once = (fn) => { let done = false; return () => { if (!done && fn) { done = true; Promise.resolve(fn()).catch((e) => log({ event: "proxy_leg_settle_failed", error: e.message })); } }; };
  async function openLeg(s, target, port) {
    const leg = await legFor(s, target);
    if (!leg) return { leg: null, raw: null, done: () => {} };
    const done = once(leg.done);
    try { return { leg, raw: await leg.open(target.host, port), done }; }
    catch (e) { upstreamFailed(s, e); done(); throw e; }
  }

  const server = http.createServer(async (req, res) => {
    const s = sessions.auth(req.headers["proxy-authorization"]);
    if (!s) { res.writeHead(407, { "proxy-authenticate": 'Basic realm="fcpi"', connection: "close" }).end(); return; }
    s.requests++;
    if (!getPolicy().localCidrs) { refuse(s, req.url, new Denied("RETRIEVAL_NOT_READY", "the host's local-network list is not loaded")); res.writeHead(503, { connection: "close" }).end("fcpi: RETRIEVAL_NOT_READY\n"); return; }
    if (overRequests(s)) { refuse(s, req.url, new Denied("RESOURCE_LIMIT", `more than ${s.maxRequests} requests`)); res.writeHead(403, { connection: "close" }).end("fcpi: RESOURCE_LIMIT\n"); return; }
    // The refused request is named by the host and port it asked for, even when it fails to parse.
    let host = "?";
    try { host = new URL(req.url).host || "?"; } catch {}
    // A leg opened for this request is settled whatever happens after it (review S14; its done() runs once).
    let settleLeg = () => {};
    // The browser's connection belongs to the session before the leg is awaited, so closing the session ends it; it
    // leaves the set when it closes, since a standing session never closes (its set would only grow).
    const client = res.socket;
    s.sockets.add(client);
    client.once("close", () => s.sockets.delete(client));
    try {
      const policy = scopeFixtures(typeof s.fixture === "function" ? s.fixture() : s.fixture, getPolicy());
      const target = parseTarget(req.url, policy);
      if (s.allow && !s.allow(target)) throw new Denied("DESTINATION_NOT_ALLOWED", `${target.host} is not a destination this session may reach`);
      const address = await resolveTarget(target, { resolvePublic, policy, lookupFixture });
      const { leg, raw, done } = await openLeg(s, target, target.port);
      settleLeg = done;
      // The browser left while the tunnel opened: nothing will use it.
      if (res.socket?.destroyed) { raw?.destroy(); done(); return; }
      if (s.logEach) res.on("close", () => log({ event: "proxy_request", session: s.attemptId, method: req.method, target_host: target.host, route: leg ? "residential" : "direct", status: res.statusCode }));
      const headers = {};
      for (const [k, v] of Object.entries(req.headers)) if (!HOP.has(k)) headers[k] = v;
      headers.connection = "close";
      // Through a leg the request rides the tunnel: no agent, since agent false would make Node build one that
      // ignores createConnection and connects by itself.
      const up = http.request({ host: target.host, port: target.port, method: req.method, path: target.url.pathname + target.url.search, headers,
        ...(raw ? { createConnection: () => raw } : { agent: false, lookup: pinnedLookup(address) }) });
      // Both ends belong to the session: closing it (render over, or a cap) tears down the request and
      // the browser's connection, not only the upstream half.
      s.sockets.add(up).add(res.socket);
      if (raw) s.sockets.add(raw);
      else up.on("socket", (sock) => sock.once("connect", () => { if (sock.remoteAddress !== address) up.destroy(new Denied("SSRF_DENIED", "peer changed")); }));
      up.on("response", (ur) => {
        const out = {};
        for (const [k, v] of Object.entries(ur.headers)) if (!HOP.has(k)) out[k] = v;
        // A target controls its status line; one Node refuses to write (below 100, above 599)
        // would throw in this callback, outside any handler, and end the service (review C2).
        try {
          if (!(ur.statusCode >= 100 && ur.statusCode <= 599)) throw new Denied("PROXY_ERROR", `upstream status ${ur.statusCode}`);
          res.writeHead(ur.statusCode, out);
        } catch (e) {
          refuse(s, host, e instanceof Denied ? e : new Denied("PROXY_ERROR", e.message));
          ur.destroy(); up.destroy();
          if (!res.headersSent) res.writeHead(502, { connection: "close" }).end(); else res.destroy();
          return;
        }
        ur.on("data", (c) => count(s, c.length, up, res.socket));
        // A piped source that is destroyed never ends its destination: an upstream response cut short
        // ends the browser's response too, instead of leaving it open.
        ur.on("aborted", () => res.destroy());
        ur.on("error", () => res.destroy());
        ur.pipe(res);
      });
      up.on("error", () => { if (!res.headersSent) res.writeHead(502, { connection: "close" }).end(); else res.destroy(); });
      res.on("close", () => { up.destroy(); raw?.destroy(); s.sockets.delete(up); s.sockets.delete(res.socket); if (raw) s.sockets.delete(raw); done(); });
      req.pipe(up);
    } catch (e) {
      settleLeg();
      refuse(s, host, e, req.url);
      const code = e.provider || e.failureClass === "TARGET_UNREACHABLE" ? 502 : 403;
      res.writeHead(code, { "content-type": "text/plain", connection: "close" }).end(`fcpi: ${e.failureClass ?? "refused"}\n`);
    }
  });

  // HTTPS: a tunnel to port 443 of a validated, pinned address, or through the residential provider. The TLS
  // session is the browser's own, end to end; the proxy sees only the host name it was asked for and the bytes.
  server.on("connect", async (req, clientSocket, head) => {
    clientSocket.on("error", () => {});
    const s = sessions.auth(req.headers["proxy-authorization"]);
    if (!s) { clientSocket.end('HTTP/1.1 407 Proxy Authentication Required\r\nProxy-Authenticate: Basic realm="fcpi"\r\nConnection: close\r\n\r\n'); return; }
    s.requests++;
    if (!getPolicy().localCidrs) { refuse(s, req.url, new Denied("RETRIEVAL_NOT_READY", "the host's local-network list is not loaded")); clientSocket.end("HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\nfcpi: RETRIEVAL_NOT_READY\n"); return; }
    if (overRequests(s)) { refuse(s, req.url, new Denied("RESOURCE_LIMIT", `more than ${s.maxRequests} requests`)); clientSocket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\nfcpi: RESOURCE_LIMIT\n"); return; }
    const [host, port] = [req.url.slice(0, req.url.lastIndexOf(":")), req.url.slice(req.url.lastIndexOf(":") + 1)];
    let settleLeg = () => {};
    // The browser's connection belongs to the session before the leg is awaited (review S14), and leaves it on close.
    s.sockets.add(clientSocket);
    clientSocket.once("close", () => s.sockets.delete(clientSocket));
    try {
      const policy = scopeFixtures(typeof s.fixture === "function" ? s.fixture() : s.fixture, getPolicy());
      const target = parseTarget(`https://${host}${port === "443" ? "" : `:${port}`}/`, policy);
      if (s.allow && !s.allow(target)) throw new Denied("DESTINATION_NOT_ALLOWED", `${target.host} is not a destination this session may reach`);
      const address = await resolveTarget(target, { resolvePublic, policy, lookupFixture });
      const { leg, raw, done } = await openLeg(s, target, 443);
      settleLeg = done;
      if (clientSocket.destroyed) { raw?.destroy(); done(); return; }
      const upstream = raw ?? net.connect({ host: target.host, port: 443, lookup: pinnedLookup(address) });
      const route = leg ? "residential" : "direct";
      if (s.logEach) {
        let up = 0, down = 0;
        upstream.on("data", (c) => { down += c.length; });
        clientSocket.on("data", (c) => { up += c.length; });
        // A tunnel is logged when it opens, so each engine connection is attributable at once (a client may keep
        // it open long after its last request), and again with its byte counts when it closes.
        const opened = () => log({ event: "proxy_request", session: s.attemptId, method: "CONNECT", target_host: target.host, route, status: 200 });
        if (raw) opened(); else upstream.once("connect", opened);
        upstream.once("close", () => log({ event: "proxy_tunnel_closed", session: s.attemptId, target_host: target.host, route, bytes_out: up, bytes_in: down, ...(leg?.meter ? { provider_bytes: leg.meter.bytes } : {}) }));
      }
      s.sockets.add(upstream).add(clientSocket);
      const start = () => {
        clientSocket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
        // Through the provider the stream is the leg's metered one, so every byte either way is counted as it passes.
        if (head?.length) upstream.write(head);
        upstream.on("data", (c) => count(s, c.length, upstream, clientSocket));
        clientSocket.on("data", (c) => count(s, c.length, upstream, clientSocket));
        upstream.pipe(clientSocket);
        clientSocket.pipe(upstream);
      };
      upstream.on("error", () => clientSocket.destroy());
      if (raw) start();
      else upstream.once("connect", () => {
        if (upstream.remoteAddress !== address) { upstream.destroy(); clientSocket.destroy(); return; }
        start();
      });
      const drop = () => { upstream.destroy(); clientSocket.destroy(); s.sockets.delete(upstream); s.sockets.delete(clientSocket); done(); };
      clientSocket.on("close", drop);
      upstream.on("close", drop);
    } catch (e) {
      settleLeg();
      refuse(s, req.url, e);
      const status = e.provider || e.failureClass === "TARGET_UNREACHABLE" ? "502 Bad Gateway" : "403 Forbidden";
      clientSocket.end(`HTTP/1.1 ${status}\r\nContent-Type: text/plain\r\nConnection: close\r\n\r\nfcpi: ${e.failureClass ?? "refused"}\n`);
    }
  });

  server.listen(listen.port, listen.host);
  const sweeper = setInterval(() => sessions.sweep(), 5000).unref();
  server.on("close", () => clearInterval(sweeper));
  return server;
}
