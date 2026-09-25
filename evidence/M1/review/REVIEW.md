# M1 scarce review — evidence, decisions and owned findings

- **Reviewer:** a fresh Opus 5.5 session at xhigh effort. It read the recorded M1 evidence, M1's code and both canonical documents. It did not have the M1 transcript. This is the first run; no earlier review of M1 existed under `evidence/M1/review/`.
- **Date:** 2026-09-25. Public retrievals ran 22:12Z–22:14Z; read-only Pi probes ran 22:25Z–22:27Z. Each file under `sources/` carries its own URL and retrieval UTC.
- **Repository at start:** `7cb748b` on `main`, clean, one worktree. During the review, a parallel owner session committed 23 commits (`36c7f33` … `f2103c1`) that changed `CLAUDE.md`, `AGENTS.md`, `docs/FIRECRAWL_PI_MILESTONES.md` (header line 6 and line 603) and `ORCHESTRATION.html`, making each milestone's own `/review-2` its review of record. On the owner's decision, this review writes only `evidence/M1/review/`, followed by the three `/address` fixes the owner approved (R17–R19).
- **Method:**
  - Every check in `evidence/M1/verification.json` was traced to its code in `scripts/m1/verify.mjs` and to the raw file it reads.
  - The 27 checks that need no Pi were re-executed from a scratchpad copy of `scripts/m1/verify.mjs`, with its two write paths redirected. Every state, input hash and `actual` string reproduced byte for byte, and so did `evidence/M1/snapshot-diff.txt`.
  - Upstream source at the pinned commit, upstream issue state and the API image's registry index were retrieved publicly (`sources/`). No Firecrawl Cloud endpoint was contacted.
  - The owner granted Pi access partway through. It was used only for read-only probes (unit properties, NetworkManager state, `/proc` sysctls, container labels, journal queries, and V15's secret hashing, whose values never left the Pi). Nothing on the Pi was started, stopped or changed.
- **Not touched:** every existing file under `evidence/M1/` (`evidence/M1/INTERPRETATION.md`, `evidence/M1/verification.json`, `evidence/M1/rendered-compose.json`, the snapshots, `raw/`, `sources/`), `deploy/`, `services/`, `tests/`, the milestone register and `ORCHESTRATION.html`. `scripts/m1/` changes only through the three fixes listed under R17–R19.

## Findings at a glance

**M1's register state: ACCEPTED, unchanged.** Every acceptance criterion at milestones line 159 holds on the evidence:

- fixture Markdown (V06);
- sentinels across recreation (V13);
- no unauthenticated or internal port exposed (V04);
- topology (V02);
- source, platform and digests (V01, V16);
- no unrelated service changes (V14, N00).

No finding breaks one. The three M1-owned findings are verifier and probe defects, closed by `/address` in this session.

| ID | Finding | Owner | Breaks an M1 criterion? | Smallest closure | Outcome |
|---|---|---|---|---|---|
| R1 | "#4244 did not reproduce" is vacuous. The core restarted whole on the broker restart, so no API process ever took the listener-reconnect path that #4244 describes (`nuq.ts:146` assigns the listener before `consume()` at 182). #4244 and its fix #4263 are both open upstream. | M2 (patch series) | No | After PC-NUQ-CONNECT, rerun case 3 with no restart policy and assert the listen queue has one consumer and a new job completes; carry #4263 or an equivalent if not. | Deferred to M2 |
| R2 | Recovery from a broker restart is by container restart only (PC-NUQ-CONNECT). A job in flight at harness exit is re-run from scratch once its lock expires; its synchronous client gets a gateway 502. That behaviour is inferred, never observed. | M2 (patch series) | No | Patch `startSender()` to catch the connect failure and fall back to PostgreSQL (the code path exists); N09-equivalent passes; a kill-mid-job test records what the job goes through. | Deferred to M2 |
| R3 | Retry multiplication: NuQ's lock reaper requeues a stalled job up to 9 times (`deploy/nuq-postgres/nuq.sql:131–135`), and each requeue re-runs the whole acquisition, outside any per-page attempt budget. | M2 (attempt budgets) | No | The adapter binds NuQ re-executions to the same logical acquisition ID and its four-attempt budget. | Deferred to M2 |
| R4 | `ALLOW_LOCAL_WEBHOOKS=true` disables the fetch engine's connect-time private-address check for every fetch. Containment holds only while the gateway admits the fixture origin alone and the fixture never redirects. | M2 (SSRF) | No | Remove the flag in the same deploy that lifts, or before any deploy that lifts, the gateway's fixture-only target rule; replace V18 with a flag-unset check. | Deferred to M2 |
| R5 | `fcpi_access` has no forward-drop rule, and no counter covers input from `fcpi-access` to host listeners. | M1 (close-out) | No | A DOCKER-USER forward drop for traffic from `fcpi-access` to anything but itself, an input drop for new connections from `fcpi-access`, and counters for both. | Fixed in `2b42ad0` (V20; `evidence/M1/closeout/CLOSEOUT.md`) |
| R6 | The core sits at 73% of its cap at rest and peaked at 80% on one static page. Its measured idle use exceeds spec §22's *normal* estimate, and no OOM-kill counter was recorded. | M2 (resource budget) | No | Measure the core on M2's fixture corpus before adding Chromium; rebalance within §22 if the peak exceeds 85% of the cap; record `memory.events` for every cgroup. | Deferred to M2 |
| R7 | The "zero Cloud attempts" claim rests partly on log scans that covered two container-instance windows; 09:02:55–09:11:45 (the whole NuQ round trip, the broker restart and the dockerd gate) was never scanned. Failed connects on internal networks emit no packet, so counters cannot see attempts. | M2 (zero-Cloud verification) | No | Scan the logs of every core instance in the window, captured before each recreation, with a positive control per instance. | Deferred to M2 |
| R8 | The snapshot's firewall view is one hash of `nft -s list ruleset`, and it does not record forwarding sysctls (IPv4 forwarding is now 1). M2 adds egress rules and compares a fresh BEFORE with `evidence/M1/snapshot-after.txt`. | M1 (close-out) | No | M2's snapshot records the table and chain list and `/proc/sys/net/*/forwarding`, not only a hash. | Fixed in `f0a95ba` (V14, V25) |
| R9 | NuQ's pg_cron deletes completed scrape rows after 1 hour and failed ones after 6 hours (`deploy/nuq-postgres/nuq.sql:123–128`); spec §21.3 promises 7 days of completed results. | M3 | No | M3's receipts and archival must not depend on NuQ rows; its "result retrieval after core/Redis expiry" test covers the 1-hour horizon. | Deferred to M3 |
| R10 | The 15-test gateway contract suite has only ever run on the workstation's Node v26.8.2 (V05). On the pinned Node 22.23.3 only N07's earlier 8-test suite ran. | M1 (close-out) | No | Run the suite inside `node@sha256:a0ddbc73…` in M3's verification. | Fixed in `d517ea9` (V21) |
| R11 | The core's credentials are as wide as they go: the Redis `default` user has `+@all`, the RabbitMQ user carries the `administrator` tag, and the core connects as the PostgreSQL superuser. | M1 (close-out); Redis: M8 | No | Narrow each against a command set measured over M8's 24-hour soak (`INFO commandstats`, broker permissions, `pg_stat_statements`), then re-soak. | PostgreSQL and RabbitMQ fixed in `2b42ad0` and `0db5a8d` (V22); Redis deferred to M8, which first measures its command set |
| R12 | Gating dockerd on the data check is correct only while Docker serves nothing but fcpi, and nothing checks that. | M8 (host lifecycle) | No | `fcpi status` and the startup unit report any container without `com.docker.compose.project=fcpi`; the coupling is revisited if one appears. | Deferred to M8 |
| R13 | The gated dockerd start ended `activating` with one recorded check failure, not `failed` after StartLimitBurst as the script expected; "dockerd stays down" is proven for the 60 s observed. The journal is capped at 32 MiB, and those entries have rotated out. | M1 (close-out) | No | M8's missing-mount test observes the unit through StartLimitBurst (3 in 1 min, RestartSec 2 s) and records `NRestarts` and `Result`. | Fixed in `2b70c65` (V19): 180 s without dockerd; systemd queued one restart that did not run, and never reached the start limit |
| R14 | NetworkManager offers the idle `netplan-eth0` profile (no interface name, no match) to every Docker veth: 27 activations and 25 aborted DHCP transactions in the window. wlan0 logged no state change, so the LAN link was not disturbed. | M1 (close-out) | No | A NetworkManager `unmanaged-devices` drop-in for `veth*` and `fcpi-*`, verified by NM device state before and after. | Fixed in `2b42ad0` (V23) |
| R15 | `deploy/nuq-postgres/nuq.sql`'s ALTER SYSTEM leaves server-class write tuning on the microSD (`bgwriter_delay` 50 ms, `bgwriter_lru_maxpages` 1000, `wal_writer_delay` 10 ms, `wal_buffers` 64 MB, `effective_io_concurrency` 200), plus 16 nightly REINDEX CONCURRENTLY jobs. Only the WAL sizes are overridden. | M8 (resource tuning) | No | Measure card writes in the soak and override by `-c` where they matter. | Deferred to M8 |
| R16 | `scripts/m1/deploy.sh` never deletes on the Pi, so deploying an older commit leaves later-added files in place, including in the bind-mounted `services/access` and `tests/fixtures/m1`. | M1 (close-out) | No | Deploy removes files under `/opt/firecrawl-pi` that are absent from the archive's manifest. | Fixed in `ef53c86` (V24) |
| R17 | `scripts/m1/core-egress-probe.mjs` hardcodes the Pi's LAN address twice, although `scripts/m1/pi-target.conf` is its single definition. | M1 | No | The probe reads the address from the environment; the collector passes it from `scripts/m1/pi-target.conf`. | Fixed in `9c3cc48` |
| R18 | V14 attributes any value of the snapshot's `nft_ruleset_sha256` line to the project without inspecting it. Its cited backing, `raw/nft-ruleset.txt`, has no header, timestamp or collector, and does not hash to the AFTER value. | M1 (verifier) | No: the ruleset file holds only Docker's tables and `fcpi_audit`, and before M1 nf_tables was not loaded | V14 attributes the firewall line only if `raw/nft-ruleset.txt` lists exactly Docker's and the project's tables. | Fixed in `c09f44e` |
| R19 | V13 requires `volume_or_data_deletion_commands_run=0`, a literal that `scripts/m1/pi-persistence.sh:45` prints unconditionally, so that clause cannot fail. The sentinel readback carries the proof. | M1 (verifier) | No | Drop the literal from the collector and the check. | Fixed in `77fb535` |
| R20 | `evidence/M1/INTERPRETATION.md` says the 09:02Z–09:14Z window ran against `e6dbfa1`. `raw/stack.txt`, `raw/nuq-roundtrip.txt`, `raw/docker-gate.txt` and `raw/pi-init-rerun.txt` record `bf8dd96`. | none | No | None: `git diff bf8dd96 e6dbfa1 -- deploy services tests/fixtures` is empty, so the deployed runtime was identical. Recorded here. | No action |
| R21 | `evidence/M1/INTERPRETATION.md` §8 item 9 lists the LAN address only in `scripts/m1/pi-target.conf` and M0 evidence. M1 also put it in `raw/lan-probe.txt`, `raw/stack.txt`, `raw/stack-final.txt` and `scripts/m1/core-egress-probe.mjs` (R17). | none | No | None before a first push; the pre-push full-history scan takes this file list. | No action |

The owner rule is the one this review's brief set. M1 was accepted before `CLAUDE.md` §5 limited deferral to findings outside a milestone's canonical Scope. Under that newer rule, R11, R13 and R16 touch M1's Implementation Work (safe credentials, fail-closed mount checks, rollback). They were deferred because each needs something M1 cannot supply: a full-workload command set, a disruptive dockerd stop, or a rollback rehearsal. M8's Scope names all three.

**Close-out.** The M1 close-out (`evidence/M1/closeout/CLOSEOUT.md`) closed R5, R8, R10, R13, R14 and R16, and closed the PostgreSQL and RabbitMQ parts of R11. It re-verified M1 on the changed stack: 24 checks rerun, all PASS (`evidence/M1/closeout/verification.json`). Every finding still open depends on something a later milestone first supplies: R1–R4, R6 and R7 (M2), R9 (M3), and R11's Redis part, R12 and R15 (M8).

## The nine questions

### Q1 — Egress by measurement

**Decision.** Counters plus internal networks are enough for M1. A forward drop on `fcpi_access` belongs to M2's egress policy (R5).

**Evidence.**
- The core is blocked by enforcement, not measurement. `fcpi_api`, `fcpi_core` and `fcpi_fixture` are `internal` with `gateway_mode_ipv4=isolated` (`raw/stack-final.txt#networks`: no host address on any of them). Docker installs `DOCKER-INTERNAL` drops for each subnet (`raw/nft-ruleset.txt` lines 60–66). Inside, the probes get ENETUNREACH and EAI_AGAIN (`raw/stack-final.txt#egress_probes`).
- Milestones line 143 ("permit only test-target outbound traffic") governs acquisition, and the core is the only acquiring component.
- The one non-internal bridge holds only the gateway. Its code opens one connection kind, to `PI_CORE_URL` (`services/access/server.mjs:106–118`). Its forwarded traffic was 0 packets over 09:02:54–09:14:33 (`raw/egress-audit.txt` lines 6–8).
- Gap: `audit_in` counts input from the internal bridges only (`raw/nft-ruleset.txt` lines 168–172). The gateway can reach host listeners through the bridge address, and nothing counts that.

**Rejected alternative.** Add the drop rule in M1 now. It would reopen an accepted milestone for traffic measured at zero from trusted project code. M2 must also write host egress enforcement for the retrieval and browser paths (spec §20.1, line 636), and that rewrites the same chains.

**Owner.** M2 (R5).

### Q2 — The dockerd coupling

**Decision.** It stands. Its precondition is that Docker serves only fcpi. That holds today and is unguarded; M8 adds the guard (R12).

**Evidence.**
- `restart: unless-stopped` (spec §24.1, line 766) revives containers at dockerd start, ahead of `deploy/host/fcpi-stack.service`. So the check has to gate dockerd itself (`deploy/host/docker.service.d/10-fcpi-data-check.conf`).
- With a failing check: 0 dockerd processes, 0 project writers, manifest unchanged. On restore, all 6 containers were revived healthy (`raw/docker-gate.txt`).
- Probe 22:25Z: `docker ps -a` lists 6 containers, all labelled `fcpi`. M0 found no container runtime before M1 (`evidence/M0/INTERPRETATION.md`).
- The check runs as root and sources `/etc/firecrawl-pi/config.env`. A malformed config or Compose file therefore keeps Docker down for everything. That is the intended fail-closed direction, and harmless while fcpi is Docker's only tenant.
- `docker.service` has `TimeoutStartSec=infinity`, so a hang in the check also keeps dockerd down.
- End-state caveat: see R13.

**Rejected alternative.** Drop `restart: unless-stopped` so the unit alone starts containers. Spec §24.1 requires the restart policy, and a supervisor would have to replace it.

**Owner.** M8 (R12, R13).

### Q3 — `ALLOW_LOCAL_WEBHOOKS=true`

**Decision.** The containment holds as recorded, and M2 is the right owner of the removal, with one ordering condition (R4).

**Evidence.**
- At the pin, the flag is one global switch. `safeFetch.ts:52–58` destroys a connected socket whose remote address is private unless `config.ALLOW_LOCAL_WEBHOOKS === true`. The check runs at connect time, so it is rebinding-safe. `webhook/delivery.ts:123` applies the same flag to webhook destinations (`sources/upstream-7666c1f-nuq-and-fetch-excerpts.txt`).
- With the flag set, a fetch may reach every private address the core can route to: its own loopback API with `/admin/*` (`deploy/compose.yaml:174`, `HOST: 0.0.0.0`), PostgreSQL, Redis, RabbitMQ and its Prometheus port.
- Webhook delivery is off: `delivery.ts:107` returns false from `shouldSendEvent` when `DISABLE_WEBHOOK_DELIVERY` is set, and `deploy/compose.yaml:188` sets it.
- The gateway admits a body only when its `url` origin is exactly `http://m1.fixture.fcpi.test:8080` with no userinfo (`services/access/server.mjs:86–90`). The contract test refuses `nuq-postgres:5432`, `10.231.1.5:6379`, Cloud and userinfo URLs (`tests/contracts/m1-gateway.test.mjs:126–134`).
- The fixture serves only `.html` files, only GET and HEAD, and has no redirect route (`tests/fixtures/m1/server.mjs:17–21`). The upstream agent follows up to 5,000 redirects (`safeFetch.ts:42`), so a redirecting fixture would break the containment.
- V18 checks the configuration; V05 checks the behaviour.

**Ordering condition.** Spec §20.2 (line 644) forbids "caller-selected global `allowLocal` settings". The flag must therefore be gone, or the fetch engine must be behind the retrieval adapter, no later than the deploy that lets the gateway admit a non-fixture origin.

**Rejected alternative.** Remove the flag in M1 and serve the fixture on a public-looking address. That fakes the SSRF boundary rather than owning it, and spec §20.2 already names the isolated fixture network as a deployment-controlled exception.

**Owner.** M2 (R4). Spec line 920 is updated by M2 when it removes the flag.

### Q4 — Recovery by restart (PC-NUQ-CONNECT)

**Decision.** Acceptable until M2 patches `nuq.ts`, given M1's single-user, fixture-only traffic. M2 owns the patch and two tests the evidence lacks (R1, R2).

**Evidence of the mechanism.** Confirmed in source (`sources/upstream-7666c1f-nuq-and-fetch-excerpts.txt`):
- `startSender()` is `try { … amqp.connect … } finally` with no catch (`nuq.ts:326–380`).
- `getJobToProcess()` awaits it inside another try/finally (1290–1331).
- The rejection escapes the `while` loops at `queue-worker.ts:329` and `nuq-worker-runner.ts:120`.
- The deployed stack logged `Error: connect ECONNREFUSED …:5672` then `A service has terminated unexpectedly` (`raw/nuq-roundtrip.txt#case3_core_log_since_restart`).
- The container restarted once. The broker answered after 13 s and the core was ready after 23 s (`#case3_restart`).
- The code already falls back to PostgreSQL when the sender is absent (`nuq.ts:1314–1319`), so a catch is the whole fix.
- No upstream issue names `startSender`. #2583 (a RabbitMQ timing ECONNREFUSED at startup) was closed in 2025-12, yet the pin still lacks the catch (`sources/upstream-issues-at-review.txt`).

**What a job in flight at harness exit goes through.** Case 3 submitted its job after the restart, so this path was not observed. From the evidence:
1. Every child dies with the harness, including the API process holding the client's synchronous request. The gateway answers 502, or cuts a response already started (`services/access/server.mjs:100–105`).
2. The job row stays `active` with its lock in PostgreSQL.
3. The lock reaper runs every 15 s and requeues any `active` job locked more than 1 minute ago, adding one stall (`deploy/nuq-postgres/nuq.sql:131–133`). V09 saw that path on a prefetched job: active at t+1, `stalls=1` by t+68, re-prefetched at t+73, completed after the worker resumed (`raw/nuq-roundtrip.txt#case2_timeline`).
4. The job then runs again from the start, which makes delivery at-least-once. Its result has no waiter. After 9 stalls the reaper marks it failed (`deploy/nuq-postgres/nuq.sql:134`).

**Why #4244 is still open for M2 (R1).** The listener is stored at `nuq.ts:146`, before `consume()` at 182. If `consume()` throws, `startListener()` returns early for good, because `this.listener` is non-null (123–124). Recovery by restart never exercised this: the API process died with the harness each time. Once PC-NUQ-CONNECT lets processes survive a broker restart, the path is live. #4244 and PR #4263 are both open.

**Rejected alternative.** Patch in M1. The patch series, its hashes and the symbol manifest begin in M2 (milestones line 195), and patching the acquired image would break D6's provenance rule.

**Owner.** M2.

### Q5 — The Redis `default` user's `+@all`

**Decision.** M8 narrows it, together with the RabbitMQ `administrator` tag and the core's PostgreSQL superuser login (R11). The measured command set comes from `INFO commandstats` sampled at the end of M8's 24-hour soak (milestones line 477 and 487). That soak is the first workload that exercises crawl, search, extract and documents.

**Evidence.**
- `scripts/m1/pi-init.sh:97` generates `user default on #… ~* &* +@all` and a `health` user limited to PING.
- `raw/stack-final.txt#rabbitmq_health` shows `users=fcpi[administrator]`. `deploy/compose.yaml:180` sets `POSTGRES_USER: postgres`, and `deploy/secrets.template:9` makes the core's password the superuser's.
- Redis 8's defaults already refuse the worst `+@all` paths: `enable-protected-configs`, `enable-debug-command` and `enable-module-command` all default to `no`. `deploy/redis/redis.conf` does not re-enable them. What remains open is FLUSHALL/FLUSHDB, durability CONFIG SET (for example `appendonly`), SHUTDOWN and KEYS.
- Only the core holds the password, on internal networks.

**Rejected alternative.** Narrow in M3 from source reading. The upstream command set spans Lua scripts and the crawl, extract and search paths that M3 does not yet exercise. A guessed allowlist fails in production, where a measured one does not.

**Owner.** M8.

### Q6 — Core memory

**Decision.** Yes. M2 measures the core on its own fixture corpus before Chromium arrives, and rebalances within §22 if needed (R6).

**Evidence.** `raw/stack-final.txt#cgroups`:
- The core's `memory.current` is 1,686 MiB (anon 1,549) at rest, with `memory.peak` 1,839 MiB of 2,304 after one static scrape.
- Seven Node processes each hold roughly 350 MiB RSS under a 256 MiB old-space ceiling (`#core_processes`).
- Spec §22 (line 721) estimates 700 MiB idle and 1,400 MiB normal.
- All six containers use 1,930 MiB; MemTotal is 8,062 MiB and MemAvailable 5,356 MiB.
- With M2's caps (5,984 MiB including the 64 MiB fixture) all at their limits, MemAvailable would be about 5,356 − (5,984 − 1,930) = 1,302 MiB. That is 278 MiB above the 1 GiB reserve (spec line 734), before SearXNG (320) and the MCP gateway (192) arrive.
- No `memory.events` (`oom_kill`) value was recorded.

**Rejected alternative.** Raise the core's cap now. §22 says a role-specific raise needs a tested rebalanced budget (line 738), and M2's Implementation Work says "adjust only within an explicitly rebalanced host budget" (milestones line 191). The idle children (extract-worker, reconciler) may justify lower role heaps instead.

**Owner.** M2. The measured-budget update to spec §22 remains an M8 artifact (milestones line 483).

### Q7 — API image provenance

**Decision.** Acceptable until M2's project build replaces the image, as D6 already obliges. No new finding.

**Evidence.**
- Re-resolved at 22:14Z: index `sha256:1b223ef1…`, arm64 `sha256:6157ce24…`, unchanged.
- The GitHub attestation API returns 404 for both digests (`sources/ghcr-firecrawl-2.11.162-at-review.txt`).
- The running core is that digest (`raw/stack-final.txt#containers`), and its `FIRECRAWL_BUILD_SHA` equals the pin (N02).
- M1 carries fixture traffic only (Q1, Q3).

**Rejected alternative.** Rebuild from source before M2. Reproducibility needs the Dockerfile fixes that start M2's patch series (`evidence/M0/review/DECISIONS.md`, D6).

**Owner.** M2, under D6's existing obligation. If M2's build slips, the unpatched image keeps the fixture-only profile (milestones line 211).

### Q8 — Licensing

**Decision.** No obligation is triggered now. The files keep their notices.

**Evidence.**
- `deploy/nuq-postgres/nuq.sql` is upstream's file byte for byte: SHA-256 `44edb370…`, equal to the pin's (`sources/upstream-7666c1f-nuq-and-fetch-excerpts.txt`).
- `deploy/nuq-postgres/Dockerfile` is a modified copy of upstream's AGPL-3.0 file (`00108183…` at the pin). Its header names the source, the license and both edits.
- AGPL-3.0's duties attach to conveying (§§4–6) and to letting other users interact with a modified version over a network (§13). A private deployment used only by its owner does neither.

**What would change it.**
- **A public push of the repository.** This conveys `deploy/nuq-postgres/nuq.sql`, the modified Dockerfile and M2's patches. It then needs the AGPL-3.0 text in the repository (none exists; there is no `LICENSE` file), the modification notices kept, and the patches offered under AGPL-3.0.
- **Pushing a built image to a registry.** This conveys object code, with the Corresponding Source duty.
- **Anyone else using the patched API over the network.** This includes sharing the gateway, and triggers §13's source offer.

**Owner.** None now. The trigger belongs to the pre-push publishing decision, alongside Q9.

### Q9 — Publishing

**Decision.** Not confirmed as stated. M1 added the LAN address beyond the recorded list (R21), and hardcoded it in code (R17, fixed).

**Evidence.**
- `git grep -c` on the address finds it in `raw/lan-probe.txt` (1), `raw/stack.txt` (2), `raw/stack-final.txt` (2) and `scripts/m1/core-egress-probe.mjs` (2), besides `scripts/m1/pi-target.conf` and M0's files. The values are not repeated here.
- The SSH host name appears in M1 only in `scripts/m1/pi-target.conf`.
- Other identifier classes found and classified:
  - the data filesystem's UUID in `deploy/config.env.example`, `scripts/m1/pi-init.sh` and the mount-branch transcripts: functional configuration, already in M0's evidence;
  - the name-derived UUID of NetworkManager's `netplan-eth0` profile, and one journal line with the host's short name, in `raw/egress-audit.txt`: not personal;
  - container IDs, veth names, sentinel and scrape UUIDs: not identifying.
- V15 recorded 0 secret findings across 209 files.

**Owner.** None: the pre-push full-history scan takes R21's list.

## The eight deviations

| # | Deviation | Judgement |
|---|---|---|
| 1 | `git archive` instead of rsync | Justified. `scripts/m1/deploy.sh:23–36` refuses tracked changes outside `evidence/`, sends one archive and verifies every hash on the Pi. It never deletes, which makes rollback by redeploy incomplete (R16, M8). |
| 2 | Dedicated uids for the data services | Justified. The images' uid 999 is the Pi-hole account (`raw/uid-migration.txt`). V02 checks every process's uid. |
| 3 | Extra internal network `fcpi_api` | Justified. It is tighter than spec §7.3's logical grouping, which "show[s] logical flows, not permission to bridge" (spec line 254), so no canonical edit is needed. M3 will need a gateway path to the platform database (spec §20.1). |
| 4 | dockerd gated on the data check | Justified by the restart-policy path. See Q2, R12 and R13. |
| 5 | `ALLOW_LOCAL_WEBHOOKS=true` | Justified and recorded in spec §29 (line 920). See Q3 and R4. |
| 6 | RabbitMQ TCP healthcheck | Justified. D3 allowed a TCP check. Measured 3.0 MiB against 76.5 MiB for `rabbitmq-diagnostics ping` (`raw/native-proofs.txt` lines 50–51), with a 120 s start period. The Compose comment's "~5 MiB" is loose, not wrong. |
| 7 | `SCRAPE_MAX_ATTEMPTS=1` | Not a deviation from the canonical design: spec §29 requires it (line 895). See R3 for the retry path it does not cover. |
| 8 | Egress by counters, not a drop rule | Justified for M1. See Q1 and R5. |

## The 28 checks

Code lines refer to `scripts/m1/verify.mjs` at `7cb748b`. "Re-run" means re-executed from the scratchpad copy with an identical state, input hash and `actual` string.

| test_id | Code | Raw input | Input that would turn it FAIL | Verdict |
|---|---|---|---|---|
| M1-N00 | 240–250 | `evidence/M1/snapshot-before.txt`, `evidence/M0/snapshot-after.txt` | Any non-session line differs; a boot-ID line is missing or differs | Holds (re-run) |
| M1-N01 | 252–264 | `raw/runtime-install.txt`, `raw/runtime-plan.txt` | Another key fingerprint; one of the five packages not held at its version; engine not linux/arm64; the simulation adds anything beyond iptables, libip4tc2 and libip6tc2 | Holds (re-run) |
| M1-N02 | 266–275 | `raw/native-proofs.txt#containers_platform`, `raw/image-inspect.txt` | A proof container absent, or on another digest, platform or uname, or with restarts; a build-SHA line differs from the pin | Holds (re-run) |
| M1-N03 | 277–284 | `raw/native-proofs.txt#postgres` | Not 17.11 on aarch64; launcher ≠ 1; jobs ≠ 36; any failed run | Holds (re-run) |
| M1-N04 | 286–293 | `raw/native-proofs.txt#redis` | No PONG; allocator not jemalloc; `arch_bits` ≠ 64; version ≠ 8.10.2 | Holds (re-run) |
| M1-N05 | 295–303 | `raw/native-proofs.txt#rabbitmq` | Ping, version, `jit`, stage-3 checks, watermark 268435456, or two probe lines missing. `raw/native-proofs-up-attempt1.txt` is hashed, not read. | Holds (re-run) |
| M1-N06 | 305–321 | `raw/native-proofs.txt` (six sections), `tests/fixtures/m1/expected/static.md` | A child count ≠ 1; any health ≠ 200; Rust module unmapped; Go library mapped; flag set; Markdown differs; ELF alignment < 0x4000 | Holds (re-run) |
| M1-N07 | 323–334 | `raw/native-proofs.txt#gateway` | Node ≠ v22.23.3; any `not ok`; inconsistent TAP counts; authenticated ≠ 200 or wrong Markdown; unauthenticated not the gateway's 401. Its expected text says 8/8, but the code accepts any consistent count (see R10). | Holds (re-run) |
| M1-N08 | 336–348 | `raw/nuq-roundtrip-proof.txt` | Case 1 fails; reply queue not classic, auto-delete and exclusive; no `basic.get`; no expiry event, `stalls=1` or dead-lettered expiry; case 2 fails | Holds (re-run) |
| M1-N09 | 350–358 | `raw/nuq-roundtrip-proof.txt#case3_scrape` | Passes only with `"success":true`; FAIL recorded (container not running) | FAIL holds; classification confirmed in source (Q4) |
| M1-V01 | 361–386 | `raw/stack-final.txt` (containers, process ELF, binfmt), `evidence/M0/raw/pi-audit.txt`, lock | Digest or platform mismatch; privileged; writable rootfs; socket mount; host network; extra capabilities; no no-new-privileges; any e_machine ≠ 183; a binfmt handler beyond M0's or an emulator | Holds (re-run) |
| M1-V02 | 388–404 | `raw/stack.txt`, `raw/stack-final.txt` | Core total ≠ 13; any child or wrapper ≠ 1; another process; a user ≠ 3002; any service uid differs | Holds (re-run) |
| M1-V03 | 406–424 | `raw/stack-final.txt#cgroups`, `#host_memory` | `memory.max`, swap or `cpu.max` differs; MemAvailable < 1,024 MiB. It does not read `memory.events` (R6). | Holds (re-run) |
| M1-V04 | 426–447 | `raw/stack-final.txt`, `raw/lan-probe.txt`, `raw/nft-ruleset.txt`, snapshot-before | A second publication or new listener; any LAN port open; control 22 closed; fewer than 14 ports; loopback drop rule absent; membership, internal flag or mode differs; a host address on an internal bridge | Holds (re-run) |
| M1-V05 | 449–462 | `raw/stack.txt#gateway_tests`, local `node --test` | Any status differs; a non-gateway challenge; `firecrawl.dev` in a challenge; a local test fails or the count ≠ declared. The "internal target" row uses `nuq-postgres.fcpi.test`, a name that exists nowhere; the contract test covers real names. | Holds (re-run; 15/15 at close-out) |
| M1-V06 | 464–485 | `raw/stack.txt`, `raw/stack-final.txt`, `raw/native-proofs.txt`, expected file history in Git | Markdown differs in any of four cases; the expected file changed since it was added, or was committed after the first scrape | Holds (re-run) |
| M1-V07 | 487–509 | `raw/stack-final.txt` (health sections) | Any unhealthy container; endpoint ≠ 200; a setting not from the command line; a cron failure; Redis health user wider than PING; AOF off; not noeviction; broker alarm, node, watermark, user, cookie mode, management plugin or uid differs | Holds (re-run) |
| M1-V08 | 511–513, 79–93 | `raw/nuq-roundtrip.txt` case 1 | Queue types or flags differ; counter deltas 0; log lines missing. `markdown_matches` is a non-null test, outside `pass`. | Holds (re-run) |
| M1-V09 | 515–517, 94–122 | `raw/nuq-roundtrip.txt` case 2 | No SIGSTOP; expiry window outside its bounds; job not active until gone; no stall; SIGCONT before the vanish; no dead-lettered expiry; scrape fails | Holds (re-run; window 50–54 s) |
| M1-V10 | 519–524, 123–139 | `raw/nuq-roundtrip.txt` case 3 | New job fails; no reply-queue receipt or `Job done`; listen queue absent or ≠ 1 consumer. It bounds neither recovery time nor restarts, and can report #4244 only if the new job fails (R1). | Holds as recorded; the #4244 conclusion does not (R1) |
| M1-V11 | 526–569 | `raw/egress-audit.txt`, `raw/egress-audit-start.txt`, `raw/stack.txt`, `raw/stack-final.txt` | Positive control 0; any must-be-zero counter > 0; a host-delivered flow other than the DHCP broadcast; IPv6 beyond link scope; missing structure or probe rows; a name resolves or a connect is not ENETUNREACH; host control fails; any pattern count > 0 | Holds for what it reads; log coverage R7; no `fcpi-access` input counter R5 |
| M1-V12 | 571–595 | `raw/mount-branches.txt` | Positive control fails; any branch starts the stack, gives the wrong reason, leaves containers, changes the manifest or creates a path; Compose probe not refused; restart not 6 healthy | Holds (re-run) |
| M1-V17 | 597–610 | `raw/docker-gate.txt`, the drop-in | Deployed drop-in hash ≠ repository; not 6 running before; gated start exits 0, leaves dockerd running or writers, shows no check failure, or changes the manifest; restore not 6 healthy | Holds for the 60 s observed (R13) |
| M1-V18 | 612–626 | `evidence/M1/rendered-compose.json`, spec | With the flag true: delivery not disabled, a core network not internal, an origin not a fixture alias, or the spec sentence absent. It passes when the flag is unset, by design. | Holds; containment confirmed in source (Q3) |
| M1-V13 | 628–645 | `raw/persistence.txt` | Sentinel format; a write missing; publish unconfirmed; a container not replaced; recreate ≠ 0; any readback differs; RabbitMQ not exactly the sentinel; node name or ownership changed. The deletion clause could not fail (R19). | Holds (re-run); R19 fixed |
| M1-V14 | 647–677 | snapshots, `raw/stack-final.txt` | An unattributed added line; a removed line other than runtime, SSH or firewall; boot ID missing or changed. The firewall line was attributed whatever its value (R18). | Holds (re-run); R18 fixed |
| M1-V15 | 679–708 | the two controls, live Pi hashes | M0 rule names drift; a rule silent on its control; fewer than 5 distinct or an empty live hash; any hit | Recorded PASS (209 files, 0 findings). Rule firing re-run here (close-out); the live hash comparison was NOT_RUN in this review. |
| M1-V16 | 710–728 | lock, `deploy/compose.yaml`, rendered Compose | A rendered reference or platform differs from the lock; the Compose text lacks it; a provenance, build-SHA, pg_cron, NuQ-digest, runtime or RabbitMQ field differs. It is repository-internal; V01 ties it to the host. | Holds (re-run) |

## Conformance to the M1 deltas

| Delta (`evidence/M0/review/DECISIONS.md`, "M1 deltas") | Evidence | Holds? |
|---|---|---|
| 1. Native proofs first | Runtime install 06:51Z, NuQ build 06:58Z, proofs 07:08Z–07:21Z on a throwaway `fcpi-proof` stack; `pi-init` (secrets, data directories) 07:27Z; Compose stack 07:34Z (raw file headers) | Yes |
| 2. What "start" means for the API | N06: harness plus six children, all health 200, exact Markdown; `USE_GO_MARKDOWN_PARSER` unset and the Go library mapped by none | Yes |
| 3. Project NuQ Dockerfile with two edits, built on the Pi | `deploy/nuq-postgres/Dockerfile:13,19`; upstream Dockerfile `00108183…` at the pin (retrieved); `raw/nuq-build.txt` | Yes |
| 4. Plain `rabbitmq:4.3.6` by digest; light healthcheck; ports unpublished | `deploy/compose.yaml:118,153–161`; `evidence/M1/sources/rabbitmq-releases-at-m1.txt` (no 4.4); N05 probe costs; V04 LAN probe includes 4369, 25672, 15692 and 5672; plugins are `management_agent`, `prometheus` and `web_dispatch`, with no management UI | Yes |
| 5. Three round-trip cases, #4244 recorded | Cases 1–2 PASS, case 3 PASS by restart and FAIL on the proof stack; the 3.13.7 fallback correctly not taken (client-side defect) | Yes as recorded, but its #4244 conclusion is R1 |
| 6. Digest correction recorded | `deploy/versions.lock.json` holds `3-management` `8689ddfc…` and `3.13.7` `47c38812…` | Yes |
| 7. Redis only from the official image | `redis@sha256:41a10b18…` (8.10.2-alpine) in Compose, lock and V01 | Yes |
| 8. Provenance in the lock | `build_provenance`: run 30579949775, `provenance: false`, attestation none; NuQ base digest, pg_cron 1.6.8-1.pgdg13+2, built digest | Yes |
| 9. Contingency (source build on a page-size failure) | Not triggered: every ELF LOAD alignment 0x10000 (`raw/native-proofs.txt` lines 79–81), no page-size signature | Yes |

## Canonical edits made

None. No decision in this review changes what the spec or the milestones assert:

- R4's removal updates spec line 920 in M2.
- R6's measured budget updates spec §22 in M8.

The register row for M1 and line 603 were left to the owner's parallel session, by decision. The handover lists the wording this review would have written.

## For M2

Each item stands on its own; the evidence is carried as fact.

1. **R2 — PC-NUQ-CONNECT.**
   - *Fact:* at `7666c1f`, `apps/api/src/services/worker/nuq.ts` `startSender()` (326–380) and `getJobToProcess()` (1290–1331) use try/finally with no catch. A broker outage's ECONNREFUSED escapes the polling `while` loops at `queue-worker.ts:329` and `nuq-worker-runner.ts:120`, and the harness exits. The PostgreSQL fallback already exists at `nuq.ts:1314–1319`.
   - *Patch:* catch in `startSender()`, log, and leave `this.sender` null.
   - *Acceptance:* on a stack without restart policies, stop the broker for at least 30 s. A job submitted during the outage completes through the PostgreSQL fallback, the core's `RestartCount` stays 0, and a job submitted after recovery completes through the reply queue.
   - *In-flight test:* kill the worker mid-job. The job goes `active` → requeued by the lock reaper within 75 s (`stalls=1`) → completed. Record what the synchronous client received.
2. **R1 — #4244.**
   - *Fact:* the listener is assigned at `nuq.ts:146` before `consume()` at 182. The reconnect is scheduled once, 250 ms after close (163–175). #4244 and PR #4263 are open (`sources/upstream-issues-at-review.txt`).
   - *Acceptance:* after R2's patch, restart the broker with the API process surviving. The `nuq.queue_scrape.listen.*` queue shows one consumer within 60 s, and a new synchronous scrape returns.
   - *If not:* add #4263 or an equivalent to the patch series.
3. **R3 — NuQ stalls.**
   - *Fact:* the reaper requeues a job up to 9 times, each re-running the acquisition (`deploy/nuq-postgres/nuq.sql:131–135`).
   - *Acceptance:* a fixture that stalls a job twice produces at most four acquisition attempts in total for its logical ID, as counted by the adapter.
4. **R4 — `ALLOW_LOCAL_WEBHOOKS`.**
   - *Fact:* the flag disables `safeFetch.ts:52–58` for every fetch, and the agent follows up to 5,000 redirects (`safeFetch.ts:42`).
   - *Acceptance:*
     - the rendered core environment lacks the flag in the same commit that widens `PI_PERMITTED_TARGET_ORIGINS`, or in an earlier one;
     - V18's successor asserts the flag is unset;
     - the fixture is reached only through the retrieval service's allowlist;
     - spec line 920 is rewritten.
5. **R5 — the access bridge.** Closed in the M1 close-out; M2 keeps it closed.
   - *Fact:* `inet fcpi_guard` (`deploy/host/fcpi-guard.nft`), loaded before every dockerd start, drops and counts forwarding in and out of `fcpi-access` and new connections from it to the host (V20).
   - *For M2:* add the retrieval and browser egress rules beside it, and keep V20's probe passing.
6. **R6 — core memory.**
   - *Fact:* at rest the core used 1,686 MiB, with a peak of 1,839 of 2,304 on one static page. All caps at their limits leave about 1,302 MiB available.
   - *Acceptance:* before Chromium, record the core's peak on M2's corpus. If it exceeds 85% of its cap, rebalance within §22's 6,432 MiB. With Chromium's stress fixture, every cgroup's `memory.events oom_kill` stays 0 and host MemAvailable stays at 1 GiB or more.
7. **R7 — Cloud-attempt evidence.**
   - *Fact:* the scans covered the core instance alive at 09:02:55 (88 lines) and the one alive at 09:14:31 (137 lines). The first instance's logs from 09:02:55 until its removal at 09:11:45 were never scanned.
   - *Acceptance:* every core container instance in M2's window has its full `docker logs` captured before recreation and scanned, with a per-instance positive control.
8. **R8 — snapshots.** Closed in the M1 close-out.
   - *Fact:* `scripts/m1/snapshot.sh` records the nftables table and chain list and the forwarding switches beside M0's snapshot. After the close-out the ruleset holds Docker's `ip`/`ip6` `nat` and `filter` tables, `ip raw`, the project's `fcpi_audit` tables and its `fcpi_guard` table. IPv4 forwarding is 1.
   - *For M2:* take BEFORE and AFTER with `scripts/m1/snapshot.sh`, compare BEFORE with `evidence/M1/closeout/snapshot-after.txt`, and attribute each change in the diff.
9. **Q7 (D6).** Replace the acquired API image with the patched build. The registry and attestation facts are in `sources/ghcr-firecrawl-2.11.162-at-review.txt`.

## `/address` outcomes (R17–R19)

Fixed after the report commit `9bd0b3e`, one commit each. None of them changes what M1 runs on the Pi.

| Finding | Commit | Change | Verification |
|---|---|---|---|
| R17 | `9c3cc48` | `scripts/m1/core-egress-probe.mjs` reads `PI_LAN_ADDRESS` and throws without it; `scripts/m1/pi-collect-stack.sh` extracts it from the deployed `scripts/m1/pi-target.conf` and passes it to `docker exec` | Live, piped from the workstation into the running core and fixture containers: 4 targets each, every lookup fails, every connect gets ENETUNREACH. Without the variable, the probe refuses to run. After the fix, `git grep` finds the address in no script except `scripts/m1/pi-target.conf`. |
| R18 | `c09f44e` | V14 attributes the firewall line only when `raw/nft-ruleset.txt` lists exactly `bridge fcpi_audit`, `inet fcpi_audit`, `ip filter`, `ip nat`, `ip raw`, `ip6 filter` and `ip6 nat`; the file is a declared input | Scratchpad copy: PASS on the recorded evidence; FAIL with one extra table appended |
| R19 | `77fb535` | The literal is gone from `scripts/m1/pi-persistence.sh`, and V13 no longer requires it | Scratchpad copy: PASS on the recorded transcript and on one without the literal; FAIL with the Redis sentinel readback emptied |

Regression: all 27 checks that need no Pi were rerun with the fixed verifier. Each matches `evidence/M1/verification.json` in state and `actual`. The only input hash that differs is V14's, because of its new input. `evidence/M1/snapshot-diff.txt` regenerates identically.

`evidence/M1/verification.json` was not rewritten; it remains the accepted record. The Pi's deployed copy under `/opt/firecrawl-pi` still holds the pre-fix collectors until the next `scripts/m1/deploy.sh`, which M2 runs.

## Checks at close-out

| Check | State | Result |
|---|---|---|
| The 28 results traced to code and raw input, each with the input that would fail it | PASS | 28/28 traced; 27/27 re-executed byte-identical (state, input hash, `actual`); `evidence/M1/snapshot-diff.txt` identical |
| The nine questions decided, each with an owner | PASS | 9/9 |
| The eight deviations judged | PASS | 8/8 |
| The nine M1 deltas checked | PASS | 9/9 |
| Gateway contract tests | PASS | 15/15 (`node --test tests/contracts/m1-gateway.test.mjs`, Node v26.8.2) |
| Every path cited in this file exists | PASS | 98/98 repository paths (`raw/` and `sources/` resolved as defined above; upstream file names, Pi-side paths, `docker.service` and `.html` are not repository paths) |
| `git status --short` lists nothing outside this review's ownership and nothing under `evidence/M1/` except `evidence/M1/review/` | PASS | Only `?? evidence/M1/review/` before the report commit, at HEAD `f2103c1` |
| Redaction: M0 and M1 rules fire on both controls, then find nothing in `evidence/M1/review/` | PASS | V15's rule block copied to the scratchpad; M0 rule names match `scripts/m0/verify.mjs`; 16/16 M0 and 5/5 M1 rules fire on their controls; 0 hits in the 4 review files; neither the LAN address nor the SSH host appears |
| V15's live-secret hash comparison, on `evidence/M1/review/` | PASS | 5 distinct, non-empty SHA-256s computed on the Pi (no value left it); 0 matches. The comparison over the whole repository was not rerun. |
| Canonical files unchanged by this review | PASS | `git diff HEAD` empty for `docs/`, `CLAUDE.md`, `AGENTS.md`, `ORCHESTRATION.html`; spec 1213 and milestones 603 lines; `CLAUDE.md` and `AGENTS.md` 1003 lines each after the owner's commits, `cmp` identical |
| `ORCHESTRATION.html` realigned | NOT_RUN | Left to the owner's parallel session, by decision |
