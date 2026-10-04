## Code Review: M9 incident launch/cleanup and persistence delta
### Summary
All four changed files meet the stated requirements, and I found no defects. Both token-cleanup passes in `scripts/m9/incident-control.sh` now hold `prepare.lock`. A busy prepare now exits with code 3 instead of a false success. The agent unit stays unprivileged and bounded, and only the optional private directories are skippable. The rewritten archive check in `scripts/m3/pi-persistence.sh` produces the same output format and still fails closed in `scripts/m3/verify.mjs` when retention removes files.

### 🔴 Critical Issues (Must Fix)
None

### 🟡 Warnings (Should Fix)
None

### 🔵 Suggestions (Consider)
1. **Lock contention permanently blocks automatic investigation.** In `scripts/m9/incident-control.sh:109-111`, any non-zero result from prepare writes `blocked/$id.json` with `PREPARATION_BLOCKED` and `automatic_retry:false`. Exit code 3 from a busy lock is now included. The controller can't race itself here: it closes fd 9 at line 101 and holds `control.lock`. The race needs a prepare running outside the controller, such as `scripts/m9/incident-live.mjs:8` or a manual `sudo` run. This matches the existing policy for an active unit (`incident-prepare.sh:11`, also exit 3), so it isn't a defect. If brief contention should only postpone the incident, the loop could skip on exit 3: `bash … || { rc=$?; [ "$rc" = 3 ] && continue; put_obj …; notice …; }`.
2. **Nothing actually bounds the archive check, despite the comment.** In `scripts/m3/pi-persistence.sh:44`, `D exec … node` has no time limit. It also reads each result whole (`readFileSync`) inside the gateway's own cgroup. Running it under `timeout 300 sudo -n docker exec …`, and hashing large files with `fs.createReadStream`, would make the "bounded" comment true. Either way, a failure only drops the output lines, which the verifier rejects.

### ✅ Good Practices
- **Locked cleanup on both paths.** The pass that runs while dispatch is disabled (`scripts/m9/incident-control.sh:11-21`) runs before the `incidents.env` checks. So inactive tokens are removed even when the env file is missing or automatic dispatch is off, and nothing is launched. The enabled-path pass (lines 83-101) takes the same lock before removing tokens, writing `failed.json` or deleting work directories. Both passes release fd 9 before any prepare call (lines 67 and 109), so the controller can't deadlock itself.
- **No false success from a busy prepare.** `scripts/m9/incident-prepare.sh:9` now exits 3, so an owner's "investigate" grant is recorded as `FAILED` with `exit_code:3`, not `EXECUTED`. Prepare holds the lock until `systemd-run` returns, so cleanup only sees the unit after it is active.
- **Startup tolerates missing optional paths.** In `scripts/m9/incident-prepare.sh:91`, only `-/home/danny/.ssh` and `-/home/danny/.codex` can be missing without stopping startup. `/home/danny/.claude` has no `-` prefix because line 27 already requires it to exist. Docker, the data directory and the control directory also have no prefix, so the sandbox fails closed. The unit still runs as `danny` with `NoNewPrivileges`, `ProtectSystem=strict`, memory, CPU and task limits, and `RuntimeMaxSec=330`.
- **The archive check keeps its old output and still fails closed.**
  - The mount is correct: `/srv/firecrawl-pi/data/artifacts` → `/srv/artifacts` (`deploy/compose.yaml:364-367`), read as uid 3380, which owns the files.
  - The output is unchanged: the `./`-relative names, sort order, newline-joined names hash and per-file content-vs-name check match the old version for ASCII hex names. Like `find -type f`, it skips symlinks.
  - If retention deletes a file during the scan, node throws, so no `archive` line is printed. If it deletes one between the write and read phases, the names hash changes. Either way `scripts/m3/verify.mjs:594,601-606` (`same("archive files=")`, `files > 0`) fails, so cleanup is never reported as success.
  - Every row hash, sentinel, registry and container-replacement check is unchanged.
- **The fixtures can actually fail.**
  - `scripts/m9/pi-control-fixtures.sh:95-111` holds the real lock through a separate open of the lock file, which correctly conflicts with the scripts' own `exec N>` reopen.
  - Exit code 3 can be told apart from other failures here: no unit is active, and `die` exits 2.
  - The enabled-path check would catch a regression: without the lock, cleanup would write `failed.json`.
  - The fixtures also cover keeping an active agent's token and removing an inactive agent's token while dispatch is disabled.

### Verdict
[ ] ❌ Request Changes (critical issues)
[x] ⚠️ Approve with Suggestions
[ ] ✅ Approve
