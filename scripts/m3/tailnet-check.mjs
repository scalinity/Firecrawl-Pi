#!/usr/bin/env node
// The private TLS path from the workstation (spec §19.1, AC02): the gateway through Tailscale Serve at
// https://<machine>.<tailnet>.ts.net:8443, reached from this machine over the tailnet, the certificate
// verified against the system's trust store (no verification is ever skipped); then every port the
// host listens on, tried over the tailnet, so what a tailnet peer reaches is measured.
//   node scripts/m3/tailnet-check.mjs < token > evidence/M3/raw/tailnet-check.txt
// The origin is read from the gateway's host-side file on the Pi into memory; the tailnet's name is
// printed as <pi-tailnet-name-host>. The token (read-only scope) arrives on stdin and is never printed.
import { request } from "node:https";
import { connect } from "node:net";
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";

const T = Object.fromEntries(readFileSync(new URL("../m1/pi-target.conf", import.meta.url), "utf8").split("\n").filter((l) => /^PI_\w+=/.test(l)).map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1).replace("$HOME", process.env.HOME)]));
const origin = execFileSync("ssh", ["-i", T.PI_SSH_KEY, "-o", "IdentitiesOnly=yes", "-o", "BatchMode=yes", T.PI_SSH_TARGET, "sudo -n grep -v '^#' /etc/firecrawl-pi/secrets/gateway/served-origins"], { encoding: "utf8" }).trim();
const u = new URL(origin);
// By shape, not by the name just read, so a name that differs from the origins file's is hidden too.
const hide = (s) => String(s).replace(/[a-z0-9-]+\.[a-z0-9-]+\.ts\.net/gi, "<pi-tailnet-name-host>").replace(/[a-z0-9-]+\.ts\.net/gi, "<pi-tailnet-name>");
const token = readFileSync(0, "utf8").trim();
const out = (rec) => process.stdout.write(`${hide(JSON.stringify({ utc: new Date().toISOString(), ...rec }))}\n`);

function get(path, { tok, host } = {}) {
  return new Promise((resolve) => {
    const req = request({ host: u.hostname, port: Number(u.port || 443), path, method: "GET", servername: u.hostname, timeout: 20000,
      headers: { host: host ?? u.host, ...(tok ? { authorization: `Bearer ${tok}` } : {}) } }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => {
        const cert = res.socket.getPeerCertificate?.() ?? {};
        let json = null; try { json = JSON.parse(Buffer.concat(chunks).toString()); } catch { /* not JSON */ }
        resolve({ status: res.statusCode, tls_authorized: res.socket.authorized === true, tls_protocol: res.socket.getProtocol?.() ?? null,
          cert_issuer_org: cert.issuer?.O ?? null, cert_subject_matches: (cert.subjectaltname ?? "").includes(`DNS:${u.hostname}`), cert_valid_to: cert.valid_to ?? null, json });
      });
    });
    req.on("timeout", () => req.destroy(new Error("timeout")));
    req.on("error", (e) => resolve({ error: e.code ?? e.message }));
    req.end();
  });
}

process.stdout.write("### meta\n");
out({ vantage: "workstation over the tailnet", origin_scheme: u.protocol, origin_port: u.port });
process.stdout.write("### tls\n");
const s = await get("/platform/v1/status", { tok: token });
out({ case: "status_with_read_token", status: s.status, error: s.error ?? null, tls_authorized: s.tls_authorized, tls_protocol: s.tls_protocol, cert_issuer_org: s.cert_issuer_org, cert_subject_matches: s.cert_subject_matches, cert_valid_to: s.cert_valid_to, core_live: s.json?.core?.live ?? null });
const n = await get("/platform/v1/status");
out({ case: "status_without_token", status: n.status, code: n.json?.code ?? null, tls_authorized: n.tls_authorized });
const j = await get("/platform/v1/jobs?limit=1", { tok: token });
out({ case: "job_list_urls", status: j.status, results_url_on_tailnet_origin: (j.json?.jobs ?? []).every((x) => String(x.results).startsWith(`${u.origin}/`)) && (j.json?.jobs ?? []).length === 1 });
const h = await get("/platform/v1/status", { tok: token, host: "evil.example" });
out({ case: "foreign_host_header", status: h.status, code: h.json?.code ?? null });

// What else a tailnet peer reaches on the Pi (spec §20.1: the Tailscale client serves the gateway
// alone): every TCP port the host listens on, as the Pi lists them (ports only; ones bound to loopback
// alone cannot be reached from a peer), tried from here over the tailnet, with Serve's :8443 as the
// positive control. Only the classification is printed.
process.stdout.write("### tailnet_ports\n");
const listening = execFileSync("ssh", ["-i", T.PI_SSH_KEY, "-o", "IdentitiesOnly=yes", "-o", "BatchMode=yes", T.PI_SSH_TARGET, "sudo -n ss -Hltn"], { encoding: "utf8" })
  .split("\n").map((l) => l.trim().split(/\s+/)[3]).filter(Boolean).filter((a) => !/^(127\.|\[::1\]:|::1:)/.test(a)).map((a) => Number(a.slice(a.lastIndexOf(":") + 1)));
const ports = [...new Set([...listening, 8443])].sort((a, b) => a - b);
const tryPort = (port) => new Promise((resolve) => {
  const s = connect({ host: u.hostname, port, timeout: 4000 });
  s.on("connect", () => { s.destroy(); resolve("open"); });
  s.on("timeout", () => { s.destroy(); resolve("timeout"); });
  s.on("error", (e) => resolve(e.code === "ECONNREFUSED" ? "refused" : String(e.code)));
});
for (const r of await Promise.all(ports.map(async (port) => ({ port, result: await tryPort(port) })))) out({ case: "tailnet_port", ...r });
process.stdout.write("### end\n");
out({ exit: 0 });
