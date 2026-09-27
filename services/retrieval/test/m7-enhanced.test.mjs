// M7: the enhanced provider (src/enhanced.mjs) against the fixture Zyte API (tests/fixtures/m7/fixture.mjs, mounted at
// ../fixtures), and its place as the waterfall's last tier (src/acquire.mjs): one dispatch per logical page within the
// four-attempt budget, reserved before it is sent and never paid twice, the target's outcome judged apart from the
// provider's, every provider failure class, and the tier's refusals before anything is sent.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { loadBudgetPolicy } from "../src/budget.mjs";
import { makeEnhanced, readAnswer, REUSE_MAX_BYTES } from "../src/enhanced.mjs";
import { makeResidential } from "../src/residential.mjs";
import { makeAcquirer, makeUrlHmac, validateHooks } from "../src/acquire.mjs";
import { Denied, parseTarget } from "../src/ssrf.mjs";
import { policyFor } from "./acquire-helpers.mjs";
import { providersDir } from "./m5-helpers.mjs";
import { M6Store, startFixture as startM6, CRED as PROXY_CRED } from "./m6-helpers.mjs";

const fx7 = await import("../fixtures/m7/fixture.mjs");
const KEY = "fixture-zyte-key-0123456789abcdef";
const KEY_SHA = createHash("sha256").update(KEY).digest("hex");
const urlHmac = makeUrlHmac(Buffer.alloc(32, 11));
const listen = (s) => new Promise((r) => s.listen(0, "127.0.0.1", () => r(s.address().port)));
const close = (s) => new Promise((r) => { s.closeAllConnections?.(); s.close(r); });

async function startM7() {
  const state = fx7.makeState();
  const target = fx7.makeTarget(state);
  const targetPort = await listen(target);
  const zyte = fx7.makeZyte(state, { keySha256: KEY_SHA, port: targetPort });
  const zytePort = await listen(zyte);
  return { state, targetPort, zytePort, close: () => Promise.all([close(target), close(zyte)]) };
}

// The deployed budget policy with the fixture providers on loopback ports and the given changes.
function budgetFor(fx, { m6 = null, mutate = () => {} } = {}) {
  const b = JSON.parse(readFileSync(new URL("../policy/budget.json", import.meta.url), "utf8"));
  b.providers["fixture-zyte"].baseUrl = `http://zyte.fixture.fcpi.test:${fx.zytePort}`;
  if (m6) b.providers["fixture-proxy"].baseUrl = `http://proxy.fixture.fcpi.test:${m6.proxyPort}`;
  mutate(b);
  return loadBudgetPolicy(JSON.stringify(b));
}
function policyOf(fx, m6 = null) {
  const hosts = ["m7esc", "m7cache", "m7"].map((h) => [`${h}.fixture.fcpi.test`, fx.targetPort, "fixture"]);
  return policyFor([...hosts, ["zyte.fixture.fcpi.test", fx.zytePort, "fixture"], ...(m6 ? [["proxy.fixture.fcpi.test", m6.proxyPort, "fixture"]] : [])]);
}

