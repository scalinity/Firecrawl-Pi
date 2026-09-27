#!/usr/bin/env node
// M7's evidence driver (docs/FIRECRAWL_PI_MILESTONES.md, M7 "Automated Verification"). It runs on the workstation and
// reaches the gateway as agents do, through an SSH forward of its loopback publication (127.0.0.1:3380); actions on the
// Pi (the host selection, the fixtures' modes and counters, the ledgers, the browser worker's processes) run over SSH. It
// prints sectioned JSON lines; scripts/m7/verify.mjs recomputes every verdict from them. Captured screenshots are saved
// under evidence/M7/raw/artifacts/ so the verifier decodes them itself.
//   node scripts/m7/e2e.mjs fixture > evidence/M7/raw/e2e-fixture.txt
//   node scripts/m7/e2e.mjs live    > evidence/M7/raw/e2e-live.txt     (held until the review is addressed)
// fixture: every controlled case against fixture-m7's enhanced provider, targets and receiver (and fixture-m6's proxy,
// M5's parser), with no public egress: first the production selection (Zyte, whose key is absent, paid dispatch off),
// then the fixture enhancer, then the fixture proxy and enhancer together. live: the live enhanced request, only with a
// Zyte key and an approved budget (otherwise its state is recorded and nothing is sent), and the declared public sample
// on the tiers this deployment may use. The selection found at the start is restored at the end. Tokens come over SSH
// into memory; none is printed.
import { execFileSync, spawn } from "node:child_process";
import { request } from "node:http";
import net, { connect } from "node:net";
import dns from "node:dns";
import { createHash, randomUUID } from "node:crypto";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");
const phase = process.argv[2];
if (!["fixture", "live"].includes(phase)) { console.error("usage: e2e.mjs fixture|live"); process.exit(2); }
const EV = process.env.FCPI_M7_EVIDENCE ?? "evidence/M7/";
const T = Object.fromEntries(readFileSync(join(ROOT, "scripts/m1/pi-target.conf"), "utf8").split("\n").filter((l) => /^PI_\w+=/.test(l)).map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1).replace("$HOME", process.env.HOME)]));
const SSH = ["-i", T.PI_SSH_KEY, "-o", "IdentitiesOnly=yes", "-o", "BatchMode=yes", "-o", "ConnectTimeout=15"];
const HOST = "127.0.0.1:3380";
const FX = (h = "m7esc") => `http://${h}.fixture.fcpi.test:8080`;
const MODERN = "2026-07-28";
const META = { "io.modelcontextprotocol/protocolVersion": MODERN, "io.modelcontextprotocol/clientCapabilities": {}, "io.modelcontextprotocol/clientInfo": { name: "fcpi-m7-e2e", version: "1" } };
const MODEL = "gpt-4.1-mini-2025-04-14", PARSER = "llamaparse-cost-effective";
const BUDGET = JSON.parse(readFileSync(join(ROOT, "deploy/policies/budget.json"), "utf8"));
const MANIFEST = JSON.parse(readFileSync(join(ROOT, "deploy/policies/capabilities.json"), "utf8"));
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
const psqlSet = (vars) => Object.entries(vars).map(([k, v]) => `\\set ${k} '${String(v).replace(/\\/g, "\\\\").replace(/'/g, "''")}'\n`).join("");
const sql = (q, vars = {}) => pi(`sudo -n docker exec -i ${cname("nuq-postgres")} psql -U postgres -d postgres -q -At -X -v ON_ERROR_STOP=1`, psqlSet(vars) + q).trim().split("\n").filter(Boolean);
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
function select(search, model, parser, proxy, enhanced) {
  const r = pi(`bash /opt/firecrawl-pi/scripts/m5/pi-selection.sh ${search} ${model} ${parser} ${proxy} ${enhanced}`).trim();
  const applied = /^selection applied/.test(r);
  out("selection", { search, model, parser, proxy, enhanced, applied });
  return applied;
}
// A fixture's control port, inside its container (the only place it is served).
const ctl = (svc, method, path) => JSON.parse(D(`exec ${cname(svc)} node -e "fetch('http://127.0.0.1:8082${path}',{method:'${method}'}).then(r=>r.text()).then(t=>process.stdout.write(t))"`));
const fx7 = (method, path) => ctl("fixture-m7", method, path);
const fx7Stats = () => fx7("GET", "/__stats");
const fx6Stats = () => ctl("fixture-m6", "GET", "/__stats");
const zyteMode = (m) => fx7("POST", `/__mode?m=${m}`);
const m5Stats = () => JSON.parse(D(`exec ${cname("fixture-m5")} node -e "fetch('http://127.0.0.1:8080/__stats/all').then(r=>r.text()).then(t=>process.stdout.write(t))"`));
const readyz = () => JSON.parse(D(`exec ${cname("retrieval-service")} node -e "fetch('http://10.231.5.10:3310/readyz').then(r=>r.text()).then(t=>process.stdout.write(t))"`));
const INTERNAL = `const fs=require("fs");let b="";process.stdin.on("data",c=>b+=c).on("end",async()=>{const t=fs.readFileSync("/run/secrets/gateway_retrieval_token","utf8").trim();const x=JSON.parse(b);const r=await fetch("http://10.231.9.20:3314"+x.path,{method:x.method,headers:{authorization:"Bearer "+t,"content-type":"application/json"},body:x.body?JSON.stringify(x.body):undefined});process.stdout.write(JSON.stringify({status:r.status,json:await r.json().catch(()=>null)}));});`;
const internal = (method, path, body) => JSON.parse(pi(`sudo -n docker exec -i ${cname("access-gateway")} node -e '${INTERNAL}'`, JSON.stringify({ method, path, body })));
// Reservations against the deployed ledger inside the retrieval service's container, as M6's race made them: n at once
// in one category (here the small enhanced one), or the release of the ones granted.
const RACE = `import { Store } from "/srv/retrieval/src/store.mjs"; import { readFileSync } from "node:fs"; import { randomUUID } from "node:crypto";
let b = ""; for await (const c of process.stdin) b += c; const x = JSON.parse(b);
const store = new Store({ host: process.env.PI_POSTGRES_HOST, database: process.env.PI_POSTGRES_DB, user: process.env.PI_POSTGRES_USER, password: readFileSync("/run/secrets/retrieval_postgres_password", "utf8").trim() });
const day = new Date().toISOString().slice(0, 10), month = day.slice(0, 7) + "-01";
const one = (i) => store.reserveBudget({ id: randomUUID(), callKey: x.prefix + i, logicalId: x.prefix + i, category: x.category, provider: x.provider, subject: x.subject, kind: "enhanced", unit: "micro_usd", rateCard: x.rateCard, requestHash: "e2e", amount: x.amount, caps: x.caps, paidTotalCap: null, paidTotalRate: 1, day, month, notifyAt: 0.8 });
const rs = x.release ? [] : await Promise.all(Array.from({ length: x.n }, (_, i) => one(i)));
const released = [];
if (x.release) for (const id of x.release) released.push(!!(await store.releaseBudget(id, "e2e race reservation, released")));
process.stdout.write(JSON.stringify({ outcomes: rs.map((r) => r.reservation ? { granted: true, id: r.reservation.id } : r.exhausted ? { granted: false, exhausted: r.exhausted } : { granted: false, other: true }), released }));
await store.close();`;
const race = (x) => JSON.parse(pi(`sudo -n docker exec -i ${cname("retrieval-service")} node --input-type=module -e '${RACE.replace(/'/g, "'\\''")}'`, JSON.stringify(x)));
const attempts = (domain, since) => sql(`SELECT row_to_json(r) FROM (SELECT logical_id, array_agg(strategy ORDER BY ordinal) AS strategies, array_agg(outcome ORDER BY ordinal) AS outcomes,
  array_agg(target_status ORDER BY ordinal) AS statuses, min(started_at) AS started FROM fcpi_retrieval.attempt WHERE domain = :'domain' AND started_at >= :'since' GROUP BY logical_id ORDER BY min(started_at)) r`, { domain, since }).map((l) => JSON.parse(l));
