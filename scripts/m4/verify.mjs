#!/usr/bin/env node
// M4 verification (docs/FIRECRAWL_PI_MILESTONES.md, M4 "Automated Verification" and "Acceptance Criteria";
// spec AC12, AC13, AC01 and AC24 through MCP; CLAUDE.md §25, §26, §33.3). Every check recomputes its result
// from the raw evidence under evidence/M4/ (or the directory FCPI_M4_EVIDENCE names) and records the §25
// tuple, with code_dirty, in evidence/M4/verification.json. A check whose evidence is missing is NOT_RUN,
// never PASS; a record a check reads must be there (an absent one fails, it does not pass vacuously); every
// negative result is read beside its positive control; each check's `expected` names what it compares.
//   node scripts/m4/verify.mjs [CHECK_ID …]
import { readFileSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { ROOT, sha256, sha256File, repoState, sections, git, kv } from "../m0/lib.mjs";

const EV = process.env.FCPI_M4_EVIDENCE ?? "evidence/M4/";
const RAW = `${EV}raw/`;
const OUT = `${EV}verification.json`;
const UPSTREAM_SHA = "7666c1f9ae8720a6bba271e0f60b6a217f8a5210";
const M4_START = "0abf44c"; // the kickoff's HEAD: files changed after it are M4's
const MODERN = "2026-07-28", LEGACY = "2025-11-25", FX = "http://m3.fixture.fcpi.test:8080";
const MIB = 1024 * 1024;
const read = (p) => readFileSync(resolve(ROOT, p), "utf8");
const json = (p) => JSON.parse(read(p));
const has = (p) => existsSync(resolve(ROOT, p));
const now = () => new Date().toISOString().replace(/\.\d+Z$/, "Z");
const hashOf = (paths) => sha256(paths.map((p) => `${p}:${sha256File(p)}`).join("\n"));
const MANIFEST = json("deploy/policies/capabilities.json");
const TOOLS = MANIFEST.mcp.tools.map((t) => t.name).sort();
const target = () => {
  const t = Object.fromEntries(read("scripts/m1/pi-target.conf").split("\n").filter((l) => /^PI_\w+=/.test(l)).map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1).replace("$HOME", process.env.HOME)]));
  if (!t.PI_SSH_TARGET || !t.PI_SSH_KEY || !t.PI_LAN_ADDRESS) throw new Error("scripts/m1/pi-target.conf lacks PI_SSH_TARGET, PI_SSH_KEY or PI_LAN_ADDRESS");
  return t;
};
const ssh = (cmd) => { const t = target(); return execFileSync("ssh", ["-i", t.PI_SSH_KEY, "-o", "IdentitiesOnly=yes", "-o", "BatchMode=yes", "-o", "ConnectTimeout=15", t.PI_SSH_TARGET, cmd], { encoding: "utf8" }); };
const hideIds = (s, t) => [[t.PI_SSH_KEY, "<pi-ssh-key>"], [t.PI_SSH_TARGET, "<pi-ssh-target>"], [t.PI_LAN_ADDRESS, "<pi-lan-address>"], [process.env.HOME, "<home>"]]
  .reduce((x, [a, b]) => (a ? x.split(a).join(b) : x), s);
