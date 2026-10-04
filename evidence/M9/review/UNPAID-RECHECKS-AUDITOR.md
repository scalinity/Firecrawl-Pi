## Summary
The scope is tight: exactly P01/P02/P07/P08, frozen spec hash, initial raw/public hashes, the closed paid window, zero paid posture before and after, and cumulative attempts are all checked. Two gaps block egress. The plan can lose or overwrite real attempts, and the evaluator fails open on NaN timestamps. Line numbers are relative to the excerpts you provided.

## Critical Issues
1. **Real attempts can go unrecorded, and reruns overwrite earlier ones** (`private plan:13-14`).
   - **Failure:** A non-200 response, missing `scrapeId`, a JSON parse failure, or a correlation miss throws before `writeFileSync`. A rerun then rewrites `corpus-rechecks.json` from scratch. Earlier acquisitions disappear, so the cumulative ≤3 check passes on incomplete history. A failed recheck also aborts the run instead of being recorded as `usable:false`.
   - **Fix:** At startup, run `fs.openSync(privatePath,'wx',0o600)` to make the run single-shot. Persist each raw response before parsing or correlating it. Record failures as results rather than throwing.

2. **NaN `completed_utc` fails open** (`scripts/m9/resource-reuse.mjs:12-13,19`).
   - **Failure:** If `completed_utc` is missing, `end` is NaN. Then `end<start` and `finished>end` are both false, so per-result window checks pass. The same applies to a missing `initialWindow.closed_utc` (`start<=NaN` is false).
   - **Fix:** `if(![start,end,Date.parse(initialWindow.closed_utc)].every(Number.isFinite)||end<start||…)return false;`

## Warnings
1. **Cloud audit regex is line-local** (`resource-reuse.mjs:11`).
   - **Failure:** With `/m`, a single `cloud_host=0` line passes even if another line reports `cloud_host=1`. `acquisition=` takes the first match, which may be `proxy_acquisition=` or a pre-window count.
   - **Fix:** Require exactly one `^cloud_host=(\d+)$` line equal to 0. Anchor `\bacquisition=` and require it to be ≥ the initial count plus 4.

2. **`proxy_micro_usd` is unchecked** (`resource-reuse.mjs:22`).
   - **Failure:** A nonzero proxy cost passes if `proxy_bytes` is 0.
   - **Fix:** Add `||r.response.acquisition.proxy_micro_usd!==0`.

3. **`sameCode` arity is ambiguous** (`scripts/m9/verify.mjs:2`).
   - **Failure:** The recheck path calls `sourceEquivalent(x)` with no second argument, while the fallback passes `false`. If the default permits a delta beyond the three pure files, out-of-scope runtime changes would be accepted.
   - **Fix:** Pass an explicit allowlist mode in both paths and assert its default.

4. **Fallback can still run after a failed recheck** (`verify.mjs:3`).
   - **Failure:** If the recheck record exists but fails, the gate falls through to the original-batch verifier.
   - **Fix:** Use `corpusOk = recheckRecord ? recheckOk : fallback`, and reject `evidence_mode` in the fallback.

## Suggestions
- **Origin regex** (`private plan:11`): `.*\.ts\.net` matches `https://x/y.ts.net`. Use `^https:\/\/[a-z0-9-]+(\.[a-z0-9-]+)*\.ts\.net(:\d+)?$`.
- **Test gaps** (`tests/contracts/m9-resource-reuse.test.mjs`): add mutations for:
  - missing `completed_utc`
  - `closed_utc` absent
  - `onlyMainContent:true`
  - `maxAge:1`
  - `proxy_micro_usd:1`
  - multi-line `cloud_host=0\ncloud_host=1`
  - an initially usable target (P03)
  - a duplicate id (`['P01','P01','P07','P08']` already fails the sort check; assert it)
- **Health check**: have the evaluator check `status_before.healthy===true`. Currently only the plan enforces it.

## Good Practices
- Merging applies only to `initialRecord.results[i].usable===false` and static/js classes, so P19 cannot be replaced.
- Exact request shape is enforced, and validated by `validateBody` before any egress.
- `liveEvidenceInWindow` re-verifies the initial batch, with hash binding to both raw and public records.
- The ledger key lists are compared before and after; provider reservations would show up.
- Tokens go only to the Pi-served private origin. Target URLs come only from the frozen spec.

## Verdict
**REQUEST CHANGES.** Fix Critical 1 and 2 and Warnings 1 and 2, add the listed test mutations, then re-review before releasing egress. No spending authorization is implicated.
