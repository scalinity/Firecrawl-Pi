# Upstream Firecrawl source findings: v2.11.162 / 7666c1f9

Tree: shallow checkout of 7666c1f9 in a session scratchpad outside the repository (read-only; not retained)
Raw outputs: copied to `evidence/M0/upstream/raw/`

## 0. Tree identity

- `git rev-parse HEAD` = `7666c1f9ae8720a6bba271e0f60b6a217f8a5210` (commit 2026-07-30T13:37:02-07:00, "feat(api): route the two /labs/search/packs endpoints (#4184)"). The working tree is clean: `git status --porcelain` printed 0 lines before and after the inspection.
- The local checkout has no tags. GitHub shows the annotated tag `v2.11.162` at object `ebfe595c…`, and it dereferences to commit `7666c1f9ae8720a6bba271e0f60b6a217f8a5210` (`upstream-raw/tag-v2.11.162.json`).
- File SHA-256 values for the Dockerfiles, nuq.sql, compose and lockfiles are in `upstream-raw/file-sha256.txt`.

## 1. NuQ PostgreSQL (`apps/nuq-postgres/`)

**Dockerfile** (`apps/nuq-postgres/Dockerfile`)
- L3–4: `ARG PG_MAJOR=17` / `FROM postgres:${PG_MAJOR}`. This is `postgres:17` with no digest. It is a floating tag.
  - Docker Hub on 2026-09-24: `postgres:17` = `sha256:d74eeac9a635390a49bc21bd49fccd973de707e2a53a76ac49b552b8712ec46f`, the same digest as `17.11` and `17-trixie`. It is Debian 13 based and multi-arch, including `linux/arm64/v8` (`upstream-raw/dockerhub-tag-platforms.txt`).
- pg_cron, L7–11: `apt-get install -y --no-install-recommends postgresql-${PG_MAJOR}-cron`. The package is `postgresql-17-cron`. **No version is pinned.** It comes from the PGDG apt repo that the official postgres image configures.
- Preload, L15–18: the image edits the initdb template `/usr/share/postgresql/${PG_MAJOR}/postgresql.conf.sample`:
  - `sed -ri "s/^#?shared_preload_libraries\s*=.*/shared_preload_libraries = 'pg_cron'/"`
  - `printf "\n# Added for pg_cron\ncron.database_name = 'postgres'\n" >> "$conf_sample"`
  - The comment explains why: "This must be set before the first server start (init scripts run after start)."
- Schema delivery, L21: `COPY nuq.sql /docker-entrypoint-initdb.d/010-nuq.sql`. It runs only on first initdb, when the data dir is empty.

**POSTGRES_DB=postgres: effectively required.**
- `cron.database_name` is hard-coded to `'postgres'` (L18).
- The official entrypoint runs `docker-entrypoint-initdb.d` scripts against `$POSTGRES_DB`.
- nuq.sql L2 runs `CREATE EXTENSION IF NOT EXISTS pg_cron;` and L123+ runs `cron.schedule(...)`.
- pg_cron allows `CREATE EXTENSION pg_cron` only in the database named by `cron.database_name`. So if POSTGRES_DB is anything other than `postgres`, `010-nuq.sql` fails at L2. The `CREATE SCHEMA nuq` / tables would then be created in the wrong DB, or not at all, because the entrypoint aborts on error with `ON_ERROR_STOP`.
  - This is pg_cron's documented behaviour. It was inferred here, not executed.
- Contradiction in upstream docs: `SELF_HOST.md` L104 suggests `# POSTGRES_DB=firecrawl`, and L127 says "set … `POSTGRES_DB` to secure values". The compose defaults keep `postgres`: `docker-compose.yaml` L30 and L168 have `POSTGRES_DB: ${POSTGRES_DB:-postgres}`. The API config default is also `postgres`: `apps/api/src/config.ts` L136 `POSTGRES_DB: z.string().default("postgres")`.

