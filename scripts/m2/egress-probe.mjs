// M2's egress probe, run INSIDE one project container by scripts/m2/pi-egress-probe.sh
// (docker exec -i -e ROLE=… -e PI_LAN_ADDRESS=… <c> node --input-type=module - < egress-probe.mjs).
// Every probe names what it expects: "fail" (no answer, refused or unreachable) or "ok". Each role
// has local positive controls, so a probe that cannot reach anything cannot pass as a denial. No
// probe sends a packet off the host: the ones that would leave are refused in the container (no
// route) or dropped by the host's guard, whose counters the collector reads around the run.
//   ROLE=core       internal networks only: no name resolution out, no route out
//   ROLE=browser    the browser network only: nothing but the retrieval service's proxy
//   ROLE=retrieval  the egress bridge: the guard drops local, special-purpose, non-web and IPv6
//                   traffic; DNS reaches only the host resolver, and pi.hole is answered locally
//   ROLE=fixture    the fixture network only
import { lookup, Resolver } from "node:dns/promises";
import { connect } from "node:net";
import http from "node:http";

const role = process.env.ROLE;
const lan = process.env.PI_LAN_ADDRESS;
if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(lan ?? "")) throw new Error("PI_LAN_ADDRESS must be the host LAN IPv4 address");

// Another address on the host's LAN (/24), never printed: traffic to it is forwarded, so it meets
// the guard's host-local rule, where traffic to the host's own address is delivered to the host.
const neighbour = lan.replace(/\.\d+$/, lan.endsWith(".1") ? ".2" : ".1");
const tcp = (host, port, ms = 3000) => new Promise((resolve) => {
  const s = connect({ host, port, timeout: ms });
  s.on("connect", () => { s.destroy(); resolve({ ok: true }); });
  s.on("timeout", () => { s.destroy(); resolve({ ok: false, error: "TIMEOUT" }); });
  s.on("error", (e) => resolve({ ok: false, error: e.code ?? e.message }));
});
const dns = async (name) => {
  try { return { ok: true, addresses: (await lookup(name, { all: true })).map((a) => a.address).length }; }
  catch (e) { return { ok: false, error: e.code ?? e.message }; }
};
const dnsVia = async (server, name) => {
  const r = new Resolver({ timeout: 3000, tries: 1 });
  r.setServers([server]);
  try { return { ok: true, addresses: (await r.resolve4(name)).length }; }
  catch (e) { return { ok: false, error: e.code ?? e.message }; }
};
const get = (url, headers = {}) => new Promise((resolve) => {
  const req = http.get(url, { headers, timeout: 3000 }, (res) => { res.resume(); resolve({ ok: true, status: res.statusCode }); });
  req.on("timeout", () => { req.destroy(); resolve({ ok: false, error: "TIMEOUT" }); });
  req.on("error", (e) => resolve({ ok: false, error: e.code ?? e.message }));
});

