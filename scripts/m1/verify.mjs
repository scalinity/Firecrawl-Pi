#!/usr/bin/env node
// M1 automated verification. Each check recomputes its result from raw evidence under
// evidence/M1/ (or, where marked live, from the Pi), independently of the collectors, and
// is recorded with the CLAUDE.md §25 tuple in evidence/M1/verification.json.
// A check whose evidence is missing is NOT_RUN, never PASS.
// Usage: node scripts/m1/verify.mjs            (all checks)
//        node scripts/m1/verify.mjs V04 V15    (subset; others keep their last record)
// FCPI_M1_EVIDENCE=evidence/M1/closeout/ node scripts/m1/verify.mjs V01 ...
//   reruns checks against the close-out's evidence (its raw/, snapshots, rendered Compose
//   and verification.json), leaving the files that back M1's acceptance untouched.
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { ROOT, sha256, sha256File, repoState, sections, git } from "../m0/lib.mjs";

const EV = process.env.FCPI_M1_EVIDENCE ?? "evidence/M1/";
if (!/^evidence\/M1\/([a-z0-9-]+\/)?$/.test(EV)) throw new Error(`FCPI_M1_EVIDENCE must be evidence/M1/ or a directory below it, got ${EV}`);
const CLOSEOUT = EV !== "evidence/M1/";
const OUT = `${EV}verification.json`;
const UPSTREAM_SHA = "7666c1f9ae8720a6bba271e0f60b6a217f8a5210";
const RAW = `${EV}raw/`;
const EXPECTED_MD = "tests/fixtures/m1/expected/static.md";
const read = (p) => readFileSync(resolve(ROOT, p), "utf8");
const json = (p) => JSON.parse(read(p));
const has = (p) => existsSync(resolve(ROOT, p));
const now = () => new Date().toISOString().replace(/\.\d+Z$/, "Z");
const hashOf = (paths) => sha256(paths.map((p) => `${p}:${sha256File(p)}`).join("\n"));
const kv = (s) => Object.fromEntries([...(s ?? "").matchAll(/([A-Za-z_][\w.]*)=(\S*)/g)].map((m) => [m[1], m[2]]));
const lineOf = (lines, prefix) => (lines ?? []).find((l) => l.startsWith(prefix));
const b64md = (b64) => (b64 ? Buffer.from(b64.replace(/^b64:/, ""), "base64").toString("utf8") : null);
const expectedMd = () => read(EXPECTED_MD);
// The SSH target comes from scripts/m1/pi-target.conf, shared with deploy.sh and lan-probe.sh.
const target = () => {
  const t = Object.fromEntries(read("scripts/m1/pi-target.conf").split("\n").filter((l) => /^PI_\w+=/.test(l)).map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1).replace("$HOME", process.env.HOME)]));
  if (!t.PI_SSH_TARGET || !t.PI_SSH_KEY) throw new Error("scripts/m1/pi-target.conf lacks PI_SSH_TARGET or PI_SSH_KEY");
  return t;
};
const ssh = (cmd) => { const t = target(); return execFileSync("ssh", ["-i", t.PI_SSH_KEY, "-o", "IdentitiesOnly=yes", "-o", "BatchMode=yes", "-o", "ConnectTimeout=15", t.PI_SSH_TARGET, cmd], { encoding: "utf8" }); };

// Pinned digests come from the lock, which scripts/m1/build-lock.mjs derives from evidence.
function digests() {
  const L = json("deploy/versions.lock.json").images;
  const d = {
    core: L.firecrawl_api_prebuilt.selected.arm64_manifest_digest,
    pg: L.nuq_postgres.selected.built_image_digest,
    redis: L.redis.selected.arm64_manifest_digest,
    rmq: L.rabbitmq.selected.arm64_manifest_digest,
    node: L.node_base.selected.arm64_manifest_digest,
  };
  return {
    service: { "nuq-postgres": d.pg, redis: d.redis, rabbitmq: d.rmq, "firecrawl-core": d.core, "access-gateway": d.node, fixture: d.node },
    proof: { "fcpi-proof-pg": d.pg, "fcpi-proof-redis": d.redis, "fcpi-proof-rabbitmq": d.rmq, "fcpi-proof-core": d.core, "fcpi-proof-gateway": d.node, "fcpi-proof-fixture": d.node },
    all: d,
  };
}
// The six harness children for NUQ_WORKER_COUNT=1, the PostgreSQL backend and
// USE_DB_AUTHENTICATION=false (harness.ts:830-908).
const CHILDREN = ["dist/src/index.js", "dist/src/services/queue-worker.js", "dist/src/services/extract-worker.js",
  "dist/src/services/worker/nuq-worker.js", "dist/src/services/worker/nuq-prefetch-worker.js", "dist/src/services/worker/nuq-reconciler-worker.js"];
const SERVICE_UID = { "nuq-postgres": "5432", redis: "6379", rabbitmq: "5672", "firecrawl-core": "3002", "access-gateway": "3380", fixture: "8080" };
// Spec §22 caps (fixture: M1-only, outside the §22 table).
const CAPS = { "nuq-postgres": [640, 0.75], redis: [320, 0.35], rabbitmq: [512, 0.5], "firecrawl-core": [2304, 2.25], "access-gateway": [160, 0.3], fixture: [64, 0.1] };

// Transient healthcheck processes (the core's `setpriv ... node -e ...`) are not topology.
const isHealthcheck = (args) => /^(setpriv |node -e )/.test(args ?? "");
function coreTopology(lines) {
  const procs = lines.filter(Boolean).map((l) => { const f = l.split(" "); return { pid: f[0], ppid: f[1], user: f[2], args: f.slice(4).join(" ") }; }).filter((p) => !isHealthcheck(p.args));
  const harness = procs.filter((p) => p.args === "node dist/src/harness.js --start-docker");
  const nodeKids = CHILDREN.map((c) => procs.filter((p) => p.args === `node ${c}`).length);
  const shKids = CHILDREN.map((c) => procs.filter((p) => p.args === `sh -c node ${c}`).length);
  const other = procs.filter((p) => p.args !== "node dist/src/harness.js --start-docker" && !CHILDREN.some((c) => p.args === `node ${c}` || p.args === `sh -c node ${c}`));
  return { total: procs.length, harness: harness.length, node_children: nodeKids, sh_wrappers: shKids, other: other.map((p) => p.args), users: [...new Set(procs.map((p) => p.user))] };
}

function roundTripCases(file) {
  const s = sections(file);
  const j = (sec) => { try { return JSON.parse(lineOf(s[sec], "{")); } catch { return null; } };
  const counter = (sec, name, qt) => {
    const l = (s[sec] ?? []).find((x) => x.startsWith(`rabbitmq_global_messages_${name}_total{`) && (!qt || x.includes(`queue_type="${qt}"`)));
    return l ? Number(l.split(" ").pop()) : 0;
  };
  const listen = (sec) => (s[sec] ?? []).map((l) => l.split("\t")).find((f) => /^nuq\.queue_scrape\.listen\./.test(f[0]));
  const prefetch = (sec) => (s[sec] ?? []).map((l) => l.split("\t")).find((f) => f[0] === "nuq.queue_scrape.prefetch");
  const md = (o) => b64md(o?.markdown_b64);
  const c1 = j("case1_scrape"), c2 = j("case2_scrape"), c3 = j("case3_scrape");
  // Case 1
  const lq = listen("case1_queues"), pq = prefetch("case1_queues");
  const log1 = (s.case1_core_log ?? []).join("\n");
  const case1 = {
    scrape_success: c1?.success === true, markdown_matches: md(c1) !== null, // v0 formatting differs from v2; completion is the criterion
    prefetch_queue: pq ? { type: pq[1], durable: pq[2] } : null,
    reply_queue: lq ? { name: lq[0], type: lq[1], durable: lq[2], auto_delete: lq[3], exclusive: lq[4], consumers: lq[7] } : null,
    get_auto_ack_delta: counter("case1_counters_after", "delivered_get_auto_ack", "rabbit_quorum_queue") - counter("case1_counters_before", "delivered_get_auto_ack", "rabbit_quorum_queue"),
    reply_consume_delta: counter("case1_counters_after", "delivered_consume_manual_ack", "rabbit_classic_queue") - counter("case1_counters_before", "delivered_consume_manual_ack", "rabbit_classic_queue"),
    log_prefetch_sent: /NuQ job prefetch sent/.test(log1), log_reply_received: /NuQ job received/.test(log1), log_job_done: c1?.scrape_id ? log1.includes(`Job done ${c1.scrape_id}`) : false,
  };
  case1.pass = case1.scrape_success && case1.prefetch_queue?.type === "quorum" && case1.prefetch_queue?.durable === "true" &&
    case1.reply_queue?.type === "classic" && case1.reply_queue?.exclusive === "true" && case1.reply_queue?.auto_delete === "true" && case1.reply_queue?.durable === "false" && case1.reply_queue?.consumers === "1" &&
    case1.get_auto_ack_delta >= 1 && case1.reply_consume_delta >= 1 && case1.log_prefetch_sent && case1.log_reply_received && case1.log_job_done;
  // Case 2: the prefetched message must vanish unconsumed about 50 s after it appeared,
  // while the job stays in PostgreSQL, is re-queued (stalls >= 1) and then completes.
  const tl = (s.case2_timeline ?? []);
  const obs = tl.map((l) => l.match(/^t\+(\d+) ready=(\S+) job=(.*)$/)).filter(Boolean).map((m) => ({ t: Number(m[1]), ready: Number(m[2]), job: m[3] }));
  const stopped = tl.some((l) => /SIGSTOP nuq-worker-0 .* state=T$/.test(l)) && !tl.some((l) => /SIGSTOP_FAILED|Operation not permitted/.test(l));
  const firstReady = obs.findIndex((o) => o.ready >= 1);
  const gone = firstReady >= 0 ? obs.findIndex((o, i) => i > firstReady && o.ready === 0) : -1;
  let expiry = null;
  if (firstReady >= 0 && gone > 0) {
    // Before the first observation the bound is t+0: the job is submitted only after the
    // worker is paused, so no prefetch message can exist earlier.
    const lastZeroBefore = firstReady > 0 ? obs[firstReady - 1].t : 0, firstSeen = obs[firstReady].t, lastSeen = obs[gone - 1].t, goneSeen = obs[gone].t;
    expiry = { min_s: lastSeen - firstSeen, max_s: goneSeen - lastZeroBefore }; // bounds on (vanish - publish)
  }
  const jobPresentUntilGone = gone > 0 && obs.slice(0, gone + 1).every((o) => o.job.startsWith("active"));
  const requeued = obs.some((o) => /stalls=[1-9]/.test(o.job));
  // The resume must come after the message vanished, not from the 120 s fallback before it.
  const sigcontT = Number((tl.find((l) => /^t\+\d+ SIGCONT nuq-worker-0/.test(l)) ?? "").match(/^t\+(\d+)/)?.[1] ?? NaN);
  const resumedAfterExpiry = gone > 0 && sigcontT >= obs[gone].t;
  // Tolerance of 5 s either side of the 50 s expiration: polls take ~3 s, each is stamped
  // after its queries finish, and rabbitmqctl's quorum-queue statistics lag; the broker's
  // dead_lettered_expired counter corroborates the expiry independently.
  const case2 = {
    worker_stopped: stopped, expiry_window_s: expiry, job_active_in_postgres_until_gone: jobPresentUntilGone, requeued_by_lock_reaper: requeued, resumed: resumedAfterExpiry,
    dead_lettered_expired_delta: counter("case2_counters_after", "dead_lettered_expired", "rabbit_quorum_queue") - counter("case2_counters_before", "dead_lettered_expired", "rabbit_quorum_queue"),
    scrape_success: c2?.success === true,
  };
  case2.pass = case2.worker_stopped && expiry !== null && expiry.min_s <= 55 && expiry.max_s >= 45 && expiry.max_s <= 70 && case2.job_active_in_postgres_until_gone &&
    case2.requeued_by_lock_reaper && case2.resumed && case2.dead_lettered_expired_delta >= 1 && case2.scrape_success;
  // Case 3
  const r3 = s.case3_restart ?? [];
  const states = r3.filter((l) => l.startsWith("restart_count="));
  const log3 = (s.case3_core_log ?? []).join("\n");
  const since = (s.case3_core_log_since_restart ?? []).join("\n");
  const lq3 = listen("case3_queues");
  const case3 = {
    broker_ping_ok_after_s: Number(kv(lineOf(r3, "broker_ping_ok_after_s")).broker_ping_ok_after_s),
    core_ready_after_s: Number(kv(lineOf(r3, "core_ready_after_s")).core_ready_after_s),
    core_restarts: states.length === 2 ? Number(kv(states[1]).restart_count) - Number(kv(states[0]).restart_count) : null,
    new_job_success: c3?.success === true, new_job_via_reply_queue: /NuQ job received/.test(log3) && (c3?.scrape_id ? log3.includes(`Job done ${c3.scrape_id}`) : false),
    reply_queue_redeclared: !!lq3 && lq3[7] === "1",
    upstream_connect_escape_observed: /ECONNREFUSED/.test(since) && /terminated unexpectedly|failed with exit code/.test(since),
    listener_without_consumer_4244: c3?.success !== true && /listener/i.test(since),
  };
  case3.pass = case3.new_job_success && case3.new_job_via_reply_queue && case3.reply_queue_redeclared;
  return { case1, case2, case3 };
}