**Init SQL:** there is one file, `apps/nuq-postgres/nuq.sql`, 331 lines, sha256 `44edb370…`.
- Extensions (L1–2): `pgcrypto`, `pg_cron`.
- **`ALTER SYSTEM` tuning (L8–32), which matters on the Pi:**
  - `max_wal_size = '16GB'`, `min_wal_size = '4GB'` (4 GB of WAL is kept pre-allocated)
  - `wal_buffers = '64MB'`, `checkpoint_timeout = '15min'`
  - `effective_io_concurrency = 200`
  - `bgwriter_*` settings, `commit_delay = 10`
  - It then calls `SELECT pg_reload_conf();`. `wal_buffers` needs a restart to take effect.
- Schema `nuq` (L34).
- Enums: `nuq.job_status` ('queued','active','completed','failed') and `nuq.group_status` ('active','completed','cancelled').
- Tables:
  - `nuq.queue_scrape` (L48): id, status, data jsonb, priority, lock, locked_at, stalls, finished_at, listen_channel_id, returnvalue/failedreason ("only for selfhost"), owner_id, group_id. It has aggressive per-table autovacuum settings and 9 indexes.
  - `nuq.queue_scrape_backlog` (L102): includes `times_out_at`, plus 4 indexes.
  - `nuq.queue_crawl_finished` (L184): same shape as queue_scrape, plus 7 indexes.
  - `nuq.group_crawl` (L249): id, status, owner_id, `ttl int8 DEFAULT 86400000`, expires_at, plus 2 indexes.
- **36 `cron.schedule` jobs** (full list in `upstream-raw/nuq-sql-cron-jobs.txt`):
  - Cleaners: `nuq_queue_scrape_clean_completed` and `…_clean_failed` run every 5 min. They delete standalone (group_id IS NULL) jobs 1 h after completion and 6 h after failure. The same pair exists for queue_crawl_finished.
  - Lock reapers, every 15 s (`nuq_queue_scrape_lock_reaper`, `nuq_queue_crawl_finished_lock_reaper`): requeue `active` jobs whose `locked_at` is older than 1 min. They fail a job after 9 stalls and `pg_notify` the failure.
  - `nuq_queue_scrape_backlog_reaper` runs every minute and deletes backlog rows past `times_out_at`.
  - `nuq_group_crawl_finished` runs every 15 s. It marks groups completed, sets expires_at = now + ttl, and inserts into queue_crawl_finished.
  - `nuq_group_crawl_clean` runs every minute: 500 expired groups per run, cascading deletes of their jobs, 90 s statement_timeout.
  - 25 nightly `REINDEX INDEX CONCURRENTLY` jobs run between 02:00 and 10:20 UTC.
  - `nuq_maintenance_watchdog` runs every minute and cancels any nuq REINDEX running longer than 18 min.
  - `cron_job_run_details_prune` runs hourly and keeps 24 h of history.
- Retention consequence: completed crawl-group jobs are deleted at `expires_at` = completion + `ttl`, default 86400000 ms (24 h). The durable-results requirement cannot rely on NuQ tables.

## 2. Harness and process model

**`NUQ_WORKER_COUNT` is read:**
- `apps/api/src/harness.ts` L118: `const NUQ_WORKER_COUNT = config.NUQ_WORKER_COUNT;`
- The value is used at L865: `Array.from({ length: NUQ_WORKER_COUNT }, …)`.

**Defaults and settings in `apps/api/src/config.ts`:**
- L231: `NUQ_WORKER_COUNT: z.coerce.number().default(5)`, so the **default is 5**. Root `docker-compose.yaml` does not set it (not found in compose; searched for `NUQ_WORKER_COUNT`).
- L230: `NUQ_WORKER_START_PORT … default(3006)`.
- Prefetch port = start + count (harness L119). Reconciler port = prefetch + 1 (L120).
- L213: `SCRAPE_MAX_ATTEMPTS: z.coerce.number().int().positive().default(6)`. It exists and is consumed at `scraper/scrapeURL/index.ts` L1223 `maxAttempts: config.SCRAPE_MAX_ATTEMPTS`. Siblings at L214–215: `SCRAPE_MAX_FEATURE_TOGGLES` default 3, `SCRAPE_MAX_FEATURE_REMOVALS` default 3.
- L129–131: `AGENT_AUTH_RESOURCE_METADATA_URL: z.url().default("https://www.firecrawl.dev/.well-known/oauth-protected-resource")`. It exists and defaults to a Firecrawl Cloud URL. It is used in `lib/agent-auth-discovery.ts` L6, which builds the RFC 9728 `WWW-Authenticate` value on a 401. The server does not fetch it, but it advertises a Cloud URL to clients.
- L348: `USE_DB_AUTHENTICATION: z.stringbool().optional()`. Compose L33 defaults it to `false`.

