// Bulk routing at the gateway (src/routing.mjs, M6): which jobs are bulk, the route their pages ask for, the refusal
// of a local-only bulk job, and the URLs whose domains a job holds.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { routeBody, isBulk, holdUrls, pagesOf, routeRefusal } from "../src/routing.mjs";
import { checkManifest } from "../src/config.mjs";
import { RequestError, validateBody } from "../src/validate.mjs";

const M = JSON.parse(readFileSync(process.env.FCPI_TEST_MANIFEST ?? new URL("../../../deploy/policies/capabilities.json", import.meta.url), "utf8"));

test("the manifest's bulk threshold is spec §10.2's 20, and a hold outlasts a job", () => {
  checkManifest(M);
  assert.throws(() => checkManifest({ ...M, limits: { ...M.limits, proxy: { bulkPages: 50, holdMinutes: 60 } } }), /bulkPages/);
  assert.throws(() => checkManifest({ ...M, limits: { ...M.limits, proxy: { bulkPages: 20, holdMinutes: 40 } } }), /holdMinutes/);
});

test("a crawl past 20 pages, or a batch past 20 URLs, is bulk and asks for the residential route; 20 or fewer are not touched", () => {
  const crawl = { url: "https://example.org/", limit: 50 };
  assert.equal(pagesOf("crawl", crawl), 50);
  assert.equal(isBulk("crawl", crawl, M), true);
  assert.deepEqual(routeBody("crawl", crawl, M), { body: { ...crawl, scrapeOptions: { proxy: "stealth" } }, bulk: true, needsRoute: true });
  // Scrape options the caller gave are kept beside the route.
  assert.deepEqual(routeBody("crawl", { ...crawl, scrapeOptions: { formats: ["markdown"] } }, M).body.scrapeOptions, { formats: ["markdown"], proxy: "stealth" });
  const small = { url: "https://example.org/", limit: 20 };
  assert.deepEqual(routeBody("crawl", small, M), { body: small, bulk: false, needsRoute: false });
  const batch = { urls: Array.from({ length: 21 }, (_, i) => `https://example.org/${i}`) };
  assert.equal(routeBody("batch", batch, M).body.proxy, "stealth");
  assert.equal(routeBody("batch", { urls: batch.urls.slice(0, 20) }, M).bulk, false);
  assert.equal(isBulk("scrape", { url: "https://example.org/" }, M), false);
});

test("a crawl with no limit takes the manifest's default of 20 pages, and is not bulk: it runs without the residential route", () => {
  const { body, units } = validateBody("crawl", { url: "https://example.org/" }, M);
  assert.equal(body.limit, 20);
  assert.equal(units, 20);
  assert.deepEqual(routeBody("crawl", body, M), { body, bulk: false, needsRoute: false });
});

test("a local-only (basic) bulk job is refused outright", () => {
  assert.throws(() => routeBody("crawl", { url: "https://example.org/", limit: 21, scrapeOptions: { proxy: "basic" } }, M), (e) => e instanceof RequestError && e.code === "PROXY_REQUIRED" && e.status === 400);
  assert.throws(() => routeBody("batch", { urls: Array.from({ length: 21 }, (_, i) => `https://e.org/${i}`), proxy: "basic" }, M), /direct egress only/);
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
  assert.equal(routeBody("crawl", { url: "https://example.org/", limit: 21 }, M).needsRoute, true);
});
