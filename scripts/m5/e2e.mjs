#!/usr/bin/env node
// M5's live evidence driver (docs/FIRECRAWL_PI_MILESTONES.md, M5 "Automated Verification"). It runs on the
// workstation and reaches the gateway as agents do, through an SSH forward of its loopback publication
// (127.0.0.1:3380 to 127.0.0.1:3380 on the Pi); actions on the Pi (the provider selection, stopping or
// pausing SearXNG, the ledger, the fixture providers' counters, calls to the retrieval service's internal
// extraction listener from inside the gateway's container) run over SSH. It prints sectioned JSON lines;
// scripts/m5/verify.mjs recomputes every verdict from them.
//   node scripts/m5/e2e.mjs fixture > evidence/M5/raw/e2e-fixture.txt
//   node scripts/m5/e2e.mjs live    > evidence/M5/raw/e2e-live.txt     (held until the review is addressed)
// fixture: every controlled case, with no live egress (search on the fixture engine, the fixture model and
// parser, then the production selection's refusals; it refuses to start with paid dispatch on). live: live search egress, and the model and parser
// only where a credential and an approved budget exist. Tokens come over SSH into memory; none is printed.
import { execFileSync, spawn } from "node:child_process";
import { request } from "node:http";
import net, { connect } from "node:net";
import dns from "node:dns";
import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");
const BUDGET = JSON.parse(readFileSync(join(ROOT, "deploy/policies/budget.json"), "utf8"));
const phase = process.argv[2];
const heldOnly = process.argv.includes("--held-only");
if (!["fixture", "live"].includes(phase)) { console.error("usage: e2e.mjs fixture|live"); process.exit(2); }
const T = Object.fromEntries(readFileSync(join(ROOT, "scripts/m1/pi-target.conf"), "utf8").split("\n").filter((l) => /^PI_\w+=/.test(l)).map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1).replace("$HOME", process.env.HOME)]));
const SSH = ["-i", T.PI_SSH_KEY, "-o", "IdentitiesOnly=yes", "-o", "BatchMode=yes", "-o", "ConnectTimeout=15"];
const HOST = "127.0.0.1:3380", FX5 = "http://m5.fixture.fcpi.test:8080", FX2 = "http://m2.fixture.fcpi.test:8080", FX3 = "http://m3.fixture.fcpi.test:8080";
const MODERN = "2026-07-28";
const META = { "io.modelcontextprotocol/protocolVersion": MODERN, "io.modelcontextprotocol/clientCapabilities": {}, "io.modelcontextprotocol/clientInfo": { name: "fcpi-m5-e2e", version: "1" } };
const PRODUCTION = ["fixture", "gpt-6-luna", "llamaparse-cost-effective"];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sha = (s) => createHash("sha256").update(s).digest("hex");
const SCHEMA = { type: "object", properties: { product: { type: "string" }, price: { type: "number" }, in_stock: { type: "boolean" }, feature: { type: "array", items: { type: "string" } } }, required: ["product"] };

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
// The selection, applied and confirmed by the retrieval service's own log (scripts/m5/pi-selection.sh).
function select(search, model, parser, proxy, enhanced) {
  const args = [search,model,parser,...(proxy === undefined ? [] : [proxy,enhanced ?? "none"])];
  const r = pi(`bash /opt/firecrawl-pi/scripts/m5/pi-selection.sh ${args.join(" ")}`).trim();
  out("selection", { search, model, parser, applied: /^selection applied/.test(r) });
}
// The fixture providers' counters, read inside the fixture container (the only place they are served).
const stats = () => JSON.parse(D(`exec ${cname("fixture-m5")} node -e "fetch('http://127.0.0.1:8080/__stats/all').then(r=>r.text()).then(t=>process.stdout.write(t))"`));
// Calls to the retrieval service's extraction listener, made inside the gateway's container with the
// gateway's own credential, read there from its secret file: several at once when given a list.
const INTERNAL = `const fs=require("fs");let b="";process.stdin.on("data",c=>b+=c).on("end",async()=>{const t=fs.readFileSync("/run/secrets/gateway_retrieval_token","utf8").trim();const bodies=JSON.parse(b);const one=async(x)=>{const t0=Date.now();const r=await fetch("http://10.231.9.20:3314/internal/extract",{method:"POST",headers:{authorization:"Bearer "+t,"content-type":"application/json"},body:JSON.stringify(x)});return{status:r.status,json:await r.json().catch(()=>null),started:t0,ms:Date.now()-t0};};process.stdout.write(JSON.stringify(await Promise.all(bodies.map(one))));});`;
const internal = (bodies) => JSON.parse(pi(`sudo -n docker exec -i ${cname("access-gateway")} node -e '${INTERNAL}'`, JSON.stringify(bodies)));
const ledger = (since) => sql(`SELECT row_to_json(r) FROM (SELECT call_key, logical_id, category, provider, subject, kind, unit, rate_card, reserved, actual, state, usage, detail, created_at, settled_at FROM fcpi_retrieval.budget_reservation WHERE created_at >= '${since}' ORDER BY created_at) r`).map((l) => JSON.parse(l));
const usageRows = () => sql(`SELECT row_to_json(u) FROM (SELECT category, period, period_start::text, reserved, settled FROM fcpi_retrieval.budget_usage WHERE period_start >= (now() at time zone 'utc')::date - 31 ORDER BY 1, 2, 3) u`).map((l) => JSON.parse(l));

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
function http(method, path, { tok = "m5", body, headers = {}, timeoutMs = 200000 } = {}) {
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
async function tool(name, args, tok = "m5") {
  const r = await http("POST", "/mcp", { tok, headers: { "mcp-protocol-version": MODERN, "mcp-method": "tools/call", "mcp-name": name },
    body: { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args, _meta: META } } });
  const text = r.json?.result?.content?.[0]?.text ?? null;
  let payload = null;
  try { payload = JSON.parse(text); } catch { /* not JSON */ }
  return { status: r.status, isError: r.json?.result?.isError === true, payload, rpcError: r.json?.error ?? null };
}
const brief = (r) => ({ status: r.status, code: r.json?.code ?? null, error: typeof r.json?.error === "string" ? r.json.error.slice(0, 300) : null, success: r.json?.success ?? null,
  ...(r.headers?.["retry-after"] ? { retryAfter: r.headers["retry-after"] } : {}) });
