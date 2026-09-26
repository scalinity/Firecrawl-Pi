// The acquisition orchestration end to end against loopback fixture servers, with an in-memory
// store that applies the real pacing and cooldown decisions (store.mjs's paceDecision and
// nextCooldown). The policy is built here with loopback fixture hosts, which the deployed policy
// loader never accepts.
import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { BlockList } from "node:net";
import { getEventListeners } from "node:events";
import { paceDecision, nextCooldown } from "../src/store.mjs";
import { makeAcquirer, makeFetcher, makePacer } from "../src/acquire.mjs";

export class FakeStore {
  constructor() { this.acq = new Map(); this.attempts = []; this.permits = new Map(); this.domains = new Map(); this.navs = []; this.cooled = []; }
  async openAcquisition(id, _h, deadline) {
    let a = this.acq.get(id);
    if (!a) this.acq.set(id, (a = { first_seen: new Date(), deadline, attempts: 0 }));
    else if (deadline < a.deadline) a.deadline = deadline;
    return { ...a };
  }
  async reserveAttempt({ logicalId, attemptId, strategy, domain, maxAttempts }) {
    const a = this.acq.get(logicalId);
    if (a.attempts >= maxAttempts) return null;
    a.attempts++;
    this.attempts.push({ attemptId, logicalId, ordinal: a.attempts, strategy, domain });
    return a.attempts;
  }
  async finishAttempt(attemptId, o) { Object.assign(this.attempts.find((x) => x.attemptId === attemptId), { outcome: o.outcome }); }
  async takePermit(kind, holder, slots) {
    for (let i = 0; i < slots; i++) if (!this.permits.has(`${kind}:${i}`)) { this.permits.set(`${kind}:${i}`, holder); return i; }
    return null;
  }
  async releasePermit(kind, holder) { for (const [k, v] of this.permits) if (k.startsWith(`${kind}:`) && v === holder) this.permits.delete(k); }
  state(domain) {
    if (!this.domains.has(domain)) this.domains.set(domain, { holder: null, hold_until: null, last_nav_at: null, cooldown_until: null, cooldown_s: null });
    return this.domains.get(domain);
  }
  async paceDirect(domain, holder, limits, holdMs, fixture) {
    const now = new Date(), s = this.state(domain);
    const hourCount = this.navs.filter((n) => n.domain === domain && now - n.at < 3600e3).length;
    const dayCount = this.navs.filter((n) => !n.fixture && now - n.at < 86400e3).length;
    const d = paceDecision({ now, state: s, hourCount, dayCount, limits });
    if (!d.go) return d;
    Object.assign(s, { holder, hold_until: new Date(+now + holdMs), last_nav_at: now });
    this.navs.push({ domain, fixture, at: now });
    return d;
  }
  async recordNavigation(domain, fixture) { this.navs.push({ domain, fixture, at: new Date(), recorded: true }); }
  async releaseDomain(domain, holder) { const s = this.state(domain); if (s.holder === holder) Object.assign(s, { holder: null, hold_until: null }); }
  async coolDown(domain, retryAfterS) {
    const s = this.state(domain), sec = nextCooldown(s.cooldown_s, retryAfterS);
    Object.assign(s, { cooldown_s: sec, cooldown_until: new Date(Date.now() + sec * 1000) });
    this.cooled.push({ domain, sec });
  }
}

const lan = new BlockList();
lan.addSubnet("45.33.20.0", 24, "ipv4");
export function policyFor(fixtures, direct = { perDomainInFlight: 1, minNavigationGapMs: 400, perDomainPerHour: 20, platformPerDay: 200 }) {
  return { ports: [80, 443], localCidrs: lan, cloudDenylist: ["*.firecrawl.dev", "firecrawl.dev"], maxRedirects: 5, maxBodyBytes: 1 << 20, permitLeaseMs: 120000,
    attempts: { maxPerPage: 4, acquisitionDeadlineMs: 90000, httpAttemptMs: 5000, browserAttemptMs: 10000 },
    fixtureLimits: { perDomainInFlight: 1, minNavigationGapMs: 0, perDomainPerHour: null, platformPerDay: null }, direct,
    browser: { maxSubresources: 10, maxSubresourceBytes: 1 << 20, contextMaxMs: 120000 },
    fixtures: fixtures.map(([host, port, limits]) => ({ host, port, cidr: "127.0.0.0/24", limits })) };
}
export function serve(handler) {
  return new Promise((resolve) => {
    const hits = [];
    const s = http.createServer((req, res) => { hits.push({ path: req.url, at: Date.now() }); handler(req, res); }).listen(0, "127.0.0.1", () => resolve({ s, port: s.address().port, hits }));
  });
}
const page = (res, body = "<main><h1>Article</h1><p>A plain page with enough text to be an article of its own.</p></main>") =>
  res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(`<!doctype html><title>t</title>${body}`);
