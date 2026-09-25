// Runs INSIDE a project container (docker exec -i <c> node --input-type=module - < core-egress-probe.mjs).
// Attempts name resolution and TCP connects that must all FAIL from an internal,
// isolated network, and prints one JSON line. With no route, a connect fails locally
// (ENETUNREACH) and no packet reaches the bridge; the host-side nft counters confirm that.
import { lookup } from "node:dns/promises";
import { connect } from "node:net";

const names = ["api.firecrawl.dev", "www.firecrawl.dev", "integrations.firecrawl.dev", "html.duckduckgo.com", "example.com"];
const targets = [
  ["1.1.1.1", 443, "public address"],
  ["158.205.34.18", 22, "host LAN address (sshd)"],
  ["158.205.34.18", 53, "host LAN address (Pi-hole DNS)"],
  ["10.231.1.1", 53, "would-be bridge gateway (isolated mode: absent)"],
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
