// Shared by the acquisition tests (acquire.test.mjs) and M6's (m6-helpers.mjs): an in-memory store that applies the
// real pacing and cooldown decisions (store.mjs's paceDecision and nextCooldown) and M6's routing records (route.mjs's
// observe), a policy built with loopback fixture hosts, which the deployed policy loader never accepts, loopback
// fixture servers and request bodies.
import http from "node:http";
import { BlockList } from "node:net";
import { paceDecision, nextCooldown } from "../src/store.mjs";
import { observe } from "../src/route.mjs";
import { makeAcquirer, makeUrlHmac } from "../src/acquire.mjs";

export class FakeStore {
  constructor() { this.acq = new Map(); this.attempts = []; this.permits = new Map(); this.domains = new Map(); this.navs = []; this.cooled = []; this.routes = new Map(); this.holds = new Map(); this.learned = []; }
  // M6: routing records (driven by route.mjs's observe, as the Store's SQL is), probes and holds.
  async routeRecord(domain) { return this.routes.get(domain) ?? null; }
  async routeHeld(domain) { const h = this.holds.get(domain); return !!h && h > Date.now(); }
  async claimProbe(domain, minutes) {
    const r = this.routes.get(domain);
    if (!r || r.preferred !== "residential" || r.expires_at > new Date() || (r.probe_at && +r.probe_at > Date.now() - minutes * 60e3)) return false;
    r.probe_at = new Date(); return true;
  }
  async learnRoute(domain, obs, routing, outcome = {}) {
    const cur = this.routes.get(domain) ?? null;
    const change = obs ? observe(cur, obs, routing) : null;
    this.learned.push({ domain, obs, outcome, change });
    if (!cur && !change && outcome.success === undefined) return null;
    const next = { ...(cur ?? { preferred: null, challenges: 0, js_count: 0, prefer_browser: false }), ...(change ?? {}) };
    this.routes.set(domain, next);
    return { row: next, change };
  }
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
  async paceDirect(domain, holder, limits, holdMs, fixture, tier = "direct") {
    const now = new Date(), s = this.state(domain);
    const hour = this.navs.filter((n) => n.domain === domain && n.tier === "direct" && now - n.at < 3600e3);
    const day = this.navs.filter((n) => !n.fixture && n.tier === "direct" && now - n.at < 86400e3);
    const oldest = (l) => (l.length ? new Date(Math.min(...l.map((n) => +n.at))) : null);
    const d = paceDecision({ now, state: s, hourCount: hour.length, dayCount: day.length, hourOldest: oldest(hour), dayOldest: oldest(day), limits, direct: tier === "direct" });
    if (!d.go) return d;
    Object.assign(s, { holder, hold_until: new Date(+now + holdMs), last_nav_at: now });
    this.navs.push({ domain, fixture, at: now, tier });
    return d;
  }
  async recordNavigation(domain, fixture) { this.navs.push({ domain, fixture, at: new Date(), recorded: true }); }
  async releaseDomain(domain, holder) { const s = this.state(domain); if (s.holder === holder) Object.assign(s, { holder: null, hold_until: null, last_nav_at: new Date() }); }
  async coolDown(domain, retryAfterS) {
    const s = this.state(domain), sec = nextCooldown(s.cooldown_s, retryAfterS);
    Object.assign(s, { cooldown_s: sec, cooldown_until: new Date(Date.now() + sec * 1000) });
    this.cooled.push({ domain, sec });
  }
}

export const urlHmac = makeUrlHmac(Buffer.alloc(32, 7));
export const lan = new BlockList();
lan.addSubnet("45.33.20.0", 24, "ipv4");
export function policyFor(fixtures, direct = { perDomainInFlight: 1, minNavigationGapMs: 400, perDomainPerHour: 20, platformPerDay: 200 }) {
  return { ports: [80, 443], localCidrs: lan, cloudDenylist: ["*.firecrawl.dev", "firecrawl.dev"], maxRedirects: 5, maxBodyBytes: 1 << 20, permitLeaseMs: 120000,
    residential: { proxyFirstDomains: [], sessionMinutes: 5, connectTimeoutMs: 3000, bulkPages: 20, holdMaxMinutes: 90 },
    routing: { maxRecords: 5000, observationsToChange: 2, ttlHours: 24, maxTtlDays: 7, probeMinutes: 5 },
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
export const page = (res, body = "<main><h1>Article</h1><p>A plain page with enough text to be an article of its own.</p></main>") =>
  res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(`<!doctype html><title>t</title>${body}`);
export const acquirerFor = (store, policy, browser = { render: async () => ({ ok: false, failure: { class: "BROWSER_UNAVAILABLE", detail: "none" } }) }) =>
  makeAcquirer({ store, getPolicy: () => policy, getLocalReady: () => true, permits: { url: 2, browser: 1 }, resolvePublic: async () => [], lookupFixture: async () => ["127.0.0.1"], browser, urlHmac, log: () => {} });
export const body = (url, id = `l-${Math.random()}`) => ({ requestId: `r-${Math.random()}`, logicalAcquisitionId: id, url, deadline: new Date(Date.now() + 30000).toISOString(), purpose: "page", expect: "html" });