const webOf = (r) => (Array.isArray(r.json?.data?.web) ? r.json.data.web : null);
async function pollExtract(id, tok = "m5", ms = 420000) {
  const end = Date.now() + ms;
  for (;;) {
    const r = await rest("GET", `/v2/extract/${id}`, undefined, { tok });
    if (r.status !== 200 || r.json?.status !== "processing" || Date.now() > end) return r;
    await sleep(2000);
  }
}
const docOf = (r) => r.json?.data ?? null;
// A memory sample (scripts/m5/pi-resources.sh), taken before each stop that would start a new cgroup.
const resources = (label) => { try { out("resources", JSON.parse(pi(`bash /opt/firecrawl-pi/scripts/m5/pi-resources.sh ${label}`))); } catch (e) { out("error", { message: `resources ${label}: ${e.message}` }); } };
async function catalog() {
  const r = await http("POST", "/mcp", { headers: { "mcp-protocol-version": MODERN, "mcp-method": "tools/list" }, body: { jsonrpc: "2.0", id: 1, method: "tools/list", params: { _meta: META } } });
  const tools = r.json?.result?.tools ?? [];
  out("mcp_catalog", { status: r.status, tools: tools.map((t) => t.name), sha256: sha(JSON.stringify(tools)), search_schema_required: tools.find((t) => t.name === "firecrawl_search")?.inputSchema?.required ?? null,
    extract_urls_max: tools.find((t) => t.name === "firecrawl_extract")?.inputSchema?.properties?.urls?.maxItems ?? null,
    scrape_json_format: JSON.stringify(tools.find((t) => t.name === "firecrawl_scrape")?.inputSchema?.properties?.formats ?? null).includes('"const":"json"'),
    batch_json_format: JSON.stringify(tools.find((t) => t.name === "firecrawl_batch_scrape")?.inputSchema?.properties?.formats ?? null).includes('"const":"json"') });
}

