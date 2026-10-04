## Code Review: M9

### Summary

Scope: `55d756c5fb12fc5e741ab4145c47a7d7fdee1237..bec9050` (61 files, +1224/−60). I gave a full review to these paths:

- the incident pipeline: `scripts/m9/incident-*.sh` and `.mjs`, `services/access/src/incidents.mjs`, and the new route and config in `services/access/server.mjs` and `services/access/src/config.mjs`;
- `scripts/m1/deploy.sh --local`;
- `scripts/ops/notify-ntfy.sh`, `scripts/ops/backup.sh`, `scripts/ops/restore.jq` and `scripts/ops/lib.sh`;
- the onboarding, verify and validation scripts under `scripts/m9/`;
- the new host units and the Compose mounts.

I skimmed the legacy Redis-helper fixes (M8 F13), the tests, the docs, and the version-lock and compose pins. All files were read only: nothing was run, nothing was changed, and nothing was reached over SSH or the network.

The signing and approval design underneath is sound. It uses Ed25519 grants, an exclusive request spool written with `fsync`, a second check by root in a container with no network, a journal entry before any action runs, and no automatic retry. The canonical documents honestly mark M9 as `IN_PROGRESS`, and `evidence/M9/acceptance.json` reports `IN_PROGRESS` / exit 1, so this change claims no unsupported acceptance.

Four defects in the root deployment path break guarantees the spec states (§25.3):

1. The approval can deploy an outdated base over a newer release.
2. Turning the feature on makes M8's phone notices depend on Docker.
3. Code the owner never approved can enter a deployed image without appearing in the approved patch.
4. Roll Back is reached through the same gateway the failed release may have broken.

Several bounds and recovery paths are also broken or untested: the daily investigation limit, investigations that get stuck, partial-deploy rollback, and the verifier's handling of live gates.

---

### 🔴 Critical Issues (Must Fix)

**CA1-C1 — Apply Fix can redeploy an outdated base over a newer release**

- **Input:** Incident Y is investigated at deployed base A. Before Y's `approval_required` notice is delivered, another release becomes current at C. That could be incident X's approved fix, or a normal `scripts/m1/deploy.sh` from the Mac.
- **Path:**
  - `scripts/ops/notify-ntfy.sh:81` signs the grant with `base=$(cat "$REPO/.fcpi-source-commit")`, which is the current release C, not the proposal's own `harvested.json .base_sha`, which is A. The private report also overwrites `base_sha` with C and keeps A only as `proposal_base_sha`.
  - `scripts/m9/incident-control.sh` checks the stale base with `.base_sha == source_commit`, which compares C with C, so it passes.
  - `scripts/m9/incident-apply.sh:11` makes the same comparison and passes.
  - `scripts/m9/incident-apply.sh:25` only checks that the tree's HEAD equals `$W/base-sha`, which is A.
  - Nothing compares the proposal's base A with the deployed release C.
  - The script then commits on A, rebuilds both images, rewrites the pins, and `deploy.sh --local` replaces `the deployed archive` with A plus the patch.
- **Observable wrong outcome:** One phone tap silently reverts release C: X's fix, its image pins, or any operator commit. This is exactly what the controller's own comment ("An old phone notice cannot deploy over it") and spec §25.3 ("stale bases … are rejected") say cannot happen.
- **Patch:**

```diff
--- a/scripts/m9/incident-apply.sh
+++ b/scripts/m9/incident-apply.sh
@@
 base=$(cat "$W/base-sha")
+if [ "${3:-}" != --rollback ]; then
+ [ "$base" = "$(source_commit)" ] || die 'proposal was prepared on a release that is no longer deployed'
+fi
--- a/scripts/ops/notify-ntfy.sh
+++ b/scripts/ops/notify-ntfy.sh
@@
   if [ -r "$report" ]; then
+    # Bind approval to the proposal's own base; never re-label an old proposal as current.
+    proposal=$(jq -r .base_sha "$report")
+    [ "$proposal" = "$base" ] || verbs=$(jq -c 'map(select(. != "apply_fix"))' <<<"$verbs")
-    jq --arg base "$base" ... '. + {proposal_base_sha:.base_sha,base_sha:$base,patch:$patch}' ...
+    jq --rawfile patch ".../patch.diff" '. + {patch:$patch}' ...
```

