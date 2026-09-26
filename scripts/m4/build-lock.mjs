#!/usr/bin/env node
// Resolve M4's entries in deploy/versions.lock.json from M4 evidence, starting from the lock as M3 closed it
// (at 0abf44c), so a re-run resolves the same entries the same way. M4 owns the MCP service's image (built
// on the Pi from the digest-pinned node base) with every package of its lockfile, the SDK selection (D5:
// server, core and node 2.1.0, client 2.1.0 for tests), the protocol revisions, the gateway image it rebuilt
// with the /mcp route, and the capability manifest's hash. Entries owned by other milestones are left as
// M3 wrote them.
//   node scripts/m4/build-lock.mjs
import { readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { ROOT, sha256File, repoState } from "../m0/lib.mjs";

const LOCK = "deploy/versions.lock.json";
const M3_LOCK_COMMIT = "0abf44c";
const read = (p) => readFileSync(resolve(ROOT, p), "utf8");
const lock = JSON.parse(execFileSync("git", ["-C", ROOT, "show", `${M3_LOCK_COMMIT}:${LOCK}`], { encoding: "utf8" }));
const need = (v, what) => { if (v === undefined || v === null || v === "") throw new Error(`cannot resolve ${what} from evidence`); return v; };
const compose = JSON.parse(read("evidence/M4/rendered-compose.json"));
const build = read("evidence/M4/raw/image-build.txt");
const image = (svc, dir) => {
  const running = need((compose.services[svc]?.image ?? "").match(/@(sha256:[0-9a-f]{64})$/)?.[1], `${svc}'s image digest in the rendered Compose file`);
  need([...build.matchAll(new RegExp(`^fcpi/${svc}:m4 id=(sha256:[0-9a-f]{64}) os=linux arch=arm64 `, "gm"))].at(-1)?.[1] === running ? true : null, `${svc} running its last recorded build`);
  const commit = need([...build.matchAll(new RegExp(`^fcpi/${svc}:m4 FCPI_SOURCE_COMMIT=([0-9a-f]{40})$`, "gm"))].at(-1)?.[1], `the commit ${svc}'s image records`);
  const base = need(read(`${dir}/Dockerfile`).match(/^FROM (node:22\.23\.3-bookworm-slim@sha256:[0-9a-f]{64})$/m)?.[1], `${svc}'s digest-pinned base`);
  need(base.endsWith(lock.images.node_base.selected.arm64_manifest_digest) ? true : null, `${svc}'s base equal to the lock's node base`);
  const pl = JSON.parse(read(`${dir}/package-lock.json`)).packages;
  const packages = Object.fromEntries(Object.entries(pl).filter(([k, v]) => k && !v.dev).map(([k, v]) => [k.replace(/^node_modules\//, ""), { version: need(v.version, k), integrity: need(v.integrity, `${k}'s integrity`) }]));
  return { status: "selected", image_id: running, platform: "linux/arm64", base, built_from_commit: commit, dockerfile: { path: `${dir}/Dockerfile`, sha256: sha256File(`${dir}/Dockerfile`) },
    lockfile: { path: `${dir}/package-lock.json`, sha256: sha256File(`${dir}/package-lock.json`) }, packages, evidence: "evidence/M4/raw/image-build.txt" };
};

lock.images.mcp_gateway = { role: "The MCP service image (built on the Pi, natively linux/arm64): the official SDK's stateless request factory in front of the gateway's REST routes", ...image("mcp-gateway", "services/mcp") };
lock.images.access_gateway = { role: "The access gateway image (built on the Pi, natively linux/arm64), with the /mcp route since M4", ...image("access-gateway", "services/access") };
const ml = JSON.parse(read("services/mcp/package-lock.json")).packages;
const at = (n) => ml[`node_modules/@modelcontextprotocol/${n}`];
lock.mcp = {
  protocol_revision: { ...lock.mcp.protocol_revision, observed: "both revisions on the wire in M4 (evidence/M4/raw/e2e-wire.txt, e2e-sdk.txt, e2e-tailnet.txt)" },
  packages: Object.fromEntries(["server", "core", "node", "client"].map((n) => [`@modelcontextprotocol/${n}`, { selected: need(at(n)?.version, n), integrity: need(at(n)?.integrity, `${n}'s integrity`),
    role: n === "client" ? "test-only (dev dependency): the SDK clients of M4's live evidence" : "runtime", source: "services/mcp/package-lock.json" }])),
  decision: "D5 (evidence/M0/review/DECISIONS.md): 2.1.0 was still npm's latest for all four on 2026-09-26, with no advisory against the v2 packages and npm audit clean",
  lockfile_packages: Object.fromEntries(Object.entries(ml).filter(([k]) => k).map(([k, v]) => [k.replace(/^node_modules\//, ""), { version: v.version, integrity: v.integrity, dev: v.dev === true }])),
  serving: { entry: "createMcpHandler(factory, { legacy: 'stateless', maxSubscriptions: 0 }) through toNodeHandler", endpoint: "/mcp behind the access gateway", catalog: "deploy/policies/capabilities.json mcp section" },
};
lock.gateway = { ...lock.gateway, capabilities_sha256: sha256File("deploy/policies/capabilities.json") };

const repo = repoState();
lock.generated_by = "scripts/m4/build-lock.mjs (M4), from the lock M3 closed with at 0abf44c; entries owned by later milestones are as M3 wrote them";
lock.generated_utc = new Date().toISOString().replace(/\.\d+Z$/, "Z");
lock.repository_sha = repo.repository_sha;
lock.worktree_dirty = repo.worktree_dirty;
writeFileSync(resolve(ROOT, LOCK), JSON.stringify(lock, null, 2) + "\n");
console.log(`lock: mcp ${lock.images.mcp_gateway.image_id.slice(7, 19)} from ${lock.images.mcp_gateway.built_from_commit.slice(0, 7)}, gateway ${lock.images.access_gateway.image_id.slice(7, 19)}, ${Object.keys(lock.mcp.lockfile_packages).length} MCP lockfile packages, capabilities ${lock.gateway.capabilities_sha256.slice(0, 8)}`);
