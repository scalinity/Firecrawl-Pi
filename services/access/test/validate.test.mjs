// Unit tests for the manifest-driven request validation (services/access/src/validate.mjs).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { validateBody, requestHash, checkUrl, RequestError } from "../src/validate.mjs";
import { checkManifest } from "../src/config.mjs";

const M = JSON.parse(readFileSync(process.env.FCPI_TEST_MANIFEST ?? new URL("../../../deploy/policies/capabilities.json", import.meta.url), "utf8"));
const refused = (fn, code, re) => assert.throws(fn, (e) => e instanceof RequestError && e.code === code && e.status === 400 && (!re || re.test(e.message)));

test("the manifest in the repository passes the startup check", () => checkManifest(M));

test("a scrape keeps accepted options, drops origin, and adds nothing", () => {
  const { body } = validateBody("scrape", { url: " http://m3.fixture.fcpi.test:8080/p01 ", formats: ["markdown", { type: "html" }, "markdown"], onlyMainContent: false, waitFor: 1000, origin: "js-sdk@4.31.1" }, M);
  assert.deepEqual(body, { url: "http://m3.fixture.fcpi.test:8080/p01", formats: ["markdown", "html"], onlyMainContent: false, waitFor: 1000 });
});

test("refused options name themselves and why, before anything else", () => {
  refused(() => validateBody("scrape", { url: "https://example.com", actions: [] }, M), "UNSUPPORTED_OPTION", /actions.*M7/);
  refused(() => validateBody("scrape", { url: "https://example.com", formats: ["screenshot"] }, M), "UNSUPPORTED_OPTION", /screenshot/);
  refused(() => validateBody("scrape", { url: "https://example.com", formats: [{ type: "json", prompt: "x" }] }, M), "UNSUPPORTED_OPTION", /M5/);
  refused(() => validateBody("batch", { urls: ["https://example.com"], appendToId: "0190f1a0-0000-7000-8000-000000000000" }, M), "UNSUPPORTED_OPTION", /one team/);
  refused(() => validateBody("crawl", { url: "https://example.com", webhook: "https://hook.example" }, M), "UNSUPPORTED_OPTION", /outbox/);
  refused(() => validateBody("crawl", { url: "https://example.com", scrapeOptions: { headers: { cookie: "x" } } }, M), "UNSUPPORTED_OPTION", /headers/);
  refused(() => validateBody("scrape", { url: "https://example.com", __agentInterop: {} }, M), "UNSUPPORTED_OPTION", /internal/);
  refused(() => validateBody("scrape", { url: "https://example.com", mobile: true }, M), "UNSUPPORTED_OPTION");
  refused(() => validateBody("scrape", { url: "https://example.com", skipTlsVerification: true }, M), "UNSUPPORTED_OPTION");
  refused(() => validateBody("crawl", { url: "https://example.com", ignoreRobotsTxt: true }, M), "UNSUPPORTED_OPTION", /robots/);
  refused(() => validateBody("scrape", { url: "https://example.com", proxy: "stealth" }, M), "UNSUPPORTED_OPTION", /M6/);
  refused(() => validateBody("crawl", { url: "https://example.com", scrapeOptions: { proxy: "enhanced" } }, M), "UNSUPPORTED_OPTION", /M7/);
  refused(() => validateBody("scrape", { url: "https://example.com", proxy: "turbo" }, M), "BAD_REQUEST");
});

