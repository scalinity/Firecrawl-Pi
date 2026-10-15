import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, request } from "node:http";
import { makeExtractor } from "../src/extractor.mjs";
import { makeJsonScrape } from "../src/jsonscrape.mjs";

const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const listen = async server => {
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${server.address().port}`;
};
const close = server => { server.closeAllConnections(); return new Promise(resolve => server.close(resolve)); };
const BODY = { url: "https://example.com/", formats: [{ type: "json", schema: { type: "object" } }] };
const page = () => ({ status: 200, json: { success: true, data: { markdown: "A supported fact.", metadata: { url: BODY.url } } } });

function gateway(run, finished) {
  return createServer((req, res) => {
    req.resume();
    req.once("end", async () => {
      try {
        await run({ req, res, id: "fixture-request", client: { principal: "fixture", scopes: new Set(["scrape", "extract"]) },
          send: (status, body) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(body)); } }, BODY, BODY.formats[0]);
      } finally { finished.resolve(); }
    });
  });
}
const client = url => { const req = request(url, { method: "POST" }); req.on("error", () => {}); req.end(); return req; };

test("closing the real caller connection during acquisition prevents a later extraction dispatch", { timeout: 5000 }, async t => {
  const entered = deferred(), released = deferred(), finished = deferred(), aborted = deferred();
  let extractionCalls = 0;
  const run = makeJsonScrape({ cfg: { coreTimeoutMs: 1000 }, M: { limits: { extract: { maxDocumentBytes: 1000 } } },
    upstream: { call: async (_method, _path, { signal }) => {
      signal.addEventListener("abort", () => aborted.resolve(), { once: true });
      entered.resolve();
      await released.promise;
      return page(); // Even a core that returns late cannot start the model.
    } }, extractor: { extract: async () => { extractionCalls++; } } });
  const server = gateway(run, finished);
  const url = await listen(server);
  t.after(() => { released.resolve(); return close(server); });
  const req = client(url);
  await entered.promise;
  req.destroy();
  await aborted.promise;
  released.resolve();
  await finished.promise;
  assert.equal(extractionCalls, 0);
});

test("closing the real caller connection destroys the in-flight internal extraction HTTP request", { timeout: 5000 }, async t => {
  const entered = deferred(), disconnected = deferred(), finished = deferred();
  let calls = 0;
  const internal = createServer((req, res) => {
    calls++;
    req.resume();
    res.once("close", () => disconnected.resolve());
    entered.resolve();
  });
  const internalUrl = await listen(internal);
  t.after(() => close(internal));
  const run = makeJsonScrape({ cfg: { coreTimeoutMs: 1000 }, M: { limits: { extract: { maxDocumentBytes: 1000 } } },
    upstream: { call: async () => page() }, extractor: makeExtractor({ url: internalUrl, token: "synthetic-fixture-token" }) });
  const server = gateway(run, finished);
  const url = await listen(server);
  t.after(() => close(server));
  const req = client(url);
  await entered.promise;
  req.destroy();
  await disconnected.promise;
  await finished.promise;
  assert.equal(calls, 1);
});

test("the internal extraction deadline bounds a trickling response and pre-aborted calls never connect", { timeout: 5000 }, async t => {
  let calls = 0;
  const disconnected = deferred();
  const internal = createServer((req, res) => {
    calls++;
    req.resume();
    res.writeHead(200, { "content-type": "application/json" });
    res.write(" ");
    const trickle = setInterval(() => res.write(" "), 5);
    res.once("close", () => { clearInterval(trickle); disconnected.resolve(); });
  });
  const url = await listen(internal);
  t.after(() => close(internal));
  const extractor = makeExtractor({ url, token: "synthetic-fixture-token" });
  const cancelled = new AbortController(); cancelled.abort();
  await assert.rejects(extractor.extract({}, 1000, cancelled.signal), error => error.code === "CANCELLED" && error.delivered === false);
  assert.equal(calls, 0);
  const started = performance.now();
  await assert.rejects(extractor.extract({}, 60), error => error.code === "TIMEOUT");
  await disconnected.promise;
  assert.ok(performance.now() - started < 1500, "response activity cannot extend the elapsed deadline");
  assert.equal(calls, 1);
});
