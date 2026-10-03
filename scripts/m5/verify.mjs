#!/usr/bin/env node
// M5 verification (docs/FIRECRAWL_PI_MILESTONES.md, M5 "Automated Verification" and "Acceptance Criteria";
// spec AC05-AC08, AC23-AC25; CLAUDE.md §25, §26, §33.3). Every check recomputes its result from the raw
// evidence under evidence/M5/ (or the directory FCPI_M5_EVIDENCE names) and records the §25 tuple, with
// code_dirty, in evidence/M5/verification.json. A check whose evidence is missing is NOT_RUN, never PASS; a
// live check whose record says its credential or budget is missing is BLOCKED_CREDENTIAL; a record a check
// reads must be there (an absent one fails, it does not pass vacuously); every negative result is read
// beside its positive control; each check's `expected` names what it compares. Fixture results and live
// results are separate checks: a fixture check never stands in for a live one.
//   node scripts/m5/verify.mjs [CHECK_ID …]
import { readFileSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { ROOT, sha256, sha256File, repoState, sections, git, kv } from "../m0/lib.mjs";

const EV = process.env.FCPI_M5_EVIDENCE ?? "evidence/M5/";
const RAW = `${EV}raw/`;
const OUT = `${EV}verification.json`;
const UPSTREAM_SHA = "7666c1f9ae8720a6bba271e0f60b6a217f8a5210";
const M5_START = "10cdc59"; // the kickoff's HEAD: files changed after it are M5's
const MIB = 1024 * 1024;
const read = (p) => readFileSync(resolve(ROOT, p), "utf8");
const json = (p) => JSON.parse(read(p));
const has = (p) => existsSync(resolve(ROOT, p));
const now = () => new Date().toISOString().replace(/\.\d+Z$/, "Z");
const hashOf = (paths) => sha256(paths.map((p) => `${p}:${sha256File(p)}`).join("\n"));
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
const FX = () => records(`${RAW}e2e-fixture.txt`);
const LIVE = () => records(`${RAW}e2e-live.txt`);
const one = (recs, c) => (recs ?? []).find((r) => r.case === c) ?? null;
const endOk = (e) => e.meta?.length === 1 && e.end?.length === 1 && e.end[0].exit === 0 && !e.error;
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const bad = (cond) => Object.entries(cond).filter(([, v]) => !v).map(([k]) => k);
const tapCounts = (lines) => { const n = (k) => +((lines ?? []).find((l) => l.startsWith(`# ${k} `)) ?? "").split(" ")[2]; return { tests: n("tests"), pass: n("pass"), fail: n("fail") }; };
const BUDGET = () => json("deploy/policies/budget.json");
const cardFor = (subject) => BUDGET().rateCards.find((r) => r.subject === subject && r.effectiveTo === null);
const modelCost = (card, u) => { const cached = Math.min(u.cachedTokens ?? 0,u.promptTokens), written = Math.min(u.cacheWriteTokens ?? 0,u.promptTokens-cached); return Math.ceil(((u.promptTokens-cached-written)*card.inputPerMTok+cached*card.cachedInputPerMTok+written*(card.cacheWritePerMTok ?? card.inputPerMTok)+u.completionTokens*card.outputPerMTok)/1e6); };
const FIXTURE_ENGINES = ["fcpi fixture", "fcpi fixture b"];
const LIVE_ENGINES = ["duckduckgo", "bing", "brave"];

// ---- redaction (M4's rules and controls, M5's live secrets) ------------------------------------------
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
  "100.100.100.100", "100.64.0.0", "100.64.0.1", "100.127.255.254",
  // M5: SearXNG's entrypoint builds its proxy URL from the secret file (deploy/searxng/entrypoint.sh), and the
  // retrieval tests' fixture credentials are synthetic values of the shape a provider key has.
  "http://searxng:${pw}@", "sk-test-not-a-real-key-0000000000"]);
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

// ---- snapshot attribution (M4's X04, with M5's bridges) ------------------------------------------------
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
  if (sec === "firewall" && /^nft_ruleset_sha256=/.test(line)) return "nftables ruleset: every changed rule attributed in X04 (evidence/M5/raw/nft-ruleset.txt)";
  if (sec === "nft_chains" && /^ip6? (filter|nat|raw) (DOCKER[-A-Z0-9]*|FORWARD|PREROUTING|OUTPUT|POSTROUTING) /.test(line)) return "Docker's chains";
  return null;
}

