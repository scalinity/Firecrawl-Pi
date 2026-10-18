## Code Review: SI6 — Release package, canonical reconciliation and rollback

### Summary
`/review-2` on SI6 (`7c747eb`, `2ecdc84`, `40531f5`, `de44fd0`, `ccb104b`): `scripts/si6/pi-cutover.sh`, `install-keys.sh`, `build-lock.mjs`, `evidence/search-intelligence/SI6/ROLLOUT.md` and the canonical documents' reconciliation, checked against the code, the policies, the deployed commit `5d91186` and the M5–M9 operations scripts. Both agents ran on Opus 5.5 (DB1, bugs; CA1, architecture, quality, security and data integrity), read-only; nothing ran against the Pi. Their findings are merged below, each source named.

The Pi-side mechanics held: every command had its own stdin under `bash -s`, the quiet check's states matched the job table, `install-keys.sh` never exposed a value, and ORCHESTRATION.html and the canonical documents were consistent. The defects were in the release procedure: the full rollback could not resolve the previous images once the rollout moved their tags; a failed build could commit and deploy an empty pin; the cutover bypassed spec §27's upgrade procedure; the rollback could be blocked by its own gate; and the lock builder erased earlier milestones' entries.

### 🔴 Critical Issues (Must Fix)
1. **The full rollback cannot run the previous release's images once steps 2 and 5 move their tags** (DB1 C1; CA1 S4) - `ROLLOUT.md:97-104`, `scripts/m5/push-api-image.sh`, `scripts/m7/pi-build-images.sh`
   - Problem: on the Pi's containerd image store a pin `fcpi/<repo>@sha256:<id>` resolves only through a name in that repository. Loading the new API image and rebuilding the `:m7` images leave the previous five images nameless, the browser worker's among them (its pin was meant to stay).
   - Risk: the documented rollback restores the old pins and `compose up` fails with "No such image"; depending on recreate order the release keeps running or the four services are left down.
   - Fix: retain each running image under a tag before any tag moves; make the cutover refuse when a pin does not resolve.
2. **Steps 2 and 5 commit and deploy image pins without checking that the image exists** (DB1 C2; CA1 S2) - `ROLLOUT.md:40-58`
   - Problem: an interrupted or failed build or push leaves `id` empty, `sed` writes `fcpi/<svc>@` into `compose.yaml`, and the commit and deploy go ahead.
   - Risk: the next `fcpi-stack.service` start (this Pi reboots unattended after a Wi-Fi loss) and the cutover fail on the invalid reference.
   - Fix: commit a pin only when the Pi holds the logged image and exactly one pin was replaced.
3. **The cutover skips spec §27's upgrade procedure and the `fcpi` surface that implements it** (CA1 C1; DB1 suggestion) - `scripts/si6/pi-cutover.sh:21-44`, `ROLLOUT.md:21-71`
   - Problem: no headroom check, backup or restore test, no staged candidate or plan, a point-in-time check instead of a hold and drain, manual functional checks, no release record.
   - Risk: work admitted between the check and the recreate is cut mid-flight (CWE-367); the tick judges the recreated core as an incident after 120 s; a partial schema has an unproven recovery point; with no `fcpi release` record, `fcpi rollback --plan` picks the newest backup of any time.
   - Fix: hold, drain, recreate and record the release in the cutover; add the backup, restore test, staged plan and functional check to the rollout.

