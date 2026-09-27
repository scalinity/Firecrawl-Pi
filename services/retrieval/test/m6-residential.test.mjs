// The residential route against the fixture proxy and targets on loopback (tests/fixtures/m6/fixture.mjs): the
// tunnel, its session and byte accounting, the availability order, provider failures, and the acquisition rules
// that keep protected work off the home connection (FIRECRAWL_PI_SPEC.md §9, §10, §28.3).
import { test } from "node:test";
import assert from "node:assert/strict";
import { Denied } from "../src/ssrf.mjs";
import { Meter } from "../src/residential.mjs";
import { pinnedLookup } from "../src/resolve.mjs";
import { proxyCost } from "../src/budget.mjs";
import { startFixture, rig, req, m6Policy, m6Budget, M6Store, CRED } from "./m6-helpers.mjs";

const base = (fx, host = "m6.fixture.fcpi.test") => `http://${host}:${fx.targetPort}`;
const hitsOf = (fx, path) => fx.state.hits.filter((h) => h.path === path);

test("a stealth request travels one tunnel under a sticky session, and settles at the bytes it carried", async () => {
  const fx = await startFixture();
  try {
    const { acquire, store, logs } = rig(fx);
    const r = await acquire(req(`${base(fx)}/static`, { route: "stealth" }));
    assert.equal(r.ok, true, JSON.stringify(r.failure));
    assert.deepEqual(r.strategies, ["residential_http"]);
    assert.equal(r.initialStrategy, "residential_http");
    assert.equal(r.route.reason, "requested");
    assert.match(r.body, /through the proxy/);
    assert.deepEqual(hitsOf(fx, "/static").map((h) => h.via), ["proxy"]);
    // The proxy saw Decodo's username form and one session; the local meter counted at least what it relayed.
    assert.equal(fx.state.tunnels.length, 1);
    const t = fx.state.tunnels[0];
    assert.match(t.session, /^[0-9a-f]{24}$/);
    assert.equal(t.minutes, 5);
    assert.ok(r.proxy.bytes >= t.up + t.down, `${r.proxy.bytes} < ${t.up + t.down}`);
    const [row] = store.ledger.rows.values();
    assert.equal(row.state, "SETTLED");
    assert.equal(row.kind, "proxy");
    assert.equal(row.reserved, proxyCost({ microUsdPerGB: 4000000 }, 10000000));
    assert.equal(row.actual, proxyCost({ microUsdPerGB: 4000000 }, r.proxy.bytes));
    // The credential never reaches a log line.
    assert.ok(!JSON.stringify(logs).includes(CRED.split(":")[1]));
  } finally { await fx.close(); }
});

test("protected work never spills to the home connection: every reason the route is unavailable is PROXY_REQUIRED with no target request", async () => {
  const fx = await startFixture();
  try {
    const cases = [
      ["NO_PROXY_SELECTED", { proxy: null }],
      ["BLOCKED_CREDENTIAL", { cred: null }],
      ["RATE_CARD_MISSING", { budget: m6Budget(fx, (b) => { for (const c of b.rateCards) if (c.subject === "fcpi-fixture-proxy") { c.effectiveFrom = "2026-01-01"; c.effectiveTo = "2026-02-01"; } }) }],
      ["PAID_DISPATCH_DISABLED", { budget: m6Budget(fx, (b) => { b.providers["fixture-proxy"].paid = true; b.providers["fixture-proxy"].baseUrl = "http://gate.example.net:7000"; delete b.providers["fixture-proxy"].usageUrl; delete b.providers["fixture-proxy"].usageCredential; b.categories.fixture_proxy.paid = true; b.categories.fixture_proxy_race.paid = true; }) }],
      ["BUDGET_EXHAUSTED", { budget: m6Budget(fx, (b) => { b.categories.fixture_proxy.caps.day = 10; }) }],
    ];
    for (const [reason, o] of cases) {
      const { acquire, store } = rig(fx, o);
      const r = await acquire(req(`${base(fx)}/static`, { route: "stealth" }));
      assert.equal(r.failure?.class, "PROXY_REQUIRED", reason);
      assert.equal(r.failure.route.residential, reason);
      assert.equal(r.attemptsUsed, 0, reason);
      assert.equal(store.attempts.length, 0, reason);
    }
    assert.equal(hitsOf(fx, "/static").length, 0);
    assert.equal(fx.state.tunnels.length, 0);
  } finally { await fx.close(); }
});