const enhancedLedger = (since) => sql(`SELECT row_to_json(r) FROM (SELECT call_key, logical_id, category, provider, subject, rate_card, reserved, actual, state, usage, detail, result IS NOT NULL AS kept, created_at FROM fcpi_retrieval.budget_reservation WHERE kind = 'enhanced' AND created_at >= :'since' ORDER BY created_at) r`, { since }).map((l) => JSON.parse(l));
const usageRows = () => sql(`SELECT row_to_json(u) FROM (SELECT category, period, period_start::text, reserved, settled FROM fcpi_retrieval.budget_usage WHERE period_start >= (now() at time zone 'utc')::date - 31 AND category IN ('enhanced', 'fixture_enhanced', 'fixture_enhanced_small', '_paid_total') ORDER BY 1, 2, 3) u`).map((l) => JSON.parse(l));
const routeRow = (domain) => { const r = sql(`SELECT row_to_json(d) FROM (SELECT preferred, challenges, failures, last_failure_class FROM fcpi_retrieval.domain_route WHERE domain = :'domain') d`, { domain }); return r.length ? JSON.parse(r[0]) : null; };
const resources = (label) => { try { out("resources", JSON.parse(pi(`bash /opt/firecrawl-pi/scripts/m7/pi-resources.sh ${label}`))); } catch (e) { out("error", { message: `resources ${label}: ${e.message}` }); } };
const chrome = () => { const b = cname("browser-worker"); return { processes: +D(`exec --user 3320 ${b} sh -c 'pgrep -c -f [c]hrome-headless-shell || true'`).trim(), health: JSON.parse(D(`exec ${b} node -e "fetch('http://10.231.2.20:3320/healthz').then(r=>r.text()).then(t=>process.stdout.write(t))"`)) }; };

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
function http(method, path, { tok = "m7", body, headers = {}, timeoutMs = 200000, raw = false } = {}) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
    const req = request({ host: "127.0.0.1", port: 3380, method, path, agent: false, timeout: timeoutMs,
      headers: { host: HOST, accept: "application/json, text/event-stream", ...(tok ? { authorization: `Bearer ${token(tok)}` } : {}), ...(data ? { "content-type": "application/json", "content-length": data.length } : {}), ...headers } }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => {
        const buf = Buffer.concat(chunks), text = raw ? "" : buf.toString();
        let json = null;
        const sse = /text\/event-stream/.test(res.headers["content-type"] ?? "");
        if (!raw) { try { json = sse ? JSON.parse(text.split("\n").filter((l) => l.startsWith("data: ")).at(-1).slice(6)) : JSON.parse(text); } catch { /* not JSON */ } }
        resolve({ status: res.statusCode, headers: res.headers, json, bytes: buf.length, ...(raw ? { buf } : {}) });
      });
    });
    req.on("timeout", () => req.destroy(new Error("timeout")));
    req.on("error", reject);
    req.end(data);
  });
}
const rest = (method, path, body, o = {}) => http(method, path, { ...o, body });
const classOf = (r) => (/Retrieval failed: ([A-Z_]+)\./.exec(r.json?.error ?? "") ?? [])[1] ?? r.json?.code ?? null;
const brief = (r) => ({ status: r.status, code: r.json?.code ?? null, class: classOf(r), error: typeof r.json?.error === "string" ? r.json.error.slice(0, 300) : null,
  success: r.json?.success ?? null, cache: r.headers?.["x-fcpi-cache"] ?? null, ...(r.headers?.["retry-after"] ? { retryAfter: r.headers["retry-after"] } : {}) });
const docOf = (r) => r.json?.data ?? null;
const scrape = (url, extra = {}, tok = "m7") => rest("POST", "/v2/scrape", { url, formats: ["markdown"], ...extra }, { tok });
const pathOf = (u) => new URL(u).pathname;
async function pollJob(kind, id, tok = "m7", ms = 600000) {
  const end = Date.now() + ms;
  for (;;) {
    const r = await rest("GET", `/v2/${kind === "batch" ? "batch/scrape" : "crawl"}/${id}`, undefined, { tok });
    if (r.status !== 200 || ["completed", "failed", "cancelled"].includes(r.json?.status) || Date.now() > end) return r;
    await sleep(3000);
  }
}
async function mcp(method, params, tok = "m7") {
  const r = await http("POST", "/mcp", { tok, headers: { "mcp-protocol-version": MODERN, "mcp-method": method, ...(method === "tools/call" ? { "mcp-name": params.name } : {}) },
    body: { jsonrpc: "2.0", id: 1, method, params: { ...params, _meta: META } } });
  return r;
}
// The case's hits on fixture-m7's targets, its provider calls, its receiver deliveries and its attempts on one domain.
async function acquisition(domain, fn) {
  const t0 = piNow(), s0 = fx7Stats(), t60 = fx6Stats().tunnels.length;
  const r = await fn();
  const s1 = fx7Stats();
  return { r, acq: attempts(domain, t0), hits: s1.hits.slice(s0.hits.length), calls: s1.calls.slice(s0.calls.length), tunnels: fx6Stats().tunnels.length - t60, t0 };
}
const hitSummary = (hits) => hits.map((h) => ({ host: h.host, path: h.path, via: h.via }));
const callSummary = (cs) => cs.map((c) => ({ url: c.url ? pathOf(c.url) : null, kind: c.kind, status: c.status, mode: c.mode }));
const clearRoutes = (like) => sql(`WITH r AS (DELETE FROM fcpi_retrieval.domain_route WHERE domain LIKE :'like' RETURNING 1), s AS (DELETE FROM fcpi_retrieval.domain_state WHERE domain LIKE :'like' RETURNING 1),
  n AS (DELETE FROM fcpi_retrieval.direct_nav WHERE domain LIKE :'like' RETURNING 1) SELECT (SELECT count(*) FROM r) || ' ' || (SELECT count(*) FROM s) || ' ' || (SELECT count(*) FROM n)`, { like })[0];
