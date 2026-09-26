#!/usr/bin/env node
// Native compatibility with the pinned official client (spec §16.1: "maintain contract fixtures using a
// pinned compatible Firecrawl client"): @mendable/firecrawl-js 4.31.1, the version the pinned upstream
// tree ships (apps/js-sdk/firecrawl/package.json), installed outside the repository. It runs on the
// workstation against the gateway through an SSH forward (scripts/m3/e2e.mjs opens the same one), with
// its base URL set explicitly, and records every connection the client opens, so a request to any other
// host (Firecrawl Cloud's default among them) would show.
//   node scripts/m3/sdk-compat.mjs <dir holding node_modules/@mendable/firecrawl-js> < token > evidence/M3/raw/sdk-compat.txt
// The token (a gateway token with every scope) arrives on stdin and is never printed.
import net from "node:net";
import dns from "node:dns";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { spawn } from "node:child_process";
import { connect } from "node:net";

const dir = process.argv[2];
const ORIGIN = "http://127.0.0.1:3380", FX = "http://m3.fixture.fcpi.test:8080";
// Every TCP connection the process opens, whatever opens it (http.request and http.get, https, fetch),
// and every name it looks up: a request to any other host, Firecrawl Cloud's default among them,
// shows here even if its connection fails.
const seen = [], looked = [];
const origConnect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function (...args) {
  const o = Array.isArray(args[0]) ? args[0][0] : args[0];   // net passes normalized (options, callback) as an array
  seen.push(o && typeof o === "object" ? (o.path ? `unix:${o.path}` : `${o.host ?? "localhost"}:${o.port}`) : `${typeof args[1] === "string" ? args[1] : "localhost"}:${o}`);
  return origConnect.apply(this, args);
};
const origLookup = dns.lookup;
dns.lookup = function (host, ...rest) { looked.push(String(host)); return origLookup.call(this, host, ...rest); };
let current = null;
const out = (section, rec) => { if (section !== current) { process.stdout.write(`### ${section}\n`); current = section; } process.stdout.write(`${JSON.stringify({ utc: new Date().toISOString(), ...rec })}\n`); };
const errOf = (e) => ({ name: e?.name ?? null, status: e?.status ?? null, code: e?.code ?? null, message: String(e?.message ?? e).slice(0, 200) });

const token = readFileSync(0, "utf8").trim();
const pkg = JSON.parse(readFileSync(join(dir, "node_modules/@mendable/firecrawl-js/package.json"), "utf8"));
const { default: Firecrawl } = await import(pathToFileURL(join(dir, "node_modules/@mendable/firecrawl-js/dist/index.js")).href);
const T = Object.fromEntries(readFileSync(new URL("../m1/pi-target.conf", import.meta.url), "utf8").split("\n").filter((l) => /^PI_\w+=/.test(l)).map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1).replace("$HOME", process.env.HOME)]));
// As e2e.mjs does: a listener already on 127.0.0.1:3380 would receive the client's requests instead of the gateway.
const free = await new Promise((r) => { const s = connect(3380, "127.0.0.1"); s.on("connect", () => { s.destroy(); r(false); }); s.on("error", () => r(true)); });
if (!free) { console.error("127.0.0.1:3380 is already in use on the workstation"); process.exit(1); }
const tunnel = spawn("ssh", ["-i", T.PI_SSH_KEY, "-o", "IdentitiesOnly=yes", "-o", "BatchMode=yes", "-N", "-o", "ExitOnForwardFailure=yes", "-L", "127.0.0.1:3380:127.0.0.1:3380", T.PI_SSH_TARGET], { stdio: "ignore" });
for (let i = 0; i < 60; i++) {
  if (await new Promise((r) => { const s = connect(3380, "127.0.0.1"); s.on("connect", () => { s.destroy(); r(true); }); s.on("error", () => r(false)); })) break;
  await new Promise((r) => setTimeout(r, 250));
}
seen.length = 0; looked.length = 0;   // the probes above are not the client's
out("meta", { client: `${pkg.name}@${pkg.version}`, node: process.version, env_FIRECRAWL_API_URL_set: process.env.FIRECRAWL_API_URL !== undefined });

const fc = new Firecrawl({ apiKey: token, apiUrl: ORIGIN });
out("client", { apiUrl: fc.http?.getApiUrl?.() ?? null });
let code = 0;
try {
  const s = await fc.scrape(`${FX}/p02`, { formats: ["markdown", "links"] });
  out("scrape", { sentinel: (s.markdown?.match(/fcpi-m3-p02-[0-9a-f]{4}/) ?? [null])[0], links: s.links?.length ?? null, url: s.metadata?.url ?? null, statusCode: s.metadata?.statusCode ?? null });
  const m = await fc.map(`${FX}/`);
  out("map", { links: m.links.map((l) => l.url).sort() });
  const c = await fc.crawl(`${FX}/`, { limit: 4, sitemap: "include", pollInterval: 1, timeout: 600 });
  out("crawl", { status: c.status, completed: c.completed, total: c.total, docs: c.data.length, urls: c.data.map((d) => d.metadata?.url).sort(), expiresAt: c.expiresAt ?? null });
  const key = `sdk-${Date.now()}`;
  const b1 = await fc.startBatchScrape([`${FX}/p05`, `${FX}/p06`], { formats: ["markdown"], idempotencyKey: key });
  const b2 = await fc.startBatchScrape([`${FX}/p05`, `${FX}/p06`], { formats: ["markdown"], idempotencyKey: key });
  out("batch", { case: "start_twice_same_key", id: b2.id ?? null, first_id: b1.id ?? null, url_on_private_origin: String(b1.url).startsWith(`${ORIGIN}/v2/batch/scrape/`) });
  let bs;
  for (let i = 0; i < 300; i++) { bs = await fc.getBatchScrapeStatus(b1.id); if (["completed", "failed", "cancelled"].includes(bs.status)) break; await new Promise((r) => setTimeout(r, 1000)); }
  out("batch", { case: "status", status: bs.status, docs: bs.data.length, sentinels: bs.data.map((d) => (d.markdown?.match(/fcpi-m3-p0[56]-[0-9a-f]{4}/) ?? [null])[0]).sort() });
  const ce = await fc.getCrawlErrors(c.id ?? (await fc.startCrawl(`${FX}/`, { limit: 1 })).id).catch((e) => ({ error: errOf(e) }));
  out("crawl_errors", { errors: ce.errors?.length ?? null, robotsBlocked: ce.robotsBlocked ?? null, error: ce.error ?? null });
  const slow = await fc.startCrawl(`${FX}/slow/`, { limit: 10, sitemap: "skip" });
  await new Promise((r) => setTimeout(r, 4000));
  const cancelled = await fc.cancelCrawl(slow.id);
  let cs;
  for (let i = 0; i < 120; i++) { cs = await fc.getCrawlStatus(slow.id); if (cs.status === "cancelled") break; await new Promise((r) => setTimeout(r, 1000)); }
  out("cancel", { cancel_returned: cancelled, final_status: cs.status, docs: cs.data.length });
  const refused = await fc.scrape(`${FX}/p03`, { formats: ["screenshot"] }).then(() => ({ refused: false }), (e) => ({ refused: true, ...errOf(e) }));
  out("refused", refused);
} catch (e) {
  out("error", errOf(e));
  code = 1;
}
out("connections", { hosts: [...new Set(seen)], total: seen.length, lookups: [...new Set(looked)] });
tunnel.kill();
out("end", { exit: code });
process.exit(code);
