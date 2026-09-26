#!/usr/bin/env node
// M2 verification (docs/FIRECRAWL_PI_MILESTONES.md, M2 "Automated Verification"; CLAUDE.md §25,
// §26, §33.3). Every check recomputes its result from the raw evidence under evidence/M2/ (or the
// directory FCPI_M2_EVIDENCE names) and records the §25 tuple, with code_dirty, in
// evidence/M2/verification.json. A check whose evidence is missing is NOT_RUN, never PASS; every
// negative result is read beside its positive control; each check names in its `expected` text
// what it compares, so a change to that input fails it.
//   node scripts/m2/verify.mjs [CHECK_ID …]
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { ROOT, sha256, sha256File, repoState, sections, git, kv } from "../m0/lib.mjs";
import { d1, SRC } from "./d1.mjs";

const EV = process.env.FCPI_M2_EVIDENCE ?? "evidence/M2/";
const RAW = `${EV}raw/`;
const OUT = `${EV}verification.json`;
const UPSTREAM_SHA = "7666c1f9ae8720a6bba271e0f60b6a217f8a5210";
const M2_START = "191c146"; // the kickoff's HEAD: files changed after it are M2's
const read = (p) => readFileSync(resolve(ROOT, p), "utf8");
const json = (p) => JSON.parse(read(p));
const has = (p) => existsSync(resolve(ROOT, p));
const now = () => new Date().toISOString().replace(/\.\d+Z$/, "Z");
const hashOf = (paths) => sha256(paths.map((p) => `${p}:${sha256File(p)}`).join("\n"));
const MIB = 1024 * 1024;
const target = () => {
  const t = Object.fromEntries(read("scripts/m1/pi-target.conf").split("\n").filter((l) => /^PI_\w+=/.test(l)).map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1).replace("$HOME", process.env.HOME)]));
  if (!t.PI_SSH_TARGET || !t.PI_SSH_KEY || !t.PI_LAN_ADDRESS) throw new Error("scripts/m1/pi-target.conf lacks PI_SSH_TARGET, PI_SSH_KEY or PI_LAN_ADDRESS");
  return t;
};
const ssh = (cmd) => { const t = target(); return execFileSync("ssh", ["-i", t.PI_SSH_KEY, "-o", "IdentitiesOnly=yes", "-o", "BatchMode=yes", "-o", "ConnectTimeout=15", t.PI_SSH_TARGET, cmd], { encoding: "utf8" }); };

// ---- transcript readers -------------------------------------------------------------------
const S = (file) => sections(file);
const jsonLines = (lines) => (lines ?? []).filter((l) => l.startsWith("{")).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
// One retrieval phase (scripts/m2/pi-retrieval-tests.sh): its driver's cases, attempt rows,
// fixture hits, logs, permits, health and cgroups.
function phase(name) {
  const f = `${RAW}rt-${name}.txt`, s = S(f), p = (k) => s[`${name}_${k}`] ?? [];
  const cases = Object.fromEntries(jsonLines(p("driver")).filter((c) => c.case && c.case !== "end").map((c) => [c.case, c]));
  const attempts = p("attempts").filter((l) => l.includes("\t")).map((l) => {
    const c = l.split("\t");
    return { logical: c[0], ordinal: +c[1], purpose: c[2], strategy: c[3], domain: c[4], started: c[5], finished: c[6], outcome: c[7], status: c[8], bytes: c[9], subresources: c[10], total: +c[11] };
  });
  const cg = (k) => Object.fromEntries(p(k).filter((l) => / max=/.test(l)).map((l) => {
    const [svc] = l.split(" ");
    const g = (key) => +((l.match(new RegExp(`(?:^| )${key}[= ](\\d+|max)`)) ?? [])[1] ?? NaN);
    return [svc, { max: g("max"), current: g("current"), peak: g("peak"), oom_kill: g("oom_kill") }];
  }));
  return {
    file: f, s, cases, attempts,
    driverExit: (p("driver").find((l) => l.startsWith("driver_exit=")) ?? "").split("=")[1],
    fixture: jsonLines(p("fixture_log")), retrieval: jsonLines(p("retrieval_log")), browser: jsonLines(p("browser_log")),
    permits: p("permits").filter(Boolean).map((l) => l.split("\t")),
    health: p("health").filter(Boolean).map((l) => { const [svc, state, h, r] = l.split(" "); return { svc, state, health: h, restarts: +(r ?? "").split("=")[1] }; }),
    cgroupsEnd: cg("cgroups_end"), cgroupsBefore: cg("cgroups_before"), cgroupsAfter: cg("cgroups_after"),
    browserHealth: (p("browser_health").find((l) => l.startsWith("{")) ?? null),
    processes: p("browser_processes").filter((l) => /^\s*\d+\s/.test(l)).map((l) => { const [pid, ppid, stat, etimes, comm] = l.trim().split(/\s+/); return { pid: +pid, ppid: +ppid, stat, etimes: +etimes, comm }; }),
    samples: p("memory_samples").filter((l) => l.startsWith("t=")).map((l) => kv(l.split(" "))),
    hostOom: p("host_oom"), kill: p("kill"), meta: p("meta"),
  };
}
// Every one of the nine services has a readable oom_kill before and after: otherwise "no cgroup's
// oom_kill rose" would be vacuous (review finding W15).
const cgroupsComplete = (ph) => ["cgroupsBefore", "cgroupsAfter"].every((k) => Object.keys(ph[k]).length >= 9 && Object.values(ph[k]).every((v) => Number.isFinite(v.oom_kill)));
const permitsFree = (ph) => ph.permits.length === 3 && ph.permits.every((r) => r[2] === "t");
const healthy = (ph) => ph.health.length >= 8 && ph.health.every((h) => h.state === "running" && h.health === "healthy");
const byLogical = (ph, id) => ph.attempts.filter((a) => a.logical === id);
const scrapeAttempts = (ph, c) => (c?.scrapeId ? byLogical(ph, c.scrapeId) : []);

// ---- Compose and lock -------------------------------------------------------------------------
const CAPS = { "nuq-postgres": [640, "75000/100000"], redis: [320, "35000/100000"], rabbitmq: [512, "50000/100000"], "firecrawl-core": [2304, "225000/100000"],
  "access-gateway": [160, "30000/100000"], fixture: [64, "10000/100000"], "retrieval-service": [448, "60000/100000"], "browser-worker": [1536, "150000/100000"], "fixture-m2": [192, "20000/100000"] };
const SERVICE_UID = { "nuq-postgres": "5432", redis: "6379", rabbitmq: "5672", "firecrawl-core": "3002", "access-gateway": "3380", fixture: "8080", "retrieval-service": "3310", "browser-worker": "3320", "fixture-m2": "8080" };
const composeImage = (svc) => json(`${EV}rendered-compose.json`).services[svc]?.image ?? "";
const digestOf = (ref) => (ref.match(/@(sha256:[0-9a-f]{64})$/) ?? [])[1] ?? null;

// ---- D1: Chrome's in-the-wild bugs and the bundled Chromium (scripts/m2/d1.mjs, shared with the lock)
// ---- redaction ---------------------------------------------------------------------------------
const M0_CONTROL = "tests/contracts/m0-redaction-control.txt", M1_CONTROL = "tests/contracts/m1-redaction-control.txt";
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
];
// Literal strings allowed outside the controls, each classified under the publishing rule: M0's
// synthetic MACs and M1's code and fixture forms (scripts/m1/verify.mjs), plus M2's:
//   password: r.proxy.password  code: services/browser/src/server.mjs passes the attempt's proxy credential to Playwright
//   password: cred.password     code: services/retrieval/src/browser.mjs forwards that credential to the worker
//   password = randomBytes      code: services/retrieval/src/proxy.mjs generates a per-attempt credential
//   password: readSecret        code: services/retrieval/src/server.mjs reads the database password from its secret file
const ALLOW = new Set(["00:00:00:00:00:00", "02:00:00:00:00:01", "02:00:00:00:00:02", "02:00:00:00:00:99",
  "amqp://fcpi:%s@", "amqp://fcpi:$rmqpw@", String.raw`amqp://fcpi:\\(.*\\)@`, "http://user:pw@",
  "password: r.proxy.password", "password: cred.password", "password = randomBytes", "password: readSecret"]);
// ids.m0: M0's identity hashes (egress IP, board serial, machine id, MACs; evidence/M0/audit.json);
// ids.secrets: the SHA-256 of each live secret.
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

