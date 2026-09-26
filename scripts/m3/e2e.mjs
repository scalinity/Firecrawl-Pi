#!/usr/bin/env node
// M3's live evidence driver. It runs on the workstation, the machine the owner's agents run on, and
// reaches the gateway the way they do: through an SSH forward of its loopback publication
// (127.0.0.1:3380 here to 127.0.0.1:3380 on the Pi). Actions on the Pi (stopping and killing
// containers, reading the ledger and NuQ, reading the fixture's log) run over SSH. It prints sectioned
// JSON lines; scripts/m3/verify.mjs recomputes every verdict from them.
//   node scripts/m3/e2e.mjs <phase> > evidence/M3/raw/e2e-<phase>.txt
// Phases: auth, sync, jobs, cancel, overload, crash, expiry, cli, after-recreate.
// Tokens come from /etc/firecrawl-pi/secrets/clients over SSH into memory; none is printed, written or
// put on a command line. Nothing printed carries the Pi's LAN address or SSH target.
import { execFileSync, spawn } from "node:child_process";
import { request } from "node:http";
import { connect } from "node:net";
import { createHash, randomUUID } from "node:crypto";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");
const phase = process.argv[2];
const T = Object.fromEntries(readFileSync(join(ROOT, "scripts/m1/pi-target.conf"), "utf8").split("\n").filter((l) => /^PI_\w+=/.test(l)).map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1).replace("$HOME", process.env.HOME)]));
const SSH = ["-i", T.PI_SSH_KEY, "-o", "IdentitiesOnly=yes", "-o", "BatchMode=yes", "-o", "ConnectTimeout=15"];
const STATE = join(ROOT, "evidence/M3/raw/e2e-state.json");   // ids later phases reuse (no secrets)
const HOST = "127.0.0.1:3380", ORIGIN = `http://${HOST}`, FX = "http://m3.fixture.fcpi.test:8080";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const now = () => new Date().toISOString();
const sha = (s) => createHash("sha256").update(s).digest("hex");

// ---- output ----------------------------------------------------------------------------------------
let current = null;
function out(section, rec) {
  if (section !== current) { process.stdout.write(`### ${section}\n`); current = section; }
  process.stdout.write(`${JSON.stringify({ utc: now(), ...rec })}\n`);
}
// A gateway answer, as recorded: status, code, the challenge, any CORS header, the body's hash and a bounded summary.
const brief = (r, extra = {}) => ({ status: r.status, code: r.json?.code ?? null, error: r.json?.error ? String(r.json.error).slice(0, 200) : null,
  www_authenticate: r.headers["www-authenticate"] ?? null, retry_after: r.headers["retry-after"] ?? null, acao: r.headers["access-control-allow-origin"] ?? null, body_sha256: sha(r.text), ...extra });

// ---- the Pi ----------------------------------------------------------------------------------------
const pi = (cmd, input) => execFileSync("ssh", [...SSH, T.PI_SSH_TARGET, cmd], { encoding: "utf8", input, maxBuffer: 64 * 1024 * 1024 });
const D = (args) => pi(`sudo -n docker ${args}`);
const cname = (svc) => `fcpi-${svc}-1`;
const sql = (q) => pi(`sudo -n docker exec -i ${cname("nuq-postgres")} psql -U postgres -d postgres -q -At -X -F '|' -v ON_ERROR_STOP=1`, q).trim().split("\n").filter(Boolean);
const tokens = {};
const token = (label) => (tokens[label] ??= pi(`sudo -n cat /etc/firecrawl-pi/secrets/clients/${label}.token`).trim());
const health = (svc) => D(`inspect -f '{{.State.Status}} {{if .State.Health}}{{.State.Health.Status}}{{end}}' ${cname(svc)}`).trim();
async function waitHealthy(svc, ms = 300000) {
  const end = Date.now() + ms;
  for (;;) { const h = health(svc); if (h === "running healthy") return h; if (Date.now() > end) throw new Error(`${svc} not healthy: ${h}`); await sleep(2000); }
}
const fixtureLog = (since) => pi(`sudo -n docker logs --since ${since} ${cname("fixture-m3")} 2>&1`).split("\n").filter((l) => l.startsWith("{")).map((l) => JSON.parse(l)).filter((l) => l.path);
const markerGroups = (id) => Number(sql(`SELECT count(DISTINCT group_id) FROM (SELECT group_id, data FROM nuq.queue_scrape UNION ALL SELECT group_id, data FROM nuq.queue_scrape_backlog) j WHERE j.data->>'origin' = 'fcpi:${id}' OR j.data->'scrapeOptions'->>'origin' = 'fcpi:${id}';`)[0]);
const ledgerJob = (id) => { const [r] = sql(`SELECT state, coalesce(upstream_id::text,''), archived, coalesce(error_code,''), dispatch_attempts FROM fcpi_platform.job WHERE id = '${id}';`); if (!r) return null; const [state, upstream, archived, error_code, attempts] = r.split("|"); return { state, upstream, archived: Number(archived), error_code, attempts: Number(attempts) }; };
const events = (id) => sql(`SELECT from_state, to_state, coalesce(detail,'') FROM fcpi_platform.job_event WHERE job_id = '${id}' ORDER BY at, id;`).map((l) => { const [from, to, detail] = l.split("|"); return { from: from || null, to, detail }; });
const attemptsCount = () => Number(sql("SELECT count(*) FROM fcpi_retrieval.attempt;")[0]);
const jobsCount = () => Number(sql("SELECT count(*) FROM fcpi_platform.job;")[0]);

// ---- the forward -----------------------------------------------------------------------------------
let tunnel = null;
async function openTunnel() {
  const free = await new Promise((r) => { const s = connect(3380, "127.0.0.1"); s.on("connect", () => { s.destroy(); r(false); }); s.on("error", () => r(true)); });
  if (!free) throw new Error("127.0.0.1:3380 is already in use on the workstation");
  tunnel = spawn("ssh", [...SSH, "-N", "-o", "ExitOnForwardFailure=yes", "-L", "127.0.0.1:3380:127.0.0.1:3380", T.PI_SSH_TARGET], { stdio: "ignore" });
  for (let i = 0; i < 60; i++) {
    const up = await new Promise((r) => { const s = connect(3380, "127.0.0.1"); s.on("connect", () => { s.destroy(); r(true); }); s.on("error", () => r(false)); });
    if (up) return;
    await sleep(250);
  }
  throw new Error("the SSH forward did not open");
}

