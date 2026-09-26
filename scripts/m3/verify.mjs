#!/usr/bin/env node
// M3 verification (docs/FIRECRAWL_PI_MILESTONES.md, M3 "Automated Verification"; CLAUDE.md §25, §26,
// §33.3). Every check recomputes its result from the raw evidence under evidence/M3/ (or the directory
// FCPI_M3_EVIDENCE names) and records the §25 tuple, with code_dirty, in evidence/M3/verification.json.
// A check whose evidence is missing is NOT_RUN, never PASS; a check that reads a record requires that
// record to be there (an absent one fails, it does not pass vacuously); every negative result is read
// beside its positive control; each check's `expected` names what it compares.
//   node scripts/m3/verify.mjs [CHECK_ID …]
import { readFileSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { ROOT, sha256, sha256File, repoState, sections, git, kv } from "../m0/lib.mjs";

const EV = process.env.FCPI_M3_EVIDENCE ?? "evidence/M3/";
const RAW = `${EV}raw/`;
const OUT = `${EV}verification.json`;
const UPSTREAM_SHA = "7666c1f9ae8720a6bba271e0f60b6a217f8a5210";
const M3_START = "aa22d92"; // the kickoff's HEAD: files changed after it are M3's
const ORIGIN = "http://127.0.0.1:3380", FX = "http://m3.fixture.fcpi.test:8080";
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
// The Pi's identifiers and this machine's paths, replaced; the key path first, since it holds $HOME.
const hideIds = (s, t) => [[t.PI_SSH_KEY, "<pi-ssh-key>"], [t.PI_SSH_TARGET, "<pi-ssh-target>"], [t.PI_LAN_ADDRESS, "<pi-lan-address>"], [process.env.HOME, "<home>"]]
  .reduce((x, [a, b]) => (a ? x.split(a).join(b) : x), s);
const digestOf = (ref) => (ref.match(/@(sha256:[0-9a-f]{64})$/) ?? [])[1] ?? null;
const composeImage = (svc) => json(`${EV}rendered-compose.json`).services[svc]?.image ?? "";
const S = (f) => sections(f);
const jsonLines = (lines) => (lines ?? []).filter((l) => l.startsWith("{")).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
// A JSON-line transcript: { section: [records] }. A section that appears again (the driver prints a
// header whenever the section changes) adds to its earlier records rather than replacing them.
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
// One run per transcript: exactly one meta and one end record, the end with exit 0, and no error. A
// transcript appended to (>>) holds two runs, which would otherwise read as one.
const endOk = (e) => e.meta?.length === 1 && e.end?.length === 1 && e.end[0].exit === 0 && !e.error;
// Ids recorded side by side: the same job means two equal UUIDs, another job two different UUIDs, so a
// missing id (two undefined values compare equal) passes neither.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const sameId = (r) => !!r && UUID_RE.test(r.id ?? "") && r.id === r.first_id;
const otherId = (r) => !!r && UUID_RE.test(r.id ?? "") && UUID_RE.test(r.first_id ?? "") && r.id !== r.first_id;
const sorted = (a) => [...a].sort();
const GRAPH = [`${FX}/`, ...Array.from({ length: 11 }, (_, i) => `${FX}/p${String(i + 1).padStart(2, "0")}`)];
const MAP12 = [FX, ...GRAPH.slice(1)];
const tapCounts = (lines) => { const n = (k) => +((lines.find((l) => l.startsWith(`# ${k} `)) ?? "").split(" ")[2]); return { tests: n("tests"), pass: n("pass"), fail: n("fail"), skipped: n("skipped"), cancelled: n("cancelled") }; };

// ---- redaction (M2's rules, M3's live secrets) ------------------------------------------------------
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
  // M3: a tailnet name by its shape (<label>.ts.net), since the live name is not always known.
  ["tailnet-name", /\b[a-z0-9-]+\.ts\.net\b/i],
];
// Literal strings allowed outside the controls: scripts/m2/verify.mjs's list, and M3's synthetic tailnet names
// (the contract suite's origins, the SSRF test's host and the review's placeholder).
const ALLOW = new Set(["00:00:00:00:00:00", "02:00:00:00:00:01", "02:00:00:00:00:02", "02:00:00:00:00:99",
  "amqp://fcpi:%s@", "amqp://fcpi:$rmqpw@", String.raw`amqp://fcpi:\\(.*\\)@`, "http://user:pw@",
  "password: r.proxy.password", "password: cred.password", "password = randomBytes", "password: readSecret",
  "example-tailnet.ts.net", "other-tailnet.ts.net", "pi.ts.net", "tailXXXX.ts.net"]);
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

// ---- snapshot attribution (scripts/m2/verify.mjs X09, with M3's bridge) ------------------------------
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
  if (sec === "firewall" && /^nft_ruleset_sha256=/.test(line)) return "nftables ruleset: Docker's rules for M3's fcpi-platform bridge (evidence/M3/raw/nft-ruleset.txt)";
  if (sec === "nft_chains" && /^ip6? (filter|nat|raw) /.test(line)) return "Docker's chains for M3's bridge";
  return null;
}

