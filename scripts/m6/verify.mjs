#!/usr/bin/env node
// M6 verification (docs/FIRECRAWL_PI_MILESTONES.md, M6 "Automated Verification" and "Acceptance Criteria";
// spec AC09, AC23, AC25; CLAUDE.md §25, §26, §33.3). Every check recomputes its result from the raw evidence under
// evidence/M6/ (or the directory FCPI_M6_EVIDENCE names) and records the §25 tuple, with code_dirty, in
// evidence/M6/verification.json. A check whose evidence is missing is NOT_RUN, never PASS; a live check whose record
// says its credential or budget is missing is BLOCKED_CREDENTIAL; a record a check reads must be there (an absent one
// fails, it does not pass vacuously); every negative result is read beside its positive control; each check's
// `expected` names what it compares. Fixture results and live results are separate checks: a fixture check never
// stands in for a live one.
//   node scripts/m6/verify.mjs [CHECK_ID …]
import { readFileSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { ROOT, sha256, sha256File, repoState, sections, git, kv } from "../m0/lib.mjs";

const EV = process.env.FCPI_M6_EVIDENCE ?? "evidence/M6/";
const RAW = `${EV}raw/`;
const OUT = `${EV}verification.json`;
const UPSTREAM_SHA = "7666c1f9ae8720a6bba271e0f60b6a217f8a5210";
const M6_START = "e08c31f"; // the kickoff's HEAD: files changed after it are M6's
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

// ---- redaction (M4's rules and controls, M5's and M6's live secrets) ----------------------------------
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
  "http://searxng:${pw}@", "sk-test-not-a-real-key-0000000000",
  // M6: the proxy credential parser splits the file's value; the variable holds no value of its own.
  "password: text.slice",
  // M6: the evidence driver's ledger race opens the deployed Store with the service's own secret file, read inside its container.
  "password: readFileSync"]);
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

// ---- snapshot attribution (M4's X04, as M5 carried it) --------------------------------------------------
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
  if (sec === "firewall" && /^nft_ruleset_sha256=/.test(line)) return "nftables ruleset: every changed rule attributed in X04 (evidence/M6/raw/nft-ruleset.txt)";
  if (sec === "nft_chains" && /^ip6? (filter|nat|raw) (DOCKER[-A-Z0-9]*|FORWARD|PREROUTING|OUTPUT|POSTROUTING) /.test(line)) return "Docker's chains";
  return null;
}

// A reboot during the window (raw/reboot.txt, M4's recorder; raw/reboot-cause.txt names its cause, as M5's did
// for the host's own Wi-Fi watchdog): the record must tie BEFORE's boot to the journal's previous boot and
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

// ---- the fixture phase's records -------------------------------------------------------------------------
const strat = (r) => (r?.acquisitions ?? []).map((a) => a.strategies);
const viaAll = (hits, via) => (hits ?? []).length > 0 && hits.every((h) => h.via === via);
const exits = (ts) => [...new Set((ts ?? []).map((t) => t.exit))];
const ok200 = (r) => r?.status === 200;
const microFor = (bytes) => Math.ceil((bytes * 4000000) / 1e9);
const ATTEMPT_RESERVATION = microFor(10000000), TUNNEL_RESERVATION = microFor(2000000);

