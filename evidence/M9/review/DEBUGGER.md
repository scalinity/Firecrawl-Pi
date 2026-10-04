## Code Review: M9

### Summary

Reviewer DB1 (debugger). I reviewed candidate `bec9050` against base `55d756c`, read-only. A hook blocked Bash, so I could not run `git diff --stat` against the base or hash the generated snapshots. Instead I read the candidate files directly:
- **Read in full:** all of `scripts/m9/incident-*`, `services/access/src/incidents.mjs`, the new route in `services/access/server.mjs`, `services/access/src/config.mjs`, `scripts/m1/deploy.sh` (local mode), `scripts/ops/notify-ntfy.sh`, the `scripts/ops/lib.sh` notice/hold helpers, the tick hand-off, `scripts/ops/restore.jq`, the incident lines of `scripts/ops/backup.sh`, the relevant parts of `scripts/ops/restore-test.sh`, and `scripts/m9/{install-global,mcp-headers.sh,client-check,live,collect,verify,validation.sh,pi-init.sh,stage-source.sh,rebuild-gateway.sh,entry}`.
- **Also read:** `deploy/host/fcpi-incident.{service,timer}`, the Compose incident mounts, and both tests (`services/access/test/incidents.test.mjs`, `tests/contracts/m9-incident-hook.test.mjs`).
- **Only skimmed:** the legacy Redis/F13 fixes, docs and helpers.
- **Not checked:** the mechanical consistency of the generated snapshot and version metadata (hashes).

The signed-grant core is sound, and so are the restore isolation and the validation consent binding. Five path-level defects remain in the incident release flow and the acceptance gate:
- An approved fix can redeploy a stale base over a newer release.
- A failed preparation silently and permanently blocks an incident.
- Once incidents are enabled, all M8 phone notices depend on Docker.
- The binary acceptance gate trusts self-asserted state files.
- A failing release stays promoted, while its only rollback path is served by the component that just failed.

### 🔴 Critical Issues (Must Fix)

**DB1-C1 — Apply Fix deploys the patch's stale base over a newer deployed release**
- **Input:** Incident A is investigated at deployed base `X`, and its harvested patch is built on `X`. Then one of these deploys `Y`:
  - another incident's Apply Fix (two incidents can run in parallel; only the model process is serialized);
  - an operator `scripts/m1/deploy.sh`;
  - a `--resume` (which reuses the old tree).
  
  After that, A's `approval_required` notice is delivered.
- **Path:**
  1. `scripts/ops/notify-ntfy.sh:81,94-95` signs the grant with `base_sha` = the commit deployed *now* (`Y`). It also overwrites the report's `base_sha` (`:85`), keeping the real base only as `proposal_base_sha`.
  2. `scripts/m9/incident-control.sh:30` and `scripts/m9/incident-apply.sh:13` compare only the grant's base with the deployed commit, so `Y == Y` passes.
  3. `incident-apply.sh:18,25` then uses `W/base-sha` (`X`) and never compares it with `source_commit`.
  4. `scripts/m1/deploy.sh --local` deploys `X+patch`, and its prune step removes `Y`'s files.
  5. `release.json.previous_sha` is set to `X`, so a later Roll Back also targets `X`.
- **Observable:** `Y`'s fix or release is silently reverted. The owner approved "base Y" in the report, but the code deployed was built on `X`. Rollback cannot restore `Y`.
- **Patch:**
```bash
# scripts/m9/incident-apply.sh, after base=$(cat "$W/base-sha")
[ "$base" = "$(source_commit)" ] || die 'proposal base is no longer the deployed release; re-investigate'
```
```bash
# scripts/m9/incident-prepare.sh, inside the existing-W/--resume branch
[ "$(cat "$W/base-sha")" = "$(source_commit)" ] || die 'deployed release changed since investigation; start a new investigation'
```
```bash
# scripts/ops/notify-ntfy.sh, in the "$report" branch
pbase=$(jq -r .base_sha "$report")
[ "$pbase" = "$base" ] || verbs='["details","dismiss"]'   # never offer apply_fix for a stale proposal
# and keep base_sha:$pbase in the written report rather than overwriting it with the deployed commit
```

