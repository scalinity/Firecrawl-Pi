#!/usr/bin/env node
// M6's evidence driver (docs/FIRECRAWL_PI_MILESTONES.md, M6 "Automated Verification"). It runs on the workstation
// and reaches the gateway as agents do, through an SSH forward of its loopback publication (127.0.0.1:3380);
// actions on the Pi (the host selection, the fixture proxy's mode and counters, the ledger, calls to the retrieval
// service's internal listener from inside the gateway's container) run over SSH. It prints sectioned JSON lines;
// scripts/m6/verify.mjs recomputes every verdict from them.
//   node scripts/m6/e2e.mjs fixture > evidence/M6/raw/e2e-fixture.txt
//   node scripts/m6/e2e.mjs live    > evidence/M6/raw/e2e-live.txt     (held until the review is addressed)
// fixture: every controlled case against fixture-m6's proxy and targets, with no public egress; first with the
// production selection (the Decodo route, whose credential is absent), then with the fixture proxy selected.
// live: live proxied egress and live residential search, only where a Decodo credential and an approved budget
// exist; otherwise their state is recorded and nothing leaves. The selection found at the start is restored at the
// end. Tokens come over SSH into memory; none is printed.
import { execFileSync, spawn } from "node:child_process";
import { request } from "node:http";
import net, { connect } from "node:net";
import dns from "node:dns";
import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");
const phase = process.argv[2];
if (!["fixture", "live"].includes(phase)) { console.error("usage: e2e.mjs fixture|live"); process.exit(2); }
const T = Object.fromEntries(readFileSync(join(ROOT, "scripts/m1/pi-target.conf"), "utf8").split("\n").filter((l) => /^PI_\w+=/.test(l)).map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1).replace("$HOME", process.env.HOME)]));
const SSH = ["-i", T.PI_SSH_KEY, "-o", "IdentitiesOnly=yes", "-o", "BatchMode=yes", "-o", "ConnectTimeout=15"];
const HOST = "127.0.0.1:3380";
const FX = (h = "m6") => `http://${h}.fixture.fcpi.test:8080`;
const MODERN = "2026-07-28";
const META = { "io.modelcontextprotocol/protocolVersion": MODERN, "io.modelcontextprotocol/clientCapabilities": {}, "io.modelcontextprotocol/clientInfo": { name: "fcpi-m6-e2e", version: "1" } };
const MODEL = "gpt-4.1-mini-2025-04-14", PARSER = "llamaparse-cost-effective";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sha = (s) => createHash("sha256").update(s).digest("hex");

// ---- output ------------------------------------------------------------------------------------------
const hideIds = (s) => [[T.PI_SSH_KEY, "<pi-ssh-key>"], [T.PI_SSH_TARGET, "<pi-ssh-target>"], [T.PI_LAN_ADDRESS, "<pi-lan-address>"], [process.env.HOME, "<home>"]]
  .reduce((x, [a, b]) => (a ? x.split(a).join(b) : x), s);
let current = null;
function out(section, rec) {
  if (section !== current) { process.stdout.write(`### ${section}\n`); current = section; }
  process.stdout.write(`${hideIds(JSON.stringify({ utc: new Date().toISOString(), ...rec }))}\n`);
}
// Every TCP connection and name lookup this process makes: only the forward may appear.
const seen = [], looked = [];
const origConnect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function (...args) {
  const o = Array.isArray(args[0]) ? args[0][0] : args[0];
  seen.push(o && typeof o === "object" ? (o.path ? `unix:${o.path}` : `${o.host ?? "localhost"}:${o.port}`) : `${typeof args[1] === "string" ? args[1] : "localhost"}:${o}`);
  return origConnect.apply(this, args);
};
const origLookup = dns.lookup;
dns.lookup = function (host, ...rest) { looked.push(String(host)); return origLookup.call(this, host, ...rest); };

