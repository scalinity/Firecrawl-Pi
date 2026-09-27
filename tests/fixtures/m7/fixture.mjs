// M7's controlled enhanced provider, targets and webhook receiver, shared by the retrieval service's unit tests
// (imported) and the deployed fixture-m7 container (server.mjs).
//
// The enhanced provider speaks Zyte API's documented contract (docs.zyte.com "HTTP requests" and "Errors", checked
// 2026-09-27): POST /v1/extract, Basic authentication with the key as the user name, { url, httpResponseBody,
// httpResponseHeaders } or { url, browserHtml }, and the answer { url, statusCode, httpResponseBody (base64),
// httpResponseHeaders [{ name, value }], browserHtml }; a target's own 4xx comes back as a 200 carrying it, and a ban is a
// 520. The key is checked by its SHA-256. It fetches the target itself over the fixture network, recording the local port
// of every connection it opens, so a target can tell a request that came through it (the same test works on loopback).
// Its "browser" is a stand-in: a script shell of the M6 form (outerHTML = atob("...")) is rendered by decoding that
// payload. A mode switch makes it answer 520, 521, 429, 500, 401, 502, never answer, or answer malformed JSON.
//
// The webhook receiver applies the verification the platform documents for a receiver (capabilities.json limits.webhooks):
// the signature is HMAC-SHA256 over "<timestamp>.<event id>.<body>" with the shared secret; a delivery whose signature
// does not verify, or whose timestamp is more than the tolerance away, is refused (401); an event id already accepted is
// acknowledged again (200) and not counted twice.
import http from "node:http";
import { createHash, createHmac, timingSafeEqual } from "node:crypto";

const sha = (s) => createHash("sha256").update(s).digest("hex");
export const TOLERANCE_S = 300;

export function makeState() {
  return { mode: "ok", calls: [], enhancedPorts: new Set(), hits: [], versions: new Map(),
    hooks: { received: [], accepted: new Map(), failNext: 0, last: null } };
}

const page = (title, body) => `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title></head><body><main><h1>${title}</h1>${body}</main></body></html>`;
const ARTICLE = (who) => page("Enhanced fixture article", `<p>This article reached the client ${who}. It carries enough ordinary prose to be read as the page's own content, with no sign of client-side rendering and no interstitial of any kind.</p><p>Second paragraph, for a fuller page.</p>`);
const CHALLENGE = page("Just a moment...", `<div id="challenge-running"></div><script src="/cdn-cgi/challenge-platform/h/b/orchestrate/jsch/v1"></script><noscript>Enable JavaScript and cookies to continue</noscript>`);
const SHELL = (html) => `<!doctype html><html><head><meta charset="utf-8"><title>Loading</title></head><body><div id="root"></div><script>document.getElementById("root").outerHTML = atob("${Buffer.from(html).toString("base64")}");</script></body></html>`;
const SHELL_PAYLOAD = /document\.getElementById\("root"\)\.outerHTML = atob\("([A-Za-z0-9+/=]*)"\)/;