// ---- snapshot attribution ----------------------------------------------------------------------
function keyedSnapshot(file) {
  const out = []; let sec = null;
  for (const l of read(file).split("\n")) {
    const m = l.match(/^### (\S+)$/);
    if (m) { sec = m[1]; continue; }
    if (sec && sec !== "meta" && l !== "end" && l !== "") out.push([sec, l]);
  }
  return out;
}
const MODULE_ALLOW = /^(bridge|stp|llc|veth|overlay|br_netfilter|ip_set|xt_[a-z_]+|xt_[A-Z]+|x_tables|nf_[a-z0-9_]+|nft_[a-z0-9_]+|ip6?_tables|ip6?table_[a-z]+|iptable_[a-z]+|ipt_[A-Z]+|xfrm_algo|xfrm_user|nf_tables|nfnetlink)$/;
function attribute(sec, line, ids) {
  if (sec === "systemd_running" && /^session-\d+\.scope$/.test(line)) return "own SSH session scope";
  if (sec === "systemd_running") { const m = line.match(/^docker-([0-9a-f]{64})\.scope$/); if (m && ids.has(m[1])) return "scope of an fcpi container"; }
  if (sec === "docker_ps") { const f = line.split("\t"); if (f.length === 4 && /^fcpi-/.test(f[1]) && ids.has(f[0])) return "fcpi container"; }
  if (sec === "findmnt") {
    if (/^\/run\/docker\/netns\/[0-9a-f]+ nsfs\[net:\[\d+\]\] nsfs rw$/.test(line)) return "container network namespace";
    const m = line.match(/^\/var\/lib\/docker\/rootfs\/overlayfs\/([0-9a-f]{64}) overlay overlay /);
    if (m && ids.has(m[1])) return "fcpi container root filesystem";
  }
  if (sec === "lsmod" && MODULE_ALLOW.test(line.split(" ")[0])) return "kernel module for the container runtime or the guard's sets";
  if (sec === "firewall" && /^nft_ruleset_sha256=/.test(line)) return "nftables ruleset: the guard's egress rules and Docker's rules for M2's bridges (evidence/M2/raw/nft-ruleset.txt)";
  if (sec === "nft_chains" && /^ip6? (filter|nat|raw) /.test(line)) return "Docker's chains for M2's bridges";
  if (sec === "forwarding") return null;
  return null;
}

// ---- checks ------------------------------------------------------------------------------------
const checks = {
  // ============================================================== baseline and Chromium (D2)
  B00: { name: "baseline-matches-m1-closeout-after", inputs: [`${EV}snapshot-before.txt`, "evidence/M1/closeout/snapshot-after.txt"],
    expected: "M2's BEFORE snapshot equals M1's close-out AFTER apart from SSH session scopes, and the boot ID is unchanged",
    run() {
      const strip = (f) => keyedSnapshot(f).map((x) => x.join("\t")).filter((l) => !/\tsession-\d+\.scope$/.test(l)).sort();
      const a = strip("evidence/M1/closeout/snapshot-after.txt"), b = strip(`${EV}snapshot-before.txt`);
      const only = (x, y) => x.filter((l) => !y.includes(l));
      const boot = (f) => (read(f).match(/^boot_id_sha256=([0-9a-f]{64})$/m) ?? [])[1];
      const ok = only(a, b).length === 0 && only(b, a).length === 0 && !!boot(`${EV}snapshot-before.txt`) && boot("evidence/M1/closeout/snapshot-after.txt") === boot(`${EV}snapshot-before.txt`);
      return { ok, actual: `only in M1 AFTER=${only(a, b).length}, only in M2 BEFORE=${only(b, a).length}, boot_id_equal=${boot("evidence/M1/closeout/snapshot-after.txt") === boot(`${EV}snapshot-before.txt`)}` };
    } },
  B01: { name: "chromium-native-aarch64", inputs: [`${RAW}browser-proof.txt`, `${RAW}stack.txt`],
    expected: "the proof ran on the 16 KiB kernel (page_size=16384, aarch64) from an arm64 image; every Chromium binary is ELF aarch64; every process in the running browser worker is ELF machine 183",
    run() {
      const s = S(`${RAW}browser-proof.txt`), m = kv(s.meta), img = kv((s.image ?? [])[0]?.split(" "));
      const elf = jsonLines(s.elf_alignment);
      const procs = (S(`${RAW}stack.txt`).process_elf ?? []).filter((l) => l.startsWith("browser-worker "));
      const ok = /page_size=16384/.test(m.kernel ?? "") && /machine=aarch64/.test(m.kernel ?? "") && img.arch === "arm64" && elf.length >= 10 && elf.every((e) => e.machine === "aarch64") &&
        procs.length > 0 && procs.every((l) => / e_machine=183 /.test(l));
      return { ok, actual: `kernel=${m.kernel}; image arch=${img.arch}; binaries=${elf.length}, all aarch64=${elf.every((e) => e.machine === "aarch64")}; running worker processes=${procs.length}, all e_machine 183=${procs.every((l) => / e_machine=183 /.test(l))}` };
    } },
  B02: { name: "chromium-load-segments-16k-aligned", inputs: [`${RAW}browser-proof.txt`],
    expected: "every Chromium ELF binary and library installed has every LOAD segment aligned at 0x4000 or above",
    run() {
      const elf = jsonLines(S(`${RAW}browser-proof.txt`).elf_alignment);
      const low = elf.filter((e) => !(parseInt(e.min_load_align_hex, 16) >= 0x4000) || e.page_16k_compatible !== true);
      return { ok: elf.length >= 10 && low.length === 0, actual: `binaries=${elf.length}; min alignment=${[...new Set(elf.map((e) => e.min_load_align_hex))].join(",")}; below 0x4000=${low.map((e) => e.path).join(",") || "none"}` };
    } },
  B03: { name: "chromium-runs-non-root", inputs: [`${RAW}browser-proof.txt`, `${RAW}stack.txt`],
    expected: "every process of the proof ran as uid 3320 with no effective capability outside Chromium's own namespace; the running worker is user 3320:3320, cap_drop ALL, no-new-privileges, not privileged",
    run() {
      const s = S(`${RAW}browser-proof.txt`);
      const procs = jsonLines((s.proof_project_seccomp ?? []).slice((s.proof_project_seccomp ?? []).indexOf("#### processes_open") + 1, (s.proof_project_seccomp ?? []).indexOf("#### close")));
      const w = (S(`${RAW}stack.txt`).containers ?? []).find((l) => l.startsWith("browser-worker ")) ?? "";
      // Only a zygote inside Chromium's user namespace holds CAP_SYS_ADMIN (0x200000), for the namespace sandbox.
      const caps = procs.filter((p) => p.cap_eff !== "0000000000000000" && !(p.type === "zygote" && p.nspid_depth >= 2));
      const ok = procs.length >= 5 && procs.every((p) => p.uid === "3320") && caps.length === 0 && / user=3320:3320 /.test(w) && / cap_drop=ALL /.test(w) && / cap_add= /.test(w) && / privileged=false /.test(w) && /no-new-privileges:true/.test(w);
      return { ok, actual: `proof processes=${procs.length}, uids=${[...new Set(procs.map((p) => p.uid))].join(",")}; unexpected capabilities=${caps.length}; worker: ${w.match(/user=\S*/)?.[0]} ${w.match(/cap_drop=\S*/)?.[0]} ${w.match(/privileged=\S*/)?.[0]}` };
    } },
  B04: { name: "chromium-sandbox-on", inputs: [`${RAW}browser-proof.txt`, `${RAW}stack.txt`, "deploy/browser/seccomp.json"],
    expected: "under Docker's built-in seccomp profile Chromium refuses to start with its sandbox (the positive control); under the project profile it starts with no --no-sandbox or --disable-setuid-sandbox flag, its renderer in a nested PID namespace with its own seccomp filter; the running worker uses the project profile",
    run() {
      const s = S(`${RAW}browser-proof.txt`);
      const ctrl = (s.control_builtin_seccomp ?? []).join("\n"), proof = s.proof_project_seccomp ?? [];
      const procs = jsonLines(proof.slice(proof.indexOf("#### processes_open") + 1, proof.indexOf("#### close")));
      const renderer = procs.find((p) => p.type === "renderer");
      const w = (S(`${RAW}stack.txt`).containers ?? []).find((l) => l.startsWith("browser-worker ")) ?? "";
      const ok = /launched=no/.test(ctrl) && /sandboxing failed/i.test(ctrl) && proof.some((l) => l.startsWith("launched=yes"));
      const ok2 = ok && procs.every((p) => p.no_sandbox_flag === false && p.disable_setuid_sandbox === false) && !!renderer && renderer.nspid_depth >= 2 && renderer.seccomp_filters >= 2 && /seccomp=\{/.test(w);
      return { ok: ok2, actual: `control launched=${/launched=no/.test(ctrl) ? "no (sandboxing failed)" : "yes"}; proof launched=${proof.some((l) => l.startsWith("launched=yes"))}; sandbox flags off=${procs.every((p) => !p.no_sandbox_flag && !p.disable_setuid_sandbox)}; renderer nspid_depth=${renderer?.nspid_depth} seccomp_filters=${renderer?.seccomp_filters}; worker seccomp profile=${/seccomp=\{/.test(w)}` };
    } },
  B05: { name: "chromium-renders-fixture", inputs: [`${RAW}browser-proof.txt`],
    expected: "the proof renders the controlled JS fixture: h1 'Rendered by script' and the sentinel fcpi-m2-js-5c1e, written by script",
    run() {
      const r = kv((S(`${RAW}browser-proof.txt`).proof_project_seccomp ?? []));
      const ok = r.h1 === "Rendered by script" && r.sentinel === "fcpi-m2-js-5c1e" && r.noscript_rendered === "false" && r.browser_version === "153.0.8010.12";
      return { ok, actual: `h1=${r.h1}; sentinel=${r.sentinel}; browser_version=${r.browser_version}` };
    } },
  B06: { name: "chromium-closes-cleanly", inputs: [`${RAW}browser-proof.txt`],
    expected: "close returns (closed=yes) and no Chromium process remains in the container after it",
    run() {
      const proof = S(`${RAW}browser-proof.txt`).proof_project_seccomp ?? [];
      const after = jsonLines(proof.slice(proof.indexOf("#### processes_after_close") + 1, proof.indexOf("#### end")));
      const open = jsonLines(proof.slice(proof.indexOf("#### processes_open") + 1, proof.indexOf("#### close")));
      const ok = proof.some((l) => l.startsWith("closed=yes")) && open.some((p) => /chrome/.test(p.exe)) && after.length > 0 && !after.some((p) => /chrome/.test(p.exe));
      return { ok, actual: `closed=${proof.some((l) => l.startsWith("closed=yes"))}; chrome processes open=${open.filter((p) => /chrome/.test(p.exe)).length} after close=${after.filter((p) => /chrome/.test(p.exe)).length}` };
    } },
  B07: { name: "chromium-no-stray-processes", inputs: [`${RAW}browser-proof.txt`],
    expected: "after the proof, no uid-3320 or Chromium process is left on the host and no throwaway container remains",
    run() {
      const a = kv(S(`${RAW}browser-proof.txt`).after);
      const ok = a.uid_3320_processes === "0" && a.chrome_processes_on_host === "0" && a.leftover_transient_containers === "0";
      return { ok, actual: `uid_3320_processes=${a.uid_3320_processes}; chrome_processes_on_host=${a.chrome_processes_on_host}; leftover_transient_containers=${a.leftover_transient_containers}` };
    } },

  // ============================================================== D1 admission and build (D4, D6)
  D01: { name: "d1-playwright-admission-every-in-the-wild-cve", inputs: [`${SRC}chrome-releases-posts-since-2019.jsonl`, `${SRC}playwright-core-1.63.0-browsers.json`, `${SRC}npm-playwright-dist-tags.json`, `${SRC}chromium-153.0.8010.12-deps-v8.txt`, `${SRC}chromiumdash-m153.json`, "deploy/versions.lock.json", `${RAW}stack.txt`],
    expected: "Playwright 1.63.0 is npm's latest stable; its bundled Chromium passes test (a) or (b) for every CVE Chrome's posts call exploited in the wild; the lock lists every one of those CVEs with its result (a missing CVE fails); the running worker's Chromium is the bundled version",
    run() {
      const r = d1();
      const fail = r.rows.filter((x) => !x.pass).map((x) => x.cve);
      const L = json("deploy/versions.lock.json").browser ?? {};
      const listed = new Set((L.in_the_wild ?? []).map((x) => x.cve));
      const missing = r.rows.map((x) => x.cve).filter((c) => !listed.has(c));
      const running = (JSON.parse((S(`${RAW}stack.txt`).browser_health ?? []).join(" ").replace(/^\d+ /, "") || "{}").version) ?? null;
      const watch = r.rows.filter((x) => !x.test_a || x.after_branch_point).map((x) => `${x.cve}:a=${x.test_a},b=${x.test_b}`);
      const ok = r.latest === "1.63.0" && r.bundled === "153.0.8010.12" && r.rows.length > 0 && fail.length === 0 && missing.length === 0 && running === r.bundled && L.playwright === "1.63.0";
      return { ok, actual: `npm latest=${r.latest}; bundled=${r.bundled} (revision ${r.revision}); in-the-wild CVEs=${r.rows.length}; failing both tests=${fail.join(",") || "none"}; (a) failed or fix after branch point: ${watch.join(" ") || "none"}; lock lists=${listed.size}, missing=${missing.length}; lock playwright=${L.playwright}; running=${running}` };
    } },
  D02: { name: "api-build-reproducible-and-pinned", inputs: [`${RAW}api-build.log`, "patches/series.json", "deploy/versions.lock.json", `${EV}rendered-compose.json`],
    expected: "the build of record runs every step (no_cache=1) from the series' exact result tree; every FROM is pinned by digest; Go, Rust, Node and pnpm print their pinned versions; cargo runs --locked, pnpm --frozen-lockfile, apt from the fixed snapshot, the FoundationDB client passes its SHA-256; no native build output ships; the image the stack runs is this build's, carrying the series hash; the lock records the same Go stage, image and series",
    run() {
      const log = read(`${RAW}api-build.log`);
      const series = json("patches/series.json");
      const L = json("deploy/versions.lock.json");
      const froms = [...log.matchAll(/^#\d+ \[(?:[a-z-]+ )?\d+\/\d+\] FROM (\S+)/gm)].map((m) => m[1]);
      const meta = [...log.matchAll(/load metadata for (\S+)/g)].map((m) => m[1]);
      const unpinned = [...new Set([...froms, ...meta])].filter((r) => !/@sha256:[0-9a-f]{64}$/.test(r));
      const id = (log.match(/^id=(sha256:[0-9a-f]{64}) os=linux arch=arm64/m) ?? [])[1];
      const want = {
        no_cache: /^no_cache=1$/m.test(log), tree: log.includes(`result_tree=${series.result_tree} series_sha256=${series.series_sha256}`), exit: /^build_exit=0 /m.test(log),
        go: /go version go1\.27\.1 linux\/arm64/.test(log), rust: /rustc 1\.98\.1 /.test(log), node: /\bv22\.23\.3\b/.test(log), pnpm: /\b11\.4\.0\b/.test(log),
        cargo_locked: /napi build --platform --release -- --locked/.test(log), frozen: /pnpm install --frozen-lockfile/.test(log), apt: /fcpi-apt-build: snapshot=20260925T000000Z/.test(log),
        fdb: /\/tmp\/fdb-clients\.deb: OK/.test(log), no_native_output: !/native install:\s+Compiling/.test(log.slice(log.indexOf("pnpm run build"))),
        series_env: log.includes(`FCPI_PATCH_SERIES_SHA256=${series.series_sha256}`), runs: digestOf(composeImage("firecrawl-core")) === id,
        lock: L.build_provenance?.firecrawl_api_image_patched?.image_id === id && L.build_provenance?.firecrawl_api_image_patched?.patch_series_sha256 === series.series_sha256 && /go1\.27\.1/.test(L.build_provenance?.firecrawl_api_image_patched?.go_version ?? "") && L.images?.go_build?.selected?.arm64_manifest_digest === (log.match(/golang:1\.27\.1-bookworm@(sha256:[0-9a-f]{64})/) ?? [])[1],
      };
      const bad = Object.entries(want).filter(([, v]) => !v).map(([k]) => k);
      return { ok: froms.length >= 3 && unpinned.length === 0 && bad.length === 0, actual: `FROM lines=${froms.length}; unpinned=${unpinned.join(",") || "none"}; failed conditions=${bad.join(",") || "none"}; image=${id?.slice(7, 19)}` };
    } },
  D03: { name: "service-images-pinned", inputs: [`${RAW}service-build.txt`, `${EV}rendered-compose.json`, "services/retrieval/Dockerfile", "deploy/browser/Dockerfile"],
    expected: "the retrieval and browser images build FROM digest-pinned bases with npm ci against their lockfiles; the images the stack runs are the last builds recorded",
    run() {
      const log = read(`${RAW}service-build.txt`);
      const froms = [...read("services/retrieval/Dockerfile").matchAll(/^FROM (\S+)/gm), ...read("deploy/browser/Dockerfile").matchAll(/^FROM (\S+)/gm)].map((m) => m[1]);
      const unpinned = froms.filter((r) => !/@sha256:[0-9a-f]{64}/.test(r));
      const lastId = (svc) => [...log.matchAll(new RegExp(`^fcpi/${svc}:m2 id=(sha256:[0-9a-f]{64})`, "gm"))].map((m) => m[1]).pop();
      const runs = { retrieval: digestOf(composeImage("retrieval-service")) === lastId("retrieval"), browser: digestOf(composeImage("browser-worker")) === lastId("browser") };
      const ci = /npm ci --omit=dev/.test(read("services/retrieval/Dockerfile")) && /npm ci/.test(read("deploy/browser/Dockerfile"));
      const ok = froms.length >= 2 && unpinned.length === 0 && runs.retrieval && runs.browser && ci;
      return { ok, actual: `FROM=${froms.length}; unpinned=${unpinned.join(",") || "none"}; running=last build: retrieval=${runs.retrieval} browser=${runs.browser}; npm ci=${ci}` };
    } },

  // ============================================================== patch series and source paths
  P01: { name: "patch-series-hashes-and-call-site-manifest", inputs: ["patches/series.json", `${RAW}api-build.log`],
    expected: "every patch file hashes to its recorded SHA-256 and the series hash recomputes; every patch names a reason, symbols and tests, and every symbol's file is one that patch changes; the coverage manifest names a call site and a covering patch for each traced path (scrape, crawl pages, robots.txt, sitemaps, search, documents, browser subresources); the build applied exactly this series",
    run() {
      const s = json("patches/series.json");
      const bad = [];
      for (const p of s.patches) {
        if (sha256File(`patches/${p.file}`) !== p.sha256) bad.push(`${p.file}:hash`);
        if (!p.reason || !(p.symbols ?? []).length || !(p.tests ?? []).length) bad.push(`${p.file}:manifest`);
        const touched = [...read(`patches/${p.file}`).matchAll(/^\+\+\+ b\/(\S+)/gm)].map((m) => m[1]);
        for (const sym of p.symbols ?? []) if (!touched.includes(sym.split(" ")[0])) bad.push(`${p.file}:${sym.split(" ")[0]}`);
      }
      const seriesHash = sha256(s.patches.map((p) => `${p.sha256}  ${p.file}\n`).join(""));
      const paths = (s.coverage ?? []).map((c) => c.path.toLowerCase());
      const need = ["scrape", "crawl", "robots", "sitemap", "search", "document", "subresource"];
      const uncovered = need.filter((n) => !paths.some((p) => p.includes(n)));
      const incomplete = (s.coverage ?? []).filter((c) => !c.call_site || !c.covered_by).map((c) => c.path);
      const applied = [...read(`${RAW}api-build.log`).matchAll(/fcpi-source: applied (\S+) sha256=([0-9a-f]{64})/g)].map((m) => `${m[1]}:${m[2]}`);
      const appliedOk = JSON.stringify(applied) === JSON.stringify(s.patches.map((p) => `${p.file}:${p.sha256}`));
      const ok = bad.length === 0 && seriesHash === s.series_sha256 && uncovered.length === 0 && incomplete.length === 0 && appliedOk && s.upstream.commit === UPSTREAM_SHA;
      return { ok, actual: `patches=${s.patches.length}; problems=${bad.join(",") || "none"}; series hash recomputes=${seriesHash === s.series_sha256}; coverage entries=${(s.coverage ?? []).length}, uncovered paths=${uncovered.join(",") || "none"}; build applied this series in order=${appliedOk}` };
    } },
  P02: { name: "traced-paths-reach-the-adapter", inputs: [`${RAW}rt-paths.txt`, `${RAW}rt-static.txt`, `${RAW}rt-browser.txt`],
    expected: "a crawl's pages, its robots.txt and each sitemap, a map's sitemap download, a search's result scrapes, a PDF document and a page's subresources each appear at the retrieval service with the purpose that path gives it; the fixture served every one of them only after that",
    run() {
      const p = phase("paths"), st = phase("static"), br = phase("browser");
      const crawl = p.cases["P01-crawl"], search = p.cases["P03-search"], map = p.cases["P02-map-gz-sitemap"];
      const pages = (crawl?.pages ?? []).filter((x) => x.scrapeId);
      const pagesViaAdapter = pages.length >= 3 && pages.every((x) => byLogical(p, x.scrapeId).some((a) => a.purpose === "page"));
      const robots = p.attempts.some((a) => a.purpose === "robots" && a.logical.startsWith("robots-txt;"));
      const sitemaps = new Set(p.attempts.filter((a) => a.purpose === "sitemap" && a.logical.startsWith("sitemap;")).map((a) => a.logical)).size;
      const fetches = p.attempts.filter((a) => a.logical.startsWith("fetch:")).map((a) => a.purpose);
      const results = (search?.results ?? []).filter((x) => x.scrapeId);
      const searchScraped = results.length >= 2 && results.every((x) => byLogical(p, x.scrapeId).length > 0) && p.retrieval.some((e) => e.event === "search");
      const pdf = st.cases["C18-pdf"];
      const pdfOk = pdf?.success === true && pdf.sentinels.includes("fcpi-m2-pdf-4e7a") && scrapeAttempts(st, pdf).length === 1;
      const sub = br.cases["S15b-subresources-direct"];
      const subOk = (sub?.proxyDenied ?? []).length >= 10 && br.fixture.some((h) => h.path === "/pixel.png");
      const ok = crawl?.status === "completed" && pagesViaAdapter && robots && sitemaps >= 2 && fetches.includes("sitemap") && map?.success === true && searchScraped && pdfOk && subOk;
      return { ok, actual: `crawl=${crawl?.status} pages via adapter=${pages.length}; robots=${robots}; sitemaps with own budget=${sitemaps}; auxiliary fetches=${fetches.join(",")}; search results scraped=${results.length} (backend used=${p.retrieval.some((e) => e.event === "search")}); pdf=${pdfOk}; subresources refused=${(sub?.proxyDenied ?? []).length}, pixel control=${br.fixture.some((h) => h.path === "/pixel.png")}` };
    } },

  // ============================================================== retrieval behaviour
  R01: { name: "static-pages-never-start-chromium", inputs: [`${RAW}rt-static.txt`],
    expected: "with the browser worker up, every static-phase acquisition is direct HTTP and the browser logs no render during the phase; the worker answering its health check at the end is the positive control that it was there to be used",
    run() {
      const p = phase("static");
      const h = p.browserHealth ? JSON.parse(p.browserHealth) : null;
      const ok = p.attempts.length >= 15 && p.attempts.every((a) => a.strategy === "direct_http") && !p.browser.some((e) => e.event === "render") && h?.ok === true;
      return { ok, actual: `attempts=${p.attempts.length}, strategies=${[...new Set(p.attempts.map((a) => a.strategy))].join(",")}; renders=${p.browser.filter((e) => e.event === "render").length}; browser health=${p.browserHealth}` };
    } },
  R02: { name: "js-delayed-cookie-pages-render", inputs: [`${RAW}rt-browser.txt`],
    expected: "the JS, delayed and cookie-then-JS fixtures return their sentinels in Markdown, each after a direct attempt classified js_shell and one browser attempt",
    run() {
      const p = phase("browser");
      const want = { "C03-js": "fcpi-m2-js-5c1e", "C04-delayed": "fcpi-m2-delayed-9b2d", "C06-cookie-js": "fcpi-m2-cookiejs-7d1c" };
      const bad = Object.entries(want).filter(([id, s]) => { const c = p.cases[id]; const a = scrapeAttempts(p, c); return !(c?.success && c.sentinels.includes(s) && a.length === 2 && a[0].outcome === "js_shell" && a[1].strategy === "direct_browser" && a[1].outcome === "rendered"); }).map(([id]) => id);
      return { ok: bad.length === 0, actual: `failing=${bad.join(",") || "none"}; renders logged=${p.browser.filter((e) => e.event === "render" && e.ok).length}` };
    } },
  R03: { name: "content-classified", inputs: [`${RAW}rt-static.txt`, `${RAW}rt-browser.txt`],
    expected: "short content is adequate (no escalation); a bot interstitial is BLOCKED_PUBLIC_CONTENT; sign-in redirects and 401 are AUTH_REQUIRED; 403 is ACCESS_DENIED; 404 and 503 keep the target's status; 429 is RATE_LIMITED with Retry-After and the next request to that domain is refused during the cooldown without reaching it; an empty page is adequate at the service; a page still a shell after rendering is RENDER_INCOMPLETE, while a short scripted page and an image-led one come back as the page",
    run() {
      const st = phase("static"), br = phase("browser");
      const err = (c) => c?.error ?? "";
      const cond = {
        short: st.cases["C02-short"]?.success === true && st.cases["C02-short"].sentinels.includes("fcpi-m2-short-3b8e") && scrapeAttempts(st, st.cases["C02-short"]).length === 1,
        challenge: /BLOCKED_PUBLIC_CONTENT/.test(err(st.cases["C07-challenge"])), login: /AUTH_REQUIRED/.test(err(st.cases["C08-login-redirect"])), auth401: /AUTH_REQUIRED/.test(err(st.cases["C09-401"])),
        forbidden: /ACCESS_DENIED/.test(err(st.cases["C10-403"])), notFound: st.cases["C11-404"]?.statusCode === 404, targetError: st.cases["C12-503"]?.statusCode === 503,
        rateLimited: /RATE_LIMITED/.test(err(st.cases["C20-429"])) && /Retry after 30/.test(err(st.cases["C20-429"])),
        cooldown: /cooling down/.test(err(st.cases["C21-429-cooldown"])) && !st.fixture.some((h) => h.host?.startsWith("cool.") && h.path === "/short.html"),
        empty: st.attempts.some((a) => a.outcome === "adequate" && a.status === "200" && a.bytes === "0"),
        shellAfterRender: /RENDER_INCOMPLETE/.test(err(br.cases["C27-js-late"])) && br.attempts.some((a) => a.outcome === "RENDER_INCOMPLETE"),
        shortScripted: br.cases["C28-short-scripted"]?.success === true && br.cases["C28-short-scripted"].sentinels.includes("fcpi-m2-shortjs-4d2e"),
        gallery: br.cases["C29-gallery"]?.success === true && br.cases["C29-gallery"].sentinels.includes("fcpi-m2-gallery-9a1b"),
      };
      const bad = Object.entries(cond).filter(([, v]) => !v).map(([k]) => k);
      return { ok: bad.length === 0, actual: `failing=${bad.join(",") || "none"}` };
    } },
  R04: { name: "size-time-and-redirect-limits", inputs: [`${RAW}rt-static.txt`, `${RAW}rt-browser.txt`],
    expected: "a declared body over 25 MiB, a gzip bomb and a script-built document over 25 MiB are SIZE_LIMIT; a target slower than the scrape timeout times out; three redirects are followed and twelve are TOO_MANY_REDIRECTS",
    run() {
      const st = phase("static"), c = st.cases, br = phase("browser");
      const cond = { hugeDom: /SIZE_LIMIT/.test(br.cases["C30-huge-dom"]?.error ?? ""), large: /SIZE_LIMIT/.test(c["C13-large"]?.error ?? ""), bomb: /SIZE_LIMIT/.test(c["C14-gzip-bomb"]?.error ?? ""), timeout: c["C15-slow-timeout"]?.http === 408,
        chain3: c["C16-chain-3"]?.success === true && c["C16-chain-3"].sentinels.includes("fcpi-m1-static-7f3a"), chain12: /TOO_MANY_REDIRECTS/.test(c["C17-chain-12"]?.error ?? "") };
      const bad = Object.entries(cond).filter(([, v]) => !v).map(([k]) => k);
      return { ok: bad.length === 0, actual: `failing=${bad.join(",") || "none"}` };
    } },
  R05: { name: "unregistered-capabilities-refused", inputs: [`${RAW}rt-static.txt`],
    expected: "skipTlsVerification, screenshots, actions and stealth proxies are refused explicitly (UNSUPPORTED_CAPABILITY or the upstream actions refusal) and never acquired",
    run() {
      const st = phase("static"), c = st.cases;
      const refused = ["C23-skip-tls-true", "C24-screenshot", "C26-stealth"].every((id) => /UNSUPPORTED_CAPABILITY/.test(c[id]?.error ?? "")) && c["C25-actions"]?.code === "SCRAPE_ACTIONS_NOT_SUPPORTED";
      const acquired = ["C23-skip-tls-true", "C24-screenshot", "C25-actions", "C26-stealth"].filter((id) => c[id]?.scrapeId && scrapeAttempts(st, c[id]).length);
      return { ok: refused && acquired.length === 0, actual: `refused=${refused}; acquired anyway=${acquired.join(",") || "none"}` };
    } },

  // ============================================================== SSRF
  S01: { name: "ssrf-matrix-denied", inputs: [`${RAW}rt-ssrf.txt`, `${RAW}unit-tests.txt`],
    expected: "every private, loopback (IPv4 and IPv6), link-local, metadata, IPv4-mapped, NAT64, CGNAT, numeric, single-label, service-name, file-scheme, host-LAN and Cloud target is refused, asked through the core and asked of the service directly, with no attempt spent; each redirect to such a target is refused after the fixture served the redirect; the direct control page succeeds; the unit tests, which include DNS rebinding, pass",
    run() {
      const p = phase("ssrf");
      const core = Object.values(p.cases).filter((c) => c.kind === "core");
      const direct = Object.values(p.cases).filter((c) => c.kind === "rs" && c.case !== "SR00-control");
      // Refused by the core's own URL check (400 BAD_REQUEST) or by the service with its class.
      const coreBad = core.filter((c) => c.success !== false || !((c.http === 400 && c.code === "BAD_REQUEST") || /SSRF_DENIED|CLOUD_DENIED/.test(c.error ?? ""))).map((c) => c.case);
      // Every attempt of the phase is accounted for: the control's one adequate fetch and the seven
      // redirect cases, each refused at its hop; no other case spent an attempt.
      const byOutcome = p.attempts.reduce((m, a) => ((m[a.outcome] = (m[a.outcome] ?? 0) + 1), m), {});
      const accounted = p.attempts.length === 8 && byOutcome.adequate === 1 && (byOutcome.SSRF_DENIED ?? 0) + (byOutcome.CLOUD_DENIED ?? 0) === 7;
      const directBad = direct.filter((c) => c.ok !== false || !["SSRF_DENIED", "CLOUD_DENIED"].includes(c.failure) || c.attemptsUsed !== 0).map((c) => c.case);
      const redirects = core.filter((c) => /^S(09|1[0-4]|19)-redirect/.test(c.case));
      const redirectHits = p.fixture.filter((h) => h.path === "/redirect").length;
      const control = p.cases["SR00-control"];
      const unit = sections(`${RAW}unit-tests.txt`).tap ?? [];
      const unitOk = unit.some((l) => /DNS rebinding/.test(l) && l.startsWith("ok ")) && unit.includes("# fail 0");
      const ok = accounted && core.length >= 18 && direct.length >= 18 && coreBad.length === 0 && directBad.length === 0 && redirects.length === 7 && redirectHits >= 7 && control?.ok === true && control.sentinels.includes("fcpi-m2-short-3b8e") && unitOk;
      return { ok, actual: `attempts accounted=${accounted} (${JSON.stringify(byOutcome)}); through core=${core.length} not refused=${coreBad.join(",") || "none"}; direct=${direct.length} not refused=${directBad.join(",") || "none"}; redirect cases=${redirects.length}, fixture served /redirect=${redirectHits}; control=${control?.ok}; unit DNS rebinding and suite=${unitOk}` };
    } },
  S02: { name: "browser-subresources-denied", inputs: [`${RAW}rt-browser.txt`],
    expected: "each of the subresource fixture's 13 private, loopback, metadata, LAN-range, numeric, Cloud and project-internal requests is refused at the proxy by host, with the attempt id on every log line; the pixel, the positive control, reaches the fixture; the page renders",
    run() {
      const p = phase("browser");
      const d = p.cases["S15b-subresources-direct"];
      const denied = d?.proxyDenied ?? [];
      const logs = p.retrieval.filter((e) => e.event === "proxy_denied");
      const unnamed = logs.filter((e) => !e.attempt_id || e.target_host === "?");
      const ok = d?.ok === true && d.sentinels.includes("fcpi-m2-subresources-6f0b") && denied.length === 13 && denied.every((x) => /^(SSRF_DENIED|CLOUD_DENIED):/.test(x)) && unnamed.length === 0 &&
        p.fixture.filter((h) => h.path === "/pixel.png").length >= 1 && p.cases["S15-subresources"]?.success === true;
      return { ok, actual: `refused=${denied.length} (${[...new Set(denied.map((x) => x.split(":")[0]))].join(",")}); proxy log lines=${logs.length}, without host or attempt=${unnamed.length}; pixel hits=${p.fixture.filter((h) => h.path === "/pixel.png").length}` };
    } },

  // ============================================================== attempts, pacing, permits
  A01: { name: "four-attempts-per-logical-page", inputs: [`${RAW}rt-budget.txt`],
    expected: "three calls for one logical page against a 503 target spend 2, then 4, attempts and the third is ATTEMPT_BUDGET_EXHAUSTED with none; the fixture saw exactly 4 requests",
    run() {
      const p = phase("budget");
      const c = [1, 2, 3].map((n) => p.cases[`A01-budget-call-${n}`]);
      const hits = p.fixture.filter((h) => /budget=/.test(h.query ?? "")).length;
      const ok = c[0]?.attemptsUsed === 2 && c[1]?.attemptsUsed === 4 && c[2]?.failure === "ATTEMPT_BUDGET_EXHAUSTED" && (c[2]?.strategies ?? []).length === 0 && hits === 4;
      return { ok, actual: `attempts after each call=${c.map((x) => x?.attemptsUsed).join(",")}; third=${c[2]?.failure}; fixture requests=${hits}` };
    } },
  A02: { name: "requeued-job-shares-its-budget", inputs: [`${RAW}nuq-stall.txt`],
    expected: "a batch job on a slow 503 target, stalled twice until NuQ's reaper requeued it, sees at most four attempts for its logical page (six without one budget); the fixture's request count equals the attempt rows; the run after the second stall spends none",
    run() {
      const s = S(`${RAW}nuq-stall.txt`);
      const rows = (s.stall_attempts ?? []).filter((l) => l.split("\t").length >= 5);
      const hits = +((s.stall_fixture_hits ?? []).join("").match(/hits=(\d+)/) ?? [])[1];
      const final = (s.stall_final ?? []).join(" ");
      const stalls = +((final.match(/\t(\d+)\t/) ?? [])[1] ?? -1);
      const acq = jsonLines(s.stall_acquisitions);
      const last = acq[acq.length - 1];
      const ok = rows.length >= 3 && rows.length <= 4 && hits === rows.length && stalls >= 2 && acq.length >= 3 && last?.attempts_used <= 4 && (last?.strategies ?? [1]).length === 0 && /failed|completed/.test(final);
      return { ok, actual: `attempt rows=${rows.length}; fixture requests=${hits}; stalls=${stalls}; runs=${acq.length}, attempts after each=${acq.map((a) => a.attempts_used).join(",")}; final=${final.split("\t")[1]}` };
    } },
  A03: { name: "direct-traffic-within-limits", inputs: [`${RAW}rt-pacing.txt`],
    expected: "on a domain with the default direct limits, the target sees navigations at least 2 s apart (10 ms tolerance for arrival jitter), one at a time, and no more than 20 in the hour, counting the three that arrive by redirect from another domain; the 21st is refused PROXY_REQUIRED at once instead of waiting",
    run() {
      const p = phase("pacing");
      const t = p.fixture.filter((h) => h.host?.startsWith("pace.")).map((h) => Date.parse(h.utc)).sort((a, b) => a - b);
      const gaps = t.slice(1).map((x, i) => x - t[i]);
      const refused = Object.values(p.cases).filter((c) => c.failure === "PROXY_REQUIRED");
      const viaRedirect = p.fixture.filter((h) => h.host?.startsWith("pace.") && /via=/.test(h.query ?? "")).length;
      const ok = t.length === 20 && viaRedirect === 3 && Math.min(...gaps) >= 1990 && refused.length === 1 && refused[0].ms < 1000;
      return { ok, actual: `target requests=${t.length} (by redirect ${viaRedirect}); min gap=${Math.min(...gaps)} ms; refused=${refused.length} (${refused[0]?.ms} ms)` };
    } },
  A04: { name: "global-url-permits", inputs: [`${RAW}rt-permits.txt`],
    expected: "three slow acquisitions on three domains asked together: two run at once and the third waits for a permit; all permits are free afterwards",
    run() {
      const p = phase("permits");
      const ms = [1, 2, 3].map((n) => p.cases[`A02-permits-${n}`]?.ms).sort((a, b) => a - b);
      const ok = [1, 2, 3].every((n) => p.cases[`A02-permits-${n}`]?.ok === true) && ms[0] < 6000 && ms[1] < 6000 && ms[2] >= 7500 && permitsFree(p);
      return { ok, actual: `durations=${ms.join(",")} ms; permits free=${permitsFree(p)}` };
    } },
  C01: { name: "cancellation-releases-permits-and-processes", inputs: [`${RAW}rt-cancel.txt`],
    expected: "a caller that leaves during an HTTP fetch and during a render cancels both (attempt rows CANCELLED, the render CANCELLED); the next render works; permits are free; the worker keeps no defunct or leftover Chromium process",
    run() {
      const p = phase("cancel");
      const cancelled = p.attempts.filter((a) => a.outcome === "CANCELLED");
      const render = p.browser.find((e) => e.event === "render" && e.failure === "CANCELLED");
      const after = p.cases["A07b-after-cancel"];
      const defunct = p.processes.filter((x) => x.stat.startsWith("Z"));
      const ok = p.cases["A06-cancel-http"]?.aborted === true && p.cases["A07-cancel-browser"]?.aborted === true && cancelled.length >= 2 && !!render && after?.ok === true && permitsFree(p) && defunct.length === 0 && p.processes.length > 0;
      return { ok, actual: `aborted http=${p.cases["A06-cancel-http"]?.aborted} render=${p.cases["A07-cancel-browser"]?.aborted}; attempts CANCELLED=${cancelled.length}; render cancelled=${!!render}; next render ok=${after?.ok}; permits free=${permitsFree(p)}; defunct=${defunct.length}` };
    } },
  C02: { name: "browser-crash-contained", inputs: [`${RAW}rt-crash.txt`],
    expected: "killing every Chromium process during a render fails that attempt BROWSER_CRASHED; the worker relaunches and the next render works; no process older than the kill remains; permits are free; every service stays healthy with its restart count unchanged",
    run() {
      const p = phase("crash");
      const k = kv(p.kill.join(" ").split(" "));
      const crash = p.cases["A08-crash-render"], after = p.cases["A08b-after-crash"];
      const listedAt = Date.parse(((p.s["crash_browser_processes"] ?? []).find((l) => l.startsWith("utc=")) ?? "").slice(4));
      const killedAt = Date.parse(`${(p.meta.find((l) => l.startsWith("utc=")) ?? "").slice(4, 14)}T${k.killed_at}Z`);
      const olderThanKill = p.processes.filter((x) => /chrome/.test(x.comm) && listedAt - x.etimes * 1000 < killedAt - 1000);
      // Each input must be there: a missing list or time would make "older than the kill" vacuous.
      const inputs = p.processes.length > 0 && Number.isFinite(listedAt) && Number.isFinite(killedAt);
      const ok = inputs && +k.chrome_processes > 0 && crash?.failure === "BROWSER_CRASHED" && after?.ok === true && olderThanKill.length === 0 && permitsFree(p) && healthy(p) && p.health.every((h) => h.svc !== "browser-worker" || h.restarts === 0);
      return { ok, actual: `inputs present=${inputs}; killed ${k.chrome_processes} chrome processes at ${k.killed_at}; crash=${crash?.failure}; next render ok=${after?.ok}; chrome older than the kill=${olderThanKill.length}; permits free=${permitsFree(p)}; all healthy=${healthy(p)}` };
    } },
  C03: { name: "browser-down-isolated", inputs: [`${RAW}rt-browser-down.txt`],
    expected: "with the browser worker stopped, a static page still succeeds and a script page fails as its own tier (BROWSER_UNAVAILABLE); the worker comes back",
    run() {
      const p = phase("browser-down");
      const st = p.cases["I01-static-browser-down"], js = p.cases["I02-js-browser-down"];
      const ok = st?.success === true && /BROWSER_UNAVAILABLE/.test(js?.error ?? "") && (p.s["browser-down_browser_stop"] ?? []).some((l) => l === "browser_state=exited") && healthy(p);
      return { ok, actual: `static=${st?.success}; js=${(js?.error ?? "").slice(0, 60)}; stopped=${(p.s["browser-down_browser_stop"] ?? []).some((l) => l === "browser_state=exited")}; healthy after=${healthy(p)}` };
    } },

  // ============================================================== resources (R6)
  M01: { name: "caps-read-from-cgroups", inputs: [`${RAW}stack.txt`],
    expected: "each service's cgroup memory.max and cpu.max equal its budget (M1's six, retrieval 448 MiB / 0.6 CPU, browser 1,536 MiB / 1.5 CPU, M2 fixture 192 MiB / 0.2 CPU), M2's services have no swap, the sum is within §22's 6,432 MiB, and the browser's /dev/shm is 256 MiB",
    run() {
      const rows = Object.fromEntries((S(`${RAW}stack.txt`).cgroups ?? []).filter(Boolean).map((l) => [l.split(" ")[0], kv(l.split(" ").slice(1))]));
      const bad = Object.entries(CAPS).filter(([svc, [mib, cpu]]) => +rows[svc]?.["memory.max"] !== mib * MIB || rows[svc]?.["cpu.max"] !== cpu).map(([s]) => s);
      const swap = ["retrieval-service", "browser-worker", "fixture-m2"].filter((s) => rows[s]?.["memory.swap.max"] !== "0");
      const sum = Object.values(rows).reduce((a, r) => a + +r["memory.max"] / MIB, 0);
      const shm = json(`${EV}rendered-compose.json`).services["browser-worker"]?.shm_size;
      const ok = bad.length === 0 && swap.length === 0 && sum <= 6432 && (shm === "268435456" || shm === 268435456 || shm === "256m");
      return { ok, actual: `services not at their budget=${bad.join(",") || "none"}; M2 services with swap=${swap.join(",") || "none"}; sum=${sum} MiB of 6432; browser shm=${shm}` };
    } },
  M02: { name: "core-peak-before-chromium", inputs: [`${RAW}rt-permits-before-chromium.txt`],
    expected: "before the browser worker existed, after M2's static, SSRF, budget, permits and paths corpus, the core's cgroup peak is recorded and is at most 85% of its 2,304 MiB cap (above that, §22 asks for a rebalance)",
    run() {
      const s = S(`${RAW}rt-permits-before-chromium.txt`);
      const noBrowser = (s.permits_meta ?? []).includes("absent") && !(s.permits_cgroups_end ?? []).some((l) => l.startsWith("browser-worker "));
      const core = (s.permits_cgroups_end ?? []).find((l) => l.startsWith("firecrawl-core ")) ?? "";
      const peak = +(core.match(/peak=(\d+)/) ?? [])[1], max = +(core.match(/max=(\d+)/) ?? [])[1];
      const ok = noBrowser && max === 2304 * MIB && peak > 0 && peak / max <= 0.85;
      return { ok, actual: `browser worker absent=${noBrowser}; core peak=${(peak / MIB).toFixed(0)} MiB of ${max / MIB} (${((peak / max) * 100).toFixed(1)}%)` };
    } },
  M03: { name: "chromium-stress-within-cap", inputs: [`${RAW}rt-stress.txt`],
    expected: "a render allocating 512 MiB succeeds; no cgroup's oom_kill rises; host MemAvailable stays at 1 GiB or more in every one-second sample",
    run() {
      const p = phase("stress");
      const rose = Object.keys(p.cgroupsAfter).filter((s) => p.cgroupsAfter[s].oom_kill > (p.cgroupsBefore[s]?.oom_kill ?? 0));
      const minAvail = Math.min(...p.samples.map((x) => +x.mem_available_mib));
      const c = p.cases["A10-stress-within-cap"];
      const ok = cgroupsComplete(p) && c?.ok === true && c.sentinels.includes("fcpi-m2-stress-8c3a") && rose.length === 0 && p.samples.length >= 3 && minAvail >= 1024;
      return { ok, actual: `render ok=${c?.ok}; oom_kill rose in=${rose.join(",") || "none"}; samples=${p.samples.length}, min MemAvailable=${minAvail} MiB; browser peak=${(p.cgroupsAfter["browser-worker"]?.peak / MIB).toFixed(0)} MiB` };
    } },
  M04: { name: "over-cap-browser-contained", inputs: [`${RAW}rt-overcap.txt`],
    expected: "a render allocating 2,400 MiB past the browser's 1,536 MiB cap ends in the browser's own cgroup (its oom_kill rises, the kernel names CONSTRAINT_MEMCG) with RENDERER_CRASHED; no other cgroup's oom_kill rises; PostgreSQL, Redis, RabbitMQ, the core and the gateway stay healthy with unchanged restart counts; the next render works; host MemAvailable stays at 1 GiB or more",
    run() {
      const p = phase("overcap");
      const rose = Object.keys(p.cgroupsAfter).filter((s) => p.cgroupsAfter[s].oom_kill > (p.cgroupsBefore[s]?.oom_kill ?? 0));
      const memcg = p.hostOom.some((l) => /CONSTRAINT_MEMCG/.test(l)) && p.hostOom.some((l) => /Killed process \d+ \(chrome-headless/.test(l));
      const minAvail = Math.min(...p.samples.map((x) => +x.mem_available_mib));
      const core5 = ["nuq-postgres", "redis", "rabbitmq", "firecrawl-core", "access-gateway"].every((s) => p.health.some((h) => h.svc === s && h.health === "healthy"));
      const ok = cgroupsComplete(p) && p.cases["A11-over-cap"]?.failure === "RENDERER_CRASHED" && JSON.stringify(rose) === JSON.stringify(["browser-worker"]) && memcg && p.cgroupsAfter["browser-worker"]?.peak === 1536 * MIB &&
        core5 && p.cases["A11b-after-over-cap"]?.ok === true && minAvail >= 1024;
      return { ok, actual: `failure=${p.cases["A11-over-cap"]?.failure}; oom_kill rose in=${rose.join(",") || "none"}; kernel memcg kill=${memcg}; browser peak=${p.cgroupsAfter["browser-worker"]?.peak / MIB} MiB; data services, core and gateway healthy=${core5}; next render=${p.cases["A11b-after-over-cap"]?.ok}; min MemAvailable=${minAvail} MiB` };
    } },

  // ============================================================== NuQ and the broker (R1, R2)
  N01: { name: "broker-outage-survived-pc-nuq-connect", inputs: [`${RAW}nuq-broker.txt`],
    expected: "with the core's restart policy off and the broker down at least 30 s, a synchronous v0 scrape during the outage completes through PostgreSQL (the API waits by polling, the worker's sender is not started); afterwards one completes through the reply queue (NuQ job sent, no polling); the core never restarts (same start time, restart count 0, no 'terminated unexpectedly'); the policy is restored",
    run() {
      const s = S(`${RAW}nuq-broker.txt`);
      const v = (sec) => jsonLines(s[`broker_${sec}`])[0];
      const out = kv((s.broker_broker_start ?? []).join(" ").split(" "));
      const log = s.broker_core_log ?? [];
      const at = (l) => (l.match(/ (\d{2}:\d{2}:\d{2}) /) ?? [])[1] ?? "";
      const startT = ((s.broker_broker_start ?? []).find((l) => l.startsWith("healthy_utc=")) ?? "").slice(23, 31);
      const stopT = ((s.broker_broker_stop ?? []).find((l) => l.startsWith("utc=")) ?? "").slice(15, 23);
      const during = log.filter((l) => at(l) >= stopT && at(l) < startT);
      const after = log.filter((l) => at(l) >= startT);
      const meta = (s.broker_meta ?? []).join(" "), state = (s.broker_core_state ?? []).join(" ");
      const started = (t) => (t.match(/started=(\S+)/) ?? [])[1];
      const cond = {
        before: v("before")?.success === true, during: v("during")?.success === true && v("during").sentinels.length === 1, after: v("after")?.success === true,
        outage: +out.outage_s >= 30, polled: during.some((l) => /waiting by polling/.test(l)) && during.some((l) => /NuQ sender not started/.test(l)),
        replyQueue: after.some((l) => /NuQ job sent/.test(l)) && !after.some((l) => /waiting by polling/.test(l)),
        noRestart: started(meta) === started(state) && /restarts=0/.test(state) && !log.some((l) => /terminated unexpectedly/.test(l)), policyOff: (s.broker_restart_policy_off ?? []).some((l) => /policy=no/.test(l)),
        restored: (s.broker_restart_policy_restore ?? []).some((l) => /policy=unless-stopped/.test(l)),
      };
      const bad = Object.entries(cond).filter(([, x]) => !x).map(([k]) => k);
      return { ok: bad.length === 0, actual: `failing=${bad.join(",") || "none"}; outage=${out.outage_s} s; during=${v("during")?.ms} ms; log lines during=${during.length} after=${after.length}` };
    } },
  N02: { name: "reply-queue-consumer-back-within-60s-4244", inputs: [`${RAW}nuq-broker.txt`],
    expected: "within 60 s of the broker being healthy again, the core's nuq.queue_scrape.listen.* queue has one consumer, and a new synchronous scrape returns",
    run() {
      const s = S(`${RAW}nuq-broker.txt`);
      const first = (s.broker_consumers ?? []).find((l) => / consumers=1$/.test(l));
      const t = +((first ?? "").match(/^t\+(\d+)s/) ?? [])[1];
      const after = jsonLines(s.broker_after)[0];
      const ok = !!first && t <= 60 && after?.success === true;
      return { ok, actual: `first consumer at t+${t}s (${first}); scrape after=${after?.success}` };
    } },
  N03: { name: "worker-killed-mid-job-recorded", inputs: [`${RAW}nuq-kill.txt`],
    expected: "the worker is killed while a synchronous job's acquisition runs; the record shows what follows: the harness ends ('nuq-worker-0 failed with exit code 137'), Docker restarts the core, the client's answer, the acquisition cancelled at the service, the job's requeue and end; killed again during a batch job, that job is requeued (stalls 1 or more) and completes in the restarted core; each within four attempts, the batch job's fixture requests equal to its attempts; the core is healthy again",
    run() {
      const s = S(`${RAW}nuq-kill.txt`);
      const log = s.kill_core_log ?? [];
      const client = jsonLines(s.kill_client_result)[0];
      const ready = (s.kill_core_ready ?? []).join(" ");
      const rows = (s.kill_attempts ?? []).filter((l) => l.split("\t").length >= 5);
      const job = (s.kill_job_observed ?? []).pop() ?? "";
      const health = (s.kill_health ?? []).find((l) => l.startsWith("firecrawl-core ")) ?? "";
      const arows = (s.kill_async_attempts ?? []).filter((l) => l.split("\t").length >= 5);
      const ajob = (s.kill_async_job_observed ?? []).pop() ?? "";
      const ahits = +((s.kill_async_fixture_hits ?? []).join("").match(/hits=(\d+)/) ?? [])[1];
      const cond = { killed: (s.kill_kill ?? []).some((l) => l === "kill_exit=0"), harness: log.some((l) => /nuq-worker-0 failed with exit code 137/.test(l)), client: !!client,
        cancelled: rows.length >= 1 && rows[0].split("\t")[3] === "CANCELLED", budget: rows.length <= 4, ended: /\t(completed|failed)\t/.test(job), asyncCompleted: /\tcompleted\t[1-9]\d*\t/.test(ajob) && arows.length >= 2 && arows.length <= 4 && ahits === arows.length && (s.kill_async_kill ?? []).some((l) => l === "kill_exit=0"), recovered: /health=healthy/.test(ready) || /running healthy/.test(health) };
      const bad = Object.entries(cond).filter(([, x]) => !x).map(([k]) => k);
      return { ok: bad.length === 0, actual: `failing=${bad.join(",") || "none"}; client=${client?.http ?? client?.error} after ${client?.ms} ms; attempts=${rows.length} (${rows.map((r) => r.split("\t")[3]).join(",")}); job=${job.split("\t")[1]} stalls=${job.split("\t")[2]}; batch job=${ajob.split("\t")[1]} stalls=${ajob.split("\t")[2]} attempts=${arows.map((r) => r.split("\t")[3]).join(",")} requests=${ahits}; core=${health.split(" ").slice(1).join(" ")}` };
    } },

  // ============================================================== egress, Cloud and exposure
  X01: { name: "zero-firecrawl-cloud-attempts", inputs: [`${RAW}egress-probe.txt`, `${RAW}guard-window-open.txt`, `${RAW}rt-ssrf.txt`],
    expected: "every core instance's saved log (scripts/m2/pi-core-logs.sh, R7) classifies each Cloud line as a refusal, a refused job's line or a request echo, and each name-resolution failure as a project service, with its harness-start positive control; the Cloud test targets were refused by policy (the positive control that they were asked); across the whole fixture window, from a guard-counter snapshot taken before its first phase to the egress probe after its last, the guard accepted no web connection on the egress bridge, so no Cloud or other public web connection was made",
    run() {
      const files = execFileSync("git", ["-C", ROOT, "ls-files", "--cached", "--others", "--exclude-standard", `${RAW}`], { encoding: "utf8" }).split("\n").filter((f) => /core-logs-.*\.txt$/.test(f));
      const recs = [];
      for (const f of files) for (const [sec, lines] of Object.entries(sections(f))) if (/^(instance|stored)_/.test(sec)) {
        const c = lines.find((l) => l.startsWith("classified ")); const ctl = +((lines.find((l) => l.startsWith("control=")) ?? "").match(/count=(\d+)/) ?? [])[1];
        const cloudCount = +((lines.find((l) => l.startsWith("pattern=firecrawl\\.dev")) ?? "").match(/count=(\d+)/) ?? [0, 0])[1];
        recs.push({ f, sec, c: c ? kv(c.split(" ").slice(1)) : null, ctl, cloudCount });
      }
      const latest = recs.filter((r) => r.c);
      const bad = latest.filter((r) => r.c.cloud_unexplained !== "0" || r.c.dns_unexplained !== "0" || !(r.ctl >= 1));
      const unclassifiedWithCloud = recs.filter((r) => !r.c && r.cloudCount > 0 && !latest.some((x) => x.sec.slice(-12) === r.sec.slice(-12)));
      const ssrf = phase("ssrf");
      const refusedCloud = Object.values(ssrf.cases).filter((c) => /CLOUD_DENIED/.test(c.error ?? "") || c.failure === "CLOUD_DENIED").length;
      // The window: the counters at its opening, the egress probe at its close; every fixture phase and
      // NuQ test lies between (their meta times), and no dockerd start reloaded the guard in between.
      const web = (f, sec) => +((sections(f)[sec] ?? []).find((l) => l.startsWith("egress_web_accepted")) ?? "=NaN").split("=")[1];
      const utcOf = (f) => Date.parse(((sections(f).meta ?? []).join(" ").match(/utc=(\S+?Z)/) ?? [])[1]);
      const open = utcOf(`${RAW}guard-window-open.txt`), close = utcOf(`${RAW}egress-probe.txt`);
      const phases = execFileSync("git", ["-C", ROOT, "ls-files", "--cached", "--others", "--exclude-standard", `${RAW}`], { encoding: "utf8" }).split("\n")
        .filter((f) => /\/(rt-[a-z-]+|nuq-(broker|kill|stall))\.txt$/.test(f));
      const times = phases.map((f) => Date.parse(((Object.entries(sections(f)).find(([k]) => /_meta$/.test(k))?.[1] ?? []).join(" ").match(/utc=(\S+?Z)/) ?? [])[1]));
      const inside = times.length >= 10 && times.every((t) => Number.isFinite(t) && t > open && t < close);
      const dockerd = (f) => ((sections(f).meta ?? []).join(" ").match(/docker_active_since=(\S+)/) ?? [])[1];
      const sameGuard = !!dockerd(`${RAW}guard-window-open.txt`) && dockerd(`${RAW}guard-window-open.txt`) === dockerd(`${RAW}egress-probe.txt`);
      const delta = web(`${RAW}egress-probe.txt`, "guard_after") - web(`${RAW}guard-window-open.txt`, "counters");
      const ok = latest.length >= 4 && bad.length === 0 && unclassifiedWithCloud.length === 0 && refusedCloud >= 3 && inside && sameGuard && delta === 0;
      return { ok, actual: `instance records classified=${latest.length} across ${files.length} captures; with unexplained lines or no control=${bad.map((r) => `${r.f}#${r.sec}`).join(",") || "none"}; unclassified with Cloud lines=${unclassifiedWithCloud.length}; Cloud targets refused by policy=${refusedCloud}; fixture window holds ${phases.length} phase records=${inside}, guard not reloaded=${sameGuard}, web accepts in the window=${delta}` };
    } },
  X02: { name: "core-has-no-direct-egress", inputs: [`${RAW}egress-probe.txt`, `${RAW}stack.txt`],
    expected: "every network the core joins is internal and it has no default route; from inside it, public names do not resolve and no public, LAN or egress-bridge address connects, while the retrieval service (its only way out) answers",
    run() {
      const s = S(`${RAW}egress-probe.txt`);
      const core = jsonLines(s.probes).find((j) => j.role === "core");
      const att = (s.attachments ?? []).find((l) => l.startsWith("firecrawl-core networks=")) ?? "";
      const nets = (att.match(/networks=(\S+)/) ?? [])[1]?.split(",") ?? [];
      const internal = nets.every((n) => (s.attachments ?? []).some((l) => l.startsWith(`network ${n} internal=true`)));
      const route = (s.attachments ?? []).some((l) => l === "firecrawl-core default_route=no resolv_nameservers=127.0.0.11");
      const ok = core?.all_as_expected === true && core.probes.filter((p) => p.expect === "ok").length >= 2 && nets.length === 3 && internal && route;
      return { ok, actual: `probes as expected=${core?.all_as_expected} (${core?.probes.length}); networks=${nets.join(",")} all internal=${internal}; default route none=${route}` };
    } },
  X03: { name: "egress-bridge-guarded-and-own-dns", inputs: [`${RAW}egress-probe.txt`, "deploy/host/fcpi-guard.nft"],
    expected: "the only non-internal networks are the gateway's access bridge and the retrieval service's egress bridge, and each container on one names its own DNS upstream; the browser worker and the fixtures have no route out; from the retrieval service, host, LAN, special-purpose, non-web-port and IPv6 targets fail while the host resolver answers; the guard's special, host-local, non-web and input drop counters each rise and its web-accept counter does not",
    run() {
      const s = S(`${RAW}egress-probe.txt`);
      const probes = Object.fromEntries(jsonLines(s.probes).map((j) => [j.role, j]));
      const nonInternal = (s.attachments ?? []).filter((l) => /^network \S+ internal=false/.test(l)).map((l) => l.split(" ")[1]).sort();
      const dnsSet = ["access-gateway", "retrieval-service"].every((svc) => (s.attachments ?? []).some((l) => l.startsWith(`${svc} networks=`) && /dns=\d/.test(l)));
      const kvc = (sec) => Object.fromEntries((s[sec] ?? []).filter((l) => /packets=/.test(l)).map((l) => [l.split(" ")[0], +l.split("=")[1]]));
      const b = kvc("guard_before"), a = kvc("guard_after"), d = (k) => (a[k] ?? 0) - (b[k] ?? 0);
      const rose = ["egress_special_dropped", "egress_local_dropped", "egress_other_dropped", "egress_input_dropped"].every((k) => d(k) > 0);
      // With the router's public address configured as local (X11), both probes to it must fail.
      const wanOn = /wan_configured=yes/.test((s.meta ?? []).join(" "));
      const wanCases = (probes.retrieval?.probes ?? []).filter((p) => /^tcp wan:/.test(p.label));
      const wanOk = wanOn && wanCases.length === 2 && wanCases.every((p) => p.as_expected);
      const ok = wanOk && JSON.stringify(nonInternal) === JSON.stringify(["fcpi_access", "fcpi_egress"]) && dnsSet && ["browser", "retrieval", "fixture"].every((r) => probes[r]?.all_as_expected === true) && rose && d("egress_web_accepted") === 0 && (a.egress_web_accepted ?? -1) === 0;
      return { ok, actual: `router public address probed=${wanOk} (configured=${wanOn}); non-internal=${nonInternal.join(",")}; own DNS on them=${dnsSet}; browser/retrieval/fixture as expected=${["browser", "retrieval", "fixture"].map((r) => probes[r]?.all_as_expected).join("/")}; guard deltas special=${d("egress_special_dropped")} local=${d("egress_local_dropped")} other=${d("egress_other_dropped")} input=${d("egress_input_dropped")} web_accepted=${d("egress_web_accepted")}` };
    } },
  X11: { name: "router-public-address-is-host-local", inputs: [`${RAW}wan-address.txt`, "evidence/M0/audit.json"],
    expected: "the router's public address (review finding W8), measured once as M0 measured it and printed only as a hash, is in the retrieval service's local-network file and the guard's host-local set",
    run() {
      const w = kv((sections(`${RAW}wan-address.txt`).measure ?? []).join(" ").split(" ")), c = kv(sections(`${RAW}wan-address.txt`).check);
      const sameAsM0 = w.wan_sha256 === json("evidence/M0/audit.json").network.egress_ip_sha256;
      const ok = w.measured === "yes" && /^[0-9a-f]{64}$/.test(w.wan_sha256 ?? "") && c.in_cidrs_file === "yes" && c.in_guard_set === "yes";
      return { ok, actual: `measured=${w.measured}; same address as M0=${sameAsM0}; in the local-network file=${c.in_cidrs_file}; in the guard set=${c.in_guard_set}` };
    } },
  X04: { name: "access-bridge-guard-still-holds", inputs: [`${RAW}guard.txt`, "deploy/host/fcpi-guard.nft"],
    expected: "the guard table is loaded from the file the repository holds; from inside the gateway, the host's bridge address, its LAN sshd and a public address do not connect (M1's V20 probe)",
    run() {
      const s = S(`${RAW}guard.txt`), m = kv(s.after_meta?.join(" ").split(" "));
      const probe = JSON.parse(((s.after_probe ?? []).find((l) => l.startsWith("gateway ")) ?? "gateway {}").slice(8));
      const tcp = Object.values(probe.tcp ?? {});
      const ok = m.guard_table === "present" && m.guard_file_sha256 === sha256File("deploy/host/fcpi-guard.nft") && tcp.length >= 3 && tcp.every((x) => x.connected === false);
      return { ok, actual: `table=${m.guard_table}; file hash matches repository=${m.guard_file_sha256 === sha256File("deploy/host/fcpi-guard.nft")}; gateway connects refused=${tcp.filter((x) => !x.connected).length}/${tcp.length}` };
    } },
  X05: { name: "allow-local-webhooks-removed-r4", inputs: [`${EV}rendered-compose.json`, "docs/FIRECRAWL_PI_SPEC.md", "patches/0003-pi-resilient-engine-adapter.patch"],
    expected: "no service sets ALLOW_LOCAL_WEBHOOKS; the core has left the fixture network; the patched config refuses the pi-resilient profile with the flag set; spec §29 no longer describes an M1 fixture exception",
    run() {
      const R = json(`${EV}rendered-compose.json`);
      const setters = Object.entries(R.services).filter(([, v]) => v.environment && "ALLOW_LOCAL_WEBHOOKS" in v.environment).map(([k]) => k);
      const coreNets = Object.keys(R.services["firecrawl-core"]?.networks ?? {});
      // The refusal itself: the added conflict entry in config.ts's superRefine, not any mention of the flag.
      const refuse = read("patches/0003-pi-resilient-engine-adapter.patch").split("\n").includes(`+      ["ALLOW_LOCAL_WEBHOOKS", value.ALLOW_LOCAL_WEBHOOKS === true],`);
      const spec = read("docs/FIRECRAWL_PI_SPEC.md");
      const specStale = /M1 fixture-only profile sets it true/.test(spec) || /M2 removes it/.test(spec);
      const ok = setters.length === 0 && !coreNets.includes("fixture") && refuse && !specStale;
      return { ok, actual: `services setting it=${setters.join(",") || "none"}; core networks=${coreNets.join(",")}; patch refuses the profile with it=${refuse}; spec still describes the M1 exception=${specStale}` };
    } },
  X06: { name: "published-ports-loopback-only", inputs: [`${RAW}stack.txt`, `${RAW}lan-probe.txt`],
    expected: "the only project publication is the gateway on 127.0.0.1:3380; no project process listens on the host beyond it; from the LAN every project port is closed while sshd (the positive control) is open",
    run() {
      const pub = (S(`${RAW}stack.txt`).published ?? []).filter((l) => / -> /.test(l));
      const listeners = (S(`${RAW}stack.txt`).published ?? []).filter((l) => /^(tcp|udp) /.test(l) && /docker-proxy/.test(l));
      const lan = S(`${RAW}lan-probe.txt`);
      const open = (lan.project_ports ?? []).filter((l) => / open$/.test(l));
      const ok = JSON.stringify(pub) === JSON.stringify(["access-gateway 3300/tcp -> 127.0.0.1:3380"]) && listeners.length === 1 && /127\.0\.0\.1:3380/.test(listeners[0]) &&
        (lan.project_ports ?? []).length >= 10 && open.length === 0 && (lan.control ?? []).includes("port=22 open");
      return { ok, actual: `publications=${pub.join(";")}; docker-proxy listeners=${listeners.length}; LAN project ports open=${open.length}/${(lan.project_ports ?? []).length}; control open=${(lan.control ?? []).includes("port=22 open")}` };
    } },
  X07: { name: "core-credentials-dml-only", inputs: [`${RAW}credentials.txt`],
    expected: "fcpi_core is no superuser, owns nothing, holds only SELECT/INSERT/UPDATE/DELETE on NuQ's tables and cannot create in schema nuq, create a function or attach a trigger; its password differs from the superuser's",
    run() {
      const s = S(`${RAW}credentials.txt`), p = kv(s.postgres), pr = kv(s.fcpi_core_probe), sc = kv(s.secrets);
      const ok = /super=false/.test(p.role ?? "") && p.fcpi_core_owned_objects === "0" && p.fcpi_core_privileges === "DELETE,INSERT,SELECT,UPDATE" && p.fcpi_core_schema_create === "f" &&
        pr.dml === "ok" && /permission denied/.test(pr.create_function_in_nuq ?? "") && /permission denied/.test(pr.create_trigger_on_nuq ?? "") && sc.core_equals_superuser === "no";
      return { ok, actual: `owned=${p.fcpi_core_owned_objects}; privileges=${p.fcpi_core_privileges}; function=${(pr.create_function_in_nuq ?? "").slice(0, 40)}; trigger=${(pr.create_trigger_on_nuq ?? "").slice(0, 40)}` };
    } },
  X08: { name: "persistence-across-force-recreate", inputs: [`${RAW}persistence.txt`, `${RAW}core-logs-before-persistence.txt`],
    expected: "after `up -d --force-recreate` with no volume removed, all nine services run healthy in new containers; the PostgreSQL, Redis and RabbitMQ sentinels read back; the retrieval service's acquisition, attempt, domain and navigation-ledger rows are unchanged; the core's log was captured first",
    run() {
      const s = S(`${RAW}persistence.txt`), V = kv(s.meta).sentinel;
      const ids = (sec) => Object.fromEntries((s[sec] ?? []).filter((l) => /^[a-z0-9-]+ [0-9a-f]{64}$/.test(l)).map((l) => l.split(" ")));
      const b = ids("before"), a = ids("after");
      const replaced = Object.keys(b).length === 9 && Object.keys(b).every((k) => a[k] && a[k] !== b[k]);
      const rows = (sec) => (s[sec] ?? []).find((l) => l.startsWith("retrieval_rows ")) ?? "";
      const healthyAll = (s.after ?? []).filter((l) => / running healthy$/.test(l)).length === 9;
      const r = kv(s.read);
      const ok = replaced && healthyAll && /recreate_exit=0/.test((s.recreate ?? []).join(" ")) && r.postgres_read === V && r.redis_read === V && (r.rabbitmq_read ?? "").includes(V) &&
        rows("write") !== "" && rows("write") === rows("read") && has(`${RAW}core-logs-before-persistence.txt`);
      return { ok, actual: `replaced=${replaced}; healthy=${healthyAll}; sentinels pg=${r.postgres_read === V} redis=${r.redis_read === V} rabbitmq=${(r.rabbitmq_read ?? "").includes(V)}; retrieval rows equal=${rows("write") === rows("read")}` };
    } },
  X09: { name: "unrelated-state-unchanged", inputs: [`${EV}snapshot-before.txt`, `${EV}snapshot-after.txt`, `${RAW}nft-ruleset.txt`],
    expected: "every line differing between M2's BEFORE and AFTER snapshots is attributed to the project (fcpi containers, their scopes, root filesystems and namespaces, kernel modules for the runtime and the guard's sets, the ruleset with the guard's egress rules and Docker's rules for M2's bridges) or to the collector's own SSH session; no unrelated line is removed or changed; boot ID unchanged",
    run() {
      const [B, A] = [`${EV}snapshot-before.txt`, `${EV}snapshot-after.txt`];
      const psIds = (f) => (read(f).match(/^### docker_ps\n([\s\S]*?)\n### /m)?.[1] ?? "").split("\n").map((l) => l.split("\t")[0]).filter((x) => /^[0-9a-f]{64}$/.test(x));
      const ids = new Set([...psIds(B), ...psIds(A)]);
      const norm = (sec, l) => (sec === "ss_listen" ? l.replace(/pid=\d+,fd=\d+/g, "pid,fd") : l);
      const K = (f) => keyedSnapshot(f).map(([s, l]) => `${s}\t${norm(s, l)}`);
      const b = K(B), a = K(A);
      const removed = b.filter((l) => !a.includes(l)), added = a.filter((l) => !b.includes(l));
      const unexplained = [], why = {}, rows = { project: [], unrelated: [] };
      for (const [kind, list] of [["removed", removed], ["added", added]]) for (const l of list) {
        const [sec, line] = [l.slice(0, l.indexOf("\t")), l.slice(l.indexOf("\t") + 1)];
        const w = attribute(sec, line, ids);
        const acceptable = w && (kind === "added" || /own SSH session|nftables|fcpi container|container network namespace|scope of an fcpi container|Docker's chains/.test(w));
        if (!acceptable) unexplained.push(`${kind} ${sec}: ${line.slice(0, 90)}`); else why[w] = (why[w] ?? 0) + 1;
        rows[acceptable ? "project" : "unrelated"].push(`${kind === "added" ? "+" : "-"} ${sec}\t${line}${w ? `\t# ${w}` : ""}`);
      }
      const boot = (f) => (read(f).match(/^boot_id_sha256=([0-9a-f]{64})$/m) ?? [])[1];
      writeFileSync(resolve(ROOT, `${EV}snapshot-diff.txt`), ["# M2 BEFORE/AFTER snapshot diff (section-keyed; written by scripts/m2/verify.mjs X09)",
        `# before: ${read(B).split("\n")[1]}  after: ${read(A).split("\n")[1]}`, `# boot_id: ${boot(B) && boot(B) === boot(A) ? "unchanged (no reboot)" : "CHANGED or MISSING"}`,
        `## changes to unrelated state (${rows.unrelated.length})`, ...rows.unrelated, `## project changes and the collector's own SSH sessions (${rows.project.length})`, ...rows.project, ""].join("\n"));
      const ok = unexplained.length === 0 && !!boot(B) && boot(B) === boot(A);
      return { ok, actual: `added=${added.length} removed=${removed.length}; attributed ${JSON.stringify(why)}; unexplained=${unexplained.length}${unexplained.length ? " [" + unexplained.slice(0, 8).join("; ") + "]" : ""}; boot_id_equal=${boot(B) === boot(A)}` };
    } },
  X10: { name: "secret-and-identifier-redaction-scan", inputs: [M0_CONTROL, M1_CONTROL, "scripts/m1/pi-target.conf", "evidence/M0/audit.json"], live: true,
    expected: "the positive controls fire every rule; then no rule matches in any tracked or new repository file; no file holds any of the nine live secrets (M1's six, the retrieval service's PostgreSQL password, the core's retrieval token and the browser token), compared by SHA-256 computed on the Pi; no file added or changed since M2 began holds the Pi's LAN address, its /24 network or its SSH target",
    run() {
      // Controls: M0's with its own dummy identities, M1's with the SHA-256 of its synthetic secrets.
      // The controls are scanned with no allow-list: their synthetic values are what must fire.
      const c = [...scan([M0_CONTROL], { m0: { egress: sha256("192.0.2.77"), serial: sha256("0123456789abcdef"), machineId: sha256("0123456789abcdef0123456789abcdef"), macs: new Set([sha256("02:00:00:00:00:01")]) } }, RULES, new Set()),
        ...scan([M1_CONTROL], { secrets: new Set([sha256("0f".repeat(32)), sha256("ABCDEFGHIJKLMNOP".repeat(4))]) }, RULES, new Set())];
      const fired = new Set(c.map((h) => h.split(" ").pop()));
      const silent = [...RULES.map(([n]) => n), ...HASH_RULES].filter((r) => !fired.has(r));
      if (silent.length) return { ok: false, actual: `positive controls: rules that did not fire: ${silent.join(", ")}` };
      const hashes = ssh(`sudo -n sh -c 'S=/etc/firecrawl-pi/secrets; h() { [ -n "$1" ] || { echo "EMPTY secret extraction" >&2; exit 1; }; printf "%s" "$1" | sha256sum | cut -c1-64; }; \
        h "$(cat $S/postgres_password)"; h "$(cat $S/core_postgres_password)"; h "$(sed -n "s#^amqp://fcpi:\\(.*\\)@rabbitmq:5672\\$#\\1#p" $S/core_nuq_rabbitmq_url)"; \
        h "$(sed -n "s#^redis://:\\(.*\\)@redis:6379\\$#\\1#p" $S/core_redis_url)"; h "$(cat $S/clients/m1-verify.token)"; h "$(cat /srv/firecrawl-pi/data/rabbitmq/.erlang.cookie)"; \
        h "$(cat $S/retrieval_postgres_password)"; h "$(cat $S/core_retrieval_token)"; h "$(cat $S/retrieval_browser_token)"'`).split("\n").filter((x) => /^[0-9a-f]{64}$/.test(x));
      if (hashes.length !== 9 || new Set(hashes).size !== 9 || hashes.includes(sha256(""))) return { ok: false, actual: `expected 9 distinct non-empty live secret hashes from the Pi, got ${hashes.length} (${new Set(hashes).size} distinct)` };
      const files = execFileSync("git", ["-C", ROOT, "ls-files", "--cached", "--others", "--exclude-standard"], { encoding: "utf8" }).split("\n").filter((f) => f && f !== M0_CONTROL && f !== M1_CONTROL && has(f) && !/\.(pdf|png|gz)$/.test(f));
      const audit = json("evidence/M0/audit.json");
      const m0 = { egress: audit.network.egress_ip_sha256, serial: audit.identity.board_serial_sha256, machineId: audit.identity.machine_id_sha256, macs: new Set([...Object.values(audit.identity.mac_sha256), sha256("00:00:00:00:00:00")]) };
      const hits = scan(files, { m0, secrets: new Set(hashes) });
      const t = target(), lan = t.PI_LAN_ADDRESS, net = lan.replace(/\.\d+$/, ".0");
      const changed = [...new Set([...git("diff", "--name-only", `${M2_START}..HEAD`).split("\n"), ...git("ls-files", "--others", "--exclude-standard").split("\n")])].filter((f) => f && has(f) && !/\.(pdf|png|gz)$/.test(f));
      const idHits = changed.filter((f) => { const x = read(f); return x.includes(lan) || x.includes(`${net}/`) || x.includes(t.PI_SSH_TARGET); });
      return { ok: hits.length === 0 && idHits.length === 0, configHash: hashOf(files.filter((f) => f !== OUT)), actual: `controls fired all ${RULES.length + HASH_RULES.length} rules; files scanned=${files.length}; live secret hashes compared=${hashes.length}; findings=${hits.length}${hits.length ? " [" + hits.slice(0, 12).join("; ") + "]" : ""}; M2 files with the LAN address, network or SSH target=${idHits.join(",") || "none"} (of ${changed.length})` };
    } },
  L01: { name: "lock-and-compose-consistent", inputs: ["deploy/versions.lock.json", "deploy/compose.yaml", `${EV}rendered-compose.json`, "patches/series.json"],
    expected: "every Compose image is pinned by digest for linux/arm64 and the lock records the same digests for the API, retrieval and browser images, the patch series hash and every patch's hash, the Playwright release with its browsers.json revision, and the browser archives' SHA-256",
    run() {
      const R = json(`${EV}rendered-compose.json`), L = json("deploy/versions.lock.json"), s = json("patches/series.json");
      const unpinned = Object.entries(R.services).filter(([, v]) => !/@sha256:[0-9a-f]{64}$/.test(v.image) || v.platform !== "linux/arm64").map(([k]) => k);
      const cond = { api: L.images?.firecrawl_api_patched?.image_id === digestOf(composeImage("firecrawl-core")), retrieval: L.images?.retrieval?.image_id === digestOf(composeImage("retrieval-service")), browser: L.images?.browser_worker?.image_id === digestOf(composeImage("browser-worker")),
        series: L.patches?.series_sha256 === s.series_sha256 && JSON.stringify((L.patches?.patches ?? []).map((p) => ({ file: p.file, sha256: p.sha256 }))) === JSON.stringify(s.patches.map((p) => ({ file: p.file, sha256: p.sha256 }))),
        playwright: L.browser?.playwright === "1.63.0" && L.browser?.chromium_revision === d1().revision, archives: L.browser?.archive_sha256?.status === "resolved" };
      const bad = Object.entries(cond).filter(([, v]) => !v).map(([k]) => k);
      return { ok: unpinned.length === 0 && bad.length === 0, actual: `unpinned=${unpinned.join(",") || "none"}; lock disagrees on=${bad.join(",") || "none"}` };
    } },
  U01: { name: "retrieval-unit-tests-pass", inputs: [`${RAW}unit-tests.txt`, `${EV}rendered-compose.json`],
    expected: "the retrieval service's unit suite passes inside the image the stack runs, the Store's SQL tests included against a throwaway PostgreSQL (none skipped), and leaves no throwaway container or network",
    run() {
      const s = S(`${RAW}unit-tests.txt`), tap = s.tap ?? [];
      const n = (k) => +((tap.find((l) => l.startsWith(`# ${k} `)) ?? "").split(" ")[2]);
      const img = (kv(s.meta?.join(" ").split(" ")).image ?? "").split("@")[1];
      const ok = n("tests") >= 40 && n("pass") === n("tests") && n("fail") === 0 && n("skipped") === 0 && tap.includes("test_exit=0") && img === digestOf(composeImage("retrieval-service")) &&
        (s.transient ?? []).includes("leftover_transient_containers=0 leftover_transient_networks=0");
      return { ok, actual: `tests=${n("tests")} pass=${n("pass")} fail=${n("fail")} skipped=${n("skipped")}; image is the running one=${img === digestOf(composeImage("retrieval-service"))}` };
    } },
  V01: { name: "review-record-complete", inputs: [`${EV}review/REVIEW.md`],
    expected: "the saved /review-2 report (CLAUDE.md §5) gives every finding an outcome (fixed with its commit, rejected with evidence, deferred to a later milestone), cites only commits that exist, and holds no absolute local path",
    run() {
      const text = read(`${EV}review/REVIEW.md`);
      const rows = text.split("\n").filter((l) => /^\| [A-Z]{1,2}\d+ \|/.test(l)).map((l) => l.split(" | "));
      const bad = rows.filter((c) => !/^(Fixed|Rejected, with the evidence|Deferred to M\d|Partly fixed, partly rejected)/.test(c[3] ?? "")).map((c) => c[0].slice(2));
      const commits = [...new Set([...text.matchAll(/`([0-9a-f]{7,40})`/g)].map((m) => m[1]))];
      const missing = commits.filter((c) => { try { git("cat-file", "-e", `${c}^{commit}`); return false; } catch { return true; } });
      const local = /\/(private\/tmp|Users\/[^\/\s]+|home\/[^\/\s]+)\//.test(text);
      const ok = rows.length > 0 && bad.length === 0 && missing.length === 0 && !local;
      return { ok, actual: `findings=${rows.length}; without a recognised outcome=${bad.join(",") || "none"}; commits cited=${commits.length}, missing=${missing.join(",") || "none"}; absolute local path=${local}` };
    } },
};

// ---- runner ------------------------------------------------------------------------------------
const listed = Object.keys(checks);
const wanted = process.argv.slice(2).length ? process.argv.slice(2) : listed;
const prior = has(OUT) ? json(OUT) : { results: [] };
const results = Object.fromEntries(prior.results.map((r) => [r.test_id, r]));
const repo = repoState();
const series = json("patches/series.json");
for (const id of wanted) {
  const c = checks[id];
  if (!c) throw new Error(`unknown check ${id}`);
  const rec = { test_id: `M2-${id}`, name: c.name, utc: now(), ...repo, upstream_sha: UPSTREAM_SHA, patch_series_sha256: series.series_sha256, config_or_fixture_hash: null, expected: c.expected };
  try {
    const missing = c.inputs.filter((p) => !has(p));
    if (missing.length) Object.assign(rec, { state: "NOT_RUN", actual: `evidence missing: ${missing.join(", ")}`, exit_code: null });
    else {
      rec.config_or_fixture_hash = hashOf(c.inputs);
      const r = c.run();
      if (r.notRun) Object.assign(rec, { state: "NOT_RUN", actual: r.actual, exit_code: null });
      else Object.assign(rec, { state: r.ok ? "PASS" : "FAIL", actual: r.actual, exit_code: r.ok ? 0 : 1 });
      if (r.configHash) rec.config_or_fixture_hash = r.configHash;
    }
    if (c.live) rec.live_sources = "the Pi over SSH (secret hashes only)";
  } catch (e) {
    Object.assign(rec, { state: "FAIL", actual: `check raised: ${e.message}`, exit_code: 2, classification: "verifier-error" });
  }
  rec.image_digests_platform = { platform: "linux/arm64", api: digestOf(composeImage("firecrawl-core")), retrieval: digestOf(composeImage("retrieval-service")), browser: digestOf(composeImage("browser-worker")) };
  // An error text can carry the SSH command; the Pi's identifiers never enter the record.
  { const t = target(); rec.actual = String(rec.actual).split(t.PI_SSH_TARGET).join("<pi-ssh-target>").split(t.PI_LAN_ADDRESS).join("<pi-lan-address>"); }
  rec.evidence_path = OUT;
  results[rec.test_id] = rec;
  console.log(`${rec.test_id} ${rec.state.padEnd(8)} ${c.name}${rec.state !== "PASS" ? `  — ${rec.actual.slice(0, 220)}` : ""}`);
}
const ordered = listed.map((id) => results[`M2-${id}`] ?? { test_id: `M2-${id}`, name: checks[id].name, state: "NOT_RUN", actual: "never run", evidence_path: OUT });
writeFileSync(resolve(ROOT, OUT), JSON.stringify({ schema: "fcpi.m2.verification/v1", runner: "scripts/m2/verify.mjs",
  repository_sha_note: "Each result records the commit checked out when it ran, with code_dirty; the commit that stores this file is a later one on main.",
  results: ordered }, null, 2) + "\n");
process.exitCode = ordered.every((r) => r.state === "PASS") ? 0 : 1;
