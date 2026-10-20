# SI5 acceptance review (independent)

Reviewer: a fresh-context agent on `claude-opus-5-5` (all 424 turns of its transcript report that model), as `CLAUDE.md` §5 requires, with no part in producing the evidence and no sub-agents. Its criterion-by-criterion record is `evidence/search-intelligence/SI5/ACCEPTANCE.md`; this file is its findings report on the candidate and its evidence, at commit `7009d2a` (code identical to `273b2e3`, where the fixture suites ran).

The report below is the reviewer's own text. Each finding's outcome is recorded in the dispositions at the end of this file.

## Code Review: SI5 acceptance


I recomputed every gate from the raw labels and run records, and every per-query value matches scores.json exactly: Q01 passes (+47.4% nDCG@10, +39.2 points recall@20) and Q02 passes (+0.106). Q03 fails (+1.9 points against 10); its threshold could not be reached from C's 91.9% coverage, and the measure that does have room (page-only) moved only +1.6 points. The full matrix is 6 PASS, 2 FAIL (F03, Q03) and 3 BLOCKED / NOT MEASURED (F05, L01, V01). F03 is a new failure with a concrete trace; F05, L01 and V01 wait on the Pi cutover.

### 🔴 Critical Issues (Must Fix)

1. **F03 fails: a hard library@version request returns other-version documents as a complete answer, with no no-match signal**
   - Where: services/retrieval/src/search-intelligence/adapters/context7.mjs:81-86; trace in evidence/search-intelligence/SI5/eval/runs/Q117.json.
   - Problem: Q117 asks "What's New In Python 4.0" with documentation "required" and libraries [{python, 4.0}].
     - Context7 served pages from library /websites/python_3_10 but sent no version.libraries entry, so scopeRecord recorded observedVersion null, status "unknown", basis "query_hint"; the sub-operation was ok and the lane success_results.
     - D returned outcome "complete" with warnings []. Eight of its top 10 are 3.x "What's New" pages, each judged a version mismatch.
     - Across the 16 strict-version held-out queries, D's top 10 holds 20 judged mismatches (Q002 2, Q010 3, Q111 1, Q115 4, Q117 8, Q120 2). All 20 have verified passages and a second judge's grade. C has 21 and A 42.
     - The system marks none of its 960 top-10 documents as a version "match".
     - Spec §6.1 requires: "report that exact-version no-match rather than silently substitute latest". The fixture at si-docs-decisions.test.mjs:80 never covers a library id that names another version.
   - Risk: an agent asking for a specific version gets wrong-version documentation presented as a complete answer. F03 also blocks acceptance, and SI6/ROLLOUT.md gate 2 requires every failed criterion to be accepted or remedied before the cutover.
   - Fix:
     - Read a version encoded in the library id or URL path (/websites/python_3_10, /3.10/) as provider-scope evidence; when it differs, leave the passage out with a detail, as the adapter already does for version.served.
     - When a hard version gets no scope_only or match scope, add an exact-version no-match warning to fcpi.search.
     - Add a fixture for a library id naming another version with no version entry, then rescore F03 by replaying the held Context7 answers.
     - Alternatively, the owner records F03 as failed, as was done for Q03.

### 🟡 Warnings (Should Fix)

1. **F05's "metadata survives the native core" clause has no executed evidence**
   - Where: scripts/si3/native-chain.mjs:5-7; patches/0011-search-intelligence-context.patch:4-56.
   - Problem: spec §24.2's single chain through access, core, retrieval, REST and MCP never ran. The controller's lift of fcpi.search to the top level and executeSearch passing the context are covered by source inspection only. The native chain says they "run only in the full core, which this chain does not start".
   - Risk: a controller regression could silently drop fcpi.search from REST and MCP responses and go unnoticed until live use. F05 stays blocked.
   - Fix: make the post-cutover live REST and MCP search (SI6/ROLLOUT.md:123) a recorded F05 check that asserts fcpi.search at the top level and in each row, or run the full core in a fixture chain.

2. **L01 is not measured: no Pi measurement exists**
   - Where: evidence/search-intelligence/SI5/eval/scores.json ("timing", labelled "workstation … not a Pi measurement"); SI6/ROLLOUT.md:127.
   - Problem: the only timings are workstation figures over 96 live searches (p50 7.8 s, p95 9.8 s, max 14.4 s). They are a proxy, not the named Pi scenarios.
   - Risk: the ≤23 s single-search p95, deadline behaviour and memory on the 8 GB Pi are unknown at release.
   - Fix: after the cutover, run ROLLOUT.md:127's scenarios on the Pi: 30 or more cold link-only searches, 30 cold documentation searches, a stalled discovery provider and a stalled Jev. Record p50, p95, deadline and resident memory, with live and fixture timings labelled separately.

