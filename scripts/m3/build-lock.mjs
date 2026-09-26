#!/usr/bin/env node
// Resolve M3's entries in deploy/versions.lock.json from M3 evidence, starting from the lock as M2
// closed it (at aa22d92), so a re-run resolves the same entries the same way. M3 owns the access
// gateway's image (built on the Pi from the digest-pinned node base) with its locked packages, the
// capability manifest and platform schema hashes, and the pinned official client the contract is
// tested with. Entries owned by other milestones are left as M2 wrote them.
// Usage: node scripts/m3/build-lock.mjs
import { readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { ROOT, sha256File, repoState } from "../m0/lib.mjs";

const LOCK = "deploy/versions.lock.json";
const M2_LOCK_COMMIT = "aa22d92";
const read = (p) => readFileSync(resolve(ROOT, p), "utf8");
const lock = JSON.parse(execFileSync("git", ["-C", ROOT, "show", `${M2_LOCK_COMMIT}:${LOCK}`], { encoding: "utf8" }));
const need = (v, what) => { if (v === undefined || v === null || v === "") throw new Error(`cannot resolve ${what} from evidence`); return v; };
const compose = JSON.parse(read("evidence/M3/rendered-compose.json"));
const running = need((compose.services["access-gateway"]?.image ?? "").match(/@(sha256:[0-9a-f]{64})$/)?.[1], "the gateway's image digest in the rendered Compose file");
const build = read("evidence/M3/raw/gateway-build.txt");
const builds = [...build.matchAll(/^fcpi\/access-gateway:m3 id=(sha256:[0-9a-f]{64}) os=linux arch=(\S+) /gm)];
need(builds.at(-1)?.[1] === running ? true : null, "the gateway running its last recorded build");
const commit = need([...build.matchAll(/^FCPI_SOURCE_COMMIT=([0-9a-f]{40})$/gm)].at(-1)?.[1], "the commit the gateway image records");
const base = need(read("services/access/Dockerfile").match(/^FROM (node:22\.23\.3-bookworm-slim@sha256:[0-9a-f]{64})$/m)?.[1], "the gateway's digest-pinned base");
need(base.endsWith(lock.images.node_base.selected.arm64_manifest_digest) ? true : null, "the gateway's base equal to the lock's node base");
const pl = JSON.parse(read("services/access/package-lock.json"));
const packages = Object.fromEntries(Object.entries(pl.packages).filter(([k]) => k).map(([k, v]) => [k.replace(/^node_modules\//, ""), { version: need(v.version, k), integrity: need(v.integrity, `${k}'s integrity`) }]));
const routeShapes = read("evidence/M3/raw/route-shapes.txt");
const client = need(routeShapes.match(/^client=(@mendable\/firecrawl-js@[\d.]+)$/m)?.[1], "the official client pinned in the upstream tree");

lock.images.access_gateway = {
  role: "The access gateway image (built on the Pi, natively linux/arm64)", status: "selected", image_id: running, platform: "linux/arm64", base,
  built_from_commit: commit, dockerfile: { path: "services/access/Dockerfile", sha256: sha256File("services/access/Dockerfile") },
  lockfile: { path: "services/access/package-lock.json", sha256: sha256File("services/access/package-lock.json") }, packages, evidence: "evidence/M3/raw/gateway-build.txt",
};
lock.gateway = {
  role: "The REST contract the gateway serves and the ledger it keeps (M3)",
  capabilities: "deploy/policies/capabilities.json", capabilities_sha256: sha256File("deploy/policies/capabilities.json"),
  platform_schema: "deploy/nuq-postgres/fcpi-platform-schema.sql", platform_schema_sha256: sha256File("deploy/nuq-postgres/fcpi-platform-schema.sql"),
  official_client: client, official_client_source: "apps/js-sdk/firecrawl/package.json in the pinned upstream tree (evidence/M3/raw/route-shapes.txt)",
  official_client_use: "contract tests from the workstation (scripts/m3/sdk-compat.mjs), installed outside the repository; not a deployed dependency",
};

const repo = repoState();
lock.generated_by = "scripts/m3/build-lock.mjs (M3), from the lock M2 closed with at aa22d92; entries owned by later milestones are as M2 wrote them";
lock.generated_utc = new Date().toISOString().replace(/\.\d+Z$/, "Z");
lock.repository_sha = repo.repository_sha;
lock.worktree_dirty = repo.worktree_dirty;
writeFileSync(resolve(ROOT, LOCK), JSON.stringify(lock, null, 2) + "\n");
console.log(`lock: access gateway ${running.slice(7, 19)} built from ${commit.slice(0, 7)}, ${Object.keys(packages).length} packages, capabilities ${lock.gateway.capabilities_sha256.slice(0, 8)}, client ${client}`);