// ---- HTTP to the gateway ---------------------------------------------------------------------------
function http(method, path, { tok, body, headers = {}, host = HOST, timeoutMs = 200000 } = {}) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? undefined : Buffer.from(typeof body === "string" ? body : JSON.stringify(body));
    const req = request({ host: "127.0.0.1", port: 3380, method, path, timeout: timeoutMs, headers: { host, ...(tok ? { authorization: `Bearer ${token(tok)}` } : {}),
      ...(data ? { "content-type": "application/json", "content-length": data.length } : {}), ...headers } }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => { const text = Buffer.concat(chunks).toString(); let json = null; try { json = JSON.parse(text); } catch { /* not JSON */ } resolve({ status: res.statusCode, headers: res.headers, text, json }); });
      res.on("error", reject);
    });
    req.on("timeout", () => req.destroy(new Error("timeout")));
    req.on("error", reject);
    req.end(data);
  });
}
const receipt = async (id, tok = "m3ro") => (await http("GET", `/platform/v1/jobs/${id}`, { tok })).json?.job ?? null;
async function waitState(id, states, ms = 900000, tok = "m3ro") {
  const end = Date.now() + ms;
  for (;;) {
    const j = await receipt(id, tok);
    if (j && states.includes(j.state)) return j;
    if (Date.now() > end) throw new Error(`job ${id} did not reach ${states.join("/")} (last ${j?.state})`);
    await sleep(2000);
  }
}
// Every document of a finished job, following `next`: page sizes, next URLs, and per-document facts.
async function pages(kind, id, limit, tok = "m3a") {
  const base = kind === "crawl" ? "/v2/crawl" : "/v2/batch/scrape";
  let path = `${base}/${id}${limit ? `?limit=${limit}` : ""}`;
  const out = { pages: [], nexts: [], docs: [], statuses: [] };
  while (path) {
    const r = await http("GET", path, { tok });
    out.statuses.push(r.status);
    if (r.status !== 200) break;
    out.pages.push(r.json.data.length);
    for (const d of r.json.data) out.docs.push({ url: d.metadata?.url ?? d.metadata?.sourceURL ?? null, sourceURL: d.metadata?.sourceURL ?? null, statusCode: d.metadata?.statusCode ?? null,
      scrapeId: d.metadata?.scrapeId ?? null, sentinel: (d.markdown?.match(/fcpi-m3-[a-z0-9]+-[0-9a-f]{4}/) ?? [null])[0], sha256: sha(JSON.stringify(d)) });
    out.head = { status: r.json.status, completed: r.json.completed, total: r.json.total, expiresAt: r.json.expiresAt };
    if (r.json.next) { out.nexts.push(r.json.next); path = r.json.next.startsWith(ORIGIN) ? r.json.next.slice(ORIGIN.length) : null; } else path = null;
  }
  return out;
}
const state = () => (existsSync(STATE) ? JSON.parse(readFileSync(STATE, "utf8")) : {});
const saveState = (o) => writeFileSync(STATE, JSON.stringify({ ...state(), ...o }, null, 2) + "\n");
const post = (kind, body, tok = "m3a", headers = {}) => http("POST", kind === "crawl" ? "/v2/crawl" : kind === "batch" ? "/v2/batch/scrape" : `/v2/${kind}`, { tok, body, headers });