3. **V01 is blocked: the redaction scan and the service images' build identity are not recorded**
   - Where: evidence/search-intelligence/SI6/verification.json ("redaction" and "service-images" are NOT_RUN).
   - Problem: the project's hash-based redaction scan has not run over the SI5 evidence, and the three :si6 service images will only be built at the cutover. My own pattern scan of 158 evidence files found no credential-shaped string and no Pi identifier, but it is weaker than the project's scan.
   - Risk: V01 cannot pass, and committed evidence (labels.json, judges.json, captures.json) carries no positive-controlled redaction proof.
   - Fix: run the redaction scan over the SI5 evidence now, before commit (it does not need the cutover), and record the service images' identity in the version lock at the cutover.

4. **labels.json names one second-round model, but 33 of those queries are unrecorded**
   - Where: scripts/si5/labels.mjs:170.
   - Problem: this line copies only the round-level model ("meta/muse-spark-1.3-contributor") into labels.json and drops judges.json's "unrecorded" list.
   - Risk: the committed provenance attributes the 33 unrecorded queries' second labels to a model that did not judge them.
   - Fix: carry "unrecorded" and a per-query model map into labels.json's "judges".

5. **The 33 unrecorded second-round queries cannot be audited for containment**
   - Where: evidence/search-intelligence/SI5/eval/judges.json ("rounds.second.unrecorded"). The lost transcripts are a given fact.
   - Problem: for those 33 queries, neither the model nor whether the judge stayed inside its packet can be checked. labels.mjs final refuses on "uncontained" and "promptNotExact" but not on "unrecorded".
   - Risk: a judge that peeked at first-round labels would agree more often, so fewer documents would be adjudicated and more first labels would stand. The effect is bounded, because second labels only decide adjudication.
   - Fix: state the limit beside the labels. Optionally re-judge those 33 queries' second sample with a recorded judge and rerun adjudication, to show the final labels are stable.

6. **The second round's API judge ran from uncommitted code, records no script identity, and was never reviewed**
   - Where: scripts/si5/judge-api.mjs:108; SI6/review/ADDENDUM-REVIEW.md:11.
   - Problem: Q069's recorded run started at 04:07:14Z, three minutes before 1147879 was committed (04:10:18Z). All seven failure files use 1147879's "-tryN" naming, and 597ec91 replaced that retry protocol at 05:24Z, after the round and the adjudication. No run record carries a script hash, and these files sit outside every saved review.
   - Risk: the 63 API-judged queries' labels cannot be tied to a commit, and a rerun would behave differently.
   - Fix: record the script's sha256, commit and dirty flag in each run record, and include judge-api.mjs, judge-api-lib.mjs, the judges.mjs merge and 597ec91 in the next review.

7. **The Reddit note leaves out profile A, mislabels a row, and its fairness claim does not hold for Q01**
   - Where: evidence/search-intelligence/SI5/gate-reclassification.md:5,15,30.
   - Problem:
     - A ranks a Reddit page in its top 10 on 71 of 120 queries (61 of the 96 held-out); D does so on 5 held-out queries. The note gives counts for every other profile but not A.
     - The row "Q02 nDCG@10 difference, D over B" should read C over B.
     - The before-and-after table uses provisional labels.
     - "Does not favour D" is true against B, not against A.
   - Risk: readers conclude the exclusion did not favour D. On final labels it moves Q01 from +44.4% (grades restored) to +47.4% (excluded). No gate changes either way.
   - Fix: add A's counts, relabel the row, and add the final-label figures with and without the exclusion (they are in ACCEPTANCE.md).

8. **The Q03 note's proposed restated target would also fail**
   - Where: evidence/search-intelligence/SI5/Q03-documentation-helpers-gap.md:30,38.
   - Problem: page-only coverage does have room (18 of 43 queries below full under C, which covers 81.8%), but D adds only +1.55 points there (interval −1.55 to +5.04).
   - Risk: restating the gate on page-only coverage, as the note suggests, would not produce a pass without a real improvement.
   - Fix: add the page-only result to the note and state that the helpers' benefit is not demonstrated on either measure.

