// M8: the host's admission file (src/admission.mjs) and the browser tier's pause (spec §23.1). A paused browser ends the
// browser attempt as a busy browser does, before any render; direct HTTP is unaffected; a stale, future, absent or
// unreadable file counts as open.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseAdmission, makeAdmission, STALE_MS } from "../src/admission.mjs";
import { makeAcquirer } from "../src/acquire.mjs";
import { FakeStore, policyFor, serve, body, page, urlHmac } from "./acquire-helpers.mjs";

const at = (ms) => new Date(ms).toISOString();
const SHELL = '<main id="root"><noscript>Please enable JavaScript to read this page.</noscript></main><script src="/app.js"></script>';
const RENDERED = "<main><h1>Rendered</h1><p>Enough article text here to be an adequate page of its own, once rendered by script.</p></main>";

test("a fresh file is read as written; its reasons are kept only when well formed", () => {
  const now = Date.now();
  const a = parseAdmission(JSON.stringify({ utc: at(now - 5000), dispatch: "paused", browser: "paused", reasons: ["memory", "hold:backup", "<script>", 7] }), now);
  assert.deepEqual([a.dispatch, a.browser, a.state, a.reasons], ["paused", "paused", "fresh", ["memory", "hold:backup"]]);
  const b = parseAdmission(JSON.stringify({ utc: at(now), dispatch: "open", browser: "paused", reasons: ["thermal"] }), now);
  assert.deepEqual([b.dispatch, b.browser], ["open", "paused"]);
  // Any value but "paused" is open.
  assert.equal(parseAdmission(JSON.stringify({ utc: at(now), dispatch: "PAUSED", browser: true }), now).dispatch, "open");
});

test("a stale, future-dated or unreadable file is open, so a stopped tick cannot stop the platform", () => {
  const now = Date.now(), paused = (utc) => JSON.stringify({ utc, dispatch: "paused", browser: "paused", reasons: ["memory"] });
  assert.deepEqual(parseAdmission(paused(at(now - STALE_MS - 1000)), now), { dispatch: "open", browser: "open", reasons: [], state: "stale" });
  assert.equal(parseAdmission(paused(at(now + 120000)), now).state, "stale");
  assert.equal(parseAdmission(paused("not a time"), now).state, "stale");
  assert.equal(parseAdmission("{not json", now).state, "unreadable");
  // The positive control: the same file within the window pauses.
  assert.equal(parseAdmission(paused(at(now - STALE_MS + 5000)), now).dispatch, "paused");
});

test("the reader caches for its window, and an absent file is open", async () => {
  const dir = mkdtempSync(join(tmpdir(), "adm-")), f = join(dir, "admission.json");
  try {
    let t = Date.now();
    const adm = makeAdmission(f, { cacheMs: 2000, now: () => t });
    assert.equal((await adm.read()).state, "unreadable");
    writeFileSync(f, JSON.stringify({ utc: at(t), dispatch: "paused", browser: "open", reasons: ["disk"] }));
    assert.equal((await adm.read()).state, "unreadable", "still the cached read");
    t += 2001;
    assert.deepEqual([(await adm.read()).dispatch, (await adm.read()).reasons], ["paused", ["disk"]]);
    assert.equal((await makeAdmission(null).read()).state, "unset");
  } finally { rmSync(dir, { recursive: true }); }
});

test("a paused browser ends the page as RESOURCE_BUSY before any render or browser attempt; open, the same page renders", async () => {
  const t = await serve((req, res) => res.writeHead(200, { "content-type": "text/html" }).end(SHELL));
  try {
    const policy = policyFor([["t.fixture.fcpi.test", t.port, "fixture"]]);
    let renders = 0;
    const browser = { render: async (a) => { renders++; return { ok: true, html: RENDERED, status: 200, finalUrl: a.url, subresources: { requests: 1, overLimit: 0 }, proxy: { requests: 1, bytes: 10, capped: false, denied: [] } }; } };
    const make = (state) => makeAcquirer({ store, getPolicy: () => policy, getLocalReady: () => true, permits: { url: 2, browser: 1 }, resolvePublic: async () => [],
      lookupFixture: async () => ["127.0.0.1"], browser, urlHmac, log: () => {}, admission: { read: async () => state } });
    const store = new FakeStore();
    const held = await make({ dispatch: "open", browser: "paused", reasons: ["thermal"], state: "fresh" })(body(`http://t.fixture.fcpi.test:${t.port}/`));
    assert.equal(renders, 0);
    assert.equal(held.ok, false);
    assert.equal(held.failure.class, "RESOURCE_BUSY");
    assert.match(held.failure.detail, /host paused browser work \(thermal\)/);
    assert.equal(store.attempts.filter((a) => a.strategy === "direct_browser").length, 0, "no browser attempt reserved: a pause spends none of the page's attempts");
    assert.equal(store.attempts.filter((a) => a.strategy === "direct_http").length, 1, "the control: the HTTP attempt that found the shell is recorded");
    assert.equal(store.permits.size, 0, "no browser permit taken");
    const open = await make({ dispatch: "open", browser: "open", reasons: [], state: "fresh" })(body(`http://t.fixture.fcpi.test:${t.port}/`));
    assert.deepEqual([open.ok, open.strategies, renders], [true, ["direct_http", "direct_browser"], 1]);
  } finally { t.s.close(); }
});

test("a paused browser leaves direct HTTP alone", async () => {
  const t = await serve((req, res) => page(res));
  try {
    const store = new FakeStore(), policy = policyFor([["t.fixture.fcpi.test", t.port, "fixture"]]);
    const r = await makeAcquirer({ store, getPolicy: () => policy, getLocalReady: () => true, permits: { url: 2, browser: 1 }, resolvePublic: async () => [],
      lookupFixture: async () => ["127.0.0.1"], browser: { render: async () => assert.fail("no render") }, urlHmac, log: () => {},
      admission: { read: async () => ({ dispatch: "paused", browser: "paused", reasons: ["memory"], state: "fresh" }) } })(body(`http://t.fixture.fcpi.test:${t.port}/`));
    assert.deepEqual([r.ok, r.strategies], [true, ["direct_http"]]);
  } finally { t.s.close(); }
});
