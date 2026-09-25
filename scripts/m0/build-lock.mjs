#!/usr/bin/env node
// Build deploy/versions.lock.json.
// Image digests come from the resolver output (evidence/M0/registry/digests.jsonl);
// versions, integrities, checksums and sizes come from the saved retrievals in
// evidence/M0/sources/ (scripts/m0/fetch-sources.sh). Nothing is retyped. Values
// that M0 could not resolve are written as explicit {status:"unresolved", reason}.
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { ROOT, repoState } from "./lib.mjs";

const SRC = "evidence/M0/sources";
const srcText = (name) => readFileSync(resolve(ROOT, SRC, name), "utf8");
const srcBody = (name) => srcText(name).split("\n").filter((l) => !l.startsWith("# ")).join("\n");
const srcJson = (name) => JSON.parse(srcBody(name));
const retrieved = (name) => (srcText(name).match(/^# retrieved_utc=(\S+)/m) || [])[1];
const cite = (name) => ({ source: `${SRC}/${name}`, retrieved_utc: retrieved(name) });

const rows = readFileSync(resolve(ROOT, "evidence/M0/registry/digests.jsonl"), "utf8")
  .split("\n").filter(Boolean).map((l) => JSON.parse(l));
const img = (repo, tag) => {
  const r = rows.find((d) => d.repository === repo && d.tag === tag);
  if (!r) throw new Error(`no resolved row for ${repo}:${tag}`);
  const keep = ({ registry, repository, tag, resolved_utc, status, index_digest, registry_reported_digest, arm64_manifest_digest, platform, index_file, arm64_manifest_file, unresolved_reason }) =>
    ({ registry, repository, tag, resolved_utc, status, index_digest, registry_reported_digest, arm64_manifest_digest, platform, index_file, arm64_manifest_file, ...(unresolved_reason ? { unresolved_reason } : {}) });
  return keep(r);
};
// A floating tag and its exact tag must share one index digest; stop if they diverge.
const sameAs = (repo, floating, exact) => {
  const x = img(repo, floating).index_digest, y = img(repo, exact).index_digest;
  if (x !== y) throw new Error(`${repo}:${floating} (${x}) no longer resolves to ${exact} (${y}); re-resolve before building the lock`);
  return `${repo}:${floating}`;
};
const unresolved = (reason, extra = {}) => ({ status: "unresolved", reason, ...extra });
const npmPkg = (file) => {
  const j = srcJson(file);
  return { selected: j.version, engines_node: j.engines?.node, integrity: j["dist.integrity"], dependencies: j.dependencies, ...(j.peerDependencies ? { peerDependencies: j.peerDependencies } : {}), ...cite(file) };
};
const node22 = srcJson("nodejs-v22.json");
const nodeLatest = node22[0], nodeSecurity = node22.find((r) => r.security);
const goStable = srcJson("go-dl.json").filter((r) => r.stable).map((r) => r.version);
const pgCronVersions = [...srcBody("pgdg-trixie-arm64-postgresql-17-cron.txt").matchAll(/^Version: (\S+)$/gm)].map((m) => m[1]);
const fdbSha = srcBody("fdb-7.3.63-clients-aarch64.deb.sha256").trim().split(/\s+/)[0];
const fdbAsset = srcJson("fdb-7.3.63-clients-aarch64-asset.json")[0];
const tags = srcBody("firecrawl-tags-latest.txt").trim().split("\n");
const release = srcJson("firecrawl-release-latest.json");
const dockerCe = Object.fromEntries(srcBody("docker-ce-trixie-arm64-versions.txt").trim().split("\n").map((l) => l.split(" ")));
// Redirect hops carry their own Content-Length (0); the final response is the last one.
const archiveBytes = (z) => { const all = [...srcBody(`playwright-chromium-1208-${z}.head.txt`).matchAll(/^Content-Length: (\d+)/gmi)].map((m) => Number(m[1])); const n = all.at(-1); if (!(n > 0)) throw new Error(`no final Content-Length for ${z}`); return n; };
const server21 = srcJson("npm-modelcontextprotocol_server_2.1.0.json");
if (!/^[0-9a-f]{64}$/.test(fdbSha)) throw new Error("FDB checksum file malformed");
if (!nodeLatest || !nodeSecurity || goStable.length === 0 || pgCronVersions.length === 0) throw new Error("a source file parsed empty");

const lock = {
  schema: "fcpi.versions-lock/v1",
  generated_utc: new Date().toISOString().replace(/\.\d+Z$/, "Z"),
  generated_by: "scripts/m0/build-lock.mjs (M0)",
  ...repoState(),
  repository_sha_note: "The commit checked out when this file was generated. The commit that stores it is a later one on main.",
  note: "Implementation artifact, not a canonical document. 'selected' entries are the M0 baseline; 'candidate' entries await the decision named in evidence/M0/INTERPRETATION.md and change nothing until that decision is recorded.",

  firecrawl: {
    repository: "https://github.com/firecrawl/firecrawl",
    channel: "API-image tags (v2.11.x); distinct from formal GitHub Releases",
    tag: "v2.11.162",
    tag_object: "ebfe595c3e218266c627f8651ccbcbe38f4ecfdd",
    tag_type: "annotated",
    tag_signature: "unsigned (GitHub verification.reason=unsigned)",
    tagger_date_utc: "2026-07-30T20:47:43Z",
    commit: "7666c1f9ae8720a6bba271e0f60b6a217f8a5210",
    compose_blob: "e2ade0104390caf31cdcae04faa619c2674dc693",
    evidence: ["evidence/M0/upstream/raw/ls-remote.txt", "evidence/M0/upstream/raw/gh-ref.json", "evidence/M0/upstream/raw/gh-tag-object.json"],
    verified_by: "scripts/m0/verify.mjs V05 (live)",
    formal_release_latest: { tag: release.tag_name, published_utc: release.published_at, tag_type: "lightweight (git ls-remote returned no peeled ^{} ref)", commit: "ef12eb36b2f3382838dfe0a0c1a5add3d5df7fe5", relation: "separate channel; not the pinned snapshot", ...cite("firecrawl-release-latest.json") },
    newer_api_image_tags: { latest_observed: tags[0], ...cite("firecrawl-tags-latest.txt"), status: "candidate", reason: "No post-2026-07-30 Firecrawl advisory affects self-hosted v2.11.162 (evidence/M0/security-review.md §C); the self-host guide still pins v2.11.162. Not adopted." },
    known_open_issues_at_pin: [
      "Transitive ip-address@6.4.0 (GHSA-mwp4-54f8-5fhr / CVE-2026-69192): octal/leading-zero IP SSRF forms; deferred upstream at every tag. Handled by the project SSRF layer (M2).",
      "Redirect-to-blocklisted-domain gap in single/batch scrape fixed after the pin in 58d0c8ebb6 (PR #4581): cherry-pick candidate for the M2 patch series.",
      "CVE-2026-32857 redirect SSRF in the upstream Playwright service: that service is replaced by the project browser worker (M2).",
      "POST /admin/integration/* proxies to integrations.firecrawl.dev without auth (evidence/M0/source-review.json S15): the gateway must never route /admin/* to the native API.",
    ],
  },

  mcp: {
    protocol_revision: { selected: "2026-07-28", verified_current_stable_utc: "2026-09-25T03:14:49Z", newer_revision: "none (only the rolling draft)", compatibility_revision: "2025-11-25", source: "evidence/M0/security-review.md §A" },
    packages: {
      "@modelcontextprotocol/server": npmPkg("npm-modelcontextprotocol_server_2.0.0.json"),
      "@modelcontextprotocol/core": npmPkg("npm-modelcontextprotocol_core_2.0.0.json"),
      "@modelcontextprotocol/node": npmPkg("npm-modelcontextprotocol_node_2.0.0.json"),
    },
    dist_tags: { ...srcJson("npm-mcp-server-dist-tags.json"), ...cite("npm-mcp-server-dist-tags.json") },
    transitive_exact_versions: unresolved("hono, @hono/node-server and zod resolve only in the M4 package lock; M0 runs no npm install."),
    candidate: { version: server21.version, server_integrity: server21["dist.integrity"], ...cite("npm-modelcontextprotocol_server_2.1.0.json"), status: "candidate", reason: "2.1.0 adds a 4 MiB request-body cap and 100-message batch cap (#2698) and rejects modern requests missing MCP-Protocol-Version (#2590); 2.0.0 has neither. No GHSA exists for v2 packages. Decision D5 (separate review)." },
  },

  runtimes: {
    node: { selected: nodeLatest.version.slice(1), lts: nodeLatest.lts, released: nodeLatest.date, minimum_security_patch: nodeSecurity.version.slice(1), minimum_security_patch_released: nodeSecurity.date, image: "node:22.23.3-bookworm-slim", same_index_digest_as: sameAs("library/node", "22-slim", "22.23.3-bookworm-slim"), ...cite("nodejs-v22.json") },
    go_build_stage: { upstream: "golang:1.24", resolves_to: "1.24.13", same_index_digest_as: sameAs("library/golang", "1.24", "1.24.13"), supported_go_lines_observed: goStable, ...cite("go-dl.json"), status: "candidate", reason: "Go 1.24 is not among the supported releases go.dev lists; it builds only libhtml-to-markdown.so. Relevant only if the API image is built from source (decision D6); moving the build stage is decision D4." },
    rust_toolchain: unresolved("Upstream installs rustup's default stable at build time and ships no Cargo.lock (native/.gitignore); two git dependencies track branches. A project build must pin the toolchain and commit a generated Cargo.lock (M1/M2)."),
    pnpm: { upstream: "11.4.0", source: "evidence/M0/upstream/findings.md (apps/api/Dockerfile)" },
  },

  images: {
    node_base: { role: "API build/runtime base and project Node services", selected: img("library/node", "22.23.3-bookworm-slim") },
    nuq_postgres_base: {
      role: "NuQ PostgreSQL base (built with apps/nuq-postgres/Dockerfile)",
      selected: img("library/postgres", "17.11-trixie"), same_index_digest_as: sameAs("library/postgres", "17", "17.11-trixie"),
      note: "17.11 (2026-08-13) fixed 28 CVEs; do not go below it.",
      pg_cron_package: { name: "postgresql-17-cron", pgdg_trixie_arm64_versions_observed: pgCronVersions, ...cite("pgdg-trixie-arm64-postgresql-17-cron.txt"), status: "unresolved", reason: "Upstream installs it unpinned; the exact version is fixed when the M1 image is built and must be recorded then." },
    },
    redis: {
      role: "Redis", selected: img("library/redis", "8.10.2-alpine"), same_index_digest_as: sameAs("library/redis", "alpine", "8.10.2-alpine"),
      note: "Upstream uses the floating redis:alpine tag, which resolves to this digest. 8.10.2 includes the 2026-08-17 and 2026-09-17 security releases. License: RSALv2/SSPLv1/AGPLv3 (personal use).",
      jemalloc_page_size: { lg_page: 16, meaning: "supports pages up to 64 KiB, including this host's 16 KiB", ...cite("redis-jemalloc-lg-page.txt") },
    },
    rabbitmq: {
      role: "RabbitMQ (NuQ messaging)",
      selected: unresolved("Decision D3 (separate review): upstream compose pins rabbitmq:3-management (3.13.7, community support ended); 4.3.6 is the only community-supported series (evidence/M0/sources/rabbitmq-release-information.txt). NuQ declares only quorum queues and one exclusive classic reply queue, both valid on 4.x."),
      candidates: [
        { ...img("library/rabbitmq", "3.13.7"), why: "same major as upstream compose, without the management plugin (spec §22)" },
        { ...img("library/rabbitmq", "4.3.6"), why: "supported series; fixes the 2026-08/09 advisories" },
      ],
      upstream_reference: img("library/rabbitmq", "3-management"),
      support_dates: cite("rabbitmq-release-information.txt"),
    },
    searxng: { role: "Private metasearch", selected: img("searxng/searxng", "2026.9.23-3cd69d30e"), same_index_digest_as_at_m0: sameAs("searxng/searxng", "latest", "2026.9.23-3cd69d30e"), note: "Tags are date+commit; M5 may re-resolve." },
    firecrawl_api_prebuilt: { role: "Upstream-built API image for the pinned commit (config FIRECRAWL_BUILD_SHA=7666c1f9...)", candidate: img("firecrawl/firecrawl", "2.11.162"), status: "candidate", reason: "Decision D6: acquire this arm64 image for M1 versus build from source. Third-party built; provenance is the image's recorded build SHA, not a reproducible build." },
    go_build: { role: "Build stage for libhtml-to-markdown.so", upstream_reference: img("library/golang", "1.24.13") },
    browser_base_option: { role: "Option for the M2 browser worker (Playwright's own arm64 image for 1.58.1)", candidate: img("playwright", "v1.58.1-noble"), status: "candidate" },
    floating_upstream_references: {
      note: "Recorded for completeness; these tags float and are not selected.",
      playwright_service_latest: img("firecrawl/playwright-service", "latest"),
      nuq_postgres_latest: img("firecrawl/nuq-postgres", "latest"),
    },
    excluded: { foundationdb: "foundationdb/foundationdb:7.3.63 server/init excluded by the selected architecture (spec §5); not resolved." },
  },

  browser: {
    playwright: "1.58.1",
    chromium_revision: "1208",
    chromium_version: "145.0.7632.6",
    version_source: "evidence/M0/upstream/raw/playwright-core-1.58.1-browsers.json",
    arm64_archives: ["chromium-linux-arm64.zip", "chromium-headless-shell-linux-arm64.zip"].map((z) => ({
      name: z, bytes: archiveBytes(z), url: `https://cdn.playwright.dev/dbazure/download/playwright/builds/chromium/1208/${z}`, ...cite(`playwright-chromium-1208-${z}.head.txt`),
    })),
    archive_sha256: unresolved("Playwright publishes no per-archive checksum next to these URLs; the M2 build records the hash of what it installs."),
    native_launch_on_host: unresolved("Not proven: the Pi runs a 16 KiB-page kernel; M2 must launch it natively (decision D2)."),
    candidate: { playwright: "1.63.0", chromium_version: "153.0.8010.12", source: "evidence/M0/security-review.md §H", status: "candidate", reason: "Chrome stable shipped 829 security fixes after 2026-07-30, two exploited in the wild (CVE-2026-85046 fixed in 152.0.7977.82; CVE-2026-87491 fixed in 153.0.8010.36). Even 1.63.0's build number is below 153.0.8010.36. Decision D1 (separate review)." },
  },

  native_dependencies: {
    foundationdb_client: { version: "7.3.63", asset: fdbAsset.name, bytes: fdbAsset.size, sha256_published: fdbSha, sha256_source: "https://github.com/apple/foundationdb/releases/download/7.3.63/foundationdb-clients_7.3.63-1_aarch64.deb.sha256", evidence: [cite("fdb-7.3.63-clients-aarch64.deb.sha256"), cite("fdb-7.3.63-clients-aarch64-asset.json")], note: "Upstream downloads it without verification; a project build must check this hash. Needed at build time only; not loaded on the PostgreSQL backend." },
    foundationdb_npm_addon: { version: "2.0.1", linux_arm64_prebuild: false, source: "evidence/M0/upstream/findings.md", note: "Compiles with node-gyp on arm64; lazily required only by the fdb backend." },
  },

  host_runtime: {
    container_runtime: unresolved(`Nothing is installed. M1 chooses between docker-ce ${dockerCe["docker-ce"]} / compose-plugin ${dockerCe["docker-compose-plugin"]} (Docker repository, ${SRC}/docker-ce-trixie-arm64-versions.txt) and docker.io from Debian (candidate recorded in evidence/M0/audit.json section4.docker_compose_versions).`),
    kernel: { source: "evidence/M0/audit.json architecture" },
    os: { source: "evidence/M0/audit.json section4.distribution_version" },
  },

  patches: { series: [], status: "none yet: the integration patch series starts in M2" },
  build_provenance: unresolved("No image was built in M0. The build host decision (Mac arm64 Linux VM, Pi native, or acquired prebuilt image) is decision D6."),
};

mkdirSync(resolve(ROOT, "deploy"), { recursive: true });
writeFileSync(resolve(ROOT, "deploy/versions.lock.json"), JSON.stringify(lock, null, 2) + "\n");
console.log("wrote deploy/versions.lock.json");