9. **F01 passes with zero margin, and the explicit-request part barely tests detection**
   - Where: evidence/search-intelligence/SI5/eval/scores.json ("activation"); services/retrieval/src/search-intelligence/documentation.mjs:57.
   - Problem: activation recall is 41/43 = 95.35% from a single live run in which the classifier asks Jev live; one more miss would fail F01. Of the 10 explicit queries, 7 are forced by "required" and 2 by library hints, which stop before the text rules run. Only Q106 reached them, and it activated through a generic technical signal. explicit_docs_request fired once, on a negative query (Q069, "GitHub changelog posts from yesterday").
   - Risk: a rerun can flip F01 to FAIL, and explicit-text detection is effectively untested by the corpus.
   - Fix: repeat the classifier-only activation runs, which are cheap, and report their spread; add explicit-text fixtures ("Rust book …") and a negative fixture for "changelog"-style wording.

10. **The sentinel fixture stops at the shortlist**
    - Where: services/retrieval/test/si-discovery.test.mjs:81-90.
    - Problem: spec §24.1 asks that a uniquely found document reach its independently expected output position. The fixture only checks that it enters the 48-document shortlist.
    - Risk: F03's sentinel clause rests on a weaker check; a blend or diversity change could drop the unique document from the output unnoticed.
    - Fix: run the blend and the diversity selection in the fixture and assert the final rank.

11. **Adapter fixes made after the freeze were not re-measured on the corpus**
    - Where: services/retrieval/src/search-intelligence/adapters/ref.mjs (7a62351), adapters/context7.mjs (5f4f1fe); evidence/search-intelligence/SI5/eval/frozen.json ("files").
    - Problem: 19 frozen files changed after 8598be4. The ranking code (rank.mjs, normalize.mjs, documentation.mjs) is unchanged, and the decisions.mjs and coordinator.mjs changes are metadata, telemetry and legacy-profile fixes. But Ref's block parser and Context7's header and reset handling changed, and they decide which hosted answers count.
    - Risk: the quality figures describe frozen-commit adapters, not HEAD's; the effect is unknown, though Ref and Context7 contribute little.
    - Fix: re-parse the stored provider answers through HEAD's adapters where the raw bodies were kept, or record the drift as a named limitation in frozen.json.

12. **S10 and S11 remain open: the Pi-side spend was not read**
    - Where: evidence/search-intelligence/SI5/review/REVIEW.md:108-109.
    - Problem: the dispositions say ACCEPTANCE.md would record the Pi's month-to-date spend and the capture's residential and enhanced spend. This review had no Pi access under its rules, so ACCEPTANCE.md records the collection's own ledger instead (about $2.62 in metered USD) and the captures' routes (basic 3,178, stealth 14, failed before any route 796).
    - Risk: platform spend during the collection and capture stays unchecked against the Pi's ledger.
    - Fix: read the Pi's ledger read-only (month-to-date by category, plus residential and enhanced spend for 2026-10-18 01:43–06:15Z) and append it beside ACCEPTANCE.md.

### 🔵 Suggestions (Consider)

1. **Correct the rejudge count in the SI5 review.** evidence/search-intelligence/SI5/review/REVIEW.md:95 (W16) says four first-round judges were re-judged; judges.json records five (Q050, Q055, Q061, Q064, Q067).
2. **Report recall@10 beside recall@20 for Q01** (scripts/si5/score.mjs:164). A supplies at most 10 documents; at equal depth D still gains +12.4 points (interval 10.4 to 14.6).
3. **Commit the raw test output behind test-run.txt, with hashes** (evidence/search-intelligence/SI5/acceptance/test-run.txt). F02, F04 and O01 rest on that one orchestrator run, which records only per-suite totals. I could rerun only the root suite (72/72), not the database suites.
4. **Plan a live check of Ref reads after the cutover.** Ref's bounded enrichment read never fired in 120 runs (every run's documentation.enrichment is null); the live smoke's single read (2,040 characters, 1 credit) is the only observation of that path.
5. **Reduce provider cues in future judging rounds** (scripts/si5/packets.mjs; SI5 review S14, rejected). Excerpt multiplicity and Context7 library-id titles can hint to a judge which provider returned a document; normalize both for any new round.

### ✅ Good Practices

