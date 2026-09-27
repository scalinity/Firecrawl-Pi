// The job runner's route holds (src/jobs.mjs, M6): what each answer to a hold does to a job that needs the residential
// route, and that a job going back to the queue gives its hold up (review W5, S16, W12). A fake ledger, core and route
// client stand in for PostgreSQL, the Firecrawl core and the retrieval service.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { makeJobs } from "../src/jobs.mjs";

const M = JSON.parse(readFileSync(process.env.FCPI_TEST_MANIFEST ?? new URL("../../../deploy/policies/capabilities.json", import.meta.url), "utf8"));
const UP = "0f8e6c1a-2b3d-4e5f-8a9b-0c1d2e3f4a5b";

// One job to claim; `uncertain` is what the reconciliation round finds.
function harness({ hold, core, request = { url: "https://a.example/", limit: 5, scrapeOptions: { proxy: "stealth" } }, uncertain = [], routes = true }) {
  const calls = { store: [], upstream: 0, holds: 0, releases: [] };
  let claimed = false;
  const job = { id: "job-1", kind: "crawl", request, submission_key: "fcpi:job-1", dispatch_attempts: 1 };
  const rec = (name) => async (...args) => { calls.store.push([name, ...args]); };
  const store = {
    orphanSubmitting: async () => 0,
    uncertain: async () => { const u = uncertain; uncertain = []; return u; },
    markerGroups: async () => [],
    claimNext: async () => (claimed ? null : ((claimed = true), job)),
    markRequeued: rec("requeued"), markRejected: rec("rejected"), markSubmitted: rec("submitted"), markUncertain: rec("uncertain"),
  };
  const upstream = { call: async () => { calls.upstream++; return core(); } };
  const client = routes ? {
    hold: async () => { calls.holds++; return hold(); },
    release: async (id) => { calls.releases.push(id); return { status: 200, json: { released: true } }; },
  } : null;
  const jobs = makeJobs({ cfg: { manifest: M, submitTimeoutMs: 1000, submitSettleMs: 1000, pollMs: 60000 }, store, upstream, archive: {}, log: () => {}, routes: client });
  return { jobs, calls };
}
const held = () => ({ status: 200, json: { held: true, until: "2026-09-26T12:00:00Z", domains: ["a.example"] } });
const accepted = () => ({ status: 200, json: { success: true, id: UP } });
const names = (calls) => calls.store.map((c) => c[0]);
const flush = () => new Promise((r) => setImmediate(r));

test("only the retrieval service's refusal (409, held: false) fails a job as PROXY_REQUIRED, unsent", async () => {
  const { jobs, calls } = harness({ hold: () => ({ status: 409, json: { held: false, residential: { available: false, reason: "BLOCKED_CREDENTIAL" } } }), core: accepted });
  await jobs.kick();
  assert.deepEqual(names(calls), ["rejected"]);
  assert.deepEqual(calls.store[0].slice(2, 4), [429, "PROXY_REQUIRED"]);
  assert.match(calls.store[0][4], /BLOCKED_CREDENTIAL/);
  assert.equal(calls.upstream, 0);
});

test("a 5xx hold answer (a restart, a database fault) puts the job back in the queue, unsent", async () => {
  for (const status of [500, 503]) {
    const { jobs, calls } = harness({ hold: () => ({ status, json: { success: false, code: "RETRIEVAL_NOT_READY" } }), core: accepted });
    await jobs.kick();
    assert.deepEqual(names(calls), ["requeued"], `HTTP ${status}`);
    assert.equal(calls.upstream, 0);
  }
});

test("an unreachable retrieval service puts the job back in the queue, unsent", async () => {
  const { jobs, calls } = harness({ hold: () => { throw Object.assign(new Error("refused"), { code: "ECONNREFUSED" }); }, core: accepted });
  await jobs.kick();
  assert.deepEqual(names(calls), ["requeued"]);
  assert.equal(calls.upstream, 0);
});

test("any other hold answer is the gateway's own error (ROUTE_HOLD_INVALID), not an unavailable route", async () => {
  for (const hold of [() => ({ status: 400, json: { success: false } }), () => ({ status: 409, json: {} }), () => ({ status: 200, json: { held: false } })]) {
    const { jobs, calls } = harness({ hold, core: accepted });
    await jobs.kick();
    assert.deepEqual(names(calls), ["rejected"]);
    assert.deepEqual(calls.store[0].slice(2, 4), [502, "ROUTE_HOLD_INVALID"]);
    assert.equal(calls.upstream, 0);
  }
});

test("with no route client configured, a job that needs the route fails as PROXY_REQUIRED, unsent", async () => {
  const { jobs, calls } = harness({ hold: held, core: accepted, routes: false });
  await jobs.kick();
  assert.deepEqual(calls.store[0].slice(0, 4), ["rejected", "job-1", 429, "PROXY_REQUIRED"]);
  assert.match(calls.store[0][4], /ROUTE_SERVICE_UNCONFIGURED/);
  assert.equal(calls.upstream, 0);
});

test("a held job the core accepts keeps its hold for its run", async () => {
  const { jobs, calls } = harness({ hold: held, core: accepted });
  await jobs.kick();
  await flush();
  assert.deepEqual(names(calls), ["submitted"]);
  assert.equal(calls.holds, 1);
  assert.deepEqual(calls.releases, []);
});

test("a held job that goes back to the queue gives its hold up, so a job waiting there, or cancelled before submission, holds nothing (S16)", async () => {
  // Not delivered: the core was never reached.
  let h = harness({ hold: held, core: () => { throw Object.assign(new Error("refused"), { code: "ECONNREFUSED", delivered: false }); } });
  await h.jobs.kick();
  await flush();
  assert.deepEqual(names(h.calls), ["requeued"]);
  assert.deepEqual(h.calls.releases, ["job-1"]);
  // The core answered 408 or 429 before creating the job.
  for (const status of [408, 429]) {
    h = harness({ hold: held, core: () => ({ status, json: {} }) });
    await h.jobs.kick();
    await flush();
    assert.deepEqual(names(h.calls), ["requeued"], `HTTP ${status}`);
    assert.deepEqual(h.calls.releases, ["job-1"]);
  }
  // Uncertain, and no upstream job carries its key once the settle window has passed.
  const job = { id: "job-2", kind: "crawl", request: { url: "https://a.example/", limit: 30 }, submission_key: "fcpi:job-2", settled: true };
  h = harness({ hold: held, core: accepted, uncertain: [job] });
  await h.jobs.kick();
  await flush();
  assert.equal(h.calls.store[0][0], "requeued");
  assert.equal(h.calls.store[0][1], "job-2");
  assert.deepEqual(h.calls.releases.slice(0, 1), ["job-2"]);
});

test("a job that does not need the route is never held", async () => {
  const { jobs, calls } = harness({ hold: held, core: accepted, request: { url: "https://a.example/", limit: 5 } });
  await jobs.kick();
  assert.equal(calls.holds, 0);
  assert.deepEqual(names(calls), ["submitted"]);
});
