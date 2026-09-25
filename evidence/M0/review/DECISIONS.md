# M0 separate review — decisions D1–D6

- **Reviewer:** a fresh Opus 5.5 session at xhigh effort. It read the recorded M0 evidence and both canonical documents. It did not have the M0 transcript.
- **Date:** 2026-09-25. Re-checks ran 05:38Z–06:05Z; each file under `sources/` carries its own URL and retrieval UTC.
- **Repository at start:** `085842d` on `main`, clean, one worktree.
- **Method:** public, unauthenticated retrievals only (`curl`; anonymous registry pull tokens were used and not stored). No Pi access, no Firecrawl Cloud endpoint, no spending, no install, no Docker.
- **Not touched:** the M0 status row, B1, B2, `deploy/versions.lock.json`, `scripts/`, existing files in `evidence/M0/`. The M0 re-check owns those.

## Decisions at a glance

| ID | Decision | Applies in | Owner input |
|---|---|---|---|
| D1 | The browser worker pins the newest stable Playwright whose bundled Chromium contains the fix for every Chromium bug Google has marked exploited in the wild at build time. Today 1.63.0 (Chromium 153.0.8010.12) qualifies by fix-commit history; the 1.64 line (Chromium 155) qualifies by version once it is stable. If no release qualifies, browser rendering stays fixture-only. | M2, and every later browser upgrade | None |
| D2 | Keep the 16 KiB-page kernel. M1 proves its components natively before building on them; M2 proves Chromium first. The 4K kernel is proposed to the owner only after a reproduced page-size failure of a mandatory component that no same-version build clears. | M1, M2 | None now. The fallback, if triggered, needs approval. |
| D3 | `rabbitmq:4.3.6`, plain image (no management plugin), by digest, accepted only after an M1 NuQ round trip. The move off 4.3 (community support ends 2026-11-30) belongs to M8. | M1; series move M8 | None |
| D4 | Any source build uses Go 1.27.x (newest patch at build time, image pinned by digest). go.mod needs no change. | M2; M1 only if it must build from source | None |
| D5 | Adopt `@modelcontextprotocol/server` 2.1.0 with `core` 2.1.0 and `node` 2.1.0; `client` 2.1.0 for tests only. | M4 | None |
| D6 | M1 acquires `ghcr.io/firecrawl/firecrawl:2.11.162` by arm64 digest and builds NuQ on the Pi. M2 builds its patched image on the Mac if the owner approves a Linux arm64 container runtime there; otherwise on the Pi with the project stack stopped. | M1; build host M2 | Yes or no to a Linux arm64 container runtime on the Mac, before M2's first build |

## Facts re-verified since M0

M0's retrievals ran 2026-09-25 between 03:14Z and 04:05Z. All paths below are relative to `evidence/M0/review/` unless they start with `evidence/`.

| Fact | M0 record | Re-check | Source |
|---|---|---|---|
| Latest stable Playwright | 1.63.0 | Unchanged. `next` is now `1.64.0-alpha-2026-09-25`. | `sources/npm-playwright.json` |
| Chromium in Playwright 1.63.0 | 153.0.8010.12 | Unchanged (revision 1243, Chrome for Testing) | `sources/playwright-core-1.63.0-browsers.json` |
| Chromium in the 1.64 alpha | — | **New:** 155.0.8059.12 (revision 1247) | `sources/playwright-core-1.64.0-alpha-2026-09-25-browsers.json` |
| Where 1.63.0 gets its arm64 Chromium | Release-note announcement | **Confirmed in code:** Google's Chrome for Testing `linux-arm64` build, mirrored on `cdn.playwright.dev`. Both archives exist (195,926,016 and 120,278,638 bytes). | `sources/playwright-1.63.0-arm64-cft-archives.txt` |
| Chrome stable security releases since 2026-07-30 | 11 posts, 829 fixes, 2 exploited in the wild | Unchanged. No stable post after 2026-09-22. None of the 108 feed entries has a new in-the-wild notice. | `sources/chrome-stable-desktop-since-2026-07-30.json` |
| Does 153.0.8010.12 contain the two in-the-wild fixes? | Not established | **New:** yes, by V8 commit history (see D1) | `sources/v8-itw-fixes-in-153.0.8010.12.txt` |
| RabbitMQ support table | 4.3 community support to 2026-11-30 | Unchanged. No 4.4 tag, beta or RC exists. | `sources/rabbitmq-release-information.txt`, `sources/rabbitmq-server-releases.txt` |
| RabbitMQ in upstream Compose | `3-management` at the pin | Unchanged at v2.11.402 and at `main` | `sources/firecrawl-upstream-rabbitmq.txt` |
| `rabbitmq:3-management` arm64 digest | The handover gives `47c38812…` | **Correction:** it is `8689ddfc…` (version `3.13.7-management`). `47c38812…` is `rabbitmq:3.13.7`, the plain image it is built on. | `sources/registry-digests-and-build-inputs.txt` |
| Docker Hub digests: rabbitmq 4.3.6 and 3.13.7, postgres 17.11-trixie, redis 8.10.2-alpine | As in `evidence/M0/registry/digests.jsonl` | Unchanged | same |
| Redis jemalloc page size | `--with-lg-page=16` on arm64 at the 8.10 branch | Unchanged. Confirmed at revision `8104e63b`, which built the selected image. | same |
| pg_cron in PGDG trixie arm64 | `1.6.8-1.pgdg13+2` | Unchanged | same |
| FoundationDB client checksum | `a3c451dd…` | Unchanged | same |
| Supported Go lines | go1.27.1, go1.26.8 | Unchanged. Release dates: 1.27.0 2026-08-19, 1.26.0 2026-02-10, 1.24.13 (the last 1.24) 2026-02-04. | `sources/go-supported-lines-and-toolchain.txt` |
| go.mod directives | `go 1.23.0`, `toolchain go1.24.0` | Unchanged | same |
| Use of the Go library at runtime | "Loaded in-process by Node" | **Refined:** loaded only when `USE_GO_MARKDOWN_PARSER` is true, which upstream does not set. A load failure falls back silently to the JavaScript Turndown converter. | `sources/firecrawl-markdown-native-paths.txt` |
| MCP v2 packages | server/core/node/client 2.1.0; hono/express 2.0.1 | Unchanged; no later release. The server 2.1.0 tarball matches its registry integrity. | `sources/npm-modelcontextprotocol-v2.json`, `sources/mcp-sdk-2.1.0-release.txt` |
| Advisories against v2 packages | None | Unchanged (GitHub advisory database and OSV) | `sources/mcp-advisories.txt` |
| Current MCP protocol revision | 2026-07-28 | Unchanged | `sources/mcp-sdk-2.1.0-release.txt` |
| `ghcr.io/firecrawl/firecrawl:2.11.162` | Index `1b223ef1…`, arm64 `6157ce24…` | Unchanged. The config is content-addressed by that digest, so the recorded `FIRECRAWL_BUILD_SHA` holds too. | `sources/firecrawl-2.11.162-image-provenance.txt` |
| How that image was built | The recorded build SHA only | **New:** built natively on an arm64 runner by upstream run 30579949775 from commit `7666c1f9`, with `provenance: false` and a build-SHA assertion. The same run created tag `v2.11.162`. No attestation was found. | same |
| Container runtime on the Mac | None | Unchanged | `sources/mac-container-runtime.txt` |

