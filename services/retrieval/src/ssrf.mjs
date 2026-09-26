// Target validation (FIRECRAWL_PI_SPEC.md §20.2): which URLs may be fetched, and which addresses
// a fetch may connect to. Every URL the service acts on passes parseTarget(); every address a
// name resolves to passes classifyAddress() before a connection is made to exactly that address.
import { BlockList, isIP } from "node:net";

export class Denied extends Error {
  // extra: { retryable, retryAfter } when the refusal is a pacing or rate-limit decision.
  constructor(failureClass, detail, extra = {}) {
    super(`${failureClass}: ${detail}`);
    this.failureClass = failureClass;
    this.detail = detail;
    this.retryable = extra.retryable ?? false;
    this.retryAfter = extra.retryAfter ?? null;
  }
}

// IANA special-purpose and non-global ranges, IPv4 then IPv6. An address in any of them is never a
// target. IPv6 forms that embed an IPv4 address are unwrapped first (embeddedIpv4) and the IPv4
// address is judged on its own; the prefixes themselves are listed too, so a form not unwrapped
// is refused rather than passed.
const V4 = [
  ["0.0.0.0", 8, "this-network"], ["10.0.0.0", 8, "private"], ["100.64.0.0", 10, "shared-cgnat"],
  ["127.0.0.0", 8, "loopback"], ["169.254.0.0", 16, "link-local"], ["172.16.0.0", 12, "private"],
  ["192.0.0.0", 24, "ietf-assignment"], ["192.0.2.0", 24, "documentation"], ["192.31.196.0", 24, "as112"],
  ["192.52.193.0", 24, "amt"], ["192.88.99.0", 24, "6to4-relay"], ["192.168.0.0", 16, "private"],
  ["192.175.48.0", 24, "as112"], ["198.18.0.0", 15, "benchmarking"], ["198.51.100.0", 24, "documentation"],
  ["203.0.113.0", 24, "documentation"], ["224.0.0.0", 4, "multicast"], ["240.0.0.0", 4, "reserved"],
];
const V6 = [
  ["::", 128, "unspecified"], ["::1", 128, "loopback"], ["::", 96, "ipv4-compatible"],
  ["::ffff:0:0", 96, "ipv4-mapped"], ["64:ff9b::", 96, "nat64"], ["64:ff9b:1::", 48, "nat64-local"],
  ["100::", 64, "discard"], ["2001::", 23, "ietf-assignment"], ["2001:db8::", 32, "documentation"],
  ["2002::", 16, "6to4"], ["3fff::", 20, "documentation"], ["5f00::", 16, "srv6"], ["fc00::", 7, "unique-local"],
  ["fe80::", 10, "link-local"], ["fec0::", 10, "site-local"], ["ff00::", 8, "multicast"],
];
// One list per family: net.BlockList matches an IPv4 address against IPv4-mapped IPv6 rules, so a
// shared list holding ::ffff:0:0/96 would put every IPv4 address in it.
const lists = { ipv4: new Map(), ipv6: new Map() };
for (const [family, rows] of [["ipv4", V4], ["ipv6", V6]]) {
  for (const [net, bits, why] of rows) {
    const m = lists[family];
    (m.get(why) ?? m.set(why, new BlockList()).get(why)).addSubnet(net, bits, family);
  }
}

function v6words(addr) {
  // Expand an IPv6 address (including a trailing dotted IPv4 part) into eight 16-bit words.
  let a = addr.toLowerCase();
  const dotted = a.match(/^(.*:)(\d+\.\d+\.\d+\.\d+)$/);
  if (dotted) {
    const o = dotted[2].split(".").map(Number);
    a = `${dotted[1]}${((o[0] << 8) | o[1]).toString(16)}:${((o[2] << 8) | o[3]).toString(16)}`;
  }
  const [head, tail] = a.split("::");
  const h = head ? head.split(":") : [];
  const t = tail !== undefined ? (tail ? tail.split(":") : []) : [];
  const words = [...h, ...Array(8 - h.length - t.length).fill("0"), ...t];
  return words.map((w) => parseInt(w || "0", 16));
}
const v4of = (hi, lo) => `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`;

// The IPv4 address an IPv6 form carries: mapped (::ffff:a.b.c.d), IPv4-compatible (::a.b.c.d),
// NAT64 (64:ff9b::/96), 6to4 (2002:aabb:ccdd::/48) and Teredo (2001:0::/32, client address
// obfuscated by bit inversion).
export function embeddedIpv4(addr) {
  const w = v6words(addr);
  const zeros = (n) => w.slice(0, n).every((x) => x === 0);
  if (zeros(5) && w[5] === 0xffff) return v4of(w[6], w[7]);
  if (zeros(6) && (w[6] !== 0 || w[7] > 1)) return v4of(w[6], w[7]);
  if (w[0] === 0x64 && w[1] === 0xff9b && w.slice(2, 6).every((x) => x === 0)) return v4of(w[6], w[7]);
  if (w[0] === 0x2002) return v4of(w[1], w[2]);
  if (w[0] === 0x2001 && w[1] === 0) return v4of(w[6] ^ 0xffff, w[7] ^ 0xffff);
  return null;
}

