#!/usr/bin/env node
// Resolve M8's entries in deploy/versions.lock.json from M8 evidence, starting from the lock as M7 closed it (at 19f047f),
// so a re-run resolves the same entries the same way. M8 owns: the retrieval and gateway images rebuilt on the Pi (host
// admission), restic (Debian's package, the one host package M8 installs) with its binary's hash, the project's host
// units, slice, timers and tmpfiles entry by hash, the PostgreSQL write settings and the Redis ACL M8 measured, and the
// capability manifest's hash. Entries owned by other milestones are left as M7 wrote them.
//   node scripts/m8/build-lock.mjs
import { readFileSync, writeFileSync, readdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { ROOT, sha256File, repoState, sections, kv } from "../m0/lib.mjs";

const LOCK = "deploy/versions.lock.json";
const M7_LOCK_COMMIT = "19f047f";
const EV = process.env.FCPI_M8_EVIDENCE ?? "evidence/M8/";
const read = (p) => readFileSync(resolve(ROOT, p), "utf8");
const lock = JSON.parse(execFileSync("git", ["-C", ROOT, "show", `${M7_LOCK_COMMIT}:${LOCK}`], { encoding: "utf8" }));
const need = (v, what) => { if (v === undefined || v === null || v === "") throw new Error(`cannot resolve ${what} from evidence`); return v; };
const compose = JSON.parse(read(`${EV}rendered-compose.json`));
const running = (svc) => need((compose.services[svc]?.image ?? "").match(/@(sha256:[0-9a-f]{64})$/)?.[1], `${svc}'s image digest in the rendered Compose file`);

// The service images rebuilt on the Pi from the deployed commit.
const build = read(`${EV}raw/image-build.txt`);
const packagesOf = (dir) => Object.fromEntries(Object.entries(JSON.parse(read(`${dir}/package-lock.json`)).packages).filter(([k, v]) => k && !v.dev)
  .map(([k, v]) => [k.replace(/^node_modules\//, ""), { version: need(v.version, k), integrity: need(v.integrity, `${k}'s integrity`) }]));
const image = (svc, tag, dir, key, role) => {
  const id = running(svc);
  need([...build.matchAll(new RegExp(`^fcpi/${tag}:m8 id=(sha256:[0-9a-f]{64}) os=linux arch=arm64 `, "gm"))].at(-1)?.[1] === id ? true : null, `${svc} running its last recorded build`);
  const commit = need([...build.matchAll(new RegExp(`^fcpi/${tag}:m8 FCPI_SOURCE_COMMIT=([0-9a-f]{40})$`, "gm"))].at(-1)?.[1], `the commit ${svc}'s image records`);
  const base = need(read(`${dir}/Dockerfile`).match(/^FROM (node:22\.23\.3-bookworm-slim@sha256:[0-9a-f]{64})$/m)?.[1], `${svc}'s digest-pinned base`);
  lock.images[key] = { ...lock.images[key], role, status: "selected", image_id: id, platform: "linux/arm64", base, built_from_commit: commit,
    dockerfile: { path: `${dir}/Dockerfile`, sha256: sha256File(`${dir}/Dockerfile`) }, lockfile: { path: `${dir}/package-lock.json`, sha256: sha256File(`${dir}/package-lock.json`) }, packages: packagesOf(dir), evidence: `${EV}raw/image-build.txt` };
};
image("retrieval-service", "retrieval", "services/retrieval", "retrieval", "The retrieval-service image (built on the Pi, natively linux/arm64): acquisition, the search, model and parser adapters, the residential route, the enhanced provider, the browser extras and webhook delivery, and since M8 the browser tier's host admission");
image("access-gateway", "access-gateway", "services/access", "access_gateway", "The access gateway image (built on the Pi, natively linux/arm64), with artifacts, the scrape cache, change detection, the webhook outbox, and since M8 the host admission of new work");

// restic, as the init transcript recorded it on the Pi.
const init = sections(`${EV}raw/init-m8.txt`);
const rk = kv(need((init.restic ?? []).find((l) => l.startsWith("restic_package=")), "restic's installed package line").split(" "));
lock.host_packages = { ...(lock.host_packages ?? {}), restic: { version: need(rk.restic_package, "restic's package version"), source: "Debian 13 (trixie) main, arm64, apt with Debian's archive signatures",
  binary: "/usr/bin/restic", binary_sha256: need(rk.restic_sha256, "restic's binary hash"), purpose: "encrypted off-device backups (spec §26); installed by scripts/m8/pi-init-m8.sh", evidence: `${EV}raw/init-m8.txt` } };

// The project's host units, slice, timers and tmpfiles entry, by hash (scripts/m8/pi-init-m8.sh installs these files).
lock.host_units = Object.fromEntries(readdirSync(resolve(ROOT, "deploy/host")).filter((f) => /^(fcpi.*\.(service|timer|slice)|tmpfiles-fcpi\.conf)$/.test(f)).sort().map((f) => [f, sha256File(`deploy/host/${f}`)]));

// What M8 measured and kept: PostgreSQL's write settings and the core's Redis user (M1 R15, R11).
const pgCmd = compose.services["nuq-postgres"].command;
lock.images.nuq_postgres = { ...lock.images.nuq_postgres, runtime_settings: pgCmd.filter((x, i) => pgCmd[i - 1] === "-c"), runtime_settings_evidence: `${EV}raw/pg-writes.txt` };
lock.images.redis = { ...lock.images.redis, core_user: "fcpi_core, limited to the command set measured in M8 (deploy/redis/fcpi-core.acl)", acl_evidence: `${EV}raw/redis-measured.txt` };
lock.gateway = { ...lock.gateway, capabilities_sha256: sha256File("deploy/policies/capabilities.json") };

const repo = repoState();
lock.generated_by = "scripts/m8/build-lock.mjs (M8), from the lock M7 closed with at 19f047f; entries owned by later milestones are as M7 wrote them";
lock.generated_utc = new Date().toISOString().replace(/\.\d+Z$/, "Z");
lock.repository_sha = repo.repository_sha;
lock.worktree_dirty = repo.worktree_dirty;
writeFileSync(resolve(ROOT, LOCK), JSON.stringify(lock, null, 2) + "\n");
console.log(`lock: retrieval ${lock.images.retrieval.image_id.slice(7, 19)}, gateway ${lock.images.access_gateway.image_id.slice(7, 19)}, restic ${lock.host_packages.restic.version}, host units ${Object.keys(lock.host_units).length}, postgres settings ${lock.images.nuq_postgres.runtime_settings.length}`);
