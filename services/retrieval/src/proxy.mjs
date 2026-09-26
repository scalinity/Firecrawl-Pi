// The browser's only way out (FIRECRAWL_PI_SPEC.md §12, §20.2). The browser worker sits on an
// internal network whose only other member is this service, and Chromium sends every request
// through this forward proxy with the credential of the attempt it belongs to. Each request -
// the page, its redirects and every subresource - is validated with the same rules as a direct
// fetch, resolved once and connected to exactly the checked address; bytes are counted per
// attempt and cut off at the page's limit. An unknown or expired credential gets 407; a refused
// target gets 403 and is counted.
import http from "node:http";
import net from "node:net";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { parseTarget, Denied } from "./ssrf.mjs";
import { resolveTarget, pinnedLookup } from "./resolve.mjs";

const HOP = new Set(["connection", "keep-alive", "proxy-authorization", "proxy-authenticate", "proxy-connection", "te", "trailer", "transfer-encoding", "upgrade"]);
const digest = (s) => createHash("sha256").update(s).digest();

export class ProxySessions {
  #s = new Map();
  // A session for one browser attempt; returns the credential the browser presents.
  open(attemptId, { expiresAt, maxBytes }) {
    const password = randomBytes(24).toString("hex");
    this.#s.set(attemptId, { attemptId, hash: digest(password), expiresAt, maxBytes, bytes: 0, requests: 0, denied: [], sockets: new Set() });
    return { username: attemptId, password };
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
    return { requests: s.requests, bytes: s.bytes, denied: s.denied };
  }
  sweep() { for (const [id, s] of this.#s) if (Date.now() > s.expiresAt + 5000) this.close(id); }
}

export function startProxy({ listen, sessions, getPolicy, resolvePublic, lookupFixture, log }) {
  const refuse = (s, target, e) => {
    s.denied.push({ host: target, class: e.failureClass ?? "PROXY_ERROR" });
    log({ event: "proxy_denied", attempt_id: s.attemptId, target_host: target, failure: e.failureClass ?? "PROXY_ERROR", detail: e.detail ?? e.message });
  };
  const count = (s, n, ...socks) => {
    s.bytes += n;
    if (s.bytes > s.maxBytes) for (const x of socks) x.destroy();
  };

  const server = http.createServer(async (req, res) => {
    const s = sessions.auth(req.headers["proxy-authorization"]);
    if (!s) { res.writeHead(407, { "proxy-authenticate": 'Basic realm="fcpi"', connection: "close" }).end(); return; }
    s.requests++;
    // The refused request is named by the host and port it asked for, even when it fails to parse.
    let host = "?";
    try { host = new URL(req.url).host || "?"; } catch {}
    try {
      const policy = getPolicy();
      const target = parseTarget(req.url, policy);
      const address = await resolveTarget(target, { resolvePublic, policy, lookupFixture });
      const headers = {};
      for (const [k, v] of Object.entries(req.headers)) if (!HOP.has(k)) headers[k] = v;
      headers.connection = "close";
      const up = http.request({ host: target.host, port: target.port, method: req.method, path: target.url.pathname + target.url.search, headers, lookup: pinnedLookup(address), agent: false });
      s.sockets.add(up);
      up.on("socket", (sock) => sock.once("connect", () => { if (sock.remoteAddress !== address) up.destroy(new Denied("SSRF_DENIED", "peer changed")); }));
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
        ur.pipe(res);
      });
      up.on("error", () => { if (!res.headersSent) res.writeHead(502, { connection: "close" }).end(); else res.destroy(); });
      res.on("close", () => { up.destroy(); s.sockets.delete(up); });
      req.pipe(up);
    } catch (e) {
      refuse(s, host, e);
      res.writeHead(403, { "content-type": "text/plain", connection: "close" }).end(`fcpi: ${e.failureClass ?? "refused"}\n`);
    }
  });

  // HTTPS: a tunnel to port 443 of a validated, pinned address. The TLS session is the browser's
  // own, end to end; the proxy sees only the host name it was asked for and the bytes.
  server.on("connect", async (req, clientSocket, head) => {
    clientSocket.on("error", () => {});
    const s = sessions.auth(req.headers["proxy-authorization"]);
    if (!s) { clientSocket.end('HTTP/1.1 407 Proxy Authentication Required\r\nProxy-Authenticate: Basic realm="fcpi"\r\nConnection: close\r\n\r\n'); return; }
    s.requests++;
    const [host, port] = [req.url.slice(0, req.url.lastIndexOf(":")), req.url.slice(req.url.lastIndexOf(":") + 1)];
    try {
      const policy = getPolicy();
      const target = parseTarget(`https://${host}${port === "443" ? "" : `:${port}`}/`, policy);
      const address = await resolveTarget(target, { resolvePublic, policy, lookupFixture });
      const upstream = net.connect({ host: target.host, port: 443, lookup: pinnedLookup(address) });
      s.sockets.add(upstream).add(clientSocket);
      upstream.on("error", () => clientSocket.destroy());
      upstream.once("connect", () => {
        if (upstream.remoteAddress !== address) { upstream.destroy(); clientSocket.destroy(); return; }
        clientSocket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
        if (head?.length) upstream.write(head);
        upstream.on("data", (c) => count(s, c.length, upstream, clientSocket));
        clientSocket.on("data", (c) => count(s, c.length, upstream, clientSocket));
        upstream.pipe(clientSocket);
        clientSocket.pipe(upstream);
      });
      const drop = () => { upstream.destroy(); clientSocket.destroy(); s.sockets.delete(upstream); s.sockets.delete(clientSocket); };
      clientSocket.on("close", drop);
      upstream.on("close", drop);
    } catch (e) {
      refuse(s, req.url, e);
      clientSocket.end(`HTTP/1.1 403 Forbidden\r\nContent-Type: text/plain\r\nConnection: close\r\n\r\nfcpi: ${e.failureClass ?? "refused"}\n`);
    }
  });

  server.listen(listen.port, listen.host);
  const sweeper = setInterval(() => sessions.sweep(), 5000).unref();
  server.on("close", () => clearInterval(sweeper));
  return server;
}
