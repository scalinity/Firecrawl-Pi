# SI5: bot-interstitial captures are blocked, not captured

## What the corpus held

All 92 Reddit captures were one page: Reddit's human-verification gate ("Reddit - Prove your humanity", 165 characters), reached by a redirect to the thread's own URL carrying `solution`, `js_challenge`, `jsc_token` and `jsc_orig_r`. Each was stored as `captured` (HTTP 200, `proxyUsed=basic`), so the judge packets told the judge `Page capture: captured; shown whole`, then gave it the search-result excerpts and the gate page. The 92 documents were graded 0:4, 1:41, 2:16, 3:1, unjudged:30; the 58 positive grades rest on the excerpts alone, a weaker standard than the page every other document was graded on. Reddit held a top-10 slot in 25 of 120 queries for profile B, 9 for D and 10 each for C, D-C7 and D-Ref.

## The rule

Spec §23.1: "Missing/inaccessible material is unjudged, not automatically irrelevant." A capture whose final URL is the gate is stored as `blocked` (`scripts/si5/gate.mjs`, which reuses the retrieval service's `redditGate`, the same test that now classifies the gate as `BLOCKED_PUBLIC_CONTENT` in production). Packets, scoring and labels read only status `captured`, so a blocked capture is no page. `labels.mjs final` drops the grade of a document whose capture is blocked (flag `capture_blocked`) and `adjudicate` does not queue it. The judge-read packets are untouched.

## Commands and results

- `node scripts/si5/capture.mjs --reclassify` (no network): 92 captures `captured` to `blocked`, hashes kept; a second run changes nothing. `captures.json`: captured 3,095 to 3,003, failed 893 to 985 (92 of them blocked).
- `node scripts/si5/labels.mjs final`: 92 documents `capture_blocked`; 0 non-Reddit grades moved; unjudged 154 to 216 of 4,015 documents (3.8% to 5.4%), reported separately and never counted as irrelevant.
- `node scripts/si5/labels.mjs adjudicate`: disputes 98 to 86 (12 concerned gate pages).
- Tests: `tests/si5-gate.test.mjs`.

## Effect on scoring (provisional: 86 disputes await adjudication)

| | before | after |
|---|---|---|
| Q01 nDCG@10, A / D | 0.5041 / 0.7332 | 0.4925 / 0.7314 |
| Q01 relative improvement (95% interval low) | +45.4% (0.380) | +48.5% (0.408) |
| Q02 nDCG@10 difference, D over B | +0.1011 | +0.1043 |
| Q03 coverage difference, D over C (95% interval) | +1.9 points (-0.8, +5.4) | unchanged |

Gate statuses are unchanged (Q01 PASS, Q02 PASS, Q03 FAIL). The exclusion lowers B more than D: the Reddit documents' excerpt-based grades had flattered the baseline. Q03 requires at least 10 points on 43 documentation-positive queries and does not depend on Reddit.