// ---- the Pi -----------------------------------------------------------------------------------------------
const pi = (cmd, input) => execFileSync("ssh", [...SSH, T.PI_SSH_TARGET, cmd], { encoding: "utf8", input, maxBuffer: 64 * 1024 * 1024 });
const D = (args) => pi(`sudo -n docker ${args}`);
const cname = (svc) => `fcpi-${svc}-1`;
const sql = (q) => pi(`sudo -n docker exec -i ${cname("nuq-postgres")} psql -U postgres -d postgres -q -At -X -v ON_ERROR_STOP=1`, q).trim().split("\n").filter(Boolean);
const tokens = {};
const token = (label) => (tokens[label] ??= pi(`sudo -n cat /etc/firecrawl-pi/secrets/clients/${label}.token`).trim());
const health = (svc) => D(`inspect -f '{{.State.Status}} {{if .State.Health}}{{.State.Health.Status}}{{end}}' ${cname(svc)}`).trim();
async function waitHealthy(svc, ms = 180000) {
  const end = Date.now() + ms;
  for (;;) { const h = health(svc); if (h === "running healthy") return h; if (Date.now() > end) throw new Error(`${svc} not healthy: ${h}`); await sleep(1000); }
}
const piNow = () => pi("date -u +%Y-%m-%dT%H:%M:%S.%3NZ").trim();
const jsonLog = (svc, since) => pi(`sudo -n docker logs ${since ? `--since ${since} ` : ""}${cname(svc)} 2>&1`).split("\n").filter((l) => l.startsWith("{")).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
const selection = () => JSON.parse(pi("bash /opt/firecrawl-pi/scripts/m5/pi-selection.sh show"));
function select(search, model, parser, proxy) {
  const r = pi(`bash /opt/firecrawl-pi/scripts/m5/pi-selection.sh ${search} ${model} ${parser} ${proxy}`).trim();
  out("selection", { search, model, parser, proxy, applied: /^selection applied/.test(r) });
}
// fixture-m6's control port, inside its container (the only place it is served).
const fxCtl = (method, path) => JSON.parse(D(`exec ${cname("fixture-m6")} node -e "fetch('http://127.0.0.1:8082${path}',{method:'${method}'}).then(r=>r.text()).then(t=>process.stdout.write(t))"`));
const fxStats = () => fxCtl("GET", "/__stats");
const fxMode = (m) => fxCtl("POST", `/__mode?m=${m}`);
const hitsFor = (st, pred) => st.hits.filter(pred);
// The retrieval service's own readiness, read inside its container.
const readyz = () => JSON.parse(D(`exec ${cname("retrieval-service")} node -e "fetch('http://10.231.5.10:3310/readyz').then(r=>r.text()).then(t=>process.stdout.write(t))"`));
// A call to the retrieval service's gateway listener, made inside the gateway's container with its credential.
const INTERNAL = `const fs=require("fs");let b="";process.stdin.on("data",c=>b+=c).on("end",async()=>{const t=fs.readFileSync("/run/secrets/gateway_retrieval_token","utf8").trim();const x=JSON.parse(b);const r=await fetch("http://10.231.9.20:3314"+x.path,{method:x.method,headers:{authorization:"Bearer "+t,"content-type":"application/json"},body:x.body?JSON.stringify(x.body):undefined});process.stdout.write(JSON.stringify({status:r.status,json:await r.json().catch(()=>null)}));});`;
const internal = (method, path, body) => JSON.parse(pi(`sudo -n docker exec -i ${cname("access-gateway")} node -e '${INTERNAL}'`, JSON.stringify({ method, path, body })));
// Reservations against the deployed ledger, made inside the retrieval service's container with its own Store and
// credential: n at once, each for one attempt's maximum, in one category. Prints the outcomes.
const RACE = `import { Store } from "/srv/retrieval/src/store.mjs"; import { readFileSync } from "node:fs"; import { randomUUID } from "node:crypto";
let b = ""; for await (const c of process.stdin) b += c; const x = JSON.parse(b);
const store = new Store({ host: process.env.PI_POSTGRES_HOST, database: process.env.PI_POSTGRES_DB, user: process.env.PI_POSTGRES_USER, password: readFileSync("/run/secrets/retrieval_postgres_password", "utf8").trim() });
const day = new Date().toISOString().slice(0, 10), month = day.slice(0, 7) + "-01";
const one = (i) => store.reserveBudget({ id: randomUUID(), callKey: x.prefix + i, logicalId: x.prefix + i, category: x.category, provider: x.provider, subject: x.subject, kind: "proxy", unit: "micro_usd", rateCard: x.rateCard, requestHash: "bytes:" + x.bytes, amount: x.amount, caps: x.caps, paidTotalCap: null, paidTotalRate: 1, day, month, notifyAt: 0.8 });
const rs = x.release ? [] : await Promise.all(Array.from({ length: x.n }, (_, i) => one(i)));
const released = [];
if (x.release) for (const id of x.release) released.push(!!(await store.releaseBudget(id, "e2e race reservation, released")));
process.stdout.write(JSON.stringify({ outcomes: rs.map((r) => r.reservation ? { granted: true, id: r.reservation.id } : r.exhausted ? { granted: false, exhausted: r.exhausted } : { granted: false, other: true }), released }));
await store.close();`;
const race = (x) => JSON.parse(pi(`sudo -n docker exec -i ${cname("retrieval-service")} node --input-type=module -e '${RACE.replace(/'/g, "'\\''")}'`, JSON.stringify(x)));
// Each acquisition of a domain since `since`, from the attempt log: its strategies, outcomes and statuses in order.
const attempts = (domain, since) => sql(`SELECT row_to_json(r) FROM (SELECT logical_id, array_agg(strategy ORDER BY ordinal) AS strategies, array_agg(outcome ORDER BY ordinal) AS outcomes,
  array_agg(target_status ORDER BY ordinal) AS statuses, array_agg(bytes ORDER BY ordinal) AS bytes, min(started_at) AS started FROM fcpi_retrieval.attempt
  WHERE domain = '${domain}' AND started_at >= '${since}' GROUP BY logical_id ORDER BY min(started_at)) r`).map((l) => JSON.parse(l));