// The enhanced provider. keySha256: the SHA-256 of its key; resolve(host): the address a target is reached at; port:
// the port every target is reached on (the deployed fixture's 8080, or a loopback test port).
export function makeZyte(state, { keySha256, resolve = async () => "127.0.0.1", port = 8080 }) {
  return http.createServer((req, res) => {
    const answer = (status, obj) => res.writeHead(status, { "content-type": "application/json", "zyte-request-id": `fx-${state.calls.length}` }).end(JSON.stringify(obj));
    if (req.method !== "POST" || req.url !== "/v1/extract") return answer(404, { status: 404, type: "/request/not-found" });
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", async () => {
      const call = { at: new Date().toISOString(), mode: state.mode, url: null, kind: null, status: null };
      state.calls.push(call);
      const m = /^Basic ([A-Za-z0-9+/=]+)$/.exec(req.headers.authorization ?? "");
      const user = m ? Buffer.from(m[1], "base64").toString("utf8") : "";
      if (!user.endsWith(":") || sha(user.slice(0, -1)) !== keySha256) { call.status = 401; return answer(401, { status: 401, type: "/auth/key-not-found" }); }
      let body;
      try { body = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { call.status = 400; return answer(400, { status: 400, type: "/request/invalid-json" }); }
      call.url = body.url; call.kind = body.browserHtml ? "browser" : "http";
      if (typeof body.url !== "string" || !(body.browserHtml === true || body.httpResponseBody === true)) { call.status = 400; return answer(400, { status: 400, type: "/request/invalid" }); }
      if (state.mode === "blackhole") { call.status = 0; return; }
      if (state.mode === "malformed") { call.status = 200; return res.writeHead(200, { "content-type": "application/json" }).end("{\"statusCode\":"); }
      if (["520", "521", "429", "500", "401", "502"].includes(state.mode)) { call.status = Number(state.mode); return answer(call.status, { status: call.status, type: "/fixture/mode" }); }
      let u = new URL(body.url);
      if (u.pathname === "/banned") { call.status = 520; return answer(520, { status: 520, type: "/download/temporary-error" }); }
      // Follows redirects on its own, as the provider does by default.
      let got = null;
      for (let hop = 0; hop < 5; hop++) {
        got = await fetchTarget(state, u, resolve, port).catch(() => null);
        if (!got) { call.status = 421; return answer(421, { status: 421, type: "/website/domain-unreachable" }); }
        if (![301, 302, 303, 307, 308].includes(got.status) || !got.headers.location) break;
        u = new URL(got.headers.location, u);
        // A redirect off the fixture network is reported as where the answer ended, never resolved or fetched: the
        // fixture sends no query for a public name (a Cloud host among them).
        if (!/\.fixture\.fcpi\.test$/.test(u.hostname)) { got = { status: 200, headers: { "content-type": "text/html" }, body: Buffer.from("<main><p>fixture: the redirect's end, not fetched</p></main>") }; break; }
      }
      call.status = 200;
      if (body.browserHtml) {
        let html = got.body.toString("utf8");
        const p = SHELL_PAYLOAD.exec(html);
        if (p) html = html.replace(/<div id="root"><\/div><script>[\s\S]*?<\/script>/, Buffer.from(p[1], "base64").toString("utf8"));
        return answer(200, { url: u.href, statusCode: got.status, browserHtml: html });
      }
      return answer(200, { url: u.href, statusCode: got.status, httpResponseBody: got.body.toString("base64"),
        httpResponseHeaders: Object.entries(got.headers).map(([name, value]) => ({ name, value: String(value) })) });
    });
  });
}

function fetchTarget(state, u, resolve, port) {
  return new Promise(async (ok, fail) => {
    let address;
    try { address = await resolve(u.hostname); } catch (e) { return fail(e); }
    const r = http.request({ host: address, port, path: u.pathname + u.search, method: "GET", headers: { host: u.host, "user-agent": "fcpi-fixture-zyte/1" }, agent: false }, (resp) => {
      const chunks = [];
      resp.on("data", (c) => chunks.push(c));
      resp.on("end", () => { state.enhancedPorts.delete(r.socket?.localPort); ok({ status: resp.statusCode, headers: resp.headers, body: Buffer.concat(chunks) }); });
    });
    r.on("socket", (s) => s.once("connect", () => state.enhancedPorts.add(s.localPort)));
    r.on("error", fail);
    r.end();
  });
}