**Relied on but not re-verified (NOT_REVERIFIED):**

- Host facts from the M0 audit, recorded 2026-09-25 03:15Z–04:00Z (`evidence/M0/audit.json`, `evidence/M0/INTERPRETATION.md`): the 16 KiB-page kernel config, `kernel_2712.img` as the only kernel, the §22 fit figures, the owner services. This review does not contact the Pi.
- Which RabbitMQ releases fix which 2026 advisories (`evidence/M0/security-review.md` §G, retrieved about 03:20Z). D3 relies on "4.3.6 fixes the 2026-08 and 2026-09 advisories".
- B1's kernel-level confirmation (`evidence/M0/b1/APPLIED.md`). D6's Pi fallback depends on it, and the M0 re-check owns it.

---

## D1 — M2 browser pair

**Decision.** The browser worker is project-owned, so it pins its own Playwright release. It does not inherit upstream's `playwright-service` pin (Playwright 1.58.1 with Chromium 145.0.7632.6).

- **Which release.** M2 pins the newest stable Playwright release available when it builds the worker, with the Chromium that release bundles.
- **Admission test.** The release is admitted only if its Chromium contains the fix for every Chromium bug Google has marked "exploited in the wild" by the build date. Evidence of a fix is one of:
  - (a) the bundled version is at or above the first stable build that shipped the fix; or
  - (b) the fix commit is an ancestor of the source revision the bundled build pins, and no later commit on that branch names the bug.

  Test (a) is preferred. Test (b) is used only when no stable release passes (a).
- **If nothing passes.** M2 uses the newest stable release for fixture tests only. Browser rendering of non-fixture targets stays disabled until a release passes.

This is a rule, not a fixed pin; M2's build date decides the version. As of this review:

- **1.63.0** (Chromium 153.0.8010.12, revision 1243) fails test (a) for CVE-2026-87491, whose first stable fix was 153.0.8010.36. It passes test (b) for both CVE-2026-85046 and CVE-2026-87491.
- **The 1.64.0 alpha of 2026-09-25** bundles 155.0.8059.12, which passes test (a) for both. If 1.64.0 ships stable with a 155 build before M2, M2 takes it.

**Evidence.**

- *Upstream pin:* `evidence/M0/upstream/raw/playwright-core-1.58.1-browsers.json` and `evidence/M0/source-review.json` S11. Upstream also launches with `--no-sandbox` and 10 pages (S12); the project cannot reuse that service regardless of version.
- *In-the-wild list:* `sources/chrome-stable-desktop-since-2026-07-30.json`.
  - CVE-2026-85046 is crbug 542403045, "Type confusion in V8". First stable fix: 152.0.7977.82.
  - CVE-2026-87491 is crbug 543557673, "Out of bounds write in V8". First stable fix: 153.0.8010.36.
- *Fix ancestry* (`sources/v8-itw-fixes-in-153.0.8010.12.txt`):
  - Chromium tag 153.0.8010.12 pins V8 `0b60d2b0` (15.3.76.4, 2026-08-24).
  - That revision's history contains `e0562d87` "Fixed: 542403045" (2026-08-07) and `36079c36` "Fixed: 543557673" (2026-08-11).
  - V8 `branch-heads/15.3`, up to 15.3.76.19 (2026-09-24), has no later commit naming either bug.
- *Releases and their bundled builds:* `sources/npm-playwright.json`, `sources/playwright-core-1.63.0-browsers.json`, `sources/playwright-core-1.64.0-alpha-2026-09-25-browsers.json`.
- *Where the arm64 binary comes from* (`sources/playwright-1.63.0-arm64-cft-archives.txt`): from 1.63.0, Linux arm64 uses Google's Chrome for Testing build. Playwright 1.58.1 used Playwright's own arm64 build (`evidence/M0/upstream/findings.md` §4).

**Rejected alternatives.**

- *M0's version-number floor, falling back to "newest available with the residual risk recorded".*
  - The version floor misreads beta and Chrome-for-Testing builds. "Fixed in 153.0.8010.36" names the first stable build to carry the fix, not the first build to contain it; 153.0.8010.12 already contains it by commit history.
  - The fallback would knowingly render arbitrary pages in a browser with an unfixed in-the-wild exploit. Keeping non-fixture rendering off until a release qualifies costs little, because M2's acceptance runs on controlled fixtures.
- *An older Playwright driving a newer Chrome for Testing binary through `executablePath`.* Spec §3.1 and §27 forbid moving Chromium independently of its package, and Playwright supports only its bundled revision.

**Strongest case against.** Commit ancestry is this review's reading set against the vendor's advisory, which names 153.0.8010.36. A fix can span several commits, or have a follow-up filed under another bug id, and a search for two ids can miss it. So pin by version or not at all.

*Answer.* The limit is real, and the evidence file records it. That is why test (a) is preferred and (b) is a fallback. It is also why the expected M2 pin is the 1.64 line, which passes (a). Test (b) matters only if M2 starts before a qualifying stable release exists. Even then, 153.0.8010.12 lacks up to 166 later stable security fixes (42, 16 and 108 in 153.0.8010.47, 153.0.8010.52 and 154.0.8037.57; none is marked in the wild). The "newest stable at build time" part of the rule removes that gap as soon as 1.64.0 ships. The answer stands.