// ---- the fixture phase ---------------------------------------------------------------------------------------
async function fixturePhase() {
  const since = piNow();
  out("meta", { phase, pi_utc: since, deployed_commit: pi("cat /opt/firecrawl-pi/.fcpi-source-commit").trim(), selection_before: JSON.parse(pi("bash /opt/firecrawl-pi/scripts/m5/pi-selection.sh show")) });
  select("fixture", "fcpi-fixture-model", "fcpi-fixture-parser", "fcpi-fixture-proxy", "fcpi-fixture-zyte");
  D(`exec ${cname("fixture-m5")} node -e "fetch('http://127.0.0.1:8080/__reset',{method:'POST'}).then(()=>{})"`);
  resources("fixture-start");
  await catalog();
  const nonce = randomUUID().slice(0, 8);

  // S01/S02: search's four outcomes against the real SearXNG, through REST and MCP.
  const q = (s) => `fcpi ${s} ${nonce}`;
  let r = await rest("POST", "/v2/search", { query: q("widgets"), limit: 5 });
  out("search", { case: "results", ...brief(r), results: webOf(r)?.length ?? null, urls: webOf(r)?.map((x) => x.url) ?? null, warning: r.json?.warning ?? null });
  r = await rest("POST", "/v2/search", { query: q("widgets"), limit: 5 });
  out("search", { case: "repeat_cached", ...brief(r), results: webOf(r)?.length ?? null });
  r = await rest("POST", "/v2/search", { query: q("fcpi-empty") });
  out("search", { case: "true_empty", ...brief(r), results: webOf(r)?.length ?? null, data: r.json?.data ?? null });
  r = await rest("POST", "/v2/search", { query: q("scraped"), limit: 2, scrapeOptions: { formats: ["markdown"] } });
  out("search", { case: "results_scraped", ...brief(r), results: webOf(r)?.length ?? null, scraped: webOf(r)?.filter((x) => typeof x.markdown === "string" && /This is fixture search result/.test(x.markdown)).length ?? null });
  // Scraping the results acquires those pages: a search-only token may search, not scrape (review W7).
  r = await rest("POST", "/v2/search", { query: q("scraped"), limit: 2, scrapeOptions: { formats: ["markdown"] } }, { tok: "m5search" });
  out("search", { case: "scrape_scope_refused", ...brief(r) });
  r = await rest("POST", "/v2/search", { query: q("search only") }, { tok: "m5search" });
  out("search", { case: "search_scope_control", ...brief(r), results: webOf(r)?.length ?? null });
  let t = await tool("firecrawl_search", { query: q("via mcp"), limit: 3 });
  out("search", { case: "mcp_results", isError: t.isError, results: t.payload?.data?.web?.length ?? null });
  t = await tool("firecrawl_search", { query: q("fcpi-empty mcp") });
  out("search", { case: "mcp_true_empty", isError: t.isError, results: t.payload?.data?.web?.length ?? null });
  r = await rest("POST", "/v2/search", { query: q("tbs"), tbs: "qdr:d" });
  out("search", { case: "refused_option", ...brief(r) });
  r = await rest("POST", "/v2/search", { query: q("fcpi-partial") });
  out("search", { case: "partial", ...brief(r), results: webOf(r)?.length ?? null, warning: r.json?.warning ?? null });
  r = await rest("POST", "/v2/search", { query: q("fcpi-fail") });
  out("search", { case: "engines_failed", ...brief(r) });
  t = await tool("firecrawl_search", { query: q("fcpi-fail mcp") });
  out("search", { case: "mcp_engines_failed", isError: t.isError, code: t.payload?.error?.code ?? null, httpStatus: t.payload?.error?.httpStatus ?? null });
  // The backend stopped: typed, never empty; map (sitemap and links) still works (AC05).
  resources("before-searxng-stop");
  D(`stop ${cname("searxng")}`);
  r = await rest("POST", "/v2/search", { query: q("backend down") });
  out("search", { case: "backend_down", ...brief(r), searxng: health("searxng") });
  t = await tool("firecrawl_search", { query: q("backend down mcp") });
  out("search", { case: "mcp_backend_down", isError: t.isError, code: t.payload?.error?.code ?? null, httpStatus: t.payload?.error?.httpStatus ?? null });
  r = await rest("POST", "/v2/map", { url: `${FX3}/`, limit: 50 });
  out("map", { case: "map_during_search_outage", ...brief(r), links: Array.isArray(r.json?.links) ? r.json.links.length : null, searxng: health("searxng") });
  D(`start ${cname("searxng")}`);
  await waitHealthy("searxng");
  // The backend paused: it accepts the connection and never answers, so the 10 s deadline speaks.
  D(`pause ${cname("searxng")}`);
  const t0 = Date.now();
  r = await rest("POST", "/v2/search", { query: q("backend paused") });
  out("search", { case: "backend_timeout", ...brief(r), ms: Date.now() - t0 });
  D(`unpause ${cname("searxng")}`);
  await waitHealthy("searxng");
  const sEvents = jsonLog("retrieval-service", since).filter((l) => l.event === "search");
  out("search_log", { events: sEvents.map((e) => ({ outcome: e.outcome, selection: e.selection, engines: e.engines, results: e.results ?? null, unresponsive: e.unresponsive ?? null })),
    query_text_logged: jsonLog("retrieval-service", since).some((l) => JSON.stringify(l).includes(nonce)) });
  out("provider_stats", { point: "after_search", ...stats() });

  // E01: the json format and extraction jobs on the fixture model.
  const m0 = piNow();
  r = await rest("POST", "/v2/scrape", { url: `${FX5}/extract/product.html`, formats: ["markdown", { type: "json", schema: SCHEMA, prompt: "Extract the product." }] });
  out("extract", { case: "json_format", ...brief(r), json: docOf(r)?.json ?? null, markdown: typeof docOf(r)?.markdown === "string", fcpi: r.json?.fcpi ?? null });
  r = await rest("POST", "/v2/scrape", { url: `${FX5}/extract/sparse.html`, formats: [{ type: "json", schema: SCHEMA }] });
  out("extract", { case: "json_nulls_kept", ...brief(r), json: docOf(r)?.json ?? null, markdown_returned: docOf(r)?.markdown !== undefined, missingRequired: r.json?.fcpi?.extraction?.missingRequired ?? null });
  r = await rest("POST", "/v2/scrape", { url: `${FX5}/extract/product.html`, formats: [{ type: "json", schema: SCHEMA, prompt: "fcpi-mode=invalid-once" }] });
  out("extract", { case: "json_one_repair", ...brief(r), json: docOf(r)?.json ?? null, usage: r.json?.fcpi?.extraction?.usage ?? null });
  r = await rest("POST", "/v2/scrape", { url: `${FX5}/extract/product.html`, formats: [{ type: "json", schema: SCHEMA, prompt: "fcpi-mode=invalid-always" }] });
  out("extract", { case: "json_invalid_after_repair", ...brief(r) });
  r = await rest("POST", "/v2/scrape", { url: `${FX5}/extract/product.html`, formats: [{ type: "json", schema: { type: "object", properties: { a: { $ref: "https://evil.example/s.json" } } } }] });
  out("extract", { case: "json_schema_ref_refused", ...brief(r) });
  r = await rest("POST", "/v2/batch/scrape", { urls: [`${FX5}/extract/product.html`], formats: [{ type: "json", schema: SCHEMA }] });
  out("extract", { case: "json_refused_on_batch", ...brief(r) });
  // The json format spends the model budget: a token that may only scrape gets 403 and the model is not asked (review W7).
  const callsScope = stats().model.calls;
  r = await rest("POST", "/v2/scrape", { url: `${FX5}/extract/product.html`, formats: [{ type: "json", schema: SCHEMA }] }, { tok: "m5scrape" });
  out("extract", { case: "json_scope_refused", ...brief(r), model_calls_before: callsScope, model_calls_after: stats().model.calls });
  r = await rest("POST", "/v2/scrape", { url: `${FX5}/extract/product.html`, formats: ["markdown"] }, { tok: "m5scrape" });
  out("extract", { case: "json_scope_control", ...brief(r) });
  // /v2/extract over explicit URLs, polled to completion; one URL that cannot be scraped makes it partial.
  const idem = `m5-${nonce}-extract`;
  r = await rest("POST", "/v2/extract", { urls: [`${FX5}/extract/product.html`, `${FX5}/extract/other.html`], schema: SCHEMA, prompt: "Extract the product." }, { headers: { "x-idempotency-key": idem } });
  const job1 = r.json?.id;
  out("extract_job", { case: "submitted", ...brief(r), id: job1 ?? null, urlTrace: r.json?.urlTrace ?? null });
  const again = await rest("POST", "/v2/extract", { urls: [`${FX5}/extract/product.html`, `${FX5}/extract/other.html`], schema: SCHEMA, prompt: "Extract the product." }, { headers: { "x-idempotency-key": idem } });
  out("extract_job", { case: "idempotent_resubmit", ...brief(again), id: again.json?.id ?? null, same: again.json?.id === job1 });
  r = await pollExtract(job1);
  out("extract_job", { case: "completed", ...brief(r), id: job1, status_field: r.json?.status ?? null, data: r.json?.data ?? null, sources: r.json?.sources ?? null, warning: r.json?.warning ?? null, fcpi: r.json?.fcpi ?? null });
  r = await rest("POST", "/v2/extract", { urls: [`${FX5}/extract/product.html`, `${FX5}/extract/missing-page.html`], schema: SCHEMA });
  const job2 = r.json?.id;
  r = await pollExtract(job2);
  out("extract_job", { case: "partial", ...brief(r), id: job2, status_field: r.json?.status ?? null, state: r.json?.fcpi?.state ?? null, pageFailures: r.json?.fcpi?.pageFailures?.map((f) => ({ url: f.url, code: f.code })) ?? null, data: r.json?.data ?? null });
  r = await rest("POST", "/v2/extract", { urls: [`${FX5}/extract/long.html`], schema: SCHEMA });
  const job3 = r.json?.id;
  r = await pollExtract(job3);
  out("extract_job", { case: "long_page_chunked", ...brief(r), id: job3, status_field: r.json?.status ?? null, units: r.json?.fcpi?.units ?? null, data: r.json?.data ?? null, sources: r.json?.sources ?? null,
    usage: r.json?.fcpi?.usage ?? null });
  r = await rest("GET", `/v2/extract/${job1}`, undefined, { tok: "m5other" });
  out("extract_job", { case: "other_principal", ...brief(r) });
  r = await rest("POST", "/v2/extract", { urls: [`${FX5}/*`], schema: SCHEMA });
  out("extract_job", { case: "wildcard_refused", ...brief(r) });
  r = await rest("POST", "/v2/extract", { urls: [`${FX5}/extract/product.html`], schema: SCHEMA, enableWebSearch: true });
  out("extract_job", { case: "web_search_refused", ...brief(r) });
  r = await rest("POST", "/v2/extract", { urls: [`${FX5}/extract/product.html`], schema: SCHEMA }, { tok: "m5ro" });
  out("extract_job", { case: "scope_refused", ...brief(r) });
  t = await tool("firecrawl_extract", { urls: [`${FX5}/extract/product.html`], schema: SCHEMA, prompt: "Extract the product." });
  const mcpJob = t.payload?.id;
  out("extract_job", { case: "mcp_submitted", isError: t.isError, id: mcpJob ?? null, next: t.payload?.next ?? null });
  let ms = null;
  for (let i = 0; i < 150; i++) { ms = await tool("firecrawl_extract_status", { id: mcpJob }); if (ms.payload?.status !== "processing") break; await sleep(2000); }
  out("extract_job", { case: "mcp_completed", isError: ms.isError, status_field: ms.payload?.status ?? null, data: ms.payload?.data ?? null });
  // Refusals before any spend, on the internal listener: unknown model, stale rate card, bad schema.
  const before = stats().model.calls;
  const doc = [{ url: `${FX5}/extract/product.html`, markdown: "Product: Fixture Widget\n\nPrice: 42.50" }];
  const refusals = internal([
    { logicalId: `m5:${nonce}:unknown`, model: "gpt-4o", schema: SCHEMA, documents: doc },
    { logicalId: `m5:${nonce}:stale`, model: "fcpi-fixture-stale", schema: SCHEMA, documents: doc },
    { logicalId: `m5:${nonce}:ref`, model: "fcpi-fixture-model", schema: { type: "object", properties: { a: { $ref: "#/x" } } }, documents: doc },
  ]);
  out("refusals", { cases: refusals.map((x, i) => ({ case: ["unknown_model", "stale_rate_card", "schema_ref"][i], status: x.status, class: x.json?.failure?.class ?? null, ok: x.json?.ok ?? null })),
    model_calls_before: before, model_calls_after: stats().model.calls });
  // AC25: concurrent reservations cannot pass the fixture_race category's cap.
  const raceUsage = usageRows().filter((u) => u.category === "fixture_race");
  // The category's day cap is shared by every pass on one UTC day, so the document is sized from what is left:
  // a reservation is 0.4 micro-USD per payload byte plus 4,000 output tokens at 1.6 (6,400), and a payload is
  // the document plus about 1,200 bytes of instructions and schema. About 3.5 reservations fit, so the cap,
  // not the burst's size, decides the split of granted and refused.
  const today = new Date().toISOString().slice(0, 10);
  const cap = JSON.parse(readFileSync(join(ROOT, "deploy/policies/budget.json"), "utf8")).categories.fixture_race.caps.day;
  const used = raceUsage.filter((u) => u.period === "day" && u.period_start === today).reduce((a, u) => a + Number(u.reserved) + Number(u.settled), 0);
  const pad = "This paragraph pads the race fixture to a known size. ";
  const repeats = Math.floor(((cap - used) / 3.5 - 6400) / 0.4 / pad.length) - 25;
  if (repeats < 50) out("error", { message: `the fixture_race day cap is nearly spent today (${used} of ${cap}); the race cannot show two overlapping grants` });
  const big = `Product: Race Widget\n\n${pad.repeat(Math.max(repeats, 1))}`;
  // The fixture model's delay mode holds the first call in the one model slot for 3 s, so every reservation
  // of the burst is held at once and the cap alone decides which are granted.
  const race = internal(Array.from({ length: 8 }, (_, i) => ({ logicalId: `m5:${nonce}:race:${i}`, model: "fcpi-fixture-race", schema: SCHEMA, prompt: "fcpi-mode=delay", documents: [{ url: `${FX5}/extract/race-${i}`, markdown: big }] })));
  out("race", { usage_before: raceUsage, results: race.map((x) => ({ status: x.status, ok: x.json?.ok ?? null, class: x.json?.failure?.class ?? x.json?.units?.[0]?.failure?.class ?? null, started: x.started, ms: x.ms })),
    reservations: ledger(m0).filter((l) => l.category === "fixture_race" && l.logical_id.startsWith(`m5:${nonce}:race:`)).map((l) => ({ logical_id: l.logical_id, reserved: l.reserved, actual: l.actual, state: l.state, created_at: l.created_at, settled_at: l.settled_at })),
    usage_after: usageRows().filter((u) => u.category === "fixture_race") });
  // Provider failures last, since three open the breaker for five minutes: a refused credential, a
  // request with no answer (the reservation kept whole), a provider error; then the breaker refuses without a request.
  const failures = [];
  // The slow case first: its failure is counted when its 60 s end, so the three fall inside the breaker's window.
  for (const [c, mode] of [["no_answer", "slow"], ["auth_refused", "http-401"], ["provider_error", "http-500"]]) {
    const rr = await rest("POST", "/v2/scrape", { url: `${FX5}/extract/product.html`, formats: [{ type: "json", schema: SCHEMA, prompt: `fcpi-mode=${mode}` }] });
    failures.push({ case: c, ...brief(rr) });
  }
  const callsOpen = stats().model.calls;
  const open = await rest("POST", "/v2/scrape", { url: `${FX5}/extract/product.html`, formats: [{ type: "json", schema: SCHEMA }] });
  failures.push({ case: "breaker_open", ...brief(open), model_calls_before: callsOpen, model_calls_after: stats().model.calls });
  out("provider_failures", { cases: failures });
  // HTML acquisition while the model provider's breaker is open (AC23).
  r = await rest("POST", "/v2/scrape", { url: `${FX2}/static.html`, formats: ["markdown"] });
  out("isolation", { case: "scrape_while_model_breaker_open", ...brief(r), markdown: typeof docOf(r)?.markdown === "string" && docOf(r).markdown.length > 0 });
  out("ledger", { point: "extraction", rows: ledger(m0) });
  resources("after-extraction");
  out("provider_stats", { point: "after_extraction", ...stats() });

  // D01/D02: every document class, native first, the fixture parser behind it. The parse cache is keyed by
  // the document's bytes, so an earlier pass's fixture parses would answer this one's without an upload:
  // the fixture parser's rows (and only those) are cleared first, and the count is recorded.
  out("documents", { case: "fixture_parse_cache_cleared", rows: +sql("WITH d AS (DELETE FROM fcpi_retrieval.parse_cache WHERE parser = 'fcpi-fixture-parser' RETURNING 1) SELECT count(*) FROM d")[0] });
  const d0 = piNow();
  const scrape = async (c, path, formats = ["markdown"]) => {
    const rr = await rest("POST", "/v2/scrape", { url: `${FX5}${path}`, formats });
    const md = docOf(rr)?.markdown ?? null;
    out("documents", { case: c, ...brief(rr), chars: md?.length ?? null, head: md ? md.slice(0, 200) : null, numPages: docOf(rr)?.metadata?.numPages ?? null,
      contentType: docOf(rr)?.metadata?.contentType ?? null });
    return rr;
  };
  await scrape("text_pdf", "/docs/text.pdf");
  await scrape("table_pdf_complex", "/docs/table.pdf");
  await scrape("scan_pdf", "/docs/scan.pdf");
  await scrape("scan_pdf_cached", "/docs/scan.pdf");
  await scrape("encrypted_pdf", "/docs/encrypted.pdf");
  await scrape("malformed_pdf", "/docs/malformed.pdf");
  await scrape("pdf_served_as_html", "/docs/pdf-as-html");
  await scrape("html_served_as_pdf", "/docs/html-as-pdf");
  await scrape("oversized_pdf", "/docs/oversized.pdf");
  await scrape("pdf_101_pages", "/docs/pages-101.pdf");
  await scrape("docx", "/docs/sample.docx");
  await scrape("parser_refused_credential", "/docs/parser-mode/http-401.pdf");
  await scrape("parser_job_failed", "/docs/parser-mode/job-fails.pdf");
  out("ledger", { point: "documents", rows: ledger(d0) });
  out("provider_stats", { point: "after_documents", ...stats() });

  // The production selection: the real model and parser, refused before any request (paid dispatch off, a credential
  // present or not), and a complex layout keeping its native text.
  select(...PRODUCTION);
  const p0 = stats();
  r = await rest("POST", "/v2/scrape", { url: `${FX5}/extract/product.html`, formats: [{ type: "json", schema: SCHEMA }] });
  out("production", { case: "json_paid_dispatch_disabled", ...brief(r) });
  r = await rest("POST", "/v2/extract", { urls: [`${FX5}/extract/product.html`], schema: SCHEMA });
  const job4 = r.json?.id;
  r = await pollExtract(job4);
  out("production", { case: "extract_job_paid_dispatch_disabled", ...brief(r), status_field: r.json?.status ?? null, errorCode: r.json?.fcpi?.errorCode ?? null, error: r.json?.error ?? null });
  r = await rest("POST", "/v2/scrape", { url: `${FX5}/docs/scan.pdf?fresh=${nonce}`, formats: ["markdown"] });
  out("production", { case: "scan_parser_required", ...brief(r) });
  r = await rest("POST", "/v2/scrape", { url: `${FX5}/docs/table.pdf?fresh=${nonce}`, formats: ["markdown"] });
  out("production", { case: "complex_keeps_native_text", ...brief(r), head: docOf(r)?.markdown?.slice(0, 200) ?? null });
  out("production", { case: "no_provider_request", stats_before: p0, stats_after: stats() });
  const status = await rest("GET", "/platform/v1/status");
  out("production", { case: "platform_status", providers: status.json?.providers ?? null, routes: status.json?.capabilities?.routes ?? null });

  // I01: ordinary acquisition with search, the model and the parser all unavailable (AC23).
  resources("before-isolation-searxng-stop");
  D(`stop ${cname("searxng")}`);
  r = await rest("POST", "/v2/search", { query: q("isolation") });
  out("isolation", { case: "search_down", ...brief(r) });
  r = await rest("POST", "/v2/scrape", { url: `${FX2}/static.html`, formats: ["markdown", "links"] });
  out("isolation", { case: "scrape", ...brief(r), markdown: typeof docOf(r)?.markdown === "string" && docOf(r).markdown.length > 0 });
  r = await rest("POST", "/v2/scrape", { url: `${FX5}/docs/text.pdf?iso=${nonce}`, formats: ["markdown"] });
  out("isolation", { case: "native_pdf", ...brief(r), sentinel: /FCPI-M5-TEXT-PDF sentinel/.test(docOf(r)?.markdown ?? "") });
  r = await rest("POST", "/v2/crawl", { url: `${FX3}/`, limit: 4 });
  const crawl = r.json?.id;
  let cs = null;
  for (let i = 0; i < 120; i++) { cs = await rest("GET", `/v2/crawl/${crawl}`); if (["completed", "failed", "cancelled"].includes(cs.json?.status)) break; await sleep(2000); }
  out("isolation", { case: "crawl", ...brief(cs), status_field: cs.json?.status ?? null, documents: cs.json?.data?.length ?? null });
  r = await rest("POST", "/v2/map", { url: `${FX3}/`, limit: 20 });
  out("isolation", { case: "map", ...brief(r), links: Array.isArray(r.json?.links) ? r.json.links.length : null });
  D(`start ${cname("searxng")}`);
  await waitHealthy("searxng");
  resources("fixture-end");
  out("connections", { hosts: [...new Set(seen)].sort(), lookups: [...new Set(looked)].filter((h) => h !== "localhost").sort() });
  out("meta_end", { pi_utc: piNow(), selection_after: JSON.parse(pi("bash /opt/firecrawl-pi/scripts/m5/pi-selection.sh show")) });
}

