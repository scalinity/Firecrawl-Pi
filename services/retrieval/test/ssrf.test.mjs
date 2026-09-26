// The SSRF matrix at the unit level (FIRECRAWL_PI_SPEC.md §20.2): address classes, host forms,
// ports, schemes, credentials, local names and the Cloud denylist. Runs with no network.
import { test } from "node:test";
import assert from "node:assert/strict";
import { BlockList } from "node:net";
import { classifyAddress, embeddedIpv4, parseTarget, Denied } from "../src/ssrf.mjs";

// A LAN on a globally routable prefix, as this host's is; a synthetic one stands in here.
const lan = new BlockList();
lan.addSubnet("45.33.20.0", 24, "ipv4");
const policy = {
  ports: [80, 443], localCidrs: lan,
  cloudDenylist: ["firecrawl.dev", "*.firecrawl.dev"],
  fixtures: [{ host: "m2.fixture.fcpi.test", port: 8080, cidr: "10.231.3.0/24", limits: "fixture" }],
};
const denied = (url, cls) => assert.throws(() => parseTarget(url, policy), (e) => e instanceof Denied && e.failureClass === cls, url);

test("IPv4 special-purpose ranges are never public", () => {
  for (const a of ["127.0.0.1", "127.255.255.254", "10.0.0.1", "10.231.1.5", "172.16.0.1", "172.31.255.255", "192.168.1.1", "169.254.169.254",
    "100.64.0.1", "100.127.255.254", "0.0.0.0", "0.1.2.3", "255.255.255.255", "224.0.0.1", "239.255.255.250", "240.0.0.1", "198.18.0.1",
    "192.0.2.1", "198.51.100.7", "203.0.113.9", "192.0.0.8", "192.88.99.1"]) {
    assert.notEqual(classifyAddress(a, lan), "public", a);
  }
  for (const a of ["8.8.8.8", "1.1.1.1", "93.184.215.14", "172.32.0.1", "100.128.0.1", "11.0.0.1"]) assert.equal(classifyAddress(a, lan), "public", a);
});

test("the host's own LAN is refused even on a globally routable prefix", () => {
  assert.equal(classifyAddress("45.33.20.7", lan), "host-local-network");
  assert.equal(classifyAddress("45.33.21.7", lan), "public");
});

test("IPv6 non-global, and every IPv6 form that carries an IPv4 address, are refused", () => {
  const cases = {
    "::1": "loopback", "::": "unspecified", "fe80::1": "link-local", "fc00::1": "unique-local", "fd7a:115c:a1e0::1": "unique-local",
    "ff02::1": "multicast", "2001:db8::1": "documentation", "fec0::1": "site-local", "100::1": "discard",
    "::ffff:127.0.0.1": "ipv6-embedded-loopback", "::ffff:10.0.0.1": "ipv6-embedded-private", "::ffff:8.8.8.8": "ipv6-embedded-ipv4",
    "64:ff9b::a00:1": "ipv6-embedded-private", "2002:a00:1::1": "ipv6-embedded-private", "::7f00:1": "ipv6-embedded-loopback",
  };
  for (const [a, why] of Object.entries(cases)) assert.equal(classifyAddress(a, lan), why, a);
  // Teredo carries the client address inverted: 2001:0:…:f5ff:fffe is 10.0.0.1.
  assert.equal(embeddedIpv4("2001:0:4136:e378:8000:63bf:f5ff:fffe"), "10.0.0.1");
  assert.equal(classifyAddress("2001:0:4136:e378:8000:63bf:f5ff:fffe", lan), "ipv6-embedded-private");
  assert.equal(classifyAddress("2606:4700:4700::1111", lan), "public");
  assert.equal(classifyAddress("4000::1", lan), "not-global-unicast");
});

test("schemes, credentials, ports and ambiguous numeric hosts", () => {
  denied("ftp://example.com/", "SSRF_DENIED");
  denied("file:///etc/passwd", "SSRF_DENIED");
  denied("http://user:pw@example.com/", "SSRF_DENIED");
  denied("http://example.com:8080/", "SSRF_DENIED");
  denied("https://example.com:80/", "SSRF_DENIED");
  denied("http://0x7f000001/", "SSRF_DENIED");
  denied("http://2130706433/", "SSRF_DENIED");
  denied("http://0177.0.0.1/", "SSRF_DENIED");
  denied("http://127.1/", "SSRF_DENIED");
  denied("http://0x08080808/", "SSRF_DENIED"); // a public address, written ambiguously
  denied("not a url", "INVALID_URL");
});

test("literal addresses are judged by class", () => {
  denied("http://127.0.0.1/", "SSRF_DENIED");
  denied("http://[::1]/", "SSRF_DENIED");
  denied("http://[::ffff:127.0.0.1]/", "SSRF_DENIED");
  denied("http://169.254.169.254/latest/meta-data/", "SSRF_DENIED");
  denied("http://10.231.1.5/", "SSRF_DENIED");
  denied("http://45.33.20.9/", "SSRF_DENIED");
  assert.equal(parseTarget("http://8.8.8.8/", policy).literal, true);
});

test("local and reserved names are refused before any lookup", () => {
  for (const u of ["http://localhost/", "http://redis/", "http://nuq-postgres:5432/", "http://firecrawl-core/", "http://printer.local/",
    "http://db.internal/", "http://nas.lan/", "http://host.home.arpa/", "http://pi.ts.net/", "http://x.test/", "http://m9.fixture.fcpi.test:8080/",
    "http://foo.localhost/", "http://a..b/"]) {
    assert.throws(() => parseTarget(u, policy), (e) => e instanceof Denied && ["SSRF_DENIED", "INVALID_URL"].includes(e.failureClass), u);
  }
});

test("Firecrawl Cloud destinations are refused", () => {
  denied("https://api.firecrawl.dev/v1/scrape", "CLOUD_DENIED");
  denied("https://firecrawl.dev/", "CLOUD_DENIED");
  denied("https://mcp.firecrawl.dev/v2/mcp", "CLOUD_DENIED");
  denied("https://integrations.firecrawl.dev/x", "CLOUD_DENIED");
});

test("the fixture exception is exact: its host, its port, plain http", () => {
  assert.equal(parseTarget("http://m2.fixture.fcpi.test:8080/static.html", policy).fixture.host, "m2.fixture.fcpi.test");
  denied("http://m2.fixture.fcpi.test/static.html", "SSRF_DENIED");
  denied("https://m2.fixture.fcpi.test:8080/", "SSRF_DENIED");
  denied("http://x.m2.fixture.fcpi.test:8080/", "SSRF_DENIED");
});

test("ordinary public URLs pass, with a trailing dot normalised", () => {
  assert.equal(parseTarget("https://example.com/a?b=1", policy).host, "example.com");
  assert.equal(parseTarget("http://example.com./", policy).host, "example.com");
  assert.equal(parseTarget("https://EXAMPLE.com/", policy).port, 443);
});

test("without the host's local-network list no address is public (review finding W7)", () => {
  assert.equal(classifyAddress("8.8.8.8"), "local-networks-not-loaded");
  assert.equal(classifyAddress("2606:4700:4700::1111", undefined), "local-networks-not-loaded");
  assert.throws(() => parseTarget("http://8.8.8.8/", { ...policy, localCidrs: undefined }), (e) => e.failureClass === "SSRF_DENIED");
});