- **Exact reproducibility.** Every per-query, per-profile nDCG@10, recall@20 and coverage value reproduces from the raw files with no differences, and the intervals agree within 0.004 under an unrelated generator.
- **Freeze discipline.** The corpus is byte-identical to its freeze (42aa3d0), spec §23 and §25 are untouched since 97ea101, and the weights are the spec's defaults, so nothing was tuned. Scores and pool cover the 96 held-out queries only.
- **Clean comparison.** Replay integrity is clean (0 misses, 0 divergences, 0 top-20 mismatches, 0 unreplayed reads), and every top-20 document of every profile was pooled.
- **Honest failure reporting.** Q03 is recorded as FAIL with an unchanged threshold, and every figure in its note reproduces. The Reddit grades are kept beside the dropped ones, and the result holds with or without them.
- **Judging hygiene.** Judges were audited from their transcripts and the uncontained ones were re-judged; there are 0 unverified spans. Adjudication added requirement support (218 entries against the first judge's 123) rather than eroding it.
- **Spot-check agreement.** My 24-label spot-check agreed 73.9% exactly and 91.3% on the relevance line, matching the judges' agreement with each other, with no bias toward D or A.
- **Clean evidence.** No Pi identifier or credential-shaped string appears in the 158 committed evidence files, and page text stays in the ignored private tree.

### Verdict

Request Changes

ACCEPTANCE.md written: 225 lines.

### Finding dispositions

The report was written at `7009d2a`. The release it concerns was cut over afterwards (`SI6/ROLLOUT.md`), so the findings that waited on the Pi are answered with Pi evidence. Nothing here is deferred: SI6 is the last step of this feature, and no later milestone owns a finding.

| Finding | Outcome | Evidence |
|---|---|---|
| C1 (F03) | Fixed (`730b623`) | Context7's scope evidence now reads a version from the library id (`/websites/python_3_10`), a scope that names another version leaves its passages out, and every hard `library@version` request carries an exact-version report (`confirmed`, `no_match`, `unconfirmed`) with `exact_version_no_match` and `exact_version_unconfirmed` warnings (`versions.mjs`; spec §6.1 states it; the Context7 contract version moved to `context7-v3/2026-10-20` so no earlier cached answer is reused). Fixtures: a library id naming another version with no version entry, per-scope verdicts, four mutation checks. **Live on the Pi** (`SI6/l01/live-summary.json`, `f03`): the 16 held-out hard-version queries each returned a report; 12 of 16 requested versions confirmed (75%), 4 unconfirmed (25%), none confirmed wrongly, none expecting no match confirmed; Q117 (Python 4.0) is `unconfirmed` with a warning, not a clean complete answer. The 20 judged mismatches in D's top 10 came from the general engines (Context7 supplied none); they are version-blind and still list other versions' pages, which the report now says. The collection was not rescored: no judging round is planned. Whether F03 now passes is the reviewer's update. |
| W1 (F05) | Fixed | A live REST search, MCP search and scrape through the deployed platform on each of the three releases: `fcpi.search` at the top level and in all five rows of both searches, coverage present, no warnings on the first (`SI6/raw/release-1/live-smoke*.jsonl`, `release-2/live-smoke.jsonl`, `live-smoke.jsonl`); `fcpi verify functional` PASS at each cutover (`raw/release-1|2/verify-functional.txt`, `raw/verify-functional.txt`). |
| W2 (L01) | Fixed | Measured on the Pi: 30 cold link-only searches, one active at a time, p50 7.4 s, p95 8.7 s, max 9.7 s against 23 s; fixture stalls, four at once and cancellation labelled apart; memory and deadlines (`SI6/l01/README.md`, `raw/l01-live.jsonl`, `raw/l01-fixture.jsonl`). The fixture cancellation scenario found a real defect (a request cancelled after it was written counted against the provider's breaker): fixed in `20d9729`, not in the review's report. |
| W3 (V01) | Fixed | The three `:si6` service images' identities are in `deploy/versions.lock.json` (`345154f`, then `88ad02c` for the final images), and `scripts/si6/verify.mjs` reports 18 PASS at a clean code tree (`SI6/verification.json`). The redaction scan passes (`SI6/raw/redaction.json`: 59 live secret hashes, no real hit, no unclassified hit, four positive controls). It found its own false positive (the Pi's host name inside a schema name; `c67ea38`) and 52 benign pattern matches never classified since M9, each read with its value masked and recorded as an exact exception (`1cf45d2`). |
| W4 | Fixed (`6ce7c98`) | `labels.json` carries a per-query model map and the `unrecorded` list. |
| W5 | Fixed in part (`77f59de`); in part rejected | The limit is stated beside the labels, with its bound: labelling the 33 unrecorded queries by the first judge alone moves Q01 to +47.7%, Q02 to +0.1067 and Q03 to +1.94 points, so no gate changes (`SI5/acceptance/unrecorded-judge-sensitivity.md`). Re-judging them is rejected: the lost transcripts cannot be recovered by a new round, and the bound shows no gate could flip. |
| W6 | Fixed in part (`b95db4c`) | Each API judge run record now carries the sha256 of `judge-api.mjs` and `judge-api-lib.mjs`, the commit and the dirty flag, and `judges.mjs` merges it whole. The records of the round already run cannot be reconstructed and stay as they are. |
| W7 | Fixed (`88b8834`) | The note counts profile A's Reddit pages (71 of 120, 61 of the 96 held-out), relabels the row (C over B), and gives the final-label figures with and without the exclusion. |
| W8 | Fixed (`a659cc4`) | The Q03 note adds the page-only result (+1.55 points, interval −1.55 to +5.04), says the helpers' benefit is demonstrated on neither measure, and breaks activation down: 37 of 41 activations are fixed by rules, 4 (Q081, Q085, Q094, Q096) depend on the classifier. |
| W9 | Fixed in part (`4cf6571`); in part rejected | A test exercises every explicit-documentation cue on its own. The live classifier-dependent queries were asked five times each on the Pi: all 20 activations positive, with probabilities 0.94–0.95 (Q096), 0.85–0.86 (Q081), 0.76–0.77 (Q094) and 0.70–0.72 (Q085) against a cutoff of 0.2 (`SI6/l01/live-summary.json`, `f01`; repeats within Jev's 900-second decision cache reuse one answer, which the README says). Changing the `changelog` rule for the held-out query Q069 is rejected: it would tune the rules on a held-out query. |
| W10 | Fixed (`3826d29`) | A per-provider sentinel test runs the blend and the diversity selection and asserts the document's final position. |
| W11 | Fixed (`f1405f2`) | `SI5/acceptance/post-freeze-adapter-changes.md` says which frozen files changed after the freeze, and why the collection could not have felt the two adapter changes. |
| W12 | Fixed (`51d0cfd`) | The Pi's ledger was read before the cutover; after the third release `SI6/raw/usage-day-after.txt` and `usage-month-after.txt` hold the day's and month's spend by category (Exa $1.36, Jev $0.15, DeepSeek $0.06 for the day of the rollouts and measurements). |
| S1 | Fixed (`a321ac3`) | The SI5 review's rejudge count reads five. |
| S2 | Fixed (`30ca605`) | recall@10 beside recall@20; at equal depth D gains +12.39 points (interval 10.34 to 14.57), computed last so the other intervals did not move. |
| S3 | Fixed (`5b718e5`) | The raw output behind the acceptance test record is committed with its hashes. |
| S4 | Fixed | Ref's bounded read fired in the smoke search of each release (`selected: 1, read: 1`). It fired in none of the 46 documentation searches of the L01 run, whose Ref lane was failing in 19 of them (below). |
| S5 | Fixed (`17429cc`) | `PROGRESS.md` says to normalize excerpt multiplicity and Context7 library-id titles before any new judging round. |

**Found while closing these, not in the report:**

| Finding | Outcome | Evidence |
|---|---|---|
| The cutover script read the wrong image list | Fixed (`b2e356f`) | `config --images <service>` lists the images of the service's dependencies too, so the first cutover refused safely before changing anything (`SI6/raw/release-1/cutover-attempt1-refused.txt`). It now reads the service's own image. |
| A caller's cancellation counted as a provider failure | Fixed (`20d9729`) | Found by the fixture cancellation scenario; regression test fails on the unfixed code; the spec's availability table states the rule (`92d245e`). |
| Ref's result blocks without a page, section or breadcrumb were refused | Fixed (`5e035b2`) | Found by the live documentation scenario: 5 refused answers and a 15-minute contract hold that skipped 14 searches. Five queries replayed on the final release return Ref results (`SI6/raw/live-ref-replay.jsonl`). The widened rule keeps refusals and `ref.tools` links failing closed (two guards, each mutation-checked). |
| The redaction scan's endpoint check matched inside a longer name | Fixed (`c67ea38`) | See W3. |
