# M1 interpretation — durable, private Firecrawl core

Evidence window 2026-09-25 06:46Z (BEFORE snapshot) to 09:16:53Z (AFTER snapshot), on one boot. The final collection window ran 09:02Z–09:14Z against the deployed commit `e6dbfa1`; later commits change only the workstation-side verifier and evidence. Upstream `firecrawl/firecrawl` v2.11.162 → `7666c1f9ae8720a6bba271e0f60b6a217f8a5210`, unpatched (patches begin in M2).

- **Checks:** `verification.json`, written by `scripts/m1/verify.mjs`. Each check recomputes its verdict from the raw transcripts in `raw/`.
- **Lockfile:** `deploy/versions.lock.json` (digests, build provenance, runtime, RabbitMQ series).
- **Rendered Compose:** `rendered-compose.json`, as the Pi renders it (`docker compose -p fcpi config`).
- **BEFORE/AFTER:** `snapshot-before.txt`, `snapshot-after.txt`, and `snapshot-diff.txt`, the attributed diff written by V14.
- **Redaction:** secrets live only on the Pi in `/etc/firecrawl-pi/secrets` (0700, files 0600, each owned by the uid that reads it). V15 compares the SHA-256 of all five live secrets against every tracked and new repository file (209 at the final run, this file included; 0 findings), after proving each of its 21 rules fires on `tests/contracts/m0-redaction-control.txt` and the M1 control lines.

**State: ACCEPTED.** Every M1 acceptance criterion holds with evidence. 27 of 28 checks pass. N09 fails and stays visible: it records an upstream defect on the proof stack, whose mitigation V10 proves on the deployed stack (§5). M2 additionally waits for the scarce review of this evidence (§8).

## 1. Native proofs (D2)

The proofs ran first, on the 16 KiB-page kernel, after the runtime install and before any Compose, persistence or gateway layer (`raw/native-proofs.txt`).

| Check | Result |
|---|---|
| N01 runtime | docker-ce 29.8.1 (API 1.56, linux/arm64) with compose plugin v5.5.1, held. It was chosen over Debian docker.io 26.1.5 because Engine 28.0.0 stops LAN neighbours reaching loopback-mapped ports (`sources/moby-v28.0.0-release-notes-excerpt.txt`). `iptables`, `libip4tc2` and `libip6tc2` came in as dependencies. |
| N02 images | 6 containers, each on linux/arm64 from its pinned digest; the API image's `FIRECRAWL_BUILD_SHA` equals the upstream commit. |
| N03 PostgreSQL | 17.11 answers; the pg_cron launcher runs (36 jobs, 58 runs succeeded, 0 failed). |
| N04 Redis | PONG; allocator jemalloc-5.3.0. |
| N05 RabbitMQ | 4.3.6, OTP 27, JIT. The first attempt failed on a root-owned Erlang cookie (`eacces`), not on page size; `pi-init.sh` now creates the cookie before the broker's first start. |
| N06 API harness | Harness plus six Node children, each under a resident `sh -c` wrapper. The Rust napi module is mapped by 5 processes; the Go library by none (`USE_GO_MARKDOWN_PARSER` unset). The fixture Markdown is exact. All three native libraries carry 0x10000 LOAD alignment. |
| N07 gateway | Node v22.23.3; authenticated 200 with exact Markdown; unauthenticated 401 with the gateway's own `Bearer realm="fcpi"`. |
| N08 NuQ cases 1–2 | Pass on the proof stack. |
| N09 NuQ case 3 | **FAIL**, classified `upstream-client-defect` (§5). |

No page-size signature appeared anywhere, so D2's 4K-kernel fallback did not trigger, and the API image did not need a source build (D6's contingency stayed closed).

## 2. Topology and caps