**DB1-C2 — A failure during preparation leaves a half-built work directory, and the incident is never investigated**
- **Input:** The owner's subscription access token in `the owner credential file` expires within 10 minutes. On a headless Pi this is the normal state unless the owner recently ran `claude` there. The same thing happens if the Claude binary hash differs, if `tar`/`jq` fail, or if `git switch -c codex/incident-$id` hits a branch left behind after the 14-day cleanup (branches are never deleted).
- **Path:**
  1. `scripts/m9/incident-prepare.sh:24-40` creates `$W`, the worktree, `input.json` and `launch-count`.
  2. Only after that, `:44` (token expiry) or `:47` (binary pin) calls `die`.
  3. On the next tick, `scripts/m9/incident-control.sh:69` skips the incident because `$W` exists.
  4. `:55` sends a failure notice only when `run/result.new.json` exists.
  5. The owner's Investigate button runs `:39` → `prepare --resume` → `die 'no resumable completed session'`.
- **Observable:** There is no `investigation_started` notice and no failure notice, only a `logger` line. The incident can never be investigated, automatically or by approval. `$W` is never cleaned up, because `harvested.json` is never written.
- **Patch:**
```bash
# scripts/m9/incident-prepare.sh — move the token-expiry and binary-sha checks (lines 44 and 46-47) above `if [ ! -e "$W" ]`, then:
launched=false
if [ ! -e "$W" ]; then
  trap '[ "$launched" = true ] || { git --git-dir="$D/source.git" worktree remove --force "$W/tree" 2>/dev/null
        git --git-dir="$D/source.git" branch -D "codex/incident-$id" 2>/dev/null; rm -rf -- "$W"
        notice diagnosis_ready "incident_agent:$id" "{\"state\":\"INVESTIGATION_BLOCKED\",\"automatic_retry\":false}" "$(now_s)" "$id"; }' EXIT
  ...existing creation...
fi
...
systemd-run ... && launched=true
```
Also delete `codex/incident-$id` in the `incident-control.sh:60` cleanup.

**DB1-C3 — Enabling incidents makes every M8 phone notice depend on Docker and the gateway container**
- **Input:** `FCPI_INCIDENT_ENABLED=true`, and dockerd is down (for example, the data check failed at boot), or the `fcpi-access-gateway-1` container does not exist, or the 128 MiB helper cannot start under memory pressure. The tick still opens `core_unhealthy`.
- **Path:**
  1. `scripts/ops/notify-ntfy.sh:70-100` runs for every notice kind, not just incident-agent ones.
  2. `:96` produces an empty `image` with no error check.
  3. `docker run ... || exit 1` at `:100` exits before the `curl` at `:102-104`. `:74` likewise exits when no `.ts.net` origin is listed.
  4. `scripts/ops/lib.sh:198-205` retries up to 5 times and then gives up.
- **Observable:** The owner gets no phone notice for exactly the outages that matter most. This regresses N01's accepted channel; the VPS watchdog only records "unhealthy app on a live Pi".
- **Patch:**
```bash
# scripts/ops/notify-ntfy.sh — never let action generation suppress the notice
gen_actions() { ...existing block body, returning the JSON on stdout... }
if ! actions=$(gen_actions) || ! jq -e 'type=="array"' >/dev/null 2>&1 <<<"$actions"; then
  actions='[]'; msg+=$'\n'"Actions unavailable; use fcpi status."
fi
```
Inside `gen_actions`, replace `exit 2`/`exit 1` with `return 1`, and use `image=$(docker inspect ... 2>/dev/null) && [ -n "$image" ] || return 1`.

