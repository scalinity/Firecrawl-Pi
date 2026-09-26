// Run inside the MCP container (scripts/m4/pi-collect-stack.sh pipes it to `node --input-type=module -`):
// what the MCP service can reach. It sits on fcpi_mcp alone, internal and isolated, so the gateway's
// fixed address answers (the control) and nothing else does: no route out, no name resolved for
// Firecrawl Cloud or any public host. Prints key=value lines; changes nothing.
import { connect } from "node:net";
import { lookup } from "node:dns/promises";
import { readFileSync } from "node:fs";

const tcp = (host, port) => new Promise((resolve) => {
  const s = connect({ host, port });
  const t = setTimeout(() => { s.destroy(); resolve("timeout"); }, 4000);
  s.on("connect", () => { clearTimeout(t); s.destroy(); resolve("open"); });
  s.on("error", (e) => { clearTimeout(t); resolve(e.code ?? "error"); });
});
const name = (h) => lookup(h).then((r) => `resolved:${r.address}`, (e) => e.code ?? "error");
const route = readFileSync("/proc/net/route", "utf8").split("\n").slice(1).some((l) => l.split(/\s+/)[1] === "00000000");
console.log(`default_route=${route ? "yes" : "no"}`);
console.log(`gateway_tcp_10.231.8.10:3300=${await tcp("10.231.8.10", 3300)}`);
for (const [h, p] of [["1.1.1.1", 443], ["104.18.0.1", 443]]) console.log(`public_tcp_${h}:${p}=${await tcp(h, p)}`);
for (const h of ["api.firecrawl.dev", "firecrawl.dev", "example.com"]) console.log(`dns_${h}=${await name(h)}`);
