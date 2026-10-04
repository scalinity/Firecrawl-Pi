## Code Review: M9 incident launch/cleanup and persistence delta
### Summary
All four changed files meet the stated invariants. Both token-cleanup passes in `scripts/m9/incident-control.sh` hold `prepare.lock`, and the first runs before the `incidents.env` gate. A busy prepare lock now exits 3 rather than 0, so no caller sees a false success. The protected-path changes keep the agent unit unprivileged and bounded. The single-process archive scan in `scripts/m3/pi-persistence.sh` emits the same hashes as before and can't let a failure or retention deletion pass as success.

### 🔴 Critical Issues (Must Fix)
None

### 🟡 Warnings (Should Fix)
None

### 🔵 Suggestions (Consider)
1. **A busy lock permanently blocks an automatic incident.** At `scripts/m9/incident-control.sh:109-111`, any non-zero exit from prepare writes `blocked/$id.json` with `automatic_retry:false`. That now includes exit 3 from a busy lock. The first cleanup pass (lines 11-21) runs before `control.lock` is taken. So a second tick started by hand at the same moment could hold `prepare.lock` briefly, and an incident that should simply be retried next tick gets blocked instead. Production can't hit this: the only caller is the `fcpi-incident.service` oneshot, and systemd never runs two copies at once. If you want to rule it out entirely, skip on exit 3 and leave the other exit codes as they are:
   ```bash
   rc=0; bash "$REPO/scripts/m9/incident-prepare.sh" "$id" || rc=$?
   [ "$rc" != 3 ] || continue
   if [ "$rc" != 0 ]; then
    put_obj "$D/blocked/$id.json" ...
   ```
   This exit 3 also covers the existing "another agent is active" case at `scripts/m9/incident-prepare.sh:11`, which already blocks permanently. Decide whether that should keep its current behaviour.
2. **Add a time limit to the archive scan.** The scan at `scripts/m3/pi-persistence.sh:44` (`D exec ... node`) has no timeout, and neither did the old loop. Wrapping it in `timeout 300` would put an upper bound on checkpoint time. If it timed out, the `archive files=` lines would be missing, and `scripts/m3/verify.mjs:594` would still fail the run because it requires a non-empty matching line.
3. **Merge the two cleanup loops.** The loops at `scripts/m9/incident-control.sh:13-18` and `85-98` share the same skip-if-active check and token removal. Moving them into one locked function would stop them drifting apart. The second loop's body also wasn't re-indented inside its new `if`.

### ✅ Good Practices
- **No race with preparation:** prepare holds the lock on fd 8 (`scripts/m9/incident-prepare.sh:9`) until `systemd-run` returns. Both controller passes take the same lock with `flock -n` and close fd 9 before calling prepare (lines 21 and 101). Cleanup therefore can't run between worktree setup and unit start, and the controller can't deadlock against prepare.
- **Disabled-path cleanup can't fail on a missing directory:** it runs ahead of the `incidents.env` gate. `pi-init.sh:12` creates `$D` before it installs the timer, so the `exec 9>` redirect always has a directory to write into.
- **Only the optional paths became optional:** the `-` prefix is on `/home/danny/.ssh` and `/home/danny/.codex` only. `/home/danny/.claude`, `/etc/firecrawl-pi`, the data root, `docker.sock` and `$D/control` are still required. NoNewPrivileges, MemoryMax, TasksMax and RuntimeMaxSec are unchanged.
- **Busy preparation is reported honestly:** an investigate grant now records `FAILED` with `exit_code:3` instead of `EXECUTED`.
- **The archive scan works unprivileged:** it runs as uid 3380 inside the gateway, the only writer of `/srv/artifacts`.
- **The scan output matches the old format:** `./`-prefixed sorted names, a names hash over newline-joined lines, and a per-file content-vs-name check.
- **Failures can't be hidden:** a vanished file makes node throw on ENOENT, which drops the `archive` line. `same()` needs a non-empty, identical line in both the write and read sections, so that run fails. A retention deletion between write and read changes the count and hash, and fails the same way.
- **Ledger, billing, registry and sentinel checks are untouched.**
- **The new fixtures test what changed:** cleanup leaves the token alone while the lock is held (disabled and enabled). A busy lock gives exit 3 and creates no worktree. An active unit keeps its auth. An inactive token is removed with dispatch disabled and no `failed.json` appears.

### Verdict
[ ] ❌ Request Changes (critical issues)
[x] ⚠️ Approve with Suggestions
[ ] ✅ Approve
