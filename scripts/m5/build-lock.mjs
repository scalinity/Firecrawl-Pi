#!/usr/bin/env node
// Resolve M5's entries in deploy/versions.lock.json from M5 evidence, starting from the lock as M4 closed it
// (at 10cdc59), so a re-run resolves the same entries the same way. M5 owns: SearXNG's image (re-resolved from
// M0's candidate to the tag current when M5 began), the patched API image with patches 0007 and 0008 and the
// series, the three service images rebuilt on the Pi (retrieval, gateway, MCP), the budget policy with its
// versioned rate cards, the search engine sets and SearXNG's settings, and the capability manifest's hash.
// Entries owned by other milestones are left as M4 wrote them.
//   node scripts/m5/build-lock.mjs
import { readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { ROOT, sha256File, repoState } from "../m0/lib.mjs";

const LOCK = "deploy/versions.lock.json";
const M4_LOCK_COMMIT = "10cdc59";
const read = (p) => readFileSync(resolve(ROOT, p), "utf8");
const lock = JSON.parse(execFileSync("git", ["-C", ROOT, "show", `${M4_LOCK_COMMIT}:${LOCK}`], { encoding: "utf8" }));
const need = (v, what) => { if (v === undefined || v === null || v === "") throw new Error(`cannot resolve ${what} from evidence`); return v; };
const compose = JSON.parse(read("evidence/M5/rendered-compose.json"));
const running = (svc) => need((compose.services[svc]?.image ?? "").match(/@(sha256:[0-9a-f]{64})$/)?.[1], `${svc}'s image digest in the rendered Compose file`);

// SearXNG: the arm64 manifest the stack runs, the index it belongs to, the version it labels.
const reg = read("evidence/M5/raw/searxng-registry.txt");
const sx = running("searxng");
need(reg.includes(`@${sx}`) ? true : null, "the running SearXNG digest in the registry record");
const stack = read("evidence/M5/raw/stack.txt");
const sxv = need(stack.match(/^version=(\S+) revision=([0-9a-f]{40}) license=(\S+) os=linux arch=arm64$/m), "SearXNG's version labels in the stack record");
lock.images.searxng = {
  role: "Private metasearch (M5): JSON only, one worker, no limiter, its only route the retrieval service's search proxy",
  status: "selected",
  selected: { registry: "registry-1.docker.io", repository: "searxng/searxng", tag: sxv[1], status: "selected", index_digest: need(reg.match(/^Digest:\s+(sha256:[0-9a-f]{64})$/m)?.[1], "SearXNG's index digest"),
    arm64_manifest_digest: sx, platform: "linux/arm64", revision: sxv[2], license: sxv[3], registry_record: "evidence/M5/raw/searxng-registry.txt" },
  replaces: { tag: lock.images.searxng.selected.tag, arm64_manifest_digest: lock.images.searxng.selected.arm64_manifest_digest, why: "M0's candidate re-resolved to the newest tag when M5 began (2026-09-26), as its note allowed; the native proof ran on this digest (evidence/M5/raw/stack.txt, searxng_native)" },
  settings: { path: "deploy/searxng/settings.yml", sha256: sha256File("deploy/searxng/settings.yml"), entrypoint: "deploy/searxng/entrypoint.sh", entrypoint_sha256: sha256File("deploy/searxng/entrypoint.sh") },
  license_note: "AGPL-3.0-or-later, run unmodified from the upstream image and configured by files; nothing is distributed",
};

// The patched API image: built on the Colima VM (D6) and loaded on the Pi.
const log = read("evidence/M5/raw/api-build.log");
const apiId = need(log.match(/^id=(sha256:[0-9a-f]{64}) os=linux arch=arm64 /m)?.[1], "the API image id in the build log");
need(apiId === running("firecrawl-core") ? true : null, "the core running the logged API build");
const push = read("evidence/M5/raw/api-push.txt");
need(push.includes(`pi_image=${apiId} arm64`) ? true : null, "the Pi holding the logged API build");
const series = JSON.parse(read("patches/series.json"));
need(log.includes(`FCPI_PATCH_SERIES_SHA256=${series.series_sha256}`) ? true : null, "the API image carrying the series hash");
const rc = need(log.match(/^repository_commit=([0-9a-f]{40}) code_dirty=(true|false)$/m), "the API build's repository commit");
lock.images.firecrawl_api_patched = { ...lock.images.firecrawl_api_patched, image_id: apiId, patch_series_sha256: series.series_sha256,
  role: "The API image the stack runs: the pinned commit with patches/ applied, patches 0007 (typed search failures) and 0008 (the document policy) since M5" };
lock.build_provenance.firecrawl_api_image_patched = { ...lock.build_provenance.firecrawl_api_image_patched, image_id: apiId, built_on: "the workstation's Colima VM, natively linux/arm64 (decision D6)",
  built_utc: need(log.match(/^utc=(\S+)$/m)?.[1], "the API build's time"), repository_commit: rc[1], code_dirty: rc[2] === "true", no_cache: /^no_cache=1$/m.test(log),
  build_log: "evidence/M5/raw/api-build.log", transfer: "evidence/M5/raw/api-push.txt (docker save on the VM, docker load on the Pi, the image id compared)", patch_series_sha256: series.series_sha256, result_tree: series.result_tree };
lock.patches = { ...lock.patches, series_sha256: series.series_sha256, result_tree: series.result_tree, patches: series.patches.map((p) => ({ file: p.file, sha256: p.sha256, reason: p.reason })) };

// The service images rebuilt on the Pi from the deployed commit.
const build = read("evidence/M5/raw/image-build.txt");
const image = (svc, dir, key, role) => {
  const id = running(svc);
  need([...build.matchAll(new RegExp(`^fcpi/${svc === "retrieval-service" ? "retrieval" : svc}:m5 id=(sha256:[0-9a-f]{64}) os=linux arch=arm64 `, "gm"))].at(-1)?.[1] === id ? true : null, `${svc} running its last recorded build`);
  const commit = need([...build.matchAll(new RegExp(`^fcpi/${svc === "retrieval-service" ? "retrieval" : svc}:m5 FCPI_SOURCE_COMMIT=([0-9a-f]{40})$`, "gm"))].at(-1)?.[1], `the commit ${svc}'s image records`);
  const base = need(read(`${dir}/Dockerfile`).match(/^FROM (node:22\.23\.3-bookworm-slim@sha256:[0-9a-f]{64})$/m)?.[1], `${svc}'s digest-pinned base`);
  const pl = JSON.parse(read(`${dir}/package-lock.json`)).packages;
  const packages = Object.fromEntries(Object.entries(pl).filter(([k, v]) => k && !v.dev).map(([k, v]) => [k.replace(/^node_modules\//, ""), { version: need(v.version, k), integrity: need(v.integrity, `${k}'s integrity`) }]));
  lock.images[key] = { ...lock.images[key], role, status: "selected", image_id: id, platform: "linux/arm64", base, built_from_commit: commit,
    dockerfile: { path: `${dir}/Dockerfile`, sha256: sha256File(`${dir}/Dockerfile`) }, lockfile: { path: `${dir}/package-lock.json`, sha256: sha256File(`${dir}/package-lock.json`) }, packages, evidence: "evidence/M5/raw/image-build.txt" };
  delete lock.images[key].base_manifest_digest;
};
image("retrieval-service", "services/retrieval", "retrieval", "The retrieval-service image (built on the Pi, natively linux/arm64): acquisition, and since M5 the search, model and parser adapters and their budgets");
image("access-gateway", "services/access", "access_gateway", "The access gateway image (built on the Pi, natively linux/arm64), with search, the json format and extraction jobs since M5");
image("mcp-gateway", "services/mcp", "mcp_gateway", "The MCP service image (built on the Pi, natively linux/arm64), with the search and extraction tools since M5");

// Budgets, rate cards, search: the committed policies, by hash, with the rate cards spelled out.
const budget = JSON.parse(read("deploy/policies/budget.json"));
const egress = JSON.parse(read("deploy/policies/egress.json"));
lock.providers = {
  budget_policy: { path: "deploy/policies/budget.json", sha256: sha256File("deploy/policies/budget.json"), paid_caps: Object.fromEntries(Object.entries(budget.categories).filter(([, c]) => c.paid).map(([k, c]) => [k, c.caps])),
    paid_total_caps: budget.paidTotal.caps, paid_dispatch: "PI_PAID_DISPATCH_ENABLED=false in deploy/compose.yaml" },
  rate_cards: budget.rateCards,
  models: budget.models, parsers: budget.parsers, default_model: budget.extraction.defaultModel, default_parser: budget.parsing.defaultParser,
  providers: Object.fromEntries(Object.entries(budget.providers).map(([k, v]) => [k, { kind: v.kind, base_url: v.baseUrl, paid: v.paid, credential_file: v.credential }])),
  search: { engines: egress.search.engines, live_engine_hosts: egress.search.engineHosts.live, per_hour: egress.search.perHour, cache_seconds: egress.search.cacheSeconds, deadline_ms: egress.search.deadlineMs },
};
lock.gateway = { ...lock.gateway, capabilities_sha256: sha256File("deploy/policies/capabilities.json") };

const repo = repoState();
lock.generated_by = "scripts/m5/build-lock.mjs (M5), from the lock M4 closed with at 10cdc59; entries owned by later milestones are as M4 wrote them";
lock.generated_utc = new Date().toISOString().replace(/\.\d+Z$/, "Z");
lock.repository_sha = repo.repository_sha;
lock.worktree_dirty = repo.worktree_dirty;
writeFileSync(resolve(ROOT, LOCK), JSON.stringify(lock, null, 2) + "\n");
console.log(`lock: searxng ${sx.slice(7, 19)} (${sxv[1]}), api ${apiId.slice(7, 19)} series ${series.series_sha256.slice(0, 8)}, retrieval ${lock.images.retrieval.image_id.slice(7, 19)}, gateway ${lock.images.access_gateway.image_id.slice(7, 19)}, mcp ${lock.images.mcp_gateway.image_id.slice(7, 19)}, budget ${lock.providers.budget_policy.sha256.slice(0, 8)}, ${budget.rateCards.length} rate cards, capabilities ${lock.gateway.capabilities_sha256.slice(0, 8)}`);
