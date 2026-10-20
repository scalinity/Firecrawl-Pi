// Live checks of the deployed search-intelligence release, through the platform as an agent reaches it (the SI5 acceptance review's F05,
// F03, F01 and S4 items). Run from the workstation after the cutover: REST through the playground's SSH forwarder, MCP through an SSH forward
// of the gateway's loopback publication. Prints one JSON line per observation; carries no secret and no page text. Kept outside the repository
// until the version lock is written (the lock builder refuses a HEAD that moved), then archived with the evidence.
//   node live.mjs smoke|versions|f01|ref
import { execFileSync, spawn } from "node:child_process";
import { request } from "node:http";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const REPO = "/Users/danny/Documents/Tools/Firecrawl";
const { sshForward } = await import(pathToFileURL(`${REPO}/scripts/playground/server.mjs`).href);
const forward = sshForward();
const phase = process.argv[2];
const corpus = JSON.parse(readFileSync(`${REPO}/evidence/search-intelligence/SI0/corpus/corpus-v1.json`, "utf8")).queries;
const out = (o) => console.log(JSON.stringify({ utc: new Date().toISOString(), ...o }));
const T = Object.fromEntries(readFileSync(`${REPO}/scripts/m1/pi-target.conf`, "utf8").split("\n").filter((l) => /^PI_\w+=/.test(l)).map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1).replace("$HOME", process.env.HOME)]));

// The public /v2/search body of a corpus query: domain constraints at the top, documentation options and date bounds in searchIntelligence.
const bodyOf = (q) => { const c = q.constraints ?? {}, si = { ...(q.searchIntelligence ?? {}) };
  if (c.publishedAfter) si.publishedAfter = c.publishedAfter; if (c.publishedBefore) si.publishedBefore = c.publishedBefore;
  return { query: q.query, limit: 10, ...(c.includeDomains?.length ? { includeDomains: c.includeDomains } : {}), ...(c.excludeDomains?.length ? { excludeDomains: c.excludeDomains } : {}), ...(Object.keys(si).length ? { searchIntelligence: si } : {}) }; };
const rest = async (body, timeout = 90) => { const t0 = Date.now(); const r = await forward({ method: "POST", path: "/v2/search", timeout, body }); return { status: r.status, data: r.data, ms: Date.now() - t0 }; };
const searchOf = (data) => data?.fcpi?.search ?? data?.data?.fcpi?.search ?? null;
const rowsOf = (data) => data?.web ?? data?.data?.web ?? [];

// ---- MCP, the modern stateless wire (scripts/m4/mcp-e2e.mjs): an SSH forward of the loopback publication, the token in memory only.
const ssh = (cmd) => execFileSync("ssh", ["-i", T.PI_SSH_KEY, "-o", "IdentitiesOnly=yes", "-o", "BatchMode=yes", "-o", "ConnectTimeout=15", T.PI_SSH_TARGET, cmd], { encoding: "utf8" });
const MODERN = "2026-07-28", META = { "io.modelcontextprotocol/protocolVersion": MODERN, "io.modelcontextprotocol/clientCapabilities": {}, "io.modelcontextprotocol/clientInfo": { name: "fcpi-si6-live", version: "1" } };
async function mcpCall(name, args) {
  const token = ssh("sudo -n cat /etc/firecrawl-pi/secrets/clients/m9codex.token").trim();
  const tunnel = spawn("ssh", ["-i", T.PI_SSH_KEY, "-o", "IdentitiesOnly=yes", "-o", "BatchMode=yes", "-N", "-o", "ExitOnForwardFailure=yes", "-L", "127.0.0.1:3391:127.0.0.1:3380", T.PI_SSH_TARGET], { stdio: "ignore" });
  try {
    for (let i = 0; i < 40; i++) { const up = await new Promise((r) => { const s = request({ host: "127.0.0.1", port: 3391, path: "/healthz", timeout: 500 }, (res) => { res.resume(); r(true); }); s.on("error", () => r(false)); s.on("timeout", () => { s.destroy(); r(false); }); s.end(); }); if (up) break; await new Promise((r) => setTimeout(r, 250)); }
    const payload = JSON.stringify({ jsonrpc: "2.0", id: 7, method: "tools/call", params: { name, arguments: args, _meta: META } });
    return await new Promise((resolve, reject) => {
      const req = request({ host: "127.0.0.1", port: 3391, path: "/mcp", method: "POST", timeout: 120000, agent: false, headers: { host: "127.0.0.1:3380", "content-type": "application/json", accept: "application/json, text/event-stream", authorization: `Bearer ${token}`, "mcp-protocol-version": MODERN, "mcp-method": "tools/call", "mcp-name": name, "content-length": Buffer.byteLength(payload) } }, (res) => {
        let t = ""; res.setEncoding("utf8"); res.on("data", (c) => (t += c)); res.on("end", () => { try { const json = /json/.test(res.headers["content-type"] ?? "") ? JSON.parse(t) : JSON.parse(t.split("\n").filter((l) => l.startsWith("data:")).map((l) => l.slice(5).trim()).filter(Boolean).at(-1)); resolve({ status: res.statusCode, json }); } catch (e) { reject(new Error(`unparseable MCP answer (${res.statusCode}): ${t.slice(0, 120)}`)); } });
      }); req.on("error", reject); req.on("timeout", () => { req.destroy(); reject(new Error("MCP timeout")); }); req.end(payload);
    });
  } finally { tunnel.kill(); }
}

