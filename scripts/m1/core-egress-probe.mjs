// Runs INSIDE a project container (docker exec -i <c> node --input-type=module - < core-egress-probe.mjs).
// Attempts name resolution and TCP connects that must all FAIL from an internal,
// isolated network, and prints one JSON line. With no route, a connect fails locally
// (ENETUNREACH) and no packet reaches the bridge; the host-side nft counters confirm that.
import { lookup } from "node:dns/promises";
import { connect } from "node:net";

const names = ["api.firecrawl.dev", "www.firecrawl.dev", "integrations.firecrawl.dev", "html.duckduckgo.com", "example.com"];
// The host LAN address comes from scripts/m1/pi-target.conf (PI_LAN_ADDRESS), its single
// definition; the collector passes it in. Without it the probe throws instead of printing
// its JSON line, so V11 fails.
const lan = process.env.PI_LAN_ADDRESS;
if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(lan ?? "")) throw new Error("PI_LAN_ADDRESS must be the host LAN IPv4 address");
const targets = [
  ["1.1.1.1", 443, "public address"],
  [lan, 22, "host LAN address (sshd)"],
  [lan, 53, "host LAN address (Pi-hole DNS)"],
  ["10.231.0.1", 53, "host address on the fcpi-access bridge (not a core network)"],
];
const out = { utc: new Date().toISOString(), dns: {}, tcp: {} };
for (const n of names) {
  try { out.dns[n] = { resolved: (await lookup(n, { all: true })).map((a) => a.address) }; }
  catch (e) { out.dns[n] = { error: e.code ?? e.message }; }
}
for (const [host, port, what] of targets) {
  out.tcp[`${host}:${port}`] = await new Promise((resolve) => {
    const s = connect({ host, port, timeout: 3000 });
    s.on("connect", () => { s.destroy(); resolve({ what, connected: true }); });
    s.on("timeout", () => { s.destroy(); resolve({ what, error: "TIMEOUT" }); });
    s.on("error", (e) => resolve({ what, error: e.code ?? e.message }));
  });
}
console.log(JSON.stringify(out));