Add a controller fixture: issue an `apply_fix` grant, advance `.fcpi-source-commit`, and assert the result is `REJECTED_STALE_BASE` or `die`.

**CA1-C2 — With incidents enabled, M8's phone notices depend on Docker and the gateway container**

- **Input:** `FCPI_INCIDENT_ENABLED=true`, and any notice is raised while dockerd is down or hung, or while `fcpi-access-gateway-1` is absent. A plausible case is `core_unhealthy` during a Docker outage.
- **Path:** For every notice kind, `scripts/ops/notify-ntfy.sh:73-100` now runs:
  - `docker inspect fcpi-access-gateway-1`;
  - `docker run …incident-actions.mjs`, then `|| exit 1`;
  - and `[ -n "$origin" ] || exit 2` if the served-origins file is unreadable.

  `deliver_notices` in `scripts/ops/lib.sh:198-205` stops retrying a notice after 5 attempts, and each attempt is capped at `timeout 20`.
- **Observable wrong outcome:** The notice that matters most, "the platform is down", is never delivered and is dropped for good after five ticks. M8 accepted ntfy delivery with no Docker dependency (spec §25), so this is a regression of an accepted capability, triggered by the M9 feature flag.
- **Patch:** Treat actions as optional and always deliver the notice.

```diff
-  origin=$(grep '^https://.*\.ts\.net$' /etc/firecrawl-pi/secrets/gateway/served-origins | head -1)
-  [ -n "$origin" ] || exit 2
+  origin=$(grep '^https://.*\.ts\.net$' /etc/firecrawl-pi/secrets/gateway/served-origins 2>/dev/null | head -1)
+  if [ -n "$origin" ]; then
   ...
-  actions=$(printf '%s\n' "$input" | timeout 10 docker run ... ) || exit 1
+  if ! actions=$(printf '%s\n' "$input" | timeout 10 docker run ... ) || ! jq -e 'type=="array"' >/dev/null <<<"$actions"; then
+    logger -t fcpi-notify -- 'incident actions unavailable; notice delivered without actions'; actions='[]'
+  fi
+  fi
```

**CA1-C3 — Files git ignores can bypass the exact-patch binding and still end up in the deployed image**

- **Input:** The agent writes `services/access/src/node_modules/x.mjs`.
  - `scripts/m9/incident-hook.sh` allows it: the bash `case` pattern `services/access/src/*.mjs` matches across `/`, and the path has no dot component.
  - The agent then adds a one-line `import './node_modules/x.mjs'` (or a dynamic import) to an allowed file.
- **Path:**
  - `.gitignore` ignores `node_modules/`.
  - `scripts/m9/incident-harvest.sh` lists untracked files only with `--exclude-standard`, so ignored files are skipped. `git diff --binary`, `patch_sha`, the secret scan and the owner's report all omit `x.mjs`.
  - `scripts/m9/incident-tests.sh` mounts the working `src/` directory, so the hidden file is present and tests pass.
  - `scripts/m9/incident-apply.sh` builds with `docker buildx … "$W/tree/services/$component"`. The Dockerfiles do `COPY src ./src`, and there is no `.dockerignore`, so the hidden file goes into the image.
  - The `git diff | sha256` check in apply also ignores it.
- **Observable wrong outcome:** The image contains code that is not in the signed patch hash, was never secret-scanned, and does not match the recorded source commit (`git archive` to `/opt` omits it). The core control in §25.3, "grant binds … exact patch", is bypassed. The phone notice shows only the file count, test exit and patch prefix.
- **Patch:**

```diff
--- a/scripts/m9/incident-hook.sh
+++ b/scripts/m9/incident-hook.sh
@@
   [[ /$rel/ != */.* ]] || deny
+  [[ /$rel/ != */node_modules/* ]] || deny
--- a/scripts/m9/incident-harvest.sh
+++ b/scripts/m9/incident-harvest.sh
@@ chown -R root:root "$W/tree"
+[ -z "$(git -C "$W/tree" ls-files --others --ignored --exclude-standard -z | head -c1)" ] || die 'ignored files in incident candidate'
--- a/scripts/m9/incident-apply.sh
+++ b/scripts/m9/incident-apply.sh
@@
+ exp=$(mktemp -d "$W/export.XXXXXX"); git -C "$W/tree" archive "$code" services | tar -x -C "$exp"
  for component in access retrieval; do
-  timeout 600 docker buildx build ... "$W/tree/services/$component" ...
+  timeout 600 docker buildx build ... "$exp/services/$component" ...
```