**DB1-C4 — The binary acceptance gate passes on self-asserted states that no committed script produces**
- **Input:** Files containing `{"criteria":{"AC01":{"state":"PASS"},…}}`, `{"state":"PASS"}` and `{"exit_code":0}` at `evidence/M9/live-gates.json`, `evidence/M9/incident-proof.json`, `evidence/M9/redaction.json` and `evidence/M9/work/fixture-run.json`. Repository search finds no producer for any of these four files.
- **Path:**
  1. `scripts/m9/verify.mjs:12-13,20,23-24` copies `fresh.state`, `incident-proof.state`, `redaction.state` and `fixture-run.exit_code` straight into the results.
  2. Nothing ties any of them to `HEAD` or the deployed commit.
  3. `:16` checks the corpus without checking `corpus_sha256` against `evidence/M9/work/corpus-freeze.json`, and trusts the per-target `usable` values.
  4. `evidence/M9/current/versions.json` is accepted from any earlier commit.
- **Observable:** `evidence/M9/acceptance.json` reports `ACCEPTED`, exit 0, without the milestone's required automated recomputation: no secret scan, no Cloud-deny enforcement, no restore/rollback reproduction. Evidence collected before a later `/address` commit also stays green. This breaks §33.3 ("recomputes every result from raw evidence; a check that cannot fail is a finding").
- **Patch:**
```js
// scripts/m9/verify.mjs
const head=git('rev-parse','HEAD');
const bound=o=>o&&o.source_commit===head&&Array.isArray(o.evidence)&&o.evidence.length>0
  &&o.evidence.every(e=>existsSync(e.path)&&hash(e.path)===e.sha256);
// AC rows: state = !historicPass ? 'FAIL' : (bound(live) && bound(fresh)) ? fresh.state : 'NOT_RUN'
// M9-CURRENT: current?.exit_code===0 && current.source_commit===head
// M9-CORPUS: also require corpus.corpus_sha256===json('evidence/M9/work/corpus-freeze.json').corpus_sha256
//   && corpus.usable===corpus.results.filter(x=>x.usable&&x.criteria.every(c=>c.passed)).length
// M9-REDACTION: run the scan here (or call a committed scripts/m9/redaction.mjs) instead of reading .state
// M9-INCIDENT / M9-FIXTURES: NOT_RUN unless bound(...) to a committed collector's raw transcript
```

**DB1-C5 — A failed incident release stays promoted, and its Roll Back is served by the component that failed**
- **Input:** An approved patch that passes `scripts/m9/incident-tests.sh` but fails at runtime. For example, `access-gateway` crashes on real config or the functional probe fails.
- **Path:**
  1. `scripts/m9/incident-apply.sh:33-36` always rebuilds and restarts `access-gateway`.
  2. `:57-62` fails.
  3. `:64-66` sends `deployment_failed` and exits, leaving the candidate deployed.
  4. The `rollback` verb (`scripts/ops/notify-ntfy.sh:78`) posts to `/platform/v1/incidents/action/*`, which only `access-gateway` serves (`services/access/server.mjs:523-538`).
- **Observable:** REST and MCP stay on the failing release. The phone's Roll Back request cannot reach a crash-looping gateway, so recovery needs SSH. This contradicts M9's "Do not promote a failing release; keep the previous accepted deployment". Rolling back to the already accepted release is exactly the deterministic runbook action the owner's requirement allows.
- **Patch:**
```bash
# scripts/m9/incident-apply.sh, replacing the rc!=0 block
if [ "$rc" != 0 ]; then
  rb=FAILED
  if [ "${3:-}" != --rollback ]; then
    git -C "$W/tree" switch --detach "$base" >/dev/null
    if bash "$REPO/scripts/m1/deploy.sh" --local "$W/tree" >"$W/auto-rollback.txt" 2>&1 \
       && docker compose -p fcpi -f "$REPO/deploy/compose.yaml" up -d --no-build --no-deps access-gateway retrieval-service >>"$W/auto-rollback.txt" 2>&1 \
       && sleep 20 && bash "$REPO/scripts/ops/verify.sh" functional >>"$W/auto-rollback.txt" 2>&1; then rb=VERIFIED; fi
  fi
  notice deployment_failed "incident_agent:$id" "{\"state\":\"DEPLOYMENT_FAILED\",\"automatic_rollback\":\"$rb\"}" "$(now_s)" "$id"
  exit "$rc"
fi
```