const routeRow = (domain) => { const r = sql(`SELECT row_to_json(d) FROM (SELECT *, round(extract(epoch FROM expires_at - set_at))::int AS ttl_s FROM fcpi_retrieval.domain_route WHERE domain = '${domain}') d`); return r.length ? JSON.parse(r[0]) : null; };
const proxyLedger = (since) => sql(`SELECT row_to_json(r) FROM (SELECT call_key, logical_id, category, provider, subject, kind, rate_card, reserved, actual, state, usage, detail, created_at, settled_at FROM fcpi_retrieval.budget_reservation WHERE kind IN ('proxy', 'reconcile') AND created_at >= '${since}' ORDER BY created_at) r`).map((l) => JSON.parse(l));
const usageRows = () => sql(`SELECT row_to_json(u) FROM (SELECT category, period, period_start::text, reserved, settled FROM fcpi_retrieval.budget_usage WHERE period_start >= (now() at time zone 'utc')::date - 31 AND category IN ('proxy', 'fixture_proxy', 'fixture_proxy_race', '_paid_total') ORDER BY 1, 2, 3) u`).map((l) => JSON.parse(l));
const resources = (label) => { try { out("resources", JSON.parse(pi(`bash /opt/firecrawl-pi/scripts/m6/pi-resources.sh ${label}`))); } catch (e) { out("error", { message: `resources ${label}: ${e.message}` }); } };

// ---- the forward and HTTP ---------------------------------------------------------------------------------
let tunnel = null;
async function openTunnel() {
  const free = await new Promise((r) => { const s = connect(3380, "127.0.0.1"); s.on("connect", () => { s.destroy(); r(false); }); s.on("error", () => r(true)); });
  if (!free) throw new Error("127.0.0.1:3380 is already in use on the workstation");
  tunnel = spawn("ssh", [...SSH, "-N", "-o", "ExitOnForwardFailure=yes", "-L", "127.0.0.1:3380:127.0.0.1:3380", T.PI_SSH_TARGET], { stdio: "ignore" });
  for (let i = 0; i < 60; i++) {
    if (await new Promise((r) => { const s = connect(3380, "127.0.0.1"); s.on("connect", () => { s.destroy(); r(true); }); s.on("error", () => r(false)); })) return;
    await sleep(250);
  }
  throw new Error("the SSH forward did not open");
}
function http(method, path, { tok = "m6", body, headers = {}, timeoutMs = 200000 } = {}) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
    const req = request({ host: "127.0.0.1", port: 3380, method, path, agent: false, timeout: timeoutMs,
      headers: { host: HOST, accept: "application/json, text/event-stream", ...(tok ? { authorization: `Bearer ${token(tok)}` } : {}), ...(data ? { "content-type": "application/json", "content-length": data.length } : {}), ...headers } }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => {
        const text = Buffer.concat(chunks).toString();
        let json = null;
        const sse = /text\/event-stream/.test(res.headers["content-type"] ?? "");
        try { json = sse ? JSON.parse(text.split("\n").filter((l) => l.startsWith("data: ")).at(-1).slice(6)) : JSON.parse(text); } catch { /* not JSON */ }
        resolve({ status: res.statusCode, headers: res.headers, json, bytes: text.length });
      });
    });
    req.on("timeout", () => req.destroy(new Error("timeout")));
    req.on("error", reject);
    req.end(data);
  });
}
const rest = (method, path, body, o = {}) => http(method, path, { ...o, body });
// A typed retrieval failure reaches REST as the core's SCRAPE_FCPI_RETRIEVAL with the class in its message.
const classOf = (r) => (/Retrieval failed: ([A-Z_]+)\./.exec(r.json?.error ?? "") ?? [])[1] ?? r.json?.code ?? null;
const brief = (r) => ({ status: r.status, code: r.json?.code ?? null, class: classOf(r), error: typeof r.json?.error === "string" ? r.json.error.slice(0, 300) : null,
  success: r.json?.success ?? null, route: r.json?.route ?? null, ...(r.headers?.["retry-after"] ? { retryAfter: r.headers["retry-after"] } : {}) });
const docOf = (r) => r.json?.data ?? null;
const scrape = (url, extra = {}, tok = "m6") => rest("POST", "/v2/scrape", { url, formats: ["markdown"], ...extra }, { tok });
async function pollJob(kind, id, ms = 600000) {
  const end = Date.now() + ms;
  for (;;) {
    const r = await rest("GET", `/v2/${kind === "batch" ? "batch/scrape" : "crawl"}/${id}`);
    if (r.status !== 200 || ["completed", "failed", "cancelled"].includes(r.json?.status) || Date.now() > end) return r;
    await sleep(3000);
  }
}
async function catalog() {
  const r = await http("POST", "/mcp", { headers: { "mcp-protocol-version": MODERN, "mcp-method": "tools/list" }, body: { jsonrpc: "2.0", id: 1, method: "tools/list", params: { _meta: META } } });
  const tools = r.json?.result?.tools ?? [];
  const scrapeTool = tools.find((t) => t.name === "firecrawl_scrape");
  out("mcp_catalog", { status: r.status, tools: tools.map((t) => t.name), sha256: sha(JSON.stringify(tools)), scrape_proxy_enum: scrapeTool?.inputSchema?.properties?.proxy?.enum ?? null });
}
// The case's attempts on one domain, bracketed by the Pi's clock around it.
async function acquisition(domain, label, fn) {
  const t0 = piNow(), st0 = fxStats();
  const r = await fn();
  const st1 = fxStats();
  const newHits = st1.hits.slice(st0.hits.length), newTunnels = st1.tunnels.slice(st0.tunnels.length);
  return { r, acq: attempts(domain, t0), hits: newHits, tunnels: newTunnels, t0 };
}
const hitSummary = (hits) => hits.map((h) => ({ host: h.host, path: h.path, via: h.via, at: h.at }));
const tunnelSummary = (ts) => ts.map((t) => ({ session: t.session, exit: t.exit, target: t.target, minutes: t.minutes, up: t.up, down: t.down, closed: t.closed }));

