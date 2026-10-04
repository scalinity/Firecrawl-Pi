## Code Review: M9 delta (pending redaction endpoint and supervisor probe correction)

### Summary

I reviewed this on exact `claude-opus-5-5`, read-only, with no network calls, writes or tests. I checked:

- the pending change at `scripts/m9/redaction.mjs:34`
- the proposed `notices()` change at `scripts/m8/pi-fault.sh:42`
- how its callers use it (`scripts/m8/pi-fault.sh:304-319`)
- the notice producer (`scripts/ops/lib.sh:170-182`, `scripts/ops/lib.sh:42-47`)
- the supervisor (`scripts/ops/tick.sh:117-132`, `scripts/ops/tick.sh:169`, `scripts/ops/tick.sh:203-205`)
- the judges in `scripts/m8/verify.mjs` (I15 at lines 540-548, O02 at lines 569-579)
- findings M9-REG-15 and M9-REG-16 in `evidence/M9/review/REVIEW.md`
- `evidence/M9/work/supervisor-window-current.txt`

**The cause in M9-REG-16 is confirmed.** `notice()` names files `<UTC>-<kind>-<key with characters outside [A-Za-z0-9_.-] replaced by _>.json`. Since M9, `tick.sh:127` writes a `recovery_attempted` notice on every restart that stays within budget, under the same key, `restart_budget_or_data_service:mcp-gateway`. That file is `…-recovery_attempted-restart_budget_or_data_service_mcp-gateway.json`. The current `grep -c -- "$1"` counts it, so this happens:

1. Round 1's `until_` succeeds on the notice count.
2. `budget_notices` becomes 1.
3. Line 314 breaks out of the loop.

I15 `three_restarts` and O02 `supervisor` therefore cannot pass.

**The proposed fix is correct.** Matching only `*-opened-"$1".json|*-cleared-"$1".json` on the basename, with `"$1"` quoted, fixes the count and keeps the verifier's expectations. Those are: rounds 1–3 with `budget_notices === 0` and restarts 1/2/3; round 4 with 1 opened notice and 3 restarts; `recovered` with 2 notices (opened plus cleared).

**The redaction change only adds detection.** It adds the bare host (`PI_SSH_TARGET.split('@').at(-1)`) to the list of endpoint values that fail the scan. It doesn't redact anything, change functional configuration, or rewrite files.

### 🔴 Critical Issues (Must Fix)

None

### 🟡 Warnings (Should Fix)

1. **`notices()` must always print an integer, including when the directory is missing.** The values are used in arithmetic and `-gt` tests at `scripts/m8/pi-fault.sh:310`, `:312`, `:314` and `:319`.
   - If a rewrite prints nothing when the outbox doesn't exist (a `while read` loop with no final `echo`, or a pipeline whose `|| true` swallows the output), then `$(( $(notices …) - n0 ))` becomes `$(( - n0 ))`. The comparisons also stop meaning anything.
   - The current version gets this right only because `grep -c` prints `0` before exiting 1.
   - Recommended shape, which needs no `ls`/`grep`, treats the key literally, and works whether or not the directory exists:

   ```bash
   notices() { local f n=0; for f in "$STATE"/alerts/outbox/*.json; do case ${f##*/} in *-opened-"$1".json|*-cleared-"$1".json) n=$((n + 1)) ;; esac; done; echo "$n"; }
   ```

   - Missing directory: there is no `nullglob` or `failglob` in `scripts/ops/lib.sh` (I checked). The unmatched glob therefore stays as the literal `*.json`, which the pattern doesn't match, so the function prints `0`.
   - The pattern ends at `.json`, so it also skips `write_atomic`'s temporary files `<id>.json.XXXXXX` (`scripts/ops/lib.sh:44`). The current unanchored grep counts those for a moment during `deliver_notices` rewrites, which can briefly add 1 to the count.

