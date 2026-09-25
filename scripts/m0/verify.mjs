#!/usr/bin/env node
// M0 automated verification. Each check recomputes its result from raw evidence
// or live sources, independently of the builders, and is recorded with the
// CLAUDE.md §25 tuple in evidence/M0/verification.json.
// Usage: node scripts/m0/verify.mjs            (all checks)
//        node scripts/m0/verify.mjs V04 V07    (subset; others keep their last record)
import { readFileSync, writeFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { resolve, relative, join } from "node:path";
import { execFileSync } from "node:child_process";
import { ROOT, sha256, sha256File, repoState, sections } from "./lib.mjs";
import { validate } from "./schema-lite.mjs";

const OUT = "evidence/M0/verification.json";
const UPSTREAM_SHA = "7666c1f9ae8720a6bba271e0f60b6a217f8a5210";
const read = (p) => readFileSync(resolve(ROOT, p), "utf8");
const json = (p) => JSON.parse(read(p));
const now = () => new Date().toISOString().replace(/\.\d+Z$/, "Z");
const hashOf = (paths) => sha256(paths.map((p) => `${p}:${sha256File(p)}`).join("\n"));

const checks = {
  // ---------------------------------------------------------------------
  V01: { name: "audit-schema-completeness", inputs: ["evidence/M0/audit.json", "tests/contracts/m0-audit.schema.json", "evidence/M0/raw/pi-audit-paths.txt"],
    expected: "audit.json validates; all 22 spec §4 fields present as observed or unavailable-with-reason; every cited source file#section exists; missing utilities recorded and confirmed absent by the explicit-PATH probe",
    run() {
      const audit = json("evidence/M0/audit.json");
      const errs = validate(json("tests/contracts/m0-audit.schema.json"), audit);
      const s4 = Object.entries(audit.section4);
      const badSources = [];
      for (const [k, f] of s4) for (const ref of f.sources) {
        const [file, sec] = ref.split("#");
        if (!existsSync(resolve(ROOT, file))) { badSources.push(`${k}: ${file} missing`); continue; }
        if (sec && !(sec in sections(file))) badSources.push(`${k}: ${ref} section missing`);
      }
      const tools = Object.fromEntries(sections("evidence/M0/raw/pi-audit-paths.txt").sbin_tools.filter((l) => l.includes("=")).map((l) => l.split("=")));
      const notAbsent = audit.missing_utilities.filter((t) => tools[t] !== "absent");
      const ok = errs.length === 0 && s4.length === 22 && badSources.length === 0 && notAbsent.length === 0 && audit.missing_utilities.length > 0;
      return { ok, actual: `schema errors=${errs.length}${errs.length ? " [" + errs.slice(0, 5).join("; ") + "]" : ""}; section4 fields=${s4.length} (observed=${s4.filter(([, f]) => f.status === "observed").length}, unavailable=${s4.filter(([, f]) => f.status === "unavailable").length}); unresolved sources=${badSources.length}${badSources.length ? " [" + badSources.join("; ") + "]" : ""}; missing utilities=${audit.missing_utilities.length}, contradicted by probe=${notAbsent.length}; unavailable items with reasons=${audit.unavailable.length}` };
    } },

  // ---------------------------------------------------------------------
  V02: { name: "machine-identity-arm64-userspace", inputs: ["evidence/M0/raw/pi-audit.txt", "evidence/M0/audit.json"],
    expected: "raw model starts 'Raspberry Pi 5 Model B'; hashed serial/machine-id present and equal in audit.json; uname -m=aarch64, dpkg --print-architecture=arm64, getconf LONG_BIT=64",
    run() {
      const s = sections("evidence/M0/raw/pi-audit.txt");
      const kvs = (lines) => Object.fromEntries(lines.filter((l) => l.includes("=")).map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]));
      const id = kvs(s.identity), ar = kvs(s.architecture), h = kvs(s.identity_hashes);
      const audit = json("evidence/M0/audit.json");
      const facts = {
        model: id.model, uname_m: ar.uname_m, dpkg_arch: ar.dpkg_arch, long_bit: ar.long_bit,
        serial_hash_ok: /^[0-9a-f]{64}$/.test(h.board_serial_sha256) && h.board_serial_sha256 === audit.identity.board_serial_sha256,
        machine_id_hash_ok: /^[0-9a-f]{64}$/.test(h.machine_id_sha256) && h.machine_id_sha256 === audit.identity.machine_id_sha256,
        audit_matches_raw: audit.identity.model === id.model && audit.architecture.uname_m === ar.uname_m && audit.architecture.dpkg_architecture === ar.dpkg_arch && audit.architecture.long_bit === Number(ar.long_bit),
      };
      const ok = /^Raspberry Pi 5 Model B/.test(id.model) && ar.uname_m === "aarch64" && ar.dpkg_arch === "arm64" && ar.long_bit === "64" && facts.serial_hash_ok && facts.machine_id_hash_ok && facts.audit_matches_raw;
      return { ok, actual: JSON.stringify(facts) };
    } },

  // ---------------------------------------------------------------------
  V03: { name: "mount-space-inode-resource-arithmetic", inputs: ["evidence/M0/raw/pi-audit.txt", "evidence/M0/audit.json"],
    expected: "root UUID agrees across findmnt, lsblk and dumpe2fs and equals the planned data UUID; free space, inode and memory-fit values recomputed from raw equal audit.json derived values; MemTotal agrees between /proc/meminfo and free -b",
    run() {
      const s = sections("evidence/M0/raw/pi-audit.txt");
      const audit = json("evidence/M0/audit.json");
      // Independent parsing, not lib.mjs helpers.
      const kb = (k) => Number((s.meminfo.find((l) => l.startsWith(k + ":")) || "").replace(/\D+/g, ""));
      const memTotal = kb("MemTotal"), memAvail = kb("MemAvailable");
      const freeB = Number(s.free.find((l) => l.startsWith("Mem:")).trim().split(/\s+/)[1]);
      const fitMiB = { total: memTotal / 1024, avail: memAvail / 1024 };
      const usage = fitMiB.total - fitMiB.avail, required = 6432 + 1024, headroom = fitMiB.avail - required;
      const rootDf = s.df_bytes.map((l) => l.trim().split(/\s+/)).find((f) => f[6] === "/");
      const availB = Number(rootDf[4]);
      const rootInodes = s.df_inodes.map((l) => l.trim().split(/\s+/)).find((f) => f[5] === "/");
      const e2 = (k) => (s.ext4_superblock.find((l) => l.startsWith(k + ":")) || "").split(/:\s+/)[1];
      const uuidFindmnt = s.storage_root[0].trim().split(/\s+/)[4];
      const uuidLsblk = s.lsblk.find((l) => /mmcblk0p2/.test(l) && /ext4/.test(l)).trim().split(/\s+/).find((t) => /^[0-9a-f]{8}-/.test(t));
      const uuidE2 = e2("Filesystem UUID");
      const r2 = (x) => Math.round(x * 100) / 100;
      const d = audit.derived;
      const cmp = {
        memtotal_proc_vs_free: memTotal * 1024 === freeB,
        existing_usage_mib: [r2(usage), d.resource_fit.existing_usage_mib],
        headroom_mib: [r2(headroom), d.resource_fit.headroom_mib],
        fits: [headroom >= 0, d.resource_fit.fits],
        root_avail_bytes: [availB, d.free_space.root_avail_bytes],
        meets_20gib: [availB >= 20 * 1024 ** 3, d.free_space.meets_threshold],
        inodes_free_df_vs_dumpe2fs: [Number(rootInodes[3]), Number(e2("Free inodes"))],
        uuid: [uuidFindmnt, uuidLsblk, uuidE2, audit.plans.storage.data_filesystem_uuid],
        root_source: rootDf[0],
      };
      const eq = (a) => a.every((x) => x === a[0]);
      const ok = cmp.memtotal_proc_vs_free && eq(cmp.existing_usage_mib) && eq(cmp.headroom_mib) && eq(cmp.fits) && eq(cmp.root_avail_bytes) && eq(cmp.meets_20gib) && eq(cmp.inodes_free_df_vs_dumpe2fs) && eq(cmp.uuid);
      return { ok, actual: `MemTotal=${memTotal} kB (${r2(fitMiB.total)} MiB), MemAvailable=${memAvail} kB (${r2(fitMiB.avail)} MiB), existing usage=${r2(usage)} MiB, caps+reserve=${required} MiB, headroom=${r2(headroom)} MiB, fits=${headroom >= 0}; root avail=${availB} B (${r2(availB / 1024 ** 3)} GiB) vs 20 GiB; free inodes=${rootInodes[3]}; comparisons=${JSON.stringify(cmp)}` };
    } },

  // ---------------------------------------------------------------------
  V04: { name: "port-collision-and-network-overlap", inputs: ["evidence/M0/audit.json", "evidence/M0/raw/pi-audit.txt", "evidence/M0/snapshot-before.txt"],
    expected: "no proposed host port matches a listening socket (any address) in the audit or BEFORE snapshot; no duplicate proposal; project-chosen ports outside the ephemeral range; project subnets do not overlap host routes",
    run() {
      const audit = json("evidence/M0/audit.json");
      const listen = new Set();
      for (const l of sections("evidence/M0/raw/pi-audit.txt").listening) { const f = l.trim().split(/\s+/); if (f[4]) listen.add(`${f[0]}/${f[4].slice(f[4].lastIndexOf(":") + 1)}`); }
      for (const l of sections("evidence/M0/snapshot-before.txt").ss_listen) { const f = l.trim().split(/\s+/); if (f[1]) listen.add(`${f[0]}/${f[1].slice(f[1].lastIndexOf(":") + 1)}`); }
      const P = audit.plans.ports;
      const proposed = P.host_published.map((x) => ({ key: `${x.proto}/${x.port}`, ...x }));
      const collisions = proposed.filter((x) => listen.has(x.key)).map((x) => x.key);
      const dupes = proposed.map((x) => x.key).filter((k, i, a) => a.indexOf(k) !== i);
      const [lo, hi] = P.ephemeral_port_range.split(/\s+/).map(Number);
      const inEphemeral = proposed.filter((x) => x.chosen_by === "project" && x.port >= lo && x.port <= hi).map((x) => x.key);
      const nonLoopbackProject = proposed.filter((x) => x.chosen_by === "project" && x.bind !== "127.0.0.1").map((x) => x.key);
      const tailnetCollisions = (P.tailnet_only ?? []).filter((t) => listen.has(`${t.proto}/${t.port}`)).map((t) => `${t.proto}/${t.port} (tailnet; alternative ${t.alternative_port}: ${listen.has(`${t.proto}/${t.alternative_port}`) ? "OCCUPIED" : "free"})`);
      const ip = (a) => a.split(".").reduce((n, o) => n * 256 + Number(o), 0);
      const net = (c) => { const [a, m] = c.split("/"); const size = 2 ** (32 - Number(m)); const base = Math.floor(ip(a) / size) * size; return [base, base + size - 1]; };
      const routes = sections("evidence/M0/raw/pi-audit.txt").network.filter((l) => /^\d+\.\d+\.\d+\.\d+\/\d+ dev/.test(l)).map((l) => l.split(" ")[0]);
      const overlaps = [];
      for (const n of P.docker_networks) for (const r of routes) { const [a1, a2] = net(n.subnet), [b1, b2] = net(r); if (a1 <= b2 && b1 <= a2) overlaps.push(`${n.subnet}~${r}`); }
      const ok = collisions.length === 0 && dupes.length === 0 && inEphemeral.length === 0 && nonLoopbackProject.length === 0 && overlaps.length === 0;
      return { ok, actual: `listening proto/ports=${[...listen].sort().join(",")}; proposed=${proposed.map((x) => `${x.bind}:${x.port}/${x.proto}`).join(",")}; collisions=${collisions.length}; duplicates=${dupes.length}; project ports in ephemeral ${lo}-${hi}=${inEphemeral.length}; project ports not loopback=${nonLoopbackProject.length}; subnet overlaps with routes ${routes.join(",")}=${overlaps.length}; tailnet notes=${tailnetCollisions.join("; ") || "none"}` };
    } },

  // ---------------------------------------------------------------------
  V05: { name: "source-sha-chain", inputs: ["deploy/versions.lock.json"], live: true,
    expected: "live GitHub: refs/tags/v2.11.162 -> annotated tag object ebfe595c... -> commit 7666c1f9...; docker-compose.yaml blob at that commit = e2ade010...; all equal to the lockfile",
    run() {
      const L = json("deploy/versions.lock.json").firecrawl;
      const ls = execFileSync("git", ["ls-remote", L.repository + ".git", `refs/tags/${L.tag}`, `refs/tags/${L.tag}^{}`], { encoding: "utf8" });
      const refObj = (ls.match(new RegExp(`^([0-9a-f]{40})\\s+refs/tags/${L.tag.replace(/\./g, "\\.")}$`, "m")) || [])[1];
      const peeled = (ls.match(/^([0-9a-f]{40})\s+refs\/tags\/\S+\^\{\}$/m) || [])[1];
      const tagObj = JSON.parse(execFileSync("gh", ["api", `repos/firecrawl/firecrawl/git/tags/${L.tag_object}`], { encoding: "utf8" }));
      const blob = JSON.parse(execFileSync("gh", ["api", `repos/firecrawl/firecrawl/contents/docker-compose.yaml?ref=${L.commit}`], { encoding: "utf8" })).sha;
      const facts = { ref_object: refObj, peeled_commit: peeled, tag_object_type: tagObj.object?.type, tag_object_target: tagObj.object?.sha, tag_name: tagObj.tag, compose_blob: blob };
      const ok = refObj === L.tag_object && tagObj.object?.type === "commit" && tagObj.object?.sha === L.commit && peeled === L.commit && tagObj.tag === L.tag && blob === L.compose_blob && L.commit === UPSTREAM_SHA;
      return { ok, actual: JSON.stringify(facts) };
    } },

  // ---------------------------------------------------------------------
  V06: { name: "digest-platform-consistency", inputs: ["deploy/versions.lock.json", "evidence/M0/registry/digests.jsonl"],
    expected: "for every image in the lockfile and every resolved registry row: sha256(saved index bytes)=index_digest; the index lists arm64_manifest_digest under linux/arm64; sha256(saved arm64 manifest bytes)=arm64_manifest_digest",
    run() {
      const lock = json("deploy/versions.lock.json");
      const found = [];
      const collect = (o) => { if (o && typeof o === "object") { if (o.index_digest && o.index_file) found.push(o); Object.values(o).forEach(collect); } };
      collect(lock.images);
      read("evidence/M0/registry/digests.jsonl").split("\n").filter(Boolean).map((l) => JSON.parse(l)).filter((r) => r.status === "resolved").forEach((r) => found.push(r));
      const bad = [], checked = new Set();
      for (const im of found) {
        const key = `${im.repository}:${im.tag}`; if (checked.has(key + im.index_digest)) continue; checked.add(key + im.index_digest);
        const idxBytes = readFileSync(resolve(ROOT, im.index_file));
        if (`sha256:${sha256(idxBytes)}` !== im.index_digest) { bad.push(`${key} index bytes`); continue; }
        const idx = JSON.parse(idxBytes.toString("utf8"));
        const entry = (idx.manifests || []).find((m) => m.digest === im.arm64_manifest_digest);
        if (!entry || entry.platform?.os !== "linux" || entry.platform?.architecture !== "arm64") { bad.push(`${key} arm64 entry not in index`); continue; }
        if (`sha256:${sha256(readFileSync(resolve(ROOT, im.arm64_manifest_file)))}` !== im.arm64_manifest_digest) bad.push(`${key} arm64 manifest bytes`);
      }
      return { ok: bad.length === 0 && checked.size > 0, actual: `image references checked=${checked.size}; failures=${bad.length}${bad.length ? " [" + bad.join("; ") + "]" : ""}`, digests: [...checked].map((k) => k) };
    } },

  // ---------------------------------------------------------------------
  V07: { name: "secret-and-identifier-redaction-scan", inputs: ["evidence/M0", "deploy/versions.lock.json"],
    expected: "no private keys, tokens, credential assignments, raw MAC addresses, raw 16-hex board serials, raw 32-hex machine IDs or the raw egress IP in evidence/M0/** or deploy/versions.lock.json",
    run() {
      const files = [];
      const walk = (d) => { for (const n of readdirSync(resolve(ROOT, d))) { const p = join(d, n); statSync(resolve(ROOT, p)).isDirectory() ? walk(p) : files.push(p); } };
      walk("evidence/M0"); files.push("deploy/versions.lock.json");
      const audit = json("evidence/M0/audit.json");
      const egressHash = audit.network.egress_ip_sha256;
      const rules = [
        ["private-key", /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
        ["github-token", /\b(gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{20,})/],
        ["openai-style-key", /\bsk-[A-Za-z0-9_-]{20,}/],
        ["aws-key", /\bAKIA[0-9A-Z]{16}\b/],
        ["slack-token", /\bxox[baprs]-[A-Za-z0-9-]{10,}/],
        ["jwt", /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/],
        ["bearer", /Bearer\s+[A-Za-z0-9._~+/-]{20,}/],
        ["credential-assignment", /\b(password|passwd|secret|api[_-]?key|access[_-]?token|auth[_-]?token)\b\s*[:=]\s*["']?(?!REDACTED|<|\$\{|null|false|true|none|string|undefined)[A-Za-z0-9+/_\-.]{8,}/i],
        ["url-credentials", /[a-z][a-z0-9+.-]*:\/\/[^\s/:@]+:[^\s/@]+@/i],
        ["mac-address", /(?<![0-9A-Fa-f:])(?:[0-9A-Fa-f]{2}[:-]){5}[0-9A-Fa-f]{2}(?![0-9A-Fa-f:])/],
        ["hex16-serial-shaped", /(?<![0-9A-Za-z_:.\/-])[0-9a-f]{16}(?![0-9A-Za-z_])/],
        ["hex32-machine-id-shaped", /(?<![0-9A-Za-z_:.\/-])[0-9a-f]{32}(?![0-9A-Za-z_])/],
      ];
      const hits = [];
      let egressHits = 0;
      for (const f of files) {
        const text = read(f);
        text.split("\n").forEach((line, i) => {
          for (const [name, re] of rules) if (re.test(line)) hits.push(`${f}:${i + 1} ${name}`);
          for (const m of line.match(/\b\d{1,3}(?:\.\d{1,3}){3}\b/g) ?? []) if (sha256(m) === egressHash) { egressHits++; hits.push(`${f}:${i + 1} raw-egress-ip`); }
        });
      }
      return { ok: hits.length === 0, configHash: hashOf(files), actual: `files scanned=${files.length}; findings=${hits.length}${hits.length ? " [" + hits.slice(0, 20).join("; ") + (hits.length > 20 ? " ..." : "") + "]" : ""}; raw egress IP occurrences=${egressHits}` };
    } },

  // ---------------------------------------------------------------------
  V08: { name: "before-after-integrity", inputs: ["evidence/M0/snapshot-before.txt", "evidence/M0/snapshot-after.txt"],
    expected: "BEFORE/AFTER diff empty apart from the audit's own session-<n>.scope units; boot ID unchanged",
    run() {
      if (!existsSync(resolve(ROOT, "evidence/M0/snapshot-after.txt"))) return { notRun: true, actual: "AFTER snapshot not yet taken" };
      let out, code = 0;
      try { out = execFileSync(resolve(ROOT, "scripts/m0/snapshot-diff.sh"), { encoding: "utf8" }); } catch (e) { out = e.stdout; code = e.status; }
      return { ok: code === 0, actual: `${out.trim()} (see evidence/M0/snapshot-diff.txt)`, exit: code };
    } },
};

// ---------------------------------------------------------------------------
const wanted = process.argv.slice(2).length ? process.argv.slice(2) : Object.keys(checks);
const prior = existsSync(resolve(ROOT, OUT)) ? json(OUT) : { results: [] };
const results = Object.fromEntries(prior.results.map((r) => [r.test_id, r]));
const repo = repoState();
const lock = json("deploy/versions.lock.json");

for (const id of wanted) {
  const c = checks[id];
  if (!c) throw new Error(`unknown check ${id}`);
  const rec = { test_id: `M0-${id}`, name: c.name, utc: now(), ...repo, upstream_sha: UPSTREAM_SHA, config_or_fixture_hash: null, expected: c.expected };
  try {
    rec.config_or_fixture_hash = c.inputs.every((p) => existsSync(resolve(ROOT, p)) && statSync(resolve(ROOT, p)).isFile()) ? hashOf(c.inputs) : null;
    const r = c.run();
    if (r.notRun) Object.assign(rec, { state: "NOT_RUN", actual: r.actual, exit_code: null });
    else Object.assign(rec, { state: r.ok ? "PASS" : "FAIL", actual: r.actual, exit_code: r.exit ?? (r.ok ? 0 : 1) });
    if (r.configHash) rec.config_or_fixture_hash = r.configHash;
    if (r.digests) rec.image_digests_platform = { platform: "linux/arm64", checked: r.digests.length };
    if (c.live) rec.live_sources = "GitHub (git ls-remote, REST API)";
  } catch (e) {
    Object.assign(rec, { state: "FAIL", actual: `check raised: ${e.message}`, exit_code: 2, classification: "verifier-error" });
  }
  if (id === "V06") rec.image_digests_platform = { ...(rec.image_digests_platform ?? {}), lockfile_sha256: sha256File("deploy/versions.lock.json") };
  rec.evidence_path = OUT;
  results[rec.test_id] = rec;
  console.log(`${rec.test_id} ${rec.state.padEnd(8)} ${c.name}`);
}

const ordered = Object.keys(checks).map((id) => results[`M0-${id}`] ?? { test_id: `M0-${id}`, name: checks[id].name, state: "NOT_RUN", actual: "never run", evidence_path: OUT });
writeFileSync(resolve(ROOT, OUT), JSON.stringify({ schema: "fcpi.m0.verification/v1", runner: "scripts/m0/verify.mjs", firecrawl_lock_commit: lock.firecrawl.commit, results: ordered }, null, 2) + "\n");
process.exitCode = ordered.every((r) => r.state === "PASS") ? 0 : 1;