**Topology (V02).** The core runs 13 processes, all as uid 3002: the harness, its six children (api, worker, extract-worker, nuq-worker-0, nuq-prefetch-worker, nuq-reconciler) and six resident `sh -c` wrappers. `NUQ_WORKER_COUNT=1` is set explicitly; the upstream default is 5. Each data service runs under a dedicated uid (PostgreSQL 5432, Redis 6379, RabbitMQ 5672), because the images' default 999 is the Pi-hole account on this host. The gateway runs as 3380 and the fixture as 8080. The core's healthcheck runs through `setpriv` as 3002, so no root process enters the count.

**Effective caps (V03, read from each container's cgroup, not from Compose).** Swap is 0 for every container.

| Service | memory.max | cpu.max | pids.max | Measured current / peak |
|---|---|---|---|---|
| nuq-postgres | 640 MiB | 0.75 | 128 | 92 / 104 MiB |
| redis | 320 MiB | 0.35 | 64 | 7 / 14 MiB |
| rabbitmq | 512 MiB | 0.50 | 256 | 116 / 148 MiB |
| firecrawl-core | 2,304 MiB | 2.25 | 512 | 1,686 / 1,839 MiB |
| access-gateway | 160 MiB | 0.30 | 64 | 14 / 27 MiB |
| fixture | 64 MiB | 0.10 | 32 | 15 / 34 MiB |

The M1 caps total 4,000 MiB of spec §22's 6,432 MiB; the rest belongs to services M2 onward add. Host MemAvailable was 5,356 MiB with the stack running. The core's peak is 80% of its cap under fixture load alone, which M2 should measure before adding browser work.

**PostgreSQL** runs with 128 MB shared buffers, 4 MB work_mem, 32 connections, and fsync, full-page writes and synchronous commit on. `max_wal_size=1GB` and `min_wal_size=80MB` are passed as `-c` flags, which override the 16 GB / 4 GB that upstream `nuq.sql` writes with ALTER SYSTEM. RabbitMQ's memory alarm is 256 MiB, below its 512 MiB cap.

## 3. Exposure

- **Host publication (V04):** only the gateway, at `127.0.0.1:3380 → 3300`. It is the only new host listener. The core, PostgreSQL, Redis and RabbitMQ publish nothing.
- **From the LAN (V04):** the workstation probe found all 14 project ports (3380, 3300, 3002–3008, 5432, 6379, 5672, 4369, 25672, 15692) closed on the Pi's LAN address, with sshd on 22 open as the positive control. The loopback-protection rule is present in the nftables ruleset.
- **Networks:**

  | Network | Subnet | Internal | Members |
  |---|---|---|---|
  | `fcpi_access` | 10.231.0.0/24 | no; it carries the host publication | gateway |
  | `fcpi_api` | 10.231.4.0/24 | yes | gateway, core |
  | `fcpi_core` | 10.231.1.0/24 | yes | core, PostgreSQL, Redis, RabbitMQ |
  | `fcpi_fixture` | 10.231.3.0/24 | yes | core, fixture |

  No internal bridge has a host address. `fcpi_browser` (10.231.2.0/24) is not created, because M2 creates it with the browser.
- **Gateway (V05):** a bearer-token check, by SHA-256 hash, runs before routing. It routes only `POST /v1/scrape` and `POST /v2/scrape`, and never `/admin/*`. Scrape targets must be the fixture origin. Missing and wrong tokens get 401 with a gateway-owned body, and no upstream challenge reaches a client. The 15 contract tests pass (`tests/contracts/m1-gateway.test.mjs`). `BULL_AUTH_KEY` is unset; token lifecycle belongs to M3.
- **Egress (V11):** the core and the fixture sit only on internal networks. From inside them, DNS fails and every TCP probe gets ENETUNREACH. Over the 11.5-minute audit window, every must-be-zero counter stayed at 0: routed out of the internal bridges, routed out of the access bridge (IPv4 and IPv6), IPv4 off-subnet, and IPv6 beyond link scope. The only host-delivered flows were DHCP broadcasts, which the audit attributes to 25 NetworkManager transactions on transient veths. The core's logs match none of the 9 Cloud and search-fallback patterns, and a positive-control line proves the scan reads them. There were zero Firecrawl Cloud attempts.

## 4. Persistence and the fail-closed data check

- **Sentinels (V13):** a fresh sentinel went into PostgreSQL (upsert), Redis (SET) and RabbitMQ (a purged durable quorum queue, publisher-confirmed). `docker compose up --force-recreate` then replaced all six containers without deleting any volume or data (83 s). All three stores read the sentinel back, RabbitMQ holding exactly one message, and the RabbitMQ node name stayed stable (`raw/persistence.txt`).
- **Data check (V12):** `fcpi-data-check` checks three things: the filesystem UUID under `/srv/firecrawl-pi/data`, the data ID, and `create_host_path: false` on every bind. Each of its five failure branches stops the stack with its own message, with 0 containers running and the data manifest unchanged. Compose itself also refuses a missing bind source (`raw/mount-branches.txt`).
- **Unclean boot (V17):** `restart: unless-stopped` would revive containers at dockerd start after a power loss, ahead of any unit. A drop-in therefore makes the check dockerd's `ExecStartPre`. With the check failing, dockerd stays down: 0 processes, 0 writers, manifest unchanged. When restored, all six containers come back healthy (`raw/docker-gate.txt`). Docker serves only this project on this host, which is why coupling the daemon to the check is acceptable.

## 5. NuQ round trip (D3)

| Case | Deployed stack | Evidence |
|---|---|---|
| 1. Completion through the quorum prefetch queue and the exclusive auto-delete reply queue | **PASS** (V08) | Prefetch queue quorum/durable; reply queue classic, exclusive, auto-delete, 1 consumer; Markdown exact |
| 2. An unconsumed prefetched message expires after 50 s; the job is still served from PostgreSQL | **PASS** (V09) | Worker paused as its own uid; expiry bracketed at 50–54 s; job `active` in PostgreSQL until the message vanished; requeued by the lock reaper; `dead_lettered_expired` +1; the resume follows the expiry; scrape succeeds |
| 3. The broker restarts; a new job completes | **PASS** (V10) by container restart | Broker answers ping after 13 s, core ready after 23 s with 1 restart; the new job completes through a redeclared reply queue |

- **N09 (proof stack, no restart policy): FAIL.** `nuq.ts` `getJobToProcess()` awaits `startSender()` → `amqp.connect()` outside its try/catch. During a broker restart, ECONNREFUSED therefore escapes the polling loops in `queue-worker.ts:329` and `nuq-worker-runner.ts:120` as an unhandled rejection, and the harness exits. The defect is not specific to RabbitMQ 4.x and has no page-size signature, so the 3.13.7 fallback does not apply. RabbitMQ 4.3.6 stays selected; no 4.4.x GA existed at M1 start (`sources/rabbitmq-releases-at-m1.txt`). The defect is recorded as the M2 patch candidate **PC-NUQ-CONNECT**. Until then, the deployed stack recovers by container restart, not in-process.
- **Upstream #4244** (a listener left without a consumer) did not reproduce, so #4263 is not a patch candidate.
- **The first Compose-stack round trip is not counted** (`raw/nuq-roundtrip-attempt1.txt`): the hardened core gives root no CAP_KILL, so it could not pause the worker. The counted run pauses the worker as its own uid.

## 6. Unrelated state (V14)

The BEFORE snapshot matched M0's AFTER snapshot line for line, on the same boot (N00). Between BEFORE and AFTER, 69 lines differ, and every one is attributed: the container runtime and its kernel modules, the nftables tables (Docker's, plus the project's `fcpi_audit` counter tables), fcpi containers with their scopes, root filesystems and network namespaces, the `127.0.0.1:3380` publication, `fcpi-stack.service`, and the audit's own SSH session scopes. Changes to unrelated state: **0**. The boot ID is unchanged. Pi-hole, Mosquitto, dnscrypt-proxy, fail2ban and the owner's air-quality services keep their units, listeners and mounts. The `fcpi_audit` tables hold counters only and are not persisted, so a reboot removes them.

## 7. Deviations from the M1 handover, and why

1. **Transfer by `git archive`, not rsync.** macOS openrsync lacks `--from0` and `--chown`. `deploy.sh` builds one archive, hashes its extracted contents, and sends it; the Pi verifies every hash with `sha256sum --strict` and records the source commit.
2. **Dedicated uids for the data services** instead of the images' 999 (§2).
3. **An extra internal network, `fcpi_api`,** between the gateway and the core. The gateway no longer shares `fcpi_core` with the data services, and its bridge's egress is counted (§3).
4. **dockerd is gated on the data check (§4),** beyond ordering the check before the Compose unit, because the restart policy bypasses the unit after an unclean boot.
5. **`ALLOW_LOCAL_WEBHOOKS=true` in the M1 fixture-only profile.** Without it, the pinned fetch engine refuses every private address, including the isolated fixture. Spec §29 now records the exception and its containment: internal networks only, `DISABLE_WEBHOOK_DELIVERY=true`, and a gateway that admits only the fixture origin. V18 fails if the containment breaks. M2 removes the flag once guarded retrieval owns the SSRF policy.
6. **The RabbitMQ healthcheck** is a TCP connect to 5672. It measured 3.0 MiB, against 76.5 MiB for `rabbitmq-diagnostics ping`, with a 2-minute start period.
7. **`SCRAPE_MAX_ATTEMPTS=1`:** upstream retries stay off, because M2's adapter owns retries (spec §29).
8. **Egress is contained by internal networks and measured by counters,** not blocked by a drop rule. The access bridge needs its default route for the host publication, and its forwarded traffic measured 0.

## 8. Items for the scarce review

The review is a fresh Opus 5.5 session at xhigh effort that reads this evidence rather than the M1 transcript. M2 waits for it. The packet:

- **Rendered Compose:** `rendered-compose.json`, together with `deploy/compose.yaml` and `deploy/host/*`.
- **Mount checks:** `raw/mount-branches.txt`, `raw/docker-gate.txt`, `deploy/host/fcpi-data-check.sh` and the dockerd drop-in.
- **Effective network exposure:** `raw/stack-final.txt` (publications, networks, cgroups), `raw/lan-probe.txt`, `raw/nft-ruleset.txt`, and `raw/egress-audit-start.txt` with `raw/egress-audit.txt`.
- **Persistence:** `raw/persistence.txt`.

Questions the review should settle:

1. **Egress by measurement.** Is containment by internal networks, with counters on the one non-internal bridge (`fcpi_access`), enough until M2? Or should that bridge get a drop rule for forwarded traffic now?
2. **The dockerd coupling.** The drop-in blocks the whole Docker daemon when the data check fails. That is correct while Docker serves only this project; it has to be revisited if anything else ever uses Docker on this host.
3. **The `ALLOW_LOCAL_WEBHOOKS` containment (V18),** and whether M2 removing the flag is the right owner.
4. **Recovery by restart (PC-NUQ-CONNECT).** Is a broker restart that restarts the whole core acceptable until M2 patches `nuq.ts`?
5. **The Redis `default` user's `+@all` width,** recorded in `deploy/secrets.template` as a known width until a measured command set exists.
6. **Core memory.** The core peaked at 80% of its 2,304 MiB cap with no browser work. Does M2 need a cap rebalance within spec §22 before Chromium arrives?
7. **API image provenance:** upstream run 30579949775, `provenance: false`, no attestation. It is a consistent public chain, not a signed build (D6).
8. **Licensing.** `deploy/nuq-postgres/nuq.sql` is upstream's AGPL-3.0 file, copied byte for byte (SHA-256 `44edb370…`) with its provenance in the Dockerfile. The project copy of the Dockerfile carries two edits.
9. **Publishing.** The Pi's LAN address and hostname appear in tracked files (`scripts/m1/pi-target.conf` and the M0 evidence). This is recorded as a decision for before any first push, which needs a full-history scan anyway; nothing was changed.