### 🟡 Warnings (Should Fix)
1. **The rollback reuses the cutover's in-flight refusal, so a failed release can block its own rollback** (DB1 W1; CA1 W2) - `pi-cutover.sh:22-25`, `ROLLOUT.md:100`.
2. **The reservation gate counts every RESERVED row ever left** (DB1 W2) - `pi-cutover.sh`: rows of kinds no restart sweeps (proxy, reconcile, enhanced, parse) stay RESERVED for good, and one blocks the cutover and the rollback permanently.
3. **Between the deploy and the cutover, the deployed retrieval code cannot start** (DB1 W3; CA1 W1) - `ROLLOUT.md:44-61`: the previous validator refuses the release's budget policy (new top-level keys, the `requests` unit, empty caps, new kinds), and a restart in the window, made minutes long by the Pi builds, takes acquisition down.
4. **`build-lock.mjs` overwrites lock entries earlier milestones own** (DB1 W4; CA1 W3) - `build-lock.mjs:59-68`: `providers.search` replaced wholesale (dropping M5's SearXNG fields), `providers.providers` rebuilt without Decodo's session and usage fields and with `api: null`, `paid_caps` left stale against the new hash.
5. **The full rollback leaves the version lock, patch series and service source describing the release** (DB1 W5; CA1 W2) - `ROLLOUT.md:97` (CLAUDE.md §22, §29).
6. **ROLLOUT's `$SSH` fails in zsh** (DB1 W6; CA1 S1) - `ROLLOUT.md:30`: a scalar is not word-split, and the redirects create empty records (C2's trigger).
7. **The cutover's state section cannot report a failed recreate** (DB1 W7) - `pi-cutover.sh:38-43`: `docker ps -q` lists running containers only, `docker inspect ""` fails, and `set -e` ends the script before the failure's end marker.
8. **Canonical accuracy** (CA1 W4): (a) "only the gateway reaches the core's listener" (feature spec §20, patch 0011's comment) is false at the network level: the core is on `core`, `api` and `acquire`, which PostgreSQL, Redis, RabbitMQ and the retrieval service also reach (CWE-923); (b) a "previously" trail at `docs/FIRECRAWL_PI_SPEC.md:430` (CLAUDE.md §33.4).
9. **The spending rules disagree across the canonical documents, and the rollout's ceiling is not a ceiling** (CA1 W5): CLAUDE.md §11 still says the default paid budget is zero and to block at the hard cap, against spec §28.3's reporting-only search categories; spec §28.3's approved dispatch and the milestones document omit the seven categories; "$1.20 an hour" is the expectation, while reservations allow about $2.3–2.5 an hour, and Tavily's credits sit outside it.
10. **Evidence and verification gaps** (CA1 W6): no redaction scan step; verification is a manual checklist where `fcpi verify functional` exists; no SI6 verifier or build-lock test; the rollout cites records (SI5's runs, `ACCEPTANCE.md`) not yet in the repository.

### 🔵 Suggestions (Consider)
1. **A dropped SSH connection during the recreate can kill compose mid-recreate** (DB1): run the cutover detached on the Pi; give `compose up` a `--wait-timeout` (CA1 S7).
2. **The lock builder reads the working-tree lock and checks too little** (DB1; CA1 S2): read the committed lock, check the cutover's deployed commit and each compose pin, make it executable.
3. **`install-keys.sh` takes a name's first `.env` occurrence; SI5 takes the last non-empty one** (DB1).
4. **Gate 2 cites records not yet committed** (DB1): `SI5/ACCEPTANCE.md` and the SI5 runs.
5. **The fast rollback is unguarded** (CA1 S3): no hold or quiet check; the lock's budget hash and profile go stale; no release is recorded.
6. **Skip the browser rebuild** (CA1 S5): it is unchanged and lengthens the mixed-version window.
7. **State the Colima rule** (CA1 S6) rather than "(Colima running)".
8. **Tidy pi-cutover.sh** (CA1 S7): `pi-retrieval-db.sh`'s section names repeat the cutover's.
9. **Factual nits in ROLLOUT.md** (CA1 S8): `search_cache` predates the release; `/internal/providers` is the retrieval service's; "only the policies are mounted" is too absolute.
10. **Feature spec drift** (CA1 S9): Exa's reservation is given as about 17,000 micro-USD; the live card reserves 37,000.

### ✅ Good Practices
- Every Pi-side command has its own stdin under `bash -s`, so the `docker exec -i` trap cannot apply, and a psql failure under `pipefail` fails closed before anything changes.
- The quiet check's job states match `fcpi-platform-schema.sql` exactly; containers are found by label; the caller checks the end marker.
- `install-keys.sh` streams each value from the file to the Pi's stdin-only installer, hard-codes the names, validates `--replace` before the remote command, and prints presence only.
- `build-lock.mjs` refuses unless the evidence chain agrees (the logged id running and on the Pi, the series hash in the image, a clean no-cache build), stricter than M7's.
- The rollback's prerequisites hold: `5d91186` is an ancestor, the schema only widens and adds, and the fast rollback's `sed` matches the one `profile` occurrence.
- ORCHESTRATION.html's snapshot, hashes, 90 ranges and 78 tooltips match; CLAUDE.md and AGENTS.md are identical; the SI6 files add no identifiers.

### Verdict
[x] ❌ Request Changes (critical issues)
[ ] ⚠️ Approve with Suggestions
[ ] ✅ Approve

### Finding dispositions

Nothing in this remediation ran against the Pi beyond read-only probes: the cutover remains the one boundary, waiting on the owner's launch authorization. `node scripts/si6/verify.mjs` recomputes every result it can before the cutover from committed evidence (11 PASS, 0 FAIL, 7 NOT_RUN waiting on the cutover, `evidence/search-intelligence/SI6/verification.json`).

| Finding | Outcome | Evidence |
|---|---|---|
| C1 | Fixed (`ac4e8f7`, `e10b6d6`) | Rollout step 3 tags the five running images `retained-5d91186` before any tag moves; the service images build under `:si6`, so no `:m7` tag moves and the browser worker is not rebuilt; the cutover refuses before anything changes when a pin does not resolve. Read-only on the Pi, the premise holds: a nameless image resolves by its bare id but not as `fcpi/retrieval@<id>`. |
| C2 | Fixed (`ac4e8f7`) | Step 4 writes and commits the API pin only when `push-api-image.sh` succeeds, the Pi reports the logged id, and exactly one pin names it; step 5 only when the build transcript ends and records every `:si6` id, otherwise the edit is discarded. |
| C3 | Fixed (`e10b6d6`, `ac4e8f7`) | The cutover takes an `fcpi hold`, drains for up to five minutes, recreates and records the release with `fcpi release`. The rollout adds `fcpi status`, `fcpi backup`, `fcpi restore-test` (a PASS required), a staged candidate with `fcpi upgrade --plan`, and `fcpi verify functional`. The isolated-namespace candidate on copied data is not run, because the Pi's 8 GB holds one stack; the rollout names the evidence that stands in for it. |
| W1 | Fixed (`e10b6d6`) | `--rollback` proceeds after the drain whatever is in flight and records the counts; both rollbacks use it. |
| W2 | Fixed (`e10b6d6`) | Only reservations younger than the longest call the deployed policies allow (the residential hold, the crawl, batch and extract deadlines, computed from the policies) gate the cutover; every RESERVED row is listed by kind with its oldest time. |
| W3 | Fixed (`e10b6d6`, `ac4e8f7`) | The images build from a staged candidate (`scripts/si6/pi-build-images.sh`), so the deployed tree and policies stay the previous release's until step 7 runs deploy, keys and cutover back to back; the remaining window, its trigger and its recovery are stated, with no `fcpi paid` change in it. |
| W4 | Fixed (`e10b6d6`, `38155c2`) | Providers and search merge into their existing entries, Decodo's fields and the SearXNG fields kept; `paid_caps` and `paid_total_caps` are recomputed; every entry outside SI6's own is asserted unchanged. The verifier runs it on synthetic evidence and checks each kept field. |
| W5 | Fixed (`ac4e8f7`) | The full rollback is a forward commit of `5d91186`'s whole tree outside evidence and the SI6 scripts, with the files the release added removed: code, pins, policies, lock and patch series together. |
| W6 | Fixed (`ac4e8f7`) | `SSH` is an array, used as `"${SSH[@]}"`; zsh-sensitive expansions are braced (`${i}:si6`). |
| W7 | Fixed (`e10b6d6`) | The state section lists exited containers too, prints `status` and `health`, and reports an absent service rather than ending the script. |
| W8 | Fixed (`bbd72b7`, `f6d045b`, `7feb956`) | Feature spec §20 and patch 0011's comment now state the premise that holds (the gateway is the headers' only sender, and every other peer on the core's networks is a project service running no caller-supplied code) and what would end it. The comment change gives patch 0011 `a66a4c3e`, series `91e3d278` and result tree `7a59ba45` (verified by `prepare-api-source.sh`), so the API image of record was rebuilt with no cache from a clean tree (`22d55814…`) and the native chain passes 25 of 25 on it. Spec §13's history trail is replaced by the current statement. |
| W9 | Fixed (`f6d045b`, `ac4e8f7`) | CLAUDE.md and AGENTS.md §11 state the search intelligence categories' exception and block at the hard cap where one exists; spec §28.3's approved dispatch and the milestones document list the seven categories and their 60-an-hour bound. The rollout gives the expectation from profile D's own usage (19,442 micro-USD a search, about $1.17 an hour), the reservation ceiling (about $3.00 an hour) and the lanes not metered in USD, Tavily's credits among them. |
| W10 | Fixed (`ac4e8f7`, `e10b6d6`, `38155c2`); the citations close with SI5 | The redaction scan runs last (`redaction.mjs --out`, so M9's record is never overwritten); `fcpi verify functional` is a step and the verifier checks its result; `scripts/si6/verify.mjs` recomputes SI6's results with a negative control for each lock guard. SI5's records and `ACCEPTANCE.md` are committed with SI5's close. |
| S1 | Fixed (`ac4e8f7`, `e10b6d6`) | The cutover and both rollbacks run under `systemd-run` on the Pi, their records fetched once the end marker is written; `compose up` has `--wait-timeout 900`. |
| S2 | Fixed (`e10b6d6`) | The builder reads HEAD's committed lock and files, requires the cutover to be of HEAD with each running image HEAD's pin, refuses a dirty code tree, and is executable. |
| S3 | Fixed (`854e71a`) | A name takes its last non-empty value, as SI5 reads it. |
| S4 | Fixed with SI5's close | Gate 2's record lands with SI5's acceptance and evaluation records. |
| S5 | Fixed (`e10b6d6`, `ac4e8f7`) | The fast rollback recreates the retrieval service under the hold and drain, records the release, and refreshes the lock's policy entries (`build-lock.mjs --policy-only`, checked by the verifier). |
| S6 | Fixed (`e10b6d6`) | Only the three changed images are built. |
| S7 | Fixed (`ac4e8f7`) | Gate 4 states §33.7's rule. |
| S8 | Fixed (`e10b6d6`) | `pi-retrieval-db.sh`'s sections are prefixed `retrieval_db_`. |
| S9 | Fixed (`ac4e8f7`) | `search_cache` left the additive list, `/internal/providers` is the retrieval service's, and the rollback no longer claims only the policies are mounted. |
| S10 | Fixed (`f6d045b`) | The feature spec gives the effective rate card's 37,000-micro-USD reservation. |
