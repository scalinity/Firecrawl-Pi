// M7's gateway units: the action subset and webhook options held to the manifest, the owner tag, the capture-to-artifact
// step, change detection's normalization, diff and version rules, and the webhook outbox's round. The SQL behind them
// (the outbox row raised in the transition's transaction, cache freshness, owner-bound artifacts) is tested against
// PostgreSQL in tests/contracts/m7-gateway-store.test.mjs.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { deflateSync } from "node:zlib";
import { validateBody, RequestError } from "../src/validate.mjs";
import { ownerTag, originFor } from "../src/auth.mjs";
import { pngSize, parseCapture, storeCaptures } from "../src/artifacts.mjs";
import { normalize, lineDiff, versionKey, makeChanges, DIFF_MAX_LINES } from "../src/changes.mjs";
import { makeOutbox } from "../src/outbox.mjs";

const M = JSON.parse(readFileSync(process.env.FCPI_TEST_MANIFEST ?? new URL("../../../deploy/policies/capabilities.json", import.meta.url), "utf8"));
const refused = (fn, code, re) => assert.throws(fn, (e) => e instanceof RequestError && e.code === code && (!re || re.test(e.message)));
const url = "https://example.com/";

// A real PNG of w x h pixels, one colour.
function png(w, h) {
  const crc = (b) => { let c = ~0; for (const x of b) { c ^= x; for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1)); } return ~c >>> 0; };
  const chunk = (type, data) => { const t = Buffer.from(type), len = Buffer.alloc(4), c = Buffer.alloc(4); len.writeUInt32BE(data.length); c.writeUInt32BE(crc(Buffer.concat([t, data]))); return Buffer.concat([len, t, data, c]); };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  const raw = Buffer.alloc((w * 3 + 1) * h);
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}

test("the action subset: accepted and normalized, everything outside it refused by name before any work", () => {
  const { body } = validateBody("scrape", { url, actions: [{ type: "wait", milliseconds: 500 }, { type: "click", selector: "#more", all: false }, { type: "scroll", direction: "down" }, { type: "screenshot", fullPage: true }, { type: "scrape" }] }, M);
  assert.deepEqual(body.actions, [{ type: "wait", milliseconds: 500 }, { type: "click", selector: "#more" }, { type: "scroll", direction: "down" }, { type: "screenshot", fullPage: true }, { type: "scrape" }]);
  for (const [a, re] of [[{ type: "executeJavascript", script: "1" }, /arbitrary JavaScript/], [{ type: "write", text: "x" }, /typing/], [{ type: "press", key: "Enter" }, /key presses/], [{ type: "pdf" }, /PDF/],
    [{ type: "click", selector: "a", all: true }, /every match/], [{ type: "screenshot", quality: 80 }, /lossless PNG/], [{ type: "screenshot", viewport: { width: 1, height: 1 } }, /1280 x 800/]]) {
    refused(() => validateBody("scrape", { url, actions: [a] }, M), "UNSUPPORTED_OPTION", re);
  }
  refused(() => validateBody("scrape", { url, actions: Array.from({ length: 11 }, () => ({ type: "scroll" })) }, M), "UNSUPPORTED_OPTION", /at most 10/);
  // json with a screenshot or actions: refused by name, since its path stores no captures (review W2); each alone is accepted.
  const J = { type: "json", schema: { type: "object", properties: { a: { type: "string" } } } };
  refused(() => validateBody("scrape", { url, formats: [J, { type: "screenshot", fullPage: true }] }, M), "UNSUPPORTED_OPTION", /not offered with screenshots or actions/);
  refused(() => validateBody("scrape", { url, formats: [J, "screenshot"] }, M), "UNSUPPORTED_OPTION", /not offered with screenshots or actions/);
  refused(() => validateBody("scrape", { url, formats: [J], actions: [{ type: "scroll", direction: "down" }] }, M), "UNSUPPORTED_OPTION", /not offered with screenshots or actions/);
  assert.equal(validateBody("scrape", { url, formats: [J] }, M).body.formats[0].type, "json");
  assert.equal(validateBody("scrape", { url, formats: ["screenshot"], actions: [{ type: "scroll", direction: "down" }] }, M).body.actions.length, 1);
  refused(() => validateBody("scrape", { url, actions: [{ type: "wait", milliseconds: 9000 }, { type: "wait", milliseconds: 7000 }] }, M), "UNSUPPORTED_OPTION", /16000 ms/);
  refused(() => validateBody("scrape", { url, actions: [{ type: "wait", selector: "#a" }, { type: "wait", selector: "#b" }, { type: "wait", selector: "#c" }, { type: "wait", milliseconds: 1 }] }, M), "UNSUPPORTED_OPTION", /selector wait counts 5000/);
  refused(() => validateBody("scrape", { url, actions: [{ type: "wait", milliseconds: 5, selector: "#a" }] }, M), "BAD_REQUEST", /not both/);
  refused(() => validateBody("scrape", { url, actions: [{ type: "click" }] }, M), "BAD_REQUEST", /selector.*required/);
  // The screenshot format: a string or an object with fullPage, on /v2/scrape alone.
  assert.deepEqual(validateBody("scrape", { url, formats: ["markdown", { type: "screenshot", fullPage: true }] }, M).body.formats, ["markdown", { type: "screenshot", fullPage: true }]);
  refused(() => validateBody("scrape", { url, formats: [{ type: "screenshot", quality: 50 }] }, M), "UNSUPPORTED_OPTION", /lossless PNG/);
  refused(() => validateBody("crawl", { url, scrapeOptions: { formats: [{ type: "screenshot" }] } }, M), "UNSUPPORTED_OPTION", /\/v2\/scrape only/);
  refused(() => validateBody("scrape", { url, formats: ["changeTracking"] }, M), "UNSUPPORTED_OPTION", /\/platform\/v1\/changes/);
});

