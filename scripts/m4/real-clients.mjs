#!/usr/bin/env node
// M4's real target clients (spec §18; AC13's "actual target-client evidence distinguished from SDK
// fixtures"): Claude Code on Haiku and Codex CLI on gpt-6-luna, both installed on the workstation, each
// given the /mcp endpoint over the tailnet (Tailscale Serve, TLS) with a gateway token of its own
// (m4claude, m4codex), and one short headless prompt against the M3 fixture: scrape a page, start a
// crawl, read its status. Each run uses a model on the owner's account, as the owner approved for M4, so
// it is a held live step: run after the review is addressed.
//   node scripts/m4/real-clients.mjs > evidence/M4/raw/real-clients.txt
// - Claude Code reads deploy/clients/claude-code.mcp.json with --strict-mcp-config, so no other MCP
//   server loads, and runs with no built-in tool (--tools "") and no user settings (--setting-sources
//   project in an empty directory: no hooks, plugins or user permissions); Codex runs with --ignore-user-config and the server from deploy/clients/codex.config.toml
//   given as -c overrides, so none of the owner's other servers or plugins load either.
// - The token reaches each client only through its environment (FCPI_MCP_TOKEN), never a command line or
//   a file; each runs in an empty temporary directory, so no project instructions are loaded.
// - What each client did is read from the Pi: the MCP service's records for its token's label (era,
//   protocol revision, tools, outcomes) and the gateway's. The clients' own model-provider traffic
//   (Anthropic, OpenAI) is theirs, labelled here, and never touches the platform.
import { execFileSync, spawn } from "node:child_process";
import { readFileSync, mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");
const T = Object.fromEntries(readFileSync(join(ROOT, "scripts/m1/pi-target.conf"), "utf8").split("\n").filter((l) => /^PI_\w+=/.test(l)).map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1).replace("$HOME", process.env.HOME)]));
const pi = (cmd) => execFileSync("ssh", ["-i", T.PI_SSH_KEY, "-o", "IdentitiesOnly=yes", "-o", "BatchMode=yes", "-o", "ConnectTimeout=15", T.PI_SSH_TARGET, cmd], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
const FX = "http://m3.fixture.fcpi.test:8080";
const origin = pi("sudo -n cat /etc/firecrawl-pi/secrets/gateway/served-origins").split("\n").map((l) => l.trim()).filter((l) => /^https:\/\//.test(l));
if (origin.length !== 1) throw new Error(`expected one https served origin, found ${origin.length}`);
const URL_MCP = `${origin[0]}/mcp`, HOSTNAME = new URL(origin[0]).hostname;
const hideIds = (s) => [[T.PI_SSH_KEY, "<pi-ssh-key>"], [T.PI_SSH_TARGET, "<pi-ssh-target>"], [T.PI_LAN_ADDRESS, "<pi-lan-address>"], [HOSTNAME, "<pi-tailnet-name-host>"], [process.env.HOME, "<home>"]]
  .reduce((x, [a, b]) => (a ? x.split(a).join(b) : x), s).replace(/\b[a-z0-9-]+\.ts\.net\b/gi, "<pi-tailnet-name-host>").replace(/\b100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.\d{1,3}\.\d{1,3}\b/g, "<tailnet-address>");
let current = null;
const out = (section, rec) => { if (section !== current) { process.stdout.write(`### ${section}\n`); current = section; } process.stdout.write(`${hideIds(JSON.stringify({ utc: new Date().toISOString(), ...rec }))}\n`); };
const version = (cmd) => execFileSync(cmd, ["--version"], { encoding: "utf8" }).trim().split("\n")[0];
const PROMPT = `Use only the tools of the MCP server named fcpi. Do these steps in order:
1. Call firecrawl_scrape with url ${FX}/p06 and formats ["markdown"]. In the page's markdown find the sentinel, a string that starts with fcpi-m3-.
2. Call firecrawl_crawl with url ${FX}/, limit 2 and sitemap "include". It returns a job id.
3. Call firecrawl_check_crawl_status with that id. If its status is not completed, call it again, at most 10 times in total.
Then reply with exactly one line and nothing else: SENTINEL=<the sentinel> CRAWL=<the last status> DOCS=<the number of documents returned>`;

function run(cmd, args, env, cwd) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const p = spawn(cmd, args, { cwd, env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"] });
    let so = "", se = "";
    p.stdout.on("data", (c) => (so += c));
    p.stderr.on("data", (c) => (se += c));
    const kill = setTimeout(() => p.kill("SIGTERM"), 600000);
    p.on("close", (code) => { clearTimeout(kill); resolve({ code, stdout: so, stderr: se, ms: Date.now() - t0 }); });
  });
}
const piNow = () => pi("date -u +%Y-%m-%dT%H:%M:%S.%3NZ").trim();
const logs = (svc, since) => pi(`sudo -n docker logs --since ${since} fcpi-${svc}-1 2>&1`).split("\n").filter((l) => l.startsWith("{")).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
// The crawl a client started, as the ledger ends it: what the platform guarantees is that the job finishes
// durably, whether or not the client's model polled until it did (it has no way to wait between calls).
const ledgerJob = (id) => {
  if (!/^[0-9a-f-]{36}$/.test(id ?? "")) return null;
  const q = `SELECT state || '|' || archived FROM fcpi_platform.job WHERE id = '${id}';`;
  const row = execFileSync("ssh", ["-i", T.PI_SSH_KEY, "-o", "IdentitiesOnly=yes", "-o", "BatchMode=yes", "-o", "ConnectTimeout=15", T.PI_SSH_TARGET,
    "sudo -n docker exec -i fcpi-nuq-postgres-1 psql -U postgres -d postgres -q -At -X -v ON_ERROR_STOP=1"], { encoding: "utf8", input: q }).trim();
  const [state, archived] = row.split("|");
  return state ? { state, archived: Number(archived) } : null;
};
async function crawlOutcome(id) {
  for (let i = 0; i < 60; i++) {
    const j = ledgerJob(id);
    if (!j || ["SUCCEEDED", "PARTIAL", "FAILED", "CANCELLED", "EXPIRED"].includes(j.state)) return { id, ...(j ?? { state: null }) };
    await new Promise((res) => setTimeout(res, 2000));
  }
  return { id, ...(ledgerJob(id) ?? { state: null }) };
}
async function piView(label, since) {
  const ml = logs("mcp-gateway", since).filter((l) => l.client === label);
  const gl = logs("access-gateway", since).filter((l) => l.client === label);
  const crawlId = ml.find((l) => l.event === "tool" && l.tool === "firecrawl_crawl" && l.outcome === "ok")?.job ?? null;
  out("pi_view", { client: label, crawl_job: crawlId ? await crawlOutcome(crawlId) : null,
    exchanges: ml.filter((l) => l.event === "exchange").map((l) => ({ client_info: l.client_info ?? null, http_method: l.http_method, mcp_method: l.mcp_method, protocol_version: l.protocol_version, status: l.status, content_type: l.content_type, session_header_sent: l.session_header_sent })),
    tools: ml.filter((l) => l.event === "tool").map((l) => ({ client_info: l.client_info ?? null, era: l.era, protocol_version: l.protocol_version, tool: l.tool, job: l.job, outcome: l.outcome, downstream_status: l.downstream?.status ?? null })),
    gateway: gl.map((l) => ({ method: l.method, route: l.route, status: l.status, mcp_method: l.mcp_method ?? null })) });
}
// Codex's server, exactly as deploy/clients/codex.config.toml states it (the template the owner copies),
// with the served origin in place of its placeholder: each key of [mcp_servers.fcpi] becomes a -c override.
function codexServer() {
  const lines = readFileSync(join(ROOT, "deploy/clients/codex.config.toml"), "utf8").split("\n");
  const start = lines.findIndex((l) => l.trim() === "[mcp_servers.fcpi]");
  if (start < 0) throw new Error("deploy/clients/codex.config.toml has no [mcp_servers.fcpi] table");
  const out = [];
  for (const l of lines.slice(start + 1)) {
    if (/^\s*\[/.test(l)) break;
    const m = l.match(/^\s*([a-z_]+)\s*=\s*(.+?)\s*$/);
    if (m) out.push("-c", `mcp_servers.fcpi.${m[1]}=${m[2].replace("https://<pi-tailnet-name-host>:8443", origin[0])}`);
  }
  if (!out.some((x) => x.startsWith("mcp_servers.fcpi.url=")) || !out.some((x) => x.startsWith("mcp_servers.fcpi.bearer_token_env_var="))) throw new Error("the Codex template lacks url or bearer_token_env_var");
  return out;
}
// The answer line, normalised: a model may wrap a value in backticks or end the line with a period, and a
// correct answer should not fail for it; each value must still be exactly the kind it names.
const answerLine = (s) => {
  const m = String(s ?? "").match(/SENTINEL=`?(fcpi-m3-[a-z0-9]+-[0-9a-f]{4})`?\s+CRAWL=`?([a-z]+)`?\s+DOCS=`?(\d+)/);
  return m ? `SENTINEL=${m[1]} CRAWL=${m[2]} DOCS=${m[3]}` : null;
};

out("meta", { platform: process.platform, deployed_commit: pi("cat /opt/firecrawl-pi/.fcpi-source-commit").trim(), pi_utc: piNow(), endpoint: "https://<pi-tailnet-name-host>:8443/mcp" });
// Each real client's token, as the registry holds it: its principal and scopes (only what the prompt needs).
for (const l of pi("bash /opt/firecrawl-pi/scripts/m3/pi-client-token.sh list").split("\n").filter((x) => /^m4(claude|codex) /.test(x))) {
  const [label, principal, scopes] = [l.split(" ")[0], (l.match(/principal=(\S+)/) ?? [])[1], (l.match(/scopes=(\S+)/) ?? [])[1]];
  out("tokens", { label, principal, scopes });
}
let code = 0;
const dir = mkdtempSync(join(tmpdir(), "fcpi-m4-real-"));
try {
  // ---- Claude Code on Haiku ----
  {
    const since = piNow();
    const token = pi("sudo -n cat /etc/firecrawl-pi/secrets/clients/m4claude.token").trim();
    const cfg = join(ROOT, "deploy/clients/claude-code.mcp.json");
    const r = await run("claude", ["-p", PROMPT, "--model", "haiku", "--mcp-config", cfg, "--strict-mcp-config", "--output-format", "json",
      // No built-in tool (Bash, Read, Edit and the rest), and no user settings: no hooks, plugins or user
      // permissions. Only the fcpi server's tools are there to call. (--bare would also skip the keychain
      // the login lives in.)
      "--tools", "", "--setting-sources", "project",
      "--allowedTools", "mcp__fcpi__firecrawl_scrape mcp__fcpi__firecrawl_crawl mcp__fcpi__firecrawl_check_crawl_status"], { FCPI_MCP_URL: URL_MCP, FCPI_MCP_TOKEN: token }, dir);
    let j = null; try { j = JSON.parse(r.stdout); } catch { /* not JSON */ }
    out("claude_code", { client: version("claude"), model_alias: "haiku", models_used: j?.modelUsage ? Object.keys(j.modelUsage) : null, exit: r.code, ms: r.ms, is_error: j?.is_error ?? null,
      permission_denials: Array.isArray(j?.permission_denials) ? j.permission_denials.map((d) => d.tool_name ?? null) : null,
      num_turns: j?.num_turns ?? null, total_cost_usd: j?.total_cost_usd ?? null, answer: answerLine(j?.result), result_head: String(j?.result ?? r.stdout).slice(0, 400), stderr_head: r.stderr.slice(0, 300) });
    await new Promise((res) => setTimeout(res, 1500));
    await piView("m4claude", since);
  }
  // ---- Codex CLI on gpt-6-luna ----
  {
    const since = piNow();
    const token = pi("sudo -n cat /etc/firecrawl-pi/secrets/clients/m4codex.token").trim();
    const last = join(dir, "codex-last.txt");
    const r = await run("codex", ["exec", "--ignore-user-config", "--skip-git-repo-check", "-s", "read-only", "-m", "gpt-6-luna",
      ...codexServer(), "-c", 'approval_policy="never"',
      "-o", last, PROMPT], { FCPI_MCP_TOKEN: token }, dir);
    const answer = existsSync(last) ? readFileSync(last, "utf8") : "";
    out("codex", { client: version("codex"), model: "gpt-6-luna", exit: r.code, ms: r.ms, answer: answerLine(answer), result_head: answer.slice(0, 400), stderr_tail: r.stderr.slice(-400) });
    await new Promise((res) => setTimeout(res, 1500));
    await piView("m4codex", since);
  }
} catch (e) {
  out("error", { message: String(e?.stack ?? e).slice(0, 600) });
  code = 1;
} finally { rmSync(dir, { recursive: true, force: true }); }
out("end", { exit: code });
process.exit(code);
