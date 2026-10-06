// The forward and search proxies chaining through the residential provider (src/proxy.mjs, M6): a browser attempt's
// page and subresources leave under its one session and meter; SearXNG's residential-routed hosts get a leg per
// tunnel, and are refused (never sent directly) when the route cannot be had (F11); a provider's refusal of a
// browser request is kept as the attempt's provider failure.
import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import net from "node:net";
import { createHash } from "node:crypto";
import { ProxySessions, startProxy } from "../src/proxy.mjs";
import { Meter } from "../src/residential.mjs";
import { startFixture, rig, m6Policy, urlHmac } from "./m6-helpers.mjs";

const listening = (srv) => new Promise((r) => (srv.listening ? r() : srv.once("listening", r)));
async function withProxy(fx, fn, { resolvePublic = async () => [] } = {}) {
  const sessions = new ProxySessions(), logs = [];
  const proxy = startProxy({ listen: { host: "127.0.0.1", port: 0 }, sessions, getPolicy: () => m6Policy(fx), resolvePublic, lookupFixture: async () => ["127.0.0.1"], log: (o) => logs.push(o) });
  await listening(proxy);
  try { return await fn({ port: proxy.address().port, sessions, logs }); } finally { proxy.closeAllConnections?.(); proxy.close(); }
}
const auth = (cred) => `Basic ${Buffer.from(`${cred.username}:${cred.password}`).toString("base64")}`;
const get = (port, url, cred) => new Promise((resolve, reject) => {
  http.request({ host: "127.0.0.1", port, path: url, headers: { "proxy-authorization": auth(cred) }, agent: false }, (res) => {
    let b = ""; res.on("data", (c) => (b += c)); res.on("end", () => resolve({ status: res.statusCode, body: b }));
  }).on("error", reject).end();
});
// A CONNECT through the proxy, then one plain request over the tunnel (a stand-in for a TLS session's bytes).
const connectGet = (port, host, targetPort, path, cred) => new Promise((resolve, reject) => {
  const s = net.connect(port, "127.0.0.1", () => s.write(`CONNECT ${host}:443 HTTP/1.1\r\nHost: ${host}:443\r\nProxy-Authorization: ${auth(cred)}\r\n\r\n`));
  let buf = "", stage = 0;
  s.on("data", (c) => {
    buf += c;
    if (stage === 0 && buf.includes("\r\n\r\n")) {
      const status = Number(buf.split(" ")[1]);
      if (status !== 200) { s.destroy(); return resolve({ status }); }
      stage = 1; buf = "";
      s.write(`GET ${path} HTTP/1.1\r\nHost: ${host}:${targetPort}\r\nConnection: close\r\n\r\n`);
    }
  });
  s.on("end", () => resolve({ status: 200, body: buf }));
  s.on("error", reject);
});

test("a residential browser session tunnels the page and every subresource under one session and one meter", async () => {
  const fx = await startFixture();
  try {
    const { residential } = rig(fx);
    const st = residential.state();
    const meter = new Meter(10_000_000);
    await withProxy(fx, async ({ port, sessions }) => {
      const upstream = residential.leg(st, { meter, sessionId: "attemptsession1", deadline: Date.now() + 10000 });
      const cred = sessions.open("a1", { expiresAt: Date.now() + 20000, maxBytes: meter.cap, fixture: true, upstream });
      const base = `http://m6.fixture.fcpi.test:${fx.targetPort}`;
      const pageR = await get(port, `${base}/subres`, cred);
      assert.equal(pageR.status, 200);
      for (const p of ["/px/1.gif", "/px/2.gif", "/px/app.js"]) assert.equal((await get(port, `${base}${p}`, cred)).status, 200);
      const closed = sessions.close("a1");
      assert.equal(closed.upstreamFailure, null);
    });
    const hits = fx.state.hits.filter((h) => h.path === "/subres" || h.path.startsWith("/px/"));
    assert.equal(hits.length, 4);
    assert.ok(hits.every((h) => h.via === "proxy"), "every request of the page came through the provider");
    assert.deepEqual([...new Set(fx.state.tunnels.map((t) => t.exit))], ["exit-1"], "one sticky exit for the page and its subresources");
    await new Promise((r) => setTimeout(r, 50));
    const relayed = fx.state.tunnels.reduce((n, t) => n + t.up + t.down, 0);
    assert.ok(meter.bytes >= relayed, `metered ${meter.bytes} < relayed ${relayed}`);
  } finally { await fx.close(); }
});

test("a provider refusal of a browser request is a 502 and the attempt's provider failure", async () => {
  const fx = await startFixture();
  try {
    const { residential } = rig(fx);
    const st = residential.state();
    const meter = new Meter(10_000_000);
    fx.state.mode = "402";
    await withProxy(fx, async ({ port, sessions }) => {
      const upstream = residential.leg(st, { meter, sessionId: "s2", deadline: Date.now() + 10000 });
      const cred = sessions.open("a2", { expiresAt: Date.now() + 20000, maxBytes: meter.cap, fixture: true, upstream });
      assert.equal((await get(port, `http://m6.fixture.fcpi.test:${fx.targetPort}/static`, cred)).status, 502);
      assert.equal(sessions.close("a2").upstreamFailure.class, "PROVIDER_BILLING");
    });
    assert.equal(fx.state.hits.length, 0);
  } finally { await fx.close(); }
});

