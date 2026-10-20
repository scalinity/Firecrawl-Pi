# SI5 acceptance: search intelligence against spec §25

| | |
|---|---|
| Written | 2026-10-20T07:15Z (UTC) |
| Candidate | `7009d2a612e75acfeda55b86f804cbbea067e1cd` (`git rev-parse HEAD`). Its code is identical to `273b2e3`, where the fixture suites ran (`SI5/acceptance/test-run.txt`): the two later commits change only evidence (`1e32f46`) and the main spec and ORCHESTRATION.html (`7009d2a`, the LlamaParse allowance). |
| Code tree | Clean (`git status` empty before this file was written). |
| Reviewer | A fresh-context agent on Opus 5.5 (`claude-opus-5-5`), with no part in producing the evidence. No sub-agents. It ran no evidence-writing script, no Docker, Colima or SSH, and no network command; it read no `.env` or secret file. |
| Ran | Its own read-only scripts (not committed) and `node --test tests/*.test.mjs` from the repository root: 72 of 72 pass, 0 skipped (Node 26.12.0). |
| Contract | `docs/FIRECRAWL_PI_SEARCH_INTELLIGENCE_SPEC.md` §23 and §25; `CLAUDE.md` §5 and §25–§27. |

Spec §25 separates six kinds of evidence, and none stands in for another. This file names the kind behind every verdict: **source** (source inspection), **fixture** (deterministic fixtures, some against a disposable PostgreSQL 17.11), **live** (live provider API calls), **model-judged** (independent source-backed model judgments), **human**, and **Pi** (measurements on the Raspberry Pi). No human judgment and no Pi measurement exists for this feature.

## Verdicts