**Obligations.**

- **M2, before pinning:**
  - Run the admission test against Chrome's stable feed as of the build date.
  - Record in `deploy/versions.lock.json`:
    - the Playwright version;
    - the `browsers.json` revision and browser version;
    - each archive's URL and the SHA-256 of what was installed, which closes the lock's `browser.archive_sha256` item;
    - for each in-the-wild CVE, which test passed and its evidence.
  - *Check:* an M2 evidence file lists every in-the-wild CVE with its result. A missing CVE is FAIL.
- **M2:** re-resolve the browser base image for the chosen version. The lock's `mcr.microsoft.com/playwright:v1.58.1-noble` candidate does not carry over.
- **M2:** prove the browser launches natively on the Pi as the milestone's first step (see D2). The arm64 binary's builder changed at 1.63.0.
- **M8, and every later browser upgrade under spec §27:** apply the same admission test.
- **Note:** the lock's `browser` section records upstream's 1.58.1. That is not the project's browser pin; M2 replaces it when it regenerates the lock.

**Canonical edits.** Spec §3.1, Browser row. It now says the browser worker's Playwright pin belongs to the project, and it states the admission rule.

*Reason:* the old row, "Chromium shipped with the pinned Playwright package", cited upstream's Dockerfile [F10]. The only Playwright pin in the repository is upstream's 1.58.1 in the lock. Read together, the row pointed at Chromium 145, which this decision rejects.

---

## D2 — 16 KiB-page kernel

**Decision.** Keep `kernel_2712.img` (16 KiB pages).

- Prove each mandatory component natively on this kernel before building on it: M1's components as M1's first step, Chromium as M2's first step.
- Propose the 4K fallback to the owner only on the trigger below. The fallback is: install `linux-image-rpi-v8`, set `kernel=kernel8.img`, and reboot.

**Known risk versus unproven.** Documented 16 KiB-page failures fall into three classes that matter here:

1. jemalloc built for 4 KiB pages;
2. ELF files whose segments are aligned to 4 KiB, from tooling bugs or custom linker flags (older Chrome and Electron builds are named);
3. Chromium before 102, whose allocator lacked 16 KiB support.

Both lists also name emulators and Android binaries, which are irrelevant here (`sources/rpi-16k-incompatible-software-tracker.txt`, `sources/asahi-broken-software.txt`). Neither list mentions PostgreSQL, Erlang/RabbitMQ or Node.

| Component | Milestone | Status on 16K | Basis |
|---|---|---|---|
| Redis 8.10.2-alpine | M1 | **Known risk, designed out** | Redis bundles jemalloc. The selected image's build (revision `8104e63b`) configures `--with-lg-page=16` on arm64. The Pi tracker lists `bitnami/redis` and 4K-built Redis packages as failing, so only the official image is acceptable. Upstream's unused `apps/redis` uses Bitnami. |
| Chromium (Chrome for Testing arm64, through Playwright) | M2 | **Unproven; highest residual risk** | The failure classes include older Chrome builds. Current Chromium supports 16 KiB pages, but the arm64 builder changed at Playwright 1.63.0. |
| RabbitMQ 4.3.6 (Erlang/OTP 27.3.4.18, JIT on) | M1 | **Unproven** | No report either way. The BeamAsm JIT maps executable memory itself, a page-size-sensitive mechanism (`sources/docker-library-rabbitmq-4.3-dockerfile.txt`). |
| Firecrawl API image (Node 22 and V8, the Rust napi module, the Go library) | M1 | **Unproven** | No report for Node or V8, and V8 runs inside Chromium on 16 KiB kernels. The pinned tree has no jemalloc (S16). The Rust module runs on every Markdown conversion. The Go library loads only if `USE_GO_MARKDOWN_PARSER` is set. |
| PostgreSQL 17.11 with pg_cron | M1 | **Unproven, low** | Not named in either list |
| Access gateway (project Node) | M1 | **Unproven, low** | Same runtime as the API image |
| SearXNG | M5 | **Unproven** | Proven when M5 first starts it |

**Fallback trigger.** All three must hold:

1. A mandatory component fails its native proof on this kernel: it fails to start, it crashes at start or under its proof workload, or the check that depends on it fails.
2. The failure is attributed to page size by a named signature:
   - jemalloc's "Unsupported system page size";
   - `readelf -lW` showing a LOAD segment aligned below `0x4000` in a binary or library that fails to load; or
   - a crash in an allocator, JIT or mmap path that the same image digest does not show on a 4 KiB-page arm64 kernel.
3. No same-version alternative clears it within the milestone:
   - another official build of the same version (a different base variant); or
   - for a project-built image, a rebuild with 64 KiB segment alignment or a 16 KiB jemalloc page.

When all three hold, record a blocker with the evidence and ask the owner. The switch is host-wide: it changes the kernel under Pi-hole and the owner's other services, and it reboots the household DNS host. Milestone authorization does not cover that (CLAUDE.md §7). A failure without a page-size signature, such as a memory cap or a configuration error, never triggers the fallback.

**Prove before committing?** Yes, for M1's components. M1 runs the native proofs as its first step after installing the container runtime, before it writes persistence, gateway or Compose configuration on top.

Chromium is not pulled into M1:

- Pulling it in would start M2's work inside M1.
- A later switch to 4K is the conservative direction. 4 KiB is the default arm64 page size in the distributions these images target, so a switch would mean re-running M1's automated checks, not redesigning M1.

M2 proves Chromium before its patch work, so that the fallback, if needed, is decided early.

**Evidence.**

- *Host kernel:* `evidence/M0/INTERPRETATION.md` §5 and `evidence/M0/audit.json` (NOT_REVERIFIED; recorded 2026-09-25).
- *Failure classes:* `sources/rpi-16k-incompatible-software-tracker.txt`, `sources/asahi-broken-software.txt`.
- *Redis:* `sources/registry-digests-and-build-inputs.txt`, and `evidence/M0/source-review.json` S16.
- *RabbitMQ's Erlang build:* `sources/docker-library-rabbitmq-4.3-dockerfile.txt`.
- *API native paths:* `sources/firecrawl-markdown-native-paths.txt`.
- *Chromium's arm64 source:* `sources/playwright-1.63.0-arm64-cft-archives.txt`.

**Rejected alternative.** Switch to the 4K kernel now.