// [label, expect, () => result]; the LAN address is labelled "lan", never printed.
const cases = {
  core: [
    ["dns api.firecrawl.dev", "fail", () => dns("api.firecrawl.dev")],
    ["dns html.duckduckgo.com", "fail", () => dns("html.duckduckgo.com")],
    ["dns example.com", "fail", () => dns("example.com")],
    ["tcp 1.1.1.1:443 (public)", "fail", () => tcp("1.1.1.1", 443)],
    ["tcp lan:22", "fail", () => tcp(lan, 22)],
    ["tcp lan:53", "fail", () => tcp(lan, 53)],
    ["tcp 10.231.6.1:53 (egress bridge host address)", "fail", () => tcp("10.231.6.1", 53)],
    ["tcp 10.231.2.10:3312 (browser proxy, another network)", "fail", () => tcp("10.231.2.10", 3312)],
    ["control tcp 10.231.5.10:3310 (retrieval service)", "ok", () => tcp("10.231.5.10", 3310)],
    ["control http retrieval-service:3310/healthz", "ok", () => get("http://retrieval-service:3310/healthz")],
  ],
  browser: [
    ["dns example.com", "fail", () => dns("example.com")],
    ["dns api.firecrawl.dev", "fail", () => dns("api.firecrawl.dev")],
    ["tcp 1.1.1.1:443 (public)", "fail", () => tcp("1.1.1.1", 443)],
    ["tcp lan:22", "fail", () => tcp(lan, 22)],
    ["tcp 10.231.5.10:3310 (retrieval service's API, another network)", "fail", () => tcp("10.231.5.10", 3310)],
    ["tcp 10.231.1.5:6379 (redis)", "fail", () => tcp("10.231.1.5", 6379)],
    ["control tcp 10.231.2.10:3312 (proxy)", "ok", () => tcp("10.231.2.10", 3312)],
    // A request to the proxy with no attempt credential: it must answer 407 and send nothing on.
    ["control http via proxy without credential (407)", "ok", () => new Promise((resolve) => {
      const req = http.request({ host: "10.231.2.10", port: 3312, path: "http://example.com/", method: "GET", timeout: 3000 }, (res) => { res.resume(); resolve({ ok: res.statusCode === 407, status: res.statusCode }); });
      req.on("timeout", () => { req.destroy(); resolve({ ok: false, error: "TIMEOUT" }); });
      req.on("error", (e) => resolve({ ok: false, error: e.code ?? e.message }));
      req.end();
    })],
  ],
  retrieval: [
    ["tcp lan:22 (the host's own LAN address, guard input)", "fail", () => tcp(lan, 22)],
    ["tcp lan:80 (the host's own LAN address, guard input)", "fail", () => tcp(lan, 80)],
    ["tcp lan-neighbour:80 (another host on the LAN, guard egress_local)", "fail", () => tcp(neighbour, 80)],
    ["tcp 10.231.6.1:22 (host on the bridge, guard input)", "fail", () => tcp("10.231.6.1", 22)],
    ["tcp 10.231.6.1:80 (host web listener on the bridge, guard input)", "fail", () => tcp("10.231.6.1", 80)],
    ["tcp 169.254.169.254:80 (metadata, guard special)", "fail", () => tcp("169.254.169.254", 80)],
    ["tcp 192.168.1.1:80 (private, guard special)", "fail", () => tcp("192.168.1.1", 80)],
    // The service is a member of fcpi_core (its PostgreSQL store), so a data-network address is
    // reached over that bridge; the guard's special-range rule is shown on a project address
    // on no attached network, which leaves by the default route.
    ["tcp 10.231.9.9:80 (private, no attached network, guard special)", "fail", () => tcp("10.231.9.9", 80)],
    ["tcp 1.1.1.1:22 (public, non-web port, guard other)", "fail", () => tcp("1.1.1.1", 22)],
    ["tcp [2606:4700:4700::1111]:443 (IPv6)", "fail", () => tcp("2606:4700:4700::1111", 443)],
    ["control dns pi.hole via 10.231.6.1 (answered by the host resolver itself)", "ok", () => dnsVia("10.231.6.1", "pi.hole")],
    ["control tcp 10.231.6.1:53 (host resolver over TCP)", "ok", () => tcp("10.231.6.1", 53)],
  ],
  fixture: [
    ["dns example.com", "fail", () => dns("example.com")],
    ["tcp 1.1.1.1:443 (public)", "fail", () => tcp("1.1.1.1", 443)],
    ["tcp lan:22", "fail", () => tcp(lan, 22)],
    ["control tcp 127.0.0.1:8080 (itself)", "ok", () => tcp("127.0.0.1", 8080)],
  ],
}[role];
if (!cases) throw new Error(`unknown ROLE ${role}`);

const probes = [];
for (const [label, expect, run] of cases) {
  const r = await run();
  probes.push({ label, expect, ...r, as_expected: expect === "ok" ? r.ok === true : r.ok === false });
}
console.log(JSON.stringify({ utc: new Date().toISOString(), role, probes, all_as_expected: probes.every((p) => p.as_expected) }));