**Spawning:** `execForward` (harness L243–278) spawns each string command as `spawn("sh", ["-c", command], { detached: true })` (L264). Each child therefore starts under an `sh -c` wrapper. Whether `/bin/sh` (dash, Debian bookworm) execs into `node` or stays resident as a parent process is not established from source and needs a live `ps` check.

**Children under `--start-docker`** (`startServices`, L818–952):

| name | command | condition |
|---|---|---|
| `api` | `node dist/src/index.js` | always (L830–839) |
| `worker` | `node dist/src/services/queue-worker.js` | always (L841–851) |
| `extract-worker` | `node dist/src/services/extract-worker.js` | always (L853–863) |
| `nuq-worker-<i>` ×N | `node dist/src/services/worker/nuq-worker.js`, or `nuq-fdb-worker.js` when `NUQ_BACKEND=fdb` | N = NUQ_WORKER_COUNT; ports 3006+i (L865–877) |
| `nuq-prefetch-worker` | `node dist/src/services/worker/nuq-prefetch-worker.js` | only if `NUQ_BACKEND !== "fdb"` (L879–893) |
| `nuq-reconciler` | `node dist/src/services/worker/nuq-reconciler-worker.js` | only if `NUQ_BACKEND !== "fdb"` (L895–908) |
| `index-worker` | `node dist/src/services/indexing/index-worker.js` | only if `config.USE_DB_AUTHENTICATION` (L910–921) |
| `command` | user argv | only if a non-`--` command is given (L934–937) |

**Container management under compose:**
- `setupNuqPostgres` (L516–538) and `setupNuqRabbitMQ` (L627–643) skip container management when `NUQ_DATABASE_URL` / `NUQ_RABBITMQ_URL` is set, or when `POSTGRES_HOST !== "localhost"`. In compose, `POSTGRES_HOST=nuq-postgres`.
- When the URL is not set, `setupNuqPostgres` builds `NUQ_DATABASE_URL` from `POSTGRES_*`: L529 `postgresql://…@${POSTGRES_HOST}:${POSTGRES_PORT}/${encodeURIComponent(POSTGRES_DB)}`.
- `setupFdb` returns early unless `NUQ_BACKEND === "fdb"` or `NUQ_FDB_TESTS` is set (L715).
- `queue-worker.ts` L259 and `index-worker.ts` L625 use `new Worker(queue.name, null, …)`. This is the BullMQ Worker, not a thread. No `cluster.fork`, `worker_threads` or `child_process` use exists outside the harness; searched `apps/api/src` for those strings.

**Process count, NUQ_WORKER_COUNT=1, pg backend, USE_DB_AUTHENTICATION=false, `--start-docker`:**
- Node processes: harness, api, worker, extract-worker, nuq-worker-0, nuq-prefetch-worker, nuq-reconciler. That is **7 Node processes: the harness plus 6 children.** Each child may also have an `sh -c` parent, which would make up to 13 processes; this has not been verified.
- With `USE_DB_AUTHENTICATION=true` there are 8 Node processes.
- With the compose default (no NUQ_WORKER_COUNT → 5) there are 11 Node processes.

## 3. API image (`apps/api/Dockerfile`)

**Stages (`FROM` lines):**
- L2 `FROM node:22-slim AS base`
- L11 `FROM golang:1.24 AS go-build`
- L19 `FROM base AS build`
- L73 `FROM base AS runtime`

There are no digests anywhere.

**Node:**
- `node:22-slim` is a floating major tag with no patch pinned. On 2026-09-24 it resolved to `22.23.3-bookworm-slim` (Debian 12), digest `sha256:43ac6c60…`.
- The published `ghcr.io/firecrawl/firecrawl:2.11.162` image was built with `NODE_VERSION=22.23.2` (see "Prebuilt images" below).
- pnpm: L8 `corepack prepare pnpm@11.4.0 --activate`.

