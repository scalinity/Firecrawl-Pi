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
  // M7: actions and screenshots are offered on /v2/scrape only.
  refused(() => validateBody("batch", { urls: ["https://example.com"], actions: [] }, M), "UNSUPPORTED_OPTION", /\/v2\/scrape only/);
  refused(() => validateBody("batch", { urls: ["https://example.com"], formats: ["screenshot"] }, M), "UNSUPPORTED_OPTION", /screenshot/);
  refused(() => validateBody("scrape", { url: "https://example.com", formats: [{ type: "summary" }] }, M), "UNSUPPORTED_OPTION", /native model path/);
  refused(() => validateBody("batch", { urls: ["https://example.com"], appendToId: "0190f1a0-0000-7000-8000-000000000000" }, M), "UNSUPPORTED_OPTION", /one team/);
  refused(() => validateBody("scrape", { url: "https://example.com", webhook: { url: "https://hook.example" } }, M), "UNSUPPORTED_OPTION", /crawl, batch and extract/);
  refused(() => validateBody("crawl", { url: "https://example.com", scrapeOptions: { headers: { cookie: "x" } } }, M), "UNSUPPORTED_OPTION", /headers/);
  refused(() => validateBody("scrape", { url: "https://example.com", __agentInterop: {} }, M), "UNSUPPORTED_OPTION", /internal/);
  refused(() => validateBody("scrape", { url: "https://example.com", mobile: true }, M), "UNSUPPORTED_OPTION");
  refused(() => validateBody("scrape", { url: "https://example.com", skipTlsVerification: true }, M), "UNSUPPORTED_OPTION");
  refused(() => validateBody("crawl", { url: "https://example.com", ignoreRobotsTxt: true }, M), "UNSUPPORTED_OPTION", /robots/);
  // M6: the residential route is offered; M7: the enhanced provider too.
  assert.equal(validateBody("scrape", { url: "https://example.com", proxy: "stealth" }, M).body.proxy, "stealth");
  assert.equal(validateBody("scrape", { url: "https://example.com", proxy: "enhanced" }, M).body.proxy, "enhanced");
  assert.equal(validateBody("crawl", { url: "https://example.com", scrapeOptions: { proxy: "enhanced" } }, M).body.scrapeOptions.proxy, "enhanced");
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
  assert.equal(c.body.limit, 20);
  assert.equal(c.body.maxDiscoveryDepth, 3);
  assert.equal(c.units, 20);
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

// ---- M5: search, the json format and extraction ------------------------------------------------------
test("search: bounded query and limit, and every option the pinned client would ignore refused by name", () => {
  const { body } = validateBody("search", { query: "fcpi widgets" }, M);
  assert.deepEqual(body, { query: "fcpi widgets", limit: 5 });
  refused(() => validateBody("search", { query: "x", limit: 11 }, M), "BAD_REQUEST");
  refused(() => validateBody("search", { query: "x".repeat(501) }, M), "BAD_REQUEST");
  refused(() => validateBody("search", {}, M), "BAD_REQUEST", /query.*required/);
  for (const [k, v, why] of [["tbs", "qdr:d", /time filters/], ["country", "de", /country/], ["categories", ["github"], /categories/], ["sources", [{ type: "news" }], /web results/], ["highlights", true, /Cloud index/], ["location", "Berlin", /geography stays unset/]]) {
    refused(() => validateBody("search", { query: "x", [k]: v }, M), "UNSUPPORTED_OPTION", why);
  }
});

test("the json format: a schema is required, it is an object within 16 KiB, and it is offered on scrape alone", () => {
  const { body } = validateBody("scrape", { url: "https://example.com", formats: ["markdown", { type: "json", schema: { type: "object", properties: { a: { type: "string" } } }, prompt: "p" }] }, M);
  assert.deepEqual(body.formats, ["markdown", { type: "json", schema: { type: "object", properties: { a: { type: "string" } } }, prompt: "p" }]);
  refused(() => validateBody("scrape", { url: "https://example.com", formats: [{ type: "json", prompt: "x" }] }, M), "BAD_REQUEST", /schema.*required/);
  refused(() => validateBody("scrape", { url: "https://example.com", formats: [{ type: "json", schema: [] }] }, M), "BAD_REQUEST", /JSON Schema object/);
  refused(() => validateBody("scrape", { url: "https://example.com", formats: [{ type: "json", schema: { type: "object", description: "x".repeat(17000) } }] }, M), "BAD_REQUEST", /16384/);
  refused(() => validateBody("scrape", { url: "https://example.com", formats: [{ type: "json", schema: {}, extra: 1 }] }, M), "BAD_REQUEST", /Unrecognized key/);
  const J = { type: "json", schema: { type: "object", properties: { a: { type: "string" } } } };
  refused(() => validateBody("batch", { urls: ["https://example.com"], formats: [J] }, M), "UNSUPPORTED_OPTION", /\/v2\/extract/);
  refused(() => validateBody("crawl", { url: "https://example.com", scrapeOptions: { formats: [J] } }, M), "UNSUPPORTED_OPTION", /\/v2\/extract/);
  refused(() => validateBody("search", { query: "x", scrapeOptions: { formats: [J] } }, M), "UNSUPPORTED_OPTION", /\/v2\/extract/);
});

