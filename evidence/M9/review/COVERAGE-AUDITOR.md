## Code Review: M9 acceptance-checker delta (vs 591dff2)

### Summary

I read all of `scripts/m9/verify.mjs`, `evidence/M9/review/REVIEW.md`, M6-R07 (`scripts/m6/verify.mjs:347-358`), the argument handling in M6 (`scripts/m6/verify.mjs:16,620`), the stored M6-R07 records, AC23 in `docs/FIRECRAWL_PI_SPEC.md:1095`, and the M8/M9 acceptance sections in `docs/FIRECRAWL_PI_MILESTONES.md:495,543,569`. I only used Read and Grep: nothing was written, run or fetched.

- **The AC23 fix is correct.** The object now has one AC23 key, so M6-R07 is in `fresh.AC23`. That means `R07` is passed to the M6 run (`scripts/m9/verify.mjs:29-30`) and has to match HEAD's code before it counts (lines 36-38). R07 checks exactly what AC23 requires: provider outage opens the breaker, stealth requests are refused with no attempt, an ordinary direct request still works, and the domain learns nothing.
- **The review check is stricter and fails closed on the current file.** All 101 table lines are accounted for: 18 header/separator lines plus 83 finding rows. Every finding row matches the new pattern, and all IDs are unique. M9-REG-13 and M9-REG-14 read "FIXED pending verification", which fails the exact-outcome test, so M9-REVIEW stays NOT_RUN for now.
- All original source, raw and hash checks, the `sameCode` path exclusions and the gates are unchanged. AC22 is unchanged. M9-RETURNED-FINDINGS still fails because of M9-REG-12.

### 🔴 Critical Issues (Must Fix)

None

### 🟡 Warnings (Should Fix)

1. **"Every finding row" only covers rows written in one exact text format. Other rows are silently skipped, and that can erase the returned M2 blocker.** (`scripts/m9/verify.mjs:61`, and line 65, which the delta didn't touch)

   Both patterns need exactly one space between the ID and the next `|`. The ID must also be unwrapped and use only the listed prefixes and characters. Any other row is ignored, not rejected.

   **Trace (reachable after an ordinary edit or markdown reformat):**
   1. A table formatter (Prettier-style column alignment) pads the "Additional finding" table at `evidence/M9/review/REVIEW.md:99`. That header is longer than every ID, so every ID cell gets extra spaces, e.g. `| M9-REG-12          | RETURNED   | …`.
   2. Line 65 no longer matches M9-REG-12, so `returned=[]` and M9-RETURNED-FINDINGS becomes **PASS**.
   3. Line 61 drops that table's rows. About 74 rows remain, so the `>=43` test still holds, and the remaining rows are unique.
   4. Once M9-REG-13 and M9-REG-14 are updated to `FIXED` (the intended next step), M9-REVIEW becomes **PASS**.
   5. If the other gates pass, the result is `ACCEPTED` while M2 still owns an unresolved RETURNED finding.

   The same skipping happens with an unlisted prefix (e.g. `DELTA-W1`), a bold or backticked ID, or a row like `| M9-REG-15 | PENDING |` with two spaces.

   There is also a smaller inconsistency. Line 60 counts the first 43 rows with a looser pattern than line 61 uses. An original-review row with a malformed ID can therefore count toward the 43 while its outcome is never checked.

   **Smallest patch:** read every table row once, reject anything that isn't a header or separator, and keep the old line-65 match as an extra source so nothing is weakened.
   ```js
   const rows=[...review.matchAll(/^\|([^|\n]*)\|([^|\n]*)\|/gm)].map(x=>({finding:x[1].trim(),outcome:x[2].trim()}))
    .filter(x=>!/^(:?-+:?|(?:Earlier |Additional )?[Ff]inding)$/.test(x.finding));
   const reviewComplete=review.includes('Remediation complete')&&dispositions.length===43&&
    rows.filter(x=>/^(?:DB1|CA1|SELF)-/.test(x.finding)).length===43&&
    rows.every(x=>/^(?:DB1|CA1|SELF|M8|M9)-[A-Za-z0-9-]+$/.test(x.finding)&&/^(FIXED|REJECTED|RETURNED)$/.test(x.outcome))&&
    new Set(rows.map(x=>x.finding)).size===rows.length;
   results.push({test_id:'M9-REVIEW',state:reviewComplete?'PASS':'NOT_RUN',finding_count:rows.length});
   const returned=[...new Set([...review.matchAll(/^\| ([A-Z0-9][A-Za-z0-9-]+) \| RETURNED\b[^|]*\|/gm)].map(x=>x[1]),
    ...rows.filter(x=>/^RETURNED\b/i.test(x.outcome)).map(x=>x.finding)])];
   ```
   With the current file this gives the same results: 83 rows, 43 original, M9-REVIEW NOT_RUN (because of REG-13/14), and RETURNED = [M9-REG-12]. Under padding, unknown prefixes or decorated IDs, the review check fails closed and the M2 RETURNED finding is still counted.

### 🔵 Suggestions (Consider)

1. **Expect every row to drop to NOT_RUN once this is committed.** The delta changes `scripts/`, so the M6-R07 record bound to e683c91 (`evidence/M9/regression/M6/verification.json:197-205`), and every other current regression record, stops matching HEAD. That is the existing fail-closed behaviour: a fresh rebuild and regression run is needed before any row can pass.
2. **Mark M9-REG-13 and M9-REG-14 FIXED only with evidence.** Change them to exact `FIXED` only after a fresh M6-R07 run at the committed HEAD, and record that verification in the evidence column. Until then they correctly hold M9-REVIEW.
3. **Two finding rows sit outside any table.** The rows at `evidence/M9/review/REVIEW.md:91,93` have no header and only display as table rows by accident. The checker counts them either way. Moving them into a table would just make the file easier to read.

### ✅ Good Practices

- The AC23 fix works by removing the duplicate key, not by adding a workaround. The historical AC23 references are unchanged, and the spec maps AC23 to M5–M7 and M9 for verification (`docs/FIRECRAWL_PI_MILESTONES.md:569`).
- Outcomes must match exactly (`$`-anchored), so "FIXED pending verification" can no longer pass on its prefix.
- IDs must be unique, and `finding_count` is reported so the acceptance file shows how many rows were checked.
- RETURNED is still a separate FAIL gate. M2 is still blocking, and the delta proposes no M2 work.

### Verdict

[ ] ❌ Request Changes
[x] ⚠️ Approve with Suggestions
[ ] ✅ Approve

The delta does what it claims and fails closed with today's REVIEW.md. The warning above is a hidden false-acceptance path: a review-file reformat could pass the review gate and erase the M2 blocker. Fix it before M9-REG-13 and M9-REG-14 are changed to `FIXED`.
