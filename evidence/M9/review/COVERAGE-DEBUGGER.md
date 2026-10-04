## Code Review: M9 acceptance-checker delta (against HEAD 591dff2)

### Summary

I read `scripts/m9/verify.mjs` in full, `evidence/M9/review/REVIEW.md`, the M6-R07 contract (`scripts/m6/verify.mjs:347-358`), and the AC23 and full-acceptance text in `docs/FIRECRAWL_PI_SPEC.md:1095,1099` and `docs/FIRECRAWL_PI_MILESTONES.md:495,543,569`. I only used Read and Grep. Nothing was run.

- **AC23 change: correct.** In a JS object literal, a repeated key keeps only the last value. At HEAD the second `AC23` replaced `[[6,'R07']]`, so M6-R07 was never re-run. Now `fresh.AC23` includes R07. That means `ids` for M6 includes `R07`, the M6 verifier runs it into `evidence/M9/regression/M6/`, and AC23 needs it to PASS, be bound to current code, and carry a fixture hash. R07 tests exactly what AC23 requires: provider outage, the breaker opening, stealth requests refused as PROXY_REQUIRED, ordinary direct requests unaffected, and no learned route on the touched domain. If its raw input is missing, AC23 is NOT_RUN, so it fails closed. No other key is repeated in either the historical or the supplementary object.
- **Review change: incomplete, and it removes a check HEAD had.** It adds the right checks: unique IDs and exact outcomes. But it no longer checks the outcome of the 43 original rows. It also skips any row whose ID cell doesn't fit the new pattern, instead of failing.
- **Unchanged and confirmed:** M2 stays blocking (`M9-REG-12 | RETURNED` → `M9-RETURNED-FINDINGS` FAIL). All source, raw-evidence and hash checks, the `sameCode` scope, and every other gate are untouched.

### 🔴 Critical Issues (Must Fix)

None

### 🟡 Warnings (Should Fix)

**W1. The delta drops the outcome check on the original 43 rows, and rows it can't parse are skipped instead of failing (`scripts/m9/verify.mjs:60-63`).**

At HEAD, `dispositions` (a loose ID match, `(?:DB1|CA1|SELF)-[^|]+`) needed both count 43 and `every(/^(FIXED|REJECTED|RETURNED)/)`. The delta keeps the count but checks outcomes only through `allDispositions`. That uses a stricter ID pattern (`[A-Za-z0-9-]+` followed by exactly one space and `|`), and `>=43` can be met by the 40+ later M8/M9 rows.

Here is a concrete false PASS once M9-REG-12 is settled and M9-REG-13/14 are marked `FIXED`. Change `REVIEW.md:38` to the joint-ID style the same file already uses at lines 9–14:
```
| DB1-C1 / CA1-C1 | PENDING | … |
```
- `dispositions`: the loose pattern still matches, so the count stays 43 and its outcome is never checked.
- `allDispositions`: after `DB1-C1` it expects ` |` but finds ` /`, so the row is dropped. That leaves 42 originals plus 41 later rows = 83, which passes `>=43`. IDs are unique and every remaining outcome is exact, so the check passes.
- Result: `M9-REVIEW` PASS with an original finding still PENDING. HEAD would have rejected this.

The same skip hides any later row that doesn't fit the pattern: a different prefix (`DB2-…`, `DELTA-…`), an underscore, a double space, or an annotation like `| M9-REG-15 (new) | PENDING |`. These rows are ignored, not rejected. That falls short of the delta's own goal, M9-REG-14: "every recorded … finding".

**Proposed smallest patch.** Replace lines 61–63. Parse every table body row, require each to be well formed, and count the originals from the strict parse:
```js
const allDispositions=[...review.matchAll(/^\|([^\n]*)\|[ \t]*$/gm)].map(x=>x[1].split('|').map(c=>c.trim()))
 .filter(c=>!/^-+$/.test(c[0])&&!/^(?:Finding|Earlier finding|Additional finding)$/.test(c[0])).map(c=>({finding:c[0],outcome:c[1]??''}));
const reviewComplete=review.includes('Remediation complete')&&dispositions.length===43&&
 allDispositions.filter(x=>/^(?:DB1|CA1|SELF)-/.test(x.finding)).length===43&&
 allDispositions.every(x=>/^(?:DB1|CA1|SELF|M8|M9)-[A-Za-z0-9-]+$/.test(x.finding)&&/^(?:FIXED|REJECTED|RETURNED)$/.test(x.outcome))&&
 new Set(allDispositions.map(x=>x.finding)).size===allDispositions.length;
```

**Trace against the current `REVIEW.md`:**
- The header rows (`Finding`, `Earlier finding`, `Additional finding`) and divider rows (`|---|`, `| --- |`) are filtered out.
- 20 DB1, 21 CA1 and 2 SELF rows give 43 originals.
- The M8 and M9 IDs are all well formed and unique. I checked the full list, including the standalone single-row tables at lines 91 and 93.
- No evidence cell contains `|`.
- `M9-REG-13/14 | FIXED pending verification` fails the exact-outcome test, so the result is NOT_RUN, as intended today.
- The PENDING trace above now fails two ways: the joint ID fails the ID pattern, and the strict original count drops to 42.
- `M9-RETURNED-FINDINGS` is unchanged and still FAIL on M9-REG-12.

### 🔵 Suggestions (Consider)

1. **Make repeated keys impossible.** Write the supplementary refs at lines 11–23 as an array of `[id, refs]` pairs. With `for (const [id, refs] of pairs) fresh[id].push(...refs)`, a repeated ID adds to the list instead of replacing it. This bug class can't come back.
2. **Report FAIL, not NOT_RUN, for a bad review file.** `M9-REVIEW` currently reports NOT_RUN for a malformed or pending file. Either way acceptance is refused, since only PASS counts. FAIL whenever `REVIEW.md` exists would match how CORPUS, INCIDENT and CURRENT report, and would make pending versus malformed easier to tell apart in `acceptance.json`.

### ✅ Good Practices

- The fix for the repeated AC23 key keeps both the M6-R07 and M8-I08..I11 evidence, and leaves the historical rows (`[5,'I01'],[6,'R06'],[7,'E03']`) alone.
- Requiring an exact, anchored outcome means "FIXED pending verification" can't pass. That correctly keeps M9-REG-13/14 open until they are verified.
- The uniqueness check on IDs and the `finding_count` output make the review gate auditable.
- The RETURNED detector's pattern is wider than the disposition pattern, which errs on the blocking side. M2 stays a full acceptance blocker, with no runtime workaround and no M2 work added.
- Source equality, the `sameCode` scope, the raw/hash/redaction checks and the dirty-tree refusal are all unchanged.

### Verdict

[x] ❌ Request Changes
[ ] ⚠️ Approve with Suggestions
[ ] ✅ Approve

The AC23 fix is correct and ready. The review change should take the W1 patch before M9-REG-14 is marked FIXED: as written, it removes an outcome check that HEAD enforced.