// The reboot during M5's window (raw/reboot.txt, M4's recorder; raw/reboot-cause.txt names the host's own
// Wi-Fi watchdog that ordered it): the record must tie BEFORE's boot to the journal's previous boot and
// AFTER's to the current one. Only then does a line the reboot itself changed count as attributed, each by
// what changed, as M4's X04 counts them: a module in both snapshots whose size differs, a mount whose target,
// source and type are the same with only its options changed, a service's ephemeral UDP port chosen again at
// its start, and a unit no longer running that neither snapshot lists as enabled.
function rebootTie(bootB, bootA) {
  if (!has(`${RAW}reboot.txt`) || !bootB || !bootA || bootB === bootA) return null;
  const s = S(`${RAW}reboot.txt`);
  const boots = Object.fromEntries((s.boots ?? []).map((l) => kv(l.split(" "))).map((b) => [b.idx, b]));
  const cur = kv(((s.current ?? [])[0] ?? "").split(" "));
  const tied = boots["-1"]?.boot_id_sha256 === bootB && boots["0"]?.boot_id_sha256 === bootA && cur.boot_id_sha256 === bootA;
  return tied ? { kernel: cur.kernel, ended: boots["-1"].last } : null;
}
function rebootAttribute(sec, line, kind, B, A) {
  const other = kind === "removed" ? A : B;
  const inOther = (pred) => other.some(([s, l]) => s === sec && l !== line && pred(l));
  if (sec === "lsmod") { const n = line.split(" ")[0]; if (inOther((l) => l.split(" ")[0] === n)) return "the reboot: a module in both snapshots, loaded again at boot"; }
  if (sec === "findmnt") { const [t, src, fs] = line.split(" "); if (inOther((l) => { const f = l.split(" "); return f[0] === t && f[1] === src && f[2] === fs; })) return "the reboot: a mount made again at boot, only its options changed"; }
  { const m = line.match(/^udp (?:0\.0\.0\.0|\*):(\d+) users:\(\("([^"]+)",pid,fd\)\)$/);
    if (sec === "ss_listen" && m && +m[1] >= 32768 && inOther((l) => l.startsWith("udp ") && l.includes(`(("${m[2]}",`))) return "the reboot: a service's ephemeral UDP port, chosen again at its start"; }
  if (sec === "systemd_running" && kind === "removed" && /\.service$/.test(line) && !B.concat(A).some(([s, l]) => s === "systemd_enabled" && l === line)) return "the reboot: a unit not enabled at boot, started on demand in the earlier boot";
  return null;
}

// ---- memory samples ----------------------------------------------------------------------------------
const samples = () => ["fixture", "live"].flatMap((p) => (has(`${RAW}e2e-${p}.txt`) ? (records(`${RAW}e2e-${p}.txt`).resources ?? []).map((r) => ({ run: p, ...r })) : []));

// ---- checks ------------------------------------------------------------------------------------------
const checks = {
  B00: { name: "baseline-matches-m4-after", inputs: [`${EV}snapshot-before.txt`, "evidence/M4/snapshot-after.txt"],
    expected: "M5's BEFORE snapshot equals M4's AFTER apart from SSH session scopes, and the boot ID is unchanged",
    run() {
      const strip = (f) => keyedSnapshot(f).map((x) => x.join("\t")).filter((l) => !/\tsession-\d+\.scope$/.test(l)).sort();
      const a = strip("evidence/M4/snapshot-after.txt"), b = strip(`${EV}snapshot-before.txt`);
      const only = (x, y) => x.filter((l) => !y.includes(l));
      const boot = (f) => (read(f).match(/^boot_id_sha256=([0-9a-f]{64})$/m) ?? [])[1];
      const ok = a.length > 50 && only(a, b).length === 0 && only(b, a).length === 0 && !!boot(`${EV}snapshot-before.txt`) && boot("evidence/M4/snapshot-after.txt") === boot(`${EV}snapshot-before.txt`);
      return { ok, actual: `lines=${a.length}; only in M4 AFTER=${only(a, b).length}, only in M5 BEFORE=${only(b, a).length}, boot_id_equal=${boot("evidence/M4/snapshot-after.txt") === boot(`${EV}snapshot-before.txt`)}` };
    } },

  // ================================================================ the images, the patches, the suites
  G01: { name: "images-pinned-built-and-running", inputs: [`${RAW}api-build.log`, `${RAW}api-push.txt`, `${RAW}image-build.txt`, `${RAW}searxng-registry.txt`, `${EV}rendered-compose.json`, `${RAW}stack.txt`],
    expected: "the patched API image was built for linux/arm64 with every step run from a clean tree, carries the series hash, and is the image the Pi loaded and the core runs; the retrieval, gateway and MCP images the stack runs are their last builds on the Pi, each recording the commit it was built from, whose source directory is unchanged to HEAD; SearXNG runs the arm64 manifest of its pinned tag; every deployed commit a record names differs from HEAD in nothing the Pi runs",
    run() {
      const log = read(`${RAW}api-build.log`), push = read(`${RAW}api-push.txt`), build = read(`${RAW}image-build.txt`), st = S(`${RAW}stack.txt`);
      const series = json("patches/series.json");
      const apiId = (log.match(/^id=(sha256:[0-9a-f]{64}) os=linux arch=arm64 /m) ?? [])[1];
      const apiCommit = (log.match(/^repository_commit=([0-9a-f]{40}) code_dirty=false$/m) ?? [])[1];
      const running = (s) => (st.containers ?? []).find((l) => l.startsWith(`${s} `))?.match(/ image=(sha256:[0-9a-f]{64}) /)?.[1];
      const last = (i) => [...build.matchAll(new RegExp(`^fcpi/${i}:m5 id=(sha256:[0-9a-f]{64}) os=linux arch=arm64 size=\\d+ user=(\\S+)$`, "gm"))].at(-1);
      const builtFrom = (i) => [...build.matchAll(new RegExp(`^fcpi/${i}:m5 FCPI_SOURCE_COMMIT=([0-9a-f]{40})$`, "gm"))].at(-1)?.[1];
      const dirSame = (c, d) => { try { git("diff", "--quiet", c, "HEAD", "--", d); return true; } catch { return false; } };
      const runsSame = (c) => { try { git("diff", "--quiet", c, "HEAD", "--", "services", "deploy", "scripts", "tests", "patches", ":(exclude)deploy/versions.lock.json"); return true; } catch { return false; } };
      const deployed = [...new Set([kv(st.meta ?? []).source_commit, FX().meta?.[0]?.deployed_commit, has(`${RAW}e2e-live.txt`) ? LIVE().meta?.[0]?.deployed_commit : null].filter(Boolean))];
      const cond = { api_built: !!apiId && /^build_exit=0 /m.test(log) && /^no_cache=1$/m.test(log) && !!apiCommit && log.includes(`FCPI_PATCH_SERIES_SHA256=${series.series_sha256}`) && log.includes(`FIRECRAWL_BUILD_SHA=${UPSTREAM_SHA}`),
        api_loaded_and_running: push.includes(`pi_image=${apiId} arm64`) && digestOf(composeImage("firecrawl-core")) === apiId && running("firecrawl-core") === apiId,
        api_patches_unchanged: !!apiCommit && dirSame(apiCommit, "patches"),
        searxng: digestOf(composeImage("searxng")) === "sha256:d9ca82c19f98a684db92af79f5647028e39aaaa90d10611633260139f65b0c19" && read(`${RAW}searxng-registry.txt`).includes("2026.9.25-12f8b6515@sha256:d9ca82c19f98a684db92af79f5647028e39aaaa90d10611633260139f65b0c19") && running("searxng") === digestOf(composeImage("searxng")),
        deployed_code_is_head: deployed.length >= 1 && deployed.every(runsSame) };
      for (const [svc, img, dir, uid] of [["retrieval-service", "retrieval", "services/retrieval", "3310:3310"], ["access-gateway", "access-gateway", "services/access", "3380:3380"], ["mcp-gateway", "mcp-gateway", "services/mcp", "3400:3400"]]) {
        const l = last(img), c = builtFrom(img);
        cond[`${img}_built_runs_unchanged`] = !!l && l[2] === uid && running(svc) === l[1] && digestOf(composeImage(svc)) === l[1] && !!c && dirSame(c, dir);
      }
      return { ok: bad(cond).length === 0, actual: `failed=${bad(cond).join(",") || "none"}; api ${apiId?.slice(7, 19)} from ${apiCommit?.slice(0, 7)} series ${series.series_sha256.slice(0, 8)}; deployed commits=${deployed.map((c) => c.slice(0, 7)).join(",")}` };
    } },
  P01: { name: "patch-series-and-coverage", inputs: ["patches/series.json", "patches/0007-typed-search-failures.patch", "patches/0008-document-policy-and-parser-fallback.patch", `${RAW}api-build.log`],
    expected: "every patch file hashes to its series entry, the series hash is recomputed from them, patches 0007 and 0008 name their symbols and tests, the search and document coverage rows name them, and the API build log shows all eight applied to the series' result tree",
    run() {
      const s = json("patches/series.json"), log = read(`${RAW}api-build.log`);
      const listing = s.patches.map((p) => `${p.sha256}  ${p.file}\n`).join("");
      const cond = { files: s.patches.every((p) => sha256File(`patches/${p.file}`) === p.sha256), series: sha256(listing) === s.series_sha256, eight: s.patches.length === 8,
        new_entries: ["0007-typed-search-failures.patch", "0008-document-policy-and-parser-fallback.patch"].every((f) => { const p = s.patches.find((x) => x.file === f); return p && p.symbols.length >= 2 && p.tests.length >= 2; }),
        coverage: /0007/.test(s.coverage.find((c) => c.path === "search queries")?.covered_by ?? "") && /0008/.test(s.coverage.find((c) => c.path === "PDF and document downloads")?.covered_by ?? ""),
        applied: s.patches.every((p) => log.includes(`applied ${p.file} sha256=${p.sha256}`)) && log.includes(`result_tree=${s.result_tree} series_sha256=${s.series_sha256}`) };
      return { ok: bad(cond).length === 0, actual: `failed=${bad(cond).join(",") || "none"}; series ${s.series_sha256.slice(0, 8)} tree ${s.result_tree.slice(0, 8)}` };
    } },
  G02: { name: "suites-pass-in-the-running-images", inputs: [`${RAW}suites.txt`, `${EV}rendered-compose.json`],
    expected: "inside the images the stack runs: the retrieval service's suite (at least 114 tests, the ledger's SQL among them against a throwaway PostgreSQL, none skipped), the gateway's extraction-runner and json-format tests (at least 16), the MCP service's suites, the gateway's unit suites, M3's 40-test contract suite and M4's gateway-level /mcp contract suite and the gateway ledger's version-1 to version-2 migration test all pass with none failing, and no throwaway container or network is left",
    run() {
      const s = S(`${RAW}suites.txt`), m = kv((s.meta ?? [""])[0].split(" "));
      const t = (k) => tapCounts(s[k]), exit0 = (k) => (s[k] ?? []).includes("test_exit=0");
      const skipped = +(((s.retrieval_tap ?? []).find((l) => l.startsWith("# skipped ")) ?? "# skipped 1").split(" ")[2]);
      const tr = kv((s.transient ?? []).flatMap((l) => l.split(" ")));
      const cond = { images: m.retrieval_image === composeImage("retrieval-service") && m.gateway_image === composeImage("access-gateway") && m.mcp_image === composeImage("mcp-gateway"),
        retrieval: t("retrieval_tap").tests >= 114 && t("retrieval_tap").fail === 0 && skipped === 0 && exit0("retrieval_tap"),
        gateway_m5: t("gateway_m5_tap").tests >= 16 && t("gateway_m5_tap").fail === 0 && exit0("gateway_m5_tap"),
        mcp: t("mcp_tap").tests >= 41 && t("mcp_tap").fail === 0 && exit0("mcp_tap"), gateway_unit: t("gateway_unit_tap").tests >= 30 && t("gateway_unit_tap").fail === 0 && exit0("gateway_unit_tap"),
        m3_contract: t("gateway_contract_tap").tests === 40 && t("gateway_contract_tap").pass === 40 && exit0("gateway_contract_tap"),
        m4_contract: t("gateway_mcp_contract_tap").tests >= 3 && t("gateway_mcp_contract_tap").fail === 0 && exit0("gateway_mcp_contract_tap"),
        ledger_migration: t("ledger_migration_tap").tests === 1 && t("ledger_migration_tap").fail === 0 && exit0("ledger_migration_tap"),
        grammars: t("grammars_tap").tests >= 3 && t("grammars_tap").fail === 0, no_leftovers: tr.leftover_transient_containers === "0" && tr.leftover_transient_networks === "0" };
      return { ok: bad(cond).length === 0, actual: `failed=${bad(cond).join(",") || "none"}; retrieval ${t("retrieval_tap").pass}/${t("retrieval_tap").tests} (skipped ${skipped}), gateway-m5 ${t("gateway_m5_tap").pass}/${t("gateway_m5_tap").tests}, mcp ${t("mcp_tap").pass}/${t("mcp_tap").tests}, gateway unit ${t("gateway_unit_tap").pass}/${t("gateway_unit_tap").tests}, M3 contract ${t("gateway_contract_tap").pass}/${t("gateway_contract_tap").tests}, M4 contract ${t("gateway_mcp_contract_tap").pass}/${t("gateway_mcp_contract_tap").tests}` };
    } },

  // ================================================================ search (AC06; review finding S6)
  S01: { name: "search-typed-outcomes-rest", inputs: [`${RAW}e2e-fixture.txt`],
    expected: "against the real SearXNG on the fixture engines, through REST: results (200, at least one); the same query again from the cache; a true empty answer (200, web: []); a partial answer (200 with a warning naming the engine that failed); every engine failing (502 SEARCH_ENGINES_FAILED, never an empty list); the backend stopped (503 SEARCH_BACKEND_UNAVAILABLE); the backend paused (504 SEARCH_TIMEOUT after the 10 s deadline); an option the pinned client ignores refused (400 UNSUPPORTED_OPTION); results scraped through the guarded path, and refused (403) to a token without the scrape scope that still searches (the control)",
    run() {
      const e = FX(), c = (k) => one(e.search, k);
      const cond = { run_whole: endOk(e), results: c("results")?.status === 200 && c("results").results >= 1, cached: c("repeat_cached")?.status === 200 && c("repeat_cached").results === c("results")?.results,
        true_empty: c("true_empty")?.status === 200 && c("true_empty").results === 0 && same(c("true_empty").data, { web: [] }),
        partial: c("partial")?.status === 200 && c("partial").results >= 1 && /Partial search result: 1 engine\(s\) did not answer \(fcpi fixture b: /.test(c("partial").warning ?? ""),
        engines_failed: c("engines_failed")?.status === 502 && c("engines_failed").code === "SEARCH_ENGINES_FAILED" && c("engines_failed").success === false,
        backend_down: c("backend_down")?.status === 503 && c("backend_down").code === "SEARCH_BACKEND_UNAVAILABLE" && /exited/.test(c("backend_down").searxng ?? ""),
        timeout: c("backend_timeout")?.status === 504 && c("backend_timeout").code === "SEARCH_TIMEOUT" && c("backend_timeout").ms >= 10000 && c("backend_timeout").ms < 20000,
        refused_option: c("refused_option")?.status === 400 && c("refused_option").code === "UNSUPPORTED_OPTION",
        scraped: c("results_scraped")?.status === 200 && c("results_scraped").scraped === c("results_scraped").results && c("results_scraped").results >= 1,
        scrape_scope: c("scrape_scope_refused")?.status === 403 && c("scrape_scope_refused").code === "INSUFFICIENT_SCOPE" && c("search_scope_control")?.status === 200 };
      return { ok: bad(cond).length === 0, actual: `failed=${bad(cond).join(",") || "none"}; ${(e.search ?? []).map((r) => `${r.case}=${r.status ?? (r.isError ? "tool-error" : "ok")}${r.code ? ` ${r.code}` : ""}`).join("; ")}` };
    } },
  S02: { name: "search-typed-outcomes-mcp", inputs: [`${RAW}e2e-fixture.txt`],
    expected: "through firecrawl_search on /mcp (modern era): results and a true empty answer are tool results (not errors), every engine failing and the backend stopped are tool errors carrying 502 SEARCH_ENGINES_FAILED and 503 SEARCH_BACKEND_UNAVAILABLE",
    run() {
      const e = FX(), c = (k) => one(e.search, k);
      const cond = { results: c("mcp_results")?.isError === false && c("mcp_results").results >= 1, empty: c("mcp_true_empty")?.isError === false && c("mcp_true_empty").results === 0,
        failed: c("mcp_engines_failed")?.isError === true && c("mcp_engines_failed").code === "SEARCH_ENGINES_FAILED" && c("mcp_engines_failed").httpStatus === 502,
        down: c("mcp_backend_down")?.isError === true && c("mcp_backend_down").code === "SEARCH_BACKEND_UNAVAILABLE" && c("mcp_backend_down").httpStatus === 503 };
      return { ok: bad(cond).length === 0, actual: `failed=${bad(cond).join(",") || "none"}` };
    } },
  S03: { name: "search-log-cache-and-selection", inputs: [`${RAW}e2e-fixture.txt`],
    expected: "the retrieval service's search events name the fixture selection and engines for every query, count the repeat as a cache hit that reached no backend (the fixture engine's own counter agrees), record the partial, empty and failed outcomes as such, and never hold the query's text (only its hash)",
    run() {
      const e = FX(), ev = e.search_log?.[0]?.events ?? [];
      const outcomes = ev.map((x) => x.outcome);
      const backendQueries = ev.filter((x) => !["cache_hit", "rate_limited"].includes(x.outcome) && !/^SEARCH_/.test(x.outcome ?? "")).length;
      const statSearch = (e.provider_stats ?? []).find((p) => p.point === "after_search")?.search?.calls;
      const cond = { selection: ev.length >= 8 && ev.every((x) => x.selection === "fixture" && same(x.engines, FIXTURE_ENGINES)), cache_hit: outcomes.includes("cache_hit"),
        outcomes: ["results", "empty", "partial", "engines_failed", "SEARCH_BACKEND_UNAVAILABLE", "SEARCH_TIMEOUT"].every((o) => outcomes.includes(o)),
        backend_count: Number.isInteger(statSearch) && statSearch >= backendQueries, no_query_text: e.search_log?.[0]?.query_text_logged === false };
      return { ok: bad(cond).length === 0, actual: `failed=${bad(cond).join(",") || "none"}; outcomes=${outcomes.join(",")}; fixture engine calls=${statSearch}` };
    } },
  S04: { name: "searxng-posture-native-and-reach", inputs: [`${RAW}stack.txt`, `${EV}rendered-compose.json`],
    expected: "SearXNG runs as 3330 with a read-only root, every capability dropped, no Docker socket, its settings and entrypoint mounted read-only and its runtime paths on tmpfs, one application worker, JSON output only (HTML answers 403) and exactly the live and fixture engines enabled; it is native on this kernel (M0's obligation): the Python interpreter and every shared object are AArch64 with LOAD segments aligned to at least the host's page size; it has no default route, reaches no public host (example.com, api.firecrawl.dev, duckduckgo.com), and the retrieval service's search proxy answers it (407 without the credential), the positive control",
    run() {
      const st = S(`${RAW}stack.txt`), R = json(`${EV}rendered-compose.json`).services.searxng;
      const c = kv(((st.containers ?? []).find((l) => l.startsWith("searxng ")) ?? "").split(" "));
      const img = kv((st.searxng_image ?? []).flatMap((l) => l.split(" ")));
      const page = +kv(((st.searxng_native ?? []).find((l) => l.startsWith("python=")) ?? "").split(" ")).page_size;
      const elfs = (st.searxng_native ?? []).filter((l) => l.startsWith("elf ")).map((l) => ({ path: l.match(/path=(\S+)/)?.[1], machine: l.match(/machine=(.*?) load_align=/)?.[1], align: l.match(/load_align=(\S+)/)?.[1] }));
      const alignOk = (a) => (a ?? "").split(",").every((x) => /^0x[0-9a-f]+$/.test(x) && parseInt(x, 16) >= page);
      const reach = kv((st.searxng_reach ?? []).flatMap((l) => l.split(" ")));
      const health = st.searxng_health ?? [];
      const cfg = (() => { try { return JSON.parse(health.find((l) => l.startsWith("{")) ?? "null"); } catch { return null; } })();
      const cond = { user: c.user === "3330:3330" && c.readonly_rootfs === "true" && c.privileged === "false" && c.cap_drop === "ALL" && c.docker_sock_mount === "0" && /no-new-privileges:true/.test(c.security_opt ?? ""),
        mounts: img.mounts === "/fcpi:ro,/run/secrets/searxng_proxy_password:ro,/run/secrets/searxng_secret_key:ro" || /\/fcpi:ro/.test(img.mounts ?? ""), tmpfs: img.tmpfs === "/etc/searxng,/tmp,/var/cache/searxng",
        workers: +kv((st.searxng_native ?? []).flatMap((l) => l.split(" "))).granian_workers >= 1 && R.environment?.GRANIAN_WORKERS === "1",
        json_only: health.includes("OK") && (health.find((l) => l.startsWith("html_format_status=")) ?? "").endsWith("=403"),
        engines: same(cfg?.engines, [...LIVE_ENGINES, ...FIXTURE_ENGINES].sort()),
        native: page >= 4096 && elfs.length >= 5 && elfs.every((x) => /AArch64/.test(x.machine ?? "") && alignOk(x.align)),
        arm64_image: img.arch === "arm64" && img.version === "2026.9.25-12f8b6515",
        reach: reach.default_route === "" && ["example.com", "api.firecrawl.dev", "duckduckgo.com"].every((h) => reach[`https_${h}`] === "refused") && reach.search_proxy_control === "407" };
      return { ok: bad(cond).length === 0, actual: `failed=${bad(cond).join(",") || "none"}; elf files=${elfs.length}, page=${page}, aligns=${[...new Set(elfs.map((x) => x.align))].join("|")}; reach=${JSON.stringify(reach)}; engines=${cfg?.engines?.join(",")}` };
    } },
  S05: { name: "search-live", live: true, inputs: [`${RAW}e2e-live.txt`],
    expected: "with live search egress switched on after the review was addressed: a live query returns results from the live engines through REST and MCP; a quoted nonsense query is answered 200 or with a typed failure, never an error of the platform's own (a live engine may still return loose matches for it, so the true empty answer is proven against the fixture engine in S01 and S02, and the count is reported here); every partial answer names the engines that did not answer; every search event names the live engine set; and every connection SearXNG made through the search proxy went to a live engine's host, with at least one",
    run() {
      const e = LIVE(), c = (k) => one(e.live_search, k);
      const ev = e.live_search_log?.[0]?.events ?? [], eg = e.live_search_log?.[0]?.egress ?? [];
      const hosts = json("deploy/policies/egress.json").search.engineHosts.live;
      const named = /^Partial search result: \d+ engine\(s\) did not answer \((duckduckgo|bing|brave): /;
      const warned = ["results", "nothing_matches"].map(c).filter((x) => x?.status === 200 && x.warning);
      const cond = { run_whole: endOk(e), results: c("results")?.status === 200 && c("results").results >= 1,
        nothing: c("nothing_matches")?.status === 200 || /^SEARCH_/.test(c("nothing_matches")?.code ?? ""),
        partial_named: warned.every((x) => named.test(x.warning)) && (!ev.some((y) => y.outcome === "partial") || warned.length >= 1),
        mcp: c("mcp_results")?.isError === false && c("mcp_results").results >= 1, selection: ev.length >= 3 && ev.every((x) => x.selection === "live" && same(x.engines, LIVE_ENGINES)),
        egress: eg.length >= 1 && eg.every((x) => hosts.includes(x.host)) };
      return { ok: bad(cond).length === 0, actual: `failed=${bad(cond).join(",") || "none"}; nonsense query: status ${c("nothing_matches")?.status}, results ${c("nothing_matches")?.results}, warning ${JSON.stringify(c("nothing_matches")?.warning ?? null)}; results=${c("results")?.results}, hosts=${JSON.stringify([...new Set(c("results")?.hosts ?? [])].slice(0, 6))}; egress hosts=${[...new Set(eg.map((x) => x.host))].join(",")}; outcomes=${ev.map((x) => x.outcome).join(",")}` };
    } },
  M01: { name: "map-during-search-outage", inputs: [`${RAW}e2e-fixture.txt`],
    expected: "with SearXNG stopped (AC05), /v2/map of the controlled site answers 200 with its links, from its sitemap and pages; the positive control is the same site's links in the isolation phase",
    run() {
      const e = FX(), m = one(e.map, "map_during_search_outage"), iso = one(e.isolation, "map");
      const ok = m?.status === 200 && m.links >= 10 && /exited/.test(m.searxng ?? "") && iso?.status === 200 && iso.links >= 10;
      return { ok, actual: `outage map ${m?.status} links=${m?.links} (searxng ${m?.searxng}); control ${iso?.status} links=${iso?.links}` };
    } },

  // ================================================================ extraction (AC07)
  E01: { name: "json-format-fixture-model", inputs: [`${RAW}e2e-fixture.txt`, "deploy/policies/budget.json"],
    expected: "on the fixture model: the json scrape format returns the page's values (product, price, stock) with markdown when asked; a sparse page's absent values are null and the markdown is left out when not asked; an invalid first answer is repaired with exactly two calls; an answer invalid after its one repair is 502 EXTRACTION_INVALID_OUTPUT; a schema $ref is refused 400 before any call; the json format on a batch is refused; a token without the extract scope gets 403 for it with no model request, while the same token scrapes (the control); every model call of the phase was reserved before dispatch and settled at the rate card's price from the provider's own usage counts",
    run() {
      const e = FX(), c = (k) => one(e.extract, k);
      const rows = (e.ledger ?? []).find((l) => l.point === "extraction")?.rows ?? [];
      const answered = rows.filter((r) => r.state === "SETTLED" && r.usage && r.category === "fixture");
      const priced = answered.every((r) => { const card = cardFor(r.subject); return card && Number(r.actual) === modelCost(card, r.usage) && Number(r.reserved) >= Number(r.actual) && r.rate_card === card.id; });
      const cond = { json: c("json_format")?.status === 200 && same(c("json_format").json, { product: "Fixture Widget", price: 42.5, in_stock: true, feature: null }) && c("json_format").markdown === true,
        nulls: c("json_nulls_kept")?.status === 200 && same(c("json_nulls_kept").json, { product: "Sparse Thing", price: null, in_stock: null, feature: null }) && c("json_nulls_kept").markdown_returned === false,
        repair: c("json_one_repair")?.status === 200 && c("json_one_repair").usage?.calls === 2 && c("json_one_repair").json?.product === "Fixture Widget",
        invalid_after_repair: c("json_invalid_after_repair")?.status === 502 && c("json_invalid_after_repair").code === "EXTRACTION_INVALID_OUTPUT",
        schema_ref: c("json_schema_ref_refused")?.status === 400 && c("json_schema_ref_refused").code === "SCHEMA_UNSUPPORTED",
        batch_refused: c("json_refused_on_batch")?.status === 400 && c("json_refused_on_batch").code === "UNSUPPORTED_OPTION",
        scope: c("json_scope_refused")?.status === 403 && c("json_scope_refused").code === "INSUFFICIENT_SCOPE" && c("json_scope_refused").model_calls_before === c("json_scope_refused").model_calls_after && c("json_scope_control")?.status === 200,
        accounting: answered.length >= 8 && priced };
      return { ok: bad(cond).length === 0, actual: `failed=${bad(cond).join(",") || "none"}; settled model calls=${answered.length}, priced by the rate card=${priced}; repair usage=${JSON.stringify(c("json_one_repair")?.usage)}` };
    } },
  E02: { name: "explicit-url-extract-jobs", inputs: [`${RAW}e2e-fixture.txt`],
    expected: "/v2/extract over explicit URLs is acknowledged with a job id, resubmitted under its idempotency key returns the same id, and polled to completed with data and each value's sources; a URL whose target answers 404 makes the job PARTIAL naming TARGET_HTTP_404; a long page is extracted in two or more units whose data merges; another principal gets 404 for the job; wildcards and web search are refused 400, a token without the extract scope 403; the same flow completes through firecrawl_extract and firecrawl_extract_status",
    run() {
      const e = FX(), c = (k) => one(e.extract_job, k);
      const units = c("long_page_chunked")?.units ?? [];
      const cond = { submitted: c("submitted")?.status === 200 && /^[0-9a-f-]{36}$/.test(c("submitted").id ?? "") && same(c("submitted").urlTrace, []),
        idempotent: c("idempotent_resubmit")?.same === true,
        completed: c("completed")?.status_field === "completed" && c("completed").data?.product === "Fixture Widget" && Object.keys(c("completed").sources ?? {}).length >= 1,
        partial: c("partial")?.status_field === "completed" && c("partial").state === "PARTIAL" && same(c("partial").pageFailures?.map((f) => f.code), ["TARGET_HTTP_404"]) && c("partial").data?.product === "Fixture Widget",
        chunked: c("long_page_chunked")?.status_field === "completed" && units.length >= 2 && units.every((u) => u.ok) && c("long_page_chunked").data?.product === "Long Widget" && c("long_page_chunked").data?.price === 99.95,
        owner: c("other_principal")?.status === 404, wildcard: c("wildcard_refused")?.status === 400 && c("wildcard_refused").code === "UNSUPPORTED_OPTION",
        web_search: c("web_search_refused")?.status === 400 && c("web_search_refused").code === "UNSUPPORTED_OPTION", scope: c("scope_refused")?.status === 403 && c("scope_refused").code === "INSUFFICIENT_SCOPE",
        mcp: c("mcp_submitted")?.isError === false && /firecrawl_extract_status/.test(c("mcp_submitted").next ?? "") && c("mcp_completed")?.status_field === "completed" && c("mcp_completed").data?.product === "Fixture Widget" };
      return { ok: bad(cond).length === 0, actual: `failed=${bad(cond).join(",") || "none"}; long page units=${units.length}; partial failures=${JSON.stringify(c("partial")?.pageFailures)}` };
    } },
  E03: { name: "refusals-before-spend", inputs: [`${RAW}e2e-fixture.txt`],
    expected: "on the retrieval service's extraction listener: a model not in the allowlist is 400 MODEL_NOT_ALLOWED, a model whose rate card has ended is 503 RATE_CARD_MISSING, a schema with a $ref is 400 SCHEMA_UNSUPPORTED, and the fixture model's request counter is the same before and after all three",
    run() {
      const r = FX().refusals?.[0], c = (k) => (r?.cases ?? []).find((x) => x.case === k);
      const cond = { unknown: c("unknown_model")?.status === 400 && c("unknown_model").class === "MODEL_NOT_ALLOWED", stale: c("stale_rate_card")?.status === 503 && c("stale_rate_card").class === "RATE_CARD_MISSING",
        schema: c("schema_ref")?.status === 400 && c("schema_ref").class === "SCHEMA_UNSUPPORTED", no_call: Number.isInteger(r?.model_calls_before) && r.model_calls_before === r.model_calls_after };
      return { ok: bad(cond).length === 0, actual: `failed=${bad(cond).join(",") || "none"}; model calls ${r?.model_calls_before}->${r?.model_calls_after}` };
    } },
  E04: { name: "provider-rejection-and-outage", inputs: [`${RAW}e2e-fixture.txt`],
    expected: "a model request with no answer within its deadline is 502 PROVIDER_UNCERTAIN and its reservation stays UNCERTAIN and whole; a refused credential is 502 PROVIDER_AUTH_FAILED and a provider error 502 PROVIDER_ERROR, both released; after those three failures the breaker refuses the next request as 503 PROVIDER_UNAVAILABLE without a provider request; the parser's refused credential is PROVIDER_AUTH_FAILED and a job the parser ends FAILED is PARSE_FAILED with its credits kept reserved",
    run() {
      const e = FX(), f = e.provider_failures?.[0]?.cases ?? [], c = (k) => f.find((x) => x.case === k);
      const rows = (e.ledger ?? []).find((l) => l.point === "extraction")?.rows ?? [];
      const drows = (e.ledger ?? []).find((l) => l.point === "documents")?.rows ?? [];
      const d = (k) => one(e.documents, k);
      const cond = { uncertain: c("no_answer")?.status === 502 && c("no_answer").code === "PROVIDER_UNCERTAIN" && rows.some((r) => r.state === "UNCERTAIN" && /no answer within/.test(r.detail ?? "")),
        auth: c("auth_refused")?.status === 502 && c("auth_refused").code === "PROVIDER_AUTH_FAILED" && rows.some((r) => r.state === "RELEASED" && /401/.test(r.detail ?? "")),
        error: c("provider_error")?.status === 502 && c("provider_error").code === "PROVIDER_ERROR" && rows.some((r) => r.state === "RELEASED" && /500/.test(r.detail ?? "")),
        breaker: c("breaker_open")?.status === 503 && c("breaker_open").code === "PROVIDER_UNAVAILABLE" && c("breaker_open").model_calls_before === c("breaker_open").model_calls_after,
        parser_auth: /PROVIDER_AUTH_FAILED/.test(d("parser_refused_credential")?.error ?? ""), parser_failed: /PARSE_FAILED/.test(d("parser_job_failed")?.error ?? "") && drows.some((r) => r.state === "UNCERTAIN" && /FAILED/.test(r.detail ?? "")) };
      return { ok: bad(cond).length === 0, actual: `failed=${bad(cond).join(",") || "none"}; ${f.map((x) => `${x.case}=${x.status} ${x.code}`).join("; ")}` };
    } },
  E05: { name: "model-live", live: true, inputs: [`${RAW}e2e-live.txt`],
    expected: "with the owner's credential and approved budget: the real model returns schema-valid data for the fixture product page, ignores the injected instructions of another page, and completes an explicit-URL job; every call is settled at the rate card from the provider's reported usage",
    run() {
      const e = LIVE(), b = one(e.live_model, "blocked");
      if (b) return { blocked: true, actual: `blocked: model credential ${b.credential}, paid dispatch ${b.paidDispatch}, llm caps ${JSON.stringify(b.llmCaps?.caps ?? null)}` };
      const c = (k) => one(e.live_model, k), rows = ((e.ledger ?? []).find((l) => l.point === "live")?.rows ?? []).filter((r) => r.category === "llm" && r.state === "SETTLED");
      const priced = rows.length >= 3 && rows.every((r) => { const card = cardFor(r.subject); return card && r.usage && Number(r.actual) === modelCost(card, r.usage); });
      const inj = c("injection_ignored")?.json;
      const cond = { json: c("json_format")?.status === 200 && c("json_format").json?.product === "Fixture Widget" && c("json_format").json?.price === 42.5,
        injection: c("injection_ignored")?.status === 200 && inj?.price === 10 && !("leaked" in (inj ?? {})), job: c("extract_job")?.status_field === "completed", priced };
      return { ok: bad(cond).length === 0, actual: `failed=${bad(cond).join(",") || "none"}; settled llm calls=${rows.length}` };
    } },

  // ================================================================ budgets and reservations (AC25)
  B01: { name: "paid-dispatch-off-caps-zero", inputs: [`${RAW}e2e-fixture.txt`, "deploy/policies/budget.json", `${EV}rendered-compose.json`],
    expected: "every paid cap in the budget policy is zero and the rendered Compose file sets PI_PAID_DISPATCH_ENABLED=false; with the production selection (the real model and parser), the json format is 402 PAID_DISPATCH_DISABLED, an extraction job fails with it, a scan-only document is PARSER_REQUIRED, and no fixture provider counter moves (no provider was asked); the platform status reports paid dispatch off and each credential only as present or absent",
    run() {
      const e = FX(), b = BUDGET(), c = (k) => one(e.production, k);
      const R = json(`${EV}rendered-compose.json`).services["retrieval-service"];
      const zero = Object.values(b.categories).filter((x) => x.paid).every((x) => Object.values(x.caps).every((v) => v === 0)) && b.paidTotal.caps.day === 0;
      const np = c("no_provider_request"), prov = c("platform_status")?.providers;
      const cond = { caps_zero: zero, env: R.environment?.PI_PAID_DISPATCH_ENABLED === "false",
        json: c("json_paid_dispatch_disabled")?.status === 402 && c("json_paid_dispatch_disabled").code === "PAID_DISPATCH_DISABLED",
        job: c("extract_job_paid_dispatch_disabled")?.status_field === "failed" && c("extract_job_paid_dispatch_disabled").errorCode === "PAID_DISPATCH_DISABLED",
        parser_required: /PARSER_REQUIRED/.test(c("scan_parser_required")?.error ?? ""),
        no_provider: !!np && same(np.stats_before?.model, np.stats_after?.model) && same(np.stats_before?.parser, np.stats_after?.parser),
        status: prov?.paidDispatch === false && ["openai", "llamaparse"].every((p) => ["present", "absent"].includes(prov?.providers?.[p]?.credential)) && !/sk-|llx-|Bearer/.test(JSON.stringify(prov)) };
      return { ok: bad(cond).length === 0, actual: `failed=${bad(cond).join(",") || "none"}; credentials=${JSON.stringify(Object.fromEntries(Object.entries(prov?.providers ?? {}).map(([k, v]) => [k, v.credential])))}` };
    } },
  B02: { name: "concurrent-reservation-race", inputs: [`${RAW}e2e-fixture.txt`, "deploy/policies/budget.json"],
    expected: "eight extractions sent at once on the fixture_race model, each reserving the same conservative amount while the first holds the one model slot: exactly floor((cap - used before) / amount) are granted and the rest are BUDGET_EXHAUSTED; the granted reservations overlap in time, their sum never passes what was left, and the category's settled total afterwards is the one before plus the granted calls' actual costs",
    run() {
      const r = FX().race?.[0], cap = BUDGET().categories.fixture_race.caps.day;
      const res0 = r?.reservations ?? [], day = res0.length ? new Date(res0[0].created_at).toISOString().slice(0, 10) : null;
      const dayUse = (rows) => (rows ?? []).filter((u) => u.period === "day" && u.period_start === day).reduce((a, u) => a + Number(u.reserved) + Number(u.settled), 0);
      const before = dayUse(r?.usage_before);
      const res = r?.reservations ?? [], amount = res.length ? Number(res[0].reserved) : NaN;
      const expected = Math.floor((cap - before) / amount);
      const ok = (r?.results ?? []).filter((x) => x.ok).length, exhausted = (r?.results ?? []).filter((x) => x.class === "BUDGET_EXHAUSTED").length;
      const overlap = res.length >= 2 && res.every((x) => Date.parse(x.created_at) < Math.min(...res.map((y) => Date.parse(y.settled_at))));
      const after = dayUse(r?.usage_after);
      const cond = { eight: (r?.results ?? []).length === 8, amounts_equal: res.every((x) => Number(x.reserved) === amount), granted: ok === expected && res.length === expected && expected >= 1 && exhausted === 8 - expected,
        within_cap: before + expected * amount <= cap, overlap, settled: after === before + res.reduce((a, x) => a + Number(x.actual), 0) };
      return { ok: bad(cond).length === 0, actual: `failed=${bad(cond).join(",") || "none"}; cap=${cap} used before=${before} amount=${amount} expected=${expected} granted=${ok} exhausted=${exhausted}; settled after=${after}` };
    } },
  B03: { name: "rate-cards-versioned", inputs: ["deploy/policies/budget.json", `${RAW}e2e-fixture.txt`],
    expected: "every model and parser the budget policy lists has a rate card with an effective date and a source, no two cards of one subject overlap, the default model's card carries the published GPT-6 Luna standard prices (0.10/0.01/0.125/0.50 USD per million input/cached/cache-write/output tokens) and LlamaParse's cost-effective card three credits a page, and a card that has ended is refused (E03's stale card, and RATE_CARD_MISSING in the record)",
    run() {
      const b = BUDGET();
      const subjects = [...Object.keys(b.models), ...Object.keys(b.parsers)];
      const dated = b.rateCards.every((r) => /^\d{4}-\d{2}-\d{2}$/.test(r.effectiveFrom) && typeof r.source === "string" && r.source.length > 10);
      const overlap = b.rateCards.some((a) => b.rateCards.some((c) => a !== c && a.subject === c.subject && a.effectiveFrom < (c.effectiveTo ?? "9999") && c.effectiveFrom < (a.effectiveTo ?? "9999")));
      const mini = cardFor(b.extraction.defaultModel), lp = cardFor(b.parsing.defaultParser);
      const stale = (FX().refusals?.[0]?.cases ?? []).find((x) => x.case === "stale_rate_card");
      const cond = { every_subject: subjects.every((s) => b.rateCards.some((r) => r.subject === s)), dated, no_overlap: !overlap,
        luna: b.extraction.defaultModel === "gpt-6-luna" && mini?.inputPerMTok === 100000 && mini.cachedInputPerMTok === 10000 && mini.cacheWritePerMTok === 125000 && mini.outputPerMTok === 500000, llamaparse: lp?.creditsPerPage === 3, stale_refused: stale?.class === "RATE_CARD_MISSING" };
      return { ok: bad(cond).length === 0, actual: `failed=${bad(cond).join(",") || "none"}; rate cards=${b.rateCards.length} for ${subjects.length} subjects` };
    } },

  // ================================================================ documents (AC08)
  D01: { name: "document-classes", inputs: [`${RAW}e2e-fixture.txt`],
    expected: "a text PDF parses natively with its sentinel; a DOCX converts natively with its sentinel; a PDF served as HTML is parsed as a PDF and an HTML page served as a PDF as HTML (MIME from bytes); a password-protected PDF is DOCUMENT_ENCRYPTED, a malformed one DOCUMENT_MALFORMED, a 26 MiB one SIZE_LIMIT and a 101-page one DOCUMENT_TOO_MANY_PAGES, each a typed failure and never empty success",
    run() {
      const e = FX(), d = (k) => one(e.documents, k);
      const cls = (k, c) => d(k)?.status >= 400 && new RegExp(`Retrieval failed: ${c}\\.`).test(d(k)?.error ?? "");
      const cond = { text: d("text_pdf")?.status === 200 && /FCPI-M5-TEXT-PDF sentinel/.test(d("text_pdf").head ?? "") && d("text_pdf").numPages === 1,
        docx: d("docx")?.status === 200 && /FCPI-M5-DOCX sentinel paragraph/.test(d("docx").head ?? ""),
        pdf_as_html: d("pdf_served_as_html")?.status === 200 && /FCPI-M5-TEXT-PDF sentinel/.test(d("pdf_served_as_html").head ?? "") && d("pdf_served_as_html").contentType === "application/pdf",
        html_as_pdf: d("html_served_as_pdf")?.status === 200 && /FCPI-M5-HTML-AS-PDF sentinel/.test(d("html_served_as_pdf").head ?? "") && d("html_served_as_pdf").contentType === "text/html",
        encrypted: cls("encrypted_pdf", "DOCUMENT_ENCRYPTED"), malformed: cls("malformed_pdf", "DOCUMENT_MALFORMED"), oversized: cls("oversized_pdf", "SIZE_LIMIT"), pages: cls("pdf_101_pages", "DOCUMENT_TOO_MANY_PAGES") };
      return { ok: bad(cond).length === 0, actual: `failed=${bad(cond).join(",") || "none"}; ${(e.documents ?? []).map((x) => `${x.case}=${x.status}`).join(", ")}` };
    } },
  D02: { name: "parser-fallback-and-credits-fixture", inputs: [`${RAW}e2e-fixture.txt`, "deploy/policies/budget.json"],
    expected: "with the fixture parser's cache rows cleared first (the count recorded), so this pass uploads afresh: a scan-only PDF (no text layer) and a complex-layout PDF go to the parser and come back with its text; the second scan of the same bytes is answered from the cache with no new upload; each parse reserved pages × 3 credits before the upload and settled at the pages returned; each finished job's upload was deleted; with the production parser (no credential) the scan is PARSER_REQUIRED and the complex layout keeps its native text",
    run() {
      const e = FX(), d = (k) => one(e.documents, k), p = (k) => one(e.production, k);
      const rows = ((e.ledger ?? []).find((l) => l.point === "documents")?.rows ?? []).filter((r) => r.category === "fixture_parser");
      const settled = rows.filter((r) => r.state === "SETTLED");
      const st = (k) => (e.provider_stats ?? []).find((x) => x.point === k)?.parser;
      const up = st("after_documents"), before = st("after_extraction");
      const cond = { cache_cleared: Number.isInteger(d("fixture_parse_cache_cleared")?.rows), scan: d("scan_pdf")?.status === 200 && /FCPI SCAN 42/.test(d("scan_pdf").head ?? ""), complex: d("table_pdf_complex")?.status === 200 && /Fixture parse of page 1/.test(d("table_pdf_complex").head ?? ""),
        cached: d("scan_pdf_cached")?.status === 200 && /FCPI SCAN 42/.test(d("scan_pdf_cached").head ?? "") && up && before && up.uploads - before.uploads === 4,
        credits: settled.length === 2 && settled.every((r) => Number(r.reserved) === 3 && Number(r.actual) === 3 && r.usage?.pages === 1), deleted: up && up.deletes - (before?.deletes ?? 0) >= 2,
        production: /PARSER_REQUIRED/.test(p("scan_parser_required")?.error ?? "") && p("complex_keeps_native_text")?.status === 200 && /Left column: the first of two columns/.test(p("complex_keeps_native_text").head ?? "") };
      return { ok: bad(cond).length === 0, actual: `failed=${bad(cond).join(",") || "none"}; parser uploads=${up?.uploads} deletes=${up?.deletes}; settled parses=${settled.length}` };
    } },
  D03: { name: "parser-live", live: true, inputs: [`${RAW}e2e-live.txt`],
    expected: "with the owner's LlamaParse credential and approved credits: a scan-only PDF and a complex-layout PDF parse live with their text (the scan's sentinel read from its image), each settled at the pages returned × 3 credits",
    run() {
      const e = LIVE(), b = one(e.live_parser, "blocked");
      if (b) return { blocked: true, actual: `blocked: parser credential ${b.credential}, paid dispatch ${b.paidDispatch}, parser caps ${JSON.stringify(b.parserCaps?.caps ?? null)}` };
      const c = (k) => one(e.live_parser, k), rows = ((e.ledger ?? []).find((l) => l.point === "live")?.rows ?? []).filter((r) => r.category === "parser" && r.state === "SETTLED");
      const cond = { scan: c("scan_only")?.status === 200 && /FCPI\s*SCAN\s*42/i.test(c("scan_only").head ?? ""), complex: c("complex")?.status === 200 && /Bolt|Washer/.test(c("complex").head ?? ""),
        credits: rows.length >= 2 && rows.every((r) => Number(r.actual) === 3 * (r.usage?.pages ?? 0)) };
      return { ok: bad(cond).length === 0, actual: `failed=${bad(cond).join(",") || "none"}; settled parses=${rows.length}` };
    } },

  // ================================================================ isolation, capabilities, Cloud (AC23, AC24)
  I01: { name: "acquisition-unaffected-by-provider-failure", inputs: [`${RAW}e2e-fixture.txt`],
    expected: "with SearXNG stopped, the paid model refused and the parser unconfigured: search answers its typed failure while a static scrape, a native text PDF, a four-page crawl and a map all succeed; and with the model provider's breaker open a scrape still succeeds",
    run() {
      const e = FX(), c = (k) => one(e.isolation, k);
      const cond = { search_down: /^SEARCH_/.test(c("search_down")?.code ?? ""), scrape: c("scrape")?.status === 200 && c("scrape").markdown === true, pdf: c("native_pdf")?.status === 200 && c("native_pdf").sentinel === true,
        crawl: c("crawl")?.status_field === "completed" && c("crawl").documents >= 3, map: c("map")?.status === 200 && c("map").links >= 10,
        breaker: c("scrape_while_model_breaker_open")?.status === 200 && c("scrape_while_model_breaker_open").markdown === true && one(e.provider_failures?.[0]?.cases, "breaker_open")?.code === "PROVIDER_UNAVAILABLE" };
      return { ok: bad(cond).length === 0, actual: `failed=${bad(cond).join(",") || "none"}` };
    } },
  C01: { name: "capabilities-and-mcp-catalog", inputs: ["deploy/policies/capabilities.json", `${RAW}e2e-fixture.txt`],
    expected: "the manifest serves POST /v2/search (scope search), POST /v2/extract (scope extract) and its status route and the json format, lists none of them as not enabled and omits no MCP tool; the live MCP catalog holds 13 tools including firecrawl_search, firecrawl_extract and firecrawl_extract_status, the search tool requires a query, the extract tool bounds its URLs at 10, and the json format appears on the scrape tool and not on the batch tool",
    run() {
      const m = json("deploy/policies/capabilities.json"), cat = FX().mcp_catalog?.[0];
      const r = (id) => m.routes.find((x) => x.id === id);
      const cond = { routes: r("search")?.scope === "search" && r("extract.submit")?.scope === "extract" && r("extract.status")?.path === "/v2/extract/{id}",
        not_enabled: !m.not_enabled.some((x) => /^\/v2\/(search|extract)/.test(x.path)), json: m.formats.allowed.includes("json") && !!m.formats.objects?.json, omitted: same(m.mcp.omitted, []),
        catalog: cat?.status === 200 && cat.tools.length === 13 && ["firecrawl_search", "firecrawl_extract", "firecrawl_extract_status"].every((t) => cat.tools.includes(t)) && same(cat.tools, [...cat.tools].sort()),
        schemas: same(cat?.search_schema_required, ["query"]) && cat?.extract_urls_max === 10 && cat?.scrape_json_format === true && cat?.batch_json_format === false };
      return { ok: bad(cond).length === 0, actual: `failed=${bad(cond).join(",") || "none"}; tools=${cat?.tools?.length} sha=${cat?.sha256?.slice(0, 12)}` };
    } },
  X01: { name: "zero-firecrawl-cloud-attempts", inputs: [`${RAW}guard-window-open.txt`, `${RAW}egress-probe.txt`, `${RAW}core-logs-final.txt`, `${RAW}stack.txt`, `${RAW}e2e-fixture.txt`],
    expected: "across one window, from a guard-counter snapshot before the first phase to the egress probe after the last, with the guard's table not reloaded and every phase inside it, the guard accepted no web connection while live egress was held (the fixture phase), and after the live phase only as many as the live engines' and providers' logged connections; the core's saved log classifies every Cloud line; the retrieval log names no Cloud host; every driver's sockets went only to the forward",
    run() {
      const utcOf = (f) => Date.parse(((sections(f).meta ?? []).join(" ").match(/utc=(\S+?Z)/) ?? [])[1]);
      const handle = (f) => ((sections(f).meta ?? []).join(" ").match(/guard_table_handle=(\d+)/) ?? [])[1];
      const web = (f, sec) => +((sections(f)[sec] ?? []).find((l) => l.startsWith("egress_web_accepted")) ?? "=NaN").split("=")[1];
      const open = utcOf(`${RAW}guard-window-open.txt`), close = utcOf(`${RAW}egress-probe.txt`);
      const inWindow = (t) => Number.isFinite(t) && t > open && t < close;
      const live = has(`${RAW}e2e-live.txt`) ? LIVE() : null;
      const phases = [FX(), ...(live ? [live] : [])];
      const delta = web(`${RAW}egress-probe.txt`, "guard_after") - web(`${RAW}guard-window-open.txt`, "counters");
      const liveConns = live ? (live.live_search_log?.[0]?.egress ?? []).filter((x) => x.method === "CONNECT").length + ((live.ledger ?? []).find((l) => l.point === "live")?.rows ?? []).filter((r) => r.state !== "RELEASED").length * 4 : 0;
      const recs = Object.entries(sections(`${RAW}core-logs-final.txt`)).filter(([k]) => /^(instance|stored)_/.test(k)).map(([, lines]) => {
        const c = lines.find((l) => l.startsWith("classified ")); const ctl = +((lines.find((l) => l.startsWith("control=")) ?? "").match(/count=(\d+)/) ?? [])[1];
        return { c: c ? kv(c.split(" ").slice(1)) : null, ctl };
      });
      const scanR = kv(((S(`${RAW}stack.txt`).retrieval_log_scan ?? [])[0] ?? "").split(" "));
      const conns = phases.map((p) => p.connections?.[0]);
      const cond = { same_guard: !!handle(`${RAW}guard-window-open.txt`) && handle(`${RAW}guard-window-open.txt`) === handle(`${RAW}egress-probe.txt`), phases_inside: phases.every((p) => inWindow(Date.parse(p.meta?.[0]?.pi_utc ?? ""))),
        web: live ? delta >= 1 && delta <= liveConns + 20 : delta === 0,
        core_logs: recs.length >= 1 && recs.every((r) => r.c && r.c.cloud_unexplained === "0" && r.c.dns_unexplained === "0" && r.ctl >= 1),
        retrieval_log: +scanR.lines > 100 && scanR.cloud_host === "0", drivers: conns.every((c) => c && same(c.hosts, ["127.0.0.1:3380"]) && c.lookups.length === 0) };
      return { ok: bad(cond).length === 0, actual: `failed=${bad(cond).join(",") || "none"}; guard handle ${handle(`${RAW}guard-window-open.txt`)}→${handle(`${RAW}egress-probe.txt`)}, web accepted delta=${delta}${live ? ` (live connections logged ≈${liveConns})` : ""}; core logs=${recs.length}; retrieval log lines=${scanR.lines} cloud=${scanR.cloud_host}` };
    } },
  X02: { name: "network-and-container-posture", inputs: [`${RAW}stack.txt`, `${EV}rendered-compose.json`],
    expected: "fcpi_search and fcpi_model are internal with isolated gateway mode, no bridge address and exactly their two members (the retrieval service and SearXNG; the gateway and the retrieval service); the retrieval service has 10.231.10.10 and 10.231.9.20 there, the gateway 10.231.9.10; the only host publication is still 127.0.0.1:3380; SearXNG and fixture-m5 run with read-only roots, dropped capabilities, no Docker socket and memory caps of 320 and 128 MiB without swap; every container runs aarch64 and every swap limit is 0",
    run() {
      const st = S(`${RAW}stack.txt`), R = json(`${EV}rendered-compose.json`).services;
      const net = (n) => (st.networks ?? []).find((l) => l.startsWith(`${n} `)) ?? "";
      const bridge = (b) => (st.networks ?? []).find((l) => l.startsWith(`bridge ${b} `));
      const pub = (st.published ?? []).filter((l) => /->/.test(l));
      const cg = (s) => kv(((st.cgroups ?? []).find((l) => l.startsWith(`${s} `)) ?? "").split(" ").slice(1));
      const c = (s) => kv(((st.containers ?? []).find((l) => l.startsWith(`${s} name=`)) ?? "").split(" "));
      const arch = (st.containers ?? []).filter((l) => / uname_m=/.test(l));
      const ri = kv(((st.retrieval_image ?? []).find((l) => l.startsWith("mounts=")) ?? "").split(" "));
      const cond = { search: /internal=true/.test(net("fcpi_search")) && /gateway_mode_ipv4=isolated/.test(net("fcpi_search")) && /members=fcpi-retrieval-service-1,fcpi-searxng-1$/.test(net("fcpi_search")) && bridge("fcpi-search") === "bridge fcpi-search addresses=",
        model: /internal=true/.test(net("fcpi_model")) && /gateway_mode_ipv4=isolated/.test(net("fcpi_model")) && /members=fcpi-access-gateway-1,fcpi-retrieval-service-1$/.test(net("fcpi_model")) && bridge("fcpi-model") === "bridge fcpi-model addresses=",
        addresses: R["retrieval-service"].networks.search.ipv4_address === "10.231.10.10" && R["retrieval-service"].networks.model.ipv4_address === "10.231.9.20" && R["access-gateway"].networks.model.ipv4_address === "10.231.9.10" && same(Object.keys(R.searxng.networks), ["search"]),
        retrieval_mounts: /\/run\/providers:ro/.test(ri.mounts ?? "") && /\/srv\/selection:ro/.test(ri.mounts ?? "") && /\/srv\/policy\/budget\.json:ro/.test(ri.mounts ?? ""),
        publication: pub.length === 1 && /^access-gateway 3300\/tcp -> 127\.0\.0\.1:3380$/.test(pub[0]),
        posture: ["searxng", "fixture-m5"].every((s) => c(s).readonly_rootfs === "true" && c(s).cap_drop === "ALL" && c(s).docker_sock_mount === "0" && c(s).privileged === "false"),
        memory: cg("searxng")["memory.max"] === String(320 * MIB) && cg("fixture-m5")["memory.max"] === String(128 * MIB),
        swap: (st.cgroups ?? []).length === 13 && (st.cgroups ?? []).every((l) => / memory\.swap\.max=0 /.test(l)), arch: arch.length === 13 && arch.every((l) => /uname_m=aarch64$/.test(l)) };
      return { ok: bad(cond).length === 0, actual: `failed=${bad(cond).join(",") || "none"}; ${net("fcpi_search")}; ${net("fcpi_model")}; publications=${pub.join(";")}` };
    } },
  X03: { name: "retrieval-log-hygiene", inputs: [`${RAW}stack.txt`],
    expected: "the retrieval service's whole log (at least 100 lines, with search, model-call, parse and extraction events as the positive control) holds nothing shaped like a provider key, a client token or a bearer credential, and the budget policy hash it logged at start is the deployed file's",
    run() {
      const st = S(`${RAW}stack.txt`), s = kv(((st.retrieval_log_scan ?? [])[0] ?? "").split(" ")), h = kv(((st.retrieval_log_scan ?? [])[1] ?? "").split(" "));
      const cond = { read: +s.lines >= 100 && +s.search >= 1 && +s.model_call >= 1 && +s.parse >= 1 && +s.extraction >= 1, clean: s.provider_key_like === "0" && s.client_token_like === "0" && s.bearer === "0",
        budget_hash: /^[0-9a-f]{64}$/.test(h.budget_policy_sha256_logged ?? "") && h.budget_policy_sha256_logged === h.budget_policy_sha256_deployed && h.budget_policy_sha256_deployed === sha256File("deploy/policies/budget.json") };
      return { ok: bad(cond).length === 0, actual: `failed=${bad(cond).join(",") || "none"}; ${(st.retrieval_log_scan ?? [])[0]}` };
    } },
  M02: { name: "memory-within-caps", inputs: [`${RAW}stack.txt`, `${RAW}e2e-fixture.txt`],
    expected: "every sample of the retrieval service, SearXNG, the gateway, the MCP service and the core peaks below 90% of its cap, no sampled cgroup records an OOM kill, the host's OOM-kill count does not rise across the samples, MemAvailable stays above 1 GiB (spec §22's reserve), and the stack's final cgroups agree",
    run() {
      const xs = samples(), st = S(`${RAW}stack.txt`);
      const svcs = ["retrieval", "searxng", "gateway", "mcp", "core"];
      const peaks = Object.fromEntries(svcs.map((s) => [s, Math.max(...xs.map((x) => (x[s] ? x[s].peak / Number(x[s].max) : 0)))]));
      const ooms = xs.flatMap((x) => svcs.map((s) => x[s]?.oom_kill ?? 0)).some((n) => n > 0);
      const vm = xs.map((x) => x.vmstat_oom_kill), avail = Math.min(...xs.map((x) => x.mem_available_kib));
      const cg = (st.cgroups ?? []).map((l) => kv(l.split(" ").slice(1)));
      const cond = { samples: xs.length >= 4, peaks: svcs.every((s) => peaks[s] > 0 && peaks[s] < 0.9), no_oom: !ooms && cg.every((c) => c.oom_kill === "0"), host_oom: vm.every((v) => v === vm[0]), headroom: avail > 1024 * 1024 };
      return { ok: bad(cond).length === 0, actual: `failed=${bad(cond).join(",") || "none"}; samples=${xs.length}; peak fractions=${JSON.stringify(Object.fromEntries(Object.entries(peaks).map(([k, v]) => [k, +v.toFixed(3)])))}; min MemAvailable=${Math.round(avail / 1024)} MiB` };
    } },
  X04: { name: "unrelated-state-unchanged", inputs: [`${EV}snapshot-before.txt`, `${EV}snapshot-after.txt`, `${RAW}nft-ruleset.txt`, "evidence/M4/raw/nft-ruleset.txt"],
    expected: "every line differing between M5's BEFORE and AFTER snapshots is attributed to the project (fcpi containers, their scopes, root filesystems and namespaces, kernel modules for the runtime, the ruleset), the collector's own SSH session, or the owner's own work that raw/owner-session.txt records; no unrelated line is removed or changed; the boot ID is unchanged, or changed only across the reboot raw/reboot.txt ties to both snapshots, whose own changes count only where a module, a mount or a service's UDP port is the same thing made again at boot or a unit neither snapshot lists as enabled is not running; rule by rule against M4's recorded ruleset, every change is Docker's for the new fcpi-search and fcpi-model bridges, and the installed guard is the repository's",
    run() {
      const [B, A] = [`${EV}snapshot-before.txt`, `${EV}snapshot-after.txt`];
      const boot = (f) => (read(f).match(/^boot_id_sha256=([0-9a-f]{64})$/m) ?? [])[1];
      const psIds = (f) => (read(f).match(/^### docker_ps\n([\s\S]*?)\n### /m)?.[1] ?? "").split("\n").map((l) => l.split("\t")[0]).filter((x) => /^[0-9a-f]{64}$/.test(x));
      const ids = new Set([...psIds(B), ...psIds(A)]);
      const tie = rebootTie(boot(B), boot(A));
      const norm = (sec, l) => (sec === "ss_listen" ? l.replace(/pid=\d+,fd=\d+/g, "pid,fd") : l);
      const KP = (f) => keyedSnapshot(f).map(([s, l]) => [s, norm(s, l)]);
      const kb = KP(B), ka = KP(A);
      const b = kb.map(([s, l]) => `${s}\t${l}`), a = ka.map(([s, l]) => `${s}\t${l}`);

      const removed = b.filter((l) => !a.includes(l)), added = a.filter((l) => !b.includes(l));
      const owner = ownerContext();
      const unexplained = [], why = {}, rows = { project: [], owner: [], reboot: [], unrelated: [] };
      for (const [kind, list] of [["removed", removed], ["added", added]]) for (const l of list) {
        const [sec, line] = [l.slice(0, l.indexOf("\t")), l.slice(l.indexOf("\t") + 1)];
        const w = attribute(sec, line, ids, owner) ?? (tie ? rebootAttribute(sec, line, kind, kb, ka) : null);
        const acceptable = w && (kind === "added" || /own SSH session|nftables|fcpi container|container network namespace|scope of an fcpi container|Docker's chains|Pi-hole's own|the owner's editor server|^the reboot: /.test(w));
        if (!acceptable) unexplained.push(`${kind} ${sec}: ${line.slice(0, 90)}`); else why[w] = (why[w] ?? 0) + 1;
        rows[!acceptable ? "unrelated" : /^the reboot: /.test(w) ? "reboot" : /owner|Pi-hole/.test(w) ? "owner" : "project"].push(`${kind === "added" ? "+" : "-"} ${sec}\t${line}${w ? `\t# ${w}` : ""}`);
      }
      const hdr = kv(((read(`${RAW}nft-ruleset.txt`).match(/^# guard_file_sha256=.*$/m) ?? [""])[0]).slice(2).split(" "));
      const guardOk = hdr.guard_file_sha256 === sha256File("deploy/host/fcpi-guard.nft");
      const r4 = ruleSet("evidence/M4/raw/nft-ruleset.txt"), r5 = ruleSet(`${RAW}nft-ruleset.txt`);
      const ruleChanges = [...[...r5].filter((r) => !r4.has(r)).map((r) => `+ ${r}`), ...[...r4].filter((r) => !r5.has(r)).map((r) => `- ${r}`)];
      const unattributed = ruleChanges.filter((ch) => !/"fcpi-search"|"fcpi-model"|10\.231\.(9|10)\.0\/24/.test(ch)).map((ch) => ch.replace(/\t/g, " ").slice(0, 110));
      const afterHash = (read(A).match(/^nft_ruleset_sha256=([0-9a-f]{64})$/m) ?? [])[1];
      const rulesTied = /^[0-9a-f]{64}$/.test(hdr.ruleset_sha256 ?? "") && hdr.ruleset_sha256 === afterHash;
      writeFileSync(resolve(ROOT, `${EV}snapshot-diff.txt`), ["# M5 BEFORE/AFTER snapshot diff (section-keyed; written by scripts/m5/verify.mjs X04)",
        `# before: ${read(B).split("\n")[1]}  after: ${read(A).split("\n")[1]}`, `# boot_id: ${boot(B) && boot(B) === boot(A) ? "unchanged (no reboot)" : tie ? `changed across the reboot raw/reboot.txt ties to both snapshots (the earlier boot ended ${tie.ended}; raw/reboot-cause.txt)` : "CHANGED or MISSING"}`,
        `## changes to unrelated state (${rows.unrelated.length})`, ...rows.unrelated, `## the owner's own work on the Pi and Pi-hole's own socket rotation (${rows.owner.length}; raw/owner-session.txt)`, ...rows.owner,
        `## the reboot's own changes (${rows.reboot.length}; raw/reboot.txt, raw/reboot-cause.txt)`, ...rows.reboot,
        `## project changes and the collector's own SSH sessions (${rows.project.length})`, ...rows.project,
        `## ruleset changes since M4's recorded ruleset (${ruleChanges.length}; Docker's for fcpi-search and fcpi-model unless listed as unattributed)`, ...ruleChanges.map((r) => r.replace(/\t/g, " ")), ""].join("\n"));
      const ok = unexplained.length === 0 && !!boot(B) && (boot(B) === boot(A) || !!tie) && guardOk && rulesTied && r4.size > 50 && r5.size > 50 && unattributed.length === 0 && ruleChanges.length >= 1;
      return { ok, actual: `added=${added.length} removed=${removed.length}; attributed ${JSON.stringify(why)}; unexplained=${unexplained.length}${unexplained.length ? " [" + unexplained.slice(0, 8).join("; ") + "]" : ""}; boot_id_equal=${boot(B) === boot(A)}, reboot tied=${!!tie}; rules changed since M4=${ruleChanges.length}, unattributed=${unattributed.length}${unattributed.length ? " [" + unattributed.slice(0, 6).join("; ") + "]" : ""}; guard is the repository's=${guardOk}; ruleset tied to AFTER=${rulesTied}` };
    } },
  X05: { name: "secret-and-identifier-redaction-scan", inputs: [M0_CONTROL, M1_CONTROL, M3_CONTROL, "scripts/m1/pi-target.conf", "evidence/M0/audit.json"], live: true,
    expected: "the positive controls fire every rule; then no rule matches in any tracked or new repository file; no file holds any live secret (M4's, M5's gateway, SearXNG-proxy and SearXNG secrets, every provider key present and every client token file on the Pi), compared by SHA-256 computed on the Pi; no file added or changed since M5 began holds the Pi's LAN address, its /24 network or its SSH target",
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
        h "$(cat $S/gateway_postgres_password)"; h "$(cat $S/gateway_retrieval_token)"; h "$(cat $S/searxng_proxy_password)"; h "$(cat $S/searxng_secret_key)"; \
        for f in $S/providers/*; do [ -f "$f" ] && h "$(tr -d "\\n" < "$f")"; done; for f in $S/clients/*.token; do h "$(tr -d "\\n" < "$f")"; done'`).split("\n").filter((x) => /^[0-9a-f]{64}$/.test(x));
      const tokenFiles = +ssh("sudo -n sh -c 'ls /etc/firecrawl-pi/secrets/clients/*.token | wc -l'").trim();
      const providerFiles = +ssh("sudo -n sh -c 'ls -A /etc/firecrawl-pi/secrets/providers | wc -l'").trim();
      if (tokenFiles < 12 || hashes.length !== 12 + providerFiles + tokenFiles || new Set(hashes).size !== hashes.length || hashes.includes(sha256(""))) return { ok: false, actual: `expected twelve fixed secrets, ${providerFiles} provider keys and every client token as distinct non-empty hashes; got ${hashes.length} hashes for ${tokenFiles} token files` };
      const files = execFileSync("git", ["-C", ROOT, "ls-files", "--cached", "--others", "--exclude-standard"], { encoding: "utf8" }).split("\n").filter((f) => f && ![M0_CONTROL, M1_CONTROL, M3_CONTROL].includes(f) && has(f) && !/\.(pdf|png|gz)$/.test(f));
      const audit = json("evidence/M0/audit.json");
      const m0 = { egress: audit.network.egress_ip_sha256, serial: audit.identity.board_serial_sha256, machineId: audit.identity.machine_id_sha256, macs: new Set([...Object.values(audit.identity.mac_sha256), sha256("00:00:00:00:00:00")]) };
      const hits = scan(files, { m0, secrets: new Set(hashes) });
      const t = target(), lan = t.PI_LAN_ADDRESS, net = lan.replace(/\.\d+$/, ".0");
      const changed = [...new Set([...git("diff", "--name-only", `${M5_START}..HEAD`).split("\n"), ...git("ls-files", "--others", "--exclude-standard").split("\n")])].filter((f) => f && has(f) && !/\.(pdf|png|gz)$/.test(f));
      const idHits = changed.filter((f) => { const x = read(f); return x.includes(lan) || x.includes(`${net}/`) || x.includes(t.PI_SSH_TARGET); });
      return { ok: hits.length === 0 && idHits.length === 0, configHash: hashOf(files.filter((f) => f !== OUT)), actual: `controls fired all ${RULES.length + HASH_RULES.length} rules; files scanned=${files.length}; live secret hashes compared=${hashes.length} (provider keys ${providerFiles}, client tokens ${tokenFiles}); findings=${hits.length}${hits.length ? " [" + hits.slice(0, 12).join("; ") + "]" : ""}; M5 files with the LAN address, network or SSH target=${idHits.join(",") || "none"} (of ${changed.length})` };
    } },
  L01: { name: "lock-and-compose-consistent", inputs: ["deploy/versions.lock.json", "deploy/compose.yaml", `${EV}rendered-compose.json`, "deploy/policies/budget.json", "deploy/policies/capabilities.json", "patches/series.json"],
    expected: "every Compose image is pinned by digest for linux/arm64 across M5's thirteen services; the lock records SearXNG's selected arm64 digest and settings, the API image and patch series the core runs, the retrieval, gateway and MCP images the stack runs, the budget policy's hash with its rate cards, and the capability manifest's hash",
    run() {
      const R = json(`${EV}rendered-compose.json`), L = json("deploy/versions.lock.json"), s = json("patches/series.json");
      const unpinned = Object.entries(R.services).filter(([, v]) => !/@sha256:[0-9a-f]{64}$/.test(v.image) || v.platform !== "linux/arm64").map(([k]) => k);
      const cond = { searxng: L.images?.searxng?.selected?.arm64_manifest_digest === digestOf(R.services.searxng.image) && L.images.searxng.settings?.sha256 === sha256File("deploy/searxng/settings.yml"),
        api: L.images?.firecrawl_api_patched?.image_id === digestOf(R.services["firecrawl-core"].image) && L.images.firecrawl_api_patched.patch_series_sha256 === s.series_sha256 && L.patches?.series_sha256 === s.series_sha256,
        services: L.images?.retrieval?.image_id === digestOf(R.services["retrieval-service"].image) && L.images?.access_gateway?.image_id === digestOf(R.services["access-gateway"].image) && L.images?.mcp_gateway?.image_id === digestOf(R.services["mcp-gateway"].image),
        budget: L.providers?.budget_policy?.sha256 === sha256File("deploy/policies/budget.json") && same(L.providers.rate_cards, json("deploy/policies/budget.json").rateCards),
        manifest: L.gateway?.capabilities_sha256 === sha256File("deploy/policies/capabilities.json") };
      return { ok: unpinned.length === 0 && bad(cond).length === 0 && Object.keys(R.services).length === 13, actual: `services=${Object.keys(R.services).length}; unpinned=${unpinned.join(",") || "none"}; lock disagrees on=${bad(cond).join(",") || "none"}` };
    } },

  // ================================================================ the review of record
  V01: { name: "review-record-complete", inputs: [`${EV}review/REVIEW.md`],
    expected: "the saved /review-2 report (CLAUDE.md §5) gives every finding it lists, and every finding found during M5 outside the review (F), a row with an outcome (fixed with its commit, rejected with evidence, deferred to M6 or later), gives every finding an earlier review deferred to M5 (M2's S6) a row of its own with an outcome, cites only commits that exist, and holds no absolute local path",
    run() {
      const text = read(`${EV}review/REVIEW.md`);
      const rows = text.split("\n").filter((l) => /^\| [A-Z]{1,2}\d+ \|/.test(l)).map((l) => l.split(" | "));
      const badRows = rows.filter((c) => !/^(Fixed|Rejected, with the evidence|Deferred to M[6-9]\b)/.test(c[3] ?? "")).map((c) => c[0].slice(2));
      const carried = ["M0", "M1", "M2", "M3", "M4"].flatMap((m) => { const dir = `evidence/${m}/review`;
        return has(dir) ? readdirSync(resolve(ROOT, dir)).filter((f) => f.endsWith(".md")).flatMap((f) => read(`${dir}/${f}`).split("\n").filter((l) => /^\| [A-Z]{1,2}\d+ \|/.test(l) && /\| Deferred to M5\b/.test(l)).map((l) => `${m} ${l.split(" | ")[0].slice(2)}`)) : []; });
      const carriedRows = text.split("\n").filter((l) => /^\| M\d [A-Z]{1,2}\d+ \|/.test(l)).map((l) => l.split(" | "));
      const carriedBad = carried.filter((id) => { const r = carriedRows.find((c) => c[0] === `| ${id}`); return !r || !/^(Fixed|Rejected, with the evidence|Deferred to M[6-9]\b)/.test(r[2] ?? ""); });
      const listedIds = [...text.matchAll(/^\s*\d+\. \*\*([CWSF]\d+) —/gm)].map((m) => m[1]);
      const uncovered = listedIds.filter((id) => !rows.some((c) => c[0] === `| ${id}`));
      const uncited = rows.filter((c) => /^Fixed/.test(c[3] ?? "") && !/`[0-9a-f]{7,40}`/.test(c[4] ?? "")).map((c) => c[0].slice(2));
      const commits = [...new Set([...rows, ...carriedRows].flatMap((c) => [...(c.join(" | ")).matchAll(/`([0-9a-f]{7,40})`/g)].map((m) => m[1])))];
      const missing = commits.filter((c) => { try { git("cat-file", "-e", `${c}^{commit}`); return false; } catch { return true; } });
      const local = /\/(private\/tmp|Users\/[^\/\s]+|home\/[^\/\s]+)\//.test(text);
      const ok = rows.length > 0 && carried.length >= 1 && listedIds.length >= rows.length - carriedRows.length && uncovered.length === 0 && uncited.length === 0 && badRows.length === 0 && missing.length === 0 && !local && carriedBad.length === 0;
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
  const rec = { test_id: `M5-${id}`, name: c.name, utc: now(), ...repo, upstream_sha: UPSTREAM_SHA, patch_series_sha256: series.series_sha256, config_or_fixture_hash: null, expected: c.expected,
    evidence_class: ["S05", "E05", "D03"].includes(id) ? "live" : "fixture-or-host" };
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
    if (id === "X05") rec.live_sources = "the Pi over SSH (secret hashes only)";
  } catch (e) {
    Object.assign(rec, { state: "FAIL", actual: `check raised: ${e.message}`, exit_code: 2, classification: "verifier-error" });
  }
  rec.image_digests_platform = has(`${EV}rendered-compose.json`) ? { platform: "linux/arm64", api: digestOf(composeImage("firecrawl-core")), retrieval: digestOf(composeImage("retrieval-service")), gateway: digestOf(composeImage("access-gateway")),
    mcp: digestOf(composeImage("mcp-gateway")), searxng: digestOf(composeImage("searxng")), browser: digestOf(composeImage("browser-worker")) } : null;
  rec.actual = hideIds(String(rec.actual), target());
  rec.evidence_path = OUT;
  results[rec.test_id] = rec;
  console.log(`${rec.test_id} ${rec.state.padEnd(18)} ${c.name}${rec.state !== "PASS" ? `  — ${rec.actual.slice(0, 260)}` : ""}`);
}
const ordered = listed.map((id) => results[`M5-${id}`] ?? { test_id: `M5-${id}`, name: checks[id].name, state: "NOT_RUN", actual: "never run", evidence_path: OUT });
writeFileSync(resolve(ROOT, OUT), JSON.stringify({ schema: "fcpi.m5.verification/v1", runner: "scripts/m5/verify.mjs",
  repository_sha_note: "Each result records the commit checked out when it ran, with code_dirty; the commit that stores this file is a later one on main. evidence_class separates the live checks (S05, E05, D03) from the fixture and host checks.",
  results: ordered }, null, 2) + "\n");
process.exitCode = ordered.every((r) => r.state === "PASS" || r.state === "BLOCKED_CREDENTIAL") ? 0 : 1;