function rig(fx, { enhancer = "fcpi-fixture-zyte", key = KEY, paidDispatch = false, mutate, m6 = null, proxy = null, extras = false, browser, store = new M6Store(), logs = [] } = {}) {
  const policy = policyOf(fx, m6), budget = budgetFor(fx, { m6, mutate });
  const dir = providersDir({ ...(key ? { fixture_zyte: key } : {}), ...(m6 ? { fixture_proxy: PROXY_CRED } : {}) });
  const log = (o) => logs.push(o);
  const getPolicy = () => policy, getBudget = () => budget, getSelection = () => ({ enhanced: enhancer, proxy });
  const lookupFixture = async () => ["127.0.0.1"], resolvePublic = async () => [];
  const common = { getBudget, getPolicy, getSelection, providersDir: dir, paidDispatch, store, resolvePublic, lookupFixture, log };
  const enhanced = makeEnhanced(common);
  const residential = makeResidential(common);
  const acquire = makeAcquirer({ store, getPolicy, getLocalReady: () => true, permits: { url: 2, browser: 1 }, resolvePublic, lookupFixture, urlHmac, log, residential, getBudget, enhanced, extras,
    browser: browser ?? { render: async () => ({ ok: false, failure: { class: "BROWSER_UNAVAILABLE", detail: "none" } }) } });
  return { store, enhanced, acquire, logs, policy, budget };
}
let n = 0;
const req = (url, over = {}) => ({ requestId: `r-${++n}`, logicalAcquisitionId: `l7-${n}-${Math.random()}`, url, deadline: new Date(Date.now() + 60000).toISOString(), purpose: "page", expect: "html", ...over });
const at = (fx, path, host = "m7esc") => `http://${host}.fixture.fcpi.test:${fx.targetPort}${path}`;
const rows = (store) => [...store.ledger.rows.values()].filter((r) => r.kind === "enhanced");

test("the budget policy validates the enhanced provider, its subjects and per-request cards; the selection names an enhancer", () => {
  const b = JSON.parse(readFileSync(new URL("../policy/budget.json", import.meta.url), "utf8"));
  const load = (f) => { const c = structuredClone(b); f(c); return loadBudgetPolicy(JSON.stringify(c)); };
  assert.equal(load(() => {}).enhancing.defaultEnhancer, "zyte-api");
  // The committed paid category is closed: zero caps until the owner approves one.
  assert.deepEqual(load(() => {}).categories.enhanced.caps, { day: 0, month: 0 });
  assert.throws(() => load((c) => { c.providers.zyte.baseUrl = "http://api.zyte.com"; }), /baseUrl is an origin/);
  assert.throws(() => load((c) => { c.providers["fixture-zyte"].paid = true; }), /paid enhanced provider is a public service/);
  assert.throws(() => load((c) => { c.providers.zyte.api = "scrapingbee"; }), /api must be zyte-v1/);
  assert.throws(() => load((c) => { c.rateCards.find((r) => r.subject === "zyte-api").billing = "per_request"; }), /successful_response_at_highest_tier/);
  assert.throws(() => load((c) => { delete c.rateCards.find((r) => r.subject === "zyte-api").microUsdPerBrowserRequest; }), /missing microUsdPerBrowserRequest/);
  assert.throws(() => load((c) => { c.enhancing.requestTimeoutMs = 60000; }), /requestTimeoutMs/);
  assert.throws(() => load((c) => { c.enhancers["zyte-api"].category = "fixture_enhanced"; }), /paid provider draws on a paid category/);
});

test("an HTTP dispatch settles at the card's highest tier, keeps its answer, and a retried page reuses it without a second call", async () => {
  const fx = await startM7();
  try {
    const { enhanced, store, policy } = rig(fx);
    const target = parseTarget(at(fx, "/article"), policy);
    const d = await enhanced.dispatch({ logicalId: "page-1", target, url: at(fx, "/article"), mode: "http", deadline: Date.now() + 30000 });
    assert.equal(d.answer.status, 200);
    assert.match(Buffer.from(d.answer.bodyBase64, "base64").toString(), /through the enhanced provider|by the enhanced route/);
    assert.equal(d.charge.actual, 1270);
    const [row] = rows(store);
    assert.equal(row.state, "SETTLED");
    assert.equal(row.call_key, "enhanced:page-1");
    assert.equal(fx.state.calls.length, 1);
    const again = await enhanced.dispatch({ logicalId: "page-1", target, url: at(fx, "/article"), mode: "http", deadline: Date.now() + 30000 });
    assert.equal(again.reused, true);
    assert.equal(fx.state.calls.length, 1, "a retried page never pays for a second dispatch");
    // The provider's request carried Basic authentication with the key; the target saw the provider, not this service.
    assert.equal(fx.state.hits.at(-1).via, "enhanced");
  } finally { await fx.close(); }
});