2. **The 15-minute restart window must be empty before the rerun starts.** `evidence/M9/work/supervisor-window-current.txt` records a supervisor restart of `mcp-gateway` at `epoch 1791023827` (10:37:07Z), left by the failed fresh probe. `tick.sh:122` counts restarts newer than `NOW - 900`. If the rerun starts before about 10:52:07Z:
   - round 1 sees `recent=1`
   - round 3 sees `recent=3`, so the budget is exhausted and an opened notice is written
   - round 3 then records `budget_notices=1`, and I15 and O02 both FAIL

   There's no code defect here, but the rerun has a precondition. Record (read-only) that `restarts.jsonl` has no `mcp-gateway` entry newer than 900 s before round 1. Don't edit the ledger.

3. **The fix only takes effect on the Pi after a deploy.** The case runs from `/opt/firecrawl-pi/scripts/m8/pi-fault.sh` (header line 3). The window snapshot shows deployed commit `591dff2`, while HEAD is `6e43824`. Notes on this:
   - `deploy.sh` refuses to run while tracked files outside `evidence/` have changes, so the `redaction.mjs` edit has to be committed (or set aside) first.
   - Once deployed, check that the commit recorded in the rerun's status matches the commit containing the `notices()` fix.
   - Check whether this commit triggers the deployed-code re-collection cascade for other cases that run on the Pi. This comes from project memory, not from code I verified.

4. **Keep the original failed run, and write the rerun beside it.** I15 and O02 read `${RAW}faults.txt`. Write the single-case rerun to a new `evidence/M9/<name>/` location and point the verifier at it through the evidence-base switch. Don't let it overwrite the failed raw output or any accepted M8 `verification.json`.

### 🔵 Suggestions (Consider)

1. **Tighten the filename pattern.** `*-opened-"$1".json` would in theory also match a notice of another kind whose key ends in `-opened-<key>`. No current key does, so this isn't reachable today. The pattern can be made exact at no cost by matching the producer's timestamp form:
   `[0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9]T[0-9][0-9][0-9][0-9][0-9][0-9]Z-opened-"$1".json` (and the same with `cleared`).

2. **Case-insensitive host check.** `scripts/m9/redaction.mjs:34` compares hosts case-sensitively, but hostnames aren't case-sensitive. Optionally also flag the bare host matched case-insensitively (for example, `read(path).toLowerCase().includes(host.toLowerCase())`). This stays an exact literal, not a broader redaction.

3. **Older evidence still contains the host.** The bare host appears in older evidence that this scan doesn't cover (`evidence/M8/**/raw/faults.err`, `evidence/M8/window-1/*`, `evidence/M0/*`). That's consistent with "accepted evidence is never overwritten", and the delta scope is intended. Consider stating it as a known, accepted residual in M9-REG-15 so it isn't mistaken for scanner coverage.

4. **Missing config values are searched as text.** On line 34, if `PI_LAN_ADDRESS` or `PI_SSH_KEY` were missing from the config, `includes(undefined)` would search for the text `"undefined"`. This is pre-existing and fails closed. A one-line guard (`.filter(Boolean)`) would make that explicit.

### ✅ Good Practices

- The endpoint list comes from the single config, `scripts/m1/pi-target.conf`, and isn't hard-coded. The config itself is the only file excluded from the scan.
- The new check is an exact literal and only produces findings. It changes no rules and widens no redactions.
- Normalizing the key in the producer, and having the probe pass already-normalized fixed keys, keeps the exact-literal match sound.
- The fix doesn't touch the supervisor's budget (`recent -ge 3` over 900 s), the ledger, or the verifier's thresholds. The 3 restarts → 1 opened → 1 cleared criterion stays the same.
- The supervisor records each restart before performing it (`tick.sh:125-126`), so a tick that is killed partway still counts against the budget.

### Verdict

[ ] ❌ Request Changes
[x] ⚠️ Approve with Suggestions
[ ] ✅ Approve

You can go ahead with both changes. Make `notices()` always print an integer, and confirm the 15-minute window is empty and the fix is deployed before the single-case rerun.
