// Classification of the M2 fixture pages and of the statuses spec §9.2 names, and the pacing
// decisions of spec §10.2, with no network and no database.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { classify } from "../src/quality.mjs";
import { paceDecision, nextCooldown } from "../src/store.mjs";
import { loadPolicy } from "../src/policy.mjs";
import { retryAfterSeconds, sniffContentType } from "../src/acquire.mjs";

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
  // A capped domain is refused at once, not after waiting out its gap.
  assert.equal(paceDecision({ now, state: s({ last_nav_at: new Date(now - 500) }), hourCount: 20, dayCount: 20, limits }).failure.class, "PROXY_REQUIRED");
  const cool = paceDecision({ now, state: s({ cooldown_until: new Date(+now + 30000) }), hourCount: 0, dayCount: 0, limits });
  assert.equal(cool.failure.class, "RATE_LIMITED");
  assert.equal(cool.failure.retryAfter, 30);
  assert.equal(nextCooldown(null, null), 60);
  assert.equal(nextCooldown(60, null, 10), 120);
  assert.equal(nextCooldown(2400, null, -5), 3600);
  assert.equal(nextCooldown(120, 5), 5);
  // review finding W14: a Retry-After of 1 s does not make the next bare cooldown 2 s, and an old
  // hour-long cooldown is not kept once an hour has passed without a 429.
  assert.equal(nextCooldown(1, null, 10), 60);
  assert.equal(nextCooldown(3600, null, 7200), 60);
  assert.equal(nextCooldown(3600, null, null), 60);
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

test("classification stays linear on unclosed and repeated markup (review finding C1)", () => {
  const login = { ...page, finalUrl: "http://m2.fixture.fcpi.test:8080/login", requestedUrl: "http://m2.fixture.fcpi.test:8080/p" };
  for (const [name, p] of [["comments", { ...page, body: "<!--".repeat(1 << 18) }], ["tags", { ...page, body: "<a".repeat(1 << 19) }],
    ["noscript", { ...page, body: "<noscript>".repeat(1 << 17) }], ["style", { ...page, body: "<style>".repeat(200000) }],
    ["mounts", { ...page, body: '<div id="root"><noscript>'.repeat(60000) }], ["inputs", { ...login, body: "<input ".repeat(200000) }],
    ["classes", { ...page, body: '<p class="x'.repeat(100000) }]]) {
    const t = Date.now();
    classify(p);
    assert.ok(Date.now() - t < 1500, `${name} took ${Date.now() - t} ms`);
  }
});

test("the linear reader keeps what the regexes kept", async () => {
  const { visibleText } = await import("../src/quality.mjs");
  assert.equal(visibleText("<p>a</p><style>x{}</style><p>b</p><!-- c --><script>d()</script>e"), "a b e");
  assert.equal(visibleText("<style>never closed <p>still read</p>"), "never closed still read"); // as the regexes left it
  assert.equal(visibleText("<p>3 < 5 and 6 > 2</p>"), "3 < 5 and 6 > 2");
  assert.equal(visibleText('<svg viewBox="0 0 1 1"/><p>after the icon</p>'), "after the icon");
  assert.equal(visibleText("<!DOCTYPE html><head><title>T</title></head><body>body text</body>"), "body text");
});

test("only structure makes a shell that fails after rendering; a short scripted page does not (review finding C5)", () => {
  const status = '<head><title>Status</title><script src="/analytics.js"></script></head><body><p>All systems operational.</p></body>';
  const gallery = '<script src="/g.js"></script><h1>Gallery</h1><img src="1.jpg"><img src="2.jpg"><img src="3.jpg">';
  for (const body of [status, gallery]) {
    const v = classify({ ...page, body });
    assert.equal(v.verdict, "js_shell");  // may earn the one browser attempt
    assert.equal(v.structural, false);    // but never fails the rendered page
  }
  assert.equal(classify({ ...page, body: site("js.html") }).structural, true);
  assert.equal(classify({ ...page, body: site("js-slow.html") }).structural, true);
  assert.equal(classify({ ...page, body: '<script src="/a.js"></script><div class="spinner loading"></div><p>Loading</p>' }).structural, true);
});

test("the PDF magic settles the type at the start of a body, or within the first KiB of one declared a PDF or opaque (review W5)", () => {
  const b = (s) => Buffer.from(s, "latin1");
  assert.equal(sniffContentType(b("%PDF-1.7\n..."), "text/html"), "application/pdf");
  assert.equal(sniffContentType(b("\xEF\xBB\xBF \n%PDF-1.4"), "text/html; charset=utf-8"), "application/pdf");
  assert.equal(sniffContentType(b("junk before the header\n%PDF-1.4"), "application/octet-stream"), "application/pdf");
  // An HTML page that mentions the string near its top stays HTML, however it is declared.
  assert.equal(sniffContentType(b("<html><title>What does %PDF-1.7 mean?</title>"), "text/html; charset=utf-8"), "text/html; charset=utf-8");
  assert.equal(sniffContentType(b("<!doctype html><p>%PDF-1.7</p>"), "application/pdf"), "text/html");
  assert.equal(sniffContentType(b("<p>plain</p>"), "application/pdf"), "application/pdf");
});
