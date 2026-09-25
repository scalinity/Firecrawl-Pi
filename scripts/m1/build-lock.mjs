#!/usr/bin/env node
// Resolve M1's entries in deploy/versions.lock.json from M1 evidence. Entries owned by
// later milestones (MCP packages: M4; browser, Go build stage, Rust toolchain: M2) are
// left exactly as M0 wrote them.
// Usage: node scripts/m1/build-lock.mjs
import { readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { ROOT, sha256File, sections, repoState } from "../m0/lib.mjs";

const LOCK = "deploy/versions.lock.json";
const read = (p) => readFileSync(resolve(ROOT, p), "utf8");
// Always start from the lock M0 accepted, so a re-run resolves the same entries the same way.
const M0_LOCK_COMMIT = "8ed6192";
const lock = JSON.parse(execFileSync("git", ["-C", ROOT, "show", `${M0_LOCK_COMMIT}:${LOCK}`], { encoding: "utf8" }));
const need = (v, what) => { if (v === undefined || v === null || v === "") throw new Error(`cannot resolve ${what} from evidence`); return v; };

// ---- evidence ------------------------------------------------------------------
const install = sections("evidence/M1/raw/runtime-install.txt");
const pkg = Object.fromEntries(install.installed.filter((l) => / (install|hold) ok installed$/.test(l)).map((l) => l.split(" ").slice(0, 2)));
const engine = need(install.installed.find((l) => / api=/.test(l)), "engine version line");
const compose = need(install.installed.find((l) => /^Docker Compose version /.test(l)), "compose version");
const buildx = need(install.installed.find((l) => /^github.com\/docker\/buildx /.test(l)), "buildx version");
const fpr = need(install.signing_key.find((l) => l === "fingerprint=9DC858229FC7DD38854AE2D88D81803C0EBFCD88"), "Docker signing key fingerprint");

const img = Object.fromEntries(sections("evidence/M1/raw/image-inspect.txt").images.filter(Boolean).map((l) => {
  const [ref, ...kv] = l.split(" ");
  return [ref, Object.fromEntries(kv.map((x) => [x.slice(0, x.indexOf("=")), x.slice(x.indexOf("=") + 1)]))];
}));
const inspect = sections("evidence/M1/raw/image-inspect.txt");
const buildSha = need(inspect.api_image_build_sha_assertion.find((l) => l.startsWith("FIRECRAWL_BUILD_SHA=")), "build SHA").split("=")[1];
if (!inspect.api_image_build_sha_assertion.includes("assert=PASS equals pinned commit")) throw new Error("build SHA assertion did not pass");
const nuqPkgs = Object.fromEntries(inspect.nuq_image_packages.filter(Boolean).map((l) => l.split(" ")));
const nuqBuild = sections("evidence/M1/raw/nuq-build.txt");
const nuqResult = JSON.parse(need(nuqBuild.result.find((l) => l.startsWith("{")), "NuQ build result"));

// Image references come from the rendered Compose (what the Pi runs) and the base digest
// from the NuQ Dockerfile's FROM line, so the lock cannot drift from either.
const rendered = JSON.parse(read("evidence/M1/rendered-compose.json")).services;
const ref = (svc) => need(rendered[svc]?.image, `${svc} image in the rendered Compose`);
const API = ref("firecrawl-core"), NUQ = ref("nuq-postgres"), RMQ = ref("rabbitmq"), REDIS = ref("redis"), NODE = ref("access-gateway");
if (ref("fixture") !== NODE) throw new Error("fixture and access-gateway images differ");
const PG_BASE = `postgres@${need(read("deploy/nuq-postgres/Dockerfile").match(/^FROM postgres:[^@\s]+@(sha256:[0-9a-f]{64})$/m)?.[1], "NuQ base digest")}`;
const nodeVersion = need(inspect.api_image_build_sha_assertion.find((l) => l.startsWith("node_version=NODE_VERSION=")), "API image Node version").split("=").pop();
const onPi = (ref) => ({ image_id_on_pi: need(img[ref]?.id, `${ref} id`), platform_on_pi: `${img[ref].os}/${img[ref].arch}`, verified_utc: sections("evidence/M1/raw/image-inspect.txt").meta[0], evidence: "evidence/M1/raw/image-inspect.txt" });

// ---- M1 resolutions --------------------------------------------------------------
Object.assign(lock, {
  generated_utc: new Date().toISOString().replace(/\.\d+Z$/, "Z"),
  generated_by: "scripts/m1/build-lock.mjs (M1), from the M0 lock at 8ed6192; entries owned by later milestones are as M0 wrote them",
  ...repoState(),
});

const api = lock.images.firecrawl_api_prebuilt;
api.selected = { ...api.candidate, status: "selected", decision: "D6 (evidence/M0/review/DECISIONS.md)", referenced_by: "arm64 manifest digest, never by tag",
  config_firecrawl_build_sha: buildSha, build_sha_equals_pinned_commit: buildSha === lock.firecrawl.commit, node_version_in_image: nodeVersion, ...onPi(API),
  runtime_configuration: { NUQ_WORKER_COUNT: "1", USE_DB_AUTHENTICATION: "false", SCRAPE_MAX_ATTEMPTS: "1", ALLOW_LOCAL_WEBHOOKS: "true (the M1 fixture-only exception in spec §29; contained as recorded in evidence/M1/INTERPRETATION.md and checked by V18)", DISABLE_WEBHOOK_DELIVERY: "true", USE_GO_MARKDOWN_PARSER: "unset (Go library inert; upstream default)", BULL_AUTH_KEY: "unset", NODE_OPTIONS: "--max-old-space-size=256",
    not_consumed_at_pin: ["NUM_WORKERS_PER_QUEUE", "CRAWL_CONCURRENT_REQUESTS", "MAX_CONCURRENT_JOBS", "BROWSER_POOL_SIZE"] } };
delete api.candidate;
api.status = "selected";
api.reason = "Decision D6: acquired by arm64 digest for M1; its build SHA equals the pinned commit. M2 replaces it with a project build.";

const nuqBase = lock.images.nuq_postgres_base;
nuqBase.selected = { ...nuqBase.selected, ...onPi(PG_BASE) };
nuqBase.pg_cron_package = { ...nuqBase.pg_cron_package, status: "resolved", pinned_in_dockerfile: "postgresql-17-cron=1.6.8-1.pgdg13+2",
  measured_in_built_image: need(nuqPkgs["postgresql-17-cron"], "pg_cron version"), postgresql_package_in_built_image: nuqPkgs["postgresql-17"],
  evidence: "evidence/M1/raw/image-inspect.txt#nuq_image_packages", reason: "Pinned in the project Dockerfile and measured in the built image." };
lock.images.nuq_postgres = {
  role: "NuQ PostgreSQL image, built on the Pi from deploy/nuq-postgres (decision D6)",
  selected: { repository: "fcpi/nuq-postgres", local_tag: "m1", built_image_digest: nuqResult.id, repo_digest: nuqResult.repo_digests[0], platform: `${nuqResult.os}/${nuqResult.arch}`,
    status: "built", ...onPi(NUQ) },
};

const rmq = lock.images.rabbitmq;
const c436 = rmq.candidates.find((c) => c.tag === "4.3.6");
rmq.selected = { ...c436, status: "selected", decision: "D3", accepted_after: "M1 NuQ round trip (evidence/M1/raw/nuq-roundtrip.txt)", ...onPi(RMQ),
  series_check: { newer_series_ga: "none: no 4.4 release or tag", retrieved: "evidence/M1/sources/rabbitmq-releases-at-m1.txt" },
  community_support_ends: "2026-11-30 (series move: M8)" };
rmq.candidates = rmq.candidates.filter((c) => c.tag !== "4.3.6").map((c) => ({ ...c, role: c.tag === "3.13.7" ? "recorded fallback if 4.x fails for a 4.x-specific reason (D3); not used" : c.role }));
delete rmq.selected.why;

lock.images.redis.selected = { ...lock.images.redis.selected, ...onPi(REDIS),
  note: "redis-server runs directly as uid 6379; bundled Redis 8 modules are not loaded (upstream issues no module command)." };
lock.images.node_base.selected = { ...lock.images.node_base.selected, ...onPi(NODE),
  used_by: ["access-gateway (services/access)", "fixture (tests/fixtures/m1)"] };

lock.host_runtime.container_runtime = {
  status: "resolved",
  source: "Docker apt repository https://download.docker.com/linux/debian trixie stable arm64",
  signing_key_fingerprint: fpr.split("=")[1],
  packages: pkg,
  held: ["docker-ce", "docker-ce-cli", "containerd.io", "docker-compose-plugin", "docker-buildx-plugin"],
  engine: engine.trim(), compose: compose.trim(), buildx: buildx.trim(),
  daemon_json: { path: "/etc/docker/daemon.json", source: "deploy/host/docker-daemon.json", sha256: sha256File("deploy/host/docker-daemon.json") },
  image_store: "containerd snapshotter (overlayfs)",
  reason: "Chosen over Debian docker.io 26.1.5: Engine 28.0.0 (moby#49325) stops neighbour hosts reaching ports mapped on a loopback address, and the LAN is flat (evidence/M1/sources/moby-v28.0.0-release-notes-excerpt.txt).",
  evidence: ["evidence/M1/raw/runtime-plan.txt", "evidence/M1/raw/runtime-install.txt"],
};

lock.build_provenance = {
  status: "resolved",
  firecrawl_api_image: {
    image: API, built_by: "upstream GitHub Actions run 30579949775 (push to main, success)", built_utc: "2026-07-30T20:43:18Z",
    runner: "native arm64 runner", source_commit: lock.firecrawl.commit, provenance: false, attestation: "none found",
    note: "A consistent public chain, not a signed or reproducible build (decision D6).",
    evidence: "evidence/M0/review/sources/firecrawl-2.11.162-image-provenance.txt",
  },
  nuq_postgres_image: {
    image: NUQ, built_on: "the Pi (linux/arm64, native)", built_utc: nuqBuild.meta[0], builder: buildx.trim(), provenance: false, sbom: false,
    dockerfile: { path: "deploy/nuq-postgres/Dockerfile", sha256: sha256File("deploy/nuq-postgres/Dockerfile"), upstream_sha256: "00108183ba9947db346226e3cc120b92b4cfcc60b215b320ad682f7944e93e45",
      edits: ["FROM postgres:17.11-trixie by arm64 digest", "postgresql-17-cron=1.6.8-1.pgdg13+2 pinned"] },
    nuq_sql: { path: "deploy/nuq-postgres/nuq.sql", sha256: sha256File("deploy/nuq-postgres/nuq.sql"), unmodified_upstream: sha256File("deploy/nuq-postgres/nuq.sql") === "44edb370cfc2601076e174c5461ffdfda8a1051b3c2a87c1b5231d002a66ee77" },
    base_image: PG_BASE, pg_cron_measured: nuqPkgs["postgresql-17-cron"],
    evidence: ["evidence/M1/raw/nuq-build.txt", "evidence/M1/raw/image-inspect.txt"],
  },
};

writeFileSync(resolve(ROOT, LOCK), JSON.stringify(lock, null, 2) + "\n");
console.log(`wrote ${LOCK}`);
