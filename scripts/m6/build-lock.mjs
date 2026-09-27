#!/usr/bin/env node
// Resolve M6's entries in deploy/versions.lock.json from M6 evidence, starting from the lock as M5 closed it (at
// e08c31f), so a re-run resolves the same entries the same way. M6 owns: the patched API image with patch 0009 and
// the nine-patch series, the three service images rebuilt on the Pi (retrieval, gateway, MCP), the budget policy
// with its proxy providers and byte rate cards, the egress policy's residential and routing sections and search
// engine routes, the guard with its proxy-port rule, SearXNG's settings (the residential fixture engine),
// fixture-m6's image, and the capability manifest's hash. Entries owned by other milestones are left as M5 wrote them.
//   node scripts/m6/build-lock.mjs
import { readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { ROOT, sha256File, repoState } from "../m0/lib.mjs";

const LOCK = "deploy/versions.lock.json";
const M5_LOCK_COMMIT = "e08c31f";
const read = (p) => readFileSync(resolve(ROOT, p), "utf8");
const lock = JSON.parse(execFileSync("git", ["-C", ROOT, "show", `${M5_LOCK_COMMIT}:${LOCK}`], { encoding: "utf8" }));
const need = (v, what) => { if (v === undefined || v === null || v === "") throw new Error(`cannot resolve ${what} from evidence`); return v; };
const compose = JSON.parse(read("evidence/M6/rendered-compose.json"));
const running = (svc) => need((compose.services[svc]?.image ?? "").match(/@(sha256:[0-9a-f]{64})$/)?.[1], `${svc}'s image digest in the rendered Compose file`);

// The patched API image: built on the Colima VM (D6) and loaded on the Pi.
const log = read("evidence/M6/raw/api-build.log");
const apiId = need(log.match(/^id=(sha256:[0-9a-f]{64}) os=linux arch=arm64 /m)?.[1], "the API image id in the build log");
need(apiId === running("firecrawl-core") ? true : null, "the core running the logged API build");
const push = read("evidence/M6/raw/api-push.txt");
need(push.includes(`pi_image=${apiId} arm64`) ? true : null, "the Pi holding the logged API build");
const series = JSON.parse(read("patches/series.json"));
need(log.includes(`FCPI_PATCH_SERIES_SHA256=${series.series_sha256}`) ? true : null, "the API image carrying the series hash");
const rc = need(log.match(/^repository_commit=([0-9a-f]{40}) code_dirty=(true|false)$/m), "the API build's repository commit");
lock.images.firecrawl_api_patched = { ...lock.images.firecrawl_api_patched, image_id: apiId, patch_series_sha256: series.series_sha256,
  role: "The API image the stack runs: the pinned commit with patches/ applied; since M6 patch 0009 carries the scrape's proxy option to the retrieval service as the acquisition's route" };
lock.build_provenance.firecrawl_api_image_patched = { ...lock.build_provenance.firecrawl_api_image_patched, image_id: apiId, built_on: "the workstation's Colima VM, natively linux/arm64 (decision D6)",
  built_utc: need(log.match(/^utc=(\S+)$/m)?.[1], "the API build's time"), repository_commit: rc[1], code_dirty: rc[2] === "true", no_cache: /^no_cache=1$/m.test(log),
  build_log: "evidence/M6/raw/api-build.log", transfer: "evidence/M6/raw/api-push.txt (docker save on the VM, docker load on the Pi, the image id compared)", patch_series_sha256: series.series_sha256, result_tree: series.result_tree };
lock.patches = { ...lock.patches, series_sha256: series.series_sha256, result_tree: series.result_tree, patches: series.patches.map((p) => ({ file: p.file, sha256: p.sha256, reason: p.reason })) };

// The service images rebuilt on the Pi from the deployed commit.
const build = read("evidence/M6/raw/image-build.txt");
const image = (svc, dir, key, role) => {
  const tag = svc === "retrieval-service" ? "retrieval" : svc;
  const id = running(svc);
  need([...build.matchAll(new RegExp(`^fcpi/${tag}:m6 id=(sha256:[0-9a-f]{64}) os=linux arch=arm64 `, "gm"))].at(-1)?.[1] === id ? true : null, `${svc} running its last recorded build`);
  const commit = need([...build.matchAll(new RegExp(`^fcpi/${tag}:m6 FCPI_SOURCE_COMMIT=([0-9a-f]{40})$`, "gm"))].at(-1)?.[1], `the commit ${svc}'s image records`);
  const base = need(read(`${dir}/Dockerfile`).match(/^FROM (node:22\.23\.3-bookworm-slim@sha256:[0-9a-f]{64})$/m)?.[1], `${svc}'s digest-pinned base`);
  const pl = JSON.parse(read(`${dir}/package-lock.json`)).packages;
  const packages = Object.fromEntries(Object.entries(pl).filter(([k, v]) => k && !v.dev).map(([k, v]) => [k.replace(/^node_modules\//, ""), { version: need(v.version, k), integrity: need(v.integrity, `${k}'s integrity`) }]));
  lock.images[key] = { ...lock.images[key], role, status: "selected", image_id: id, platform: "linux/arm64", base, built_from_commit: commit,
    dockerfile: { path: `${dir}/Dockerfile`, sha256: sha256File(`${dir}/Dockerfile`) }, lockfile: { path: `${dir}/package-lock.json`, sha256: sha256File(`${dir}/package-lock.json`) }, packages, evidence: "evidence/M6/raw/image-build.txt" };
};
image("retrieval-service", "services/retrieval", "retrieval", "The retrieval-service image (built on the Pi, natively linux/arm64): acquisition, the search, model and parser adapters, and since M6 the residential proxy route, domain routing and proxy reconciliation");
image("access-gateway", "services/access", "access_gateway", "The access gateway image (built on the Pi, natively linux/arm64), with bulk jobs' residential route and route holds since M6");
image("mcp-gateway", "services/mcp", "mcp_gateway", "The MCP service image (built on the Pi, natively linux/arm64), whose scrape tools offer the stealth proxy option since M6");

// fixture-m6: the node base the other fixtures run, by digest.
lock.images.fixture_m6 = { role: "M6's controlled residential proxy and targets (tests/fixtures/m6), on the internal fixture network only", status: "selected",
  image: compose.services["fixture-m6"].image, platform: "linux/arm64", source: { server: "tests/fixtures/m6/server.mjs", server_sha256: sha256File("tests/fixtures/m6/server.mjs"), fixture: "tests/fixtures/m6/fixture.mjs", fixture_sha256: sha256File("tests/fixtures/m6/fixture.mjs") } };

// Budgets and rate cards, routing, the guard, SearXNG's settings: the committed files, by hash.
const budget = JSON.parse(read("deploy/policies/budget.json"));
const egress = JSON.parse(read("deploy/policies/egress.json"));
lock.providers = {
  ...lock.providers,
  budget_policy: { path: "deploy/policies/budget.json", sha256: sha256File("deploy/policies/budget.json"), paid_caps: Object.fromEntries(Object.entries(budget.categories).filter(([, c]) => c.paid).map(([k, c]) => [k, c.caps])),
    paid_total_caps: budget.paidTotal.caps, paid_dispatch: "PI_PAID_DISPATCH_ENABLED=false in deploy/compose.yaml" },
  rate_cards: budget.rateCards,
  proxies: budget.proxies, proxying: budget.proxying,
  providers: Object.fromEntries(Object.entries(budget.providers).map(([k, v]) => [k, { kind: v.kind, base_url: v.baseUrl, paid: v.paid, credential_file: v.credential, ...(v.usageUrl ? { usage_url: v.usageUrl, usage_credential_file: v.usageCredential } : {}), ...(v.session ? { session: v.session } : {}) }])),
  search: { ...lock.providers.search, engines: egress.search.engines, live_engine_hosts: egress.search.engineHosts.live, engine_routes: egress.search.engineRoutes },
};
lock.egress = { policy: "deploy/policies/egress.json", policy_sha256: sha256File("deploy/policies/egress.json"), residential: egress.residential, routing: egress.routing, direct: egress.direct, attempts: egress.attempts,
  guard: "deploy/host/fcpi-guard.nft", guard_sha256: sha256File("deploy/host/fcpi-guard.nft"), proxy_port_rule: "tcp dport 7000 to public addresses, counted as egress_proxy_accepted",
  provider_contract: "Decodo residential, checked 2026-09-26: gate.decodo.com:7000, HTTP CONNECT, username user-<name>-session-<id>-sessionduration-<minutes>; usage by POST https://api.decodo.com/api/v2/statistics/traffic (bytes)" };
lock.images.searxng = { ...lock.images.searxng, settings: { ...lock.images.searxng.settings, sha256: sha256File("deploy/searxng/settings.yml") } };
lock.gateway = { ...lock.gateway, capabilities_sha256: sha256File("deploy/policies/capabilities.json") };

const repo = repoState();
lock.generated_by = "scripts/m6/build-lock.mjs (M6), from the lock M5 closed with at e08c31f; entries owned by later milestones are as M5 wrote them";
lock.generated_utc = new Date().toISOString().replace(/\.\d+Z$/, "Z");
lock.repository_sha = repo.repository_sha;
lock.worktree_dirty = repo.worktree_dirty;
writeFileSync(resolve(ROOT, LOCK), JSON.stringify(lock, null, 2) + "\n");
console.log(`lock: api ${apiId.slice(7, 19)} series ${series.series_sha256.slice(0, 8)}, retrieval ${lock.images.retrieval.image_id.slice(7, 19)}, gateway ${lock.images.access_gateway.image_id.slice(7, 19)}, mcp ${lock.images.mcp_gateway.image_id.slice(7, 19)}, budget ${lock.providers.budget_policy.sha256.slice(0, 8)} (${budget.rateCards.length} rate cards), egress ${lock.egress.policy_sha256.slice(0, 8)}, guard ${lock.egress.guard_sha256.slice(0, 8)}, capabilities ${lock.gateway.capabilities_sha256.slice(0, 8)}`);