test("the cache options: maxAge within the cache's hour, storeInCache a boolean, both on /v2/scrape only", () => {
  assert.equal(validateBody("scrape", { url, maxAge: 3600000, storeInCache: false }, M).body.maxAge, 3600000);
  refused(() => validateBody("scrape", { url, maxAge: 3600001 }, M), "BAD_REQUEST");
  refused(() => validateBody("batch", { urls: [url], maxAge: 1000 }, M), "UNSUPPORTED_OPTION", /\/v2\/scrape only/);
  refused(() => validateBody("scrape", { url, minAge: 1 }, M), "UNSUPPORTED_OPTION", /maxAge/);
});

test("a job's webhook: url, metadata and the three events; custom headers and page events refused by name", () => {
  const { body } = validateBody("crawl", { url, webhook: { url: "https://hooks.example/x", metadata: { run: 1 }, events: ["completed", "failed", "completed"] } }, M);
  assert.deepEqual(body.webhook, { url: "https://hooks.example/x", metadata: { run: 1 }, events: ["completed", "failed"] });
  refused(() => validateBody("batch", { urls: [url], webhook: { url: "https://hooks.example/x", headers: { a: "b" } } }, M), "UNSUPPORTED_OPTION", /signed/);
  refused(() => validateBody("extract", { urls: [url], schema: { type: "object" }, webhook: { url: "https://hooks.example/x", events: ["page"] } }, M), "UNSUPPORTED_OPTION", /per-page/);
  refused(() => validateBody("crawl", { url, webhook: { url: "https://hooks.example/x", metadata: { x: "y".repeat(5000) } } }, M), "BAD_REQUEST", /4096/);
  refused(() => validateBody("crawl", { url, webhook: "https://hooks.example/x" }, M), "BAD_REQUEST");
});

test("the owner tag: sixteen hex digits, stable per principal, different across principals; the origin carries it", () => {
  assert.match(ownerTag("owner"), /^[0-9a-f]{16}$/);
  assert.equal(ownerTag("owner"), ownerTag("owner"));
  assert.notEqual(ownerTag("owner"), ownerTag("guest"));
  assert.equal(originFor("owner", "fcpi:1"), `fcpi:${ownerTag("owner")}:fcpi:1`);
  assert.match(originFor("owner", "fcpi:1"), /^fcpi:([0-9a-f]{16}):/, "the form patch 0010's fcpiOwnerOf reads");
});