test("unknown keys, bad types and out-of-range values are 400 BAD_REQUEST", () => {
  refused(() => validateBody("scrape", { url: "https://example.com", bogus: 1 }, M), "BAD_REQUEST", /Unrecognized key/);
  refused(() => validateBody("scrape", { url: "https://example.com", waitFor: 15001 }, M), "BAD_REQUEST");
  refused(() => validateBody("scrape", { url: "https://example.com", timeout: 90001 }, M), "BAD_REQUEST");
  refused(() => validateBody("crawl", { url: "https://example.com", limit: 201 }, M), "BAD_REQUEST");
  refused(() => validateBody("crawl", { url: "https://example.com", maxDiscoveryDepth: 4 }, M), "BAD_REQUEST");
  refused(() => validateBody("crawl", { url: "https://example.com", includePaths: ["(unclosed"] }, M), "BAD_REQUEST", /regular expression/);
  refused(() => validateBody("map", { url: "https://example.com", limit: 1001 }, M), "BAD_REQUEST");
  refused(() => validateBody("scrape", { formats: ["markdown"] }, M), "BAD_REQUEST", /url.*required/);
  refused(() => validateBody("scrape", [], M), "BAD_REQUEST");
  refused(() => validateBody("crawl", { url: "https://example.com", delay: 0 }, M), "BAD_REQUEST");
});

test("keys and values named after inherited object members are unknown, not manifest entries", () => {
  for (const k of ["constructor", "toString", "hasOwnProperty", "valueOf"]) {
    refused(() => validateBody("scrape", { url: "https://example.com", [k]: 1 }, M), "BAD_REQUEST", /Unrecognized key/);
    refused(() => validateBody("crawl", { url: "https://example.com", scrapeOptions: { [k]: 1 } }, M), "BAD_REQUEST", /Unrecognized key/);
    refused(() => validateBody("scrape", { url: "https://example.com", formats: [k] }, M), "BAD_REQUEST", /unknown format/);
    refused(() => validateBody("scrape", { url: "https://example.com", proxy: k }, M), "BAD_REQUEST", /must be one of/);
  }
});

test("crawl and map get the platform's defaults; a crawl's units are its limit", () => {
  const c = validateBody("crawl", { url: "https://example.com" }, M);
  assert.equal(c.body.limit, 50);
  assert.equal(c.body.maxDiscoveryDepth, 3);
  assert.equal(c.units, 50);
  assert.equal(validateBody("map", { url: "https://example.com" }, M).body.limit, 1000);
});

test("a batch drops invalid URLs by default, refuses them on request, and caps its size", () => {
  const b = validateBody("batch", { urls: ["https://a.example", "ftp://x", "https://a.example", "not a url"] }, M);
  assert.deepEqual(b.body.urls, ["https://a.example"]);
  assert.deepEqual(b.invalidURLs, ["ftp://x", "not a url"]);
  assert.equal(b.units, 1);
  assert.equal("ignoreInvalidURLs" in b.body, false);
  refused(() => validateBody("batch", { urls: ["https://a.example", "ftp://x"], ignoreInvalidURLs: false }, M), "BAD_REQUEST");
  refused(() => validateBody("batch", { urls: Array.from({ length: M.limits.batch.maxUrls + 1 }, (_, i) => `https://e${i}.example`) }, M), "BAD_REQUEST", /at most/);
  refused(() => validateBody("batch", { urls: ["ftp://x"] }, M), "BAD_REQUEST", /No valid URLs/);
});

test("URLs: http(s) with a top-level domain and no credentials", () => {
  assert.equal(checkUrl("https://example.com/a?b=c"), null);
  assert.equal(checkUrl("http://m3.fixture.fcpi.test:8080/"), null);
  assert.match(checkUrl("http://user:pw@example.com/"), /credentials/);
  assert.match(checkUrl("file:///etc/passwd"), /http/);
  assert.match(checkUrl("http://localhost/"), /top-level domain/);
  assert.match(checkUrl("x".repeat(3000)), /2048/);
});

test("the request hash ignores key order but not values", () => {
  const a = validateBody("crawl", { url: "https://example.com", limit: 5, sitemap: "skip" }, M).body;
  const b = validateBody("crawl", { sitemap: "skip", limit: 5, url: "https://example.com" }, M).body;
  const c = validateBody("crawl", { url: "https://example.com", limit: 6, sitemap: "skip" }, M).body;
  assert.equal(requestHash("crawl", a), requestHash("crawl", b));
  assert.notEqual(requestHash("crawl", a), requestHash("crawl", c));
  assert.notEqual(requestHash("crawl", a), requestHash("batch", a));
});