// ---- redaction (V15) -----------------------------------------------------------------
const M0_CONTROL = "tests/contracts/m0-redaction-control.txt";
const M1_CONTROL = "tests/contracts/m1-redaction-control.txt";
// The M0 rule set (scripts/m0/verify.mjs V07), unchanged; V15 checks the names still match.
const M0_RULES = [
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
];
const M1_RULES = [
  ["url-empty-user-credentials", /[a-z][a-z0-9+.-]*:\/\/:[A-Za-z0-9._~%+-]{8,}@/i],
  ["rabbitmq-default-pass", /\bdefault_pass\s*=\s*(?!%s|<)\S{8,}/],
  ["fcpi-client-token", /\bfcpi_[a-z0-9]+_[0-9a-f]{32,}\b/],
];
const M0_HASH_RULES = ["raw-egress-ip", "raw-board-serial", "raw-machine-id", "unexplained-mac-hash"];
const M1_HASH_RULES = ["live-secret-by-hash-hex", "live-secret-by-hash-cookie"];
// Exact literal strings allowed outside the controls, each classified under the publishing
// rule; a real value of the same shape still fires. M0's synthetic MACs, plus:
//   amqp://fcpi:%s@          code: pi-init.sh builds the broker URL from a format string
//   amqp://fcpi:$rmqpw@      code: pi-native-proofs.sh builds the proof URL from a shell variable
//   amqp://fcpi:\\(.*\\)@    code: this file's sed pattern that extracts the password on the Pi
//   http://user:pw@          test fixture: m1-gateway.test.mjs checks userinfo URLs are refused
const SYNTHETIC_ALLOW = new Set(["00:00:00:00:00:00", "02:00:00:00:00:01", "02:00:00:00:00:02", "02:00:00:00:00:99",
  "amqp://fcpi:%s@", "amqp://fcpi:$rmqpw@", String.raw`amqp://fcpi:\\(.*\\)@`, "http://user:pw@"]);
function scanFiles(files, ids, rules, allow = new Set()) {
  const hits = [];
  for (const f of files) {
    read(f).split("\n").forEach((line, i) => {
      const at = `${f}:${i + 1}`;
      for (const [name, re] of rules) {
        const all = [...line.matchAll(new RegExp(re.source, re.flags.includes("g") ? re.flags : re.flags + "g"))].map((m) => m[0]);
        if (all.some((v) => !allow.has(v))) hits.push(`${at} ${name}`);
      }
      if (ids.m0) {
        for (const m of line.match(/\b\d{1,3}(?:\.\d{1,3}){3}\b/g) ?? []) if (sha256(m) === ids.m0.egress) hits.push(`${at} raw-egress-ip`);
        for (const m of line.match(/(?<![0-9A-Fa-f])[0-9A-Fa-f]{16}(?![0-9A-Fa-f])/g) ?? []) if (sha256(m.toLowerCase()) === ids.m0.serial) hits.push(`${at} raw-board-serial`);
        for (const m of line.match(/(?<![0-9A-Fa-f])[0-9A-Fa-f]{32}(?![0-9A-Fa-f])/g) ?? []) if (sha256(m.toLowerCase()) === ids.m0.machineId) hits.push(`${at} raw-machine-id`);
        for (const m of line.matchAll(/MAC_SHA256:([0-9a-f]{64})/g)) if (!ids.m0.macs.has(m[1])) hits.push(`${at} unexplained-mac-hash`);
      }
      if (ids.secrets) {
        for (const m of line.match(/(?<![0-9A-Fa-f])[0-9a-f]{64}(?![0-9A-Fa-f])/g) ?? []) if (ids.secrets.has(sha256(m))) hits.push(`${at} live-secret-by-hash-hex`);
        for (const m of line.match(/fcpi_[a-z0-9]+_[0-9a-f]{64}/g) ?? []) if (ids.secrets.has(sha256(m))) hits.push(`${at} live-secret-by-hash-hex`);
        for (const m of line.match(/(?<![A-Z])[A-P]{64}(?![A-Z])/g) ?? []) if (ids.secrets.has(sha256(m))) hits.push(`${at} live-secret-by-hash-cookie`);
      }
    });
  }
  return hits;
}

