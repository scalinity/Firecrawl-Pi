// Shared helpers for the M0 audit builder and verifier. Node built-ins only.
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
export const MIB = 1024 * 1024;
export const GIB = 1024 * MIB;

export const sha256 = (buf) => createHash("sha256").update(buf).digest("hex");
export const sha256File = (p) => sha256(readFileSync(resolve(ROOT, p)));

export function git(...args) {
  return execFileSync("git", ["-C", ROOT, ...args], { encoding: "utf8" }).trim();
}
export function repoState() {
  // code_dirty ignores evidence/, which is written while a verification window is open (the
  // exclusion scripts/m1/deploy.sh makes), so it shows whether the code that ran is HEAD's.
  return { repository_sha: git("rev-parse", "HEAD"), worktree_dirty: git("status", "--porcelain").length > 0,
    code_dirty: git("status", "--porcelain", "--", ".", ":(exclude)evidence").length > 0 };
}

// Split a probe transcript into { sectionName: [lines] } on "### name" headers.
export function sections(path) {
  const out = {};
  let cur = null;
  for (const line of readFileSync(resolve(ROOT, path), "utf8").split("\n")) {
    const m = line.match(/^### (\S+)$/);
    if (m) { cur = m[1]; out[cur] = []; continue; }
    if (cur) out[cur].push(line);
  }
  return out;
}

// key=value lines of a section into an object (first "=" splits).
export function kv(lines) {
  const o = {};
  for (const l of lines ?? []) {
    const i = l.indexOf("=");
    if (i > 0 && /^[\w.\- ]+$/.test(l.slice(0, i))) o[l.slice(0, i).trim()] = l.slice(i + 1).trim();
  }
  return o;
}

// /proc/meminfo lines into { Key: kB }.
export function meminfo(lines) {
  const o = {};
  for (const l of lines ?? []) {
    const m = l.match(/^(\S+):\s+(\d+)\s*kB$/);
    if (m) o[m[1]] = Number(m[2]);
  }
  return o;
}

// `df -B1 -T` rows keyed by mount point.
export function dfBytes(lines) {
  const o = {};
  for (const l of (lines ?? []).slice(1)) {
    const f = l.trim().split(/\s+/);
    if (f.length >= 7) o[f[6]] = { source: f[0], fstype: f[1], size: Number(f[2]), used: Number(f[3]), avail: Number(f[4]) };
  }
  return o;
}

// `df -i` rows keyed by mount point.
export function dfInodes(lines) {
  const o = {};
  for (const l of (lines ?? []).slice(1)) {
    const f = l.trim().split(/\s+/);
    if (f.length >= 6 && /^\d+$/.test(f[1])) o[f[5]] = { inodes: Number(f[1]), used: Number(f[2]), free: Number(f[3]) };
  }
  return o;
}

// `ss -Hlntup` rows into listeners.
export function listeners(lines) {
  const out = [];
  for (const l of lines ?? []) {
    const f = l.trim().split(/\s+/);
    if (f.length < 6 || !/^(tcp|udp)$/.test(f[0])) continue;
    const local = f[4];
    const i = local.lastIndexOf(":");
    const proc = (l.match(/users:\(\("([^"]+)"/) || [])[1] ?? null;
    out.push({ proto: f[0], state: f[1], address: local.slice(0, i), port: Number(local.slice(i + 1)), process: proc });
  }
  return out;
}

// The resource-fit rule of spec §22, from raw meminfo values (kB).
export const CAP_SUM_MIB = 6432;
export const RESERVE_MIB = 1024;
export const WORK_SPACE_GIB = 20;
export function resourceFit(mem) {
  const memTotalMiB = mem.MemTotal / 1024;
  const memAvailableMiB = mem.MemAvailable / 1024;
  const existingUsageMiB = memTotalMiB - memAvailableMiB;
  const requiredMiB = CAP_SUM_MIB + RESERVE_MIB;
  const headroomMiB = memAvailableMiB - requiredMiB;
  const r2 = (x) => Math.round(x * 100) / 100;
  return {
    mem_total_mib: r2(memTotalMiB),
    mem_available_mib: r2(memAvailableMiB),
    existing_usage_mib: r2(existingUsageMiB),
    cap_sum_mib: CAP_SUM_MIB,
    reserve_mib: RESERVE_MIB,
    required_mib: requiredMiB,
    headroom_mib: r2(headroomMiB),
    fits: headroomMiB >= 0,
  };
}
export function spaceFit(rootDf) {
  const availGiB = rootDf.avail / GIB;
  return {
    root_avail_bytes: rootDf.avail,
    root_avail_gib: Math.round(availGiB * 100) / 100,
    threshold_gib: WORK_SPACE_GIB,
    meets_threshold: availGiB >= WORK_SPACE_GIB,
  };
}
