#!/usr/bin/env node
// Resolve the search intelligence release's entries in deploy/versions.lock.json from SI6's cutover evidence, starting from the
// lock as committed at HEAD (git show), so a re-run resolves the same entries the same way. SI6 owns: the patched API image
// with patch 0011 and the eleven-patch series, the retrieval, gateway and MCP images rebuilt on the Pi, the budget policy's
// hash and paid caps, its rate cards, its providers (merged into each provider's existing entry), the search profile and its
// providers and categories (merged into the existing search entry, whose SearXNG fallback fields stay), and the egress and
// capability policies' hashes. Every image is taken only when the cutover record shows it running and healthy, its build log
// names it, the record's deployed commit is HEAD and HEAD's compose pin is that image. Every other entry is asserted unchanged.
//   node scripts/si6/build-lock.mjs     (after the cutover's record, evidence/search-intelligence/SI6/raw/)
// --policy-only refreshes only the policy entries (the budget policy's hash and caps, rate cards, providers, search, the egress
// and capability hashes), for the fast rollback, which changes the budget policy and no image.
// FCPI_SI6_RAW names another evidence directory (the verifier's synthetic evidence); the lock is written only when it is unset
// or FCPI_SI6_LOCK_OUT names where to write.
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { ROOT, sha256, repoState } from "../m0/lib.mjs";