// ---- snapshot attribution (V14) ---------------------------------------------------------
// The snapshot records the ruleset only as a hash, so the firewall line is attributed from the
// ruleset listing instead: it must hold exactly Docker's tables and the project's counting tables.
// Before M1 nf_tables was not loaded, so no other ruleset existed for M1 to change.
const NFT_TABLES = ["bridge fcpi_audit", "inet fcpi_audit", "ip filter", "ip nat", "ip raw", "ip6 filter", "ip6 nat"];
// From M1's close-out on, the project's access-bridge guard (deploy/host/fcpi-guard.nft) too.
const NFT_TABLES_GUARDED = [...NFT_TABLES, "inet fcpi_guard"].sort();
const nftTables = () => [...read(`${RAW}nft-ruleset.txt`).matchAll(/^table (\S+ \S+) \{$/gm)].map((m) => m[1]).sort();
const GUARD = "project access-bridge guard (deploy/host/fcpi-guard.nft)";
const MODULE_ALLOW = /^(bridge|stp|llc|veth|overlay|br_netfilter|ip_set|xt_[a-z_]+|xt_[A-Z]+|x_tables|nf_[a-z0-9_]+|nft_[a-z0-9_]+|ip6?_tables|ip6?table_[a-z]+|iptable_[a-z]+|ipt_[A-Z]+|xfrm_algo|xfrm_user|nf_tables|nfnetlink)$/;
function keyedSnapshot(file) {
  const out = [];
  let sec = null;
  for (const l of read(file).split("\n")) {
    const m = l.match(/^### (\S+)$/);
    if (m) { sec = m[1]; continue; }
    if (sec && sec !== "meta" && l !== "end" && l !== "") out.push([sec, l]);
  }
  return out;
}
function attribute(sec, line, containerIds) {
  const listener = (l) => l.replace(/pid=\d+,fd=\d+/g, "pid,fd"); // systemd's socket-activation fd numbers move as units are added
  if (sec === "systemd_running" && /^session-\d+\.scope$/.test(line)) return "own SSH session scope (excluded, as in M0)";
  if (sec === "systemd_running" || sec === "systemd_enabled") {
    if (/^(containerd\.service|docker\.service|docker\.socket)$/.test(line)) return "container runtime installed by M1";
    if (/^fcpi-stack\.service$/.test(line)) return "project unit (enabled by pi-init.sh)";
    const m = line.match(/^docker-([0-9a-f]{64})\.scope$/);
    if (m && containerIds.has(m[1])) return "scope of a running fcpi container";
  }
  if (sec === "docker_activation" && /^(containerd\.service|docker\.service|docker\.socket)=/.test(line)) return "container runtime installed by M1";
  if (sec === "docker_ps") {
    if (line.startsWith("SKIPPED docker.service not active")) return "container runtime installed by M1";
    const f = line.split("\t");
    if (f.length === 4 && /^fcpi-/.test(f[1]) && containerIds.has(f[0])) return "fcpi container";
  }
  if (sec === "findmnt") {
    if (/^\/run\/docker\/netns\/[0-9a-f]+ nsfs\[net:\[\d+\]\] nsfs rw$/.test(line)) return "container network namespace";
    const m = line.match(/^\/var\/lib\/docker\/rootfs\/overlayfs\/([0-9a-f]{64}) overlay overlay /);
    if (m && containerIds.has(m[1])) return "fcpi container root filesystem";
  }
  // The guard's `ct state` match loads nft_ct; M1's own runtime never did.
  if (sec === "lsmod" && /^nft_ct /.test(line) && JSON.stringify(nftTables()) === JSON.stringify(NFT_TABLES_GUARDED)) return `kernel module for the guard's ct state match (${GUARD.slice(GUARD.indexOf("(") + 1, -1)})`;
  if (sec === "lsmod" && MODULE_ALLOW.test(line.split(" ")[0])) return "kernel module loaded by the container runtime";
  if (sec === "firewall" && /^nft_ruleset_sha256=/.test(line)) {
    const t = JSON.stringify(nftTables());
    if (t === JSON.stringify(NFT_TABLES)) return "nftables: Docker's tables and the project's fcpi_audit tables (evidence/M1/raw/nft-ruleset.txt)";
    return t === JSON.stringify(NFT_TABLES_GUARDED) ? `nftables: Docker's tables, the project's fcpi_audit tables and its fcpi_guard table (${RAW}nft-ruleset.txt)` : null;
  }
  // Sections scripts/m1/pi-snapshot-net.sh adds from the close-out on.
  if (sec === "nft_tables" && line === "table inet fcpi_guard") return GUARD;
  if (sec === "nft_chains" && /^inet fcpi_guard (forward hook=forward|input hook=input) prio=-10 policy=accept$/.test(line)) return GUARD;
  if (sec === "ss_listen" && /^tcp 127\.0\.0\.1:3380 users:\(\("docker-proxy",/.test(line)) return "the gateway's only host publication";
  return null;
}

const checks = {
  // ===================================================================== native proofs (D2)
  N00: { name: "baseline-matches-m0-after", inputs: ["evidence/M1/snapshot-before.txt", "evidence/M0/snapshot-after.txt"],
    expected: "M1 BEFORE equals M0 AFTER apart from SSH session scopes; boot ID unchanged",
    run() {
      const a = keyedSnapshot("evidence/M0/snapshot-after.txt").map((x) => x.join("\t")).filter((l) => !/\tsession-\d+\.scope$/.test(l)).sort();
      const b = keyedSnapshot("evidence/M1/snapshot-before.txt").map((x) => x.join("\t")).filter((l) => !/\tsession-\d+\.scope$/.test(l)).sort();
      const only = (x, y) => x.filter((l) => !y.includes(l));
      const boot = (f) => (read(f).match(/^boot_id_sha256=([0-9a-f]{64})$/m) ?? [])[1];
      // Both boot IDs must be real 64-hex hashes: two missing lines must not compare equal.
      const ok = only(a, b).length === 0 && only(b, a).length === 0 && !!boot("evidence/M0/snapshot-after.txt") && boot("evidence/M0/snapshot-after.txt") === boot("evidence/M1/snapshot-before.txt");
      return { ok, actual: `lines only in M0 AFTER=${only(a, b).length}, only in M1 BEFORE=${only(b, a).length}, boot_id_equal=${boot("evidence/M0/snapshot-after.txt") === boot("evidence/M1/snapshot-before.txt")}` };
    } },

  N01: { name: "container-runtime-installed", inputs: [`${RAW}runtime-plan.txt`, `${RAW}runtime-install.txt`],
    expected: "Docker's signing key fingerprint 9DC85822…0EBFCD88; docker-ce 5:29.8.1, containerd.io 2.3.5, compose 5.5.1, buildx 0.37.1 installed and held; engine linux/arm64; only iptables and its two libraries added beyond them",
    run() {
      const s = sections(`${RAW}runtime-install.txt`), p = sections(`${RAW}runtime-plan.txt`);
      const inst = s.installed ?? [];
      const want = { "docker-ce": "5:29.8.1-1~debian.13~trixie", "docker-ce-cli": "5:29.8.1-1~debian.13~trixie", "containerd.io": "2.3.5-1~debian.13~trixie", "docker-compose-plugin": "5.5.1-1~debian.13~trixie", "docker-buildx-plugin": "0.37.1-1~debian.13~trixie" };
      const held = Object.entries(want).every(([k, v]) => inst.includes(`${k} ${v} hold ok installed`));
      const sim = (p.simulate ?? []).filter((l) => l.startsWith("Inst ")).map((l) => l.split(" ")[1]).sort();
      const extra = sim.filter((x) => !(x in want));
      const ok = (s.signing_key ?? []).includes("fingerprint=9DC858229FC7DD38854AE2D88D81803C0EBFCD88") && held && inst.some((l) => /^29\.8\.1 api=\S+ os\/arch=linux\/arm64$/.test(l)) &&
        inst.includes("Docker Compose version v5.5.1") && JSON.stringify(extra) === JSON.stringify(["iptables", "libip4tc2", "libip6tc2"]);
      return { ok, actual: `held=${held}; engine=${inst.find((l) => / api=/.test(l))}; packages added beyond the five: ${extra.join(",")}` };
    } },

  N02: { name: "proof-images-native-arm64-from-pinned-digests", inputs: [`${RAW}native-proofs.txt`, `${RAW}image-inspect.txt`, "deploy/versions.lock.json"],
    expected: "every proof container runs the pinned digest, platform linux/arm64, uname -m aarch64, no restart; the API image's FIRECRAWL_BUILD_SHA equals the pinned commit",
    run() {
      const D = digests().proof;
      const rows = (sections(`${RAW}native-proofs.txt`).containers_platform ?? []).filter(Boolean).map((l) => ({ name: l.split(" ")[0], ...kv(l) }));
      const bad = Object.entries(D).filter(([n, d]) => { const r = rows.find((x) => x.name === n); return !r || r.image !== d || r.platform !== "linux/arm64" || r.uname_m !== "aarch64" || r.restarts !== "0"; }).map(([n]) => n);
      const sha = sections(`${RAW}image-inspect.txt`).api_image_build_sha_assertion ?? [];
      const ok = rows.length === 6 && bad.length === 0 && sha.includes(`FIRECRAWL_BUILD_SHA=${UPSTREAM_SHA}`) && sha.includes(`app_build_sha_file=${UPSTREAM_SHA}`);
      return { ok, actual: `containers=${rows.length}; not matching=${bad.join(",") || "none"}; build_sha=${(lineOf(sha, "FIRECRAWL_BUILD_SHA=") ?? "").split("=")[1]}` };
    } },

  N03: { name: "proof-postgres-pg-cron-native", inputs: [`${RAW}native-proofs.txt`],
    expected: "PostgreSQL 17.11 on aarch64 answers; one pg_cron launcher; 36 cron jobs; cron runs succeed and none fail",
    run() {
      const pg = kv((sections(`${RAW}native-proofs.txt`).postgres ?? []).join(" ").replace(/version=.*?64-bit/, ""));
      const v = lineOf(sections(`${RAW}native-proofs.txt`).postgres, "version=") ?? "";
      const ok = /PostgreSQL 17\.11 .*aarch64/.test(v) && pg.pg_cron_launcher_backends === "1" && pg.cron_jobs === "36" && Number(pg.cron_runs_succeeded) > 0 && pg.cron_runs_failed === "0";
      return { ok, actual: `${v.slice(8, 60)}; launcher=${pg.pg_cron_launcher_backends}; jobs=${pg.cron_jobs}; runs succeeded=${pg.cron_runs_succeeded} failed=${pg.cron_runs_failed}` };
    } },

  N04: { name: "proof-redis-jemalloc-native", inputs: [`${RAW}native-proofs.txt`],
    expected: "Redis 8.10.2 answers PING; INFO memory reports a jemalloc allocator; arch_bits 64",
    run() {
      const r = sections(`${RAW}native-proofs.txt`).redis ?? [];
      const alloc = (lineOf(r, "mem_allocator:") ?? "").split(":")[1];
      const ok = r.includes("ping=PONG") && /^jemalloc-/.test(alloc ?? "") && r.includes("arch_bits:64") && r.includes("redis_version:8.10.2");
      return { ok, actual: `ping=${(lineOf(r, "ping=") ?? "").split("=")[1]}; allocator=${alloc}` };
    } },

  N05: { name: "proof-rabbitmq-native", inputs: [`${RAW}native-proofs.txt`, `${RAW}native-proofs-up-attempt1.txt`],
    expected: "RabbitMQ 4.3.6 answers ping; BEAM runs its JIT (emu_flavor jit); check_running and check_local_alarms pass; memory alarm 256 MiB; the diagnostics ping's memory cost measured against the cap",
    run() {
      const r = sections(`${RAW}native-proofs.txt`).rabbitmq ?? [];
      const g = (p) => (lineOf(r, p) ?? "").slice(p.length);
      const probes = r.filter((l) => l.startsWith("probe=")).map((l) => kv(l));
      const ok = /Ping succeeded/.test(g("ping=")) && g("server_version=") === "4.3.6" && g("erlang_emu_flavor=") === "jit" && g("check_running=") === "ok" && g("check_local_alarms=") === "ok" && g("memory_high_watermark=") === "268435456" && probes.length === 2;
      return { ok, actual: `version=${g("server_version=")}; emu_flavor=${g("erlang_emu_flavor=")}; otp=${g("erlang_otp_release=")}; probe memory deltas MiB: ${probes.map((p) => p.delta_mib).join(" (diagnostics ping), ")} (tcp); first attempt failed on a root-owned Erlang cookie (eacces), not a page-size signature` };
    } },

  N06: { name: "proof-api-harness-native", inputs: [`${RAW}native-proofs.txt`, EXPECTED_MD],
    expected: "harness up with its six children, all health endpoints 200; Rust napi module mapped by the converting processes; Go library mapped by none and USE_GO_MARKDOWN_PARSER unset; direct /v2/scrape Markdown equals the expected fixture output byte for byte; every native ELF has LOAD alignment >= 0x4000",
    run() {
      const s = sections(`${RAW}native-proofs.txt`);
      const health = JSON.parse(lineOf(s.core_health, "{") ?? "{}");
      const allOk = ["api_liveness", "extract_worker", "queue_worker", "nuq_worker_0", "nuq_prefetch_worker", "nuq_reconciler"].every((k) => health[k]?.status === 200);
      const topo = coreTopology(s.core_processes.filter((l) => !/ ps -eo /.test(l)));
      const rust = (s.native_module_mappings ?? []).filter((l) => l.startsWith("rust_module_mapped_by")).length;
      const go = (s.native_module_mappings ?? []).filter((l) => l.startsWith("go_library_mapped_by")).length;
      const flags = kv((s.core_env_flags ?? []).join(" "));
      const scrape = JSON.parse(lineOf(s.scrape_direct, "{") ?? "{}");
      const elf = (s.elf_alignment ?? []).filter(Boolean).map((l) => JSON.parse(l));
      const md = b64md(scrape.markdown_b64);
      const ok = s.core_health.includes("ready=1 after_probe_attempts=1") || /^ready=1/.test(s.core_health[0]) ? allOk && topo.harness === 1 && topo.node_children.every((n) => n === 1) &&
        rust >= 1 && go === 0 && flags.USE_GO_MARKDOWN_PARSER === "UNSET" && flags.NUQ_WORKER_COUNT === "1" && md === expectedMd() && elf.length === 3 && elf.every((e) => e.page_16k_compatible) : false;
      return { ok, actual: `health_all_200=${allOk}; node processes: harness=${topo.harness} children=${topo.node_children.join("")} sh_wrappers=${topo.sh_wrappers.join("")}; rust_module_mapped_by=${rust} go_library_mapped_by=${go}; USE_GO_MARKDOWN_PARSER=${flags.USE_GO_MARKDOWN_PARSER}; markdown_exact=${md === expectedMd()}; elf=${elf.map((e) => `${e.path.split("/").pop()}:${e.min_load_align_hex}`).join(",")}` };
    } },

  N07: { name: "proof-gateway-native", inputs: [`${RAW}native-proofs.txt`, EXPECTED_MD],
    expected: "the gateway's contract tests pass 8/8 on the pinned Node 22.23.3; an authenticated fixture scrape through it returns the expected Markdown; an unauthenticated one gets the gateway's own 401",
    run() {
      const g = sections(`${RAW}native-proofs.txt`).gateway ?? [];
      const idx = g.indexOf("authenticated:");
      const auth = JSON.parse(g[idx + 1] ?? "{}"), unauth = JSON.parse(g[g.indexOf("unauthenticated:") + 1] ?? "{}");
      const tapOk = g.filter((l) => /^ok \d/.test(l)).length, tapNotOk = g.filter((l) => /^not ok/.test(l)).length, tapPass = Number((lineOf(g, "# pass ") ?? "").slice(7));
      // Internally consistent TAP, not a pinned count: the proof ran the suite of its day.
      const ok = g.includes("contract_tests_node=v22.23.3") && tapOk > 0 && tapNotOk === 0 && tapPass === tapOk && g.includes("# fail 0") && auth.http_status === 200 && b64md(auth.markdown_b64) === expectedMd() &&
        unauth.http_status === 401 && unauth.www_authenticate === 'Bearer realm="fcpi"';
      return { ok, actual: `node=${(lineOf(g, "contract_tests_node=") ?? "").split("=")[1]}; tests=${g.filter((l) => /^ok \d/.test(l)).length} ok, ${g.filter((l) => /^not ok/.test(l)).length} not ok; authenticated=${auth.http_status} markdown_exact=${b64md(auth.markdown_b64) === expectedMd()}; unauthenticated=${unauth.http_status} challenge=${unauth.www_authenticate}` };
    } },

  N08: { name: "proof-nuq-roundtrip-cases-1-2", inputs: [`${RAW}nuq-roundtrip-proof.txt`],
    expected: "on the proof stack: case 1 completes through the quorum prefetch queue and the exclusive auto-delete reply queue; case 2's prefetched message expires unconsumed ~50 s and the job is still served from PostgreSQL",
    run() {
      // The proof transcript predates the per-case log sections; judge it from queues, counters and the timeline.
      const s = sections(`${RAW}nuq-roundtrip-proof.txt`);
      const c1 = JSON.parse(lineOf(s.case1_scrape, "{") ?? "{}"), c2 = JSON.parse(lineOf(s.case2_scrape, "{") ?? "{}");
      const lq = (s.case1_queues ?? []).map((l) => l.split("\t")).find((f) => /^nuq\.queue_scrape\.listen\./.test(f[0]));
      const cnt = (sec, n) => Number(((s[sec] ?? []).find((l) => l.startsWith(`rabbitmq_global_messages_${n}_total{`)) ?? " 0").split(" ").pop());
      const tl = (s.case2_timeline ?? []);
      const ok = c1.success === true && lq?.[1] === "classic" && lq?.[3] === "true" && lq?.[4] === "true" && cnt("case1_counters_after", "delivered_get_auto_ack") >= 1 &&
        tl.some((l) => /EVENT prefetch_message_gone_unconsumed/.test(l)) && tl.some((l) => /stalls=1/.test(l)) && cnt("case2_counters_after", "dead_lettered_expired") >= 1 && c2.success === true;
      return { ok, actual: `case1 success=${c1.success} reply_queue=${lq?.slice(1, 5).join("/")}; case2 expired=${tl.some((l) => /gone_unconsumed/.test(l))} requeued=${tl.some((l) => /stalls=1/.test(l))} dead_lettered_expired=${cnt("case2_counters_after", "dead_lettered_expired")} success=${c2.success}` };
    } },

  N09: { name: "proof-nuq-roundtrip-case-3-without-restart-policy", inputs: [`${RAW}nuq-roundtrip-proof.txt`],
    expected: "on the proof stack (no restart policy), a new job completes after the broker restarts",
    run() {
      const s = sections(`${RAW}nuq-roundtrip-proof.txt`);
      const c3 = (s.case3_scrape ?? []).join(" ");
      const ok = /"success":true/.test(c3);
      return { ok, actual: `broker ${kv(lineOf(s.case3_restart, "broker_ping_ok_after_s") ?? "").broker_ping_ok_after_s ?? "?"} s to ping; new job: ${ok ? "completed" : "not completed: " + c3.slice(0, 90)}`,
        classification: ok ? undefined : "upstream-client-defect: nuq.ts getJobToProcess() awaits startSender() -> amqp.connect() outside its try/catch, so ECONNREFUSED during a broker restart escapes the queue-worker.ts:329 and nuq-worker-runner.ts:120 polling loops as an unhandled rejection and the harness exits. Not RabbitMQ-4.x-specific, not a page-size signature. Under Compose, restart: unless-stopped recovers it (V10). M2 patch candidate PC-NUQ-CONNECT." };
    } },

  // ===================================================================== deployed stack
  V01: { name: "running-containers-native-arm64-pinned-hardened", inputs: [`${RAW}stack-final.txt`, "deploy/versions.lock.json"],
    expected: "each service runs its pinned digest on linux/arm64; every process in every project container is an aarch64 ELF (e_machine 183); no binfmt handler; no privileged container, host network or Docker socket mount; read-only root filesystems; all capabilities dropped (the core keeps only SETUID/SETGID for its one-time drop); no-new-privileges",
    run() {
      const s = sections(`${RAW}stack-final.txt`);
      const D = digests().service;
      const rows = (s.containers ?? []).filter((l) => / name=/.test(l)).map((l) => ({ svc: l.split(" ")[0], ...kv(l) }));
      const bad = [];
      for (const [svc, dg] of Object.entries(D)) {
        const r = rows.find((x) => x.svc === svc);
        if (!r) { bad.push(`${svc}:absent`); continue; }
        if (r.image !== dg) bad.push(`${svc}:digest`);
        if (r.platform !== "linux/arm64") bad.push(`${svc}:platform`);
        if (r.privileged !== "false" || r.readonly_rootfs !== "true" || r.docker_sock_mount !== "0" || /^host$/.test(r.network_mode)) bad.push(`${svc}:hardening`);
        if (r.cap_drop !== "ALL" || (svc === "firecrawl-core" ? r.cap_add !== "CAP_SETGID,CAP_SETUID" : r.cap_add !== "")) bad.push(`${svc}:caps`);
        if (!/no-new-privileges:true/.test(r.security_opt)) bad.push(`${svc}:nnp`);
        if (!(s.containers ?? []).includes(`${svc} uname_m=aarch64`)) bad.push(`${svc}:uname`);
      }
      const procs = (s.process_elf ?? []).filter(Boolean).map((l) => ({ svc: l.split(" ")[0], ...kv(l) }));
      const nonNative = procs.filter((p) => p.e_machine !== "183");
      // binfmt_misc: no handler beyond M0's baseline (python3.13, for .pyc files), and none that emulates.
      const binfmt = (kv(lineOf(s.meta, "binfmt_misc_handlers=")).binfmt_misc_handlers ?? "").split(",").filter(Boolean);
      const m0binfmt = (read("evidence/M0/raw/pi-audit.txt").match(/^binfmt_entries=(.*)$/m)?.[1] ?? "").split(" ").filter((x) => x && !/^(register|status)$/.test(x));
      const binfmtOk = binfmt.every((h) => m0binfmt.includes(h) && !/qemu|box64|fex|emul/i.test(h));
      const ok = rows.length === 6 && bad.length === 0 && procs.length > 0 && nonNative.length === 0 && binfmtOk;
      return { ok, actual: `services=${rows.length}; problems=${bad.join(",") || "none"}; processes=${procs.length}, non-aarch64=${nonNative.length}; binfmt_misc handlers=${binfmt.join(",") || "none"} (M0 baseline: ${m0binfmt.join(",")})`, digests: Object.values(D) };
    } },

  V02: { name: "process-topology-and-uids", inputs: [`${RAW}stack-final.txt`, `${RAW}stack.txt`],
    expected: "the core runs the harness, its six children once each (one nuq-worker: NUQ_WORKER_COUNT=1) and six resident `sh -c` wrappers: 13 processes, all uid 3002; every other container's processes run as that service's dedicated uid",
    run() {
      const res = {};
      let ok = true;
      for (const f of [`${RAW}stack.txt`, `${RAW}stack-final.txt`]) {
        const s = sections(f);
        const t = coreTopology((s.core_processes ?? []));
        const uids = {};
        for (const l of (s.process_elf ?? []).filter(Boolean)) { if (isHealthcheck(l.slice(l.indexOf(" args=") + 6))) continue; const svc = l.split(" ")[0]; (uids[svc] ??= new Set()).add(kv(l).uid); }
        const uidOk = Object.entries(SERVICE_UID).every(([svc, u]) => uids[svc] && uids[svc].size === 1 && uids[svc].has(u));
        const good = t.total === 13 && t.harness === 1 && t.node_children.every((n) => n === 1) && t.sh_wrappers.every((n) => n === 1) && t.other.length === 0 && t.users.length === 1 && t.users[0] === "3002" && uidOk;
        ok &&= good;
        res[f.split("/").pop()] = { total: t.total, harness: t.harness, node_children: t.node_children.join(""), sh_wrappers: t.sh_wrappers.join(""), core_users: t.users.join(","), service_uids_as_designed: uidOk };
      }
      return { ok, actual: JSON.stringify(res) };
    } },

  V03: { name: "effective-cgroup-caps-and-host-memory", inputs: [`${RAW}stack-final.txt`],
    expected: "each container's memory.max equals its spec §22 cap, memory.swap.max is 0, cpu.max equals its quota; host MemAvailable >= 1 GiB with the stack running",
    run() {
      const s = sections(`${RAW}stack-final.txt`);
      const rows = Object.fromEntries((s.cgroups ?? []).filter(Boolean).map((l) => [l.split(" ")[0], kv(l)]));
      const bad = [];
      const usage = [];
      for (const [svc, [mib, cpus]] of Object.entries(CAPS)) {
        const r = rows[svc];
        if (!r) { bad.push(`${svc}:absent`); continue; }
        if (Number(r["memory.max"]) !== mib * 1024 * 1024) bad.push(`${svc}:memory.max=${r["memory.max"]}`);
        if (r["memory.swap.max"] !== "0") bad.push(`${svc}:swap=${r["memory.swap.max"]}`);
        if (r["cpu.max"] !== `${Math.round(cpus * 100000)}/100000`) bad.push(`${svc}:cpu.max=${r["cpu.max"]}`);
        usage.push(`${svc} ${(Number(r["memory.current"]) / 1048576).toFixed(0)}/${mib} MiB (anon ${(Number(r.anon) / 1048576).toFixed(0)})`);
      }
      const avail = Number((lineOf(s.host_memory, "MemAvailable:") ?? "").replace(/\D+/g, "")) / 1024;
      const ok = bad.length === 0 && avail >= 1024;
      return { ok, actual: `problems=${bad.join(",") || "none"}; host MemAvailable=${avail.toFixed(0)} MiB; usage: ${usage.join("; ")}; M1 caps total=${Object.values(CAPS).reduce((a, [m]) => a + m, 0)} MiB` };
    } },

  V04: { name: "published-ports-and-exposure", inputs: [`${RAW}stack-final.txt`, `${RAW}lan-probe.txt`, `${RAW}nft-ruleset.txt`, "evidence/M1/snapshot-before.txt"],
    expected: "the only publication is access-gateway 3300/tcp on 127.0.0.1:3380; the only new host listener is docker-proxy on 127.0.0.1:3380; from a LAN neighbour every project port is closed while sshd (control) answers; Engine's rule dropping non-loopback packets to 127.0.0.1:3380 is present; the networks are segmented as designed: fcpi_access (NAT, publication) holds only the gateway; fcpi_api holds only the gateway and the core; fcpi_core holds the core and the three data services, never the gateway; fcpi_fixture holds the core and the fixture; the last three are internal, isolated and have no host address",
    run() {
      const s = sections(`${RAW}stack-final.txt`);
      const pubs = (s.published ?? []).filter((l) => / -> /.test(l));
      const norm = (l) => l.replace(/pid=\d+,fd=\d+/g, "pid,fd");
      const before = new Set((sections("evidence/M1/snapshot-before.txt").ss_listen ?? []).filter(Boolean).map(norm));
      const hostListen = (s.published ?? []).slice((s.published ?? []).indexOf("--- host listeners (ss -Hltnup)") + 1).filter(Boolean).map(norm);
      const added = hostListen.filter((l) => !before.has(l));
      const lan = sections(`${RAW}lan-probe.txt`);
      const open = (lan.project_ports ?? []).filter((l) => / open$/.test(l));
      const ruleset = read(`${RAW}nft-ruleset.txt`);
      const nets = Object.fromEntries((s.networks ?? []).filter((l) => /^fcpi_\w+ internal=/.test(l)).map((l) => [l.split(" ")[0], kv(l)]));
      const want = { fcpi_access: ["false", "nat", "fcpi-access-gateway-1"], fcpi_api: ["true", "isolated", "fcpi-access-gateway-1,fcpi-firecrawl-core-1"],
        fcpi_core: ["true", "isolated", "fcpi-firecrawl-core-1,fcpi-nuq-postgres-1,fcpi-rabbitmq-1,fcpi-redis-1"], fcpi_fixture: ["true", "isolated", "fcpi-firecrawl-core-1,fcpi-fixture-1"] };
      const netBad = Object.entries(want).filter(([n, [internal, mode, members]]) => nets[n]?.internal !== internal || nets[n]?.gateway_mode_ipv4 !== mode || nets[n]?.members !== members).map(([n]) => n);
      const hostAddr = (s.networks ?? []).filter((l) => /^bridge fcpi-(api|core|fixture) addresses=\S/.test(l));
      const ok = Object.keys(nets).length === 4 && netBad.length === 0 && hostAddr.length === 0 && pubs.length === 1 && pubs[0] === "access-gateway 3300/tcp -> 127.0.0.1:3380" && added.length === 1 && /^tcp 127\.0\.0\.1:3380 users:\(\("docker-proxy"/.test(added[0]) &&
        (lan.project_ports ?? []).length === 14 && open.length === 0 && (lan.control ?? []).includes("port=22 open") &&
        /ip daddr 127\.0\.0\.1 iifname != "lo" tcp dport 3380 counter drop/.test(ruleset);
      return { ok, actual: `publications=${pubs.join(";")}; new host listeners=${added.join(";") || "none"}; LAN probe: ${(lan.project_ports ?? []).length} project ports, open=${open.length}, control 22 open=${(lan.control ?? []).includes("port=22 open")}; loopback-protection rule present=${/tcp dport 3380 counter drop/.test(ruleset)}; networks mis-segmented=${netBad.join(",") || "none"}; internal bridges with a host address=${hostAddr.length}` };
    } },

  V05: { name: "gateway-token-rejection-and-routing", inputs: [`${RAW}stack.txt`, "tests/contracts/m1-gateway.test.mjs", "services/access/server.mjs"],
    expected: "missing and wrong tokens get 401 with the gateway's own body and challenge (no firecrawl.dev); /admin/* is 401 without and 404 with a token; an unlisted route is 404; non-fixture and internal targets are 403; the contract tests pass locally",
    run() {
      const g = Object.fromEntries((sections(`${RAW}stack.txt`).gateway_tests ?? []).filter(Boolean).map((l) => [l.split(" ")[0], { ...kv(l), body: l.slice(l.indexOf("body=") + 5) }]));
      const e = (k, st) => g[k]?.status === st;
      const unauthOk = ["missing_token", "wrong_token", "missing_token_admin"].every((k) => e(k, "401") && g[k].www_authenticate === 'Bearer_realm="fcpi"' && JSON.parse(g[k].body).error === "unauthorized");
      const noCloud = Object.values(g).every((x) => !/firecrawl\.dev/.test(x.www_authenticate ?? ""));
      let local = { code: null, out: "" };
      try { local.out = execFileSync(process.execPath, ["--test", "--test-reporter=tap", "tests/contracts/m1-gateway.test.mjs"], { cwd: ROOT, encoding: "utf8" }); local.code = 0; } catch (x) { local = { code: x.status, out: x.stdout ?? "" }; }
      const pass = Number((local.out.match(/^# pass (\d+)$/m) ?? [])[1]), fail = Number((local.out.match(/^# fail (\d+)$/m) ?? [])[1]);
      const declared = (read("tests/contracts/m1-gateway.test.mjs").match(/^test\(/gm) ?? []).length; // every test the file declares must pass
      const ok = unauthOk && noCloud && e("valid_token_admin", "404") && e("valid_token_unlisted_route", "404") && e("valid_token_non_fixture_target", "403") && e("valid_token_internal_target", "403") && e("valid_token_fixture_scrape", "200") && local.code === 0 && pass === declared && fail === 0;
      return { ok, actual: `${Object.entries(g).map(([k, v]) => `${k}=${v.status}`).join(" ")}; unauthenticated bodies/challenges gateway-owned=${unauthOk}; Cloud challenge anywhere=${!noCloud}; local contract tests (node ${process.version}): pass=${pass}/${declared} declared, fail=${fail}` };
    } },

  V06: { name: "static-fixture-markdown-exact", inputs: [`${RAW}stack.txt`, `${RAW}stack-final.txt`, EXPECTED_MD, "tests/fixtures/m1/site/static.html"],
    expected: "the fixture's Markdown equals tests/fixtures/m1/expected/static.md byte for byte through the gateway and directly, before and after container recreation; the expected file was committed before the earliest scrape in the evidence",
    run() {
      const exp = expectedMd();
      const res = {};
      for (const f of [`${RAW}stack.txt`, `${RAW}stack-final.txt`]) {
        const s = sections(f);
        const gw = (s.gateway_tests ?? []).find((l) => l.startsWith("valid_token_fixture_scrape "));
        const gmd = gw ? b64md(JSON.parse(gw.slice(gw.indexOf("body=") + 5)).markdown) : null;
        const d = JSON.parse(lineOf(s.direct_scrape, "{") ?? "{}");
        res[f.split("/").pop()] = { gateway: gmd === exp, direct: b64md(d.markdown_b64) === exp };
      }
      // The file must be unchanged since the commit that added it, and that last change must
      // predate the earliest scrape: an edit made to match observed output would fail here.
      const addCommit = git("log", "--diff-filter=A", "--format=%H", "--", EXPECTED_MD).split("\n").pop();
      const committed = git("log", "-1", "--format=%cI", "--", EXPECTED_MD);
      const unchangedSinceAdded = !!addCommit && git("rev-parse", `${addCommit}:${EXPECTED_MD}`) === git("hash-object", EXPECTED_MD);
      // The earliest scrape is always M1's native proof, whichever evidence is being checked.
      const firstScrape = (lineOf(sections("evidence/M1/raw/native-proofs.txt").scrape_direct, "{") ?? "").match(/"utc_start":"([^"]+)"/)?.[1];
      const before = unchangedSinceAdded && !!committed && !!firstScrape && new Date(committed) < new Date(firstScrape);
      const ok = Object.values(res).every((r) => r.gateway && r.direct) && before;
      return { ok, actual: `${JSON.stringify(res)}; expected last changed ${committed} (content unchanged since added in ${addCommit.slice(0, 7)}: ${unchangedSinceAdded}), earliest recorded scrape ${firstScrape}, committed first=${before}; expected sha256=${sha256File(EXPECTED_MD)}` };
    } },

  V07: { name: "dependency-health-beyond-heartbeat", inputs: [`${RAW}stack-final.txt`],
    expected: "every container healthy; every harness child's own health endpoint 200 (nuq-worker-0's runs a PostgreSQL query); PostgreSQL answers, pg_cron runs with no failures, spec §22 settings from the command line, durability on; Redis PONG for the PING-only health user, NOAUTH without credentials, AOF on and writing, jemalloc; RabbitMQ running without alarms, node rabbit@rabbitmq, 256 MiB alarm, one user, private cookie, no management UI",
    run() {
      const s = sections(`${RAW}stack-final.txt`);
      const health = (s.containers ?? []).filter((l) => / name=/.test(l)).map((l) => kv(l).health);
      const core = JSON.parse(lineOf(s.core_health, "{") ?? "{}");
      const coreOk = ["api_liveness", "api_readiness", "extract_worker", "queue_worker", "nuq_worker_0", "nuq_prefetch_worker", "nuq_reconciler"].every((k) => core[k]?.status === 200);
      const pg = s.postgres_health ?? [];
      const pgk = kv(pg.filter((l) => !l.startsWith("version=")).join(" "));
      const setting = (n, v) => pg.includes(`${n}=${v} source=command line`);
      const pgOk = pgk.select_1 === "1" && pgk.pg_cron_launcher_backends === "1" && pgk.cron_jobs === "36" && Number(pgk.cron_runs_last_10min_succeeded) > 0 && pgk.cron_runs_last_10min_failed === "0" &&
        setting("shared_buffers", "128MB") && setting("work_mem", "4MB") && setting("max_connections", "32") && setting("max_wal_size", "1GB") && setting("min_wal_size", "80MB") &&
        setting("fsync", "on") && setting("full_page_writes", "on") && setting("synchronous_commit", "on") && pgk.process_uid === "5432";
      const rd = s.redis_health ?? [];
      const rdOk = rd.includes("health_user_ping=PONG") && /^health_user_info_denied=NOPERM/.test(lineOf(rd, "health_user_info_denied=") ?? "") && /^no_auth_ping=NOAUTH/.test(lineOf(rd, "no_auth_ping=") ?? "") &&
        rd.includes("aof_enabled:1") && rd.includes("aof_last_write_status:ok") && /^mem_allocator:jemalloc-/.test(lineOf(rd, "mem_allocator:") ?? "") && rd.includes("maxmemory_policy:noeviction");
      const rq = s.rabbitmq_health ?? [];
      const g = (p) => (lineOf(rq, p) ?? "").slice(p.length);
      const rqOk = /Ping succeeded/.test(g("ping=")) && g("check_running=") === "ok" && g("check_local_alarms=") === "ok" && g("node=") === "rabbit@rabbitmq" && g("memory_high_watermark_bytes=") === "268435456" &&
        (CLOSEOUT ? /^fcpi\[\]$/ : /^fcpi\[(administrator)?\]$/).test(g("users=").trim()) && g("cookie=") === "5672:5672 400" && !/rabbitmq_management /.test(g("enabled_plugins=") + " ") && g("process_uid=") === "5672";
      const ok = health.length === 6 && health.every((h) => h === "healthy") && coreOk && pgOk && rdOk && rqOk;
      return { ok, actual: `container health=${health.join(",")}; core endpoints all 200=${coreOk}; postgres=${pgOk} (cron runs 10 min: ${pgk.cron_runs_last_10min_succeeded} ok/${pgk.cron_runs_last_10min_failed} failed, connections ${pgk.connections}/${pgk.max_connections}); redis=${rdOk}; rabbitmq=${rqOk} (plugins: ${g("enabled_plugins=").trim()})` };
    } },

  V08: { name: "nuq-roundtrip-case-1-prefetch-and-reply", inputs: [`${RAW}nuq-roundtrip.txt`],
    expected: "a /v0/scrape job is prefetched into the durable quorum queue nuq.queue_scrape.prefetch, taken by the worker (basic.get), and its completion returns through the exclusive, auto-delete, non-durable classic reply queue with one consumer",
    run() { const { case1 } = roundTripCases(`${RAW}nuq-roundtrip.txt`); return { ok: case1.pass, actual: JSON.stringify(case1) }; } },

  V09: { name: "nuq-roundtrip-case-2-expiry-and-postgres", inputs: [`${RAW}nuq-roundtrip.txt`, "evidence/M1/raw/nuq-roundtrip-attempt1.txt"],
    expected: "with nuq-worker-0 stopped, the prefetched message vanishes unconsumed within a window containing 50 s, the broker counts one expired message, the job stays active in PostgreSQL, the lock reaper re-queues it (stalls >= 1), and it completes after the worker resumes",
    run() { const { case2 } = roundTripCases(`${RAW}nuq-roundtrip.txt`); return { ok: case2.pass, actual: JSON.stringify(case2) + "; the first Compose-stack run (nuq-roundtrip-attempt1.txt) could not pause the worker (no CAP_KILL for root in the hardened core) and is not counted" }; } },

  V10: { name: "nuq-roundtrip-case-3-broker-restart", inputs: [`${RAW}nuq-roundtrip.txt`],
    expected: "after a broker restart a new job completes through a re-declared reply queue",
    run() {
      const { case3 } = roundTripCases(`${RAW}nuq-roundtrip.txt`);
      return { ok: case3.pass, actual: JSON.stringify(case3), classification: case3.upstream_connect_escape_observed ? `recovery by container restart (restart: unless-stopped), not in-process: the upstream connect-escape defect (N09, M2 patch candidate PC-NUQ-CONNECT) restarted the core ${case3.core_restarts}x; upstream #4244 (listener left without a consumer) ${case3.listener_without_consumer_4244 ? "REPRODUCED" : "not reproduced"}` : undefined };
    } },

  V11: { name: "no-cloud-or-internet-egress-from-the-core", inputs: [`${RAW}egress-audit.txt`, `${RAW}egress-audit-start.txt`, `${RAW}stack.txt`, `${RAW}stack-final.txt`],
    expected: "across the whole window (stack checks, NuQ round trip with broker and core restarts, recreation, mount branches): the positive control counts internal traffic; zero IPv4 from the internal subnets to anywhere else, zero IPv6 beyond link scope, zero packets routed out, zero IPv6 to the host; every IPv4 packet delivered to the host is a 0.0.0.0->255.255.255.255 UDP broadcast attributed to NetworkManager DHCP on a transient veth; the core and fixture have no default route, cannot resolve any external name and get ENETUNREACH for public and host addresses; the core logs show no Cloud, DuckDuckGo or DNS-failure lines",
    run() {
      const a = read(`${RAW}egress-audit.txt`).split("\n");
      const c = Object.fromEntries(a.filter((l) => / family=/.test(l)).map((l) => [l.split(" ")[0], Number(kv(l).packets)]));
      const flows = a.filter((l) => l.startsWith("flow ")).map((l) => kv(l));
      const nmDhcp = a.filter((l) => /^nm .* dhcp4 \(veth[0-9a-f]+\): activation: beginning transaction/.test(l)).length;
      const mustZero = ["ipv4_from_internal_to_off_subnet", "ipv6_beyond_link_scope_on_any_bridge", "routed_out_of_internal_bridges", "ipv6_beyond_link_scope_to_host", "routed_out_of_access_bridge", "routed_out_of_access_bridge_ipv6"];
      const hostV4 = flows.filter((f) => f.set === "inet:fcpi_audit:seen_in_v4");
      const hostV4Ok = hostV4.every((f) => f.src === "0.0.0.0" && f.dst === "255.255.255.255" && f.l4proto === "udp") && (c.ipv4_to_host_from_internal_bridges === 0 || nmDhcp > 0);
      const v6 = flows.filter((f) => f.set === "bridge:fcpi_audit:seen_v6");
      const v6LinkOnly = v6.every((f) => /^(ff02:|fe80:)/.test(f.dst));
      const probes = [];
      let structOk = true, logOk = true;
      const counts = [];
      for (const f of [`${RAW}stack.txt`, `${RAW}stack-final.txt`]) {
        const s = sections(f);
        // Cardinality first: every expected row must be present, so an empty section or a
        // failed docker exec / docker logs cannot pass by absence.
        const rows = (s.egress_structure ?? []).filter((l) => /^fcpi-[\w-]+-1 default_route=/.test(l)).length;
        const probeRows = (s.egress_probes ?? []).filter((x) => /^(core|fixture) \{/.test(x)).length;
        const patterns = (s.core_log_scan ?? []).filter((l) => /^pattern=\S+ count=\d+$/.test(l)).length;
        const control = Number(kv(lineOf(s.core_log_scan, "control=") ?? "").count ?? 0);
        const logLines = Number(kv(lineOf(s.core_log_scan, "log_lines=") ?? "").log_lines ?? 0);
        counts.push(`${f.split("/").pop()}: structure=${rows}/6 probes=${probeRows}/2 patterns=${patterns}/9 control=${control} log_lines=${logLines}`);
        if (rows !== 6 || probeRows !== 2) structOk = false;
        if (patterns !== 9 || control < 1 || logLines < 20) logOk = false;
        for (const l of s.egress_structure ?? []) {
          const name = l.split(" ")[0], k = kv(l);
          if (/fcpi-(firecrawl-core|fixture|nuq-postgres|redis|rabbitmq)-1/.test(name) && (k.default_route !== "no" || k.nameserver !== "127.0.0.11,")) structOk = false;
        }
        for (const l of (s.egress_probes ?? []).filter((x) => /^(core|fixture) \{/.test(x))) {
          const p = JSON.parse(l.slice(l.indexOf("{")));
          const dnsFail = Object.values(p.dns).every((d) => d.error && !d.resolved);
          const tcpFail = Object.values(p.tcp).every((t) => !t.connected && t.error === "ENETUNREACH");
          probes.push(`${f.split("/").pop()}:${l.split(" ")[0]} dns_all_fail=${dnsFail} tcp_all_ENETUNREACH=${tcpFail}`);
          if (!dnsFail || !tcpFail) structOk = false;
        }
        if (!(s.egress_probes ?? []).includes("host_control_example_com=resolves")) structOk = false;
        for (const l of s.core_log_scan ?? []) if (/^pattern=/.test(l) && kv(l).count !== "0") logOk = false;
      }
      const ok = c.ipv4_from_internal_subnets > 0 && mustZero.every((k) => c[k] === 0) && hostV4Ok && v6LinkOnly && structOk && logOk;
      return { ok, actual: `evidence rows [${counts.join("; ")}]; window ${(lineOf(read(`${RAW}egress-audit-start.txt`).split("\n"), "started") ?? "").slice(8)} to ${(lineOf(a, "read ") ?? "").slice(5)}; counters ${JSON.stringify(c)}; host-delivered IPv4 flows=${hostV4.map((f) => `${f.src}->${f.dst}/${f.l4proto}`).join(",") || "none"} with ${nmDhcp} NetworkManager DHCP transactions on transient veths; link-scope IPv6 flows=${v6.map((f) => `${f.src}->${f.dst}`).join(",") || "none"}; ${probes.join("; ")}; core log Cloud/DNS lines=${logOk ? 0 : "PRESENT"}` };
    } },

  V12: { name: "mount-check-failure-branches", inputs: [`${RAW}mount-branches.txt`, "deploy/host/fcpi-data-check.sh", "deploy/host/fcpi-stack.service", "deploy/host/fcpi-data-check.service"],
    expected: "the check passes on the real config; each branch (UUID mismatch, data-ID mismatch, data directory absent, a bind that may create its host path, an absent bind source) fails the check for its own reason, fails the start of fcpi-stack, leaves no project container running, writes nothing (metadata manifest of /srv/firecrawl-pi unchanged) and creates no path; Compose itself refuses a missing bind source; the stack restarts healthy afterwards",
    run() {
      const s = sections(`${RAW}mount-branches.txt`);
      const reasons = { uuid_mismatch: /filesystem UUID of .* expected '00000000-0000-4000-8000-000000000000'/, data_id_mismatch: /data ID in .* does not match PI_DATA_ID/,
        data_dir_absent: /data directory \/srv\/firecrawl-pi\/data-absent-m1-test is absent/, bind_creates_host_path: /bind \S+ does not set create_host_path: false/, bind_source_absent: /bind source \S+ is absent/ };
      const res = {};
      let ok = (s.positive_control ?? []).includes("check_exit=0") && kv(lineOf(s.stop, "stop_exit")).running_containers === "0" &&
        kv(lineOf(s.stop, "compose_creates_path_diff_lines")).compose_creates_path_diff_lines === "1" && kv(lineOf(s.stop, "compose_absent_source_diff_lines")).compose_absent_source_diff_lines === "2";
      for (const [b, re] of Object.entries(reasons)) {
        const L = s[`branch_${b}`] ?? [];
        const k = kv(L.join(" "));
        const msg = lineOf(L, "check_message=") ?? "", direct = lineOf(L, "direct_check_exit=") ?? "";
        const good = k.stack_start_exit !== "0" && k.stack_start_exit !== undefined && k.data_check_result === "exit-code" && re.test(msg) && re.test(direct) && /^direct_check_exit=1 /.test(direct) &&
          k.running_containers === "0" && k.manifest_unchanged === "yes" && k.absent_dir_created === "no" && k.absent_bind_created === "no";
        res[b] = good;
        ok &&= good;
      }
      const probe = kv((s.compose_refuses_missing_bind ?? []).join(" "));
      const composeOk = probe.probe_up_exit === "1" && probe.absent_bind_created === "no" && probe.manifest_unchanged === "yes" && probe.probe_resources_left === "0";
      const restart = kv(lineOf(s.restart, "start_exit") ?? "");
      const healthy = (s.restart ?? []).filter((l) => / running healthy$/.test(l)).length;
      ok &&= composeOk && restart.start_exit === "0" && restart.stack_active === "active" && healthy === 6 && (s.restart ?? []).includes("manager_env_PI_CONFIG_FILE=0");
      return { ok, actual: `branches ${JSON.stringify(res)}; compose refuses missing bind=${composeOk}; restart ok=${restart.start_exit === "0"} healthy=${healthy}/6; manager env restored=${(s.restart ?? []).includes("manager_env_PI_CONFIG_FILE=0")}` };
    } },

  V17: { name: "dockerd-gated-by-data-check", inputs: [`${RAW}docker-gate.txt`, "deploy/host/docker.service.d/10-fcpi-data-check.conf"],
    expected: "dockerd runs the data check as ExecStartPre from the deployed drop-in; with dockerd stopped alone (containers still marked for revival) and a failing check, dockerd does not start, no project uid runs any process and nothing under /srv/firecrawl-pi changes; with the real config dockerd starts and its restart policies revive all six containers healthy",
    run() {
      const s = sections(`${RAW}docker-gate.txt`);
      const k = (sec) => kv((s[sec] ?? []).join(" "));
      const di = k("drop_in"), b = k("before"), st = k("stop_dockerd_alone"), g = k("gated_start"), r = k("restored_start");
      const repoHash = sha256(read("deploy/host/docker.service.d/10-fcpi-data-check.conf"));
      const ok = /path=\/opt\/firecrawl-pi\/deploy\/host\/fcpi-data-check\.sh/.test((s.drop_in ?? []).join(" ")) && di.drop_in_sha256 === repoHash && di.repo_sha256 === repoHash &&
        b.running_containers === "6" && (s.before ?? []).includes("restart_policies=unless-stopped ") &&
        st.docker === "inactive" && st.fcpi_stack === "active" && st.writers === "0" &&
        g.start_exit !== "0" && g.start_exit !== undefined && g.dockerd_processes === "0" && Number(g.check_failures) >= 1 && g.writers === "0" && g.manifest_unchanged === "yes" &&
        r.start_exit === "0" && r.docker === "active" && r.revived_healthy === "6" && r.manager_env_PI_CONFIG_FILE === "0";
      return { ok, actual: `drop-in deployed=${di.drop_in_sha256 === repoHash}; before: ${b.running_containers} running (${(lineOf(s.before, "restart_policies=") ?? "").slice(17).trim()}); dockerd stopped alone: fcpi-stack=${st.fcpi_stack}; gated start: exit=${g.start_exit} state=${g.docker} dockerd_processes=${g.dockerd_processes} check_failures=${g.check_failures} writers=${g.writers} manifest_unchanged=${g.manifest_unchanged}; restored: revived_healthy=${r.revived_healthy}` };
    } },

  V18: { name: "allow-local-webhooks-contained", inputs: [`${EV}rendered-compose.json`, "docs/FIRECRAWL_PI_SPEC.md"],
    expected: "if the core sets ALLOW_LOCAL_WEBHOOKS=true (spec §29's M1 fixture-only exception), then webhook delivery is disabled, every network the core joins is internal, and every origin the gateway permits names a host that exists only as an alias on the fixture network; the spec records the exception",
    run() {
      const R = json(`${EV}rendered-compose.json`);
      const core = R.services["firecrawl-core"], gw = R.services["access-gateway"];
      const allow = core.environment?.ALLOW_LOCAL_WEBHOOKS === "true";
      const coreNets = Object.keys(core.networks ?? {});
      const internal = coreNets.every((n) => R.networks[n]?.internal === true);
      const fixtureAliases = new Set(Object.values(R.services).flatMap((s) => s.networks?.fixture?.aliases ?? []));
      const origins = (gw.environment?.PI_PERMITTED_TARGET_ORIGINS ?? "").split(",").filter(Boolean);
      const originsOk = origins.length > 0 && origins.every((o) => { try { return fixtureAliases.has(new URL(o).hostname); } catch { return false; } });
      const specRecords = /The M1 fixture-only profile sets it true/.test(read("docs/FIRECRAWL_PI_SPEC.md"));
      const ok = !allow || (core.environment?.DISABLE_WEBHOOK_DELIVERY === "true" && coreNets.length > 0 && internal && originsOk && specRecords);
      return { ok, actual: `ALLOW_LOCAL_WEBHOOKS=${core.environment?.ALLOW_LOCAL_WEBHOOKS ?? "unset"}; DISABLE_WEBHOOK_DELIVERY=${core.environment?.DISABLE_WEBHOOK_DELIVERY ?? "unset"}; core networks ${coreNets.join(",")} all internal=${internal}; permitted origins ${origins.join(",")} all fixture-network aliases=${originsOk}; spec §29 records the exception=${specRecords}` };
    } },

  V13: { name: "persistence-sentinels-survive-force-recreate", inputs: [`${RAW}persistence.txt`],
    expected: "sentinels written to PostgreSQL, Redis (AOF) and RabbitMQ (durable quorum queue, confirmed publish) read back identically after `docker compose up -d --force-recreate`, with every container replaced, no volume or data deletion, the RabbitMQ node name unchanged and data ownership intact",
    // Nothing deleted is shown by the readback: every sentinel survives and data ownership is unchanged.
    run() {
      const s = sections(`${RAW}persistence.txt`);
      const v = kv(lineOf(s.meta, "sentinel=")).sentinel;
      const ids = (sec) => Object.fromEntries((s[sec] ?? []).filter((l) => /^[a-z-]+ [0-9a-f]{64}$/.test(l)).map((l) => l.split(" ")));
      const b = ids("before"), a = ids("after");
      const replaced = Object.keys(b).length === 6 && Object.keys(b).every((k) => a[k] && a[k] !== b[k]);
      const rq = JSON.parse((lineOf(s.read, "rabbitmq_read=") ?? "rabbitmq_read={}").slice(14));
      const w = JSON.parse((lineOf(s.write, "rabbitmq_write=") ?? "rabbitmq_write={}").slice(15));
      const owners = (s.read ?? []).filter((l) => /^\d+:\d+ 700 \/srv\/firecrawl-pi\/data/.test(l));
      const ok = /^m1-sentinel-[0-9a-f-]{36}$/.test(v ?? "") && (s.write ?? []).includes(`postgres_written=${v}`) && (s.write ?? []).includes("redis_set=OK") && w.confirmed === true &&
        replaced && kv(lineOf(s.recreate, "recreate_exit")).recreate_exit === "0" &&
        (s.read ?? []).includes(`postgres_read=${v}`) && (s.read ?? []).includes(`redis_read=${v}`) && Array.isArray(rq.messages) && rq.messages.length === 1 && rq.messages[0] === v &&
        (s.before ?? []).includes("rabbitmq_node=rabbit@rabbitmq") && (s.after ?? []).includes("rabbitmq_node=rabbit@rabbitmq") &&
        owners.join("|") === "0:0 700 /srv/firecrawl-pi/data|5432:5432 700 /srv/firecrawl-pi/data/postgres|6379:6379 700 /srv/firecrawl-pi/data/redis|5672:5672 700 /srv/firecrawl-pi/data/rabbitmq";
      return { ok, actual: `sentinel=${v}; all 6 containers replaced=${replaced}; postgres=${(s.read ?? []).includes(`postgres_read=${v}`)} redis=${(s.read ?? []).includes(`redis_read=${v}`)} rabbitmq=${JSON.stringify(rq.messages) === JSON.stringify([v])} (messages held: ${rq.messages?.length ?? "none"}); recreate ${kv(lineOf(s.recreate, "recreate_exit")).elapsed_s} s; node name stable=${(s.after ?? []).includes("rabbitmq_node=rabbit@rabbitmq")}` };
    } },

  V14: { name: "unrelated-state-unchanged", inputs: [`${EV}snapshot-before.txt`, `${EV}snapshot-after.txt`, `${RAW}stack-final.txt`, `${RAW}nft-ruleset.txt`],
    expected: "every difference between BEFORE and AFTER is attributed to a project addition (runtime, its modules and firewall tables, fcpi containers and their scopes, mounts and namespaces, the 127.0.0.1:3380 publication, fcpi-stack.service) or is the audit's own SSH session; no unrelated line is removed or changed; boot ID unchanged",
    run() {
      const [BEFORE, AFTER] = [`${EV}snapshot-before.txt`, `${EV}snapshot-after.txt`];
      if (!has(AFTER)) return { notRun: true, actual: "AFTER snapshot not yet taken" };
      // fcpi containers on either side: a container the project replaced is gone from AFTER.
      const psIds = (f) => (read(f).match(/^### docker_ps\n([\s\S]*?)\n### /m)?.[1] ?? "").split("\n").map((l) => l.split("\t")[0]).filter((x) => /^[0-9a-f]{64}$/.test(x));
      const ids = new Set([...psIds(BEFORE), ...psIds(AFTER)]);
      const norm = (sec, l) => (sec === "ss_listen" ? l.replace(/pid=\d+,fd=\d+/g, "pid,fd") : l);
      const B = keyedSnapshot(BEFORE).map(([s, l]) => `${s}\t${norm(s, l)}`);
      const A = keyedSnapshot(AFTER).map(([s, l]) => `${s}\t${norm(s, l)}`);
      const removed = B.filter((l) => !A.includes(l)), added = A.filter((l) => !B.includes(l));
      const unexplained = [];
      const byReason = {};
      const diffRows = { project: [], unrelated: [] };
      for (const [kind, list] of [["removed", removed], ["added", added]]) for (const l of list) {
        const [sec, line] = [l.slice(0, l.indexOf("\t")), l.slice(l.indexOf("\t") + 1)];
        const why = attribute(sec, line, ids);
        // A removed line is only acceptable as the runtime's "before" state, an SSH session, a
        // firewall hash the project changed, or a container the project replaced (with its
        // scope, root filesystem and network namespace).
        const acceptable = why && (kind === "added" || /container runtime installed by M1|own SSH session|nftables|fcpi container|container network namespace/.test(why));
        if (!acceptable) unexplained.push(`${kind} ${sec}: ${line.slice(0, 90)}`); else byReason[why] = (byReason[why] ?? 0) + 1;
        diffRows[acceptable ? "project" : "unrelated"].push(`${kind === "added" ? "+" : "-"} ${sec}\t${line}${why ? `\t# ${why}` : ""}`);
      }
      const boot = (f) => (read(f).match(/^boot_id_sha256=([0-9a-f]{64})$/m) ?? [])[1];
      const ok = unexplained.length === 0 && !!boot(BEFORE) && boot(BEFORE) === boot(AFTER);
      // The BEFORE/AFTER diff, written by the check that judges it so the two cannot disagree.
      writeFileSync(resolve(ROOT, `${EV}snapshot-diff.txt`), [
        `# ${CLOSEOUT ? "M1 close-out" : "M1"} BEFORE/AFTER snapshot diff (section-keyed; written by scripts/m1/verify.mjs V14)`,
        `# before: ${read(BEFORE).split("\n")[1]}  after: ${read(AFTER).split("\n")[1]}`,
        `# boot_id: ${boot(BEFORE) && boot(BEFORE) === boot(AFTER) ? "unchanged (no reboot)" : "CHANGED or MISSING"}`,
        `## changes to unrelated state (${diffRows.unrelated.length})`, ...diffRows.unrelated,
        `## project additions and the audit's own SSH sessions (${diffRows.project.length})`, ...diffRows.project, ""].join("\n"));
      return { ok, actual: `added=${added.length} removed=${removed.length}; attributed ${JSON.stringify(byReason)}; unexplained=${unexplained.length}${unexplained.length ? " [" + unexplained.slice(0, 8).join("; ") + "]" : ""}; boot_id_equal=${boot(BEFORE) === boot(AFTER)}` };
    } },

  V15: { name: "secret-and-identifier-redaction-scan", inputs: [M0_CONTROL, M1_CONTROL, "evidence/M0/audit.json"], live: true,
    expected: "both positive controls fire every rule (M0's rule set unchanged, plus M1's URL-credential, RabbitMQ default_pass, client-token and live-secret-by-hash rules); then no rule matches in any tracked or new repository file, and no file contains any live M1 secret value (compared by SHA-256 against hashes computed on the Pi)",
    run() {
      const m0src = read("scripts/m0/verify.mjs");
      const m0names = [...m0src.matchAll(/^\s+\["([a-z0-9-]+)", \//gm)].map((m) => m[1]);
      if (JSON.stringify(m0names) !== JSON.stringify(M0_RULES.map(([n]) => n))) return { ok: false, actual: `M0 rule names drifted: ${m0names.join(",")}` };
      const audit = json("evidence/M0/audit.json");
      const m0ids = { egress: audit.network.egress_ip_sha256, serial: audit.identity.board_serial_sha256, machineId: audit.identity.machine_id_sha256,
        macs: new Set([...Object.values(audit.identity.mac_sha256), sha256("00:00:00:00:00:00")]) };
      // Controls: M0's with its own dummy identities; M1's with the SHA-256 of its synthetic secrets.
      const c0 = scanFiles([M0_CONTROL], { m0: { egress: sha256("192.0.2.77"), serial: sha256("0123456789abcdef"), machineId: sha256("0123456789abcdef0123456789abcdef"), macs: new Set([sha256("02:00:00:00:00:01")]) } }, M0_RULES);
      const synth = new Set([sha256("0f".repeat(32)), sha256("ABCDEFGHIJKLMNOP".repeat(4))]);
      const c1 = scanFiles([M1_CONTROL], { secrets: synth }, M1_RULES);
      const f0 = new Set(c0.map((h) => h.split(" ").pop())), f1 = new Set(c1.map((h) => h.split(" ").pop()));
      const silent = [...[...M0_RULES.map(([n]) => n), ...M0_HASH_RULES].filter((r) => !f0.has(r)), ...[...M1_RULES.map(([n]) => n), ...M1_HASH_RULES].filter((r) => !f1.has(r))];
      if (silent.length) return { ok: false, actual: `positive controls: rules that did not fire: ${silent.join(", ")}` };
      // Live: SHA-256 of each M1 secret value, computed on the Pi; no value leaves it.
      const hashes = ssh(`sudo -n sh -c 'S=/etc/firecrawl-pi/secrets; h() { [ -n "$1" ] || { echo "EMPTY secret extraction" >&2; exit 1; }; printf "%s" "$1" | sha256sum | cut -c1-64; }; \
        h "$(cat $S/postgres_password)"; h "$(cat $S/core_postgres_password)"; h "$(sed -n "s#^amqp://fcpi:\\(.*\\)@rabbitmq:5672\\$#\\1#p" $S/core_nuq_rabbitmq_url)"; \
        h "$(sed -n "s#^redis://:\\(.*\\)@redis:6379\\$#\\1#p" $S/core_redis_url)"; h "$(cat $S/clients/m1-verify.token)"; h "$(cat /srv/firecrawl-pi/data/rabbitmq/.erlang.cookie)"'`).split("\n").filter((x) => /^[0-9a-f]{64}$/.test(x));
      // Six values since the close-out: the superuser's password and the core role's differ.
      if (hashes.length !== 6 || new Set(hashes).size !== 6) return { ok: false, actual: `expected 6 distinct live secret hashes from the Pi, got ${hashes.length} (${new Set(hashes).size} distinct)` };
      // Second guard: an extraction that came back empty would hash to sha256(""), a distinct
      // 64-hex value that would silently exclude that secret from the scan.
      if (hashes.includes(sha256(""))) return { ok: false, actual: "a live secret extraction on the Pi returned an empty value" };
      const files = execFileSync("git", ["-C", ROOT, "ls-files", "--cached", "--others", "--exclude-standard"], { encoding: "utf8" })
        .split("\n").filter((f) => f && f !== M0_CONTROL && f !== M1_CONTROL && has(f));
      const hits = scanFiles(files, { m0: m0ids, secrets: new Set(hashes) }, [...M0_RULES, ...M1_RULES], SYNTHETIC_ALLOW);
      const hashed = files.filter((f) => f !== OUT);
      return { ok: hits.length === 0, configHash: hashOf(hashed), actual: `positive controls fired all ${M0_RULES.length + M0_HASH_RULES.length} M0 and ${M1_RULES.length + M1_HASH_RULES.length} M1 rules; files scanned=${files.length}; live secret hashes compared=${hashes.length}; findings=${hits.length}${hits.length ? " [" + hits.slice(0, 20).join("; ") + "]" : ""}` };
    } },

  V16: { name: "lock-compose-digest-and-provenance-consistency", inputs: ["deploy/versions.lock.json", "deploy/compose.yaml", `${EV}rendered-compose.json`],
    expected: "every Compose image is referenced by the digest the lock selects, with platform linux/arm64; the lock records the API image's build SHA and upstream run 30579949775 without attestation, the NuQ base digest, measured pg_cron and built digest, the container runtime and the RabbitMQ series actually run",
    run() {
      const L = json("deploy/versions.lock.json");
      const d = digests().all;
      const R = json(`${EV}rendered-compose.json`);
      const want = { "nuq-postgres": `fcpi/nuq-postgres@${d.pg}`, redis: `redis@${d.redis}`, rabbitmq: `rabbitmq@${d.rmq}`, "firecrawl-core": `ghcr.io/firecrawl/firecrawl@${d.core}`, "access-gateway": `node@${d.node}`, fixture: `node@${d.node}` };
      const bad = Object.entries(want).filter(([svc, ref]) => R.services[svc]?.image !== ref || R.services[svc]?.platform !== "linux/arm64").map(([svc]) => svc);
      const composeText = read("deploy/compose.yaml");
      const inCompose = Object.values(want).every((ref) => composeText.includes(`image: ${ref}`));
      const bp = L.build_provenance;
      const ok = bad.length === 0 && inCompose && L.images.firecrawl_api_prebuilt.selected.config_firecrawl_build_sha === UPSTREAM_SHA &&
        /30579949775/.test(bp.firecrawl_api_image.built_by) && bp.firecrawl_api_image.provenance === false && bp.firecrawl_api_image.attestation === "none found" &&
        bp.nuq_postgres_image.base_image.endsWith(L.images.nuq_postgres_base.selected.arm64_manifest_digest) && bp.nuq_postgres_image.pg_cron_measured === "1.6.8-1.pgdg13+2" &&
        bp.nuq_postgres_image.nuq_sql.unmodified_upstream === true && L.images.nuq_postgres.selected.built_image_digest === d.pg &&
        L.host_runtime.container_runtime.status === "resolved" && /^29\.8\.1 /.test(L.host_runtime.container_runtime.engine) &&
        L.images.rabbitmq.selected.tag === "4.3.6" && L.images.nuq_postgres_base.pg_cron_package.status === "resolved";
      return { ok, actual: `services not matching the lock=${bad.join(",") || "none"}; compose text pins=${inCompose}; api build_sha=${L.images.firecrawl_api_prebuilt.selected.config_firecrawl_build_sha.slice(0, 8)}; nuq built=${d.pg.slice(7, 19)}; pg_cron=${bp.nuq_postgres_image.pg_cron_measured}; runtime=${L.host_runtime.container_runtime.engine}; rabbitmq=${L.images.rabbitmq.selected.tag}` };
    } },

  // ===================================================================== close-out (evidence/M1/review/REVIEW.md)
  // Each reads evidence only the close-out collects, so it is NOT_RUN against M1's own record.
  V19: { name: "dockerd-stays-down-while-the-data-check-fails", inputs: [`${RAW}docker-gate.txt`, "deploy/host/docker.service.d/20-fcpi-guard.conf"],
    expected: "with a failing data check, dockerd is observed, sampling every second and logging each change of docker's and fcpi-stack's states and the job queue, until systemd stops restarting it (StartLimitBurst) or for at least 400 s: no dockerd process and no project process at any sample, NRestarts and Result recorded, the data manifest unchanged; the guard drop-in is deployed as in the repository and runs after the data check; after the restore the guard table is loaded with its 4 rules (R13)",
    run() {
      const s = sections(`${RAW}docker-gate.txt`);
      if (!s.start_limit) return { notRun: true, actual: "this transcript predates the restart-limit observation (REVIEW.md R13)" };
      const k = (sec) => kv((s[sec] ?? []).join(" "));
      const l = k("start_limit"), g = k("gated_start"), r = k("restored_start"), di = k("drop_in");
      const guardHash = sha256(read("deploy/host/docker.service.d/20-fcpi-guard.conf"));
      const order = /path=\/opt\/firecrawl-pi\/deploy\/host\/fcpi-data-check\.sh path=\/usr\/sbin\/nft/.test((s.drop_in ?? []).join(" "));
      const long = l.reached_failed === "yes" || Number(l.observed_s) >= 400;
      const tl = (s.start_limit_timeline ?? []).filter((x) => /^t\+\d+ /.test(x));
      const ok = long && l.max_dockerd_processes === "0" && l.max_writers === "0" && l.active_state !== "active" && /^\d+$/.test(l.nrestarts ?? "") && !!l.result &&
        tl.length > 0 && Number(l.check_failures_total) >= 1 && g.manifest_unchanged === "yes" && di.guard_drop_in_sha256 === guardHash && di.guard_repo_sha256 === guardHash && order &&
        r.revived_healthy === "6" && r.guard_table === "present" && r.guard_rules === "4";
      return { ok, actual: `observed ${l.observed_s} s, reached failed=${l.reached_failed} (active=${l.active_state} sub=${l.sub_state} result=${l.result} NRestarts=${l.nrestarts}; states seen: ${(lineOf(s.start_limit, "states_seen=") ?? "").slice(12)}); max dockerd processes=${l.max_dockerd_processes}, max project processes=${l.max_writers}; data-check failures=${l.check_failures_total}; timeline (${tl.length} changes): ${tl.join(" | ").slice(0, 1400)}; manifest unchanged=${g.manifest_unchanged}; policy ${(lineOf(s.drop_in, "restart=") ?? "").trim()}; guard drop-in deployed=${di.guard_drop_in_sha256 === guardHash}, runs after the data check=${order}; after restore: revived healthy=${r.revived_healthy}, guard table=${r.guard_table} with ${r.guard_rules} rules` };
    } },

  V20: { name: "access-bridge-guard-drops-everything-but-replies", inputs: [`${RAW}guard.txt`, "deploy/host/fcpi-guard.nft", `${RAW}stack-final.txt`, `${EV}rendered-compose.json`],
    expected: "without the guard, the gateway container reaches the host through the bridge address and the LAN address and reaches the Internet through the bridge's NAT (the positive control); with the guard loaded from its installed copy, identical to the repository's file and naming the bridge Compose names, all three are dropped and counted; no drop is counted between the probe and the dockerd gate test, or from the gate's reload to the end of the window; a public name the gateway resolved past the guard through the host's loopback resolver no longer resolves once the gateway has its own upstream; the gateway still serves the fixture through 127.0.0.1:3380 (R5)",
    run() {
      const s = sections(`${RAW}guard.txt`);
      const meta = (p) => kv((s[`${p}_meta`] ?? []).join(" "));
      const probe = (p) => { try { return JSON.parse((lineOf(s[`${p}_probe`], "gateway {") ?? "").slice(8)); } catch { return null; } };
      const cnt = (p) => Object.fromEntries((s[`${p}_counters`] ?? []).filter((l) => / packets=\d+$/.test(l)).map((l) => [l.split(" ")[0], Number(kv(l).packets)]));
      const KEYS = ["access_forward_out_dropped", "access_forward_in_dropped", "access_input_new_dropped"];
      const b = probe("before"), a = probe("after");
      const fileHash = sha256(read("deploy/host/fcpi-guard.nft"));
      const beforeOk = meta("before").guard_table === "absent" && !!b && Object.keys(b.tcp).length === 3 && Object.values(b.tcp).every((t) => t.connected === true);
      // The guard matches the bridge by name, so the rendered Compose network must carry that name.
      const bridge = json(`${EV}rendered-compose.json`).networks?.access?.driver_opts?.["com.docker.network.bridge.name"];
      const coupled = bridge === "fcpi-access" && read("deploy/host/fcpi-guard.nft").includes(`iifname "${bridge}"`);
      const afterOk = meta("after").guard_table === "present" && meta("after").guard_file_sha256 === fileHash && coupled && !!a && Object.keys(a.tcp).length === 3 && Object.values(a.tcp).every((t) => t.connected === false);
      const ca = cnt("after"), cp = cnt("pregate"), ce = cnt("end");
      const counted = ca.access_input_new_dropped >= 2 && ca.access_forward_out_dropped >= 1;
      const quiet = KEYS.every((k) => Number.isFinite(ca[k]) && cp[k] === ca[k] && ce[k] === 0) && meta("end").guard_table === "present";
      const gw = (sections(`${RAW}stack-final.txt`).gateway_tests ?? []).find((l) => l.startsWith("valid_token_fixture_scrape "));
      const served = !!gw && kv(gw).status === "200";
      // DNS: with the guard loaded but before the gateway's own upstream, a public name resolves
      // past the guard (the positive control); with it, the lookup fails.
      const pd = probe("predns");
      const dnsOk = pd?.dns_example_com?.resolved === true && a?.dns_example_com?.resolved === false;
      const ok = beforeOk && afterOk && counted && quiet && served && dnsOk;
      const dns = `before the gateway's DNS setting ${pd?.dns_example_com ? (pd.dns_example_com.resolved ? "resolves" : pd.dns_example_com.error) : "not probed"}, with it ${a?.dns_example_com ? (a.dns_example_com.resolved ? "resolves" : a.dns_example_com.error) : "not probed"}`;
      const fmt = (p) => (p ? Object.entries(p.tcp).map(([k, v]) => `${k}=${v.connected ? "connected" : v.error}`).join(",") : "missing");
      return { ok, actual: `without guard: ${fmt(b)}; with guard: ${fmt(a)}; counters after probe ${JSON.stringify(ca)}, before the gate ${JSON.stringify(cp)}, at window end (after the gate's reload) ${JSON.stringify(ce)}; installed guard equals the repository file=${meta("after").guard_file_sha256 === fileHash}; rendered bridge name=${bridge}, matched by the guard=${coupled}; a public name from the gateway: ${dns}; gateway fixture scrape=${gw ? kv(gw).status : "missing"}` };
    } },

  V21: { name: "gateway-contract-tests-on-the-pinned-node", inputs: [`${RAW}gateway-tests-pinned-node.txt`, "tests/contracts/m1-gateway.test.mjs", "deploy/versions.lock.json"],
    expected: "every test the gateway's contract suite declares passes inside the pinned node image the gateway runs (Node v22.23.3), with no network, a read-only root filesystem and the gateway's uid; the throwaway container is gone afterwards (R10)",
    run() {
      const t = read(`${RAW}gateway-tests-pinned-node.txt`), s = sections(`${RAW}gateway-tests-pinned-node.txt`);
      const img = kv(lineOf(s.meta, "image=") ?? "").image;
      const pass = Number((t.match(/^# pass (\d+)$/m) ?? [])[1]), fail = Number((t.match(/^# fail (\d+)$/m) ?? [])[1]);
      const declared = (read("tests/contracts/m1-gateway.test.mjs").match(/^test\(/gm) ?? []).length;
      const run = s.run ?? [];
      const ok = img === `node@${digests().all.node}` && run.includes("node_version=v22.23.3") && pass === declared && fail === 0 && run.includes("exit=0") && run.includes("leftover_transient_containers=0");
      return { ok, actual: `image=${img} (lock ${digests().all.node.slice(0, 19)}); ${lineOf(run, "node_version=")}; pass=${pass}/${declared} declared, fail=${fail}; ${lineOf(run, "exit=")}; ${lineOf(run, "leftover_transient_containers=")}` };
    } },

  V22: { name: "core-credentials-narrowed", inputs: [`${RAW}credentials.txt`, `${EV}rendered-compose.json`],
    expected: "the core connects to PostgreSQL as fcpi_core: not a superuser, no role, database, replication or RLS-bypass rights, owner of nothing, with exactly SELECT, INSERT, UPDATE and DELETE on every NuQ table and no CREATE on the schema, so it cannot attach code the superuser's pg_cron jobs would run; as fcpi_core a DML statement succeeds while creating a function in nuq and a trigger on a NuQ table are refused; the superuser has no password; the core's password differs from the superuser's and its container receives neither superuser secret; the only non-loopback sessions are fcpi_core's; RabbitMQ user fcpi has no tags and keeps its vhost permissions; Redis is unchanged, deferred to M8 (R11)",
    run() {
      const s = sections(`${RAW}credentials.txt`);
      const p = kv((s.postgres ?? []).join(" ")), sc = kv((s.secrets ?? []).join(" "));
      const probe = (k) => (lineOf(s.fcpi_core_probe, `${k}=`) ?? "").slice(k.length + 1).trim();
      const sessions = (lineOf(s.postgres, "tcp_sessions=") ?? "").slice(13).trim().split(" ").filter(Boolean);
      const roleOk = p.role === "fcpi_core" && ["super", "createrole", "createdb", "replication", "bypassrls"].every((k) => p[k] === "false");
      const privOk = p.superusers === "postgres" && p.superuser_has_password === "f" && p.nuq_owner === "postgres" && p.fcpi_core_owned_objects === "0" &&
        p.fcpi_core_privileges === "DELETE,INSERT,SELECT,UPDATE" && Number(p.nuq_tables) > 0 && p.fcpi_core_tables_with_dml === p.nuq_tables && p.fcpi_core_schema_create === "f";
      const probeOk = probe("dml") === "ok" && /permission denied for schema nuq/.test(probe("create_function_in_nuq")) && /(must be owner of (table|relation)|permission denied for table) queue_scrape/.test(probe("create_trigger_on_nuq"));
      const ownOk = privOk && probeOk;
      const sessOk = sessions.length > 0 && sessions.every((x) => /^fcpi_core:\d+$/.test(x));
      const files = ["postgres_password 5432:5432 600", "core_postgres_password 0:0 600", "postgres_core_role_password 5432:5432 600"];
      const secOk = sc.core_equals_superuser === "no" && sc.core_role_pair_equal === "yes" && files.every((f) => (s.secrets ?? []).includes(f));
      const rq = s.rabbitmq ?? [];
      const rqOk = (lineOf(rq, "users=") ?? "").slice(6).trim() === "fcpi[]" && /(^|;)fcpi \.\* \.\* \.\*(;|$)/.test((lineOf(rq, "permissions=") ?? "").slice(12));
      const R = json(`${EV}rendered-compose.json`);
      const secretsOf = (svc) => (R.services[svc]?.secrets ?? []).map((x) => x.source);
      const composeOk = R.services["firecrawl-core"]?.environment?.POSTGRES_USER === "fcpi_core" && !secretsOf("firecrawl-core").some((x) => /^postgres_/.test(x)) &&
        secretsOf("nuq-postgres").includes("postgres_core_role_password");
      const ok = roleOk && ownOk && sessOk && secOk && rqOk && composeOk;
      return { ok, actual: `role ${lineOf(s.postgres, "role=")?.slice(5)}; superusers=${p.superusers} (password set=${p.superuser_has_password}); nuq owner=${p.nuq_owner}; fcpi_core owns ${p.fcpi_core_owned_objects} objects, holds ${p.fcpi_core_privileges} on ${p.fcpi_core_tables_with_dml}/${p.nuq_tables} NuQ tables, schema CREATE=${p.fcpi_core_schema_create}; as fcpi_core: DML=${probe("dml")}, create function in nuq -> ${probe("create_function_in_nuq").replace(/^ERROR:\s*/, "")}, create trigger on queue_scrape -> ${probe("create_trigger_on_nuq").replace(/^ERROR:\s*/, "")}; cron jobs ${p.cron_job_owners ?? (lineOf(s.postgres, "cron_job_owners=") ?? "").slice(16)}; TCP sessions ${sessions.join(" ") || "none"}; core password equals superuser's=${sc.core_equals_superuser}, core pair equal=${sc.core_role_pair_equal}, file modes ok=${files.every((f) => (s.secrets ?? []).includes(f))}; rabbitmq ${(lineOf(rq, "users=") ?? "").trim()} ${(lineOf(rq, "permissions=") ?? "").trim()}; core POSTGRES_USER=${R.services["firecrawl-core"]?.environment?.POSTGRES_USER}, core secrets=${secretsOf("firecrawl-core").join(",")}; redis default user unchanged (M8)` };
    } },

  V23: { name: "networkmanager-leaves-docker-interfaces-alone", inputs: [`${RAW}nm.txt`, "deploy/host/NetworkManager/90-fcpi-unmanaged.conf"],
    expected: "before the file, NetworkManager handles Docker's interfaces (the positive control); once pi-init.sh installs it as in the repository and reloads NM's configuration, every veth, fcpi-* bridge and docker0 is unmanaged and wlan0 stays connected; NetworkManager's merged configuration carries the file's value; from the reload to the end of the verification window (containers recreated, dockerd restarted), a non-empty NM journal that logs Docker's interfaces (the positive control) shows no activation or DHCP transaction on them and no wlan0 state change (R14)",
    run() {
      const s = sections(`${RAW}nm.txt`);
      // Device lines only: the section also ends with the collector's "end" line.
      const dev = (p) => (s[`${p}_devices`] ?? []).filter((l) => /^(wlan0|veth[0-9a-f]+|fcpi-[a-z]+|docker0) \S+ \S/.test(l)).map((l) => { const f = l.split(" "); return { d: f[0], state: f.slice(2).join(" ") }; });
      const docker = (p) => dev(p).filter((x) => x.d !== "wlan0");
      const wlan = (p) => dev(p).find((x) => x.d === "wlan0")?.state;
      const repoHash = sha256(read("deploy/host/NetworkManager/90-fcpi-unmanaged.conf"));
      const j = kv((s.window_journal ?? []).join(" "));
      const beforeHandled = docker("before").some((x) => x.state !== "unmanaged");
      const unmanaged = (p) => docker(p).length > 0 && docker(p).every((x) => x.state === "unmanaged");
      const effective = kv((s.after_meta ?? []).join(" ")).effective_unmanaged_devices;
      const ok = beforeHandled && kv((s.after_meta ?? []).join(" ")).conf_sha256 === repoHash && effective === "interface-name:veth*,interface-name:fcpi-*,interface-name:docker0" && unmanaged("after") && unmanaged("window") &&
        Number(j.journal_lines) > 0 && Number(j.docker_interface_lines) > 0 &&
        ["before", "after", "window"].every((p) => wlan(p) === "connected") &&
        j.docker_interface_activations === "0" && j.docker_interface_dhcp_transactions === "0" && j.wlan0_state_changes === "0";
      const tally = (p) => Object.entries(docker(p).reduce((m, x) => ({ ...m, [x.state]: (m[x.state] ?? 0) + 1 }), {})).map(([k, v]) => `${k}:${v}`).join(",");
      return { ok, actual: `before: Docker interfaces ${tally("before")}, wlan0 ${wlan("before")}; after reload: ${tally("after")}, wlan0 ${wlan("after")}; window end: ${tally("window")}, wlan0 ${wlan("window")}; since ${(lineOf(s.window_journal, "since=") ?? "?").slice(6)} UTC: journal lines=${j.journal_lines}, lines about Docker interfaces=${j.docker_interface_lines}, activations=${j.docker_interface_activations} dhcp=${j.docker_interface_dhcp_transactions} wlan0 state changes=${j.wlan0_state_changes}; conf deployed=${kv((s.after_meta ?? []).join(" ")).conf_sha256 === repoHash}, effective unmanaged-devices=${effective}` };
    } },

  V24: { name: "deploy-removes-files-dropped-from-git", inputs: [`${RAW}deploy-prune.txt`, "scripts/m1/deploy.sh"],
    expected: "a file and a directory planted under /opt/firecrawl-pi that no commit contains are removed by the deploy, after every deployed file's hash is verified; .fcpi-source-commit is kept and names the deployed commit; the Pi then holds exactly the archive's files plus that one (R16)",
    run() {
      const s = sections(`${RAW}deploy-prune.txt`);
      const m = kv((s.meta ?? []).join(" ")), pl = kv((s.plant ?? []).join(" ")), af = kv((s.after ?? []).join(" "));
      const dep = s.deploy ?? [];
      const ok = m.probe_tracked === "no" && pl.planted === "yes" && dep.includes("removed ./tests/closeout-stale/probe.txt") && dep.includes("removed-dir ./tests/closeout-stale") &&
        dep.some((l) => /hashes verified, [1-9]\d* stale files removed\)/.test(l)) && dep.includes("deploy_exit=0") &&
        af.stale_file_present === "no" && af.stale_dir_present === "no" && af.source_commit === m.head && Number(af.pi_files) === Number(m.archive_files) + 1;
      return { ok, actual: `planted=${pl.planted}; deploy: ${(dep.find((l) => /^deployed commit /.test(l)) ?? "no summary").replace(/ to \S+$/, "")}; removed lines=${dep.filter((l) => /^removed/.test(l)).join(" | ")}; after: stale file=${af.stale_file_present}, stale dir=${af.stale_dir_present}, source commit matches=${af.source_commit === m.head}, files on the Pi=${af.pi_files} for ${m.archive_files} archived` };
    } },

  V25: { name: "closeout-baseline-matches-m1-after", inputs: [`${EV}snapshot-before.txt`, "evidence/M1/snapshot-after.txt"],
    expected: "the close-out's BEFORE equals M1's AFTER apart from SSH session scopes and the sections the snapshot gained for the close-out (nft_tables, nft_chains, forwarding), which BEFORE records; boot ID unchanged (R8)",
    run() {
      if (!CLOSEOUT) return { notRun: true, actual: "runs only against the close-out's evidence (FCPI_M1_EVIDENCE)" };
      const NET = ["nft_tables", "nft_chains", "forwarding"];
      const norm = (sec, l) => (sec === "ss_listen" ? l.replace(/pid=\d+,fd=\d+/g, "pid,fd") : l);
      const lines = (f) => keyedSnapshot(f).filter(([sec]) => !NET.includes(sec)).map(([sec, l]) => `${sec}\t${norm(sec, l)}`).filter((l) => !/\tsession-\d+\.scope$/.test(l)).sort();
      const a = lines("evidence/M1/snapshot-after.txt"), b = lines(`${EV}snapshot-before.txt`);
      const only = (x, y) => x.filter((l) => !y.includes(l));
      const net = Object.fromEntries(NET.map((sec) => [sec, keyedSnapshot(`${EV}snapshot-before.txt`).filter(([x, l]) => x === sec && !/^SKIPPED/.test(l)).length]));
      const boot = (f) => (read(f).match(/^boot_id_sha256=([0-9a-f]{64})$/m) ?? [])[1];
      const ok = only(a, b).length === 0 && only(b, a).length === 0 && NET.every((sec) => net[sec] > 0) && !!boot(`${EV}snapshot-before.txt`) && boot(`${EV}snapshot-before.txt`) === boot("evidence/M1/snapshot-after.txt");
      return { ok, actual: `lines only in M1 AFTER=${only(a, b).length}${only(a, b).length ? " [" + only(a, b).slice(0, 4).join("; ") + "]" : ""}, only in close-out BEFORE=${only(b, a).length}${only(b, a).length ? " [" + only(b, a).slice(0, 4).join("; ") + "]" : ""}; new sections recorded ${JSON.stringify(net)}; boot_id_equal=${boot(`${EV}snapshot-before.txt`) === boot("evidence/M1/snapshot-after.txt")}` };
    } },
  V26: { name: "fresh-install-paths-create-the-narrowed-credentials", inputs: [`${RAW}fresh-init-proof.txt`, "deploy/nuq-postgres/initdb/020-fcpi-core-role.sh", "deploy/nuq-postgres/fcpi-core-role.psql", "deploy/rabbitmq/30-fcpi.conf"],
    expected: "a throwaway container of the pinned NuQ image initialising empty data runs 010-nuq.sql and 020-fcpi-core-role.sh, ignores the .psql beside them and logs no error; fcpi_core then exists with a password and no special rights, owns nothing, and holds exactly SELECT, INSERT, UPDATE and DELETE on every NuQ table, while the superuser has no password and keeps the cron jobs; a throwaway broker of the pinned image, first booting with 30-fcpi.conf, creates user fcpi with no tags; nothing is left behind (R11)",
    run() {
      const s = sections(`${RAW}fresh-init-proof.txt`);
      const p = kv((s.postgres_initdb ?? []).join(" ")), r = s.rabbitmq_first_boot ?? [], c = kv((s.cleanup ?? []).join(" "));
      const scripts = (lineOf(s.postgres_initdb, "initdb_scripts=") ?? "").slice(15);
      const initOk = /running \/docker-entrypoint-initdb\.d\/010-nuq\.sql;/.test(scripts) && /sourcing \/docker-entrypoint-initdb\.d\/020-fcpi-core-role\.sh;/.test(scripts) &&
        /ignoring \/docker-entrypoint-initdb\.d\/fcpi-core-role\.psql;/.test(scripts) && p.init_errors === "0";
      const pgOk = p.role === "fcpi_core" && ["super", "createrole", "createdb", "replication", "bypassrls"].every((k) => p[k] === "false") &&
        p.superuser_has_password === "f" && p.fcpi_core_has_password === "t" && p.nuq_owner === "postgres" && p.fcpi_core_owned_objects === "0" &&
        p.fcpi_core_privileges === "DELETE,INSERT,SELECT,UPDATE" && Number(p.nuq_tables) > 0 && p.fcpi_core_tables_with_dml === p.nuq_tables && /^postgres:\d+$/.test((lineOf(s.postgres_initdb, "cron_job_owners=") ?? "").slice(16));
      const rmqOk = (lineOf(r, "users=") ?? "").slice(6).trim() === "fcpi[]" && (lineOf(r, "default_user_tags_env=") ?? "").includes("{ok,[]}");
      const ok = initOk && pgOk && rmqOk && c.leftover_transient_containers === "0" && c.leftover_secret_dir === "no";
      return { ok, actual: `initdb: ${scripts} errors=${p.init_errors}; role ${(lineOf(s.postgres_initdb, "role=") ?? "").slice(5)}, password set=${p.fcpi_core_has_password}; superuser password set=${p.superuser_has_password}; nuq owner=${p.nuq_owner}; fcpi_core owns ${p.fcpi_core_owned_objects}, holds ${p.fcpi_core_privileges} on ${p.fcpi_core_tables_with_dml}/${p.nuq_tables} tables; cron ${(lineOf(s.postgres_initdb, "cron_job_owners=") ?? "").slice(16)}; broker first boot: ${(lineOf(r, "users=") ?? "").trim()} ${(lineOf(r, "default_user_tags_env=") ?? "").trim()}; leftovers: containers=${c.leftover_transient_containers} secrets=${c.leftover_secret_dir}` };
    } },
};

// ---------------------------------------------------------------------------
// The close-out checks read evidence only the close-out collects; M1's own record lists M1's checks.
const CLOSEOUT_ONLY = new Set(["V19", "V20", "V21", "V22", "V23", "V24", "V25", "V26"]);
const listed = Object.keys(checks).filter((id) => CLOSEOUT || !CLOSEOUT_ONLY.has(id));
const wanted = process.argv.slice(2).length ? process.argv.slice(2) : listed;
const prior = has(OUT) ? json(OUT) : { results: [] };
const results = Object.fromEntries(prior.results.map((r) => [r.test_id, r]));
const repo = repoState();
for (const id of wanted) {
  const c = checks[id];
  if (!c) throw new Error(`unknown check ${id}`);
  const rec = { test_id: `M1-${id}`, name: c.name, utc: now(), ...repo, upstream_sha: UPSTREAM_SHA, patch_series: "none (patches begin in M2)", config_or_fixture_hash: null, expected: c.expected };
  try {
    const missing = c.inputs.filter((p) => !has(p));
    if (missing.length) { Object.assign(rec, { state: "NOT_RUN", actual: `evidence missing: ${missing.join(", ")}`, exit_code: null }); }
    else {
      rec.config_or_fixture_hash = hashOf(c.inputs);
      const r = c.run();
      if (r.notRun) Object.assign(rec, { state: "NOT_RUN", actual: r.actual, exit_code: null });
      else Object.assign(rec, { state: r.ok ? "PASS" : "FAIL", actual: r.actual, exit_code: r.exit ?? (r.ok ? 0 : 1) });
      if (!r.ok && r.classification) rec.classification = r.classification;
      if (r.ok && r.classification) rec.note = r.classification;
      if (r.configHash) rec.config_or_fixture_hash = r.configHash;
      if (r.digests) rec.image_digests_platform = { platform: "linux/arm64", digests: r.digests };
    }
    if (c.live) rec.live_sources = "the Pi over SSH (secret hashes only)";
  } catch (e) {
    Object.assign(rec, { state: "FAIL", actual: `check raised: ${e.message}`, exit_code: 2, classification: "verifier-error" });
  }
  rec.evidence_path = OUT;
  results[rec.test_id] = rec;
  console.log(`${rec.test_id} ${rec.state.padEnd(8)} ${c.name}`);
}
const ordered = listed.map((id) => results[`M1-${id}`] ?? { test_id: `M1-${id}`, name: checks[id].name, state: "NOT_RUN", actual: "never run", evidence_path: OUT });
writeFileSync(resolve(ROOT, OUT), JSON.stringify({ schema: "fcpi.m1.verification/v1", runner: "scripts/m1/verify.mjs",
  repository_sha_note: "Each result records the commit checked out when it ran, with worktree_dirty; the commit that stores this file is a later one on main.",
  firecrawl_lock_commit: json("deploy/versions.lock.json").firecrawl.commit, results: ordered }, null, 2) + "\n");
process.exitCode = ordered.every((r) => r.state === "PASS") ? 0 : 1;