// "public", or the reason the address is refused. localCidrs are the host's own connected
// networks (deployment configuration): the LAN this host sits on may use a range that is
// globally routable, so the special-purpose lists alone do not cover it.
export function classifyAddress(addr, localCidrs = new BlockList()) {
  const family = isIP(addr);
  if (family === 0) return "not-an-address";
  const type = family === 4 ? "ipv4" : "ipv6";
  if (localCidrs.check(addr, type)) return "host-local-network";
  if (family === 6) {
    const inner = embeddedIpv4(addr);
    if (inner) {
      const r = classifyAddress(inner, localCidrs);
      return r === "public" ? "ipv6-embedded-ipv4" : `ipv6-embedded-${r}`;
    }
  }
  for (const [why, list] of lists[type]) if (list.check(addr, type)) return why;
  // Beyond the named ranges, only global unicast (2000::/3) is ever a public IPv6 address.
  if (family === 6 && (v6words(addr)[0] & 0xe000) !== 0x2000) return "not-global-unicast";
  return "public";
}

// Names that are never public targets: local service names, reserved and special-use suffixes,
// the tailnet's names.
const RESERVED_SUFFIXES = [".localhost", ".local", ".internal", ".lan", ".home", ".home.arpa", ".corp",
  ".intranet", ".private", ".test", ".example", ".invalid", ".onion", ".arpa", ".ts.net", ".alt"];

export function hostMatches(host, pattern) {
  return pattern.startsWith("*.") ? host.endsWith(pattern.slice(1)) : host === pattern;
}

// Parse and validate a target URL. Returns { url, host, port, fixture } or throws Denied.
//   policy.fixtures: exact host names allowed on their own port, resolved inside the project's
//     fixture network (the one deployment-controlled exception, spec §20.2);
//   policy.cloudDenylist: Firecrawl Cloud service destinations, never contacted (spec §20.4).
export function parseTarget(raw, policy) {
  if (typeof raw !== "string" || raw.length === 0 || raw.length > 8192) throw new Denied("INVALID_URL", "missing or oversized URL");
  let url;
  try { url = new URL(raw); } catch { throw new Denied("INVALID_URL", "not a URL"); }
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Denied("SSRF_DENIED", `scheme ${url.protocol} is not http or https`);
  if (url.username || url.password) throw new Denied("SSRF_DENIED", "URLs with credentials are refused");
  let host = url.hostname.toLowerCase();
  if (host.endsWith(".")) host = host.slice(0, -1);
  const bare = host.startsWith("[") ? host.slice(1, -1) : host;
  // The WHATWG parser turns numeric forms such as 0x7f.1, 2130706433 or 0177.0.0.1 into a dotted
  // address. A literal written any other way than its canonical form is refused as ambiguous.
  const rawHost = (raw.match(/^[a-z][a-z0-9+.-]*:\/\/(?:[^@/?#]*@)?(\[[^\]]*\]|[^:/?#]*)/i) ?? [])[1]?.toLowerCase().replace(/\.$/, "");
  if (isIP(bare) && rawHost !== host) throw new Denied("SSRF_DENIED", "ambiguous numeric host encoding");
  const fixture = (policy.fixtures ?? []).find((f) => f.host === host) ?? null;
  const defaultPort = url.protocol === "https:" ? 443 : 80;
  const port = url.port ? Number(url.port) : defaultPort;
  if (fixture) {
    if (port !== fixture.port || url.protocol !== "http:") throw new Denied("SSRF_DENIED", "fixture hosts are served only on their own http port");
    return { url, host, port, fixture };
  }
  if ((policy.cloudDenylist ?? []).some((p) => hostMatches(host, p))) throw new Denied("CLOUD_DENIED", `${host} is a Firecrawl Cloud service destination`);
  if (!(policy.ports ?? [80, 443]).includes(port) || port !== defaultPort) throw new Denied("SSRF_DENIED", `port ${port} is not the scheme's default port`);
  if (isIP(bare)) {
    const why = classifyAddress(bare, policy.localCidrs);
    if (why !== "public") throw new Denied("SSRF_DENIED", `address ${bare} is ${why}`);
    return { url, host: bare, port, fixture: null, literal: true };
  }
  if (!host.includes(".")) throw new Denied("SSRF_DENIED", `single-label name ${host} is a local name`);
  if (host === "localhost" || RESERVED_SUFFIXES.some((s) => host.endsWith(s))) throw new Denied("SSRF_DENIED", `${host} is a reserved or local name`);
  if (!/^[a-z0-9.-]+$/.test(host) || host.split(".").some((l) => l.length === 0 || l.length > 63 || l.startsWith("-") || l.endsWith("-"))) {
    throw new Denied("SSRF_DENIED", "host name is not a valid DNS name");
  }
  return { url, host, port, fixture: null };
}