// ---- checks ------------------------------------------------------------------------------------------
const checks = {
  B00: { name: "baseline-matches-m2-after", inputs: [`${EV}snapshot-before.txt`, "evidence/M2/snapshot-after.txt"],
    expected: "M3's BEFORE snapshot equals M2's AFTER apart from SSH session scopes, and the boot ID is unchanged",
    run() {
      const strip = (f) => keyedSnapshot(f).map((x) => x.join("\t")).filter((l) => !/\tsession-\d+\.scope$/.test(l)).sort();
      const a = strip("evidence/M2/snapshot-after.txt"), b = strip(`${EV}snapshot-before.txt`);
      const only = (x, y) => x.filter((l) => !y.includes(l));
      const boot = (f) => (read(f).match(/^boot_id_sha256=([0-9a-f]{64})$/m) ?? [])[1];
      const ok = a.length > 50 && only(a, b).length === 0 && only(b, a).length === 0 && !!boot(`${EV}snapshot-before.txt`) && boot("evidence/M2/snapshot-after.txt") === boot(`${EV}snapshot-before.txt`);
      return { ok, actual: `lines=${a.length}; only in M2 AFTER=${only(a, b).length}, only in M3 BEFORE=${only(b, a).length}, boot_id_equal=${boot("evidence/M2/snapshot-after.txt") === boot(`${EV}snapshot-before.txt`)}` };
    } },

  // ================================================================ the gateway build and its tests
  G01: { name: "gateway-image-pinned-built-and-running", inputs: [`${RAW}gateway-build.txt`, `${EV}rendered-compose.json`, `${RAW}stack.txt`, "services/access/Dockerfile", "services/access/package-lock.json"],
    expected: "the gateway builds FROM the digest-pinned node base with npm ci --omit=dev --ignore-scripts against its lockfile, for linux/arm64, as uid 3380, recording the commit it was built from; the image the stack renders and runs is the last build recorded, and its recorded commit is that build's; that commit and every deployed commit a raw record names differ from HEAD in nothing the Pi runs or the drivers do",
    run() {
      const log = read(`${RAW}gateway-build.txt`), df = read("services/access/Dockerfile");
      const builds = [...log.matchAll(/^fcpi\/access-gateway:m3 id=(sha256:[0-9a-f]{64}) os=linux arch=(\S+) size=\d+ user=(\S+)$/gm)];
      const last = builds.at(-1);
      const lastCommit = [...log.matchAll(/^FCPI_SOURCE_COMMIT=([0-9a-f]{40})$/gm)].at(-1)?.[1];
      const froms = [...df.matchAll(/^FROM (\S+)/gm)].map((m) => m[1]);
      const st = S(`${RAW}stack.txt`);
      const running = (st.containers ?? []).find((l) => l.startsWith("access-gateway "))?.match(/ image=(sha256:[0-9a-f]{64}) /)?.[1];
      const imgCommit = kv(st.gateway_image ?? []).image_FCPI_SOURCE_COMMIT;
      const lock = json("services/access/package-lock.json");
      const cond = { built: !!last && /build_exit=0 /.test(log.split("### images").at(-2) ?? log), arm64: last?.[2] === "arm64", uid: last?.[3] === "3380:3380", from_pinned: froms.length === 1 && /@sha256:[0-9a-f]{64}$/.test(froms[0]),
        npm_ci: /npm ci --omit=dev --ignore-scripts/.test(df), lock_integrity: Object.entries(lock.packages).filter(([k]) => k).every(([, v]) => /^sha512-/.test(v.integrity ?? "")),
        rendered: digestOf(composeImage("access-gateway")) === last?.[1], running: running === last?.[1], commit_recorded: !!lastCommit && imgCommit === lastCommit };
      // The evidence describes the code at HEAD: the image's build commit and every deployed commit a raw
      // record names differ from HEAD in nothing the Pi runs or the drivers do (the verifier, the lock
      // builder and the lock may move on). tailscale-before.txt is the host before Tailscale existed, a
      // state that cannot be collected again.
      const CODE = ["services/access", "deploy", ":(exclude)deploy/versions.lock.json", "scripts/m1/deploy.sh", "scripts/m3", ":(exclude)scripts/m3/verify.mjs", ":(exclude)scripts/m3/build-lock.mjs",
        "tests/contracts/m3-gateway.test.mjs", "tests/fixtures/m3"];
      const named = readdirSync(resolve(ROOT, RAW)).filter((f) => f !== "tailscale-before.txt" && /\.(txt|json)$/.test(f))
        .flatMap((f) => [...read(`${RAW}${f}`).matchAll(/source_commit(?:=|":")([0-9a-f]{40})/g)].map((m) => [f, m[1]]));
      const commits = new Set([imgCommit, ...named.map(([, c]) => c)].filter(Boolean));
      const stale = [...commits].filter((c) => { try { git("diff", "--quiet", c, "HEAD", "--", ...CODE); return false; } catch { return true; } });
      cond.evidence_at_head = named.length >= 10 && stale.length === 0;
      const bad = Object.entries(cond).filter(([, v]) => !v).map(([k]) => k);
      return { ok: bad.length === 0, actual: `records naming a deployed commit=${named.length}, commits differing from HEAD in code=${stale.map((c) => c.slice(0, 7)).join(",") || "none"}; builds=${builds.length}; last=${last?.[1]?.slice(7, 19)} arch=${last?.[2]} user=${last?.[3]}; running=${running?.slice(7, 19)}; image commit=${imgCommit?.slice(0, 7)}; failed conditions=${bad.join(",") || "none"}` };
    } },
  G02: { name: "gateway-tests-pass-in-the-running-image", inputs: [`${RAW}gateway-tests.txt`, `${EV}rendered-compose.json`, "services/access/test/validate.test.mjs", "services/access/test/auth.test.mjs", "services/access/test/archive.test.mjs", "tests/contracts/m3-gateway.test.mjs"],
    expected: "inside the image the stack runs (Node 22.23.3), the gateway's unit tests and its contract suite (a fake core with the pinned route shapes, a throwaway PostgreSQL) run every test they declare, all passing, none skipped or cancelled, including the header-stripping and the three submission-crash tests; no throwaway container or network is left",
    run() {
      const s = S(`${RAW}gateway-tests.txt`);
      const declared = (files) => files.reduce((n, f) => n + (read(f).match(/^test\(/gm) ?? []).length, 0);
      const u = tapCounts(s.unit_tap ?? []), c = tapCounts(s.contract_tap ?? []);
      const du = declared(["services/access/test/validate.test.mjs", "services/access/test/auth.test.mjs", "services/access/test/archive.test.mjs"]), dc = declared(["tests/contracts/m3-gateway.test.mjs"]);
      const okNames = (s.contract_tap ?? []).filter((l) => /^ok \d+ - /.test(l)).map((l) => l.replace(/^ok \d+ - /, ""));
      const need = ["only the gateway's headers reach the core", "never delivered", "answer lost after the core created the job", "never reached the core"];
      const missing = need.filter((n) => !okNames.some((x) => x.includes(n)));
      const img = (kv((s.meta ?? []).join(" ").split(" ")).image ?? "").split("@")[1];
      const node = ((s.contract_tap ?? []).concat(s.transient ?? []).join("\n").match(/node_version=(v[\d.]+)/) ?? [])[1];
      const ok = u.tests === du && u.pass === du && u.fail === 0 && u.skipped === 0 && c.tests === dc && c.pass === dc && c.fail === 0 && c.skipped === 0 && c.cancelled === 0 &&
        (s.unit_tap ?? []).includes("test_exit=0") && (s.contract_tap ?? []).includes("test_exit=0") && missing.length === 0 && img === digestOf(composeImage("access-gateway")) && node === "v22.23.3" &&
        (s.transient ?? []).includes("leftover_transient_containers=0 leftover_transient_networks=0");
      return { ok, actual: `unit ${u.pass}/${u.tests} of ${du} declared (skipped ${u.skipped}); contract ${c.pass}/${c.tests} of ${dc} declared (skipped ${c.skipped}); named tests missing=${missing.join(";") || "none"}; image is the running one=${img === digestOf(composeImage("access-gateway"))}; node=${node}` };
    } },
  R01: { name: "route-shapes-verified-at-the-pin", inputs: [`${RAW}route-shapes.txt`, "deploy/policies/capabilities.json", "patches/series.json"],
    expected: "the checked tree is upstream 7666c1f9 with the patch series (its recorded result tree); the route and schema files hash to the manifest's values; every native route the manifest serves is registered upstream with that method and shape; every route it declares not enabled is registered upstream; every call the pinned official client (the manifest's version) makes on a served path's family (the same path under another method, or a path under a served one) is served or declared not enabled; each verdict is recomputed from the raw registrations and client calls, not read from the collector's labels",
    run() {
      const s = S(`${RAW}route-shapes.txt`), m = json("deploy/policies/capabilities.json"), ser = json("patches/series.json"), meta = kv(s.meta);
      // Every verdict is recomputed here from the raw registrations and client calls against the manifest
      // in the repository; the collector's own labels (FOUND, REGISTERED, served) are not read.
      const regs = (s.registrations ?? []).filter((l) => /^[A-Z]+ \//.test(l));
      const form = (method, path) => `${method} ${path.replace("{id}", ":jobId")}`;
      const native = m.routes.filter((r) => r.upstream);
      const bad = native.filter((r) => !regs.includes(r.upstream) || form(r.method, r.path) !== r.upstream).map((r) => r.id);
      const offAbsent = m.not_enabled.filter((r) => !regs.includes(form(r.method, r.path)) && !regs.includes(form(r.method, r.path).replace(":jobId", ":id"))).map((r) => `${r.method} ${r.path}`);
      const calls = (s.client_calls ?? []).filter((l) => /^[A-Z]+ \//.test(l)).map((l) => l.split(" ").slice(0, 2));
      const servedKey = new Set(native.map((r) => `${r.method} ${r.path}`)), offKey = new Set(m.not_enabled.map((r) => `${r.method} ${r.path}`));
      // A client call on a served path's family (the same path under another method, or a path under a
      // served one) must be served or declared not enabled, so the client meets a named refusal, not a gap.
      const gaps = calls.filter(([method, path]) => native.some((r) => path === r.path || path.startsWith(`${r.path}/`)) && !servedKey.has(`${method} ${path}`) && !offKey.has(`${method} ${path}`)).map((c) => c.join(" "));
      const hashes = (read(`${RAW}route-shapes.txt`).match(/routes_file=\S+ sha256=([0-9a-f]{64})/) ?? [])[1] === m.upstream.routes_file_sha256 && (read(`${RAW}route-shapes.txt`).match(/schemas_file=\S+ sha256=([0-9a-f]{64})/) ?? [])[1] === m.upstream.schemas_file_sha256;
      const servedCalls = calls.filter(([method, path]) => servedKey.has(`${method} ${path}`)).length;
      const ok = meta.head === UPSTREAM_SHA && meta.tree === ser.result_tree && m.upstream.source_tree === ser.result_tree && hashes && regs.length >= 50 && native.length === 10 && bad.length === 0 &&
        offAbsent.length === 0 && meta.client === `${m.upstream.client.package}@${m.upstream.client.version}` && servedCalls >= 10 && gaps.length === 0;
      return { ok, actual: `head=${meta.head?.slice(0, 7)} tree=${meta.tree?.slice(0, 8)}; file hashes match=${hashes}; registrations=${regs.length}; native routes=${native.length}, not registered or reshaped=${bad.join(";") || "none"}; not enabled=${m.not_enabled.length}, not registered upstream=${offAbsent.join(";") || "none"}; client=${meta.client}, served calls=${servedCalls}, client calls on a served family neither served nor declared=${gaps.join(";") || "none"}` };
    } },

  // ================================================================ REST contract and authorization
  A01: { name: "authorized-scrape-crawl-batch-map", inputs: [`${RAW}e2e-sync.txt`, `${RAW}e2e-jobs.txt`, `${RAW}sdk-compat.txt`],
    expected: "through the private path with a scoped token: a scrape returns the fixture's sentinel in Markdown and HTML with its links and status 200; a map returns exactly the 12 graph URLs (5 under limit 5); a crawl of the controlled graph finishes with the 12 unique pages and their sentinels; a crawl limited to 5 returns exactly 5; a batch keeps per-item outcomes (two pages, a 404 page, the authentication gate as an AUTH_REQUIRED error) and reports the invalid URL; the pinned official client does the same operations against the gateway",
    run() {
      const sy = E("sync"), jb = E("jobs");
      const sc = sy.scrape?.[0], mw = one(sy.map, "whole"), m5 = one(sy.map, "limit_5");
      const g = one(jb.crawl_graph, "finished"), gp = one(jb.crawl_graph, "pages_limit_5"), l5 = jb.crawl_limit?.[0], bs = one(jb.batch, "submit"), bf = one(jb.batch, "finished");
      const sk = records(`${RAW}sdk-compat.txt`);
      const cond = {
        sync_ran: endOk(sy), scrape: sc?.status === 200 && sc.success === true && sc.sentinel_in_markdown === true && sc.sentinel_in_html === true && sc.statusCode === 200 && (sc.links ?? []).includes(`${FX}/p05`),
        map_whole: JSON.stringify(mw?.links) === JSON.stringify(sorted(MAP12)), map_limit: (m5?.links ?? []).length === 5,
        jobs_ran: endOk(jb), crawl: g?.state === "SUCCEEDED" && g.archived === 12 && JSON.stringify(sorted((gp?.docs ?? []).map((d) => d.url))) === JSON.stringify(sorted(GRAPH)) && (gp?.docs ?? []).every((d) => /^fcpi-m3-(index|p\d\d)-[0-9a-f]{4}$/.test(d.sentinel ?? "")),
        crawl_limit: l5?.state === "SUCCEEDED" && l5.docs === 5 && l5.archived === 5,
        batch: bs?.status === 200 && JSON.stringify(bs.invalidURLs) === JSON.stringify(["ftp://m3.fixture.fcpi.test/x"]) && bf?.state === "PARTIAL" && (bf.docs ?? []).length === 3 &&
          (bf.docs ?? []).some((d) => d.url === `${FX}/missing` && d.statusCode === 404) && (bf.errors ?? []).length === 1 && bf.errors[0].url === `${FX}/gate` && /AUTH_REQUIRED/.test(bf.errors[0].error),
        sdk: sk.end?.[0]?.exit === 0 && /^fcpi-m3-p02-/.test(sk.scrape?.[0]?.sentinel ?? "") && JSON.stringify(sk.map?.[0]?.links) === JSON.stringify(sorted(MAP12)) && sk.crawl?.[0]?.status === "completed" && sk.crawl[0].docs === 4 &&
          sk.batch?.find((r) => r.case === "status")?.docs === 2 && sk.cancel?.[0]?.final_status === "cancelled",
      };
      const bad = Object.entries(cond).filter(([, v]) => !v).map(([k]) => k);
      return { ok: bad.length === 0, actual: `failed conditions=${bad.join(",") || "none"}; crawl ${g?.state} archived=${g?.archived}; batch ${bf?.state} docs=${(bf?.docs ?? []).length} errors=${(bf?.errors ?? []).length}; map=${(mw?.links ?? []).length}; official client exit=${sk.end?.[0]?.exit}` };
    } },
  A02: { name: "pagination-private-origin-stable", inputs: [`${RAW}e2e-jobs.txt`, `${RAW}e2e-expiry.txt`, `${RAW}e2e-after-recreate.txt`],
    expected: "a finished 12-page crawl read 5 at a time comes back as pages of 5, 5 and 2 whose `next` URLs name the gateway's private origin, the job's external id and increasing skips, never an internal host; the union is the 12 documents once each; the same pages read after the core forgot the job and after every container was recreated give the same documents",
    run() {
      const jb = E("jobs"), ex = E("expiry"), ar = E("after-recreate");
      const p = one(jb.crawl_graph, "pages_limit_5"), id = one(jb.crawl_graph, "submit")?.id;
      const nextsOk = (p?.nexts ?? []).length === 2 && p.nexts.every((n, i) => n === `${ORIGIN}/v2/crawl/${id}?skip=${5 * (i + 1)}&limit=5`);
      const shas = (p?.docs ?? []).map((d) => d.sha256);
      const later = [ex.served_after_expiry?.find((r) => r.kind === "crawl"), ar.served_after_recreate?.find((r) => r.kind === "crawl")];
      const same = later.every((r) => r && JSON.stringify(r.served_sha256) === JSON.stringify(shas));
      const internal = /firecrawl-core|10\.231\.|:3002/.test(read(`${RAW}e2e-jobs.txt`));
      const ok = JSON.stringify(p?.pages) === "[5,5,2]" && nextsOk && new Set(shas).size === 12 && new Set((p?.docs ?? []).map((d) => d.url)).size === 12 && same && !internal && ex.served_after_expiry?.every((r) => r.nexts_private === true);
      return { ok, actual: `pages=${JSON.stringify(p?.pages)}; next URLs on the private origin with the external id=${nextsOk}; unique documents=${new Set(shas).size}; same documents after expiry and recreation=${same}; internal host in the transcript=${internal}` };
    } },
  A03: { name: "credentials-missing-invalid-revoked-scope-owner", inputs: [`${RAW}e2e-auth.txt`],
    expected: "missing, unknown, Basic-scheme and empty tokens get 401 with the gateway's own challenge (Bearer realm=\"fcpi\", never a firecrawl.dev one) while a valid token gets 200; a read-only token gets 403 INSUFFICIENT_SCOPE on scrape, map, crawl, batch and cancel and 200 on status; on five job routes another principal gets exactly the unknown-id answer (same status and body hash), with and without spoofed identity headers, while the owner gets 200 and the other principal's job list (a list) excludes the job that the owner's own list holds (the control); a token revoked on the Pi is refused within 3 s without a gateway restart (its start time the same before the revocation and after the refusal), having worked just before",
    run() {
      const a = E("auth");
      const un = a.unauthenticated ?? [];
      const unOk = ["missing", "invalid", "basic_scheme", "bearer_empty"].every((c) => { const r = one(un, c); return r?.status === 401 && r.code === "UNAUTHORIZED" && r.www_authenticate === 'Bearer realm="fcpi"'; }) && one(un, "valid_control")?.status === 200;
      const sc = a.scope ?? [];
      const scOk = ["read_token_submits_crawl", "read_token_scrapes", "read_token_maps", "read_token_cancels", "read_token_submits_batch"].every((c) => one(sc, c)?.status === 403 && one(sc, c)?.code === "INSUFFICIENT_SCOPE") && one(sc, "read_token_reads_status_control")?.status === 200;
      const ow = (a.owner ?? []).filter((r) => / \//.test(r.case ?? ""));
      const owOk = ow.length === 5 && ow.every((r) => r.beta.status === 404 && r.beta.body_sha256 === r.unknown.body_sha256 && r.beta_spoofed_headers.body_sha256 === r.unknown.body_sha256 && r.beta.status === r.unknown.status) &&
        one(a.owner, "alpha_reads_own_control")?.status === 200 && one(a.owner, "beta_job_list")?.contains_alpha_job === false && one(a.owner, "beta_job_list")?.status === 200 && one(a.owner, "beta_job_list")?.is_list === true &&
        one(a.owner, "alpha_job_list_control")?.status === 200 && one(a.owner, "alpha_job_list_control")?.is_list === true && one(a.owner, "alpha_job_list_control")?.contains_alpha_job === true;
      const rv = a.revoke ?? [];
      const restart = one(rv, "gateway_restarts_during")?.restart_count ?? "";
      const rvOk = one(rv, "before")?.status === 200 && one(rv, "revoked_on_pi")?.result === "revoked m3rev" && one(rv, "after")?.status === 401 && one(rv, "after").ms_until_refused <= 3000 && /^0 /.test(restart) &&
        /^\d{4}-\d\d-\d\dT/.test(one(rv, "before")?.started_at ?? "") && one(rv, "before").started_at === one(rv, "gateway_restarts_during")?.started_at_after;
      const noCloud = !/firecrawl\.dev/.test(read(`${RAW}e2e-auth.txt`).split("\n").filter((l) => l.includes("www_authenticate")).join("\n"));
      const ok = endOk(a) && unOk && scOk && owOk && rvOk && noCloud;
      return { ok, actual: `unauthenticated=${unOk}; scopes=${scOk}; owner isolation over ${ow.length} routes=${owOk}; revocation refused after ${one(rv, "after")?.ms_until_refused} ms (restarts ${restart.split(" ")[0]})=${rvOk}; no Cloud challenge=${noCloud}` };
    } },
  A04: { name: "request-limits-and-overload", inputs: [`${RAW}e2e-sync.txt`, `${RAW}e2e-overload.txt`, `${RAW}e2e-auth.txt`],
    expected: "a body over 1 MiB is 413 BODY_TOO_LARGE, a 26-URL batch, a crawl limit of 201 or depth 4, a map limit of 1001 and a waitFor of 15001 are 400 BAD_REQUEST, headers over 16 KiB are 431, and none of them leaves a receipt; of six held synchronous scrapes four run and two get 503 OVERLOADED, each with a positive Retry-After, and a later one runs; with 430 page units open a 200-page crawl is 503 OVERLOADED, and with 20 open jobs the next is 503 OVERLOADED, both with Retry-After, and every job queued for the test was cancelled without reaching the core; past the failure budget unknown tokens get 429 while a valid token still gets 200",
    run() {
      const sy = E("sync"), ov = E("overload"), au = E("auth");
      const L = sy.limits ?? [], st = (c) => one(L, c)?.status;
      // Each limit is refused with its exact code, and none of them left a receipt.
      const code = (c) => one(L, c)?.code, fxL = sy.limits_effects?.[0];
      const limits = st("body_over_1mib") === 413 && code("body_over_1mib") === "BODY_TOO_LARGE" && ["batch_26_urls", "crawl_limit_201", "crawl_depth_4", "map_limit_1001", "wait_for_15001"].every((c) => st(c) === 400 && code(c) === "BAD_REQUEST") &&
        st("header_over_16kib") === 431 && !!fxL && Number.isInteger(fxL.jobs_before) && fxL.jobs_before === fxL.jobs_after;
      const so = (sy.sync_overload ?? []).find((r) => r.statuses), after = one(sy.sync_overload, "after_release");
      const sync = so && so.statuses.filter((x) => x === 200).length === 4 && so.statuses.filter((x) => x === 503).length === 2 && so.codes.filter((c) => c === "OVERLOADED").length === 2 &&
        so.retry_after.filter((_, i) => so.statuses[i] === 503).length === 2 && so.retry_after.filter((_, i) => so.statuses[i] === 503).every((x) => Number(x) > 0) && after?.status === 200;
      const A = ov.admission ?? [];
      const units = one(A, "units_over_500"), jobs = one(A, "jobs_over_20"), clean = one(A, "cleanup");
      const adm = units?.status === 503 && units.code === "OVERLOADED" && units.open_units === 430 && Number(units.retry_after) > 0 && jobs?.status === 503 && jobs.code === "OVERLOADED" && jobs.open_jobs === 20 &&
        Number(jobs.retry_after) > 0 && JSON.stringify(clean?.states) === '["CANCELLED"]' && clean.queued_ever_submitted === 0;
      const rl = au.rate_limit?.[0];
      const rate = rl && rl.first_429_at > 0 && rl.statuses.slice(0, rl.first_429_at).every((x) => x === 401) && rl.statuses.slice(rl.first_429_at).every((x) => x === 429) && rl.valid_during === 200;
      return { ok: endOk(sy) && endOk(ov) && limits && sync && adm && rate, actual: `limits=${limits}; synchronous ${JSON.stringify(so?.statuses)} then ${after?.status}; units refusal at ${units?.open_units} open, jobs refusal at ${jobs?.open_jobs} open, cleanup ${JSON.stringify(clean?.states)} submitted=${clean?.queued_ever_submitted}; 429 from attempt ${rl?.first_429_at}, valid during=${rl?.valid_during}` };
    } },
  A05: { name: "unsupported-options-refused-before-work", inputs: [`${RAW}e2e-sync.txt`],
    expected: "each refused option (screenshot and json formats, actions, headers, mobile, maxAge, __agentInterop, skipTlsVerification, the stealth proxy, a crawl's webhook, prompt, ignoreRobotsTxt, zeroDataRetention and page actions, a batch's appendToId and webhook, a map's location and useIndex) is 400 UNSUPPORTED_OPTION naming the option, an unknown key is 400 BAD_REQUEST, and across all of them no retrieval attempt, no receipt and no fixture request occurred, while the scrape before them made attempts and reached the fixture",
    run() {
      const sy = E("sync"), R = sy.refused ?? [];
      const expectOption = { scrape_screenshot: "formats.screenshot", scrape_json_format: "formats.json", scrape_actions: "actions", scrape_headers: "headers", scrape_mobile: "mobile", scrape_max_age: "maxAge",
        scrape_agent_interop: "__agentInterop", scrape_skip_tls: "skipTlsVerification", scrape_stealth: "proxy.stealth", crawl_webhook: "webhook", crawl_prompt: "prompt", crawl_ignore_robots: "ignoreRobotsTxt",
        crawl_zdr: "zeroDataRetention", crawl_scrape_actions: "scrapeOptions.actions", batch_append: "appendToId", batch_webhook: "webhook", map_location: "location", map_use_index: "useIndex" };
      const bad = Object.entries(expectOption).filter(([c, o]) => { const r = one(R, c); return !(r?.status === 400 && r.code === "UNSUPPORTED_OPTION" && r.option === o); }).map(([c]) => c);
      const unk = one(R, "scrape_unknown_key");
      const fx = sy.refused_effects?.[0];
      const effects = fx && fx.attempts_before === fx.attempts_after && fx.jobs_before === fx.jobs_after && fx.fixture_hits_for_refused === 0 && fx.positive_control_attempts_from_scrape > 0 && fx.fixture_hits_since_scrape >= 1;
      return { ok: endOk(sy) && bad.length === 0 && unk?.status === 400 && unk.code === "BAD_REQUEST" && effects, actual: `refusals checked=${Object.keys(expectOption).length}, wrong=${bad.join(",") || "none"}; unknown key=${unk?.status} ${unk?.code}; attempts ${fx?.attempts_before}->${fx?.attempts_after}, receipts ${fx?.jobs_before}->${fx?.jobs_after}, fixture hits=${fx?.fixture_hits_for_refused}; control: scrape attempts=${fx?.positive_control_attempts_from_scrape}` };
    } },

  // ================================================================ durable jobs
  J01: { name: "crash-before-upstream-submission-k1", inputs: [`${RAW}e2e-crash.txt`],
    expected: "with the core stopped a crawl is acknowledged (200) and its receipt stays RECEIVED, the dispatch recorded as not delivered; after the gateway is killed and the core returns, the next gateway submits it once and it succeeds, one upstream job carrying its key",
    run() {
      const c = E("crash"), k = c.k1_never_delivered ?? [];
      const s = one(k, "submit_with_core_stopped"), f = one(k, "finished");
      const ok = endOk(c) && s?.status === 200 && s.ledger?.state === "RECEIVED" && s.events.some((e) => e.from === "SUBMITTING" && e.to === "RECEIVED" && /not delivered/.test(e.detail)) &&
        one(k, "gateway_killed")?.result === "fcpi-access-gateway-1" && f?.state === "SUCCEEDED" && f.archived > 0 && f.marker_groups === 1 && f.events.filter((e) => e.to === "QUEUED").length === 1;
      return { ok, actual: `acknowledged=${s?.status} while the receipt was ${s?.ledger?.state}; final ${f?.state} archived=${f?.archived}; upstream jobs with its key=${f?.marker_groups}` };
    } },
  J02: { name: "crash-after-upstream-submission-k2-k3", inputs: [`${RAW}e2e-crash.txt`],
    expected: "K2: the gateway dies with the submission at a paused core (the client gets no acknowledgement); the woken core creates the job; the next gateway marks it SUBMISSION_UNCERTAIN and maps it by its key without resubmitting; the client's retry with the same key gets the same id; it succeeds with one upstream job. K3: the core is killed while paused, so no upstream job exists; the next gateway keeps it SUBMISSION_UNCERTAIN, the native status route answers 503 SUBMISSION_UNCERTAIN with the receipt on the private origin, and only after the settle window is it submitted, once; it succeeds with one upstream job",
    run() {
      const c = E("crash"), k2 = c.k2_answer_lost ?? [], k3 = c.k3_submission_lost ?? [];
      const f2 = one(k2, "finished"), f3 = one(k3, "finished"), d3 = one(k3, "during_settle_window");
      const seq2 = (f2?.events ?? []).map((e) => e.to).slice(0, 4).join(">");
      const seq3 = (f3?.events ?? []).map((e) => e.to).slice(0, 6).join(">");
      const k2ok = one(k2, "gateway_killed")?.client?.acknowledged === false && one(k2, "core_created_it_meanwhile")?.marker_groups === 1 && seq2 === "RECEIVED>SUBMITTING>SUBMISSION_UNCERTAIN>QUEUED" &&
        f2.events.some((e) => /reconciled/.test(e.detail)) && sameId(one(k2, "client_retries_same_key")) && f2?.state === "SUCCEEDED" && f2.marker_groups === 1;
      const k3ok = one(k3, "gateway_killed")?.client?.acknowledged === false && one(k3, "core_killed_while_paused")?.core_state === "exited" && one(k3, "core_back")?.marker_groups === 0 &&
        d3?.ledger_state === "SUBMISSION_UNCERTAIN" && d3.native_status?.status === 503 && d3.native_status.code === "SUBMISSION_UNCERTAIN" && d3.native_status.receipt === `${ORIGIN}/platform/v1/jobs/${one(k3, "in_flight")?.id}` &&
        d3.client_retry?.status === 503 && seq3 === "RECEIVED>SUBMITTING>SUBMISSION_UNCERTAIN>RECEIVED>SUBMITTING>QUEUED" && f3.events.some((e) => /180000 ms after it was sent/.test(e.detail)) && f3?.state === "SUCCEEDED" && f3.marker_groups === 1;
      return { ok: endOk(c) && k2ok && k3ok, actual: `K2 ${seq2} final ${f2?.state} upstream=${f2?.marker_groups} retry same id=${sameId(one(k2, "client_retries_same_key"))}; K3 ${seq3} native=${d3?.native_status?.status} ${d3?.native_status?.code} final ${f3?.state} upstream=${f3?.marker_groups}` };
    } },
  J03: { name: "acknowledged-jobs-tracked-through-crashes-k4-k5", inputs: [`${RAW}e2e-crash.txt`],
    expected: "an acknowledged crawl running when the gateway is killed is tracked by the next gateway to SUCCEEDED with all 6 pages archived; one running when the core is killed reaches an explicit end state (here SUCCEEDED) after NuQ requeued the interrupted page (at least one stalled page, the positive control that work was cut), no page above 4 attempts, and one upstream job",
    run() {
      const c = E("crash"), k4 = one(c.k4_gateway_crash_running, "finished"), k5 = one(c.k5_core_crash_running, "finished");
      const ok = endOk(c) && one(c.k4_gateway_crash_running, "acknowledged_running")?.ledger?.state === "RUNNING" && k4?.state === "SUCCEEDED" && k4.archived === 6 && k4.marker_groups === 1 &&
        one(c.k5_core_crash_running, "core_killed")?.ledger?.state === "RUNNING" && ["SUCCEEDED", "PARTIAL", "FAILED"].includes(k5?.state) && k5.marker_groups === 1 && k5.stalled_pages >= 1 &&
        (k5.attempts_per_page ?? []).length > 0 && k5.attempts_per_page.every((n) => n <= 4);
      return { ok, actual: `K4 ${k4?.state} archived=${k4?.archived}; K5 ${k5?.state} archived=${k5?.archived} stalled pages=${k5?.stalled_pages} attempts per page=${JSON.stringify(k5?.attempts_per_page)}` };
    } },
  J04: { name: "idempotent-requests-and-conflicting-reuse", inputs: [`${RAW}e2e-jobs.txt`, `${RAW}sdk-compat.txt`, `${RAW}e2e-crash.txt`],
    expected: "a repeated crawl with the same idempotency key and body (also with its keys reordered) returns the same id; the same key with another body is 409 IDEMPOTENCY_CONFLICT; another principal's use of the key makes its own job; one upstream job carries the key; a batch retried under its key returns the same id, also through the official client; the crash tests' client retries under their keys return the ids they were given; each \"same id\" is two recorded UUIDs that are equal, and the official client's run ended cleanly",
    run() {
      const jb = E("jobs"), I = jb.idempotency ?? [], cr = E("crash");
      const sk = records(`${RAW}sdk-compat.txt`);
      const skRetry = sk.batch?.find((r) => r.case === "start_twice_same_key");
      const same = { same_body: sameId(one(I, "same_key_same_body")), reordered: sameId(one(I, "same_key_reordered_body")), batch: sameId(one(jb.batch, "same_key_again")),
        official_client: endOk(sk) && sameId(skRetry), crash_retry: sameId(one(cr.k2_answer_lost, "client_retries_same_key")) };
      const ok = Object.values(same).every(Boolean) && one(I, "same_key_other_body")?.status === 409 && one(I, "same_key_other_body")?.code === "IDEMPOTENCY_CONFLICT" &&
        one(I, "other_principal_same_key")?.status === 200 && otherId(one(I, "other_principal_same_key")) && one(I, "upstream_groups_for_key")?.marker_groups === 1 && one(I, "upstream_groups_for_key")?.beta_marker_groups === 0;
      return { ok, actual: `same id where expected=${JSON.stringify(same)}; other body=${one(I, "same_key_other_body")?.status}; other principal got its own job=${otherId(one(I, "other_principal_same_key"))}; upstream jobs for the key=${one(I, "upstream_groups_for_key")?.marker_groups}` };
    } },
  J05: { name: "no-duplicate-logical-submission", inputs: ["auth", "jobs", "cancel", "overload", "crash"].map((p) => `${RAW}e2e-${p}.txt`).concat(`${RAW}sdk-compat.txt`),
    expected: "every job each live run admitted, listed from the ledger at the run's end (the auth owner's crawl, the graph, limit and batch jobs, another principal's job, the cancel and overload jobs, the crash tests' and every official-client job), has at most one upstream job carrying its submission key: exactly one where the ledger maps an upstream id, read while NuQ still held that upstream group's rows, and none where it maps none",
    run() {
      const files = ["auth", "jobs", "cancel", "overload", "crash"].map((p) => E(p)).concat([records(`${RAW}sdk-compat.txt`)]);
      const jobs = [...new Map(files.flatMap((e) => e.ledger ?? []).map((r) => [r.id, r])).values()];
      const above = jobs.filter((j) => !(Number.isInteger(j.marker_groups) && j.marker_groups <= 1));
      const mapped = jobs.filter((j) => j.upstream), unmapped = jobs.filter((j) => !j.upstream);
      const mappedBad = mapped.filter((j) => !(j.marker_groups === 1 && j.upstream_rows > 0));
      const unmappedBad = unmapped.filter((j) => j.marker_groups !== 0);
      const ok = files.every(endOk) && jobs.length >= 30 && mapped.length >= 10 && unmapped.filter((j) => j.cancel_requested).length >= 1 && above.length === 0 && mappedBad.length === 0 && unmappedBad.length === 0;
      return { ok, actual: `jobs listed=${jobs.length} (mapped ${mapped.length}, unmapped ${unmapped.length}); above one upstream job=${above.length}; mapped without exactly one, or read after NuQ let go=${mappedBad.map((j) => j.id.slice(0, 8)).join(",") || "none"}; unmapped with one=${unmappedBad.map((j) => j.id.slice(0, 8)).join(",") || "none"}` };
    } },
  J06: { name: "results-served-after-core-redis-and-nuq-expiry-r9", inputs: [`${RAW}e2e-expiry.txt`],
    expected: "before: the finished crawl's and batch's NuQ job rows and group rows exist, Redis holds their crawl keys and the core answers 200 for them; then pg_cron's own nuq_group_crawl_clean deletes the rows (a successful run that started after the expiry UPDATE committed, both on the database's clock), the Redis keys expire and the core is recreated: 0 NuQ rows, 0 group rows, 0 keys and the core answers 404; yet the gateway serves every document, each hashing to the archive manifest and to the hash recorded when the job finished (evidence/M1/review/REVIEW.md R9)",
    run() {
      const ex = E("expiry"), b = ex.before?.[0], a = ex.after_expiry?.[0], sv = ex.served_after_expiry ?? [];
      const before = b && b.upstream.length === 2 && b.upstream.every((r) => r.nuq_jobs > 0 && r.group_row === 1) && b.redis_keys.every((n) => n > 0) && b.core_status.every((s) => s === "200");
      // pg_cron's own cleaner did it: a successful run that started after the expiry UPDATE committed (both
      // times from the database's clock).
      const expAt = Date.parse(ex.expire?.[0]?.at_db ?? "");
      const cleaned = Number.isFinite(expAt) && (a?.cleaner_runs ?? []).some((l) => { const [st, t] = l.split(" "); return st === "succeeded" && Date.parse(t) > expAt; });
      const after = a && a.upstream.every((r) => r.nuq_jobs === 0 && r.group_row === 0) && a.redis_keys.every((n) => n === 0) && a.core_status.every((s) => s === "404") && cleaned;
      const served = sv.length === 2 && sv.every((r) => r.statuses.every((s) => s === 200) && r.docs > 0 && r.docs === r.manifest_sha256.length && JSON.stringify(r.served_sha256) === JSON.stringify(r.manifest_sha256) && JSON.stringify(r.served_sha256) === JSON.stringify(r.recorded_before_sha256));
      return { ok: endOk(ex) && before && after && served, actual: `before: nuq rows ${JSON.stringify(b?.upstream?.map((r) => r.nuq_jobs))} keys ${JSON.stringify(b?.redis_keys)} core ${JSON.stringify(b?.core_status)}; after: rows ${JSON.stringify(a?.upstream?.map((r) => r.nuq_jobs + r.group_row))} keys ${JSON.stringify(a?.redis_keys)} core ${JSON.stringify(a?.core_status)}; served ${sv.map((r) => `${r.kind}=${r.docs} hashes equal=${JSON.stringify(r.served_sha256) === JSON.stringify(r.manifest_sha256)}`).join(" ")}` };
    } },
  J07: { name: "cancellation-stops-new-work", inputs: [`${RAW}e2e-cancel.txt`, `${RAW}sdk-compat.txt`],
    expected: "a crawl queued behind a running one is cancelled before submission (CANCELLED, no upstream job); the running slow crawl's cancel answers {status: cancelled}, it ends CANCELLED with its completed pages archived, and no slow page started more than 2.5 s after the cancel; cancelling a finished crawl is 409; the official client's cancel returns true and the crawl ends cancelled",
    run() {
      const c = E("cancel"), s = one(c.slow_crawl, "finished"), q = one(c.queued_crawl, "cancel"), cc = one(c.slow_crawl, "cancel");
      const cut = Date.parse(s?.cancel_at ?? "") + 2500;
      // cancel_at and the fixture's times are both the Pi's clock; a missing cancel time fails rather than
      // making every comparison false.
      const late = (s?.fixture_requests ?? []).filter((r) => !(Date.parse(r.started) <= cut));
      const sk = records(`${RAW}sdk-compat.txt`);
      const ok = endOk(c) && one(c.queued_crawl, "submit_while_other_runs")?.ledger_state === "RECEIVED" && q?.status === 200 && q.ledger_state === "CANCELLED" && q.marker_groups === 0 &&
        Number.isFinite(cut) && cc?.status === 200 && cc.body?.status === "cancelled" && s?.state === "CANCELLED" && s.archived === s.completed && s.archived >= 2 && (s.fixture_requests ?? []).length >= 2 && late.length === 0 &&
        one(c.finished_job, "cancel_finished")?.status === 409 && sk.cancel?.[0]?.cancel_returned === true && sk.cancel[0].final_status === "cancelled";
      return { ok, actual: `queued job ${q?.ledger_state} upstream=${q?.marker_groups}; running job ${s?.state} archived=${s?.archived}; slow pages started after cancel+2.5 s=${late.length} of ${(s?.fixture_requests ?? []).length}; finished job cancel=${one(c.finished_job, "cancel_finished")?.status}; official client=${sk.cancel?.[0]?.final_status}` };
    } },

  // ================================================================ network boundary
  N01: { name: "host-and-origin-validated", inputs: [`${RAW}e2e-auth.txt`, `${RAW}e2e-sync.txt`],
    expected: "a foreign Host and a rebinding-style Host are 421 MISDIRECTED; the served loopback origins are 200; a foreign or null browser Origin (and a foreign preflight) is 403 ORIGIN_NOT_ALLOWED; no Origin is 200; no response carries Access-Control-Allow-Origin, including the scrape and map answers forwarded from the core (whose cors() middleware sets it on every answer), each recorded with the header's value",
    run() {
      const H = E("auth").host_origin ?? [], st = (c) => one(H, c)?.status;
      const sy = E("sync"), fwd = [...(sy.scrape ?? []), ...(sy.map ?? [])];
      // Each record must carry the field: an answer recorded without it proves nothing about the header.
      const noAcao = (r) => "acao" in r && r.acao === null;
      const hostOk = st("host_foreign") === 421 && st("host_rebinding_name") === 421 && st("host_localhost_alias") === 200 && st("host_loopback") === 200 && st("origin_foreign") === 403 && st("origin_null") === 403 &&
        st("origin_absent") === 200 && st("preflight_foreign") === 403 && H.length === 8 && H.every(noAcao);
      const fwdOk = fwd.length === 3 && fwd.every((r) => r.status === 200 && noAcao(r));
      return { ok: hostOk && fwdOk, actual: H.map((r) => `${r.case}=${r.status}`).join(" ") + `; ACAO on gateway answers=${H.some((r) => !noAcao(r))}; forwarded answers=${fwd.map((r) => r.status).join(",")}, ACAO on them=${fwd.map((r) => r.acao ?? "absent").join(",")}` };
    } },
  N02: { name: "spoofed-principal-headers-have-no-effect", inputs: [`${RAW}e2e-auth.txt`, `${RAW}gateway-tests.txt`],
    expected: "live: another principal sending x-fcpi-principal, x-fcpi-owner, x-forwarded-user, x-forwarded-for and x-real-ip naming the owner still gets exactly the unknown-id answer on every job route; contract: the core receives only the gateway's own headers (no authorization, cookie, forwarded, idempotency or x-fcpi-* header) and no query string",
    run() {
      const ow = (E("auth").owner ?? []).filter((r) => r.beta_spoofed_headers);
      const live = ow.length === 5 && ow.every((r) => r.beta_spoofed_headers.status === 404 && r.beta_spoofed_headers.body_sha256 === r.unknown.body_sha256);
      const contract = (S(`${RAW}gateway-tests.txt`).contract_tap ?? []).some((l) => /^ok \d+ - a valid token scrapes; upstream's Cloud challenge is stripped; only the gateway's headers reach the core/.test(l));
      return { ok: live && contract, actual: `live routes with spoofed headers answered as unknown=${ow.filter((r) => r.beta_spoofed_headers.body_sha256 === r.unknown.body_sha256).length}/${ow.length}; contract header test passed=${contract}` };
    } },
  N03: { name: "internal-ports-denied-from-every-vantage", inputs: [`${RAW}port-probe.txt`, `${RAW}lan-probe.txt`],
    expected: "every probe names a host and every resolved address is a project address; from the gateway (the permitted vantage) the core's API and PostgreSQL open (the positive controls) and nothing else but the core's own harness ports on fcpi_api: Redis, RabbitMQ, the retrieval service (/internal/acquire too), the browser worker and the fixture are unresolved or dropped, as are the host's listeners through the bridge; a container on the publication bridge reaches only the gateway's port; a container on Docker's default bridge reaches no project service (the host's sshd is its control); on the host only 127.0.0.1:3380 is open; from the LAN every project port is closed while sshd (the control) is open; the guard counted the dropped attempts; no throwaway container is left",
    run() {
      const s = S(`${RAW}port-probe.txt`), recs = ["gateway", "access_peer", "default_bridge", "host"].flatMap((k) => jsonLines(s[k]));
      const by = (role) => Object.fromEntries(recs.filter((r) => r.role === role).map((r) => [r.label, r.outcome]));
      const g = by("gateway"), ap = by("access_peer"), db = by("default_bridge"), h = by("host");
      const gOpen = Object.entries(g).filter(([, o]) => o === "open").map(([l]) => l);
      const gateway = g.core_api === "open" && g.postgres === "open" && gOpen.every((l) => /^(core_api|postgres|core_30\d\d)$/.test(l)) &&
        ["redis_name", "rabbitmq_name", "retrieval_name", "browser_name", "fixture_name", "redis_ip", "rabbitmq_ip", "retrieval_ip", "retrieval_proxy_ip", "browser_ip", "fixture_ip", "core_on_core_net", "postgres_on_core_net",
          "host_sshd", "host_dns", "host_http", "host_mqtt", "host_airdb", "retrieval_internal"].every((l) => g[l] && g[l] !== "open");
      const peer = ap.gateway_port === "open" && Object.entries(ap).filter(([l]) => l !== "gateway_port").every(([, o]) => o !== "open") && Object.keys(ap).length >= 9;
      const bridge = db.host_sshd === "open" && Object.entries(db).filter(([l]) => l !== "host_sshd").every(([, o]) => o !== "open") && Object.keys(db).length >= 10;
      const host = h.gateway_publication === "open" && Object.entries(h).filter(([l]) => l !== "gateway_publication").every(([, o]) => o === "closed") && Object.keys(h).length >= 20;
      const ctr = (sec) => Object.fromEntries((s[sec] ?? []).map((l) => l.split(" packets=")).filter((x) => x.length === 2).map(([k, v]) => [k, +v]));
      const drops = (ctr("guard_after").access_forward_out_dropped ?? 0) > (ctr("guard_before").access_forward_out_dropped ?? Infinity) && (ctr("guard_after").access_input_new_dropped ?? 0) > (ctr("guard_before").access_input_new_dropped ?? Infinity);
      const lan = S(`${RAW}lan-probe.txt`);
      const lanOk = (lan.project_ports ?? []).filter((l) => /^port=/.test(l)).length >= 19 && !(lan.project_ports ?? []).some((l) => / open$/.test(l)) && (lan.control ?? []).includes("port=22 open");
      // Every probe named a host (an empty one probes the prober's own loopback and reads as denied), and
      // every address the collector resolved is a project address.
      const targets = recs.length >= 60 && recs.every((r) => /^[A-Za-z0-9.-]+:\d+$/.test(r.target ?? ""));
      const addr = kv(((s.meta ?? []).find((l) => l.startsWith("addresses ")) ?? "").split(" ").slice(1));
      const addrs = ["core_api", "core_core", "pg_core", "pg_platform", "redis", "rabbitmq", "retrieval", "browser", "fixture_m3", "gateway_access"].every((k) => /^10\.231\.\d+\.\d+$/.test(addr[k] ?? ""));
      const ok = targets && addrs && gateway && peer && bridge && host && drops && lanOk && (s.transient ?? []).includes("leftover_transient_containers=0");
      return { ok, actual: `probes=${recs.length} with named hosts=${targets}, project addresses=${addrs}; gateway opens=${gOpen.join(",")}; access peer=${peer}; default bridge=${bridge}; host=${host} (${Object.keys(h).length} probes); guard counted drops=${drops}; LAN closed ${(lan.project_ports ?? []).filter((l) => / closed$/.test(l)).length} with control=${(lan.control ?? []).includes("port=22 open")}` };
    } },
  N04: { name: "published-ports-loopback-only", inputs: [`${RAW}stack.txt`],
    expected: "the only project publication is the gateway on 127.0.0.1:3380, the one docker-proxy listener on the host; the gateway answers without a token 401",
    run() {
      const s = S(`${RAW}stack.txt`);
      const pub = (s.published ?? []).filter((l) => / -> /.test(l));
      const listeners = (s.published ?? []).filter((l) => /docker-proxy/.test(l));
      const ok = JSON.stringify(pub) === JSON.stringify(["access-gateway 3300/tcp -> 127.0.0.1:3380"]) && listeners.length === 1 && /127\.0\.0\.1:3380/.test(listeners[0]) && kv(s.gateway_unauthenticated).status_without_token === "401";
      return { ok, actual: `publications=${pub.join(";")}; docker-proxy listeners=${listeners.length}; without a token=${kv(s.gateway_unauthenticated).status_without_token}` };
    } },
  N05: { name: "missing-data-mount-fails-closed", inputs: [`${RAW}mount-check.txt`],
    expected: "the data check passes on the real configuration (the control) and fails when the artifact bind source is absent, creating nothing at that path; the gateway image with an artifact root lacking the marker exits non-zero before listening and writes nothing; no throwaway container is left",
    run() {
      const s = S(`${RAW}mount-check.txt`), m = s.missing_artifact_bind ?? [], sh = s.shadow_artifact_root ?? [];
      const shv = kv((sh.find((l) => l.startsWith("exit=")) ?? "").split(" "));
      const ok = (s.control ?? []).some((l) => /^fcpi-data-check: OK /.test(l)) && (s.control ?? []).includes("exit=0") && m.includes("copy_names_missing_source=1") &&
        m.some((l) => /FAIL: bind source <missing-artifact-path> is absent/.test(l)) && m.includes("exit=1") && m.includes("missing_path_created=no") &&
        sh.some((l) => /lacks \.fcpi-artifact-root/.test(l)) && shv.exit !== "0" && shv.exit !== undefined && shv.listening === "0" && shv.files_written === "0" && (s.transient ?? []).includes("leftover_transient_containers=0");
      return { ok, actual: `control passes=${(s.control ?? []).includes("exit=0")}; absent bind refused=${m.includes("exit=1")}, path created=${(m.find((l) => l.startsWith("missing_path_created=")) ?? "").split("=")[1]}; shadow root exit=${shv.exit} listening=${shv.listening} files=${shv.files_written}` };
    } },
  N06: { name: "platform-network-and-ledger-rights", inputs: [`${RAW}stack.txt`, `${RAW}platform-rights.txt`],
    expected: "fcpi_platform is internal and isolated with no host address and holds only the gateway and PostgreSQL; every internal project network is isolated; the gateway joins fcpi_access, fcpi_api and fcpi_platform only; fcpi_gateway is no superuser and owns nothing, holds DML on the four ledger tables and no other right, and may only read fcpi_platform.schema_version, which holds version 1, no CREATE and no usage of the NuQ or retrieval schemas; the marker lookup is SECURITY DEFINER with a pinned search_path, owned by the NOLOGIN fcpi_nuq_reader, which can read only NuQ's two job tables; PUBLIC and fcpi_core cannot execute it; neither fcpi_core nor fcpi_retrieval can use the platform schema; pg_hba's first two rules, loaded without error, admit only fcpi_gateway to the postgres database from 10.231.7.0/24 with its password and reject every other role from that subnet; probed from the platform network with a wrong password, fcpi_gateway reaches password authentication (the control) while fcpi_core, fcpi_retrieval and postgres are refused by pg_hba, and no probe container is left",
    run() {
      const s = S(`${RAW}stack.txt`), r = S(`${RAW}platform-rights.txt`).rights ?? [], rk = kv(r.flatMap((l) => l.split(" ")));
      const nets = Object.fromEntries((s.networks ?? []).filter((l) => /^fcpi_/.test(l)).map((l) => [l.split(" ")[0], kv(l.split(" ").slice(1))]));
      const plat = nets.fcpi_platform;
      const gwNets = sorted(Object.entries(nets).filter(([, v]) => (v.members ?? "").split(",").includes("fcpi-access-gateway-1")).map(([k]) => k));
      const isolated = Object.entries(nets).filter(([, v]) => v.internal === "true").every(([, v]) => v.gateway_mode_ipv4 === "isolated");
      const noAddr = (s.networks ?? []).includes("bridge fcpi-platform addresses=");
      const line = (p) => r.find((l) => l.startsWith(p)) ?? "";
      const gw = line("role=fcpi_gateway "), rd = line("role=fcpi_nuq_reader ");
      const lookup = line("lookup ");
      const cond = { platform_net: plat?.internal === "true" && plat.gateway_mode_ipv4 === "isolated" && plat.members === "fcpi-access-gateway-1,fcpi-nuq-postgres-1" && noAddr, isolated,
        gateway_nets: JSON.stringify(gwNets) === JSON.stringify(["fcpi_access", "fcpi_api", "fcpi_platform"]),
        gateway_role: /super=false/.test(gw) && /createrole=false createdb=false replication=false bypassrls=false/.test(gw) && /owned_objects role=fcpi_gateway n=0 functions=0/.test(r.join("\n")),
        dml: rk.platform_tables === "4" && rk.gateway_dml_on === "4" && rk.gateway_other_rights_on === "0",
        version: rk.schema_version === "1" && rk.gateway_version_select === "true" && rk.gateway_version_write === "false",
        schemas: rk.gateway_schema_create === "false" && rk.gateway_nuq_usage === "false" && rk.gateway_retrieval_usage === "false" && rk.gateway_public_create === "false" && rk.core_platform_usage === "false" && rk.retrieval_platform_usage === "false",
        reader: /login=false super=false/.test(rd) && /owned_objects role=fcpi_nuq_reader n=0 functions=1/.test(r.join("\n")) && line("reader_tables=") === "reader_tables=nuq.queue_scrape,nuq.queue_scrape_backlog",
        lookup: /owner=fcpi_nuq_reader security_definer=true config=search_path=pg_catalog, pg_temp gateway_execute=true core_execute=false public_execute=false/.test(lookup) };
      // pg_hba as loaded: the platform subnet's two rules come first (first match wins), and none errs.
      const P = S(`${RAW}platform-rights.txt`);
      const rules = (P.hba_rules ?? []).filter((l) => l.startsWith("hba_rule ")).map((l) => kv(l.split(" ").slice(1)));
      const plat24 = (x) => x?.type === "host" && x.address === "10.231.7.0" && x.mask === "255.255.255.0";
      cond.hba = rules.length >= 3 && plat24(rules[0]) && rules[0].db === "postgres" && rules[0].user === "fcpi_gateway" && rules[0].method === "scram-sha-256"
        && plat24(rules[1]) && rules[1].db === "all" && rules[1].user === "all" && rules[1].method === "reject" && rules.every((x) => x.error === "");
      // From the platform network: the gateway's role reaches password authentication (the control that
      // the probe reached the server); every other role is refused by pg_hba before it.
      const probe = Object.fromEntries((P.hba_probe ?? []).filter((l) => l.startsWith("probe ")).map((l) => { const k = kv(l.split(" ").slice(1)); return [k.role, k.result]; }));
      cond.hba_probe = probe.fcpi_gateway === "password_failed" && ["fcpi_core", "fcpi_retrieval", "postgres"].every((x) => probe[x] === "rejected_by_hba")
        && (P.hba_probe ?? []).includes("leftover_transient=0");
      const bad = Object.entries(cond).filter(([, v]) => !v).map(([k]) => k);
      return { ok: bad.length === 0, actual: `failed conditions=${bad.join(",") || "none"}; gateway networks=${gwNets.join(",")}; platform members=${plat?.members}; ${line("reader_tables=")}` };
    } },

  // ================================================================ zero Cloud, persistence, host state
  X01: { name: "zero-firecrawl-cloud-attempts", inputs: [`${RAW}egress-probe.txt`, `${RAW}guard-window-open.txt`, `${RAW}core-logs-final.txt`, `${RAW}stack.txt`, `${RAW}persistence.txt`, `${RAW}e2e-expiry.txt`, `${RAW}sdk-compat.txt`],
    expected: "across one window, from a guard-counter snapshot before the first live phase to the egress probe after the last, with the guard's table not reloaded (same handle at both ends) and every live phase inside it, the guard accepted no web connection on the egress bridge; every core instance M3 ran (the one the expiry phase replaced, the one it made, and the one the persistence recreate made) has a saved log, and every saved log classifies each Cloud line as a refusal or a request echo and each name-resolution failure as a project service, with its positive control; the gateway's log, from the container that served every live phase (scanned before the recreate replaced it) and the one that replaced it, each read and whole, names no Cloud host, token, authorization value or target URL; the official client, instrumented at the socket and name-lookup level (so http, https and fetch all show), opened more than ten connections, every one to the forwarded 127.0.0.1:3380, and looked up no name but that address",
    run() {
      const utcOf = (f) => Date.parse(((sections(f).meta ?? []).join(" ").match(/utc=(\S+?Z)/) ?? [])[1]);
      const handle = (f) => ((sections(f).meta ?? []).join(" ").match(/guard_table_handle=(\d+)/) ?? [])[1];
      const web = (f, sec) => +((sections(f)[sec] ?? []).find((l) => l.startsWith("egress_web_accepted")) ?? "=NaN").split("=")[1];
      const open = utcOf(`${RAW}guard-window-open.txt`), close = utcOf(`${RAW}egress-probe.txt`);
      const phases = ["auth", "sync", "jobs", "cancel", "overload", "crash", "expiry", "cli", "after-recreate"].map((p) => `${RAW}e2e-${p}.txt`);
      const times = phases.map((f) => (has(f) ? Date.parse(jsonLines(sections(f).meta)[0]?.utc ?? "") : NaN));
      const sdkT = Date.parse(jsonLines(S(`${RAW}sdk-compat.txt`).meta)[0]?.utc ?? "");
      const inside = [...times, sdkT].every((t) => Number.isFinite(t) && t > open && t < close);
      const sameGuard = !!handle(`${RAW}guard-window-open.txt`) && handle(`${RAW}guard-window-open.txt`) === handle(`${RAW}egress-probe.txt`);
      const delta = web(`${RAW}egress-probe.txt`, "guard_after") - web(`${RAW}guard-window-open.txt`, "counters");
      const recs = Object.entries(sections(`${RAW}core-logs-final.txt`)).filter(([k]) => /^(instance|stored)_/.test(k)).map(([k, lines]) => {
        const c = lines.find((l) => l.startsWith("classified ")); const ctl = +((lines.find((l) => l.startsWith("control=")) ?? "").match(/count=(\d+)/) ?? [])[1];
        return { k, c: c ? kv(c.split(" ").slice(1)) : null, ctl };
      });
      const badLogs = recs.filter((r) => !r.c || r.c.cloud_unexplained !== "0" || r.c.dns_unexplained !== "0" || !(r.ctl >= 1));
      // The gateway's log, from both of its containers: the one that served every live phase (created before
      // the window opened; its kills and starts keep one log), scanned before the recreate replaced it, and
      // the one that replaced it. Each was read (request records), is whole (its first line is still the
      // start's first event), and holds none of the patterns: Cloud hosts, tokens, Authorization, target URLs.
      const PATS = ["firecrawl\\.dev", "firecrawl\\.com", "mendable", "fcpi_[a-z0-9]+_[0-9a-f]{64}", "Bearer [A-Za-z0-9]", "[Aa]uthorization", "m3\\.fixture\\.fcpi\\.test"];
      const scanOf = (lines = []) => {
        const k = kv((lines[0] ?? "").split(" "));
        const pat = (p) => +((lines.find((l) => l.startsWith(`pattern=${p} `)) ?? "").match(/count=(\d+)/) ?? [NaN, NaN])[1];
        return { k, hits: PATS.filter((p) => pat(p) !== 0) };
      };
      const pre = scanOf(S(`${RAW}persistence.txt`).gateway_log_before), post = scanOf(S(`${RAW}stack.txt`).gateway_log_scan);
      const whole = (x) => /^[0-9a-f]{12}$/.test(x.k.instance ?? "") && +x.k.request_records > 0 && x.k.first_event === "clients_loaded" && x.hits.length === 0;
      const gatewayLog = whole(pre) && whole(post) && Date.parse(pre.k.created) < open && pre.k.instance !== post.k.instance;
      const glk = pre.k;
      const sk = jsonLines(S(`${RAW}sdk-compat.txt`).connections)[0];
      // Every socket the official client opened, whatever opened it, and every name it looked up.
      const client = sk && JSON.stringify(sk.hosts) === JSON.stringify(["127.0.0.1:3380"]) && sk.total > 10 && Array.isArray(sk.lookups) && sk.lookups.every((h) => h === "127.0.0.1");
      // Every core instance M3 ran has its saved log among them: the one the expiry phase replaced, the one
      // it made (which the persistence recreate replaced), and the one that made.
      const exr = E("expiry").after_expiry?.[0], ps = S(`${RAW}persistence.txt`);
      const coreIn = (sec) => ((ps[sec] ?? []).find((l) => l.startsWith("firecrawl-core ")) ?? "").split(" ")[1]?.slice(0, 12);
      const m3Cores = new Set([exr?.core_instance_before, exr?.core_instance_after, coreIn("before"), coreIn("after")].filter((x) => /^[0-9a-f]{12}$/.test(x ?? "")));
      const saved = new Set(recs.map((r) => r.k.replace(/^(instance|stored)_/, "")));
      const uncaptured = [...m3Cores].filter((id) => !saved.has(id));
      const ok = inside && sameGuard && delta === 0 && m3Cores.size >= 3 && uncaptured.length === 0 && badLogs.length === 0 && gatewayLog && client;
      return { ok, actual: `phases inside the window=${inside}; guard not reloaded=${sameGuard}; web accepts in the window=${delta}; core instance records=${recs.length}, M3 core instances=${m3Cores.size} of which without a saved log=${uncaptured.join(",") || "none"}, with unexplained lines or no control=${badLogs.map((r) => r.k).join(",") || "none"}; gateway logs: served the phases ${pre.k.instance ?? "unscanned"} (${pre.k.request_records ?? 0} requests, whole=${pre.k.first_event === "clients_loaded"}, patterns found=${pre.hits.join("|") || "none"}), replaced it ${post.k.instance ?? "unscanned"} (${post.k.request_records ?? 0} requests, patterns found=${post.hits.join("|") || "none"}); client sockets=${JSON.stringify(sk?.hosts)} lookups=${JSON.stringify(sk?.lookups)}` };
    } },
  X02: { name: "persistence-across-force-recreate", inputs: [`${RAW}persistence.txt`, `${RAW}e2e-after-recreate.txt`],
    expected: "after `up -d --force-recreate` with no volume removed, all ten services run healthy in new containers; the PostgreSQL, Redis and RabbitMQ sentinels read back; the ledger's rows (receipts, every event, every idempotency key, the document manifest) hash the same; the archive keeps every file, at least one and at least one per distinct document the manifest names, each hashing to its name; the sentinel is a real value; the client registry is unchanged; afterwards the gateway still accepts a token and serves the archived crawl and batch with the same document hashes; the core's log was saved first",
    run() {
      const s = S(`${RAW}persistence.txt`), V = kv((s.meta ?? []).join(" ").split(" ")).sentinel;
      const ids = (sec) => Object.fromEntries((s[sec] ?? []).filter((l) => /^[a-z0-9-]+ [0-9a-f]{64}$/.test(l)).map((l) => l.split(" ")));
      const b = ids("before"), a = ids("after");
      const replaced = Object.keys(b).length === 10 && Object.keys(b).every((k) => a[k] && a[k] !== b[k]);
      const healthy = (s.after ?? []).filter((l) => / running healthy$/.test(l)).length === 10;
      const pick = (sec, p) => (s[sec] ?? []).find((l) => l.startsWith(p)) ?? "";
      const same = (p) => pick("write", p) !== "" && pick("write", p) === pick("read", p);
      const r = kv(s.read);
      const ar = E("after-recreate");
      const served = (ar.served_after_recreate ?? []).length === 2 && ar.served_after_recreate.every((x) => x.docs > 0 && JSON.stringify(x.served_sha256) === JSON.stringify(x.recorded_before_sha256));
      // The sentinel is a real value (two missing ones compare equal), and the archive holds files: at least
      // one per distinct document the manifest names.
      const sentinel = /^fcpi-m3-persist-[0-9a-f]{12}$/.test(V ?? "");
      const lw = kv(pick("write", "ledger ").split(" ").slice(1)), files = +((pick("write", "archive files=").match(/files=(\d+)/) ?? [])[1]);
      const archiveFull = files > 0 && Number.isInteger(+lw.documents_distinct_sha256) && files >= +lw.documents_distinct_sha256 && +lw.events > 0 && +lw.idempotency > 0;
      const ok = sentinel && archiveFull && replaced && healthy && /recreate_exit=0/.test((s.recreate ?? []).join(" ")) && r.postgres_read === V && r.redis_read === V && (r.rabbitmq_read ?? "").includes(V) &&
        same("ledger ") && same("archive files=") && pick("read", "archive files_whose_content_differs_from_name=") === "archive files_whose_content_differs_from_name=0" && same("registry ") &&
        (s.core_logs_before ?? []).some((l) => l.startsWith("classified ")) && one(ar.tokens, "still_valid")?.status === 200 && served && endOk(ar);
      return { ok, actual: `replaced=${replaced}; healthy=${healthy}; sentinels pg=${r.postgres_read === V} redis=${r.redis_read === V} rabbitmq=${(r.rabbitmq_read ?? "").includes(V)}; ledger same=${same("ledger ")}; archive same=${same("archive files=")}; registry same=${same("registry ")}; served after=${served}` };
    } },
  X03: { name: "non-internal-containers-name-their-dns-and-the-core-stays-inside", inputs: [`${RAW}egress-probe.txt`],
    expected: "every container on a non-internal network names its own DNS upstream (the gateway 192.0.2.1, the retrieval service its egress bridge's host address); the core has no default route; the M3 fixture joins only the internal fixture network",
    run() {
      const at = (S(`${RAW}egress-probe.txt`).attachments ?? []);
      const svc = (n) => at.find((l) => l.startsWith(`${n} networks=`)) ?? "";
      const route = (n) => (at.find((l) => l.startsWith(`${n} default_route=`)) ?? "").match(/default_route=(\S+)/)?.[1];
      const ok = /networks=fcpi_access,fcpi_api,fcpi_platform dns=192\.0\.2\.1 /.test(svc("access-gateway")) && /dns=10\.231\.6\.1 /.test(svc("retrieval-service")) && /networks=fcpi_fixture dns= /.test(svc("fixture-m3")) && route("firecrawl-core") === "no";
      return { ok, actual: `gateway: ${svc("access-gateway").replace(/ network_mode=.*$/, "")}; fixture-m3: ${svc("fixture-m3").replace(/ network_mode=.*$/, "")}; core default route=${route("firecrawl-core")}` };
    } },
  X04: { name: "unrelated-state-unchanged", inputs: [`${EV}snapshot-before.txt`, `${EV}snapshot-after.txt`, `${RAW}nft-ruleset.txt`],
    expected: "every line differing between M3's BEFORE and AFTER snapshots is attributed to the project (fcpi containers, their scopes, root filesystems and namespaces, kernel modules for the runtime, the ruleset with Docker's rules for M3's bridge) or to the collector's own SSH session; no unrelated line is removed or changed; the boot ID is unchanged; the ruleset holds only Docker's and the project's tables",
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
      const tables = [...read(`${RAW}nft-ruleset.txt`).matchAll(/^table (\S+ \S+) \{/gm)].map((m) => m[1]).sort();
      const tablesOk = JSON.stringify(tables) === JSON.stringify(["bridge fcpi_audit", "inet fcpi_audit", "inet fcpi_guard", "ip filter", "ip nat", "ip raw", "ip6 filter", "ip6 nat"]);
      const boot = (f) => (read(f).match(/^boot_id_sha256=([0-9a-f]{64})$/m) ?? [])[1];
      writeFileSync(resolve(ROOT, `${EV}snapshot-diff.txt`), ["# M3 BEFORE/AFTER snapshot diff (section-keyed; written by scripts/m3/verify.mjs X04)",
        `# before: ${read(B).split("\n")[1]}  after: ${read(A).split("\n")[1]}`, `# boot_id: ${boot(B) && boot(B) === boot(A) ? "unchanged (no reboot)" : "CHANGED or MISSING"}`,
        `## changes to unrelated state (${rows.unrelated.length})`, ...rows.unrelated, `## project changes and the collector's own SSH sessions (${rows.project.length})`, ...rows.project, ""].join("\n"));
      const ok = unexplained.length === 0 && !!boot(B) && boot(B) === boot(A) && tablesOk;
      return { ok, actual: `added=${added.length} removed=${removed.length}; attributed ${JSON.stringify(why)}; unexplained=${unexplained.length}${unexplained.length ? " [" + unexplained.slice(0, 8).join("; ") + "]" : ""}; boot_id_equal=${boot(B) === boot(A)}; ruleset tables=${tables.join(",")}` };
    } },
  X05: { name: "secret-and-identifier-redaction-scan", inputs: [M0_CONTROL, M1_CONTROL, M3_CONTROL, "scripts/m1/pi-target.conf", "evidence/M0/audit.json"], live: true,
    expected: "the positive controls fire every rule (M3's adds a synthetic tailnet name); then no rule matches in any tracked or new repository file, a tailnet name included; no file holds any live secret (eight of M2's, the gateway's PostgreSQL password and every client token file on the Pi, at least five), compared by SHA-256 computed on the Pi; no file added or changed since M3 began holds the Pi's LAN address, its /24 network or its SSH target",
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
      // Nine fixed secrets and every client token file there is (m1-verify's, M3's four and any added
      // since), so a client added later is scanned for too.
      if (hashes.length < 14 || new Set(hashes).size !== hashes.length || hashes.includes(sha256(""))) return { ok: false, actual: `expected at least 14 distinct non-empty live secret hashes from the Pi (nine fixed and at least five client tokens), got ${hashes.length} (${new Set(hashes).size} distinct)` };
      const files = execFileSync("git", ["-C", ROOT, "ls-files", "--cached", "--others", "--exclude-standard"], { encoding: "utf8" }).split("\n").filter((f) => f && ![M0_CONTROL, M1_CONTROL, M3_CONTROL].includes(f) && has(f) && !/\.(pdf|png|gz)$/.test(f));
      const audit = json("evidence/M0/audit.json");
      const m0 = { egress: audit.network.egress_ip_sha256, serial: audit.identity.board_serial_sha256, machineId: audit.identity.machine_id_sha256, macs: new Set([...Object.values(audit.identity.mac_sha256), sha256("00:00:00:00:00:00")]) };
      const hits = scan(files, { m0, secrets: new Set(hashes) });
      const t = target(), lan = t.PI_LAN_ADDRESS, net = lan.replace(/\.\d+$/, ".0");
      const changed = [...new Set([...git("diff", "--name-only", `${M3_START}..HEAD`).split("\n"), ...git("ls-files", "--others", "--exclude-standard").split("\n")])].filter((f) => f && has(f) && !/\.(pdf|png|gz)$/.test(f));
      const idHits = changed.filter((f) => { const x = read(f); return x.includes(lan) || x.includes(`${net}/`) || x.includes(t.PI_SSH_TARGET); });
      return { ok: hits.length === 0 && idHits.length === 0, configHash: hashOf(files.filter((f) => f !== OUT)), actual: `controls fired all ${RULES.length + HASH_RULES.length} rules; files scanned=${files.length}; live secret hashes compared=${hashes.length} (client tokens ${hashes.length - 9}); findings=${hits.length}${hits.length ? " [" + hits.slice(0, 12).join("; ") + "]" : ""}; M3 files with the LAN address, network or SSH target=${idHits.join(",") || "none"} (of ${changed.length})` };
    } },
  L01: { name: "lock-and-compose-consistent", inputs: ["deploy/versions.lock.json", "deploy/compose.yaml", `${EV}rendered-compose.json`, "services/access/package-lock.json", "deploy/policies/capabilities.json"],
    expected: "every Compose image is pinned by digest for linux/arm64; the lock records the gateway image the stack runs, its node base, its pg release with the lockfile's integrity, the capability manifest's hash and the pinned official client; M2's entries (API, retrieval and browser images) still match the stack",
    run() {
      const R = json(`${EV}rendered-compose.json`), L = json("deploy/versions.lock.json"), pl = json("services/access/package-lock.json");
      const unpinned = Object.entries(R.services).filter(([, v]) => !/@sha256:[0-9a-f]{64}$/.test(v.image) || v.platform !== "linux/arm64").map(([k]) => k);
      const g = L.images?.access_gateway ?? {};
      const cond = { gateway: g.image_id === digestOf(R.services["access-gateway"].image), base: g.base === "node:22.23.3-bookworm-slim@sha256:a0ddbc73510e98f5e824fd64266ffe1c2c343ba9cf260d95ca2985ad632a3f3e",
        pg: g.packages?.pg?.version === pl.packages["node_modules/pg"].version && g.packages.pg.integrity === pl.packages["node_modules/pg"].integrity,
        manifest: L.gateway?.capabilities_sha256 === sha256File("deploy/policies/capabilities.json"), client: L.gateway?.official_client === "@mendable/firecrawl-js@4.31.1",
        api: L.images?.firecrawl_api_patched?.image_id === digestOf(R.services["firecrawl-core"].image), retrieval: L.images?.retrieval?.image_id === digestOf(R.services["retrieval-service"].image),
        browser: L.images?.browser_worker?.image_id === digestOf(R.services["browser-worker"].image) };
      const bad = Object.entries(cond).filter(([, v]) => !v).map(([k]) => k);
      return { ok: unpinned.length === 0 && bad.length === 0 && Object.keys(R.services).length === 10, actual: `services=${Object.keys(R.services).length}; unpinned=${unpinned.join(",") || "none"}; lock disagrees on=${bad.join(",") || "none"}` };
    } },
  C01: { name: "fcpi-status-and-jobs", inputs: [`${RAW}e2e-cli.txt`],
    expected: "`fcpi status` exits 0 naming a live core and a working ledger, `--json` prints the status document, `fcpi jobs` lists the token's jobs and `fcpi jobs <id>` prints a receipt with its transitions, all through the private path with a read-only token on stdin; without a base URL fcpi exits 2 and names the missing setting",
    run() {
      const f = E("cli").fcpi ?? [];
      const byArgs = (a) => f.find((r) => JSON.stringify(r.args) === JSON.stringify(a));
      const st = byArgs(["status"]), sj = byArgs(["status", "--json"]), jl = byArgs(["jobs", "--limit", "5"]), jd = byArgs(["jobs", "<graph job>"]), nb = f.find((r) => r.case === "no_base_url");
      const ok = st?.exit === 0 && st.lines.some((l) => /^core +live/.test(l)) && st.lines.some((l) => /^ledger +ok/.test(l)) && sj?.exit === 0 && sj.lines.includes('  "success": true,') &&
        jl?.exit === 0 && jl.lines.length === 5 && jl.lines.every((l) => /^[0-9a-f-]{36}  /.test(l)) && jd?.exit === 0 && jd.lines.some((l) => /RECEIVED -> SUBMITTING/.test(l)) && nb?.exit === 2 && /FCPI_BASE_URL/.test(nb.stderr ?? "");
      return { ok, actual: `status exit=${st?.exit}; json exit=${sj?.exit}; jobs lines=${jl?.lines?.length}; receipt with transitions=${jd?.lines?.some((l) => /->/.test(l))}; no base URL exit=${nb?.exit}` };
    } },
  M01: { name: "memory-within-caps", inputs: [`${RAW}stack.txt`, `${RAW}persistence.txt`, `${RAW}sdk-compat.txt`].concat(["auth", "sync", "jobs", "cancel", "overload", "crash", "expiry", "cli", "after-recreate"].map((p) => `${RAW}e2e-${p}.txt`)),
    expected: "sampled at the end of every live phase and of the official client's run, and before every kill, stop or recreate that would replace a cgroup and its peak: the gateway's peak stays under its 160 MiB cap and the core's under its 2,304 MiB cap, neither cgroup records an OOM kill, the host's OOM-kill count does not change across the samples and MemAvailable stays at 1 GiB or more; at the end no project cgroup records an OOM kill",
    run() {
      const cg = Object.fromEntries((S(`${RAW}stack.txt`).cgroups ?? []).filter((l) => / memory\.max=/.test(l)).map((l) => [l.split(" ")[0], kv(l.split(" ").slice(1))]));
      const gw = cg["access-gateway"];
      const avail = +((S(`${RAW}stack.txt`).host_memory ?? []).find((l) => l.startsWith("MemAvailable:")) ?? "").replace(/\D+/g, "") / 1024;
      // Every sample, labelled with the run that took it; each run must have sampled.
      const PH = ["auth", "sync", "jobs", "cancel", "overload", "crash", "expiry", "cli", "after-recreate"];
      const samples = [...PH.flatMap((p) => (E(p).resources ?? []).map((r) => ({ run: p, ...r }))),
        ...(records(`${RAW}sdk-compat.txt`).resources ?? []).map((r) => ({ run: "sdk-compat", ...r })),
        ...jsonLines(S(`${RAW}persistence.txt`).resources_before_recreate).map((r) => ({ run: "persistence", ...r }))];
      const unsampled = [...PH, "sdk-compat", "persistence"].filter((p) => !samples.some((s) => s.run === p));
      const within = (c, capMib) => !!c && +c.max === capMib * MIB && Number.isFinite(c.peak) && c.peak < +c.max && c.oom_kill === 0;
      const over = samples.filter((s) => !(within(s.gateway, 160) && (s.core === null || within(s.core, 2304)) && s.mem_available_kib >= 1024 * 1024)).map((s) => `${s.run}/${s.label}`);
      const hostOoms = new Set(samples.map((s) => s.vmstat_oom_kill));
      const peakOf = (k) => Math.max(...samples.map((s) => s[k]?.peak ?? 0)) / MIB;
      const ok = unsampled.length === 0 && samples.length >= 18 && over.length === 0 && hostOoms.size === 1 && Number.isInteger([...hostOoms][0]) &&
        Object.keys(cg).length === 10 && gw && +gw["memory.max"] === 160 * MIB && +gw["memory.peak"] < +gw["memory.max"] && Object.values(cg).every((v) => v.oom_kill === "0") && avail >= 1024;
      return { ok, actual: `samples=${samples.length}, runs without one=${unsampled.join(",") || "none"}, over a cap or low on memory=${over.join(",") || "none"}; highest peaks: gateway ${peakOf("gateway").toFixed(1)} MiB, core ${peakOf("core").toFixed(0)} MiB; host OOM-kill counts seen=${[...hostOoms].join(",")}; at the end: gateway peak=${(+gw?.["memory.peak"] / MIB).toFixed(1)} MiB, cgroup OOM kills=${Object.entries(cg).filter(([, v]) => v.oom_kill !== "0").map(([k]) => k).join(",") || "none"}, MemAvailable=${avail.toFixed(0)} MiB` };
    } },
  P01: { name: "private-access-from-the-target-machine", inputs: [`${RAW}e2e-auth.txt`, `${RAW}sdk-compat.txt`],
    expected: "the live tests and the official client ran on the workstation (macOS), the machine the owner's agents run on, through an SSH forward of the gateway's loopback publication that stayed up for the whole phase, with nothing published beyond loopback; the gateway instance answering through the forward is the one the Pi's gateway container logged at its start",
    run() {
      // Facts, not the driver's description: the platform it ran on (the workstation is macOS; the Pi is
      // Linux), a forward that stayed up for the whole phase, and the same gateway instance on both sides.
      const au = E("auth"), m = au.meta?.[0], fw = au.forward?.[0], v = au.vantage?.[0];
      const sk = records(`${RAW}sdk-compat.txt`);
      const ok = endOk(au) && m?.platform === "darwin" && Number.isInteger(fw?.pid) && fw.exited_before_end === false &&
        UUID_RE.test(v?.gateway_instance_via_forward ?? "") && v.gateway_instance_via_forward === v.gateway_instance_on_pi && sk.client?.[0]?.apiUrl === "http://127.0.0.1:3380" && endOk(sk);
      return { ok, actual: `platform=${m?.platform}; forward pid=${fw?.pid} ended early=${fw?.exited_before_end}; the instance answering through the forward is the Pi's gateway=${!!v && v.gateway_instance_via_forward === v.gateway_instance_on_pi}; official client base URL=${sk.client?.[0]?.apiUrl}` };
    } },
  P02: { name: "tailnet-tls-private-serving", inputs: [`${RAW}tailscale-before.txt`, `${RAW}tailscale-install.txt`, `${RAW}lan-probe.txt`],
    expected: "Tailscale is installed from its repository with the signing key's published fingerprint, and the installed keyring holds that one primary key and no other; it runs without taking the host's DNS (resolv.conf unchanged), routes, an exit node or Tailscale SSH; Serve maps tailnet :8443 to the gateway's loopback publication with no Funnel; from the workstation over the tailnet the certificate verifies for the machine's name, a read-only token gets 200 and no token 401, the gateway returns URLs on the tailnet origin and refuses a foreign Host; from the LAN :8443 is closed; the loaded guard holds the repository guard file's three tailnet rules, and over the tailnet no port the host listens on answers except :8443 (the control)",
    run() {
      const status = `${RAW}tailscale-status.txt`, check = `${RAW}tailnet-check.txt`;
      // A credential block is a recorded state (the Pi's Tailscale awaiting its login or approval), never
      // the mere absence of evidence, which is NOT_RUN.
      if (!has(status)) return { notRun: true, actual: "evidence missing: tailscale-status.txt (the Pi's Tailscale state was not collected)" };
      const backend = (read(status).match(/\bbackend=(\S+)/) ?? [])[1];
      if (/^(NeedsLogin|NeedsMachineAuth)$/.test(backend ?? "")) return { blocked: true, actual: `the Pi's Tailscale is ${backend}: awaiting the owner's approval of its login` };
      if (!has(check)) return { notRun: true, actual: `evidence missing: tailnet-check.txt (the Pi's Tailscale is ${backend ?? "unknown"}; the workstation check was not run)` };
      const ins = read(`${RAW}tailscale-install.txt`), s = S(status), ts = kv((s.tailscale ?? []).flatMap((l) => l.split(" ")));
      const serve = jsonLines(s.serve)[0] ?? {};
      const web = serve.web ?? [];
      const resolvBefore = (read(`${RAW}tailscale-before.txt`).match(/resolv_conf_sha256=([0-9a-f]{64})/) ?? [])[1];
      const resolvAfter = (read(status).match(/resolv_conf_sha256=([0-9a-f]{64})/) ?? [])[1];
      const c = records(check).tls ?? [];
      const w = one(c, "status_with_read_token"), n = one(c, "status_without_token"), j = one(c, "job_list_urls"), h = one(c, "foreign_host_header");
      const lan = S(`${RAW}lan-probe.txt`).project_ports ?? [];
      const kr = kv((s.keyring ?? []).flatMap((l) => l.split(" ")));
      const cond = { key: /key_fingerprint=2596A99EAAB33821893C0A79458CA832957F5868/.test(ins) && /installed=\S+ tailscaled=active/.test(ins),
        keyring: kr.primary_keys === "1" && kr.primary_fpr === "2596A99EAAB33821893C0A79458CA832957F5868",
        running: ts.backend === "Running" && ts.tailscaled === "active", no_dns_routes_ssh: ts.corp_dns === "false" && ts.route_all === "false" && ts.run_ssh === "false" && ts.advertise_routes === "0" && ts.exit_node === "false",
        resolv_unchanged: !!resolvBefore && resolvBefore === resolvAfter,
        serve: web.length === 1 && /:8443$/.test(web[0].host_port) && web[0].handlers?.["/"] === "http://127.0.0.1:3380" && serve.funnel === 0,
        tls: w?.status === 200 && w.tls_authorized === true && w.cert_subject_matches === true && w.core_live === true, no_token: n?.status === 401 && n.code === "UNAUTHORIZED",
        urls: j?.status === 200 && j.results_url_on_tailnet_origin === true, host: h?.status === 421, lan: lan.includes("port=8443 closed") };
      // The tailnet boundary: the loaded guard holds the repository's three tailnet rules, and over the
      // tailnet only :8443 answers (the control) of every port the host listens on.
      const g = kv((s.guard ?? []).flatMap((l) => l.split(" ")));
      const tp = (records(check).tailnet_ports ?? []).filter((r) => r.case === "tailnet_port");
      cond.tailnet_guard = g.tailnet_rules === "3" && g.guard_file_sha256 === sha256File("deploy/host/fcpi-guard.nft");
      cond.tailnet_ports = tp.length >= 4 && tp.find((r) => r.port === 8443)?.result === "open" && tp.filter((r) => r.port !== 8443).every((r) => r.result !== "open");
      const bad = Object.entries(cond).filter(([, v]) => !v).map(([k]) => k);
      return { ok: bad.length === 0, actual: `failed conditions=${bad.join(",") || "none"}; backend=${ts.backend}; serve=${JSON.stringify(web)}; TLS ${w?.tls_protocol} authorized=${w?.tls_authorized} issuer=${w?.cert_issuer_org}; with token=${w?.status} without=${n?.status} foreign host=${h?.status}; tailnet ports=${tp.map((r) => `${r.port}:${r.result}`).join(",")}` };
    } },
  V01: { name: "review-record-complete", inputs: [`${EV}review/REVIEW.md`],
    expected: "the saved /review-2 report (CLAUDE.md §5) gives every finding it lists a row with an outcome (fixed with its commit, rejected with evidence, deferred to M4 or later), and gives every finding an earlier review deferred to M3 (CLAUDE.md §30) a row of its own with such an outcome, cites only commits that exist, and holds no absolute local path",
    run() {
      const text = read(`${EV}review/REVIEW.md`);
      const rows = text.split("\n").filter((l) => /^\| [A-Z]{1,2}\d+ \|/.test(l)).map((l) => l.split(" | "));
      // A deferral names a later milestone (M4-M9); M3's own findings cannot be deferred to M3 or earlier.
      const bad = rows.filter((c) => !/^(Fixed|Rejected, with the evidence|Deferred to M[4-9]\b|Partly fixed, partly rejected)/.test(c[3] ?? "")).map((c) => c[0].slice(2));
      // Findings earlier reviews deferred to M3 (CLAUDE.md §30): each has a row "| M<n> <id> | finding |
      // outcome | commits |" here, with a recognised outcome, a fix citing its commits.
      const carried = ["M0", "M1", "M2"].flatMap((m) => { const dir = `evidence/${m}/review`;
        return has(dir) ? readdirSync(resolve(ROOT, dir)).filter((f) => f.endsWith(".md")).flatMap((f) => read(`${dir}/${f}`).split("\n").filter((l) => /^\| [A-Z]{1,2}\d+ \|/.test(l) && /\| Deferred to M3\b/.test(l)).map((l) => `${m} ${l.split(" | ")[0].slice(2)}`)) : []; });
      const carriedRows = text.split("\n").filter((l) => /^\| M\d [A-Z]{1,2}\d+ \|/.test(l)).map((l) => l.split(" | "));
      const carriedBad = carried.filter((id) => { const r = carriedRows.find((c) => c[0] === `| ${id}`); return !r || !/^(Fixed|Rejected, with the evidence|Deferred to M[4-9]\b)/.test(r[2] ?? "") || (/^Fixed/.test(r[2]) && !/`[0-9a-f]{7,40}`/.test(r[3] ?? "")); });
      const listedIds = [...text.matchAll(/^\s*\d+\. \*\*([CWS]\d+) —/gm)].map((m) => m[1]);
      const uncovered = listedIds.filter((id) => !rows.some((c) => c[0] === `| ${id}`));
      const uncited = rows.filter((c) => /^Fixed/.test(c[3] ?? "") && !/`[0-9a-f]{7,40}`/.test(c[4] ?? "")).map((c) => c[0].slice(2));
      const commits = [...new Set(rows.flatMap((c) => [...(c[4] ?? "").matchAll(/`([0-9a-f]{7,40})`/g)].map((m) => m[1])))];
      const missing = commits.filter((c) => { try { git("cat-file", "-e", `${c}^{commit}`); return false; } catch { return true; } });
      const local = /\/(private\/tmp|Users\/[^\/\s]+|home\/[^\/\s]+)\//.test(text);
      const ok = rows.length > 0 && listedIds.length === rows.length && uncovered.length === 0 && uncited.length === 0 && bad.length === 0 && missing.length === 0 && !local && carried.length > 0 && carriedBad.length === 0;
      return { ok, actual: `carried over from earlier reviews=${carried.join(",")}, without a recognised outcome=${carriedBad.join(",") || "none"}; findings listed=${listedIds.length}, rows=${rows.length}, without a row=${uncovered.join(",") || "none"}; fixed without a commit=${uncited.join(",") || "none"}; without a recognised outcome=${bad.join(",") || "none"}; commits cited=${commits.length}, missing=${missing.join(",") || "none"}; absolute local path=${local}` };
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
  const rec = { test_id: `M3-${id}`, name: c.name, utc: now(), ...repo, upstream_sha: UPSTREAM_SHA, patch_series_sha256: series.series_sha256, config_or_fixture_hash: null, expected: c.expected };
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
  rec.image_digests_platform = has(`${EV}rendered-compose.json`) ? { platform: "linux/arm64", gateway: digestOf(composeImage("access-gateway")), api: digestOf(composeImage("firecrawl-core")), retrieval: digestOf(composeImage("retrieval-service")), browser: digestOf(composeImage("browser-worker")) } : null;
  // An error text can carry the SSH command: its key path, the target, the LAN address and $HOME never enter the record.
  rec.actual = hideIds(String(rec.actual), target());
  rec.evidence_path = OUT;
  results[rec.test_id] = rec;
  console.log(`${rec.test_id} ${rec.state.padEnd(18)} ${c.name}${rec.state !== "PASS" ? `  — ${rec.actual.slice(0, 240)}` : ""}`);
}
const ordered = listed.map((id) => results[`M3-${id}`] ?? { test_id: `M3-${id}`, name: checks[id].name, state: "NOT_RUN", actual: "never run", evidence_path: OUT });
writeFileSync(resolve(ROOT, OUT), JSON.stringify({ schema: "fcpi.m3.verification/v1", runner: "scripts/m3/verify.mjs",
  repository_sha_note: "Each result records the commit checked out when it ran, with code_dirty; the commit that stores this file is a later one on main.",
  results: ordered }, null, 2) + "\n");
process.exitCode = ordered.every((r) => r.state === "PASS" || r.state === "BLOCKED_CREDENTIAL") ? 0 : 1;