| Criterion | Verdict | Kind of evidence | Evidence | Limitations |
|---|---|---|---|---|
| F01 mandatory coverage | **PASS** | fixture; live (120 D runs); corpus labels written before any ranking | `services/retrieval/test/si-discovery.test.mjs:171`; `SI5/eval/runs/*.json` (D lanes, `documentation.activation`); `SI5/eval/scores.json` `activation`; `SI0/corpus/corpus-v1.json` | Activation recall 41/43 = 95.3% against ≥95%: zero margin, from one live run whose classifier asks Jev live. 7 of the 10 explicit queries force activation through `documentation: "required"` and 2 through library hints, both of which stop before the text rules run. Only Q106 reached them, and it activated through a generic technical signal, not `explicit_docs_request`; that rule fired once, on a negative query (Q069, "GitHub changelog posts from yesterday"). |
| F02 response truth | **PASS** | fixture; source (one hop) | `SI5/degraded-matrix.txt` (9/9 at `15e66dc`, clean); `SI5/acceptance/test-run.txt` (retrieval 478/478, MCP 51/51 at `273b2e3`); `si-discovery.test.mjs:251`; native chain `answer_mapping` (`SI6/raw/native-chain-release-image.txt`) | The core's v2 controller, which lifts `fcpi.search` into the REST body, is not executed by any test; it is checked here by source inspection (`patches/0011-search-intelligence-context.patch:4-56`). Not run on the Pi. |
| F03 evidence integrity | **FAIL** | model-judged (live D outputs); fixture; source | `SI5/eval/labels.json` (`versionStatus`); `SI5/eval/runs/Q117.json`; `scores.json` `wrongVersion`; `si-docs-decisions.test.mjs:80`; `si-jev-search.test.mjs:165`; `si-discovery.test.mjs:81` | 20 independently judged version mismatches in D's top 10 under strict `library@version` requests, all 20 with verified passages; Q117 is a silent substitution (see "F03"). The sentinel fixture checks shortlist entry, not output position. |
| F04 lifetimes and accounting | **PASS** | fixture (with PostgreSQL) | `test-run.txt` (retrieval 478/478, 0 skipped); `si-discovery.test.mjs:618,689`; `si-store`, `si-ref`, `si-server` suites; `SI6/review/ADDENDUM-REVIEW.md` W1, P1 | The one run is the orchestrator's; this review could not rerun the database suites (no Docker under its rules). Nothing ran on the Pi. |
| F05 compatibility | **BLOCKED / NOT MEASURED** | fixture (regressions); source | `test-run.txt` (gateway 101, MCP 51, root 72, retrieval 478; contracts 152 pass and 15 accounted failures); `SI6/raw/native-chain-release-image.txt` (25/25); `scripts/si3/native-chain.mjs:5-7` | The regression clause passes. The clause "additive metadata survives native core" was not measured: spec §24.2's access→core→retrieval→REST→MCP chain never ran, and the native chain says the controller and `executeSearch` "run only in the full core, which this chain does not start". It closes with the cutover's live REST and MCP search (`SI6/ROLLOUT.md:123`) or a full-core fixture chain. |
| Q01 full-system improvement | **PASS** | model-judged | `SI5/eval/{labels,scores,pool,frozen}.json`, `runs/` | +47.4% nDCG@10 and +39.2 points recall@20, both intervals exclude zero; recomputed exactly. A supplies at most 10 documents (see "Q01"). |
| Q02 Jev benefit | **PASS** | model-judged | same | +0.106 nDCG@10 (interval 0.086 to 0.126), positive in all 12 categories; recomputed exactly. |
| Q03 docs benefit | **FAIL** | model-judged | same; `SI5/Q03-documentation-helpers-gap.md` | +1.9 points against ≥10 (interval −0.8 to +5.4). Recorded as failed by owner decision, threshold unchanged. |
| L01 measured performance | **BLOCKED / NOT MEASURED** | none of the right kind | `scores.json` `timing` (workstation, not Pi) | No Pi measurement: the cutover waits on the owner's launch authorization. The workstation figures (p50 7.8 s, p95 9.8 s, max 14.4 s over 96 live searches) are a proxy and are not L01. |
| O01 durable instrumentation | **PASS** | fixture (with PostgreSQL); source | `test-run.txt`; `si-records.test.mjs:131`, `si-telemetry`, `si-store` (reduction, retention, prune); `git diff main...HEAD` (0 dashboard or analytics files) | Persistence and retention were shown against a disposable database, not on the Pi; the run is the orchestrator's. |
| V01 honest completion | **BLOCKED / NOT MEASURED** | source; live (contracts); this review | `SI0/provider-contracts-2026-10-17.md`; `SI5/live-smoke.json`; `SI6/verification.json` (11 PASS, 7 NOT_RUN); `SI1`–`SI6/review/` | Present: hosted contracts (documented 2026-10-17, live-smoked 2026-10-18), the API image of record, review findings with outcomes, reproducible metrics, the rollback-profile fixture (`si-discovery.test.mjs:757`). Missing until the cutover: the three service images' build identity and the project's redaction scan (both NOT_RUN in `SI6/verification.json`). L01 is named as blocked, as V01 requires. |

**Overall: 6 PASS, 2 FAIL (F03, Q03), 3 BLOCKED / NOT MEASURED (F05, L01, V01).** The feature is not accepted as a whole. What passing Q01 and Q02 supports is the qualified statement spec §25 allows: on this source-backed, independently model-judged benchmark, the candidate met the proposed ranking targets. That is not human validation or proof of factual correctness.

## Integrity of the comparison

