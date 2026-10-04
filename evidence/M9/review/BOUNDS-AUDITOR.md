## Code Review: M9 incident evidence bounds

### Summary
I compared the four changed files with HEAD `a0ae1edd`. I also read the code that calls into them or launches the run: `scripts/m9/incident-prepare.sh:87-93` (the systemd-run bounds), `scripts/m9/incident-agent.sh:15-26` (how `result.json` is produced) and `scripts/m9/incident-hook.sh` (where the model may write). I found no critical issues.

- **Producer and gate now use the same rule.** `scripts/m9/incident-live.mjs:18` and `scripts/m9/verify.mjs:56` both call `incidentVerdict`. Every field it checks survives the JSON write and read unchanged, so a proof that passes in the producer also passes the gate's `incidentVerdict` check.
- **The checked values match what is launched.** In `scripts/m9/evidence-checks.mjs:36-38`:
  - `MemoryMax=768M` gives `805306368`.
  - `RuntimeMaxSec=330` gives `'5min 30s'`.
  - `CPUQuota=50%` gives `CPUQuotaPerSecUSec='500ms'`.
  - `TasksMax=128` and `MemorySwapMax=0` match directly.
  - `--uid=danny` gives `User=danny`.
  - `NoNewPrivileges=yes` gives `true`.
- **The model check reads the real output.** It reads the keys of `modelUsage` in the raw CLI JSON, not the hard-coded `model` field in the proof.
- **The model cannot forge `result.json`.** The hook only allows `Write`/`Edit` inside `$W/tree` (`scripts/m9/incident-hook.sh:22,29`). `result.json` is only created by `incident-agent.sh:24-26`, from Claude's stdout.
- **Estimates are not treated as invoices.** `api_equivalent_estimate_usd` is not part of the verdict, and the verdict requires `invoiced_usd===null`.
- **Commit and root-fixture binding stay in `verify.mjs`.** `sameCode(proof.source_commit)` and `rootOk` remain only there, as you required.

### 🔴 Critical Issues (Must Fix)
None.

### 🟡 Warnings (Should Fix)
1. **`Number(...)` turns some missing or unknown values into 0** (`scripts/m9/evidence-checks.mjs:37-38`).
   - `Number(null)`, `Number('')`, `Number(false)` and `Number([])` all equal `0`. So a proof with `MemorySwapMax: null` or `""` passes, even though missing or unknown values are supposed to fail.
   - This can't happen today. `systemctl show` prints `infinity` for an unset value, and the only other way in is a hand-edited proof, which could just as well write `'0'`. It is still looser than it should be.
   - Since the producer always stores the raw `systemctl` strings, compare exactly instead:
     ```js
     u.MemorySwapMax==='0'&&...&&u.TasksMax==='128'
     ```
     The test fixture already uses `'0'` and `'128'`.
2. **Several unit fields are taken on trust or not captured at all.**
   - `unit.tools` is hard-coded to `'Read,Edit,Write'` in `scripts/m9/incident-live.mjs:17`. Checking it in `incidentVerdict` always succeeds, so it is not evidence.
   - Several privilege settings in `incident-prepare.sh:90-91` are never captured or checked: `ProtectSystem=strict`, `ProtectHome=read-only`, `PrivateTmp`, `ReadWritePaths` and `InaccessiblePaths`. The last one is what hides `~/.claude`, `~/.ssh` and `/etc/firecrawl-pi` from the model.
   - Today these are only protected indirectly. Line 8 checks that the deployment is at HEAD, and the gate's `sameCode` check ties the proof to the current code.
   - To match "every actual … privilege field", add these to the `systemctl show -p` list and pin them in `incidentVerdict`. Otherwise, rename `tools` to something like `declared_tools` so it isn't read as observed.

### 🔵 Suggestions (Consider)
1. **A raw file containing `null` crashes the check** (`scripts/m9/evidence-checks.mjs:33-34`). `JSON.parse('null')` returns `null`, so `r.modelUsage` throws a TypeError. In `verify.mjs` that aborts the run before `acceptance.json` is written. The result is still a failure, but a noisy one. Fix: `if(!r||typeof r!=='object')return false;` right after parsing.
2. **Dead code in the producer** (`scripts/m9/incident-live.mjs:17`). The inline `state:` expression is now always overwritten by line 18. Drop it so there is only one acceptance rule.
3. **Missing test cases** (`tests/contracts/m9-evidence-bound.test.mjs`). Add negative cases for:
   - mixed models (`{'claude-opus-5-5':…, 'other':…}`)
   - no `modelUsage` / empty `{}`
   - a unit field that is missing, e.g. `TasksMax` deleted
   - `MemorySwapMax: null` and `''` (this pins down Warning 1)
   - `invoiced_usd: 0`
   - a mismatched `incident_id` and an edited raw with a stale hash
4. **Possible false failures from the model check.** Requiring every `modelUsage` key to be `claude-opus-5-5` is correctly strict. But if the CLI ever records an internal helper model, an honest run will come out `IMPLEMENTED_UNVERIFIED`. This fails safely; it's worth noting in the evidence notes.
5. **Gate reports `NOT_RUN` instead of `FAIL`** (`scripts/m9/verify.mjs:58`, existing behaviour). When a proof exists but fails the check, the gate still says `NOT_RUN`. Consider `proof?'FAIL':'NOT_RUN'`, as M9-CORPUS and M9-RESEARCH already do.

### ✅ Good Practices
- One shared check (`incidentVerdict`) replaces two copies of the rule, so the producer and the gate can't drift apart.
- The verdict recomputes the SHA-256 of the private raw output and reads the model from what the CLI actually reported.
- Parse errors return `false`, and every comparison is `===` against fixed values (apart from Warning 1).
- The new test checks that each systemd bound, including `infinity`, the wrong user and the wrong tools, makes the verdict fail one at a time. It also covers a wrong model and `auth_removed:false`.
- Commit binding (`sameCode`) and root-fixture binding (`rootOk`) remain in the final gate.

### Verdict
- [ ] Approve
- [x] Approve with Suggestions
- [ ] Request Changes