test("each provider failure class: released and free, counted on the breaker or not, and an unknown outcome stays reserved and is never resent", async () => {
  const fx = await startM7();
  try {
    const { enhanced, store, policy } = rig(fx, { mutate: (b) => { b.breaker.failures = 3; } });
    const target = parseTarget(at(fx, "/article"), policy);
    const go = (id, mode = "http") => enhanced.dispatch({ logicalId: id, target, url: at(fx, "/article"), mode, deadline: Date.now() + 30000 });
    const expect = { 520: "BLOCKED_PUBLIC_CONTENT", 401: "PROVIDER_AUTH_FAILED", 429: "PROVIDER_RATE_LIMITED" };
    for (const [mode, cls] of Object.entries(expect)) {
      fx.state.mode = mode;
      const d = await go(`fail-${mode}`);
      assert.equal(d.failure.class, cls, mode);
      assert.equal(store.ledger.rows.get(`enhanced:fail-${mode}`).state, "RELEASED", `${mode} is not charged`);
    }
    // 520 is the target's ban of the provider, not the provider's fault: only 401 and 429 counted, so the breaker is closed.
    assert.equal(enhanced.breakerState("fixture-zyte"), "closed");
    fx.state.mode = "500";
    assert.equal((await go("fail-500")).failure.class, "PROVIDER_ERROR");
    assert.equal(enhanced.breakerState("fixture-zyte"), "open");
    const st = await enhanced.availability("http");
    assert.equal(st.reason, "PROVIDER_UNAVAILABLE");
    const refused = await go("while-open");
    assert.equal(refused.failure.class, "ENHANCED_REQUIRED");
    assert.equal(store.ledger.rows.has("enhanced:while-open"), false, "nothing is reserved while the tier is unavailable");
  } finally { await fx.close(); }
});

test("a request with no answer leaves its charge UNCERTAIN and the page's dispatch is never sent again; a malformed 200 is charged", async () => {
  const fx = await startM7();
  try {
    const { enhanced, store, policy } = rig(fx, { mutate: (b) => { b.enhancing.requestTimeoutMs = 1500; } });
    const target = parseTarget(at(fx, "/article"), policy);
    fx.state.mode = "blackhole";
    const d = await enhanced.dispatch({ logicalId: "silent", target, url: at(fx, "/article"), mode: "browser", deadline: Date.now() + 30000 });
    assert.equal(d.failure.class, "ENHANCED_UNCERTAIN");
    assert.equal(store.ledger.rows.get("enhanced:silent").state, "UNCERTAIN");
    fx.state.mode = "ok";
    const calls = fx.state.calls.length;
    const again = await enhanced.dispatch({ logicalId: "silent", target, url: at(fx, "/article"), mode: "browser", deadline: Date.now() + 30000 });
    assert.equal(again.failure.class, "ENHANCED_UNCERTAIN");
    assert.equal(fx.state.calls.length, calls);
    fx.state.mode = "malformed";
    const m = await enhanced.dispatch({ logicalId: "garbled", target, url: at(fx, "/article"), mode: "http", deadline: Date.now() + 30000 });
    assert.equal(m.failure.class, "PROVIDER_ERROR");
    assert.equal(store.ledger.rows.get("enhanced:garbled").state, "SETTLED");
    assert.equal(store.ledger.rows.get("enhanced:garbled").actual, 1270);
  } finally { await fx.close(); }
});