### 🟡 Warnings (Should Fix)

- **DB1-W1 — A failed resume harvests the old diagnosis together with partial new edits.** On resume, `run/result.json` survives from the first run, so `scripts/m9/incident-control.sh:55` never marks `failed.json`. The `:73-78` loop then harvests the *old* `result.json` with whatever the timed-out or failed second run left in the tree, and `scripts/m9/incident-harvest.sh` offers it for approval. Fix: before launching a resume, have `scripts/m9/incident-prepare.sh` move `result.json` to `result.prev.json`, and have harvest require `result.json` newer than `launch-count`.
- **DB1-W2 — The protected-path guard does not match its stated contract.** The prompt (`scripts/m9/incident-agent.sh:22`) says security, budgets and egress cannot be changed. Yet `scripts/m9/incident-hook.sh:29-30` and `scripts/m9/incident-harvest.sh:24-25` allow these files:
  - `services/retrieval/src/{ssrf,policy,proxy,provider,enhanced,residential,webhook,route,server}.mjs`
  - `services/access/src/{mcp,validate,registry-equivalent}.mjs`
  
  The phone shows only the file count and 12 hex characters of the patch hash. Either deny these files explicitly, or switch to an allowlist of non-policy modules.
- **DB1-W3 — Failures in `incident-apply.sh` before deployment are silent and leave the incident unrecoverable.** Any `die` or `set -e` failure between `:24` and `:47` (build, tests, backup, restore test) sends no notice. Commits are already made at `:30`/`:42`, so `:25` (`HEAD == base`) blocks every later Apply. The whole apply also runs inside `fcpi-incident.service` with `TimeoutStartSec=1800`, and two 600 s builds plus three 180 s test runs plus backup plus a full restore test can exceed that. systemd then kills the apply mid-way, and the processed record stays `EXECUTION_STARTED`. Fix: add an EXIT trap that sends `deployment_failed`/`apply_blocked`, and run the apply as its own `systemd-run` unit with a longer, explicit bound.
- **DB1-W4 — The approval signature works as a bearer capability that ntfy.sh stores.** `scripts/m9/incident-actions.mjs:16-17` puts the signature in the ntfy action headers, and puts the `?proof=` signature in the view URL. Anyone holding the topic or the ntfy.sh cache, and also able to reach the tailnet origin, can approve within 30 minutes. The tailnet requirement mitigates this, but it still relies on the secrecy of what is in the message. Consider also requiring Tailscale Serve's `Tailscale-User-Login` header to match the owner for `apply_fix` and `rollback`.
- **DB1-W5 — The real-client success check can be satisfied by a request echo.** In `scripts/m9/client-check.mjs:15`, `/Fixture|fixture|Firecrawl|Welcome/` matches the request URL `m1.fixture.fcpi.test` in any non-error result's `metadata.sourceURL`, even with empty or challenge markdown. Assert the exact known fixture heading instead. Nothing correlates the call with the Pi gateway log (client label `m9claude`/`m9codex`), and nothing checks for zero Cloud requests, both of which the owner requirement asks for.
- **DB1-W6 — The incident control flow has no fixture tests.** Only the grant module and the hook have tests. Nothing tests `scripts/m9/incident-{control,prepare,harvest,apply}.sh` or the notify action path. These are exactly where C1, C2, C3, C5 and W1 sit.

### 🔵 Suggestions (Consider)

