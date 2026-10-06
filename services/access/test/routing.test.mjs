// Bulk routing at the gateway (src/routing.mjs, M6): which jobs are bulk, the route their pages ask for, the refusal
// of a local-only bulk job, and the URLs whose domains a job holds.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { routeBody, isBulk, holdUrls, pagesOf, routeRefusal } from "../src/routing.mjs";
import { checkManifest } from "../src/config.mjs";
import { RequestError, validateBody } from "../src/validate.mjs";

const M = JSON.parse(readFileSync(process.env.FCPI_TEST_MANIFEST ?? new URL("../../../deploy/policies/capabilities.json", import.meta.url), "utf8"));

test("the manifest's bulk threshold is spec §10.2's 300, one domain's hourly direct allowance, and a hold outlasts a job", () => {
  checkManifest(M);
  assert.equal(M.limits.proxy.bulkPages, 300);
  assert.throws(() => checkManifest({ ...M, limits: { ...M.limits, proxy: { bulkPages: 20, holdMinutes: 60 } } }), /bulkPages/);
  assert.throws(() => checkManifest({ ...M, limits: { ...M.limits, proxy: { bulkPages: 300, holdMinutes: 40 } } }), /holdMinutes/);
  // A manifest that would admit a bulk job stops startup (review R21).
  const crawl = { ...M.bodies.crawl, fields: { ...M.bodies.crawl.fields, limit: { ...M.bodies.crawl.fields.limit, max: 301 } } };
  assert.throws(() => checkManifest({ ...M, bodies: { ...M.bodies, crawl } }), /no admitted job is bulk/);
});

test("every job the manifest admits starts on the home connection; only a job past 300 pages would be bulk and ask for the residential route", () => {
  // The largest crawl and batch the manifest admits are within one domain's hourly direct allowance.
  assert.ok(M.bodies.crawl.fields.limit.max <= M.limits.proxy.bulkPages && M.limits.batch.hardMaxUrls <= M.limits.proxy.bulkPages);
  const largest = { url: "https://example.org/", limit: M.bodies.crawl.fields.limit.max };
  assert.deepEqual(routeBody("crawl", largest, M), { body: largest, bulk: false, needsRoute: false });
  const batch = { urls: Array.from({ length: M.limits.batch.hardMaxUrls }, (_, i) => `https://example.org/${i}`) };
  assert.deepEqual(routeBody("batch", batch, M), { body: batch, bulk: false, needsRoute: false });
  // The rule itself, past the allowance: the pages ask for the residential route, and options the caller gave are kept.
  const crawl = { url: "https://example.org/", limit: 301 };
  assert.equal(pagesOf("crawl", crawl), 301);
  assert.equal(isBulk("crawl", crawl, M), true);
  assert.deepEqual(routeBody("crawl", crawl, M), { body: { ...crawl, scrapeOptions: { proxy: "stealth" } }, bulk: true, needsRoute: true });
  assert.deepEqual(routeBody("crawl", { ...crawl, scrapeOptions: { formats: ["markdown"] } }, M).body.scrapeOptions, { formats: ["markdown"], proxy: "stealth" });
  assert.equal(routeBody("batch", { urls: Array.from({ length: 301 }, (_, i) => `https://example.org/${i}`) }, M).body.proxy, "stealth");
  assert.equal(isBulk("crawl", { url: "https://example.org/", limit: 300 }, M), false);
  assert.equal(isBulk("scrape", { url: "https://example.org/" }, M), false);
});

test("a crawl with no limit takes the manifest's default of 20 pages, and is not bulk: it runs without the residential route", () => {
  const { body, units } = validateBody("crawl", { url: "https://example.org/" }, M);
  assert.equal(body.limit, 20);
  assert.equal(units, 20);
  assert.deepEqual(routeBody("crawl", body, M), { body, bulk: false, needsRoute: false });
});

test("a local-only (basic) bulk job is refused outright", () => {
  assert.throws(() => routeBody("crawl", { url: "https://example.org/", limit: 301, scrapeOptions: { proxy: "basic" } }, M), (e) => e instanceof RequestError && e.code === "PROXY_REQUIRED" && e.status === 400);
  assert.throws(() => routeBody("batch", { urls: Array.from({ length: 301 }, (_, i) => `https://e.org/${i}`), proxy: "basic" }, M), /direct egress only/);
  // M7 review W15: a bulk job asking for the enhanced provider is refused by name, never rewritten to stealth.
  assert.throws(() => routeBody("crawl", { url: "https://example.org/", limit: 301, scrapeOptions: { proxy: "enhanced" } }, M), (e) => e instanceof RequestError && e.code === "UNSUPPORTED_OPTION" && e.extra.option === "scrapeOptions.proxy");
  assert.throws(() => routeBody("batch", { urls: Array.from({ length: 301 }, (_, i) => `https://e.org/${i}`), proxy: "enhanced" }, M), (e) => e.code === "UNSUPPORTED_OPTION" && e.extra.option === "proxy");
  // Within the allowance a local-only job is admitted as it is: it runs on the home connection, as it asked.
  const basic = { url: "https://example.org/", limit: 200, scrapeOptions: { proxy: "basic" } };
  assert.deepEqual(routeBody("crawl", basic, M), { body: basic, bulk: false, needsRoute: false });
  // A small enhanced job holds its domains on the residential route, so its auxiliary downloads never leave direct.
  const small = { url: "https://example.org/", limit: 5, scrapeOptions: { proxy: "enhanced" } };
  assert.deepEqual(routeBody("crawl", small, M), { body: small, bulk: false, needsRoute: true });
  assert.equal(routeBody("batch", { urls: ["https://e.org/1"], proxy: "enhanced" }, M).needsRoute, true);
});

test("a crawl holds its start URL's domain, a batch every URL's; an unavailable route is a 429 naming why", () => {
  assert.deepEqual(holdUrls("crawl", { url: "https://a.example/x", limit: 30 }), ["https://a.example/x"]);
  assert.deepEqual(holdUrls("batch", { urls: ["https://a.example/1", "https://b.example/2"] }), ["https://a.example/1", "https://b.example/2"]);
  const r = routeRefusal({ available: false, reason: "BLOCKED_CREDENTIAL" });
  assert.equal(r.status, 429);
  assert.equal(r.body.code, "PROXY_REQUIRED");
  assert.equal(r.body.route.residential, "BLOCKED_CREDENTIAL");
  assert.equal(routeRefusal(null).body.route.residential, "ROUTE_SERVICE_UNREACHABLE");
});

test("a job of any size whose pages ask for the residential route needs it, and holds its domains; auto and basic small jobs do not (review W7)", () => {
  const small = { url: "https://example.org/", limit: 5 };
  assert.equal(routeBody("crawl", { ...small, scrapeOptions: { proxy: "stealth" } }, M).needsRoute, true);
  assert.equal(routeBody("batch", { urls: ["https://a.example/"], proxy: "stealth" }, M).needsRoute, true);
  assert.equal(routeBody("crawl", small, M).needsRoute, false);
  assert.equal(routeBody("crawl", { ...small, scrapeOptions: { proxy: "basic" } }, M).needsRoute, false);
  assert.equal(routeBody("crawl", { url: "https://example.org/", limit: 200 }, M).needsRoute, false);
  assert.equal(routeBody("crawl", { url: "https://example.org/", limit: 301 }, M).needsRoute, true);
});