test("extraction: explicit URLs only, at most ten, a schema required; discovery refused by name", () => {
  const S = { type: "object", properties: { a: { type: "string" } } };
  const { body, units, invalidURLs } = validateBody("extract", { urls: ["https://a.example/1", "https://a.example/1", "not a url"], schema: S, ignoreInvalidURLs: true, showSources: true }, M);
  assert.deepEqual(body, { urls: ["https://a.example/1"], schema: S });
  assert.equal(units, 1);
  assert.deepEqual(invalidURLs, ["not a url"]);
  refused(() => validateBody("extract", { urls: Array.from({ length: 11 }, (_, i) => `https://a.example/${i}`), schema: S }, M), "BAD_REQUEST", /at most 10/);
  refused(() => validateBody("extract", { urls: ["https://a.example/*"], schema: S }, M), "UNSUPPORTED_OPTION", /discovery/);
  refused(() => validateBody("extract", { urls: ["https://a.example/"], prompt: "find prices" }, M), "BAD_REQUEST", /schema.*required/);
  for (const [k, v, why] of [["enableWebSearch", true, /discovery/], ["allowExternalLinks", true, /following links/], ["agent", { model: "x" }, /agent/], ["limit", 5, /URLs given/]]) {
    refused(() => validateBody("extract", { urls: ["https://a.example/"], schema: S, [k]: v }, M), "UNSUPPORTED_OPTION", why);
  }
  refused(() => validateBody("extract", { urls: ["https://a.example/"], schema: S, prompt: "x".repeat(4001) }, M), "BAD_REQUEST");
});

test("json model selection preserves defaults and accepts only the complete Sol/xhigh pair", () => {
  const json = { type: "json", schema: { type: "object", properties: { answer: { type: "string" } } }, prompt: "Read the page" };
  const scrape = { url: "https://example.com", formats: ["markdown", json] };
  const ordinary = validateBody("scrape", scrape, M).body;
  assert.deepEqual(ordinary.formats[1], json);
  assert.equal(Object.hasOwn(ordinary.formats[1], "model"), false);
  assert.equal(Object.hasOwn(ordinary.formats[1], "reasoningEffort"), false);
  const selected = { ...json, model: "gpt-6.1-sol", reasoningEffort: "xhigh" };
  const accepted = validateBody("scrape", { ...scrape, formats: ["markdown", selected] }, M).body;
  assert.deepEqual(accepted.formats[1], selected);
  assert.notEqual(requestHash("scrape", accepted), requestHash("scrape", ordinary), "selected model work cannot reuse a default-model cache identity");
  assert.deepEqual(scrape.formats[1], json, "validation does not add model options to the original request");
});

test("json rejects half-specified or unsupported model choices before a normalized acquisition body exists", () => {
  const format = { type: "json", schema: { type: "object" } };
  const body = options => ({ url: "https://example.com", formats: [{ ...format, ...options }] });
  for (const options of [{ model: "gpt-6.1-sol" }, { reasoningEffort: "xhigh" }]) {
    refused(() => validateBody("scrape", body(options), M), "BAD_REQUEST", /must be supplied together/);
  }
  for (const options of [
    { model: "unknown-model", reasoningEffort: "xhigh" },
    { model: "gpt-6-luna", reasoningEffort: "xhigh" },
    { model: "gpt-6.1-sol", reasoningEffort: "low" },
    { model: "gpt-6.1-sol", reasoningEffort: null },
    { model: null, reasoningEffort: "xhigh" },
  ]) refused(() => validateBody("scrape", body(options), M), "UNSUPPORTED_OPTION", /may only be/);
});