const digestOf = (ref) => (ref.match(/@(sha256:[0-9a-f]{64})$/) ?? [])[1] ?? null;
const composeImage = (svc) => json(`${EV}rendered-compose.json`).services[svc]?.image ?? "";
const S = (f) => sections(f);
const jsonLines = (lines) => (lines ?? []).filter((l) => l.startsWith("{")).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
// A JSON-line transcript: { section: [records] }; a section that appears again adds to its records.
function records(path) {
  const out = {};
  let cur = null;
  for (const line of read(path).split("\n")) {
    const m = line.match(/^### (\S+)$/);
    if (m) { cur = m[1]; out[cur] ??= []; continue; }
    if (cur && line.startsWith("{")) { try { out[cur].push(JSON.parse(line)); } catch { /* not a record */ } }
  }
  return out;
}
const E = (name) => records(`${RAW}e2e-${name}.txt`);
const one = (recs, c) => (recs ?? []).find((r) => r.case === c) ?? null;
// One run per transcript: exactly one meta and one end record, the end with exit 0, and no error.
const endOk = (e) => e.meta?.length === 1 && e.end?.length === 1 && e.end[0].exit === 0 && !e.error;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const sentinelOf = (s, page) => typeof s === "string" && new RegExp(`^fcpi-m3-${page}-[0-9a-f]{4}$`).test(s);
const tapCounts = (lines) => { const n = (k) => +((lines ?? []).find((l) => l.startsWith(`# ${k} `)) ?? "").split(" ")[2]; return { tests: n("tests"), pass: n("pass"), fail: n("fail") }; };
const PHASES = ["wire", "sdk", "cancel", "restart", "stopped", "tailnet"];
const bad = (cond) => Object.entries(cond).filter(([, v]) => !v).map(([k]) => k);

// ---- redaction (M3's rules and controls, M4's live secrets) ------------------------------------------
const M0_CONTROL = "tests/contracts/m0-redaction-control.txt", M1_CONTROL = "tests/contracts/m1-redaction-control.txt", M3_CONTROL = "tests/contracts/m3-redaction-control.txt";
const RULES = [
  ["private-key", /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
  ["github-token", /\b(gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{20,})/],
  ["openai-style-key", /\bsk-[A-Za-z0-9_-]{20,}/],
  ["aws-key", /\bAKIA[0-9A-Z]{16}\b/],
  ["slack-token", /\bxox[baprs]-[A-Za-z0-9-]{10,}/],
  ["jwt", /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/],
  ["bearer", /Bearer\s+[A-Za-z0-9._~+/-]{20,}/],
  ["credential-assignment", /\b(password|passwd|secret|api[_-]?key|access[_-]?token|auth[_-]?token)\b\s*[:=]\s*["']?(?!REDACTED|<|\$\{|null|false|true|none|string|undefined)[A-Za-z0-9+/_\-.]{8,}/i],
  ["url-credentials", /[a-z][a-z0-9+.-]*:\/\/[^\s/:@<]+:[^\s/@]+@/i],
  ["local-path", /\/(private\/tmp|Users\/[^\/\s]+|home\/[^\/\s]+)\//],
  ["mac-address", /(?<![0-9A-Fa-f:])(?:[0-9A-Fa-f]{2}[:-]){5}[0-9A-Fa-f]{2}(?![0-9A-Fa-f:])/],
  ["imager-instance-id", /rpi-imager-\d{6,}/],
  ["url-empty-user-credentials", /[a-z][a-z0-9+.-]*:\/\/:[A-Za-z0-9._~%+-]{8,}@/i],
  ["rabbitmq-default-pass", /\bdefault_pass\s*=\s*(?!%s|<)\S{8,}/],
  ["fcpi-client-token", /\bfcpi_[a-z0-9]+_[0-9a-f]{32,}\b/],
  ["tailnet-name", /\b[a-z0-9-]+\.ts\.net\b/i],
  ["tailnet-address", /(?<![\d.])100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.\d{1,3}\.\d{1,3}(?![\d.\/])|\bfd7a:115c:a1e0::[0-9a-f]{1,4}:[0-9a-f]{1,4}\b/i],
];
const ALLOW = new Set(["00:00:00:00:00:00", "02:00:00:00:00:01", "02:00:00:00:00:02", "02:00:00:00:00:99",
  "amqp://fcpi:%s@", "amqp://fcpi:$rmqpw@", String.raw`amqp://fcpi:\\(.*\\)@`, "http://user:pw@",
  "password: r.proxy.password", "password: cred.password", "password = randomBytes", "password: readSecret",
  "example-tailnet.ts.net", "other-tailnet.ts.net", "pi.ts.net", "tailXXXX.ts.net",
  "100.100.100.100", "100.64.0.0", "100.64.0.1", "100.127.255.254"]);
const HASH_RULES = ["raw-egress-ip", "raw-board-serial", "raw-machine-id", "unexplained-mac-hash", "live-secret-by-hash-hex", "live-secret-by-hash-cookie"];
function scan(files, ids, rules = RULES, allow = ALLOW) {
  const hits = [];
  const secrets = ids.secrets;
  for (const f of files) read(f).split("\n").forEach((line, i) => {
    const at = `${f}:${i + 1}`;
    for (const [name, re] of rules) if ([...line.matchAll(new RegExp(re.source, re.flags.includes("g") ? re.flags : re.flags + "g"))].some((m) => !allow.has(m[0]))) hits.push(`${at} ${name}`);
    if (ids.m0) {
      for (const m of line.match(/\b\d{1,3}(?:\.\d{1,3}){3}\b/g) ?? []) if (sha256(m) === ids.m0.egress) hits.push(`${at} raw-egress-ip`);
      for (const m of line.match(/(?<![0-9A-Fa-f])[0-9A-Fa-f]{16}(?![0-9A-Fa-f])/g) ?? []) if (sha256(m.toLowerCase()) === ids.m0.serial) hits.push(`${at} raw-board-serial`);
      for (const m of line.match(/(?<![0-9A-Fa-f])[0-9A-Fa-f]{32}(?![0-9A-Fa-f])/g) ?? []) if (sha256(m.toLowerCase()) === ids.m0.machineId) hits.push(`${at} raw-machine-id`);
      for (const m of line.matchAll(/MAC_SHA256:([0-9a-f]{64})/g)) if (!ids.m0.macs.has(m[1])) hits.push(`${at} unexplained-mac-hash`);
    }
    if (secrets) {
      for (const m of line.match(/(?<![0-9A-Fa-f])[0-9a-f]{64}(?![0-9A-Fa-f])/g) ?? []) if (secrets.has(sha256(m))) hits.push(`${at} live-secret-by-hash-hex`);
      for (const m of line.match(/fcpi_[a-z0-9]+_[0-9a-f]{64}/g) ?? []) if (secrets.has(sha256(m))) hits.push(`${at} live-secret-by-hash-hex`);
      for (const m of line.match(/(?<![A-Z])[A-P]{64}(?![A-Z])/g) ?? []) if (secrets.has(sha256(m))) hits.push(`${at} live-secret-by-hash-cookie`);
    }
  });
  return hits;
}

// ---- snapshot attribution (scripts/m3/verify.mjs X04, with M4's bridge) -------------------------------
function keyedSnapshot(file) {
  const out = []; let sec = null;
  for (const l of read(file).split("\n")) {
    const m = l.match(/^### (\S+)$/);
    if (m) { sec = m[1]; continue; }
    if (sec && sec !== "meta" && l !== "end" && l !== "") out.push([sec, l]);
  }
  return out;
}
function ruleSet(path) {
  const out = new Set();
  let table = null, chain = null, inSet = false;
  for (const raw of read(path).replace(/# Warning: table \S+ \S+ is managed by iptables-nft, do not touch!\n/g, "").split("\n")) {
    const l = raw.trim();
    let m;
    if ((m = l.match(/^table (\S+ \S+) \{$/))) { table = m[1]; chain = null; inSet = false; continue; }
    if ((m = l.match(/^chain (\S+) \{$/))) { chain = m[1]; inSet = false; continue; }
    if (/^(set|map) \S+ \{$/.test(l)) { inSet = true; chain = null; continue; }
    if (l === "}") { if (inSet) inSet = false; else if (chain) chain = null; else table = null; continue; }
    if (table && chain && !inSet && l && !l.startsWith("#")) out.add(`${table}\t${chain}\t${l}`);
  }
  return out;
}
const MODULE_ALLOW = /^(bridge|stp|llc|veth|overlay|br_netfilter|ip_set|xt_[a-z_]+|xt_[A-Z]+|x_tables|nf_[a-z0-9_]+|nft_[a-z0-9_]+|ip6?_tables|ip6?table_[a-z]+|iptable_[a-z]+|ipt_[A-Z]+|xfrm_algo|xfrm_user|nf_tables|nfnetlink)$/;
// The owner's own work on the Pi in the window (scripts/m4/pi-owner-session.sh): an apt upgrade, an editor
// server on loopback. A line is the owner's only when that record names its cause.
function ownerContext() {
  if (!has(`${RAW}owner-session.txt`)) return null;
  const s = S(`${RAW}owner-session.txt`), journal = s.journal ?? [];
  return { apt: (s.apt_runs ?? []).some((l) => /^Commandline: apt (upgrade|full-upgrade)\b/.test(l)), dm: journal.some((l) => /kernel: device-mapper: ioctl/.test(l)),
    tracefs: journal.some((l) => /kernel: NOTICE: Automounting of tracing/.test(l)),
    ports: new Set((s.loopback_listeners ?? []).filter((l) => /exe=<owner-home>\/\.cursor-server\//.test(l)).flatMap((l) => (l.match(/ports=(.*)$/)?.[1] ?? "").trim().split(/\s+/))) };
}
function attribute(sec, line, ids, owner = null) {
  if (sec === "lsmod" && /^dm_mod \d+$/.test(line) && owner?.dm && owner.apt) return "the owner's apt upgrade: device-mapper loaded by its hooks (raw/owner-session.txt)";
  if (sec === "findmnt" && /^\/sys\/kernel\/debug\/tracing tracefs tracefs /.test(line) && owner?.tracefs) return "the owner's session: tracefs automounted (raw/owner-session.txt)";
  { const m = line.match(/^tcp (127\.0\.0\.1:\d+) users:\(\("MainThread",pid,fd\)\)$/); if (sec === "ss_listen" && m && owner?.ports.has(m[1])) return "the owner's editor server on loopback (raw/owner-session.txt)"; }
  { const m = line.match(/^udp (?:0\.0\.0\.0|\*):(\d+) users:\(\("pihole-FTL",pid,fd\)\)$/); if (sec === "ss_listen" && m && +m[1] >= 32768) return "Pi-hole's own ephemeral upstream socket, rotated by Pi-hole"; }
  if (sec === "systemd_running" && /^session-\d+\.scope$/.test(line)) return "own SSH session scope";
  if (sec === "systemd_running") { const m = line.match(/^docker-([0-9a-f]{64})\.scope$/); if (m && ids.has(m[1])) return "scope of an fcpi container"; }
  if (sec === "docker_ps") { const f = line.split("\t"); if (f.length === 4 && /^fcpi-/.test(f[1]) && ids.has(f[0])) return "fcpi container"; }
  if (sec === "findmnt") {
    if (/^\/run\/docker\/netns\/[0-9a-f]+ nsfs\[net:\[\d+\]\] nsfs rw$/.test(line)) return "container network namespace";
    const m = line.match(/^\/var\/lib\/docker\/rootfs\/overlayfs\/([0-9a-f]{64}) overlay overlay /);
    if (m && ids.has(m[1])) return "fcpi container root filesystem";
  }
  if (sec === "lsmod" && MODULE_ALLOW.test(line.split(" ")[0])) return "kernel module for the container runtime or the guard's sets";
  if (sec === "firewall" && /^nft_ruleset_sha256=/.test(line)) return "nftables ruleset: every changed rule attributed in X04 (evidence/M4/raw/nft-ruleset.txt)";
  if (sec === "nft_chains" && /^ip6? (filter|nat|raw) (DOCKER[-A-Z0-9]*|FORWARD|PREROUTING|OUTPUT|POSTROUTING) /.test(line)) return "Docker's chains";
  return null;
}

// ---- memory samples (every phase's, M01) --------------------------------------------------------------
const samples = () => PHASES.flatMap((p) => (has(`${RAW}e2e-${p}.txt`) ? (E(p).resources ?? []).map((r) => ({ run: p, ...r })) : []));

// ---- checks ------------------------------------------------------------------------------------------
const checks = {
  B00: { name: "baseline-matches-m3-after", inputs: [`${EV}snapshot-before.txt`, "evidence/M3/snapshot-after.txt"],
    expected: "M4's BEFORE snapshot equals M3's AFTER apart from SSH session scopes, and the boot ID is unchanged",
    run() {
      const strip = (f) => keyedSnapshot(f).map((x) => x.join("\t")).filter((l) => !/\tsession-\d+\.scope$/.test(l)).sort();
      const a = strip("evidence/M3/snapshot-after.txt"), b = strip(`${EV}snapshot-before.txt`);
      const only = (x, y) => x.filter((l) => !y.includes(l));
      const boot = (f) => (read(f).match(/^boot_id_sha256=([0-9a-f]{64})$/m) ?? [])[1];
      const ok = a.length > 50 && only(a, b).length === 0 && only(b, a).length === 0 && !!boot(`${EV}snapshot-before.txt`) && boot("evidence/M3/snapshot-after.txt") === boot(`${EV}snapshot-before.txt`);
      return { ok, actual: `lines=${a.length}; only in M3 AFTER=${only(a, b).length}, only in M4 BEFORE=${only(b, a).length}, boot_id_equal=${boot("evidence/M3/snapshot-after.txt") === boot(`${EV}snapshot-before.txt`)}` };
    } },

  // ================================================================ the images, the lock and the suites
  G01: { name: "images-pinned-built-and-running", inputs: [`${RAW}image-build.txt`, `${EV}rendered-compose.json`, `${RAW}stack.txt`, "services/mcp/Dockerfile", "services/access/Dockerfile"],
    expected: "both images build FROM the digest-pinned node base with npm ci --omit=dev --ignore-scripts against their lockfiles, for linux/arm64, the MCP service as uid 3400 and the gateway as uid 3380, recording the commit they were built from; the images the stack renders and runs are the last builds recorded; each image's source directory is unchanged from its build commit to HEAD, and every deployed commit a raw record names (the held real-client run's among them) differs from HEAD in nothing the Pi runs or the drivers do",
    run() {
      const log = read(`${RAW}image-build.txt`), st = S(`${RAW}stack.txt`);
      const last = (i) => [...log.matchAll(new RegExp(`^fcpi/${i}:m4 id=(sha256:[0-9a-f]{64}) os=linux arch=(\\S+) size=\\d+ user=(\\S+)$`, "gm"))].at(-1);
      const built = (i) => [...log.matchAll(new RegExp(`^fcpi/${i}:m4 FCPI_SOURCE_COMMIT=([0-9a-f]{40})$`, "gm"))].at(-1)?.[1];
      const running = (s) => (st.containers ?? []).find((l) => l.startsWith(`${s} `))?.match(/ image=(sha256:[0-9a-f]{64}) /)?.[1];
      const df = (d) => read(`services/${d}/Dockerfile`);
      const froms = (d) => [...df(d).matchAll(/^FROM (\S+)/gm)].map((m) => m[1]);
      const deployed = [...new Set([kv(st.meta ?? []).source_commit, ...PHASES.filter((p) => has(`${RAW}e2e-${p}.txt`)).map((p) => E(p).meta?.[0]?.deployed_commit), kv((S(`${RAW}suites.txt`).meta ?? [""])[0].split(" ")).source_commit,
        // The held real-client run too, once it has run: it must not have met a stale deployment.
        ...(has(`${RAW}real-clients.txt`) ? [records(`${RAW}real-clients.txt`).meta?.[0]?.deployed_commit] : [])].filter(Boolean))];
      const runsSame = (c) => { try { git("diff", "--quiet", c, "HEAD", "--", "services", "deploy", "scripts", "tests", ":(exclude)deploy/versions.lock.json"); return true; } catch { return false; } };
      const dirSame = (c, d) => { try { git("diff", "--quiet", c, "HEAD", "--", d); return true; } catch { return false; } };
      const cond = {};
      for (const [svc, img, dir, uid] of [["mcp-gateway", "mcp-gateway", "services/mcp", "3400:3400"], ["access-gateway", "access-gateway", "services/access", "3380:3380"]]) {
        const l = last(img), c = built(img);
        cond[`${svc}_built_arm64_uid`] = !!l && l[2] === "arm64" && l[3] === uid && /build_exit=0 image=fcpi\/[a-z-]+:m4/.test(log);
        cond[`${svc}_from_pinned`] = froms(dir.split("/")[1]).length === 1 && /@sha256:[0-9a-f]{64}$/.test(froms(dir.split("/")[1])[0]) && /npm ci --omit=dev --ignore-scripts/.test(df(dir.split("/")[1]));
        cond[`${svc}_runs_last_build`] = !!l && running(svc) === l[1] && digestOf(composeImage(svc)) === l[1];
        cond[`${svc}_source_unchanged`] = !!c && dirSame(c, dir);
      }
      cond.deployed_code_is_head = deployed.length >= 1 && deployed.every(runsSame);
      return { ok: bad(cond).length === 0, actual: `failed=${bad(cond).join(",") || "none"}; mcp image ${last("mcp-gateway")?.[1]?.slice(7, 19)} built from ${built("mcp-gateway")?.slice(0, 7)}; gateway image ${last("access-gateway")?.[1]?.slice(7, 19)} built from ${built("access-gateway")?.slice(0, 7)}; deployed commits named=${deployed.map((c) => c.slice(0, 7)).join(",")}` };
    } },
  G02: { name: "suites-pass-in-the-running-images", inputs: [`${RAW}suites.txt`, `${EV}rendered-compose.json`, "services/mcp/test/tools.test.mjs", "services/mcp/test/server.test.mjs", "services/mcp/test/rest.test.mjs", "services/access/test/mcp.test.mjs", "tests/contracts/m3-gateway.test.mjs", "tests/contracts/m4-gateway-mcp.test.mjs", "tests/contracts/m4-grammars.test.mjs"],
    expected: "inside the images the stack renders (Node 22.23.3): the MCP service's unit, integration and gateway-client suites, the gateway's unit suites with the /mcp proxy's, M3's 40-test contract suite unchanged, and M4's gateway-level /mcp contract suite (every refusal before the MCP service, the validated identity forwarded, no route without PI_MCP_URL) all pass with none failing, and no throwaway container or network is left",
    run() {
      const s = S(`${RAW}suites.txt`), m = kv((s.meta ?? [""])[0].split(" "));
      const mc = tapCounts(s.mcp_tap), gu = tapCounts(s.gateway_unit_tap), gc = tapCounts(s.gateway_contract_tap), gm = tapCounts(s.gateway_mcp_contract_tap), gr = tapCounts(s.grammars_tap);
      const exit = (sec) => (s[sec] ?? []).includes("test_exit=0");
      const tr = kv((s.transient ?? []).flatMap((l) => l.split(" ")));
      const cond = { images: m.mcp_image === composeImage("mcp-gateway") && m.gateway_image === composeImage("access-gateway"),
        mcp: mc.tests >= 33 && mc.pass === mc.tests && mc.fail === 0 && exit("mcp_tap"), gateway_unit: gu.tests >= 26 && gu.pass === gu.tests && gu.fail === 0 && exit("gateway_unit_tap"),
        m4_contract: gm.tests >= 3 && gm.pass === gm.tests && gm.fail === 0 && exit("gateway_mcp_contract_tap"), grammars: gr.tests >= 3 && gr.pass === gr.tests && gr.fail === 0 && exit("grammars_tap"),
        m3_contract: gc.tests === 40 && gc.pass === 40 && gc.fail === 0 && exit("gateway_contract_tap"), node: /mcp:v22\.23\.3,gateway:v22\.23\.3/.test(read(`${RAW}suites.txt`)),
        no_leftovers: tr.leftover_transient_containers === "0" && tr.leftover_transient_networks === "0" };
      return { ok: bad(cond).length === 0, actual: `failed=${bad(cond).join(",") || "none"}; mcp ${mc.pass}/${mc.tests}, gateway unit ${gu.pass}/${gu.tests}, M3 contract ${gc.pass}/${gc.tests}, M4 /mcp contract ${gm.pass}/${gm.tests}` };
    } },
  K01: { name: "official-sdk-locked-and-request-factory-used", inputs: ["services/mcp/package.json", "services/mcp/package-lock.json", "services/mcp/server.mjs", `${RAW}image-build.txt`],
    expected: "services/mcp pins @modelcontextprotocol/server, core and node at exactly 2.1.0 with decision D5's integrities (client 2.1.0 as a dev dependency only), every locked package carries an integrity; the server builds its handler with createMcpHandler and legacy: 'stateless', mounts it through toNodeHandler, constructs a fresh McpServer inside the factory and holds no session generator, event store or session map; the image's npm ls lists the three at 2.1.0",
    run() {
      const pkg = json("services/mcp/package.json"), lock = json("services/mcp/package-lock.json").packages, src = read("services/mcp/server.mjs");
      const D5 = { server: "sha512-FdvwZU5N03O77Suh35JqjAqq5R1ZTEPFtwu6N4BgBq28qrQtrCnpbLL5U2pwYCuE194jAw0xnlOVmIqhfoYuUQ==", core: "sha512-YdFj5gMRHr0gYNAhTbQDgjLHiEJdIAUYxomhKseUNye7ZGlISQmUoLh2sveFFCiQ7j2YMffT1kgSND0FSfIFjQ==",
        node: "sha512-6xg3iWVcOfiL8Y7rI6xUqXD0lI2AY5q3djsa/cOi1IJUSwx06t0gvhSwU/6mIIohrFlt40/ANUG56DQ0HLhILQ==", client: "sha512-mDVhoy5WjDb0U+4dQPzLcciC2erSex/GRVQqnoZdiuMoE3YiTZdiS7ezNcFwX4XEOWOaj7jZr0kLYnILnL8orA==" };
      const at = (n) => lock[`node_modules/@modelcontextprotocol/${n}`];
      const factoryBody = src.slice(src.indexOf("const factory = (ctx) =>"), src.indexOf("const handler = createMcpHandler"));
      const npmLs = read(`${RAW}image-build.txt`);
      const cond = { deps_exact: ["server", "core", "node"].every((n) => pkg.dependencies[`@modelcontextprotocol/${n}`] === "2.1.0") && pkg.devDependencies?.["@modelcontextprotocol/client"] === "2.1.0" && !pkg.dependencies["@modelcontextprotocol/client"],
        integrities: Object.entries(D5).every(([n, i]) => at(n)?.version === "2.1.0" && at(n)?.integrity === i), client_dev: at("client")?.dev === true,
        all_locked: Object.entries(lock).filter(([k]) => k).every(([, v]) => /^sha512-/.test(v.integrity ?? "")),
        factory: /createMcpHandler\(factory, \{ legacy: "stateless"/.test(src) && /toNodeHandler\(handler/.test(src) && /new McpServer\(/.test(factoryBody),
        no_session_state: !/sessionIdGenerator|EventStore|eventStore|new Map\(|sessions\b/.test(src),
        image_npm_ls: ["server", "core", "node"].every((n) => new RegExp(`@modelcontextprotocol/${n}@2\\.1\\.0`).test(npmLs)) };
      return { ok: bad(cond).length === 0, actual: `failed=${bad(cond).join(",") || "none"}; locked packages=${Object.keys(lock).filter(Boolean).length}; hono=${lock["node_modules/hono"]?.version}, @hono/node-server=${lock["node_modules/@hono/node-server"]?.version}, zod=${lock["node_modules/zod"]?.version}` };
    } },

  // ================================================================ AC12: the modern protocol
  P01: { name: "modern-discovery-and-calls-without-initialize-or-session", inputs: [`${RAW}e2e-wire.txt`, `${RAW}e2e-sdk.txt`, `${RAW}e2e-restart.txt`],
    expected: "server/discover answers 2026-07-28 only, tools without listChanged, a 60 s private cache hint and the server's identity in result metadata; a tools/call on a fresh connection with no discovery or initialize before it scrapes the fixture as one JSON answer with resultType complete; the SDK client pinned to 2026-07-28 negotiates it by server/discover, never sends initialize, sends MCP-Protocol-Version, Mcp-Method equal to the body's method and Mcp-Name on each tools/call, with the envelope's revision on every request, and scrapes, maps, crawls, reads the crawl to completed and reads its receipt to SUCCEEDED; no answer anywhere carries Mcp-Session-Id; the MCP service logged these calls as modern 2026-07-28 for the validated client",
    run() {
      const w = E("wire"), s = E("sdk"), r = E("restart");
      const disc = one(w.discovery, "server_discover"), dir = one(w.calls, "direct_modern_scrape"), conn = one(s.modern, "connected");
      const ex = s.modern_wire?.[0]?.exchanges ?? [], posts = ex.filter((e) => e.http_method === "POST");
      const wireRecs = Object.values(w).flat().filter((x) => "session_header" in x);
      const st = one(s.modern, "crawl_status"), rc = one(s.modern, "receipt");
      const tools = one(s.pi_view, "tool_records")?.records ?? [];
      const cond = { runs: endOk(w) && endOk(s),
        discover: disc?.status === 200 && same(disc.supported_versions, [MODERN]) && same(disc.capabilities, { tools: { listChanged: false } }) && disc.ttl_ms === 60000 && disc.cache_scope === "private" && disc.server_info?.name === "fcpi-mcp-gateway",
        direct_call: dir?.status === 200 && dir.content_type === "application/json" && dir.sse === false && dir.result_type === "complete" && sentinelOf(dir.sentinel, "p02"),
        negotiated: conn?.negotiated === MODERN, discover_first: posts[0]?.body_method === "server/discover" && posts.length >= 8,
        no_initialize: !ex.some((e) => e.body_method === "initialize" || e.body_method === "notifications/initialized"),
        headers: posts.every((e) => e.protocol_header === MODERN && e.mcp_method === e.body_method && e.envelope_version === MODERN && (e.body_method !== "tools/call" || !!e.mcp_name)),
        no_session: ex.every((e) => e.session_header === null) && wireRecs.length >= 30 && wireRecs.every((x) => x.session_header === null) && one(r.after_restart, "sdk_client_across_restart")?.exchanges_with_session === 0,
        calls: sentinelOf(one(s.modern, "scrape")?.sentinel, "p07") && (one(s.modern, "map")?.links ?? []).length === 12 && st?.status === "completed" && st.completed === 4 && rc?.state === "SUCCEEDED",
        logged_modern: tools.filter((t) => t.client === "m4a" && t.era === "modern" && t.protocol_version === MODERN && t.outcome === "ok").length >= 5 };
      return { ok: bad(cond).length === 0, actual: `failed=${bad(cond).join(",") || "none"}; SDK exchanges=${ex.length} (POST ${posts.length}), methods=${[...new Set(posts.map((e) => e.body_method))].join(",")}; raw answers checked for a session header=${wireRecs.length}; receipt=${rc?.state}` };
    } },
  P02: { name: "malformed-missing-mismatched-metadata-rejected", inputs: [`${RAW}e2e-wire.txt`],
    expected: "on the modern path: a missing MCP-Protocol-Version, a missing Mcp-Method, an Mcp-Method or Mcp-Name that disagrees with the body, and a header revision that disagrees with the envelope are 400 -32020; the modern header without the envelope and a malformed envelope are 400 -32602; an unsupported revision is 400 -32022; none of those eight JSON-bodied requests reached the server factory on either leg (the SDK's classification rejects them first), so none was served as a 2025-era request; a body that is not JSON is 400 -32700, answered by the SDK's legacy leg, which handles every non-JSON body, as its parse error; none of the nine reached the fixture and the MCP service logged no tool call for any of them, while the well-formed control reached the factory on the modern leg, reached the fixture and was logged (D5 obligation 1)",
    run() {
      const w = E("wire"), v = w.validation ?? [];
      const EXP = { missing_protocol_version_header: -32020, missing_method_header: -32020, method_header_mismatch: -32020, name_header_mismatch: -32020, version_header_body_mismatch: -32020,
        modern_header_without_envelope: -32602, malformed_envelope: -32602, unsupported_revision: -32022, not_json: -32700 };
      const seen = one(w.pi_view, "fixture_markers")?.seen ?? {};
      const toolIds = new Set((one(w.pi_view, "tool_records")?.records ?? []).map((t) => t.request_id));
      const serve = one(w.pi_view, "serve_records")?.records ?? [];
      const served = (id) => serve.filter((s) => s.request_id === id).map((s) => s.era);
      const wrong = Object.entries(EXP).filter(([c, code]) => { const r = one(v, c); return !(r && r.status === 400 && r.rpc_error?.code === code && r.result_type === null && seen[c] === 0 && UUID_RE.test(r.request_id ?? "") && !toolIds.has(r.request_id)); }).map(([c]) => c);
      // The eight JSON-bodied cases never reach the factory; the non-JSON body reaches the legacy leg only.
      const reachedFactory = Object.keys(EXP).filter((c) => c !== "not_json" && served(one(v, c)?.request_id).length > 0);
      const nj = served(one(v, "not_json")?.request_id);
      const ctl = one(v, "well_formed_control");
      const ok = endOk(w) && serve.length >= 10 && wrong.length === 0 && reachedFactory.length === 0 && same(nj, ["legacy"]) && same(served(ctl?.request_id), ["modern"]) &&
        ctl?.status === 200 && seen.well_formed_control === 1 && sentinelOf(ctl.sentinel, "p04") && toolIds.has(ctl.request_id);
      return { ok, actual: `cases=${Object.keys(EXP).length}, answered otherwise=${wrong.join(",") || "none"}; JSON-bodied cases that reached the factory=${reachedFactory.join(",") || "none"}; the non-JSON body served on=${nj.join(",") || "none"}; the control served on=${served(ctl?.request_id).join(",") || "none"}; fixture requests for rejected cases=${Object.keys(EXP).reduce((a, c) => a + (seen[c] ?? 0), 0)}, for the control=${seen.well_formed_control}; codes=${Object.keys(EXP).map((c) => one(v, c)?.rpc_error?.code).join(",")}` };
    } },
  P03: { name: "json-and-request-scoped-sse", inputs: [`${RAW}e2e-wire.txt`, `${RAW}e2e-tailnet.txt`],
    expected: "a modern call without a progress token is one application/json answer; the same call with a progress token is a text/event-stream answer carrying the progress notification with that token before the result; the MCP service logged that exchange as an event stream; 2025-era answers are streams; through Tailscale Serve the SDK client's progress call streamed and delivered its notification",
    run() {
      const w = E("wire"), t = E("tailnet");
      const j = one(w.calls, "direct_modern_scrape"), p = one(w.calls, "progress_sse_scrape"), l = one(w.legacy, "tools_call_scrape");
      const ex = (one(w.pi_view, "exchange_records")?.records ?? []).find((e) => e.request_id === p?.request_id);
      const tn = one(t.tailnet, "modern_sdk");
      const cond = { json: j?.content_type === "application/json" && j.sse === false,
        sse: p?.status === 200 && /^text\/event-stream/.test(p.content_type ?? "") && p.sse === true && same(p.messages, ["notifications/progress", "result"]) && p.progress_token === "m4-progress-1" && sentinelOf(p.sentinel, "p03"),
        logged_stream: /^text\/event-stream/.test(ex?.content_type ?? ""), legacy_stream: l?.sse === true && sentinelOf(l.sentinel, "p05"),
        through_serve: endOk(t) && tn?.sse_exchanges >= 1 && tn.progress_messages >= 1 && sentinelOf(tn.sentinel, "p02") };
      return { ok: bad(cond).length === 0, actual: `failed=${bad(cond).join(",") || "none"}; JSON=${j?.content_type}; progress call=${p?.content_type} messages=${JSON.stringify(p?.messages)}; logged as ${ex?.content_type}; tailnet SSE exchanges=${tn?.sse_exchanges}` };
    } },
  P04: { name: "cancellation", inputs: [`${RAW}e2e-cancel.txt`],
    expected: "a modern tools/call with JSON-RPC id 0, aborted while the fixture held its page (the page started before the abort), is logged by the MCP service as cancelled with id 0, and the gateway logged its /mcp exchange and the MCP service's scrape call as 499 (D5 obligation 3); a 2025-era call whose connection closes mid-call is cancelled the same way; the 2025-era SDK client's notifications/cancelled is acknowledged and, served statelessly by another instance, is recorded with how the running call ended, ok when the notification reached another instance as stateless serving expects, or cancelled were it honoured (the spec promises no legacy return channel; the check records the limitation, it does not require it); firecrawl_cancel_crawl answers cancelled twice, the crawl and its receipt end CANCELLED with its completed pages archived and no slow page started more than 2.5 s after the cancel; cancelling a finished crawl is the gateway's 409 as a tool error",
    run() {
      const c = E("cancel"), m = one(c.request_cancel, "modern"), lc = one(c.request_cancel, "legacy_connection_close"), ln = one(c.request_cancel, "legacy_sdk_notification");
      const inFlight = (r) => !!r && (r.fixture ?? []).length === 1 && Date.parse(r.fixture[0].started) < Date.parse(r.abort_at ?? "");
      const cancelled = (r, era) => inFlight(r) && r.mcp_tool_record?.outcome === "cancelled" && r.mcp_tool_record.jsonrpc_id === 0 && r.mcp_tool_record.era === era && r.mcp_tool_record.downstream?.code === "ABORTED" &&
        same(r.gateway_mcp_exchanges?.map((x) => x.status), [499]) && r.gateway_scrape_records?.length === 1 && r.gateway_scrape_records[0].status === 499 && r.gateway_scrape_records[0].client === "m4a";
      const s = one(c.crawl_cancel, "slow_crawl"), f = one(c.crawl_cancel, "finished_crawl");
      const cut = Date.parse(s?.cancel_at ?? "") + 2500;
      const late = (s?.fixture_requests ?? []).filter((r) => !(Date.parse(r.started) <= cut));
      const cond = { run: endOk(c), modern_id0: cancelled(m, "modern") && m.body_id === 0 && m.exchange_failed === "AbortError", legacy_close: cancelled(lc, "legacy") && lc.client_outcome === "closed",
        legacy_notification_recorded: inFlight(ln) && ln.cancel_notifications >= 1 && ln.mcp_tool_record?.era === "legacy" && ["ok", "cancelled"].includes(ln.mcp_tool_record.outcome),
        crawl_cancel: s?.cancel?.status === "cancelled" && s.cancel_again?.status === "cancelled" && s.status === "cancelled" && s.receipt_state === "CANCELLED" && Number.isFinite(cut) && s.archived === s.completed && s.archived >= 2 && (s.fixture_requests ?? []).length >= 2 && late.length === 0,
        finished_409: f?.is_error === true && f.error?.httpStatus === 409 };
      return { ok: bad(cond).length === 0, actual: `failed=${bad(cond).join(",") || "none"}; modern id ${m?.mcp_tool_record?.jsonrpc_id} ${m?.mcp_tool_record?.outcome}, gateway ${JSON.stringify(m?.gateway_mcp_exchanges)}/${m?.gateway_scrape_records?.[0]?.status}; legacy close ${lc?.mcp_tool_record?.outcome}; legacy notification: ${ln?.cancel_notifications} acknowledged, call ${ln?.mcp_tool_record?.outcome} (ok: the notification reached another instance; cancelled: it was honoured); crawl ${s?.receipt_state} archived=${s?.archived}, slow pages started after cancel+2.5 s=${late.length} of ${(s?.fixture_requests ?? []).length}; finished crawl=${f?.error?.httpStatus}` };
    } },
  P05: { name: "deterministic-catalog", inputs: [`${RAW}e2e-wire.txt`, `${RAW}e2e-sdk.txt`, `${RAW}e2e-stopped.txt`, "deploy/policies/capabilities.json"],
    expected: "tools/list answers the manifest's nine tools sorted by name, byte-identical for two principals and both eras, and again from the SDK clients of both eras and after the MCP service was stopped and started; modern answers carry the 60 s private cache hint; each tool's annotations and argument names are the ones generated from the manifest (scrape: its route's fields less the gateway-set origin; crawl and batch: plus idempotencyKey); capabilities list the omitted tools with their not_enabled reasons; subscriptions/listen is refused -32603",
    run() {
      const w = E("wire"), s = E("sdk"), st = E("stopped");
      const cat = ["modern_m4a", "modern_m4b", "legacy_m4a"].map((c) => one(w.catalog, c));
      const hash = cat[0]?.tools_sha256;
      const fields = (b) => Object.entries({ ...(MANIFEST.bodies[b].extends ? MANIFEST.fieldsets[MANIFEST.bodies[b].extends] : {}), ...MANIFEST.bodies[b].fields }).filter(([, v]) => v.type !== "replaced").map(([k]) => k);
      const keys = cat[0]?.schema_keys ?? {};
      const annOk = MANIFEST.mcp.tools.every((t) => same(cat[0]?.annotations?.[t.name], { title: t.title, ...t.annotations }));
      const caps = one(w.scopes, "read_only_capabilities");
      const reasons = MANIFEST.mcp.omitted.map((o) => ({ name: o.name, reason: MANIFEST.not_enabled.find((r) => r.method === o.method && r.path === o.path).reason }));
      const cond = { three_equal: cat.every((c) => c?.status === 200 && same(c.tools, TOOLS)) && cat.every((c) => c.tools_sha256 === hash),
        sdk_equal: one(s.modern, "list_tools")?.tools_sha256 === hash && one(s.legacy, "list_tools")?.tools_sha256 === hash,
        after_restart: one(st.started, "mcp_request")?.tools === TOOLS.length,
        cache_hint: cat.slice(0, 2).every((c) => c.ttl_ms === 60000 && c.cache_scope === "private"),
        annotations: annOk, schemas: same(keys.firecrawl_scrape, fields("scrape").sort()) && same(keys.firecrawl_crawl, [...fields("crawl"), "idempotencyKey"].sort()) && same(keys.firecrawl_batch_scrape, [...fields("batch"), "idempotencyKey"].sort()) && same(keys.firecrawl_check_crawl_status, ["id", "limit", "skip"]),
        omitted: same(caps?.omitted, reasons) && same(caps?.mcp_tools, TOOLS), listen_refused: one(w.subscriptions, "listen_refused")?.rpc_error?.code === -32603 };
      return { ok: bad(cond).length === 0, actual: `failed=${bad(cond).join(",") || "none"}; tools=${cat[0]?.tools?.length} sha=${hash?.slice(0, 12)}; omitted=${(caps?.omitted ?? []).map((o) => o.name).join(",")}` };
    } },

  // ================================================================ AC13: compatibility and clients
  P06: { name: "2025-11-25-stateless-compatibility", inputs: [`${RAW}e2e-wire.txt`, `${RAW}e2e-sdk.txt`, `${RAW}e2e-tailnet.txt`],
    expected: "a raw 2025-era initialize negotiates 2025-11-25 with no session header, and a later tools/call with no session scrapes the fixture; GET and DELETE on /mcp (the 2025 session operations) and a modern GET are 405; the SDK client at its 2025-11-25 default initializes, lists, scrapes and crawls to completed with no session header on any answer, and over the tailnet does the same; the MCP service logged its calls as legacy 2025-11-25",
    run() {
      const w = E("wire"), s = E("sdk"), t = E("tailnet");
      const init = one(w.legacy, "initialize"), call = one(w.legacy, "tools_call_scrape");
      const ex = s.legacy_wire?.[0]?.exchanges ?? [];
      const tools = [...(one(s.pi_view, "tool_records")?.records ?? []), ...(one(w.pi_view, "tool_records")?.records ?? [])];
      const cond = { raw_init: init?.status === 200 && init.protocol_version === LEGACY && init.session_header === null && init.server_info?.name === "fcpi-mcp-gateway",
        raw_call: call?.status === 200 && sentinelOf(call.sentinel, "p05") && call.session_header === null, session_ops_405: ["http_get", "http_delete", "modern_get"].every((c) => one(w.legacy, c)?.status === 405),
        sdk: one(s.legacy, "connected")?.negotiated === LEGACY && ex[0]?.body_method === "initialize" && ex.every((e) => e.session_header === null) && sentinelOf(one(s.legacy, "scrape")?.sentinel, "p08") && one(s.legacy, "crawl_status")?.status === "completed",
        tailnet: one(t.tailnet, "legacy_sdk")?.negotiated === LEGACY && one(t.tailnet, "legacy_sdk").sessions === 0 && sentinelOf(one(t.tailnet, "legacy_sdk").sentinel, "p03"),
        logged_legacy: tools.filter((x) => x.era === "legacy" && x.protocol_version === LEGACY && x.outcome === "ok").length >= 3 };
      return { ok: bad(cond).length === 0, actual: `failed=${bad(cond).join(",") || "none"}; raw initialize=${init?.protocol_version}; SDK negotiated=${one(s.legacy, "connected")?.negotiated}, exchanges=${ex.length}; legacy tool records=${tools.filter((x) => x.era === "legacy").length}` };
    } },
  P07: { name: "two-independent-clients-and-owner-isolation", inputs: [`${RAW}e2e-sdk.txt`, `${RAW}e2e-tailnet.txt`],
    expected: "two SDK clients with their own tokens and principals call the same endpoint at once (their calls overlap in time) and both get their pages; the MCP service logged each call under its own validated client and principal; another principal's job answers exactly as an unknown id does, through MCP; over the tailnet a modern and a 2025-era client of different principals both succeed",
    run() {
      const s = E("sdk"), t = E("tailnet"), c = one(s.concurrent, "two_clients"), iso = one(s.legacy, "other_principals_job");
      const tools = one(s.pi_view, "tool_records")?.records ?? [];
      const principals = new Set(tools.map((x) => `${x.client}/${x.principal}`));
      const cond = { run: endOk(s), concurrent: sentinelOf(c?.a?.sentinel, "p09") && sentinelOf(c?.b?.sentinel, "p10") && c.overlap_ms > 0,
        own_principals: principals.has("m4a/m4-owner") && principals.has("m4b/m4-other"),
        isolation: iso?.is_error === true && iso.error?.httpStatus === 404 && iso.identical === true,
        tailnet_two: one(t.tailnet, "modern_sdk")?.negotiated === MODERN && one(t.tailnet, "legacy_sdk")?.negotiated === LEGACY };
      return { ok: bad(cond).length === 0, actual: `failed=${bad(cond).join(",") || "none"}; overlap=${c?.overlap_ms} ms; client/principal pairs logged=${[...principals].join(",")}; foreign job=${iso?.error?.httpStatus} identical to unknown=${iso?.identical}` };
    } },
  P08: { name: "new-tcp-connection-between-related-calls", inputs: [`${RAW}e2e-restart.txt`],
    expected: "the crawl and every later status call of the same job each went over a TCP connection of its own (distinct local ports, none the crawl's), and the job was resolved to completed with its six pages through them",
    run() {
      const r = E("restart"), s = one(r.after_restart, "status_new_connection");
      const ports = s?.status_local_ports ?? [];
      const ok = endOk(r) && Number.isInteger(s?.crawl_local_port) && ports.length >= 1 && new Set(ports).size === ports.length && !ports.includes(s.crawl_local_port) && s.status === "completed" && s.completed === 6 && s.returned === 6;
      return { ok, actual: `crawl port=${s?.crawl_local_port}; status calls=${ports.length}, distinct=${new Set(ports).size}; status=${s?.status} completed=${s?.completed}` };
    } },
  P09: { name: "mcp-restart-between-crawl-and-status", inputs: [`${RAW}e2e-restart.txt`],
    expected: "a crawl accepted by one MCP process is read to completed by another after the MCP container restarted (its start time changed, the gateway's did not): the MCP log names a different process instance for the status calls than for the crawl, and that instance started in the window; the SDK client that existed before the restart reads its own crawl to completed afterwards, with no initialize and no session header; the REST route answered the job during the restart",
    run() {
      const r = E("restart"), a = one(r.after_restart, "restarted"), i = one(r.pi_view, "instances"), sc = one(r.after_restart, "sdk_client_across_restart");
      const cond = { run: endOk(r), restarted: a?.started_changed === true && a.gateway_unchanged === true,
        instances: UUID_RE.test(i?.crawl_instance ?? "") && i.status_instances?.length === 1 && i.status_instances[0] !== i.crawl_instance && (i.started_instances ?? []).includes(i.status_instances[0]),
        resolved: one(r.after_restart, "status_new_connection")?.status === "completed", sdk_client: sc?.status === "completed" && sc.exchanges_with_session === 0 && sc.initialize_sent === false,
        rest_during: one(r.during_restart, "rest_crawl_status")?.status === 200 };
      return { ok: bad(cond).length === 0, actual: `failed=${bad(cond).join(",") || "none"}; crawl instance=${i?.crawl_instance?.slice(0, 8)}, status instances=${(i?.status_instances ?? []).map((x) => x.slice(0, 8)).join(",")}; SDK client across restart=${sc?.status}` };
    } },
  P10: { name: "rest-serves-with-mcp-stopped", inputs: [`${RAW}e2e-stopped.txt`],
    expected: "with the MCP container stopped, /mcp answers 503 MCP_UNAVAILABLE within 3 s while a REST scrape, the platform status (core live), a job created before and a crawl submitted and finished during the stop all answer through REST; started again, /mcp lists the tools; the gateway was never restarted",
    run() {
      const s = E("stopped"), m = one(s.stopped, "mcp_request"), b = one(s.started, "mcp_request");
      const cond = { run: endOk(s), stopped: /^exited/.test(one(s.stopped, "mcp_state")?.state ?? ""), mcp_503: m?.status === 503 && m.code === "MCP_UNAVAILABLE" && m.ms < 3000,
        rest: one(s.stopped, "rest_scrape")?.status === 200 && sentinelOf(one(s.stopped, "rest_scrape").sentinel, "p11") && one(s.stopped, "rest_platform_status")?.core_live === true &&
          one(s.stopped, "rest_prior_job")?.status === 200 && one(s.stopped, "rest_crawl_while_stopped")?.status === "completed" && one(s.stopped, "rest_crawl_while_stopped").docs === 2,
        back: b?.status === 200 && b.tools === TOOLS.length && b.gateway_unchanged === true };
      return { ok: bad(cond).length === 0, actual: `failed=${bad(cond).join(",") || "none"}; /mcp while stopped=${m?.status} ${m?.code} in ${m?.ms} ms; REST crawl while stopped=${one(s.stopped, "rest_crawl_while_stopped")?.status}` };
    } },

  // ================================================================ AC01 and the boundary through MCP
  A01: { name: "authorization-and-boundary-through-mcp", inputs: [`${RAW}e2e-wire.txt`, `${RAW}e2e-tailnet.txt`],
    expected: "on /mcp a missing, unknown or Basic token is 401 with the gateway's own challenge, a foreign Host 421, a foreign or null Origin 403, a body over 1 MiB 413 (D5 obligation 2): none of them reached the MCP service, whose log holds none of their request ids while it holds the window's other exchanges; a client's own x-fcpi-* headers are replaced by the validated identity; a read-only token's scrape is the gateway's 403 INSUFFICIENT_SCOPE as a tool error while its read works; an option outside the schema is refused before the gateway; over the tailnet no token is 401 and a foreign Host 421; no answer carries Access-Control-Allow-Origin",
    run() {
      const w = E("wire"), t = E("tailnet"), b = w.boundary ?? [];
      const at = (c) => one(b, c);
      const pv = one(w.pi_view, "mcp_records_for_gateway_refusals"), spoof = one(w.pi_view, "spoofed_identity_as_logged");
      const all = [...Object.values(w).flat(), ...Object.values(t).flat()].filter((x) => "acao" in x);
      const cond = { tokens: ["token_missing", "token_invalid", "token_basic_scheme"].every((c) => at(c)?.status === 401 && at(c).code === "UNAUTHORIZED" && at(c).www_authenticate === 'Bearer realm="fcpi"'),
        host_origin: at("foreign_host")?.status === 421 && at("foreign_origin")?.status === 403 && at("null_origin")?.status === 403, body_cap: at("body_over_cap")?.status === 413 && at("body_over_cap").code === "BODY_TOO_LARGE" && at("body_over_cap").body_bytes > 1048576,
        none_reached_mcp: pv?.request_ids === 7 && pv.mcp_records === 0 && pv.mcp_exchanges_in_window >= 20, control: at("valid_control")?.status === 200,
        spoofing: at("spoofed_identity_headers")?.status === 200 && spoof?.client === "m4a" && spoof.principal === "m4-owner",
        scope: one(w.scopes, "read_only_scrape")?.error?.code === "INSUFFICIENT_SCOPE" && one(w.scopes, "read_only_scrape").error.httpStatus === 403 && one(w.scopes, "read_only_capabilities")?.core_live === true,
        schema: one(w.scopes, "schema_refused_option")?.is_error === true && /Input validation error/.test(one(w.scopes, "schema_refused_option").text ?? ""),
        tailnet: one(t.tailnet, "no_token")?.status === 401 && one(t.tailnet, "foreign_host")?.status === 421, no_cors: all.length >= 30 && all.every((x) => x.acao === null) };
      return { ok: bad(cond).length === 0, actual: `failed=${bad(cond).join(",") || "none"}; refusals=${b.map((x) => `${x.case}:${x.status}`).join(",")}; MCP records for the gateway's refusals=${pv?.mcp_records} of ${pv?.request_ids} (window exchanges ${pv?.mcp_exchanges_in_window}); answers checked for CORS=${all.length}` };
    } },
  A02: { name: "tool-payload-bounded-and-marked", inputs: [`${RAW}e2e-wire.txt`],
    expected: "a 100 KiB page in three formats (over the 256 KiB tool payload) comes back as one tool result of at most 262,144 bytes, not an error, naming each cut field with its original and returned size; the bytes returned plus the bytes cut (a lower bound on the whole answer, since JSON escaping only adds bytes) exceed the limit, so the page really was over it; the page's sentinel is still in its markdown",
    run() {
      const b = one(E("wire").bound, "big_page"), cuts = b?.truncated ?? {};
      // Only the fields cut are listed, so their original sizes alone need not pass the limit: what was
      // returned plus what was removed must.
      const removed = Object.values(cuts).reduce((a, c) => a + ((c.originalBytes ?? 0) - (c.returnedBytes ?? 0)), 0);
      const ok = b?.status === 200 && b.is_error === null && b.text_bytes > 0 && b.text_bytes <= 262144 && Object.keys(cuts).length >= 1 &&
        Object.values(cuts).every((c) => Number.isFinite(c.originalBytes) && Number.isFinite(c.returnedBytes) && c.returnedBytes < c.originalBytes) && b.text_bytes + removed > 262144 && sentinelOf(b.sentinel, "big");
      return { ok, actual: `text bytes=${b?.text_bytes}; bytes cut=${removed}; returned plus cut=${(b?.text_bytes ?? 0) + removed}; cut fields=${JSON.stringify(cuts)}; sentinel=${b?.sentinel}` };
    } },

  // ================================================================ observability
  O01: { name: "independent-mcp-observability", inputs: [`${RAW}stack.txt`, `${RAW}e2e-wire.txt`],
    expected: "the MCP container's whole log (its first line a start's) holds exchange, serve and tool records and a start for each process it ran, and none of the patterns for Firecrawl Cloud, tokens, bearer or authorization values, target URLs or fixture content; every tool call logged in the wire phase names its era, revision, tool and validated client, and the gateway's request id it names is a gateway record of the same client on the tool's route",
    run() {
      const st = S(`${RAW}stack.txt`), w = E("wire");
      const scanL = st.mcp_log_scan ?? [], head = kv((scanL[0] ?? "").split(" "));
      const pats = scanL.filter((l) => l.startsWith("pattern=")).map((l) => kv(l.split(" ")));
      const tools = one(w.pi_view, "tool_records")?.records ?? [], gw = one(w.pi_view, "gateway_records")?.records ?? [];
      // Every tool's route, from the manifest: a tool record must match a gateway record on that route.
      const routeOf = Object.fromEntries(MANIFEST.mcp.tools.map((x) => [x.name, x.route]));
      const unmatched = tools.filter((t) => !(t.era && t.protocol_version && t.client && t.downstream?.request_id && gw.some((g) => g.request_id === t.downstream.request_id && g.client === t.client && g.route === routeOf[t.tool])));
      const cond = { scan: +head.lines > 50 && +head.exchange_records > 30 && +head.serve_records > 30 && +head.tool_records > 20 && +head.starts >= 3 && head.first_event === "listening",
        patterns: pats.length === 8 && pats.every((p) => p.count === "0"), correlated: tools.length >= 6 && unmatched.length === 0,
        health: (st.mcp_health ?? []).some((l) => /^200 .*"live":true/.test(l)) };
      return { ok: bad(cond).length === 0, actual: `failed=${bad(cond).join(",") || "none"}; ${scanL[0] ?? "no scan"}; patterns with hits=${pats.filter((p) => p.count !== "0").map((p) => p.pattern).join(",") || "none"}; tool records=${tools.length}, not matched to a gateway record=${unmatched.length}` };
    } },

  // ================================================================ AC24, the network and the host
  X01: { name: "zero-firecrawl-cloud-attempts", inputs: [`${RAW}guard-window-open.txt`, `${RAW}egress-probe.txt`, `${RAW}core-logs-final.txt`, `${RAW}stack.txt`].concat(PHASES.map((p) => `${RAW}e2e-${p}.txt`)),
    expected: "across one window, from a guard-counter snapshot before the first live phase to the egress probe after the last, with the guard's table not reloaded and every phase inside it (the held real-client run too, once it has run), the guard accepted no web connection; the core's saved log classifies every Cloud line and name-resolution failure, with its control; the MCP container has no default route, reaches the gateway's fixed address (the control) and nothing public, and resolves no Firecrawl Cloud or public name; the MCP and gateway logs hold no Cloud host; every driver's sockets went only to the forward or to Tailscale Serve, and it looked up no name but the tailnet's",
    run() {
      const utcOf = (f) => Date.parse(((sections(f).meta ?? []).join(" ").match(/utc=(\S+?Z)/) ?? [])[1]);
      const handle = (f) => ((sections(f).meta ?? []).join(" ").match(/guard_table_handle=(\d+)/) ?? [])[1];
      const web = (f, sec) => +((sections(f)[sec] ?? []).find((l) => l.startsWith("egress_web_accepted")) ?? "=NaN").split("=")[1];
      const open = utcOf(`${RAW}guard-window-open.txt`), close = utcOf(`${RAW}egress-probe.txt`);
      const inWindow = (t) => Number.isFinite(t) && t > open && t < close;
      const inside = PHASES.every((p) => inWindow(Date.parse(E(p).meta?.[0]?.pi_utc ?? "")));
      // The held real-client run, once it has run, belongs to the same window: its traffic is covered too.
      const realRun = has(`${RAW}real-clients.txt`) ? records(`${RAW}real-clients.txt`).meta?.[0] : undefined;
      const realInside = realRun === undefined || inWindow(Date.parse(realRun?.pi_utc ?? ""));
      const delta = web(`${RAW}egress-probe.txt`, "guard_after") - web(`${RAW}guard-window-open.txt`, "counters");
      const recs = Object.entries(sections(`${RAW}core-logs-final.txt`)).filter(([k]) => /^(instance|stored)_/.test(k)).map(([, lines]) => {
        const c = lines.find((l) => l.startsWith("classified ")); const ctl = +((lines.find((l) => l.startsWith("control=")) ?? "").match(/count=(\d+)/) ?? [])[1];
        return { c: c ? kv(c.split(" ").slice(1)) : null, ctl };
      });
      // key=value with ':' in the keys (host:port), so split at the first '=' rather than through kv().
      const reach = Object.fromEntries((S(`${RAW}stack.txt`).mcp_reach ?? []).filter((l) => l.includes("=")).map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]));
      const reachOk = reach.default_route === "no" && reach["gateway_tcp_10.231.8.10:3300"] === "open" && Object.entries(reach).filter(([k]) => k.startsWith("public_tcp_")).every(([, v]) => v !== "open") &&
        Object.entries(reach).filter(([k]) => k.startsWith("public_tcp_")).length === 2 && ["api.firecrawl.dev", "firecrawl.dev", "example.com"].every((h) => reach[`dns_${h}`] && !reach[`dns_${h}`].startsWith("resolved"));
      const cloudIn = (sec) => (S(`${RAW}stack.txt`)[sec] ?? []).filter((l) => /^pattern=(firecrawl\\\.(dev|com)|mendable)/.test(l)).map((l) => kv(l.split(" ")).count);
      const conns = PHASES.filter((p) => p !== "tailnet").map((p) => E(p).connections?.[0]);
      const tn = E("tailnet").tailnet_connections?.[0];
      const cond = { same_guard: !!handle(`${RAW}guard-window-open.txt`) && handle(`${RAW}guard-window-open.txt`) === handle(`${RAW}egress-probe.txt`), phases_inside: inside, real_clients_inside: realInside, no_web: delta === 0,
        core_logs: recs.length >= 1 && recs.every((r) => r.c && r.c.cloud_unexplained === "0" && r.c.dns_unexplained === "0" && r.ctl >= 1), mcp_reach: reachOk,
        logs_clean: [...cloudIn("mcp_log_scan"), ...cloudIn("gateway_log_scan")].length === 6 && [...cloudIn("mcp_log_scan"), ...cloudIn("gateway_log_scan")].every((c) => c === "0"),
        drivers: conns.every((c) => c && same(c.hosts, ["127.0.0.1:3380"]) && c.lookups.length === 0) && tn && same(tn.hosts, ["<pi-tailnet-name-host>:8443"]) && same(tn.lookups, ["<pi-tailnet-name-host>"]) };
      return { ok: bad(cond).length === 0, actual: `failed=${bad(cond).join(",") || "none"}; guard handle ${handle(`${RAW}guard-window-open.txt`)}→${handle(`${RAW}egress-probe.txt`)}, web accepted delta=${delta}; core logs=${recs.length}; MCP reach ${JSON.stringify(reach)}` };
    } },
  X03: { name: "mcp-network-and-container-posture", inputs: [`${RAW}stack.txt`, `${EV}rendered-compose.json`],
    expected: "fcpi_mcp is internal with isolated gateway mode, no bridge address, and exactly the gateway and the MCP service as members; the MCP service is on fcpi_mcp alone at 10.231.8.20, the gateway gains it at 10.231.8.10 beside its three M3 networks; the only host publication is still 127.0.0.1:3380; the MCP container runs as 3400:3400 with a read-only root, every capability dropped, no-new-privileges, not privileged, no Docker socket, its manifest mounted read-only, a 192 MiB memory cap without swap, and native aarch64",
    run() {
      const st = S(`${RAW}stack.txt`);
      const net = (st.networks ?? []).find((l) => l.startsWith("fcpi_mcp "));
      const bridge = (st.networks ?? []).find((l) => l.startsWith("bridge fcpi-mcp "));
      const c = kv(((st.containers ?? []).find((l) => l.startsWith("mcp-gateway ")) ?? "").split(" "));
      const g = (st.containers ?? []).find((l) => l.startsWith("mcp-gateway uname_m="));
      const pub = (st.published ?? []).filter((l) => /->/.test(l));
      const cg = kv(((st.cgroups ?? []).find((l) => l.startsWith("mcp-gateway ")) ?? "").split(" ").slice(1));
      const R = json(`${EV}rendered-compose.json`).services;
      const img = kv((st.mcp_image ?? []).flatMap((l) => l.split(" ")));
      const cond = { network: /internal=true/.test(net ?? "") && /gateway_mode_ipv4=isolated/.test(net) && /members=fcpi-access-gateway-1,fcpi-mcp-gateway-1$/.test(net) && /subnet=10\.231\.8\.0\/24/.test(net), no_bridge_address: bridge === "bridge fcpi-mcp addresses=",
        mcp_nets: same(Object.keys(R["mcp-gateway"].networks ?? {}), ["mcp"]) && R["mcp-gateway"].networks.mcp.ipv4_address === "10.231.8.20" && img.ipv4 === "10.231.8.20",
        gateway_nets: same(Object.keys(R["access-gateway"].networks ?? {}).sort(), ["access", "api", "mcp", "platform"]) && R["access-gateway"].networks.mcp.ipv4_address === "10.231.8.10",
        publication: pub.length === 1 && /^access-gateway 3300\/tcp -> 127\.0\.0\.1:3380$/.test(pub[0]) && !R["mcp-gateway"].ports,
        posture: c.user === "3400:3400" && c.readonly_rootfs === "true" && c.privileged === "false" && c.cap_drop === "ALL" && /no-new-privileges:true/.test(c.security_opt ?? "") && c.docker_sock_mount === "0" && c.platform === "linux/arm64" && /uname_m=aarch64/.test(g ?? ""),
        mounts: img.mounts === "/srv/policy/capabilities.json:ro", memory: cg["memory.max"] === String(192 * MIB) && cg["memory.swap.max"] === "0" };
      return { ok: bad(cond).length === 0, actual: `failed=${bad(cond).join(",") || "none"}; ${net}; publications=${pub.join(";")}` };
    } },
  X04: { name: "unrelated-state-unchanged", inputs: [`${EV}snapshot-before.txt`, `${EV}snapshot-after.txt`, `${RAW}nft-ruleset.txt`, "evidence/M3/raw/nft-ruleset.txt", `${RAW}owner-session.txt`],
    expected: "every line differing between M4's BEFORE and AFTER snapshots is attributed to the project (fcpi containers, their scopes, root filesystems and namespaces, kernel modules for the runtime, the ruleset) or to the collector's own SSH session, or to the owner's own work on the Pi that raw/owner-session.txt records (an apt upgrade, an editor server) and Pi-hole's own rotating upstream sockets; no unrelated line is removed or changed; the boot ID is unchanged; rule by rule against M3's recorded ruleset, every change is Docker's for the new fcpi-mcp bridge, and the installed guard is the repository's",
    run() {
      const [B, A] = [`${EV}snapshot-before.txt`, `${EV}snapshot-after.txt`];
      const psIds = (f) => (read(f).match(/^### docker_ps\n([\s\S]*?)\n### /m)?.[1] ?? "").split("\n").map((l) => l.split("\t")[0]).filter((x) => /^[0-9a-f]{64}$/.test(x));
      const ids = new Set([...psIds(B), ...psIds(A)]);
      const norm = (sec, l) => (sec === "ss_listen" ? l.replace(/pid=\d+,fd=\d+/g, "pid,fd") : l);
      const K = (f) => keyedSnapshot(f).map(([s, l]) => `${s}\t${norm(s, l)}`);
      const b = K(B), a = K(A);
      const removed = b.filter((l) => !a.includes(l)), added = a.filter((l) => !b.includes(l));
      const owner = ownerContext();
      const unexplained = [], why = {}, rows = { project: [], owner: [], unrelated: [] };
      for (const [kind, list] of [["removed", removed], ["added", added]]) for (const l of list) {
        const [sec, line] = [l.slice(0, l.indexOf("\t")), l.slice(l.indexOf("\t") + 1)];
        const w = attribute(sec, line, ids, owner);
        const acceptable = w && (kind === "added" || /own SSH session|nftables|fcpi container|container network namespace|scope of an fcpi container|Docker's chains|Pi-hole's own|the owner's editor server/.test(w));
        if (!acceptable) unexplained.push(`${kind} ${sec}: ${line.slice(0, 90)}`); else why[w] = (why[w] ?? 0) + 1;
        rows[!acceptable ? "unrelated" : /owner|Pi-hole/.test(w) ? "owner" : "project"].push(`${kind === "added" ? "+" : "-"} ${sec}\t${line}${w ? `\t# ${w}` : ""}`);
      }
      const hdr = kv(((read(`${RAW}nft-ruleset.txt`).match(/^# guard_file_sha256=.*$/m) ?? [""])[0]).slice(2).split(" "));
      const guardOk = hdr.guard_file_sha256 === sha256File("deploy/host/fcpi-guard.nft");
      const r3 = ruleSet("evidence/M3/raw/nft-ruleset.txt"), r4 = ruleSet(`${RAW}nft-ruleset.txt`);
      const ruleChanges = [...[...r4].filter((r) => !r3.has(r)).map((r) => `+ ${r}`), ...[...r3].filter((r) => !r4.has(r)).map((r) => `- ${r}`)];
      const unattributed = ruleChanges.filter((ch) => !/"fcpi-mcp"|10\.231\.8\.0\/24/.test(ch)).map((ch) => ch.replace(/\t/g, " ").slice(0, 110));
      const afterHash = (read(A).match(/^nft_ruleset_sha256=([0-9a-f]{64})$/m) ?? [])[1];
      const rulesTied = /^[0-9a-f]{64}$/.test(hdr.ruleset_sha256 ?? "") && hdr.ruleset_sha256 === afterHash;
      const tables = [...read(`${RAW}nft-ruleset.txt`).matchAll(/^table (\S+ \S+) \{/gm)].map((m) => m[1]).sort();
      const tablesOk = tables.every((t) => /^(bridge fcpi_audit|inet fcpi_audit|inet fcpi_guard|ip6? (filter|nat|raw|mangle))$/.test(t)) && tables.includes("inet fcpi_guard");
      const boot = (f) => (read(f).match(/^boot_id_sha256=([0-9a-f]{64})$/m) ?? [])[1];
      writeFileSync(resolve(ROOT, `${EV}snapshot-diff.txt`), ["# M4 BEFORE/AFTER snapshot diff (section-keyed; written by scripts/m4/verify.mjs X04)",
        `# before: ${read(B).split("\n")[1]}  after: ${read(A).split("\n")[1]}`, `# boot_id: ${boot(B) && boot(B) === boot(A) ? "unchanged (no reboot)" : "CHANGED or MISSING"}`,
        `## changes to unrelated state (${rows.unrelated.length})`, ...rows.unrelated, `## the owner's own work on the Pi and Pi-hole's own socket rotation (${rows.owner.length}; raw/owner-session.txt)`, ...rows.owner, `## project changes and the collector's own SSH sessions (${rows.project.length})`, ...rows.project,
        `## ruleset changes since M3's recorded ruleset (${ruleChanges.length}; Docker's for fcpi-mcp unless listed as unattributed)`, ...ruleChanges.map((r) => r.replace(/\t/g, " ")), ""].join("\n"));
      const ok = unexplained.length === 0 && !!boot(B) && boot(B) === boot(A) && guardOk && rulesTied && r3.size > 50 && r4.size > 50 && unattributed.length === 0 && ruleChanges.length >= 1 && tablesOk;
      return { ok, actual: `added=${added.length} removed=${removed.length}; attributed ${JSON.stringify(why)}; unexplained=${unexplained.length}${unexplained.length ? " [" + unexplained.slice(0, 8).join("; ") + "]" : ""}; boot_id_equal=${boot(B) === boot(A)}; rules changed since M3=${ruleChanges.length}, unattributed=${unattributed.length}${unattributed.length ? " [" + unattributed.slice(0, 6).join("; ") + "]" : ""}; guard is the repository's=${guardOk}; ruleset tied to AFTER=${rulesTied}` };
    } },
  X05: { name: "secret-and-identifier-redaction-scan", inputs: [M0_CONTROL, M1_CONTROL, M3_CONTROL, "scripts/m1/pi-target.conf", "evidence/M0/audit.json"], live: true,
    expected: "the positive controls fire every rule; then no rule matches in any tracked or new repository file; no file holds any live secret (M2's eight, the gateway's PostgreSQL password and every client token file on the Pi, M4's five among them), compared by SHA-256 computed on the Pi; no file added or changed since M4 began holds the Pi's LAN address, its /24 network or its SSH target",
    run() {
      const c = [...scan([M0_CONTROL], { m0: { egress: sha256("192.0.2.77"), serial: sha256("0123456789abcdef"), machineId: sha256("0123456789abcdef0123456789abcdef"), macs: new Set([sha256("02:00:00:00:00:01")]) } }, RULES, new Set()),
        ...scan([M1_CONTROL], { secrets: new Set([sha256("0f".repeat(32)), sha256("ABCDEFGHIJKLMNOP".repeat(4))]) }, RULES, new Set()),
        ...scan([M3_CONTROL], {}, RULES, new Set())];
      const fired = new Set(c.map((h) => h.split(" ").pop()));
      const silent = [...RULES.map(([n]) => n), ...HASH_RULES].filter((r) => !fired.has(r));
      if (silent.length) return { ok: false, actual: `positive controls: rules that did not fire: ${silent.join(", ")}` };
      const hashes = ssh(`sudo -n sh -c 'S=/etc/firecrawl-pi/secrets; h() { [ -n "$1" ] || { echo "EMPTY secret extraction" >&2; exit 1; }; printf "%s" "$1" | sha256sum | cut -c1-64; }; \
        h "$(cat $S/postgres_password)"; h "$(cat $S/core_postgres_password)"; h "$(sed -n "s#^amqp://fcpi:\\(.*\\)@rabbitmq:5672\\$#\\1#p" $S/core_nuq_rabbitmq_url)"; \
        h "$(sed -n "s#^redis://:\\(.*\\)@redis:6379\\$#\\1#p" $S/core_redis_url)"; h "$(cat /srv/firecrawl-pi/data/rabbitmq/.erlang.cookie)"; \
        h "$(cat $S/retrieval_postgres_password)"; h "$(cat $S/core_retrieval_token)"; h "$(cat $S/retrieval_browser_token)"; \
        h "$(cat $S/gateway_postgres_password)"; for f in $S/clients/*.token; do h "$(tr -d "\\n" < "$f")"; done'`).split("\n").filter((x) => /^[0-9a-f]{64}$/.test(x));
      const tokenFiles = +ssh("sudo -n sh -c 'ls /etc/firecrawl-pi/secrets/clients/*.token | wc -l'").trim();
      if (tokenFiles < 9 || hashes.length !== 9 + tokenFiles || new Set(hashes).size !== hashes.length || hashes.includes(sha256(""))) return { ok: false, actual: `expected nine fixed secrets and every client token (at least nine files, M4's five among them) as distinct non-empty hashes; got ${hashes.length} hashes for ${tokenFiles} token files` };
      const files = execFileSync("git", ["-C", ROOT, "ls-files", "--cached", "--others", "--exclude-standard"], { encoding: "utf8" }).split("\n").filter((f) => f && ![M0_CONTROL, M1_CONTROL, M3_CONTROL].includes(f) && has(f) && !/\.(pdf|png|gz)$/.test(f));
      const audit = json("evidence/M0/audit.json");
      const m0 = { egress: audit.network.egress_ip_sha256, serial: audit.identity.board_serial_sha256, machineId: audit.identity.machine_id_sha256, macs: new Set([...Object.values(audit.identity.mac_sha256), sha256("00:00:00:00:00:00")]) };
      const hits = scan(files, { m0, secrets: new Set(hashes) });
      const t = target(), lan = t.PI_LAN_ADDRESS, net = lan.replace(/\.\d+$/, ".0");
      const changed = [...new Set([...git("diff", "--name-only", `${M4_START}..HEAD`).split("\n"), ...git("ls-files", "--others", "--exclude-standard").split("\n")])].filter((f) => f && has(f) && !/\.(pdf|png|gz)$/.test(f));
      const idHits = changed.filter((f) => { const x = read(f); return x.includes(lan) || x.includes(`${net}/`) || x.includes(t.PI_SSH_TARGET); });
      return { ok: hits.length === 0 && idHits.length === 0, configHash: hashOf(files.filter((f) => f !== OUT)), actual: `controls fired all ${RULES.length + HASH_RULES.length} rules; files scanned=${files.length}; live secret hashes compared=${hashes.length} (client tokens ${tokenFiles}); findings=${hits.length}${hits.length ? " [" + hits.slice(0, 12).join("; ") + "]" : ""}; M4 files with the LAN address, network or SSH target=${idHits.join(",") || "none"} (of ${changed.length})` };
    } },
  L01: { name: "lock-and-compose-consistent", inputs: ["deploy/versions.lock.json", "deploy/compose.yaml", `${EV}rendered-compose.json`, "services/mcp/package-lock.json", "services/access/package-lock.json", "deploy/policies/capabilities.json"],
    expected: "every Compose image is pinned by digest for linux/arm64 across M4's eleven services; the lock records the MCP image and the gateway image the stack runs with their node base, every package of the MCP lockfile with its integrity, the protocol revisions and the SDK at 2.1.0 as selected with no remaining candidate, and the capability manifest's hash; M2's and M3's other image entries still match the stack",
    run() {
      const R = json(`${EV}rendered-compose.json`), L = json("deploy/versions.lock.json"), ml = json("services/mcp/package-lock.json").packages;
      const unpinned = Object.entries(R.services).filter(([, v]) => !/@sha256:[0-9a-f]{64}$/.test(v.image) || v.platform !== "linux/arm64").map(([k]) => k);
      const m = L.images?.mcp_gateway ?? {}, g = L.images?.access_gateway ?? {};
      const pk = Object.entries(ml).filter(([k]) => k).map(([k, v]) => [k.replace(/^node_modules\//, ""), v]);
      const cond = { mcp_image: m.image_id === digestOf(R.services["mcp-gateway"].image) && m.base === "node:22.23.3-bookworm-slim@sha256:a0ddbc73510e98f5e824fd64266ffe1c2c343ba9cf260d95ca2985ad632a3f3e",
        mcp_packages: pk.length >= 17 && pk.every(([k, v]) => L.mcp?.lockfile_packages?.[k]?.version === v.version && L.mcp.lockfile_packages[k].integrity === v.integrity && L.mcp.lockfile_packages[k].dev === (v.dev === true)),
        sdk_selected: ["server", "core", "node"].every((n) => L.mcp?.packages?.[`@modelcontextprotocol/${n}`]?.selected === "2.1.0") && L.mcp?.packages?.["@modelcontextprotocol/client"]?.selected === "2.1.0" && !L.mcp?.candidate,
        protocol: L.mcp?.protocol_revision?.selected === MODERN && L.mcp.protocol_revision.compatibility_revision === LEGACY,
        gateway: g.image_id === digestOf(R.services["access-gateway"].image), manifest: L.gateway?.capabilities_sha256 === sha256File("deploy/policies/capabilities.json"),
        others: L.images?.firecrawl_api_patched?.image_id === digestOf(R.services["firecrawl-core"].image) && L.images?.retrieval?.image_id === digestOf(R.services["retrieval-service"].image) && L.images?.browser_worker?.image_id === digestOf(R.services["browser-worker"].image) };
      return { ok: unpinned.length === 0 && bad(cond).length === 0 && Object.keys(R.services).length === 11, actual: `services=${Object.keys(R.services).length}; unpinned=${unpinned.join(",") || "none"}; lock disagrees on=${bad(cond).join(",") || "none"}` };
    } },
  M01: { name: "memory-within-caps", inputs: [`${RAW}stack.txt`].concat(PHASES.map((p) => `${RAW}e2e-${p}.txt`)),
    expected: "sampled at the start and end of every phase and before the MCP container's restart and stop: the MCP service's peak stays under its 192 MiB cap, the gateway's under 160 MiB and the core's under 2,304 MiB, none records an OOM kill, the host's OOM-kill count does not change across the samples and MemAvailable stays at 1 GiB or more; no container restarted unseen, which would have reset its peak and OOM count: in time order, the core's and the gateway's start times never change between two samples, and the MCP service's changes exactly across its deliberate restart and stop (the control that a restart shows); at the end no project cgroup records an OOM kill and every one has memory.swap.max 0, so no container can swap past its cap",
    run() {
      const all = samples().sort((a, b) => Date.parse(a.utc) - Date.parse(b.utc));
      const unsampled = PHASES.filter((p) => !all.some((s) => s.run === p && s.label === `start-${p}`) || !all.some((s) => s.run === p && /^end-/.test(s.label)));
      // Consecutive samples: a start time that moves outside the MCP service's two deliberate steps is a
      // restart M01's peaks cannot see; across those steps the MCP service's must move.
      const DELIBERATE = new Set(["before-mcp-restart>end-restart", "before-mcp-stop>end-stopped"]);
      const restarts = [], controls = [];
      for (let i = 1; i < all.length; i++) {
        const [a, b] = [all[i - 1], all[i]], pair = `${a.label}>${b.label}`;
        for (const k of ["core", "gateway"]) if (a[k]?.started_at !== b[k]?.started_at) restarts.push(`${k} ${pair}`);
        const mcpMoved = a.mcp?.started_at !== b.mcp?.started_at;
        if (DELIBERATE.has(pair)) controls.push(mcpMoved); else if (mcpMoved) restarts.push(`mcp ${pair}`);
      }
      const within = (c, capMib) => !!c && +c.max === capMib * MIB && Number.isFinite(c.peak) && c.peak < +c.max && c.oom_kill === 0;
      const over = all.filter((s) => !(within(s.mcp, 192) && within(s.gateway, 160) && within(s.core, 2304) && s.mem_available_kib >= 1024 * 1024)).map((s) => `${s.run}/${s.label}`);
      const hostOoms = new Set(all.map((s) => s.vmstat_oom_kill));
      const cg = Object.fromEntries((S(`${RAW}stack.txt`).cgroups ?? []).filter((l) => / memory\.max=/.test(l)).map((l) => [l.split(" ")[0], kv(l.split(" ").slice(1))]));
      const peak = (k) => Math.max(...all.map((s) => s[k]?.peak ?? 0)) / MIB;
      const ok = unsampled.length === 0 && all.length >= 14 && restarts.length === 0 && controls.length === 2 && controls.every(Boolean) && over.length === 0 && hostOoms.size === 1 && Number.isInteger([...hostOoms][0]) &&
        Object.keys(cg).length === 11 && Object.values(cg).every((v) => v.oom_kill === "0") && Object.values(cg).every((v) => v["memory.swap.max"] === "0");
      return { ok, actual: `samples=${all.length}, phases without one=${unsampled.join(",") || "none"}, restarts unseen by the peaks=${restarts.join(",") || "none"}, deliberate MCP restarts seen=${controls.filter(Boolean).length} of ${controls.length}, over a cap or low on memory=${over.join(",") || "none"}; highest peaks: MCP ${peak("mcp").toFixed(1)} MiB, gateway ${peak("gateway").toFixed(1)} MiB, core ${peak("core").toFixed(0)} MiB; host OOM-kill counts seen=${[...hostOoms].join(",")}; cgroup OOM kills at the end=${Object.entries(cg).filter(([, v]) => v.oom_kill !== "0").map(([k]) => k).join(",") || "none"}; swap not capped at the end=${Object.entries(cg).filter(([, v]) => v["memory.swap.max"] !== "0").map(([k]) => k).join(",") || "none"}` };
    } },

  M02: { name: "mcp-memory-envelope-measured", inputs: [`${RAW}mcp-memory-probe.txt`, `${EV}rendered-compose.json`, "deploy/policies/capabilities.json"],
    expected: "in a throwaway container of the image the stack runs, with the node options the service runs with and the deployed manifest, the MCP server answers maxToolCalls concurrent status reads, three rounds, whose gateway answers are at the answer cap (within 64 KiB, the control that the envelope was really exercised), both as a page of documents and as one document over the payload limit: every call succeeds within the payload limit, the server stays up, and its peak resident memory stays under 80% of the service's 192 MiB cap",
    run() {
      const s = S(`${RAW}mcp-memory-probe.txt`), meta = kv(((s.meta ?? [""])[0] ?? "").split(" ")), recs = jsonLines(s.probe);
      const base = recs.find((r) => r.event === "baseline"), shapes = recs.filter((r) => r.event === "shape");
      const R = json(`${EV}rendered-compose.json`).services["mcp-gateway"], L = MANIFEST.mcp.limits, cap = 192 * MIB;
      const cond = { image: meta.image === composeImage("mcp-gateway"), options: base?.node_options === (R.environment?.NODE_OPTIONS ?? "") && /--max-old-space-size=\d+/.test(base?.node_options ?? ""),
        manifest: base?.rest_response_max_bytes === L.restResponseMaxBytes && base.max_tool_calls === L.maxToolCalls, cap_is_services: +R.mem_limit === cap,
        shapes: shapes.length === 2 && ["page", "one_large_document"].every((n) => shapes.some((x) => x.shape === n)),
        at_the_cap: shapes.every((x) => x.answer_bytes >= L.restResponseMaxBytes - 65536),
        calls: shapes.every((x) => x.calls === 3 * L.maxToolCalls && x.ok === x.calls && x.alive === true && x.max_text_bytes <= L.toolTextMaxBytes),
        headroom: shapes.every((x) => Number.isFinite(x.peak_rss) && x.peak_rss < 0.8 * cap), exit: (s.probe ?? []).includes("probe_exit=0"),
        no_leftovers: (s.transient ?? []).includes("leftover_transient_containers=0") };
      return { ok: bad(cond).length === 0, actual: `failed=${bad(cond).join(",") || "none"}; answer cap ${L.restResponseMaxBytes} × ${L.maxToolCalls} concurrent; peaks=${shapes.map((x) => `${x.shape}:${(x.peak_rss / MIB).toFixed(1)} MiB`).join(",")} of ${cap / MIB} MiB (80% = ${(0.8 * cap / MIB).toFixed(1)}); node options=${base?.node_options}` };
    } },

  // ================================================================ the held live step: real target clients
  R01: { name: "real-target-clients", inputs: [`${RAW}real-clients.txt`],
    expected: "Claude Code on Haiku and Codex CLI on gpt-6-luna, each configured from deploy/clients/ with its own token scoped to read,scrape,crawl only over the tailnet and no other MCP server (Claude Code also with no built-in tool and no user settings, and no permission denial recorded), answer the fixture prompt with the page's sentinel and the crawl status each last read, and the two-page crawl each started finishes in the ledger SUCCEEDED with both pages archived; the MCP service logged each client's scrape, crawl and status calls as ok under that client's own label, with the revision each actually used, and neither saw a session header; this is real-client evidence, kept apart from the SDK fixtures",
    run() {
      const r = records(`${RAW}real-clients.txt`);
      const pv = (label) => (r.pi_view ?? []).find((x) => x.client === label) ?? null;
      // The answer names the page's sentinel and the crawl status the client last read (completed, or still
      // scraping: a client's model has no way to wait between polls); the crawl it started must then finish
      // in the ledger with both pages archived, which is what the platform guarantees.
      const good = (answer) => /^SENTINEL=fcpi-m3-p06-[0-9a-f]{4} CRAWL=(completed|scraping) DOCS=\d+$/.test(answer ?? "");
      const finished = (v) => v?.crawl_job?.state === "SUCCEEDED" && v.crawl_job.archived === 2;
      const used = (v) => { const tools = new Set((v?.tools ?? []).filter((t) => t.outcome === "ok").map((t) => t.tool)); return ["firecrawl_scrape", "firecrawl_crawl", "firecrawl_check_crawl_status"].every((t) => tools.has(t)); };
      const revs = (v) => [...new Set((v?.tools ?? []).map((t) => `${t.era}/${t.protocol_version}`))].join(",");
      const products = (v) => [...new Set([...(v?.tools ?? []), ...(v?.exchanges ?? [])].map((x) => x.client_info).filter(Boolean).map((i) => `${i.name}@${i.version}`))].join(",") || "none named";
      const cc = r.claude_code?.[0], cx = r.codex?.[0], vc = pv("m4claude"), vx = pv("m4codex");
      const cond = { run: r.meta?.length === 1 && r.end?.[0]?.exit === 0 && !r.error, claude_answer: cc?.exit === 0 && good(cc.answer), claude_crawl_finished: finished(vc), claude_isolated: Array.isArray(cc?.permission_denials) && cc.permission_denials.length === 0,
        scopes: ["m4claude", "m4codex"].every((l) => (r.tokens ?? []).some((t) => t.label === l && t.scopes === "read,scrape,crawl")), claude_calls: used(vc) && (vc?.exchanges ?? []).length >= 3 && vc.exchanges.every((e) => e.session_header_sent === false),
        codex_answer: cx?.exit === 0 && good(cx.answer), codex_crawl_finished: finished(vx), codex_calls: used(vx) && (vx?.exchanges ?? []).length >= 3 && vx.exchanges.every((e) => e.session_header_sent === false) };
      return { ok: bad(cond).length === 0, actual: `failed=${bad(cond).join(",") || "none"}; Claude Code ${cc?.client} (${(cc?.models_used ?? []).join(",")}): ${cc?.answer}, crawl ${vc?.crawl_job?.state}/${vc?.crawl_job?.archived}, revision ${revs(vc)}, named itself ${products(vc)}; Codex ${cx?.client} (${cx?.model}): ${cx?.answer}, crawl ${vx?.crawl_job?.state}/${vx?.crawl_job?.archived}, revision ${revs(vx)}, named itself ${products(vx)}` };
    } },

  // ================================================================ the review of record
  V01: { name: "review-record-complete", inputs: [`${EV}review/REVIEW.md`],
    expected: "the saved /review-2 report (CLAUDE.md §5) gives every finding it lists, and every finding found during M4 outside the review (F), a row with an outcome (fixed with its commit, rejected with evidence, deferred to M5 or later), gives every finding an earlier review deferred to M4 (CLAUDE.md §30) a row of its own (there is none at M4's start), cites only commits that exist, and holds no absolute local path",
    run() {
      const text = read(`${EV}review/REVIEW.md`);
      const rows = text.split("\n").filter((l) => /^\| [A-Z]{1,2}\d+ \|/.test(l)).map((l) => l.split(" | "));
      const badRows = rows.filter((c) => !/^(Fixed|Rejected, with the evidence|Deferred to M[5-9]\b)/.test(c[3] ?? "")).map((c) => c[0].slice(2));
      const carried = ["M0", "M1", "M2", "M3"].flatMap((m) => { const dir = `evidence/${m}/review`;
        return has(dir) ? readdirSync(resolve(ROOT, dir)).filter((f) => f.endsWith(".md")).flatMap((f) => read(`${dir}/${f}`).split("\n").filter((l) => /^\| [A-Z]{1,2}\d+ \|/.test(l) && /\| Deferred to M4\b/.test(l)).map((l) => `${m} ${l.split(" | ")[0].slice(2)}`)) : []; });
      const carriedRows = text.split("\n").filter((l) => /^\| M\d [A-Z]{1,2}\d+ \|/.test(l)).map((l) => l.split(" | "));
      const carriedBad = carried.filter((id) => { const r = carriedRows.find((c) => c[0] === `| ${id}`); return !r || !/^(Fixed|Rejected, with the evidence|Deferred to M[5-9]\b)/.test(r[2] ?? ""); });
      // The review's findings (C, W, S) and those found during M4 outside it (F), which later milestones take
      // from this report just the same.
      const listedIds = [...text.matchAll(/^\s*\d+\. \*\*([CWSF]\d+) —/gm)].map((m) => m[1]);
      const uncovered = listedIds.filter((id) => !rows.some((c) => c[0] === `| ${id}`));
      const uncited = rows.filter((c) => /^Fixed/.test(c[3] ?? "") && !/`[0-9a-f]{7,40}`/.test(c[4] ?? "")).map((c) => c[0].slice(2));
      const commits = [...new Set(rows.flatMap((c) => [...(c[4] ?? "").matchAll(/`([0-9a-f]{7,40})`/g)].map((m) => m[1])))];
      const missing = commits.filter((c) => { try { git("cat-file", "-e", `${c}^{commit}`); return false; } catch { return true; } });
      const local = /\/(private\/tmp|Users\/[^\/\s]+|home\/[^\/\s]+)\//.test(text);
      const ok = rows.length > 0 && listedIds.length >= rows.length - carriedRows.length && uncovered.length === 0 && uncited.length === 0 && badRows.length === 0 && missing.length === 0 && !local && carriedBad.length === 0;
      return { ok, actual: `carried over from earlier reviews=${carried.join(",") || "none"}, without a recognised outcome=${carriedBad.join(",") || "none"}; findings listed=${listedIds.length}, rows=${rows.length}, without a row=${uncovered.join(",") || "none"}; fixed without a commit=${uncited.join(",") || "none"}; without a recognised outcome=${badRows.join(",") || "none"}; commits cited=${commits.length}, missing=${missing.join(",") || "none"}; absolute local path=${local}` };
    } },
};

// ---- runner ------------------------------------------------------------------------------------------
const listed = Object.keys(checks);
const wanted = process.argv.slice(2).length ? process.argv.slice(2) : listed;
const prior = has(OUT) ? json(OUT) : { results: [] };
const results = Object.fromEntries(prior.results.map((r) => [r.test_id, r]));
const repo = repoState();
const series = json("patches/series.json");
for (const id of wanted) {
  const c = checks[id];
  if (!c) throw new Error(`unknown check ${id}`);
  const rec = { test_id: `M4-${id}`, name: c.name, utc: now(), ...repo, upstream_sha: UPSTREAM_SHA, patch_series_sha256: series.series_sha256, config_or_fixture_hash: null, expected: c.expected };
  try {
    const missing = c.inputs.filter((p) => !has(p));
    if (missing.length) Object.assign(rec, { state: "NOT_RUN", actual: `evidence missing: ${missing.join(", ")}`, exit_code: null });
    else {
      rec.config_or_fixture_hash = c.inputs.length ? hashOf(c.inputs) : null;
      const r = c.run();
      if (r.notRun) Object.assign(rec, { state: "NOT_RUN", actual: r.actual, exit_code: null });
      else if (r.blocked) Object.assign(rec, { state: "BLOCKED_CREDENTIAL", actual: r.actual, exit_code: null });
      else Object.assign(rec, { state: r.ok ? "PASS" : "FAIL", actual: r.actual, exit_code: r.ok ? 0 : 1 });
      if (r.configHash) rec.config_or_fixture_hash = r.configHash;
    }
    if (c.live) rec.live_sources = "the Pi over SSH (secret hashes only)";
  } catch (e) {
    Object.assign(rec, { state: "FAIL", actual: `check raised: ${e.message}`, exit_code: 2, classification: "verifier-error" });
  }
  rec.image_digests_platform = has(`${EV}rendered-compose.json`) ? { platform: "linux/arm64", mcp: digestOf(composeImage("mcp-gateway")), gateway: digestOf(composeImage("access-gateway")), api: digestOf(composeImage("firecrawl-core")), retrieval: digestOf(composeImage("retrieval-service")), browser: digestOf(composeImage("browser-worker")) } : null;
  rec.actual = hideIds(String(rec.actual), target());
  rec.evidence_path = OUT;
  results[rec.test_id] = rec;
  console.log(`${rec.test_id} ${rec.state.padEnd(18)} ${c.name}${rec.state !== "PASS" ? `  — ${rec.actual.slice(0, 260)}` : ""}`);
}
const ordered = listed.map((id) => results[`M4-${id}`] ?? { test_id: `M4-${id}`, name: checks[id].name, state: "NOT_RUN", actual: "never run", evidence_path: OUT });
writeFileSync(resolve(ROOT, OUT), JSON.stringify({ schema: "fcpi.m4.verification/v1", runner: "scripts/m4/verify.mjs",
  repository_sha_note: "Each result records the commit checked out when it ran, with code_dirty; the commit that stores this file is a later one on main.",
  results: ordered }, null, 2) + "\n");
process.exitCode = ordered.every((r) => r.state === "PASS" || r.state === "BLOCKED_CREDENTIAL") ? 0 : 1;