Also run the trusted tests against the same `git archive` export rather than the working directory.

**CA1-C4 — Roll Back is reached through the component the failed release may have broken**

- **Input:** An approved patch to `services/access/src/*.mjs` passes the container tests but fails to start in production, for example because it depends on production-only mounts or config such as `PI_INCIDENT_*`, admission or the artifact root.
- **Path:**
  - `scripts/m9/incident-apply.sh` recreates `access-gateway`.
  - `ops/verify.sh functional` fails, and `notice deployment_failed` offers `rollback`.
  - The phone's signed POST goes to `/platform/v1/incidents/action/<id>` on the crashing access-gateway, behind Tailscale Serve. The result is a 502, nothing is spooled, and the controller never sees a request.
- **Observable wrong outcome:** The one recovery path the spec prescribes ("A failed deployment requires a new owner-approved Roll Back action") cannot be reached. REST and MCP stay down until the owner gets to a terminal. The rollback depends on the release being rolled back.
- **Patch:** Restoring the already-accepted previous release is a deterministic step of the kind the owner requirement allows ("roll back to an already accepted configuration/image where a tested runbook permits"). Use it automatically when the gateway itself is unhealthy:

```diff
 if [ "$rc" != 0 ]; then
+ if [ "${3:-}" != --rollback ] && [ "$(docker inspect -f '{{.State.Health.Status}}' "$(cid access-gateway)" 2>/dev/null)" != healthy ]; then
+   git -C "$W/tree" switch --detach "$base" >/dev/null
+   bash "$REPO/scripts/m1/deploy.sh" --local "$W/tree" >>"$W/deploy.txt" 2>&1 \
+     && docker compose -p fcpi -f "$REPO/deploy/compose.yaml" up -d --no-build --no-deps access-gateway retrieval-service >>"$W/deploy.txt" 2>&1
+   notice deployment_failed "incident_agent:$id" '{"state":"AUTO_RESTORED_PREVIOUS_ACCEPTED","approval_channel_unavailable":true}' "$(now_s)" "$id"; exit "$rc"
+ fi
  notice deployment_failed ...
```

Alternatively, serve the action endpoint from a component that incident patches cannot change. Either way, add a fixture in which the candidate gateway fails at startup.

---

### 🟡 Warnings (Should Fix)

**CA1-W1 — The "four per UTC day" investigation limit is not enforced.** `scripts/m9/incident-prepare.sh` runs `find … -newermt "$(date -u +%F)"`. `-newermt` reads that date as *local* midnight, and the Pi is on America/New_York (AGENTS §33.6). Between 00:00Z and about 04:00Z the threshold is in the future, so the count is always 0 and there is no limit for four hours a day. The check also counts directory mtimes, which change whenever files are added under an older `$W`. Fix: append one line per launch to a root-owned ledger and count entries whose epoch is ≥ today's UTC midnight (`date -u -d "$(date -u +%F) 00:00 UTC" +%s`).

