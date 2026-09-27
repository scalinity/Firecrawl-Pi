// M7: webhook delivery (src/webhook.mjs) against the fixture receiver (tests/fixtures/m7/fixture.mjs): only approved
// destinations, one fresh signature per attempt over the event's constant body and id, no delivery while suppressed, an
// unapproved or private destination refused unsent, and the receiver's documented check refusing a tampered, stale or
// replayed delivery.
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { makeWebhooks } from "../src/webhook.mjs";
import { policyFor } from "./acquire-helpers.mjs";

const fx7 = await import("../fixtures/m7/fixture.mjs");
const SECRET = "fixture-webhook-signing-secret-0123456789";

async function startReceiver(now) {
  const state = fx7.makeState();
  const s = fx7.makeReceiver(state, { secret: SECRET, ...(now ? { now } : {}) });
  await new Promise((r) => s.listen(0, "127.0.0.1", r));
  return { state, port: s.address().port, close: () => new Promise((r) => { s.closeAllConnections(); s.close(r); }) };
}
function hooks(rx, { delivery = "enabled", secret = SECRET, destinations, resolvePublic = async () => [] } = {}) {
  const policy = policyFor([["hooks.fixture.fcpi.test", rx.port, "fixture"]]);
  policy.webhooks = { destinations: destinations ?? [`http://hooks.fixture.fcpi.test:${rx.port}/receive`], timeoutMs: 3000 };
  return { url: `http://hooks.fixture.fcpi.test:${rx.port}/receive`,
    w: makeWebhooks({ getPolicy: () => policy, resolvePublic, lookupFixture: async () => ["127.0.0.1"], getSecret: () => secret, delivery, log: () => {} }) };
}
const event = (type = "crawl.completed") => JSON.stringify({ success: true, type, id: randomUUID(), data: [], metadata: { run: "unit" } });

test("an approved destination receives a signed delivery the receiver verifies; a retry of the same event is acknowledged once", async () => {
  const rx = await startReceiver();
  try {
    const { w, url } = hooks(rx);
    assert.deepEqual(w.check(url), { allowed: true, reason: null, delivery: "enabled" });
    const eventId = randomUUID(), body = event();
    const d = await w.deliver({ eventId, url, body });
    assert.deepEqual(d, { delivered: true, status: 200 });
    assert.equal(rx.state.hooks.received.at(-1).verdict, "accepted");
    const again = await w.deliver({ eventId, url, body });
    assert.equal(again.delivered, true);
    assert.equal(rx.state.hooks.received.at(-1).verdict, "duplicate");
    assert.equal(rx.state.hooks.accepted.size, 1, "an event delivered twice is acted on once");
  } finally { await rx.close(); }
});

test("a refusing receiver is a failed attempt; suppressed delivery, an unapproved destination and a missing secret send nothing", async () => {
  const rx = await startReceiver();
  try {
    const { w, url } = hooks(rx);
    rx.state.hooks.failNext = 1;
    const eventId = randomUUID(), body = event();
    const d = await w.deliver({ eventId, url, body });
    assert.equal(d.delivered, false);
    assert.equal(d.class, "WEBHOOK_REFUSED");
    assert.equal((await w.deliver({ eventId, url, body })).delivered, true, "the next attempt of the same event is delivered");
    const before = rx.state.hooks.received.length;
    assert.equal((await hooks(rx, { delivery: "suppressed" }).w.deliver({ eventId: randomUUID(), url, body })).class, "WEBHOOKS_SUPPRESSED");
    assert.equal((await w.deliver({ eventId: randomUUID(), url: `${url}/elsewhere`, body })).class, "WEBHOOK_DESTINATION_NOT_APPROVED");
    assert.equal(w.check(`${url}/elsewhere`).reason, "NOT_APPROVED");
    assert.equal(hooks(rx, { destinations: [] }).w.check(url).reason, "NONE_APPROVED");
    assert.equal(hooks(rx, { secret: null }).w.check(url).reason, "NO_SIGNING_SECRET");
    assert.equal(rx.state.hooks.received.length, before, "nothing reached the receiver");
  } finally { await rx.close(); }
});

test("an approved public destination whose name resolves to a private address is refused unsent (SSRF)", async () => {
  const rx = await startReceiver();
  try {
    const url = "https://hooks.example.org/receive";
    const { w } = hooks(rx, { destinations: [url], resolvePublic: async () => ["10.0.0.5"] });
    const d = await w.deliver({ eventId: randomUUID(), url, body: event() });
    assert.equal(d.delivered, false);
    assert.equal(d.class, "SSRF_DENIED");
  } finally { await rx.close(); }
});

test("the receiver's documented check: a tampered body, a stale timestamp and a forged signature are refused", async () => {
  const t = Math.floor(Date.now() / 1000);
  const rx = await startReceiver(() => t);
  try {
    const { w, url } = hooks(rx);
    const eventId = randomUUID(), body = event();
    assert.equal((await w.deliver({ eventId, url, body })).delivered, true);
    const last = rx.state.hooks.last;
    const post = (headers, b) => fetch(url.replace("hooks.fixture.fcpi.test", "127.0.0.1"), { method: "POST", headers, body: b }).then(async (r) => ({ status: r.status, verdict: (await r.json()).verdict }));
    assert.deepEqual(await post(last.headers, last.body.replace("unit", "evil")), { status: 401, verdict: "bad_signature" });
    assert.deepEqual(await post({ ...last.headers, "x-fcpi-timestamp": String(t - 3600) }, last.body), { status: 401, verdict: "stale_timestamp" });
    assert.deepEqual(await post({ ...last.headers, "x-fcpi-signature": `v1=${"0".repeat(64)}` }, last.body), { status: 401, verdict: "bad_signature" });
    // The same delivery replayed within the tolerance verifies and is acknowledged as a duplicate, not acted on again.
    assert.deepEqual(await post(last.headers, last.body), { status: 200, verdict: "duplicate" });
    assert.equal(rx.state.hooks.accepted.size, 1);
  } finally { await rx.close(); }
});
