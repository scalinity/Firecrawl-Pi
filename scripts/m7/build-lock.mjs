#!/usr/bin/env node
// Resolve M7's entries in deploy/versions.lock.json from M7 evidence, starting from the lock as M6 closed it (at
// 0318b6e), so a re-run resolves the same entries the same way. M7 owns: the patched API image with patch 0010 and the
// ten-patch series, the four service images rebuilt on the Pi (retrieval, gateway, MCP, browser worker), the budget
// policy with its enhanced providers and per-request rate cards, the egress policy's webhook destinations and M7's
// fixture hosts, fixture-m7's image, and the capability manifest's hash. Entries owned by other milestones are left as
// M6 wrote them.
//   node scripts/m7/build-lock.mjs
import { readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { ROOT, sha256File, repoState } from "../m0/lib.mjs";

const LOCK = "deploy/versions.lock.json";
const M6_LOCK_COMMIT = "0318b6e";
const read = (p) => readFileSync(resolve(ROOT, p), "utf8");
const lock = JSON.parse(execFileSync("git", ["-C", ROOT, "show", `${M6_LOCK_COMMIT}:${LOCK}`], { encoding: "utf8" }));
const need = (v, what) => { if (v === undefined || v === null || v === "") throw new Error(`cannot resolve ${what} from evidence`); return v; };
const compose = JSON.parse(read("evidence/M7/rendered-compose.json"));
const running = (svc) => need((compose.services[svc]?.image ?? "").match(/@(sha256:[0-9a-f]{64})$/)?.[1], `${svc}'s image digest in the rendered Compose file`);

// The patched API image: built on the Colima VM (D6) and loaded on the Pi.
const log = read("evidence/M7/raw/api-build.log");
const apiId = need(log.match(/^id=(sha256:[0-9a-f]{64}) os=linux arch=arm64 /m)?.[1], "the API image id in the build log");
need(apiId === running("firecrawl-core") ? true : null, "the core running the logged API build");
const push = read("evidence/M7/raw/api-push.txt");
need(push.includes(`pi_image=${apiId} arm64`) ? true : null, "the Pi holding the logged API build");
const series = JSON.parse(read("patches/series.json"));
need(log.includes(`FCPI_PATCH_SERIES_SHA256=${series.series_sha256}`) ? true : null, "the API image carrying the series hash");
const rc = need(log.match(/^repository_commit=([0-9a-f]{40}) code_dirty=(true|false)$/m), "the API build's repository commit");
lock.images.firecrawl_api_patched = { ...lock.images.firecrawl_api_patched, image_id: apiId, patch_series_sha256: series.series_sha256,
  role: "The API image the stack runs: the pinned commit with patches/ applied; since M7 patch 0010 carries the enhanced route, screenshots and the action subset, and the principal's owner tag" };
lock.build_provenance.firecrawl_api_image_patched = { ...lock.build_provenance.firecrawl_api_image_patched, image_id: apiId, built_on: "the workstation's Colima VM, natively linux/arm64 (decision D6)",
  built_utc: need(log.match(/^utc=(\S+)$/m)?.[1], "the API build's time"), repository_commit: rc[1], code_dirty: rc[2] === "true", no_cache: /^no_cache=1$/m.test(log),
  build_log: "evidence/M7/raw/api-build.log", transfer: "evidence/M7/raw/api-push.txt (docker save on the VM, docker load on the Pi, the image id compared)", patch_series_sha256: series.series_sha256, result_tree: series.result_tree };
lock.patches = { ...lock.patches, series_sha256: series.series_sha256, result_tree: series.result_tree, patches: series.patches.map((p) => ({ file: p.file, sha256: p.sha256, reason: p.reason })) };

// The service images rebuilt on the Pi from the deployed commit.
const build = read("evidence/M7/raw/image-build.txt");
const packagesOf = (dir) => Object.fromEntries(Object.entries(JSON.parse(read(`${dir}/package-lock.json`)).packages).filter(([k, v]) => k && !v.dev)
  .map(([k, v]) => [k.replace(/^node_modules\//, ""), { version: need(v.version, k), integrity: need(v.integrity, `${k}'s integrity`) }]));
const built = (svc, tag) => {
  const id = running(svc);
  need([...build.matchAll(new RegExp(`^fcpi/${tag}:m7 id=(sha256:[0-9a-f]{64}) os=linux arch=arm64 `, "gm"))].at(-1)?.[1] === id ? true : null, `${svc} running its last recorded build`);
  return { id, commit: need([...build.matchAll(new RegExp(`^fcpi/${tag}:m7 FCPI_SOURCE_COMMIT=([0-9a-f]{40})$`, "gm"))].at(-1)?.[1], `the commit ${svc}'s image records`) };
};
const image = (svc, tag, dir, key, role) => {
  const { id, commit } = built(svc, tag);
  const base = need(read(`${dir}/Dockerfile`).match(/^FROM (node:22\.23\.3-bookworm-slim@sha256:[0-9a-f]{64})$/m)?.[1], `${svc}'s digest-pinned base`);
  lock.images[key] = { ...lock.images[key], role, status: "selected", image_id: id, platform: "linux/arm64", base, built_from_commit: commit,
    dockerfile: { path: `${dir}/Dockerfile`, sha256: sha256File(`${dir}/Dockerfile`) }, lockfile: { path: `${dir}/package-lock.json`, sha256: sha256File(`${dir}/package-lock.json`) }, packages: packagesOf(dir), evidence: "evidence/M7/raw/image-build.txt" };
};
image("retrieval-service", "retrieval", "services/retrieval", "retrieval", "The retrieval-service image (built on the Pi, natively linux/arm64): acquisition, the search, model and parser adapters, the residential route, and since M7 the enhanced provider, the browser extras and webhook delivery");
image("access-gateway", "access-gateway", "services/access", "access_gateway", "The access gateway image (built on the Pi, natively linux/arm64), with artifacts, the scrape cache, change detection and the webhook outbox since M7");
image("mcp-gateway", "mcp-gateway", "services/mcp", "mcp_gateway", "The MCP service image (built on the Pi, natively linux/arm64), whose scrape tool offers the action subset, the screenshot format and the cache options since M7");
{
  const { id, commit } = built("browser-worker", "browser");
  const base = need(read("deploy/browser/Dockerfile").match(/^FROM mcr\.microsoft\.com\/playwright@(sha256:[0-9a-f]{64})$/m)?.[1], "the browser worker's digest-pinned base");
  need(base === lock.images.browser_worker.base_manifest_digest ? true : null, "the browser worker's base unchanged since M2");
  lock.images.browser_worker = { ...lock.images.browser_worker, role: "The browser-worker image (built on the Pi, natively linux/arm64), with the action subset and screenshots since M7", image_id: id, built_from_commit: commit,
    dockerfile: { path: "deploy/browser/Dockerfile", sha256: sha256File("deploy/browser/Dockerfile") }, lockfile: { path: "services/browser/package-lock.json", sha256: sha256File("services/browser/package-lock.json") },
    packages: packagesOf("services/browser"), evidence: "evidence/M7/raw/image-build.txt" };
}

// fixture-m7: the node base the other fixtures run, by digest.
lock.images.fixture_m7 = { role: "M7's controlled enhanced provider, targets and webhook receiver (tests/fixtures/m7), on the internal fixture network only", status: "selected",
  image: compose.services["fixture-m7"].image, platform: "linux/arm64", source: { server: "tests/fixtures/m7/server.mjs", server_sha256: sha256File("tests/fixtures/m7/server.mjs"), fixture: "tests/fixtures/m7/fixture.mjs", fixture_sha256: sha256File("tests/fixtures/m7/fixture.mjs") } };

// Budgets and rate cards, the egress policy's webhooks: the committed files, by hash.
const budget = JSON.parse(read("deploy/policies/budget.json"));
const egress = JSON.parse(read("deploy/policies/egress.json"));
lock.providers = {
  ...lock.providers,
  budget_policy: { path: "deploy/policies/budget.json", sha256: sha256File("deploy/policies/budget.json"), paid_caps: Object.fromEntries(Object.entries(budget.categories).filter(([, c]) => c.paid).map(([k, c]) => [k, c.caps])),
    paid_total_caps: budget.paidTotal.caps, paid_dispatch: "PI_PAID_DISPATCH_ENABLED=false in deploy/compose.yaml" },
  rate_cards: budget.rateCards,
  enhancers: budget.enhancers, enhancing: budget.enhancing,
  providers: Object.fromEntries(Object.entries(budget.providers).map(([k, v]) => [k, { kind: v.kind, base_url: v.baseUrl, paid: v.paid, credential_file: v.credential, ...(v.usageUrl ? { usage_url: v.usageUrl, usage_credential_file: v.usageCredential } : {}), ...(v.session ? { session: v.session } : {}), ...(v.api ? { api: v.api } : {}) }])),
  enhanced_contract: "Zyte API, checked 2026-09-27: POST https://api.zyte.com/v1/extract, Basic authentication (key as user name), httpResponseBody or browserHtml; only successful responses charged; 520 a ban",
};
lock.egress = { ...lock.egress, policy_sha256: sha256File("deploy/policies/egress.json"), webhooks: egress.webhooks, fixtures: egress.fixtures.map((f) => f.host), guard_sha256: sha256File("deploy/host/fcpi-guard.nft") };
lock.gateway = { ...lock.gateway, capabilities_sha256: sha256File("deploy/policies/capabilities.json"), ledger_schema_version: 3 };

const repo = repoState();
lock.generated_by = "scripts/m7/build-lock.mjs (M7), from the lock M6 closed with at 0318b6e; entries owned by later milestones are as M6 wrote them";
lock.generated_utc = new Date().toISOString().replace(/\.\d+Z$/, "Z");
lock.repository_sha = repo.repository_sha;
lock.worktree_dirty = repo.worktree_dirty;
writeFileSync(resolve(ROOT, LOCK), JSON.stringify(lock, null, 2) + "\n");
console.log(`lock: api ${apiId.slice(7, 19)} series ${series.series_sha256.slice(0, 8)}, retrieval ${lock.images.retrieval.image_id.slice(7, 19)}, gateway ${lock.images.access_gateway.image_id.slice(7, 19)}, mcp ${lock.images.mcp_gateway.image_id.slice(7, 19)}, browser ${lock.images.browser_worker.image_id.slice(7, 19)}, budget ${lock.providers.budget_policy.sha256.slice(0, 8)} (${budget.rateCards.length} rate cards), egress ${lock.egress.policy_sha256.slice(0, 8)}, capabilities ${lock.gateway.capabilities_sha256.slice(0, 8)}`);