// ---- the live phase (held until the review is addressed) ---------------------------------------------------
async function livePhase() {
  const since = piNow();
  out("meta", { phase, pi_utc: since, deployed_commit: pi("cat /opt/firecrawl-pi/.fcpi-source-commit").trim(), selection_before: JSON.parse(pi("bash /opt/firecrawl-pi/scripts/m5/pi-selection.sh show")),
    providers: (await rest("GET", "/platform/v1/status")).json?.providers ?? null });
  const providers = (await rest("GET", "/platform/v1/status")).json?.providers ?? {};
  const has = (p) => providers.providers?.[p]?.credential === "present";
  const paid = providers.paidDispatch === true;
  const modelLive = has("openai") && paid && (providers.caps?.llm?.caps?.day ?? 0) > 0;
  const parserLive = has("llamaparse") && paid && (providers.caps?.parser?.caps?.month ?? 0) > 0;
  select("live", modelLive ? "gpt-6-luna" : PRODUCTION[1], PRODUCTION[2]);
  // Live search: results, a query nothing matches, and one through MCP. Few queries, each fanned to three engines.
  const nonce = randomUUID().slice(0, 8);
  let r;
  if (!heldOnly) {
  r = await rest("POST", "/v2/search", { query: "Raspberry Pi 5 official product brief", limit: 5 });
  out("live_search", { case: "results", ...brief(r), results: webOf(r)?.length ?? null, hosts: webOf(r)?.map((x) => { try { return new URL(x.url).hostname; } catch { return null; } }) ?? null, warning: r.json?.warning ?? null });
  await sleep(3000);
  r = await rest("POST", "/v2/search", { query: `"fcpiqz${nonce}xk7vw3m9"`, limit: 5 });
  out("live_search", { case: "nothing_matches", ...brief(r), results: webOf(r)?.length ?? null, warning: r.json?.warning ?? null });
  await sleep(3000);
  const t = await tool("firecrawl_search", { query: "SearXNG metasearch engine documentation", limit: 3 });
  out("live_search", { case: "mcp_results", isError: t.isError, results: t.payload?.data?.web?.length ?? null, code: t.payload?.error?.code ?? null });
  out("live_search_log", { events: jsonLog("retrieval-service", since).filter((l) => l.event === "search").map((e) => ({ outcome: e.outcome, selection: e.selection, engines: e.engines, results: e.results ?? null, unresponsive: e.unresponsive ?? null })),
    egress: jsonLog("retrieval-service", since).filter((l) => l.event === "proxy_request" && l.session === "searxng").map((e) => ({ method: e.method, host: e.target_host, status: e.status ?? null, bytes_in: e.bytes_in ?? null })) });
  }
  // The live model and parser, only with a credential and an approved budget; otherwise their state is recorded.
  const m0 = piNow();
  if (modelLive) {
    r = await rest("POST", "/v2/scrape", { url: `${FX5}/extract/product.html`, formats: [{ type: "json", schema: SCHEMA, prompt: "Extract the product listing." }] });
    out("live_model", { case: "json_format", ...brief(r), json: docOf(r)?.json ?? null, fcpi: r.json?.fcpi ?? null });
    r = await rest("POST", "/v2/scrape", { url: `${FX5}/extract/injection.html`, formats: [{ type: "json", schema: SCHEMA }] });
    out("live_model", { case: "injection_ignored", ...brief(r), json: docOf(r)?.json ?? null });
    const nullable = { type: "object", properties: { product: {type:"string"}, manufacturer: {type:["string","null"]} }, required:["product"] };
    r = await rest("POST", "/v2/scrape", { url: `${FX5}/extract/product.html`, formats: [{type:"json",schema:nullable,prompt:"The source gives no manufacturer. Return null for manufacturer."}] });
    out("live_model", {case:"missing_is_null", ...brief(r), json:docOf(r)?.json ?? null, fcpi:r.json?.fcpi ?? null});
    r = await rest("POST", "/v2/extract", { urls: [`${FX5}/extract/product.html`, `${FX5}/extract/other.html`], schema: SCHEMA });
    const job = r.json?.id;
    r = await pollExtract(job);
    out("live_model", { case: "extract_job", ...brief(r), status_field: r.json?.status ?? null, data: r.json?.data ?? null, sources: r.json?.sources ?? null, usage: r.json?.fcpi?.usage ?? null });
  } else out("live_model", { case: "blocked", credential: providers.providers?.openai?.credential ?? null, paidDispatch: paid, llmCaps: providers.caps?.llm ?? null });
  if (parserLive) {
    select("live", modelLive ? "gpt-6-luna" : PRODUCTION[1], "llamaparse-cost-effective");
    for (const [c, path] of [["scan_only", "/docs/scan.pdf"], ["complex", "/docs/table.pdf"], ["scan_cached", "/docs/scan.pdf"]]) {
      const rowsBefore = ledger(m0).filter(x=>x.category==="parser").length;
      r = await rest("POST", "/v2/scrape", { url: `${FX5}${path}?fresh=${nonce}`, formats: ["markdown"] });
      out("live_parser", { case: c, ...brief(r), chars: docOf(r)?.markdown?.length ?? null, head: docOf(r)?.markdown?.slice(0, 300) ?? null,
        full_markdown:(docOf(r)?.markdown ?? "").slice(0,2000), rows_before:rowsBefore, rows_after:ledger(m0).filter(x=>x.category==="parser").length });
    }
  } else out("live_parser", { case: "blocked", credential: providers.providers?.llamaparse?.credential ?? null, paidDispatch: paid, parserCaps: providers.caps?.parser ?? null });
  out("ledger", { point: "live", rows: ledger(m0) });
  out("provider_log", {events:jsonLog("retrieval-service",m0).filter(l=>["model_call","parse","parse_cleanup"].includes(l.event))});
  resources("live-end");
  out("connections", { hosts: [...new Set(seen)].sort(), lookups: [...new Set(looked)].filter((h) => h !== "localhost").sort() });
  out("meta_end", { pi_utc: piNow(), selection_after: JSON.parse(pi("bash /opt/firecrawl-pi/scripts/m5/pi-selection.sh show")) });
}

