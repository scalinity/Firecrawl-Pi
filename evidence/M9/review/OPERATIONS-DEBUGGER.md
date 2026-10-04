## Code Review: M9 delta — known-endpoint redaction (M9-REG-15) and supervisor notice probe (M9-REG-16)

Reviewer: fresh independent read-only debugger on Opus 5.5 (`claude-opus-5-5`). I made no network calls, wrote no files and ran no tests. I treated evidence content as data only.

### Summary

Both pending changes are correct and narrow, and neither weakens a criterion.

- **Redaction (`scripts/m9/redaction.mjs:34`):** The one-line change adds the exact bare host from `PI_SSH_TARGET` (`split('@').at(-1)`) to the scan for real private endpoints. It only adds a value to the hard-fail list. It doesn't touch the rules or classifications, and `scripts/m1/pi-target.conf` is still excluded and unchanged.
- **Probe diagnosis is confirmed by code and evidence:**
  - `scripts/ops/tick.sh:127` emits `notice recovery_attempted "restart_budget_or_data_service:$svc"`.
  - `scripts/ops/lib.sh:172` names that file `<ts>-recovery_attempted-restart_budget_or_data_service_mcp-gateway.json`.
  - `scripts/m8/pi-fault.sh:42` (`ls | grep -c -- "$1"`) counts that file as an incident notice.
  - So the round loop breaks after round 1 (`pi-fault.sh:314`). That matches `evidence/M9/regression/M8/raw/faults.txt:134-135` (`round_1 … budget_notices:1`, `recovered … budget_notices:1`), which is preserved in `initial-supervisor-notice-faults.txt`.
- **The proposed anchored `-opened-`/`-cleared-` match restores the M8 I15 semantics.** Rounds 1–3 give 0, round 4 gives 1 (opened), and `recovered` gives 2 (opened + cleared after two clean ticks, `tick.sh:204-205`). That is exactly what `scripts/m8/verify.mjs:545` and `:576-577` require.

The remaining risks are in how the rerun gets into evidence and how it binds to a commit, not in the patch itself.

### 🔴 Critical Issues (Must Fix)

None

### 🟡 Warnings (Should Fix)

1. **A supervisor-only rerun can't simply be appended to `faults.txt`. It also inherits the shared restart budget.**
   - **Append fails:** `scripts/m8/verify.mjs:39-42` merges repeated `### supervisor` sections into one array, and `step()` (`:51`) takes the *first* `round_1`/`recovered`. An appended rerun would still be judged on the old `budget_notices:1` records, so I15 keeps failing.
   - **Redirect loses data:** `node scripts/m8/faults.mjs supervisor > …/faults.txt` would replace the whole file and drop every other case.
   - **What to do:** replace only the lines between `### supervisor` and its `### end` with the rerun's section. Keep the original file (already done) and record that the section was replaced, with the rerun's meta (`deployed_commit`, boot hash).
   - **Budget timing:** `evidence/M9/work/supervisor-window-current.txt:1` shows an mcp-gateway supervisor restart at epoch 1791023827. The runtime budget (`tick.sh:122-123`, 900 s) is shared, and the probe only rebases its *count* (`c0`), not the budget. A rerun starting before epoch 1791024727 (10:52:07Z) would hit the exhausted state by round 3, and I15 would fail for reasons unrelated to the fix.
   - **Suggested guard (probe only, no runtime change):** add this at the top of the `supervisor)` case:
     ```bash
     [ "$(jq -c --argjson t $(( $(now_s) - 900 )) 'select(.service == "mcp-gateway" and .epoch >= $t)' "$sup" 2>/dev/null | wc -l)" -eq 0 ] || { out refused '{"reason":"restart_budget_window_in_use"}'; exit 1; }
     ```
     It reports a refusal instead of producing a misleading failure, and it leaves the budget and `restarts.jsonl` alone.

