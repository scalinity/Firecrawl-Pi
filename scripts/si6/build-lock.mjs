#!/usr/bin/env node
// Resolve the search intelligence release's entries in deploy/versions.lock.json from SI6's cutover evidence, starting from the
// lock as committed, so a re-run resolves the same entries the same way. SI6 owns: the patched API image with patch 0011 and
// the eleven-patch series, the retrieval, gateway and MCP images rebuilt on the Pi, the budget policy with the search
// providers, their categories and rate cards, and the egress and capability policies' hashes. Every image is taken only when
// the cutover record shows it running, healthy, and its build log names it. Entries owned by earlier milestones are as they are.
//   node scripts/si6/build-lock.mjs     (after scripts/si6/pi-cutover.sh's record, evidence/search-intelligence/SI6/raw/)
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { ROOT, sha256File, repoState } from "../m0/lib.mjs";

const LOCK = "deploy/versions.lock.json", RAW = "evidence/search-intelligence/SI6/raw";
const read = (p) => readFileSync(resolve(ROOT, p), "utf8");
const lock = JSON.parse(read(LOCK));
const need = (v, what) => { if (v === undefined || v === null || v === "") throw new Error(`cannot resolve ${what} from evidence`); return v; };
const cutover = read(`${RAW}/cutover.txt`);
need(/^end_marker=reached /m.test(cutover) ? true : null, "a completed cutover (its end marker)");
const running = (svc) => {
  const m = cutover.match(new RegExp(`^${svc} image=(sha256:[0-9a-f]{64}) health=(\\S+)$`, "m"));
  need(m?.[2] === "healthy" ? true : null, `${svc} healthy after the cutover`);
  return m[1];
};

// The patched API image: built on the Colima VM from a clean tree with every step run (D6), carried to the Pi.
const log = read(`${RAW}/api-build.log`);
const apiId = need(log.match(/^id=(sha256:[0-9a-f]{64}) os=linux arch=arm64 /m)?.[1], "the API image id in the build log");
need(apiId === running("firecrawl-core") ? true : null, "the core running the logged API build");
need(read(`${RAW}/api-push.txt`).includes(`pi_image=${apiId} arm64`) ? true : null, "the Pi holding the logged API build");
const series = JSON.parse(read("patches/series.json"));
need(log.includes(`FCPI_PATCH_SERIES_SHA256=${series.series_sha256}`) ? true : null, "the API image carrying the series hash");
const rc = need(log.match(/^repository_commit=([0-9a-f]{40}) code_dirty=(true|false)$/m), "the API build's repository commit");
need(rc[2] === "false" && /^no_cache=1$/m.test(log) ? true : null, "a build of record (clean tree, every step run)");
lock.images.firecrawl_api_patched = { ...lock.images.firecrawl_api_patched, image_id: apiId, patch_series_sha256: series.series_sha256,
  role: "The API image the stack runs: the pinned commit with patches/ applied; since SI6 patch 0011 carries the caller's original query, options, trusted context and deadline to the retrieval service's search coordinator, and the bounded evidence payload" };
lock.build_provenance.firecrawl_api_image_patched = { ...lock.build_provenance.firecrawl_api_image_patched, image_id: apiId, built_on: "the workstation's Colima VM, natively linux/arm64 (decision D6)",
  built_utc: need(log.match(/^utc=(\S+)$/m)?.[1], "the API build's time"), repository_commit: rc[1], code_dirty: false, no_cache: true, patch_series_sha256: series.series_sha256, result_tree: series.result_tree,
  build_log: `${RAW}/api-build.log`, transfer: `${RAW}/api-push.txt (docker save on the VM, docker load on the Pi, the image id compared)` };
lock.patches = { ...lock.patches, series_sha256: series.series_sha256, result_tree: series.result_tree, patches: series.patches.map((p) => ({ file: p.file, sha256: p.sha256, reason: p.reason })) };