// ---- checks ------------------------------------------------------------------------------------------
const checks = {
  B00: { name: "baseline-matches-m5-after", inputs: [`${EV}snapshot-before.txt`, "evidence/M5/snapshot-after.txt"],
    expected: "M6's BEFORE snapshot equals M5's AFTER apart from SSH session scopes, and the boot ID is unchanged",
    run() {
      const strip = (f) => keyedSnapshot(f).map((x) => x.join("\t")).filter((l) => !/\tsession-\d+\.scope$/.test(l)).sort();
      const a = strip("evidence/M5/snapshot-after.txt"), b = strip(`${EV}snapshot-before.txt`);
      const only = (x, y) => x.filter((l) => !y.includes(l));
      const boot = (f) => (read(f).match(/^boot_id_sha256=([0-9a-f]{64})$/m) ?? [])[1];
      const ok = a.length > 50 && only(a, b).length === 0 && only(b, a).length === 0 && !!boot(`${EV}snapshot-before.txt`) && boot("evidence/M5/snapshot-after.txt") === boot(`${EV}snapshot-before.txt`);
      return { ok, actual: `lines=${a.length}; only in M5 AFTER=${only(a, b).length}, only in M6 BEFORE=${only(b, a).length}, boot_id_equal=${boot("evidence/M5/snapshot-after.txt") === boot(`${EV}snapshot-before.txt`)}` };
    } },

  // ================================================================ the images, the patches, the suites
  G01: { name: "images-pinned-built-and-running", inputs: [`${RAW}api-build.log`, `${RAW}api-push.txt`, `${RAW}image-build.txt`, `${EV}rendered-compose.json`, `${RAW}stack.txt`],
    expected: "the patched API image was built for linux/arm64 with every step run from a clean tree, carries the nine-patch series hash, and is the image the Pi loaded and the core runs; the retrieval, gateway and MCP images the stack runs are their last builds on the Pi, each recording the commit it was built from, whose source directory is unchanged to HEAD; SearXNG still runs M5's pinned arm64 digest; every deployed commit a record names differs from HEAD in nothing the Pi runs",
    run() {
      const log = read(`${RAW}api-build.log`), push = read(`${RAW}api-push.txt`), build = read(`${RAW}image-build.txt`), st = S(`${RAW}stack.txt`);
      const series = json("patches/series.json");
      const apiId = (log.match(/^id=(sha256:[0-9a-f]{64}) os=linux arch=arm64 /m) ?? [])[1];
      const apiCommit = (log.match(/^repository_commit=([0-9a-f]{40}) code_dirty=false$/m) ?? [])[1];
      const running = (s) => (st.containers ?? []).find((l) => l.startsWith(`${s} `))?.match(/ image=(sha256:[0-9a-f]{64}) /)?.[1];
      const last = (i) => [...build.matchAll(new RegExp(`^fcpi/${i}:m6 id=(sha256:[0-9a-f]{64}) os=linux arch=arm64 size=\\d+ user=(\\S+)$`, "gm"))].at(-1);
      const builtFrom = (i) => [...build.matchAll(new RegExp(`^fcpi/${i}:m6 FCPI_SOURCE_COMMIT=([0-9a-f]{40})$`, "gm"))].at(-1)?.[1];
      const dirSame = (c, d) => { try { git("diff", "--quiet", c, "HEAD", "--", d); return true; } catch { return false; } };
      const runsSame = (c) => { try { git("diff", "--quiet", c, "HEAD", "--", "services", "deploy", "scripts", "tests", "patches", ":(exclude)deploy/versions.lock.json"); return true; } catch { return false; } };
      const deployed = [...new Set([kv(st.meta ?? []).source_commit, FX().meta?.[0]?.deployed_commit, has(`${RAW}e2e-live.txt`) ? LIVE().meta?.[0]?.deployed_commit : null].filter(Boolean))];
      const SEARXNG = "sha256:d9ca82c19f98a684db92af79f5647028e39aaaa90d10611633260139f65b0c19";
      const cond = { api_built: !!apiId && /^build_exit=0 /m.test(log) && /^no_cache=1$/m.test(log) && !!apiCommit && log.includes(`FCPI_PATCH_SERIES_SHA256=${series.series_sha256}`) && log.includes(`FIRECRAWL_BUILD_SHA=${UPSTREAM_SHA}`),
        api_loaded_and_running: push.includes(`pi_image=${apiId} arm64`) && digestOf(composeImage("firecrawl-core")) === apiId && running("firecrawl-core") === apiId,
        api_patches_unchanged: !!apiCommit && dirSame(apiCommit, "patches"),
        searxng: digestOf(composeImage("searxng")) === SEARXNG && running("searxng") === SEARXNG,
        deployed_code_is_head: deployed.length >= 1 && deployed.every(runsSame) };
      for (const [svc, img, dir, uid] of [["retrieval-service", "retrieval", "services/retrieval", "3310:3310"], ["access-gateway", "access-gateway", "services/access", "3380:3380"], ["mcp-gateway", "mcp-gateway", "services/mcp", "3400:3400"]]) {
        const l = last(img), c = builtFrom(img);
        cond[`${img}_built_runs_unchanged`] = !!l && l[2] === uid && running(svc) === l[1] && digestOf(composeImage(svc)) === l[1] && !!c && dirSame(c, dir);
      }
      return { ok: bad(cond).length === 0, actual: `failed=${bad(cond).join(",") || "none"}; api ${apiId?.slice(7, 19)} from ${apiCommit?.slice(0, 7)} series ${series.series_sha256.slice(0, 8)}; deployed commits=${deployed.map((c) => c.slice(0, 7)).join(",")}` };
    } },
  P01: { name: "patch-series-and-coverage", inputs: ["patches/series.json", "patches/0009-residential-route-option.patch", `${RAW}api-build.log`],
    expected: "every patch file hashes to its series entry, the series hash is recomputed from them, patch 0009 names its symbols and tests and touches only the pi-resilient engine, and the API build log shows all nine applied to the series' result tree",
    run() {
      const s = json("patches/series.json"), log = read(`${RAW}api-build.log`);
      const listing = s.patches.map((p) => `${p.sha256}  ${p.file}\n`).join("");
      const p9 = s.patches.find((x) => x.file === "0009-residential-route-option.patch");
      const touched = [...read("patches/0009-residential-route-option.patch").matchAll(/^diff --git a\/(\S+) b\//gm)].map((m) => m[1]);
      const cond = { files: s.patches.every((p) => sha256File(`patches/${p.file}`) === p.sha256), series: sha256(listing) === s.series_sha256, nine: s.patches.length === 9 && s.patches.at(-1) === p9,
        entry: !!p9 && p9.symbols.length >= 1 && p9.tests.length >= 2, scope: same(touched, ["apps/api/src/scraper/scrapeURL/engines/pi-resilient/index.ts"]),
        applied: s.patches.every((p) => log.includes(`applied ${p.file} sha256=${p.sha256}`)) && log.includes(`result_tree=${s.result_tree} series_sha256=${s.series_sha256}`) };
      return { ok: bad(cond).length === 0, actual: `failed=${bad(cond).join(",") || "none"}; series ${s.series_sha256.slice(0, 8)} tree ${s.result_tree.slice(0, 8)}; 0009 touches ${touched.join(",")}` };
    } },
  G02: { name: "suites-pass-in-the-running-images", inputs: [`${RAW}suites.txt`, `${EV}rendered-compose.json`],
    expected: "inside the images the stack runs: the retrieval service's suite (at least 143 tests, M6's routing, residential, proxy and store suites among them, the SQL against a throwaway PostgreSQL, none skipped), the gateway's M5 and M6 tests (at least 20, bulk routing among them), the MCP service's suites, the gateway's unit suites, M3's 40-test contract suite, M4's gateway-level /mcp contract suite and the gateway ledger's migration test all pass with none failing, and no throwaway container or network is left",
    run() {
      const s = S(`${RAW}suites.txt`), m = kv((s.meta ?? [""])[0].split(" "));
      const t = (k) => tapCounts(s[k]), exit0 = (k) => (s[k] ?? []).includes("test_exit=0");
      const skipped = +(((s.retrieval_tap ?? []).find((l) => l.startsWith("# skipped ")) ?? "# skipped 1").split(" ")[2]);
      // One test of each M6 suite, by title: the routing rules, the residential route, the proxies' chaining, the store's SQL.
      const m6suites = ["two consistent challenges on the direct route set a 24-hour residential preference", "a stealth request travels one tunnel under a sticky session",
        "F11: a search host routed residential goes through the provider", "eight concurrent proxy reservations on a cap with room for three"].every((t) => (s.retrieval_tap ?? []).some((l) => l.startsWith("ok ") && l.includes(t)));
      const tr = kv((s.transient ?? []).flatMap((l) => l.split(" ")));
      const cond = { images: m.retrieval_image === composeImage("retrieval-service") && m.gateway_image === composeImage("access-gateway") && m.mcp_image === composeImage("mcp-gateway"),
        retrieval: t("retrieval_tap").tests >= 143 && t("retrieval_tap").fail === 0 && skipped === 0 && exit0("retrieval_tap"), m6_suites_ran: m6suites,
        gateway_m6: t("gateway_m6_tap").tests >= 20 && t("gateway_m6_tap").fail === 0 && exit0("gateway_m6_tap"),
        mcp: t("mcp_tap").tests >= 41 && t("mcp_tap").fail === 0 && exit0("mcp_tap"), gateway_unit: t("gateway_unit_tap").tests >= 30 && t("gateway_unit_tap").fail === 0 && exit0("gateway_unit_tap"),
        m3_contract: t("gateway_contract_tap").tests === 40 && t("gateway_contract_tap").pass === 40 && exit0("gateway_contract_tap"),
        m4_contract: t("gateway_mcp_contract_tap").tests >= 3 && t("gateway_mcp_contract_tap").fail === 0 && exit0("gateway_mcp_contract_tap"),
        ledger_migration: t("ledger_migration_tap").tests === 1 && t("ledger_migration_tap").fail === 0 && exit0("ledger_migration_tap"),
        grammars: t("grammars_tap").tests >= 3 && t("grammars_tap").fail === 0, no_leftovers: tr.leftover_transient_containers === "0" && tr.leftover_transient_networks === "0" };
      return { ok: bad(cond).length === 0, actual: `failed=${bad(cond).join(",") || "none"}; retrieval ${t("retrieval_tap").pass}/${t("retrieval_tap").tests} (skipped ${skipped}), gateway-m6 ${t("gateway_m6_tap").pass}/${t("gateway_m6_tap").tests}, mcp ${t("mcp_tap").pass}/${t("mcp_tap").tests}, gateway unit ${t("gateway_unit_tap").pass}/${t("gateway_unit_tap").tests}, M3 contract ${t("gateway_contract_tap").pass}/${t("gateway_contract_tap").tests}, M4 contract ${t("gateway_mcp_contract_tap").pass}/${t("gateway_mcp_contract_tap").tests}` };
    } },

  // ================================================================ routing and egress (AC09, AC25)
  R01: { name: "direct-and-proxied-egress-fixture", inputs: [`${RAW}e2e-fixture.txt`],
    expected: "the same fixture target seen from both routes: a basic request arrives from the direct route with no tunnel and proxyUsed basic; a stealth request arrives through the fixture proxy's exit in one tunnel, under a 24-character session id with Decodo's session duration, with proxyUsed stealth; each is one attempt of the strategy its route names",
    run() {
      const e = FX().egress ?? [], d = one(e, "direct"), r = one(e, "residential");
      const cond = { direct: ok200(d) && /"via":"direct"/.test(d.body ?? "") && d.proxyUsed === "basic" && same(strat(d), [["direct_http"]]) && viaAll(d.hits, "direct") && (d.tunnels ?? []).length === 0,
        residential: ok200(r) && /"via":"proxy"/.test(r.body ?? "") && r.proxyUsed === "stealth" && same(strat(r), [["residential_http"]]) && viaAll(r.hits, "proxy") && (r.tunnels ?? []).length === 1 && /^[0-9a-f]{24}$/.test(r.tunnels[0].session) && r.tunnels[0].minutes === 5 };
      return { ok: bad(cond).length === 0, actual: `failed=${bad(cond).join(",") || "none"}; direct ${d?.body?.slice(0, 60)} ${JSON.stringify(strat(d))}; residential ${r?.body?.slice(0, 60)} ${JSON.stringify(strat(r))} tunnels=${(r?.tunnels ?? []).length}` };
    } },
  R02: { name: "browser-subresources-follow-the-route", inputs: [`${RAW}e2e-fixture.txt`],
    expected: "a stealth request for a script shell renders on the residential route (residential_http, then residential_browser); the page's HTTP and browser loads and both of its images reach the target through the proxy, every tunnel under one exit, none directly",
    run() {
      const r = one(FX().subresources, "residential_browser");
      const paths = (r?.hits ?? []).map((h) => h.path).sort();
      const cond = { rendered: ok200(r) && r.markdown === true && r.proxyUsed === "stealth", strategies: same(strat(r), [["residential_http", "residential_browser"]]),
        all_via_proxy: viaAll(r?.hits, "proxy") && same(paths, ["/js-subres", "/js-subres", "/px/1.gif", "/px/2.gif"]), one_exit: exits(r?.tunnels).length === 1 && (r?.tunnels ?? []).length >= 3 };
      return { ok: bad(cond).length === 0, actual: `failed=${bad(cond).join(",") || "none"}; strategies=${JSON.stringify(strat(r))}; hits=${(r?.hits ?? []).map((h) => `${h.path}@${h.via}`).join(",")}; tunnels=${(r?.tunnels ?? []).length} exits=${exits(r?.tunnels).join(",")}` };
    } },
  R03: { name: "protected-and-bulk-work-never-uses-home-egress", inputs: [`${RAW}e2e-fixture.txt`],
    expected: "with the residential route unavailable (Decodo selected, paid dispatch off, no credential): a stealth scrape and a proxy-first domain are PROXY_REQUIRED with no attempt and no target request; a bulk crawl and a bulk batch are 429 PROXY_REQUIRED and a local-only bulk crawl 400 PROXY_REQUIRED, with no receipt and no target request; beside them an ordinary scrape and a five-page crawl reach the target directly (the controls); with the fixture proxy, a 25-page crawl and a 21-URL batch finish with every request of the bulk domain, robots.txt and sitemaps included, through the proxy under a route hold that is released at the end; with the route's budget exhausted and with its breaker open, stealth and bulk work are refused with no target request",
    run() {
      const p = FX().production ?? [], b = FX().bulk ?? [], bud = FX().budget ?? [], o = FX().outage ?? [];
      const none = (r) => r && (r.hits ?? []).length === 0 && (r.tunnels ?? 0) === 0;
      const st = one(p, "stealth_proxy_required"), pf = one(p, "proxy_first_required"), bc = one(p, "bulk_crawl_refused"), bb = one(p, "bulk_batch_refused"), bs = one(p, "basic_bulk_refused"), nr = one(p, "no_receipts");
      const sd = one(p, "static_direct"), sc = one(p, "small_crawl_direct");
      const cf = one(b, "crawl_finished"), bf = one(b, "batch_finished"), ca = one(b, "crawl_accepted");
      const ex = one(bud, "exhausted_stealth"), eb = one(bud, "exhausted_bulk"), br = one(o, "breaker_open_refused");
      const cond = {
        stealth_refused: st?.class === "PROXY_REQUIRED" && (st.acquisitions ?? []).length === 0 && none(st) && /PAID_DISPATCH_DISABLED|BLOCKED_CREDENTIAL/.test(st.error ?? ""),
        proxy_first_refused: pf?.class === "PROXY_REQUIRED" && (pf.acquisitions ?? []).length === 0 && (pf.hits ?? []).length === 0,
        bulk_refused: bc?.status === 429 && bc.code === "PROXY_REQUIRED" && none(bc) && bb?.status === 429 && bb.code === "PROXY_REQUIRED" && (bb.hits ?? []).length === 0 && bs?.status === 400 && bs.code === "PROXY_REQUIRED" && (bs.hits ?? []).length === 0,
        no_receipt: nr && nr.jobs_before === nr.jobs_after,
        controls: ok200(sd) && sd.markdown === true && viaAll(sd.hits, "direct") && ok200(sc) && sc.status_field === "completed" && sc.documents === 5 && viaAll(sc.hits, "direct"),
        bulk_via_proxy: ok200(cf) && cf.status_field === "completed" && cf.documents === 25 && viaAll(cf.hits, "proxy") && (cf.hits ?? []).some((h) => h.path === "/robots.txt") && ca?.holds_during >= 1 && cf.holds_after === 0
          && ok200(bf) && bf.status_field === "completed" && bf.documents === 21 && viaAll(bf.hits, "proxy") && bf.holds_after === 0,
        exhausted: ex?.class === "PROXY_REQUIRED" && /BUDGET_EXHAUSTED/.test(ex.error ?? "") && none(ex) && eb?.status === 429 && /BUDGET_EXHAUSTED/.test(eb.error ?? "") && none(eb),
        breaker: br?.class === "PROXY_REQUIRED" && /PROVIDER_UNAVAILABLE/.test(br.error ?? "") && none(br) };
      return { ok: bad(cond).length === 0, actual: `failed=${bad(cond).join(",") || "none"}; refusals: stealth ${st?.class}, proxy-first ${pf?.class}, bulk crawl ${bc?.status} ${bc?.code}, bulk batch ${bb?.status}, basic bulk ${bs?.status}; receipts ${nr?.jobs_before}→${nr?.jobs_after}; bulk crawl ${cf?.documents} docs, ${(cf?.hits ?? []).length} hits all via proxy=${viaAll(cf?.hits, "proxy")}; batch ${bf?.documents} docs` };
    } },
  R04: { name: "controlled-escalation", inputs: [`${RAW}e2e-fixture.txt`],
    expected: "an auto request for a page whose HTTP answer is a script shell and whose direct render is a challenge goes direct_http, direct_browser, residential_browser and returns the page rendered through the proxy; a 403 challenge and a 200 challenge on the direct route each go direct_http then residential_http and return the article; no acquisition passes four attempts",
    run() {
      const e = FX().escalation ?? [], j = one(e, "js_challenge"), c3 = one(e, "challenge_403"), c2 = one(e, "challenge_200");
      const cond = { js: ok200(j) && same(strat(j), [["direct_http", "direct_browser", "residential_browser"]]) && /Rendered through the proxy/.test(j.markdown ?? "") && j.proxyUsed === "stealth",
        c403: ok200(c3) && same(strat(c3), [["direct_http", "residential_http"]]) && /through the proxy after a challenge/.test(c3.markdown ?? "") && c3.proxyUsed === "stealth",
        c200: ok200(c2) && same(strat(c2), [["direct_http", "residential_http"]]) && /through the proxy after a challenge/.test(c2.markdown ?? ""),
        routes_seen: [j, c3, c2].every((r) => (r?.hits ?? []).some((h) => h.via === "direct") && (r?.hits ?? []).some((h) => h.via === "proxy")) };
      return { ok: bad(cond).length === 0, actual: `failed=${bad(cond).join(",") || "none"}; ${[j, c3, c2].map((r) => `${r?.case}: ${JSON.stringify(strat(r))}`).join("; ")}` };
    } },
  R05: { name: "failure-rules-401-429-403-404-5xx", inputs: [`${RAW}e2e-fixture.txt`],
    expected: "spec §9.2 through REST on the direct route: 401 is AUTH_REQUIRED after one attempt; an unknown 403 is ACCESS_DENIED after one; 404 returns the page with status 404 after one; 500 gets exactly one same-tier retry and keeps its status; 429 is RATE_LIMITED with Retry-After 30 after one; none reaches the proxy; the cooled-down domain then refuses a stealth request as RATE_LIMITED with no target request and no tunnel (a rate limit is respected on every route, never rotated around)",
    run() {
      const f = FX().failure_rules ?? [];
      const c = (k) => one(f, k);
      const one1 = (r) => same(strat(r), [["direct_http"]]) && (r?.tunnels ?? 0) === 0;
      const cool = c("cooldown_all_routes");
      const cond = { a401: c("401")?.class === "AUTH_REQUIRED" && one1(c("401")), a403: c("unknown_403")?.class === "ACCESS_DENIED" && one1(c("unknown_403")),
        a404: ok200(c("404")) && c("404").statusCode === 404 && one1(c("404")), a500: same(strat(c("500")), [["direct_http", "direct_http"]]) && c("500").statusCode === 500 && (c("500").tunnels ?? 0) === 0,
        a429: c("429")?.class === "RATE_LIMITED" && /Retry after 30 s/.test(c("429").error ?? "") && one1(c("429")),
        cooldown: cool?.class === "RATE_LIMITED" && (cool.hits ?? []).length === 0 && (cool.tunnels ?? 0) === 0 && cool.domain_state?.cooldown_s === 30 && cool.domain_state.remaining_s > 0 };
      return { ok: bad(cond).length === 0, actual: `failed=${bad(cond).join(",") || "none"}; ${f.map((r) => `${r.case}=${r.class ?? r.status}/${JSON.stringify(strat(r))}`).join("; ")}` };
    } },
  R06: { name: "learning-ttl-probe-and-attempt-limits", inputs: [`${RAW}e2e-fixture.txt`],
    expected: "on one domain: the first direct challenge is pending (no preference), the second sets a residential preference of 24 hours (consistent_challenges); the third acquisition starts residential and never reaches the home connection; after the preference expires one probe goes direct, meets the challenge, renews the preference (probe_confirmed) and escalates; the table holds at most 5,000 rows; no acquisition in the phase used more than four attempts, and none retried the same tier more than once",
    run() {
      const L = FX().learning ?? [], o1 = one(L, "observation_1"), o2 = one(L, "observation_2"), o3 = one(L, "observation_3"), pr = one(L, "probe_after_expiry"), bd = one(L, "bound");
      const ev = FX().retrieval_events?.[0]?.acquisitions ?? [];
      const sameTierTwice = ev.some((e) => { const s = e.strategies ?? []; return s.some((x, i) => i >= 2 && s[i - 1] === x && s[i - 2] === x); });
      const cond = { first_pending: ok200(o1) && same(strat(o1), [["direct_http", "residential_http"]]) && o1.route?.preferred === null && o1.route?.challenges === 1,
        second_sets: ok200(o2) && o2.route?.preferred === "residential" && Math.abs((o2.route?.ttl_s ?? 0) - 86400) <= 5 && o2.route?.last_reason === "consistent_challenges",
        third_learned: ok200(o3) && same(strat(o3), [["residential_http"]]) && viaAll(o3.hits, "proxy"),
        probe: ok200(pr) && same(strat(pr), [["direct_http", "residential_http"]]) && pr.route?.last_reason === "probe_confirmed" && Math.abs((pr.route?.ttl_s ?? 0) - 86400) <= 5 && Date.parse(pr.route?.set_at) > Date.parse(o2.route?.set_at)
          && ev.some((e) => e.route_reason === "probe_after_expiry"),
        bound: bd?.rows >= 1 && bd.rows <= 5000, attempts: ev.length >= 40 && ev.every((e) => e.attempts_used >= 0 && e.attempts_used <= 4 && (e.strategies ?? []).length <= 4), no_same_tier_twice: !sameTierTwice };
      return { ok: bad(cond).length === 0, actual: `failed=${bad(cond).join(",") || "none"}; o1 ${JSON.stringify(o1?.route && { p: o1.route.preferred, c: o1.route.challenges })}; o2 ${o2?.route?.preferred}/${o2?.route?.ttl_s}/${o2?.route?.last_reason}; o3 ${JSON.stringify(strat(o3))}; probe ${JSON.stringify(strat(pr))} ${pr?.route?.last_reason}; acquisitions=${ev.length}, max attempts=${Math.max(...ev.map((e) => e.attempts_used))}` };
    } },
  R07: { name: "provider-outage-and-isolation", inputs: [`${RAW}e2e-fixture.txt`],
    expected: "the fixture proxy answering 407, 402 and never answering gives PROVIDER_AUTH_FAILED, PROVIDER_BILLING and PROVIDER_UNREACHABLE, each one residential attempt with no target request; the three open the provider's breaker (readiness: PROVIDER_UNAVAILABLE); with it open a stealth request is PROXY_REQUIRED with no attempt, while an ordinary request reaches the target directly (AC23); the domain those failures touched learned nothing",
    run() {
      const o = FX().outage ?? [], p407 = one(o, "provider_407"), p402 = one(o, "provider_402"), bh = one(o, "provider_blackhole"), br = one(o, "breaker"), ref = one(o, "breaker_open_refused"), du = one(o, "direct_unaffected"), dp = one(o, "domain_not_poisoned");
      const prov = (r, cls) => r?.class === cls && same(strat(r), [["residential_http"]]) && (r.hits ?? []).length === 0;
      const cond = { classes: prov(p407, "PROVIDER_AUTH_FAILED") && prov(p402, "PROVIDER_BILLING") && prov(bh, "PROVIDER_UNREACHABLE"),
        breaker: br?.readyz?.residential?.available === false && br.readyz.residential.reason === "PROVIDER_UNAVAILABLE" && br.readyz.ok === true,
        refused: ref?.class === "PROXY_REQUIRED" && (ref.acquisitions ?? []).length === 0 && (ref.hits ?? []).length === 0,
        direct_unaffected: ok200(du) && du.markdown === true && same(strat(du), [["direct_http"]]) && viaAll(du.hits, "direct"),
        not_poisoned: dp && (dp.route === null || dp.route.preferred === null) };
      return { ok: bad(cond).length === 0, actual: `failed=${bad(cond).join(",") || "none"}; ${[p407, p402, bh].map((r) => r?.class).join(",")}; breaker ${br?.readyz?.residential?.reason}; refused ${ref?.class}; direct ${du?.status} ${JSON.stringify(strat(du))}; route ${JSON.stringify(dp?.route?.preferred ?? null)}` };
    } },
  R08: { name: "simultaneous-clients-pacing-and-cost", inputs: [`${RAW}e2e-fixture.txt`, "deploy/policies/budget.json"],
    expected: "two clients alternating direct and residential requests to one domain with the 2 s gap all succeed, both routes and both clients appear, and the target sees every navigation at least 2,000 ms after the one before, whatever its route or client; eight simultaneous reservations against the race category grant exactly the floor of what was left over one attempt's reservation, the rest BUDGET_EXHAUSTED, and every granted one is released",
    run() {
      const p = one(FX().pacing, "two_clients_two_routes"), rc = one(FX().budget, "reservation_race"), rel = one(FX().budget, "race_released");
      const at = (p?.hits ?? []).map((h) => Date.parse(h.at)).sort((a, b) => a - b), gaps = at.slice(1).map((t, i) => t - at[i]);
      const granted = (rc?.outcomes ?? []).filter((x) => x.granted).length, refused = (rc?.outcomes ?? []).filter((x) => x.exhausted?.category === "fixture_proxy_race").length;
      const cond = { all_ok: (p?.results ?? []).length === 6 && p.results.every((r) => r.status === 200), both_routes: new Set((p?.hits ?? []).map((h) => h.via)).size === 2 && new Set((p?.results ?? []).map((r) => r.client)).size === 2,
        gaps: at.length === 6 && gaps.every((g) => g >= 2000),
        race: !!rc && rc.amount === ATTEMPT_RESERVATION && rc.expected_granted >= 1 && granted === rc.expected_granted && refused === 8 - granted && rc.expected_granted < 8,
        released: !!rel && rel.released.length === granted && rel.released.every(Boolean) };
      return { ok: bad(cond).length === 0, actual: `failed=${bad(cond).join(",") || "none"}; gaps ms=${gaps.join(",")}; routes=${[...new Set((p?.hits ?? []).map((h) => h.via))].join(",")}; race granted ${granted} of 8 (expected ${rc?.expected_granted}, cap ${rc?.cap}, used before ${rc?.used_before}), released ${rel?.released?.length}` };
    } },
  R09: { name: "proxy-reservations-settlement-and-hard-cap", inputs: [`${RAW}e2e-fixture.txt`, "deploy/policies/budget.json", `${EV}rendered-compose.json`],
    expected: "every residential attempt reserved one attempt's maximum (10 MB at $4/GB, 40,000 micro-USD) and every search tunnel its own (2 MB, 8,000) before anything was sent; every settled row's actual is the rate card's price for its measured bytes, above its reservation only for an attempt cut at its cap and then by at most one chunk; the residential echo's settled bytes are at least what the fixture proxy relayed for its session; the 12 MB page past its reservation is SIZE_LIMIT after one attempt; no proxy row exists for the production phase; the paid proxy caps are zero and paid dispatch is off",
    run() {
      const rows = (FX().ledger?.[0]?.rows ?? []).filter((r) => r.kind === "proxy");
      const budget = json("deploy/policies/budget.json"), R = json(`${EV}rendered-compose.json`);
      const reservedOk = rows.length >= 20 && rows.every((r) => Number(r.reserved) === (r.call_key.startsWith("proxy:search:") ? TUNNEL_RESERVATION : ATTEMPT_RESERVATION) || r.call_key.startsWith("e2e-race-"));
      const settled = rows.filter((r) => r.state === "SETTLED");
      const priced = settled.length >= 15 && settled.every((r) => (r.usage?.reconciled ? Number(r.actual) <= Number(r.reserved) : Number(r.actual) === microFor(r.usage?.bytes ?? -1))
        && (Number(r.actual) <= Number(r.reserved) || (r.usage?.capped === true && Number(r.actual) - Number(r.reserved) <= microFor(1048576))));
      const eg = one(FX().egress, "residential"), echoTunnel = (eg?.tunnels ?? [])[0];
      const echoRow = rows.find((r) => r.usage && eg && Date.parse(r.created_at) >= Date.parse(eg.utc) - 30000 && Date.parse(r.created_at) <= Date.parse(eg.utc) && r.state === "SETTLED");
      const sz = one(FX().size_limit, "past_reservation");
      const prodStart = Date.parse(FX().production?.[0]?.utc ?? ""), prodEnd = Date.parse(FX().route?.[0]?.utc ?? "");
      const cond = { reserved_first: reservedOk, priced_within: priced, covers_relayed: !!echoTunnel && !!echoRow && echoRow.usage.bytes >= echoTunnel.up + echoTunnel.down,
        size_limit: sz?.class === "SIZE_LIMIT" && same(strat(sz), [["residential_http"]]),
        production_none: rows.every((r) => !(Date.parse(r.created_at) >= prodStart && Date.parse(r.created_at) <= prodEnd)),
        paid_zero: same(budget.categories.proxy.caps, { day: 0, month: 0 }) && budget.paidTotal.caps.day === 0 && R.services["retrieval-service"].environment.PI_PAID_DISPATCH_ENABLED === "false" };
      return { ok: bad(cond).length === 0, actual: `failed=${bad(cond).join(",") || "none"}; proxy rows=${rows.length} (settled ${settled.length}, uncertain ${rows.filter((r) => r.state === "UNCERTAIN").length}); echo settled bytes=${echoRow?.usage?.bytes} relayed=${echoTunnel ? echoTunnel.up + echoTunnel.down : null}; size limit ${sz?.class}` };
    } },
  R10: { name: "provider-usage-reconciliation", inputs: [`${RAW}e2e-fixture.txt`],
    expected: "reconciling today's fixture-proxy traffic reads the fixture's own usage report (the same byte count it serves), compares it with the ledger's measured bytes, and settles any excess at the rate card's price as a reconcile row; a report below the measurement lowers nothing",
    run() {
      const r = one(FX().reconcile, "fixture_proxy_day"), j = r?.json;
      const rows = (FX().ledger?.[0]?.rows ?? []).filter((x) => x.kind === "reconcile" && x.provider === "fixture-proxy" && Date.parse(x.created_at) >= Date.parse(r?.utc ?? "") - 60000);
      const want = j ? Math.max(0, microFor(j.providerBytes - j.localBytes)) : NaN;
      const cond = { answered: r?.status === 200 && j?.provider === "fixture-proxy" && j.localBytes > 0, report: j?.providerBytes === r?.fixture_usage,
        adjustment: j?.adjustmentMicroUsd === (j && j.providerBytes > j.localBytes ? want : 0), recorded: j?.adjustmentMicroUsd > 0 ? rows.some((x) => Number(x.actual) === j.adjustmentMicroUsd && x.state === "SETTLED") : rows.length === 0 };
      return { ok: bad(cond).length === 0, actual: `failed=${bad(cond).join(",") || "none"}; local ${j?.localBytes} provider ${j?.providerBytes} (fixture report ${r?.fixture_usage}); adjustment ${j?.adjustmentMicroUsd} micro-USD; reconcile rows ${rows.length}` };
    } },
  R11: { name: "search-residential-engines-fixture", inputs: [`${RAW}e2e-fixture.txt`, "deploy/policies/egress.json"],
    expected: "F11: the policy routes Brave and DuckDuckGo residential and Bing direct; with the fixture proxy, the residential fixture engine is reached only through the proxy (its tunnel logged route residential) while the other fixture engines stay direct; without a proxy the residential engine is refused (PROXY_REQUIRED), the answer is partial and names it, and it sees no request",
    run() {
      const s = FX().search ?? [], r = one(s, "residential_engine"), n = one(s, "residential_engine_no_route"), E = json("deploy/policies/egress.json").search.engineRoutes;
      const cond = { policy: E["search.brave.com"] === "residential" && E["duckduckgo.com"] === "residential" && E["html.duckduckgo.com"] === "residential" && E["lite.duckduckgo.com"] === "residential" && E["www.bing.com"] === "direct",
        through_proxy: ok200(r) && viaAll(r.hits, "proxy") && (r.proxy_log ?? []).some((l) => l.host === "searchr.fixture.fcpi.test" && l.route === "residential") && (r.proxy_log ?? []).some((l) => l.host === "search.fixture.fcpi.test" && l.route === "direct"),
        refused_without: ok200(n) && /fcpi fixture r/.test(n.warning ?? "") && (n.hits ?? []).length === 0 && n.results >= 1 };
      return { ok: bad(cond).length === 0, actual: `failed=${bad(cond).join(",") || "none"}; with proxy: ${(r?.hits ?? []).length} engine hit(s) via ${[...new Set((r?.hits ?? []).map((h) => h.via))].join(",")}; without: warning=${n?.warning}` };
    } },
  R12: { name: "every-acquisition-records-its-route", inputs: [`${RAW}e2e-fixture.txt`, `${RAW}stack.txt`],
    expected: "every acquisition the retrieval service logged in the fixture phase names its initial and final strategy, its attempts and its route (requested, start, reason), each strategy one of spec §8.3's names; across the service's whole log every acquisition line carries these fields",
    run() {
      const ev = FX().retrieval_events?.[0]?.acquisitions ?? [], scan = kv(((S(`${RAW}stack.txt`).retrieval_log_scan ?? [])[0] ?? "").split(" "));
      const NAMES = /^(direct_http|direct_browser|residential_http|residential_browser)$/;
      const full = ev.filter((e) => e.route_requested && e.route_start !== undefined && e.route_reason !== undefined && Number.isInteger(e.attempts_used) && (e.strategies ?? []).every((s) => NAMES.test(s))
        && ((e.strategies ?? []).length === 0 ? e.initial_strategy === null : e.initial_strategy === e.strategies[0] && e.final_strategy === e.strategies.at(-1)));
      const cond = { phase: ev.length >= 40 && full.length === ev.length, whole_log: +scan.acquisition >= ev.length && scan.acquisition === scan.acquisition_with_route_fields };
      return { ok: bad(cond).length === 0, actual: `failed=${bad(cond).join(",") || "none"}; phase acquisitions=${ev.length}, complete=${full.length}; log acquisitions=${scan.acquisition}, with route fields=${scan.acquisition_with_route_fields}` };
    } },

  // ================================================================ live (held until the review is addressed)
  L01: { name: "live-proxied-egress-differs", live: true, inputs: [`${RAW}e2e-live.txt`],
    expected: "with an approved Decodo credential and budget: the same public echo seen directly and through Decodo shows two different addresses, the proxied one with proxyUsed stealth and a settled proxy reservation; without them, BLOCKED_CREDENTIAL, and no live proxy request is made",
    run() {
      const l = LIVE(), e = l.live_egress?.[0];
      if (!endOk(l)) return { ok: false, actual: "the live run did not end cleanly" };
      if (e?.case === "blocked") return { blocked: true, actual: `credential=${e.credential} paidDispatch=${e.paidDispatch} proxyCaps=${JSON.stringify(e.proxyCaps)}: ${e.reason}` };
      const rows = (l.ledger?.[0]?.rows ?? []).filter((r) => r.kind === "proxy" && r.provider === "decodo");
      const ok = e?.case === "direct_vs_proxied" && e.differ === true && e.proxyUsed === "stealth" && rows.some((r) => r.state === "SETTLED" && Number(r.actual) > 0);
      return { ok, actual: `differ=${e?.differ} proxyUsed=${e?.proxyUsed} decodo rows=${rows.length}` };
    } },
  L02: { name: "live-search-residential-engines", live: true, inputs: [`${RAW}e2e-live.txt`],
    expected: "with the live proxy: a live query's Brave and DuckDuckGo requests leave only through Decodo (route residential in the search proxy's log) and Bing's directly; without it, BLOCKED_CREDENTIAL",
    run() {
      const l = LIVE(), s = l.live_search?.[0];
      if (!endOk(l)) return { ok: false, actual: "the live run did not end cleanly" };
      if (s?.case === "blocked") return { blocked: true, actual: s.reason };
      const logd = s?.proxy_log ?? [];
      const ok = s?.status === 200 && logd.some((x) => /brave|duckduckgo/.test(x.host) && x.route === "residential") && !logd.some((x) => /brave|duckduckgo/.test(x.host) && x.route === "direct");
      return { ok, actual: `status=${s?.status} results=${s?.results} residential engine tunnels=${logd.filter((x) => x.route === "residential").length}` };
    } },

  // ================================================================ the manifest, the host
  C01: { name: "capabilities-and-mcp-catalog", inputs: ["deploy/policies/capabilities.json", `${RAW}e2e-fixture.txt`],
    expected: "the manifest offers the proxy option auto, basic and stealth, refuses enhanced until M7 and sets the bulk threshold at 20 pages with a 60-minute hold; the MCP catalog's scrape tool offers the same three values and not enhanced",
    run() {
      const m = json("deploy/policies/capabilities.json"), cat = FX().mcp_catalog?.[0], px = m.fieldsets.scrapeOptions.proxy;
      const cond = { manifest: same(px.values, ["auto", "basic", "stealth"]) && /M7/.test(px.refused.enhanced ?? "") && !px.refused.stealth, limits: m.limits.proxy?.bulkPages === 20 && m.limits.proxy.holdMinutes === 60,
        catalog: cat?.status === 200 && same(cat.scrape_proxy_enum, ["auto", "basic", "stealth"]) };
      return { ok: bad(cond).length === 0, actual: `failed=${bad(cond).join(",") || "none"}; mcp scrape proxy enum=${JSON.stringify(cat?.scrape_proxy_enum)}; tools=${cat?.tools?.length}` };
    } },
  X01: { name: "zero-firecrawl-cloud-attempts", inputs: [`${RAW}guard-window-open.txt`, `${RAW}egress-probe.txt`, `${RAW}core-logs-final.txt`, `${RAW}stack.txt`, `${RAW}e2e-fixture.txt`],
    expected: "across one window, from a guard-counter snapshot before the first phase to the egress probe after the last, with the guard's table not reloaded and every phase inside it: during the fixture phase the guard accepted no web connection and no proxy-port connection (the fixture proxy is on the internal fixture network); after a live phase only as many as its logged connections; the core's saved log classifies every Cloud line; the retrieval log names no Cloud host; every driver's sockets went only to the forward",
    run() {
      const utcOf = (f) => Date.parse(((sections(f).meta ?? []).join(" ").match(/utc=(\S+?Z)/) ?? [])[1]);
      const handle = (f) => ((sections(f).meta ?? []).join(" ").match(/guard_table_handle=(\d+)/) ?? [])[1];
      const counter = (f, sec, name) => +((sections(f)[sec] ?? []).find((l) => l.startsWith(`${name} `)) ?? "=NaN").split("=")[1];
      const open = utcOf(`${RAW}guard-window-open.txt`), close = utcOf(`${RAW}egress-probe.txt`);
      const inWindow = (t) => Number.isFinite(t) && t > open && t < close;
      const live = has(`${RAW}e2e-live.txt`) ? LIVE() : null;
      const liveRan = live && live.live_egress?.[0]?.case !== "blocked";
      const phases = [FX(), ...(live ? [live] : [])];
      const web = counter(`${RAW}egress-probe.txt`, "guard_after", "egress_web_accepted") - counter(`${RAW}guard-window-open.txt`, "counters", "egress_web_accepted");
      const proxy = counter(`${RAW}egress-probe.txt`, "guard_after", "egress_proxy_accepted") - counter(`${RAW}guard-window-open.txt`, "counters", "egress_proxy_accepted");
      const recs = Object.entries(sections(`${RAW}core-logs-final.txt`)).filter(([k]) => /^(instance|stored)_/.test(k)).map(([, lines]) => {
        const c = lines.find((l) => l.startsWith("classified ")); const ctl = +((lines.find((l) => l.startsWith("control=")) ?? "").match(/count=(\d+)/) ?? [])[1];
        return { c: c ? kv(c.split(" ").slice(1)) : null, ctl };
      });
      const scanR = kv(((S(`${RAW}stack.txt`).retrieval_log_scan ?? [])[0] ?? "").split(" "));
      const conns = phases.map((p) => p.connections?.[0]);
      const cond = { same_guard: !!handle(`${RAW}guard-window-open.txt`) && handle(`${RAW}guard-window-open.txt`) === handle(`${RAW}egress-probe.txt`), phases_inside: phases.every((p) => inWindow(Date.parse(p.meta?.[0]?.pi_utc ?? ""))),
        counters_read: Number.isFinite(web) && Number.isFinite(proxy), egress: liveRan ? web >= 1 && proxy >= 1 : web === 0 && proxy === 0,
        core_logs: recs.length >= 1 && recs.every((r) => r.c && r.c.cloud_unexplained === "0" && r.c.dns_unexplained === "0" && r.ctl >= 1),
        retrieval_log: +scanR.lines > 100 && scanR.cloud_host === "0", drivers: conns.every((c) => c && same(c.hosts, ["127.0.0.1:3380"]) && c.lookups.length === 0) };
      return { ok: bad(cond).length === 0, actual: `failed=${bad(cond).join(",") || "none"}; guard handle ${handle(`${RAW}guard-window-open.txt`)}→${handle(`${RAW}egress-probe.txt`)}, web accepted delta=${web}, proxy-port accepted delta=${proxy}, live ran=${!!liveRan}; core logs=${recs.length}; retrieval log lines=${scanR.lines} cloud=${scanR.cloud_host}` };
    } },
  X02: { name: "network-and-container-posture", inputs: [`${RAW}stack.txt`, `${EV}rendered-compose.json`],
    expected: "fixture-m6 sits on the internal fixture network alone with no default route, answers under its eight fixture names, mounts only its credential's SHA-256 as a secret, and runs with a read-only root, dropped capabilities, no Docker socket and a 96 MiB cap without swap; the fixture network stays internal; the only host publication is still 127.0.0.1:3380; all fourteen containers run aarch64 and every swap limit is 0",
    run() {
      const st = S(`${RAW}stack.txt`), R = json(`${EV}rendered-compose.json`).services;
      const net = (n) => (st.networks ?? []).find((l) => l.startsWith(`${n} `)) ?? "";
      const pub = (st.published ?? []).filter((l) => /->/.test(l));
      const cg = (s) => kv(((st.cgroups ?? []).find((l) => l.startsWith(`${s} `)) ?? "").split(" ").slice(1));
      const c = (s) => kv(((st.containers ?? []).find((l) => l.startsWith(`${s} name=`)) ?? "").split(" "));
      const arch = (st.containers ?? []).filter((l) => / uname_m=/.test(l));
      const reach = st.fixture_m6_reach ?? [];
      const rk = kv(((reach.find((l) => l.startsWith("networks=")) ?? "")).split(" "));
      const cond = { fixture_internal: /internal=true/.test(net("fcpi_fixture")) && /gateway_mode_ipv4=isolated/.test(net("fcpi_fixture")) && /fcpi-fixture-m6-1/.test(net("fcpi_fixture")),
        m6_reach: reach.includes("default_route=no") && rk.networks === "fcpi_fixture" && (rk.aliases ?? "").split(",").length >= 8 && rk.secrets_mounted === "/run/secrets/fixture_proxy_sha256" && same(Object.keys(R["fixture-m6"].networks), ["fixture"]),
        publication: pub.length === 1 && /^access-gateway 3300\/tcp -> 127\.0\.0\.1:3380$/.test(pub[0]),
        posture: c("fixture-m6").readonly_rootfs === "true" && c("fixture-m6").cap_drop === "ALL" && c("fixture-m6").docker_sock_mount === "0" && c("fixture-m6").privileged === "false",
        memory: cg("fixture-m6")["memory.max"] === String(96 * MIB),
        swap: (st.cgroups ?? []).length === 14 && (st.cgroups ?? []).every((l) => / memory\.swap\.max=0 /.test(l)), arch: arch.length === 14 && arch.every((l) => /uname_m=aarch64$/.test(l)) };
      return { ok: bad(cond).length === 0, actual: `failed=${bad(cond).join(",") || "none"}; ${net("fcpi_fixture")}; fixture-m6 ${reach.join(" ")}; publications=${pub.join(";")}` };
    } },
  X03: { name: "retrieval-log-hygiene", inputs: [`${RAW}stack.txt`],
    expected: "the retrieval service's whole log (with acquisitions, residential-route requests, route holds and a reconciliation as the positive control) holds no provider key, client token, bearer or Basic credential, no Proxy-Authorization, no proxy session username and not the fixture proxy's credential, which the scan read and looked for by value; and the budget policy hash it logged at start is the deployed file's",
    run() {
      const st = S(`${RAW}stack.txt`), s = kv(((st.retrieval_log_scan ?? [])[0] ?? "").split(" ")), h = kv(((st.retrieval_log_scan ?? [])[1] ?? "").split(" "));
      const cond = { read: +s.lines >= 100 && +s.acquisition >= 40 && +s.residential_route >= 1 && +s.route_held >= 1 && +s.proxy_reconciled >= 1 && s.fixture_credential_readable === "yes",
        clean: ["provider_key_like", "client_token_like", "bearer", "proxy_authorization", "basic_credential", "session_username", "fixture_credential", "cloud_host"].every((k) => s[k] === "0"),
        budget_hash: /^[0-9a-f]{64}$/.test(h.budget_policy_sha256_logged ?? "") && h.budget_policy_sha256_logged === h.budget_policy_sha256_deployed && h.budget_policy_sha256_deployed === sha256File("deploy/policies/budget.json") };
      return { ok: bad(cond).length === 0, actual: `failed=${bad(cond).join(",") || "none"}; ${(st.retrieval_log_scan ?? [])[0]}` };
    } },
  M01: { name: "memory-within-caps", inputs: [`${RAW}stack.txt`, `${RAW}e2e-fixture.txt`],
    expected: "every sample of the retrieval service, the browser worker, SearXNG, the gateway, the MCP service, the core and fixture-m6 peaks below 90% of its cap, no sampled cgroup records an OOM kill, the host's OOM-kill count does not rise across the samples, MemAvailable stays above 1 GiB (spec §22's reserve), and the stack's final cgroups agree",
    run() {
      const xs = samples(), st = S(`${RAW}stack.txt`);
      const svcs = ["retrieval", "browser", "searxng", "gateway", "mcp", "core", "fixture_m6"];
      const peaks = Object.fromEntries(svcs.map((s) => [s, Math.max(...xs.map((x) => (x[s] ? x[s].peak / Number(x[s].max) : 0)))]));
      const ooms = xs.flatMap((x) => svcs.map((s) => x[s]?.oom_kill ?? 0)).some((n) => n > 0);
      const vm = xs.map((x) => x.vmstat_oom_kill), avail = Math.min(...xs.map((x) => x.mem_available_kib));
      const cg = (st.cgroups ?? []).map((l) => kv(l.split(" ").slice(1)));
      const cond = { samples: xs.length >= 2, peaks: svcs.every((s) => peaks[s] > 0 && peaks[s] < 0.9), no_oom: !ooms && cg.every((c) => c.oom_kill === "0"), host_oom: vm.every((v) => v === vm[0]), headroom: avail > 1024 * 1024 };
      return { ok: bad(cond).length === 0, actual: `failed=${bad(cond).join(",") || "none"}; samples=${xs.length}; peak fractions=${JSON.stringify(Object.fromEntries(Object.entries(peaks).map(([k, v]) => [k, +v.toFixed(3)])))}; min MemAvailable=${Math.round(avail / 1024)} MiB` };
    } },
  X04: { name: "unrelated-state-unchanged", inputs: [`${EV}snapshot-before.txt`, `${EV}snapshot-after.txt`, `${RAW}nft-ruleset.txt`, "evidence/M5/raw/nft-ruleset.txt"],
    expected: "every line differing between M6's BEFORE and AFTER snapshots is attributed to the project (fcpi containers, their scopes, root filesystems and namespaces, kernel modules for the runtime, the ruleset), the collector's own SSH session, or the owner's own work that raw/owner-session.txt records; no unrelated line is removed or changed; the boot ID is unchanged, or changed only across a reboot raw/reboot.txt ties to both snapshots; rule by rule against M5's recorded ruleset, the only change is the guard's new proxy-port rule, and the installed guard is the repository's",
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
      const r5 = ruleSet("evidence/M5/raw/nft-ruleset.txt"), r6 = ruleSet(`${RAW}nft-ruleset.txt`);
      const ruleChanges = [...[...r6].filter((r) => !r5.has(r)).map((r) => `+ ${r}`), ...[...r5].filter((r) => !r6.has(r)).map((r) => `- ${r}`)];
      const unattributed = ruleChanges.filter((ch) => !/^\+ inet fcpi_guard\tforward\tiifname "fcpi-egress" ct state new tcp dport 7000 counter( packets \d+ bytes \d+)? accept comment "egress_proxy_accepted"$/.test(ch)).map((ch) => ch.replace(/\t/g, " ").slice(0, 110));
      const afterHash = (read(A).match(/^nft_ruleset_sha256=([0-9a-f]{64})$/m) ?? [])[1];
      const rulesTied = /^[0-9a-f]{64}$/.test(hdr.ruleset_sha256 ?? "") && hdr.ruleset_sha256 === afterHash;
      writeFileSync(resolve(ROOT, `${EV}snapshot-diff.txt`), ["# M6 BEFORE/AFTER snapshot diff (section-keyed; written by scripts/m6/verify.mjs X04)",
        `# before: ${read(B).split("\n")[1]}  after: ${read(A).split("\n")[1]}`, `# boot_id: ${boot(B) && boot(B) === boot(A) ? "unchanged (no reboot)" : tie ? `changed across the reboot raw/reboot.txt ties to both snapshots (the earlier boot ended ${tie.ended})` : "CHANGED or MISSING"}`,
        `## changes to unrelated state (${rows.unrelated.length})`, ...rows.unrelated, `## the owner's own work on the Pi and Pi-hole's own socket rotation (${rows.owner.length}; raw/owner-session.txt)`, ...rows.owner,
        `## the reboot's own changes (${rows.reboot.length})`, ...rows.reboot,
        `## project changes and the collector's own SSH sessions (${rows.project.length})`, ...rows.project,
        `## ruleset changes since M5's recorded ruleset (${ruleChanges.length}; the guard's proxy-port rule unless listed as unattributed)`, ...ruleChanges.map((r) => r.replace(/\t/g, " ")), ""].join("\n"));
      const ok = unexplained.length === 0 && !!boot(B) && (boot(B) === boot(A) || !!tie) && guardOk && rulesTied && r5.size > 50 && r6.size > 50 && unattributed.length === 0 && ruleChanges.length === 1;
      return { ok, actual: `added=${added.length} removed=${removed.length}; attributed ${JSON.stringify(why)}; unexplained=${unexplained.length}${unexplained.length ? " [" + unexplained.slice(0, 8).join("; ") + "]" : ""}; boot_id_equal=${boot(B) === boot(A)}, reboot tied=${!!tie}; rules changed since M5=${ruleChanges.length}, unattributed=${unattributed.length}${unattributed.length ? " [" + unattributed.slice(0, 6).join("; ") + "]" : ""}; guard is the repository's=${guardOk}; ruleset tied to AFTER=${rulesTied}` };
    } },
  X05: { name: "secret-and-identifier-redaction-scan", inputs: [M0_CONTROL, M1_CONTROL, M3_CONTROL, "scripts/m1/pi-target.conf", "evidence/M0/audit.json"], live: true,
    expected: "the positive controls fire every rule; then no rule matches in any tracked or new repository file; no file holds any live secret (M4's and M5's, every provider file present, the fixture proxy's credential among them, and every client token file on the Pi), compared by SHA-256 computed on the Pi; no file added or changed since M6 began holds the Pi's LAN address, its /24 network or its SSH target",
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
        for f in $S/providers/*; do [ -f "$f" ] && { h "$(tr -d "\\n" < "$f")"; case "$(tr -d "\\n" < "$f")" in *:*) h "$(tr -d "\\n" < "$f" | cut -d: -f2-)";; esac; }; done; for f in $S/clients/*.token; do h "$(tr -d "\\n" < "$f")"; done'`).split("\n").filter((x) => /^[0-9a-f]{64}$/.test(x));
      const tokenFiles = +ssh("sudo -n sh -c 'ls /etc/firecrawl-pi/secrets/clients/*.token | wc -l'").trim();
      const providerFiles = +ssh("sudo -n sh -c 'ls -A /etc/firecrawl-pi/secrets/providers | wc -l'").trim();
      const pairFiles = +ssh("sudo -n sh -c 'grep -l : /etc/firecrawl-pi/secrets/providers/* 2>/dev/null | wc -l'").trim();
      if (tokenFiles < 14 || providerFiles < 1 || hashes.length !== 12 + providerFiles + pairFiles + tokenFiles || new Set(hashes).size !== hashes.length || hashes.includes(sha256(""))) return { ok: false, actual: `expected twelve fixed secrets, ${providerFiles} provider files (${pairFiles} with a password part) and every client token as distinct non-empty hashes; got ${hashes.length} hashes for ${tokenFiles} token files` };
      const files = execFileSync("git", ["-C", ROOT, "ls-files", "--cached", "--others", "--exclude-standard"], { encoding: "utf8" }).split("\n").filter((f) => f && ![M0_CONTROL, M1_CONTROL, M3_CONTROL].includes(f) && has(f) && !/\.(pdf|png|gz)$/.test(f));
      const audit = json("evidence/M0/audit.json");
      const m0 = { egress: audit.network.egress_ip_sha256, serial: audit.identity.board_serial_sha256, machineId: audit.identity.machine_id_sha256, macs: new Set([...Object.values(audit.identity.mac_sha256), sha256("00:00:00:00:00:00")]) };
      const hits = scan(files, { m0, secrets: new Set(hashes) });
      const t = target(), lan = t.PI_LAN_ADDRESS, net = lan.replace(/\.\d+$/, ".0");
      const changed = [...new Set([...git("diff", "--name-only", `${M6_START}..HEAD`).split("\n"), ...git("ls-files", "--others", "--exclude-standard").split("\n")])].filter((f) => f && has(f) && !/\.(pdf|png|gz)$/.test(f));
      const idHits = changed.filter((f) => { const x = read(f); return x.includes(lan) || x.includes(`${net}/`) || x.includes(t.PI_SSH_TARGET); });
      return { ok: hits.length === 0 && idHits.length === 0, configHash: hashOf(files.filter((f) => f !== OUT)), actual: `controls fired all ${RULES.length + HASH_RULES.length} rules; files scanned=${files.length}; live secret hashes compared=${hashes.length} (provider files ${providerFiles}, password parts ${pairFiles}, client tokens ${tokenFiles}); findings=${hits.length}${hits.length ? " [" + hits.slice(0, 12).join("; ") + "]" : ""}; M6 files with the LAN address, network or SSH target=${idHits.join(",") || "none"} (of ${changed.length})` };
    } },
  L03: { name: "lock-and-compose-consistent", inputs: ["deploy/versions.lock.json", "deploy/compose.yaml", `${EV}rendered-compose.json`, "deploy/policies/budget.json", "deploy/policies/egress.json", "deploy/policies/capabilities.json", "patches/series.json"],
    expected: "every Compose image is pinned by digest for linux/arm64 across M6's fourteen services; the lock records the API image and nine-patch series the core runs, the retrieval, gateway and MCP images the stack runs, the budget policy's hash with its rate cards (the proxy cards among them), the egress policy's hash with its residential and routing sections, the guard's hash, the fixture-m6 image, and the capability manifest's hash",
    run() {
      const R = json(`${EV}rendered-compose.json`), L = json("deploy/versions.lock.json"), s = json("patches/series.json"), E = json("deploy/policies/egress.json");
      const unpinned = Object.entries(R.services).filter(([, v]) => !/@sha256:[0-9a-f]{64}$/.test(v.image) || v.platform !== "linux/arm64").map(([k]) => k);
      const cond = { api: L.images?.firecrawl_api_patched?.image_id === digestOf(R.services["firecrawl-core"].image) && L.images.firecrawl_api_patched.patch_series_sha256 === s.series_sha256 && L.patches?.series_sha256 === s.series_sha256 && L.patches.patches.length === 9,
        services: L.images?.retrieval?.image_id === digestOf(R.services["retrieval-service"].image) && L.images?.access_gateway?.image_id === digestOf(R.services["access-gateway"].image) && L.images?.mcp_gateway?.image_id === digestOf(R.services["mcp-gateway"].image),
        budget: L.providers?.budget_policy?.sha256 === sha256File("deploy/policies/budget.json") && same(L.providers.rate_cards, json("deploy/policies/budget.json").rateCards) && L.providers.rate_cards.some((c) => c.subject === "decodo-residential"),
        egress: L.egress?.policy_sha256 === sha256File("deploy/policies/egress.json") && same(L.egress.residential, E.residential) && same(L.egress.routing, E.routing) && L.egress.guard_sha256 === sha256File("deploy/host/fcpi-guard.nft"),
        fixture: L.images?.fixture_m6?.image === R.services["fixture-m6"].image, manifest: L.gateway?.capabilities_sha256 === sha256File("deploy/policies/capabilities.json") };
      return { ok: unpinned.length === 0 && bad(cond).length === 0 && Object.keys(R.services).length === 14, actual: `services=${Object.keys(R.services).length}; unpinned=${unpinned.join(",") || "none"}; lock disagrees on=${bad(cond).join(",") || "none"}` };
    } },

  // ================================================================ the review of record
  V01: { name: "review-record-complete", inputs: [`${EV}review/REVIEW.md`],
    expected: "the saved /review-2 report (CLAUDE.md §5) gives every finding it lists, and every finding found during M6 outside the review (F), a row with an outcome (fixed with its commit, rejected with evidence, deferred to M7 or later), gives every finding an earlier review deferred to M6 (M5's F11) a row of its own with an outcome, cites only commits that exist, and holds no absolute local path",
    run() {
      const text = read(`${EV}review/REVIEW.md`);
      const OUTCOME = /^(Fixed|Rejected, with the evidence|Deferred to M[7-9]\b)/;
      const rows = text.split("\n").filter((l) => /^\| [A-Z]{1,2}\d+ \|/.test(l)).map((l) => l.split(" | "));
      const badRows = rows.filter((c) => !OUTCOME.test(c[3] ?? "")).map((c) => c[0].slice(2));
      const carried = ["M0", "M1", "M2", "M3", "M4", "M5"].flatMap((m) => { const dir = `evidence/${m}/review`;
        return has(dir) ? readdirSync(resolve(ROOT, dir)).filter((f) => f.endsWith(".md")).flatMap((f) => read(`${dir}/${f}`).split("\n").filter((l) => /^\| [A-Z]{1,2}\d+ \|/.test(l) && /\| Deferred to M6\b/.test(l)).map((l) => `${m} ${l.split(" | ")[0].slice(2)}`)) : []; });
      const carriedRows = text.split("\n").filter((l) => /^\| M\d [A-Z]{1,2}\d+ \|/.test(l)).map((l) => l.split(" | "));
      const carriedBad = carried.filter((id) => { const r = carriedRows.find((c) => c[0] === `| ${id}`); return !r || !OUTCOME.test(r[2] ?? ""); });
      const listedIds = [...text.matchAll(/^\s*\d+\. \*\*([CWSF]\d+) —/gm)].map((m) => m[1]);
      const uncovered = listedIds.filter((id) => !rows.some((c) => c[0] === `| ${id}`));
      const uncited = [...rows.filter((c) => /^Fixed/.test(c[3] ?? "")), ...carriedRows.filter((c) => /^Fixed/.test(c[2] ?? ""))].filter((c) => !/`[0-9a-f]{7,40}`/.test(c.join(" | "))).map((c) => c[0].slice(2));
      const commits = [...new Set([...rows, ...carriedRows].flatMap((c) => [...(c.join(" | ")).matchAll(/`([0-9a-f]{7,40})`/g)].map((m) => m[1])))];
      const missing = commits.filter((c) => { try { git("cat-file", "-e", `${c}^{commit}`); return false; } catch { return true; } });
      const local = /\/(private\/tmp|Users\/[^\/\s]+|home\/[^\/\s]+)\//.test(text);
      const ok = rows.length > 0 && carried.length >= 1 && uncovered.length === 0 && uncited.length === 0 && badRows.length === 0 && missing.length === 0 && !local && carriedBad.length === 0;
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
  const rec = { test_id: `M6-${id}`, name: c.name, utc: now(), ...repo, upstream_sha: UPSTREAM_SHA, patch_series_sha256: series.series_sha256, config_or_fixture_hash: null, expected: c.expected,
    evidence_class: ["L01", "L02"].includes(id) ? "live" : "fixture-or-host" };
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
    mcp: digestOf(composeImage("mcp-gateway")), searxng: digestOf(composeImage("searxng")), browser: digestOf(composeImage("browser-worker")), fixture_m6: digestOf(composeImage("fixture-m6")) } : null;
  rec.actual = hideIds(String(rec.actual), target());
  rec.evidence_path = OUT;
  results[rec.test_id] = rec;
  console.log(`${rec.test_id} ${rec.state.padEnd(18)} ${c.name}${rec.state !== "PASS" ? `  — ${rec.actual.slice(0, 260)}` : ""}`);
}
const ordered = listed.map((id) => results[`M6-${id}`] ?? { test_id: `M6-${id}`, name: checks[id].name, state: "NOT_RUN", actual: "never run", evidence_path: OUT });
writeFileSync(resolve(ROOT, OUT), JSON.stringify({ schema: "fcpi.m6.verification/v1", runner: "scripts/m6/verify.mjs",
  repository_sha_note: "Each result records the commit checked out when it ran, with code_dirty; the commit that stores this file is a later one on main. evidence_class separates the live checks (L01, L02) from the fixture and host checks.",
  results: ordered }, null, 2) + "\n");
process.exitCode = ordered.every((r) => r.state === "PASS" || r.state === "BLOCKED_CREDENTIAL") ? 0 : 1;
