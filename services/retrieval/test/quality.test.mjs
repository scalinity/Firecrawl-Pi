// Classification of the M2 fixture pages and of the statuses spec §9.2 names, and the pacing
// decisions of spec §10.2, with no network and no database.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { classify } from "../src/quality.mjs";
import { paceDecision, nextCooldown } from "../src/store.mjs";
import { loadPolicy } from "../src/policy.mjs";
import { retryAfterSeconds } from "../src/acquire.mjs";

// tests/fixtures is mounted beside the tests when they run in the service's image (M1's static
// page included).
const site = (f) => readFileSync(new URL(f === "static.html" ? "../fixtures/m1/site/static.html" : `../fixtures/m2/site/${f}`, import.meta.url), "utf8");
const page = { status: 200, contentType: "text/html; charset=utf-8", finalUrl: "http://m2.fixture.fcpi.test:8080/p", requestedUrl: "http://m2.fixture.fcpi.test:8080/p" };

test("static pages are adequate, short ones too; script-rendered ones are JS shells", () => {
  assert.equal(classify({ ...page, body: site("static.html") }).verdict, "adequate");
  assert.equal(classify({ ...page, body: site("short.html") }).verdict, "adequate");
  assert.equal(classify({ ...page, body: site("js.html") }).verdict, "js_shell");
  assert.equal(classify({ ...page, body: site("delayed.html") }).verdict, "js_shell");
  assert.equal(classify({ ...page, body: "" }).verdict, "adequate"); // empty is not a block (spec §9.2)
});

test("interstitials, sign-in gates and refusals are typed failures", () => {
  const challenge = '<html><head><title>Just a moment...</title></head><body><div id="challenge-running"></div><script src="/cdn-cgi/challenge-platform/h/b/orchestrate/chl_page/v1"></script></body></html>';
  assert.equal(classify({ ...page, body: challenge }).failure.class, "BLOCKED_PUBLIC_CONTENT");
  assert.equal(classify({ ...page, status: 403, body: challenge }).failure.class, "BLOCKED_PUBLIC_CONTENT");
  assert.equal(classify({ ...page, status: 403, body: "<p>no</p>" }).failure.class, "ACCESS_DENIED");
  const login = '<form><input name="u"><input type="password" name="p"></form>';
  assert.equal(classify({ ...page, finalUrl: "http://m2.fixture.fcpi.test:8080/login?next=/members", body: login }).failure.class, "AUTH_REQUIRED");
  assert.equal(classify({ ...page, status: 401, body: "" }).failure.class, "AUTH_REQUIRED");
  const rl = classify({ ...page, status: 429, body: "", retryAfter: 7 });
  assert.equal(rl.failure.class, "RATE_LIMITED");
  assert.equal(rl.failure.retryAfter, 7);
});

test("missing pages and target errors keep the native result; binaries are binaries", () => {
  assert.equal(classify({ ...page, status: 404, body: "<p>gone</p>" }).verdict, "not_found");
  assert.equal(classify({ ...page, status: 503, body: "<p>down</p>" }).verdict, "target_error");
  assert.equal(classify({ ...page, contentType: "application/pdf", body: null }).verdict, "binary");
  assert.equal(classify({ ...page, contentType: "application/xml", body: "<urlset/>" }).verdict, "adequate");
});

test("direct pacing: gap, one in flight, the hourly and daily caps, cooldowns", () => {
  const now = new Date("2026-09-26T12:00:00Z");
  const limits = { perDomainInFlight: 1, minNavigationGapMs: 2000, perDomainPerHour: 20, platformPerDay: 200 };
  const s = (o) => ({ holder: null, hold_until: null, last_nav_at: null, cooldown_until: null, ...o });
  assert.deepEqual(paceDecision({ now, state: s({}), hourCount: 0, dayCount: 0, limits }), { go: true });
  assert.equal(paceDecision({ now, state: s({ last_nav_at: new Date(now - 500) }), hourCount: 1, dayCount: 1, limits }).waitMs, 1500);
  assert.ok(paceDecision({ now, state: s({ holder: "h", hold_until: new Date(+now + 10000) }), hourCount: 1, dayCount: 1, limits }).waitMs > 0);
  assert.deepEqual(paceDecision({ now, state: s({ holder: "h", hold_until: new Date(now - 1) }), hourCount: 1, dayCount: 1, limits }), { go: true });
  assert.equal(paceDecision({ now, state: s({}), hourCount: 20, dayCount: 20, limits }).failure.class, "PROXY_REQUIRED");
  assert.equal(paceDecision({ now, state: s({}), hourCount: 3, dayCount: 200, limits }).failure.class, "PROXY_REQUIRED");
  const cool = paceDecision({ now, state: s({ cooldown_until: new Date(+now + 30000) }), hourCount: 0, dayCount: 0, limits });
  assert.equal(cool.failure.class, "RATE_LIMITED");
  assert.equal(cool.failure.retryAfter, 30);
  assert.equal(nextCooldown(null, null), 60);
  assert.equal(nextCooldown(60, null), 120);
  assert.equal(nextCooldown(2400, null), 3600);
  assert.equal(nextCooldown(120, 5), 5);
  assert.equal(retryAfterSeconds("12"), 12);
  assert.ok(retryAfterSeconds(new Date(Date.now() + 30000).toUTCString()) >= 29);
});

test("the deployed policy loads; a looser or unknown one does not", () => {
  const text = readFileSync(new URL("../policy/egress.json", import.meta.url), "utf8");
  const p = loadPolicy(text);
  assert.equal(p.attempts.maxPerPage, 4);
  const mutate = (f) => { const j = JSON.parse(text); f(j); return JSON.stringify(j); };
  assert.throws(() => loadPolicy(mutate((j) => { j.attempts.maxPerPage = 5; })));
  assert.throws(() => loadPolicy(mutate((j) => { j.direct.perDomainPerHour = 40; })));
  assert.throws(() => loadPolicy(mutate((j) => { j.direct.minNavigationGapMs = 500; })));
  assert.throws(() => loadPolicy(mutate((j) => { j.extra = 1; })));
  assert.throws(() => loadPolicy(mutate((j) => { j.cloudDenylist = ["example.com"]; })));
  assert.throws(() => loadPolicy(mutate((j) => { j.fixtures.push({ host: "evil.example.com", port: 80, cidr: "10.231.3.0/24", limits: "fixture" }); })));
  assert.throws(() => loadPolicy(mutate((j) => { j.fixtures[0].cidr = "0.0.0.0/0"; })));
  assert.throws(() => loadPolicy(mutate((j) => { j.search.backend = "https://searx.example.com/search"; })));
});