test("a bulk hold and a proxy-first domain start residential, and without the route they are refused, not sent directly", async () => {
  const fx = await startFixture();
  try {
    const up = rig(fx, { policy: m6Policy(fx, { proxyFirst: ["m6hard.fixture.fcpi.test"] }) });
    up.store.holds.set("m6.fixture.fcpi.test", Date.now() + 60000);
    const held = await up.acquire(req(`${base(fx)}/static`));
    assert.equal(held.route.reason, "bulk_hold");
    assert.deepEqual(held.strategies, ["residential_http"]);
    const hard = await up.acquire(req(`${base(fx, "m6hard.fixture.fcpi.test")}/static`));
    assert.equal(hard.route.reason, "proxy_first_domain");
    assert.deepEqual(hard.strategies, ["residential_http"]);
    // Auxiliary downloads of a held domain take the same route.
    const f = await up.fetchOnce({ url: `${base(fx)}/robots.txt`, requestId: "f1", purpose: "sitemap" });
    assert.equal(f.status, 200);
    assert.equal(hitsOf(fx, "/robots.txt").at(-1).via, "proxy");

    const down = rig(fx, { cred: null, policy: m6Policy(fx, { proxyFirst: ["m6hard.fixture.fcpi.test"] }) });
    down.store.holds.set("m6.fixture.fcpi.test", Date.now() + 60000);
    const before = fx.state.hits.length;
    assert.equal((await down.acquire(req(`${base(fx)}/static`))).failure.class, "PROXY_REQUIRED");
    assert.equal((await down.acquire(req(`${base(fx, "m6hard.fixture.fcpi.test")}/static`))).failure.class, "PROXY_REQUIRED");
    await assert.rejects(down.fetchOnce({ url: `${base(fx)}/robots.txt`, requestId: "f2", purpose: "sitemap" }), (e) => e instanceof Denied && e.failureClass === "PROXY_REQUIRED");
    assert.equal(fx.state.hits.length, before, "no target request without the route");
  } finally { await fx.close(); }
});

test("auto: a challenge on the direct route escalates once to the residential route; two challenges teach the domain", async () => {
  const fx = await startFixture();
  try {
    const { acquire, store } = rig(fx);
    const url = `${base(fx, "m6learn.fixture.fcpi.test")}/challenge`;
    const r1 = await acquire(req(url));
    assert.equal(r1.ok, true, JSON.stringify(r1.failure));
    assert.deepEqual(r1.strategies, ["direct_http", "residential_http"]);
    assert.deepEqual(r1.route.escalations, ["direct_http->residential_http"]);
    assert.equal(store.routes.get("m6learn.fixture.fcpi.test").challenges, 1);
    const r2 = await acquire(req(url));
    assert.deepEqual(r2.strategies, ["direct_http", "residential_http"]);
    assert.equal(store.routes.get("m6learn.fixture.fcpi.test").preferred, "residential");
    // Learned: the third starts residential and never touches the home connection.
    const directBefore = hitsOf(fx, "/challenge").filter((h) => h.via === "direct").length;
    const r3 = await acquire(req(url));
    assert.equal(r3.route.reason, "learned_block");
    assert.deepEqual(r3.strategies, ["residential_http"]);
    assert.equal(hitsOf(fx, "/challenge").filter((h) => h.via === "direct").length, directBefore);
  } finally { await fx.close(); }
});