test("the tier's refusals come before any reservation: no credential, a paid provider without paid dispatch, a zero cap, no enhancer", async () => {
  const fx = await startM7();
  try {
    assert.equal((await rig(fx, { key: null }).enhanced.availability()).reason, "BLOCKED_CREDENTIAL");
    assert.equal((await rig(fx, { enhancer: null }).enhanced.availability()).reason, "NO_ENHANCER_SELECTED");
    const paid = rig(fx, { enhancer: "zyte-api", mutate: (b) => { b.providers.zyte.credential = "fixture_zyte"; } });
    assert.equal((await paid.enhanced.availability()).reason, "PAID_DISPATCH_DISABLED");
    // Paid dispatch on, the committed caps are zero: nothing fits.
    const zero = rig(fx, { enhancer: "zyte-api", paidDispatch: true, mutate: (b) => { b.providers.zyte.credential = "fixture_zyte"; } });
    assert.equal((await zero.enhanced.availability("http")).reason, "BUDGET_EXHAUSTED");
    const r = await zero.acquire(req(at(fx, "/article"), { route: "enhanced" }));
    assert.equal(r.failure.class, "ENHANCED_REQUIRED");
    assert.deepEqual(r.strategies, []);
    assert.equal(fx.state.calls.length, 0, "nothing was sent to the provider");
  } finally { await fx.close(); }
});

test("an exhausted cap stops the next page's dispatch before it is sent, and concurrent pages cannot pass the cap", async () => {
  const fx = await startM7();
  try {
    // fcpi-fixture-zyte-small's cap (20,000 micro-USD) has room for one browser request (16,080).
    const { enhanced, store, policy } = rig(fx, { enhancer: "fcpi-fixture-zyte-small" });
    const target = parseTarget(at(fx, "/article"), policy);
    const all = await Promise.all([1, 2, 3].map((i) => enhanced.dispatch({ logicalId: `race-${i}`, target, url: at(fx, "/article"), mode: "browser", deadline: Date.now() + 30000 })));
    assert.equal(all.filter((d) => d.answer).length, 1);
    assert.equal(all.filter((d) => ["BUDGET_EXHAUSTED", "ENHANCED_REQUIRED"].includes(d.failure?.class)).length, 2);
    assert.equal(fx.state.calls.length, 1);
    assert.equal(rows(store).filter((r) => r.state === "SETTLED").length, 1);
  } finally { await fx.close(); }
});

