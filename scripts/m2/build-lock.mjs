#!/usr/bin/env node
// Resolve M2's entries in deploy/versions.lock.json from M2 evidence, starting from the lock as M1
// closed it (at 191c146), so a re-run resolves the same entries the same way. M2 owns the browser,
// the Go build stage, the Rust toolchain, the patch series, the patched API image (replacing the
// acquired one, review finding Q7), the retrieval and browser images, and the core's runtime
// configuration. Entries owned by other milestones are left as M1 wrote them.
// Usage: node scripts/m2/build-lock.mjs
import { readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { ROOT, sha256File, sections, repoState } from "../m0/lib.mjs";
import { d1, SRC } from "./d1.mjs";

const LOCK = "deploy/versions.lock.json";
const M1_LOCK_COMMIT = "191c146";
const read = (p) => readFileSync(resolve(ROOT, p), "utf8");
const lock = JSON.parse(execFileSync("git", ["-C", ROOT, "show", `${M1_LOCK_COMMIT}:${LOCK}`], { encoding: "utf8" }));
const need = (v, what) => { if (v === undefined || v === null || v === "" || Number.isNaN(v)) throw new Error(`cannot resolve ${what} from evidence`); return v; };
const compose = JSON.parse(read("evidence/M2/rendered-compose.json"));
const digestOf = (svc) => need((compose.services[svc]?.image ?? "").match(/@(sha256:[0-9a-f]{64})$/)?.[1], `${svc}'s image digest in the rendered Compose file`);
const resolved = read("evidence/M2/registry/resolved.jsonl").split("\n").filter(Boolean).map((l) => JSON.parse(l));
const registry = (repo, tag) => { const r = need(resolved.find((x) => x.repository === repo && x.tag === tag), `${repo}:${tag} in evidence/M2/registry/resolved.jsonl`); return { ...r, platform: "linux/arm64" }; };

// ---- the browser: D1 admission, archives, installed files, native launch ------------------------
const D = d1();
need(D.rows.length && D.rows.every((r) => r.pass) ? true : null, "D1 admission (a CVE fails both tests)");
const archives = read(`${SRC}chromium-153.0.8010.12-linux-arm64-archives.txt`).split("\n").filter((l) => l && !l.startsWith("#")).map((l) => { const [name, url, bytes, sha256] = l.split("\t"); return { name, url, bytes: Number(bytes), sha256 }; });
const inArchive = new Map();
for (const [name, file] of [["chrome", "chrome-linux-arm64"], ["chrome-headless-shell", "chrome-headless-shell-linux-arm64"]]) {
  for (const l of read(`${SRC}chromium-153.0.8010.12-${file}.files.sha256`).split("\n").filter(Boolean)) { const [h, p] = l.split(/\s+/); inArchive.set(p.replace(/^\.\//, ""), { h, name }); }
}
const proof = sections("evidence/M2/raw/browser-proof.txt");
const installed = (proof.installed_files_sha256 ?? []).filter((l) => /^[0-9a-f]{64}\s/.test(l)).map((l) => { const [h, p] = l.split(/\s+/); return { h, p }; })
  .filter((x) => x.p.split("/").length > 2).map((x) => ({ ...x, rel: x.p.slice(x.p.indexOf("/") + 1) }));
const matched = installed.filter((x) => inArchive.get(x.rel)?.h === x.h).length;
need(matched === installed.length && installed.length > 0 ? true : null, `every installed Chromium file matching its archive (${matched}/${installed.length})`);
const proofMeta = Object.fromEntries((proof.meta ?? []).filter((l) => l.includes("=")).map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]));
const playwrightImage = registry("playwright", "v1.63.0-noble");

lock.browser = {
  playwright: "1.63.0",
  admission: {
    rule: "Decision D1: the newest stable Playwright at the build date, admitted only if its bundled Chromium carries the fix for every Chrome bug marked exploited in the wild by that date; test (a) preferred, test (b) only where (a) fails.",
    npm_latest_at_build: D.latest, bundled_chromium: D.bundled, v8_revision: D.v8rev, v8_branch: D.v8_branch, milestone_branch_point: D.branch_point,
    later_v8_branch_commits_checked: D.later_branch_commits, admitted: true,
    sources: `${SRC}d1-index.txt`, derived_by: "scripts/m2/d1.mjs",
  },
  in_the_wild: D.rows.map((r) => ({ cve: r.cve, bug: r.bug, first_fixed: r.first_fixed, test_a: r.test_a, test_b: r.test_b, fix_commit: r.fix_commit, fix_after_branch_point: r.after_branch_point })),
  chromium_revision: D.revision,
  chromium_version: D.bundled,
  version_source: `${SRC}playwright-core-1.63.0-browsers.json`,
  arm64_archives: archives,
  archive_sha256: { status: "resolved", source: `${SRC}chromium-153.0.8010.12-linux-arm64-archives.txt`,
    installed_files_matching_archives: `${matched}/${installed.length}`, installed_files_source: "evidence/M2/raw/browser-proof.txt (installed_files_sha256)" },
  base_image: { ...playwrightImage, role: "Base of the browser worker (deploy/browser/Dockerfile)" },
  native_launch_on_host: { status: "resolved", kernel: proofMeta.kernel, evidence: "evidence/M2/raw/browser-proof.txt",
    result: "native aarch64, every LOAD segment 16 KiB-aligned or more, non-root, sandbox on under the project seccomp profile (deploy/browser/seccomp.json)" },
};

// ---- the build of record: Go, Rust, the patched API image ---------------------------------------
const log = read("evidence/M2/raw/api-build.log");
const pick = (re, what) => need((log.match(re) ?? [])[1], what);
const series = JSON.parse(read("patches/series.json"));
const apiId = pick(/^id=(sha256:[0-9a-f]{64}) os=linux arch=arm64/m, "the API image id in the build log");
need(apiId === digestOf("firecrawl-core") ? true : null, "the running core's image being the build of record");
const goImage = registry("library/golang", "1.27.1-bookworm"), rustImage = registry("library/rust", "1.98.1-slim-bookworm");
lock.images.go_build = { role: "Build stage for libhtml-to-markdown.so (decision D4)", selected: goImage, go_version: pick(/(go version go\S+ linux\/arm64)/, "the go version line"), status: "selected" };
lock.images.rust_toolchain = { role: "Rust toolchain copied into the API build stage", selected: rustImage, status: "selected" };
lock.runtimes.go_build_stage = { selected: "1.27.1", image: `golang:1.27.1-bookworm@${goImage.arm64_manifest_digest}`, gotoolchain: pick(/^#\d+ [\d.]+ (local)$/m, "GOTOOLCHAIN=local"), status: "resolved", evidence: "evidence/M2/raw/api-build.log" };
lock.runtimes.rust_toolchain = { selected: "1.98.1", image: `rust:1.98.1-slim-bookworm@${rustImage.arm64_manifest_digest}`, rustc: pick(/(rustc 1\.98\.1 \([^)]+\))/, "rustc"), cargo: pick(/(cargo 1\.98\.1 \([^)]+\))/, "cargo"),
  cargo_lock: "native/Cargo.lock, committed through patches/0006-reproducible-arm64-build.patch; the native build runs cargo --locked", status: "resolved", evidence: "evidence/M2/raw/api-build.log" };
lock.native_dependencies.foundationdb_client.verified_in_build = { check: pick(/(\/tmp\/fdb-clients\.deb: OK)/, "the FoundationDB client hash check"), evidence: "evidence/M2/raw/api-build.log" };
lock.patches = { status: "resolved", upstream_commit: series.upstream.commit, series_sha256: series.series_sha256, series_sha256_definition: series.series_sha256_definition, result_tree: series.result_tree,
  patches: series.patches.map((p) => ({ file: p.file, sha256: p.sha256, reason: p.reason })), manifest: "patches/series.json (symbols, tests and the call-site coverage of each traced path)" };
lock.images.firecrawl_api_patched = {
  role: "The API image the stack runs from M2: the pinned commit with patches/ applied (review finding Q7, decision D6)", status: "selected",
  image_id: apiId, platform: "linux/arm64", source_commit: series.upstream.commit, patch_series_sha256: series.series_sha256,
};
lock.images.firecrawl_api_prebuilt.status = "superseded";
lock.images.firecrawl_api_prebuilt.reason = "Decision D6: acquired by arm64 digest for M1; from M2 the stack runs the patched project build (images.firecrawl_api_patched). Kept for rollback to the M1 fixture-only profile.";
const cfg = compose.services["firecrawl-core"].environment;
lock.images.firecrawl_api_patched.runtime_configuration = {
  NUQ_WORKER_COUNT: cfg.NUQ_WORKER_COUNT, USE_DB_AUTHENTICATION: cfg.USE_DB_AUTHENTICATION, SCRAPE_MAX_ATTEMPTS: cfg.SCRAPE_MAX_ATTEMPTS,
  ALLOW_LOCAL_WEBHOOKS: "ALLOW_LOCAL_WEBHOOKS" in cfg ? cfg.ALLOW_LOCAL_WEBHOOKS : "unset (review finding R4; the patched config refuses the pi-resilient profile if it is set)",
  DISABLE_WEBHOOK_DELIVERY: cfg.DISABLE_WEBHOOK_DELIVERY, PI_RETRIEVAL_URL: cfg.PI_RETRIEVAL_URL, SEARXNG_ENDPOINT: cfg.SEARXNG_ENDPOINT,
  USE_GO_MARKDOWN_PARSER: "USE_GO_MARKDOWN_PARSER" in cfg ? cfg.USE_GO_MARKDOWN_PARSER : "unset (Go library inert; upstream default)", NODE_OPTIONS: cfg.NODE_OPTIONS,
};
const commitLine = log.match(/^repository_commit=([0-9a-f]{40}) code_dirty=(true|false)$/m) ?? [];
lock.build_provenance.firecrawl_api_image_patched = {
  image_id: apiId, built_on: "the workstation's Colima VM, natively linux/arm64 (decision D6)", built_utc: pick(/^utc=(\S+)$/m, "the build time"),
  repository_commit: need(commitLine[1], "the build's repository commit"), code_dirty: commitLine[2] === "true", no_cache: /^no_cache=1$/m.test(log),
  patch_series_sha256: pick(/FCPI_PATCH_SERIES_SHA256=([0-9a-f]{64})/, "the series hash in the image"), result_tree: series.result_tree,
  go_version: lock.images.go_build.go_version, rustc: lock.runtimes.rust_toolchain.rustc, node: pick(/^#\d+ [\d.]+ (v22\.23\.3)$/m, "the node version"), pnpm: pick(/^#\d+ [\d.]+ (11\.4\.0)$/m, "the pnpm version"),
  debian_snapshot: pick(/fcpi-apt-build: snapshot=(\S+)/, "the Debian snapshot"), provenance: false, sbom: false, evidence: "evidence/M2/raw/api-build.log",
};

// ---- the project services' images ----------------------------------------------------------------
const services = read("evidence/M2/raw/service-build.txt");
const lastBuild = (name) => [...services.matchAll(new RegExp(`^fcpi/${name}:m2 id=(sha256:[0-9a-f]{64})`, "gm"))].map((m) => m[1]).pop();
for (const [key, name, svc, dockerfile, base] of [["retrieval", "retrieval", "retrieval-service", "services/retrieval/Dockerfile", lock.images.node_base.selected.arm64_manifest_digest],
  ["browser_worker", "browser", "browser-worker", "deploy/browser/Dockerfile", playwrightImage.arm64_manifest_digest]]) {
  const id = digestOf(svc);
  need(lastBuild(name) === id ? true : null, `${svc} running its last recorded build`);
  lock.images[key] = { role: `The ${svc} image (built on the Pi, natively linux/arm64)`, status: "selected", image_id: id, platform: "linux/arm64", base_manifest_digest: base,
    dockerfile: { path: dockerfile, sha256: sha256File(dockerfile) }, evidence: "evidence/M2/raw/service-build.txt" };
}

const repo = repoState();
lock.generated_by = "scripts/m2/build-lock.mjs (M2), from the lock M1 closed with at 191c146; entries owned by later milestones are as M1 wrote them";
lock.generated_utc = new Date().toISOString().replace(/\.\d+Z$/, "Z");
lock.repository_sha = repo.repository_sha;
lock.worktree_dirty = repo.worktree_dirty;
writeFileSync(resolve(ROOT, LOCK), JSON.stringify(lock, null, 2) + "\n");
console.log(`lock: playwright ${lock.browser.playwright} (${D.rows.length} in-the-wild CVEs), api ${apiId.slice(7, 19)}, retrieval ${lock.images.retrieval.image_id.slice(7, 19)}, browser ${lock.images.browser_worker.image_id.slice(7, 19)}, series ${series.series_sha256.slice(0, 8)}, installed files matching archives ${matched}/${installed.length}`);