- It is a host-wide boot change and reboot that needs the owner's approval.
- The owner's current services run on 16 KiB.
- No failure has been observed.
- The known failure classes are absent from, or designed out of, the chosen M1 images.
- The native proofs are needed regardless, because M1 must assert native ARM64 execution.

**Strongest case against.** The maintainers build and test every image in this stack on 4 KiB kernels. Five unproven components add up to a real chance that something breaks, and the JIT-heavy pieces (V8 in Node and Chromium, BeamAsm in RabbitMQ) are where page-size assumptions hide. Switching once now costs one reboot and removes the whole class.

*Answer.* The chance is real, but being wrong is cheap and bounded.

- A failure surfaces in M1's first step.
- The fallback is one owner-approved reboot away, after which M1's checks run again.
- Switching now spends the owner's approval and a host-wide change on a failure nobody has seen, and gives up the model-specific kernel the host runs today.

The answer stands.

**Obligations.**

- **M1, first step after the container runtime is installed.** Prove each component natively:
  - every container runs on arm64 from the pinned digest;
  - PostgreSQL answers a query, and the pg_cron scheduler is running;
  - Redis answers `PING`, and `INFO memory` reports a jemalloc allocator;
  - RabbitMQ answers a ping and passes the NuQ round trip (D3);
  - the API harness is up with its six children, and the static fixture's Markdown matches the expected output. That conversion runs the Rust module, so a load failure shows as a failed start or as empty or wrong Markdown;
  - the gateway serves an authenticated request.
- **M1, the Go library.** Record `USE_GO_MARKDOWN_PARSER` as unset, which is upstream's default and leaves the Go library inert. If any milestone enables it, assert after a conversion that the converting process maps `libhtml-to-markdown.so` (`/proc/<pid>/maps`), because a load failure is otherwise hidden by the Turndown fallback.
- **M2, first step.** Launch the browser headless with the sandbox on, render one fixture page, exit cleanly, and confirm the process tree is gone.
- **M5.** Prove SearXNG starts natively when it is first started.

**Canonical edits.** None. The canonical documents do not name a page size. The obligations sit inside M1's existing "Assert every running binary/container is native ARM64" and M2's "Browser native-build feasibility must be established rather than presumed".

---

## D3 — RabbitMQ series

**Decision.** M1 runs `rabbitmq:4.3.6`, the plain image with no management plugin, pinned by digest: index `sha256:d0bffe70e755f348625415f32b0a090662e5f06b3ba3f82a4c7aaa18621b1279`, arm64 `sha256:1a4b64d98915c38f496d1047f427baecdf0f5f73a773c8f2f7a515ce9763b5f8`. M1 accepts it only after the NuQ round trip below. If a 4.4.x GA release is published before M1 starts, M1 takes the newest 4.4.x patch instead, under the same checks.

**What happens at 2026-11-30.** No successor exists yet. There was no 4.4 tag, beta or RC at 2026-09-25 05:48Z.

- *RabbitMQ's recent pattern:* each series' community support ended 15 days to about three months after the next series' GA.

  | Next series GA | Previous series' community support ended |
  |---|---|
  | 4.1.0 on 2025-04-15 | 4.0 on 2025-04-30 |
  | 4.2.0 on 2025-10-27 | 4.1 on 2026-01-31 |
  | 4.3.0 on 2026-04-23 | 4.2 on 2026-07-31 |

  That suggests a 4.4 GA before 2026-11-30. It is an inference, not a published date.
- *If a 4.4.x GA exists by then:* move to its newest patch as a controlled upgrade (spec §27):
  1. enable all stable feature flags on 4.3;
  2. back up definitions and data;
  3. run the NuQ round trip against a candidate;
  4. cut over.

  Enabled feature flags cannot be turned off, so rollback means restoring the pre-upgrade state. That is the schema-sensitive rollback M8 must rehearse anyway.
- *If none exists:* stay on 4.3.x as an accepted gap. The broker is private, speaks AMQP 0-9-1 only, and publishes no port. It has none of the plugins where most 2026 advisories landed: management, STOMP, MQTT, Web STOMP, federation or shovel (`evidence/M0/security-review.md` §G).
- *In either case:* an advisory affecting the enabled surface moves the broker to a fixed community release in whichever milestone is active. The enabled surface is core AMQP 0-9-1, quorum and classic queues, Erlang distribution, and the Prometheus plugin.
- *Owner of the move:* M8, because upgrade and rollback are its scope, and the move gives its rehearsal a real upgrade. M9's acceptance records whether the broker is on a community-supported series or on the accepted gap.

**Has upstream run NuQ on 4.x?** Not in any public evidence.

- Upstream Compose pins `rabbitmq:3-management` at v2.11.162, at v2.11.402 and at `main`.
- None of the 76 upstream issues and PRs that mention RabbitMQ concerns 4.x.
- What Firecrawl Cloud runs is unknown.

So the project runs the first known test of NuQ on 4.x itself. NuQ's use of RabbitMQ is small (`sources/nuq-rabbitmq-usage.txt`; `evidence/M0/source-review.json` S14):

- durable quorum queues;
- one exclusive, auto-delete classic reply queue;
- `basic.get` without acknowledgement;
- a 50-second per-message expiration on the quorum prefetch queue;
- small payloads: a status word or a job descriptor. Results live in PostgreSQL.

**Health without the management plugin.** RabbitMQ documents CLI-based checks. Stage 1 is `rabbitmq-diagnostics -q ping`. Stage 3 is `rabbitmq-diagnostics -q check_running && rabbitmq-diagnostics -q check_local_alarms`. Two facts shape how to use them on the Pi:

- Each CLI call starts an Erlang VM that joins Erlang distribution, and the container healthcheck runs inside the broker's 512 MiB cap.
- RabbitMQ's own Kubernetes operator uses a TCP check on the AMQP port as its readiness probe (`sources/rabbitmq-docs-health-checks.txt`).

So M1 uses three layers:

- *Container healthcheck:* a TCP connect to 5672, or `ping` at a long interval, with a start period long enough for a Pi boot. Upstream #4750 measured about 20 seconds on a 16-CPU host.
- *On demand:* `check_running` plus `check_local_alarms` from the status command, and metrics from `rabbitmq_prometheus`, which the plain image enables (port 15692, internal only).
- *Functional proof:* the NuQ round trip.