// The targets. via(req): "enhanced" for a request the provider made, "proxy" for one through the residential proxy,
// "direct" otherwise; isProxied(req) tells the proxy's requests apart (by the proxy container's address when deployed).
export function makeTarget(state, { isProxied = () => false } = {}) {
  return http.createServer((req, res) => {
    const via = state.enhancedPorts.has(req.socket.remotePort) ? "enhanced" : isProxied(req) ? "proxy" : "direct";
    const host = (req.headers.host ?? "").split(":")[0].replace(/\.fixture\.fcpi\.test$/, "");
    const url = new URL(req.url, "http://x"), path = url.pathname;
    state.hits.push({ at: new Date().toISOString(), host, path, via });
    const html = (status, body, extra = {}) => res.writeHead(status, { "content-type": "text/html; charset=utf-8", ...extra }).end(body);
    switch (path) {
      // The waterfall's last tier: challenged directly and through the proxy, answered through the enhanced provider.
      case "/tough": return via === "enhanced" ? html(200, ARTICLE("through the enhanced provider")) : html(403, CHALLENGE);
      case "/tough200": return html(200, via === "enhanced" ? ARTICLE("through the enhanced provider") : CHALLENGE);
      // A script shell whose render is a challenge unless the enhanced provider rendered it.
      case "/js-tough": return html(200, SHELL(via === "enhanced" ? `<main><h1>Rendered by the enhanced provider</h1><p>${"Rendered enhanced content. ".repeat(12)}</p></main>`
        : `<div id="challenge-running"></div><script src="/cdn-cgi/challenge-platform/h/b/orchestrate/jsch/v1"></script>`));
      // Challenged on every route, the enhanced provider's included.
      case "/never": return html(403, CHALLENGE);
      // Target outcomes the enhanced provider passes on as they are.
      case "/gone": return html(404, page("Not found", "<p>No such page.</p>"));
      case "/slow-down": return html(429, page("Too many requests", "<p>Slow down.</p>"), { "retry-after": "30" });
      case "/login": return html(401, page("Sign in", "<p>Authentication required.</p>"), { "www-authenticate": 'Basic realm="fixture"' });
      case "/article": return html(200, ARTICLE(`by the ${via} route`));
      case "/redirect-out": return res.writeHead(302, { location: "http://firecrawl.dev/" }).end();
      // Cache: an article that counts every fetch, and error pages that are never cached.
      case "/cached": return html(200, page("Cache fixture", `<p>${"A page for the cache to hold. ".repeat(8)}</p>`));
      case "/err500": return html(500, page("Server error", "<p>Something went wrong.</p>"));
      case "/err404": return html(404, page("Not found", "<p>No such page.</p>"));
      // Changes: a document whose text is its current version, set through the control port; version 0 makes it an error
      // page and version -1 a bot interstitial at the same URL, neither of which may replace the stored version.
      case "/doc": {
        const v = state.versions.get(path) ?? 1;
        if (v === 0) return html(500, page("Server error", "<p>Something went wrong.</p>"));
        if (v === -1) return html(403, CHALLENGE);
        return html(200, page("Change fixture", `<p>Release notes, version ${v}.</p><p>${"Stable paragraph that does not change. ".repeat(6)}</p>${v >= 2 ? `<p>Added in version ${v}: a new line of text.</p>` : ""}`));
      }
      case "/doc-challenge": return html(403, CHALLENGE);
      // Screenshots: three horizontal bands 1000 px tall each (red, green, blue), 1280 px wide.
      case "/bands": return html(200, `<!doctype html><html><head><meta charset="utf-8"><title>Bands</title><style>html,body{margin:0;padding:0}div{width:1280px;height:1000px}</style></head><body><div style="background:#ff0000"></div><div style="background:#00ff00"></div><div style="background:#0000ff"></div><p style="margin:0;height:0;overflow:hidden">${"Band fixture text. ".repeat(20)}</p></body></html>`);
      // Incompressible pixels (review W10): a page 1,800 px tall of random noise, so its captures are near the worker's
      // capture limit and the gateway's memory is measured at the extras bound, not at a gradient's few kilobytes.
      case "/noise": return html(200, `<!doctype html><html><head><meta charset="utf-8"><title>Noise</title><style>html,body{margin:0}canvas{display:block}</style></head><body><canvas id="n" width="1280" height="1800"></canvas><p>${"Noise fixture text. ".repeat(20)}</p>
<script>const c=document.getElementById("n").getContext("2d"),img=c.createImageData(1280,1800),d=img.data;for(let o=0;o<d.length;o+=65536)crypto.getRandomValues(d.subarray(o,Math.min(o+65536,d.length)));for(let i=3;i<d.length;i+=4)d[i]=255;c.putImageData(img,0,0);</script></body></html>`);
      // A page 25,000 px tall: a full-page capture stops at 20,000 px and says so.
      case "/tall": return html(200, `<!doctype html><html><head><meta charset="utf-8"><title>Tall</title><style>html,body{margin:0}</style></head><body><div style="width:1280px;height:25000px;background:linear-gradient(#ffffff,#000000)"><p>${"Tall fixture text. ".repeat(30)}</p></div></body></html>`);
      // Actions: a button that reveals a section, an element that appears after 1.5 s, and content added on scroll.
      case "/actions": return html(200, `<!doctype html><html><head><meta charset="utf-8"><title>Actions</title></head><body><main><h1>Action fixture</h1><p>${"Visible from the start. ".repeat(10)}</p>
<button id="more" onclick="document.getElementById('hidden').style.display='block'">Show more</button><section id="hidden" style="display:none"><p>Expanded section text revealed by the click.</p></section>
<div id="late"></div><div style="height:3000px"></div><div id="bottom"></div></main>
<script>setTimeout(function(){var p=document.createElement('p');p.id='arrived';p.textContent='Late element arrived.';document.getElementById('late').appendChild(p);},1500);
window.addEventListener('scroll',function(){if(!document.getElementById('scrolled')){var p=document.createElement('p');p.id='scrolled';p.textContent='Content loaded on scroll.';document.getElementById('bottom').appendChild(p);}});</script></body></html>`);
      // A click that loads another document on the same host: allowed, and counted against the domain (review W6).
      case "/samehost": return html(200, `<!doctype html><html><head><meta charset="utf-8"><title>Same host</title></head><body><main><h1>Same-host link</h1><p>${"Ordinary text on this page. ".repeat(10)}</p><a id="next" href="/article">next</a></main></body></html>`);
      // A click that would take the page to another host, which the browser worker refuses.
      case "/offhost": return html(200, `<!doctype html><html><head><meta charset="utf-8"><title>Off host</title></head><body><main><h1>Off-host link</h1><p>${"Ordinary text on this page. ".repeat(10)}</p><a id="away" href="http://m7.fixture.fcpi.test:8080/article">elsewhere</a></main></body></html>`);
      default: return html(404, page("Not found", "<p>No such fixture page.</p>"));
    }
  });
}

