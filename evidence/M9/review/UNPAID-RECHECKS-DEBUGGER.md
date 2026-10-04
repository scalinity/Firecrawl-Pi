## Summary
The evaluator correctly enforces exact IDs, posture, ledger keys, the time window and cumulative attempts. The 15→19 merge is computed from raw evidence. Two gaps break "actual attempt / real correlation" provenance, and one gate path fails open. Line numbers are relative to the pasted snippets.

## Critical Issues
1. **`scripts/m9/resource-reuse.mjs:15-22`: response and acquisition correlation is never verified.** The producer matches `logical_id` to `scrapeId`, but the verifier only checks `attempts_used` and costs. Reachable failure: a raw file that reuses one acquisition event for all four responses, or carries an acquisition from another call, passes the check. Minimal fix: in the loop, require `const sid=r.response.json?.data?.metadata?.scrapeId; sid && r.response.acquisition.logical_id===sid`, and require the four `sid` values to be distinct. Add `metadata.scrapeId` and `logical_id` to the fixture in `tests/contracts/m9-resource-reuse.test.mjs:4`, and add a mismatch mutation.
2. **Plan lines 12-14: a crash and rerun erases real attempts.** The plan throws on a missing `scrapeId` (any non-200 or error body), on lagging acquisition logs, or on invalid JSON. A rerun then overwrites `privatePath` with fresh `raw`. The earlier, real acquisitions disappear, and the cumulative check (≤3) is computed on an undercount. Minimal fix:
   - Open `privatePath` with `flag:'wx'` before the first call, so any existing partial record blocks a rerun.
   - Persist failed responses as results instead of throwing before the write.

## Warnings
1. **`scripts/m9/resource-reuse.mjs:17-18`: only some request fields are checked.** Extra keys pass, for example `proxy:'stealth'`, `actions`, or `waitFor` on a static target. Fix: compare the sorted `Object.keys(r.request)` against the exact expected set for each page class.
2. **`scripts/m9/verify.mjs:3`: the gate fails open.** If `recheckRecord` exists but is invalid, the gate silently falls back to the original-batch path. Fix: `const corpusOk=recheckRecord?recheckOk:(…existing fallback…)`.
3. **`tests/contracts/m9-resource-reuse.test.mjs:13-14`: boundary gaps.** The `r.results[0].id='P19'` mutation fails at the ID-set check, so the `usable!==false` and `page_class` guards are never exercised (P19 is `static` in the fixture). Add these cases:
   - P19 marked `page_class:'enhanced'`, substituted with a valid ID set
   - initial `usable:true` for P01
   - the boundary `attempts_used=2`, which must PASS (1+2=3)
   - `started_utc===closed_utc`, which must fail
   - `finalRecord.usable:20`, which must fail (arithmetic)

## Suggestions
- Check that the producer's per-ID `record.results[].request_sha256` and `attempts` match the raw file. They are currently unverified, so the public summary can drift from the raw evidence.
- If `pi-retrieval-log-scan.sh` scans the whole container lifetime, the earlier batch already satisfies `acquisition>=4`. Consider recording the count before the rechecks and requiring after − before ≥ 4.

## Good Practices
- The frozen spec is re-hashed before the run and `validateBody` runs on the exact request bodies.
- Paid posture and provider ledger keys are captured before and after, and the run aborts on any change.
- Cumulative attempts use the original raw `old.acquisition`, not recheck-only counts.
- Initial raw and public hashes and the closed window are bound, and recheck start must be strictly after `closed_utc`.
- P19 is excluded by the exact ID set and stays failed in the merge.
- Usability is recomputed from merged raw results through `corpusVerdict`, so 15→19 is derived rather than asserted.

## Verdict
**Request changes. Keep egress held.** Fix Critical 1 and 2 and Warning 2, then add the listed tests. After that, the four unpaid rechecks are acceptable to run once.
