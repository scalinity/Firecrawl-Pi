// The browser client against a loopback stand-in for the worker: a reply larger than the page
// limit allows is refused before it is parsed, declared or not (review finding C3).
import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { ProxySessions } from "../src/proxy.mjs";
import { makeBrowserClient } from "../src/browser.mjs";

const policy = { maxBodyBytes: 1024, browser: { maxSubresources: 10, maxSubresourceBytes: 1 << 20, contextMaxMs: 120000 } };
function worker(reply) {
  return new Promise((resolve) => {
    const s = http.createServer((req, res) => { req.resume(); req.on("end", () => reply(res)); }).listen(0, "127.0.0.1", () => resolve(s));
  });
}
const client = (s) => makeBrowserClient({ url: new URL(`http://127.0.0.1:${s.address().port}`), token: "t".repeat(40), proxyServer: "http://127.0.0.1:1",
  sessions: new ProxySessions(), getPolicy: () => policy });
const args = () => ({ attemptId: `a-${Math.random()}`, url: "http://example.com/", deadline: Date.now() + 10000, waitFor: 0, userAgent: "x" });
const big = JSON.stringify({ ok: true, html: "y".repeat(3 * 1024 * 1024) });

test("an oversized worker reply is SIZE_LIMIT, declared or chunked; a normal one is parsed", async () => {
  for (const reply of [(res) => res.writeHead(200, { "content-type": "application/json", "content-length": Buffer.byteLength(big) }).end(big),
    (res) => { res.writeHead(200, { "content-type": "application/json" }); res.write(big.slice(0, 1 << 20)); res.write(big.slice(1 << 20, 2 << 20)); res.end(big.slice(2 << 20)); }]) {
    const s = await worker(reply);
    try { assert.equal((await client(s).render(args())).failure?.class, "SIZE_LIMIT"); } finally { s.close(); }
  }
  const s = await worker((res) => res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ ok: true, html: "<p>fine</p>", status: 200 })));
  try {
    const r = await client(s).render(args());
    assert.equal(r.ok, true);
    assert.equal(r.html, "<p>fine</p>");
    assert.deepEqual(r.proxy, { requests: 0, bytes: 0, denied: [] });
  } finally { s.close(); }
});