export const acquirerFor = (store, policy, browser = { render: async () => ({ ok: false, failure: { class: "BROWSER_UNAVAILABLE", detail: "none" } }) }) =>
  makeAcquirer({ store, getPolicy: () => policy, getLocalReady: () => true, permits: { url: 2, browser: 1 }, resolvePublic: async () => [], lookupFixture: async () => ["127.0.0.1"], browser, log: () => {} });
export const body = (url, id = `l-${Math.random()}`) => ({ requestId: `r-${Math.random()}`, logicalAcquisitionId: id, url, deadline: new Date(Date.now() + 30000).toISOString(), purpose: "page", expect: "html" });

test("a redirect into another domain is paced and counted there, and a 429 cools down the host that sent it (review finding C4)", async () => {
  const b = await serve((req, res) => (req.url.startsWith("/429") ? res.writeHead(429, { "retry-after": "7" }).end() : page(res)));
  const a = await serve((req, res) => res.writeHead(302, { location: `http://b.fixture.fcpi.test:${b.port}${req.url.replace("/go", "")}` }).end());
  try {
    const store = new FakeStore(), policy = policyFor([["a.fixture.fcpi.test", a.port, "fixture"], ["b.fixture.fcpi.test", b.port, "direct"]]);
    const acquire = acquirerFor(store, policy);
    const [r1, r2] = await Promise.all([acquire(body(`http://a.fixture.fcpi.test:${a.port}/go/p1`)), acquire(body(`http://a.fixture.fcpi.test:${a.port}/go/p2`))]);
    assert.equal(r1.ok && r2.ok, true);
    assert.equal(store.navs.filter((n) => n.domain === "b.fixture.fcpi.test").length, 2);
    const gap = Math.abs(b.hits[1].at - b.hits[0].at);
    assert.ok(gap >= 380, `B saw two navigations ${gap} ms apart`);
    assert.equal(store.state("b.fixture.fcpi.test").holder, null);
    const r3 = await acquire(body(`http://a.fixture.fcpi.test:${a.port}/go/429`));
    assert.equal(r3.failure.class, "RATE_LIMITED");
    assert.deepEqual(store.cooled, [{ domain: "b.fixture.fcpi.test", sec: 7 }]);
    const r4 = await acquire(body(`http://a.fixture.fcpi.test:${a.port}/go/p3`));
    assert.equal(r4.failure.class, "RATE_LIMITED");
    assert.equal(r4.failure.retryAfter > 0, true);
    assert.equal(b.hits.filter((h) => h.path === "/p3").length, 0);
  } finally { a.s.close(); b.s.close(); }
});

test("downloads and searches hold a URL permit, and repeated downloads of one URL share a budget (review finding W1)", async () => {
  const f = await serve((req, res) => res.writeHead(200, { "content-type": "application/xml" }).end("<urlset/>"));
  try {
    const store = new FakeStore(), policy = policyFor([["f.fixture.fcpi.test", f.port, "fixture"]]);
    const fetchOnce = makeFetcher({ store, getPolicy: () => policy, getLocalReady: () => true, permits: { url: 2, browser: 1 }, resolvePublic: async () => [], lookupFixture: async () => ["127.0.0.1"], log: () => {} });
    const req = () => ({ requestId: `r-${Math.random()}`, url: `http://f.fixture.fcpi.test:${f.port}/sitemap.xml.gz`, purpose: "sitemap", deadline: new Date(Date.now() + 1500).toISOString() });
    // Both permits held elsewhere: the download waits for one, and gives up at its deadline.
    await store.takePermit("url", "page-1", 2); await store.takePermit("url", "page-2", 2);
    await assert.rejects(fetchOnce(req()), (e) => e.failureClass === "RESOURCE_BUSY" && e.retryable === true);
    assert.equal(f.hits.length, 0);
    await store.releasePermit("url", "page-1"); await store.releasePermit("url", "page-2");
    for (let n = 1; n <= 4; n++) assert.equal((await fetchOnce(req())).status, 200);
    await assert.rejects(fetchOnce(req()), (e) => e.failureClass === "ATTEMPT_BUDGET_EXHAUSTED");
    assert.equal(f.hits.length, 4);
    assert.equal(store.permits.size, 0);
  } finally { f.s.close(); }
});

