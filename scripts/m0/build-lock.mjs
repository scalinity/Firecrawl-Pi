#!/usr/bin/env node
// Build deploy/versions.lock.json. Image digests are copied from the resolver
// output (evidence/M0/registry/digests.jsonl), never retyped. Values that M0
// could not resolve are written as explicit {status:"unresolved", reason}.
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { ROOT, repoState } from "./lib.mjs";

const rows = readFileSync(resolve(ROOT, "evidence/M0/registry/digests.jsonl"), "utf8")
  .split("\n").filter(Boolean).map((l) => JSON.parse(l));
const img = (repo, tag) => {
  const r = rows.find((d) => d.repository === repo && d.tag === tag);
  if (!r) throw new Error(`no resolved row for ${repo}:${tag}`);
  const keep = ({ registry, repository, tag, resolved_utc, status, index_digest, arm64_manifest_digest, platform, index_file, arm64_manifest_file, unresolved_reason }) =>
    ({ registry, repository, tag, resolved_utc, status, index_digest, arm64_manifest_digest, platform, index_file, arm64_manifest_file, ...(unresolved_reason ? { unresolved_reason } : {}) });
  return keep(r);
};
const sameAs = (repo, a, b) => img(repo, a).index_digest === img(repo, b).index_digest;
const unresolved = (reason, extra = {}) => ({ status: "unresolved", reason, ...extra });

