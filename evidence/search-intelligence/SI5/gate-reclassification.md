# SI5: bot-interstitial captures are blocked, not captured

## What the corpus held

All 92 Reddit captures were one page: Reddit's human-verification gate ("Reddit - Prove your humanity", 165 characters), reached by a redirect to the thread's own URL carrying `solution`, `js_challenge`, `jsc_token` and `jsc_orig_r`. Each was stored as `captured` (HTTP 200, `proxyUsed=basic`), so the judge packets told the judge `Page capture: captured; shown whole`, then gave it the search-result excerpts and the gate page. The 92 documents were graded 0:4, 1:41, 2:16, 3:1, unjudged:30. The 58 positive grades rest on the excerpts, since the page was the gate; that is not a weaker standard in itself, because the 893 failed captures were also judged on their excerpts where those sufficed and their grades stand. The difference is what the judges were told: a failed capture's packet said the page was not available, and these packets said it was captured and shown whole. Reddit held a top-10 slot in 25 of 120 queries for profile B, 9 for D and 10 each for C, D-C7 and D-Ref. Profile A, the baseline of Q01, ranks a Reddit page in its top 10 on 71 of the 120 queries (61 of the 96 held-out, in 67 slots), and D does on 5 of the 96.

## The rule

A judgment made on a capture that the packet misrepresented as the captured page is void, and the document is unjudged (spec §23.1: "Missing/inaccessible material is unjudged, not automatically irrelevant"). A failed capture was presented as unavailable, so its judges knew, and their grades stand.

A capture is a gate when its final URL carries `js_challenge` and `jsc_token` on reddit.com and the pool URL did not, or its title is the gate's (`scripts/si5/gate.mjs`, which reuses the retrieval service's `redditGate` and `redditGateTitle`, so the evaluation and the platform agree). It is stored as `blocked`, with `previousStatus` and `reclassifiedAt` when it was reclassified, so it is not mistaken for one blocked at capture time. Packets and scoring read only status `captured`; `labels.mjs final` drops the grade of a document whose capture is blocked (flag `capture_blocked`, the first flag that applies, with the original labels kept beside it) and `adjudicate` does not queue it. The judge-read packets are untouched. `labels.json` records the hash of `captures.json` and of `gate.mjs` and `quality.mjs` under `inputs`, since the label set now depends on them, and the agreement figures leave blocked documents out and report how many pairs that was (`blockedPairs`), how many captures are blocked and how many of them matched a judged document (`blockedCaptures`, `blockedUnmatched`).

## When it was decided

The exclusion was decided after provisional scores existed: the label and score files had been produced once before it. It is therefore reported both ways. The table below gives the scores before and after; the gate statuses are the same either way; the original grades stay in `labels.json` beside every dropped one; and the exclusion costs the baselines more than D: A ranks a Reddit page in its top 10 on 61 of the 96 held-out queries against D's 5, and B on 21, so it widens D's lead over both. It removes no weakness of D's, but it is not neutral between the profiles, which is why the final labels are also reported with the dropped grades restored (below).

## Commands and results

- `node scripts/si5/capture.mjs --reclassify` (no network): 92 captures `captured` to `blocked`, hashes kept; a second run changes nothing. `captures.json`: captured 3,095 to 3,003, failed 893 to 985 (92 of them blocked). The 92 records carry `previousStatus: captured` and `reclassifiedAt` 2026-10-20T03:34:29Z, the time of the run, written back afterwards.
- `node scripts/si5/labels.mjs final`: 92 documents `capture_blocked`; 0 non-Reddit grades moved; unjudged 154 to 216 of 4,015 documents (3.8% to 5.4%), reported separately and never counted as irrelevant.
- `node scripts/si5/labels.mjs adjudicate`: 12 disputes over gate pages are not queued.
- Tests: `tests/si5-gate.test.mjs` and `tests/si5-labels.test.mjs` (the last drives `capture.mjs --reclassify` and `labels.mjs final|adjudicate` over a fixture tree, `FCPI_SI5_ROOT`).

## Effect on scoring (provisional until the final labels)

| | before | after |
|---|---|---|
| Q01 nDCG@10, A / D | 0.5041 / 0.7332 | 0.4925 / 0.7314 |
| Q01 relative improvement (95% interval low) | +45.4% (0.380) | +48.5% (0.408) |
| Q02 nDCG@10 difference, C over B | +0.1011 | +0.1043 |
| Q03 coverage difference, D over C (95% interval) | +1.9 points (-0.8, +5.4) | unchanged |

Gate statuses are unchanged (Q01 PASS, Q02 PASS, Q03 FAIL). Q03 requires at least 10 points on 43 documentation-positive queries and does not depend on Reddit.

## On the final labels, with and without the exclusion

The table above was computed on provisional labels. On the final labels (after adjudication), the project's scorer gives the following with the dropped grades as recorded and with the first judge's grades put back on the blocked documents (62 of the 92 had one; the other 30 were unjudged):

| | Excluded (as recorded) | Grades restored |
|---|---|---|
| nDCG@10 A / B / C / D | 0.5000 / 0.6271 / 0.7330 / 0.7370 | 0.5116 / 0.6324 / 0.7351 / 0.7388 |
| Q01 relative improvement, D over A | +47.4% | +44.4% |
| Q01 recall@20 gain, D over A | +39.2 points | +39.0 points |
| Q02 nDCG@10 difference, C over B | +0.1059 | +0.1027 |
| Q03 coverage difference, D over C | +1.94 points | +1.94 points |

No gate status changes either way. The exclusion moves Q01 by about three points in D's favour, because the baseline A is the profile that ranks Reddit pages most.