test("auto without the route answers a challenge as BLOCKED_PUBLIC_CONTENT; basic never escalates; the residential route's own challenge is final", async () => {
  const fx = await startFixture();
  try {
    const none = rig(fx, { cred: null });
    const r = await none.acquire(req(`${base(fx)}/challenge`));
    assert.equal(r.failure.class, "BLOCKED_PUBLIC_CONTENT");
    assert.match(r.failure.detail, /residential route is unavailable \(BLOCKED_CREDENTIAL\)/);
    assert.deepEqual(r.strategies, ["direct_http"]);
    const up = rig(fx);
    const b = await up.acquire(req(`${base(fx)}/challenge`, { route: "basic" }));
    assert.equal(b.failure.class, "BLOCKED_PUBLIC_CONTENT");
    assert.deepEqual(b.strategies, ["direct_http"]);
    const always = await up.acquire(req(`${base(fx)}/always-challenge`));
    assert.equal(always.failure.class, "BLOCKED_PUBLIC_CONTENT");
    assert.deepEqual(always.strategies, ["direct_http", "residential_http"]);
    assert.match(always.failure.detail, /enhanced retrieval is not available \(M7\)/);
  } finally { await fx.close(); }
});

test("401, 429, an unknown 403, 404 and 5xx follow spec §9.2: nothing of them reaches the residential route", async () => {
  const fx = await startFixture();
  try {
    const { acquire, store } = rig(fx);
    const at = (p, host) => acquire(req(`${base(fx, host)}${p}`));
    const auth = await at("/401");
    assert.deepEqual([auth.failure.class, auth.strategies], ["AUTH_REQUIRED", ["direct_http"]]);
    const denied = await at("/403");
    assert.deepEqual([denied.failure.class, denied.strategies], ["ACCESS_DENIED", ["direct_http"]]);
    const missing = await at("/404");
    assert.deepEqual([missing.ok, missing.targetStatus, missing.strategies], [true, 404, ["direct_http"]]);
    const err = await at("/500");
    assert.deepEqual([err.targetStatus, err.strategies], [500, ["direct_http", "direct_http"]]);
    const limited = await at("/429", "m6cool.fixture.fcpi.test");
    assert.deepEqual([limited.failure.class, limited.failure.retryAfter, limited.strategies], ["RATE_LIMITED", 30, ["direct_http"]]);
    // The cooldown holds on every route: a stealth request is refused too, rather than rotated around the limit.
    const again = await acquire(req(`${base(fx, "m6cool.fixture.fcpi.test")}/static`, { route: "stealth" }));
    assert.equal(again.failure.class, "RATE_LIMITED");
    assert.equal(fx.state.tunnels.length, 0);
    // None of them taught a route preference; an auth gate is counted, never learned from.
    assert.equal(store.routes.get("m6.fixture.fcpi.test")?.preferred ?? null, null);
  } finally { await fx.close(); }
});

test("provider failures are typed, count on the breaker, never teach the domain and never fall back to direct", async () => {
  const fx = await startFixture();
  try {
    const { acquire, residential, store } = rig(fx);
    const expect = { 407: "PROVIDER_AUTH_FAILED", 402: "PROVIDER_BILLING", 429: "PROVIDER_RATE_LIMITED" };
    for (const [mode, cls] of Object.entries(expect)) {
      fx.state.mode = mode;
      const r = await acquire(req(`${base(fx)}/static`, { route: "stealth" }));
      assert.equal(r.failure.class, cls, mode);
      assert.deepEqual(r.strategies, ["residential_http"]);
    }
    // Three provider failures within the window opened the breaker: the route is now unavailable, refused up front.
    assert.equal(residential.breakerState("fixture-proxy"), "open");
    fx.state.mode = "ok";
    const refused = await acquire(req(`${base(fx)}/static`, { route: "stealth" }));
    assert.equal(refused.failure.class, "PROXY_REQUIRED");
    assert.equal(refused.failure.route.residential, "PROVIDER_UNAVAILABLE");
    assert.equal(hitsOf(fx, "/static").length, 0, "the home connection was never tried");
    assert.equal(store.routes.get("m6.fixture.fcpi.test")?.preferred ?? null, null);
    // Every provider-refused attempt settled its reservation at the few bytes it measured.
    for (const row of store.ledger.rows.values()) assert.equal(row.state, "SETTLED");
  } finally { await fx.close(); }
});