- **Frozen configuration.** `SI5/eval/frozen.json` was written at 2026-10-18T01:36Z from commit `8598be4`, before any label existed. It records weights 1 for every provider and 0.75 for SearXNG, which are spec §11.1's own defaults: no weight was tuned, on the tuning queries or any other. A second collector revision (`fe923a7`, from Q099, with a reason) changed only `scripts/si5/collect.mjs` (`git diff --stat 8598be4 fe923a7`), so the retrieval code is the same for all 120 queries. Runs: 78 held-out queries at `8598be4` and 18 at `fe923a7`, every one with `codeDirty: false`.
- **Held-out set.** All 96 held-out queries are scored; `excluded` is `{}` and `aMissing` is `[]`. The corpus file still hashes to its freeze (`b4ae2b8f…`, committed in `42aa3d0` before any ranking existed). The split rule fixed positions 3 and 8 of each category as tuning before any query was written. `scores.json` and `pool.json` contain held-out queries only.
- **Thresholds and membership.** Spec §23 and §25 are unchanged since the spec's first commit (`97ea101`); the only later edits are to §18 and §20. Documentation-positive, explicit and version membership come from the frozen corpus.
- **Identical snapshots.** `scores.json` `integrity` lists no replay miss, no divergence, no top 20 that fails to extend its public answer, and no unreplayed read; my own pass over `runs/*.json` agrees (0, 0, 0, 0). No Ref enrichment read happened in any of the 120 runs, D included, so the change in D-Ref's read handling between the two collector revisions affected nothing.
- **Pool.** Every document in every profile's top 20 for every query has a labels entry (0 gaps). The pool rule (`pool.json` `rule`) is each profile's top 20 (A's top 10), two otherwise-unpooled candidates per provider, and anchors. That matches §23.1. The anchors come from a separate blind Sonnet 5.5 agent (`anchors.json` `author`).
- **Code that moved after the freeze.** Frozen files changed later in 19 places, mostly SI3's and SI4's review fixes and SI6's changes. The ranking files `rank.mjs`, `normalize.mjs` and `documentation.mjs` are unchanged. `decisions.mjs` only adds call keys to metadata. The `coordinator.mjs` changes concern telemetry, a cached lane's kind and the production legacy profile, not the aggregate ranking. Two changes could alter which hosted answers count: Ref's block parser (`7a62351`) and Context7's rate headers and reset bounds (`5f4f1fe`). Neither was re-measured on the corpus. No adapter changed after the live smoke at `3a25606`. My judgment is that the quality evidence still describes the candidate's ranking.
- **Collection database.** Q001–Q098 shared the suites' database, which put fixture ledger rows into Q048's and Q052's records; `score.mjs` drops them. From Q099 the collection had its own database (`fcpi_si5_eval`).

## The gates, recomputed

I wrote my own scorer from §23.2's definitions over `labels.json`, `runs/*.json`, `pool.json`, `frozen.json` and the corpus, without reusing `scripts/si5/score.mjs`. **Every per-query, per-profile nDCG@10, recall@20 and coverage value matches `scores.json` exactly (0 differences); the aggregates differ only by floating-point rounding (at most 6×10⁻¹⁷).** My bootstrap uses the same design (paired, category-stratified, 10,000 resamples) with an unrelated generator (mulberry32) and seed. Its intervals differ from `scores.json`'s by at most 0.004, as two random samples should; coverage intervals move in steps of about 0.4 points because coverage values are discrete.

### Q01: D over A, 96 held-out queries

| | Recomputed | `scores.json` | My 95% interval | `scores.json` interval |
|---|---|---|---|---|
| nDCG@10 A / D | 0.5000 / 0.7370 | 0.5000 / 0.7370 | | |
| Relative improvement (≥10%) | +47.40% | +47.40% | +39.72% to +55.97% | +39.66% to +55.73% |
| Recall@20 A / D | 0.1897 / 0.5816 | same | | |
| Recall@20 gain (≥10 points) | +39.19 points | +39.19 | +36.84 to +41.67 | +36.77 to +41.58 |

**PASS**, and both intervals exclude zero. Sensitivity checks, all mine and all still above the thresholds:
- **List length.** A, the legacy Serper-first selection, supplies at most 10 documents, so its recall@20 equals its recall@10. The spec allows this ("a profile supplying fewer documents leaves remaining ranks empty"). At equal depth (recall@10), D gains +12.39 points (interval +10.36 to +14.59): the condition still holds, narrowly.
- **Unjudged documents.** A has 1.10 unjudged documents per top 10 against D's 0.07. With unjudged documents dropped (condensed nDCG), the improvement is +43.6%.
- **The Reddit exclusion.** With the dropped Reddit grades restored, it is +44.4% and +39.0 points (see "The Reddit exclusion").
- **Pooling bias.** Leaving out any one provider's uniquely found relevant documents keeps D's recall@20 between 0.587 and 0.612, against A's 0.164 to 0.242. Recall@20 of the independently identified anchors is A 0.337, D 0.529.
- **Five-engine subset.** On the 90 queries every engine could represent, D 0.7377 against A 0.5064.
- **Categories.** D beats A in all 12; the smallest gain is +0.124 (scientific and technical research).

### Q02: C over B, the same general snapshots

| | Recomputed | `scores.json` | My 95% interval | `scores.json` interval |
|---|---|---|---|---|
| nDCG@10 B / C | 0.6271 / 0.7330 | same | | |
| Difference (≥0.02) | +0.1059 | +0.1059 | +0.0856 to +0.1261 | +0.0857 to +0.1264 |

**PASS.** C − B by category: software documentation +0.108, GitHub repositories +0.078, coding and infrastructure +0.070, MLX +0.136, scientific +0.057, recent models and tools +0.112, time-sensitive +0.097, general web +0.181, difficult semantic +0.136, ambiguous documentation +0.076, near-duplicates +0.104, explicit version and domain +0.115. It is positive in every category, and the result holds with unjudged documents dropped (+0.094) and with the Reddit grades restored (+0.103). C's Jev decisions were live calls made at replay time over B's exact candidates.

### Q03: D over C, 43 documentation-positive queries

| | Recomputed | `scores.json` | My 95% interval | `scores.json` interval |
|---|---|---|---|---|
| Coverage C / D | 0.9186 / 0.9380 | same | | |
| Difference (≥10 points) | +1.94 points | +1.94 | −0.78 to +5.43 | −0.78 to +5.43 |
| Page-only coverage C / D | 0.8178 / 0.8333 | same | | |
| Page-only difference | +1.55 | +1.55 | −1.55 to +5.04 | −1.55 to +4.65 |
| Context7 only (D-C7) / Ref only (D-Ref) | 0.9341 / 0.9302 | same | over C: +1.55 (0 to +3.88) / +1.16 (0 to +3.49) | |

**FAIL.** The ablations' requirements supported over C's: Context7 2, Ref 1. Relevant documents only one provider found: Context7 88, Ref 33 across the 96 queries; few reach a top 10 where C lacks the requirement.

## Q03: the failure, why, and what it means

The failure is as recorded: D adds 1.9 points of documentation evidence coverage over C, against a threshold of 10. The interval crosses zero, so even the small gain is statistically inconclusive. Every figure in `Q03-documentation-helpers-gap.md` reproduces from my own scoring:
- D beats C on Q081, Q106 and Q116, loses on Q004, and ties 39.
- Six queries stay below full coverage under D (Q004, Q024, Q031, Q082, Q090, Q119), with the helpers active on all six.
- On Q004, nDCG@10 falls from 0.515 to 0.456 and coverage from 1.00 to 0.67.
- Two of D's top-10 documents are unjudged, and every documentation passage is judged.
- The over-firing reasons: 15 `unresolved_technical_signal`, 10 `classifier_positive`, 6 `deterministic_signal`, 1 timeout and 1 `explicit_docs_request`.

My independent view of why:
1. **The gated measure had almost no room.** C already covers 91.86% of the requirements, so D could add at most 8.14 points. The threshold was out of reach on this corpus and these labels whatever the helpers did. The note says so correctly.
2. **The ceiling is not the whole story.** Page-only coverage has room: 18 of 43 queries are below full under C, at 81.8%. Yet there D adds only +1.55 points, with an interval crossing zero. On both measures, the helpers' contribution to supported requirements is small. The note's third item proposes restating the target on page-only coverage, where 10 points "is arithmetically possible". On these results that restated gate would also fail.
3. **The documentation passages are few, and Ref read nothing.** The passage round judged 29 documents and verified 47 requirement passages (`labels.json` `agreement`). Ref's bounded enrichment read never fired in 120 runs, so Ref's part in Q03 is its search excerpts alone.
4. **Ranking is unchanged within noise.** D − C nDCG@10 is +0.004 over 96 queries (interval −0.003 to +0.011) and +0.010 over the 43 documentation-positive ones (−0.000 to +0.020).
5. **Firing precision is the cost lever, not the cause.** The helpers fire on 33 of 53 queries that do not need documentation (62%). That costs Context7 requests and Ref credits but did not change coverage. The two misses (Q060, Q084) already had full coverage under D.

What it means for the release: the documentation helpers' benefit is **not demonstrated** on this benchmark. It is also not shown to be harmful: one coverage loss (Q004), and no significant nDCG change. The owner's decision to ship with Q03 recorded as failed is stated here as given; the gate is not relabelled and no threshold is lowered. The helpers add metered spend; over the 120-query collection, D's own ledger came to Context7 90 requests and Ref 89 credits. That cost buys no measured coverage gain, which is worth weighing when the firing rules are next tuned, on the 24 tuning queries only.

## F03: what fails

F03 asks for "zero confirmed version mismatches in strict-version outputs". I read "strict-version outputs" as the results returned for a request carrying a hard `library@version` pair, and "confirmed" as established from the source. Each judgment here cites a verified passage. On that reading:
- Sixteen held-out queries send a hard pair. On six of them D's top 10 contains **20 documents independently judged a version mismatch**: Q002 (2), Q010 (3), Q111 (1), Q115 (4), Q117 (8) and Q120 (2).
- All 20 have verified passages and were also graded by the second judge (every judged mismatch was in its sample); one was adjudicated.
- C's top 10 holds 21 and A's 42, so this is not a regression the documentation helpers introduced.
- Across the 19 versioned queries, D's top 10 is judged 147 match, 20 mismatch, 22 unknown and 1 not applicable (190 documents): 77.4% confirmed by the judges and 11.6% unknown.

The system itself confirms no version: of D's 960 top-10 documents, 13 carry a version scope, and none has status `match`. The narrower reading, that no output the system *itself* confirms as mismatched may be returned, would pass only because the system confirms nothing. I do not adopt it.

The concrete trace, Q117 (`SI5/eval/runs/Q117.json`):
1. The request is "What's New In Python 4.0", with `documentation: "required"` and `libraries: [{ python, 4.0 }]`. The corpus marks it `expectNoMatch` and notes that "returning 3.x pages as if 4.0 is a failure".
2. D returns `outcome: complete` with `warnings: []`. Eight of its top 10 are Python 3.x "What's New" pages, each judged a mismatch at grade 1.
3. Context7, asked for the strict scope `python@4.0`, served pages from the library `/websites/python_3_10`. Its answer carried no `version.libraries` entry, so `scopeRecord` (`services/retrieval/src/search-intelligence/adapters/context7.mjs:81-86`) recorded `observedVersion: null, status: "unknown", basis: "query_hint"`. The sub-operation was `ok`, the lane `success_results`, and nothing was said.
4. Spec §6.1 requires: "If a hard version has no matching documentation, report that exact-version no-match rather than silently substitute latest."

The fixture (`si-docs-decisions.test.mjs:80`) covers a mismatch reported through `version.served` and deliberately keeps "none" as `unknown`. It does not model a library id that names another version, which is what the live API sent.

F03's other clauses:
- **Matching-version evidence retained and attributed:** passes in fixtures (`si-docs-decisions.test.mjs:80`).
- **No false merges:** holds by construction. The code never hard-collapses, only exact canonical-URL grouping and soft groups (`decisions.mjs:276`), and the mirror fixture keeps both rows (`si-jev-search.test.mjs:165`).
- **Unique-provider sentinel:** passes, but its fixture (`si-discovery.test.mjs:81-90`) checks only that the sentinel enters the shortlist, not the "independently expected output position" §24.1 asks for.
- **Citations identify real sources:** of D's 960 top-10 URLs, the Pi captured 754, 8 answered HTTP 404, 185 could not be captured by the platform's own acquisition, and 5 were Reddit gates.

F03 is FAIL. Remedying it, or recording it as failed by owner decision as Q03 was, is the owner's call and is not made here.

## The Reddit exclusion

All 92 Reddit captures in the pool were one page, Reddit's human-verification gate, stored as `captured`. They are now stored as `blocked`, and the grades judged on them are dropped (flag `capture_blocked`), with the original labels kept beside each. The first judge had graded them 0:4, 1:41, 2:16, 3:1 and unjudged:30, which reproduces from `labels.json`. The exclusion was decided after provisional scores existed. `gate-reclassification.md` says so and gives a before-and-after table.

How honestly the note reports it:
- Its rule (a judgment made on a capture the packet misrepresented as captured is void) is stated accurately and applied uniformly.
- Its table was computed on provisional labels, before adjudication.
- Its row "Q02 nDCG@10 difference, D over B" (`gate-reclassification.md:30`) is mislabelled: Q02 is C over B.
- It gives Reddit's top-10 presence for B, C, D, D-C7 and D-Ref (25, 10, 9, 10 and 10 of 120 queries), all of which reproduce, but **not for A**. A, Q01's baseline, ranks a Reddit page in its top 10 on **71 of 120 queries (61 of the 96 held-out, 67 slots)**, against D's 5 held-out.
- Its statement that the exclusion "does not favour D by removing a weakness of D's" is true of B but not of A. Dropping those grades lowers A's nDCG more than D's.

Does the result depend on the exclusion? It does not. On the **final** labels, the gates with the exclusion and with the dropped grades restored (the first judge's grade, since blocked documents were never adjudicated) are:

| | Excluded (as recorded) | Restored |
|---|---|---|
| nDCG@10 A / B / C / D | 0.5000 / 0.6271 / 0.7330 / 0.7370 | 0.5116 / 0.6324 / 0.7351 / 0.7388 |
| Q01 relative improvement | +47.4% | +44.4% |
| Q01 recall@20 gain | +39.2 points | +39.0 points |
| Q02 difference | +0.1059 | +0.1027 |
| Q03 coverage C / D, difference | 0.9186 / 0.9380, +1.94 points | 0.9186 / 0.9380, +1.94 points |

No gate status changes either way.

## The judging

| Round | Judge | Records | What I checked |
|---|---|---|---|
| First (all 96 queries) | `claude-sonnet-5-5`, 101 agents | `judges.json` `rounds.first` | Five judges opened another query's output to copy its shape (Q050, Q055, Q061, Q064, Q067); each query was judged again, with the original kept. `judges.json` records five; the SI5 review's W16 disposition says four (`SI5/review/REVIEW.md:95`). Q110's one flag (`.env` in the judge's own text, not a file access) matches `judge-notes.json`. |
| Second (20% per category plus every mismatch, mirror and raised question: 2,861 documents) | 63 queries `meta/muse-spark-1.3-contributor` through OpenRouter, packet inline, temperature 0; **33 queries unrecorded** (given: their transcripts were lost) | `judges.json` `rounds.second`, `second-selection.json` | Containment of the 33 unrecorded queries cannot be audited. The 63 API queries started at 04:07:14Z, before the API judge was committed (`1147879` at 04:10:18Z). Their run records carry no script hash, and all seven failure files bear the `-tryN` names of `1147879`'s protocol, which `597ec91` replaced after the round. `labels.json` `judges.second.model` names Muse Spark for the whole round. |
| Adjudication (351 disputes) | `claude-opus-5-5`, 15 agents | `rounds.adjudication` | All contained. Adjudicators listed 218 requirement passages where the first judge had listed 123 for the same documents; only 6 adjudicated documents lost a requirement the first judge had. Restoring those changes Q03 by 0. |
| Passages (29 documents) | `claude-sonnet-5-5`, 3 agents | `rounds.passages` | 47 requirement passages verified, 0 unverified. |

Agreement recomputed from the rows matches `labels.json` exactly: 2,769 pairs (92 blocked pairs left out), 2,035 exact (73.5%), 2,418 on the same side of the relevance line at grade 2 (87.3%), and 2,569 within one grade. 351 disputes, all adjudicated. 0 unverified spans, 0 invalid grades, 0 changed files.

Provenance and its limits:
- Every final label is `independent_model_judgment` (3,664) or `independent_model_adjudication` (351). None is human.
- The adjudicator, the implementing session and this reviewer all run on Opus 5.5, so their errors may be correlated (spec §23.1).
- Jev supplied no label.

## Label spot-check

I drew 24 labels with my own salted hash order, spread over 11 categories, all four grades, both provenances and unjudged documents. I graded each from its packet: the task's question and requirements, and the document's excerpts and page in `eval/private/packets/`. No page text is copied here.

| Query | Document | Category | Label (provenance) | Mine |
|---|---|---|---|---|
| Q100 | `dbb79092beb` | ambiguous documentation | 0 (adjudicated) | 1 |
| Q062 | `de665d6f74f` | time-sensitive | 0 (adjudicated) | 0 |
| Q076 | `d89744f31d1` | general web | 1 (adjudicated) | 1 |
| Q060 | `d009637a3cd` | recent models and tools | 1 (adjudicated) | 2 |
| Q094 | `d550fc2700d` | ambiguous documentation | 2 (adjudicated) | 2 |
| Q019 | `d2c23b79ffd` | GitHub repositories | 2 (adjudicated) | 2 |
| Q049 | `df595c85712` | scientific research | 3 (adjudicated) | 3 |
| Q080 | `db766549aa1` | general web | 3 (adjudicated) | 3 |
| Q037 | `df01f78a2b3` | MLX | 0 | 1 |
| Q057 | `d21657bbd27` | recent models and tools | 0 | 1 |
| Q020 | `d9c0706b6ec` | GitHub repositories | 0 | 1 |
| Q115 | `d8c96b257c3` | explicit version and domain | 1, mismatch | 1, mismatch |
| Q012 | `d5092e3d71f` | GitHub repositories | 1 | 1 |
| Q115 | `d73bcfa337b` | explicit version and domain | 1 | 2 |
| Q095 | `d050523a906` | ambiguous documentation | 2 | 2 |
| Q026 | `d6e170704fd` | coding and infrastructure | 2 | 2 |
| Q021 | `d329b57c586` | coding and infrastructure | 2 | 2 |
| Q079 | `d9ebd11068d` | general web | 3 | 3 |
| Q107 | `d740608a66e` | near-duplicates | 3 | 3 |
| Q005 | `d9e001b2b00` | software documentation | 3 | 3 |
| Q022 | `daadee3ffce` | coding and infrastructure | unjudged | unjudged |
| Q031 | `d339fe921bb` | MLX | unjudged | unjudged |
| Q117 | `d6a87d379eb` | explicit version and domain | 1, mismatch | 1, mismatch |
| Q106 | `ddff0e045c8` | near-duplicates | passage round: R1 and R2 from Context7 | R1 and R2 supported |

On the 23 graded documents: **exact agreement 17 (73.9%), same side of the relevance line 21 (91.3%), within one grade 23 (100%)**, and the one passage judgment agrees. All six disagreements put my grade one higher. Four are at the 0/1 boundary, which changes no recall and little gain. Two cross the relevance line: Q060, an excerpt that states the over-200K price, and Q115 `d73bcfa337b`, a webpack 4 `cacheGroups` example. The rate matches the judges' own agreement with each other, and I found no direction favouring D or A. The two version calls checked (Q115 `d8c96b257c3`, which shows webpack 5's `defaultVendors`, and Q117's 3.14 page) are right. One adjudicated label (Q019) carries no requirement although its excerpt shows R1; the count above shows this is not systematic. This spot-check is itself a model judgment, on the same model as the adjudicator.

## Limitations not closed

- **The unrecorded judge model of 33 second-round queries** (given). Neither their model nor their containment can be audited. Their labels decide only which documents went to adjudication, and the first label stands unless adjudicated.
- **Second-round code identity.** The 63 API-judged queries ran on a tree that did not yet hold `1147879`. No run record names the script that ran. `judge-api.mjs`, `judge-api-lib.mjs`, the `judges.mjs` merge and `597ec91` fall outside every saved review (`SI6/review/ADDENDUM-REVIEW.md:11`). This review read `judge-api.mjs` and its diff and found no defect that changes a label.
- **Nothing measured on the Pi.** The cutover waits on the owner's launch authorization. L01 has no Pi measurement. F05's native-core path, V01's service images and redaction scan, and F02, F04 and O01's behaviour on the deployed system all wait on it.
- **The fixture record is one run by the orchestrator** (`test-run.txt`). I reran only the root suite (72/72). The 15 `tests/contracts/m1-gateway.test.mjs` failures are accounted for: they predate the branch, because the keys that test passes left the gateway in M3 (`269035d`, 2026-09-26) and the test file is unchanged on this branch.
- **Code after the freeze** (see "Integrity of the comparison"): Ref's and Context7's parser fixes were not re-measured on the corpus.
- **Redaction.** The project's hash-based redaction scan has not run (`SI6/verification.json`). My weaker pattern scan of the 158 committed `evidence/search-intelligence` files found no credential-shaped string and no occurrence of the Pi's LAN address or SSH host. Its two IPv4-shaped hits are DOI-style identifiers inside result URLs (Q043, Q084).
- **Partial unblinding (SI5 review S14, rejected there and recorded here).** Excerpt multiplicity and Context7's library-id titles can hint to a judge which provider returned a document. The packets were not rebuilt.
- **What the intervals cover.** They condition on this corpus, these snapshots and these labels. They do not cover systematic judge error, later provider changes, or human judgment.

## Items the SI5 review left to this file

- **S10, the Pi's month-to-date search and paid spend beside the collection's.** *Not read*: this review had no Pi access under its rules, so the item stays open. The collection's own ledger (`runs/*.json` `ledger`, 120 queries, fixture rows excluded) settled:
  - Brave 118 requests and Context7 90 requests;
  - DeepSeek 82,500 micro-USD, Exa 2,023,000 micro-USD and Jev (OpenRouter) 515,016 micro-USD, plus 8 released Jev reservations;
  - Ref 89 credits, Serper 125 credits and Tavily 236 credits.

  That is about $2.62 in metered USD. The second judging round cost $0.98 on OpenRouter (`judges.json`).
- **S11, the capture's client and the platform's residential and enhanced spend.** The client was `scripts/si5/capture.mjs` through `scripts/playground/server.mjs`'s `sshForward`: the desktop app's forwarder into the Pi's REST batch scrape, on the release deployed before this feature (`5d91186`). `captures.json` records 3,178 pages by `basic`, 14 by `stealth` and 796 failing before any route. The enhanced tier's cap was zero at the time, and failures read `BUDGET_EXHAUSTED`, so no enhanced dispatch was possible. The residential and any other spend on the Pi was *not read* (no Pi access); the item stays open.
- **S12, the bulk-threshold decision.** As `capture.mjs:1-10` states: 3,988 distinct URLs in batches of 25, one batch at a time, far below the platform's 300-page bulk threshold. Before each batch it read the Pi's direct-navigation count and waited while it would pass 4,000 of the 5,000-a-day allowance. The captures ran 2026-10-18 01:43–06:15Z.
- **S14:** recorded under "Limitations not closed".

## Reproducing these figures

The definitions are §23.2's: gain 2^g−1, discount log2(rank+1), ideal from the judged pool, unjudged counted as no gain and reported separately, a repeated canonical URL counted once. Recall@20 is against grade ≥2. Coverage counts a requirement supported by a top-10 document graded ≥1 and not of a mismatched version: a page passage for every profile listing the document, and an excerpt or documentation passage only for a profile whose own lanes delivered it. Every figure above comes from the committed files `SI5/eval/{labels,scores,pool,frozen,captures,judges,anchors,second-selection}.json`, `SI5/eval/runs/*.json` and `SI0/corpus/corpus-v1.json`. The exception is the spot-check, which reads the git-ignored packets under `SI5/eval/private/`.
