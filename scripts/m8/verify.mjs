#!/usr/bin/env node
// M8 verification (docs/FIRECRAWL_PI_MILESTONES.md, M8 "Automated Verification" and "Acceptance Criteria"; spec AC14-AC19,
// AC23; CLAUDE.md §25, §26, §33.3). Every check recomputes its result from the raw evidence under evidence/M8/ (or the
// directory FCPI_M8_EVIDENCE names) and records the §25 tuple, with code_dirty, in its verification.json. A check whose
// evidence is missing is NOT_RUN, never PASS; a check that needs an owner input the record says is absent is
// BLOCKED_CREDENTIAL; every negative result is read beside its positive control in the same evidence; each check's
// `expected` names what it compares, and its comment names an input that would fail it.
//   node scripts/m8/verify.mjs [CHECK_ID …]
import { readFileSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { ROOT, sha256, sha256File, repoState, sections, git, kv } from "../m0/lib.mjs";

const EV = process.env.FCPI_M8_EVIDENCE ?? "evidence/M8/";
const RAW = `${EV}raw/`;
const OUT = `${EV}verification.json`;
const UPSTREAM_SHA = "7666c1f9ae8720a6bba271e0f60b6a217f8a5210";
const M8_START = "19f047f"; // the kickoff's HEAD: files changed after it are M8's
const MIB = 1024 * 1024;
const read = (p) => readFileSync(resolve(ROOT, p), "utf8");
const json = (p) => JSON.parse(read(p));
const has = (p) => existsSync(resolve(ROOT, p));
const now = () => new Date().toISOString().replace(/\.\d+Z$/, "Z");
const hashOf = (paths) => sha256(paths.map((p) => `${p}:${has(p) && !p.endsWith("/") ? sha256File(p) : "dir"}`).join("\n"));
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
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const bad = (cond) => Object.entries(cond).filter(([, v]) => !v).map(([k]) => k);
const tapCounts = (lines) => { const n = (k) => +((lines ?? []).find((l) => l.startsWith(`# ${k} `)) ?? "").split(" ")[2]; return { tests: n("tests"), pass: n("pass"), fail: n("fail") }; };
const pct = (xs, p) => { if (!xs.length) return null; const s = [...xs].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.ceil((p / 100) * s.length) - 1)]; };
const FAULTS = () => records(`${RAW}faults.txt`);
const step = (c, name) => (FAULTS()[c] ?? []).find((r) => r.step === name) ?? null;
const steps = (c) => FAULTS()[c] ?? [];
// A gateway answer the checks accept as typed and retryable: never 502 (a client library resubmits on 502).
const not502 = (r) => r && r.status !== 502;

// ---- redaction (M4's rules and controls, M5-M8's live secrets) ------------------------------------------
const M0_CONTROL = "tests/contracts/m0-redaction-control.txt", M1_CONTROL = "tests/contracts/m1-redaction-control.txt", M3_CONTROL = "tests/contracts/m3-redaction-control.txt", M8_CONTROL = "tests/contracts/m8-redaction-control.txt";
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
  "http://searxng:${pw}@", "sk-test-not-a-real-key-0000000000",
  "password: text.slice", "password: readFileSync",
  "secret = getSecret", "secret: hookSecret", 'SECRET = "fixture-webhook-signing-secret-0123456789', 'password: "unused-with-trust']);
const HASH_RULES = ["raw-egress-ip", "raw-board-serial", "raw-machine-id", "unexplained-mac-hash", "live-secret-by-hash-hex", "live-secret-by-hash-cookie", "live-secret-by-hash-base64"];
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
      // M8: the backup keys are 48 random bytes in base64 (64 characters).
      for (const m of line.match(/(?<![A-Za-z0-9+/])[A-Za-z0-9+/]{64}(?![A-Za-z0-9+/=])/g) ?? []) if (secrets.has(sha256(m))) hits.push(`${at} live-secret-by-hash-base64`);
    }
  });
  return hits;
}

// ---- snapshot attribution (M7's X04 with M8's durable boot records) -------------------------------------
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
  // M8: the project's own units, slice and timers (deploy/host/), installed by scripts/m8/pi-init-m8.sh.
  if (["systemd_running", "systemd_enabled"].includes(sec) && /^fcpi[-.]/.test(line.split(/\s/)[0])) return "M8's project unit, slice or timer (deploy/host/)";
  if (sec === "docker_ps") { const f = line.split("\t"); if (f.length === 4 && /^fcpi-/.test(f[1]) && ids.has(f[0])) return "fcpi container"; }
  if (sec === "findmnt") {
    if (/^\/run\/docker\/netns\/[0-9a-f]+ nsfs\[net:\[\d+\]\] nsfs rw$/.test(line)) return "container network namespace";
    const m = line.match(/^\/var\/lib\/docker\/rootfs\/overlayfs\/([0-9a-f]{64}) overlay overlay /);
    if (m && ids.has(m[1])) return "fcpi container root filesystem";
  }
  if (sec === "lsmod" && MODULE_ALLOW.test(line.split(" ")[0])) return "kernel module for the container runtime or the guard's sets";
  if (sec === "firewall" && /^nft_ruleset_sha256=/.test(line)) return "nftables ruleset: every changed rule attributed in X04 (raw/nft-ruleset.txt)";
  if (sec === "nft_chains" && /^ip6? (filter|nat|raw) (DOCKER[-A-Z0-9]*|FORWARD|PREROUTING|OUTPUT|POSTROUTING) /.test(line)) return "Docker's chains";
  return null;
}
// One reboot record's chain (scripts/m7/pi-reboot-record.sh's format, which the durable boot records keep).
function chainOf(file) {
  if (!has(file)) return null;
  const s = S(file);
  const boots = (s.boots ?? []).map((l) => kv(l.split(" "))).sort((a, b) => +a.idx - +b.idx);
  const cur = kv(((s.current ?? [])[0] ?? "").split(" "));
  const ended = boots.slice(0, -1).map((b) => ({ b, e: kv(((s[`ended_${b.idx.replace("-", "")}`] ?? [])[0] ?? "").split(" ")) }));
  const ends = boots.length >= 1 && boots.at(-1).idx === "0" && boots.at(-1).boot_id_sha256 === cur.boot_id_sha256;
  const ready = kv(((s.readiness ?? [])[0] ?? "").split(" "));
  return { file, first: boots[0]?.boot_id_sha256 ?? null, current: cur.boot_id_sha256 ?? null, kernel: cur.kernel, ends, ended, ready, before_found: kv(s.meta ?? []).before_found };
}
// How one boot ended: an orderly shutdown the owner's Wi-Fi watchdog started after a Wi-Fi loss with no local action after
// it and no undervoltage (M7's rule), or the reboot M8's own driver made (raw/faults.txt names both boots), orderly.
const watchdogEnd = (e) => +e.shutdown_markers > 0 && e.watchdog_reboot === "yes" && /^\d{4}-/.test(e.loss_utc ?? "")
  && ["sudo_commands", "ssh_logins", "sessions", "console_logins", "undervoltage"].every((k) => e[k] === "0");