test("the waterfall: a direct challenge with no residential route goes straight to one enhanced dispatch; the provider's 200 is judged by the target's page", async () => {
  const fx = await startM7();
  try {
    const { acquire } = rig(fx);
    const r = await acquire(req(at(fx, "/tough")));
    assert.equal(r.ok, true, JSON.stringify(r.failure));
    assert.deepEqual(r.strategies, ["direct_http", "enhanced"]);
    assert.deepEqual(r.route.escalations, ["direct_http->enhanced_http"]);
    assert.equal(r.enhanced.charge.state, "SETTLED");
    assert.equal(r.provider, "fixture-zyte");
    assert.equal(r.costEstimate, 0.00127);
    // Challenged on every route, the enhanced provider's included: one dispatch, then a typed failure.
    const never = await acquire(req(at(fx, "/never")));
    assert.equal(never.failure.class, "BLOCKED_PUBLIC_CONTENT");
    assert.match(never.failure.detail, /enhanced provider's answer was itself a bot interstitial/);
    assert.deepEqual(never.strategies, ["direct_http", "enhanced"]);
    // A page asked of the enhanced tier alone, and target outcomes it passes on: 404 is the page, 401 and 429 are failures.
    const only = await acquire(req(at(fx, "/article"), { route: "enhanced" }));
    assert.deepEqual(only.strategies, ["enhanced"]);
    assert.equal(only.ok, true);
    const gone = await acquire(req(at(fx, "/gone"), { route: "enhanced" }));
    assert.equal(gone.ok, true);
    assert.equal(gone.targetStatus, 404);
    assert.equal((await acquire(req(at(fx, "/login"), { route: "enhanced" }))).failure.class, "AUTH_REQUIRED");
    const slow = await acquire(req(at(fx, "/slow-down", "m7cache"), { route: "enhanced" }));
    assert.equal(slow.failure.class, "RATE_LIMITED");
    // An answer that ended at a Cloud host is refused, whatever it holds.
    const out = await acquire(req(at(fx, "/redirect-out", "m7"), { route: "enhanced" }));
    assert.equal(out.failure.class, "CLOUD_DENIED");
    // The ban: free, and a typed target outcome.
    const banned = await acquire(req(at(fx, "/banned"), { route: "enhanced" }));
    assert.equal(banned.failure.class, "BLOCKED_PUBLIC_CONTENT");
    assert.equal(banned.enhanced.charge, null);
  } finally { await fx.close(); }
});

test("the full waterfall: direct, residential, then the one enhanced dispatch, within four attempts; a stealth request stops at the residential route", async () => {
  const fx = await startM7();
  const m6 = await startM6();
  // The M6 proxy tunnels to its own target port unless told otherwise; here every tunnel goes to the M7 targets.
  m6.state.portOverride = fx.targetPort;
  try {
    const { acquire, store } = rig(fx, { m6, proxy: "fcpi-fixture-proxy" });
    const r = await acquire(req(at(fx, "/tough")));
    assert.equal(r.ok, true, JSON.stringify(r.failure));
    assert.deepEqual(r.strategies, ["direct_http", "residential_http", "enhanced"]);
    assert.deepEqual(r.route.escalations, ["direct_http->residential_http", "residential_http->enhanced_http"]);
    assert.ok(r.attemptsUsed <= 4);
    assert.equal(r.costEstimate > 0.00127, true, "the proxy's bytes and the enhanced request are both counted");
    const s = await acquire(req(at(fx, "/tough"), { route: "stealth" }));
    assert.deepEqual(s.strategies, ["residential_http"]);
    assert.equal(s.failure.class, "BLOCKED_PUBLIC_CONTENT");
    assert.equal(rows(store).length, 1, "only the auto page dispatched");
  } finally { await Promise.all([fx.close(), m6.close()]); }
});

test("the page's attempts are shared: a page whose earlier attempts spent the budget gets no enhanced dispatch", async () => {
  const fx = await startM7();
  try {
    const { acquire, store } = rig(fx);
    const body = req(at(fx, "/tough"));
    await store.openAcquisition(body.logicalAcquisitionId, "h", new Date(Date.now() + 60000));
    store.acq.get(body.logicalAcquisitionId).attempts = 3; // three attempts spent by earlier calls for this page
    const r = await acquire(body);
    assert.deepEqual(r.strategies, ["direct_http"]);
    assert.equal(r.failure.class, "ATTEMPT_BUDGET_EXHAUSTED");
    assert.equal(fx.state.calls.length, 0);
  } finally { await fx.close(); }
});

test("screenshots and actions: validated to the subset, refused for the enhanced tier and while switched off, and never sent to the provider", async () => {
  assert.equal(validateHooks(undefined), null);
  assert.deepEqual(validateHooks({ screenshot: { fullPage: true } }), { screenshot: { fullPage: true }, actions: [] });
  assert.deepEqual(validateHooks({ actions: [{ type: "wait", milliseconds: 500 }, { type: "click", selector: "#more" }, { type: "scroll" }, { type: "scrape" }] }).actions,
    [{ type: "wait", milliseconds: 500 }, { type: "click", selector: "#more" }, { type: "scroll", direction: "down" }, { type: "scrape" }]);
  const cls = (h) => { try { validateHooks(h); return null; } catch (e) { assert.ok(e instanceof Denied); return e.failureClass; } };
  assert.equal(cls({ actions: [{ type: "executeJavascript", script: "1" }] }), "UNSUPPORTED_CAPABILITY");
  assert.equal(cls({ actions: [{ type: "write", text: "x" }] }), "UNSUPPORTED_CAPABILITY");
  assert.equal(cls({ actions: Array.from({ length: 11 }, () => ({ type: "scroll" })) }), "UNSUPPORTED_CAPABILITY");
  assert.equal(cls({ actions: [{ type: "wait", milliseconds: 9000 }, { type: "wait", milliseconds: 7000 }] }), "UNSUPPORTED_CAPABILITY");
  assert.equal(cls({ actions: [{ type: "wait", selector: "#a" }, { type: "wait", selector: "#b" }, { type: "wait", selector: "#c" }, { type: "wait", milliseconds: 1 }] }), "UNSUPPORTED_CAPABILITY");
  assert.equal(cls({ actions: [{ type: "wait", milliseconds: 5, selector: "#a" }] }), "INVALID_REQUEST");
  assert.equal(cls({ screenshot: { fullPage: true, quality: 80 } }), "UNSUPPORTED_CAPABILITY");
  assert.equal(cls({ actions: [{ type: "click", selector: "#a", all: true }] }), "UNSUPPORTED_CAPABILITY");
  const fx = await startM7();
  try {
    const renders = [];
    const browser = { render: async (a) => { renders.push(a); return { ok: true, status: 200, finalUrl: a.url, html: `<main><h1>t</h1><p>${"text ".repeat(60)}</p></main>`, screenshot: { mime: "image/png", width: 1280, height: 800, truncated: false, bytes: 4, base64: "iVBORw==" }, actions: { screenshots: [], scrapes: [] } }; } };
    const off = rig(fx, { browser });
    assert.equal((await off.acquire(req(at(fx, "/article"), { hooks: { screenshot: {} } }))).failure.class, "UNSUPPORTED_CAPABILITY");
    const on = rig(fx, { browser, extras: true });
    assert.equal((await on.acquire(req(at(fx, "/article"), { route: "enhanced", hooks: { screenshot: {} } }))).failure.class, "UNSUPPORTED_CAPABILITY");
    const shot = await on.acquire(req(at(fx, "/article"), { hooks: { screenshot: { fullPage: false } } }));
    assert.equal(shot.ok, true);
    assert.deepEqual(shot.strategies, ["direct_browser"], "a page with extras is rendered from the start");
    assert.equal(shot.screenshot.base64, "iVBORw==");
    assert.deepEqual(renders.at(-1).hooks, { screenshot: { fullPage: false }, actions: [] });
    // Challenged in the browser, with no residential route: the enhanced tier is not asked for a page with extras.
    const cbrowser = { render: async (a) => ({ ok: true, status: 403, finalUrl: a.url, html: '<title>Just a moment...</title><div id="challenge-running"></div>', screenshot: null, actions: null }) };
    const c = rig(fx, { browser: cbrowser, extras: true });
    const blocked = await c.acquire(req(at(fx, "/tough"), { hooks: { screenshot: {} } }));
    assert.equal(blocked.failure.class, "BLOCKED_PUBLIC_CONTENT");
    assert.match(blocked.failure.detail, /not sent to the enhanced provider/);
    assert.equal(fx.state.calls.length, 0);
  } finally { await fx.close(); }
});

test("readAnswer holds the provider to its contract", () => {
  const ok = readAnswer({ url: "https://example.org/", statusCode: 200, httpResponseBody: Buffer.from("hi").toString("base64"), httpResponseHeaders: [{ name: "Content-Type", value: "text/plain" }] }, "http", 100);
  assert.equal(ok.body.toString(), "hi");
  assert.equal(ok.contentType, "text/plain");
  assert.throws(() => readAnswer({ url: "https://example.org/", statusCode: 200, httpResponseBody: "@@" }, "http", 100), /base64/);
  assert.throws(() => readAnswer({ url: "https://example.org/", statusCode: 200, httpResponseBody: Buffer.alloc(200).toString("base64") }, "http", 100), /exceeds/);
  assert.throws(() => readAnswer({ url: "ftp://x/", statusCode: 200, browserHtml: "" }, "browser", 100), /http\(s\)/);
  assert.throws(() => readAnswer({ url: "https://x/", statusCode: 0, browserHtml: "" }, "browser", 100), /statusCode/);
  assert.ok(REUSE_MAX_BYTES >= 1048576);
});