// ---- the fixture phase ---------------------------------------------------------------------------------------
async function fixturePhase(before) {
  const since = piNow();
  out("meta", { phase, pi_utc: since, deployed_commit: pi("cat /opt/firecrawl-pi/.fcpi-source-commit").trim(), selection_before: before });
  // The fixture's own routing and pacing rows are cleared, so learning and cooldowns start fresh; the counts are kept.
  const cleared = sql(`WITH r AS (DELETE FROM fcpi_retrieval.domain_route WHERE domain LIKE 'm6%.fixture.fcpi.test' RETURNING 1), s AS (DELETE FROM fcpi_retrieval.domain_state WHERE domain LIKE 'm6%.fixture.fcpi.test' RETURNING 1),
    h AS (DELETE FROM fcpi_retrieval.route_hold WHERE domain LIKE 'm6%.fixture.fcpi.test' RETURNING 1), n AS (DELETE FROM fcpi_retrieval.direct_nav WHERE domain LIKE 'm6%.fixture.fcpi.test' RETURNING 1)
    SELECT (SELECT count(*) FROM r) || ' ' || (SELECT count(*) FROM s) || ' ' || (SELECT count(*) FROM h) || ' ' || (SELECT count(*) FROM n)`)[0].split(" ").map(Number);
  out("reset", { domain_route: cleared[0], domain_state: cleared[1], route_hold: cleared[2], direct_nav: cleared[3], fixture: fxCtl("POST", "/__reset") });
  resources("fixture-start");
  await catalog();
  const nonce = randomUUID().slice(0, 8);

  // ---- A: the production selection (Decodo, no credential): the route is unavailable, and nothing spills.
  select("fixture", MODEL, PARSER, "decodo-residential");
  out("production", { case: "route_state", readyz: readyz().residential, routes: internal("GET", "/internal/routes").json, providers: (await rest("GET", "/platform/v1/status")).json?.providers?.providers?.decodo ?? null });
  let a = await acquisition("m6.fixture.fcpi.test", "stealth", () => scrape(`${FX()}/static?a=${nonce}`, { proxy: "stealth" }));
  out("production", { case: "stealth_proxy_required", ...brief(a.r), acquisitions: a.acq, hits: hitSummary(a.hits), tunnels: a.tunnels.length });
  const jobs0 = Number(sql("SELECT count(*) FROM fcpi_platform.job")[0]);
  a = await acquisition("m6bulk.fixture.fcpi.test", "bulk crawl", () => rest("POST", "/v2/crawl", { url: `${FX("m6bulk")}/bulk/`, limit: 50 }));
  out("production", { case: "bulk_crawl_refused", ...brief(a.r), acquisitions: a.acq, hits: hitSummary(a.hits), tunnels: a.tunnels.length });
  a = await acquisition("m6bulk.fixture.fcpi.test", "bulk batch", () => rest("POST", "/v2/batch/scrape", { urls: Array.from({ length: 21 }, (_, i) => `${FX("m6bulk")}/bulk/p${i + 1}?b=${nonce}`) }));
  out("production", { case: "bulk_batch_refused", ...brief(a.r), acquisitions: a.acq, hits: hitSummary(a.hits) });
  a = await acquisition("m6bulk.fixture.fcpi.test", "basic bulk", () => rest("POST", "/v2/crawl", { url: `${FX("m6bulk")}/bulk/`, limit: 30, scrapeOptions: { proxy: "basic" } }));
  out("production", { case: "basic_bulk_refused", ...brief(a.r), hits: hitSummary(a.hits) });
  out("production", { case: "no_receipts", jobs_before: jobs0, jobs_after: Number(sql("SELECT count(*) FROM fcpi_platform.job")[0]) });
  a = await acquisition("m6hard.fixture.fcpi.test", "proxy-first", () => scrape(`${FX("m6hard")}/static?a=${nonce}`));
  out("production", { case: "proxy_first_required", ...brief(a.r), acquisitions: a.acq, hits: hitSummary(a.hits) });
  a = await acquisition("m6.fixture.fcpi.test", "challenge", () => scrape(`${FX()}/challenge?a=${nonce}`));
  out("production", { case: "challenge_no_route", ...brief(a.r), acquisitions: a.acq, hits: hitSummary(a.hits), tunnels: a.tunnels.length });
  // The positive controls: ordinary direct work goes on (AC23), and a small crawl runs directly.
  a = await acquisition("m6.fixture.fcpi.test", "static", () => scrape(`${FX()}/static?a=${nonce}`));
  out("production", { case: "static_direct", ...brief(a.r), markdown: /directly/.test(docOf(a.r)?.markdown ?? ""), proxyUsed: docOf(a.r)?.metadata?.proxyUsed ?? null, acquisitions: a.acq, hits: hitSummary(a.hits) });
  a = await acquisition("m6bulk.fixture.fcpi.test", "small crawl", async () => { const s = await rest("POST", "/v2/crawl", { url: `${FX("m6bulk")}/bulk/`, limit: 5 }); return s.json?.id ? pollJob("crawl", s.json.id) : s; });
  out("production", { case: "small_crawl_direct", ...brief(a.r), status_field: a.r.json?.status ?? null, documents: a.r.json?.data?.length ?? null, acquisitions: a.acq, hits: hitSummary(a.hits), tunnels: a.tunnels.length });

  // ---- B: the fixture proxy selected.
  select("fixture", MODEL, PARSER, "fcpi-fixture-proxy");
  out("route", { case: "route_state", readyz: readyz().residential, routes: internal("GET", "/internal/routes").json });
  // B1: the same target seen from the direct route and from the proxy's exit.
  a = await acquisition("m6.fixture.fcpi.test", "echo basic", () => scrape(`${FX()}/echo?e=${nonce}`, { proxy: "basic", formats: ["rawHtml"] }));
  out("egress", { case: "direct", ...brief(a.r), body: docOf(a.r)?.rawHtml ?? null, proxyUsed: docOf(a.r)?.metadata?.proxyUsed ?? null, acquisitions: a.acq, hits: hitSummary(a.hits), tunnels: tunnelSummary(a.tunnels) });
  a = await acquisition("m6.fixture.fcpi.test", "echo stealth", () => scrape(`${FX()}/echo?e=${nonce}-s`, { proxy: "stealth", formats: ["rawHtml"] }));
  out("egress", { case: "residential", ...brief(a.r), body: docOf(a.r)?.rawHtml ?? null, proxyUsed: docOf(a.r)?.metadata?.proxyUsed ?? null, acquisitions: a.acq, hits: hitSummary(a.hits), tunnels: tunnelSummary(a.tunnels) });
  // B2: a residential browser render: the page and its images through the provider under one session.
  a = await acquisition("m6.fixture.fcpi.test", "js-subres", () => scrape(`${FX()}/js-subres?s=${nonce}`, { proxy: "stealth" }));
  out("subresources", { case: "residential_browser", ...brief(a.r), markdown: /Scripted page with subresources/.test(docOf(a.r)?.markdown ?? ""), proxyUsed: docOf(a.r)?.metadata?.proxyUsed ?? null,
    acquisitions: a.acq, hits: hitSummary(a.hits), tunnels: tunnelSummary(a.tunnels) });
  // B3: escalation, automatic: HTTP to browser to the residential browser; and HTTP straight to residential HTTP.
  // Each on a name of its own under m6esc, which must learn nothing between them: the first two challenges would set
  // a preference, so the preference is cleared after each (the learning itself is B5's, on m6learn).
  for (const [c, path] of [["js_challenge", "/js-challenge"], ["challenge_403", "/challenge"], ["challenge_200", "/challenge200"]]) {
    sql("DELETE FROM fcpi_retrieval.domain_route WHERE domain = 'm6esc.fixture.fcpi.test'");
    a = await acquisition("m6esc.fixture.fcpi.test", c, () => scrape(`${FX("m6esc")}${path}?x=${nonce}`));
    out("escalation", { case: c, ...brief(a.r), markdown: (docOf(a.r)?.markdown ?? "").slice(0, 160), proxyUsed: docOf(a.r)?.metadata?.proxyUsed ?? null, acquisitions: a.acq, hits: hitSummary(a.hits), tunnels: tunnelSummary(a.tunnels) });
  }
  // B4: spec §9.2's rules; none of them reaches the provider.
  for (const [c, host, path] of [["401", "m6", "/401"], ["unknown_403", "m6", "/403"], ["404", "m6", "/404"], ["500", "m6", "/500"], ["429", "m6cool", "/429"]]) {
    a = await acquisition(`${host}.fixture.fcpi.test`, c, () => scrape(`${FX(host)}${path}?r=${nonce}`));
    out("failure_rules", { case: c, ...brief(a.r), statusCode: docOf(a.r)?.metadata?.statusCode ?? null, acquisitions: a.acq, hits: hitSummary(a.hits), tunnels: a.tunnels.length });
  }
  a = await acquisition("m6cool.fixture.fcpi.test", "cooled stealth", () => scrape(`${FX("m6cool")}/static?r=${nonce}`, { proxy: "stealth" }));
  out("failure_rules", { case: "cooldown_all_routes", ...brief(a.r), acquisitions: a.acq, hits: hitSummary(a.hits), tunnels: a.tunnels.length, domain_state: sql("SELECT row_to_json(s) FROM (SELECT cooldown_s, round(extract(epoch FROM cooldown_until - now()))::int AS remaining_s FROM fcpi_retrieval.domain_state WHERE domain = 'm6cool.fixture.fcpi.test') s").map((l) => JSON.parse(l))[0] ?? null });
  // B5: learning, the preference, its TTL, the probe after expiry.
  const L = [];
  for (let i = 1; i <= 3; i++) {
    a = await acquisition("m6learn.fixture.fcpi.test", `learn ${i}`, () => scrape(`${FX("m6learn")}/challenge?l=${nonce}-${i}`));
    L.push({ n: i, ...brief(a.r), acquisitions: a.acq, hits: hitSummary(a.hits), route: routeRow("m6learn.fixture.fcpi.test") });
  }
  for (const x of L) out("learning", { case: `observation_${x.n}`, ...x });
  sql("UPDATE fcpi_retrieval.domain_route SET expires_at = now() - interval '1 minute', probe_at = NULL WHERE domain = 'm6learn.fixture.fcpi.test'");
  a = await acquisition("m6learn.fixture.fcpi.test", "probe", () => scrape(`${FX("m6learn")}/challenge?l=${nonce}-probe`));
  out("learning", { case: "probe_after_expiry", ...brief(a.r), acquisitions: a.acq, hits: hitSummary(a.hits), route: routeRow("m6learn.fixture.fcpi.test") });
  out("learning", { case: "bound", rows: Number(sql("SELECT count(*) FROM fcpi_retrieval.domain_route")[0]), max: 5000 });
  // B6: a bulk crawl and a bulk batch: accepted, held, every request through the provider, the hold released.
  const b0 = piNow(), bs0 = fxStats();
  let r = await rest("POST", "/v2/crawl", { url: `${FX("m6bulk")}/bulk/`, limit: 25 });
  const crawlId = r.json?.id;
  out("bulk", { case: "crawl_accepted", ...brief(r), id: crawlId ?? null, holds_during: sql(`SELECT count(*) FROM fcpi_retrieval.route_hold WHERE domain = 'm6bulk.fixture.fcpi.test' AND until > now()`).map(Number)[0] });
  r = crawlId ? await pollJob("crawl", crawlId) : r;
  await sleep(5000);
  let bs1 = fxStats();
  const bulkHits = bs1.hits.slice(bs0.hits.length).filter((h) => h.host === "m6bulk.fixture.fcpi.test");
  out("bulk", { case: "crawl_finished", ...brief(r), status_field: r.json?.status ?? null, documents: r.json?.data?.length ?? null, hits: hitSummary(bulkHits), acquisitions: attempts("m6bulk.fixture.fcpi.test", b0),
    holds_after: sql(`SELECT count(*) FROM fcpi_retrieval.route_hold WHERE domain = 'm6bulk.fixture.fcpi.test'`).map(Number)[0],
    gateway_log: jsonLog("access-gateway", b0).filter((l) => l.event === "job" && ["route_held", "submitted", "finished"].includes(l.action)).map((l) => ({ action: l.action, job: l.job, domains: l.domains ?? null })) });
  const bb0 = piNow(), bbs0 = fxStats();
  r = await rest("POST", "/v2/batch/scrape", { urls: Array.from({ length: 21 }, (_, i) => `${FX("m6bulk")}/bulk/p${i + 1}?bb=${nonce}`) });
  const batchId = r.json?.id;
  r = batchId ? await pollJob("batch", batchId) : r;
  await sleep(5000);
  bs1 = fxStats();
  out("bulk", { case: "batch_finished", ...brief(r), status_field: r.json?.status ?? null, documents: r.json?.data?.length ?? null, acquisitions: attempts("m6bulk.fixture.fcpi.test", bb0), hits: hitSummary(bs1.hits.slice(bbs0.hits.length).filter((h) => h.host === "m6bulk.fixture.fcpi.test")),
    holds_after: sql(`SELECT count(*) FROM fcpi_retrieval.route_hold WHERE domain = 'm6bulk.fixture.fcpi.test'`).map(Number)[0] });
  // B7: pacing across clients and routes: two tokens, direct and residential alternately, one domain with the 2 s gap.
  const p0 = piNow(), ps0 = fxStats();
  const pace = await Promise.all([
    (async () => { const o = []; for (const [i, proxy] of [[1, "basic"], [2, "stealth"], [3, "basic"]]) o.push({ client: "m6", proxy, ...brief(await scrape(`${FX("m6pace")}/static?p=${nonce}-a${i}`, { proxy }, "m6")) }); return o; })(),
    (async () => { const o = []; for (const [i, proxy] of [[1, "stealth"], [2, "basic"], [3, "stealth"]]) o.push({ client: "m6other", proxy, ...brief(await scrape(`${FX("m6pace")}/static?p=${nonce}-b${i}`, { proxy }, "m6other")) }); return o; })(),
  ]);
  const paceHits = fxStats().hits.slice(ps0.hits.length).filter((h) => h.host === "m6pace.fixture.fcpi.test");
  out("pacing", { case: "two_clients_two_routes", results: pace.flat(), hits: hitSummary(paceHits), acquisitions: attempts("m6pace.fixture.fcpi.test", p0) });
  // B10: an attempt past its byte reservation.
  a = await acquisition("m6.fixture.fcpi.test", "big", () => scrape(`${FX()}/big?z=${nonce}`, { proxy: "stealth" }));
  out("size_limit", { case: "past_reservation", ...brief(a.r), acquisitions: a.acq, tunnels: tunnelSummary(a.tunnels) });
  // B11 (F11): search with the residential fixture engine: through the provider, then refused without the route.
  const s0 = piNow(), ss0 = fxStats();
  r = await rest("POST", "/v2/search", { query: `fcpi residential ${nonce}`, limit: 5 });
  const sHits = fxStats().hits.slice(ss0.hits.length).filter((h) => h.host === "searchr.fixture.fcpi.test");
  out("search", { case: "residential_engine", ...brief(r), results: (r.json?.data?.web ?? []).map((x) => ({ url: x.url, title: x.title })), warning: r.json?.warning ?? null, hits: hitSummary(sHits),
    proxy_log: jsonLog("retrieval-service", s0).filter((l) => ["proxy_request", "proxy_tunnel_closed", "proxy_denied"].includes(l.event) && l.session === "searxng").map((l) => ({ event: l.event, method: l.method ?? null, host: l.target_host, route: l.route ?? null, failure: l.failure ?? null, provider_bytes: l.provider_bytes ?? null })) });
  // B12: reconciliation of today's fixture-proxy bytes against the fixture's usage report.
  const today = new Date().toISOString().slice(0, 10);
  out("reconcile", { case: "fixture_proxy_day", ...internal("POST", "/internal/proxy/reconcile", { provider: "fixture-proxy", day: today }), fixture_usage: fxStats().usage[today] ?? null });
  // B9: the ledger race and budget exhaustion, on the race category.
  select("fixture", MODEL, PARSER, "fcpi-fixture-proxy-race");
  const card = JSON.parse(readFileSync(join(ROOT, "deploy/policies/budget.json"), "utf8"));
  const cap = card.categories.fixture_proxy_race.caps.day, amount = Math.ceil((card.proxying.maxAttemptBytes * 4000000) / 1e9);
  const used0 = usageRows().filter((u) => u.category === "fixture_proxy_race" && u.period === "day" && u.period_start === today).reduce((n, u) => n + Number(u.reserved) + Number(u.settled), 0);
  const raceOut = race({ n: 8, prefix: `e2e-race-${nonce}-`, category: "fixture_proxy_race", provider: "fixture-proxy", subject: "fcpi-fixture-proxy-race", rateCard: "fixture/fcpi-fixture-proxy-race@2026-09-26", bytes: card.proxying.maxAttemptBytes, amount, caps: { day: cap } });
  out("budget", { case: "reservation_race", cap, amount, used_before: used0, expected_granted: Math.max(0, Math.floor((cap - used0) / amount)), ...raceOut });
  // With the category full: a stealth scrape and a bulk crawl are refused, and nothing reaches the provider or target.
  a = await acquisition("m6.fixture.fcpi.test", "exhausted", () => scrape(`${FX()}/static?q=${nonce}`, { proxy: "stealth" }));
  out("budget", { case: "exhausted_stealth", ...brief(a.r), acquisitions: a.acq, hits: hitSummary(a.hits), tunnels: a.tunnels.length });
  a = await acquisition("m6bulk.fixture.fcpi.test", "exhausted bulk", () => rest("POST", "/v2/crawl", { url: `${FX("m6bulk")}/bulk/`, limit: 40 }));
  out("budget", { case: "exhausted_bulk", ...brief(a.r), hits: hitSummary(a.hits), tunnels: a.tunnels.length });
  const rel = race({ release: raceOut.outcomes.filter((o) => o.granted).map((o) => o.id) });
  out("budget", { case: "race_released", released: rel.released });
  // B11 continued: the residential engine without the route.
  select("fixture", MODEL, PARSER, "none");
  const n0 = fxStats();
  r = await rest("POST", "/v2/search", { query: `fcpi residential none ${nonce}`, limit: 5 });
  out("search", { case: "residential_engine_no_route", ...brief(r), results: (r.json?.data?.web ?? []).length, warning: r.json?.warning ?? null, hits: hitSummary(fxStats().hits.slice(n0.hits.length).filter((h) => h.host === "searchr.fixture.fcpi.test")) });
  // B8: provider failures, then the breaker, then ordinary work beside it (AC23). Last: the breaker stays open five minutes.
  select("fixture", MODEL, PARSER, "fcpi-fixture-proxy");
  for (const m of ["407", "402", "blackhole"]) {
    fxMode(m);
    a = await acquisition("m6.fixture.fcpi.test", `mode ${m}`, () => scrape(`${FX()}/static?o=${nonce}-${m}`, { proxy: "stealth" }));
    out("outage", { case: `provider_${m}`, ...brief(a.r), acquisitions: a.acq, hits: hitSummary(a.hits) });
  }
  fxMode("ok");
  out("outage", { case: "breaker", readyz: readyz() });
  a = await acquisition("m6.fixture.fcpi.test", "after breaker", () => scrape(`${FX()}/static?o=${nonce}-after`, { proxy: "stealth" }));
  out("outage", { case: "breaker_open_refused", ...brief(a.r), acquisitions: a.acq, hits: hitSummary(a.hits), tunnels: a.tunnels.length });
  a = await acquisition("m6.fixture.fcpi.test", "isolation", () => scrape(`${FX()}/static?o=${nonce}-iso`));
  out("outage", { case: "direct_unaffected", ...brief(a.r), markdown: /directly/.test(docOf(a.r)?.markdown ?? ""), acquisitions: a.acq, hits: hitSummary(a.hits) });
  out("outage", { case: "domain_not_poisoned", route: routeRow("m6.fixture.fcpi.test") });

  // The record of the phase: the ledger, the fixture's counters, the retrieval log's acquisitions.
  out("ledger", { rows: proxyLedger(since), usage: usageRows() });
  const st = fxStats();
  out("fixture_stats", { tunnels: tunnelSummary(st.tunnels), refusals: st.refusals, usage: st.usage, hits: st.hits.length, sessions: Object.keys(st.sessions).length });
  const events = jsonLog("retrieval-service", since);
  out("retrieval_events", { acquisitions: events.filter((l) => l.event === "acquisition").map((l) => ({ attempts_used: l.attempts_used, strategies: l.strategies, initial_strategy: l.initial_strategy ?? null, final_strategy: l.final_strategy ?? null,
      route_requested: l.route_requested ?? null, route_start: l.route_start ?? null, route_reason: l.route_reason ?? null, failure: l.failure, proxy_bytes: l.proxy_bytes ?? null, proxy_states: l.proxy_states ?? null })),
    fetches: events.filter((l) => l.event === "fetch").map((l) => ({ purpose: l.purpose, strategy: l.strategy ?? null, route_reason: l.route_reason ?? null })),
    other: events.filter((l) => ["route_held", "route_released", "route_hold_refused", "proxy_reconciled", "budget_notice", "selection_loaded"].includes(l.event)).map((l) => ({ event: l.event, reason: l.reason ?? null, proxy: l.proxy ?? undefined })) });
  resources("fixture-end");
  out("connections", { hosts: [...new Set(seen)].sort(), lookups: [...new Set(looked)].filter((h) => h !== "localhost").sort() });
  out("meta_end", { pi_utc: piNow() });
}