**Evidence.**

- *Support dates and releases:* `sources/rabbitmq-release-information.txt`, `sources/rabbitmq-server-releases.txt`.
- *Upstream usage and issues:* `sources/firecrawl-upstream-rabbitmq.txt`.
- *NuQ's broker usage:* `sources/nuq-rabbitmq-usage.txt`.
- *Health checks:* `sources/rabbitmq-docs-health-checks.txt`.
- *The official image:* `sources/docker-library-rabbitmq-4.3-dockerfile.txt`.
- *Digests:* `sources/registry-digests-and-build-inputs.txt`.
- *Advisories:* `evidence/M0/security-review.md` §G (NOT_REVERIFIED; retrieved 2026-09-25 about 03:20Z).

**Rejected alternatives.**

- *3.13.7, upstream's line.* Community support ended 2024-09-30, and public fixes stopped with it; the 2026 advisories have public fixes only in 4.3.x. It is kept only as the recorded fallback, if the round trip fails on 4.x for a 4.x-specific reason: plain `rabbitmq:3.13.7` by arm64 digest `sha256:47c388129d4fc820f399d60d4e358c03a91617a657be024be7321be3387de819`, recorded as an accepted gap.
- *4.2.x.* Community support ended 2026-07-31, and public 4.2.9 lacks the 2026-08 and 2026-09 fixes, which are commercial-only.
- *The `-management` variant.* Spec §22 avoids the management plugin unless a diagnostic need warrants it, and the CLI checks plus Prometheus metrics cover health.

**Strongest case against.** Upstream has only ever run NuQ on 3.13, and 4.x changes broker internals and defaults. NuQ already has open reliability bugs in its RabbitMQ listener: upstream #4244 reports that one failed `consume()` leaves the listener without a consumer, so every `waitForJob()` hangs. Changing the broker's major version under a fragile queue layer invites failures that are hard to attribute, and a private, plugin-minimal 3.13.7 is little exposed.

*Answer.* The fragility is real, but it lives in NuQ's client code and occurs on 3.13 as well, so the round trip must exercise it on either series. 3.13.7 gets no public fixes, so any future advisory in its core would stay unfixed for the life of the deployment; 4.3.x gets them. The round trip exercises every part of NuQ's small broker contract, and if 4.x fails it, the fallback is explicit. The answer stands.

**Obligations (M1).**

- **Image.** Pull by digest. Use the plain image, never `-management`. Publish no port: 5672, 4369, 25672 and 15692 stay on the internal network. Keep the Erlang cookie private.
- **Healthcheck.** Use the layers above, and measure the probe's memory. Set the memory alarm per spec §22: 256 MiB, below the 512 MiB cap.
- **NuQ round trip,** each case recorded as PASS or FAIL in `evidence/M1/`:
  1. A job completes through the quorum prefetch queue and the exclusive reply queue.
  2. A prefetched message that is never consumed expires after 50 seconds, and the job is still served from PostgreSQL.
  3. The broker restarts, and a new job completes. If the #4244 hang reproduces, record it and carry a fix (upstream PR #4263 or equivalent) into M2's patch series.
- **M8:** the series move above. **M9:** record the broker's support state.

**Canonical edits.** None. The canonical documents do not name a series, and spec §22 already requires the explicit memory alarm and no management plugin.

---

## D4 — Go build stage

**Decision.** Any source build of the API image uses Go 1.27.x: the newest 1.27 patch at build time (1.27.1 today), from the official `golang:1.27.x` image pinned by digest. go.mod needs no change. D4 first applies to M2's patched API image. It applies in M1 only if the acquired image fails (D6) and M1 must build from source.

**Why go.mod needs no patch.**

- go.mod declares `go 1.23.0`, a minimum, and `toolchain go1.24.0`, a suggestion the go command follows only when its own toolchain is older.
- The official golang images set `GOTOOLCHAIN=local`, so the bundled 1.27 toolchain runs.
- GODEBUG defaults follow the module's `go 1.23.0` line, except for settings introduced in security releases.

The one required change is the Dockerfile's `FROM golang:1.24 AS go-build`. M2's Dockerfile patch changes that line anyway, along with the other reproducibility fixes.

**Why 1.27 rather than 1.26.** Go supports each release until two newer majors exist, so 1.26 support ends when 1.28 ships and 1.27 support ends when 1.29 ships. Releases land in February and August (1.26.0 on 2026-02-10, 1.27.0 on 2026-08-19). That puts the end of support at about February 2027 for 1.26 and about August 2027 for 1.27; both are estimates from the cadence, not published dates. An image built on 1.26 in the fourth quarter of 2026 would sit on an unsupported toolchain within months, around M9.

**Stakes are lower than M0 assumed.** The Go stage builds only `libhtml-to-markdown.so`, and upstream's configuration never loads it (`USE_GO_MARKDOWN_PARSER` is unset). D4 is build hygiene unless the project turns the Go parser on. The acquired 2.11.162 image (D6) carries a library built with `golang:1.24`, whose last release was 1.24.13 on 2026-02-04. Under upstream defaults that library is inert.

**Evidence.**

- *Supported lines, dates and toolchain rules:* `sources/go-supported-lines-and-toolchain.txt`.
- *When the Go library loads:* `sources/firecrawl-markdown-native-paths.txt`.
- *The API Dockerfile's stages:* `evidence/M0/upstream/findings.md` §3.

**Rejected alternative.** 1.26.x, M0's proposal. Its advantages are more point releases and a smaller jump from 1.24. Both are weak here, because go.mod's `go 1.23.0` line fixes language semantics and GODEBUG defaults at 1.23 whichever toolchain builds the library. Its shorter remaining support is a calendar fact.

**Strongest case against.** 1.27 is five weeks old, and 1.27.1 is its first patch. A cgo `c-shared` library running inside Node is where runtime changes (signals, thread handling) bite, and here a failure is silent because the converter falls back to Turndown. 1.26.8 is the well-tested choice.

*Answer.* The silent-fallback point is correct. It makes a regression invisible, not undetectable, so the obligations add a positive check. With that check, a 1.27 regression shows up in M2's fixtures, and 1.26.x remains a supported fallback with a recorded reason. The toolchain choice also leaves the module dependencies untouched: `golang.org/x/net v0.41.0` and the html-to-markdown fork are pinned by go.sum, and reviewing them belongs to M2's patch review, not to D4. The answer stands.

