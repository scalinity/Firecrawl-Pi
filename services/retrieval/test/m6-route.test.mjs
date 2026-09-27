// The egress decision and domain learning (src/route.mjs) as pure functions: every start rule, spec §9.5's two
// observations, the probe after expiry, the TTL and its seven-day ceiling, and Decodo's session username.
import { test } from "node:test";
import assert from "node:assert/strict";
import { startTier, startsInBrowser, observe, sessionUsername } from "../src/route.mjs";

const routing = { maxRecords: 5000, observationsToChange: 2, ttlHours: 24, maxTtlDays: 7, probeMinutes: 5 };
const H = 3600e3, NOW = Date.parse("2026-09-27T12:00:00Z");
const pref = (over = {}) => ({ preferred: "residential", set_at: new Date(NOW - H), expires_at: new Date(NOW + H), probe_at: null, challenges: 0, ...over });

test("the start: basic is direct whatever the domain; stealth, a hold, a proxy-first domain and a learned block start residential", () => {
  const s = (o) => startTier({ route: "auto", record: null, held: false, proxyFirst: false, routing, now: NOW, ...o });
  assert.deepEqual(s({}), { tier: "direct", reason: "default" });
  assert.deepEqual(s({ route: "basic", held: true, proxyFirst: true, record: pref() }), { tier: "direct", reason: "local_only" });
  assert.deepEqual(s({ route: "stealth" }), { tier: "residential", reason: "requested" });
  assert.deepEqual(s({ held: true }), { tier: "residential", reason: "bulk_hold" });
  assert.deepEqual(s({ proxyFirst: true }), { tier: "residential", reason: "proxy_first_domain" });
  assert.deepEqual(s({ record: pref() }), { tier: "residential", reason: "learned_block" });
  // A pending challenge alone changes nothing.
  assert.deepEqual(s({ record: { preferred: null, challenges: 1 } }), { tier: "direct", reason: "default" });
});

test("after a preference expires, one probe goes direct and the others stay residential while it runs", () => {
  const expired = pref({ expires_at: new Date(NOW - 1) });
  assert.deepEqual(startTier({ route: "auto", record: expired, routing, now: NOW }), { tier: "direct", reason: "probe_after_expiry", probe: true });
  assert.deepEqual(startTier({ route: "auto", record: { ...expired, probe_at: new Date(NOW - 60e3) }, routing, now: NOW }), { tier: "residential", reason: "probe_in_progress" });
  // A probe that never reported back lapses after probeMinutes, and the next request probes.
  assert.equal(startTier({ route: "auto", record: { ...expired, probe_at: new Date(NOW - 6 * 60e3) }, routing, now: NOW }).probe, true);
});

test("two consistent challenges on the direct route set a 24-hour residential preference; one does not", () => {
  const first = observe(null, { tier: "direct", outcome: "challenge" }, routing, NOW);
  assert.deepEqual(first, { challenges: 1, reason: "challenge_pending" });
  const second = observe({ preferred: null, challenges: 1 }, { tier: "direct", outcome: "challenge" }, routing, NOW);
  assert.equal(second.preferred, "residential");
  assert.equal(+second.expires_at - NOW, 24 * H);
  assert.equal(second.challenges, 0);
  // An adequate direct answer between them resets the count.
  assert.deepEqual(observe({ preferred: null, challenges: 1 }, { tier: "direct", outcome: "adequate" }, routing, NOW), { challenges: 0, reason: "challenge_reset" });
  // Challenges seen on the residential route never teach the direct preference.
  assert.equal(observe(null, { tier: "residential", outcome: "challenge" }, routing, NOW), null);
});

test("the probe confirms a block at once, or clears the preference", () => {
  const expired = pref({ expires_at: new Date(NOW - 1), probe_at: new Date(NOW - 1000) });
  const confirmed = observe(expired, { tier: "direct", outcome: "challenge", probe: true }, routing, NOW);
  assert.equal(confirmed.reason, "probe_confirmed");
  assert.equal(+confirmed.expires_at - NOW, 24 * H);
  assert.equal(confirmed.probe_at, null);
  const cleared = observe(expired, { tier: "direct", outcome: "adequate", probe: true }, routing, NOW);
  assert.equal(cleared.preferred, null);
  assert.equal(cleared.reason, "probe_cleared");
});

test("residential successes extend the preference by one TTL, never past seven days from when it was set", () => {
  const r = pref({ set_at: new Date(NOW - 2 * H), expires_at: new Date(NOW + H) });
  assert.equal(+observe(r, { tier: "residential", outcome: "adequate" }, routing, NOW).expires_at - NOW, 24 * H);
  const old = pref({ set_at: new Date(NOW - (7 * 24 - 1) * H), expires_at: new Date(NOW + 0.5 * H) });
  assert.equal(+observe(old, { tier: "residential", outcome: "adequate" }, routing, NOW).expires_at, +old.set_at + 7 * 24 * H);
  // At the ceiling nothing extends it further.
  assert.equal(observe(pref({ set_at: new Date(NOW - 7 * 24 * H), expires_at: new Date(NOW + 1) }), { tier: "residential", outcome: "adequate" }, routing, NOW), null);
});

test("script shells: two renders make a domain start in the browser; an HTTP answer that needed none resets it", () => {
  const one = observe(null, { tier: "direct", mode: "browser", outcome: "js_rendered" }, routing, NOW);
  assert.deepEqual(one, { js_count: 1, reason: "js_pending" });
  const two = observe({ js_count: 1 }, { tier: "direct", mode: "browser", outcome: "js_rendered" }, routing, NOW);
  assert.equal(two.prefer_browser, true);
  assert.equal(startsInBrowser(two, NOW), true);
  assert.equal(startsInBrowser({ ...two, browser_expires_at: new Date(NOW - 1) }, NOW), false);
  assert.equal(observe({ prefer_browser: true, js_count: 0 }, { tier: "direct", mode: "http", outcome: "adequate" }, routing, NOW).prefer_browser, false);
  // A browser success does not reset what it just confirmed.
  assert.equal(observe({ prefer_browser: true, js_count: 0 }, { tier: "direct", mode: "browser", outcome: "adequate" }, routing, NOW), null);
});

test("the session username is Decodo's documented form, and refuses what would change its meaning", () => {
  assert.equal(sessionUsername("sp12345", "abc123", 5), "user-sp12345-session-abc123-sessionduration-5");
  assert.throws(() => sessionUsername("sp-1", "abc", 5), /letters, digits and underscores/);
  assert.throws(() => sessionUsername("sp1", "a-b", 5), /session id/);
  assert.throws(() => sessionUsername("sp1", "x".repeat(65), 5), /session id/);
});
