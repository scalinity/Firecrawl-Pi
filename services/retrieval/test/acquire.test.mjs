// The acquisition orchestration end to end against loopback fixture servers, with an in-memory
// store that applies the real pacing and cooldown decisions (store.mjs's paceDecision and
// nextCooldown). The policy is built here with loopback fixture hosts, which the deployed policy
// loader never accepts.
import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { BlockList } from "node:net";
import { paceDecision, nextCooldown } from "../src/store.mjs";
import { makeAcquirer, makeFetcher } from "../src/acquire.mjs";

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