test("F11: the real search leg sends a residential-routed engine through the provider, reserving and settling each tunnel, and refuses it without the route (review W12, S4)", async () => {
  const fx = await startFixture();
  fx.state.portOverride = fx.targetPort;
  const ENGINE = "engine-r.example.com", UNNAMED = "search.unnamed.example.com"; // public names; the fixture proxy delivers their tunnels to the loopback target
  const pw = createHash("sha256").update("pw").digest(), cred = { username: "searxng", password: "pw" };
  const routes = { engineRoutes: { [ENGINE]: "residential", "direct.example.com": "direct" }, liveHosts: [ENGINE, UNNAMED, "direct.example.com"], key: urlHmac };
  try {
    const { residential, store } = rig(fx);
    const upstreamFor = residential.searchUpstream(routes);
    assert.equal(await upstreamFor({ host: "direct.example.com" }), null, "a host routed direct gets no leg");
    await withProxy(fx, async ({ port, sessions, logs }) => {
      // SearXNG's standing session, its credential checked by SHA-256 as the service's secret file gives it.
      sessions.fixed("searxng", pw, { fixture: () => false, allow: () => true, upstreamFor });
      for (const host of [ENGINE, UNNAMED]) {
        const c = await connectGet(port, host, 443, "/echo", cred);
        assert.equal(c.status, 200, JSON.stringify(logs));
        assert.match(c.body, /"via":"proxy"/, `${host} went through the provider`);
      }
      assert.equal(logs.filter((l) => l.event === "proxy_request" && l.method === "CONNECT" && l.route === "residential").length, 2);
    }, { resolvePublic: async () => ["93.184.216.34"] });
    await new Promise((r) => setTimeout(r, 100));
    const rows = [...store.ledger.rows.values()];
    assert.equal(rows.length, 2, "one reservation per tunnel");
    assert.ok(rows.every((r) => r.call_key.startsWith("proxy:search:") && r.reserved === Math.ceil((2_000_000 * 4_000_000) / 1e9) && r.state === "SETTLED" && r.usage.bytes > 0));

    // Without the route: the residential host is refused and the target sees nothing.
    const none = rig(fx, { cred: null });
    const before = fx.state.hits.length;
    await withProxy(fx, async ({ port, sessions, logs }) => {
      sessions.fixed("searxng", pw, { fixture: () => false, allow: () => true, upstreamFor: none.residential.searchUpstream(routes) });
      const r = await connectGet(port, ENGINE, 443, "/echo", cred);
      assert.equal(r.status, 403);
      assert.ok(logs.some((l) => l.event === "proxy_denied" && l.failure === "PROXY_REQUIRED"));
    }, { resolvePublic: async () => ["93.184.216.34"] });
    assert.equal(fx.state.hits.length, before);
    assert.equal(none.store.ledger.rows.size, 0);
  } finally { await fx.close(); }
});

test("a residential browser tunnel the provider breaks after it was up ends the request, and leaves the attempt's charge UNCERTAIN, still counted (review W12)", async () => {
  const fx = await startFixture();
  try {
    const { residential, store } = rig(fx);
    const st = residential.state();
    const { reservation } = await residential.reserve(st, { callKey: "proxy:broken-1", logicalId: "broken-1", bytes: 1_000_000 });
    const meter = new Meter(1_000_000);
    fx.state.mode = "reset";
    await withProxy(fx, async ({ port, sessions }) => {
      const upstream = residential.leg(st, { meter, sessionId: "brokensession1", deadline: Date.now() + 10000 });
      const cred = sessions.open("a3", { expiresAt: Date.now() + 20000, maxBytes: meter.cap, fixture: true, upstream });
      // The first answer bytes cross, then the provider resets the tunnel: the browser's answer is cut by a reset, never
      // ended as though whole and never left hanging.
      const r = await new Promise((resolve) => {
        http.request({ host: "127.0.0.1", port, path: `http://m6.fixture.fcpi.test:${fx.targetPort}/big`, headers: { "proxy-authorization": auth(cred) }, agent: false }, (res) => {
          res.on("data", () => {}); res.on("end", () => resolve({ ended: true, status: res.statusCode })); res.on("error", (e) => resolve({ error: e.code }));
        }).on("error", (e) => resolve({ error: e.code })).end();
      });
      assert.equal(r.error, "ECONNRESET", `the broken tunnel's answer was not cut: ${JSON.stringify(r)}`);
      sessions.close("a3");
    });
    // The client's reset and the tunnel's own error event are separate events: the meter records the break when the
    // latter arrives, which under load may be a moment after the reset reached the client.
    for (const until = Date.now() + 2000; !meter.errored && Date.now() < until; ) await new Promise((r) => setTimeout(r, 10));
    assert.equal(meter.errored, true, "the break is recorded on the attempt's meter");
    assert.ok(meter.bytes > 0 && meter.tunnels === 1);
    const s = await residential.settle(st, reservation, meter, "broken tunnel test");
    assert.equal(s.state, "UNCERTAIN");
    assert.equal(store.ledger.rows.get("proxy:broken-1").state, "UNCERTAIN", "the whole reservation stays counted until the provider's report reconciles it");
    assert.equal(residential.breakerState(st.providerName), "closed", "a tunnel broken after it was up is not a provider outage on its own");
  } finally { await fx.close(); }
});