test("captures become owner-bound artifacts with the PNG's own dimensions; a clipped capture says so; anything else is refused", async () => {
  const shot = png(1280, 800), tall = png(1280, 20000);
  assert.deepEqual(pngSize(shot), { width: 1280, height: 800 });
  assert.equal(pngSize(Buffer.from("not a png")), null);
  assert.equal(parseCapture(`data:image/png;truncated=true;base64,${tall.toString("base64")}`).truncated, true);
  const files = new Map(), rows = [];
  const archive = { put: async (b) => { const sha = createHash("sha256").update(b).digest("hex"); files.set(sha, b); return { sha256: sha, bytes: b.length }; }, hasRoom: async () => true };
  const store = { archiveBytes: async () => 0, addArtifacts: async (list) => list.map((a) => { const r = { ...a, expires_at: new Date(Date.now() + 7 * 86400e3) }; rows.push(r); return r; }) };
  const doc = { markdown: "m", screenshot: `data:image/png;base64,${shot.toString("base64")}`, actions: { screenshots: [`data:image/png;truncated=true;base64,${tall.toString("base64")}`], scrapes: [] } };
  const out = await storeCaptures(doc, { principal: "owner", origin: "https://gw.example", archive, store, quotaBytes: 1e9 });
  assert.equal(out.length, 2);
  assert.match(doc.screenshot, /^https:\/\/gw\.example\/platform\/v1\/artifacts\/[0-9a-f-]{36}$/);
  assert.equal(doc.actions.screenshots[0], out[1].url);
  assert.deepEqual([out[0].width, out[0].height, out[0].truncated], [1280, 800, false]);
  assert.deepEqual([out[1].width, out[1].height, out[1].truncated], [1280, 20000, true]);
  assert.ok(rows.every((r) => r.principal === "owner"));
  // A page that understated its height is still marked clipped: the image is at the clip height (review S6).
  const liar = await storeCaptures({ screenshot: `data:image/png;base64,${tall.toString("base64")}` }, { principal: "owner", origin: "https://gw.example", archive, store, quotaBytes: 1e9 });
  assert.equal(liar[0].truncated, true);
  // A capture that fails after a good one leaves no artifact of either (review S5).
  const before = rows.length;
  await assert.rejects(storeCaptures({ screenshot: `data:image/png;base64,${shot.toString("base64")}`, actions: { screenshots: ["data:image/png;base64,QUJD"] } },
    { principal: "owner", origin: "https://gw.example", archive, store, quotaBytes: 1e9 }), (e) => e.code === "CAPTURE_INVALID");
  assert.equal(rows.length, before);
  await assert.rejects(storeCaptures({ screenshot: "data:image/png;base64,QUJD" }, { principal: "o", origin: "x", archive, store, quotaBytes: 1e9 }), (e) => e.code === "CAPTURE_INVALID");
  await assert.rejects(storeCaptures({ screenshot: `data:image/png;base64,${shot.toString("base64")}` }, { principal: "o", origin: "x", archive, store, quotaBytes: 10 }), (e) => e.code === "STORAGE_QUOTA");
});

test("change detection: normalized text, a bounded line diff, and the key of equivalent options only", () => {
  assert.equal(normalize("  a   b \n\n\tc\n"), "a b\nc");
  const d = lineDiff("one\ntwo\nthree", "one\nthree\nfour");
  assert.deepEqual([d.added, d.removed, d.truncated], [1, 1, false]);
  assert.equal(d.text, "  one\n- two\n  three\n+ four");
  const big = lineDiff(Array.from({ length: DIFF_MAX_LINES + 1 }, (_, i) => `l${i}`).join("\n"), "l0");
  assert.deepEqual([big.text, big.removed, big.truncated], [null, DIFF_MAX_LINES, true]);
  assert.equal(versionKey({ url }), versionKey({ url, onlyMainContent: true, waitFor: 0, proxy: "auto" }));
  assert.notEqual(versionKey({ url }), versionKey({ url, onlyMainContent: false }));
});

function changesRig() {
  const files = new Map(), versions = new Map(), sent = [];
  const archive = { put: async (b) => { const sha = createHash("sha256").update(b).digest("hex"); files.set(sha, Buffer.from(b)); return { sha256: sha, bytes: b.length }; }, read: async (sha) => files.get(sha), hasRoom: async () => true };
  const store = { versionGet: async (p, k) => versions.get(`${p}|${k}`) ?? null, versionPut: async (v) => versions.set(`${v.principal}|${v.key}`, { ...v, normalized_sha256: v.normalizedSha256, scraped_at: new Date() }) };
  let answer = null;
  const upstream = { call: async (_m, _p, o) => { sent.push(o.body); return answer; } };
  const changes = makeChanges({ cfg: { coreTimeoutMs: 1000 }, store, upstream, archive, originFor });
  const run = async (principal, body) => { let out; await changes({ client: { principal }, send: (status, b) => { out = { status, b }; } }, body); return out; };
  return { run, sent, versions, set: (a) => { answer = a; } };
}
const page = (markdown, statusCode = 200) => ({ status: 200, json: { success: true, data: { markdown, metadata: { statusCode, url } } } });