**Obligations.**

- **M2:** the Dockerfile patch pins `golang:1.27.<newest>@sha256:…`. The lock records the tag, the digest and the `go version` line from the build log, replacing the `runtimes.go_build_stage` candidate.
- **M2, and any milestone that enables `USE_GO_MARKDOWN_PARSER`:** after a conversion, the converting process maps `libhtml-to-markdown.so`, and a fixture's Markdown matches the Go converter's expected output. Without both checks, the Go path is unproven.
- **M8:** moving to 1.28 when 1.27 support ends is a routine rebuild under spec §27.

**Canonical edits.** None.

---

## D5 — MCP SDK

**Decision.** Adopt 2.1.0. M4's package set:

| Package | Version | Role | Integrity |
|---|---|---|---|
| `@modelcontextprotocol/server` | 2.1.0 | `createMcpHandler`, including the stateless 2025-era fallback, which is its default | `sha512-FdvwZU5N03O77Suh35JqjAqq5R1ZTEPFtwu6N4BgBq28qrQtrCnpbLL5U2pwYCuE194jAw0xnlOVmIqhfoYuUQ==` |
| `@modelcontextprotocol/core` | 2.1.0 | Exact dependency of server | `sha512-YdFj5gMRHr0gYNAhTbQDgjLHiEJdIAUYxomhKseUNye7ZGlISQmUoLh2sveFFCiQ7j2YMffT1kgSND0FSfIFjQ==` |
| `@modelcontextprotocol/node` | 2.1.0 | `toNodeHandler` and the Host/Origin validation helpers. Depends on `@hono/node-server ^1.19.9`; needs peer `hono ^4.11.4`, whose exact version M4's lockfile resolves. | `sha512-6xg3iWVcOfiL8Y7rI6xUqXD0lI2AY5q3djsa/cOi1IJUSwx06t0gvhSwU/6mIIohrFlt40/ANUG56DQ0HLhILQ==` |
| `@modelcontextprotocol/client` | 2.1.0 | Test-only, for M4's modern client and its 2025-11-25 client | `sha512-mDVhoy5WjDb0U+4dQPzLcciC2erSex/GRVQqnoZdiuMoE3YiTZdiS7ezNcFwX4XEOWOaj7jZr0kLYnILnL8orA==` |

Not used:

- `@modelcontextprotocol/hono`, `express` and `fastify`, because M4 uses the Node adapter;
- `@modelcontextprotocol/server-legacy`, because 2025-era stateless compatibility is part of `server`.

**Evidence.**

- *Package metadata:* `sources/npm-modelcontextprotocol-v2.json`.
- *Release notes, the tarball integrity check and the legacy fallback:* `sources/mcp-sdk-2.1.0-release.txt`.
- *Advisories:* `sources/mcp-advisories.txt`.
- *M0's SDK review:* `evidence/M0/security-review.md` §B.

2.1.0's notes contain one feature (#1624, request-time OAuth scope challenges) and patch fixes. Nothing is marked breaking.

**Rejected alternative.** Stay on 2.0.0 and enforce the body cap and header rule in the gateway, M0's fallback.

- #2590 is a classification defect inside `createMcpHandler`: a modern POST without `MCP-Protocol-Version` is dispatched, and tool handlers run.
- Re-creating that classification in the gateway is custom protocol code, which the spec avoids (§35: "Minimize protocol code").
- M4's verification requires "malformed/missing/mismatched header/body rejection", which 2.0.0 fails.
- `node` 2.1.0, the release of the Node adapter that bounds body reads, requires `server ^2.1.0`.

**Strongest case against.** 2.1.0 is two days old, and it is a minor release carrying a new feature. Its body cap is redundant, because spec §20.3 already caps request bodies at 1 MiB in the gateway before MCP sees them. Wait for 2.1.1.

*Answer.* Agreed: the 4 MiB cap adds little behind the 1 MiB gateway cap, so it is not the reason for this decision. #2590 is, and no gateway cap substitutes for it. M4 is several milestones away, and spec §17.1 already makes M4 check for security patches before freezing its lock. A later 2.1.x patch taken at M4 is a baseline change under spec §3.2. The answer stands.

**Obligations (M4).** Lock the set above with its integrities, then verify:

