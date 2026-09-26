// A TCP reachability probe, run inside a container from stdin (scripts/m3/pi-port-probe.sh). TARGETS is
// a space-separated list of label=host:port; each is resolved and connected with a 3 s limit, and one
// JSON line reports the outcome: open, refused, timeout, unresolved or unreachable. With HTTP_PATH set,
// an open target also gets one POST of an empty JSON body to that path and its status is reported.
// Changes nothing. Node built-ins only.
import { connect } from "node:net";
import { lookup } from "node:dns/promises";

const role = process.env.ROLE ?? "unknown";
const httpPath = process.env.HTTP_PATH ?? "";
const targets = (process.env.TARGETS ?? "").split(" ").filter(Boolean).map((t) => { const [label, hp] = t.split("="); const i = hp.lastIndexOf(":"); return { label, host: hp.slice(0, i), port: Number(hp.slice(i + 1)) }; });

function tcp(address, port) {
  return new Promise((resolve) => {
    const s = connect({ host: address, port, timeout: 3000 });
    const done = (r) => { s.destroy(); resolve(r); };
    s.on("connect", () => done("open"));
    s.on("timeout", () => done("timeout"));
    s.on("error", (e) => done(e.code === "ECONNREFUSED" ? "refused" : e.code === "EHOSTUNREACH" || e.code === "ENETUNREACH" ? "unreachable" : `error:${e.code}`));
  });
}

for (const t of targets) {
  let address = t.host;
  if (!/^\d+\.\d+\.\d+\.\d+$/.test(t.host)) {
    try { address = (await lookup(t.host, { family: 4 })).address; } catch (e) { console.log(JSON.stringify({ role, label: t.label, target: `${t.host}:${t.port}`, outcome: "unresolved", code: e.code })); continue; }
  }
  const outcome = await tcp(address, t.port);
  const rec = { role, label: t.label, target: `${t.host}:${t.port}`, outcome };
  if (outcome === "open" && httpPath) {
    rec.http = await fetch(`http://${address}:${t.port}${httpPath}`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}", signal: AbortSignal.timeout(5000) })
      .then((r) => r.status, (e) => `error:${e.cause?.code ?? e.name}`);
  }
  console.log(JSON.stringify(rec));
}
