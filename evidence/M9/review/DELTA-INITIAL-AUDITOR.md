I couldn't diff the files against `27f29d1`, so the review is incomplete. The hook blocked every Bash call (no `git diff`, `rg`, `sed` or `ls`), blocked reading `<review-skill>`, and blocked Glob in the review directory. Read and Grep worked in the repository. That means I reviewed the current contents of the four files plus their callers, and assumed which parts are new from your description. I used a standard severity-ordered layout because I couldn't load the `/review` template.

# Review: M9 incident cleanup/launch and M3 persistence (uncommitted)

## Verdict
No critical findings. Most of what you asked to verify holds. One medium issue: cleanup still races preparation on the path that runs when automatic dispatch is enabled. Two low test-coverage gaps and one nit.

## Findings

### Medium — Cleanup with dispatch enabled still races preparation
`scripts/m9/incident-control.sh:83-96`

The new pass at lines 11-21 erases tokens only while holding `prepare.lock`. The older pass at lines 83-91, which runs when dispatch is enabled, does the same erasure without the lock. It also writes the terminal `failed.json` without it.

The controller itself can't hit this race: it releases fd 9 at line 21, takes `control.lock`, and runs prepare one incident at a time. But prepare has a caller outside the controller: `scripts/m9/incident-live.mjs:8` runs `sudo -n bash …/incident-prepare.sh <id>` directly, as would any owner resume over sudo.

How it fails:
1. The live check starts prepare for id X. Prepare takes `prepare.lock` and writes the token (`incident-prepare.sh:76`). It then writes `launch-count`, `launched-at` and the ledger line (lines 80-83).
2. The timer runs a controller tick before prepare reaches `systemd-run` at line 87.
3. In that tick, the unit isn't active yet (line 86), so line 87 deletes the token. `launched-at` exists and there's no `result.json`, so lines 88-90 write `failed.json` and send an `INVESTIGATION_FAILED` notice.
4. Prepare launches the unit. `incident-agent.sh:11` (`cat …/access-token`) fails under `set -e`.

Result: a false terminal failure, one of the four daily launches spent, and a spurious notice to the owner. These lines probably predate the delta, but the delta's goal of "no racing preparation" only holds while dispatch is disabled.

Patch: put the same lock around the second pass. Nothing inside it takes the lock, and prepare is only called later, at line 104, after the lock is released.
```diff
@@ scripts/m9/incident-control.sh
 find "$C/grants" "$C/requests" "$C/processed" "$C/reports" -type f -name '*.json' -mtime +7 -delete
+exec 9>"$D/prepare.lock"
+if flock -n 9; then
 for w in "$D"/work/*; do
  ...
 done
+ flock -u 9
+fi
+exec 9>&-
```

### Low — The fixtures don't test the two new properties
`scripts/m9/pi-control-fixtures.sh:91-102`
- **Lock exclusion isn't tested.** No test holds `prepare.lock` and checks that the token survives. Suggested test:
  ```bash
  flock "$T/state/incidents/prepare.lock" bash "$T/repo/scripts/m9/incident-control.sh" tick
  ```
  Run it with dispatch disabled, then assert `[ -e "$W/run/auth/access-token" ]`.
- **The enabled-path erasure is no longer tested on its own.** In the test at line 102, the new pass at lines 11-21 deletes the token before line 87 runs, so the "removes auth" check would pass even if line 87 broke.
- **The optional-path launch is never tested.** No fixture completes a launch (`doctor.sh` isn't copied), so nothing checks that the recorded `systemd-run` arguments contain `-$T/home/.codex` and `-$T/home/.ssh`. Real namespace behaviour still needs a live run.

### Low — Expiry race in the archive check is smaller but still there
`scripts/m3/pi-persistence.sh:76,105`; `scripts/m3/verify.mjs:606`

`names_sha256` from the write section is compared exactly with the read section, and the recreate step between them can take up to 900 s. A legitimate expiry or sweep deletion in that window still fails X02, and a file that vanishes mid-scan makes node throw on ENOENT. Both fail closed, and the single-process scan shrinks the window a lot. This is a known limit, not a regression.

### Nit — The scan only looks at the `results/<dir>/<file>.json` layout
`scripts/m3/pi-persistence.sh:47-50`

The old `find . -name '*.json' -type f` matched any depth. The new scan matches exactly depth 2. The writer (`services/access/src/archive.mjs:19`) and its sweep (`:67-68`) use the same depth-2 layout, so nothing is missed today. A stray file elsewhere would no longer be counted. If you want that covered, count anything outside the expected pattern as `bad`.

## Requirements checked (from current file contents)
- **Bounded, unprivileged run** (`incident-prepare.sh:87-93`): uid/gid danny, `NoNewPrivileges`, `ProtectSystem=strict`, `ProtectHome=read-only`, writes only to `tree` and `run`. Limits: 768M memory, no swap, 50% CPU, 128 tasks, `RuntimeMaxSec=330` plus a 300 s timeout in the agent.
- **Optional private directories** (`incident-prepare.sh:91`): only `.ssh` and `.codex` get the `-` prefix, so a missing one can't stop the sandbox starting. The required paths stay strict, so a missing one fails closed. `/home/danny/.claude` has already been read at line 27, so it exists.
- **Token erasure with dispatch disabled** (`incident-control.sh:11-21`): the pass runs before the `incidents.env` check. Prepare holds the same lock file on fd 8 from line 9 until it exits, which is after `systemd-run` returns, so the window before the unit starts is covered. A unit that dies at namespace setup is collected and shows as inactive, so the next tick erases its token. The controller releases fd 9 before running prepare, so prepare's `flock -n … || exit 0` can't silently skip.
- **Persistence assertions are intact:**
  - The ledger hash covers all four tables, and the billing hash covers reservations and usage.
  - The registry line still has its hash and client count.
  - The 10-service list is unchanged, and X02 requires 10 replaced and 10 healthy.
  - Every shard file's content is hashed against its name inside the gateway as uid 3380. The files are 0600, owned by 3380, so that user can read them.
  - Sorting and the newline-joined names hash match the old shell approach, and any failure gives missing lines, which X02 rejects.
- **Out of scope:** the M2 redirect classification wasn't reviewed, as you instructed.