test("change detection: new, same, then changed with a diff; an error page and a failed scrape are never versions", async () => {
  const r = changesRig();
  r.set(page("# Notes\n\nversion 1\n"));
  assert.equal((await r.run("owner", { url })).b.changeStatus, "new");
  assert.equal(r.sent[0].origin, originFor("owner", "changes"));
  assert.deepEqual(r.sent[0].formats, ["markdown"]);
  r.set(page("# Notes\n\n  version 1  \n"));
  assert.equal((await r.run("owner", { url })).b.changeStatus, "same", "whitespace alone is no change");
  r.set(page("# Notes\n\nversion 2\nadded line\n", 500));
  const err = await r.run("owner", { url });
  assert.deepEqual([err.status, err.b.code], [422, "NOT_COMPARED"]);
  r.set({ status: 500, json: { success: false, code: "SCRAPE_FCPI_RETRIEVAL", error: "Retrieval failed: BLOCKED_PUBLIC_CONTENT." } });
  assert.equal((await r.run("owner", { url })).status, 422);
  r.set(page("# Notes\n\nversion 2\nadded line\n"));
  const changed = await r.run("owner", { url });
  assert.equal(changed.b.changeStatus, "changed", "compared with version 1: the failures in between replaced nothing");
  assert.match(changed.b.diff.text, /^- version 1$/m);
  assert.match(changed.b.diff.text, /^\+ added line$/m);
  // Another principal's first look at the same page is its own "new".
  assert.equal((await r.run("guest", { url })).b.changeStatus, "new");
  // A page with no text is not compared, a deterministic 422, not a retryable failure; the version stays (review W5).
  for (const md of ["", "  \n\n\t  \n"]) {
    r.set(page(md));
    const empty = await r.run("owner", { url });
    assert.deepEqual([empty.status, empty.b.code], [422, "NOT_COMPARED"]);
    assert.match(empty.b.error, /no text/);
  }
  r.set(page("# Notes\n\nversion 2\nadded line\n"));
  assert.equal((await r.run("owner", { url })).b.changeStatus, "same");
});

test("the outbox round: delivered, retried, dead after its attempts or at once for an unapproved destination, deferred without an attempt", async () => {
  const ev = (id, attempts = 0) => ({ id, type: "crawl.completed", destination: "http://hooks.fixture.fcpi.test:8080/receive", body: "{}", attempts });
  const due = [ev("e1"), ev("e2"), ev("e3", 4), ev("e4"), ev("e5"), ev("e6")];
  const calls = [];
  const store = { claimWebhooks: async () => due.splice(0), webhookDelivered: async (id, s) => calls.push(["delivered", id, s]), webhookDefer: async (id) => calls.push(["defer", id]),
    webhookFailed: async (id, f) => calls.push(["failed", id, f.final, f.maxAttempts]) };
  const answers = { e1: { delivered: true, status: 200 }, e2: { delivered: false, status: 500, class: "WEBHOOK_REFUSED" }, e3: { delivered: false, status: 500, class: "WEBHOOK_REFUSED" },
    e4: { delivered: false, class: "WEBHOOK_DESTINATION_NOT_APPROVED" }, e5: { delivered: false, class: "WEBHOOKS_SUPPRESSED" } };
  const extractor = { webhookDeliver: async ({ eventId }) => { if (eventId === "e6") throw Object.assign(new Error("x"), { code: "ECONNREFUSED" }); return { status: 200, json: answers[eventId] }; } };
  const logs = [];
  await makeOutbox({ store, extractor, limits: M.limits, log: (o) => logs.push(o) }).tick();
  assert.deepEqual(calls, [["delivered", "e1", 200], ["failed", "e2", false, 5], ["failed", "e3", false, 5], ["failed", "e4", true, 5], ["defer", "e5"], ["defer", "e6"]]);
  assert.equal(logs.find((l) => l.id === "e3").action, "dead", "the fifth failed attempt is the last");
  assert.equal(logs.find((l) => l.id === "e2").action, "retry");
});

test("forward: an unreachable core is the gateway's own 503 with Retry-After, never 502 (review W14)", async () => {
  const { createServer, request } = await import("node:http");
  const { makeUpstream } = await import("../src/upstream.mjs");
  const up = makeUpstream({ core: new URL("http://127.0.0.1:1"), coreTimeoutMs: 2000 });
  const logged = [];
  const srv = createServer((req, res) => up.forward(res, "/v2/scrape", { url: "https://a.example/" }, (s) => logged.push(s), { "x-request-id": "r" }));
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  try {
    const got = await new Promise((resolve, reject) => {
      const q = request({ host: "127.0.0.1", port: srv.address().port, method: "POST", path: "/" }, (res) => { let b = ""; res.on("data", (c) => { b += c; }); res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body: JSON.parse(b) })); });
      q.on("error", reject); q.end();
    });
    assert.deepEqual([got.status, got.body.code, got.headers["retry-after"]], [503, "UPSTREAM_UNAVAILABLE", "10"]);
    assert.deepEqual(logged, [503]);
  } finally { await new Promise((r) => srv.close(r)); }
});