1. A modern POST without `MCP-Protocol-Version` gets `400` with JSON-RPC `-32020`, and no tool handler runs.
2. A body over the gateway cap is refused at the gateway with `413` before parsing (spec §20.3).
3. The cancellation test includes a request whose id is `0` (#2654).

**Canonical edits.** Every baseline occurrence of `server@2.0.0` becomes `server@2.1.0`:

- spec lines 46, 83 and 512, and source M06 at line 1184;
- milestones line 36;
- line 108 of both `CLAUDE.md` and `AGENTS.md`, which stay byte-identical.

Spec line 83 and §17.1 also name the companion `core` and `node` 2.1.0 packages. See "Canonical edits made" below.

---

## D6 — M1 image source and build host

**Decision.**

- **API image (M1).** M1 acquires the upstream API image by digest: `ghcr.io/firecrawl/firecrawl@sha256:6157ce24e6867f013704c1cf2b752ec1ea7a3f730da09014b511d1049c8651af` (arm64; index `sha256:1b223ef18d410f67615f32ccaa3dcedfc26af4286f096247bddca3b624545e63`), never by tag. It records the config's `FIRECRAWL_BUILD_SHA=7666c1f9ae8720a6bba271e0f60b6a217f8a5210` at pull time.
- **NuQ image (M1).** M1 builds NuQ on the Pi; it is a base image plus one package, and needs no owner input. It uses upstream's `apps/nuq-postgres/Dockerfile` with two project packaging changes:
  - `FROM postgres:17.11-trixie@sha256:86fa57b44a1d38f09970f64ac71eb492f7a9cf94d08b85e1c8f07bb0fc0a1761`;
  - the install pinned to `postgresql-17-cron=1.6.8-1.pgdg13+2`.

  Upstream's `FROM postgres:${PG_MAJOR}` cannot carry a digest through `PG_MAJOR`, because the same file reuses `PG_MAJOR` in the package name and the config path.
- **M2 build host.** M2 builds its patched API image on the Mac (option B) if the owner approves installing a Linux arm64 container runtime there. If the owner declines, M2 builds on the Pi (option C) with the project stack stopped, under a memory cap and CPU quota that leave room for the owner's services, and with card writes measured.
- **The specs agree.** Spec §3.2 now states when the unpatched upstream image may be acquired, and M1's "build or acquire" points to that rule.

**Consistency with §3.2.** In substance, acquiring the image fits §3.2's intent: no patch series exists before M2, and the image is upstream's build of exactly the pinned commit. On its face, though, "Build our images from the pinned source plus an ordered patch series" contradicts M1's "Build or acquire". §3.2 now states when acquisition is allowed and what its provenance is:

- no patch exists yet;
- the image is referenced by digest;
- its recorded build SHA equals the pinned commit.

**Provenance established** (`sources/firecrawl-2.11.162-image-provenance.txt`):

- Upstream run 30579949775 (push to `main`, success, 2026-07-30 20:37:06Z–20:47:54Z) built the arm64 image natively on an arm64 runner from commit `7666c1f9`.
- Before publishing, the run checked that the image's `FIRECRAWL_BUILD_SHA` equals that commit.
- The same run created the annotated tag `v2.11.162`, "Release API image v2.11.162", at 20:47:43Z. The image was created at 20:43:18Z.
- The run built with `provenance: false`, and no attestation was found.

So the provenance is a consistent public chain, not a signed or reproducible build.

**What option A carries.** Everything as built on 2026-07-30:

- Node 22.23.2, the July security release;
- Debian packages as of that day;
- Rust dependencies resolved that day, since upstream keeps no Cargo.lock;
- the Go library built with `golang:1.24`, which upstream's configuration never loads.

M1 carries only controlled fixture traffic ("Until M2 guarded retrieval is complete, permit only test-target outbound traffic"), and M2 replaces the image with a project build.

**M2 build host: the owner decides; the recommendation is the Mac.**

| | Mac (option B) | Pi (option C) |
|---|---|---|
| Needs | The owner's approval to install a Linux arm64 container runtime on the workstation | Nothing new. B1's memory controller, once the M0 re-check confirms it, makes a bounded build possible. |
| Effect on the Pi | None beyond the image transfer | The build cannot run beside the full stack, because spec §22 leaves about 281 MiB of headroom. Each build stops the project stack, runs slower on four cores, and writes to the only disk. |
| Fit for M2 | M2 develops the patch series and rebuilds often | Acceptable for occasional rebuilds |

The smallest input is a yes or no to installing one Linux arm64 container runtime on the Mac. Which runtime is the owner's choice. If it is Docker Desktop, its subscription terms apply to larger businesses, not to personal use; free and open-source runtimes also exist.

**Rejected alternative.** Build from source in M1, on the Pi, while the stack is not yet running. That would set up the build pipeline early. But a reproducible build needs its fixes first:

- a pinned Rust toolchain;
- a generated and committed Cargo.lock;
- the FoundationDB checksum;
- the Go line;
- digest-pinned `FROM` lines.

Those are Dockerfile edits that begin M2's patch series. Building in M1 would also change nothing M1 tests, because the same commit runs either way.

**Strongest case against.** The core service would run a third-party binary with no attestation, whose Rust dependencies floated at build time. That contradicts the reproducibility the spec asks for. Build from source from the start: the Pi is idle during M1, so the build competes with nothing.

*Answer.* The idle-Pi point is fair: it makes option C cheaper in M1 than in M2. But reproducibility needs the Dockerfile fixes, which are M2's patch series; doing them in M1 widens M1 and pulls M2's work forward. The acquired image's provenance chain is public and consistent, and M2 replaces the image. The answer stands.

**Contingency.** If the acquired image fails its native proof for a page-size reason (D2), M1 builds from source. D4, the reproducibility fixes and the build-host decision then move into M1, and the owner input above becomes an M1 input.

**Obligations.**

- **M1, API image:**
  - Pull by digest.
  - Assert `FIRECRAWL_BUILD_SHA` equals the pinned commit.
  - Record run 30579949775 and the missing attestation under `build_provenance` in `deploy/versions.lock.json`.
- **M1, NuQ image:** build it as above. The lock records the base digest, the pg_cron version and the built image's digest, which resolves the lock's `pg_cron_package` item.
- **M2:**
  - Build on the host the owner's answer selects.
  - Close every gap in `evidence/M0/INTERPRETATION.md` §4: the Rust toolchain, Cargo.lock, the FoundationDB checksum `a3c451dd…`, D4 and digest-pinned `FROM` lines.
  - *Check:* the build log shows no floating tag, unpinned toolchain or unlocked dependency.

**Canonical edits.** Spec §3.2 (the build rule sentence) and M1's Implementation Work (its first sentence).

---

## M1 deltas

The M1 handover already assumes four things:

- D6 option A by the digest above, and NuQ built from upstream `apps/nuq-postgres/Dockerfile` with `FROM` pinned to `postgres:17.11-trixie` by digest;
- RabbitMQ per D3, with the management plugin off and a NuQ round trip;
- native start proofs for postgres, redis, rabbitmq, firecrawl-core and the gateway on the 16K kernel;
- D4 applied only if building from source.

M1 must do the following differently or in addition.

1. **Order.** The native proofs are M1's first step after installing the container runtime, before any persistence, gateway or Compose work is built on them (D2).
2. **What "start" means for the API image.** A running container is not enough. The harness must be up with its six children, and the static fixture's Markdown must match the expected output; that runs the Rust module.
   - Leave `USE_GO_MARKDOWN_PARSER` unset and record it as unset.
   - If it is ever enabled, assert that the converting process maps `libhtml-to-markdown.so`, because a Go load failure falls back silently to Turndown.
3. **The NuQ Dockerfile cannot take the digest through its build argument.** `FROM postgres:${PG_MAJOR}` reuses `PG_MAJOR` in the package name and the config path. M1 therefore keeps a project-owned copy with two edits:
   - `FROM postgres:17.11-trixie@sha256:86fa57b4…`;
   - `postgresql-17-cron=1.6.8-1.pgdg13+2` pinned in the install line, not only recorded afterwards.

   It builds on the Pi.
4. **RabbitMQ image and health.** Use the plain `rabbitmq:4.3.6` image, not `-management`, by digest (index `d0bffe70…`, arm64 `1a4b64d9…`). If 4.4.x reaches GA before M1 starts, use its newest patch instead. The healthcheck:
   - gets a start period sized for a Pi boot (upstream #4750 fails at about 20 seconds even on a 16-CPU host);
   - uses a light probe (a TCP check on 5672, or `ping` at a long interval), with its memory measured against the 512 MiB cap;
   - leaves stage-3 checks and `rabbitmq_prometheus` for on-demand status.

   Ports 4369, 25672 and 15692 stay unpublished.
5. **The NuQ round trip has three cases:**
   1. completion through the prefetch quorum queue and the exclusive reply queue;
   2. a prefetched message expiring after 50 seconds, with the job still served from PostgreSQL;
   3. a broker restart followed by a new job.

   If upstream #4244 reproduces, record it as an M2 patch candidate (#4263). If 4.x fails for a 4.x-specific reason, fall back to plain `rabbitmq:3.13.7` by arm64 digest `47c388…`, recorded as an accepted gap.
6. **Digest correction, for the record.** `rabbitmq:3-management` arm64 is `8689ddfc…`; `47c388…` is plain `rabbitmq:3.13.7`. M1 uses neither unless the fallback above is triggered.
7. **Redis comes only from the official image** (8.10.2-alpine, already selected), never from `bitnami/redis`, which is built with a 4 KiB jemalloc page.
8. **Provenance in the lock.** Record run 30579949775 and the missing attestation for the API image, and the NuQ base digest, pg_cron version and built image digest.
9. **Contingency.** If the acquired API image fails its native proof for a page-size reason, M1 builds from source. D4, the reproducibility fixes and the owner's Mac decision then move into M1.

D1 and D5 do not affect M1.

---

## Canonical edits made

Every edit replaces text in place. No line is added or removed, so every line reference and every range cited by `ORCHESTRATION.html` stays valid.

| File and line | Old | New | Decision |
|---|---|---|---|
| `docs/FIRECRAWL_PI_SPEC.md` 46 | `…official TypeScript SDK v2 with @modelcontextprotocol/server@2.0.0…` | `…@modelcontextprotocol/server@2.1.0…` | D5 |
| `docs/FIRECRAWL_PI_SPEC.md` 83 | Baseline row `@modelcontextprotocol/server@2.0.0`; "pin matching official Node/core packages" | `@modelcontextprotocol/server@2.1.0`. The row names what 2.1.0 enforces and the core/node 2.1.0 companions. | D5 |
| `docs/FIRECRAWL_PI_SPEC.md` 86 | Browser row: "Chromium shipped with the pinned Playwright package" | The project owns the worker's Playwright pin; the in-the-wild admission rule | D1 |
| `docs/FIRECRAWL_PI_SPEC.md` 91 | "Build our images from the pinned source plus an ordered patch series." | The same sentence, plus when the unpatched upstream API image may be acquired and what its provenance is | D6 |
| `docs/FIRECRAWL_PI_SPEC.md` 512 | "Pin `@modelcontextprotocol/server@2.0.0`, compatible official core/Node packages…" | "Pin `@modelcontextprotocol/server@2.1.0` with `@modelcontextprotocol/core@2.1.0` and `@modelcontextprotocol/node@2.1.0`…" | D5 |
| `docs/FIRECRAWL_PI_SPEC.md` 1184 | Source M06 at the `server@2.0.0` tag | Source M06 at the `server@2.1.0` tag (the URL resolves) | D5 |
| `docs/FIRECRAWL_PI_MILESTONES.md` 36 | "verified `@modelcontextprotocol/server@2.0.0`" | "verified `@modelcontextprotocol/server@2.1.0`" | D5 |
| `docs/FIRECRAWL_PI_MILESTONES.md` 139 | "Build or acquire immutable native ARM64 images…" | The same, plus: the API image is acquired only under spec §3.2's build-SHA rule, and every image is referenced by digest | D6 |
| `CLAUDE.md` 108 and `AGENTS.md` 108 | `@modelcontextprotocol/server@2.0.0` | `@modelcontextprotocol/server@2.1.0` | D5 |

The register (D1–D6 rows, the review paragraph and the next-action line) is updated in the same commit.

**Not changed, and owned elsewhere:**

- The M0 status row, and `evidence/M0/INTERPRETATION.md` line 11 and §5, still say that D1–D6 await the review. The M0 re-check owns both.
- `deploy/versions.lock.json` still lists its candidates. M1 and M2 resolve them from these decisions.

---

## Checks at close-out

Run on 2026-09-25 before the commit that stores this file.

| Check | State | Result |
|---|---|---|
| Old values in spec, milestones, `CLAUDE.md` and `AGENTS.md`: `server@2.0.0`; the old Browser row; the old §3.2 and M1 sentence endings; "Decision for the separate review"; the old next-action wording | PASS | 0 in each file |
| New baseline value `server@2.1.0` | PASS | Spec 4 (lines 46, 83, 512, 1184); milestones 1; `CLAUDE.md` 1; `AGENTS.md` 1 |
| `cmp CLAUDE.md AGENTS.md` | PASS | Identical |
| Line counts unchanged | PASS | 1213, 603, 979 and 979 |
| Each D-row states a decision, with Kind "Decided by the separate review (2026-09-25)" | PASS | 6 of 6 |
| The next action names the M0 re-check | PASS | Milestones line 603 |
| M0, B1 and B2 rows unchanged against `085842d` | PASS | Byte-equal |
| Files outside this review's ownership unchanged (`deploy/`, `scripts/`, existing `evidence/M0/` files) | PASS | `git status` lists none |
| `ORCHESTRATION.html` embedded and displayed hashes equal the files | PASS | Spec `bfe6862e…`, milestones `df5bb388…`, agents `dd344871…` |
| `source-data` serialization round-trips byte for byte | PASS | Before and after the edit |
| Pending-review strings left on the page | PASS | 0 |
| Paths cited in this file exist | PASS | 32 of 32. `evidence/M1/` is a future output location, not a source. |
| Identifier and token scan of `evidence/M0/review/` | PASS | No match |
| `scripts/m0/verify.mjs` | NOT_RUN | Owned by the M0 re-check; some of its checks run live against the Pi |
| Visual check of `ORCHESTRATION.html` in both themes and at phone width | NOT_RUN | Text edits in place only; the layout is unchanged, and the thread grid keeps its seven cards |