// The service images rebuilt on the Pi from the deployed release commit (scripts/m7/pi-build-images.sh's transcript).
const build = read(`${RAW}/image-build.txt`);
const packagesOf = (dir) => Object.fromEntries(Object.entries(JSON.parse(read(`${dir}/package-lock.json`)).packages).filter(([k, v]) => k && !v.dev)
  .map(([k, v]) => [k.replace(/^node_modules\//, ""), { version: need(v.version, k), integrity: need(v.integrity, `${k}'s integrity`) }]));
const image = (svc, tag, dir, key, role) => {
  const id = running(svc);
  need([...build.matchAll(new RegExp(`^fcpi/${tag}:m7 id=(sha256:[0-9a-f]{64}) os=linux arch=arm64 `, "gm"))].at(-1)?.[1] === id ? true : null, `${svc} running its last recorded build`);
  const commit = need([...build.matchAll(new RegExp(`^fcpi/${tag}:m7 FCPI_SOURCE_COMMIT=([0-9a-f]{40})$`, "gm"))].at(-1)?.[1], `the commit ${svc}'s image records`);
  const base = need(read(`${dir}/Dockerfile`).match(/^FROM (node:22\.23\.3-bookworm-slim@sha256:[0-9a-f]{64})$/m)?.[1], `${svc}'s digest-pinned base`);
  lock.images[key] = { ...lock.images[key], role, status: "selected", image_id: id, platform: "linux/arm64", base, built_from_commit: commit,
    dockerfile: { path: `${dir}/Dockerfile`, sha256: sha256File(`${dir}/Dockerfile`) }, lockfile: { path: `${dir}/package-lock.json`, sha256: sha256File(`${dir}/package-lock.json`) },
    packages: packagesOf(dir), evidence: `${RAW}/image-build.txt` };
};
image("retrieval-service", "retrieval", "services/retrieval", "retrieval", `${lock.images.retrieval.role.replace(/; since SI6 .*$/, "")}; since SI6 the search intelligence coordinator (five general engines, Context7 and Ref, Jev decisions), its evidence hook and its operational records`);
image("access-gateway", "access-gateway", "services/access", "access_gateway", `${lock.images.access_gateway.role.replace(/; since SI6 .*$/, "")}; since SI6 the searchIntelligence options and the search's trusted context headers`);
image("mcp-gateway", "mcp-gateway", "services/mcp", "mcp_gateway", `${lock.images.mcp_gateway.role.replace(/; since SI6 .*$/, "")}; since SI6 the search tool's searchIntelligence options and fcpi.search compaction`);

// Budgets, rate cards and the search providers; the policies by hash.
const budget = JSON.parse(read("deploy/policies/budget.json"));
lock.providers = {
  ...lock.providers,
  budget_policy: { ...lock.providers.budget_policy, path: "deploy/policies/budget.json", sha256: sha256File("deploy/policies/budget.json") },
  rate_cards: budget.rateCards,
  providers: Object.fromEntries(Object.entries(budget.providers).map(([k, v]) => [k, { kind: v.kind, base_url: v.baseUrl, paid: v.paid, credential_file: v.credential, api: v.api ?? null }])),
  search: { profile: budget.searching.profile, general: budget.searching.generalSubjects, documentation: budget.searching.documentationSubjects, decision: budget.searching.decisionSubject,
    decision_model: budget.decisions?.[budget.searching.decisionSubject]?.model ?? null, searxng_mode: budget.searching.searxngMode,
    categories: Object.fromEntries(Object.entries(budget.categories).filter(([k]) => /^(search_|docs_|decisions_)/.test(k)).map(([k, c]) => [k, { paid: c.paid, unit: c.unit, caps: c.caps }])),
    serper_allocation: { category: "serper_trial", credits: budget.searching.allocationCredits, renewal: false } },
};
lock.egress = { ...lock.egress, policy_sha256: sha256File("deploy/policies/egress.json") };
lock.gateway = { ...lock.gateway, capabilities_sha256: sha256File("deploy/policies/capabilities.json") };

const repo = repoState();
lock.generated_by = "scripts/si6/build-lock.mjs (search intelligence SI6), from the lock as committed before the cutover; entries owned by earlier milestones are as they were";
lock.generated_utc = new Date().toISOString().replace(/\.\d+Z$/, "Z");
lock.repository_sha = repo.repository_sha;
lock.worktree_dirty = repo.worktree_dirty;
writeFileSync(resolve(ROOT, LOCK), JSON.stringify(lock, null, 2) + "\n");
console.log(`lock: api ${apiId.slice(7, 19)} series ${series.series_sha256.slice(0, 8)}, retrieval ${lock.images.retrieval.image_id.slice(7, 19)}, gateway ${lock.images.access_gateway.image_id.slice(7, 19)}, mcp ${lock.images.mcp_gateway.image_id.slice(7, 19)}`);