const LOCK = "deploy/versions.lock.json", RAW = process.env.FCPI_SI6_RAW ?? "evidence/search-intelligence/SI6/raw", OUT = process.env.FCPI_SI6_LOCK_OUT ?? (process.env.FCPI_SI6_RAW ? null : LOCK);
const read = (p) => readFileSync(resolve(ROOT, p), "utf8");
const git = (...a) => execFileSync("git", ["-C", ROOT, ...a], { encoding: "utf8" });
const base = JSON.parse(git("show", `HEAD:${LOCK}`));
const lock = structuredClone(base);
const need = (v, what) => { if (v === undefined || v === null || v === "") throw new Error(`cannot resolve ${what} from evidence`); return v; };
const head = git("rev-parse", "HEAD").trim(), POLICY_ONLY = process.argv.includes("--policy-only");
// Every input is HEAD's, so the lock describes the commit it is written for; code that differs from HEAD is refused.
need(repoState().code_dirty ? null : true, "a clean code tree (evidence aside)");
const sha256File = (p) => sha256(execFileSync("git", ["-C", ROOT, "show", `HEAD:${p}`]));
let apiId = null;
if (!POLICY_ONLY) {
const cutover = read(`${RAW}/cutover.txt`);
need(/^end_marker=reached /m.test(cutover) ? true : null, "a completed cutover (its end marker)");
need(cutover.match(/^utc=\S+ deployed_commit=([0-9a-f]{40}) mode=cutover /m)?.[1] === head ? true : null, "a cutover of HEAD (the commit whose pins this lock records)");
const compose = git("show", "HEAD:deploy/compose.yaml");
const running = (svc, repo) => {
  const m = cutover.match(new RegExp(`^${svc} image=(sha256:[0-9a-f]{64}) status=(\\S+) health=(\\S+)$`, "m"));
  need(m?.[2] === "running" && m?.[3] === "healthy" ? true : null, `${svc} running and healthy after the cutover`);
  need(compose.includes(`${repo}@${m[1]}`) ? true : null, `HEAD's compose pin for ${svc} being the running image`);
  return m[1];
};

// The patched API image: built on the Colima VM from a clean tree with every step run (D6), carried to the Pi.
const log = read(`${RAW}/api-build.log`);
apiId = need(log.match(/^id=(sha256:[0-9a-f]{64}) os=linux arch=arm64 /m)?.[1], "the API image id in the build log");
need(apiId === running("firecrawl-core", "fcpi/firecrawl-api") ? true : null, "the core running the logged API build");
need(read(`${RAW}/api-push.txt`).includes(`pi_image=${apiId} arm64`) ? true : null, "the Pi holding the logged API build");
const series = JSON.parse(git("show", "HEAD:patches/series.json"));
need(log.includes(`FCPI_PATCH_SERIES_SHA256=${series.series_sha256}`) ? true : null, "the API image carrying the series hash");
const rc = need(log.match(/^repository_commit=([0-9a-f]{40}) code_dirty=(true|false)$/m), "the API build's repository commit");
need(rc[2] === "false" && /^no_cache=1$/m.test(log) ? true : null, "a build of record (clean tree, every step run)");
lock.images.firecrawl_api_patched = { ...lock.images.firecrawl_api_patched, image_id: apiId, patch_series_sha256: series.series_sha256,
  role: "The API image the stack runs: the pinned commit with patches/ applied; since SI6 patch 0011 carries the caller's original query, options, trusted context and deadline to the retrieval service's search coordinator, and the bounded evidence payload" };
lock.build_provenance.firecrawl_api_image_patched = { ...lock.build_provenance.firecrawl_api_image_patched, image_id: apiId, built_on: "the workstation's Colima VM, natively linux/arm64 (decision D6)",
  built_utc: need(log.match(/^utc=(\S+)$/m)?.[1], "the API build's time"), repository_commit: rc[1], code_dirty: false, no_cache: true, patch_series_sha256: series.series_sha256, result_tree: series.result_tree,
  build_log: `${RAW}/api-build.log`, transfer: `${RAW}/api-push.txt (docker save on the VM, docker load on the Pi, the image id compared)` };
lock.patches = { ...lock.patches, series_sha256: series.series_sha256, result_tree: series.result_tree, patches: series.patches.map((p) => ({ file: p.file, sha256: p.sha256, reason: p.reason })) };

// The three service images rebuilt on the Pi from the staged release candidate (scripts/si6/pi-build-images.sh's transcript).
const build = read(`${RAW}/image-build.txt`);
need(/^end$/m.test(build) ? true : null, "a completed image build transcript");
const packagesOf = (dir) => Object.fromEntries(Object.entries(JSON.parse(git("show", `HEAD:${dir}/package-lock.json`)).packages).filter(([k, v]) => k && !v.dev)
  .map(([k, v]) => [k.replace(/^node_modules\//, ""), { version: need(v.version, k), integrity: need(v.integrity, `${k}'s integrity`) }]));
const image = (svc, tag, dir, key, role) => {
  const id = running(svc, `fcpi/${tag}`);
  need([...build.matchAll(new RegExp(`^fcpi/${tag}:si6 id=(sha256:[0-9a-f]{64}) os=linux arch=arm64 `, "gm"))].at(-1)?.[1] === id ? true : null, `${svc} running its recorded build`);
  const commit = need([...build.matchAll(new RegExp(`^fcpi/${tag}:si6 FCPI_SOURCE_COMMIT=([0-9a-f]{40})$`, "gm"))].at(-1)?.[1], `the commit ${svc}'s image records`);
  const from = need(git("show", `HEAD:${dir}/Dockerfile`).match(/^FROM (node:22\.23\.3-bookworm-slim@sha256:[0-9a-f]{64})$/m)?.[1], `${svc}'s digest-pinned base`);
  lock.images[key] = { ...lock.images[key], role, status: "selected", image_id: id, platform: "linux/arm64", base: from, built_from_commit: commit,
    dockerfile: { path: `${dir}/Dockerfile`, sha256: sha256File(`${dir}/Dockerfile`) }, lockfile: { path: `${dir}/package-lock.json`, sha256: sha256File(`${dir}/package-lock.json`) },
    packages: packagesOf(dir), evidence: `${RAW}/image-build.txt` };
};
image("retrieval-service", "retrieval", "services/retrieval", "retrieval", `${base.images.retrieval.role.replace(/; since SI6 .*$/, "")}; since SI6 the search intelligence coordinator (five general engines, Context7 and Ref, Jev decisions), its evidence hook and its operational records`);
image("access-gateway", "access-gateway", "services/access", "access_gateway", `${base.images.access_gateway.role.replace(/; since SI6 .*$/, "")}; since SI6 the searchIntelligence options and the search's trusted context headers`);
image("mcp-gateway", "mcp-gateway", "services/mcp", "mcp_gateway", `${base.images.mcp_gateway.role.replace(/; since SI6 .*$/, "")}; since SI6 the search tool's searchIntelligence options and fcpi.search compaction`);
}

// Budgets, rate cards and the search providers, each merged into what the lock already holds; the policies by hash.
const budget = JSON.parse(git("show", "HEAD:deploy/policies/budget.json"));
const providerEntry = (v) => ({ kind: v.kind, base_url: v.baseUrl, paid: v.paid, credential_file: v.credential, ...(v.usageUrl ? { usage_url: v.usageUrl, usage_credential_file: v.usageCredential } : {}),
  ...(v.session ? { session: v.session } : {}), ...(v.api ? { api: v.api } : {}) });
lock.providers = {
  ...lock.providers,
  budget_policy: { ...lock.providers.budget_policy, path: "deploy/policies/budget.json", sha256: sha256File("deploy/policies/budget.json"),
    paid_caps: Object.fromEntries(Object.entries(budget.categories).filter(([, c]) => c.paid).map(([k, c]) => [k, c.caps])), paid_total_caps: budget.paidTotal.caps },
  rate_cards: budget.rateCards,
  providers: Object.fromEntries(Object.entries(budget.providers).map(([k, v]) => [k, { ...lock.providers.providers?.[k], ...providerEntry(v) }])),
  search: { ...lock.providers.search, profile: budget.searching.profile, general: budget.searching.generalSubjects, documentation: budget.searching.documentationSubjects, decision: budget.searching.decisionSubject,
    decision_model: budget.decisions?.[budget.searching.decisionSubject]?.model ?? null, searxng_mode: budget.searching.searxngMode,
    categories: Object.fromEntries(Object.entries(budget.categories).filter(([k]) => /^(search_|docs_|decisions_)/.test(k)).map(([k, c]) => [k, { paid: c.paid, unit: c.unit, caps: c.caps }])),
    serper_allocation: { category: "serper_trial", credits: budget.searching.allocationCredits, renewal: false } },
};
lock.egress = { ...lock.egress, policy_sha256: sha256File("deploy/policies/egress.json") };
lock.gateway = { ...lock.gateway, capabilities_sha256: sha256File("deploy/policies/capabilities.json") };

// Nothing SI6 does not own has moved: every other entry of the committed lock is as it was.
const OWNED = new Set(["images.firecrawl_api_patched", "images.retrieval", "images.access_gateway", "images.mcp_gateway", "build_provenance.firecrawl_api_image_patched", "patches",
  "providers.budget_policy", "providers.rate_cards", "providers.providers", "providers.search", "egress.policy_sha256", "gateway.capabilities_sha256",
  "generated_by", "generated_utc", "repository_sha", "worktree_dirty"]);
const moved = [];
const compare = (a, b, path) => {
  if (OWNED.has(path)) return;
  if (a && b && typeof a === "object" && typeof b === "object" && !Array.isArray(a) && !Array.isArray(b)) { for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) compare(a[k], b[k], path ? `${path}.${k}` : k); return; }
  if (JSON.stringify(a) !== JSON.stringify(b)) moved.push(path);
};
compare(base, lock, "");
// Within the merged entries, only SI6's fields change: every provider keeps its earlier fields, the search entry its fallback.
for (const [k, v] of Object.entries(base.providers.providers ?? {})) for (const f of Object.keys(v)) if (!(f in lock.providers.providers[k])) moved.push(`providers.providers.${k}.${f} dropped`);
const SI6_SEARCH = new Set(["profile", "general", "documentation", "decision", "decision_model", "searxng_mode", "categories", "serper_allocation"]);
for (const f of Object.keys(base.providers.search ?? {})) if (!SI6_SEARCH.has(f) && JSON.stringify(base.providers.search[f]) !== JSON.stringify(lock.providers.search[f])) moved.push(`providers.search.${f}`);
need(moved.length ? null : true, `no change outside SI6's entries (moved: ${moved.join(", ")})`);

const repo = repoState();
lock.generated_by = "scripts/si6/build-lock.mjs (search intelligence SI6), from the lock as committed before the cutover; entries owned by earlier milestones are as they were";
lock.generated_utc = new Date().toISOString().replace(/\.\d+Z$/, "Z");
lock.repository_sha = repo.repository_sha;
lock.worktree_dirty = repo.worktree_dirty;
if (OUT) writeFileSync(resolve(ROOT, OUT), JSON.stringify(lock, null, 2) + "\n");
console.log(`lock: ${POLICY_ONLY ? "policies only" : `api ${apiId.slice(7, 19)}, retrieval ${lock.images.retrieval.image_id.slice(7, 19)}, gateway ${lock.images.access_gateway.image_id.slice(7, 19)}, mcp ${lock.images.mcp_gateway.image_id.slice(7, 19)}`}, budget ${lock.providers.budget_policy.sha256.slice(0, 8)} profile ${lock.providers.search.profile}${OUT ? "" : " (not written)"}`);