// A capture saved beside the evidence, named by its hash, for the verifier to decode.
function saveArtifact(buf) {
  const dir = join(ROOT, EV, "raw/artifacts");
  mkdirSync(dir, { recursive: true });
  const name = `${sha(buf)}.png`;
  writeFileSync(join(dir, name), buf);
  return `raw/artifacts/${name}`;
}
async function fetchArtifact(url, tok = "m7") {
  const r = await http("GET", new URL(url).pathname, { tok, raw: true });
  const h = r.headers;
  return { status: r.status, mime: h["content-type"] ?? null, width: h["x-fcpi-width"] ?? null, height: h["x-fcpi-height"] ?? null, truncated: h["x-fcpi-truncated"] ?? null,
    bytes: r.bytes, sha256: r.status === 200 ? sha(r.buf) : null, saved: r.status === 200 && r.bytes < 8 * 1048576 ? saveArtifact(r.buf) : null, head_hex: r.status === 200 ? r.buf.subarray(0, 33).toString("hex") : null };
}

// ---- the fixture phase ---------------------------------------------------------------------------------------
async function fixturePhase(before) {
  const since = piNow();
  out("meta", { phase, pi_utc: since, deployed_commit: pi("cat /opt/firecrawl-pi/.fcpi-source-commit").trim(), selection_before: before });
  out("reset", { routes: clearRoutes("m7%.fixture.fcpi.test"), fixture_m7: fx7("POST", "/__reset"), fixture_m6: ctl("fixture-m6", "POST", "/__reset") });
  resources("fixture-start");
  const nonce = randomUUID().slice(0, 8);
  // The catalog: the scrape tool's schema carries the enhanced proxy, the action subset, the screenshot format, the cache.
  const cat = await mcp("tools/list", {});
  const tools = cat.json?.result?.tools ?? [];
  const st = tools.find((t) => t.name === "firecrawl_scrape")?.inputSchema?.properties ?? {};
  out("mcp_catalog", { status: cat.status, tools: tools.map((t) => t.name), sha256: sha(JSON.stringify(tools)), scrape_proxy_enum: st.proxy?.enum ?? null,
    scrape_actions: (st.actions?.items?.anyOf ?? []).map((a) => a.properties?.type?.const), scrape_max_age: st.maxAge?.maximum ?? null,
    crawl_webhook_events: tools.find((t) => t.name === "firecrawl_crawl")?.inputSchema?.properties?.webhook?.properties?.events?.items?.enum ?? null });

  // ---- A: the production selection: Zyte without a key and paid dispatch off. Nothing is sent; ordinary work goes on.
  select("fixture", MODEL, PARSER, "decodo-residential", "zyte-api");
  out("production", { case: "tier_state", readyz: readyz().enhanced, routes: internal("GET", "/internal/routes").json?.enhanced ?? null,
    provider: (await rest("GET", "/platform/v1/status")).json?.providers?.providers?.zyte ?? null });
  let a = await acquisition("m7esc.fixture.fcpi.test", () => scrape(`${FX()}/article?a=${nonce}`, { proxy: "enhanced" }));
  out("production", { case: "enhanced_required", ...brief(a.r), acquisitions: a.acq, hits: hitSummary(a.hits), calls: callSummary(a.calls) });
  a = await acquisition("m7esc.fixture.fcpi.test", () => scrape(`${FX()}/tough?a=${nonce}`));
  out("production", { case: "auto_blocked_no_tier", ...brief(a.r), acquisitions: a.acq, hits: hitSummary(a.hits), calls: callSummary(a.calls), tunnels: a.tunnels });
  a = await acquisition("m7esc.fixture.fcpi.test", () => scrape(`${FX()}/article?c=${nonce}`));
  out("production", { case: "direct_control", ...brief(a.r), markdown: /by the direct route/.test(docOf(a.r)?.markdown ?? ""), acquisitions: a.acq, hits: hitSummary(a.hits) });

  // ---- B: the fixture enhancer alone (no residential route): the tier, its answers and the target's outcomes.
  select("fixture", MODEL, PARSER, "none", "fcpi-fixture-zyte");
  out("enhanced", { case: "tier_state", readyz: readyz().enhanced });
  const esc = async (c, path, extra = {}, host = "m7esc") => {
    clearRoutes(`${host}.fixture.fcpi.test`);
    const x = await acquisition(`${host}.fixture.fcpi.test`, () => scrape(`${FX(host)}${path}${path.includes("?") ? "&" : "?"}e=${nonce}`, extra));
    out("enhanced", { case: c, ...brief(x.r), markdown: (docOf(x.r)?.markdown ?? "").slice(0, 200), statusCode: docOf(x.r)?.metadata?.statusCode ?? null, proxyUsed: docOf(x.r)?.metadata?.proxyUsed ?? null,
      acquisitions: x.acq, hits: hitSummary(x.hits), calls: callSummary(x.calls), tunnels: x.tunnels });
    return x;
  };
  await esc("auto_403_to_enhanced", "/tough");
  await esc("auto_200_to_enhanced", "/tough200");
  await esc("auto_js_to_enhanced_browser", "/js-tough");
  await esc("route_enhanced_alone", "/article", { proxy: "enhanced" });
  await esc("enhanced_also_challenged", "/never");
  await esc("target_404", "/gone", { proxy: "enhanced" });
  await esc("target_401", "/login", { proxy: "enhanced" });
  await esc("target_429", "/slow-down", { proxy: "enhanced" }, "m7");
  a = await acquisition("m7.fixture.fcpi.test", () => scrape(`${FX("m7")}/article?cool=${nonce}`, { proxy: "basic" }));
  out("enhanced", { case: "cooldown_all_routes", ...brief(a.r), acquisitions: a.acq, hits: hitSummary(a.hits), domain_state: sql("SELECT row_to_json(s) FROM (SELECT cooldown_s, round(extract(epoch FROM cooldown_until - now()))::int AS remaining_s FROM fcpi_retrieval.domain_state WHERE domain = 'm7.fixture.fcpi.test') s").map((l) => JSON.parse(l))[0] ?? null });
  await esc("final_url_refused", "/redirect-out", { proxy: "enhanced" }, "m7cache");

  // ---- C: the fixture proxy and the fixture enhancer: the whole waterfall.
  select("fixture", MODEL, PARSER, "fcpi-fixture-proxy", "fcpi-fixture-zyte");
  await esc("waterfall_http", "/tough");
  await esc("waterfall_browser_four_attempts", "/js-tough");
  await esc("stealth_stops_at_residential", "/tough", { proxy: "stealth" });

  // ---- D: screenshots and actions (on m7shot, the enhancer selected, no residential route needed).
  select("fixture", MODEL, PARSER, "none", "fcpi-fixture-zyte");
  const shot = async (c, path, body, tok = "m7") => {
    const x = await acquisition("m7shot.fixture.fcpi.test", () => rest("POST", "/v2/scrape", { url: `${FX("m7shot")}${path}`, ...body }, { tok }));
    const d = docOf(x.r), arts = x.r.json?.fcpi?.artifacts ?? [];
    const fetched = [];
    for (const art of arts) fetched.push({ url: art.url, meta: art, fetched: await fetchArtifact(art.url, tok) });
    out("extras", { case: c, ...brief(x.r), screenshot: d?.screenshot ?? null, action_screenshots: d?.actions?.screenshots ?? null,
      scrapes: (d?.actions?.scrapes ?? []).map((s) => ({ url: s.url, has_click_text: /Expanded section text revealed by the click/.test(s.html), has_late: /Late element arrived\./.test(s.html), has_scrolled: /Content loaded on scroll\./.test(s.html), chars: s.html.length })),
      markdown: (d?.markdown ?? "").slice(0, 120), artifacts: fetched, acquisitions: x.acq, hits: hitSummary(x.hits), calls: callSummary(x.calls) });
    return { x, fetched };
  };
  await shot("viewport", "/bands", { formats: ["markdown", "screenshot"] });
  await shot("full_page", `/bands?f=${nonce}`, { formats: ["markdown", { type: "screenshot", fullPage: true }] });
  const tall = await shot("full_page_clipped", `/tall?f=${nonce}`, { formats: ["markdown", { type: "screenshot", fullPage: true }] });
  await shot("actions", `/actions?f=${nonce}`, { formats: ["markdown"], actions: [{ type: "wait", selector: "#arrived" }, { type: "click", selector: "#more" }, { type: "scroll", direction: "down" }, { type: "scrape" }, { type: "screenshot" }] });
  // The extras bound, measured (review W10): two captures of incompressible pixels just under the worker's 8 MiB, and one
  // just over it, refused as a resource limit with nothing crossing to the core.
  await shot("noise_worst_case", `/noise?h=1150&f=${nonce}`, { formats: ["markdown", { type: "screenshot", fullPage: true }], actions: [{ type: "screenshot" }] });
  resources("extras-worst-case");
  await shot("noise_over_limit", `/noise?h=2400&f=${nonce}`, { formats: ["markdown", { type: "screenshot", fullPage: true }] });
  await shot("samehost_click", `/samehost?f=${nonce}`, { formats: ["markdown"], actions: [{ type: "click", selector: "#next" }, { type: "wait", milliseconds: 500 }, { type: "scrape" }] });
  await shot("offhost_click", `/offhost?f=${nonce}`, { formats: ["markdown"], actions: [{ type: "click", selector: "#away" }, { type: "scrape" }] });
  // Refused before any work: outside the subset, past its bounds.
  for (const [c, body] of [["execute_javascript", { actions: [{ type: "executeJavascript", script: "1" }] }], ["write", { actions: [{ type: "write", text: "x" }] }], ["press", { actions: [{ type: "press", key: "Enter" }] }],
    ["pdf", { actions: [{ type: "pdf" }] }], ["click_all", { actions: [{ type: "click", selector: "a", all: true }] }], ["eleven_actions", { actions: Array.from({ length: 11 }, () => ({ type: "scroll" })) }],
    ["waits_past_15s", { actions: [{ type: "wait", milliseconds: 9000 }, { type: "wait", milliseconds: 7000 }] }], ["screenshot_quality", { formats: [{ type: "screenshot", quality: 80 }] }],
    ["json_with_screenshot", { formats: [{ type: "json", schema: { type: "object", properties: { title: { type: "string" } } } }, "screenshot"] }],
    ["screenshot_on_batch", null]]) {
    const x = await acquisition("m7shot.fixture.fcpi.test", () => (body ? rest("POST", "/v2/scrape", { url: `${FX("m7shot")}/bands?r=${c}`, ...body })
      : rest("POST", "/v2/batch/scrape", { urls: [`${FX("m7shot")}/bands?r=${c}`], formats: ["screenshot"] })));
    out("extras_refused", { case: c, ...brief(x.r), option: x.r.json?.option ?? null, acquisitions: x.acq, hits: hitSummary(x.hits) });
  }
  // The residential route renders extras too, every request through the proxy.
  select("fixture", MODEL, PARSER, "fcpi-fixture-proxy", "fcpi-fixture-zyte");
  await shot("residential_screenshot", `/bands?res=${nonce}`, { formats: ["markdown", "screenshot"], proxy: "stealth" });
  select("fixture", MODEL, PARSER, "none", "fcpi-fixture-zyte");
  // Artifacts belong to their principal and their retention.
  const artUrl = tall.fetched[0]?.url ?? null;
  if (artUrl) {
    const p = new URL(artUrl).pathname, id = p.split("/").pop();
    const other = await http("GET", p, { tok: "m7other" }), none = await http("GET", p, { tok: null }), unknown = await http("GET", `/platform/v1/artifacts/${randomUUID()}`), badId = await http("GET", "/platform/v1/artifacts/not-a-uuid");
    sql("UPDATE fcpi_platform.artifact SET expires_at = now() - interval '1 second' WHERE id = :'id'", { id });
    const expired = await http("GET", p);
    out("artifact_access", { case: "owner_and_expiry", owner_before: tall.fetched[0].fetched.status, other: other.status, other_body: other.json, none: none.status, unknown: unknown.status, bad_id: badId.status, expired: expired.status, expired_code: expired.json?.code ?? null });
  } else out("artifact_access", { case: "owner_and_expiry", error: "no artifact to test" });
  // Through MCP: a screenshot comes back as the artifact's address.
  const m = await mcp("tools/call", { name: "firecrawl_scrape", arguments: { url: `${FX("m7shot")}/bands?mcp=${nonce}`, formats: ["markdown", { type: "screenshot" }] } });
  const text = m.json?.result?.content?.[0]?.text ?? "";
  out("extras", { case: "mcp_screenshot", status: m.status, is_error: m.json?.result?.isError ?? null, artifact_urls: [...new Set(text.match(/https?:\/\/[^"\s]+\/platform\/v1\/artifacts\/[0-9a-f-]{36}/g) ?? [])], has_data_url: /data:image\/png/.test(text) });
  // Contexts and processes: after successes, a timeout and a crash, the worker is idle and its Chromium count back to its baseline.
  const c0 = chrome();
  const t = await acquisition("m2.fixture.fcpi.test", () => rest("POST", "/v2/scrape", { url: `http://m2.fixture.fcpi.test:8080/js-hold.html?t=${nonce}`, formats: ["markdown"], waitFor: 15000, actions: [{ type: "wait", milliseconds: 15000 }] }));
  await sleep(3000);
  const c1 = chrome();
  // Caught here, so a failed kill is recorded, never an unhandled rejection that would skip the driver's restoring finally.
  const killer = (async () => { await sleep(8000); const n = D(`exec --user 3320 ${cname("browser-worker")} sh -c 'pgrep -c -f [c]hrome-headless-shell || true'`).trim(); D(`exec --user 3320 ${cname("browser-worker")} sh -c 'pkill -KILL -f [c]hrome-headless-shell || true'`); return +n; })().catch((e) => ({ error: e.message.split("\n")[0] }));
  const k = await acquisition("m2.fixture.fcpi.test", () => rest("POST", "/v2/scrape", { url: `http://m2.fixture.fcpi.test:8080/js-hold.html?k=${nonce}`, formats: ["markdown", "screenshot"] }));
  const killed = await killer;
  await sleep(3000);
  const c2 = chrome();
  const after = await acquisition("m7shot.fixture.fcpi.test", () => rest("POST", "/v2/scrape", { url: `${FX("m7shot")}/bands?after=${nonce}`, formats: ["markdown", "screenshot"] }));
  await sleep(2000);
  out("cleanup", { case: "timeout_crash_success", before: c0, timeout: { ...brief(t.r), acquisitions: t.acq }, after_timeout: c1, crash: { ...brief(k.r), acquisitions: k.acq, killed_processes: killed }, after_crash: c2,
    next_render: { ...brief(after.r), artifacts: (after.r.json?.fcpi?.artifacts ?? []).length }, final: chrome(),
    worker_log: jsonLog("browser-worker", t.t0).filter((l) => ["render", "browser_retired", "browser_launched", "browser_disconnected"].includes(l.event)).map((l) => ({ event: l.event, ok: l.ok ?? null, failure: l.failure ?? null, reason: l.reason ?? null, killed: l.killed ?? null })) });

  // ---- E: the scrape cache (m7cache).
  const cacheAt = (path) => `${FX("m7cache")}${path}`;
  const cc = async (c, url, extra, tok = "m7") => {
    const x = await acquisition("m7cache.fixture.fcpi.test", () => scrape(url, extra, tok));
    out("cache", { case: c, ...brief(x.r), cacheState: docOf(x.r)?.metadata?.cacheState ?? null, statusCode: docOf(x.r)?.metadata?.statusCode ?? null, acquisitions: x.acq.length, hits: x.hits.length, calls: x.calls.length });
  };
  const u = cacheAt(`/cached?c=${nonce}`);
  await cc("first_miss_stored", u, { maxAge: 600000 });
  await sleep(1500);
  await cc("hit", u, { maxAge: 600000 });
  await cc("other_principal_miss", u, { maxAge: 600000 }, "m7other");
  await cc("other_options_miss", u, { maxAge: 600000, formats: ["html"] });
  await cc("max_age_zero_miss", u, {});
  // A plain scrape, asking nothing of the cache, stores nothing (review S3): a later read of it misses.
  await cc("plain_first", cacheAt(`/cached?p=${nonce}`), {});
  await sleep(1500);
  await cc("plain_not_kept", cacheAt(`/cached?p=${nonce}`), { maxAge: 600000 });
  await cc("store_false_first", cacheAt(`/cached?s=${nonce}`), { storeInCache: false });
  await cc("store_false_not_kept", cacheAt(`/cached?s=${nonce}`), { maxAge: 600000 });
  await cc("error_500_first", cacheAt(`/err500?c=${nonce}`), { storeInCache: true });
  await sleep(1500);
  await cc("error_500_not_kept", cacheAt(`/err500?c=${nonce}`), { maxAge: 600000 });
  await cc("error_404_first", cacheAt(`/err404?c=${nonce}`), { storeInCache: true });
  await sleep(1500);
  await cc("error_404_not_kept", cacheAt(`/err404?c=${nonce}`), { maxAge: 600000 });
  sql("UPDATE fcpi_platform.page_cache SET expires_at = now() - interval '1 second' WHERE principal = 'm7'");
  await cc("expired_miss", u, { maxAge: 600000 });
  // A cached enhanced answer costs nothing again.
  const eu = cacheAt(`/cached?enh=${nonce}`), led0 = enhancedLedger(since).length;
  await cc("enhanced_first", eu, { proxy: "enhanced", storeInCache: true });
  await sleep(1500);
  await cc("enhanced_hit", eu, { proxy: "enhanced", maxAge: 600000 });
  out("cache", { case: "enhanced_ledger", rows_before: led0, rows_after: enhancedLedger(since).length });

  // ---- F: the parse cache is owner-scoped (M5 review S1).
  select("fixture", "fcpi-fixture-model", "fcpi-fixture-parser", "none", "fcpi-fixture-zyte");
  const cleared = +sql("WITH d AS (DELETE FROM fcpi_retrieval.parse_cache WHERE parser = 'fcpi-fixture-parser' RETURNING 1) SELECT count(*) FROM d")[0];
  const up0 = m5Stats().parser.uploads;
  const pdf = (tok) => scrape("http://m5.fixture.fcpi.test:8080/docs/scan.pdf", {}, tok);
  const p1 = await pdf("m7"), up1 = m5Stats().parser.uploads, p2 = await pdf("m7"), up2 = m5Stats().parser.uploads, p3 = await pdf("m7other"), up3 = m5Stats().parser.uploads;
  out("parse_cache", { case: "owner_scoped", cleared, uploads: [up0, up1, up2, up3], results: [p1, p2, p3].map((r) => ({ ...brief(r), text: /FCPI SCAN 42/.test(docOf(r)?.markdown ?? "") })),
    rows: sql("SELECT row_to_json(p) FROM (SELECT owner, parser, pages FROM fcpi_retrieval.parse_cache WHERE parser = 'fcpi-fixture-parser' ORDER BY created_at) p").map((l) => JSON.parse(l)),
    parse_log: jsonLog("retrieval-service", since).filter((l) => l.event === "parse").map((l) => ({ cached: l.cached ?? false, outcome: l.outcome ?? null })) });
  select("fixture", MODEL, PARSER, "none", "fcpi-fixture-zyte");

  // ---- G: changes (m7chg).
  const chg = async (c, tok = "m7", path = "/doc") => {
    const r = await rest("POST", "/platform/v1/changes", { url: `${FX("m7chg")}${path}?n=${nonce}` }, { tok });
    out("changes", { case: c, status: r.status, code: r.json?.code ?? null, changeStatus: r.json?.changeStatus ?? null, contentSha256: r.json?.contentSha256 ?? null, previousContentSha256: r.json?.previousContentSha256 ?? null,
      diff: r.json?.diff ?? null, error: r.json?.error?.slice(0, 200) ?? null });
  };
  const ver = (v) => fx7("POST", `/__version?path=/doc&v=${v}`);
  ver(1); await chg("first_new"); await chg("unchanged_same");
  ver(2); await chg("text_changed");
  ver(0); await chg("error_page_not_compared");
  ver(-1); await chg("challenge_not_compared");
  ver(2); await chg("after_failures_same");
  ver(3); await chg("changed_again");
  await chg("other_principal_new", "m7other");

  // ---- H: webhooks (the receiver on hooks.fixture.fcpi.test).
  const HOOK = "http://hooks.fixture.fcpi.test:8080/receive";
  const recv = () => fx7Stats().hooks;
  const hooksOf = async (id) => (await rest("GET", `/platform/v1/jobs/${id}`)).json?.job?.webhooks ?? null;
  const waitHooks = async (id, pred, ms = 240000) => { const end = Date.now() + ms; for (;;) { const h = await hooksOf(id); if ((h && pred(h)) || Date.now() > end) return h; await sleep(3000); } };
  const batch = (urls, webhook, headers = {}) => rest("POST", "/v2/batch/scrape", { urls, webhook }, { headers });
  // H1: delivered, verified, each event once.
  const h0 = recv().received.length;
  let b = await batch([`${FX("m7")}/article?w1=${nonce}`], { url: HOOK, metadata: { run: nonce } });
  let job = b.json?.id;
  let done = job ? await pollJob("batch", job) : b;
  let hk = job ? await waitHooks(job, (h) => h.length >= 2 && h.every((e) => e.state !== "PENDING")) : null;
  let rv = recv();
  out("webhooks", { case: "delivered", ...brief(b), job, status_field: done.json?.status ?? null, webhooks: hk, received: rv.received.slice(h0), accepted: Object.entries(rv.accepted).filter(([, v]) => v.id === job) });
  // H2: the receiver refuses twice; the same event id is retried, then acknowledged once.
  fx7("POST", "/__hooks/fail?n=2");
  const h1 = recv().received.length;
  b = await batch([`${FX("m7")}/article?w2=${nonce}`], { url: HOOK, events: ["completed"] });
  job = b.json?.id;
  done = job ? await pollJob("batch", job) : b;
  hk = job ? await waitHooks(job, (h) => h.length >= 1 && h.every((e) => e.state !== "PENDING")) : null;
  rv = recv();
  out("webhooks", { case: "retried_then_delivered", ...brief(b), job, webhooks: hk, received: rv.received.slice(h1), accepted: Object.entries(rv.accepted).filter(([, v]) => v.id === job) });
  // H3: a receiver that never accepts: bounded attempts, then a dead letter on the receipt.
  fx7("POST", "/__hooks/fail?n=50");
  const h2 = recv().received.length;
  b = await batch([`${FX("m7")}/article?w3=${nonce}`], { url: HOOK, events: ["completed"] });
  job = b.json?.id;
  if (job) await pollJob("batch", job);
  hk = job ? await waitHooks(job, (h) => h.length >= 1 && h.every((e) => e.state === "DEAD"), 420000) : null;
  fx7("POST", "/__hooks/fail?n=0");
  out("webhooks", { case: "dead_after_attempts", ...brief(b), job, webhooks: hk, received: recv().received.slice(h2).length, max_attempts: MANIFEST.limits.webhooks.maxAttempts });
  // H4: destinations not approved are refused before any receipt, and nothing is delivered to them.
  const j0 = +sql("SELECT count(*) FROM fcpi_platform.job")[0];
  const refused = [];
  for (const dest of ["http://10.231.3.99:8080/receive", "https://hooks.example.org/receive", `${HOOK}/elsewhere`]) {
    const r = await batch([`${FX("m7")}/article?w4=${nonce}`], { url: dest });
    refused.push({ dest: dest.replace(/^(https?:\/\/[^/]+).*/, "$1"), ...brief(r), option: r.json?.option ?? null });
  }
  out("webhooks", { case: "unapproved_refused", refused, jobs_before: j0, jobs_after: +sql("SELECT count(*) FROM fcpi_platform.job")[0] });
  // H5: the receiver's own check: a replay within the tolerance is a duplicate; stale and tampered deliveries are refused.
  out("webhooks", { case: "receiver_check", same: fx7("POST", "/__replay?as=same"), stale: fx7("POST", "/__replay?as=stale"), tampered: fx7("POST", "/__replay?as=tampered") });
  // H6: suppression (a restore's switch): events are kept unsent, then delivered once delivery runs again.
  // The retrieval container is recreated twice below: its log so far is read first, and joined with its successor's at the end.
  const earlierEvents = jsonLog("retrieval-service", since);
  out("retrieval_log_scan", { case: "before_recreate", lines: pi("bash /opt/firecrawl-pi/scripts/m7/pi-retrieval-log-scan.sh").trim().split("\n") });
  const C = "sudo -n docker compose -p fcpi -f /opt/firecrawl-pi/deploy/compose.yaml";
  resources("before-suppression");
  pi(`${C} -f /opt/firecrawl-pi/deploy/compose.webhooks-suppressed.yaml up -d --no-deps --wait --wait-timeout 180 --force-recreate retrieval-service 2>&1 | tail -2`);
  await waitHealthy("retrieval-service");
  const h3 = recv().received.length;
  b = await batch([`${FX("m7")}/article?w6=${nonce}`], { url: HOOK, events: ["completed"] });
  job = b.json?.id;
  if (job) await pollJob("batch", job);
  await sleep(20000);
  const held = job ? await hooksOf(job) : null;
  const heldReceived = recv().received.length - h3;
  resources("suppressed");
  pi(`${C} up -d --no-deps --wait --wait-timeout 180 --force-recreate retrieval-service 2>&1 | tail -2`);
  await waitHealthy("retrieval-service");
  hk = job ? await waitHooks(job, (h) => h.length >= 1 && h.every((e) => e.state === "DELIVERED")) : null;
  out("webhooks", { case: "suppressed_then_delivered", ...brief(b), job, while_suppressed: held, received_while_suppressed: heldReceived, after: hk, received_after: recv().received.length - h3,
    delivery_env: D(`inspect -f '{{range .Config.Env}}{{println .}}{{end}}' ${cname("retrieval-service")}`).split("\n").filter((l) => l.startsWith("PI_WEBHOOK_DELIVERY=")) });

  // ---- I: the budget: a full small category refuses the next dispatch before it is sent, and concurrent reservations cannot pass it.
  select("fixture", MODEL, PARSER, "none", "fcpi-fixture-zyte-small");
  const card = BUDGET.rateCards.find((r) => r.subject === "fcpi-fixture-zyte-small"), cap = BUDGET.categories.fixture_enhanced_small.caps.day, amount = card.microUsdPerHttpRequest;
  const today = new Date().toISOString().slice(0, 10);
  const used0 = usageRows().filter((x) => x.category === "fixture_enhanced_small" && x.period === "day" && x.period_start === today).reduce((n, x) => n + Number(x.reserved) + Number(x.settled), 0);
  const raceOut = race({ n: 30, prefix: `e2e-race-${nonce}-`, category: "fixture_enhanced_small", provider: "fixture-zyte", subject: "fcpi-fixture-zyte-small", rateCard: card.id, amount, caps: { day: cap } });
  out("budget", { case: "reservation_race", cap, amount, used_before: used0, expected_granted: Math.max(0, Math.floor((cap - used0) / amount)), ...raceOut });
  a = await acquisition("m7esc.fixture.fcpi.test", () => scrape(`${FX()}/article?x=${nonce}`, { proxy: "enhanced" }));
  out("budget", { case: "exhausted_enhanced", ...brief(a.r), acquisitions: a.acq, hits: hitSummary(a.hits), calls: callSummary(a.calls) });
  clearRoutes("m7esc.fixture.fcpi.test");
  a = await acquisition("m7esc.fixture.fcpi.test", () => scrape(`${FX()}/tough?x=${nonce}`));
  out("budget", { case: "exhausted_auto", ...brief(a.r), acquisitions: a.acq, hits: hitSummary(a.hits), calls: callSummary(a.calls) });
  out("budget", { case: "race_released", released: race({ release: raceOut.outcomes.filter((o) => o.granted).map((o) => o.id) }).released });

  // ---- J: provider failures, each once and apart from the target; then the breaker, and the platform useful beside it.
  select("fixture", MODEL, PARSER, "none", "fcpi-fixture-zyte");
  for (const [md, path] of [["520", "/tough"], ["blackhole", "/article"], ["429", "/article"], ["401", "/article"]]) {
    zyteMode(md);
    const x = await acquisition("m7esc.fixture.fcpi.test", () => scrape(`${FX()}${path}?o=${nonce}-${md}`, { proxy: "enhanced" }));
    out("outage", { case: `provider_${md}`, ...brief(x.r), acquisitions: x.acq, hits: hitSummary(x.hits), calls: callSummary(x.calls),
      ledger: enhancedLedger(x.t0).map((l) => ({ state: l.state, reserved: l.reserved, actual: l.actual })) });
  }
  zyteMode("ok");
  out("outage", { case: "breaker", readyz: readyz() });
  a = await acquisition("m7esc.fixture.fcpi.test", () => scrape(`${FX()}/article?o=${nonce}-open`, { proxy: "enhanced" }));
  out("outage", { case: "breaker_open_refused", ...brief(a.r), acquisitions: a.acq, hits: hitSummary(a.hits), calls: callSummary(a.calls) });
  clearRoutes("m7esc.fixture.fcpi.test");
  a = await acquisition("m7esc.fixture.fcpi.test", () => scrape(`${FX()}/tough?o=${nonce}-open`));
  out("outage", { case: "auto_during_outage", ...brief(a.r), acquisitions: a.acq, calls: callSummary(a.calls) });
  a = await acquisition("m7esc.fixture.fcpi.test", () => scrape(`${FX()}/article?o=${nonce}-direct`));
  out("outage", { case: "direct_unaffected", ...brief(a.r), markdown: /by the direct route/.test(docOf(a.r)?.markdown ?? ""), acquisitions: a.acq, hits: hitSummary(a.hits) });
  const mm = await mcp("tools/call", { name: "firecrawl_scrape", arguments: { url: `${FX()}/article?o=${nonce}-mcp`, formats: ["markdown"] } });
  out("outage", { case: "mcp_unaffected", status: mm.status, is_error: mm.json?.result?.isError ?? null, has_article: /by the direct route/.test(mm.json?.result?.content?.[0]?.text ?? "") });
  out("outage", { case: "domain_not_poisoned", route: routeRow("m7esc.fixture.fcpi.test") });

  // The record of the phase: the ledger, the fixtures' counters, the retrieval log's acquisitions and enhanced dispatches.
  out("ledger", { rows: enhancedLedger(since), usage: usageRows() });
  const s7 = fx7Stats();
  out("fixture_stats", { calls: callSummary(s7.calls), hits: s7.hits.length, received: s7.hooks.received.length });
  const events = [...earlierEvents, ...jsonLog("retrieval-service", since)];
  out("retrieval_events", { acquisitions: events.filter((l) => l.event === "acquisition").map((l) => ({ logical_id: l.logical_id, attempts_used: l.attempts_used, strategies: l.strategies, initial_strategy: l.initial_strategy ?? null, final_strategy: l.final_strategy ?? null,
      route_requested: l.route_requested ?? null, failure: l.failure, enhanced_mode: l.enhanced_mode ?? null, enhanced_state: l.enhanced_state ?? null, enhanced_reused: l.enhanced_reused ?? null, enhanced_micro_usd: l.enhanced_micro_usd ?? null, hooks: l.hooks ?? null })),
    enhanced: events.filter((l) => l.event === "enhanced").map((l) => ({ logical_id: l.logical_id, mode: l.mode, provider_status: l.provider_status, outcome: l.outcome, target_status: l.target_status ?? null, micro_usd: l.micro_usd ?? null })),
    action_navigations: events.filter((l) => l.event === "browser_action_navigations_counted").map((l) => ({ attempt_id: l.attempt_id, count: l.count })),
    webhook_attempts: events.filter((l) => l.event === "webhook_attempt").map((l) => ({ status: l.status, delivered: l.delivered, failure: l.failure ?? null })) });
  resources("fixture-end");
  out("connections", { hosts: [...new Set(seen)].sort(), lookups: [...new Set(looked)].filter((h) => h !== "localhost").sort() });
  out("meta_end", { pi_utc: piNow() });
}

// ---- the live phase (held until the review is addressed) ---------------------------------------------------
// The declared public sample (spec §31.1): twenty permitted URLs over fourteen domains, fixed before any result was seen,
// one request each through the production selection, so the rate is the one this deployment achieves with the tiers it
// may use now. Classes: static, js, docs, difficult.
const SAMPLE = [
  ["static", "https://example.com/"], ["static", "https://books.toscrape.com/"], ["static", "https://books.toscrape.com/catalogue/a-light-in-the-attic_1000/index.html"],
  ["static", "https://quotes.toscrape.com/"], ["static", "https://www.scrapethissite.com/pages/simple/"], ["static", "https://www.scrapethissite.com/pages/forms/"],
  ["static", "https://en.wikipedia.org/wiki/Raspberry_Pi"], ["static", "https://en.wikipedia.org/wiki/Web_scraping"],
  ["js", "https://quotes.toscrape.com/js/"], ["js", "https://quotes.toscrape.com/js-delayed/"], ["js", "https://www.scrapethissite.com/pages/ajax-javascript/"],
  ["docs", "https://docs.python.org/3/library/json.html"], ["docs", "https://developer.mozilla.org/en-US/docs/Web/HTTP/Status/404"], ["docs", "https://www.rfc-editor.org/rfc/rfc9110.html"],
  ["docs", "https://nodejs.org/api/http.html"], ["docs", "https://www.postgresql.org/docs/current/sql-select.html"], ["docs", "https://docs.docker.com/engine/network/"],
  ["difficult", "https://www.cloudflare.com/"], ["difficult", "https://www.g2.com/"], ["difficult", "https://www.zillow.com/"],
];
async function livePhase(before) {
  const since = piNow();
  const status = (await rest("GET", "/platform/v1/status")).json?.providers ?? {};
  out("meta", { phase, pi_utc: since, deployed_commit: pi("cat /opt/firecrawl-pi/.fcpi-source-commit").trim(), selection_before: before, providers: status });
  const zyte = status.providers?.zyte ?? null, cap = status.caps?.enhanced?.caps ?? null;
  const liveEnhanced = zyte?.credential === "present" && status.paidDispatch === true && (cap?.day ?? 0) > 0 && (cap?.month ?? 0) > 0;
  if (!liveEnhanced) {
    out("live_enhanced", { case: "blocked", credential: zyte?.credential ?? null, paidDispatch: status.paidDispatch ?? null, enhancedCaps: cap, reason: "no Zyte key with an approved budget and paid dispatch; no live enhanced request was made" });
  } else {
    select(before.search, before.extractionModel, before.parser, before.proxy ?? "none", "zyte-api");
    const r = await scrape("https://example.com/", { proxy: "enhanced" });
    out("live_enhanced", { case: "permitted_target", ...brief(r), markdown: (docOf(r)?.markdown ?? "").slice(0, 200), proxyUsed: docOf(r)?.metadata?.proxyUsed ?? null,
      ledger: sql(`SELECT row_to_json(r) FROM (SELECT provider, subject, reserved, actual, state, usage FROM fcpi_retrieval.budget_reservation WHERE kind = 'enhanced' AND provider = 'zyte' AND created_at >= :'since') r`, { since }).map((l) => JSON.parse(l)) });
  }
  // The public sample, through the production selection: live search and the budget's default proxy and enhancer, set
  // here rather than taken as found, since a run cut off before its restore can leave the fixture selection behind.
  const prod = { search: "live", proxy: BUDGET.proxying?.defaultProxy ?? "none", enhanced: BUDGET.enhancing?.defaultEnhancer ?? "none" };
  out("public_sample", { case: "selection", ...prod, applied: select(prod.search, MODEL, PARSER, prod.proxy, prod.enhanced) });
  out("public_sample", { case: "declared", urls: SAMPLE.map(([c, url]) => ({ class: c, url })), domains: [...new Set(SAMPLE.map(([, u]) => new URL(u).hostname.replace(/^www\./, "")))].length });
  for (const [cls, url] of SAMPLE) {
    const r = await scrape(url, { formats: ["markdown"] });
    const md = docOf(r)?.markdown ?? "";
    out("public_sample", { case: "result", class: cls, url, ...brief(r), statusCode: docOf(r)?.metadata?.statusCode ?? null, proxyUsed: docOf(r)?.metadata?.proxyUsed ?? null, markdown_chars: md.length, head: md.slice(0, 120) });
    await sleep(1500);
  }
  out("public_sample", { case: "acquisitions", rows: jsonLog("retrieval-service", since).filter((l) => l.event === "acquisition").map((l) => ({ strategies: l.strategies, failure: l.failure, route_reason: l.route_reason ?? null, attempts_used: l.attempts_used })) });
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
  // The fixtures back to normal and the selection found at the start restored, whatever happened; the retrieval service
  // back on the committed Compose file if the suppression case was interrupted.
  try { zyteMode("ok"); fx7("POST", "/__hooks/fail?n=0"); } catch { /* fixture unreachable */ }
  try {
    const env = D(`inspect -f '{{range .Config.Env}}{{println .}}{{end}}' ${cname("retrieval-service")}`);
    if (/PI_WEBHOOK_DELIVERY=suppressed/.test(env)) { pi("sudo -n docker compose -p fcpi -f /opt/firecrawl-pi/deploy/compose.yaml up -d --no-deps --wait --wait-timeout 180 --force-recreate retrieval-service 2>&1 | tail -1"); out("error", { message: "the retrieval service was left suppressed; restored" }); exit = 1; }
  } catch (e) { out("error", { message: `checking the retrieval service's delivery setting: ${e.message}` }); exit = 1; }
  const orNone = (v, dflt) => (v === undefined ? dflt : v ?? "none");
  try {
    if (before) select(before.search, before.extractionModel, before.parser, orNone(before.proxy, BUDGET.proxying.defaultProxy ?? "none"), orNone(before.enhanced, BUDGET.enhancing.defaultEnhancer ?? "none"));
  } catch (e) { out("error", { message: `restoring the selection: ${e.message}` }); exit = 1; }
  tunnel?.kill();
  out("end", { exit, selection_after: (() => { try { return selection(); } catch { return null; } })() });
  process.exitCode = exit;
}