test("a proxy that cannot be reached or never answers is PROVIDER_UNREACHABLE within the connect timeout", async () => {
  const fx = await startFixture();
  try {
    const { acquire } = rig(fx);
    fx.state.mode = "refuse";
    assert.equal((await acquire(req(`${base(fx)}/static`, { route: "stealth" }))).failure.class, "PROVIDER_UNREACHABLE");
    fx.state.mode = "blackhole";
    const t0 = Date.now();
    assert.equal((await acquire(req(`${base(fx)}/static`, { route: "stealth" }))).failure.class, "PROVIDER_UNREACHABLE");
    assert.ok(Date.now() - t0 < 6000, "bounded by residential.connectTimeoutMs (3 s here)");
  } finally { await fx.close(); }
});

test("an attempt past its byte reservation is cut off as SIZE_LIMIT with no retry, and its true charge is recorded, above the reservation by at most the chunk that tripped it (review W2, S8)", async () => {
  const fx = await startFixture();
  try {
    const { acquire, store } = rig(fx, { policy: Object.assign(m6Policy(fx), { maxBodyBytes: 20_000_000 }) });
    const r = await acquire(req(`${base(fx)}/big`, { route: "stealth" }));
    assert.equal(r.failure.class, "SIZE_LIMIT");
    assert.deepEqual(r.strategies, ["residential_http"], "a cut at the cap earns no same-tier retry");
    const [row] = store.ledger.rows.values();
    assert.equal(row.state, "SETTLED");
    assert.ok(row.usage.bytes > 10_000_000 && row.usage.bytes < 10_000_000 + 1_048_576, `${row.usage.bytes} bytes`);
    assert.equal(row.actual, Math.ceil((row.usage.bytes * 4_000_000) / 1e9));
    assert.ok(row.actual > row.reserved);
    assert.match(row.detail, /above its reservation/);
  } finally { await fx.close(); }
});

test("the direct limits spent, an auto request moves the same attempt to the residential route; basic stops at PROXY_REQUIRED", async () => {
  const fx = await startFixture();
  try {
    const direct = { perDomainInFlight: 1, minNavigationGapMs: 0, perDomainPerHour: 1, platformPerDay: 200 };
    const { acquire } = rig(fx, { policy: m6Policy(fx, { direct }) });
    const url = `${base(fx, "m6pace.fixture.fcpi.test")}/static`;
    assert.deepEqual((await acquire(req(url))).strategies, ["direct_http"]);
    const second = await acquire(req(url));
    assert.equal(second.ok, true, JSON.stringify(second.failure));
    assert.deepEqual(second.strategies, ["residential_http"]);
    assert.equal(second.attemptsUsed, 1, "the cap cost the page no attempt");
    assert.deepEqual(second.route.escalations, ["direct_cap:domain_hour"]);
    const basic = await acquire(req(url, { route: "basic" }));
    assert.equal(basic.failure.class, "PROXY_REQUIRED");
    assert.equal(hitsOf(fx, "/static").filter((h) => h.via === "direct").length, 1);
  } finally { await fx.close(); }
});

test("HTTP to browser to residential browser: a script shell renders on the same route, and its challenge escalates in the browser", async () => {
  const fx = await startFixture();
  try {
    // A browser stand-in that fetches the page as Chromium would through the forward proxy: directly, or through
    // the attempt's leg when it has one, and runs nothing: it returns the markup the shell would write.
    const http = await import("node:http");
    const browser = { render: async ({ url, upstream }) => {
      const u = new URL(url);
      const body = await new Promise((resolve, reject) => {
        const go = (socket) => http.request({ host: u.hostname, port: u.port, path: u.pathname, ...(socket ? { createConnection: () => socket } : { agent: false, lookup: pinnedLookup("127.0.0.1") }) },
          (res) => { let b = ""; res.on("data", (c) => (b += c)); res.on("end", () => resolve(b)); }).on("error", reject).end();
        if (upstream) upstream.open(u.hostname, Number(u.port)).then(go, reject); else go(null);
      });
      const inner = /atob\("([^"]+)"\)/.exec(body);
      const html = inner ? `<html><body>${Buffer.from(inner[1], "base64").toString()}</body></html>` : body;
      return { ok: true, status: 200, html, finalUrl: url, contentType: "text/html", subresources: { requests: 0, overLimit: 0 }, proxy: { requests: 1, bytes: html.length, capped: false, denied: [] } };
    } };
    const { acquire, store } = rig(fx, { browser });
    const r = await acquire(req(`${base(fx)}/js-challenge`));
    assert.equal(r.ok, true, JSON.stringify(r.failure));
    assert.deepEqual(r.strategies, ["direct_http", "direct_browser", "residential_browser"]);
    assert.match(r.body, /Rendered through the proxy/);
    assert.equal(r.attemptsUsed, 3);
    assert.deepEqual(r.route.escalations, ["direct_browser->residential_browser"]);
    // The residential browser attempt reserved and settled like an HTTP one.
    const rows = [...store.ledger.rows.values()];
    assert.equal(rows.length, 1);
    assert.equal(rows[0].state, "SETTLED");
  } finally { await fx.close(); }
});