const lock = {
  schema: "fcpi.versions-lock/v1",
  generated_utc: new Date().toISOString().replace(/\.\d+Z$/, "Z"),
  generated_by: "scripts/m0/build-lock.mjs (M0)",
  ...repoState(),
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
    formal_release_latest: { tag: "v2.11.0", published_utc: "2026-06-19T15:09:30Z", tag_type: "lightweight (git ls-remote returned no peeled ^{} ref)", commit: "ef12eb36b2f3382838dfe0a0c1a5add3d5df7fe5", relation: "separate channel; not the pinned snapshot" },
    newer_api_image_tags: { latest_observed: "v2.11.402", observed_utc: "2026-09-25T03:12:00Z", status: "candidate", reason: "No post-2026-07-30 Firecrawl advisory affects self-hosted v2.11.162 (evidence/M0/security-review.md §C); the self-host guide still pins v2.11.162. Not adopted." },
    known_open_issues_at_pin: [
      "Transitive ip-address@6.4.0 (GHSA-mwp4-54f8-5fhr / CVE-2026-69192): octal/leading-zero IP SSRF forms; deferred upstream at every tag. Handled by the project SSRF layer (M2).",
      "Redirect-to-blocklisted-domain gap in single/batch scrape fixed after the pin in 58d0c8ebb6 (PR #4581): cherry-pick candidate for the M2 patch series.",
      "CVE-2026-32857 redirect SSRF in the upstream Playwright service: that service is replaced by the project browser worker (M2).",
    ],
  },

  mcp: {
    protocol_revision: { selected: "2026-07-28", verified_current_stable_utc: "2026-09-25T03:14:49Z", newer_revision: "none (only the rolling draft)", compatibility_revision: "2025-11-25" },
    packages: {
      "@modelcontextprotocol/server": { selected: "2.0.0", engines_node: ">=20", integrity: "sha512-YhHWdHfpFMQfd0prsEnxKeS3Qz3ytIGmsS0sth4KDjnacIT7hxk6hXHkJ9KysxlkvTM+WZAtQbbcUhdoP4Hvtw==", dependencies: { zod: "^4.2.0", "@modelcontextprotocol/core": "2.0.0" } },
      "@modelcontextprotocol/core": { selected: "2.0.0", engines_node: ">=20", integrity: "sha512-pJCEwGG7Lfr/+PQp9ZTwKXNeO5wzbfKL7H3MYpCorM4oFBoQrdjnBgEoqG+RjhsvS1FKrDbKux+M1HhlnGWqcA==" },
      "@modelcontextprotocol/node": { selected: "2.0.0", engines_node: ">=20", integrity: "sha512-Y4hAC2XdGDUdDOCbLDOCA4+aL3NUldjsOWlDL/YwpAxrPhRm1xHd7lZ+mLacvZ9t3PaH28wgNoaLQGrIk1P2pg==", dependencies: { "@hono/node-server": "^1.19.9" }, peerDependencies: { hono: "^4.11.4", "@modelcontextprotocol/server": "^2.0.0" } },
    },
    transitive_exact_versions: unresolved("hono, @hono/node-server and zod resolve only in the M4 package lock; M0 runs no npm install."),
    candidate: { version: "2.1.0", published: "2026-09-23", server_integrity: "sha512-FdvwZU5N03O77Suh35JqjAqq5R1ZTEPFtwu6N4BgBq28qrQtrCnpbLL5U2pwYCuE194jAw0xnlOVmIqhfoYuUQ==", status: "candidate", reason: "2.1.0 adds a 4 MiB request-body cap and 100-message batch cap (#2698) and rejects modern requests missing MCP-Protocol-Version (#2590); 2.0.0 has neither. No GHSA exists for v2 packages. Decision D5 (separate review)." },
    evidence: "evidence/M0/security-review.md §A-B",
  },

  runtimes: {
    node: { selected: "22.23.3", lts: "Jod", released: "2026-09-23", minimum_security_patch: "22.23.2 (security release 2026-07-28)", image: "node:22.23.3-bookworm-slim", note: `node:22-slim resolves to the same index digest: ${sameAs("library/node", "22.23.3-bookworm-slim", "22-slim")}` },
    go_build_stage: { upstream: "golang:1.24", resolves_to: "1.24.13", same_digest: sameAs("library/golang", "1.24", "1.24.13"), supported_go_lines_observed: ["go1.27.1", "go1.26.8"], status: "candidate", reason: "Go 1.24 is out of upstream support; used only to build libhtml-to-markdown.so. Relevant only if the API image is built from source (decision D6); moving the build stage is decision D4." },
    rust_toolchain: unresolved("Upstream installs rustup's default stable at build time and ships no Cargo.lock (native/.gitignore); two git dependencies track branches. A project build must pin the toolchain and commit a generated Cargo.lock (M1/M2)."),
    pnpm: { upstream: "11.4.0", source: "apps/api/Dockerfile" },
  },

  images: {
    node_base: { role: "API build/runtime base and project Node services", selected: img("library/node", "22.23.3-bookworm-slim") },
    nuq_postgres_base: { role: "NuQ PostgreSQL base (built with apps/nuq-postgres/Dockerfile)", selected: img("library/postgres", "17.11-trixie"), note: `postgres:17 resolves to the same index digest: ${sameAs("library/postgres", "17", "17.11-trixie")}. 17.11 (2026-08-13) fixed 28 CVEs; do not go below it.`, pg_cron_package: { name: "postgresql-17-cron", pgdg_trixie_arm64_version_observed: "1.6.8-1.pgdg13+2", status: "unresolved", reason: "Upstream installs it unpinned; the exact version is fixed when the M1 image is built and must be recorded then." } },
    redis: { role: "Redis", selected: img("library/redis", "8.10.2-alpine"), note: `Upstream uses floating redis:alpine, which resolves to this index digest: ${sameAs("library/redis", "alpine", "8.10.2-alpine")}. 8.10.2 includes the 2026-08-17 and 2026-09-17 security releases. Bundled jemalloc is built with --with-lg-page=16 on arm64, compatible with the 16 KiB-page kernel. License: RSALv2/SSPLv1/AGPLv3 (personal use).` },
    rabbitmq: {
      role: "RabbitMQ (NuQ messaging)",
      selected: unresolved("Decision D3 (separate review): upstream compose pins rabbitmq:3-management (3.13.7, community support ended); 4.3.6 is the only community-supported series (until 2026-11-30). NuQ declares only quorum queues and one exclusive classic reply queue, both valid on 4.x."),
      candidates: [
        { ...img("library/rabbitmq", "3.13.7"), why: "same major as upstream compose, without the management plugin (spec §22)" },
        { ...img("library/rabbitmq", "4.3.6"), why: "supported series; fixes the 2026-08/09 advisories" },
      ],
      upstream_reference: img("library/rabbitmq", "3-management"),
    },
    searxng: { role: "Private metasearch", selected: img("searxng/searxng", "2026.9.23-3cd69d30e"), note: `latest resolved to the same index digest at M0: ${sameAs("searxng/searxng", "latest", "2026.9.23-3cd69d30e")}. Tags are date+commit; M5 may re-resolve.` },
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
    arm64_archives: [
      { name: "chromium-linux-arm64.zip", bytes: 188304613, url: "https://cdn.playwright.dev/dbazure/download/playwright/builds/chromium/1208/chromium-linux-arm64.zip" },
      { name: "chromium-headless-shell-linux-arm64.zip", bytes: 111562127, url: "https://cdn.playwright.dev/dbazure/download/playwright/builds/chromium/1208/chromium-headless-shell-linux-arm64.zip" },
    ],
    archive_sha256: unresolved("Playwright publishes no per-archive checksum next to these URLs; the M2 build records the hash of what it installs."),
    native_launch_on_host: unresolved("Not proven: the Pi runs a 16 KiB-page kernel; M2 must launch it natively (decision D2)."),
    candidate: { playwright: "1.63.0", chromium_version: "153.0.8010.12", status: "candidate", reason: "Chrome stable shipped 829 security fixes after 2026-07-30, two exploited in the wild (CVE-2026-85046 fixed in 152.0.7977.82; CVE-2026-87491 fixed in 153.0.8010.36). Even 1.63.0's build number is below 153.0.8010.36. Decision D1 (separate review)." },
  },

  native_dependencies: {
    foundationdb_client: { version: "7.3.63", asset: "foundationdb-clients_7.3.63-1_aarch64.deb", bytes: 62603072, sha256_published: "a3c451ddb8242cc2396ba3419e1f3c9b283a64ea2eaff555377f4503bf9c3a64", sha256_source: "https://github.com/apple/foundationdb/releases/download/7.3.63/foundationdb-clients_7.3.63-1_aarch64.deb.sha256", note: "Upstream downloads it without verification; a project build must check this hash. Needed at build time only; not loaded on the PostgreSQL backend." },
    foundationdb_npm_addon: { version: "2.0.1", linux_arm64_prebuild: false, note: "Compiles with node-gyp on arm64; lazily required only by the fdb backend." },
  },

  host_runtime: {
    container_runtime: unresolved("Nothing is installed. M1 chooses between docker-ce 5:29.8.1 / compose-plugin 5.5.1 (Docker repo) and docker.io 26.1.5 (Debian); see evidence/M0/runtime-candidates.json."),
    kernel: { release: "6.18.34+rpt-rpi-2712", page_size_bytes: 16384, images_present: ["kernel_2712.img"] },
    os: "Debian GNU/Linux 13 (trixie) 13.5, Raspberry Pi reference 2026-06-18",
  },

  patches: { series: [], status: "none yet: the integration patch series starts in M2" },
  build_provenance: unresolved("No image was built in M0. The build host decision (Mac arm64 Linux VM, Pi native, or acquired prebuilt image) is decision D6."),
};

mkdirSync(resolve(ROOT, "deploy"), { recursive: true });
writeFileSync(resolve(ROOT, "deploy/versions.lock.json"), JSON.stringify(lock, null, 2) + "\n");
console.log("wrote deploy/versions.lock.json");
