// SI1 capacity and availability units (docs/FIRECRAWL_PI_SEARCH_INTELLIGENCE_SPEC.md §14.1, §15): the permit pools' limits,
// fairness across searches, cancellation and deadline; the DeepSeek token bucket; and the contract hold that only a repeated,
// identical wire failure sets, with its one recovery probe.
import { test } from "node:test";
import assert from "node:assert/strict";
import { PermitPool, TokenBucket } from "../src/search-intelligence/permits.mjs";
import { makeAvailability, CONTRACT_HOLD_MS } from "../src/search-intelligence/availability.mjs";

const pending = (p) => Promise.race([p.then(() => "settled", () => "settled"), new Promise((r) => setImmediate(() => r("pending")))]);
const api = (limit) => [{ key: "api", limit }];

test("a permit pool grants up to its limit, queues the rest, and a release is counted once", async () => {
  const pool = new PermitPool();
  const r1 = await pool.acquire(api(2), "s1"), r2 = await pool.acquire(api(2), "s2");
  const third = pool.acquire(api(2), "s3");
  assert.equal(await pending(third), "pending");
  r1();
  r1();
  const r3 = await third;
  assert.deepEqual(pool.snapshot(), { held: { api: 2 }, waiting: 0 }, "the second release of r1 returned nothing");
  r2(); r3();
  assert.deepEqual(pool.snapshot(), { held: {}, waiting: 0 });
});

test("a key whose permits are all returned is dropped: a finished search leaves no entry behind", async () => {
  const pool = new PermitPool();
  for (let i = 0; i < 50; i++) {
    const release = await pool.acquire([{ key: "jev", limit: 4 }, { key: `search:s${i}`, limit: 2 }], `s${i}`);
    release();
  }
  assert.equal(pool.held.size, 0, "no per-search key outlives its search");
  assert.equal(pool.bySearch.size, 0);
});

test("a freed permit goes to the waiting search that holds the fewest, then the oldest", async () => {
  const pool = new PermitPool();
  const a1 = await pool.acquire(api(2), "A");
  await pool.acquire(api(2), "A");
  const a3 = pool.acquire(api(2), "A"), b1 = pool.acquire(api(2), "B");
  a1();
  assert.equal(await pending(b1), "settled", "B holds none, so it goes before A's older waiter");
  assert.equal(await pending(a3), "pending");
});

test("a waiter that is cancelled or outlives its deadline leaves unsent, and capacity is reported as such", async () => {
  const pool = new PermitPool();
  await pool.acquire(api(1), "s1");
  const ac = new AbortController();
  const cancelled = pool.acquire(api(1), "s2", { signal: ac.signal });
  ac.abort();
  await assert.rejects(cancelled, (e) => e.code === "CANCELLED" && e.sent === false);
  await assert.rejects(pool.acquire(api(1), "s3", { deadlineAt: Date.now() + 30 }), (e) => e.code === "PROVIDER_TIMEOUT" && e.capacity === true && e.sent === false);
  assert.equal(pool.snapshot().waiting, 0, "neither left a waiter behind");
  await assert.rejects(pool.acquire(api(1), "s4", { signal: AbortSignal.abort() }), (e) => e.code === "CANCELLED");
});

test("the token bucket spends its burst at once, then paces; a deadline it cannot meet and a cancellation end unsent", async () => {
  const bucket = new TokenBucket(5);
  const t0 = Date.now();
  for (let i = 0; i < 5; i++) await bucket.take();
  assert.ok(Date.now() - t0 < 50, "five tokens are available at once");
  await bucket.take();
  assert.ok(Date.now() - t0 >= 150, "the sixth waits for a refill at 5 per second");
  await assert.rejects(bucket.take({ deadlineAt: Date.now() + 20 }), (e) => e.code === "PROVIDER_TIMEOUT" && e.capacity === true && e.sent === false);
  await assert.rejects(bucket.take({ signal: AbortSignal.abort() }), (e) => e.code === "CANCELLED" && e.sent === false);
});

test("three identical contract failures hold the adapter; the hold ends with one probe, and a success clears it", async () => {
  let now = 1_000_000;
  const rows = new Map();
  const store = { availabilityRows: async () => [...rows.values()], setAvailability: async (r) => { rows.set(r.provider, r); } };
  const moves = [];
  const av = makeAvailability({ store, clock: () => now, onTransition: (t) => moves.push(`${t.from}>${t.to}`) });
  await av.reenable("q");
  for (let i = 0; i < 2; i++) await av.observe("p", "e1", { reason: "contract_failure", providerCode: "shape" });
  assert.equal(av.check("p", "e1").eligible, true, "two failures do not hold");
  assert.deepEqual(moves, [], "a first write that keeps a provider available is no transition");
  // A different wire failure starts the count again; a request-specific refusal never counts.
  await av.observe("p", "e1", { reason: "contract_failure", providerCode: "other_shape" });
  await av.observe("p", "e1", { reason: "unsupported_request" });
  assert.equal(av.check("p", "e1").eligible, true);
  for (let i = 0; i < 3; i++) await av.observe("p", "e1", { reason: "contract_failure", providerCode: "shape" });
  assert.deepEqual([av.check("p", "e1").eligible, av.check("p", "e1").reason], [false, "contract_failure"]);
  now += CONTRACT_HOLD_MS;
  assert.deepEqual(av.check("p", "e1"), { eligible: true, probe: true }, "the hold's end admits a probe");
  await av.observe("p", "e1", { success: true });
  assert.deepEqual(av.check("p", "e1"), { eligible: true, probe: false });
  assert.equal(rows.get("p").state, "available", "the cleared state is persisted");
  assert.deepEqual(moves, ["available>contract_hold", "contract_hold>available"], "only the hold and its end are transitions");
});

test("a read that started before a refusal's write cannot replace it, nor can a write still in flight", async () => {
  const rows = new Map();
  let releaseWrite;
  const writeGate = new Promise((r) => { releaseWrite = r; });
  const store = { availabilityRows: async () => [...rows.values()], setAvailability: async (r) => { await writeGate; rows.set(r.provider, r); } };
  const av = makeAvailability({ store });
  const writing = av.observe("p", "e1", { reason: "quota_exhausted" });
  // The database does not hold the refusal yet: a refresh now must keep the in-memory row.
  await av.refresh();
  assert.deepEqual([av.check("p", "e1").eligible, av.check("p", "e1").reason], [false, "quota_exhausted"]);
  releaseWrite();
  await writing;
  await av.refresh();
  assert.equal(av.check("p", "e1").reason, "quota_exhausted", "after the write lands, the read agrees");
});

test("a success from a call dispatched before a refusal was observed does not clear it; a later one does", async () => {
  let now = 5_000;
  const rows = new Map();
  const store = { availabilityRows: async () => [...rows.values()], setAvailability: async (r) => { rows.set(r.provider, r); } };
  const av = makeAvailability({ store, clock: () => now });
  await av.observe("p", "e1", { reason: "rate_limited", retryAt: 60_000 });
  now = 6_000;
  await av.observe("p", "e1", { success: true, dispatchedAt: 4_000 });
  assert.equal(av.check("p", "e1").reason, "rate_limited", "dispatched before the refusal: proves nothing about it");
  await av.observe("p", "e1", { success: true, dispatchedAt: new Date(5_500).toISOString() });
  assert.deepEqual(av.check("p", "e1"), { eligible: true, probe: false });
});