**Go (L11–17):**
- Builds `sharedLibs/go-html-to-md` into `libhtml-to-markdown.so` with `-buildmode=c-shared` (cgo), which is loaded in-process by Node.
- The image is `golang:1.24`, which resolved to 1.24.13 on 2026-09-24 and is multi-arch including arm64/v8.
- `go.mod`: `go 1.23.0`, `toolchain go1.24.0`.
- aarch64: the Dockerfile has no arch-specific handling. It relies on a native build in the golang image, so it works on arm64 as long as the builder platform is arm64.

**Rust (L39–45, L52–58):**
- Installs rustup via `curl … https://sh.rustup.rs | sh -s -- -y --no-modify-path`. This takes the **default stable toolchain with no version pin.** No `rust-toolchain` file exists; searched `apps/api` to depth 3.
- It builds the `native/` workspace package `@mendable/firecrawl-rs`, crate `firecrawl_rs`, type `cdylib`, through napi-rs. The install script `"install": "pnpm build"` runs `napi build --platform --release`, triggered by `pnpm install --frozen-lockfile`.
- **No `Cargo.lock`:** `apps/api/native/.gitignore` L112 ignores `Cargo.lock`. The crate uses two unpinned git dependencies:
  - `nodesig = { git = "https://github.com/firecrawl/nodesig" }`
  - `calamine = { git = "https://github.com/firecrawl/calamine", branch = "fc-prod" }`
  - As a result, Rust dependency resolution floats at build time.
- aarch64: the Dockerfile has no arch-specific handling. It builds natively for the host target. The `napi.targets` in `native/package.json` lists only x64-win/x64-mac/x64-linux/arm64-mac, but that list governs prebuilt publishing, not `napi build --platform`, which builds for the host. aarch64-linux therefore depends on a native compile, which is feasible in principle but not proven.