- **DB1-S1:** `scripts/m9/incident-prepare.sh:17` passes a UTC date to `-newermt`, which reads it in local time (America/New_York). It also counts directories *modified* today, not created today.
- **DB1-S2:** `scripts/m9/incident-prepare.sh:11` uses `systemctl … | grep -q .` under `pipefail`, which is AGENTS.md §33.6's SIGPIPE trap. Use `grep . >/dev/null`.
- **DB1-S3:** The `details` grant has three problems:
  - Each tap queues a `details` action that sends yet another notice (`scripts/m9/incident-control.sh:40`).
  - GET consumes the grant before reading the report, so a missing or rebased report returns 503 with the grant already spent (`services/access/src/incidents.mjs:58-62`).
  - Every later notice rewrites `reports/$id.json`, which invalidates earlier view grants.
- **DB1-S4:** `scripts/m9/verify.mjs:15` marks a disabled AC22 as `PASS`. A `NOT_REQUIRED` state would match the spec's capability vocabulary.
- **DB1-S5:** Add `the owner Claude directory` to the agent unit's `InaccessiblePaths` (`scripts/m9/incident-prepare.sh:57`). Under `ProtectHome=read-only`, the refresh token stays readable by the agent process. Also, `claude setup-token`'s long-lived token, kept as a 0600 secret, would avoid the hourly-expiry dependency behind C2.
- **DB1-S6:** `scripts/m9/install-global.mjs` cannot resume after a crash between `codex mcp add` (`:40`) and the helper write (`:46`), because `:28` then throws "differs". The global `headersHelper` also points into the working tree.
- **DB1-S7:** `scripts/m9/validation.sh stop` runs under `set -e`. If `up --wait` fails, `override.yaml`, `budget.json`, `consent.json` and the timer stay behind. The container is still recreated from the base config, so paid dispatch is off. Remove those files first, or use `|| true` and then report.
- **DB1-S8:** The Claude worktree branches are named `codex/incident-*`. In `notify-ntfy.sh`, a `cleared` notice for `incident_agent:*` reads "Incident incident_agent: cleared, Duration 0s".
- **DB1-S9:** With `create_host_path:false`, the unconditional gateway incident mounts (`deploy/compose.yaml:374-391`) make `scripts/m9/pi-init.sh` a hard prerequisite for any gateway start. Record this in the deploy order and the fresh-init proof.

### ✅ Good Practices

- **Two-stage approvals:**
  - The gateway holds only the Ed25519 public key.
  - The grant binds action, incident, base, patch and test hashes.
  - A one-use, fsynced `wx` request file guards against replay; the 12-way concurrent replay test passes.
  - The root controller re-verifies each request in a network-less container before acting.
  - `EXECUTION_STARTED` is journalled before any action, so a crash never becomes an implicit retry.
- **Agent sandbox:**
  - The agent runs as a non-root `systemd-run` unit with memory, CPU, task and runtime limits, `NoNewPrivileges`, `ProtectSystem=strict`, and `InaccessiblePaths` covering secrets, data, the Docker socket and `.ssh`.
  - `--setting-sources ''` and a root-owned hook enforce symlink and ancestor checks.
  - There is no Bash, MCP or subagent access, and no API-key fallback.
  - The Claude binary is pinned by hash.
- **Harvest:**
  - It freezes the tree as root before hashing it.
  - It applies a path allowlist to the git diff.
  - It runs the literal-secret scan over both the patch and the model output.
  - Tests run on an internal-only network with a disposable PostgreSQL.
- **Restore and backup:**
  - `scripts/ops/restore.jq` strips the incident env and mounts from the restore copy.
  - `scripts/ops/backup.sh` excludes the agent's auth directory.
- **Validation and onboarding:**
  - `scripts/m9/validation.sh` consent is bound to the source commit, capped at 1 h, with a 45-minute stop timer, and the base caps are never edited.
  - `scripts/m9/install-global.mjs` keeps tokens off argv and checks with deep equality that unrelated client servers are unchanged.
- **Honesty about pending work:** `IMPLEMENTATION-NOTES.md` states that the live, paid and incident steps are still pending.

### Verdict

**Request changes.** Fix C1–C5 and add fixture tests for the control, prepare, harvest, apply and notify paths (W6) before enabling `FCPI_INCIDENT_ENABLED`, running any held live step, or rerunning `scripts/m9/verify.mjs`.
