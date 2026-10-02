## Code Review: M8 — Operations, resource stability, recovery and restore (19f047f..HEAD)

### Summary
Reviewed 68 files (31 commits, about 4,100 changed lines outside evidence/) with 2 specialist agents: a debugger and a code auditor. Both ran on Opus 5.5, the review model. The orchestrator checked every critical finding against the source. The ops layer is careful in its core mechanics: atomic state writes, fail-open admission with a staleness bound, internal-only restore networks, and a token passed to curl by descriptor. However, 2 introduced critical findings break the secret-handling rules in CLAUDE.md §17 and §33.2, and 24 warnings cluster around coordination between backup, the tick and the restore test, rollback correctness, and verifier checks that cannot fail.

**Scope (so the reader knows what was and wasn't reviewed):**
- **Large-changeset guard triggered.** Tier 1 (full review): `scripts/ops/*`, `scripts/fcpi`, `deploy/host/*`, the `deploy/compose.yaml` diff, `deploy/redis/fcpi-core.rules`, `scripts/m8/pi-redis-narrow.sh`, the host admission in `services/access` and `services/retrieval` with their tests, and `scripts/m8/verify.mjs`. Tier 2 (skimmed for shape changes and obvious criticals): the rest of `scripts/m8/*`. Tier 3 (acknowledged only): `scripts/m8/collect-open.sh`, `scripts/m8/collect-close.sh`, `scripts/m8/fcpi-soak.service`, `tests/contracts/m8-redaction-control.txt`, `tests/fixtures/m8/ledger-v4-candidate.sql`. Confidence is high on Tier 1; Tier 2 may hold false negatives.
- **Reviewed:** new files in full; modified files as changed lines plus 20 lines of context plus the enclosing function.
- **Skipped:** `evidence/**`, used as input only.
- **Out of scope:** enterprise governance machinery, since this is personal infrastructure.
- **Not run:** test suite, linters and build. This is a read-only review.

### 🔴 Critical Issues (Must Fix)

**Introduced in this changeset:**
1. **C1 — Every production client token is placed on jq's command line during the restore test (CWE-214; CLAUDE.md §33.2)** - `scripts/ops/restore-test.sh:128`, `scripts/ops/restore-test.sh:156`  _(corroborated: both agents)_
   - Problem: line 128 runs `jq -cn … --arg t "$(cat "$f")"` once per token file. Line 156 passes the whole token map as `--argjson t "$tokens"`. The restored secrets snapshot is production's, so these are the live bearer tokens.
   - Risk: `fcpi-restore-test.timer`, a rehearsal or `fcpi restore-test` runs the script as root → one jq process per token, then one for the plan → while each runs, any local uid on this shared host can read `/proc/<pid>/cmdline` or `ps -eo args` (Debian mounts /proc without hidepid) → it reads `fcpi_<label>_<64hex>` for every client, including all-scope ones, and can act as that client against the gateway on 127.0.0.1:3380. Independently flagged by both reviewers, and the orchestrator confirmed it against lines 128 and 156.
   - Fix:
     ```bash
     # Before
     tokens=$(for f in "$TOK"/*.token; do [ -f "$f" ] && jq -cn --arg l "$(basename "$f" .token)" --arg t "$(cat "$f")" '{($l): $t}'; done | jq -sc 'add // {}')
     plan=$(jq -cn --argjson t "$tokens" --argjson r "$reqs" '{base:"http://access-gateway:3300",host:"127.0.0.1:3380",tokens:$t,requests:$r}')
     # After: --rawfile puts only the path in argv; the map travels on stdin
     tokens=$(for f in "$TOK"/*.token; do [ -f "$f" ] && jq -cn --arg l "$(basename "$f" .token)" --rawfile t "$f" '{($l): ($t | rtrimstr("\n"))}'; done | jq -sc 'add // {}')
     plan=$(printf '%s' "$tokens" | jq -c --argjson r "$reqs" '{base:"http://access-gateway:3300",host:"127.0.0.1:3380",tokens:.,requests:$r}')
     ```

2. **C2 — `fcpi doctor` fuses secret files that lack a trailing newline, so it never searches for those secrets** - `scripts/ops/doctor.sh:51`  _(only DB1 — CA1 was in scope but didn't flag; confirmed by the orchestrator)_
   - Problem: `xargs -0 -r cat` concatenates files back to back, and `tr -s '\n' '\n'` only squeezes newlines; it never adds one. Most secrets are written with `printf '%s'` and have no final newline (`scripts/m1/pi-init.sh:80-81,111`, `scripts/m1/pi-narrow-credentials.sh`, `scripts/m8/pi-redis-narrow.sh`, `scripts/m8/pi-backup-setup.sh`). Each such value is therefore fused with the next file's first line, and the pattern file holds `P1P2…` instead of `P1` and `P2`.
   - Risk: a container log line carries `core_postgres_password` → `doctor.sh` builds a pattern file in which that value appears only fused with its neighbour → `grep -rlF -f` finds no hit → the bundle is kept and `REDACTION.txt` states "files carrying one: 0". `--self-test` plants a `clients/*.token` value. It passes only if that token ends in a newline, or if the file cat happens to put right after it does; either way it does not test newline-less files. The "enforced, not trusted" redaction that §17 depends on is silently defeated for most secrets.
   - Fix:
     ```bash
     # Before
     find /etc/firecrawl-pi/secrets -type f -size -8k -print0 | xargs -0 -r cat | tr -s '\n' '\n' | awk 'length($0) >= 12' | sort -u >"$pat"
     # After: awk 1 terminates each file's last record
     find /etc/firecrawl-pi/secrets -type f -size -8k -print0 | xargs -0 -r awk 1 | awk 'length($0) >= 12' | sort -u >"$pat"
     ```
     Also give `--self-test` a second planted value, taken from a newline-less file such as `redis_ops_password`.

### 🟡 Warnings (Should Fix)

**Introduced in this changeset:**

*Backup, tick and restore coordination*
1. **W1 — The backup's resume step runs `compose up -d` on the whole project** - `scripts/ops/backup.sh:79-85`  _(corroborated: both agents)_
   - Problem: `stop $APP` is paired with `up -d --wait`. That recreates any container whose config or image drifted from the deployed `compose.yaml`: `deploy.sh` does not recreate services, so an uncut deploy goes live unreviewed at 03:30. It also starts services an operator stopped on purpose. `backup-meta` then records the new commit and images, while the dumped data came from the old ones.
   - Suggestion: before stopping, capture `ps --status running --services`. On resume, run `compose start` on exactly those services and poll their health. Keep `up -d` only as the fallback when that fails.
2. **W2 — The physical copy is taken without confirming the data services stopped** - `scripts/ops/backup.sh:101-104`  _(corroborated: both agents)_
   - Problem: the exit status of `compose stop redis rabbitmq nuq-postgres` is discarded. When the stop fails, `cp -a` copies a live PGDATA and PASS is recorded, and the restore test later runs on that torn copy.
   - Suggestion: require `docker inspect -f '{{.State.Running}}'` to be `false` for all three before copying; otherwise set `copy_ok=false`.
3. **W3 — The tick opens false incidents during the nightly backup** - `scripts/ops/tick.sh:126-165` vs `scripts/ops/backup.sh:87-106`  _(corroborated: both agents)_
   - Problem: `queue_unreadable` (hold 0 s), `core_unhealthy` (120 s) and `functional_probe_failing` are all judged while the backup has these services stopped on purpose. Once N01's channel is configured, this produces opened/cleared notices every night.
   - Suggestion: skip or defer those incidents while `$HOLDS/backup` exists. Assert the notice count across a backup in K01.
4. **W4 — Repository jobs are not mutually excluded, and a skipped restore test leaves no trace** - `scripts/fcpi:39-48`, `scripts/ops/restore-test.sh:29`, `scripts/ops/tick.sh:143`, `deploy/host/fcpi-*.timer`  _(corroborated: both agents)_
   - Problem: `backup-check` does not take `backup.lock`, so `restic check` can contend with `forget --prune` and raise a false FAIL. Restore-test uses `flock -n … || die`, which writes no `last-restore-test.json`. With `Persistent=true`, a first Sunday spent down makes all three timers fire at boot, and the month's restore proof is silently lost. Nothing opens an incident for a stale restore test. Secrets and data snapshots are paired by "first after, within an hour" (`restore-test.sh:69-71`), which breaks if an upload is slow.
   - Suggestion: take the lock in `backup-check`. Give timer-started runs a bounded `flock -w`, or record SKIPPED. Add `restore_test_stale` (older than 35 days). Tag both snapshots `--tag fcpi-run=$RUN` and pair them by that tag.
5. **W5 — The boot record's readiness wait is bounded by iterations, not by wall clock** - `scripts/ops/boot-record.sh:37-55` vs `deploy/host/fcpi-boot-record.service` (`TimeoutStartSec=1200`)  _(corroborated: both agents)_
   - Problem: the first loop is 180 × (5 s + curl timeouts). The second waits up to 10 more minutes for `ActiveState=active`, even when the state is `failed`. On a boot where the stack fails, systemd kills the unit at 1200 s, before the readiness line and `end` are written, so H04 rejects exactly the boot most worth recording.
   - Suggestion: use one deadline (boot + 900 s) for both loops, and break when the stack's state is `failed`.
6. **W6 — Nothing serializes writers of the admission file** - `scripts/ops/lib.sh:98-118`  _(corroborated: both agents; DB1 🟡, CA1 🔵, merged at the higher severity)_
   - Problem: the tick and `hold_set`/`hold_clear` can interleave, and the last rename wins. A tick can reopen dispatch while the backup drains, or re-apply a cleared hold, for up to 60 s.
   - Suggestion: wrap `admission_write` in `flock "$RUND/admission.lock"`.
7. **W7 — `backup-meta.json` is never validated before upload** - `scripts/ops/backup.sh:117-124`  _(unique to CA1's lane)_
   - Problem: if `compose config` fails, `--argjson images ""` makes jq exit, leaving an empty `backup-meta.json`. The upload still proceeds and records PASS; every nightly backup then lacks canaries until the monthly restore test notices.
   - Suggestion: `jq -e '.run and .versions_lock_sha256 and (.images|type=="object")'` before upload, and record FAIL otherwise.
8. **W8 — The five-minute quiescence limit (spec §26) is measured, not enforced** - `scripts/ops/backup.sh:78-108`  _(unique to CA1's lane)_
   - Problem: the worst case is about 16 minutes: drain 120 s, dump 240 s, an unbounded `cp -a`, then `--wait-timeout 600`. Meanwhile the 900 s hold can expire with services still stopped, and `quiesce_s > 300` still records PASS.
   - Suggestion: give drain and dump one shared budget, record `quiesce_exceeded`, and have the tick open an incident on it.
9. **W9 — The restore test starts a second stack with no disk or memory headroom check** - `scripts/ops/restore-test.sh:59-113`, `deploy/host/fcpi.slice`  _(unique to CA1's lane)_
   - Problem: it restores a full copy onto production PostgreSQL's filesystem, where running out of space means a WAL PANIC in production. It then starts about 4.9 GiB of capped services in an uncapped slice, without taking a hold.
   - Suggestion: check free disk (restore-size × 1.2 + 2 GiB) and MemAvailable against measured figures first, and record the minimum MemAvailable during the run.
10. **W10 — The restore copy's isolation rests on unasserted string rewrites** - `scripts/ops/restore-test.sh:95-118`  _(unique to CA1's lane)_
    - Problem: isolation depends on four `gsub` path prefixes. A future bind mount outside them would silently share production state, and no check or test covers the transformation.
    - Suggestion: add a `binds_isolated` check that every bind source and `secrets.*.file` starts with `$R`, plus a golden test of the jq program against the rendered `deploy/compose.yaml`.
11. **W11 — The restore copy keeps `restart: unless-stopped`** - `scripts/ops/restore-test.sh:103`  _(only DB1 — CA1 was in scope but didn't flag; confirmed by the orchestrator)_
    - Problem: if the host resets during the test (the Wi-Fi watchdog resets are a known pattern), the EXIT trap never runs, and dockerd revives the whole `fcpi-restore` stack at boot. There it can run for weeks. Its `fcpi.transient` label hides it from the foreign-container check.
    - Suggestion: add `| .restart = "no"` inside the `map_values(...)`. Have the tick flag any running `fcpi-restore` container that no restore test holds.
12. **W12 — The webhook check samples its baseline after the copy is already up** - `scripts/ops/restore-test.sh:125` (the `up` is at `:112`)  _(only DB1 — CA1 was in scope but didn't flag)_
    - Problem: delivery attempts made while the restored services start fall before `hooks0`, so `no_webhook_delivered` cannot see them.
    - Suggestion: start only the data services, read the baseline, then start the app services. Alternatively, compare against counts recorded in `backup-meta`.
13. **W13 — The tick's time budget is exposed to notice delivery and to the supervisor's record order** - `scripts/ops/lib.sh:134-147`, `scripts/ops/tick.sh:113-114`, `deploy/host/fcpi-tick.service`  _(unique to CA1's lane)_
    - Problem: each notice costs up to 20 s with no overall cap. A down channel with 8 pending notices pushes past `TimeoutStartSec=150`: systemd kills every tick, the admission file approaches its staleness bound, and retention is skipped. The supervisor appends its restart record after `docker restart`, so a tick killed mid-restart undercounts the restart budget.
    - Suggestion: cap delivery per tick (by time or count), or move it to its own unit. Append the restart record before calling `docker restart`.
14. **W14 — The OOM incident misses a container's main process being killed** - `scripts/ops/tick.sh:55,60,124,138`  _(unique to DB1's lane)_
    - Problem: a restart recreates the scope and resets `memory.events`, and only running containers are read, so `oom_kill:<svc>` never rises. `oom.json` is also rewritten before incidents are judged.
    - Suggestion: read the hierarchical `oom_kill` from `fcpi.slice/memory.events`, `.State.OOMKilled` or the `RestartCount` delta. Write `oom.json` only after judging.

*Rollback, recovery and redaction*

15. **W15 — The rollback plan names a backup taken after the migration** - `scripts/ops/plan.sh:77,79`  _(only DB1 — CA1 was in scope but didn't flag; confirmed by the orchestrator)_
    - Problem: `backup_to_restore` is `$cur.last_backup_before`, which `current_release` computes now, so it is the newest backup. After an upgrade to schema 4 and one nightly backup, the plan restores schema-4 data under the old gateway.
    - Suggestion: use the newest backup whose `platform_schema_version` equals `$prev.ledger_schema_db`, or the `last_backup_before` recorded at cutover.
16. **W16 — The rollback plan ignores moves of the data-service images** - `scripts/ops/plan.sh:76-77`  _(only CA1 — DB1 was in scope but didn't flag)_
    - Problem: `data_restore_needed` compares only the ledger schema. After a PostgreSQL major upgrade, the plan prescribes no data restore and starts an older binary on newer data, which CLAUDE.md §29 forbids.
    - Suggestion: also set `data_restore_needed` when the nuq-postgres, redis or rabbitmq image differs. Record and compare the NuQ schema hash too.
17. **W17 — The DR procedure cannot bring up the recorded images** - `scripts/ops/restore-procedure.txt:23-26`, `deploy/compose.yaml` (`pull_policy: never`, local image-ID pins)  _(unique to CA1's lane)_
    - Problem: the backup excludes images, the builds are not reproducible, and "rebuild from that commit" produces different IDs, so the recorded commit does not start after a loss of the Pi. The restore test never exercises this, because it reuses the Pi's local images.
    - Suggestion: back up `docker save` of the five project images as a tagged restic snapshot, with a `docker load` step. Alternatively, document the rebuild-and-repin path honestly.
18. **W18 — The doctor's redaction misses secrets that are only part of a structured line (CWE-532)** - `scripts/ops/doctor.sh:51-53`  _(only CA1 — DB1 was in scope but didn't flag)_
    - Problem: only whole lines and `://user:pass@` passwords are searched. The password half of a `user:pass` line, a `k = v` value (RabbitMQ `default_pass`), and the base64 `Basic` form of a proxy credential pass unnoticed. This is separate from critical 2.
    - Suggestion: also add the part after `:` in `user:pass` lines, the value after `=`, and the base64 of each `user:pass` pair (as X05's pairFiles does).

*Verifier and suite checks that cannot fail*

19. **W19 — `fcpi verify services` passes with zero suite checks, and `verify functional` can report a stale probe** - `scripts/ops/verify.sh:50,59`  _(corroborated: both agents)_
    - Problem: if `pi-suites.sh` dies before its first `### … test_exit=` section, `all([])` is true. Failing input: pi-suites output with no sections. For the functional suite, `probe.sh` exits 0 under `flock -n` while the timer's probe runs, and the previous probe is reported as current.
    - Suggestion: require the expected section names. Require `probe-last.json.utc` to be no older than the suite's own start.
20. **W20 — K02 claims artifact checks it never requires** - `scripts/m8/verify.mjs:711-722`  _(unique to CA1's lane)_
    - Problem: `expected` says artifacts hash and are refused to another principal, but `cond` never requires an `artifact_hash:*` or `artifact_acl:*` key. Failing input: a `restore_test` record with no artifact checks still passes.
    - Suggestion: require at least one of each, or drop the claim.
21. **W21 — S04 passes when the Redis ACL log was never read** - `scripts/m8/verify.mjs:676`, `scripts/m8/pi-redis.sh:21`  _(unique to DB1's lane; confirmed by the orchestrator)_
    - Problem: under `set -e`/`pipefail`, a failed `r ACL LOG` ends the collector right after `### acl_log`, and the empty section matches `/^\s*$/`. Failing input: `redis-soak.txt` with an empty `acl_log` section passes.
    - Suggestion: have the collector print `acl_log_read=ok entries=<n>` after the read, and require it in S04.
22. **W22 — The runner reports a missing live input as BLOCKED_CREDENTIAL** - `scripts/m8/verify.mjs:893`  _(unique to CA1's lane)_
    - Problem: an absent K03 or N01 file becomes BLOCKED_CREDENTIAL even when the credential exists and the collector simply never ran.
    - Suggestion: report NOT_RUN when the file is absent. Use BLOCKED_CREDENTIAL only when the record says so.
23. **W23 — V01 accepts review outcomes CLAUDE.md §5 does not define** - `scripts/m8/verify.mjs:862,870`  _(unique to DB1's lane)_
    - Problem: `Closed`, `Recorded` and `Returned to M\d` are accepted at M8 (§5 allows "returned" only at M9), and only `Fixed` rows need a commit.
    - Suggestion: restrict the outcomes to Fixed with a commit, Rejected with evidence, and Deferred to M9 with a reason.

*Interface regression*

24. **W24 — The bash rewrite of `fcpi` breaks M3's e2e CLI case** - `scripts/fcpi` vs `scripts/m3/e2e.mjs:456-466`  _(unique to CA1's lane; confirmed by the orchestrator)_
    - Problem: M3 runs `scripts/fcpi` on the workstation with `FCPI_BASE_URL` and `FCPI_TOKEN_FILE=/dev/stdin`. The new `fcpi` ignores both, sources Pi paths and requires root, so the case fails and M3's e2e cannot be rerun for M9 regressions.
    - Suggestion: update or retire M3's `cli` case, and record the interface change.

### 🔵 Suggestions (Consider)

**Introduced in this changeset:**
1. **S1 — Operator input interpolated into SQL (CWE-89, root operator only)** - `scripts/ops/usage.sh:13`  _(corroborated: both agents)_
   - Current: the glob `[0-9]*d` accepts `1';…d` and `1xd`.
   - Better: `[[ $period =~ ^[0-9]{1,4}d$ ]]`.
2. **S2 — A browser-pause refusal spends a page attempt** - `services/retrieval/src/acquire.mjs:420-431`  _(corroborated: both agents)_
   - Current: the admission check runs after `reserveAttempt`.
   - Better: read admission first, or document why the attempt row is kept.
3. **S3 — Weak soak and notice checks** - `scripts/m8/verify.mjs:571,612,619`  _(unique to DB1's lane)_
   - Current: `pct([])` is null, and `null <= 5000` is true, so an absent request class passes the latency check. O02 accepts a round-1 notice and never checks that the incident cleared.
   - Better: require non-null p95 values; require the round-4 open and the clear.
4. **S4 — The restore check merges stderr into its results** - `scripts/ops/restore-test.sh:158-159`  _(unique to DB1's lane)_
   - Current: with `2>&1`, one non-JSON line fails every later check (fail-closed but misleading).
   - Better: send stderr to `"$R/check.err"`.
5. **S5 — One missing cgroup value drops the whole minute's sample** - `scripts/ops/tick.sh:53-58`, `scripts/ops/probe.sh:37`  _(unique to DB1's lane)_
   - Current: an empty read breaks the JSON, and `probe.sh`'s arithmetic then aborts before the `tick_stale` check.
   - Better: default each read to `null`, and guard the arithmetic.
6. **S6 — Alert command parsing and a burst on first configuration** - `scripts/ops/lib.sh:136,142`  _(unique to DB1's lane)_
   - Current: quotes are kept literally, and configuring a channel sends the whole 90-day outbox at once.
   - Better: strip the quotes, and deliver only notices newer than the configuration.
7. **S7 — Backup setup overwrites its configuration despite its header** - `scripts/m8/pi-backup-setup.sh:12,41`  _(unique to DB1's lane)_
   - Current: running `fixture` after `live` silently points nightly backups back at the on-card repository.
   - Better: refuse to switch without an explicit flag.
8. **S8 — The boot record holds back `multi-user.target`** - `deploy/host/fcpi-boot-record.service:13-14`  _(unique to DB1's lane)_
   - Current: the oneshot delays the target by up to 20 minutes.
   - Better: accept this and say so in the unit, or run the readiness part after the target.
9. **S9 — admission.mjs is duplicated** - `services/access/src/admission.mjs`, `services/retrieval/src/admission.mjs`  _(unique to CA1's lane)_
   - Current: two copies, identical apart from their headers.
   - Better: a test asserting the bodies are equal, or one module copied in at build.
10. **S10 — Thresholds repeated as magic numbers** - `scripts/ops/tick.sh:93-99`, `STALE_MS` in both admission.mjs files, `scripts/ops/probe.sh:39`, `scripts/ops/verify.sh:43-44`, `scripts/ops/backup.sh:87`  _(unique to CA1's lane)_
    - Current: the same limits are written separately in shell, jq and JS.
    - Better: define them once in `lib.sh`, and carry `stale_after_s` in the admission file.
11. **S11 — Backend credentials exported to every child process (CWE-526)** - `scripts/ops/backup.sh:38`, `scripts/ops/restore-test.sh:38`, `scripts/fcpi:43`  _(unique to CA1's lane)_
    - Current: `set -a; . "$FCPI_RESTIC_ENV_FILE"`.
    - Better: `restic() { ( set -a; . "$FCPI_RESTIC_ENV_FILE"; exec command restic "$@" ); }`.
12. **S12 — Redis ACL denials after the soak are never surfaced** - `deploy/redis/fcpi-core.rules`  _(unique to CA1's lane)_
    - Current: the allowance is measured over one soak only.
    - Better: have the tick sample the `ACL LOG` length and open an incident when it grows.
13. **S13 — Prune runs before any integrity check** - `scripts/ops/backup.sh:141`  _(unique to CA1's lane)_
    - Current: `forget --prune` runs nightly. Spec §26 says prune only after a successful backup and its required checks.
    - Better: run `forget` nightly and `prune` after a passing weekly `backup-check`.
14. **S14 — The DR procedure does not give the suppressed-webhook start command** - `scripts/ops/restore-procedure.txt:27-29`  _(unique to CA1's lane)_
    - Current: it says "keep webhooks suppressed", then gives a plain `systemctl start fcpi-stack`.
    - Better: give the exact suppressed start command.
15. **S15 — The slice has no aggregate memory cap** - `deploy/host/fcpi.slice`  _(unique to CA1's lane)_
    - Current: only `MemorySwapMax` is set; the per-container caps sum to about 7.2 GiB on an 8 GiB host.
    - Better: consider a measured `MemoryHigh` on the slice.

### ✅ Good Practices
- Admission fails open on a stale, future-dated, unreadable or absent file, with positive controls in both services. The gateway refuses with 503 and Retry-After and never answers 502 (`services/access/server.mjs:537-541`).
- State files are read through `obj`/`put_obj` and written with `write_atomic`. The admission directory, not the file, is bind-mounted, so atomic renames are seen.
- `gw()` passes the operator token to curl as a process-substitution descriptor, and `pi-redis.sh` passes `REDISCLI_AUTH` on stdin, so neither reaches argv.
- The restore copy drops published ports and the egress network, forces every network internal, and labels every container `fcpi.transient`. Paid dispatch and webhook delivery are forced off.
- The backup takes a logical dump and a cold physical copy, restarts services through an EXIT trap, and keeps secrets in their own restic stream without a plaintext staging copy.
- The Redis narrowing refuses unexpected ACL shapes, keeps the password hash and masks hashes in its output.
- The supervisor's restart budget is bounded, and data services are excluded from restarts. O04 requires at least 1,000 answers before claiming "no 502".

### Verdict
[x] ❌ Request Changes (critical issues)
[ ] ⚠️ Approve with Suggestions
[ ] ✅ Approve

---

## Carried from earlier reviews

| ID | Finding | Outcome | Commits |
|---|---|---|---|
| M1 R11 | Redis's `default` user holds `+@all` for the core | Fixed: the core connects as `fcpi_core`, allowed the command set its build can issue (BullMQ's scripts and client, the core's dist, ioredis; deploy/redis/fcpi-core.rules), measured over a paced workload (24 core commands); `default` is off; the operator reads statistics as `fcpi_ops`. S04 holds the soak to no rejected call and no denial; the probe raises any later denial (S12) | `1877a99`, `0bd5ed3`, `2bb7eef` |
| M1 R12 | Containers outside project fcpi go unreported, though dockerd's start gate assumes Docker serves the project alone | Fixed: `fcpi foreign` names them at every fcpi-stack start, the tick opens foreign_container, and fcpi status lists them; H03 injects one and requires each to name it and then none | `6293915`, `a07f979` |
| M1 R13 | The dockerd gate was observed for 60 s only | Fixed in M1's close-out: fcpi-stack Wants docker.service, and dockerd reaches its start limit in 6 s (evidence/M1/closeout) | `a1e6c15`, `f4d0cae` |
| M1 R14 | NetworkManager handled Docker's veths | Fixed in M1's close-out: 90-fcpi-unmanaged.conf leaves `veth*`, `fcpi-*` and `docker0` unmanaged; `fcpi verify ops` checks the installed file | `2b42ad0`, `f5bac0b` |
| M1 R15 | PostgreSQL's server-class background and WAL writer settings on the microSD card; sixteen nightly REINDEX jobs | Fixed: the writer settings return to PostgreSQL's defaults, chosen on an A/B of card writes (72.1 to 65.2 MiB/h) and WAL flushes (1,822 to 1,715/h) on one workload (S03). The REINDEX jobs stay: the 27 NuQ indexes total 496 KiB, so a night's REINDEX writes under 1 MB | `bc31798`, `041320e` |
| M4 F1 | A 614 KB page aborted the core's API child at a 256 MiB heap | Fixed: each core child's heap ceiling is 384 MiB (M7 F11), and M8's heap probe runs 400 KiB to 2 MiB pages in three formats against it with no heap failure and no restart (scripts/m8/pi-heap-probe.sh; S05) | `b825e57`, `1365bc8` |
| M4 F2 | A systemd daemon-reload lifts every container's swap limit | Fixed: every container runs under fcpi.slice, whose MemorySwapMax=0 systemd re-asserts at every reload; the tick opens swap_limit_lost for a container whose scope and slice both allow swap, and H02 reloads and requires the slice to hold 0 (the trigger that lifts a scope stays unpinned, F9) | `a07f979`, `57d55bf` |
| M7 F10 | Wi-Fi losses end in the owner's watchdog rebooting the Pi | Rejected, with the evidence that it is not a project defect: the losses follow the access point's DFS channel and the regulatory domain resetting to WORLD, and the reboots are the owner's watchdog (evidence/M8/reboots holds each boot M8 saw, F6). What M8 owns is surviving them: every boot is recorded durably (M7 F13), readiness after a reboot is timed (R01), and the soak measures the host over a day (S01) | — |
| M7 F13 | Reboot records were overwritten or rotated out of the 32 MiB journal before they were kept | Fixed: fcpi-boot-record.service writes each boot's record at that boot, the ended boot's cause while the journal still holds it and this boot's readiness, one file per boot, never rewritten; H04 requires one for every boot of the window | `a07f979`, `aa4b4c0`, `9b6a339`, `ee51164`, `58a3019` |

## Found during M8, outside the review

| ID | Severity | Finding | Outcome | Commits |
|---|---|---|---|---|
| F1 | — | gw() opened the token's process substitution inside an array assignment, closed before curl ran, so every host call to the gateway answered 000 | Fixed: the descriptor is opened on curl's own command line | `b196243` |
| F2 | — | Host samples were about 8 KiB a minute (11 MiB a day on the card) | Fixed: a compact projection is kept and incidents are judged on the full record | `0416d79` |
| F3 | — | The soak's change-check verdict broke the eval'd jq program with inner double quotes | Fixed: the quotes are escaped | `f7c369f` |
| F4 | — | fcpi doctor refused its bundle intermittently: the gateway's start log line names the tailnet Serve origin | Fixed: the log filter redacts tailnet names and addresses | `0d839f7` |
| F5 | — | The owner's ChatGPT/Codex remote-SSH helper opens about three SSH sessions a minute to the Pi, each about 40 journal lines, so the 32 MiB journal holds about 2.5 hours | Rejected, with the evidence that it is not a project defect: the helper is the owner's (recorded, not changed); its effect on the project, reboot causes rotating out, is closed by the boot record written at each boot (M7 F13) | — |
| F6 | — | A Wi-Fi loss at 23:18Z on 2026-09-27 led to five boots by 00:24Z: three ended by the watchdog's reboot, two with no shutdown markers mid-recovery | Rejected, with the evidence that it is not a project defect: the same owner-side cause as M7 F10; each boot is kept in evidence/M8/reboots and tied by H04 | — |
| F7 | — | Card writes in a boot's first 70 minutes: journald 263 MB (mostly F5's churn), containerd 109 MB and dockerd 102 MB (health-check execs), PostgreSQL 70 MB, RabbitMQ 51 MB; about 345 MB/h for the project | Rejected, with the evidence that it is a measurement, not a defect: it is the storage evidence spec §21.1 asks for, and R15's change lowered PostgreSQL's share (S03) | — |
| F8 | — | S03 as first written also judged WAL bytes per hour, which the writer settings do not govern | Fixed: S03 judges card writes and WAL flushes, and reports WAL bytes | `041320e` |
| F9 | — | M4 F2's trigger is not pinned: no single systemd action reproduced a lifted scope, yet most scopes were found at max within about two hours of creation | Fixed: fcpi.slice's MemorySwapMax=0 holds whatever lifts a scope, and H02's control is a scope observed lifted with the slice still at 0 | `a07f979`, `57d55bf` |
| F10 | — | A docker inspect race (a container removed between ps and inspect) appended a second JSON document, the conditions failed, an empty state.json was written, and every later tick stayed broken without tick_stale noticing | Fixed: the inspect output is merged into one array, state files are read and written only as JSON objects, and a minute whose incidents did not compute is logged | `e0ec0ff` |
| F11 | — | Found while addressing S12: pi-collect-stack.sh read Redis's health with the core's URL in its M1 shape as the default user, which M8's narrowing turned off, so the section came back empty (two AUTH failures sat in the ACL log) and nothing noticed | Fixed: it reads as fcpi_ops, password on stdin, and X02 requires AOF on with its last write ok | `4f81a79` |
| F12 | — | Found while addressing W22: nothing in the repository produced raw/backup-live.txt or raw/notify-live.txt, the records K03 and N01 read | Fixed: pi-backup-live.sh and pi-notify-live.sh write them, configured=no with the reason while the owner input is absent, and window.sh runs both | `74e1864` |
| F13 | — | Found with F11: M3's e2e redisKeys helper and the M1, M6 and M7 collectors and verifiers still read the core's Redis URL in its M1 shape, so rerun after M8's narrowing they authenticate as the disabled default user | Deferred to M9: those are earlier milestones' accepted tools, outside M8's Scope, and M9's final acceptance is where they run again; each needs the fcpi_ops read F11 uses | — |
| F14 | — | Found while addressing W4: backup-check sent a backup_check_failed notice directly, which never cleared and repeated every failing week, and the backup's usage named a --no-quiesce-check option it never had | Fixed: the tick owns backup_check_failed and backup_check_stale as incidents, and the usage names only what exists | `4f11426` |
| F15 | — | During pi-up-m8.sh's forced recreate the tick read containers Docker already reported running, before their cgroup scopes existed, as swap allowed, and opened swap_limit_lost for three services with a notice each | Fixed: the tick and S01 judge only a scope they read; a scope read with swap allowed still opens the incident | `5687578` |
| F16 | — | pi-up-m8.sh recreated PostgreSQL and the core with no hold in force, so the tick opened queue_unreadable for a restart the bring-up made on purpose | Fixed: the bring-up holds admissions for the recreate, as a cutover does (spec §27), and clears the hold on exit | `4feb8b1` |
| F17 | — | Under set -e, pi-backup-setup.sh read the repository from a configuration file that did not exist yet (the fixture's first backup-fixture.env); sed exited 2 and ended the script before it wrote the file | Fixed: a configuration file that does not exist yet reads as no repository | `b86a078` |
| F18 | — | N01's proof polled ntfy's server one second after the recovery was sent and found only the incident's opening message, though the recovery was accepted, delivered and received on the owner's phone | Fixed: the proof polls for up to a minute until both of the incident's messages are listed | `28724e8` |
| F19 | — | Window 1: the thermal fault case's own ticks left at once whenever the timer's tick held the lock, which ntfy delivery holds a few seconds longer, so browser work was never seen resuming (I14 and O02 failed) | Fixed: tick.sh waits FCPI_TICK_LOCK_WAIT_S for the lock (0 for the timer's runs, as before); the fault cases and the notice proof wait up to 90 s | `6b60f8e` |
| F20 | — | Window 1: S01 excused a request refused during the nightly backup's hold only as 503 HOST_PRESSURE, but once the quiescence stops the gateway a request gets no answer at all (six did at 07:30:33Z); X02 required swap 0 on every container's own scope, where the design denies swap at fcpi.slice because a scope's limit can be lifted (M4 F2, F9) | Fixed: both forms inside the hold are the backup's designed pause (spec §26) and any other failure still fails; X02 requires the slice's 0 above all fifteen services and reports the scopes whose own limit was lifted | `600e68f` |
| F21 | — | Window 1: a long SSH session over the Pi's Wi-Fi dropped while the soak's record was collected, and window.sh stopped before the Redis statistics, the soak's stop and the close | Fixed: the soak's record is written on the Pi, copied and checked against the Pi's hash; each read-only end step is tried again after a dropped connection, and notes of retries go to the log, never into the evidence | `07ab78c` |
| F22 | — | Window 2: the VPS watchdog reset an open incident's class and first failure when the failure class changed, so an outage that opened as heartbeat_missing cleared as monitor_stale with a shortened outage | Fixed: a new failure run starts only while no incident is open; replayed on the VPS, missing four times, stale once and ok twice now clears as heartbeat_missing with its first failure kept, where the previous code clears as monitor_stale | `a8e4433` |
| F23 | — | Window 2 (I07): Chromium killed as a render started left the browser worker busy for good, answering 429 until restarted: a Playwright call on a browser lost before the render's context and deadline existed never settled | Fixed: a hard stop bounds the whole render; the browser-crash case also kills Chromium as a render starts; the worker's image is built, locked and checked by G01 with the others | `784d342`, `303a1bb`, `cc54f33` |
| F24 | — | Window 2 (S02): the fixture peaked at 58 of its 64 MiB (91 %), and fixture-m3, the other 64 MiB Node fixture, at 85 % | Fixed: both get 96 MiB, as the other Node fixtures have; they serve test pages only, and fcpi.slice's bound is unchanged | `88229d0` |
| F25 | — | Window 2 (S01): two refusals at 07:30:36Z inside the nightly backup's hold fell between two minute samples, neither of which saw the hold, so S01 could not tie them to the backup | Fixed: the soak lists the backup runs and S01 uses each run's own start and end; on copies of window 2's record, without the section it fails, with the real run it passes, and with the run moved an hour earlier it fails | `dc11b35` |
| F26 | — | The browser-crash case's Chromium killer matched its own command line, killed itself after Chromium, and recorded 0 processes killed for a kill that happened | Fixed: the killer skips its own pid | `d7ab53f` |
| F27 | — | Window 3: a power cut left NUL blocks in two appended logs (the day's host samples and the soak's log); jq stops at the first damaged line, so the soak's collection kept 86 of its samples, and the tick's log trim and daily summary had the same weakness | Fixed: lib.sh's jsonl reads line by line and skips what is not a whole JSON line; the soak's collection and the window's readers use it and record the damage, which S01 reports; on the damaged files it returns 311 of 311 samples and 294 of 294 soak records | `79b5e80`, `c907e28` |
| F28 | — | Window 3: the Pi restarted on its last saved clock (it has no real-time-clock battery), docker's log timestamps went back, and docker logs --since returned nothing, so restoring the selection reported a failure although the service had loaded it 7 s after the write | Fixed: a step's log lines are found by their position in the log, never by time | `63d2b04` |
| F29 | — | Window 4: the same power cut had left NUL blocks in docker's json-file logs (the retrieval service, the gateway, two fixtures), and docker logs stops at the first with no error, so pi-selection.sh never saw the fixture selection load, the fault run failed at its first step, and window.sh went on to the soak regardless | Fixed: pi-selection.sh confirms a selection from the retrieval service's own state; window.sh stops before the soak when the fault run cannot pass (windows 1 to 3 pass that gate, window 4 stops) | `e2fe85f`, `66ac385` |
| F30 | — | Before window 5: a further power cut cut the core's docker log short the same way (17,328 of 17,875 lines), so any window reader of a container log could read it short | Fixed: lib.sh's container_log reads the json-file log as root, rotated file first, past NUL blocks and partial lines, identical to docker logs on an undamaged log, and every reader the window runs uses it; before every dockerd start a repair rewrites each damaged container log with its whole JSON lines (on the Pi, four files repaired and no line dropped) | `bd6d18d`, `6366dd8` |

## Outcomes

Every fix below is committed and its local checks pass: each changed script parses, shellcheck reports no error, the
verifier compiles, and the Node suites the workstation can run pass (the restore transformation's golden test, the
admission copies' contract test and the retrieval admission tests). The live proof is the evidence window run on the
redeployed Pi: the fault cases, the backup and restore proof, the rehearsal and the soak recollect every record these
checks read.

| ID | Severity | Finding | Outcome | Commits |
|---|---|---|---|---|
| C1 | 🔴 | Every production client token is placed on jq's command line during the restore test | Fixed: jq reads each token with --rawfile and the map reaches the plan on stdin | `15bbc82` |
| C2 | 🔴 | fcpi doctor fuses secret files that lack a trailing newline, so it never searches for those secrets | Fixed: awk 1 ends each file's last line; the self-test plants a newline-less value and a client token, and O03 requires every planted value found | `5cdce7f` |
| W1 | 🟡 | The backup's resume step runs compose up -d on the whole project | Fixed: the services running before the backup are started again with compose start, which recreates nothing; backup-meta records the running images and whether they match the deployed tree | `6159de0` |
| W2 | 🟡 | The physical copy is taken without confirming the data services stopped | Fixed: each data service must report Running=false before the copy, or the run fails naming it | `e4b0ab6` |
| W3 | 🟡 | The tick opens false incidents during the nightly backup | Fixed: while a hold is in force, core_unhealthy, queue_stalled, queue_unreadable and functional_probe_failing neither open nor clear, and the probe does not count its failures; K01 requires no such notice across the backup, with the ticks that read the hold as the control | `8db9ad0` |
| W4 | 🟡 | Repository jobs are not mutually excluded, and a skipped restore test leaves no trace | Fixed: backup, backup-check and restore-test share repo_lock with a bounded wait and record SKIPPED; the tick opens restore_test_stale, backup_check_stale and backup_check_failed; both snapshots of a run carry a run tag the restore test pairs them by | `4f11426` |
| W5 | 🟡 | The boot record's readiness wait is bounded by iterations, not by wall clock | Fixed: readiness is waited for until 900 s of uptime and both waits end by a deadline inside the unit's bound; the second stops once the stack unit has failed | `9b6a339` |
| W6 | 🟡 | Nothing serializes writers of the admission file | Fixed: every write lists the holds and renames the file under admission.lock (exercised on the Pi with 40 concurrent writers) | `0e40589` |
| W7 | 🟡 | backup-meta.json is never validated before upload | Fixed: the run, version-lock hash, image map and canary arrays are checked before upload, and the run fails otherwise | `357b3b2` |
| W8 | 🟡 | The five-minute quiescence limit is measured, not enforced | Fixed: drain, dump and copy share one 300 s budget; every attempt records quiesce_exceeded and the tick opens backup_quiescence_over_budget | `f3eaf36` |
| W9 | 🟡 | The restore test starts a second stack with no disk or memory headroom check | Fixed: restore size plus a fifth and 2 GiB free is required (unknown size fails closed), 2,048 MiB available to start, and a watchdog kills the copy under 1,280 MiB, recording the lowest reading; K02 requires both checks | `fe4c547` |
| W10 | 🟡 | The restore copy's isolation rests on unasserted string rewrites | Fixed: the transformation is scripts/ops/restore.jq; binds_isolated refuses a copy naming a production path before it starts; a golden test and pi-suites.sh check it against the Compose file the Pi renders, with production's own file as the control | `cbc085a` |
| W11 | 🟡 | The restore copy keeps restart: unless-stopped | Fixed: the copy's services carry restart "no", and the tick opens restore_copy_running after three hours | `696d359` |
| W12 | 🟡 | The webhook check samples its baseline after the copy is already up | Fixed: the data services start first, the baseline is read, then the rest starts | `542ff3c` |
| W13 | 🟡 | The tick's time budget is exposed to notice delivery and to the supervisor's record order | Fixed: at most three deliveries or 30 s a tick, and the restart record is appended before the restart | `4b60f91` |
| W14 | 🟡 | The OOM incident misses a container's main process being killed | Fixed: the tick reads fcpi.slice's own oom_kill and opens oom_kill:fcpi.slice naming the services that restarted; oom.json is written after judging; the memory-pressure fault case counts the slice's kills too | `bb59353` |
| W15 | 🟡 | The rollback plan names a backup taken after the migration | Fixed: the newest backup that finished before the running commit's cutover at the previous release's ledger version (backup records carry it) | `a327210` |
| W16 | 🟡 | The rollback plan ignores moves of the data-service images | Fixed: a data restore is needed when the ledger differs, a data service's image moves or the NuQ or retrieval schema file differs (releases record their hashes) | `a327210` |
| W17 | 🟡 | The DR procedure cannot bring up the recorded images | Fixed: to an off-device repository the backup saves the fcpi/* images into a third snapshot whenever their set changes (a failure fails the run); the procedure loads them and checks the Compose pins, rebuild-and-repin being the fallback | `e1b7c10` |
| W18 | 🟡 | The doctor's redaction misses secrets that are only part of a structured line | Fixed: password halves of user:password lines, key = value values and the base64 Basic form are searched for too; the self-test plants a provider password half | `8eb2d92` |
| W19 | 🟡 | fcpi verify services passes with zero suite checks, and verify functional can report a stale probe | Fixed: suites_complete requires every suite by name, and probe_ran_now a probe begun at or after the suite's start | `32b531a` |
| W20 | 🟡 | K02 claims artifact checks it never requires | Fixed: the backup proof takes a fixture screenshot first, and K02 requires its artifact and a passing hash and refusal check | `4068bf7` |
| W21 | 🟡 | S04 passes when the Redis ACL log was never read | Fixed: the collector prints acl_log_read=ok entries=<n> after the read, which S04 requires | `a54b698` |
| W22 | 🟡 | The runner reports a missing live input as BLOCKED_CREDENTIAL | Fixed: a missing input is NOT_RUN; the blocked state comes only from a record the live collectors write (F12) | `74e1864` |
| W23 | 🟡 | V01 accepts review outcomes CLAUDE.md §5 does not define | Fixed: only Fixed, "Rejected, with the evidence" and "Deferred to M9", each with its substance | `f6782d9` |
| W24 | 🟡 | The bash rewrite of fcpi breaks M3's e2e CLI case | Fixed: M3's Node client returns as scripts/ops/client.mjs, and fcpi runs it for status and jobs whenever FCPI_BASE_URL is set | `252f8d1` |
| S1 | 🔵 | Operator input interpolated into SQL | Fixed: --period is day, month or one to four digits and d | `ba6d79f` |
| S2 | 🔵 | A browser-pause refusal spends a page attempt | Fixed: the admission file is read before the attempt is reserved; the test asserts no browser attempt row | `fce86f1` |
| S3 | 🔵 | Weak soak and notice checks | Fixed: every p95 must be measured, and O02 requires three restarts without a notice, the notice at the fourth hang and its clear | `b6c406a` |
| S4 | 🔵 | The restore check merges stderr into its results | Fixed: its stderr goes to check.err | `7b9a535` |
| S5 | 🔵 | One missing cgroup value drops the whole minute's sample | Fixed: a failed read is null and a malformed row drops alone; the probe's age arithmetic is guarded | `eefe6e8` |
| S6 | 🔵 | Alert command parsing and a burst on first configuration | Fixed: one pair of surrounding quotes is removed, and only notices raised since alerts.env was written are delivered | `fef9c7b` |
| S7 | 🔵 | Backup setup overwrites its configuration despite its header | Fixed: another repository's configuration is kept unless --switch is given, checked before any repository is opened | `f75df5f` |
| S8 | 🔵 | The boot record holds back multi-user.target | Fixed: the unit is Type=exec, bounded by RuntimeMaxSec | `ee51164` |
| S9 | 🔵 | admission.mjs is duplicated | Fixed: a contract test holds the two copies to the same code below their headers | `7ee7261` |
| S10 | 🔵 | Thresholds repeated as magic numbers | Fixed: lib.sh states the admission limits once, and a contract test holds the services' STALE_MS to them | `946dbc6` |
| S11 | 🔵 | Backend credentials exported to every child process | Fixed: lib.sh's restic function sources them in a subshell for restic alone | `7369e76` |
| S12 | 🔵 | Redis ACL denials after the soak are never surfaced | Fixed: the probe records the ACL log's non-AUTH entries (read with redis-cli -e, so a refused read is null) and the tick opens redis_acl_denied | `2bb7eef` |
| S13 | 🔵 | Prune runs before any integrity check | Fixed: the nightly run only forgets; the weekly check prunes after restic check passes | `23f69d8` |
| S14 | 🔵 | The DR procedure does not give the suppressed-webhook start command | Fixed: step 6 gives the compose command with the webhooks-suppressed override, then the owner's go-ahead and systemctl start | `e1b7c10` |
| S15 | 🔵 | The slice has no aggregate memory cap | Fixed: fcpi.slice sets MemoryHigh=5632M (MemTotal less spec §22's reserve and the host's measured services); fcpi verify ops and S02 check it | `72ad844` |