**Native Node modules** (allowBuilds list in `pnpm-workspace.yaml`):
- Present in the lockfile with linux-arm64 prebuilt packages: esbuild 0.28.1, msgpackr-extract 3.0.3, oxc-resolver 11.24.2, @sentry/cli 2.58.2, typescript-7, @napi-rs/*.
- `koffi@2.9.0` ships multi-platform binaries.
- `foundationdb@2.0.1` (package.json L115 `"foundationdb": "^2.0.1"`) uses `"install": "node-gyp-build"` and `gypfile: true`. Its npm tarball contains prebuilds only for `darwin-arm64`, `darwin-x64`, `linux-x64`. **There is no linux-arm64 prebuild, so arm64 compiles it with node-gyp** against the libfdb_c headers. That is why the build stage installs `build-essential`, `python3` and the FDB client .deb (Dockerfile L23–37).
- Runtime loading of `foundationdb` is lazy: `src/services/worker/nuq-fdb/client.ts` L5–13 contains "Keep the require lazy so processes that never touch the FDB backend (PG-only deploys …) can still boot" and `require("foundationdb")`.

**FoundationDB client (build L30–37, runtime L82–88):**
```
ARG FDB_VERSION=7.3.63
RUN ARCH=$(dpkg --print-architecture) && \
    case "$ARCH" in arm64) FDB_ARCH=aarch64 ;; *) FDB_ARCH=$ARCH ;; esac && \
    curl -fsSL -o /tmp/fdb-clients.deb \
      "https://github.com/apple/foundationdb/releases/download/${FDB_VERSION}/foundationdb-clients_${FDB_VERSION}-1_${FDB_ARCH}.deb" && \
    dpkg -i /tmp/fdb-clients.deb && rm /tmp/fdb-clients.deb
```
- The arm64-to-aarch64 mapping is explicit. **No checksum is verified.**
- The client is installed in both the build and runtime stages, even when the FDB backend is unused.
- Upstream release `apple/foundationdb` tag `7.3.63` (published 2025-02-21) **does include `foundationdb-clients_7.3.63-1_aarch64.deb`**, along with `.sha256`, the `amd64` .deb, `libfdb_c.aarch64.so`, `fdbcli.aarch64`, and el9 aarch64 rpms (`upstream-raw/fdb-7.3.63-release-assets.txt`). The URL the Dockerfile builds on arm64 therefore resolves to an existing asset.

**Per-component aarch64 support according to the Dockerfile:**

| component | aarch64 status |
|---|---|
| node base | yes (multi-arch base) |
| Go .so | yes (native build) |
| Rust napi | yes in principle (native build, no pins) |
| foundationdb npm | compiled from source on arm64 |
| FDB client .deb | explicit aarch64 mapping; asset exists |

**Prebuilt images on ghcr:**
- `ghcr.io/firecrawl/firecrawl:2.11.162` is manifest list `sha256:1b223ef18d410f67615f32ccaa3dcedfc26af4286f096247bddca3b624545e63`, with:
  - linux/arm64 `sha256:6157ce24e6867f013704c1cf2b752ec1ea7a3f730da09014b511d1049c8651af`
  - linux/amd64 `sha256:cc27dadc…`
- The config of both platform images contains `FIRECRAWL_BUILD_SHA=7666c1f9ae8720a6bba271e0f60b6a217f8a5210` and `NODE_VERSION=22.23.2`. The arm64 image was created 2026-07-30T20:43:18Z. `CMD ["node","dist/src/harness.js","--start-docker"]` (`upstream-raw/ghcr-firecrawl-2.11.162-config.json`).
- The tag `v2.11.162` (with the v) returns 404 on ghcr.

## 4. Playwright service (`apps/playwright-service-ts/`)

**Dockerfile:**
- L1 `FROM node:22-slim`: single stage, no digest; currently bookworm, Debian 12.
- L7 pnpm 11.4.0 via corepack. L11 `pnpm install --frozen-lockfile`.
- L15 `ENV PLAYWRIGHT_BROWSERS_PATH=/usr/local/share/playwright`.
- L18 `RUN pnpm exec playwright install chromium --with-deps`.
- L22–23 `chown -R node:node /usr/src/app && chmod -R a+rX /usr/local/share/playwright`.
- L30 `USER node`. L32 `CMD [ "pnpm", "start" ]`. `start` = `node dist/api.js`, so pnpm stays resident as the parent process.

**Versions:**
- `package.json` has `"playwright": "^1.58.1"`.
- `pnpm-lock.yaml` L468/L473 resolves **`playwright@1.58.1` and `playwright-core@1.58.1`**.
- The playwright-core-1.58.1.tgz sha256 is `13a9053a45c5837e8082d45ae1fcb73bed818e7cdde69b7783cc07213df671b5`.

**`browsers.json`** from `npm pack playwright-core@1.58.1` (`upstream-raw/playwright-core-1.58.1-browsers.json`):
- `chromium` revision **1208**, browserVersion **145.0.7632.6** ("Chrome for Testing")
- `chromium-headless-shell` revision **1208**, 145.0.7632.6

**linux-arm64 builds:** in `package/lib/server/registry/index.js`, `DOWNLOAD_PATHS` (L158–220; excerpt in `upstream-raw/playwright-core-1.58.1-registry-index-L140-220.js`) has arm64 entries:
- `chromium`: `"debian11-arm64"`, `"debian12-arm64"`, `"debian13-arm64"`, `"ubuntu20.04/22.04/24.04-arm64"` → `"builds/chromium/%s/chromium-linux-arm64.zip"`
- `chromium-headless-shell`: the same platforms → `"builds/chromium/%s/chromium-headless-shell-linux-arm64.zip"`
- `ubuntu18.04-arm64` has `void 0`, i.e. unsupported.

**The x64 and arm64 binaries come from different builders.** x64 uses `cftUrl("linux64/chrome-linux64.zip")`, which is Google's Chrome for Testing. arm64 uses Playwright's own Chromium build at `cdn.playwright.dev` (`builds/chromium/1208/…`).

**Launch posture:** `api.ts` L190–201 launches with `chromium.launch({ headless: true, args: ['--no-sandbox','--disable-setuid-sandbox','--disable-dev-shm-usage', …,'--no-zygote','--disable-gpu'] })`.
- The **sandbox is disabled upstream**, which conflicts with the project's browser rules.
- `MAX_CONCURRENT_PAGES` defaults to 10 (L26–28). Compose sets it from `CRAWL_CONCURRENT_REQUESTS:-10`.

## 5. Root `docker-compose.yaml`

- Project name `firecrawl` (L1). Network `backend` is a bridge network.
- Named volumes: `fdb-data`, `fdb-cluster-file` only.
- **nuq-postgres, redis and rabbitmq have no named volumes.** Postgres data sits in the image's anonymous VOLUME. Redis and RabbitMQ are not persisted.

| service | image / build | ports | volumes | limits | notes |
|---|---|---|---|---|---|
| playwright-service | `build: apps/playwright-service-ts` (commented `ghcr.io/firecrawl/playwright-service:latest`) | none | tmpfs `/tmp/.cache:noexec,nosuid,size=1g` | `cpus: 2.0`, `mem_limit: 4G`, `memswap_limit: 4G` | `no-new-privileges`, `cap_drop: ALL`, `MAX_CONCURRENT_PAGES: ${CRAWL_CONCURRENT_REQUESTS:-10}` |
| api | `build: apps/api` (commented `ghcr.io/firecrawl/firecrawl`, no tag) | **`"${PORT:-3002}:${INTERNAL_PORT:-3002}"`, no bind address, so all host interfaces (0.0.0.0)** | `fdb-cluster-file:/var/fdb:ro` | `cpus: 4.0`, `mem_limit: 8G`, `memswap_limit: 8G` | `command: node dist/src/harness.js --start-docker`; `NUQ_RABBITMQ_URL: amqp://rabbitmq:5672`; `HARNESS_STARTUP_TIMEOUT_MS` 60000; `extra_hosts host.docker.internal:host-gateway`; nofile 65535; depends_on redis, playwright-service, rabbitmq (healthy); **no depends_on nuq-postgres** |
| redis | `redis:alpine` (floating) | none | none | none | `redis-server --bind 0.0.0.0` |
| rabbitmq | `rabbitmq:3-management` (floating) | none | none | none | healthcheck `rabbitmq-diagnostics -q check_running` |
| nuq-postgres | `build: apps/nuq-postgres` (commented `ghcr.io/firecrawl/nuq-postgres:latest`) | none | none (anonymous only) | none | `POSTGRES_USER/PASSWORD/DB` default `postgres` |
| foundationdb | `foundationdb/foundationdb:7.3.63` | none | `fdb-data`, `fdb-cluster-file` | none | "experimental"; **always started** (no profile) |
| foundationdb-init | `foundationdb/foundationdb:7.3.63` | none | `fdb-cluster-file` | none | one-shot `fdbcli … 'configure new single ssd'`, `restart: "no"` |

**Common environment** (`x-common-env`, L24–60):
- `POSTGRES_DB: ${POSTGRES_DB:-postgres}`, `USE_DB_AUTHENTICATION:-false`
- `NUM_WORKERS_PER_QUEUE:-8`, `CRAWL_CONCURRENT_REQUESTS:-10`, `MAX_CONCURRENT_JOBS:-5`, `BROWSER_POOL_SIZE:-5`
- `NUQ_BACKEND: ${NUQ_BACKEND}` and `FDB_CLUSTER_FILE: ${NUQ_BACKEND:+/var/fdb/fdb.cluster}`, so FDB is used only when NUQ_BACKEND is set
- There is no NUQ_WORKER_COUNT, so the harness default of 5 applies.

**Prebuilt images** (registry lookups on 2026-09-24):
- On ghcr, `ghcr.io/firecrawl/{firecrawl,playwright-service,nuq-postgres}:latest` are all amd64+arm64 manifest lists.
  - Only `firecrawl` has a version tag `2.11.162`.
  - `playwright-service:2.11.162` / `v2.11.162` and `nuq-postgres:2.11.162` / `v2.11.162` return 404 (`upstream-raw/ghcr-firecrawl-images.txt`).
- `foundationdb/foundationdb:7.3.63` is `sha256:df1a2310…`, linux/amd64 + linux/arm64.
- `redis:alpine`, `rabbitmq:3-management`, `postgres:17`, `node:22-slim` and `golang:1.24` all include arm64/v8. Their digests are in `upstream-raw/dockerhub-tag-platforms.txt`.

## 6. All Dockerfiles

Search: `find . -name 'Dockerfile*' -not -path '*/node_modules/*'`. Raw output is in `upstream-raw/dockerfile-from-lines.txt`.

| path | FROM |
|---|---|
| `apps/api/Dockerfile` | L2 `node:22-slim AS base`; L11 `golang:1.24 AS go-build`; L19 `base AS build`; L73 `base AS runtime` |
| `apps/playwright-service-ts/Dockerfile` | L1 `node:22-slim` |
| `apps/nuq-postgres/Dockerfile` | L3–4 `ARG PG_MAJOR=17` / `postgres:${PG_MAJOR}` |
| `apps/redis/Dockerfile` | L1–2 `ARG REDIS_VERSION=8.0.3` / `bitnami/redis:${REDIS_VERSION}` |
| `apps/go-html-to-md-service/Dockerfile` | L2 `golang:1.23-alpine AS builder`; L23 `alpine:latest` |

- `apps/redis` is not used by root compose. **`bitnami/redis:8.0.3` returned 404 on Docker Hub**; the tag exists under `bitnamilegacy/redis:8.0.3`.
- `apps/go-html-to-md-service` (it has its own `docker-compose.yml`) is not used by root compose. The API loads the Go .so in-process instead.

## 7. Hard-coded Firecrawl Cloud destinations in `apps/api/src` (non-test)

Search: `api.firecrawl.dev`, `firecrawl.dev`, `mcp.firecrawl`, `fire-engine`, `mendable.ai`, plus a full list of hard-coded hosts. Raw output is in `upstream-raw/cloud-destinations-grep.txt` and `upstream-raw/api-src-hardcoded-hosts.txt`.

**Actual outbound network calls:**
- `lib/admin-integration-integrations-proxy.ts` L26: ``const url = `https://integrations.firecrawl.dev${upstreamPath}` `` followed by `fetch(url, …)`, which forwards the caller's `Authorization` header.
  - The routes are mounted unconditionally at `routes/admin.ts` L103–116: `POST /admin/integration/{create-user,validate-api-key,rotate-api-key}`.
  - They are **outside** the `if (config.BULL_AUTH_KEY)` block (L29–101) and have no auth middleware. `index.ts` L135 has `app.use(adminRouter)`.
  - **Any client of the API port can make the self-host call Firecrawl Cloud infrastructure.** This is not a background default, but it is reachable.
- `controllers/v0/admin/crawl-monitor.ts` L52/L58/L102 crawls `https://firecrawl.dev` with limit 2. It is reachable only via `/admin/${BULL_AUTH_KEY}/crawl-monitor` (admin.ts L95–99, inside the BULL_AUTH_KEY block). It contacts the public website, not the API.
- `services/posthog.ts` L19: `POSTHOG_HOST || "https://us.i.posthog.com"`. It is a no-op unless `POSTHOG_API_KEY` is set (L26). This is third-party analytics, not Firecrawl.
- Fire-engine is Firecrawl's hosted scraping engine: `scraper/scrapeURL/engines/fire-engine/scrape.ts` L181–182 `config.FIRE_ENGINE_BETA_URL ?? "<mock-fire-engine-url>"`. The gate is `useFireEngine = FIRE_ENGINE_BETA_URL !== "" && !== undefined` (`engines/index.ts` L57–59, `WebScraper/sitemap.ts` L22–24). **There is no default Cloud URL. It is inert unless configured.** The fire-engine engines are also added when `meta.mock !== null` (engines/index.ts L657–667), which is test mocks only.
- Search: `search/v2/index.ts` L40 uses fire-engine search only if `FIRE_ENGINE_BETA_URL` is set. L56 uses SearXNG if `SEARXNG_ENDPOINT` is set. **L69–77 falls back to DuckDuckGo** (`search/v2/ddgsearch.ts` L150/L166 `https://html.duckduckgo.com/html`) whenever SearXNG is unset or returns zero web results. This is not a Firecrawl destination, but it is a silent direct-egress fallback relevant to home-IP policy.

**Identity strings and defaults that are not fetched:**
- `config.ts` L31: `FIRECRAWL_DASHBOARD_URL: z.url().default("https://www.firecrawl.dev")`. It builds links in exchange.ts L519, slack.ts L40/L239, slack/commands.ts L45, slack/redirect.ts L14 and monitoring_email.ts L138/L149.
- `config.ts` L129–131: `AGENT_AUTH_RESOURCE_METADATA_URL` default `https://www.firecrawl.dev/.well-known/oauth-protected-resource`. It is emitted in the `WWW-Authenticate` header on 401 and **points clients at Cloud OAuth metadata.**
- `services/oauth-token-introspection.ts` L8: `FIRECRAWL_REST_RESOURCE = "https://api.firecrawl.dev/"`. It is the expected OAuth audience (used at controllers/auth.ts L127). The introspection endpoint itself is `OAUTH_INTROSPECT_URL`, which is optional with no default.
- `services/mcp/action-logs.ts` L9–10: an allow-list of resource strings, `https://mcp.firecrawl.dev/v2/mcp` and `…/v2/mcp-oauth`.
- `controllers/v2/parse.ts` L483: a synthetic URL label `https://parse.firecrawl.dev/uploads/…`. The engine is forced to `pdf`/`document`/`fetch` by file kind (L118–130). Whether the `fetch` branch could dereference this URL was not traced.
- `services/notification/monitoring_email.ts` L20 and `email_notification.ts` L169: the from-address `notifications@notifications.firecrawl.dev`.
- User-facing messages that mention `firecrawl.dev/pricing`, `/signin` and `/app`: `controllers/auth.ts` L387/L392/L831, `lib/keyless.ts` L21, `lib/key-restriction.ts` L11, `lib/ip-restriction.ts` L158, `routes/shared.ts` L73/L105–106/L208–209, `controllers/v0/scrape.ts` L285, `v0/crawl.ts` L152, `v1/scrape.ts` L285, `v2/scrape.ts` L434, `v2/browser.ts` L255, `v2/scrape-browser.ts` L586, `v2/parse.ts` L597, `index.ts` L122 (`docs.firecrawl.dev`), `services/worker/scrape-worker.ts` L1029 (`help@mendable.ai`).
- `config.ts` L309 is a comment mentioning `https://api.firecrawl.dev/v2/slack/oauth/callback`.

**Other third-party defaults, key-gated:**
- `config.ts` L63–66: `GOOGLE_WEB_RISK_API_URL` default `https://webrisk.googleapis.com`. It is disabled unless `GOOGLE_WEB_RISK_API_KEY` is set (`google-web-risk.ts` L54–55).
- `SENTRY_DSN` is optional (`sentry.ts` L125).
- `LLAMAPARSE_API_KEY` is optional (config.ts L104).

## Surprises and flags

1. Upstream Chromium runs with `--no-sandbox --disable-setuid-sandbox --no-zygote` (api.ts L193–198), and page concurrency defaults to 10.
2. `POSTGRES_DB` must remain `postgres` because `cron.database_name = 'postgres'` is baked into the image. The upstream SELF_HOST.md example (`POSTGRES_DB=firecrawl`) would break pg_cron init.
3. nuq.sql applies `ALTER SYSTEM` settings of `max_wal_size=16GB` / `min_wal_size=4GB`, which are sized for cloud disks.
4. Compose publishes the API on all interfaces and persists no Postgres, Redis or RabbitMQ data in named volumes. FoundationDB and its init container always start even though the pg backend is the default.
5. `/admin/integration/*` is unauthenticated and proxies to `integrations.firecrawl.dev`.
6. `AGENT_AUTH_RESOURCE_METADATA_URL` defaults to Cloud.
7. Search silently falls back to DuckDuckGo when SearXNG returns nothing.
8. The Rust build has no Cargo.lock and has floating git dependencies. The rustup toolchain is unpinned. The FDB .deb download has no checksum check. Every base image uses a floating tag.
9. On ARM64, Chromium comes from Playwright's own build (`cdn.playwright.dev`), not Chrome for Testing as on x64.
10. A prebuilt `ghcr.io/firecrawl/firecrawl:2.11.162` arm64 image exists, and its build SHA matches the pinned commit. The matching playwright-service and nuq-postgres version tags do not exist; only `:latest` does.
