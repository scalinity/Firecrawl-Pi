// M6's controlled residential proxy and targets, shared by the retrieval service's unit tests (imported) and the
// deployed fixture-m6 container (server.mjs). One process holds both, so a target can tell a request that came
// through the proxy from one that came from the retrieval service directly: the proxy records the local port of
// every connection it opens to a target, and the target looks its peer's port up (the same test works on
// loopback, where every address is the same).
//
// The proxy speaks Decodo's documented contract (help.decodo.com, residential "User:pass requests", checked
// 2026-09-26): HTTP CONNECT, Basic Proxy-Authorization with the username
// "user-<name>-session-<id>-sessionduration-<minutes>", one sticky exit per session id. The credential is checked by
// the SHA-256 of "<name>:<password>". A mode switch makes it answer 407, 402, 429 or 503, refuse connections or
// never answer, so every provider failure class can be produced. It counts the bytes of every tunnel in both
// directions, per session, and serves the day's total as a usage report (GET /__usage?day=), as a provider does.
import http from "node:http";
import net from "node:net";
import { createHash } from "node:crypto";

const USER = /^user-([A-Za-z0-9_]+)-session-([A-Za-z0-9]{1,64})-sessionduration-(\d{1,4})$/;
const sha = (s) => createHash("sha256").update(s).digest("hex");

// portOverride (unit tests only): the port every tunnel is opened to, so a CONNECT for a public name's port 443 can
// reach the loopback target.
export function makeState() {
  return { proxiedPorts: new Set(), mode: "ok", tunnels: [], exits: new Map(), refusals: [], hits: [], usageByDay: new Map(), portOverride: null };
}

// The proxy. resolve(host) gives the address a CONNECT target is reached at (Docker's resolver when deployed).
export function makeProxy(state, { credentialSha256, resolve = async (h) => h }) {
  const day = () => new Date().toISOString().slice(0, 10);
  const server = http.createServer((req, res) => {
    // The provider's usage report (origin-form); a forward-proxy request (absolute-form) is not offered.
    if (req.url.startsWith("/__usage")) {
      const d = new URL(req.url, "http://x").searchParams.get("day") ?? day();
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ day: d, rx_tx_bytes: state.usageByDay.get(d) ?? 0 }));
      return;
    }
    res.writeHead(405, { connection: "close" }).end("fixture proxy: CONNECT only\n");
  });
  server.on("connect", async (req, client, head) => {
    client.on("error", () => {});
    const refuse = (status, why) => { state.refusals.push({ at: new Date().toISOString(), status, why, target: req.url }); client.end(`HTTP/1.1 ${status} Refused\r\nConnection: close\r\n\r\n`); };
    // Never answers, but reads, so the client's close is seen and the socket goes with it.
    if (state.mode === "blackhole") { client.resume(); client.once("end", () => client.destroy()); return; }
    if (state.mode === "refuse") { client.destroy(); state.refusals.push({ at: new Date().toISOString(), status: 0, why: "connection dropped", target: req.url }); return; }
    const m = /^Basic ([A-Za-z0-9+/=]+)$/.exec(req.headers["proxy-authorization"] ?? "");
    const [user, ...rest] = m ? Buffer.from(m[1], "base64").toString("utf8").split(":") : [];
    const u = USER.exec(user ?? "");
    if (!u || sha(`${u[1]}:${rest.join(":")}`) !== credentialSha256) return refuse(407, u ? "credential" : "username format");
    if (state.mode !== "ok") return refuse(Number(state.mode), `mode ${state.mode}`);
    const [session, minutes] = [u[2], Number(u[3])];
    if (!state.exits.has(session)) state.exits.set(session, `exit-${state.exits.size + 1}`);
    const [host, port] = [req.url.slice(0, req.url.lastIndexOf(":")), Number(req.url.slice(req.url.lastIndexOf(":") + 1))];
    let address;
    try { address = await resolve(host); } catch { return refuse(502, "target does not resolve"); }
    const t = { at: new Date().toISOString(), session, minutes, exit: state.exits.get(session), target: `${host}:${port}`, up: 0, down: 0, closed: false };
    state.tunnels.push(t);
    const upstream = net.connect({ host: address, port: state.portOverride ?? port });
    upstream.once("connect", () => {
      state.proxiedPorts.add(upstream.localPort);
      client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (head?.length) { t.up += head.length; upstream.write(head); }
      client.on("data", (c) => { t.up += c.length; });
      upstream.on("data", (c) => { t.down += c.length; });
      client.pipe(upstream); upstream.pipe(client);
    });
    upstream.on("error", () => { if (!client.destroyed) refuse(502, "target unreachable"); });
    const close = () => {
      if (t.closed) return;
      t.closed = true;
      state.proxiedPorts.delete(upstream.localPort);
      const d = t.at.slice(0, 10);
      state.usageByDay.set(d, (state.usageByDay.get(d) ?? 0) + t.up + t.down);
      upstream.destroy(); client.destroy();
    };
    client.on("close", close); upstream.on("close", close);
  });
  return server;
}