test("the four-attempt budget holds across routes: no fifth attempt, whatever the escalations", async () => {
  const fx = await startFixture();
  try {
    const { acquire } = rig(fx);
    const id = `l-budget-${Math.random()}`;
    const url = `${base(fx)}/always-challenge`;
    const a = await acquire(req(url, { logicalAcquisitionId: id }));
    const b = await acquire(req(url, { logicalAcquisitionId: id }));
    const c = await acquire(req(url, { logicalAcquisitionId: id }));
    assert.deepEqual([a.attemptsUsed, b.attemptsUsed], [2, 4]);
    assert.equal(c.failure.class, "ATTEMPT_BUDGET_EXHAUSTED");
    assert.equal(hitsOf(fx, "/always-challenge").length, 4);
  } finally { await fx.close(); }
});

test("eight simultaneous reservations against a cap with room for three: three granted, five BUDGET_EXHAUSTED, nothing sent for them", async () => {
  // Acquisitions are bound by the two global URL permits, so only search tunnels (one reservation each, as many as
  // SearXNG opens) press on a cap this wide at once; the ledger's own race is tested against PostgreSQL (m6-store).
  const fx = await startFixture();
  try {
    const per = proxyCost({ microUsdPerGB: 4000000 }, 10000000);
    const { residential, store } = rig(fx, { budget: m6Budget(fx, (b) => { b.categories.fixture_proxy.caps.day = per * 3 + 1; }) });
    const st = residential.state();
    const rs = await Promise.all(Array.from({ length: 8 }, (_, i) => residential.reserve(st, { callKey: `proxy:race-${i}`, logicalId: `race-${i}`, bytes: 10000000 })));
    assert.equal(rs.filter((r) => r.reservation).length, 3);
    assert.equal(rs.filter((r) => r.failure?.class === "BUDGET_EXHAUSTED").length, 5);
    assert.equal(store.ledger.used("fixture_proxy"), per * 3);
    assert.equal(fx.state.tunnels.length, 0);
  } finally { await fx.close(); }
});

test("the meter trips at its cap, and a tunnel attached after it tripped is cut at once (review W2)", async () => {
  const m = new Meter(100);
  const sock = () => { const s = { destroyed: false, destroy() { this.destroyed = true; }, once() {} }; return s; };
  const early = sock();
  m.attach(early);
  m.add(60);
  assert.equal(m.capped, false);
  m.add(50);
  assert.equal(m.capped, true);
  assert.equal(m.bytes, 110);
  assert.equal(early.destroyed, true);
  const late = sock();
  m.attach(late);
  assert.equal(late.destroyed, true);
  assert.equal(m.tunnels, 2);
});

