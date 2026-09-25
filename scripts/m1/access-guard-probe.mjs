// TCP connects from inside the access-gateway container, each bounded at 3 s: the host
// through the fcpi-access bridge address, the host's LAN address, and one public address
// that is reached only by forwarding through the bridge's NAT. No DNS lookup is made.
// Piped into the container by scripts/m1/pi-guard-probe.sh; prints one JSON line.
import { connect } from "node:net";

const lan = process.env.PI_LAN_ADDRESS;
if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(lan ?? "")) throw new Error("PI_LAN_ADDRESS must be the host LAN IPv4 address");
const targets = [
  ["host_bridge_53", "10.231.0.1", 53],
  ["host_lan_22", lan, 22],
  ["public_443", "1.1.1.1", 443],
];
const attempt = (host, port) => new Promise((done) => {
  const s = connect({ host, port });
  const t = setTimeout(() => { s.destroy(); done({ connected: false, error: "timeout" }); }, 3000);
  s.once("connect", () => { clearTimeout(t); s.destroy(); done({ connected: true }); });
  s.once("error", (e) => { clearTimeout(t); done({ connected: false, error: e.code ?? e.message }); });
});
const out = { utc: new Date().toISOString(), tcp: {} };
for (const [key, host, port] of targets) out.tcp[key] = await attempt(host, port);
console.log(JSON.stringify(out));