// ---- the live phase (held until the review is addressed) ---------------------------------------------------
async function livePhase(before) {
  const since = piNow();
  const status = (await rest("GET", "/platform/v1/status")).json?.providers ?? {};
  out("meta", { phase, pi_utc: since, deployed_commit: pi("cat /opt/firecrawl-pi/.fcpi-source-commit").trim(), selection_before: before, providers: status });
  const decodo = status.providers?.decodo ?? null;
  const cap = status.caps?.proxy?.caps ?? null;
  const liveProxy = decodo?.credential === "present" && status.paidDispatch === true && (cap?.day ?? 0) > 0 && (cap?.month ?? 0) > 0;
  if (!liveProxy) {
    out("live_egress", { case: "blocked", credential: decodo?.credential ?? null, paidDispatch: status.paidDispatch ?? null, proxyCaps: cap, reason: "no Decodo credential with an approved budget and paid dispatch; no live proxy request was made" });
    out("live_search", { case: "blocked", reason: "the residential engines need the live proxy" });
  } else {
    select(before.search, before.extractionModel, before.parser, "decodo-residential");
    const echo = "https://api.ipify.org/?format=json";
    const d = await scrape(echo, { proxy: "basic", formats: ["rawHtml"] });
    const p = await scrape(`${echo}&r=1`, { proxy: "stealth", formats: ["rawHtml"] });
    const ip = (r) => { try { return JSON.parse((docOf(r)?.rawHtml ?? "").replace(/<[^>]+>/g, "")).ip; } catch { return null; } };
    out("live_egress", { case: "direct_vs_proxied", direct: brief(d), proxied: brief(p), direct_ip_sha256: ip(d) ? sha(ip(d)) : null, proxied_ip_sha256: ip(p) ? sha(ip(p)) : null, differ: !!ip(d) && !!ip(p) && ip(d) !== ip(p), proxyUsed: docOf(p)?.metadata?.proxyUsed ?? null });
    select("live", before.extractionModel, before.parser, "decodo-residential");
    const s = await rest("POST", "/v2/search", { query: "Raspberry Pi 5 official product brief", limit: 5 });
    out("live_search", { case: "residential_engines", ...brief(s), results: (s.json?.data?.web ?? []).length, warning: s.json?.warning ?? null,
      proxy_log: jsonLog("retrieval-service", since).filter((l) => ["proxy_request", "proxy_denied"].includes(l.event) && l.session === "searxng").map((l) => ({ event: l.event, host: l.target_host, route: l.route ?? null, failure: l.failure ?? null })) });
    out("ledger", { rows: proxyLedger(since), usage: usageRows() });
  }
  out("connections", { hosts: [...new Set(seen)].sort(), lookups: [...new Set(looked)].filter((h) => h !== "localhost").sort() });
  out("meta_end", { pi_utc: piNow() });
}

let exit = 0, before = null;
try {
  await openTunnel();
  before = selection();
  await (phase === "fixture" ? fixturePhase(before) : livePhase(before));
} catch (e) {
  exit = 1;
  out("error", { message: e.message, stack: String(e.stack ?? "").split("\n").slice(0, 4).join(" | ") });
} finally {
  // The fixture proxy back to ok and the selection found at the start restored, whatever happened.
  try { fxMode("ok"); } catch { /* fixture unreachable */ }
  // A selection written before M6 has no proxy key, which means the budget policy's default.
  const proxyBefore = (b) => (b.proxy === undefined ? JSON.parse(readFileSync(join(ROOT, "deploy/policies/budget.json"), "utf8")).proxying.defaultProxy : b.proxy ?? "none");
  try { if (before) select(before.search, before.extractionModel, before.parser, proxyBefore(before)); } catch (e) { out("error", { message: `restoring the selection: ${e.message}` }); exit = 1; }
  tunnel?.kill();
  out("end", { exit, selection_after: (() => { try { return selection(); } catch { return null; } })() });
  process.exitCode = exit;
}
