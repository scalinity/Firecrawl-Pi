#!/usr/bin/env node
// M7 verification (docs/FIRECRAWL_PI_MILESTONES.md, M7 "Automated Verification" and "Acceptance Criteria";
// spec AC10, AC11, AC20, AC21, with AC23-AC25; CLAUDE.md §25, §26, §33.3). Every check recomputes its result from the raw
// evidence under evidence/M7/ (or the directory FCPI_M7_EVIDENCE names) and records the §25 tuple, with code_dirty, in
// evidence/M7/verification.json. A check whose evidence is missing is NOT_RUN, never PASS; a live check whose record
// says its credential or budget is missing is BLOCKED_CREDENTIAL; a record a check reads must be there (an absent one
// fails, it does not pass vacuously); every negative result is read beside its positive control; each check's
// `expected` names what it compares. Fixture results and live results are separate checks: a fixture check never
// stands in for a live one.
//   node scripts/m7/verify.mjs [CHECK_ID …]
import { readFileSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import { inflateSync } from "node:zlib";
import { resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { ROOT, sha256, sha256File, repoState, sections, git, kv } from "../m0/lib.mjs";

const EV = process.env.FCPI_M7_EVIDENCE ?? "evidence/M7/";
const RAW = `${EV}raw/`;
const OUT = `${EV}verification.json`;
const UPSTREAM_SHA = "7666c1f9ae8720a6bba271e0f60b6a217f8a5210";
const M7_START = "0318b6e"; // the kickoff's HEAD: files changed after it are M7's
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

// ---- redaction (M4's rules and controls, M5-M7's live secrets) ------------------------------------------
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
  "password: readFileSync",
  // M7: the retrieval service and the fixture receiver read the signing secret into a variable that holds no value of
  // its own; the webhook test's secret and the local trust-auth PostgreSQL's unused password are synthetic.
  "secret = getSecret", "secret: hookSecret", 'SECRET = "fixture-webhook-signing-secret-0123456789', 'password: "unused-with-trust']);
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
  if (sec === "firewall" && /^nft_ruleset_sha256=/.test(line)) return "nftables ruleset: every changed rule attributed in X04 (evidence/M7/raw/nft-ruleset.txt)";
  if (sec === "nft_chains" && /^ip6? (filter|nat|raw) (DOCKER[-A-Z0-9]*|FORWARD|PREROUTING|OUTPUT|POSTROUTING) /.test(line)) return "Docker's chains";
  return null;
}

// Reboots between the snapshots (raw/reboot.txt, scripts/m7/pi-reboot-record.sh, M4's recorder for a chain of boots):
// the record must hold every boot from BEFORE's to AFTER's, AFTER's the current one, and each boot that ended must
// have ended in an orderly shutdown the host's own Wi-Fi watchdog started after a Wi-Fi loss, with no local action
// after the loss and no undervoltage. Only then does a line the reboots changed count as attributed, each by
// what changed, as M4's X04 counts them: a module in both snapshots whose size differs, a mount whose target,
// source and type are the same with only its options changed, a service's ephemeral UDP port chosen again at
// its start, and a unit no longer running that neither snapshot lists as enabled.
// One record's chain: its boots in order, the current one, whether every boot that ended ended as required.
function chainOf(file) {
  if (!has(file)) return null;
  const s = S(file);
  const boots = (s.boots ?? []).map((l) => kv(l.split(" "))).sort((a, b) => +a.idx - +b.idx);
  const cur = kv(((s.current ?? [])[0] ?? "").split(" "));
  const ended = boots.slice(0, -1).map((b) => ({ b, e: kv(((s[`ended_${b.idx.replace("-", "")}`] ?? [])[0] ?? "").split(" ")) }));
  const orderly = ended.every(({ e }) => +e.shutdown_markers > 0 && e.watchdog_reboot === "yes" && /^\d{4}-/.test(e.loss_utc ?? "")
    && ["sudo_commands", "ssh_logins", "sessions", "console_logins", "undervoltage"].every((k) => e[k] === "0"));
  const ok = ({ e }) => +e.shutdown_markers > 0 && e.watchdog_reboot === "yes" && /^\d{4}-/.test(e.loss_utc ?? "")
    && ["sudo_commands", "ssh_logins", "sessions", "console_logins", "undervoltage"].every((k) => e[k] === "0");
  const ends = boots.length >= 1 && boots.at(-1).idx === "0" && boots.at(-1).boot_id_sha256 === cur.boot_id_sha256;
  const whole = ends && orderly;
  // From a given boot on: every boot after it that ended ended as required, and the chain reaches the current boot.
  const wholeFrom = (hash) => { const i = boots.findIndex((b) => b.boot_id_sha256 === hash); return ends && i >= 0 && ended.slice(i).every(ok); };
  return { first: boots[0]?.boot_id_sha256 ?? null, current: cur.boot_id_sha256 ?? null, kernel: cur.kernel, whole, wholeFrom, ended: ended.map(({ b }) => b.last) };
}
// The close's record ties the chain when the journal still holds BEFORE's boot. Once the journal has rotated it out, a
// record made earlier while it held it (raw/reboot-early.txt, with its provenance) ties BEFORE to the boot then
// current, and the close's record must tie that boot on to AFTER's: still current, or every reboot since as required.
function rebootTie(bootB, bootA) {
  if (!bootB || !bootA || bootB === bootA) return null;
  const late = chainOf(`${RAW}reboot.txt`), early = chainOf(`${RAW}reboot-early.txt`);
  if (!late || late.current !== bootA) return null;
  if (late.whole && late.first === bootB) return { kernel: late.kernel, ended: late.ended.join(", ") };
  const provenance = has(`${RAW}reboot-early.txt`) && /^source=scripts\/m7\/pi-reboot-record\.sh run at \S+Z/.test((S(`${RAW}reboot-early.txt`).provenance ?? [])[0] ?? "");
  if (early && provenance && early.whole && early.first === bootB && late.wholeFrom(early.current)) return { kernel: late.kernel, ended: `${early.ended.join(", ")} (recorded before the journal rotated)${late.ended.length ? `, then ${late.ended.join(", ")}` : ""}` };
  return null;
}
function rebootAttribute(sec, line, kind, B, A) {
  const other = kind === "removed" ? A : B;
  const inOther = (pred) => other.some(([s, l]) => s === sec && l !== line && pred(l));
  if (sec === "lsmod") { const n = line.split(" ")[0]; if (inOther((l) => l.split(" ")[0] === n)) return "the reboot: a module in both snapshots, loaded again at boot"; }
  // The socket-diagnostics modules load on demand when ss asks for sockets (the snapshot's own ss_listen does): an earlier
  // boot had them, a boot the snapshot has not yet run ss in may not.
  if (sec === "lsmod" && kind === "removed" && /^(inet|tcp|udp|raw|unix|netlink|af_packet)_diag$/.test(line.split(" ")[0])) return "the reboot: a socket-diagnostics module ss loaded on demand in the earlier boot";
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
const ok200 = (r) => r?.status === 200;
const calls = (r) => r?.calls ?? [];
const scanOf = (lines) => kv((lines ?? []).find((l) => l.startsWith("lines=")) ?.split(" ") ?? []);

// A PNG decoded here, from the bytes the driver saved (8-bit RGB or RGBA, not interlaced: what Chromium writes).
function png(path) {
  const buf = readFileSync(resolve(ROOT, `${EV}${path}`));
  if (!buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) throw new Error(`${path} is not a PNG`);
  let i = 8, w, h, depth, type, interlace; const idat = [];
  while (i < buf.length) {
    const len = buf.readUInt32BE(i), t = buf.toString("latin1", i + 4, i + 8), d = buf.subarray(i + 8, i + 8 + len);
    if (t === "IHDR") { w = d.readUInt32BE(0); h = d.readUInt32BE(4); depth = d[8]; type = d[9]; interlace = d[12]; }
    if (t === "IDAT") idat.push(d);
    if (t === "IEND") break;
    i += 12 + len;
  }
  if (depth !== 8 || ![2, 6].includes(type) || interlace !== 0) throw new Error(`${path}: unsupported PNG (depth ${depth}, type ${type}, interlace ${interlace})`);
  const bpp = type === 6 ? 4 : 3, stride = w * bpp, raw = inflateSync(Buffer.concat(idat)), px = Buffer.alloc(stride * h);
  for (let y = 0; y < h; y++) {
    const f = raw[y * (stride + 1)], line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1)), out = px.subarray(y * stride, (y + 1) * stride), up = y ? px.subarray((y - 1) * stride, y * stride) : null;
    for (let x = 0; x < stride; x++) {
      const a = x >= bpp ? out[x - bpp] : 0, b = up ? up[x] : 0, c = up && x >= bpp ? up[x - bpp] : 0;
      const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
      out[x] = (line[x] + [0, a, b, (a + b) >> 1, pa <= pb && pa <= pc ? a : pb <= pc ? b : c][f]) & 255;
    }
  }
  const at = (x, y) => { const o = y * stride + x * bpp; return [px[o], px[o + 1], px[o + 2]]; };
  return { width: w, height: h, at };
}
const near = ([r, g, b], [R, G, B]) => Math.abs(r - R) + Math.abs(g - G) + Math.abs(b - B) <= 24;