// The webhook receiver. secret: the shared signing secret; now(): the receiver's clock in seconds.
export function makeReceiver(state, { secret, now = () => Math.floor(Date.now() / 1000) }) {
  return http.createServer((req, res) => {
    if (req.method !== "POST" || req.url !== "/receive") return res.writeHead(404).end();
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const body = Buffer.concat(chunks);
      const rec = { at: new Date().toISOString(), eventId: req.headers["x-fcpi-event-id"] ?? null, timestamp: req.headers["x-fcpi-timestamp"] ?? null, verdict: null };
      state.hooks.received.push(rec);
      // The last delivery the receiver accepted, which the control port can send again (a replay, stale or tampered).
      const seen = { headers: { "x-fcpi-event-id": rec.eventId, "x-fcpi-timestamp": rec.timestamp, "x-fcpi-signature": req.headers["x-fcpi-signature"] ?? "", "content-type": "application/json" }, body: body.toString("utf8") };
      const done = (status, verdict) => { rec.verdict = verdict; res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify({ verdict })); };
      const v = verify({ secret, eventId: rec.eventId, timestamp: rec.timestamp, signature: req.headers["x-fcpi-signature"], body, now: now() });
      if (v) return done(401, v);
      if (state.hooks.failNext > 0) { state.hooks.failNext--; return done(500, "failing_on_purpose"); }
      if (state.hooks.accepted.has(rec.eventId)) return done(200, "duplicate");
      let event = null;
      try { event = JSON.parse(body.toString("utf8")); } catch { /* counted as accepted all the same */ }
      state.hooks.accepted.set(rec.eventId, { at: rec.at, type: event?.type ?? null, id: event?.id ?? null });
      state.hooks.last = seen;
      done(200, "accepted");
    });
  });
}

// The documented receiver check: null when the delivery verifies, or why not.
export function verify({ secret, eventId, timestamp, signature, body, now }) {
  if (typeof eventId !== "string" || !/^[0-9a-f-]{36}$/.test(eventId)) return "no_event_id";
  if (typeof timestamp !== "string" || !/^\d{10}$/.test(timestamp)) return "no_timestamp";
  if (Math.abs(now - Number(timestamp)) > TOLERANCE_S) return "stale_timestamp";
  const m = /^v1=([0-9a-f]{64})$/.exec(signature ?? "");
  if (!m) return "no_signature";
  const want = createHmac("sha256", secret).update(`${timestamp}.${eventId}.`).update(body).digest();
  return timingSafeEqual(want, Buffer.from(m[1], "hex")) ? null : "bad_signature";
}

export function stats(state) {
  return { mode: state.mode, calls: state.calls, hits: state.hits, versions: Object.fromEntries(state.versions),
    hooks: { received: state.hooks.received, accepted: Object.fromEntries(state.hooks.accepted), failNext: state.hooks.failNext } };
}
export function reset(state) {
  state.mode = "ok"; state.calls.length = 0; state.hits.length = 0; state.versions.clear();
  state.hooks.received.length = 0; state.hooks.accepted.clear(); state.hooks.failNext = 0; state.hooks.last = null;
}