test("a download's final URL is one a response header can carry (review finding S10)", async () => {
  const f = await serve((req, res) => res.writeHead(200, { "content-type": "application/pdf" }).end("%PDF-"));
  try {
    const store = new FakeStore(), policy = policyFor([["f.fixture.fcpi.test", f.port, "fixture"]]);
    const fetchOnce = makeFetcher({ store, getPolicy: () => policy, getLocalReady: () => true, permits: { url: 2, browser: 1 }, resolvePublic: async () => [], lookupFixture: async () => ["127.0.0.1"], log: () => {} });
    const r = await fetchOnce({ requestId: "r-s10", url: `http://f.fixture.fcpi.test:${f.port}/doc-€.pdf`, purpose: "document" });
    assert.equal(r.finalUrl, `http://f.fixture.fcpi.test:${f.port}/doc-%E2%82%AC.pdf`);
    assert.doesNotThrow(() => http.validateHeaderValue("x-fcpi-final-url", r.finalUrl));
  } finally { f.s.close(); }
});

test("a caller that leaves during a retry's back-off gets CANCELLED and no further attempt (review finding W2)", async () => {
  const t = await serve((req, res) => res.writeHead(503, { "content-type": "text/html" }).end("<p>down</p>"));
  try {
    const store = new FakeStore(), policy = policyFor([["t.fixture.fcpi.test", t.port, "fixture"]]);
    const ac = new AbortController();
    const started = acquirerFor(store, policy)(body(`http://t.fixture.fcpi.test:${t.port}/`, "cancel-1"), ac.signal);
    setTimeout(() => ac.abort(), 300); // after the first 503, inside the same-tier retry's back-off
    const r = await started;
    assert.equal(r.failure.class, "CANCELLED");
    assert.equal(store.acq.get("cancel-1").attempts, 1);
    assert.equal(t.hits.length, 1);
    assert.equal(store.permits.size, 0);
  } finally { t.s.close(); }
});

test("a pacing wait leaves no abort listener behind on the caller's signal (review finding S7)", async () => {
  let waits = 20;
  const store = { paceDirect: async () => (waits-- > 0 ? { waitMs: 1 } : { go: true }) };
  const policy = policyFor([["t.fixture.fcpi.test", 1, "fixture"]]);
  const { pace } = makePacer({ store, getPolicy: () => policy, log: () => {} });
  const ac = new AbortController();
  const p = await pace({ host: "t.fixture.fcpi.test", fixture: policy.fixtures[0] }, "h", Date.now() + 5000, ac.signal);
  assert.equal(p.failure, undefined);
  assert.equal(getEventListeners(ac.signal, "abort").length, 0);
});

test("a database error while the browser attempt is paced still frees every permit and hold (review finding W3)", async () => {
  const shell = '<main id="root"><noscript>Please enable JavaScript to read this page.</noscript></main><script src="/app.js"></script>';
  const t = await serve((req, res) => res.writeHead(200, { "content-type": "text/html" }).end(shell));
  try {
    const store = new FakeStore(), policy = policyFor([["t.fixture.fcpi.test", t.port, "fixture"]]);
    const real = store.paceDirect.bind(store);
    let calls = 0;
    store.paceDirect = async (...a) => { if (++calls === 2) throw Object.assign(new Error("connection terminated"), { code: "57P01" }); return real(...a); };
    let rendered = false;
    const browser = { render: async () => { rendered = true; return { ok: true, html: shell, status: 200 }; } };
    await assert.rejects(acquirerFor(store, policy, browser)(body(`http://t.fixture.fcpi.test:${t.port}/`)), /connection terminated/);
    assert.equal(rendered, false);
    assert.equal(store.permits.size, 0);
    assert.equal(store.state("t.fixture.fcpi.test").holder, null);
  } finally { t.s.close(); }
});

test("a render that hit its budget is RESOURCE_LIMIT, not a success (review finding W6)", async () => {
  const shell = '<main id="root"><noscript>Please enable JavaScript to read this page.</noscript></main><script src="/app.js"></script>';
  const t = await serve((req, res) => res.writeHead(200, { "content-type": "text/html" }).end(shell));
  try {
    const store = new FakeStore(), policy = policyFor([["t.fixture.fcpi.test", t.port, "fixture"]]);
    const rendered = "<main><h1>Rendered</h1><p>Enough article text here to be an adequate page of its own, once rendered by script.</p></main>";
    for (const r of [{ subresources: { requests: 200, overLimit: 3 }, proxy: { requests: 200, bytes: 10, capped: false, denied: [] } },
      { subresources: { requests: 5, overLimit: 0 }, proxy: { requests: 260, bytes: 10, capped: true, denied: [] } }]) {
      const browser = { render: async () => ({ ok: true, html: rendered, status: 200, ...r }) };
      const out = await acquirerFor(store, policy, browser)(body(`http://t.fixture.fcpi.test:${t.port}/`));
      assert.equal(out.failure?.class, "RESOURCE_LIMIT");
    }
  } finally { t.s.close(); }
});