**CA1-W2 — Investigations can get stuck or leak state, with no notice.**
- `incident-prepare.sh` creates `$W` (worktree, bundle, `input.json`) *before* checking the access-token expiry and the pinned Claude binary. If either check fails, `$W` exists with `launch-count=0`. The automatic path then skips the incident forever (`[ ! -e "$D/work/$id" ]`), and Investigate fails with "no resumable completed session". The owner is never told.
- If Claude writes no stdout, `result.new.json` is empty, so neither `failed.json` nor harvest fires.
- Cleanup in `incident-control.sh` only removes *harvested* directories after 14 days. Failed or unlaunched worktrees, `codex/incident-*` branches, session transcripts, and an access token left behind after a SIGKILL from the 768M OOM limit (the bash `EXIT` trap doesn't run) all stay forever.
- Fix: run the token and binary checks before creating `$W`; build `$W` in a temporary directory and rename it into place; have root delete `run/auth/access-token` once the unit is inactive; and clean up `failed.json` and unlaunched directories on the same 14-day rule.

**CA1-W3 — A failed resume can be harvested against a stale diagnosis.** On `--resume`, `incident-prepare.sh` keeps the old `run/result.json`, hands the tree back to `danny`, and deletes `harvested.json`. If the resumed run times out or fails, `result.json` is still the *previous* diagnosis, but the tree now holds new, unvalidated edits. The controller then harvests them and may send `approval_required` with a diagnosis that does not describe the patch. Fix: move `result.json` to `result.prev.json` before relaunching. Harvest only a `result.json` newer than `launch-count`; otherwise mark the run `INVESTIGATION_FAILED`.

**CA1-W4 — Apply has crash-consistency and rollback gaps.**
- If `deploy.sh --local` fails after `tar -x` but before the marker is written (for example on the hash check or the prune step), `/opt` holds a mix of candidate and base files while the marker still names the base. The `--rollback` branch then requires `source_commit == candidate_sha`, so it dies with "release has moved" and rollback is impossible. Fix: accept `source_commit ∈ {previous_sha, candidate_sha}`.
- `fcpi-incident.service` sets `TimeoutStartSec=1800`, but the inner budgets add up to more: tests are 60 + 3×180 s, the builds are 2×600 s, and backup and restore-test have their own 7 h / 6 h service limits. systemd's SIGTERM can land in the middle of a deploy, leaving `EXECUTION_STARTED` and sending no notice.
- `backup.sh` and `restore-test.sh` (restic) now run inside the controller's `MemoryMax=256M`, which nobody has measured.
- If the build, backup or restore-test fails before `hold_set`, nothing is sent to the phone, and `release.json` never advances past `PREPARED`.

**CA1-W5 — The approved release's source exists only in the Pi's private mirror.** The candidate commits live on `codex/incident-$id` in `/var/lib/firecrawl-pi/incidents/source.git`. `stage-source.sh` only fetches *into* that mirror, and nothing brings the fix back to the canonical Mac repository. The next ordinary `scripts/m1/deploy.sh` silently reverts the owner-approved fix and its image pins. Meanwhile `.fcpi-source-commit` and `versions.lock` cite a commit that is not in the project's history (AGENTS §33.1 requires that the recorded commit describes what runs). Fix: refuse a Mac deploy whose HEAD doesn't contain the deployed commit, and export the release as a bundle or patch for import.

**CA1-W6 — The agent can edit the tests that gate its own patch.** The hook and harvest allow edits to existing `services/*/test/*.mjs` and to `tests/contracts/m4-gateway-mcp.test.mjs`, which `incident-tests.sh` describes as the check of the privileged action boundary. A patch can weaken these and still get `test_exit: 0`, which is what the phone shows. Fix: run the base-commit copies of existing tests (overlay base `test/` plus only *new* test files), or refuse changes to existing test files.

**CA1-W7 — An approval is only as strong as the secrecy of the ntfy topic.** The Ed25519 signature travels inside the ntfy action headers, posted to and cached by the hosted ntfy.sh. Anyone holding the topic who can also reach the tailnet (for example a compromised VPS, which holds the topic) can replay a cached approval. This is equivalent to the URL secrecy that spec §25.3 calls insufficient, and the owner requirement says "no bearer tokens in notification text". The notifier also now sends the private `*.ts.net` origin to ntfy.sh, which contradicts spec §25 / `notify-ntfy.sh:7-8` ("never … a URL"). Either add a factor that isn't in the message (for example, verify the Tailscale Serve identity header against the owner login before `consume`), or rewrite the spec claim to state the actual trust boundary.

**CA1-W8 — The verifier takes fresh gates' states as given.** `scripts/m9/verify.mjs` reads `.state` / `criteria[id].state` directly from `evidence/M9/live-gates.json`, `incident-proof.json` and `redaction.json`, which no script produces. It takes `clients/*.json .state` as written, and treats M9-REVIEW as passed on the substring "Remediation complete". None of these checks can fail on content, which contradicts AGENTS §33.3 ("recomputes every result from raw evidence"; a check that cannot fail is itself a finding). Add producers for each file, and recompute each state from its raw records.

**CA1-W9 — The client "VERIFIED_LIVE" test is too weak.** In `scripts/m9/client-check.mjs`, `usable` matches `/Fixture|fixture|Firecrawl|Welcome/` against the whole stringified item.
- For Codex that item includes the arguments, which contain `m1.fixture.fcpi.test`, so any completed call passes.
- For Codex there is no `server === 'fcpi'` check, and for Claude the tool name isn't pinned to `mcp__fcpi__`.
- Other global MCP servers aren't isolated (no `--strict-mcp-config` for Claude; nothing for Codex).
- Nothing on the Pi side proves the request arrived, and nothing proves zero Cloud requests. The owner requirement asks for both.

Fix: require `server === 'fcpi'` and the exact fixture heading in the tool *result*, then cross-check the gateway log on the Pi (client label `m9claude`/`m9codex`, time window).

**CA1-W10 — The root incident path has no fixture coverage.** `evidence/M9/work/pi-fixtures-final.txt` covers grant issuing and consuming and the gateway route. It does not exercise:
- `incident-control.sh`, `incident-prepare.sh`, `incident-harvest.sh` and `incident-apply.sh`;
- `deploy.sh --local` (whose `shasum` dependency on the Pi is unverified);
- rollback;
- or the controller's stale-base rejection, which is broken per CA1-C1.

These are consequential root paths. Add disposable-namespace fixtures before the held live step.

---

### 🔵 Suggestions (Consider)

- **CA1-S1** — `scripts/m9/install-global.mjs` calls `current.replace(section[0], replacement)` with a *string* replacement, so `$&`, `$'` and similar patterns in the TOML would be expanded. Use `() => replacement`.
- **CA1-S2** — `incident-prepare.sh` runs `systemctl list-units … | grep -q . && exit 3` under `pipefail`, which is the SIGPIPE trap in AGENTS §33.6 and can let a second agent start. Use `grep . >/dev/null`.
- **CA1-S3** — Each "View Report" GET spools a `details` request, which sends a new notification with fresh grants. Return the report without spooling.
- **CA1-S4** — The controller checks expiry against the time it processes the request, not the approval time. Approvals queued behind a long apply expire, are logged as `REJECTED_INVALID_PROOF`, and the owner is not told. A gateway or controller image that is down is also misreported as an invalid proof. Distinguish these cases and send a notice on rejection.
- **CA1-S5** — The agent unit relies on the hook alone to keep `the owner credential file` (which holds the refresh token) unreadable. Add `the owner Claude directory` to `InaccessiblePaths` and pass the binary through `BindReadOnlyPaths`.
- **CA1-S6** — `incident-apply.sh:17` sets `GIT_CONFIG_GLOBAL=the owner Git configuration`, so root's `git` reads a user-writable config (`core.fsmonitor`, `core.pager`). Use `/dev/null` and pass the identity with `-c user.name/email`.
- **CA1-S7** — Notices keyed `incident_agent:` render as "Incident incident_agent". The branch prefix `codex/incident-` is used for a Claude agent. While blocked, the controller logs every 30 s, which adds to journal churn on the 32 MiB journal.

---

### ✅ Good Practices

- The grant signs every binding field (schema, id, incident, action, base, patch, tests, issue time, expiry). It expires in 30 minutes, and `apply_fix` requires both hashes (`services/access/src/incidents.mjs`).
- The gateway holds only the public key. Requests are consumed with an `O_EXCL` file write plus file and directory `fsync`. Root re-checks each request against the issued grant in a container with no network, a read-only root, all capabilities dropped and uid 3380.
- The controller journals `EXECUTION_STARTED` before running anything, never retries automatically, and rejects grants whose base is stale (except in CA1-C1's case).
- The agent unit is bounded: it runs without root, with `NoNewPrivileges`, `ProtectSystem=strict`, `InaccessiblePaths` covering secrets, data and the Docker socket, memory, CPU, task and runtime limits, one agent at a time, a pinned binary and model, `--strict-mcp-config`, and no shell or subagents. Its hook rejects symlinked ancestors and dot paths.
- `restore.jq` strips the incident environment and mounts from the isolated copy, and a contract test covers this.
- `scripts/ops/redis-cli.sh` resolves M8 F13 with secrets on stdin and least-privilege users. Parsing the foreign-container list on tabs fixes the empty-label bug, and a test covers it.
- `validation.sh` binds the consent to the deployed commit, caps budgets, enforces both an absolute expiry and a 45-minute auto-stop, and never edits the base Compose file or its zero caps.
- `install-global.mjs` preserves unrelated servers by semantic comparison, refuses silent rotation, and keeps tokens in the keychain via stdin.
- Canonical docs and `acceptance.json` honestly report `IN_PROGRESS`, with live steps held.

### Verdict

**Request changes.** Fix CA1-C1 through CA1-C4 before any live incident or Apply Fix step, and add the fixtures named in CA1-W10.
