// A finished job's outcome (src/outcome.mjs): the receipt's state, and its failed pages grouped by the typed class the
// retrieval service gave them, with the instant a retryable class may be retried.
import { test } from "node:test";
import assert from "node:assert/strict";
import { jobOutcome } from "../src/outcome.mjs";

const at = "2026-10-06T09:08:55.530Z";
const refused = (url, cls, detail, retry) => ({ id: url, url, code: "SCRAPE_FCPI_RETRIEVAL", timestamp: at,
  error: `Retrieval failed: ${cls}. ${detail}${retry !== undefined ? ` Retry after ${retry} s.` : ""}` });

test("a partial crawl names its failed pages by class, most frequent first, with sample URLs and when to retry", () => {
  const errors = [
    ...Array.from({ length: 5 }, (_, i) => refused(`https://b.example/${i}`, "DIRECT_LIMIT", "300 direct navigations to this domain in the last hour, the home connection's allowance", 1800 + i)),
    refused("https://b.example/x", "AUTH_REQUIRED", "the target requires authentication"),
    { id: "z", url: "https://b.example/t", code: "SCRAPE_TIMEOUT", error: "Scrape timed out", timestamp: at },
  ];
  const o = jobOutcome({ state: "PARTIAL", errors: { errors, robotsBlocked: ["https://b.example/private"] } });
  assert.equal(o.state, "PARTIAL");
  assert.equal(o.failed, 7);
  assert.equal(o.robotsBlocked, 1);
  assert.deepEqual(o.failures.map((f) => [f.class, f.count]), [["DIRECT_LIMIT", 5], ["AUTH_REQUIRED", 1], ["SCRAPE_TIMEOUT", 1]]);
  const limit = o.failures[0];
  assert.equal(limit.detail, "300 direct navigations to this domain in the last hour, the home connection's allowance");
  assert.deepEqual(limit.urls, ["https://b.example/0", "https://b.example/1", "https://b.example/2"]);
  // The latest of the group's retry times, as an instant: the error's time plus its seconds.
  assert.equal(limit.retryAt, new Date(Date.parse(at) + 1804 * 1000).toISOString());
  assert.equal("retryAt" in o.failures[1], false, "a class with no retry time states none");
  assert.equal(o.failures[2].detail, "Scrape timed out");
});

test("a clean job says so; malformed entries are grouped, never thrown on; details are bounded", () => {
  assert.deepEqual(jobOutcome({ state: "SUCCEEDED", errors: { errors: [], robotsBlocked: [] } }), { state: "SUCCEEDED", failed: 0 });
  assert.deepEqual(jobOutcome({ state: "SUCCEEDED", errors: null }), { state: "SUCCEEDED", failed: 0 });
  const o = jobOutcome({ state: "PARTIAL", errors: { errors: [null, { error: 7 }, refused("https://b.example/", "TARGET_ERROR", "x".repeat(2000))] } });
  assert.equal(o.failed, 3);
  assert.deepEqual(o.failures.map((f) => [f.class, f.count]), [["ERROR", 2], ["TARGET_ERROR", 1]]);
  assert.equal(o.failures[1].detail.length, 300);
});

test("the gateway's notes about the record are reported apart from the failed pages they cannot be counted as (review R14)", () => {
  const errors = [refused("https://b.example/1", "DIRECT_LIMIT", "the allowance", 60),
    { id: "fcpi:job-1:ERRORS_TRUNCATED:1", timestamp: at, url: "", code: "ERRORS_TRUNCATED", error: "120 further per-item errors and 0 further robots-blocked URLs were not archived" },
    { id: "fcpi:job-1:UPSTREAM_ERRORS_LOST:2", timestamp: at, url: "", code: "UPSTREAM_ERRORS_LOST", error: "the core forgot this job before its per-item errors were archived; they are unknown" }];
  const o = jobOutcome({ state: "PARTIAL", errors: { errors, robotsBlocked: [] } });
  assert.equal(o.failed, 1);
  assert.deepEqual(o.failures.map((f) => f.class), ["DIRECT_LIMIT"]);
  assert.deepEqual(o.notes.map((n) => n.code), ["ERRORS_TRUNCATED", "UPSTREAM_ERRORS_LOST"]);
});