// ---- the orchestration's branches (review finding W9) ---------------------------------------------
const SHELL = '<main id="root"><noscript>Please enable JavaScript to read this page.</noscript></main><script src="/app.js"></script>';
const RENDERED = "<main><h1>Rendered</h1><p>Enough article text here to be an adequate page of its own, once rendered by script.</p></main>";
const okRender = (html = RENDERED) => ({ render: async (a) => ({ ok: true, html, status: 200, finalUrl: a.url, subresources: { requests: 1, overLimit: 0 }, proxy: { requests: 1, bytes: 10, capped: false, denied: [] } }) });

test("a JS shell gets one browser attempt; a structural shell after it is RENDER_INCOMPLETE", async () => {
  const t = await serve((req, res) => res.writeHead(200, { "content-type": "text/html" }).end(SHELL));
  try {
    const store = new FakeStore(), policy = policyFor([["t.fixture.fcpi.test", t.port, "fixture"]]);
    const good = await acquirerFor(store, policy, okRender())(body(`http://t.fixture.fcpi.test:${t.port}/`));
    assert.deepEqual([good.ok, good.strategies, good.attemptsUsed], [true, ["direct_http", "direct_browser"], 2]);
    const still = await acquirerFor(store, policy, okRender(SHELL))(body(`http://t.fixture.fcpi.test:${t.port}/`));
    assert.equal(still.failure.class, "RENDER_INCOMPLETE");
    assert.equal(store.attempts.at(-1).outcome, "RENDER_INCOMPLETE");
  } finally { t.s.close(); }
});

test("a target error gets one same-tier retry and keeps its native status; the budget can run out before the browser", async () => {
  let n = 0;
  const t = await serve((req, res) => (req.url === "/down" ? res.writeHead(503, { "content-type": "text/html" }).end("<p>down</p>") : (n++, res.writeHead(200, { "content-type": "text/html" }).end(SHELL))));
  try {
    const store = new FakeStore(), policy = policyFor([["t.fixture.fcpi.test", t.port, "fixture"]]);
    const down = await acquirerFor(store, policy)(body(`http://t.fixture.fcpi.test:${t.port}/down`, "down-1"));
    assert.deepEqual([down.ok, down.targetStatus, down.attemptsUsed], [true, 503, 2]);
    // Three attempts already spent on this logical page: the fourth is direct, none is left for the browser.
    await store.openAcquisition("late-1", "h", new Date(Date.now() + 60000));
    store.acq.get("late-1").attempts = 3;
    const late = await acquirerFor(store, policy, okRender())(body(`http://t.fixture.fcpi.test:${t.port}/`, "late-1"));
    assert.equal(late.failure.class, "ATTEMPT_BUDGET_EXHAUSTED");
    assert.equal(n, 1);
  } finally { t.s.close(); }
});

test("a pacing refusal is the attempt's recorded outcome and reaches no target", async () => {
  const t = await serve((req, res) => res.writeHead(200, { "content-type": "text/html" }).end("<p>x</p>"));
  try {
    const store = new FakeStore(), policy = policyFor([["t.fixture.fcpi.test", t.port, "fixture"]]);
    await store.coolDown("t.fixture.fcpi.test", 30);
    const r = await acquirerFor(store, policy)(body(`http://t.fixture.fcpi.test:${t.port}/`));
    assert.equal(r.failure.class, "RATE_LIMITED");
    assert.equal(store.attempts.at(-1).outcome, "RATE_LIMITED");
    assert.equal(t.hits.length, 0);
  } finally { t.s.close(); }
});

test("requests are validated and bodies decoded by their declared charset", async () => {
  const { validateAcquireRequest, decodeText } = await import("../src/acquire.mjs");
  const ok = body("http://example.com/");
  for (const bad of [null, { ...ok, url: "" }, { ...ok, deadline: "soon" }, { ...ok, purpose: "crawl" }, { ...ok, expect: "video" }, { ...ok, headers: [] }, { ...ok, waitFor: 15001 }, { ...ok, logicalAcquisitionId: "x".repeat(257) }]) {
    assert.throws(() => validateAcquireRequest(bad), (e) => e.failureClass === "INVALID_REQUEST");
  }
  assert.equal(validateAcquireRequest(ok).waitFor, 0);
  assert.equal(decodeText(Buffer.from([0x63, 0x61, 0x66, 0xe9]), "text/html; charset=iso-8859-1"), "café");
  assert.equal(decodeText(Buffer.from('<meta charset="windows-1252"><p>\x93q\x94</p>', "latin1"), "text/html"), '<meta charset="windows-1252"><p>“q”</p>');
  assert.equal(decodeText(Buffer.from("héllo", "utf8"), "text/html; charset=not-a-charset"), "héllo");
});