// ---- phases ----------------------------------------------------------------------------------------
const PHASES = {
  async auth() {
    for (const [c, opts] of [["missing", {}], ["invalid", { headers: { authorization: `Bearer fcpi_zz_${randomUUID().replace(/-/g, "").repeat(2)}` } }],
      ["basic_scheme", { headers: { authorization: `Basic ${Buffer.from("m3a:x").toString("base64")}` } }], ["bearer_empty", { headers: { authorization: "Bearer " } }]]) {
      out("unauthenticated", { case: c, ...brief(await http("GET", "/platform/v1/status", opts)) });
    }
    out("unauthenticated", { case: "valid_control", ...brief(await http("GET", "/platform/v1/status", { tok: "m3a" })) });
    const u = randomUUID();
    for (const [c, m, p, b] of [["read_token_submits_crawl", "POST", "/v2/crawl", { url: `${FX}/`, limit: 1 }], ["read_token_scrapes", "POST", "/v2/scrape", { url: `${FX}/p01` }],
      ["read_token_maps", "POST", "/v2/map", { url: `${FX}/` }], ["read_token_cancels", "DELETE", `/v2/crawl/${u}`], ["read_token_submits_batch", "POST", "/v2/batch/scrape", { urls: [`${FX}/p01`] }]]) {
      out("scope", { case: c, ...brief(await http(m, p, { tok: "m3ro", body: b })) });
    }
    out("scope", { case: "read_token_reads_status_control", ...brief(await http("GET", "/platform/v1/status", { tok: "m3ro" })) });
    // Owner isolation: a crawl of m3-alpha's, looked up by m3-beta, answers exactly as an unknown id does.
    const c = await post("crawl", { url: `${FX}/`, limit: 2, sitemap: "skip" });
    out("owner", { case: "alpha_submits", ...brief(c), id: c.json?.id ?? null });
    const id = c.json.id;
    await waitState(id, ["SUCCEEDED", "PARTIAL", "FAILED", "CANCELLED"]);
    const unknown = randomUUID();
    for (const [m, p] of [["GET", `/v2/crawl/${id}`], ["GET", `/v2/crawl/${id}/errors`], ["DELETE", `/v2/crawl/${id}`], ["GET", `/platform/v1/jobs/${id}`], ["GET", `/v2/batch/scrape/${id}`]]) {
      const theirs = await http(m, p, { tok: "m3b" });
      const spoof = await http(m, p, { tok: "m3b", headers: { "x-fcpi-principal": "m3-alpha", "x-fcpi-owner": "m3-alpha", "x-forwarded-user": "m3-alpha", "x-forwarded-for": "127.0.0.1", "x-real-ip": "127.0.0.1" } });
      const unk = await http(m, p.replace(id, unknown), { tok: "m3b" });
      out("owner", { case: `${m} ${p.replace(id, "{id}")}`, beta: brief(theirs), beta_spoofed_headers: brief(spoof), unknown: brief(unk) });
    }
    out("owner", { case: "alpha_reads_own_control", ...brief(await http("GET", `/v2/crawl/${id}`, { tok: "m3a" })) });
    const list = await http("GET", "/platform/v1/jobs?limit=100", { tok: "m3b" });
    out("owner", { case: "beta_job_list", status: list.status, is_list: Array.isArray(list.json?.jobs), contains_alpha_job: (list.json?.jobs ?? []).some((j) => j.id === id), jobs: (list.json?.jobs ?? []).length });
    // The control: the same list route shows alpha the job, so its absence from beta's list means something.
    const own = await http("GET", "/platform/v1/jobs?limit=100", { tok: "m3a" });
    out("owner", { case: "alpha_job_list_control", status: own.status, is_list: Array.isArray(own.json?.jobs), contains_alpha_job: (own.json?.jobs ?? []).some((j) => j.id === id) });
    saveState({ ownerJob: id });
    // Revocation: m3rev works, is revoked on the Pi, and is refused within seconds, without a restart.
    out("revoke", { case: "before", ...brief(await http("GET", "/platform/v1/status", { tok: "m3rev" })) });
    const t0 = Date.now();
    out("revoke", { case: "revoked_on_pi", result: pi("bash /opt/firecrawl-pi/scripts/m3/pi-client-token.sh revoke m3rev").trim() });
    let r, n = 0;
    do { await sleep(250); r = await http("GET", "/platform/v1/status", { tok: "m3rev" }); n++; } while (r.status === 200 && Date.now() - t0 < 10000);
    out("revoke", { case: "after", ms_until_refused: Date.now() - t0, polls: n, ...brief(r) });
    out("revoke", { case: "gateway_restarts_during", restart_count: D(`inspect -f '{{.RestartCount}} {{.State.StartedAt}}' ${cname("access-gateway")}`).trim() });
    // Host and Origin.
    for (const [c2, host, headers] of [["host_foreign", "evil.example", {}], ["host_rebinding_name", "attacker.example:3380", {}], ["host_localhost_alias", "localhost:3380", {}], ["host_loopback", HOST, {}],
      ["origin_foreign", HOST, { origin: "https://evil.example" }], ["origin_null", HOST, { origin: "null" }], ["origin_absent", HOST, {}]]) {
      const x = await http("GET", "/platform/v1/status", { tok: "m3a", host, headers });
      out("host_origin", { case: c2, ...brief(x) });
    }
    const pre = await http("OPTIONS", "/v2/scrape", { headers: { origin: "https://evil.example", "access-control-request-method": "POST" } });
    out("host_origin", { case: "preflight_foreign", ...brief(pre) });
    // Upstream's Cloud challenge and admin routes stay out of reach.
    out("routes", { case: "admin_authenticated", ...brief(await http("POST", "/admin/integration/create-user", { tok: "m3a", body: {} })) });
    out("routes", { case: "search_not_enabled", ...brief(await http("POST", "/v2/search", { tok: "m3a", body: { query: "x" } })) });
    out("routes", { case: "ongoing_not_enabled", ...brief(await http("GET", "/v2/crawl/ongoing", { tok: "m3a" })) });
    out("routes", { case: "scrape_status_not_enabled", ...brief(await http("GET", `/v2/scrape/${randomUUID()}`, { tok: "m3a" })) });
    out("routes", { case: "unlisted", ...brief(await http("GET", "/v1/crawl", { tok: "m3a" })) });
    // The failure budget last: 35 unknown tokens, then a valid one.
    const statuses = [];
    for (let i = 0; i < 35; i++) statuses.push((await http("GET", "/platform/v1/status", { headers: { authorization: `Bearer fcpi_rl_${sha(String(i))}` } })).status);
    const ok = await http("GET", "/platform/v1/status", { tok: "m3a" });
    out("rate_limit", { statuses, first_429_at: statuses.indexOf(429), valid_during: ok.status });
  },

  async sync() {
    const a0 = attemptsCount(), since = now();
    const s = await post("scrape", { url: `${FX}/p01`, formats: ["markdown", "html", "rawHtml", "links"] });
    const d = s.json?.data ?? {};
    out("scrape", { ...brief(s), success: s.json?.success, sentinel_in_markdown: /fcpi-m3-p01-[0-9a-f]{4}/.test(d.markdown ?? ""), sentinel_in_html: /fcpi-m3-p01-[0-9a-f]{4}/.test(d.html ?? ""),
      raw_html_bytes: (d.rawHtml ?? "").length, links: d.links ?? null, url: d.metadata?.url ?? null, statusCode: d.metadata?.statusCode ?? null, title: d.metadata?.title ?? null,
      markdown_sha256: d.markdown ? sha(d.markdown) : null, request_id: s.headers["x-request-id"] ?? null });
    const m = await post("map", { url: `${FX}/` });
    out("map", { case: "whole", ...brief(m), links: (m.json?.links ?? []).map((l) => (typeof l === "string" ? l : l.url)).sort() });
    const m5 = await post("map", { url: `${FX}/`, limit: 5 });
    out("map", { case: "limit_5", ...brief(m5), links: (m5.json?.links ?? []).map((l) => (typeof l === "string" ? l : l.url)).sort() });
    const a1 = attemptsCount(), j1 = jobsCount(), since2 = now();
    const refused = [
      ["scrape_screenshot", "scrape", { url: `${FX}/p03?refused=screenshot`, formats: ["screenshot"] }], ["scrape_json_format", "scrape", { url: `${FX}/p03?refused=json`, formats: [{ type: "json", prompt: "x" }] }],
      ["scrape_actions", "scrape", { url: `${FX}/p03?refused=actions`, actions: [{ type: "wait", milliseconds: 100 }] }], ["scrape_headers", "scrape", { url: `${FX}/p03?refused=headers`, headers: { cookie: "a=b" } }],
      ["scrape_mobile", "scrape", { url: `${FX}/p03?refused=mobile`, mobile: true }], ["scrape_max_age", "scrape", { url: `${FX}/p03?refused=maxage`, maxAge: 3600000 }],
      ["scrape_agent_interop", "scrape", { url: `${FX}/p03?refused=interop`, __agentInterop: { auth: "x", requestId: "y", shouldBill: false } }],
      ["scrape_skip_tls", "scrape", { url: `${FX}/p03?refused=tls`, skipTlsVerification: true }], ["scrape_stealth", "scrape", { url: `${FX}/p03?refused=stealth`, proxy: "stealth" }],
      ["crawl_webhook", "crawl", { url: `${FX}/?refused=webhook`, webhook: "https://hooks.example/x" }], ["crawl_prompt", "crawl", { url: `${FX}/?refused=prompt`, prompt: "only blog posts" }],
      ["crawl_ignore_robots", "crawl", { url: `${FX}/?refused=robots`, ignoreRobotsTxt: true }], ["crawl_zdr", "crawl", { url: `${FX}/?refused=zdr`, zeroDataRetention: true }],
      ["crawl_scrape_actions", "crawl", { url: `${FX}/?refused=cactions`, scrapeOptions: { actions: [{ type: "click", selector: "a" }] } }],
      ["batch_append", "batch", { urls: [`${FX}/p03?refused=append`], appendToId: randomUUID() }], ["batch_webhook", "batch", { urls: [`${FX}/p03?refused=bwebhook`], webhook: "https://hooks.example/y" }],
      ["map_location", "map", { url: `${FX}/?refused=location`, location: { country: "de" } }], ["map_use_index", "map", { url: `${FX}/?refused=index`, useIndex: true }],
      ["scrape_unknown_key", "scrape", { url: `${FX}/p03?refused=unknown`, bogus: true }],
    ];
    for (const [c, kind, body] of refused) { const r = await post(kind, body); out("refused", { case: c, ...brief(r), option: r.json?.option ?? null }); }
    const hits = fixtureLog(since2).filter((l) => (l.query ?? "").includes("refused="));
    out("refused_effects", { attempts_before: a1, attempts_after: attemptsCount(), jobs_before: j1, jobs_after: jobsCount(), fixture_hits_for_refused: hits.length, positive_control_attempts_from_scrape: a1 - a0,
      fixture_hits_since_scrape: fixtureLog(since).filter((l) => l.path === "/p01").length });
    // Limits.
    out("limits", { case: "body_over_1mib", ...brief(await post("scrape", { url: `${FX}/p01`, pad: "x".repeat(1048600) })) });
    out("limits", { case: "batch_26_urls", ...brief(await post("batch", { urls: Array.from({ length: 26 }, (_, i) => `${FX}/p01?i=${i}`) })) });
    out("limits", { case: "crawl_limit_201", ...brief(await post("crawl", { url: `${FX}/`, limit: 201 })) });
    out("limits", { case: "crawl_depth_4", ...brief(await post("crawl", { url: `${FX}/`, maxDiscoveryDepth: 4 })) });
    out("limits", { case: "map_limit_1001", ...brief(await post("map", { url: `${FX}/`, limit: 1001 })) });
    out("limits", { case: "wait_for_15001", ...brief(await post("scrape", { url: `${FX}/p01`, waitFor: 15001 })) });
    out("limits", { case: "header_over_16kib", ...(await http("GET", "/platform/v1/status", { tok: "m3a", headers: { "x-pad": "y".repeat(17000) } }).then((r) => brief(r), (e) => ({ error: e.message }))) });
    // Synchronous overload: six held scrapes at once; the gateway admits four.
    const held = await Promise.all(Array.from({ length: 6 }, (_, i) => post("scrape", { url: `${FX}/delay?ms=6000&n=${i}&t=${Date.now()}` })));
    out("sync_overload", { statuses: held.map((r) => r.status), codes: held.map((r) => r.json?.code ?? null), retry_after: held.map((r) => r.headers["retry-after"] ?? null) });
    const after = await post("scrape", { url: `${FX}/p02` });
    out("sync_overload", { case: "after_release", ...brief(after) });
  },

  async jobs() {
    const key = `m3-graph-${randomUUID()}`;
    const g = await post("crawl", { url: `${FX}/`, limit: 12, sitemap: "include" }, "m3a", { "x-idempotency-key": key });
    out("crawl_graph", { case: "submit", ...brief(g), id: g.json?.id ?? null, url: g.json?.url ?? null });
    const id = g.json.id;
    const again = await post("crawl", { url: `${FX}/`, limit: 12, sitemap: "include" }, "m3a", { "x-idempotency-key": key });
    // Both ids are recorded, never a comparison: the verifier requires two equal UUIDs, so two missing ids cannot pass.
    out("idempotency", { case: "same_key_same_body", ...brief(again), id: again.json?.id ?? null, first_id: id });
    const reordered = await post("crawl", { sitemap: "include", limit: 12, url: `${FX}/` }, "m3a", { "x-idempotency-key": key });
    out("idempotency", { case: "same_key_reordered_body", ...brief(reordered), id: reordered.json?.id ?? null, first_id: id });
    out("idempotency", { case: "same_key_other_body", ...brief(await post("crawl", { url: `${FX}/`, limit: 11 }, "m3a", { "x-idempotency-key": key })) });
    const beta = await post("crawl", { url: `${FX}/`, limit: 12, sitemap: "include" }, "m3b", { "x-idempotency-key": key });
    out("idempotency", { case: "other_principal_same_key", ...brief(beta), id: beta.json?.id ?? null, first_id: id });
    if (beta.json?.id) out("idempotency", { case: "other_principal_job_cancelled", ...brief(await http("DELETE", `/v2/crawl/${beta.json.id}`, { tok: "m3b" })) });
    const done = await waitState(id, ["SUCCEEDED", "PARTIAL", "FAILED", "CANCELLED"]);
    out("crawl_graph", { case: "finished", state: done.state, archived: done.archived, completed: done.completed, total: done.total, upstream_id: done.upstreamId, submission_key: done.submissionKey,
      events: (done.events ?? []).map((e) => e.to), marker_groups: markerGroups(id), resultsExpireAt: done.resultsExpireAt });
    const p = await pages("crawl", id, 5);
    out("crawl_graph", { case: "pages_limit_5", ...p });
    const errs = await http("GET", `/v2/crawl/${id}/errors`, { tok: "m3a" });
    out("crawl_graph", { case: "errors", ...brief(errs), errors: errs.json?.errors?.length ?? null, robotsBlocked: errs.json?.robotsBlocked ?? null });
    out("idempotency", { case: "upstream_groups_for_key", marker_groups: markerGroups(id), beta_marker_groups: beta.json?.id ? markerGroups(beta.json.id) : null });
    // A crawl limited to 5 pages.
    const l5 = await post("crawl", { url: `${FX}/`, limit: 5, sitemap: "include" });
    const l5done = await waitState(l5.json.id, ["SUCCEEDED", "PARTIAL", "FAILED"]);
    const l5p = await pages("crawl", l5.json.id);
    out("crawl_limit", { id: l5.json.id, state: l5done.state, archived: l5done.archived, docs: l5p.docs.length, marker_groups: markerGroups(l5.json.id), urls: l5p.docs.map((d) => d.url).sort() });
    // A batch with per-item outcomes: two pages, a 404, an authentication gate, and one invalid URL.
    const bkey = `m3-batch-${randomUUID()}`;
    const body = { urls: [`${FX}/p01`, `${FX}/p02`, `${FX}/missing`, `${FX}/gate`, "ftp://m3.fixture.fcpi.test/x"] };
    const b = await post("batch", body, "m3a", { "x-idempotency-key": bkey });
    out("batch", { case: "submit", ...brief(b), id: b.json?.id ?? null, invalidURLs: b.json?.invalidURLs ?? null, url: b.json?.url ?? null });
    const b2 = await post("batch", body, "m3a", { "x-idempotency-key": bkey });
    out("batch", { case: "same_key_again", ...brief(b2), id: b2.json?.id ?? null, first_id: b.json.id });
    const bdone = await waitState(b.json.id, ["SUCCEEDED", "PARTIAL", "FAILED", "CANCELLED"]);
    const bp = await pages("batch", b.json.id);
    const be = await http("GET", `/v2/batch/scrape/${b.json.id}/errors`, { tok: "m3a" });
    out("batch", { case: "finished", state: bdone.state, archived: bdone.archived, docs: bp.docs.map((d) => ({ url: d.url, statusCode: d.statusCode, sentinel: d.sentinel })),
      errors: (be.json?.errors ?? []).map((e) => ({ url: e.url, code: e.code ?? null, error: String(e.error).slice(0, 120) })), marker_groups: markerGroups(b.json.id) });
    const list = await http("GET", "/platform/v1/jobs?limit=100", { tok: "m3a" });
    out("list", { status: list.status, contains: [id, l5.json.id, b.json.id].map((x) => (list.json?.jobs ?? []).some((j) => j.id === x)) });
    saveState({ graphJob: id, batchJob: b.json.id, limitJob: l5.json.id, graphDocs: p.docs, batchDocs: bp.docs });
  },

  async cancel() {
    const since = now();
    const s = await post("crawl", { url: `${FX}/slow/`, limit: 30, sitemap: "skip" });
    out("slow_crawl", { case: "submit", ...brief(s), id: s.json?.id ?? null });
    const id = s.json.id;
    for (let i = 0; i < 120; i++) { const j = await receipt(id); if ((j?.completed ?? 0) >= 2) break; await sleep(1000); }
    const q = await post("crawl", { url: `${FX}/`, limit: 3, sitemap: "skip" });
    const qs = ledgerJob(q.json.id);
    out("queued_crawl", { case: "submit_while_other_runs", ...brief(q), id: q.json?.id ?? null, ledger_state: qs.state });
    out("queued_crawl", { case: "cancel", ...brief(await http("DELETE", `/v2/crawl/${q.json.id}`, { tok: "m3a" })), ledger_state: ledgerJob(q.json.id).state, marker_groups: markerGroups(q.json.id) });
    const tCancel = now();
    const c = await http("DELETE", `/v2/crawl/${id}`, { tok: "m3a" });
    out("slow_crawl", { case: "cancel", ...brief(c), body: c.json, at: tCancel });
    const done = await waitState(id, ["CANCELLED", "FAILED", "SUCCEEDED", "PARTIAL"], 300000);
    await sleep(8000);
    const log = fixtureLog(since).filter((l) => l.path.startsWith("/slow/s")).map((l) => ({ path: l.path, answered: l.utc, started: new Date(Date.parse(l.utc) - 2000).toISOString() }));
    out("slow_crawl", { case: "finished", state: done.state, archived: done.archived, completed: done.completed, total: done.total, marker_groups: markerGroups(id), cancel_at: tCancel, fixture_requests: log,
      events: (await receipt(id)).events.map((e) => e.to), queued_job_after: ledgerJob(q.json.id).state, queued_job_marker_groups: markerGroups(q.json.id) });
    const fin = state().graphJob;
    if (fin) out("finished_job", { case: "cancel_finished", ...brief(await http("DELETE", `/v2/crawl/${fin}`, { tok: "m3a" })) });
  },

  async overload() {
    const ids = [];
    const a = await post("crawl", { url: `${FX}/slow/`, limit: 30, sitemap: "skip" });
    ids.push(a.json.id);
    out("admission", { case: "active_slow_crawl", ...brief(a) });
    for (let i = 0; i < 2; i++) { const r = await post("crawl", { url: `${FX}/?u=${i}`, limit: 200, sitemap: "skip" }); ids.push(r.json?.id); out("admission", { case: `crawl_200_${i}`, ...brief(r) }); }
    const over = await post("crawl", { url: `${FX}/?u=over`, limit: 200, sitemap: "skip" });
    out("admission", { case: "units_over_500", ...brief(over), open_jobs: Number(sql("SELECT count(*) FROM fcpi_platform.job WHERE state IN ('RECEIVED','SUBMITTING','SUBMISSION_UNCERTAIN','QUEUED','RUNNING');")[0]),
      open_units: Number(sql("SELECT coalesce(sum(units),0) FROM fcpi_platform.job WHERE state IN ('RECEIVED','SUBMITTING','SUBMISSION_UNCERTAIN','QUEUED','RUNNING');")[0]) });
    let n = 0, last;
    for (;;) {
      last = await post("crawl", { url: `${FX}/?j=${n}`, limit: 1, sitemap: "skip" });
      if (last.status !== 200) break;
      ids.push(last.json.id); n++;
      if (n > 30) break;
    }
    out("admission", { case: "jobs_over_20", accepted_before_refusal: n, ...brief(last), open_jobs: Number(sql("SELECT count(*) FROM fcpi_platform.job WHERE state IN ('RECEIVED','SUBMITTING','SUBMISSION_UNCERTAIN','QUEUED','RUNNING');")[0]) });
    for (const id of ids.slice(1)) await http("DELETE", `/v2/crawl/${id}`, { tok: "m3a" });
    await http("DELETE", `/v2/crawl/${ids[0]}`, { tok: "m3a" });
    await waitState(ids[0], ["CANCELLED", "FAILED", "SUCCEEDED", "PARTIAL"], 300000);
    const states = ids.map((id) => ledgerJob(id).state);
    out("admission", { case: "cleanup", states: [...new Set(states)], count: states.length, queued_ever_submitted: ids.slice(1).filter((id) => markerGroups(id) > 0).length });
  },

  async crash() {
    const coreLogs = (label) => pi(`bash /opt/firecrawl-pi/scripts/m2/pi-core-logs.sh ${label}`);
    out("core_logs", { label: "crash-before", summary: coreLogs("m3-crash-before").split("\n").filter((l) => /^(classified|control=)/.test(l)) });
    const gwKill = () => D(`kill ${cname("access-gateway")}`).trim();
    const gwStart = async () => { D(`start ${cname("access-gateway")}`); return waitHealthy("access-gateway"); };
    const crawl = (key, limit = 3) => post("crawl", { url: `${FX}/`, limit, sitemap: "skip" }, "m3a", { "x-idempotency-key": key });

    // K1: never delivered. The core is stopped, so the dispatcher cannot connect: acknowledged, kept, submitted once later.
    D(`stop ${cname("firecrawl-core")}`);
    const k1 = await crawl(`m3-k1-${randomUUID()}`);
    out("k1_never_delivered", { case: "submit_with_core_stopped", ...brief(k1), id: k1.json?.id ?? null, ledger: ledgerJob(k1.json.id), events: events(k1.json.id) });
    out("k1_never_delivered", { case: "gateway_killed", result: gwKill() });
    D(`start ${cname("firecrawl-core")}`); await waitHealthy("firecrawl-core");
    await gwStart();
    const k1done = await waitState(k1.json.id, ["SUCCEEDED", "PARTIAL", "FAILED"]);
    out("k1_never_delivered", { case: "finished", state: k1done.state, archived: k1done.archived, marker_groups: markerGroups(k1.json.id), events: events(k1.json.id) });

    // K2: answer lost after the core created the job. The core is paused with the submission in its socket;
    // the gateway dies; the core wakes and creates the crawl; the next gateway maps it by its key.
    D(`pause ${cname("firecrawl-core")}`);
    const k2key = `m3-k2-${randomUUID()}`;
    const k2p = crawl(k2key).then((r) => ({ acknowledged: true, ...brief(r) }), (e) => ({ acknowledged: false, error: e.code ?? e.message }));
    let k2id = null;
    for (let i = 0; i < 60 && !k2id; i++) { await sleep(500); k2id = sql(`SELECT id FROM fcpi_platform.job WHERE state = 'SUBMITTING' ORDER BY created_at DESC LIMIT 1;`)[0] ?? null; }
    out("k2_answer_lost", { case: "in_flight", id: k2id, ledger: ledgerJob(k2id) });
    out("k2_answer_lost", { case: "gateway_killed", result: gwKill(), client: await k2p });
    D(`unpause ${cname("firecrawl-core")}`);
    for (let i = 0; i < 30 && markerGroups(k2id) === 0; i++) await sleep(1000);
    out("k2_answer_lost", { case: "core_created_it_meanwhile", marker_groups: markerGroups(k2id), ledger: ledgerJob(k2id) });
    await gwStart();
    await waitState(k2id, ["QUEUED", "RUNNING", "SUCCEEDED", "PARTIAL"], 120000);
    const retry = await crawl(k2key);
    out("k2_answer_lost", { case: "client_retries_same_key", ...brief(retry), id: retry.json?.id ?? null, first_id: k2id });
    const k2done = await waitState(k2id, ["SUCCEEDED", "PARTIAL", "FAILED"]);
    out("k2_answer_lost", { case: "finished", state: k2done.state, archived: k2done.archived, marker_groups: markerGroups(k2id), events: events(k2id) });

    // K3: the submission is lost. The core is paused with the submission in its socket, the gateway dies, and
    // the core is killed while paused, so it never reads it: uncertain until the settle window, then sent once.
    D(`pause ${cname("firecrawl-core")}`);
    const k3key = `m3-k3-${randomUUID()}`;
    const k3p = crawl(k3key).then((r) => ({ acknowledged: true, ...brief(r) }), (e) => ({ acknowledged: false, error: e.code ?? e.message }));
    let k3id = null;
    for (let i = 0; i < 60 && !k3id; i++) { await sleep(500); k3id = sql(`SELECT id FROM fcpi_platform.job WHERE state = 'SUBMITTING' ORDER BY created_at DESC LIMIT 1;`)[0] ?? null; }
    out("k3_submission_lost", { case: "in_flight", id: k3id, ledger: ledgerJob(k3id) });
    out("k3_submission_lost", { case: "gateway_killed", result: gwKill(), client: await k3p });
    out("core_logs", { label: "k3-before-core-kill", summary: coreLogs("m3-k3-before-kill").split("\n").filter((l) => /^(classified|control=)/.test(l)) });
    out("k3_submission_lost", { case: "core_killed_while_paused", result: D(`kill ${cname("firecrawl-core")}`).trim(), core_state: D(`inspect -f '{{.State.Status}}' ${cname("firecrawl-core")}`).trim() });
    D(`start ${cname("firecrawl-core")}`); await waitHealthy("firecrawl-core");
    out("k3_submission_lost", { case: "core_back", marker_groups: markerGroups(k3id) });
    await gwStart();
    const uncertain = await waitState(k3id, ["SUBMISSION_UNCERTAIN"], 60000).catch(() => null);
    const nat = await http("GET", `/v2/crawl/${k3id}`, { tok: "m3a" });
    const again = await crawl(k3key);
    out("k3_submission_lost", { case: "during_settle_window", ledger_state: uncertain?.state ?? ledgerJob(k3id).state, native_status: brief(nat, { receipt: nat.json?.receipt ?? null, id: nat.json?.id ?? null }),
      client_retry: brief(again, { id: again.json?.id ?? null }) });
    const k3done = await waitState(k3id, ["SUCCEEDED", "PARTIAL", "FAILED"], 600000);
    out("k3_submission_lost", { case: "finished", state: k3done.state, archived: k3done.archived, marker_groups: markerGroups(k3id), events: events(k3id) });

    // K4: the gateway dies while an acknowledged crawl runs; the next process keeps tracking and archives it.
    const k4 = await post("crawl", { url: `${FX}/slow/`, limit: 6, sitemap: "skip" }, "m3a", { "x-idempotency-key": `m3-k4-${randomUUID()}` });
    for (let i = 0; i < 120; i++) { const j = await receipt(k4.json.id); if ((j?.completed ?? 0) >= 1) break; await sleep(1000); }
    out("k4_gateway_crash_running", { case: "acknowledged_running", ...brief(k4), id: k4.json.id, ledger: ledgerJob(k4.json.id) });
    out("k4_gateway_crash_running", { case: "gateway_killed", result: gwKill() });
    await gwStart();
    const k4done = await waitState(k4.json.id, ["SUCCEEDED", "PARTIAL", "FAILED"], 600000);
    out("k4_gateway_crash_running", { case: "finished", state: k4done.state, archived: k4done.archived, marker_groups: markerGroups(k4.json.id), events: events(k4.json.id) });

    // K5: the core dies while an acknowledged crawl runs; NuQ requeues the stalled page, and the job reaches an explicit end.
    const k5 = await post("crawl", { url: `${FX}/slow/`, limit: 6, sitemap: "skip" }, "m3a", { "x-idempotency-key": `m3-k5-${randomUUID()}` });
    for (let i = 0; i < 120; i++) { const j = await receipt(k5.json.id); if ((j?.completed ?? 0) >= 1) break; await sleep(1000); }
    out("core_logs", { label: "k5-before-core-kill", summary: coreLogs("m3-k5-before-kill").split("\n").filter((l) => /^(classified|control=)/.test(l)) });
    out("k5_core_crash_running", { case: "core_killed", id: k5.json.id, ledger: ledgerJob(k5.json.id), result: D(`kill ${cname("firecrawl-core")}`).trim() });
    D(`start ${cname("firecrawl-core")}`); await waitHealthy("firecrawl-core");
    const k5done = await waitState(k5.json.id, ["SUCCEEDED", "PARTIAL", "FAILED", "CANCELLED"], 900000);
    const up = ledgerJob(k5.json.id).upstream;
    const perPage = sql(`SELECT a.logical_id, a.attempts FROM fcpi_retrieval.acquisition a WHERE a.logical_id IN (SELECT id::text FROM nuq.queue_scrape WHERE group_id = '${up}') ORDER BY 2 DESC;`).map((l) => Number(l.split("|")[1]));
    out("k5_core_crash_running", { case: "finished", state: k5done.state, archived: k5done.archived, error: k5done.error, marker_groups: markerGroups(k5.json.id), events: events(k5.json.id), attempts_per_page: perPage,
      stalled_pages: Number(sql(`SELECT count(*) FROM nuq.queue_scrape WHERE group_id = '${up}' AND coalesce(stalls, 0) > 0;`)[0]) });
    out("core_logs", { label: "crash-after", summary: coreLogs("m3-crash-after").split("\n").filter((l) => /^(classified|control=)/.test(l)) });
    saveState({ crashJobs: { k1: k1.json.id, k2: k2id, k3: k3id, k4: k4.json.id, k5: k5.json.id } });
  },

  async expiry() {
    const st = state();
    const jobs = [["crawl", st.graphJob, st.graphDocs], ["batch", st.batchJob, st.batchDocs]];
    const ups = jobs.map(([, id]) => ledgerJob(id).upstream);
    const manifest = Object.fromEntries(jobs.map(([, id]) => [id, sql(`SELECT ordinal, sha256 FROM fcpi_platform.job_document WHERE job_id = '${id}' ORDER BY ordinal;`).map((l) => l.split("|")[1])]));
    const upstreamRows = () => ups.map((u) => ({ upstream: u, nuq_jobs: Number(sql(`SELECT count(*) FROM nuq.queue_scrape WHERE group_id = '${u}';`)[0]), group_row: Number(sql(`SELECT count(*) FROM nuq.group_crawl WHERE id = '${u}';`)[0]) }));
    const redisKeys = (u) => Number(pi(`sudo -n sed -n 's#^redis://:\\(.*\\)@redis:6379$#\\1#p' /etc/firecrawl-pi/secrets/core_redis_url | sudo -n docker exec -i ${cname("redis")} sh -c 'read -r p; REDISCLI_AUTH="$p" redis-cli --no-auth-warning --scan --pattern "crawl:${u}*" | wc -l'`).trim());
    const coreStatus = (kind, u) => pi(`sudo -n docker exec -u 3002 ${cname("firecrawl-core")} node -e "fetch('http://127.0.0.1:3002/v2/${kind === "crawl" ? "crawl" : "batch/scrape"}/${u}').then(r=>console.log(r.status),e=>console.log('error'))"`).trim();
    out("before", { upstream: upstreamRows(), redis_keys: ups.map(redisKeys), core_status: jobs.map(([k], i) => coreStatus(k, ups[i])), cleaner: sql("SELECT jobname || ' ' || schedule FROM cron.job WHERE jobname IN ('nuq_group_crawl_clean', 'nuq_queue_scrape_clean_completed', 'nuq_group_crawl_finished');") });
    // The core's own expiry, brought forward: the group's expiry moves to the past, and pg_cron's
    // nuq_group_crawl_clean (every minute) deletes the group and every job row; Redis's keys expire.
    out("expire", { updated: sql(`UPDATE nuq.group_crawl SET expires_at = now() - interval '1 second' WHERE id IN ('${ups.join("','")}') AND status = 'completed' RETURNING id;`).length });
    for (let i = 0; i < 150 && upstreamRows().some((r) => r.nuq_jobs + r.group_row > 0); i++) await sleep(2000);
    const cron = sql("SELECT status || ' ' || to_char(start_time at time zone 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS\"Z\"') FROM cron.job_run_details d JOIN cron.job j ON j.jobid = d.jobid WHERE j.jobname = 'nuq_group_crawl_clean' ORDER BY d.start_time DESC LIMIT 3;");
    for (const u of ups) pi(`sudo -n sed -n 's#^redis://:\\(.*\\)@redis:6379$#\\1#p' /etc/firecrawl-pi/secrets/core_redis_url | sudo -n docker exec -i ${cname("redis")} sh -c 'read -r p; export REDISCLI_AUTH="$p"; redis-cli --no-auth-warning --scan --pattern "crawl:${u}*" | while read -r k; do redis-cli --no-auth-warning EXPIRE "$k" 1 >/dev/null; done'`);
    await sleep(3000);
    out("core_logs", { label: "expiry-before-core-recreate", summary: pi("bash /opt/firecrawl-pi/scripts/m2/pi-core-logs.sh m3-expiry-before-recreate").split("\n").filter((l) => /^(classified|control=)/.test(l)) });
    pi("sudo -n docker compose -p fcpi -f /opt/firecrawl-pi/deploy/compose.yaml up -d --force-recreate --no-deps --wait --wait-timeout 600 firecrawl-core 2>&1 | tail -2");
    out("after_expiry", { upstream: upstreamRows(), redis_keys: ups.map(redisKeys), core_status: jobs.map(([k], i) => coreStatus(k, ups[i])), cleaner_runs: cron,
      core_container_started: D(`inspect -f '{{.State.StartedAt}}' ${cname("firecrawl-core")}`).trim() });
    for (const [kind, id, before] of jobs) {
      const p = await pages(kind, id, 3);
      out("served_after_expiry", { kind, id, statuses: p.statuses, pages: p.pages, docs: p.docs.length, served_sha256: p.docs.map((d) => d.sha256), manifest_sha256: manifest[id],
        recorded_before_sha256: (before ?? []).map((d) => d.sha256), head: p.head, nexts_private: p.nexts.every((n) => n.startsWith(`${ORIGIN}/`)) });
    }
  },

  async cli() {
    for (const args of [["status"], ["status", "--json"], ["jobs", "--limit", "5"], ["jobs", state().graphJob]]) {
      let r;
      try { r = { code: 0, out: execFileSync(join(ROOT, "scripts/fcpi"), args, { encoding: "utf8", input: token("m3ro"), env: { ...process.env, FCPI_BASE_URL: ORIGIN, FCPI_TOKEN_FILE: "/dev/stdin" } }) }; }
      catch (e) { r = { code: e.status, out: String(e.stdout ?? ""), err: String(e.stderr ?? "") }; }
      out("fcpi", { args: args.map((a) => (a === state().graphJob ? "<graph job>" : a)), exit: r.code, lines: r.out.split("\n").filter(Boolean).slice(0, 12), stderr: r.err ?? null });
    }
    let r;
    try { r = { code: 0 }; execFileSync(join(ROOT, "scripts/fcpi"), ["status"], { encoding: "utf8", env: { ...process.env, FCPI_BASE_URL: "", FCPI_TOKEN_FILE: "/dev/null" } }); }
    catch (e) { r = { code: e.status, err: String(e.stderr ?? "").trim() }; }
    out("fcpi", { case: "no_base_url", exit: r.code, stderr: r.err });
  },

  async ["after-recreate"]() {
    const st = state();
    out("tokens", { case: "still_valid", ...brief(await http("GET", "/platform/v1/status", { tok: "m3a" })) });
    for (const [kind, id, before] of [["crawl", st.graphJob, st.graphDocs], ["batch", st.batchJob, st.batchDocs]]) {
      const p = await pages(kind, id, 5);
      out("served_after_recreate", { kind, id, statuses: p.statuses, docs: p.docs.length, served_sha256: p.docs.map((d) => d.sha256), recorded_before_sha256: (before ?? []).map((d) => d.sha256) });
    }
    const r = await receipt(st.graphJob);
    out("receipts_after_recreate", { graph_state: r?.state, events: r?.events?.length ?? null, crash_jobs: Object.fromEntries(Object.entries(st.crashJobs ?? {}).map(([k, id]) => [k, ledgerJob(id)?.state ?? null])) });
  },
};

if (!PHASES[phase]) { console.error(`usage: e2e.mjs ${Object.keys(PHASES).join("|")}`); process.exit(2); }
out("meta", { phase, source_commit: pi("cat /opt/firecrawl-pi/.fcpi-source-commit").trim(), vantage: "workstation through an SSH forward of 127.0.0.1:3380" });
await openTunnel();
let code = 0;
try { await PHASES[phase](); } catch (e) { out("error", { message: e.message }); code = 1; }
tunnel?.kill();
out("end", { exit: code });
process.exit(code);