// ---- checks ------------------------------------------------------------------------------------------
const checks = {
  B00: { name: "baseline-matches-m6-after", inputs: [`${EV}snapshot-before.txt`, "evidence/M6/snapshot-after.txt"],
    expected: "M7's BEFORE snapshot equals M6's AFTER apart from SSH session scopes, and the boot ID is unchanged",
    run() {
      const strip = (f) => keyedSnapshot(f).map((x) => x.join("\t")).filter((l) => !/\tsession-\d+\.scope$/.test(l)).sort();
      const a = strip("evidence/M6/snapshot-after.txt"), b = strip(`${EV}snapshot-before.txt`);
      const only = (x, y) => x.filter((l) => !y.includes(l));
      const boot = (f) => (read(f).match(/^boot_id_sha256=([0-9a-f]{64})$/m) ?? [])[1];
      const ok = a.length > 50 && only(a, b).length === 0 && only(b, a).length === 0 && !!boot(`${EV}snapshot-before.txt`) && boot("evidence/M6/snapshot-after.txt") === boot(`${EV}snapshot-before.txt`);
      return { ok, actual: `lines=${a.length}; only in M6 AFTER=${only(a, b).length}, only in M7 BEFORE=${only(b, a).length}, boot_id_equal=${boot("evidence/M6/snapshot-after.txt") === boot(`${EV}snapshot-before.txt`)}` };
    } },

  // ================================================================ the images, the patches, the suites
  G01: { name: "images-pinned-built-and-running", inputs: [`${RAW}api-build.log`, `${RAW}api-push.txt`, `${RAW}image-build.txt`, `${EV}rendered-compose.json`, `${RAW}stack.txt`],
    expected: "the patched API image was built for linux/arm64 with every step run from a clean tree, carries the ten-patch series hash, and is the image the Pi loaded and the core runs; the retrieval, gateway, MCP and browser images the stack runs are their last builds on the Pi, each recording the commit it was built from, whose source directories are unchanged to HEAD; every deployed commit a record names differs from HEAD in nothing the Pi runs",
    run() {
      const log = read(`${RAW}api-build.log`), push = read(`${RAW}api-push.txt`), build = read(`${RAW}image-build.txt`), st = S(`${RAW}stack.txt`);
      const series = json("patches/series.json");
      const apiId = (log.match(/^id=(sha256:[0-9a-f]{64}) os=linux arch=arm64 /m) ?? [])[1];
      const apiCommit = (log.match(/^repository_commit=([0-9a-f]{40}) code_dirty=false$/m) ?? [])[1];
      const running = (s) => (st.containers ?? []).find((l) => l.startsWith(`${s} `))?.match(/ image=(sha256:[0-9a-f]{64}) /)?.[1];
      const last = (i) => [...build.matchAll(new RegExp(`^fcpi/${i}:m7 id=(sha256:[0-9a-f]{64}) os=linux arch=arm64 size=\\d+ user=(\\S+)$`, "gm"))].at(-1);
      const builtFrom = (i) => [...build.matchAll(new RegExp(`^fcpi/${i}:m7 FCPI_SOURCE_COMMIT=([0-9a-f]{40})$`, "gm"))].at(-1)?.[1];
      const dirSame = (c, ...d) => { try { git("diff", "--quiet", c, "HEAD", "--", ...d); return true; } catch { return false; } };
      const runsSame = (c) => { try { git("diff", "--quiet", c, "HEAD", "--", "services", "deploy", "scripts", "tests", "patches", ":(exclude)deploy/versions.lock.json"); return true; } catch { return false; } };
      const deployed = [...new Set([kv(st.meta ?? []).source_commit, FX().meta?.[0]?.deployed_commit, has(`${RAW}e2e-live.txt`) ? LIVE().meta?.[0]?.deployed_commit : null].filter(Boolean))];
      const cond = { api_built: !!apiId && /^build_exit=0 /m.test(log) && /^no_cache=1$/m.test(log) && !!apiCommit && log.includes(`FCPI_PATCH_SERIES_SHA256=${series.series_sha256}`) && log.includes(`FIRECRAWL_BUILD_SHA=${UPSTREAM_SHA}`),
        api_loaded_and_running: push.includes(`pi_image=${apiId} arm64`) && digestOf(composeImage("firecrawl-core")) === apiId && running("firecrawl-core") === apiId,
        api_patches_unchanged: !!apiCommit && dirSame(apiCommit, "patches"),
        deployed_code_is_head: deployed.length >= 1 && deployed.every(runsSame) };
      for (const [svc, img, dirs, uid] of [["retrieval-service", "retrieval", ["services/retrieval"], "3310:3310"], ["access-gateway", "access-gateway", ["services/access"], "3380:3380"],
        ["mcp-gateway", "mcp-gateway", ["services/mcp"], "3400:3400"], ["browser-worker", "browser", ["services/browser", "deploy/browser"], "3320:3320"]]) {
        const l = last(img), c = builtFrom(img);
        cond[`${img}_built_runs_unchanged`] = !!l && l[2] === uid && running(svc) === l[1] && digestOf(composeImage(svc)) === l[1] && !!c && dirSame(c, ...dirs);
      }
      return { ok: bad(cond).length === 0, actual: `failed=${bad(cond).join(",") || "none"}; api ${apiId?.slice(7, 19)} from ${apiCommit?.slice(0, 7)} series ${series.series_sha256.slice(0, 8)}; deployed commits=${deployed.map((c) => c.slice(0, 7)).join(",")}` };
    } },
  P01: { name: "patch-series-and-coverage", inputs: ["patches/series.json", "patches/0010-enhanced-route-browser-extras-and-owner.patch", `${RAW}api-build.log`],
    expected: "every patch file hashes to its series entry, the series hash is recomputed from them, patch 0010 names its symbols and tests and touches only the pi-resilient engine, the PDF engine's parser request, runWebScraper and the internal options type, and the API build log shows all ten applied to the series' result tree",
    run() {
      const s = json("patches/series.json"), log = read(`${RAW}api-build.log`);
      const listing = s.patches.map((p) => `${p.sha256}  ${p.file}\n`).join("");
      const p10 = s.patches.find((x) => x.file === "0010-enhanced-route-browser-extras-and-owner.patch");
      const touched = [...read("patches/0010-enhanced-route-browser-extras-and-owner.patch").matchAll(/^diff --git a\/(\S+) b\//gm)].map((m) => m[1]).sort();
      const allowed = ["apps/api/src/main/runWebScraper.ts", "apps/api/src/scraper/scrapeURL/engines/pdf/piResilient.ts", "apps/api/src/scraper/scrapeURL/engines/pi-resilient/fetch.ts",
        "apps/api/src/scraper/scrapeURL/engines/pi-resilient/index.ts", "apps/api/src/scraper/scrapeURL/index.ts"];
      const cond = { files: s.patches.every((p) => sha256File(`patches/${p.file}`) === p.sha256), series: sha256(listing) === s.series_sha256, ten: s.patches.length === 10 && s.patches.at(-1) === p10,
        entry: !!p10 && p10.symbols.length >= 5 && p10.tests.length >= 3, scope: same(touched, allowed),
        applied: s.patches.every((p) => log.includes(`applied ${p.file} sha256=${p.sha256}`)) && log.includes(`result_tree=${s.result_tree} series_sha256=${s.series_sha256}`) };
      return { ok: bad(cond).length === 0, actual: `failed=${bad(cond).join(",") || "none"}; series ${s.series_sha256.slice(0, 8)} tree ${s.result_tree.slice(0, 8)}; 0010 touches ${touched.length} files` };
    } },
  G02: { name: "suites-pass-in-the-running-images", inputs: [`${RAW}suites.txt`, `${EV}rendered-compose.json`],
    expected: "inside the images the stack runs: the retrieval service's suite (at least 165 tests, M7's enhanced, webhook and ledger suites among them, the SQL against a throwaway PostgreSQL, none skipped), the gateway ledger's migrations to versions 2 and 3 and M7's gateway ledger SQL (six tests), the gateway's M5-M7 tests (at least 28), the MCP service's suites (at least 42), the gateway's unit suites, M3's contract suite with M7's two route tests (42), M4's gateway-level /mcp contract suite and the grammars all pass with none failing, and no throwaway container or network is left",
    run() {
      const s = S(`${RAW}suites.txt`), m = kv((s.meta ?? [""])[0].split(" "));
      const t = (k) => tapCounts(s[k]), exit0 = (k) => (s[k] ?? []).includes("test_exit=0");
      const skipped = +(((s.retrieval_tap ?? []).find((l) => l.startsWith("# skipped ")) ?? "# skipped 1").split(" ")[2]);
      const m7suites = ["an HTTP dispatch settles at the card's highest tier", "the full waterfall: direct, residential, then the one enhanced dispatch",
        "an approved destination receives a signed delivery the receiver verifies", "one logical page, eight racing callers: one enhanced reservation"].every((x) => (s.retrieval_tap ?? []).some((l) => l.startsWith("ok ") && l.includes(x)));
      const tr = kv((s.transient ?? []).flatMap((l) => l.split(" ")));
      const cond = { images: m.retrieval_image === composeImage("retrieval-service") && m.gateway_image === composeImage("access-gateway") && m.mcp_image === composeImage("mcp-gateway"),
        retrieval: t("retrieval_tap").tests >= 165 && t("retrieval_tap").fail === 0 && skipped === 0 && exit0("retrieval_tap"), m7_suites_ran: m7suites,
        ledger: t("ledger_tap").tests === 6 && t("ledger_tap").pass === 6 && exit0("ledger_tap"),
        gateway_m7: t("gateway_m7_tap").tests >= 28 && t("gateway_m7_tap").fail === 0 && exit0("gateway_m7_tap"),
        mcp: t("mcp_tap").tests >= 42 && t("mcp_tap").fail === 0 && exit0("mcp_tap"), gateway_unit: t("gateway_unit_tap").tests >= 30 && t("gateway_unit_tap").fail === 0 && exit0("gateway_unit_tap"),
        m3_contract: t("gateway_contract_tap").tests === 42 && t("gateway_contract_tap").pass === 42 && exit0("gateway_contract_tap"),
        m4_contract: t("gateway_mcp_contract_tap").tests >= 3 && t("gateway_mcp_contract_tap").fail === 0 && exit0("gateway_mcp_contract_tap"),
        grammars: t("grammars_tap").tests >= 3 && t("grammars_tap").fail === 0, no_leftovers: tr.leftover_transient_containers === "0" && tr.leftover_transient_networks === "0" };
      return { ok: bad(cond).length === 0, actual: `failed=${bad(cond).join(",") || "none"}; retrieval ${t("retrieval_tap").pass}/${t("retrieval_tap").tests} (skipped ${skipped}), ledger ${t("ledger_tap").pass}/${t("ledger_tap").tests}, gateway-m7 ${t("gateway_m7_tap").pass}/${t("gateway_m7_tap").tests}, mcp ${t("mcp_tap").pass}/${t("mcp_tap").tests}, gateway unit ${t("gateway_unit_tap").pass}/${t("gateway_unit_tap").tests}, M3 contract ${t("gateway_contract_tap").pass}/${t("gateway_contract_tap").tests}, M4 contract ${t("gateway_mcp_contract_tap").pass}/${t("gateway_mcp_contract_tap").tests}` };
    } },

  // ================================================================ enhanced retrieval (AC10)
  E01: { name: "automatic-escalation-ends-at-one-enhanced-dispatch", inputs: [`${RAW}e2e-fixture.txt`],
    expected: "with the fixture enhancer selected and no residential route: a 403 and a 200 challenge go direct_http then enhanced, and a script shell whose render is a challenge goes direct_http, direct_browser, then enhanced in browser mode, each returning the target's page as the provider fetched it with proxyUsed stealth and one provider request; route enhanced goes to the provider alone; with the fixture proxy too, a challenge goes direct_http, residential_http, enhanced and the script shell uses all four attempts (direct_http, direct_browser, residential_browser, enhanced); a stealth request stops at the residential route and never reaches the provider; the targets saw each route's request",
    run() {
      const e = FX().enhanced ?? [], c = (k) => one(e, k);
      const oneCall = (r, kind) => calls(r).length === 1 && calls(r)[0].kind === kind && calls(r)[0].status === 200;
      const vias = (r) => (r?.hits ?? []).map((h) => h.via);
      const a403 = c("auto_403_to_enhanced"), a200 = c("auto_200_to_enhanced"), js = c("auto_js_to_enhanced_browser"), alone = c("route_enhanced_alone");
      const wh = c("waterfall_http"), wb = c("waterfall_browser_four_attempts"), st = c("stealth_stops_at_residential");
      const cond = {
        http_403: ok200(a403) && same(strat(a403), [["direct_http", "enhanced"]]) && /through the enhanced provider/.test(a403.markdown ?? "") && a403.proxyUsed === "stealth" && oneCall(a403, "http") && same(vias(a403), ["direct", "enhanced"]),
        http_200: ok200(a200) && same(strat(a200), [["direct_http", "enhanced"]]) && /through the enhanced provider/.test(a200.markdown ?? "") && oneCall(a200, "http"),
        browser: ok200(js) && same(strat(js), [["direct_http", "direct_browser", "enhanced"]]) && /Rendered by the enhanced provider/.test(js.markdown ?? "") && oneCall(js, "browser"),
        alone: ok200(alone) && same(strat(alone), [["enhanced"]]) && viaAll(alone.hits, "enhanced") && oneCall(alone, "http"),
        waterfall_http: ok200(wh) && same(strat(wh), [["direct_http", "residential_http", "enhanced"]]) && same(vias(wh), ["direct", "proxy", "enhanced"]) && wh.tunnels >= 1 && oneCall(wh, "http"),
        waterfall_four: ok200(wb) && same(strat(wb), [["direct_http", "direct_browser", "residential_browser", "enhanced"]]) && /Rendered by the enhanced provider/.test(wb.markdown ?? "") && oneCall(wb, "browser"),
        stealth: st?.class === "BLOCKED_PUBLIC_CONTENT" && same(strat(st), [["residential_http"]]) && calls(st).length === 0 && /stealth request goes no further/.test(st.error ?? "") };
      return { ok: bad(cond).length === 0, actual: `failed=${bad(cond).join(",") || "none"}; ${[a403, a200, js, alone, wh, wb, st].map((r) => `${r?.case}: ${JSON.stringify(strat(r))} calls=${calls(r).length}`).join("; ")}` };
    } },
  E02: { name: "four-attempts-one-enhanced-no-paid-retry-multiplication", inputs: [`${RAW}e2e-fixture.txt`],
    expected: "across the fixture phase: no acquisition uses more than four attempts or more than one enhanced strategy; every provider request the fixture received is one logged enhanced dispatch (as many requests as dispatch lines, none repeated for a page); a page challenged by the provider too gets exactly one request and a typed failure; every enhanced ledger row is one per logical page, and a charged one (a 200) settled at the card's highest-tier price for its mode (1270 or 16080 micro-USD) while the free failures were released",
    run() {
      const f = FX(), ev = f.retrieval_events?.[0] ?? {}, acq = ev.acquisitions ?? [], disp = ev.enhanced ?? [], fx = f.fixture_stats?.[0] ?? {}, led = f.ledger?.[0]?.rows ?? [];
      const never = one(f.enhanced, "enhanced_also_challenged");
      const perPage = new Map();
      for (const r of led) perPage.set(r.logical_id, (perPage.get(r.logical_id) ?? 0) + 1);
      const charged = led.filter((r) => r.state === "SETTLED"), released = led.filter((r) => r.state === "RELEASED");
      const price = (r) => (r.usage?.mode === "browser" ? 16080 : 1270);
      const cond = { acquisitions_read: acq.length >= 40 && disp.length >= 8,
        four: acq.every((a) => a.attempts_used <= 4 && (a.strategies ?? []).filter((s) => s === "enhanced").length <= 1),
        one_request_per_dispatch: (fx.calls ?? []).length === disp.length && new Set(disp.map((d) => d.logical_id)).size === disp.length,
        challenged_once: never?.class === "BLOCKED_PUBLIC_CONTENT" && calls(never).length === 1 && /nothing further is tried/.test(never.error ?? ""),
        one_row_per_page: led.length >= 8 && [...perPage.values()].every((n) => n === 1),
        settled_at_card: charged.length >= 6 && charged.every((r) => Number(r.actual) === price(r) && Number(r.reserved) === price(r)) && released.every((r) => Number(r.actual) === 0) };
      return { ok: bad(cond).length === 0, actual: `failed=${bad(cond).join(",") || "none"}; acquisitions=${acq.length}, max attempts=${Math.max(...acq.map((a) => a.attempts_used))}, dispatch lines=${disp.length}, provider requests=${(fx.calls ?? []).length}; ledger rows=${led.length} (settled ${charged.length}, released ${released.length}, uncertain ${led.filter((r) => r.state === "UNCERTAIN").length})` };
    } },
  E03: { name: "target-and-provider-errors-apart", inputs: [`${RAW}e2e-fixture.txt`],
    expected: "a target's own outcome through the provider is judged as the target's: its 404 is the page with status 404, its 401 is AUTH_REQUIRED, its 429 is RATE_LIMITED and cools the domain on every route (a later basic request is refused with no target request), and an answer ending at a Cloud host is CLOUD_DENIED; the provider's own failures are its own: a ban (520) is BLOCKED_PUBLIC_CONTENT and released free, a request with no answer is ENHANCED_UNCERTAIN and stays reserved, a rate limit (429) and a refused key (401) are PROVIDER_RATE_LIMITED and PROVIDER_AUTH_FAILED and released free, each after one request; none of them changes the domain's routing record",
    run() {
      const e = FX().enhanced ?? [], o = FX().outage ?? [], c = (k) => one(e, k), p = (k) => one(o, k);
      const t4 = c("target_404"), t1 = c("target_401"), t9 = c("target_429"), cool = c("cooldown_all_routes"), fu = c("final_url_refused");
      const states = (r) => (r?.ledger ?? []).map((l) => l.state);
      const dom = p("domain_not_poisoned")?.route;
      const cond = { target_404: ok200(t4) && t4.statusCode === 404 && same(strat(t4), [["enhanced"]]), target_401: t1?.class === "AUTH_REQUIRED" && calls(t1).length === 1,
        target_429: t9?.class === "RATE_LIMITED" && calls(t9).length === 1 && cool?.class === "RATE_LIMITED" && (cool.hits ?? []).length === 0 && cool.domain_state?.cooldown_s === 30,
        final_url: fu?.class === "CLOUD_DENIED" && calls(fu).length === 1,
        ban: p("provider_520")?.class === "BLOCKED_PUBLIC_CONTENT" && calls(p("provider_520")).length === 1 && same(states(p("provider_520")), ["RELEASED"]),
        uncertain: p("provider_blackhole")?.class === "ENHANCED_UNCERTAIN" && calls(p("provider_blackhole")).length === 1 && same(states(p("provider_blackhole")), ["UNCERTAIN"]),
        rate_limit: p("provider_429")?.class === "PROVIDER_RATE_LIMITED" && calls(p("provider_429")).length === 1 && same(states(p("provider_429")), ["RELEASED"]),
        auth: p("provider_401")?.class === "PROVIDER_AUTH_FAILED" && calls(p("provider_401")).length === 1 && same(states(p("provider_401")), ["RELEASED"]),
        not_poisoned: !dom || !/^PROVIDER_|^ENHANCED_/.test(dom.last_failure_class ?? "") };
      return { ok: bad(cond).length === 0, actual: `failed=${bad(cond).join(",") || "none"}; 404→${t4?.statusCode}, 401→${t1?.class}, 429→${t9?.class} (cooldown ${cool?.domain_state?.cooldown_s} s), cloud→${fu?.class}; provider 520→${p("provider_520")?.class} ${states(p("provider_520"))}, silent→${p("provider_blackhole")?.class} ${states(p("provider_blackhole"))}, 429→${p("provider_429")?.class}, 401→${p("provider_401")?.class}; m7esc route=${JSON.stringify(dom)}` };
    } },
  E04: { name: "outage-and-exhausted-budget-without-cloud", inputs: [`${RAW}e2e-fixture.txt`],
    expected: "with the production selection (Zyte, no key, paid dispatch off) a request for the enhanced tier is ENHANCED_REQUIRED and an auto challenge BLOCKED_PUBLIC_CONTENT naming both unavailable tiers, with no provider request and no attempt beyond the direct one, while an ordinary page is fetched directly; with the small fixture category full (concurrent reservations granted exactly the room left) the next dispatch is refused as ENHANCED_REQUIRED (BUDGET_EXHAUSTED) before any request; after three counted provider failures the breaker is open, the tier is refused with no request, and direct scrapes and MCP scrapes go on (AC23)",
    run() {
      const p = FX().production ?? [], bud = FX().budget ?? [], o = FX().outage ?? [];
      const er = one(p, "enhanced_required"), ab = one(p, "auto_blocked_no_tier"), dc = one(p, "direct_control"), ts = one(p, "tier_state");
      const race = one(bud, "reservation_race"), ex = one(bud, "exhausted_enhanced"), ea = one(bud, "exhausted_auto"), rel = one(bud, "race_released");
      const br = one(o, "breaker"), bo = one(o, "breaker_open_refused"), ad = one(o, "auto_during_outage"), du = one(o, "direct_unaffected"), mu = one(o, "mcp_unaffected");
      const granted = (race?.outcomes ?? []).filter((x) => x.granted).length;
      const cond = { production_state: ts?.readyz?.available === false && ts.readyz.reason === "PAID_DISPATCH_DISABLED" && ts.provider?.credential === "absent",
        production_refused: er?.class === "ENHANCED_REQUIRED" && (er.acquisitions ?? []).length === 0 && calls(er).length === 0 && (er.hits ?? []).length === 0,
        production_auto: ab?.class === "BLOCKED_PUBLIC_CONTENT" && same(strat(ab), [["direct_http"]]) && calls(ab).length === 0 && /enhanced provider is unavailable \(PAID_DISPATCH_DISABLED\)/.test(ab.error ?? ""),
        production_control: ok200(dc) && dc.markdown === true,
        race: race && granted === race.expected_granted && (race.outcomes ?? []).length === 30 && rel?.released?.length === granted && rel.released.every(Boolean),
        exhausted: ex?.class === "ENHANCED_REQUIRED" && /BUDGET_EXHAUSTED/.test(ex.error ?? "") && calls(ex).length === 0 && ea?.class === "BLOCKED_PUBLIC_CONTENT" && /BUDGET_EXHAUSTED/.test(ea.error ?? "") && calls(ea).length === 0,
        breaker_open: br?.readyz?.providers?.["fixture-zyte"] === "open" && br.readyz.enhanced?.reason === "PROVIDER_UNAVAILABLE",
        refused_open: bo?.class === "ENHANCED_REQUIRED" && calls(bo).length === 0 && ad?.class === "BLOCKED_PUBLIC_CONTENT" && calls(ad).length === 0,
        isolation: ok200(du) && du.markdown === true && mu?.status === 200 && mu.is_error !== true && mu.has_article === true };
      return { ok: bad(cond).length === 0, actual: `failed=${bad(cond).join(",") || "none"}; production ${er?.class}/${ab?.class}; race granted ${granted} of ${race?.expected_granted} expected (cap ${race?.cap}, used ${race?.used_before}); exhausted ${ex?.class}; breaker ${br?.readyz?.providers?.["fixture-zyte"]}; direct ${du?.status}, mcp ${mu?.status}` };
    } },
  E05: { name: "live-enhanced-request", inputs: [`${RAW}e2e-live.txt`],
    expected: "with a Zyte key, an approved enhanced budget and paid dispatch: route enhanced fetches a permitted public target (example.com) through the provider, the answer is the page, and its ledger row is SETTLED at the card's price; without them the check is BLOCKED_CREDENTIAL and the record shows no live request was made",
    run() {
      const l = LIVE().live_enhanced?.[0];
      if (!l) return { ok: false, actual: "no live_enhanced record" };
      if (l.case === "blocked") return { blocked: true, actual: `credential=${l.credential}, paidDispatch=${l.paidDispatch}, caps=${JSON.stringify(l.enhancedCaps)}: ${l.reason}` };
      const row = (l.ledger ?? [])[0];
      // The current example.com body is its documentation-use paragraph; Example Domain remains its title.
      const content = /Example Domain|This domain is for use in documentation examples without needing permission\./.test(l.markdown ?? "");
      const ok = l.status === 200 && content && l.proxyUsed === "stealth" && row?.provider === "zyte" && row?.subject === "zyte-api" && row?.state === "SETTLED" && Number(row.actual) > 0;
      return { ok, actual: `status ${l.status}; ledger ${JSON.stringify(row)}` };
    } },

  // ================================================================ browser extras (AC11)
  B01: { name: "screenshots-correct-and-bounded", inputs: [`${RAW}e2e-fixture.txt`],
    expected: "a viewport screenshot of the three-band page is a 1280 x 800 PNG, red where the first band is; a full-page one is 1280 x 3000 with red, green and blue at the bands' heights; a full-page capture of the 25,000 px page is 1280 x 20,000 and marked truncated in the answer and the artifact's headers; each capture came back as an artifact address, not image data, with its PNG's own dimensions, and was rendered in one direct_browser attempt; a stealth request's screenshot is rendered on the residential route; through MCP the screenshot is an artifact address too; two captures of incompressible pixels just under the worker's 8 MiB (6.5 to 8 MiB between them) are stored whole, the case M01's gateway sample measures, and one capture just over it is refused as RESOURCE_LIMIT with no artifact; and the core runs the whole window without a restart",
    run() {
      const x = FX().extras ?? [], c = (k) => one(x, k);
      const art = (r) => r?.artifacts?.[0] ?? null;
      const vp = c("viewport"), fp = c("full_page"), tl = c("full_page_clipped"), rs = c("residential_screenshot"), mc = c("mcp_screenshot"), nz = c("noise_worst_case");
      // The worst case the gateway's memory is measured at (review W10): two incompressible captures, stored whole.
      const nzBytes = (nz?.artifacts ?? []).reduce((n, a) => n + (a.meta?.bytes ?? 0), 0), over = c("noise_over_limit");
      // The core ran the whole window without a restart: the same container, started before the window opened.
      const core = kv(((S(`${RAW}stack.txt`).containers ?? []).find((l) => l.startsWith("firecrawl-core name=")) ?? "").split(" "));
      const opened = Date.parse(FX().meta?.[0]?.pi_utc ?? "");
      const pv = art(vp)?.fetched?.saved ? png(art(vp).fetched.saved) : null, pf = art(fp)?.fetched?.saved ? png(art(fp).fetched.saved) : null;
      const tall = art(tl)?.fetched;
      const tallDims = tall?.head_hex ? { w: parseInt(tall.head_hex.slice(32, 40), 16), h: parseInt(tall.head_hex.slice(40, 48), 16) } : null;
      const isUrl = (s) => /\/platform\/v1\/artifacts\/[0-9a-f-]{36}$/.test(s ?? "");
      const cond = { viewport: ok200(vp) && isUrl(vp.screenshot) && !!pv && pv.width === 1280 && pv.height === 800 && near(pv.at(640, 400), [255, 0, 0]) && art(vp).meta.width === 1280 && art(vp).meta.height === 800 && art(vp).meta.truncated === false && art(vp).fetched.mime === "image/png",
        full_page: ok200(fp) && !!pf && pf.width === 1280 && pf.height === 3000 && near(pf.at(640, 500), [255, 0, 0]) && near(pf.at(640, 1500), [0, 255, 0]) && near(pf.at(640, 2500), [0, 0, 255]),
        clipped: ok200(tl) && tallDims?.w === 1280 && tallDims.h === 20000 && art(tl).meta.truncated === true && tall.truncated === "true" && tall.height === "20000",
        one_browser_attempt: [vp, fp, tl].every((r) => same(strat(r), [["direct_browser"]])),
        residential: ok200(rs) && isUrl(rs.screenshot) && same(strat(rs), [["residential_browser"]]) && viaAll(rs.hits, "proxy"),
        mcp: mc?.status === 200 && mc.is_error !== true && mc.artifact_urls?.length === 1 && mc.has_data_url === false,
        worst_case: ok200(nz) && (nz.artifacts ?? []).length === 2 && nzBytes >= 6.5 * 1048576 && nzBytes <= 8 * 1048576,
        over_limit: over?.class === "RESOURCE_LIMIT" && (over.artifacts ?? []).length === 0,
        core_stable: core.restarts === "0" && Date.parse(core.started_at ?? "") < opened };
      return { ok: bad(cond).length === 0, actual: `failed=${bad(cond).join(",") || "none"}; viewport ${pv?.width}x${pv?.height} ${pv ? pv.at(640, 400) : ""}; full ${pf?.width}x${pf?.height}; clipped ${tallDims?.w}x${tallDims?.h} truncated=${art(tl)?.meta?.truncated}; residential ${JSON.stringify(strat(rs))}; mcp urls=${mc?.artifact_urls?.length}; worst case ${nz?.status} artifacts=${(nz?.artifacts ?? []).length} bytes=${nzBytes}; over the bound ${over?.class}; core restarts=${core.restarts} started=${core.started_at}` };
    } },
  B02: { name: "action-subset-correct-bounded-and-refused-outside-it", inputs: [`${RAW}e2e-fixture.txt`],
    expected: "on the action page, a selector wait, a click, a scroll, a content capture and a screenshot run in order: the capture holds the late element, the section the click revealed and the content the scroll loaded, and the screenshot is an artifact of 1280 x 800; a click on a same-host link loads that document, which the retrieval service counts against the domain (the phase's only counted action navigation); a click on a link to another host fails the render as ACTION_FAILED (the page may not leave its host) and the other host is never requested; executeJavascript, write, press, pdf, clicking every match, eleven actions, 16 s of waits, a screenshot's quality, the json format with a screenshot and a screenshot on a batch are each refused 400 UNSUPPORTED_OPTION naming the option, before any attempt or target request",
    run() {
      const x = FX().extras ?? [], r = FX().extras_refused ?? [];
      const ac = one(x, "actions"), oh = one(x, "offhost_click"), sh = one(x, "samehost_click");
      const navs = FX().retrieval_events?.[0]?.action_navigations ?? [];
      const s0 = ac?.scrapes?.[0], shot = ac?.artifacts?.[0];
      const ps = shot?.fetched?.saved ? png(shot.fetched.saved) : null;
      const names = ["execute_javascript", "write", "press", "pdf", "click_all", "eleven_actions", "waits_past_15s", "screenshot_quality", "json_with_screenshot", "screenshot_on_batch"];
      const refusedOk = names.every((n) => { const c = one(r, n); return c?.status === 400 && c.code === "UNSUPPORTED_OPTION" && !!c.option && (c.acquisitions ?? []).length === 0 && (c.hits ?? []).length === 0; });
      const cond = { actions: ok200(ac) && !!s0 && s0.has_late && s0.has_click_text && s0.has_scrolled && ac.action_screenshots?.length === 1 && /\/platform\/v1\/artifacts\//.test(ac.action_screenshots[0]) && !!ps && ps.width === 1280 && ps.height === 800,
        one_attempt: same(strat(ac), [["direct_browser"]]),
        samehost: ok200(sh) && /\/article/.test(sh.scrapes?.[0]?.url ?? "") && (sh.hits ?? []).some((h) => h.host === "m7shot" && h.path === "/article") && same(navs.map((n) => n.count), [1]),
        offhost: oh?.class === "ACTION_FAILED" && /another host/.test(oh.error ?? "") && !(oh.hits ?? []).some((h) => h.host === "m7" && h.path === "/article"),
        refused: refusedOk };
      return { ok: bad(cond).length === 0, actual: `failed=${bad(cond).join(",") || "none"}; capture ${JSON.stringify(s0 ?? null)}; samehost ${sh?.status} scrape ${sh?.scrapes?.[0]?.url ?? null} counted ${JSON.stringify(navs)}; offhost ${oh?.class}; refused ${names.map((n) => `${n}:${one(r, n)?.status}/${one(r, n)?.option}`).join(",")}` };
    } },
  B03: { name: "artifacts-owner-bound-and-expiring", inputs: [`${RAW}e2e-fixture.txt`],
    expected: "an artifact is served to its principal (200), and answers another principal's token exactly as an unknown id does (404 NOT_FOUND), a request with no token 401, a malformed id 400, and once past its retention 410 EXPIRED",
    run() {
      const a = one(FX().artifact_access, "owner_and_expiry");
      const cond = { owner: a?.owner_before === 200, other: a?.other === 404 && a.other_body?.code === "NOT_FOUND", unknown: a?.unknown === 404, none: a?.none === 401, bad_id: a?.bad_id === 400, expired: a?.expired === 410 && a.expired_code === "EXPIRED" };
      return { ok: bad(cond).length === 0, actual: `failed=${bad(cond).join(",") || "none"}; ${JSON.stringify(a)}` };
    } },
  B04: { name: "contexts-and-processes-cleaned", inputs: [`${RAW}e2e-fixture.txt`],
    expected: "a render whose actions run past the browser attempt's deadline fails typed (TIMEOUT) and a render whose Chromium is killed fails typed (a crash class) with the kill observed; after each the worker is idle, it launches a fresh browser, the next render with a screenshot succeeds, and the Chromium process count returns to within the warm browser's own (no context outlives its render)",
    run() {
      const c = one(FX().cleanup, "timeout_crash_success");
      const idle = (s) => s?.health?.busy === false;
      const crashCls = /^(BROWSER_CRASHED|RENDERER_CRASHED|BROWSER_ERROR|NAVIGATION_FAILED)$/;
      const retired = (c?.worker_log ?? []).some((l) => l.event === "browser_retired" || l.event === "browser_disconnected");
      const cond = { timeout: c?.timeout?.class === "TIMEOUT", crash: crashCls.test(c?.crash?.class ?? "") && c.crash.killed_processes >= 1,
        idle_after: idle(c?.after_timeout) && idle(c?.after_crash) && idle(c?.final), relaunched: retired && (c?.worker_log ?? []).some((l) => l.event === "browser_launched"),
        next_render: c?.next_render?.status === 200 && c.next_render.artifacts === 1,
        processes: [c?.after_timeout, c?.after_crash, c?.final].every((s) => Number.isFinite(s?.processes) && s.processes <= Math.max(c.before.processes, 12)) };
      return { ok: bad(cond).length === 0, actual: `failed=${bad(cond).join(",") || "none"}; timeout ${c?.timeout?.class}, crash ${c?.crash?.class} (killed ${c?.crash?.killed_processes}); chrome processes before ${c?.before?.processes}, after timeout ${c?.after_timeout?.processes}, after crash ${c?.after_crash?.processes}, final ${c?.final?.processes}` };
    } },

  // ================================================================ cache and changes (AC21)
  C01: { name: "cache-scope-freshness-expiry-and-billing", inputs: [`${RAW}e2e-fixture.txt`],
    expected: "a successful 2xx scrape is stored and the same principal's same request within maxAge is a hit (cacheState hit, no attempt, no target request); another principal, other options, maxAge 0, a plain scrape that asked nothing of the cache, a request with storeInCache false, a 500 page, a 404 page and an expired entry are each a miss that reaches the target; a cached enhanced answer is served again with no provider request and no new ledger row",
    run() {
      const c = FX().cache ?? [], k = (n) => one(c, n);
      const miss = (r) => ok200(r) && r.cache === "miss" && r.hits >= 1;
      const cond = { stored_then_hit: miss(k("first_miss_stored")) && ok200(k("hit")) && k("hit").cache === "hit" && k("hit").cacheState === "hit" && k("hit").hits === 0 && k("hit").acquisitions === 0,
        scope: miss(k("other_principal_miss")) && miss(k("other_options_miss")) && miss(k("max_age_zero_miss")),
        not_stored: miss(k("store_false_first")) && miss(k("store_false_not_kept")) && miss(k("plain_first")) && miss(k("plain_not_kept")),
        errors_not_cached: k("error_500_first")?.statusCode === 500 && miss(k("error_500_not_kept")) && k("error_404_first")?.statusCode === 404 && miss(k("error_404_not_kept")),
        expiry: miss(k("expired_miss")),
        billing: ok200(k("enhanced_first")) && k("enhanced_first").calls === 1 && ok200(k("enhanced_hit")) && k("enhanced_hit").cache === "hit" && k("enhanced_hit").calls === 0 && k("enhanced_hit").hits === 0
          && k("enhanced_ledger")?.rows_after === k("enhanced_ledger").rows_before + 1 };
      return { ok: bad(cond).length === 0, actual: `failed=${bad(cond).join(",") || "none"}; ${c.map((r) => `${r.case}:${r.cache ?? "-"}/${r.hits ?? "-"}`).join(" ")}` };
    } },
  C02: { name: "parse-cache-owner-scoped", inputs: [`${RAW}e2e-fixture.txt`],
    expected: "M5 review S1: a scan-only PDF parsed for one principal is a cache hit for that principal's second scrape (no upload) and a fresh parse for another principal (one more upload), each returning the document's text; the parse cache holds one row per principal, keyed by two different sixteen-hex owner tags",
    run() {
      const p = one(FX().parse_cache, "owner_scoped");
      const [u0, u1, u2, u3] = p?.uploads ?? [];
      const owners = (p?.rows ?? []).map((r) => r.owner);
      const cond = { uploads: u1 === u0 + 1 && u2 === u1 && u3 === u2 + 1, text: (p?.results ?? []).length === 3 && p.results.every((r) => r.status === 200 && r.text === true),
        rows: owners.length === 2 && owners.every((o) => /^[0-9a-f]{16}$/.test(o)) && new Set(owners).size === 2, logged: (p?.parse_log ?? []).some((l) => l.cached === true) };
      return { ok: bad(cond).length === 0, actual: `failed=${bad(cond).join(",") || "none"}; uploads ${JSON.stringify(p?.uploads)}; owners ${owners.join(",")}` };
    } },
  C03: { name: "change-detection", inputs: [`${RAW}e2e-fixture.txt`],
    expected: "a page's first look is new, the same text again is same, a real text change is changed with a line diff showing the added line, an error page and a bot interstitial at the same URL are 422 NOT_COMPARED and replace nothing (the next successful look at the version seen before them is same), a later change is changed again, and another principal's first look at the page is new",
    run() {
      const c = FX().changes ?? [], k = (n) => one(c, n);
      const cond = { new: k("first_new")?.changeStatus === "new", same: k("unchanged_same")?.changeStatus === "same",
        changed: k("text_changed")?.changeStatus === "changed" && /^\+ Added in version 2: a new line of text\.$/m.test(k("text_changed").diff?.text ?? "") && k("text_changed").diff.added >= 1,
        errors: k("error_page_not_compared")?.status === 422 && k("error_page_not_compared").code === "NOT_COMPARED" && k("challenge_not_compared")?.status === 422 && k("challenge_not_compared").code === "NOT_COMPARED",
        kept: k("after_failures_same")?.changeStatus === "same" && k("after_failures_same").contentSha256 === k("text_changed")?.contentSha256,
        again: k("changed_again")?.changeStatus === "changed", other: k("other_principal_new")?.changeStatus === "new" };
      return { ok: bad(cond).length === 0, actual: `failed=${bad(cond).join(",") || "none"}; ${c.map((r) => `${r.case}:${r.changeStatus ?? r.code}`).join(" ")}` };
    } },

  // ================================================================ webhooks (AC20)
  W01: { name: "webhooks-signed-retried-deduplicated-and-restricted", inputs: [`${RAW}e2e-fixture.txt`],
    expected: "a batch naming the approved receiver gets its started and completed events delivered and accepted by the receiver's signature and timestamp check, each once; a receiver refusing twice sees the same event id three times and accepts it once, the receipt showing DELIVERED after three attempts; a receiver that never accepts sees the event limits.webhooks.maxAttempts times and the receipt shows it DEAD; a private address, a public host and an unlisted path on the approved host are refused 400 before any receipt; the receiver refuses a stale timestamp and a tampered body (401) and acknowledges a replay as a duplicate",
    run() {
      const w = FX().webhooks ?? [], k = (n) => one(w, n), max = json("deploy/policies/capabilities.json").limits.webhooks.maxAttempts;
      const d = k("delivered"), rt = k("retried_then_delivered"), dd = k("dead_after_attempts"), un = k("unapproved_refused"), rc = k("receiver_check");
      const types = (h) => (h ?? []).map((e) => `${e.type}:${e.state}:${e.attempts}`).sort();
      const rtId = rt?.webhooks?.[0]?.eventId;
      const cond = { delivered: d?.status === 200 && same(types(d.webhooks), ["batch_scrape.completed:DELIVERED:1", "batch_scrape.started:DELIVERED:1"]) && (d.accepted ?? []).length === 2 && (d.received ?? []).every((r) => r.verdict === "accepted"),
        retried: same(types(rt?.webhooks), ["batch_scrape.completed:DELIVERED:3"]) && (rt.received ?? []).filter((r) => r.eventId === rtId).map((r) => r.verdict).join(",") === "failing_on_purpose,failing_on_purpose,accepted" && (rt.accepted ?? []).length === 1,
        dead: same(types(dd?.webhooks), [`batch_scrape.completed:DEAD:${max}`]) && dd.received === max,
        unapproved: (un?.refused ?? []).length === 3 && un.refused.every((r) => r.status === 400 && r.code === "UNSUPPORTED_OPTION" && r.option === "webhook.url") && un.jobs_before === un.jobs_after,
        receiver: rc?.same?.status === 200 && rc.same.verdict === "duplicate" && rc.stale?.status === 401 && rc.stale.verdict === "stale_timestamp" && rc.tampered?.status === 401 && rc.tampered.verdict === "bad_signature" };
      return { ok: bad(cond).length === 0, actual: `failed=${bad(cond).join(",") || "none"}; delivered ${JSON.stringify(types(d?.webhooks))}; retried ${JSON.stringify(types(rt?.webhooks))}; dead ${JSON.stringify(types(dd?.webhooks))} received ${dd?.received}; unapproved ${(un?.refused ?? []).map((r) => r.status).join(",")}` };
    } },
  W02: { name: "webhooks-suppressed-during-restore", inputs: [`${RAW}e2e-fixture.txt`],
    expected: "with the retrieval service running under deploy/compose.webhooks-suppressed.yaml, a finished job's event stays PENDING with no attempt counted and WEBHOOKS_SUPPRESSED as its last error, and the receiver gets nothing; back on the committed Compose file, the same event is delivered",
    run() {
      const s = one(FX().webhooks, "suppressed_then_delivered");
      const held = s?.while_suppressed?.[0], after = s?.after?.[0];
      const cond = { held: held?.state === "PENDING" && held.attempts === 0 && /WEBHOOKS_SUPPRESSED/.test(held.lastError ?? "") && s.received_while_suppressed === 0,
        delivered_after: after?.state === "DELIVERED" && after.eventId === held?.eventId && s.received_after >= 1, back_enabled: same(s?.delivery_env, ["PI_WEBHOOK_DELIVERY=enabled"]) };
      return { ok: bad(cond).length === 0, actual: `failed=${bad(cond).join(",") || "none"}; while suppressed ${JSON.stringify(held)}; after ${JSON.stringify(after)}` };
    } },

  // ================================================================ the manifest, the public sample
  K01: { name: "capability-manifest-and-mcp-catalog", inputs: ["deploy/policies/capabilities.json", `${RAW}e2e-fixture.txt`],
    expected: "the manifest offers the enhanced proxy, the screenshot format (on /v2/scrape only), the five-action subset, the cache options on /v2/scrape, webhooks on crawl, batch and extract, and the artifact and changes routes; it still refuses change tracking (naming /platform/v1/changes), the unsafe actions, minAge and lockdown, and lists the Cloud agent, browser and interact routes as not enabled; the MCP catalog's scrape tool offers the same proxy values, actions and cache bound, and the crawl tool the webhook events",
    run() {
      const m = json("deploy/policies/capabilities.json"), cat = FX().mcp_catalog?.[0];
      const acts = m.bodies.scrape.fields.actions;
      const ne = m.not_enabled.map((r) => r.path);
      const cond = { proxy: same(m.fieldsets.scrapeOptions.proxy.values, ["auto", "basic", "stealth", "enhanced"]),
        screenshot: m.formats.allowed.includes("screenshot") && m.formats.scrapeOnly.includes("screenshot") && !m.formats.refused.screenshot,
        actions: same(Object.keys(acts.subset), ["wait", "click", "scroll", "screenshot", "scrape"]) && acts.maxItems === 10 && acts.maxWaitMs === 15000 && ["write", "press", "executeJavascript", "pdf"].every((a) => !!acts.refused[a]),
        cache: m.bodies.scrape.fields.maxAge?.max === 3600000 && m.bodies.scrape.fields.storeInCache?.type === "boolean" && /\/v2\/scrape only/.test(m.refused.maxAge),
        webhooks: ["crawl", "batch", "extract"].every((b) => m.bodies[b].fields.webhook?.type === "webhook"),
        routes: m.routes.some((r) => r.id === "platform.artifact") && m.routes.some((r) => r.id === "platform.changes"),
        still_refused: /\/platform\/v1\/changes/.test(m.formats.refused.changeTracking) && !!m.refused.minAge && !!m.refused.lockdown && ["/v2/agent", "/v2/browser", "/v2/scrape/{id}/interact"].every((p) => ne.includes(p)),
        catalog: cat?.status === 200 && same(cat.scrape_proxy_enum, ["auto", "basic", "stealth", "enhanced"]) && same(cat.scrape_actions, ["wait", "click", "scroll", "screenshot", "scrape"]) && cat.scrape_max_age === 3600000 && same(cat.crawl_webhook_events, ["started", "completed", "failed"]) && cat.tools.length === m.mcp.tools.length };
      return { ok: bad(cond).length === 0, actual: `failed=${bad(cond).join(",") || "none"}; mcp tools=${cat?.tools?.length}; scrape proxy ${JSON.stringify(cat?.scrape_proxy_enum)}; actions ${JSON.stringify(cat?.scrape_actions)}` };
    } },
  L02: { name: "public-sample-documented", inputs: [`${RAW}e2e-live.txt`],
    expected: "the declared public sample (twenty URLs over at least five domains, fixed in scripts/m7/e2e.mjs before any result) was requested once each through the production selection, which the live phase set and recorded (live search, the budget's default proxy and enhancer), and every result is recorded with its outcome; the usable-retrieval rate is computed per class and in all, a result being usable when it returned 200 with markdown; the rate is documented as the tiers this deployment may use now, not a claim about the web",
    run() {
      const p = LIVE().public_sample ?? [];
      const d = one(p, "declared"), rs = p.filter((r) => r.case === "result");
      if (!d) return { notRun: true, actual: "the live phase recorded no public sample" };
      const usable = (r) => r.status === 200 && r.success === true && r.markdown_chars >= 200;
      const byClass = {};
      for (const r of rs) { const c = (byClass[r.class] ??= { n: 0, usable: 0 }); c.n++; if (usable(r)) c.usable++; }
      const why = (r) => (/Retrieval failed: ([A-Z_]+)\./.exec(r.error ?? "") ?? [])[1] ?? r.code ?? (r.status === 200 ? `markdown ${r.markdown_chars} chars` : `HTTP ${r.status}`);
      const fails = rs.filter((r) => !usable(r)).map((r) => `${new URL(r.url).hostname} (${r.class}): ${why(r)}`);
      const declaredUrls = (d.urls ?? []).map((u) => u.url);
      const B = json("deploy/policies/budget.json"), sel = one(p, "selection");
      const cond = { declared: declaredUrls.length === 20 && d.domains >= 5, all_recorded: rs.length === 20 && same(rs.map((r) => r.url), declaredUrls),
        production: sel?.applied === true && sel.search === "live" && sel.proxy === B.proxying.defaultProxy && sel.enhanced === B.enhancing.defaultEnhancer };
      const total = rs.filter(usable).length;
      return { ok: bad(cond).length === 0, actual: `failed=${bad(cond).join(",") || "none"}; usable ${total}/${rs.length} (${Math.round((100 * total) / Math.max(1, rs.length))}%); ${Object.entries(byClass).map(([k, v]) => `${k} ${v.usable}/${v.n}`).join(", ")}; not usable: ${fails.join(", ") || "none"}` };
    } },

  // ================================================================ the host
  X01: { name: "zero-firecrawl-cloud-attempts", inputs: [`${RAW}guard-window-open.txt`, `${RAW}egress-probe.txt`, `${RAW}core-logs-final.txt`, `${RAW}stack.txt`, `${RAW}e2e-fixture.txt`],
    expected: "across one window, from a guard-counter snapshot before the first phase to the egress probe after the last, with the guard's table not reloaded and every phase inside it: during the fixture phase the guard accepted no web connection and no proxy-port connection (every M7 fixture is on the internal fixture network); after a live phase only its own; the core's saved log classifies every Cloud line; the retrieval logs (the container before the suppression case and its successor) name no Cloud host; every driver's sockets went only to the forward",
    run() {
      const utcOf = (f) => Date.parse(((sections(f).meta ?? []).join(" ").match(/utc=(\S+?Z)/) ?? [])[1]);
      const handle = (f) => ((sections(f).meta ?? []).join(" ").match(/guard_table_handle=(\d+)/) ?? [])[1];
      const counter = (f, sec, name) => +((sections(f)[sec] ?? []).find((l) => l.startsWith(`${name} `)) ?? "=NaN").split("=")[1];
      const open = utcOf(`${RAW}guard-window-open.txt`), close = utcOf(`${RAW}egress-probe.txt`);
      const inWindow = (t) => Number.isFinite(t) && t > open && t < close;
      const live = has(`${RAW}e2e-live.txt`) ? LIVE() : null;
      const liveRan = !!live && (live.public_sample ?? []).some((r) => r.case === "result");
      const phases = [FX(), ...(live ? [live] : [])];
      const web = counter(`${RAW}egress-probe.txt`, "guard_after", "egress_web_accepted") - counter(`${RAW}guard-window-open.txt`, "counters", "egress_web_accepted");
      const proxy = counter(`${RAW}egress-probe.txt`, "guard_after", "egress_proxy_accepted") - counter(`${RAW}guard-window-open.txt`, "counters", "egress_proxy_accepted");
      const recs = Object.entries(sections(`${RAW}core-logs-final.txt`)).filter(([k]) => /^(instance|stored)_/.test(k)).map(([, lines]) => {
        const c = lines.find((l) => l.startsWith("classified ")); const ctl = +((lines.find((l) => l.startsWith("control=")) ?? "").match(/count=(\d+)/) ?? [])[1];
        return { c: c ? kv(c.split(" ").slice(1)) : null, ctl };
      });
      const scans = [scanOf(S(`${RAW}stack.txt`).retrieval_log_scan), scanOf(one(FX().retrieval_log_scan, "before_recreate")?.lines)];
      const conns = phases.map((p) => p.connections?.[0]);
      const cond = { same_guard: !!handle(`${RAW}guard-window-open.txt`) && handle(`${RAW}guard-window-open.txt`) === handle(`${RAW}egress-probe.txt`), phases_inside: phases.every((p) => inWindow(Date.parse(p.meta?.[0]?.pi_utc ?? ""))),
        counters_read: Number.isFinite(web) && Number.isFinite(proxy), egress: liveRan ? web >= 1 && proxy === 0 : web === 0 && proxy === 0,
        core_logs: recs.length >= 1 && recs.every((r) => r.c && r.c.cloud_unexplained === "0" && r.c.dns_unexplained === "0" && r.ctl >= 1),
        retrieval_logs: +scans[1].acquisition >= 40 && +scans[0].enhanced >= 1 && +scans[0].webhook_attempt >= 1 && scans.every((s) => s.cloud_host === "0"), drivers: conns.every((c) => c && same(c.hosts, ["127.0.0.1:3380"]) && c.lookups.length === 0) };
      return { ok: bad(cond).length === 0, actual: `failed=${bad(cond).join(",") || "none"}; guard handle ${handle(`${RAW}guard-window-open.txt`)}→${handle(`${RAW}egress-probe.txt`)}, web accepted delta=${web}, proxy-port accepted delta=${proxy}, live ran=${liveRan}; core logs=${recs.length}; retrieval log lines=${scans.map((s) => s.lines).join("+")} cloud=${scans.map((s) => s.cloud_host).join("+")}` };
    } },
  X02: { name: "network-and-container-posture", inputs: [`${RAW}stack.txt`, `${EV}rendered-compose.json`],
    expected: "fixture-m7 sits on the internal fixture network alone with no default route, answers under its seven fixture names, mounts only its key's SHA-256 and the receiver's secret, and runs with a read-only root, dropped capabilities, no Docker socket and a 96 MiB cap without swap; the fixture network stays internal; the only host publication is still 127.0.0.1:3380; all fifteen containers run aarch64 and every swap limit is 0; the retrieval service and the browser worker run with the extras on and delivery enabled",
    run() {
      const st = S(`${RAW}stack.txt`), R = json(`${EV}rendered-compose.json`).services;
      const net = (n) => (st.networks ?? []).find((l) => l.startsWith(`${n} `)) ?? "";
      const pub = (st.published ?? []).filter((l) => /->/.test(l));
      const cg = (s) => kv(((st.cgroups ?? []).find((l) => l.startsWith(`${s} `)) ?? "").split(" ").slice(1));
      const c = (s) => kv(((st.containers ?? []).find((l) => l.startsWith(`${s} name=`)) ?? "").split(" "));
      const arch = (st.containers ?? []).filter((l) => / uname_m=/.test(l));
      const reach = st.fixture_m7_reach ?? [];
      const rk = kv(((reach.find((l) => l.startsWith("networks=")) ?? "")).split(" "));
      const sw = JSON.parse(((st.retrieval_log_scan ?? []).find((l) => l.startsWith("switches_logged=")) ?? "switches_logged=null").slice(16));
      const cond = { fixture_internal: /internal=true/.test(net("fcpi_fixture")) && /gateway_mode_ipv4=isolated/.test(net("fcpi_fixture")) && /fcpi-fixture-m7-1/.test(net("fcpi_fixture")),
        m7_reach: reach.includes("default_route=no") && rk.networks === "fcpi_fixture" && same((rk.aliases ?? "").split(",").filter((a) => a.endsWith(".fixture.fcpi.test")), ["hooks", "m7", "m7cache", "m7chg", "m7esc", "m7shot", "zyte"].map((h) => `${h}.fixture.fcpi.test`)) && rk.secrets_mounted === "/run/secrets/fixture_webhook_secret,/run/secrets/fixture_zyte_sha256" && same(Object.keys(R["fixture-m7"].networks), ["fixture"]),
        publication: pub.length === 1 && /^access-gateway 3300\/tcp -> 127\.0\.0\.1:3380$/.test(pub[0]),
        posture: c("fixture-m7").readonly_rootfs === "true" && c("fixture-m7").cap_drop === "ALL" && c("fixture-m7").docker_sock_mount === "0" && c("fixture-m7").privileged === "false",
        memory: cg("fixture-m7")["memory.max"] === String(96 * MIB),
        swap: (st.cgroups ?? []).length === 15 && (st.cgroups ?? []).every((l) => / memory\.swap\.max=0 /.test(l)), arch: arch.length === 15 && arch.every((l) => /uname_m=aarch64$/.test(l)),
        switches: sw?.browser_extras === true && sw.webhook_delivery === "enabled" && R["browser-worker"].environment?.PI_BROWSER_EXTRAS_ENABLED === "true" };
      return { ok: bad(cond).length === 0, actual: `failed=${bad(cond).join(",") || "none"}; ${net("fcpi_fixture")}; fixture-m7 ${reach.join(" ")}; publications=${pub.join(";")}; switches ${JSON.stringify(sw)}` };
    } },
  X03: { name: "retrieval-log-hygiene", inputs: [`${RAW}stack.txt`, `${RAW}e2e-fixture.txt`],
    expected: "both retrieval containers' whole logs (the one the suppression case recreated, scanned before it went, and its successor; with acquisitions, enhanced dispatches and webhook attempts as the positive control) hold no provider key, client token, bearer or Basic credential, no Proxy-Authorization, no proxy session username, no webhook signature, and not the fixture proxy's credential, the fixture enhanced provider's key or the webhook signing secret, each looked for by value; and the budget policy hash logged at start is the deployed file's",
    run() {
      const st = S(`${RAW}stack.txt`), a = scanOf(one(FX().retrieval_log_scan, "before_recreate")?.lines), b = scanOf(st.retrieval_log_scan);
      const h = kv(((st.retrieval_log_scan ?? []).find((l) => l.startsWith("budget_policy_sha256_logged=")) ?? "").split(" "));
      const clean = (s) => ["provider_key_like", "client_token_like", "bearer", "proxy_authorization", "basic_credential", "session_username", "signature", "fixture_credential", "zyte_fixture_key", "webhook_secret", "cloud_host"].every((k) => s[k] === "0");
      const readable = (s) => s.fixture_credential_readable === "yes" && s.zyte_fixture_key_readable === "yes" && s.webhook_secret_readable === "yes";
      const cond = { read: +a.acquisition >= 40 && +a.enhanced >= 8 && +a.renders_with_extras >= 1 && +b.enhanced >= 1 && +b.webhook_attempt >= 1 && readable(a) && readable(b),
        clean: clean(a) && clean(b),
        budget_hash: /^[0-9a-f]{64}$/.test(h.budget_policy_sha256_logged ?? "") && h.budget_policy_sha256_logged === h.budget_policy_sha256_deployed && h.budget_policy_sha256_deployed === sha256File("deploy/policies/budget.json") };
      return { ok: bad(cond).length === 0, actual: `failed=${bad(cond).join(",") || "none"}; before recreate lines=${a.lines} acquisitions=${a.acquisition} enhanced=${a.enhanced} extras=${a.renders_with_extras}; after lines=${b.lines} enhanced=${b.enhanced} webhook=${b.webhook_attempt}` };
    } },
  M01: { name: "memory-within-caps", inputs: [`${RAW}stack.txt`, `${RAW}e2e-fixture.txt`],
    expected: "every sample of the retrieval service, the browser worker, SearXNG, the gateway, the MCP service, the core, fixture-m6 and fixture-m7 peaks below 90% of its cap, no sampled cgroup records an OOM kill, the host's OOM-kill count does not rise across the samples, MemAvailable stays above 1 GiB (spec §22's reserve), and the stack's final cgroups agree",
    run() {
      const xs = samples(), st = S(`${RAW}stack.txt`);
      const svcs = ["retrieval", "browser", "searxng", "gateway", "mcp", "core", "fixture_m6", "fixture_m7"];
      const peaks = Object.fromEntries(svcs.map((s) => [s, Math.max(...xs.map((x) => (x[s] ? x[s].peak / Number(x[s].max) : 0)))]));
      const ooms = xs.flatMap((x) => svcs.map((s) => x[s]?.oom_kill ?? 0)).some((n) => n > 0);
      const vm = xs.map((x) => x.vmstat_oom_kill), avail = Math.min(...xs.map((x) => x.mem_available_kib));
      const cg = (st.cgroups ?? []).map((l) => kv(l.split(" ").slice(1)));
      const cond = { samples: xs.length >= 4, peaks: svcs.every((s) => peaks[s] > 0 && peaks[s] < 0.9), no_oom: !ooms && cg.every((c) => c.oom_kill === "0"), host_oom: vm.every((v) => v === vm[0]), headroom: avail > 1024 * 1024 };
      return { ok: bad(cond).length === 0, actual: `failed=${bad(cond).join(",") || "none"}; samples=${xs.length}; peak fractions=${JSON.stringify(Object.fromEntries(Object.entries(peaks).map(([k, v]) => [k, +v.toFixed(3)])))}; min MemAvailable=${Math.round(avail / 1024)} MiB` };
    } },
  X04: { name: "unrelated-state-unchanged", inputs: [`${EV}snapshot-before.txt`, `${EV}snapshot-after.txt`, `${RAW}nft-ruleset.txt`, "evidence/M6/raw/nft-ruleset.txt"],
    expected: "every line differing between M7's BEFORE and AFTER snapshots is attributed to the project (fcpi containers, their scopes, root filesystems and namespaces, kernel modules for the runtime, the ruleset), the collector's own SSH session, or the owner's own work that raw/owner-session.txt records; no unrelated line is removed or changed; the boot ID is unchanged, or changed only across reboots raw/reboot.txt ties to both snapshots, each an orderly shutdown the host's own Wi-Fi watchdog started after a Wi-Fi loss, with no local action after the loss and no undervoltage; rule by rule against M6's recorded ruleset, nothing changed (M7 needs no new egress), and the installed guard is the repository's",
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
      const r5 = ruleSet("evidence/M6/raw/nft-ruleset.txt"), r6 = ruleSet(`${RAW}nft-ruleset.txt`);
      const ruleChanges = [...[...r6].filter((r) => !r5.has(r)).map((r) => `+ ${r}`), ...[...r5].filter((r) => !r6.has(r)).map((r) => `- ${r}`)];
      const unattributed = ruleChanges.map((ch) => ch.replace(/\t/g, " ").slice(0, 110));
      const afterHash = (read(A).match(/^nft_ruleset_sha256=([0-9a-f]{64})$/m) ?? [])[1];
      const rulesTied = /^[0-9a-f]{64}$/.test(hdr.ruleset_sha256 ?? "") && hdr.ruleset_sha256 === afterHash;
      writeFileSync(resolve(ROOT, `${EV}snapshot-diff.txt`), ["# M7 BEFORE/AFTER snapshot diff (section-keyed; written by scripts/m7/verify.mjs X04)",
        `# before: ${read(B).split("\n")[1]}  after: ${read(A).split("\n")[1]}`, `# boot_id: ${boot(B) && boot(B) === boot(A) ? "unchanged (no reboot)" : tie ? `changed across the reboots raw/reboot.txt ties to both snapshots (the earlier boots ended ${tie.ended})` : "CHANGED or MISSING"}`,
        `## changes to unrelated state (${rows.unrelated.length})`, ...rows.unrelated, `## the owner's own work on the Pi and Pi-hole's own socket rotation (${rows.owner.length}; raw/owner-session.txt)`, ...rows.owner,
        `## the reboot's own changes (${rows.reboot.length})`, ...rows.reboot,
        `## project changes and the collector's own SSH sessions (${rows.project.length})`, ...rows.project,
        `## ruleset changes since M6's recorded ruleset (${ruleChanges.length}; none expected)`, ...ruleChanges.map((r) => r.replace(/\t/g, " ")), ""].join("\n"));
      const ok = unexplained.length === 0 && !!boot(B) && (boot(B) === boot(A) || !!tie) && guardOk && rulesTied && r5.size > 50 && r6.size > 50 && unattributed.length === 0 && ruleChanges.length === 0;
      return { ok, actual: `added=${added.length} removed=${removed.length}; attributed ${JSON.stringify(why)}; unexplained=${unexplained.length}${unexplained.length ? " [" + unexplained.slice(0, 8).join("; ") + "]" : ""}; boot_id_equal=${boot(B) === boot(A)}, reboot tied=${!!tie}; rules changed since M6=${ruleChanges.length}, unattributed=${unattributed.length}${unattributed.length ? " [" + unattributed.slice(0, 6).join("; ") + "]" : ""}; guard is the repository's=${guardOk}; ruleset tied to AFTER=${rulesTied}` };
    } },
  X05: { name: "secret-and-identifier-redaction-scan", inputs: [M0_CONTROL, M1_CONTROL, M3_CONTROL, "scripts/m1/pi-target.conf", "evidence/M0/audit.json"], live: true,
    expected: "the positive controls fire every rule; then no rule matches in any tracked or new repository file; no file holds any live secret (M4's and M5's, the webhook signing secret, every provider file present, the fixture proxy's credential and the fixture enhanced provider's key among them, and every client token file on the Pi), compared by SHA-256 computed on the Pi; no file added or changed since M7 began holds the Pi's LAN address, its /24 network or its SSH target",
    run() {
      const c = [...scan([M0_CONTROL], { m0: { egress: sha256("192.0.2.77"), serial: sha256("0123456789abcdef"), machineId: sha256("0123456789abcdef0123456789abcdef"), macs: new Set([sha256("02:00:00:00:00:01")]) } }, RULES, new Set()),
        ...scan([M1_CONTROL], { secrets: new Set([sha256("0f".repeat(32)), sha256("ABCDEFGHIJKLMNOP".repeat(4))]) }, RULES, new Set()),
        ...scan([M3_CONTROL], {}, RULES, new Set())];
      const fired = new Set(c.map((h) => h.split(" ").pop()));
      const silent = [...RULES.map(([n]) => n), ...HASH_RULES].filter((r) => !fired.has(r));
      if (silent.length) return { ok: false, actual: `positive controls: rules that did not fire: ${silent.join(", ")}` };
      const hashes = ssh(`sudo -n sh -c 'S=/etc/firecrawl-pi/secrets; h() { [ -n "$1" ] || { echo "EMPTY secret extraction" >&2; exit 1; }; printf "%s" "$1" | sha256sum | cut -c1-64; }; \
        h "$(cat $S/postgres_password)"; h "$(cat $S/core_postgres_password)"; h "$(sed -n "s#^amqp://fcpi:\\(.*\\)@rabbitmq:5672\\$#\\1#p" $S/core_nuq_rabbitmq_url)"; \
        h "$(sed -n "s#^redis://[^:@]*:\\(.*\\)@redis:6379\\$#\\1#p" $S/core_redis_url)"; h "$(cat /srv/firecrawl-pi/data/rabbitmq/.erlang.cookie)"; \
        h "$(cat $S/retrieval_postgres_password)"; h "$(cat $S/core_retrieval_token)"; h "$(cat $S/retrieval_browser_token)"; \
        h "$(cat $S/gateway_postgres_password)"; h "$(cat $S/gateway_retrieval_token)"; h "$(cat $S/searxng_proxy_password)"; h "$(cat $S/searxng_secret_key)"; h "$(cat $S/webhook_signing_secret)"; \
        for f in $S/providers/*; do [ -f "$f" ] && { h "$(tr -d "\\n" < "$f")"; case "$(tr -d "\\n" < "$f")" in *:*) h "$(tr -d "\\n" < "$f" | cut -d: -f2-)";; esac; }; done; for f in $S/clients/*.token; do h "$(tr -d "\\n" < "$f")"; done'`).split("\n").filter((x) => /^[0-9a-f]{64}$/.test(x));
      const tokenFiles = +ssh("sudo -n sh -c 'ls /etc/firecrawl-pi/secrets/clients/*.token | wc -l'").trim();
      const providerFiles = +ssh("sudo -n sh -c 'ls -A /etc/firecrawl-pi/secrets/providers | wc -l'").trim();
      const pairFiles = +ssh("sudo -n sh -c 'grep -l : /etc/firecrawl-pi/secrets/providers/* 2>/dev/null | wc -l'").trim();
      if (tokenFiles < 14 || providerFiles < 1 || hashes.length !== 13 + providerFiles + pairFiles + tokenFiles || new Set(hashes).size !== hashes.length || hashes.includes(sha256(""))) return { ok: false, actual: `expected thirteen fixed secrets, ${providerFiles} provider files (${pairFiles} with a password part) and every client token as distinct non-empty hashes; got ${hashes.length} hashes for ${tokenFiles} token files` };
      const files = execFileSync("git", ["-C", ROOT, "ls-files", "--cached", "--others", "--exclude-standard"], { encoding: "utf8" }).split("\n").filter((f) => f && ![M0_CONTROL, M1_CONTROL, M3_CONTROL].includes(f) && has(f) && !/\.(pdf|png|gz)$/.test(f));
      const audit = json("evidence/M0/audit.json");
      const m0 = { egress: audit.network.egress_ip_sha256, serial: audit.identity.board_serial_sha256, machineId: audit.identity.machine_id_sha256, macs: new Set([...Object.values(audit.identity.mac_sha256), sha256("00:00:00:00:00:00")]) };
      const hits = scan(files, { m0, secrets: new Set(hashes) });
      const t = target(), lan = t.PI_LAN_ADDRESS, net = lan.replace(/\.\d+$/, ".0");
      const changed = [...new Set([...git("diff", "--name-only", `${M7_START}..HEAD`).split("\n"), ...git("ls-files", "--others", "--exclude-standard").split("\n")])].filter((f) => f && has(f) && !/\.(pdf|png|gz)$/.test(f));
      const idHits = changed.filter((f) => { const x = read(f); return x.includes(lan) || x.includes(`${net}/`) || x.includes(t.PI_SSH_TARGET); });
      return { ok: hits.length === 0 && idHits.length === 0, configHash: hashOf(files.filter((f) => f !== OUT)), actual: `controls fired all ${RULES.length + HASH_RULES.length} rules; files scanned=${files.length}; live secret hashes compared=${hashes.length} (provider files ${providerFiles}, password parts ${pairFiles}, client tokens ${tokenFiles}); findings=${hits.length}${hits.length ? " [" + hits.slice(0, 12).join("; ") + "]" : ""}; M7 files with the LAN address, network or SSH target=${idHits.join(",") || "none"} (of ${changed.length})` };
    } },
  L03: { name: "lock-and-compose-consistent", inputs: ["deploy/versions.lock.json", "deploy/compose.yaml", `${EV}rendered-compose.json`, "deploy/policies/budget.json", "deploy/policies/egress.json", "deploy/policies/capabilities.json", "patches/series.json"],
    expected: "every Compose image is pinned by digest for linux/arm64 across M7's fifteen services; the lock records the API image and ten-patch series the core runs, the retrieval, gateway, MCP and browser images the stack runs, the budget policy's hash with its rate cards (Zyte's among them), the egress policy's hash with its webhook destinations, the guard's hash, the fixture-m7 image, and the capability manifest's hash",
    run() {
      const R = json(`${EV}rendered-compose.json`), L = json("deploy/versions.lock.json"), s = json("patches/series.json"), E = json("deploy/policies/egress.json");
      const unpinned = Object.entries(R.services).filter(([, v]) => !/@sha256:[0-9a-f]{64}$/.test(v.image) || v.platform !== "linux/arm64").map(([k]) => k);
      const cond = { api: L.images?.firecrawl_api_patched?.image_id === digestOf(R.services["firecrawl-core"].image) && L.images.firecrawl_api_patched.patch_series_sha256 === s.series_sha256 && L.patches?.series_sha256 === s.series_sha256 && L.patches.patches.length === 10,
        services: L.images?.retrieval?.image_id === digestOf(R.services["retrieval-service"].image) && L.images?.access_gateway?.image_id === digestOf(R.services["access-gateway"].image) && L.images?.mcp_gateway?.image_id === digestOf(R.services["mcp-gateway"].image)
          && L.images?.browser_worker?.image_id === digestOf(R.services["browser-worker"].image),
        budget: L.providers?.budget_policy?.sha256 === sha256File("deploy/policies/budget.json") && same(L.providers.rate_cards, json("deploy/policies/budget.json").rateCards) && L.providers.rate_cards.some((c) => c.subject === "zyte-api"),
        egress: L.egress?.policy_sha256 === sha256File("deploy/policies/egress.json") && same(L.egress.webhooks, E.webhooks) && L.egress.guard_sha256 === sha256File("deploy/host/fcpi-guard.nft"),
        fixture: L.images?.fixture_m7?.image === R.services["fixture-m7"].image, manifest: L.gateway?.capabilities_sha256 === sha256File("deploy/policies/capabilities.json") };
      return { ok: unpinned.length === 0 && bad(cond).length === 0 && Object.keys(R.services).length === 15, actual: `services=${Object.keys(R.services).length}; unpinned=${unpinned.join(",") || "none"}; lock disagrees on=${bad(cond).join(",") || "none"}` };
    } },

  // ================================================================ the review of record
  V01: { name: "review-record-complete", inputs: [`${EV}review/REVIEW.md`],
    expected: "the saved /review-2 report (CLAUDE.md §5) gives every finding it lists, and every finding found during M7 outside the review (F), a row with an outcome (fixed with its commit, rejected with evidence, deferred to M8 or M9), gives every finding an earlier review deferred to M7 (M5's S1) a row of its own with an outcome, cites only commits that exist, and holds no absolute local path",
    run() {
      const text = read(`${EV}review/REVIEW.md`);
      const OUTCOME = /^(Fixed|Rejected, with the evidence|Deferred to M[89]\b)/;
      const rows = text.split("\n").filter((l) => /^\| [A-Z]{1,2}\d+ \|/.test(l)).map((l) => l.split(" | "));
      const badRows = rows.filter((c) => !OUTCOME.test(c[3] ?? "")).map((c) => c[0].slice(2));
      const carried = ["M0", "M1", "M2", "M3", "M4", "M5", "M6"].flatMap((m) => { const dir = `evidence/${m}/review`;
        return has(dir) ? readdirSync(resolve(ROOT, dir)).filter((f) => f.endsWith(".md")).flatMap((f) => read(`${dir}/${f}`).split("\n").filter((l) => /^\| [A-Z]{1,2}\d+ \|/.test(l) && /\| Deferred to M7\b/.test(l)).map((l) => `${m} ${l.split(" | ")[0].slice(2)}`)) : []; });
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
  const rec = { test_id: `M7-${id}`, name: c.name, utc: now(), ...repo, upstream_sha: UPSTREAM_SHA, patch_series_sha256: series.series_sha256, config_or_fixture_hash: null, expected: c.expected,
    evidence_class: ["E05", "L02"].includes(id) ? "live" : "fixture-or-host" };
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
    mcp: digestOf(composeImage("mcp-gateway")), searxng: digestOf(composeImage("searxng")), browser: digestOf(composeImage("browser-worker")), fixture_m6: digestOf(composeImage("fixture-m6")), fixture_m7: digestOf(composeImage("fixture-m7")) } : null;
  rec.actual = hideIds(String(rec.actual), target());
  rec.evidence_path = OUT;
  results[rec.test_id] = rec;
  console.log(`${rec.test_id} ${rec.state.padEnd(18)} ${c.name}${rec.state !== "PASS" ? `  — ${rec.actual.slice(0, 260)}` : ""}`);
}
const ordered = listed.map((id) => results[`M7-${id}`] ?? { test_id: `M7-${id}`, name: checks[id].name, state: "NOT_RUN", actual: "never run", evidence_path: OUT });
writeFileSync(resolve(ROOT, OUT), JSON.stringify({ schema: "fcpi.m7.verification/v1", runner: "scripts/m7/verify.mjs",
  repository_sha_note: "Each result records the commit checked out when it ran, with code_dirty; the commit that stores this file is a later one on main. evidence_class separates the live checks (E05, L02) from the fixture and host checks.",
  results: ordered }, null, 2) + "\n");
process.exitCode = ordered.every((r) => r.state === "PASS" || r.state === "BLOCKED_CREDENTIAL") ? 0 : 1;