2. **Committing either change invalidates the code binding of every current-evidence item, not just this case.**
   - Both edited files are under `scripts/`.
   - `scripts/m9/verify.mjs:6` (`sameCode`) and `scripts/m8/verify.mjs:287-292` (`deployed_code_is_head` across every meta commit in `faults.txt`, `soak.txt`, `heap.txt`, `backup-fixture.txt`, `rehearsal.txt`) diff the whole `scripts` tree against HEAD.
   - The redaction fix can't stay uncommitted: M9-REDACTION needs `source_commit===head` (`scripts/m9/verify.mjs:68`), and `deploy.sh` refuses a dirty tree.
   - So the dispositions' "rerun only this case" is not enough for acceptance on its own. `faults.txt` meta `591dff2`, `evidence/M9/incident-proof.json` and `work/fixture-run.json` would all stop binding.
   - Several bound items were already collected on earlier commits, so this may be the planned final re-collection. Still: land both fixes in one commit, deploy it, dry-run the verifier, and then re-collect everything bound to the code. Record the REG-15/REG-16 outcomes as pending that collection, not as complete.

3. **The redaction scan uses an unanchored `includes()`.** The bare host is short and generic, so it also matches as a substring (any `<prefix><bare host>`).
   - Repository search found no such superstring today. The only matches are `scripts/m0/snapshot.sh:9`, `scripts/m0/build-audit.mjs:163`, `evidence/M0/*` and `evidence/M8/*/raw/faults.err`.
   - This fails closed, not open, which is acceptable for a security gate.
   - Before committing, confirm none of those files fall in the `git diff 55d756c…HEAD` set at `redaction.mjs:33`. If one does, M9-REDACTION goes to FAIL and needs a classification or a scoped fix, not a wider rule.

### 🔵 Suggestions (Consider)

1. **Suggested shape for the probe.** This version uses no `ls` parsing, matches the key literally, and treats an absent directory safely:
   ```bash
   notices() { local f n=0; for f in "$STATE"/alerts/outbox/*.json; do case ${f##*/} in *-opened-"$1".json|*-cleared-"$1".json) n=$((n + 1)) ;; esac; done; echo "$n"; }
   ```
   Checks against this shape:
   - **Absent directory:** `nullglob` is not set in `scripts/ops/lib.sh`, so the unmatched glob stays a literal `*.json`. That fails both patterns and the function prints `0`.
   - **Output:** it always prints exactly one integer and returns 0, which `$(( … ))` and `--argjson` at `pi-fault.sh:245,251,265,269,280,310-319,341,344` need.
   - **Literal key:** the quoted `"$1"` is matched literally, so `.`/`-` in keys are never treated as pattern characters.
   - **Temp files:** the `.json` anchor also skips `write_atomic`'s `mktemp "<id>.json.XXXXXX"` temp files, which the old `grep` could briefly count.
   - **Other callers:** all of them (`disk_critical`, `memory_low`, `temperature_high`, `foreign_container`) pass fixed, already-normalized keys that only ever produce opened/cleared notices. Their counts stay the same, and the new `investigation_started`/`diagnosis_ready`/`approval_required` kinds are now excluded too.
2. **Fix the leak at its source as well.** `scripts/m8/faults.mjs:16` `hide()` replaces only the full `user@host`, which is how the bare host reached the stderr evidence. Adding the same exact bare-host pair (`[T.PI_SSH_TARGET.split('@').at(-1), "<pi-ssh-host>"]`) after the full-target pair would stop a flaky SSH during the rerun from producing evidence that the scanner then rejects. It is exact-value only and doesn't change functional configuration.
3. **Keep endpoint values out of this report if it's saved.** If it goes under `evidence/M9/review/`, keep the literal bare host, LAN address and home-directory paths out of it. `redaction.mjs:34` and the `local-path` rule would flag them. This report uses none.

### ✅ Good Practices

- The original failed supervisor run is kept unchanged (`initial-supervisor-notice-faults.txt`) beside the current raw.
- The redaction fix only adds an exact configured value. No blanket rule is widened, no classification is added, and functional endpoint configuration is untouched.
- The probe fix changes only which files are counted. The runtime supervisor budget, ledger and notice producer stay unchanged, and the verifier's expected 3 restarts, then 1 opened and 1 cleared, still applies.
- The diagnosis is traced from producer (`tick.sh:127`, `lib.sh:172`) to consumer (`pi-fault.sh:42,314`) to evidence (`faults.txt:134-135`).

### Verdict

**APPROVE WITH WARNINGS.** Both changes are correct as proposed. Before recording REG-15/REG-16 as FIXED:
- Replace (don't append) the `### supervisor` section in the M9 regression `faults.txt`.
- Start the rerun only after the mcp-gateway 15-minute restart window has cleared, ideally with the refusal guard above.
- Account for the code-binding cascade by committing both fixes together, deploying, dry-running the verifier, then re-collecting all code-bound evidence.
