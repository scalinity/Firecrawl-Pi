## Code Review: M9 incident evidence bounds

### Summary
The delta moves the incident acceptance check into one shared `incidentVerdict` in `scripts/m9/evidence-checks.mjs`. Both the producer (`scripts/m9/incident-live.mjs:18`) and the final gate (`scripts/m9/verify.mjs:56`) now call it. The model check now reads the raw Claude output's `modelUsage` keys, not the hard-coded `model:'claude-opus-5-5'` field in the proof. If `modelUsage` is missing, empty, or names any other model, the check fails.

I checked every pinned bound against the producer in `scripts/m9/incident-prepare.sh:87-89` and all of them match:
- `MemoryMax=768M` → `805306368`
- `MemorySwapMax=0`
- `CPUQuota=50%` → `CPUQuotaPerSecUSec=500ms`
- `TasksMax=128`
- `RuntimeMaxSec=330` → `5min 30s`
- `NoNewPrivileges=yes`
- `--uid=danny`

The pinned tools string matches `scripts/m9/incident-agent.sh:16`. The estimate is never treated as an invoice: `invoiced_usd===null` is required and `api_equivalent_estimate_usd` never affects the verdict. The `source_commit` (`sameCode`) and root fixture (`rootOk`) checks stay in `scripts/m9/verify.mjs:53,56`, as required.

The remaining issues are robustness gaps that fail closed or need unusual `systemctl` output. None of them can produce a false PASS.

### 🔴 Critical Issues (Must Fix)
None.

### 🟡 Warnings (Should Fix)
1. **A raw file containing `null` crashes the check instead of returning false** (`scripts/m9/evidence-checks.mjs:33-34`).
   - **Trace:** `JSON.parse('null')` succeeds and returns `null`. The next line, `r.modelUsage`, then throws a `TypeError`. The hash check comes after this line, so it never runs.
   - **Effect in `verify.mjs:55-56`:** any private `incident/<id>.json` containing `null` aborts the whole final gate. Every other result is lost, instead of M9-INCIDENT simply being recorded as `NOT_RUN`.
   - **Effect in the producer:** it throws before writing `incident-proof.json`.
   - This fails closed, but it is not a clean binary verdict. Suggested patch:
     ```js
     let r;try{r=JSON.parse(raw);}catch{return false;}
     if(!r||typeof r!=='object')return false;
     ```
2. **`Number()` coercion lets an empty or null value pass as `0`** (`scripts/m9/evidence-checks.mjs:37-38`).
   - `Number('')===0` and `Number(null)===0`. If `systemctl show` printed an empty `MemorySwapMax=` line, it would pass as `0`, even though the requirement is that unknown values must fail. `TasksMax` uses the same coercion and would also accept forms like `'0x80'` or `' 128 '`.
   - In practice this is hard to reach, because systemd prints `infinity` when a value isn't set. Still, the producer always stores these fields as raw `systemctl` strings, so an exact string comparison is both stricter and simpler:
     ```js
     u.MemorySwapMax==='0'&&...&&u.TasksMax==='128'
     ```
     The existing test already uses `'0'` and `'128'`, so it keeps passing.

### 🔵 Suggestions (Consider)
1. **Remove dead code** in `scripts/m9/incident-live.mjs:17`. The inline `state:` expression is always overwritten on line 18. Removing it, or setting a placeholder, avoids a second rule that could later disagree with the shared check.
2. **`unit.tools` is a constant set by the producer** (`incident-live.mjs:17`), not something read from the live unit. It only proves anything because `incident-agent.sh` is covered by `sameCode`. A comment saying so, or reading the value from the deployed script, would make that clearer.
3. **Add test cases** to `tests/contracts/m9-evidence-bound.test.mjs`:
   - `modelUsage` missing
   - `modelUsage: {}`
   - mixed models, e.g. opus plus another model
   - `MemorySwapMax: ''`
   - raw `'null'` (once warning 1 is fixed)
   - a raw/hash mismatch
   - `invoiced_usd` set to a number
4. **Possible false negatives from the exact model match.** If a real run lists an extra helper model, or a model ID with a suffix, in `modelUsage`, a valid run would be rejected. That fails closed, so it's acceptable, but worth knowing if a live run unexpectedly comes back `IMPLEMENTED_UNVERIFIED`.

### ✅ Good Practices
- The producer and the gate share one function, so they cannot drift apart.
- The model is checked from the raw output, which is bound by its SHA-256 hash, not from a field the producer writes itself.
- Each pinned value is exact and matches the real `systemd-run` properties. `infinity` and missing fields fail, either through `NaN` or strict string comparison.
- The test changes each bound one at a time, including `User:'root'`, and also checks a wrong model and `auth_removed:false`.
- The estimate (`api_equivalent_estimate_usd`) is kept separate from `invoiced_usd`, and acceptance requires `invoiced_usd` to be `null`.

### Verdict
- [ ] Approve
- [x] Approve with Suggestions
- [ ] Request Changes