const page = (title, body) => `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title></head><body><main><h1>${title}</h1>${body}</main></body></html>`;
const ARTICLE = (who) => page("Residential fixture article", `<p>This article reached the client ${who}. It carries enough ordinary prose to be read as the page's own content, with no sign of client-side rendering and no interstitial of any kind.</p><p>Second paragraph, for a fuller page.</p>`);
// A public-content bot interstitial, recognised by its challenge platform's script path (quality.mjs).
const CHALLENGE = page("Just a moment...", `<div id="challenge-running"></div><script src="/cdn-cgi/challenge-platform/h/b/orchestrate/jsch/v1"></script><noscript>Enable JavaScript and cookies to continue</noscript>`);
// A script shell whose script writes the page: an article for a proxied peer, a challenge for a direct one. The
// markup is the fixture's own constant, carried base64-encoded, so the HTTP answer holds no challenge marker and
// no "</script>" of its own: to the classifier it is only a script shell, as a real one would be.
const SHELL = (html) => `<!doctype html><html><head><meta charset="utf-8"><title>Loading</title></head><body><div id="root"></div><script>document.getElementById("root").outerHTML = atob("${Buffer.from(html).toString("base64")}");</script></body></html>`;

// The targets, on every m6*.fixture.fcpi.test name (and searchr, the residential fixture search engine).
export function makeTarget(state) {
  return http.createServer((req, res) => {
    const via = state.proxiedPorts.has(req.socket.remotePort) ? "proxy" : "direct";
    const host = (req.headers.host ?? "").split(":")[0];
    const path = req.url.split("?")[0];
    state.hits.push({ at: new Date().toISOString(), host, path, via });
    const html = (status, body, extra = {}) => res.writeHead(status, { "content-type": "text/html; charset=utf-8", ...extra }).end(body);
    // The residential fixture search engine (SearXNG's "fcpi fixture r", a json_engine).
    if (host === "searchr.fixture.fcpi.test") {
      const q = new URL(req.url, "http://x").searchParams.get("q") ?? "";
      return res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ results: [{ url: `https://example.org/residential-engine/${encodeURIComponent(q)}`, title: `Residential engine result (${via})`, content: `answered ${via}` }] }));
    }
    switch (path) {
      case "/echo": return res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ via, host }));
      case "/echo.html": return html(200, ARTICLE(`by the ${via} route`));
      case "/static": return html(200, ARTICLE(via === "proxy" ? "through the proxy" : "directly"));
      // A challenge for the home route, the article for the residential one (as a 403, and as a 200).
      case "/challenge": return via === "proxy" ? html(200, ARTICLE("through the proxy after a challenge")) : html(403, CHALLENGE);
      case "/challenge200": return via === "proxy" ? html(200, ARTICLE("through the proxy after a challenge")) : html(200, CHALLENGE);
      // Challenged on every route: nothing further may answer it before M7.
      case "/always-challenge": return html(403, CHALLENGE);
      // HTTP sees a script shell on both routes; the rendered page is a challenge directly and an article proxied.
      case "/js-challenge": return html(200, SHELL(via === "proxy" ? `<main><h1>Rendered through the proxy</h1><p>${"Rendered residential content. ".repeat(12)}</p></main>` : `<div id="challenge-running"></div><script src="/cdn-cgi/challenge-platform/h/b/orchestrate/jsch/v1"></script>`));
      // A page with subresources on its own host: each is fetched under the attempt's one proxy session.
      case "/subres": return html(200, page("Subresources", `<p>${"A page that loads its own images and a script. ".repeat(8)}</p><img src="/px/1.gif"><img src="/px/2.gif"><script src="/px/app.js"></script>`));
      case "/px/1.gif": case "/px/2.gif": return res.writeHead(200, { "content-type": "image/gif" }).end(Buffer.from("R0lGODlhAQABAAAAACw=", "base64"));
      case "/px/app.js": return res.writeHead(200, { "content-type": "text/javascript" }).end("window.fixtureScript = true;");
      case "/401": return html(401, page("Sign in", "<p>Authentication required.</p>"), { "www-authenticate": 'Basic realm="fixture"' });
      case "/403": return html(403, page("Forbidden", "<p>You do not have access to this resource.</p>"));
      case "/404": return html(404, page("Not found", "<p>No such page.</p>"));
      case "/500": return html(500, page("Server error", "<p>Something went wrong.</p>"));
      case "/429": return html(429, page("Too many requests", "<p>Slow down.</p>"), { "retry-after": "30" });
      // Larger than one residential attempt's byte reservation (budget.json proxying.maxAttemptBytes, 10 MB).
      case "/big": return res.writeHead(200, { "content-type": "text/plain" }).end(Buffer.alloc(12_000_000, 0x61));
      // The bulk crawl graph: an index linking 24 pages, each linking back.
      case "/robots.txt": return res.writeHead(200, { "content-type": "text/plain" }).end("User-agent: *\nAllow: /\n");
      case "/bulk/": return html(200, page("Bulk index", Array.from({ length: 24 }, (_, i) => `<p><a href="/bulk/p${i + 1}">Bulk page ${i + 1}</a></p>`).join("")));
      default: {
        const b = /^\/bulk\/p(\d+)$/.exec(path);
        if (b) return html(200, page(`Bulk page ${b[1]}`, `<p>${"Bulk fixture page content. ".repeat(10)}</p><a href="/bulk/">index</a>`));
        return html(404, page("Not found", "<p>No such fixture page.</p>"));
      }
    }
  });
}

// Counts for the evidence: tunnels by session and exit, target hits by route, refusals, and the usage ledger.
export function stats(state) {
  return { mode: state.mode, tunnels: state.tunnels, refusals: state.refusals, hits: state.hits, usage: Object.fromEntries(state.usageByDay),
    sessions: Object.fromEntries(state.exits) };
}
export function reset(state) {
  state.tunnels.length = 0; state.refusals.length = 0; state.hits.length = 0; state.mode = "ok";
}
