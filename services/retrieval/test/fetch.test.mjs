// Resolution, pinning (DNS rebinding) and the guarded HTTP client, against local servers. The
// policy object is built here with a loopback fixture subnet, which the deployed policy loader
// never accepts (it requires a 10.231.x.0/24 fixture network); it lets the real client run end to
// end with no network beyond loopback.
import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { gzipSync } from "node:zlib";
import { BlockList } from "node:net";
import { resolveTarget, pinnedLookup } from "../src/resolve.mjs";
import { guardedFetch, CookieJar, callerHeaders } from "../src/httpfetch.mjs";
import { parseTarget, Denied } from "../src/ssrf.mjs";

const lan = new BlockList();
lan.addSubnet("45.33.20.0", 24, "ipv4");
const basePolicy = { ports: [80, 443], localCidrs: lan, cloudDenylist: ["*.firecrawl.dev", "firecrawl.dev"], maxRedirects: 3 };

function serve(handler) {
  return new Promise((resolve) => {
    const seen = [];
    const s = http.createServer((req, res) => { seen.push({ host: req.headers.host, path: req.url, cookie: req.headers.cookie ?? null, auth: req.headers.authorization ?? null }); handler(req, res); });
    s.listen(0, "127.0.0.1", () => resolve({ s, port: s.address().port, seen }));
  });
}
const fixturePolicy = (port) => ({ ...basePolicy, fixtures: [{ host: "fx.fixture.fcpi.test", port, cidr: "127.0.0.0/24", limits: "fixture" }] });
const lookupFixture = async () => ["127.0.0.1"];
const soon = () => Date.now() + 5000;

test("a public name with any private answer is refused, and a DNS failure is typed", async () => {
  const policy = { ...basePolicy, fixtures: [] };
  const t = parseTarget("https://example.com/", policy);
  await assert.rejects(resolveTarget(t, { resolvePublic: async () => ["10.0.0.5"], policy }), (e) => e.failureClass === "SSRF_DENIED");
  await assert.rejects(resolveTarget(t, { resolvePublic: async () => ["93.184.215.14", "127.0.0.1"], policy }), (e) => e.failureClass === "SSRF_DENIED");
  await assert.rejects(resolveTarget(t, { resolvePublic: async () => ["45.33.20.9"], policy }), (e) => e.failureClass === "SSRF_DENIED");
  await assert.rejects(resolveTarget(t, { resolvePublic: async () => { throw Object.assign(new Error("x"), { code: "ENOTFOUND" }); }, policy }), (e) => e.failureClass === "DNS_FAILURE");
  assert.equal(await resolveTarget(t, { resolvePublic: async () => ["93.184.215.14"], policy }), "93.184.215.14");
});

test("DNS rebinding: each connection uses the one address it checked, and a changed answer is checked again", async () => {
  const policy = { ...basePolicy, fixtures: [] };
  const t = parseTarget("https://rebind.example.com/", policy);
  const answers = [["93.184.215.14"], ["127.0.0.1"]];
  const resolvePublic = async () => answers.shift();
  assert.equal(await resolveTarget(t, { resolvePublic, policy }), "93.184.215.14");
  await assert.rejects(resolveTarget(t, { resolvePublic, policy }), (e) => e.failureClass === "SSRF_DENIED");
  // The pinned lookup answers only with the checked address, whatever the name, in both of the
  // callback forms Node's connect uses.
  const lk = pinnedLookup("93.184.215.14");
  lk("rebind.example.com", { all: true }, (err, list) => assert.deepEqual(list, [{ address: "93.184.215.14", family: 4 }]));
  lk("rebind.example.com", {}, (err, addr, fam) => { assert.equal(addr, "93.184.215.14"); assert.equal(fam, 4); });
  const { s, port, seen } = await serve((req, res) => res.end("pinned"));
  try {
    const body = await new Promise((resolve, reject) => http.get({ host: "never-resolved.example", port, path: "/", lookup: pinnedLookup("127.0.0.1"), agent: false },
      (res) => { let b = ""; res.on("data", (c) => (b += c)); res.on("end", () => resolve(b)); }).on("error", reject));
    assert.equal(body, "pinned");
    assert.equal(seen[0].host, `never-resolved.example:${port}`);
  } finally { s.close(); }
});

test("a fixture name must resolve inside its own subnet", async () => {
  const policy = fixturePolicy(8080);
  const t = parseTarget("http://fx.fixture.fcpi.test:8080/", policy);
  await assert.rejects(resolveTarget(t, { policy, lookupFixture: async () => ["10.0.0.9"] }), (e) => e.failureClass === "SSRF_DENIED");
  assert.equal(await resolveTarget(t, { policy, lookupFixture }), "127.0.0.1");
});

test("a redirect is validated at every hop: into private space it is refused before any connection", async () => {
  const { s, port, seen } = await serve((req, res) => {
    if (req.url === "/to-private") return res.writeHead(302, { location: "http://10.231.1.5:6379/" }).end();
    if (req.url === "/to-metadata") return res.writeHead(301, { location: "http://169.254.169.254/latest/meta-data/" }).end();
    if (req.url === "/to-cloud") return res.writeHead(302, { location: "https://api.firecrawl.dev/v1/scrape" }).end();
    if (req.url === "/to-name") return res.writeHead(307, { location: "http://redis:6379/" }).end();
    if (req.url.startsWith("/loop")) return res.writeHead(302, { location: "/loop" }).end();
    res.end("ok");
  });
  try {
    const base = `http://fx.fixture.fcpi.test:${port}`;
    const go = (p) => guardedFetch({ url: base + p, maxBytes: 1 << 20, deadline: soon(), policy: fixturePolicy(port), lookupFixture });
    await assert.rejects(go("/to-private"), (e) => e.failureClass === "SSRF_DENIED");
    await assert.rejects(go("/to-metadata"), (e) => e.failureClass === "SSRF_DENIED");
    await assert.rejects(go("/to-cloud"), (e) => e.failureClass === "CLOUD_DENIED");
    await assert.rejects(go("/to-name"), (e) => e.failureClass === "SSRF_DENIED");
    await assert.rejects(go("/loop"), (e) => e.failureClass === "TOO_MANY_REDIRECTS");
    const ok = await go("/fine");
    assert.equal(ok.body.toString(), "ok");
  } finally { s.close(); }
});