// The fixture phase promises no provider request, but its production cases select the real providers and rely on the paid-dispatch
// switch to refuse them: the caps are above zero now, so with the switch on they would send real requests for fixture URLs. It stops
// before any selection changes unless the service reports the switch off (an unreadable status counts as on).
async function requireDispatchOff() {
  const on = (await rest("GET", "/platform/v1/status")).json?.providers?.paidDispatch;
  if (on !== false) throw new Error(`the fixture phase needs paid dispatch off and the service reports ${on ?? "nothing"}: its production cases would send real provider requests for fixture URLs`);
}

let exit = 0, before = null;
try {
  await openTunnel();
  if (phase === "fixture") await requireDispatchOff();
  before = JSON.parse(pi("bash /opt/firecrawl-pi/scripts/m5/pi-selection.sh show"));
  await (phase === "fixture" ? fixturePhase() : livePhase());
} catch (e) {
  exit = 1;
  out("error", { message: e.message, stack: String(e.stack ?? "").split("\n").slice(0, 4).join(" | ") });
} finally {
  // Restore every dimension found at entry, including M6/M7's proxy and enhancer selections.
  try { if (before) select(before.search,before.extractionModel,before.parser,
    (before.proxy === undefined ? BUDGET.proxying.defaultProxy : before.proxy) ?? "none",
    (before.enhanced === undefined ? BUDGET.enhancing.defaultEnhancer : before.enhanced) ?? "none"); } catch (e) { out("error", { message: `restoring the selection: ${e.message}` }); exit = 1; }
  try { if (health("searxng") !== "running healthy") { D(`unpause ${cname("searxng")}`); } } catch { /* not paused */ }
  tunnel?.kill();
  out("end", { exit });
  process.exitCode = exit;
}
