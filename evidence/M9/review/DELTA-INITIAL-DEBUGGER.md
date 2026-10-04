# Review: four-file uncommitted delta (HEAD `27f29d1`)

I couldn't follow two of your instructions. A PreToolUse hook ("Read-only scoped review") blocked every `git` command against the repository, so I couldn't see the diff against HEAD. It also blocked reading `<review-skill>`, so this uses a standard /review layout instead of that file's format. I reviewed the current contents of the four files and inferred which sections changed from your description and the code comments. Findings that touch code the delta may not have changed are marked as such. I ran no tests, made no edits and used no network.

## Summary

The delta meets its main goals. I found **no Critical findings**, one Important, one Minor and two test-coverage gaps.

## Requirement check

| Requirement | Result | Evidence |
|---|---|---|
| Bounded, unprivileged incident run | Met | `scripts/m9/incident-prepare.sh:87-93`: `--uid=danny`, NoNewPrivileges, memory/CPU/task limits, `RuntimeMaxSec=330` (longer than the agent's 300 s timeout plus 15 s kill-after in `scripts/m9/incident-agent.sh:24`), ProtectSystem=strict, ProtectHome=read-only |
| Missing optional private folders can't break sandbox startup | Met | `scripts/m9/incident-prepare.sh:91`: `-/home/danny/.ssh -/home/danny/.codex` (the `-` prefix tells systemd to skip a missing path). `/home/danny/.claude` correctly has no `-`: it is required and is read at line 27. The fixture's path rewrite (`scripts/m9/pi-control-fixtures.sh:14`) keeps the `-` prefix. |
| Inactive OAuth tokens erased while auto-dispatch is disabled | Met | `scripts/m9/incident-control.sh:11-21` runs before the `incidents.env` gate at lines 22-23. `pi-init.sh:12` creates `$D` before `incidents.env`, and the controller service is gated on that file, so the `exec 9>` redirect can't fail on a missing directory. |
| No race with preparation | Partly met; see I1 | Prepare holds `prepare.lock` (fd 8) from line 9 through `systemd-run`. `systemd-run` doesn't pass that fd to the unit, so the lock drops as prepare exits and the unit is already active. The controller closes fd 9 before its own prepare calls at lines 67 and 104, so it can't deadlock itself. |
| Persistence keeps every assertion | Met | Ledger hash covers job, job_document, job_event and idempotency (`scripts/m3/pi-persistence.sh:29-33`); billing hash at lines 35-38; registry at line 61; ten `SERVICES` at line 17; `scripts/m3/verify.mjs:591-606` still requires 10 replaced and 10 healthy services, plus `same("archive files=")` and `…differs_from_name=0` |

## Findings

### I1 (Important): the post-dispatch cleanup loop still races direct preparation calls
This may predate the delta; I couldn't confirm without git.

`scripts/m9/incident-control.sh:83-96` erases tokens (line 87) and writes `failed.json` plus an `INVESTIGATION_FAILED` notice (lines 88-90) **without** holding `prepare.lock`. The delta's new locked block (lines 11-21) covers only the disabled path, so with dispatch enabled the "without racing preparation" guarantee only half holds.

Trace (a real caller exists: `scripts/m9/incident-live.mjs:8` runs `sudo -n bash …/incident-prepare.sh <id>` outside `control.lock`; the timer fires every 30 s of inactivity):
1. Prepare writes the token (line 76), then `launched-at` (line 81), then runs `chown -R` over the whole worktree (line 84). The unit is not active yet.
2. A controller tick with `FCPI_INCIDENT_ENABLED=true` reaches line 86. `is-active` returns false, so line 87 deletes `run/auth/access-token`. Lines 88-90 then write `failed.json` and send `INVESTIGATION_FAILED`, because `launched-at` exists and `result.json` doesn't.
3. Prepare launches the unit. `incident-agent.sh:11` (`cat …/access-token`) fails under `set -e` and the unit exits. The live proof ends up `IMPLEMENTED_UNVERIFIED`, and the owner gets a false failure notice.

This fails closed (no token leaks, no extra launch), but it's a genuine race.

Patch: hold `prepare.lock` around this loop too. The prepare calls in the request loop have already returned by then, and the lock is released before the automatic prepare loop at line 99.
```diff
--- a/scripts/m9/incident-control.sh
+++ b/scripts/m9/incident-control.sh
@@
 find "$C/grants" "$C/requests" "$C/processed" "$C/reports" -type f -name '*.json' -mtime +7 -delete
+exec 9>"$D/prepare.lock"
+if flock -n 9; then
 for w in "$D"/work/*; do
  ...
 done
+fi
+exec 9>&-
```

### M1 (Minor): the controller's cleanup can make a direct prepare call silently do nothing
`scripts/m9/incident-prepare.sh:9` runs `flock -n 8 || exit 0`. Before this delta, only another prepare could hold that lock. Now the controller's cleanup block (`incident-control.sh:11-20`) holds it briefly on every tick, including while dispatch is disabled. If `incident-live.mjs` or an owner's manual call lands in that window, prepare exits 0 without launching anything. The window is short (one `systemctl is-active` per worktree), but exit 0 reports success when nothing happened. Patch: change it to `flock -w 10 8 || exit 0`, which waits out the brief cleanup but still yields to a real concurrent preparation.

### T1 (test gap): no fixture checks lock exclusion
`scripts/m9/pi-control-fixtures.sh:95-97` only shows that disabled cleanup erases the token. No case shows that the token **survives** while `prepare.lock` is held. Suggested addition: `flock "$T/state/incidents/prepare.lock" bash "$T/repo/scripts/m9/incident-control.sh" tick`, then assert the token still exists.

### T2 (test gap): optional-path property not asserted
The `systemd-run` stub already records its arguments to `$T/systemd`, but no fixture case checks for `InaccessiblePaths=… -$T/home/.codex`. A one-line `grep -qF -- "-$T/home/.codex" "$T/systemd"` after a successful launch would cover the observed failure.

## Persistence rewrite: `scripts/m3/pi-persistence.sh:41-56`
I found no defects.
- **Same files covered.** `services/access/src/archive.mjs:19` writes only `results/<2 hex>/<sha>.json`, which is exactly the depth-2 walk. The archive mount, user `3380:3380` and the `0700` owner all match `deploy/compose.yaml:319,364-367`.
- **Same sort order and hash input.** Names are ASCII hex, so JS `sort()` matches `LC_ALL=C sort`, and the names hash is taken over `./xx/<sha>.json\n` lines (the same shape as `scripts/m4/pi-after-reset.sh:63`). `verify.mjs` only compares write against read within one run.
- **Fails closed.** If the sweep (`archive.mjs:60-75`) deletes a file mid-walk, `readFileSync` throws, nothing prints, and `same("archive files=")` fails.
- **Residual risk, not a defect.** The script now runs a second Node process inside the gateway's 160 MiB cgroup. The highest gateway peak I found in recorded evidence is about 84 MB (M7 `stack.txt`), so there's headroom. However, the `resources_before_recreate` peak (line 89, collected after the line-76 `archive`) now includes this inspection process. Keep that in mind when reading the M3 resource figures.
- **Residual risk, not a defect.** Results can still expire legitimately between `write` and `read`, across a recreate that can take up to 900 s. The faster scan makes that much less likely but can't rule it out.

## Out of scope
The M2 redirect-classification issue, as you noted.