test("bodies are bounded before and after decoding", async () => {
  const { s, port } = await serve((req, res) => {
    if (req.url === "/big") return res.end(Buffer.alloc(2 << 20, 0x61));
    if (req.url === "/declared") { res.writeHead(200, { "content-length": String(8 << 20) }); return res.end(); }
    if (req.url === "/bomb") { res.writeHead(200, { "content-encoding": "gzip" }); return res.end(gzipSync(Buffer.alloc(16 << 20, 0x20))); }
    res.end("small");
  });
  try {
    const go = (p) => guardedFetch({ url: `http://fx.fixture.fcpi.test:${port}${p}`, maxBytes: 1 << 20, deadline: soon(), policy: fixturePolicy(port), lookupFixture });
    await assert.rejects(go("/big"), (e) => e.failureClass === "SIZE_LIMIT");
    await assert.rejects(go("/declared"), (e) => e.failureClass === "SIZE_LIMIT");
    await assert.rejects(go("/bomb"), (e) => e.failureClass === "SIZE_LIMIT");
    assert.equal((await go("/ok")).body.toString(), "small");
  } finally { s.close(); }
});

test("a slow target ends at the deadline", async () => {
  const { s, port } = await serve(() => { /* never answers */ });
  try {
    const t0 = Date.now();
    await assert.rejects(guardedFetch({ url: `http://fx.fixture.fcpi.test:${port}/`, maxBytes: 1024, deadline: Date.now() + 600, policy: fixturePolicy(port), lookupFixture }),
      (e) => e.failureClass === "TIMEOUT");
    assert.ok(Date.now() - t0 < 3000);
  } finally { s.closeAllConnections(); s.close(); }
});

test("a cookie set on a redirect comes back on the next hop to the same host", async () => {
  const { s, port, seen } = await serve((req, res) => {
    if (/fcpi_gate=1/.test(req.headers.cookie ?? "")) return res.end("past the gate");
    res.writeHead(302, { location: "/", "set-cookie": "fcpi_gate=1; Path=/" }).end();
  });
  try {
    const r = await guardedFetch({ url: `http://fx.fixture.fcpi.test:${port}/`, maxBytes: 1024, deadline: soon(), policy: fixturePolicy(port), lookupFixture, jar: new CookieJar() });
    assert.equal(r.body.toString(), "past the gate");
    assert.equal(r.redirects.length, 2);
    assert.equal(seen[1].cookie, "fcpi_gate=1");
  } finally { s.close(); }
});

test("caller credentials go only to the first origin", async () => {
  const other = await serve((req, res) => res.end("other"));
  const first = await serve((req, res) => res.writeHead(302, { location: `http://fy.fixture.fcpi.test:${other.port}/` }).end());
  const policy = { ...basePolicy, fixtures: [
    { host: "fx.fixture.fcpi.test", port: first.port, cidr: "127.0.0.0/24", limits: "fixture" },
    { host: "fy.fixture.fcpi.test", port: other.port, cidr: "127.0.0.0/24", limits: "fixture" }] };
  try {
    await guardedFetch({ url: `http://fx.fixture.fcpi.test:${first.port}/`, headers: { authorization: "Bearer caller-secret-value", Cookie: "session=abc", "X-Forwarded-For": "1.2.3.4" },
      maxBytes: 1024, deadline: soon(), policy, lookupFixture });
    assert.equal(first.seen[0].auth, "Bearer caller-secret-value");
    assert.equal(other.seen[0].auth, null);
    assert.equal(other.seen[0].cookie, null);
  } finally { first.s.close(); other.s.close(); }
  assert.deepEqual(Object.keys(callerHeaders({ Host: "evil", "Proxy-Authorization": "x", "X-Forwarded-For": "1.2.3.4", Accept: "text/html" })), ["accept"]);
  assert.throws(() => callerHeaders({ cookie: "x".repeat(20000) }), Denied);
});

test("a connection reset mid-body is TARGET_UNREACHABLE, and a broken gzip body UNSUPPORTED_CONTENT (review finding W10)", async () => {
  const { s, port } = await serve((req, res) => {
    if (req.url === "/gz") { res.writeHead(200, { "content-type": "text/html", "content-encoding": "gzip" }); res.end(Buffer.from("not gzip at all")); return; }
    res.writeHead(200, { "content-type": "text/html", "content-length": "1000" });
    res.write("<p>only the start");
    setTimeout(() => res.socket.destroy(), 50);
  });
  try {
    const go = (p) => guardedFetch({ url: `http://fx.fixture.fcpi.test:${port}${p}`, maxBytes: 1 << 20, deadline: soon(), policy: fixturePolicy(port), lookupFixture });
    await assert.rejects(go("/reset"), (e) => e.failureClass === "TARGET_UNREACHABLE");
    await assert.rejects(go("/gz"), (e) => e.failureClass === "UNSUPPORTED_CONTENT");
  } finally { s.close(); }
});