test("a residential render whose leg passed its reservation is RESOURCE_LIMIT, not a success, and no tunnel opens after the cap (review W2)", async () => {
  const fx = await startFixture();
  try {
    const http = await import("node:http");
    // A browser stand-in: the page's big subresource trips the cap; the page itself still "renders", as Chromium would.
    let lateRefused = null;
    const browser = { render: async ({ url, upstream }) => {
      const u = new URL(url);
      await new Promise((resolve) => upstream.open(u.hostname, Number(u.port)).then((s) => {
        http.request({ host: u.hostname, port: u.port, path: "/big", createConnection: () => s }, (res) => { res.on("data", () => {}); res.on("close", resolve); res.on("error", resolve); }).on("error", resolve).end();
      }, resolve));
      lateRefused = await upstream.open(u.hostname, Number(u.port)).then(() => null, (e) => e.failureClass);
      return { ok: true, status: 200, html: "<html><body><main><h1>Partial page</h1><p>" + "text ".repeat(200) + "</p></main></body></html>", finalUrl: url, contentType: "text/html",
        subresources: { requests: 1, overLimit: 0 }, proxy: { requests: 2, bytes: 1000, capped: false, denied: [] } };
    } };
    const { acquire } = rig(fx, { browser, policy: Object.assign(m6Policy(fx), { maxBodyBytes: 20_000_000 }) });
    const r = await acquire(req(`${base(fx)}/js-subres`, { route: "stealth" }));
    assert.equal(r.failure?.class, "RESOURCE_LIMIT");
    assert.deepEqual(r.strategies, ["residential_http", "residential_browser"]);
    assert.equal(lateRefused, "SIZE_LIMIT");
  } finally { await fx.close(); }
});

test("a credential whose name would change the session username is refused, and the route's state never carries the password (review S18, S2)", async () => {
  const fx = await startFixture();
  try {
    const bad = rig(fx, { cred: "user-sp1-session-x:0123456789abcdef" });
    assert.equal(bad.residential.state().reason, "BLOCKED_CREDENTIAL");
    const r = await bad.acquire(req(`${base(fx)}/static`, { route: "stealth" }));
    assert.equal(r.failure.class, "PROXY_REQUIRED");
    assert.equal(fx.state.tunnels.length, 0);
    const good = rig(fx);
    const st = good.residential.state();
    assert.equal(st.available, true);
    assert.ok(!JSON.stringify(st).includes(CRED.split(":")[1]), "no password in the route state");
    assert.equal(JSON.stringify(await good.residential.availability()).includes(CRED.split(":")[1]), false);
  } finally { await fx.close(); }
});

test("a target that never answers the TLS hello through the tunnel ends as TIMEOUT within the attempt, not at the provider's leisure (review W3)", async () => {
  const fx = await startFixture();
  const net = await import("node:net");
  const silent = net.createServer((s) => { s.on("error", () => {}); }).listen(0, "127.0.0.1");
  await new Promise((r) => silent.once("listening", r));
  fx.state.portOverride = silent.address().port;
  try {
    const { acquire, store } = rig(fx, { resolvePublic: async () => ["93.184.216.34"] });
    const t0 = Date.now();
    const r = await acquire(req("https://silent.example.org/", { route: "stealth" }));
    assert.equal(r.failure.class, "TIMEOUT");
    assert.ok(Date.now() - t0 < 12000, `${Date.now() - t0} ms`);
    const [row] = store.ledger.rows.values();
    assert.equal(row.state, "SETTLED", "the attempt's reservation settled at what the tunnel carried");
  } finally { silent.close(); await fx.close(); }
});

test("an exception between a reservation and its settlement still closes the leg: released when nothing was sent (review W9)", async () => {
  const fx = await startFixture();
  try {
    const store = new M6Store();
    const real = store.paceDirect.bind(store);
    store.paceDirect = async (...a) => { if (a[5] === "residential") throw Object.assign(new Error("connection terminated"), { code: "57P01" }); return real(...a); };
    const { acquire } = rig(fx, { store });
    await assert.rejects(acquire(req(`${base(fx)}/static`, { route: "stealth" })), /connection terminated/);
    const rows = [...store.ledger.rows.values()];
    assert.equal(rows.length, 1);
    assert.equal(rows[0].state, "RELEASED");
    assert.equal(store.ledger.used("fixture_proxy"), 0, "the reservation no longer counts against the cap");
    assert.equal(fx.state.tunnels.length, 0);
  } finally { await fx.close(); }
});