if (phase === "smoke" || phase === "mcp") {
  const args = { query: "How do I declare reactive state with ref() in Vue 3.5?", limit: 5, searchIntelligence: { documentation: "required" } };
  const r = phase === "mcp" ? { status: 0, data: null, ms: 0 } : await rest(args); const s = searchOf(r.data), rows = rowsOf(r.data);
  if (phase !== "mcp") out({ check: "rest_search", status: r.status, ms: r.ms, top_keys: Object.keys(r.data ?? {}), search_schema: s?.schema ?? null, outcome: s?.outcome ?? null, rows: rows.length, rows_with_fcpi_search: rows.filter((w) => w?.fcpi?.search?.documentId).length,
    top_level_search: !!s, coverage_present: !!s?.coverage, providers: Object.keys(s?.providers ?? {}), warnings: s?.warnings ?? null, enrichment: s?.documentation?.enrichment ?? null });
  const m = await mcpCall("firecrawl_search", args); const text = m.json?.result?.content?.[0]?.text ?? ""; let payload = null; try { payload = JSON.parse(text); } catch { /* reported below */ }
  const ms = payload?.fcpi?.search ?? payload?.data?.fcpi?.search ?? null, mrows = payload?.data?.web ?? payload?.web ?? [];
  out({ check: "mcp_search", status: m.status, is_error: !!m.json?.result?.isError, parsed: !!payload, top_keys: Object.keys(payload ?? {}), top_level_search: !!ms, coverage_present: !!ms?.coverage, rows: mrows.length, rows_with_fcpi_search: mrows.filter((w) => w?.fcpi?.search?.documentId || w?.fcpi?.search?.canonicalUrl).length, warnings: ms?.warnings ?? null, bytes: text.length });
  if (phase === "mcp") process.exit(0);
  const sc = await forward({ method: "POST", path: "/v2/scrape", timeout: 60, body: { url: "https://example.com/", formats: ["markdown"] } });
  out({ check: "rest_scrape", status: sc.status, markdown_chars: (sc.data?.data?.markdown ?? sc.data?.markdown ?? "").length });
} else if (phase === "versions") {
  const hard = corpus.filter((q) => q.split === "heldout" && (q.searchIntelligence?.libraries ?? []).some((l) => l.version && !/^latest$/i.test(l.version)));
  for (const q of hard) {
    const r = await rest(bodyOf(q)); const s = searchOf(r.data);
    out({ check: "version_report", id: q.id, status: r.status, ms: r.ms, outcome: s?.outcome ?? null, rows: rowsOf(r.data).length, versions: s?.coverage?.documentation?.versions ?? null, warnings: s?.warnings ?? null, activation: s?.documentation?.activation?.reason ?? null,
      expectNoMatch: q.expectNoMatch === true, requested: (q.searchIntelligence.libraries ?? []).map((l) => `${l.name}@${l.version ?? ""}`) });
  }
} else if (phase === "f01") {
  const ids = ["Q081", "Q085", "Q094", "Q096"]; const reps = Number(process.argv[3] ?? 5);
  for (const id of ids) { const q = corpus.find((x) => x.id === id);
    for (let i = 1; i <= reps; i++) { const r = await rest({ ...bodyOf(q), searchIntelligence: { ...(q.searchIntelligence ?? {}), documentation: "auto" } }); const a = searchOf(r.data)?.documentation?.activation;
      out({ check: "activation_repeat", id, run: i, status: r.status, ms: r.ms, active: a?.active ?? null, reason: a?.reason ?? null, probability: a?.uncertainty ?? null, signals: a?.signals ?? null }); } }
} else if (phase === "ref") {
  const docs = corpus.filter((q) => q.documentationRelevance === "positive" && q.documentationExplicit).slice(0, 6); let seen = 0;
  for (const q of docs) { const r = await rest({ ...bodyOf(q), searchIntelligence: { ...(q.searchIntelligence ?? {}), documentation: "required" } }); const e = searchOf(r.data)?.documentation?.enrichment ?? null;
    out({ check: "ref_enrichment", id: q.id, status: r.status, ms: r.ms, attempted: !!e, enrichment: e }); if (e) { seen++; if (seen >= 2) break; } }
} else { console.error("usage: live.mjs smoke|versions|f01|ref"); process.exit(2); }
