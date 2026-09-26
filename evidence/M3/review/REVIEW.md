# M3 review of record — /review-2

- **Method:** `/review-2` (CLAUDE.md §5), read-only. Three agents ran in parallel:
  - DB1, debugger: logic, runtime, types and integration;
  - CA1, code auditor: architecture, quality, performance, security and data integrity;
  - TV1, code reviewer: verification tooling and evidence integrity.
- **Model:** all three ran on **Opus 5.5** (the Agent tool's `opus` alias), so there is no substitution. Their independence comes from fresh contexts: none saw this session's transcript.
- **Third agent:** the owner approved a third agent in case the changeset was too large for two. TV1 took the verifier, the drivers and the collectors, because M3's acceptance runs through `scripts/m3/verify.mjs`, and a check that passes on missing evidence would hide a real defect. M2's review found that kind of check (M2 W15).
- **Date:** 2026-09-26, 10:18Z–10:45Z.
- **Range:** `aa22d92..a6094c9` on `main`: 21 commits, 46 files, 4,882 insertions.
- **Orchestrator checks:** before this report was written, all four critical findings were confirmed against the code and the evidence:
  - C1 by reading `services/access/src/jobs.mjs:150-156` and `store.mjs:9,108,128-131`;
  - C2 by reading the script's scope check against `services/access/src/auth.mjs:20-21,44-46`;
  - C3 from `evidence/M3/raw/stack.txt`: every container `started_at` 09:17:22–35Z, after the recreate, and the gateway log scan `lines=15 request_records=7`;
  - C4 by reading `scripts/m3/pi-tailscale.sh:24-25,70-71`.
- **Checks on the Pi (10:47Z):**
  - The installed keyring `/usr/share/keyrings/tailscale-archive-keyring.gpg` holds one public key, `2596A99E…F5868`, so W9's scenario did not occur on this install.
  - Tailscale is `Running` with one peer and Serve not configured.
  - No `.ts.net` name appears anywhere under `evidence/M3/`.
- **Adaptation:** the environment has no team-creation or task tools, so the agents were spawned directly with the Agent tool and reported by message.

## Code Review: M3 — authorized REST, durable jobs and agent access

### Summary
Three specialist agents reviewed the M3 changeset (1 debugger, 1 code auditor, 1 verification reviewer, all on Opus 5.5). The gateway's foundation holds:
- guarded single-statement transitions with their events;
- receipts committed before any answer;
- an exact `delivered` flag;
- marker reconciliation through a narrowly privileged SECURITY DEFINER lookup;
- archive writes fsynced before their rows;
- principal-scoped lookups.

Four critical defects must be fixed before acceptance:
- a ledger error after a claim leaves a SUBMITTING row that stops all asynchronous dispatch;
- a token-script typo freezes the client registry, so a later revocation reports success and does nothing;
- X01 scans only the gateway container started after the recreate;
- the tailnet name can reach committed evidence unseen.

**Scope (so the reader knows what was and wasn't reviewed):**
- **The large-changeset guard triggered** (46 files, 4,882 lines).
  - **Tier 1, full review:**
    - `services/access/server.mjs`, `client.mjs`, `Dockerfile` and `src/*.mjs`;
    - `deploy/compose.yaml`, `deploy/nuq-postgres/fcpi-platform-schema.sql` and its initdb script, `deploy/policies/capabilities.json`;
    - `scripts/fcpi`;
    - `scripts/m3/pi-client-token.sh`, `pi-init-m3.sh`, `pi-platform-db.sh`, `pi-tailscale.sh`, `pi-up-m3.sh` and `verify.mjs`.
  - **Tier 2, skimmed by DB1 and CA1 and fully reviewed by TV1:** the remaining `scripts/m3/*` drivers and collectors (`e2e.mjs`, `sdk-compat.mjs`, `tailnet-check.mjs`, `route-shapes.mjs`, `port-probe.mjs`, `pi-*.sh`, `lan-probe.sh`, `build-lock.mjs`, `rebuild-gateway.sh`), plus `services/access/test/*`, `tests/contracts/m3-gateway.test.mjs`, `tests/fixtures/m3/*` and `deploy/policies/egress.json`.
  - **Tier 3, acknowledged only:** `deploy/secrets.template`, `deploy/versions.lock.json`, `services/access/package-lock.json` and everything under `evidence/`.
  - Confidence: high on Tier 1 and on the verification tooling; false negatives possible in the Tier 2 service tests.
- **Out of scope per the review's context:**
  - MCP (M4);
  - search, extraction and providers (M5–M7);
  - the close-out documents not yet written;
  - Tailscale's live association, which was then awaiting the owner.
- **Not run by the agents:** the test suite, linters and builds. DB1 and CA1 ran read-only `node -e` probes to confirm behaviour.
- **Paths:** `apps/api/…` paths are files in the pinned upstream tree (`7666c1f9` with `patches/` applied). `apps/js-sdk/…` paths are in the pinned client, @mendable/firecrawl-js 4.31.1.

### 🔴 Critical Issues (Must Fix)

1. **C1 — A SUBMITTING row left by the running process is never recovered, so all dispatch stops** - `services/access/src/jobs.mjs:29-57, 148-163`, `services/access/src/store.mjs:9, 108, 127-132` _(corroborated: CA1 as critical, DB1 as a warning; CA1's trace kept)_
   - Problem: Orphaned SUBMITTING rows are handled only in `prepare()`. It runs once per process (`orphansHandled`) and only for rows whose `submitter IS DISTINCT FROM` this instance. So any exception between `claimNext`'s COMMIT and the `mark*` call that records the answer leaves the row SUBMITTING under the live instance. Such exceptions include a PostgreSQL restart, a pool `connectionTimeoutMillis` expiry, a `statement_timeout`, or a COMMIT whose reply is lost. The row is never moved to SUBMISSION_UNCERTAIN.
   - Risk (CWE-667): the failure unfolds in this order.
     1. A crawl is claimed and POSTed, and the core creates it.
     2. nuq-postgres restarts, so `markSubmitted` rejects and `tick_failed` is logged.
     3. On every later tick `prepare()` returns early. `claimNext` counts the row in `UPSTREAM_ACTIVE` and returns null.
     4. No queued job is ever submitted again. The stuck job answers `200 status:"scraping" completed:0` for good, and its crawl is never archived. Once the 20 open-job cap fills, every submission is refused with 503 OVERLOADED. The TCP-only healthcheck never restarts the container.
     5. A manual restart after NuQ's cleaner has deleted the marker rows finds no group, so it requeues after the settle window and submits the job a second time. That breaks "no duplicate logical submission" and loses the first run's results.
     
     K1–K5 kill the gateway and the core, never PostgreSQL, so this path is untested.
   - Fix: within one process, `dispatchOne` always finishes inside its own step of the serial chain. Any SUBMITTING row seen at the start of a step has therefore been abandoned, whichever instance claimed it. Handle such rows on every round:
     ```js
     // services/access/src/store.mjs
     async orphanSubmitting() {
       const ids = (await q("SELECT id FROM fcpi_platform.job WHERE state = 'SUBMITTING'")).rows.map((r) => r.id);
       for (const id of ids) await moveTx(id, ["SUBMITTING"], "SUBMISSION_UNCERTAIN", {}, "the submission's answer was never recorded");
       return ids.length;
     },
     // services/access/src/jobs.mjs: drop orphansHandled; prepare() runs on every tick and kick
     async function prepare() {
       const n = await store.orphanSubmitting();
       if (n) say({ action: "orphaned_submissions", count: n });
     }
     ```
     `markSubmitted` already accepts SUBMISSION_UNCERTAIN, and the settle window is keyed on `submit_started_at`, so an in-doubt POST is reconciled by its marker before any resubmission. Add a contract test:
     - put the fake core in `hang` mode;
     - `pg_terminate_backend` the gateway's connections, then release the core;
     - assert that the job reaches QUEUED without a restart, with one marker group.

2. **C2 — The token script accepts scope lists the gateway rejects, which freezes the registry, stops revocations silently and crash-loops the gateway on restart** - `scripts/m3/pi-client-token.sh:36-37`, `services/access/src/auth.mjs:20-21, 44-46` _(DB1)_
   - Problem: the script checks scopes with `^[a-z,]+$` and then loops over `${scopes//,/ }`, and bash word splitting drops empty items. So `read,`, `,read` and `read,,scrape` pass and are written to the registry. The gateway splits `read,` into `["read", ""]`, rejects the whole file, and `refresh()` keeps the last good set.
   - Risk:
     1. `pi-client-token.sh create agent2 owner read,scrape,` prints `created agent2 …`. The gateway logs `clients_rejected`, and agent2's token never works.
     2. `pi-client-token.sh revoke agent1` for a leaked token prints `revoked agent1`. The new file still holds the bad line, so it is rejected too, and agent1's token keeps authenticating (spec §20.3).
     3. On the next restart, `refresh(true)` with `seen === null` throws at module top level, and `restart: unless-stopped` crash-loops the only host-published service.
   - Fix: make the script's check the parser's, and refuse to rename a candidate registry the gateway would reject:
     ```bash
     # scripts/m3/pi-client-token.sh, create
     [[ $scopes =~ ^[a-z]+(,[a-z]+)*$ ]] || die "scopes must be a comma list of scope names, with no empty entries"
     # replace(), before the mv
     sudo -n awk -v ok=" $SCOPES " '!/^[[:space:]]*(#|$)/ {
         if ($0 !~ /^[a-z0-9]{1,32} [a-z0-9][a-z0-9-]{0,62} [a-z]+(,[a-z]+)* sha256:[0-9a-f]{64}$/) bad = 1
         n = split($3, s, ","); for (i = 1; i <= n; i++) if (index(ok, " " s[i] " ") == 0) bad = 1 }
       END { exit bad }' "$tmp" || { sudo -n rm -f -- "$tmp"; die "the new registry would not parse; nothing changed"; }
     ```

3. **C3 — X01's gateway-log condition reads only the container started after the recreate, and no check reads the token or Authorization counts** - `scripts/m3/verify.mjs:452-455`, `scripts/m3/pi-collect-stack.sh:81-88`, `scripts/m3/pi-persistence.sh:55-72` _(TV1)_
   - Problem: `pi-persistence.sh` force-recreates all services, the access gateway included, and saves only the core's log first. `pi-collect-stack.sh` then scans `docker logs` of the new gateway, so the scan covers 15 lines and 7 requests against a ledger of 70 jobs. The log of the gateway that served every earlier phase (auth, sync, jobs, cancel, overload, crash, expiry, cli, sdk-compat) is discarded unscanned. The collector also counts `fcpi_…` tokens, `Bearer`, `Authorization` and target URLs, but `gatewayLog` reads only the three Cloud patterns.
   - Risk: suppose the gateway logged an Authorization header or tried a Cloud URL during the jobs phase. The recreate destroys that log, the new container's 7 requests count 0, and X01 passes. So AC24 (zero Cloud attempts in instrumented logs) and AC01's "no secret in logs" pass without evidence for the part of M3 that matters.
   - Fix: scan every gateway instance before it is replaced, and require every pattern to be 0 in each scan:
     ```bash
     # scripts/m3/pi-gateway-log-scan.sh (new; pi-collect-stack.sh's gateway_log_scan and pi-persistence.sh before the recreate call it)
     c=$(sudo -n docker compose -p fcpi ps -q access-gateway)
     L=$(sudo -n docker logs "$c" 2>&1)
     echo "instance=$(sudo -n docker inspect -f '{{.Id}}' "$c" | cut -c1-12) created=$(sudo -n docker inspect -f '{{.Created}}' "$c") lines=… request_records=…"
     for pat in 'firecrawl\.dev' 'firecrawl\.com' 'mendable' 'fcpi_[a-z0-9]+_[0-9a-f]{64}' 'Bearer [A-Za-z0-9]' '[Aa]uthorization' 'm3\.fixture\.fcpi\.test'; do …; done
     ```
     ```js
     // scripts/m3/verify.mjs X01: both scans clean, the earlier instance created before the window opened, two distinct instances
     const gatewayLog = Date.parse(pre.k.created) < open && +pre.k.request_records > 0 && pre.clean && +post.k.request_records > 0 && post.clean && pre.k.instance !== post.k.instance;
     ```
     The gateway killed by the crash phase is a third instance, so the scan must also run before `gwKill()`, or X01 must name every instance and require a clean scan for each.

4. **C4 — The tailnet name can reach committed evidence through `pi-tailscale.sh status`, and X05 cannot see it** - `scripts/m3/pi-tailscale.sh:24-25, 70-71`, `scripts/m3/verify.mjs:533-535` _(TV1)_
   - Problem: `redact()` works only while the live `.Self.DNSName` is known, and falls back to `cat` when `name` is empty. The `origins_file` section then prints the stored origin, and its `sed` replaces only the machine label. `tailnet-check.mjs` hides names the same way, from the origins file.
   - Risk: after `tailscale logout`, a lost login, or an origins file naming a different tailnet, BackendState is not Running and `.Self.DNSName` is empty. `status` then writes `https://<machine>.tailXXXX.ts.net:8443` to `evidence/M3/raw/tailscale-status.txt`. P02 fails, but §27 keeps the evidence, and X05 checks only the LAN address, the /24 and the SSH target. So the tailnet name is committed (§33.2).
   - Fix: redact by the name's shape rather than its live value, and give X05 a shape rule with a positive control:
     ```bash
     # scripts/m3/pi-tailscale.sh
     redact() { sed -E 's/[A-Za-z0-9-]+\.[A-Za-z0-9-]+\.ts\.net/<pi-tailnet-name-host>/g; s/[A-Za-z0-9-]+\.ts\.net/<pi-tailnet-name>/g'; }
     ```
     ```js
     // scripts/m3/verify.mjs X05 RULES, with a synthetic control line; the contract test's synthetic origins allowed
     ["tailnet-name", /\b[a-z0-9-]+\.ts\.net\b/i],
     ```

### 🟡 Warnings (Should Fix)

1. **W1 — Upstream's `Access-Control-Allow-Origin: *` passes through the synchronous routes** - `services/access/src/upstream.mjs:7, 70-72` _(corroborated: CA1 and DB1)_
   - Problem: `forward()` copies every upstream header except hop-by-hop ones. The pinned core runs `app.use(cors())` (`apps/api/src/index.ts:88`), so every `/v2/scrape` and `/v2/map` answer carries `Access-Control-Allow-Origin: *`. That contradicts `server.mjs:4` ("no CORS headers are ever sent") and N01's expectation. It is not exploitable, because a foreign Origin is refused with 403 first. It went unseen because the fake core never sends the header and N01 probes only `/platform/v1/status`.
   - Suggestion: forward an allowlist of headers (content type and length), make the fake core send `access-control-allow-origin: *`, and record the header on the live scrape and map answers for N01.

2. **W2 — The validator reads option specs through the prototype chain** - `services/access/src/validate.mjs:32, 51, 75-80` _(corroborated: CA1 and DB1)_
   - Problem: `fields[k]`, `manifest.refused[k]`, `manifest.formats.refused[type]` and `spec.refused?.[v]` resolve inherited members. For example:
     - `{"url":"https://example.com","constructor":1}` throws a plain `Error`, which is answered 503 PLATFORM_UNAVAILABLE with `retry-after: 10`, an invitation to retry;
     - `formats:["toString"]` and `proxy:"constructor"` produce refusal messages containing `function …() { [native code] }`.
     
     This is CWE-20. There is no prototype pollution, because `__` keys are refused.
   - Suggestion: add `const own = (o, k) => (o && Object.hasOwn(o, k) ? o[k] : undefined)` and use it for every client-key lookup. Add these bodies to the unit tests, expecting 400 BAD_REQUEST.

3. **W3 — One failing step stalls the whole round, and archival has no attempt budget** - `services/access/src/jobs.mjs:59-146, 158-163` _(corroborated: CA1 and DB1)_
   - Problem: `tick` runs `resolveUncertain`, `pollRunning` and `dispatchOne` without isolating one job from another, so any throw aborts the rest of the round. Examples are a lost grant, a `\u0000` in upstream errors, or ENOSPC from `archive.put`. `finalize` also retries a persistently failing page or `put` forever, and once upstream reports `completed` the deadline cancel gets 409. The RUNNING row holds the one upstream slot until the core forgets the job (about 24 h). `failLost` then marks results that were archived as `UPSTREAM_STATE_LOST`.
   - Suggestion:
     - give each job in the loops its own try/catch that logs and continues;
     - give archival a failure budget: past the deadline plus a grace period, finish the job as FAILED or PARTIAL with `ARCHIVE_INCOMPLETE` and the documents already archived, freeing the slot and recording why.

4. **W4 — A failed per-item errors fetch finalizes the job as SUCCEEDED, permanently** - `services/access/src/jobs.mjs:136-138` _(DB1)_
   - Problem: `.catch(() => null)` on the `/errors` fetch means a timeout, reset, 5xx or 404 leaves the list empty. The job then becomes SUCCEEDED instead of PARTIAL. `/errors` is served from `job.errors` afterwards, so the per-item failures are lost. This is the swallow-and-continue pattern §21 forbids.
   - Suggestion: treat it like an interrupted page fetch. On 404 call `failLost`; on any other failure log `archive_interrupted` and return, so the next poll retries.

5. **W5 — The official client polls a rejected job for up to 7 days** - `services/access/server.mjs:165-166` _(DB1)_
   - Problem: a job acknowledged 200 while it waited for the single upstream slot, then refused by the core (FAILED, no `upstream_id`), is served as HTTP 200 with `success: false`. In the pinned client:
     - `getCrawlStatus` throws `SdkError(status=200)`;
     - `isRetryableError` falls through to "retry on unknown errors" (`apps/js-sdk/firecrawl/src/v2/utils/errorHandler.ts:48`);
     - `crawl()` and `batchScrape()` then poll every 2 s until the job expires with 410.
     
     The single upstream slot makes this deferred refusal routine.
   - Suggestion: serve every finished job with `success: true`, keeping `status: "failed"` and `error`, as the other FAILED jobs are served.

6. **W6 — Status reads of a running job buffer up to 16 MiB each with no concurrency bound, under a 160 MiB cap** - `services/access/server.mjs:143-156` _(CA1)_
   - Problem: for QUEUED or RUNNING jobs, each read buffers upstream's page up to `archiveResponseMaxBytes` (16 MiB), then concatenates, decodes, parses and re-serializes it. That is several live copies, roughly 50–80 MiB per read. Synchronous requests are bounded by `maxSyncInFlight`, but these reads have no in-flight limit. Two polls, or one poll during `finalize`, can reach an OOM kill, which interrupts submissions and turns them uncertain.
   - Suggestion: cap the status path at `L.results.pageMaxBytes`, allow one or two buffered reads at once (503 OVERLOADED with `retry-after` beyond that), and measure the peak under that load (see W7).

7. **W7 — M01 reads cgroup counters that the recreate had just reset** - `scripts/m3/verify.mjs:562-570`, `scripts/m3/pi-collect-stack.sh:53-59` _(corroborated: CA1 and TV1)_
   - Problem: `memory.peak` and `oom_kill` belong to each container's current cgroup. The crash phase's kill and the persistence recreate replace those cgroups, so the recorded peak (about 31 MiB of 160) covers a container about 40 s old. An OOM kill during `jobs`, the sync overload or `expiry` cannot be seen. The check claims "after every live phase". This regresses M2's before-and-after pattern (M2 W15).
   - Suggestion: sample `memory.peak`, `memory.max`, `oom_kill`, `/proc/vmstat oom_kill`, MemAvailable and `StartedAt` for the gateway and the core at the end of each e2e phase and before each kill or recreate. Require every sample under its cap with `vmstat oom_kill` constant, and fail when a phase has no sample.

8. **W8 — X04 accepts any ruleset change, never checks the guard's contents, and will misattribute Tailscale** - `scripts/m3/verify.mjs:122-123, 506-508`, `scripts/m3/pi-collect-stack.sh:68-69` _(corroborated: CA1 and TV1)_
   - Problem: every `nft_ruleset_sha256` change and every new `ip filter|nat|raw` chain is attributed as "Docker's rules for M3's bridge", and only table names are compared. A weakened `inet fcpi_guard` rule would pass, and M2's guard-file hash check is not carried forward. After the owner-approved Tailscale install, `ts-*` chains are silently attributed to Docker. The tailscaled unit, its listener and raw tailnet addresses in `stack.txt`'s listeners are unexplained.
   - Suggestion:
     - diff M3's redacted ruleset against `evidence/M2/raw/nft-ruleset.txt` and attribute each changed rule (to `fcpi-platform`/`10.231.7.0/24`, or to Tailscale's `ts-*` chains);
     - carry forward `guard_file_sha256` against `deploy/host/fcpi-guard.nft`;
     - attribute Tailscale explicitly, and redact tailnet addresses in `pi-collect-stack.sh`.

9. **W9 — The Tailscale key check reads only the first fingerprint** - `scripts/m3/pi-tailscale.sh:31-32, 36` _(CA1)_
   - Problem: `awk '$1 == "fpr" {print $10; exit}'` checks the first key, then installs the whole file as the repository's `signed-by` keyring. A download with a second public key appended would pass, and apt would trust that key (CWE-347, CWE-494). The installed keyring holds one key (checked at 10:47Z), so this install was not affected.
   - Suggestion: require exactly one `pub` record, and every `fpr` to be the primary's or one of its subkeys', before comparing.

10. **W10 — Joining the tailnet exposes the host's own listeners to tailnet peers, and nothing measures it** - `scripts/m3/pi-tailscale.sh:47`, `scripts/m3/tailnet-check.mjs` _(CA1)_
    - Problem: `tailscale up` without `--shields-up` or a tailnet policy lets every tailnet peer reach every host service bound to all addresses, at the Pi's tailnet address: sshd, Pi-hole, Mosquitto, airdb. Spec §20.1 scopes the Tailscale client to the access gateway, and CLAUDE.md §9 protects unrelated services. `tailnet-check.mjs` tests only :8443. This is live: the Pi joined the tailnet during M3 and has one peer.
    - Suggestion: limit inbound tailnet traffic to the Serve port, by a project-owned rule or by a tailnet policy, and record which. Add a tailnet-side probe of the host's other ports to `tailnet-check.mjs`, so the exposure is measured.

11. **W11 — The implementation and the spec disagree on cursors** - `services/access/server.mjs:136, 164`, `docs/FIRECRAWL_PI_SPEC.md:479` _(CA1)_
    - Problem: spec §16.2 requires cursors that are "opaque, owner-bound, and stable across gateway/MCP restarts". The gateway issues `?skip=N&limit=M` offsets in upstream's native `next` URLs, which the pinned client follows verbatim:
      - they are owner-bound through the principal-scoped lookup;
      - they are stable because they index archive ordinals;
      - they are not opaque.
    - Suggestion: make both canonical documents state the offset cursors and why (the native client follows `next`), or implement opaque cursors.

12. **W12 — Critical-path branches without tests** - `tests/contracts/m3-gateway.test.mjs`, `services/access/test/*` _(CA1)_
    - Problem: none of these has a test:
      - `store.sweep` with archived documents;
      - metadata deletion at 30 days and idempotency-key expiry;
      - `STORAGE_QUOTA` admission;
      - `finalize`'s `TOO_LARGE` fallback, `ARCHIVE_DOCUMENT_TOO_LARGE` skip, `JOB_DEADLINE_EXCEEDED` and archive-error PARTIAL;
      - reconciliation with more than one marker group;
      - the RUNNING path's `RESULT_TOO_LARGE`;
      - a ledger failure mid-dispatch (C1);
      - prototype-named keys (W2).
      
      The fake core is also mocked past W1.
    - Suggestion: add a contract test for each, reusing the fake core's modes, extra marker rows, and `UPDATE … SET results_expire_at/metadata_expire_at` followed by a sweep.

13. **W13 — J05 counts about 13 of the ledger's 70 jobs yet claims "every job the live tests submitted"** - `scripts/m3/verify.mjs:320-331` _(TV1)_
    - Problem: only records carrying `marker_groups` are counted. That leaves out the auth owner job, overload's crawl, beta's job and every sdk-compat job, `start_twice_same_key` included. That test is the "no duplicate logical submission from retry" criterion.
    - Suggestion: add a `ledger` phase after the crash phase and before expiry, while NuQ still holds the rows. It lists every job created in the window with its state, `upstream_id` and distinct marker-group count. J05 then requires at most one group per job, exactly one where an upstream id exists, and none for a job cancelled while queued.

14. **W14 — Conditions that pass on missing values** - `scripts/m3/e2e.mjs:228, 230, 254`, `scripts/m3/sdk-compat.mjs:58`, `scripts/m3/verify.mjs:238, 253-254, 315-317` _(TV1)_
    - Problem: three conditions pass when their input is absent:
      - (a) `same_id` is `x === y`, which is true when both ids are undefined, and J04 never checks the sdk-compat run's `end`.
      - (b) A04's `retry_after.filter(Boolean).every(…)` passes on two 503s with no Retry-After.
      - (c) A03's `contains_alpha_job === false` has no positive control: a list route answering another shape passes.
    - Suggestion:
      - record both ids and require equal UUIDs;
      - require exactly two positive Retry-After values on the 503s;
      - record and require `alpha_job_list_control`.

15. **W15 — A05 and J07 compare workstation time with Pi time** - `scripts/m3/e2e.mjs:189, 204, 275-281`, `scripts/m3/verify.mjs:345-346` _(TV1)_
    - Problem: `docker logs --since <workstation now>` and `cancel_at` (the workstation clock) are compared with the fixture's Pi-clock `utc`. Clock skew can make a late page look timely, or put refused requests before `--since` so they count 0. A missing `cancel_at` makes `cut` NaN, so `late=[]` and J07 passes.
    - Suggestion: count the unique `refused=` queries over the whole fixture log, take the cancel time on the Pi, and require `Number.isFinite(cut)`.

16. **W16 — N03 treats an empty address as a denied port** - `scripts/m3/pi-port-probe.sh:22, 27-31`, `scripts/m3/verify.mjs:374-383` _(TV1)_
    - Problem: when `ip_on` returns empty (for example, a renamed service), the target becomes `:6379`. The probe then tests the prober's own loopback and records `refused` or `closed`, and N03 passes.
    - Suggestion: make the collector exit on an empty address, and make N03 require a non-empty `10.231.x.y` host in every target.

17. **W17 — X01's core-log condition can be met by M1 and M2 captures alone** - `scripts/m3/verify.mjs:447-451, 458` _(TV1)_
    - Problem: `recs.length >= 3` counts every stored instance under `core-instances` (14 today, most from earlier milestones). An M3 core instance replaced without a capture leaves the count unchanged.
    - Suggestion: require a record for each M3 core instance id, taken from persistence's `before` and `after` ids and from the core the expiry phase replaces.

18. **W18 — Nothing ties the evidence to the code at HEAD** - `scripts/m3/verify.mjs:141-158, 628` _(TV1)_
    - Problem: G01 checks that the running image is the last one built, but not that its build commit, or any phase's `source_commit`, matches HEAD for the code that ran. After `/address` changes `services/access`, stale evidence still passes with `code_dirty=false`.
    - Suggestion: for the image's commit and each phase's `source_commit`, require `git diff --quiet <c> HEAD -- services/access deploy scripts/m3 tests/contracts/m3-gateway.test.mjs tests/fixtures/m3`.

19. **W19 — R01 trusts the collector's verdicts, and one of its conditions can never fail** - `scripts/m3/verify.mjs:180-190`, `scripts/m3/route-shapes.mjs:47-48, 53, 66` _(TV1)_
    - Problem: `FOUND`, `REGISTERED` and `served` are labels written by the collector, although the raw registrations sit in the same file. `unservedServed` looks for an `unserved` line matching a manifest route exactly, which the collector never produces.
    - Suggestion: recompute FOUND and REGISTERED from the registrations. Replace `unservedServed` with a condition that fails when an unserved client call shares a served route's path under another method or suffix.

20. **W20 — V01 misses findings carried over from earlier reviews and accepts deferral to any milestone** - `scripts/m3/verify.mjs:601-615` _(TV1)_
    - Problem: `Deferred to M\d` accepts "Deferred to M2" or "Deferred to M3". V01 also never checks that a finding an earlier review deferred to M3 (M1's R9) has an outcome here, which CLAUDE.md §30 requires.
    - Suggestion: accept only `Deferred to M[4-9]`. Collect the `Deferred to M3` rows from `evidence/M{0,1,2}/review/*.md` and require each id in this report's carried-over table.

21. **W21 — A03's "no restart" condition cannot see a manual restart** - `scripts/m3/verify.mjs:240-241`, `scripts/m3/e2e.mjs:156` _(TV1)_
    - Problem: `RestartCount` counts only restarts made by the restart policy. A revocation that relied on `docker restart` would show 0.
    - Suggestion: record `State.StartedAt` before the revoke and after the refusal, and require them to be equal.

22. **W22 — A failure partway through leaves project containers stopped or paused, or leaves transient containers behind** - `scripts/m3/e2e.mjs:311-391, 447-452`, `scripts/m3/pi-gateway-tests.sh:20-41`, `scripts/m3/pi-mount-check.sh:42-47` _(TV1)_
    - Problem:
      - a throw after `pause`, `stop` or `gwKill()` leaves the core paused or stopped, or the gateway down, because a kill counts as a manual stop;
      - the detached test PostgreSQL has no trap;
      - if the image wrongly starts listening, the mount check's `docker run` hangs, which is the very defect it tests for.
    - Suggestion:
      - add a `finally` in e2e that restores and waits for health, and records a `restore` section;
      - add an EXIT trap in `pi-gateway-tests.sh`;
      - name the mount-check container, bound it with `timeout`, and remove it in a trap.

23. **W23 — Error texts can put the SSH command into evidence** - `scripts/m3/e2e.mjs:449`, `scripts/m3/verify.mjs:641, 645` _(TV1)_
    - Problem: an `execFileSync` failure message contains `ssh -i <key path> … <target>`, and e2e writes it unredacted. The runner redacts the target and the LAN address, but not the key path or `$HOME`.
    - Suggestion: redact `PI_SSH_TARGET`, `PI_SSH_KEY`, `PI_LAN_ADDRESS` and `HOME` inside e2e's `out()` and in the runner.

24. **W24 — The official-client connection hook covers only `http(s).request`** - `scripts/m3/sdk-compat.mjs:21-28` _(TV1)_
    - Problem: `http.get`, `https.get` and `fetch` bypass the hook, and it is the only instrumentation behind X01's official-client clause.
    - Suggestion: hook `net.Socket.prototype.connect` and `dns.lookup`, and record every destination.

25. **W25 — The revocation tests race a roughly one-second poll** - `services/access/test/auth.test.mjs:44`, `tests/contracts/m3-gateway.test.mjs:365` _(TV1)_
    - Problem: fixed sleeps of 1,100 and 1,200 ms leave 100–200 ms of margin on a loaded Pi.
    - Suggestion: poll for up to 2 s and assert that the observed latency is at most 2,000 ms.

### 🔵 Suggestions (Consider)

1. **S1 — The metadata sweep is not transactional** - `services/access/src/store.mjs:169-173`, `deploy/nuq-postgres/fcpi-platform-schema.sql:55-88` _(corroborated: CA1 and DB1)_
   - Current: the job row is deleted, then its events and documents in separate statements. An interruption leaves orphan rows no later sweep finds.
   - Better: delete the three for each job inside one `tx`, or add `ON DELETE CASCADE` foreign keys.
2. **S2 — The role-password step lacks `log_min_error_statement = panic`** - `scripts/m3/pi-platform-db.sh:26`, `deploy/nuq-postgres/initdb/040-fcpi-platform.sh:9` _(CA1)_
   - Current: only `log_statement = 'none'` is set, and the initdb path sets nothing. A failing `ALTER ROLE … PASSWORD` would be logged with the password (CWE-532).
   - Better: follow M1's `fcpi-core-role.psql`, which sets both.
3. **S3 — A failed registry write leaves a label that can neither be created nor revoked** - `scripts/m3/pi-client-token.sh:43-49` _(CA1)_
   - Current: the token file is linked before the registry is replaced, so if `replace` fails, only a manual `rm` recovers.
   - Better: remove the new token file when `replace` fails.
4. **S4 — PostgreSQL accepts any role from the gateway's network** - `deploy/compose.yaml` (the `platform` network) _(CA1)_
   - Current: the image's default `pg_hba` accepts every role from any address with scram.
   - Better: a `pg_hba` entry allowing only `fcpi_gateway` from `10.231.7.0/24`.
5. **S5 — Nothing enforces the rollback rule on schema versions** - `deploy/nuq-postgres/fcpi-platform-schema.sql` _(CA1)_
   - Current: M3's Rollback forbids an older binary against an incompatible platform schema, but nothing records or checks the version.
   - Better: add a one-row `schema_version` that the gateway checks at startup, when the first migration lands.
6. **S6 — Interval values are interpolated into SQL** - `services/access/src/store.mjs:60, 87, 91, 119` _(CA1)_
   - Current: safe only because `checkManifest` validates them as integers.
   - Better: `now() + $n * interval '1 day'`.
7. **S7 — Gateway-made error entries do not match the native shape, and truncation is silent** - `services/access/src/jobs.mjs:112, 137-138` _(CA1)_
   - Current: `{code, error}` entries are mixed into the native list, and `slice(0, 1000)` truncates without a record.
   - Better: give them the native fields and record the truncation count.
8. **S8 — The uncertain-submission answer assumes the client sent a key** - `services/access/server.mjs:86-89` _(CA1)_
   - Current: the answer says to "retry with the same idempotency key" when none was sent.
   - Better: when no key was sent, point only to the receipt.
9. **S9 — The storage quota is checked only at admission** - `services/access/src/store.mjs:83-84` _(CA1)_
   - Current: archival never rechecks free space.
   - Better: a free-space floor before `archive.put`, ending archival with `STORAGE_QUOTA`.
10. **S10 — Shutdown keeps dispatching** - `services/access/server.mjs:309` _(corroborated: CA1 and DB1)_
    - Current: the job timers run through the 20 s grace period, so a claim can be killed mid-POST.
    - Better: clear the job timers before `server.close`.
11. **S11 — A new shard directory is not fsynced into its parent** - `services/access/src/archive.mjs:30-36` _(CA1)_
    - Current: `put` fsyncs the shard, not `results/`, after `mkdir` creates a new shard.
    - Better: also fsync `results/` when `mkdir` created the shard.
12. **S12 — Each streamed document adds listeners to the shared response** - `services/access/server.mjs:172-175` _(DB1)_
    - Current: one `pipeline(src, res, { end: false })` per document. 100 documents left 200 `close` and 200 `error` listeners on Node 26, and stale close handlers fire into finished pipelines.
    - Better: one pipeline over an async generator.
13. **S13 — `finalize` advances by `docs.length` instead of upstream's cursor** - `services/access/src/jobs.mjs:117-133` _(DB1)_
    - Current: upstream counts jobs without a return value in `iteratedOver` but leaves them out of `data` (`apps/api/src/controllers/v2/crawl-status.ts:296-312`). An all-empty page ends archival early.
    - Better: take `skip` from `next`, and end on its absence.
14. **S14 — A cancelled RECEIVED job stays open while another job is active** - `services/access/src/store.mjs:108-113` _(DB1)_
    - Current: `claimNext` returns at the active-count check before the loop that closes cancelled rows.
    - Better: close cancelled RECEIVED rows before that check.
15. **S15 — P02 treats missing files as a credential block** - `scripts/m3/verify.mjs:583` _(TV1)_
    - Current: BLOCKED_CREDENTIAL whenever the Tailscale files are absent.
    - Better: require recorded evidence of the blocking state, otherwise NOT_RUN.
16. **S16 — P01's vantage is a constant** - `scripts/m3/e2e.mjs:446`, `scripts/m3/verify.mjs:576` _(TV1)_
    - Current: the check matches a hard-coded string.
    - Better: record `process.platform` and the forward's pid and exit status.
17. **S17 — X02 has weak spots** - `scripts/m3/verify.mjs:464-476`, `scripts/m3/pi-persistence.sh:25-35` _(TV1)_
    - Current: `postgres_read === V` is true when both are undefined, `files=0` passes on both sides, and events and idempotency rows are counted, not hashed.
    - Better: require `!!V` and archive files at least the ledger's documents, and hash the rows.
18. **S18 — J06 accepts any past cleaner run** - `scripts/m3/verify.mjs:337`, `scripts/m3/e2e.mjs:406` _(TV1)_
    - Current: any past successful run of `nuq_group_crawl_clean` satisfies it.
    - Better: require a run that started after the expiry UPDATE, on the database clock.
19. **S19 — A04 accepts any 400 on the limit cases** - `scripts/m3/verify.mjs:251` _(TV1)_
    - Current: status only.
    - Better: require `code === "BAD_REQUEST"` and no new receipt.
20. **S20 — `records()` would merge two runs of one phase** - `scripts/m3/verify.mjs:38-50` _(TV1)_
    - Current: a transcript appended to with `>>` reads as one run.
    - Better: require exactly one `meta` and one `end` record.
21. **S21 — X05 hard-codes the token labels** - `scripts/m3/verify.mjs:527` _(TV1)_
    - Current: `owner m3a m3b m3ro`.
    - Better: hash every `clients/*.token` and require at least four.
22. **S22 — Contract-suite coupling and weak assertions** - `tests/contracts/m3-gateway.test.mjs:350, 384, 434-454, 466-471, 513-520` _(TV1)_
    - Current: some tests depend on earlier tests' jobs. The startup test asserts only a non-zero exit. The admission test's Retry-After is not asserted. K3 depends on a 3 s settle window.
    - Better: give each test its own data, assert the refusal message and Retry-After, and widen the settle window.
23. **S23 — Collectors that change or print what they should not** - `scripts/m3/route-shapes.mjs:27`, `scripts/m3/lan-probe.sh:12` _(TV1)_
    - Current: `git add -A` changes the prepared tree's index, and lan-probe prints the LAN address and relies on a pipe to redact it.
    - Better: use a temporary `GIT_INDEX_FILE`, and print `<pi-lan-address>` directly.
24. **S24 — Weak bindings in the drivers** - `scripts/m3/e2e.mjs:334, 353`, `scripts/m3/sdk-compat.mjs:37-41`, `scripts/m3/pi-gateway-tests.sh:23-24` _(TV1)_
    - Current: K2 and K3 bind "the latest SUBMITTING job", sdk-compat skips the free-port check, and `pg_isready` over the socket can pass during init.
    - Better: look jobs up by key, check the port, and use `pg_isready -h 127.0.0.1`.

### ✅ Good Practices
- Tokens are stored only as SHA-256 hashes, and every stored hash is compared in constant time with no early exit.
- The registry is replaced atomically and reloaded on inode, mtime or size.
- Tokens never appear on a command line.
- Every transition is one guarded `move()` with its event row in the same transaction.
- Admission and claiming share one advisory lock, so the open-job caps and the single upstream slot hold across concurrent requests.
- Each submission opens its own connection, so `delivered` is exact. Every ambiguous outcome is SUBMISSION_UNCERTAIN, reconciled by marker and settle window; nothing is resubmitted blindly. 502 is avoided because the client retries it.
- The marker lookup is a SECURITY DEFINER SQL function owned by a NOLOGIN role that can read only NuQ's two job tables, with a pinned `search_path`. The gateway's role has DML only.
- Archive writes go to a temp file, then fsync, rename and directory fsync, and only then the row. Sweep and archival share the serial chain, and `put` refreshes an existing copy's mtime.
- Every job lookup is scoped by principal; another principal's job is indistinguishable from an unknown id. Upstream requests are rebuilt from scratch.
- The capability manifest drives both validation and the client's URLs. Refused options are named before any work, and `checkManifest` rejects caps above the spec's limits.
- Configuration fails closed: unknown `PI_*` keys stop startup, `PI_CLOUD_ACCESS_ENABLED` must be `false`, and the client has no default base URL.
- In the verifier:
  - a missing input gives NOT_RUN;
  - exceptions are FAIL with a classification;
  - X05's positive controls must fire every rule over 14 distinct secret hashes computed on the Pi;
  - the guard window is bound by the table handle;
  - the crash matrix has real controls.

### Verdict
[x] ❌ Request Changes (critical issues)
[ ] ⚠️ Approve with Suggestions
[ ] ✅ Approve

## Outcomes

Recorded after `/address`. Every finding was fixed; none was rejected or deferred. Each fix is its own commit, with a test or check that fails without it wherever one could be made.

| ID | Severity | Finding | Outcome | Commits |
|---|---|---|---|---|
| C1 | 🔴 | Abandoned SUBMITTING row stops all dispatch | Fixed: every round moves SUBMITTING rows to uncertain for marker reconciliation; a contract test fails the ledger write mid-dispatch and sees the running process map the job once | `ade6c8d` |
| C2 | 🔴 | Token script accepts scopes the gateway rejects | Fixed: the scope list must have no empty entries, and a registry the gateway would reject is never renamed into place (checked on the Pi against the parser's verdicts) | `3cdb07e` |
| C3 | 🔴 | X01 scans only the post-recreate gateway log | Fixed: both gateway containers are scanned, the one that served every phase before the recreate, for every pattern and with a completeness control | `cc965b3` |
| C4 | 🔴 | Tailnet name can reach evidence unseen | Fixed: names are redacted by shape across the whole status output, and X05 has a tailnet-name rule with its own control | `7f93210` |
| W1 | 🟡 | Upstream's `Access-Control-Allow-Origin: *` passes through | Fixed: only content-type, content-length and retry-after are forwarded; N01 checks the forwarded answers | `cda769f` |
| W2 | 🟡 | Prototype-chain lookups in the validator | Fixed: own-property lookups for every client-named entry, with a unit test | `afaf7c7` |
| W3 | 🟡 | One failing step stalls a round; archival unbounded | Fixed: each job is isolated, and a job still open 30 minutes past its deadline is closed with what was archived | `dfe5d99` |
| W4 | 🟡 | Failed errors fetch finalizes as SUCCEEDED | Fixed: the fetch is retried; errors the core has forgotten are recorded as unknown | `a52127b` |
| W5 | 🟡 | Official client polls a refused job for 7 days | Fixed: finished jobs are served with success true and their failed status | `21c365b` |
| W6 | 🟡 | Unbounded buffered status reads of running jobs | Fixed: pageMaxBytes each, at most maxStatusReadsInFlight at once | `45e416f` |
| W7 | 🟡 | M01 reads counters the recreate reset | Fixed: memory is sampled in every phase and before every kill, stop or recreate; M01 reads every sample and the host's OOM count | `28e164b` |
| W8 | 🟡 | X04 accepts any ruleset change; Tailscale misattributed | Fixed: a rule-by-rule diff against M2 with the guard file's hash and the AFTER snapshot's tie; Tailscale attributed by name; tailnet addresses redacted and scanned for | `ee138e4`, `ab557a4` |
| W9 | 🟡 | Tailscale key check reads only the first key | Fixed: the keyring must hold exactly one primary key, and the installed keyring is measured (one key, Tailscale's) | `b60dfff` |
| W10 | 🟡 | Tailnet peers reach the host's listeners | Fixed: the guard admits only :8443 on tailscale0; measured over the tailnet, no host service answers | `145bc30`, `4efd86f` |
| W11 | 🟡 | Spec requires opaque cursors | Fixed: the spec states the native offset cursors and their owner binding; the orchestration page's snapshot is refreshed | `12a0969` |
| W12 | 🟡 | Critical-path branches without tests | Fixed: contract tests for each listed branch (ledger failure, prototype keys, oversized pages and documents, quota, running-page limit, retention and sweep, deadline, duplicate groups) | `f57eeed`, `ade6c8d`, `afaf7c7`, `a1bbdd8`, `77c8fc5`, `27b5ec9`, `45e416f`, `c642f9e`, `cda769f` |
| W13 | 🟡 | J05 counts a fraction of the jobs | Fixed: every run ends with a ledger snapshot, and J05 reads every job the live runs admitted | `216bbb5` |
| W14 | 🟡 | Conditions that pass on missing values | Fixed: ids are recorded and compared as UUIDs; Retry-After is required on each 503; A03 has its control | `b497c66` |
| W15 | 🟡 | A05 and J07 compare two clocks | Fixed: every compared time comes from the Pi; refused requests are counted over the whole log | `5300369` |
| W16 | 🟡 | N03 reads an empty address as denied | Fixed: the collector stops on an unresolved address; N03 requires named hosts and project addresses | `58c0ae9` |
| W17 | 🟡 | X01's core-log count met by old captures | Fixed: every M3 core instance must have its saved log | `c269849` |
| W18 | 🟡 | Nothing ties evidence to HEAD | Fixed: every deployed commit a record names, and the image's build commit, must match HEAD's code | `e736a71`, `2d0bb60`, `4af7a48` |
| W19 | 🟡 | R01 trusts collector labels; a condition cannot fail | Fixed: verdicts are recomputed from the raw registrations; the new rule found two real gaps, now declared not enabled | `d68c102` |
| W20 | 🟡 | V01 misses carried-over findings | Fixed: deferral only to M4-M9, and every finding an earlier review deferred to M3 needs its own row | `a859029` |
| W21 | 🟡 | A03 cannot see a manual restart | Fixed: the gateway's start time is compared before and after the revocation | `6e19f80` |
| W22 | 🟡 | Failures leave containers stopped or behind | Fixed: every phase ends with a restore; the test runner and the mount check have traps and a bound | `906dd48` |
| W23 | 🟡 | Error texts can carry the SSH command | Fixed: the key path, target, LAN address and $HOME are redacted in the drivers' and the runner's output | `73b7b60` |
| W24 | 🟡 | Official-client hook covers only `request` | Fixed: every socket and name lookup is recorded | `a69920f` |
| W25 | 🟡 | Revocation tests race the reload | Fixed: both poll within the spec's two seconds | `3cf95ee` |
| S1 | 🔵 | Metadata sweep not transactional | Fixed: one statement; a contract test shows a failing sweep leaves the row and its events | `c642f9e` |
| S2 | 🔵 | Role-password step can log the password | Fixed: log_min_error_statement = panic in both password steps (M2's retrieval-role steps had the same gap, fixed beside it) | `69cb947`, `645843e` |
| S3 | 🔵 | Failed registry write strands a label | Fixed: the new token file is removed when the registry is left unchanged | `9d4e73e` |
| S4 | 🔵 | PostgreSQL accepts any role from the gateway's network | Fixed: pg_hba admits only fcpi_gateway from the platform subnet; N06 probes it | `28b10d6`, `b09b633` |
| S5 | 🔵 | Schema version not enforced | Fixed: the ledger records its schema version and the gateway refuses any other | `3015ad1` |
| S6 | 🔵 | Intervals interpolated into SQL | Fixed: every interval is a query parameter | `c0b39e4` |
| S7 | 🔵 | Gateway error entries lack the native shape | Fixed: id, timestamp and url on every entry; a cut list is recorded | `77c8fc5` |
| S8 | 🔵 | Uncertain answer assumes a key | Fixed: the answer says what a retry would do, with a key, without one, or for a read | `d729400` |
| S9 | 🔵 | Quota checked only at admission | Fixed: archival stops at the quota and a free-space floor | `27b5ec9` |
| S10 | 🔵 | SIGTERM keeps dispatching | Fixed: job rounds stop first; a pending submission waits for the next process | `4d5f31c` |
| S11 | 🔵 | New shard directory not fsynced into results/ | Fixed: results/ is fsynced when a shard is created | `d358c9d` |
| S12 | 🔵 | Listeners pile on a streamed page | Fixed: one pipeline per page | `9330357` |
| S13 | 🔵 | Archival advances by page size | Fixed: archival follows upstream's next and ends when it stops moving | `9fed546` |
| S14 | 🔵 | Cancelled waiting job stays open | Fixed: cancelled waiting jobs close before the active-slot check | `a33e5b3` |
| S15 | 🔵 | P02 reads missing files as a credential block | Fixed: a block only from the recorded Tailscale state; otherwise NOT_RUN | `3113be8` |
| S16 | 🔵 | P01's vantage is a constant | Fixed: platform, the forward's life and the answering gateway instance are recorded | `9d32b46` |
| S17 | 🔵 | X02 weak spots | Fixed: a real sentinel, a non-empty archive, and events and idempotency keys hashed | `1e7deed` |
| S18 | 🔵 | J06 accepts any past cleaner run | Fixed: only a run started after the expiry update counts | `abc46b8` |
| S19 | 🔵 | A04 accepts any 400 | Fixed: the exact codes, and no receipt left | `f8c5927` |
| S20 | 🔵 | `records()` merges two runs | Fixed: one meta and one end per transcript | `43f18df` |
| S21 | 🔵 | X05 hard-codes token labels | Fixed: every client token file on the Pi is scanned for | `c8d5f14` |
| S22 | 🔵 | Contract-suite coupling and weak assertions | Fixed: per-test data and harness cleanup, exact refusals and Retry-After, a wider settle window | `2a9c5a7`, `c321312` |
| S23 | 🔵 | Collectors change or print what they should not | Fixed: a copied index for route-shapes; the LAN probe never prints the address | `222cce1` |
| S24 | 🔵 | Weak bindings in the drivers | Fixed: crash jobs bound by key, the forward's port checked, the real server awaited | `ea84241` |

### Carried over from earlier reviews

| ID | Finding | Outcome | Commits |
|---|---|---|---|
| M1 R9 | NuQ's pg_cron deletes finished scrape rows after an hour, while spec §21.3 promises seven days of results | Fixed: M3's receipts and archive never depend on NuQ's rows; the ledger records every job and the archive keeps each document, and J06 serves them after pg_cron's cleaner, Redis expiry and a core recreate have removed the native state | `f24de87`, `269035d` |

### Found during `/address`, beyond the review

- **Oversized upstream answers were reported as resets** (`a1bbdd8`). `call()` destroyed an oversized response before settling, and since Node 16 destroying an unfinished `IncomingMessage` emits `aborted` synchronously, so the call settled as RESET. Archival's fallback to one document per page never ran, an oversized page held the single upstream slot as a retried "interruption", and a running job's status read over the cap answered 503 UPSTREAM_UNAVAILABLE. A contract test now runs archival under a 4 KiB cap.
- **M2's retrieval-role password step had S2's gap** (`645843e`), in both its initdb script and its setup script. It is fixed beside S2.
- **Two client calls met a generic 404** (`d68c102`). W19's stronger rule found that the pinned client calls `POST` and `DELETE /v2/scrape/{id}/interact`. The manifest now declares both not enabled, so they are answered 501 with the reason.
- **Two bugs in the tailnet check** (`4efd86f`), found on its first live run. It read `res.socket` after a keep-alive agent had taken it back. Its port probe also found tailscaled's peer API answering over the tailnet: Tailscale's own userspace network stack serves it before the host's firewall. It is Tailscale's function, not a host service, and P02 now reports it by name while requiring that no host service answers.
- **Chromium was OOM-killed six times inside its capped cgroup**, measured while building W7's sampler. This happened at 06:57Z on 2026-09-26, before M3's evidence window. The kills were `CONSTRAINT_MEMCG` in the browser worker's cgroup (uid 3320, about 1.4 GB resident): M2's bound contained them, and the host and the other services were unaffected. M01 now requires the host's OOM-kill count to stay constant across the window, so a repeat inside it would fail. The browser's memory under load belongs to M8's resource-stability work.

### Reruns

After `/address`, every affected check ran again on evidence collected at the fixes:

- **Gateway suites.** Locally, the unit tests and the contract suite (40 tests) pass. On the Pi, inside the image the stack runs (`5d814709`, Node 22.23.3), the unit tests pass 20 of 20 and the contract suite 40 of 40, with no throwaway container or network left (G02).
- **The held live step.** Tailscale Serve ran after the fixes; the tailnet TLS check and port probe pass (P02).
- **Evidence.** The whole evidence window was collected twice. The first collection (`4efd86f`) found the three issues recorded in `INTERPRETATION.md` §8. The second, at `5c4dbb4`, is the record.
- **Verifier.** `scripts/m3/verify.mjs` at `4405e0b`, with every code change committed (`code_dirty=false`), passes 33 of 33 checks (`evidence/M3/verification.json`), V01 on this report included.