function drivenReboots() {
  if (!has(`${RAW}faults.txt`)) return [];
  return (FAULTS().reboot ?? []).map((r) => ({ from: r.boot_before, to: r.boot_after }));
}
// The boot records (evidence/M8/reboots/boot-*.txt, made at each boot) joined from bootB to bootA: every hop an ended boot
// that ended as one of the two kinds above. Returns the hops, or null.
function bootChain(bootB, bootA) {
  if (!bootB || !bootA) return null;
  if (bootB === bootA) return [];
  const dir = `${EV}reboots/`;
  const recs = has(dir) ? readdirSync(resolve(ROOT, dir)).filter((f) => /^boot-.*\.txt$/.test(f)).map((f) => chainOf(`${dir}${f}`)).filter((c) => c && c.ends) : [];
  const driven = drivenReboots();
  const hops = [];
  let at = bootB;
  for (let i = 0; i < 50 && at !== bootA; i++) {
    const r = recs.find((c) => c.first === at && c.ended.length >= 1);
    if (!r) return null;
    const e = r.ended[0].e;
    const kind = watchdogEnd(e) ? "watchdog" : (driven.some((d) => d.from === at && d.to === r.current) && +e.shutdown_markers > 0 ? "driven" : null);
    if (!kind) return null;
    hops.push({ from: at, to: r.current, kind, last: r.ended[0].b.last, file: r.file.split("/").pop() });
    at = r.current;
  }
  return at === bootA ? hops : null;
}
function rebootAttribute(sec, line, kind, B, A) {
  const other = kind === "removed" ? A : B;
  const inOther = (pred) => other.some(([s, l]) => s === sec && l !== line && pred(l));
  if (sec === "lsmod") { const n = line.split(" ")[0]; if (inOther((l) => l.split(" ")[0] === n)) return "the reboot: a module in both snapshots, loaded again at boot"; }
  if (sec === "lsmod" && kind === "removed" && /^(inet|tcp|udp|raw|unix|netlink|af_packet)_diag$/.test(line.split(" ")[0])) return "the reboot: a socket-diagnostics module ss loaded on demand in the earlier boot";
  if (sec === "findmnt") { const [t, src, fs] = line.split(" "); if (inOther((l) => { const f = l.split(" "); return f[0] === t && f[1] === src && f[2] === fs; })) return "the reboot: a mount made again at boot, only its options changed"; }
  { const m = line.match(/^udp (?:0\.0\.0\.0|\*):(\d+) users:\(\("([^"]+)",pid,fd\)\)$/);
    if (sec === "ss_listen" && m && +m[1] >= 32768 && inOther((l) => l.startsWith("udp ") && l.includes(`(("${m[2]}",`))) return "the reboot: a service's ephemeral UDP port, chosen again at its start"; }
  if (sec === "systemd_running" && kind === "removed" && /\.service$/.test(line) && !B.concat(A).some(([s, l]) => s === "systemd_enabled" && l === line)) return "the reboot: a unit not enabled at boot, started on demand in the earlier boot";
  return null;
}
// The section-keyed diff of two snapshots, each changed line attributed: to the project, the owner, the collector's own
// SSH sessions, or (when tied) the reboots. Pids and fds in ss lines are normalised, since a restart changes them.
function snapshotDiff(B, A, tied) {
  const psIds = (f) => (read(f).match(/^### docker_ps\n([\s\S]*?)\n### /m)?.[1] ?? "").split("\n").map((l) => l.split("\t")[0]).filter((x) => /^[0-9a-f]{64}$/.test(x));
  const ids = new Set([...psIds(B), ...psIds(A)]);
  const norm = (sec, l) => (sec === "ss_listen" ? l.replace(/pid=\d+,fd=\d+/g, "pid,fd") : l);
  const KP = (f) => keyedSnapshot(f).map(([s, l]) => [s, norm(s, l)]);
  const kb = KP(B), ka = KP(A);
  const b = kb.map(([s, l]) => `${s}\t${l}`), a = ka.map(([s, l]) => `${s}\t${l}`);
  const removed = b.filter((l) => !a.includes(l)), added = a.filter((l) => !b.includes(l));
  const owner = ownerContext();
  const unexplained = [], why = {}, rows = { project: [], owner: [], reboot: [], unrelated: [] };
  for (const [kind, list] of [["removed", removed], ["added", added]]) for (const l of list) {
    const [sec, line] = [l.slice(0, l.indexOf("\t")), l.slice(l.indexOf("\t") + 1)];
    const w = attribute(sec, line, ids, owner) ?? (tied ? rebootAttribute(sec, line, kind, kb, ka) : null);
    const acceptable = w && (kind === "added" || /own SSH session|nftables|fcpi container|container network namespace|scope of an fcpi container|Docker's chains|Pi-hole's own|the owner's editor server|M8's project unit|^the reboot: /.test(w));
    if (!acceptable) unexplained.push(`${kind} ${sec}: ${line.slice(0, 90)}`); else why[w] = (why[w] ?? 0) + 1;
    rows[!acceptable ? "unrelated" : /^the reboot: /.test(w) ? "reboot" : /owner|Pi-hole/.test(w) ? "owner" : "project"].push(`${kind === "added" ? "+" : "-"} ${sec}\t${line}${w ? `\t# ${w}` : ""}`);
  }
  return { added, removed, unexplained, why, rows };
}
const bootOf = (f) => (read(f).match(/^boot_id_sha256=([0-9a-f]{64})$/m) ?? [])[1];

// ---- the soak's records ------------------------------------------------------------------------------------
const SOAK = () => records(`${RAW}soak.txt`);
const soakWindow = () => SOAK().meta?.[0] ?? null;
const svcMap = (s) => Object.fromEntries((s.containers ?? []).filter((c) => c.project === "fcpi").map((c) => [c.service, c]));

// ---- checks ------------------------------------------------------------------------------------------
const checks = {
  // Fails: any line other than SSH session scopes differing between M7's AFTER and M8's BEFORE, unless it is a reboot's
  // and a record ties that reboot (a boot record, or the recorder's chain) as an orderly one.
  B00: { name: "baseline-matches-m7-after", inputs: [`${EV}snapshot-before.txt`, "evidence/M7/snapshot-after.txt", `${EV}reboots/`],
    expected: "M8's BEFORE snapshot equals M7's AFTER apart from SSH session scopes; a changed boot ID only across reboots a record ties as orderly (the owner's Wi-Fi watchdog after a Wi-Fi loss), whose own changes are then attributed",
    run() {
      const [A7, B8] = ["evidence/M7/snapshot-after.txt", `${EV}snapshot-before.txt`];
      const chain = bootChain(bootOf(A7), bootOf(B8));
      const d = snapshotDiff(A7, B8, !!chain);
      const recs = readdirSync(resolve(ROOT, `${EV}reboots/`)).filter((f) => f.endsWith(".txt")).map((f) => chainOf(`${EV}reboots/${f}`));
      const earliest = recs.filter(Boolean).sort((a, b) => a.file.localeCompare(b.file))[0];
      return { ok: d.unexplained.length === 0 && (bootOf(A7) === bootOf(B8) || !!chain),
        actual: `boot changed=${bootOf(A7) !== bootOf(B8)}, tied=${!!chain}; the earliest M8 reboot record (${earliest?.file.split("/").pop() ?? "none"}) found M7 AFTER's boot in the journal=${earliest?.before_found ?? "?"}; added=${d.added.length} removed=${d.removed.length}; attributed ${JSON.stringify(d.why)}; unexplained=${d.unexplained.length}${d.unexplained.length ? " [" + d.unexplained.slice(0, 8).join("; ") + "]" : ""}` };
    } },

  // ================================================================ the images and the suites
  // Fails: an M8 image not built from a clean commit whose service directory is unchanged to HEAD, a running image that is
  // not the Compose file's, or a record naming a deployed commit that differs from HEAD in what the Pi runs.
  G01: { name: "images-built-and-running-deployed-code-is-head", inputs: [`${RAW}image-build.txt`, `${EV}rendered-compose.json`, `${RAW}stack.txt`, "deploy/versions.lock.json", "evidence/M7/raw/api-build.log"],
    expected: "the retrieval and gateway images the stack runs are their last builds on the Pi, each recording the commit it was built from, whose source directories are unchanged to HEAD; the API, MCP and browser images are M7's, their sources (and the patch series) unchanged since the commits that built them; every deployed commit a record names differs from HEAD in nothing the Pi runs",
    run() {
      const build = read(`${RAW}image-build.txt`), st = S(`${RAW}stack.txt`), L = json("deploy/versions.lock.json");
      const running = (s) => (st.containers ?? []).find((l) => l.startsWith(`${s} `))?.match(/ image=(sha256:[0-9a-f]{64}) /)?.[1];
      const last = (i) => [...build.matchAll(new RegExp(`^fcpi/${i}:m8 id=(sha256:[0-9a-f]{64}) os=linux arch=arm64 size=\\d+ user=(\\S+)$`, "gm"))].at(-1);
      const builtFrom = (i) => [...build.matchAll(new RegExp(`^fcpi/${i}:m8 FCPI_SOURCE_COMMIT=([0-9a-f]{40})$`, "gm"))].at(-1)?.[1];
      const dirSame = (c, ...d) => { try { git("diff", "--quiet", c, "HEAD", "--", ...d); return true; } catch { return false; } };
      const runsSame = (c) => { try { git("diff", "--quiet", c, "HEAD", "--", "services", "deploy", "scripts", "tests", "patches", ":(exclude)deploy/versions.lock.json"); return true; } catch { return false; } };
      const apiCommit = (read("evidence/M7/raw/api-build.log").match(/^repository_commit=([0-9a-f]{40}) code_dirty=false$/m) ?? [])[1];
      const metas = ["faults.txt", "soak.txt", "heap.txt", "backup-fixture.txt", "rehearsal.txt"].filter((f) => has(`${RAW}${f}`))
        .flatMap((f) => [...read(`${RAW}${f}`).matchAll(/(?:source_commit|deployed_commit|"commit")[=":]+"?([0-9a-f]{40})/g)].map((m) => m[1]));
      const deployed = [...new Set([kv(st.meta ?? []).source_commit, ...metas].filter(Boolean))];
      const cond = { deployed_code_is_head: deployed.length >= 1 && deployed.every(runsSame),
        api: running("firecrawl-core") === L.images.firecrawl_api_patched.image_id && digestOf(composeImage("firecrawl-core")) === L.images.firecrawl_api_patched.image_id && !!apiCommit && dirSame(apiCommit, "patches"),
        mcp: running("mcp-gateway") === L.images.mcp_gateway.image_id && dirSame(L.images.mcp_gateway.built_from_commit, "services/mcp"),
        browser: running("browser-worker") === L.images.browser_worker.image_id && dirSame(L.images.browser_worker.built_from_commit, "services/browser", "deploy/browser") };
      for (const [svc, img, dirs, uid] of [["retrieval-service", "retrieval", ["services/retrieval"], "3310:3310"], ["access-gateway", "access-gateway", ["services/access"], "3380:3380"]]) {
        const l = last(img), c = builtFrom(img);
        cond[`${img}_built_runs_unchanged`] = !!l && l[2] === uid && running(svc) === l[1] && digestOf(composeImage(svc)) === l[1] && !!c && dirSame(c, ...dirs);
      }
      return { ok: bad(cond).length === 0, actual: `failed=${bad(cond).join(",") || "none"}; deployed commits=${deployed.map((c) => c.slice(0, 7)).join(",")}; retrieval ${last("retrieval")?.[1].slice(7, 19)} from ${builtFrom("retrieval")?.slice(0, 7)}, gateway ${last("access-gateway")?.[1].slice(7, 19)} from ${builtFrom("access-gateway")?.slice(0, 7)}` };
    } },
  // Fails: a failing or skipped test, fewer tests than the suites hold, a bash script that does not parse, a leftover
  // throwaway container.
  G02: { name: "suites-pass-in-the-running-images", inputs: [`${RAW}suites.txt`, `${EV}rendered-compose.json`],
    expected: "inside the images the stack runs: the retrieval service's suite with M8's host-admission tests among its tests (at least 170, none skipped or failing), the gateway ledger SQL, the gateway's suites, the MCP service's, M3's contract suite with M8's HOST_PRESSURE test (43), M4's /mcp contract suite and the grammars; every host operations script parses; no throwaway container or network is left",
    run() {
      const s = S(`${RAW}suites.txt`), m = kv((s.meta ?? [""])[0].split(" "));
      const t = (k) => tapCounts(s[k]), exit0 = (k) => (s[k] ?? []).includes("test_exit=0");
      const skipped = +(((s.retrieval_tap ?? []).find((l) => l.startsWith("# skipped ")) ?? "# skipped 1").split(" ")[2]);
      const m8 = ["a paused browser ends the browser attempt as RESOURCE_BUSY before any render; open, the same page renders", "a stale, future-dated or unreadable file is open, so a stopped tick cannot stop the platform"]
        .every((x) => (s.retrieval_tap ?? []).some((l) => l.startsWith("ok ") && l.includes(x)));
      const hp = (s.gateway_contract_tap ?? []).some((l) => l.startsWith("ok ") && l.includes("M8: while the host holds dispatch"));
      const ops = kv((s.ops_syntax ?? []).filter((l) => /^files=/.test(l)).flatMap((l) => l.split(" ")));
      const tr = kv((s.transient ?? []).flatMap((l) => l.split(" ")));
      const cond = { images: m.retrieval_image === composeImage("retrieval-service") && m.gateway_image === composeImage("access-gateway") && m.mcp_image === composeImage("mcp-gateway"),
        retrieval: t("retrieval_tap").tests >= 170 && t("retrieval_tap").fail === 0 && skipped === 0 && exit0("retrieval_tap"), m8_retrieval_tests: m8,
        ledger: t("ledger_tap").tests === 6 && t("ledger_tap").pass === 6 && exit0("ledger_tap"),
        gateway_m7: t("gateway_m7_tap").tests >= 28 && t("gateway_m7_tap").fail === 0 && exit0("gateway_m7_tap"),
        mcp: t("mcp_tap").tests >= 42 && t("mcp_tap").fail === 0 && exit0("mcp_tap"), gateway_unit: t("gateway_unit_tap").tests >= 30 && t("gateway_unit_tap").fail === 0 && exit0("gateway_unit_tap"),
        m3_contract: t("gateway_contract_tap").tests === 43 && t("gateway_contract_tap").pass === 43 && exit0("gateway_contract_tap") && hp,
        m4_contract: t("gateway_mcp_contract_tap").tests >= 3 && t("gateway_mcp_contract_tap").fail === 0 && exit0("gateway_mcp_contract_tap"),
        grammars: t("grammars_tap").tests >= 3 && t("grammars_tap").fail === 0, ops_syntax: +ops.files >= 20 && ops.failed === "0" && exit0("ops_syntax"),
        no_leftovers: tr.leftover_transient_containers === "0" && tr.leftover_transient_networks === "0" };
      return { ok: bad(cond).length === 0, actual: `failed=${bad(cond).join(",") || "none"}; retrieval ${t("retrieval_tap").pass}/${t("retrieval_tap").tests} (skipped ${skipped}), ledger ${t("ledger_tap").pass}/${t("ledger_tap").tests}, gateway-m7 ${t("gateway_m7_tap").pass}/${t("gateway_m7_tap").tests}, mcp ${t("mcp_tap").pass}/${t("mcp_tap").tests}, gateway unit ${t("gateway_unit_tap").pass}/${t("gateway_unit_tap").tests}, M3 contract ${t("gateway_contract_tap").pass}/${t("gateway_contract_tap").tests}, ops scripts ${ops.files} parsed, ${ops.failed} failed` };
    } },

  // ================================================================ the host (lifecycle, F2, R12, F13)
  // Fails: any fcpi verify ops check failing (a unit that is not the deployed one, a timer not active, a container outside
  // fcpi.slice, a stale tick), restic not at the pinned version, or the slice's swap limit not 0.
  H01: { name: "host-units-timers-slice-and-command", inputs: [`${RAW}init-m8.txt`, `${RAW}verify-ops.txt`],
    expected: "restic is Debian's 0.18.0-1+b4; fcpi.slice holds MemorySwapMax=0 and memory.swap.max 0; every project unit, timer and the tmpfiles entry is the deployed one, enabled and active; every fcpi container runs under fcpi.slice with swap denied; no container outside the project; the tick, the admission file and the probe are fresh; fcpi verify ops passes every check at the window's close",
    run() {
      const i = S(`${RAW}init-m8.txt`), v = read(`${RAW}verify-ops.txt`).split("\n");
      const rk = kv(((i.restic ?? []).find((l) => l.startsWith("restic_package=")) ?? "").split(" "));
      const slice = kv(((i.units ?? []).find((l) => l.startsWith("fcpi.slice ")) ?? "").split(" ").slice(1));
      const rows = v.filter((l) => /^  (PASS|FAIL) {2}/.test(l)).map((l) => l.trim().split(/\s{2,}/));
      const want = ["data_check", "guard_loaded", "docker_dropins", "units_installed", "units_enabled_active", "slice_swap_zero", "containers_in_slice", "containers_swap_denied", "no_foreign_containers", "tick_fresh", "admission_fresh", "probe_recent_ok", "nm_unmanaged"];
      const cond = { restic: rk.restic_package === "0.18.0-1+b4" && /^[0-9a-f]{64}$/.test(rk.restic_sha256 ?? ""), slice: slice.MemorySwapMax === "0" && slice["memory.swap.max"] === "0",
        verify_ops: /^ops PASS /.test(v[0] ?? "") && want.every((w) => rows.some((r) => r[0] === "PASS" && r[1] === w)) && !rows.some((r) => r[0] === "FAIL") };
      return { ok: bad(cond).length === 0, actual: `failed=${bad(cond).join(",") || "none"}; restic ${rk.restic_package}; ${v[0]}; failing: ${rows.filter((r) => r[0] !== "PASS").map((r) => r[1]).join(",") || "none"}` };
    } },
  // Fails: a scope's swap limit not lifted by the reload (the positive control: F2's cause did happen), any container left
  // able to swap, the slice's limit not 0, or a memory limit lifted.
  H02: { name: "swap-denied-across-a-systemd-reload", inputs: [`${RAW}faults.txt`],
    // The positive control is F2's lift itself, observed on the running stack: container scopes whose memory.swap.max stands
    // at max although Compose set it to 0. What lifts them is not pinned (REVIEW.md F9); the slice does not depend on it.
    expected: "on the running stack at least one container scope's memory.swap.max has been lifted to max (M4's F2, the positive control) while fcpi.slice's stays 0 as its unit says; across a systemctl daemon-reload every container's effective swap stays denied; every scope's memory.max is unchanged",
    run() {
      const r = step("swap_reload", "reload");
      if (!r) return { ok: false, actual: "no swap_reload record" };
      const parse = (s) => Object.fromEntries(s.split(";").filter(Boolean).map((x) => { const [n, swap, mem] = x.trim().split(" "); return [`${swap} ${mem}`, +n]; }));
      const b = parse(r.scope_swap_and_memory_max_before), a = parse(r.after);
      const memB = Object.keys(b).map((k) => k.split(" ")[1]).sort(), memA = Object.keys(a).map((k) => k.split(" ")[1]).sort();
      const n = r.effective.containers;
      const cond = { control_lifted: [...Object.keys(b), ...Object.keys(a)].some((k) => k.startsWith("max ")),
        slice: r.slice_swap_max === "0" && r.slice_property === "0", effective: n >= 15 && r.effective.swap_allowed === 0 && r.effective_before?.swap_allowed === 0, memory_unchanged: same([...new Set(memB)], [...new Set(memA)]) };
      return { ok: bad(cond).length === 0, actual: `failed=${bad(cond).join(",") || "none"}; recreated scope ${r.recreated_scope_before}→${r.recreated_scope_after}; scopes before ${r.scope_swap_and_memory_max_before} after ${r.after}; slice ${r.slice_swap_max} (${r.slice_property}); effective ${JSON.stringify(r.effective)}` };
    } },
  // Fails: a container outside the project not named by the tick, fcpi foreign or fcpi status, more than one notice for
  // it, or a report left after it is removed.
  H03: { name: "containers-outside-the-project-reported", inputs: [`${RAW}faults.txt`, `${RAW}verify-ops.txt`],
    expected: "with a container outside Compose project fcpi running, the tick opens foreign_container once, fcpi foreign and fcpi status name it; once it is removed, both report none; the window's close finds none (M1 R12)",
    run() {
      const d = step("foreign_container", "detected"), c = step("foreign_container", "cleared");
      const cond = { detected: !!d && /fcpi-m8-foreign-probe/.test(d.fcpi_foreign) && same(d.status_foreign, ["fcpi-m8-foreign-probe"]) && d.opened_notices === 1,
        cleared: !!c && c.fcpi_foreign === "foreign: none" && same(c.status_foreign, []) && c.notices_since === 2,
        close: read(`${RAW}verify-ops.txt`).split("\n").some((l) => /^  PASS  no_foreign_containers /.test(l)) };
      return { ok: bad(cond).length === 0, actual: `failed=${bad(cond).join(",") || "none"}; detected ${JSON.stringify(d)}; cleared ${JSON.stringify(c)}` };
    } },
  // Fails: a boot in the window (the snapshots', the reboot test's, any watchdog reboot) without its own durable record, a
  // record whose ended boot is missing, or two records for one boot.
  H04: { name: "durable-boot-records", inputs: [`${EV}reboots/`, `${EV}snapshot-before.txt`, `${EV}snapshot-after.txt`],
    expected: "every boot after the first M8 install (the reboot test's among them, and any the owner's watchdog made) has its own record, made at that boot by fcpi-boot-record.service, holding the boot that ended (its last entry, shutdown markers, the watchdog's steps) and this boot's readiness, one file per boot, never rewritten (M7 F13)",
    run() {
      const dir = `${EV}reboots/`;
      const files = readdirSync(resolve(ROOT, dir)).filter((f) => /^boot-\d{8}T\d{6}Z-[0-9a-f]{12}\.txt$/.test(f));
      const recs = files.map((f) => chainOf(`${dir}${f}`));
      const perBoot = new Map(); for (const r of recs) perBoot.set(r.current, (perBoot.get(r.current) ?? 0) + 1);
      const driven = drivenReboots();
      const need = [...new Set([...driven.map((d) => d.to), bootOf(`${EV}snapshot-after.txt`)])].filter((b) => b && b !== bootOf(`${EV}snapshot-before.txt`));
      const cond = { records: recs.length >= 1 && recs.every((r) => r.ends && r.ended.length >= 1 && r.ready.ready_after_boot_s !== undefined),
        one_per_boot: [...perBoot.values()].every((n) => n === 1), every_boot_recorded: need.every((b) => perBoot.has(b)),
        named_by_boot: files.every((f) => recs.find((r) => r.file.endsWith(f))?.current?.startsWith(f.slice(22, 34))) };
      return { ok: bad(cond).length === 0, actual: `failed=${bad(cond).join(",") || "none"}; records=${files.join(",")}; boots needing one=${need.map((b) => b.slice(0, 12)).join(",")}` };
    } },

  // ================================================================ restart and recovery (AC15)
  // Fails: readiness past five minutes, a boot record without its readiness line, a stack not healthy after, swap allowed.
  R01: { name: "normal-reboot-ready-within-five-minutes", inputs: [`${RAW}faults.txt`, `${EV}reboots/`],
    expected: "after an orderly systemctl reboot and no SSH action on the Pi until it was ready, the new boot's own record (fcpi-boot-record.service) shows the stack active and REST, MCP and a fixture scrape answering within 300 s of kernel start; the ended boot shows its shutdown markers; fcpi status is healthy afterwards with swap denied to every container",
    run() {
      const r = FAULTS().reboot?.[0];
      if (!r) return { ok: false, actual: "no reboot record" };
      const f = r.record_file ? `${EV}reboots/boot-${r.record_file}` : null;
      const c = f && has(f) ? chainOf(f) : null;
      const ready = +(c?.ready.ready_after_boot_s ?? NaN);
      const e = c?.ended?.[0]?.e ?? {};
      const cond = { new_boot: r.boot_after !== r.boot_before, record_kept: !!c && c.current === r.boot_after && c.first === r.boot_before,
        ready_in_five_minutes: Number.isFinite(ready) && ready <= 300, orderly: +e.shutdown_markers > 0, healthy_after: r.status_after?.healthy === true && r.status_after?.mcp?.ready === true,
        swap: Object.values(r.status_after?.services ?? {}).every((s) => s.swap_denied !== false) };
      return { ok: bad(cond).length === 0, actual: `failed=${bad(cond).join(",") || "none"}; ssh back after ${r.ssh_back_after_s} s; ${JSON.stringify(c?.ready ?? {})}; ended boot ${JSON.stringify(e)}` };
    } },
  R02: { name: "docker-restart-recovers-without-action", inputs: [`${RAW}faults.txt`],
    expected: "a dockerd restart (containers stopped and revived by their restart policies) is healthy again, REST and MCP ready, within 300 s, fcpi-stack.service still active; a crawl acknowledged just before reaches a terminal state with its receipt kept; swap denied to every container afterwards",
    run() {
      const s = step("docker_restart", "ready"), j = step("docker_restart", "job_after"), sub = step("docker_restart", "submitted"), b = step("docker_restart", "before");
      const cond = { control: b?.status?.healthy === true, submitted: sub?.call?.status === 200 && !!sub.job, ready: !!s && s.restart_exit === 0 && s.ready_after_s >= 0 && s.ready_after_s <= 300 && s.status.healthy,
        unit: s?.stack_unit === "active", job: /^(SUCCEEDED|PARTIAL|FAILED)$/.test(j?.job?.state ?? ""), swap: s?.swap?.swap_allowed === 0 && s?.swap?.containers >= 15 };
      return { ok: bad(cond).length === 0, actual: `failed=${bad(cond).join(",") || "none"}; ready after ${s?.ready_after_s} s; job ${JSON.stringify(j?.job)}` };
    } },
  // Fails: dockerd running or the stack started with the data filesystem absent, anything written to the empty mount point,
  // or no recovery with the data ID unchanged once the filesystem is back.
  R03: { name: "missing-data-mount-refuses-writers", inputs: [`${RAW}faults.txt`],
    expected: "with an empty tmpfs mounted over the data directory (a missing data filesystem), dockerd's gated start fails through its start limit and fcpi-stack.service fails, the data check logs its refusal, no dockerd runs, and nothing is written to the empty mount point; with the filesystem back the stack is ready without other action, its data ID unchanged and swap denied (M1 R13 observed through the start limit)",
    run() {
      const r = step("missing_mount", "refused"), v = step("missing_mount", "recovered");
      const d = kv((r?.docker ?? "").split(" "));
      const cond = { dockerd_refused: !!r && r.docker_start_exit !== 0 && d.ActiveState !== "active" && r.dockerd_processes === 0, stack_refused: r?.stack_start_exit !== 0,
        logged: r?.data_check_failures_logged >= 1, no_shadow: r?.shadow_entries === 0, recovered: !!v && v.ready_after_s >= 0 && v.ready_after_s <= 600 && v.data_id_unchanged === true && v.status.healthy,
        swap: v?.swap?.swap_allowed === 0 };
      return { ok: bad(cond).length === 0, actual: `failed=${bad(cond).join(",") || "none"}; ${JSON.stringify(r)}; recovered ${JSON.stringify({ ready_after_s: v?.ready_after_s, data_id_unchanged: v?.data_id_unchanged })}` };
    } },

  // ================================================================ injected failures (spec §24.2, AC15, AC17, AC23)
  I01: { name: "mcp-crash-restarts-mcp-alone", inputs: [`${RAW}faults.txt`],
    expected: "an MCP process killed by SIGKILL is restarted by its restart policy alone; REST serves a fixture scrape while it is down; afterwards a new MCP request reads a crawl by the job handle it was given before the crash",
    run() {
      const s = step("mcp_crash", "submitted"), d = step("mcp_crash", "rest_during"), a = step("mcp_crash", "mcp_after");
      const cond = { control: s?.call?.status === 200 && !!s.job, rest: d?.status === 200 && d.sentinel === true, back: !!a && a.back_after_s >= 0 && a.back_after_s <= 180 && a.restarts_delta === 1,
        handle: a?.handle_call_status === 200 && a.handle_call_ok === true };
      return { ok: bad(cond).length === 0, actual: `failed=${bad(cond).join(",") || "none"}; ${JSON.stringify(a)}` };
    } },
  I02: { name: "api-child-crash-recovers-typed", inputs: [`${RAW}faults.txt`],
    expected: "the core's API child killed by SIGKILL: fcpi status shows the API down, the gateway answers a scrape with a typed status, never 502; the core is healthy again within 600 s; a crawl acknowledged before reaches a terminal state with its receipt kept",
    run() {
      const d = step("api_child_crash", "rest_during"), x = step("api_child_crash", "detected"), r = step("api_child_crash", "recovered"), j = step("api_child_crash", "job_after");
      const cond = { typed: not502(d) && (d.status === 200 || d.status === 503 || d.status === 504), detected: x?.api_down_seen_after_s >= 0 && x.status.api === false,
        recovered: r?.ready_after_s >= 0 && r.ready_after_s <= 600, job: /^(SUCCEEDED|PARTIAL|FAILED)$/.test(j?.job?.state ?? "") };
      return { ok: bad(cond).length === 0, actual: `failed=${bad(cond).join(",") || "none"}; during ${JSON.stringify(d)}; ${JSON.stringify(r)}; job ${JSON.stringify(j?.job)}` };
    } },
  I03: { name: "worker-death-shown-as-degraded-and-recovered", inputs: [`${RAW}faults.txt`],
    expected: "the NuQ worker hung (SIGSTOP): fcpi status shows the worker down while the API is still live (a live API with a dead worker is degraded, not healthy); the supervisor restarts the core once Docker marks it unhealthy, and it is ready within 600 s; a new crawl completes",
    run() {
      const x = step("worker_child_crash", "detected"), r = step("worker_child_crash", "recovered"), j = step("worker_child_crash", "job_after");
      const cond = { independent: x?.worker_down_seen_after_s >= 0 && x.status.worker === false && x.status.api === true && x.status.healthy === false,
        recovered: r?.ready_after_s >= 0 && r.ready_after_s <= 600 && r.status.healthy && r.supervisor_restarts >= 1, job: j?.job?.state === "SUCCEEDED" };
      return { ok: bad(cond).length === 0, actual: `failed=${bad(cond).join(",") || "none"}; detected ${JSON.stringify(x?.status)}; ${JSON.stringify({ ready_after_s: r?.ready_after_s, restarts: r?.container_restarts_delta })}` };
    } },
  I04: { name: "postgres-down-fails-closed-and-reconciles", inputs: [`${RAW}faults.txt`],
    expected: "with PostgreSQL stopped: a crawl submission is refused with a typed 503 and nothing acknowledged, never 502; the gateway's status route still answers with the ledger down; fcpi status names the ledger and the database; after it starts, the same idempotency key is accepted once and a second submission returns the same job, which completes",
    run() {
      const s = step("postgres_down", "submit_during"), sc = step("postgres_down", "scrape_during"), p = step("postgres_down", "platform_status_during"), st = step("postgres_down", "status_during"),
        r = step("postgres_down", "recovered"), i = step("postgres_down", "idempotent"), j = step("postgres_down", "job_after");
      const cond = { control: step("postgres_down", "before")?.status?.healthy === true, fail_closed: s?.status === 503 && not502(sc), liveness: p?.status === 200 && p.ledger_ok === false,
        detected: st?.status?.ledger === false && st.status.not_healthy.includes("nuq-postgres"), recovered: r?.ready_after_s >= 0 && r.ready_after_s <= 600,
        idempotent: i?.same === true, job: j?.job?.state === "SUCCEEDED" };
      return { ok: bad(cond).length === 0, actual: `failed=${bad(cond).join(",") || "none"}; submit ${JSON.stringify(s)}; scrape ${JSON.stringify(sc)}; idempotent ${JSON.stringify(i)}` };
    } },
  ...Object.fromEntries([["I05", "redis"], ["I06", "rabbitmq"]].map(([id, svc]) => [id, { name: `${svc}-down-stops-dispatch-and-recovers`, inputs: [`${RAW}faults.txt`],
    expected: `with ${svc} stopped: requests that need it get typed answers, never 502; fcpi status names ${svc}; after it starts the stack is ready within 600 s, a crawl submitted during the outage reaches a terminal state with its receipt kept, and a fixture scrape succeeds`,
    run() {
      const c = `${svc}_down`, s = step(c, "submit_during"), sc = step(c, "scrape_during"), st = step(c, "status_during"), r = step(c, "recovered"), j = step(c, "job_after"), a = step(c, "static_after");
      const cond = { control: step(c, "before")?.status?.healthy === true, typed: not502(s) && not502(sc), detected: (st?.status?.not_healthy ?? []).includes(svc),
        recovered: r?.ready_after_s >= 0 && r.ready_after_s <= 600, job: !s?.job || /^(SUCCEEDED|PARTIAL|FAILED)$/.test(j?.job?.state ?? ""), after: a?.status === 200 && a.sentinel === true };
      return { ok: bad(cond).length === 0, actual: `failed=${bad(cond).join(",") || "none"}; submit ${JSON.stringify(s)}; scrape ${JSON.stringify(sc)}; job ${JSON.stringify(j?.job)}` };
    } }])),
  I07: { name: "browser-crash-contained", inputs: [`${RAW}faults.txt`],
    expected: "Chromium killed during a render: the render's answer is a typed failure, never 502; no browser permit is left held and no Chromium process is left; while the worker relaunches its browser any refusal is typed and retryable, and a script-rendered page renders within a minute; the data services stay healthy",
    run() {
      const k = step("browser_crash", "render_killed"), n = step("browser_crash", "next_render");
      const cond = { killed: k?.chrome_processes_killed >= 1 && !/^502 /.test(k.answer), permits: n?.browser_permits_held === "0", processes: n?.chrome_left_before_next === "0",
        next: n?.status === 200 && n.sentinel === true && n.served_after_s <= 60 && (n.refusals_before ?? []).every((r) => r.status !== 502 && r.class),
        data_services: !(n?.host?.not_healthy ?? ["?"]).some((s) => ["nuq-postgres", "redis", "rabbitmq"].includes(s)) };
      return { ok: bad(cond).length === 0, actual: `failed=${bad(cond).join(",") || "none"}; killed ${JSON.stringify(k)}; next ${JSON.stringify({ status: n?.status, sentinel: n?.sentinel, permits: n?.browser_permits_held, left: n?.chrome_left_before_next, tries: n?.tries, served_after_s: n?.served_after_s, refusals: n?.refusals_before })}` };
    } },
  I08: { name: "search-outage-isolated-and-not-resurrected", inputs: [`${RAW}faults.txt`],
    expected: "with SearXNG stopped: search answers a typed failure, not an empty success, never 502; scrape, map and crawl still work; the supervisor does not start the stopped service (three ticks later it is still exited) and fcpi status shows search not ready while the core is; started again, search returns results",
    run() {
      const s = step("searxng_down", "search_during"), sc = step("searxng_down", "scrape_during"), m = step("searxng_down", "map_during"), n = step("searxng_down", "not_resurrected"), a = step("searxng_down", "search_after");
      const cond = { typed: !!s && s.status !== 200 && not502(s), others: sc?.status === 200 && sc.sentinel && m?.status === 200 && m.links >= 5 && n?.crawl?.state === "SUCCEEDED",
        not_resurrected: /^exited/.test(n?.searxng_state ?? "") && n.status.search === false && n.status.api === true, after: a?.status === 200 && a.results > 20 };
      return { ok: bad(cond).length === 0, actual: `failed=${bad(cond).join(",") || "none"}; search ${JSON.stringify(s)}; searxng ${n?.searxng_state}; after ${JSON.stringify(a)}` };
    } },
  I09: { name: "proxy-outage-never-spills-to-the-home-ip", inputs: [`${RAW}faults.txt`],
    expected: "with the residential route selected and its proxy down: a bulk crawl of the M3 site (past the bulk mark) is refused PROXY_REQUIRED at submission, or runs only residential attempts that fail as the proxy's failures, with no direct attempt to its domain and no page archived; a low-risk fixture scrape goes on directly",
    run() {
      const b = step("proxy_down", "bulk_submit"), j = step("proxy_down", "bulk_job"), e = step("proxy_down", "bulk_errors"), l = step("proxy_down", "low_risk_during");
      const proxyFailures = (e?.classes ?? []).length >= 1 && e.classes.every((c) => /^(PROXY_|RESIDENTIAL_)/.test(c));
      const cond = { refused_or_failed_on_the_proxy: b?.code === "PROXY_REQUIRED" || (j?.job?.archived === 0 && proxyFailures && +l?.bulk_residential_attempts >= 1),
        no_spill: l?.bulk_direct_attempts === "0", low_risk: l?.status === 200 && l.sentinel === true, not502: not502(b) };
      return { ok: bad(cond).length === 0, actual: `failed=${bad(cond).join(",") || "none"}; bulk ${JSON.stringify(b)} ${JSON.stringify(j?.job ?? null)} errors ${JSON.stringify(e)}; direct attempts ${l?.bulk_direct_attempts}, residential ${l?.bulk_residential_attempts}` };
    } },
  I10: { name: "model-parser-enhanced-outage-isolated", inputs: [`${RAW}faults.txt`],
    expected: "with the fixture model, parser and enhanced provider down: extraction and a scan-only PDF answer typed failures, never 502; an ordinary scrape and a crawl are unaffected; with them back, extraction succeeds",
    run() {
      const e = step("providers_down", "extract_during"), p = step("providers_down", "parse_during"), s = step("providers_down", "scrape_during"), c = step("providers_down", "crawl_during"), a = step("providers_down", "extract_after");
      const cond = { typed: !!e && e.status !== 200 && not502(e) && !!p && not502(p), ordinary: s?.status === 200 && s.sentinel === true && c?.job?.state === "SUCCEEDED", after: a?.status === 200 };
      return { ok: bad(cond).length === 0, actual: `failed=${bad(cond).join(",") || "none"}; extract ${JSON.stringify(e)}; parse ${JSON.stringify(p)}; after ${JSON.stringify(a)}` };
    } },
  I11: { name: "network-outage-bounded-and-recovered-without-restart", inputs: [`${RAW}faults.txt`],
    expected: "with the retrieval service's egress network disconnected (no Internet and no DNS for it): a public URL fails typed, never 502, and teaches its domain nothing hostile; fixture work and the status route go on; reconnected, name resolution works again with no restart of the service",
    run() {
      const p = step("egress_down", "public_during"), f = step("egress_down", "fixture_during"), s = step("egress_down", "status_route_during"), r = step("egress_down", "recovered"), a = step("egress_down", "fixture_after");
      const learned = (r?.domain_route_example ?? "none").split("|");
      const cond = { typed: !!p && p.status !== 200 && not502(p), no_hostile_learning: learned[0] === "none" || (learned[0] !== "residential" && learned[1] === "0"),
        fixture: f?.status === 200 && f.sentinel && s?.status === 200, recovered: r?.dns_after === "true" && r.restarts_delta === 0 && r.restarted === false && a?.status === 200 };
      return { ok: bad(cond).length === 0, actual: `failed=${bad(cond).join(",") || "none"}; public ${JSON.stringify(p)}; route ${r?.domain_route_example}; dns after ${r?.dns_after}` };
    } },
  I12: { name: "disk-pressure-stops-admission-and-deletes-nothing", inputs: [`${RAW}faults.txt`],
    expected: "with the data filesystem at its critical mark (under 2 GiB free, by an fallocated file): new work is refused 503 HOST_PRESSURE while reads answer; disk_critical opens once; PostgreSQL stays ready; no document row or result file is deleted; with the space back, admission reopens, the incident clears once, and a scrape succeeds",
    run() {
      const s = step("disk_pressure", "scrape_during"), rd = step("disk_pressure", "read_during"), st = step("disk_pressure", "state_during"), r = step("disk_pressure", "recovered");
      const cond = { refused: s?.status === 503 && s.code === "HOST_PRESSURE", reads: rd?.status === 200, paused: st?.status?.admission?.dispatch === "paused" && (st.status.admission.reasons ?? []).includes("disk") && st.free < 2 * 1024 * MIB,
        one_notice: st?.opened_notices === 1, intact: !!r && r.postgres_ready && r.documents_after >= r.documents_before && r.files_after >= r.files_before,
        recovered: r?.scrape?.status === 200 && r.status.admission.dispatch === "open" && r.disk_critical_notices === 2 };
      return { ok: bad(cond).length === 0, actual: `failed=${bad(cond).join(",") || "none"}; during ${JSON.stringify(s)} free ${st?.free}; notices ${st?.opened_notices}/${r?.disk_critical_notices}` };
    } },
  I13: { name: "memory-pressure-pauses-and-nothing-of-the-project-is-killed", inputs: [`${RAW}faults.txt`],
    expected: "with available memory pushed under 1 GiB by a capped throwaway allocator: new work is refused 503 HOST_PRESSURE, browser work is paused, memory_low opens once after a minute; no project container records an OOM kill and the data services stay healthy; with the allocator gone, admission reopens, the incident clears once, and a scrape succeeds",
    run() {
      const s = step("memory_pressure", "scrape_during"), st = step("memory_pressure", "state_during"), r = step("memory_pressure", "recovered");
      const cond = { low: s?.low_after_s >= 0, refused: s?.status === 503 && s.code === "HOST_PRESSURE", paused: st?.status?.admission?.dispatch === "paused" && st.status.admission.browser === "paused" && (st.status.admission.reasons ?? []).includes("memory"),
        one_notice: st?.opened_notices === 1, no_oom: r?.fcpi_oom_kills === 0, data_services: !(st?.status?.not_healthy ?? ["?"]).some((x) => ["nuq-postgres", "redis", "rabbitmq"].includes(x)),
        recovered: r?.scrape?.status === 200 && r.status.admission.dispatch === "open" && r.memory_low_notices === 2 };
      return { ok: bad(cond).length === 0, actual: `failed=${bad(cond).join(",") || "none"}; during ${JSON.stringify(s)}; available ${st?.available_mib} MiB; oom ${r?.fcpi_oom_kills}; notices ${st?.opened_notices}/${r?.memory_low_notices}` };
    } },
  I14: { name: "thermal-pressure-pauses-browser-work-only", inputs: [`${RAW}faults.txt`],
    expected: "with an injected 76 °C reading (a test input the tick records as injected; the sensor itself is not heated): the browser tier is refused RESOURCE_BUSY while a static scrape succeeds and dispatch stays open; temperature_high opens; at 69 °C for two samples the browser resumes, a script-rendered page renders, and the incident clears once",
    run() {
      const j = step("thermal_pressure", "js_during"), s = step("thermal_pressure", "static_during"), st = step("thermal_pressure", "state_during"), a = step("thermal_pressure", "js_after");
      const cond = { browser_refused: !!j && j.status !== 200 && not502(j) && /RESOURCE_BUSY/.test(`${j.class} ${j.error}`), static_ok: s?.status === 200 && s.sentinel === true,
        paused: st?.status?.admission?.browser === "paused" && st.status.admission.dispatch === "open" && (st.status.admission.reasons ?? []).includes("thermal"),
        resumed: a?.status === 200 && a.sentinel === true && a.host?.admission?.browser === "open", notices: a?.temperature_notices === 2 };
      return { ok: bad(cond).length === 0, actual: `failed=${bad(cond).join(",") || "none"}; js during ${JSON.stringify(j)}; notices ${a?.temperature_notices}` };
    } },
  I15: { name: "supervisor-bounded-restarts-then-incident", inputs: [`${RAW}faults.txt`],
    expected: "an MCP process frozen (SIGSTOP) turns unhealthy and the supervisor restarts it, at most three times in 15 minutes; the fourth time an incident opens instead and no fourth restart is made; REST serves throughout; restarted by hand it recovers",
    run() {
      const rs = [1, 2, 3, 4].map((n) => step("supervisor", `round_${n}`)).filter(Boolean), r = step("supervisor", "recovered");
      const last = rs.at(-1);
      const cond = { three_restarts: rs.length >= 4 && rs.slice(0, 3).every((x, i) => x.supervisor_restarts === i + 1 && x.budget_notices === 0), incident: last?.budget_notices === 1 && last.supervisor_restarts === 3,
        rest: rs.every((x) => x.rest.status === 200 && x.rest.sentinel === true), recovered: r?.ready_after_s >= 0 && r.status.healthy };
      return { ok: bad(cond).length === 0, actual: `failed=${bad(cond).join(",") || "none"}; rounds ${JSON.stringify(rs.map((x) => ({ s: x.acted_after_s, r: x.supervisor_restarts, n: x.budget_notices })))}` };
    } },

  // ================================================================ observability (AC17)
  // Fails: a case whose status does not name the failed component, or names a healthy one as failed.
  O01: { name: "status-names-each-failure-independently", inputs: [`${RAW}faults.txt`],
    expected: "fcpi status --json, read during each injected failure, names that component and not the others: the API down with the ledger up; the worker down with the API live; the ledger and the database down; Redis down; RabbitMQ down; search not ready with the core ready; dispatch paused for memory and for disk; the browser paused, dispatch open, for temperature",
    run() {
      const st = (c, s) => step(c, s)?.status ?? null;
      const rows = {
        api: ((s) => s && s.api === false)(st("api_child_crash", "detected")),
        worker: ((s) => s && s.worker === false && s.api === true)(st("worker_child_crash", "detected")),
        ledger: ((s) => s && s.ledger === false && s.not_healthy.includes("nuq-postgres") && !s.not_healthy.includes("redis"))(st("postgres_down", "status_during")),
        redis: ((s) => s && s.not_healthy.includes("redis") && !s.not_healthy.includes("rabbitmq") && !s.not_healthy.includes("nuq-postgres"))(st("redis_down", "status_during")),
        rabbitmq: ((s) => s && s.not_healthy.includes("rabbitmq") && !s.not_healthy.includes("redis") && !s.not_healthy.includes("nuq-postgres"))(st("rabbitmq_down", "status_during")),
        search: ((s) => s && s.search === false && s.api === true && s.rest === true)(step("searxng_down", "not_resurrected")?.status),
        memory: ((s) => s && s.admission.dispatch === "paused" && s.admission.reasons.includes("memory") && !s.admission.reasons.includes("disk"))(st("memory_pressure", "state_during")),
        disk: ((s) => s && s.admission.dispatch === "paused" && s.admission.reasons.includes("disk") && !s.admission.reasons.includes("memory"))(st("disk_pressure", "state_during")),
        thermal: ((s) => s && s.admission.browser === "paused" && s.admission.dispatch === "open" && s.admission.reasons.includes("thermal"))(st("thermal_pressure", "state_during")) };
      return { ok: Object.values(rows).every(Boolean), actual: `named correctly: ${Object.entries(rows).map(([k, v]) => `${k}=${!!v}`).join(" ")}` };
    } },
  // Fails: an incident noticed more than once while open, not noticed, or its recovery not noticed.
  O02: { name: "one-notice-per-incident-and-its-recovery", inputs: [`${RAW}faults.txt`],
    expected: "each incident the injected failures opened (disk_critical, memory_low, temperature_high, foreign_container, the supervisor's exhausted budget) produced exactly one opened notice while it lasted, across several ticks, and exactly one cleared notice after it (the local outbox and the journal; delivery to an owner channel is N01)",
    run() {
      const cond = { disk: step("disk_pressure", "state_during")?.opened_notices === 1 && step("disk_pressure", "recovered")?.disk_critical_notices === 2,
        memory: step("memory_pressure", "state_during")?.opened_notices === 1 && step("memory_pressure", "recovered")?.memory_low_notices === 2,
        thermal: step("thermal_pressure", "js_after")?.temperature_notices === 2, foreign: step("foreign_container", "detected")?.opened_notices === 1 && step("foreign_container", "cleared")?.notices_since === 2,
        supervisor: step("supervisor", "round_4")?.budget_notices === 1 || [1, 2, 3, 4].some((n) => step("supervisor", `round_${n}`)?.budget_notices === 1) };
      return { ok: bad(cond).length === 0, actual: `failed=${bad(cond).join(",") || "none"}` };
    } },
  // Fails: a container log past its rotation bound, operations logs past 200 MiB, a doctor bundle over 5 MiB or carrying a
  // secret, or a self-test the redaction check does not refuse.
  O03: { name: "logs-bounded-and-diagnostics-redacted", inputs: [`${RAW}faults.txt`],
    expected: "every project container's log is within its rotation bound (10 MiB x 3 for the services, 5 MiB x 2 for the dependencies); /var/log/firecrawl-pi stays under 200 MiB; fcpi doctor writes a bundle of at most 5 MiB after searching it for every secret value and finding none; with one real secret planted (--self-test) it refuses and keeps nothing",
    run() {
      const logs = steps("log_bounds").filter((r) => r.step === "container_log"), ops = step("log_bounds", "ops_logs");
      const size = (x) => ({ "10m": 10 * MIB, "5m": 5 * MIB })[x] ?? NaN;
      const over = logs.filter((l) => !(l.files <= +l.max_file && l.largest <= size(l.max_size) + 64 * 1024)).map((l) => l.service);
      const b = step("doctor", "bundle"), t = step("doctor", "self_test");
      const cond = { containers: logs.length >= 15 && over.length === 0, ops: ops?.var_log_firecrawl_pi_bytes < 200 * MIB,
        bundle: b?.exit === 0 && /secret values checked, 0 found/.test(b.output) && b.size > 0 && b.size <= 5 * MIB && b.files >= 10,
        self_test: !!t && t.exit !== 0 && /redaction check failed \([1-9]\d* files carry a secret/.test(t.output) };
      return { ok: bad(cond).length === 0, actual: `failed=${bad(cond).join(",") || "none"}; logs over bound=${over.join(",") || "none"} of ${logs.length}; ops logs ${ops?.var_log_firecrawl_pi_bytes} B; bundle ${b?.size} B ${b?.files} files; self-test exit ${t?.exit}` };
    } },
  // Fails: a 502 anywhere the gateway answered in the fault cases or the soak.
  O04: { name: "the-gateway-never-answers-502", inputs: [`${RAW}faults.txt`, `${RAW}soak.txt`],
    expected: "no answer the gateway gave in the injected failures or the soak is HTTP 502 (a client library retries 502 by resubmitting); the fault cases and the soak together hold at least 1,000 gateway answers",
    run() {
      const fx = JSON.stringify(FAULTS()), so = (SOAK().soak_log ?? []);
      const n502 = (fx.match(/"status":502\b/g) ?? []).length + so.filter((r) => r.status === 502).length;
      const answers = (fx.match(/"status":\d{3}\b/g) ?? []).length + so.filter((r) => r.status > 0).length;
      return { ok: n502 === 0 && answers >= 1000, actual: `answers=${answers}, 502s=${n502}` };
    } },

  // ================================================================ the soak (AC16) and resources
  // Fails: a window under 24 h, a sample gap past 5 % not tied to a reboot, any OOM kill, any throttle flag, a sample under
  // 1 GiB available, a stalled queue, a failed request not explained by a backup's hold, a p95 past its target, swap allowed.
  S01: { name: "24-hour-paced-soak", inputs: [`${RAW}soak.txt`],
    expected: "a 24-hour paced fixture soak (every minute a static scrape and the status, and on a fixed schedule script-rendered pages, MCP, search, map, PDFs, extraction, crawls, batches, screenshots and change checks): at least 95 % of its minutes sampled; no OOM kill in any project container or the host; no throttle or undervoltage flag; at least 1 GiB available in every sample; the oldest queued item never older than 5 minutes; disk free space within 2 GiB of the start; every request succeeds except any refused 503 HOST_PRESSURE while a backup held the platform; p95 at most 5 s for static pages, 20 s for script-rendered ones, 2 s for status and MCP discovery; swap denied to every container throughout",
    run() {
      const w = soakWindow(), log = SOAK().soak_log ?? [], smp = SOAK().samples ?? [];
      if (!w) return { ok: false, actual: "no soak window" };
      const dur = w.end_epoch - w.start_epoch;
      const reqs = log.filter((r) => !["missed", "end"].includes(r.class));
      const held = new Set(smp.filter((s) => (s.admission?.reasons ?? []).some((x) => /^hold:backup$/.test(x))).map((s) => s.utc.slice(0, 16)));
      const near = (u) => { const t = Date.parse(u); return [-2, -1, 0, 1, 2].some((d) => held.has(new Date(t + d * 60000).toISOString().slice(0, 16))); };
      const failed = reqs.filter((r) => !r.ok), explained = failed.filter((r) => r.code === "HOST_PRESSURE" && near(r.utc)), unexplained = failed.filter((r) => !explained.includes(r));
      const byClass = (c) => reqs.filter((r) => r.class === c && r.ok).map((r) => r.ms);
      const p95 = { static: pct(byClass("static"), 95), js: pct(byClass("js"), 95), status: pct(byClass("status"), 95), mcp_list: pct(byClass("mcp_list"), 95) };
      const perInst = new Map(); for (const s of smp) for (const c of s.containers ?? []) if (c.project === "fcpi") { const k = `${c.service}/${c.id}`; const v = perInst.get(k) ?? []; v.push(c.oom_kill ?? 0); perInst.set(k, v); }
      const oom = [...perInst.values()].some((v) => Math.max(...v) > Math.min(...v)) || (smp.length && Math.max(...smp.map((s) => s.host_oom_kill)) > Math.min(...smp.map((s) => s.host_oom_kill)));
      const minAvail = Math.min(...smp.map((s) => s.mem.available_mib)), maxOld = Math.max(...smp.map((s) => s.queue?.oldest_queued_s ?? 0));
      const free0 = smp[0]?.disk?.free, free1 = smp.at(-1)?.disk?.free;
      const cond = { duration: dur >= 86400 && log.some((r) => r.class === "end"), coverage: smp.length >= 0.95 * (dur / 60), no_oom: !oom, no_throttle: smp.every((s) => s.throttled === "0x0"),
        memory: minAvail >= 1024, queue: smp.every((s) => s.queue?.ok) && maxOld <= 300, disk: free1 >= free0 - 2 * 1024 * MIB, requests: reqs.length >= 2000 && unexplained.length === 0,
        latency: p95.static <= 5000 && p95.js <= 20000 && p95.status <= 2000 && p95.mcp_list <= 2000,
        swap: smp.every((s) => (s.containers ?? []).filter((c) => c.project === "fcpi" && c.state === "running").every((c) => c.swap_limited)) };
      const classes = [...new Set(reqs.map((r) => r.class))].map((c) => `${c}:${reqs.filter((r) => r.class === c && r.ok).length}/${reqs.filter((r) => r.class === c).length}`).join(" ");
      return { ok: bad(cond).length === 0, actual: `failed=${bad(cond).join(",") || "none"}; window ${w.start_utc}..${w.end_utc} (${(dur / 3600).toFixed(1)} h); samples=${smp.length}; requests ${classes}; failed=${failed.length} (held by a backup ${explained.length}; ${unexplained.slice(0, 5).map((r) => `${r.class} ${r.status} ${r.code}`).join("; ")}); missed minutes=${log.filter((r) => r.class === "missed").length}; min available ${minAvail} MiB; max oldest queued ${maxOld} s; p95 ms ${JSON.stringify(p95)}; disk free ${free0}→${free1}` };
    } },
  // Fails: a service whose peak reaches 90 % of its cap during the soak, or a spec §22 measured figure that differs from
  // the soak's.
  S02: { name: "memory-within-caps-and-measured-budget", inputs: [`${RAW}soak.txt`, "docs/FIRECRAWL_PI_SPEC.md"],
    expected: "over the soak every project service's memory peak stays under 90 % of its cap; spec §22's measured column (idle as the soak's lowest current value, normal as its median, peak as its highest peak, in MiB) equals what the soak's samples give",
    run() {
      const smp = SOAK().samples ?? [];
      const svc = {};
      for (const s of smp) for (const c of s.containers ?? []) if (c.project === "fcpi" && c.state === "running") { const v = (svc[c.service] ??= { cur: [], peak: 0, limit: c.mem_limit }); v.cur.push(c.mem_current); v.peak = Math.max(v.peak, c.mem_peak ?? 0); }
      const m = Object.fromEntries(Object.entries(svc).map(([k, v]) => [k, { idle: Math.round(Math.min(...v.cur) / MIB), normal: Math.round(pct(v.cur, 50) / MIB), peak: Math.round(v.peak / MIB), cap: Math.round(v.limit / MIB), frac: +(v.peak / v.limit).toFixed(3) }]));
      const over = Object.entries(m).filter(([, v]) => !(v.frac < 0.9)).map(([k]) => k);
      const spec = read("docs/FIRECRAWL_PI_SPEC.md");
      const rows = [...spec.matchAll(/^\| `([a-z0-9-]+)` \| (\d[\d,]*) \| (\d[\d,]*) \| (\d[\d,]*) \|/gm)].map((r) => [r[1], [r[2], r[3], r[4]].map((x) => +x.replace(/,/g, ""))]);
      const mismatch = rows.filter(([k, [i, n, p]]) => !m[k] || m[k].idle !== i || m[k].normal !== n || m[k].peak !== p).map(([k]) => k);
      const cond = { samples: smp.length >= 1000 && Object.keys(m).length >= 15, caps: over.length === 0, spec_rows: rows.length >= 9 && mismatch.length === 0 };
      return { ok: bad(cond).length === 0, actual: `failed=${bad(cond).join(",") || "none"}; over 90 %=${over.join(",") || "none"}; spec rows=${rows.length}, differing=${mismatch.join(",") || "none"}; measured ${JSON.stringify(m)}` };
    } },
  // Fails: the chosen write settings not in force in the final Compose file and the soak, or the A/B not measured on the
  // same workload, or the chosen settings writing more than the server-class ones.
  S03: { name: "postgres-write-settings-measured-on-the-card", inputs: [`${RAW}pg-writes.txt`, `${EV}rendered-compose.json`],
    // WAL bytes are reported, not judged: these settings decide when dirty buffers and WAL are written and flushed, not how
    // much WAL a workload generates (a first version of this check judged them too; see REVIEW.md F8).
    expected: "the same paced workload measured for an hour under nuq.sql's server-class writer settings (A) and for an hour under the settings M8 keeps (B): PostgreSQL's own writes to the card (its cgroup's io.stat) and its WAL flushes per hour are each no higher under B; the Compose command carries B's settings (M1 R15)",
    run() {
      const l = read(`${RAW}pg-writes.txt`).split("\n").filter((x) => x.startsWith("{")).map((x) => JSON.parse(x));
      const g = (k) => l.find((x) => x.label === k);
      const rate = (a, b, f) => (f(b) - f(a)) / ((Date.parse(b.utc) - Date.parse(a.utc)) / 3600000);
      const [a0, a1, b0, b1] = ["a_start", "a_end", "b_start", "b_end"].map(g);
      if (!a0 || !a1 || !b0 || !b1) return { ok: false, actual: `missing labels: ${["a_start", "a_end", "b_start", "b_end"].filter((k) => !g(k)).join(",")}` };
      const io = (x) => x.postgres_cgroup_wbytes, wal = (x) => x.pg.wal_bytes;
      const syncs = (x) => x.pg.wal_sync;
      const A = { io: rate(a0, a1, io), wal: rate(a0, a1, wal), syncs: rate(a0, a1, syncs) }, B = { io: rate(b0, b1, io), wal: rate(b0, b1, wal), syncs: rate(b0, b1, syncs) };
      const cmd = json(`${EV}rendered-compose.json`).services["nuq-postgres"].command.join(" ");
      const keep = b1.pg.settings;
      const inCompose = ["bgwriter_delay", "bgwriter_lru_maxpages", "wal_writer_delay", "wal_buffers", "effective_io_concurrency"].every((k) => cmd.includes(`${k}=`));
      const cond = { server_class_a: a0.pg.settings.bgwriter_delay === "50" && a0.pg.settings.wal_writer_delay === "10", b_differs: keep.bgwriter_delay !== "50" && keep.wal_writer_delay !== "10",
        windows: Math.abs((Date.parse(a1.utc) - Date.parse(a0.utc)) - (Date.parse(b1.utc) - Date.parse(b0.utc))) < 600000, no_more_card_writes: B.io <= A.io, no_more_flushes: B.syncs <= A.syncs, compose: inCompose };
      return { ok: bad(cond).length === 0, actual: `failed=${bad(cond).join(",") || "none"}; A card ${(A.io / MIB).toFixed(1)} MiB/h, ${Math.round(A.syncs)} WAL flushes/h, WAL ${(A.wal / MIB).toFixed(2)} MiB/h; B card ${(B.io / MIB).toFixed(1)} MiB/h, ${Math.round(B.syncs)} flushes/h, WAL ${(B.wal / MIB).toFixed(2)} MiB/h; kept ${JSON.stringify(keep)}` };
    } },
  // Fails: the core's Redis user not the narrowed one, any command rejected or denied by the ACL across the soak, or the
  // default user still enabled with every command.
  S04: { name: "redis-user-narrowed-to-the-measured-command-set", inputs: [`${RAW}redis-measured.txt`, `${RAW}redis-soak.txt`],
    expected: "the command set the core used across every suite and a paced workload (INFO commandstats) is the narrowed user's allowance; the core connects as that user; the default user is off; across the 24-hour soak no command was rejected and the ACL log holds no denial (M1 R11)",
    run() {
      const m = S(`${RAW}redis-measured.txt`), s = S(`${RAW}redis-soak.txt`);
      // AUTH is outside every ACL, and CONFIG RESETSTAT, ACL LOG and ACL LIST are the measurement tool's own (scripts/m8/pi-redis.sh).
      const TOOL = ["auth", "config|resetstat", "acl|log", "acl|list"];
      const used = (m.commandstats ?? []).map((l) => l.match(/^cmdstat_([^:]+):calls=(\d+)/)).filter(Boolean).map((x) => x[1]).filter((c) => !TOOL.includes(c));
      const users = s.acl_users ?? [];
      const core = users.find((u) => /^user fcpi_core /.test(u)) ?? "", dflt = users.find((u) => /^user default /.test(u)) ?? "";
      const allowed = [...core.matchAll(/ \+([a-z|]+)/g)].map((x) => x[1]);
      const rejected = (s.commandstats ?? []).filter((l) => /rejected_calls=[1-9]|failed_calls=[1-9]/.test(l));
      const cond = { measured: used.length >= 5, narrowed: !!core && !/ \+@all/.test(core) && used.every((c) => allowed.includes(c)), core_user: kv((s.meta ?? []).flatMap((l) => l.split(" "))).core_user === "fcpi_core",
        default_off: / off /.test(`${dflt} `), no_denials: /^\s*$/.test((s.acl_log ?? [""]).join("")) && rejected.length === 0 && (s.commandstats ?? []).length >= 5 };
      return { ok: bad(cond).length === 0, actual: `failed=${bad(cond).join(",") || "none"}; measured ${used.length} commands: ${used.join(",")}; allowed ${allowed.join(",")}; rejected lines ${rejected.length}` };
    } },
  // Fails: a heap failure or a core restart on any page up to 2 MiB, a 502, or no live heap reading.
  S05: { name: "core-heap-holds-large-pages-at-384-mib", inputs: [`${RAW}heap.txt`],
    expected: "with each core child's heap ceiling at 384 MiB: the API child's live heap at rest is read after a full GC; pages of 400 KiB, 614 KiB (M4's F1 size), 1, 1.5 and 2 MiB scraped as Markdown, HTML and raw HTML each answer 200 with their sentinel, or a typed refusal, never 502; the core logs no heap failure and does not restart; the live heap after each is recorded",
    run() {
      const s = S(`${RAW}heap.txt`), meta = kv((s.meta ?? [""])[0].split(" "));
      const probes = Object.keys(s).filter((k) => /^probe_\d+$/.test(k)).map((k) => {
        const l = s[k], h = kv((l.find((x) => x.startsWith("http=")) ?? "").split(" ")), c = kv((l.find((x) => x.startsWith("code=")) ?? "").split(" "));
        const st = l.filter((x) => x.startsWith("core started=")).map((x) => kv(x.slice(5).split(" ")));
        const heap = kv((l.find((x) => x.startsWith("live_heap_used_mib=")) ?? "").split(" "));
        return { kb: +k.slice(6), http: +h.http, sentinel: +c.sentinel >= 1, fails: +((l.find((x) => x.startsWith("heap_failures_logged=")) ?? "=1").split("=")[1]),
          restarted: st.length === 2 && (st[0].started !== st[1].started || st[0].restarts !== st[1].restarts), heap: +heap.live_heap_used_mib };
      });
      const rest = kv(((s.rest ?? []).find((x) => x.startsWith("live_heap_used_mib=")) ?? "").split(" "));
      const cond = { ceiling: /--max-old-space-size=384/.test(meta.node_options ?? ""), sizes: [400, 614, 1024, 1536, 2048].every((k) => probes.some((p) => p.kb === k)),
        answered: probes.every((p) => (p.http === 200 && p.sentinel) || (p.http >= 400 && p.http !== 502)), no_failure: probes.every((p) => p.fails === 0 && !p.restarted),
        heap_read: +rest.live_heap_used_mib > 0 && probes.every((p) => p.heap > 0) };
      return { ok: bad(cond).length === 0, actual: `failed=${bad(cond).join(",") || "none"}; at rest ${rest.live_heap_used_mib} MiB; ${probes.map((p) => `${p.kb} KiB: ${p.http}${p.sentinel ? "" : " no sentinel"}, heap ${p.heap} MiB${p.restarted ? ", RESTARTED" : ""}`).join("; ")}` };
    } },

  // ================================================================ backup and restore (AC18)
  // Fails: quiescence past five minutes, the stack not healthy after, a snapshot missing, retention not run, the staging
  // copy left behind.
  K01: { name: "coordinated-backup-on-the-fixture-repository", inputs: [`${RAW}backup-fixture.txt`],
    expected: "fcpi backup against the fixture repository: at most five minutes of quiescence with a crawl in flight, the stack healthy after, both snapshots (data and secrets) written, retention applied after them, the staging copy removed, fcpi status showing the backup's age; the repository is on the Pi's own card and says so (not the off-device backup, K03)",
    run() {
      const r = records(`${RAW}backup-fixture.txt`), m = kv(read(`${RAW}backup-fixture.txt`).split("\n")[1].split(" ")), b = r.backup?.[0], st = r.status_after_backup?.[0], lo = r.leftovers?.[0];
      const cond = { inflight: r.inflight?.[0]?.status === 200 && !!r.inflight[0].job, pass: b?.result === "PASS" && b.quiesce_s <= 300 && b.stack_healthy_after === true && /^[0-9a-f]{8}/.test(b.snapshot_data) && /^[0-9a-f]{8}/.test(b.snapshot_secrets) && b.forget_exit === 0,
        inflight_captured: b?.inflight_jobs >= 1 && b.canary_results >= 1, labelled: m.offdevice === "no" && b?.offdevice === "no", status: st?.backup?.last_success === b?.utc && st.healthy, staging_removed: lo?.staging_current === false };
      return { ok: bad(cond).length === 0, actual: `failed=${bad(cond).join(",") || "none"}; ${JSON.stringify(b)}` };
    } },
  // Fails: any restore check failing (a canary's hash, another principal's access, an in-flight receipt, REST or MCP, a
  // webhook delivered, a network not internal) or the isolated copy left behind.
  K02: { name: "isolated-restore-proves-the-backup", inputs: [`${RAW}backup-fixture.txt`],
    expected: "fcpi restore-test restores that backup into Compose project fcpi-restore (every network internal, no egress, webhooks suppressed, paid dispatch off): the manifest verifies, the configuration matches the backup's, every canary result's documents hash as they did before the backup and another principal gets 404, the in-flight job's receipt is still tracked, artifacts hash and are refused to another principal, a REST fixture scrape and MCP tools/list and a scrape tool call work, no webhook is delivered; then the copy is removed",
    run() {
      const r = records(`${RAW}backup-fixture.txt`), t = r.restore_test?.[0], lo = r.leftovers?.[0], b = r.backup?.[0];
      const c = t?.checks ?? {};
      const need = ["manifest", "config_matches_backup", "copy_started", "networks_internal", "side_effects_off", "result_hashes", "rest_fixture_scrape", "mcp_tools_list", "mcp_scrape", "no_webhook_delivered"];
      const cond = { pass: t?.result === "PASS" && t.backup_run && t.snapshot === b?.snapshot_data?.slice(0, 8), checks: need.every((k) => c[k]?.ok === true),
        acl: Object.keys(c).some((k) => k.startsWith("result_acl:")) && Object.entries(c).filter(([k]) => k.startsWith("result_acl:")).every(([, v]) => v.ok),
        inflight: Object.keys(c).some((k) => k.startsWith("inflight_tracked:")) && Object.entries(c).filter(([k]) => k.startsWith("inflight_tracked:")).every(([, v]) => v.ok),
        removed: lo?.restore_containers === 0 && lo.restore_dir === false };
      return { ok: bad(cond).length === 0, actual: `failed=${bad(cond).join(",") || "none"}; ${t?.result} in ${t?.seconds} s; failing checks: ${Object.entries(c).filter(([, v]) => !v.ok).map(([k, v]) => `${k} (${v.detail})`).join("; ") || "none"}` };
    } },
  // BLOCKED_CREDENTIAL until the owner supplies an off-device destination and holds the recovery key.
  K03: { name: "off-device-backup-and-restore", inputs: [`${RAW}backup-live.txt`], evidenceClass: "live",
    expected: "a backup to the owner's off-device repository (FCPI_BACKUP_OFFDEVICE=yes) passes, the repository holds a recovery key besides the Pi's, and fcpi restore-test restores it with every check passing",
    run() {
      const r = records(`${RAW}backup-live.txt`), m = kv((S(`${RAW}backup-live.txt`).meta ?? []).flatMap((l) => l.split(" ")));
      if (m.configured !== "yes") return { blocked: true, actual: `no off-device repository is configured (${m.reason ?? "owner input: a destination and recovery-key custody"}); nothing was sent` };
      const b = r.backup?.[0], t = r.restore_test?.[0];
      const ok = m.offdevice === "yes" && +m.restic_keys >= 2 && b?.result === "PASS" && t?.result === "PASS";
      return { ok, actual: `offdevice=${m.offdevice} keys=${m.restic_keys} backup=${b?.result} restore=${t?.result}` };
    } },
  // BLOCKED_CREDENTIAL until the owner names a notification channel and consents to it.
  N01: { name: "incident-notice-reaches-the-owner-channel", inputs: [`${RAW}notify-live.txt`], evidenceClass: "live",
    expected: "one injected incident and its recovery reach the owner's chosen channel through FCPI_ALERT_COMMAND, each delivered once",
    run() {
      const m = kv((S(`${RAW}notify-live.txt`).meta ?? []).flatMap((l) => l.split(" ")));
      if (m.configured !== "yes") return { blocked: true, actual: `no owner notification channel is configured (${m.reason ?? "owner input: a channel and consent"}); notices stay in the journal and the local outbox (O02)` };
      const r = records(`${RAW}notify-live.txt`).delivered ?? [];
      return { ok: r.length === 2 && r.every((x) => x.delivered === true && x.attempts === 1), actual: JSON.stringify(r) };
    } },

  // ================================================================ upgrade and rollback (AC19)
  U01: { name: "upgrade-and-rollback-rehearsed-in-isolation", inputs: [`${RAW}rehearsal.txt`],
    expected: "in the isolated restored copy: a reversible configuration change passes its checks and passes again when reverted; a candidate image that refuses this release's configuration fails its start and, rolled back to the baseline image, the copy passes its checks; after the candidate ledger migration to version 4 the baseline gateway refuses the migrated ledger, and the rollback that restores the pre-migration database from the backup with the baseline images brings the copy back to version 3 with every check passing",
    run() {
      const r = (k) => step("rehearsal", k) ?? records(`${RAW}rehearsal.txt`).rehearsal?.find((x) => x.step === k);
      const R = records(`${RAW}rehearsal.txt`).rehearsal ?? [], g = (k) => R.find((x) => x.step === k);
      const cond = { baseline: g("baseline")?.restore_test?.result === "PASS",
        config: g("candidate_config")?.up_exit === 0 && /=100000$/.test(g("candidate_config").env) && g("candidate_config").checks.pass && g("reverted_config")?.checks?.pass && /=110000$/.test(g("reverted_config").env),
        image_failure: g("candidate_image")?.up_exit !== 0 && /unknown configuration keys/.test(g("candidate_image").refusal ?? "") && g("rolled_back_image")?.up_exit === 0 && g("rolled_back_image").checks.pass,
        schema: g("migrated")?.migration_exit === 0 && g("migrated").schema_version === "4" && /schema version is 4, this build needs 3/.test(g("migrated").refusal ?? "")
          && g("rolled_back_schema")?.restore_exit === 0 && g("rolled_back_schema").schema_version === "3" && g("rolled_back_schema").checks.pass };
      void r;
      return { ok: bad(cond).length === 0, actual: `failed=${bad(cond).join(",") || "none"}; steps ${R.map((x) => x.step).join(",")}` };
    } },
  U02: { name: "upgrade-and-rollback-plans-read-only", inputs: [`${RAW}plans.txt`],
    expected: "fcpi upgrade --plan against a staged candidate (M7's release) names the image changes, the ledger schema the candidate reaches against the database's, whether the change is schema-sensitive and the rollback that follows, and the steps of spec §27; fcpi rollback --plan names the previous recorded release and whether a data restore is needed; the deployed tree's hash is the same before and after",
    run() {
      const r = records(`${RAW}plans.txt`), u = r.upgrade_plan?.[0], b = r.rollback_plan?.[0], h = r.tree?.map((x) => x.sha256) ?? [];
      const cond = { upgrade: !!u && u.image_changes.length >= 1 && typeof u.schema_sensitive === "boolean" && u.steps.length >= 8 && /redeploy|restore/.test(u.rollback),
        rollback: !!b && /^[0-9a-f]{40}$/.test(b.to_commit) && typeof b.data_restore_needed === "boolean" && b.steps.length >= 2, read_only: h.length === 2 && h[0] === h[1] };
      return { ok: bad(cond).length === 0, actual: `failed=${bad(cond).join(",") || "none"}; upgrade ${u?.from_commit?.slice(0, 7)}→${u?.to_commit?.slice(0, 7)} changes ${u?.image_changes?.length} sensitive ${u?.schema_sensitive}; rollback to ${b?.to_commit?.slice(0, 7)} restore ${b?.data_restore_needed}` };
    } },

  // ================================================================ posture, Cloud independence, attribution, redaction
  X01: { name: "zero-firecrawl-cloud-attempts", inputs: [`${RAW}guard-window-open.txt`, `${RAW}egress-probe.txt`, `${RAW}core-logs-final.txt`],
    expected: "across one window, from a guard-counter snapshot before the first phase to the egress probe after the last, with the guard's table not reloaded (or reloaded only by the window's own reboot, whose counters are then read per boot): the guard accepted no web and no proxy-port connection (every M8 phase uses internal fixtures only); the core's saved logs classify every Cloud line",
    run() {
      const handle = (f) => ((sections(f).meta ?? []).join(" ").match(/guard_table_handle=(\d+)/) ?? [])[1];
      const counter = (f, sec, name) => +((sections(f)[sec] ?? []).find((l) => l.startsWith(`${name} `)) ?? "=NaN").split("=")[1];
      const web = counter(`${RAW}egress-probe.txt`, "guard_after", "egress_web_accepted") - (handle(`${RAW}guard-window-open.txt`) === handle(`${RAW}egress-probe.txt`) ? counter(`${RAW}guard-window-open.txt`, "counters", "egress_web_accepted") : 0);
      const proxy = counter(`${RAW}egress-probe.txt`, "guard_after", "egress_proxy_accepted") - (handle(`${RAW}guard-window-open.txt`) === handle(`${RAW}egress-probe.txt`) ? counter(`${RAW}guard-window-open.txt`, "counters", "egress_proxy_accepted") : 0);
      const recs = Object.entries(sections(`${RAW}core-logs-final.txt`)).filter(([k]) => /^(instance|stored)_/.test(k)).map(([, lines]) => {
        const c = lines.find((l) => l.startsWith("classified ")); const ctl = +((lines.find((l) => l.startsWith("control=")) ?? "").match(/count=(\d+)/) ?? [])[1];
        return { c: c ? kv(c.split(" ").slice(1)) : null, ctl };
      });
      const cond = { counters_read: Number.isFinite(web) && Number.isFinite(proxy), egress: web === 0 && proxy === 0, core_logs: recs.length >= 1 && recs.every((r) => r.c && r.c.cloud_unexplained === "0" && r.c.dns_unexplained === "0" && r.ctl >= 1) };
      return { ok: bad(cond).length === 0, actual: `failed=${bad(cond).join(",") || "none"}; guard handle ${handle(`${RAW}guard-window-open.txt`)}→${handle(`${RAW}egress-probe.txt`)}, web accepted delta=${web}, proxy-port delta=${proxy}; core logs=${recs.length}` };
    } },
  X02: { name: "network-and-container-posture", inputs: [`${RAW}stack.txt`, `${EV}rendered-compose.json`],
    expected: "all fifteen containers run aarch64 under fcpi.slice with memory.swap.max 0 (the scope and the slice); the only host publication is 127.0.0.1:3380; the gateway and the retrieval service mount the admission directory read-only and name PI_ADMISSION_FILE; the core's health check reports its API and worker apart",
    run() {
      const st = S(`${RAW}stack.txt`), R = json(`${EV}rendered-compose.json`).services;
      const pub = (st.published ?? []).filter((l) => /->/.test(l));
      const arch = (st.containers ?? []).filter((l) => / uname_m=/.test(l));
      const adm = (s) => (R[s].volumes ?? []).some((v) => v.source === "/run/firecrawl-pi/admission" && v.target === "/srv/admission" && v.read_only === true) && R[s].environment?.PI_ADMISSION_FILE === "/srv/admission/admission.json";
      const cond = { slice: Object.values(R).every((s) => s.cgroup_parent === "fcpi.slice"), swap: (st.cgroups ?? []).length === 15 && (st.cgroups ?? []).every((l) => / parent_swap_max=0 /.test(l) && / memory\.swap\.max=0 /.test(l)),
        arch: arch.length === 15 && arch.every((l) => /uname_m=aarch64$/.test(l)), publication: pub.length === 1 && /^access-gateway 3300\/tcp -> 127\.0\.0\.1:3380$/.test(pub[0]),
        admission: adm("access-gateway") && adm("retrieval-service"), health: /api=/.test(JSON.stringify(R["firecrawl-core"].healthcheck.test)) && /worker=/.test(JSON.stringify(R["firecrawl-core"].healthcheck.test)) };
      return { ok: bad(cond).length === 0, actual: `failed=${bad(cond).join(",") || "none"}; publications=${pub.join(";")}; cgroups=${(st.cgroups ?? []).length}` };
    } },
  X04: { name: "unrelated-state-unchanged", inputs: [`${EV}snapshot-before.txt`, `${EV}snapshot-after.txt`, `${RAW}nft-ruleset.txt`, "evidence/M7/raw/nft-ruleset.txt", `${EV}reboots/`],
    expected: "every line differing between M8's BEFORE and AFTER snapshots is attributed to the project (fcpi containers, their scopes and namespaces, M8's units, slice and timers, kernel modules for the runtime), the collector's own SSH sessions, or the owner's own work that raw/owner-session.txt records; the boot ID is unchanged, or changed only across reboots the durable boot records tie from BEFORE's boot to AFTER's, each an orderly watchdog reboot or the reboot the driver made; the guard's rules are M7's and the installed guard is the repository's",
    run() {
      const [B, A] = [`${EV}snapshot-before.txt`, `${EV}snapshot-after.txt`];
      const chain = bootChain(bootOf(B), bootOf(A));
      const d = snapshotDiff(B, A, !!chain);
      const hdr = kv(((read(`${RAW}nft-ruleset.txt`).match(/^# guard_file_sha256=.*$/m) ?? [""])[0]).slice(2).split(" "));
      const guardOk = hdr.guard_file_sha256 === sha256File("deploy/host/fcpi-guard.nft");
      const r7 = ruleSet("evidence/M7/raw/nft-ruleset.txt"), r8 = ruleSet(`${RAW}nft-ruleset.txt`);
      const ruleChanges = [...[...r8].filter((r) => !r7.has(r)).map((r) => `+ ${r}`), ...[...r7].filter((r) => !r8.has(r)).map((r) => `- ${r}`)];
      const afterHash = (read(A).match(/^nft_ruleset_sha256=([0-9a-f]{64})$/m) ?? [])[1];
      const rulesTied = /^[0-9a-f]{64}$/.test(hdr.ruleset_sha256 ?? "") && hdr.ruleset_sha256 === afterHash;
      writeFileSync(resolve(ROOT, `${EV}snapshot-diff.txt`), ["# M8 BEFORE/AFTER snapshot diff (section-keyed; written by scripts/m8/verify.mjs X04)",
        `# before: ${read(B).split("\n")[1]}  after: ${read(A).split("\n")[1]}`,
        `# boot_id: ${bootOf(B) === bootOf(A) ? "unchanged (no reboot)" : chain ? `changed across ${chain.length} reboot(s) the durable boot records tie: ${chain.map((h) => `${h.kind} (${h.file})`).join(", ")}` : "CHANGED and not tied"}`,
        `## changes to unrelated state (${d.rows.unrelated.length})`, ...d.rows.unrelated, `## the owner's own work on the Pi and Pi-hole's own socket rotation (${d.rows.owner.length}; raw/owner-session.txt)`, ...d.rows.owner,
        `## the reboots' own changes (${d.rows.reboot.length})`, ...d.rows.reboot, `## project changes and the collector's own SSH sessions (${d.rows.project.length})`, ...d.rows.project,
        `## ruleset changes since M7's recorded ruleset (${ruleChanges.length}; none expected)`, ...ruleChanges.map((r) => r.replace(/\t/g, " ")), ""].join("\n"));
      const ok = d.unexplained.length === 0 && !!bootOf(B) && (bootOf(B) === bootOf(A) || !!chain) && guardOk && rulesTied && r7.size > 50 && r8.size > 50 && ruleChanges.length === 0;
      return { ok, actual: `added=${d.added.length} removed=${d.removed.length}; attributed ${JSON.stringify(d.why)}; unexplained=${d.unexplained.length}${d.unexplained.length ? " [" + d.unexplained.slice(0, 8).join("; ") + "]" : ""}; boot changed=${bootOf(B) !== bootOf(A)}, tied=${chain ? chain.map((h) => h.kind).join("+") || "no reboot" : "no"}; rules changed since M7=${ruleChanges.length}; guard is the repository's=${guardOk}; ruleset tied to AFTER=${rulesTied}` };
    } },
  X05: { name: "secret-and-identifier-redaction-scan", inputs: [M0_CONTROL, M1_CONTROL, M3_CONTROL, M8_CONTROL, "scripts/m1/pi-target.conf", "evidence/M0/audit.json"], live: true,
    expected: "the positive controls fire every rule; then no rule matches in any tracked or new repository file; no file holds any live secret (every earlier one, the webhook signing secret, every provider file, every client token file on the Pi, and M8's backup keys), compared by SHA-256 computed on the Pi; no file added or changed since M8 began holds the Pi's LAN address, its /24 network or its SSH target",
    run() {
      const c = [...scan([M0_CONTROL], { m0: { egress: sha256("192.0.2.77"), serial: sha256("0123456789abcdef"), machineId: sha256("0123456789abcdef0123456789abcdef"), macs: new Set([sha256("02:00:00:00:00:01")]) } }, RULES, new Set()),
        ...scan([M1_CONTROL], { secrets: new Set([sha256("0f".repeat(32)), sha256("ABCDEFGHIJKLMNOP".repeat(4))]) }, RULES, new Set()),
        ...scan([M8_CONTROL], { secrets: new Set([sha256("QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVphYmNkZWZnaGlqa2xtbm9wcXJzdHV2")]) }, RULES, new Set()),
        ...scan([M3_CONTROL], {}, RULES, new Set())];
      const fired = new Set(c.map((h) => h.split(" ").pop()));
      const silent = [...RULES.map(([n]) => n), ...HASH_RULES].filter((r) => !fired.has(r));
      if (silent.length) return { ok: false, actual: `positive controls: rules that did not fire: ${silent.join(", ")}` };
      const hashes = ssh(`sudo -n sh -c 'S=/etc/firecrawl-pi/secrets; h() { [ -n "$1" ] || { echo "EMPTY secret extraction" >&2; exit 1; }; printf "%s" "$1" | sha256sum | cut -c1-64; }; \
        h "$(cat $S/postgres_password)"; h "$(cat $S/core_postgres_password)"; h "$(sed -n "s#^amqp://fcpi:\\(.*\\)@rabbitmq:5672\\$#\\1#p" $S/core_nuq_rabbitmq_url)"; \
        h "$(sed -n "s#^redis://[^:]*:\\(.*\\)@redis:6379\\$#\\1#p" $S/core_redis_url)"; h "$(cat /srv/firecrawl-pi/data/rabbitmq/.erlang.cookie)"; \
        h "$(cat $S/retrieval_postgres_password)"; h "$(cat $S/core_retrieval_token)"; h "$(cat $S/retrieval_browser_token)"; \
        h "$(cat $S/gateway_postgres_password)"; h "$(cat $S/gateway_retrieval_token)"; h "$(cat $S/searxng_proxy_password)"; h "$(cat $S/searxng_secret_key)"; h "$(cat $S/webhook_signing_secret)"; \
        for f in $S/providers/*; do [ -f "$f" ] && { h "$(tr -d "\\n" < "$f")"; case "$(tr -d "\\n" < "$f")" in *:*) h "$(tr -d "\\n" < "$f" | cut -d: -f2-)";; esac; }; done; for f in $S/clients/*.token $S/backup/*password; do [ -f "$f" ] && h "$(tr -d "\\n" < "$f")"; done'`).split("\n").filter((x) => /^[0-9a-f]{64}$/.test(x));
      const tokenFiles = +ssh("sudo -n sh -c 'ls /etc/firecrawl-pi/secrets/clients/*.token | wc -l'").trim();
      const backupKeys = +ssh("sudo -n sh -c 'ls /etc/firecrawl-pi/secrets/backup/*password 2>/dev/null | wc -l'").trim();
      const providerFiles = +ssh("sudo -n sh -c 'ls -A /etc/firecrawl-pi/secrets/providers | wc -l'").trim();
      const pairFiles = +ssh("sudo -n sh -c 'grep -l : /etc/firecrawl-pi/secrets/providers/* 2>/dev/null | wc -l'").trim();
      if (tokenFiles < 16 || backupKeys < 1 || hashes.length !== 13 + providerFiles + pairFiles + tokenFiles + backupKeys || new Set(hashes).size !== hashes.length || hashes.includes(sha256(""))) return { ok: false, actual: `expected thirteen fixed secrets, ${providerFiles} provider files (${pairFiles} with a password part), ${tokenFiles} client tokens and ${backupKeys} backup keys as distinct non-empty hashes; got ${hashes.length}` };
      const files = execFileSync("git", ["-C", ROOT, "ls-files", "--cached", "--others", "--exclude-standard"], { encoding: "utf8" }).split("\n").filter((f) => f && ![M0_CONTROL, M1_CONTROL, M3_CONTROL, M8_CONTROL].includes(f) && has(f) && !/\.(pdf|png|gz)$/.test(f));
      const audit = json("evidence/M0/audit.json");
      const m0 = { egress: audit.network.egress_ip_sha256, serial: audit.identity.board_serial_sha256, machineId: audit.identity.machine_id_sha256, macs: new Set([...Object.values(audit.identity.mac_sha256), sha256("00:00:00:00:00:00")]) };
      const hits = scan(files, { m0, secrets: new Set(hashes) });
      const t = target(), lan = t.PI_LAN_ADDRESS, net = lan.replace(/\.\d+$/, ".0");
      const changed = [...new Set([...git("diff", "--name-only", `${M8_START}..HEAD`).split("\n"), ...git("ls-files", "--others", "--exclude-standard").split("\n")])].filter((f) => f && has(f) && !/\.(pdf|png|gz)$/.test(f));
      const idHits = changed.filter((f) => { const x = read(f); return x.includes(lan) || x.includes(`${net}/`) || x.includes(t.PI_SSH_TARGET); });
      return { ok: hits.length === 0 && idHits.length === 0, configHash: hashOf(files.filter((f) => f !== OUT)), actual: `controls fired all ${RULES.length + HASH_RULES.length} rules; files scanned=${files.length}; live secret hashes compared=${hashes.length} (provider files ${providerFiles}, password parts ${pairFiles}, client tokens ${tokenFiles}, backup keys ${backupKeys}); findings=${hits.length}${hits.length ? " [" + hits.slice(0, 12).join("; ") + "]" : ""}; M8 files with the LAN address, network or SSH target=${idHits.join(",") || "none"} (of ${changed.length})` };
    } },
  L03: { name: "lock-and-compose-consistent", inputs: ["deploy/versions.lock.json", "deploy/compose.yaml", `${EV}rendered-compose.json`],
    expected: "every Compose image is pinned by digest for linux/arm64 across the fifteen services; the lock records the retrieval and gateway images the stack runs, M7's API, MCP and browser images, restic's package version and binary hash, fcpi.slice and the host units' hashes, and the capability manifest's hash",
    run() {
      const R = json(`${EV}rendered-compose.json`), L = json("deploy/versions.lock.json");
      const unpinned = Object.entries(R.services).filter(([, v]) => !/@sha256:[0-9a-f]{64}$/.test(v.image) || v.platform !== "linux/arm64").map(([k]) => k);
      const units = readdirSync(resolve(ROOT, "deploy/host")).filter((f) => /^fcpi.*\.(service|timer|slice)$/.test(f));
      const cond = { services: L.images?.retrieval?.image_id === digestOf(R.services["retrieval-service"].image) && L.images?.access_gateway?.image_id === digestOf(R.services["access-gateway"].image)
          && L.images?.mcp_gateway?.image_id === digestOf(R.services["mcp-gateway"].image) && L.images?.browser_worker?.image_id === digestOf(R.services["browser-worker"].image) && L.images?.firecrawl_api_patched?.image_id === digestOf(R.services["firecrawl-core"].image),
        restic: L.host_packages?.restic?.version === "0.18.0-1+b4" && /^[0-9a-f]{64}$/.test(L.host_packages.restic.binary_sha256 ?? ""),
        units: units.length >= 11 && units.every((u) => L.host_units?.[u] === sha256File(`deploy/host/${u}`)), manifest: L.gateway?.capabilities_sha256 === sha256File("deploy/policies/capabilities.json") };
      return { ok: unpinned.length === 0 && bad(cond).length === 0 && Object.keys(R.services).length === 15, actual: `services=${Object.keys(R.services).length}; unpinned=${unpinned.join(",") || "none"}; lock disagrees on=${bad(cond).join(",") || "none"}` };
    } },
  // Fails: a finding without an outcome, a fix without its commit, a cited commit that does not exist, a finding an earlier
  // review deferred to M8 without its own row, or an absolute local path.
  V01: { name: "review-record-complete", inputs: [`${EV}review/REVIEW.md`],
    expected: "the saved /review-2 report (CLAUDE.md §5) gives every finding it lists, and every finding found during M8 outside the review (F), a row with an outcome (fixed with its commit, rejected with evidence, deferred to M9); gives every finding an earlier review deferred to M8 (M1's R11, R12, R13, R14 and R15, M4's F1 and F2, M7's F10 and F13) a row with an outcome; cites only commits that exist; holds no absolute local path",
    run() {
      const text = read(`${EV}review/REVIEW.md`);
      const OUTCOME = /^(Fixed|Closed|Rejected, with the evidence|Deferred to M9\b|Returned to M\d\b|Recorded)/;
      const rows = text.split("\n").filter((l) => /^\| [A-Z]{1,2}\d+ \|/.test(l)).map((l) => l.split(" | "));
      const badRows = rows.filter((c) => !OUTCOME.test(c[3] ?? "")).map((c) => c[0].slice(2));
      const carried = ["M1 R11", "M1 R12", "M1 R13", "M1 R14", "M1 R15", "M4 F1", "M4 F2", "M7 F10", "M7 F13"];
      const carriedRows = text.split("\n").filter((l) => /^\| M\d [A-Z]{1,2}\d+ \|/.test(l)).map((l) => l.split(" | "));
      const carriedBad = carried.filter((id) => { const r = carriedRows.find((c) => c[0] === `| ${id}`); return !r || !OUTCOME.test(r[2] ?? ""); });
      const listedIds = [...text.matchAll(/^\s*\d+\. \*\*([CWSF]\d+) —/gm)].map((m) => m[1]);
      const uncovered = listedIds.filter((id) => !rows.some((c) => c[0] === `| ${id}`));
      const uncited = [...rows.filter((c) => /^Fixed/.test(c[3] ?? "")), ...carriedRows.filter((c) => /^Fixed/.test(c[2] ?? ""))].filter((c) => !/`[0-9a-f]{7,40}`/.test(c.join(" | "))).map((c) => c[0].slice(2));
      const commits = [...new Set([...rows, ...carriedRows].flatMap((c) => [...(c.join(" | ")).matchAll(/`([0-9a-f]{7,40})`/g)].map((m) => m[1])))];
      const missing = commits.filter((c) => { try { git("cat-file", "-e", `${c}^{commit}`); return false; } catch { return true; } });
      const local = /\/(private\/tmp|Users\/[^\/\s]+|home\/[^\/\s]+)\//.test(text);
      const ok = rows.length > 0 && uncovered.length === 0 && uncited.length === 0 && badRows.length === 0 && missing.length === 0 && !local && carriedBad.length === 0;
      return { ok, actual: `carried over without a recognised outcome=${carriedBad.join(",") || "none"}; findings listed=${listedIds.length}, rows=${rows.length}, without a row=${uncovered.join(",") || "none"}; fixed without a commit=${uncited.join(",") || "none"}; without a recognised outcome=${badRows.join(",") || "none"}; commits cited=${commits.length}, missing=${missing.join(",") || "none"}; absolute local path=${local}` };
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
  const rec = { test_id: `M8-${id}`, name: c.name, utc: now(), ...repo, upstream_sha: UPSTREAM_SHA, patch_series_sha256: series.series_sha256, config_or_fixture_hash: null, expected: c.expected,
    evidence_class: c.evidenceClass ?? "fixture-or-host" };
  try {
    const missing = c.inputs.filter((p) => !has(p));
    if (missing.length && c.evidenceClass === "live") Object.assign(rec, { state: "BLOCKED_CREDENTIAL", actual: `no live record (${missing.join(", ")}): the owner input it needs has not been given`, exit_code: null });
    else if (missing.length) Object.assign(rec, { state: "NOT_RUN", actual: `evidence missing: ${missing.join(", ")}`, exit_code: null });
    else {
      rec.config_or_fixture_hash = hashOf(c.inputs);
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
    mcp: digestOf(composeImage("mcp-gateway")), browser: digestOf(composeImage("browser-worker")) } : null;
  rec.actual = hideIds(String(rec.actual), target());
  rec.evidence_path = OUT;
  results[rec.test_id] = rec;
  console.log(`${rec.test_id} ${rec.state.padEnd(18)} ${c.name}${rec.state !== "PASS" ? `  — ${rec.actual.slice(0, 260)}` : ""}`);
}
const ordered = listed.map((id) => results[`M8-${id}`] ?? { test_id: `M8-${id}`, name: checks[id].name, state: "NOT_RUN", actual: "never run", evidence_path: OUT });
writeFileSync(resolve(ROOT, OUT), JSON.stringify({ schema: "fcpi.m8.verification/v1", runner: "scripts/m8/verify.mjs",
  repository_sha_note: "Each result records the commit checked out when it ran, with code_dirty; the commit that stores this file is a later one on main. evidence_class separates the live checks (K03, N01) from the fixture and host checks.",
  results: ordered }, null, 2) + "\n");
process.exitCode = ordered.every((r) => r.state === "PASS" || r.state === "BLOCKED_CREDENTIAL") ? 0 : 1;
