# SI5 acceptance: search intelligence against spec §25

| | |
|---|---|
| Written | 2026-10-20T07:15Z (UTC) |
| Candidate | `7009d2a612e75acfeda55b86f804cbbea067e1cd` (`git rev-parse HEAD`). Its code is identical to `273b2e3`, where the fixture suites ran (`SI5/acceptance/test-run.txt`): the two later commits change only evidence (`1e32f46`) and the main spec and ORCHESTRATION.html (`7009d2a`, the LlamaParse allowance). |
| Code tree | Clean (`git status` empty before this file was written). |
| Reviewer | A fresh-context agent on Opus 5.5 (`claude-opus-5-5`), with no part in producing the evidence. No sub-agents. It ran no evidence-writing script, no Docker, Colima or SSH, and no network command; it read no `.env` or secret file. |
| Ran | Its own read-only scripts (not committed) and `node --test tests/*.test.mjs` from the repository root: 72 of 72 pass, 0 skipped (Node 26.12.0). |
| Contract | `docs/FIRECRAWL_PI_SEARCH_INTELLIGENCE_SPEC.md` §23 and §25; `CLAUDE.md` §5 and §25–§27. |

**Updated three times on 2026-10-20: the final verdicts are in "Third update — 2026-10-20, the fifth release" at the end of this file.** The earlier updates are kept as written: the first at `9a7a45a`, the second at `e9e9d08`, and everything above them at `7009d2a`.

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

## Update — 2026-10-20, after the cutover

| | |
|---|---|
| Written | 2026-10-20T11:30Z (UTC), by the same reviewer (Opus 5.5, fresh context for the update, no sub-agents, no Pi, Docker, SSH or network access, no evidence-writing script) |
| Candidate | HEAD `9a7a45a5905a835edd5cc9093af5a973697eccd8`, code tree clean. During the review another session added files I did not write and left untouched: `SI6/raw/test-run-9a7a45a.txt` (untracked) and an edit to `PROGRESS.md`. |
| Deployed | The third release: the services built from `5e035b2` (retrieval `1cb9b68b…`, access gateway `cf06cecd…`, MCP gateway `13aad419…`) and the API image `c2585732…`; cutover at deployed commit `4b1c11e`, end marker reached 10:42:20Z, all four healthy (`SI6/raw/cutover.txt`); the same ids in `deploy/versions.lock.json`. |
| Ran | `node --test tests/*.test.mjs`: 74 of 74 pass, 0 skipped. My own read-only scripts over the raw records, below. |

Since `7009d2a` the release was cut over three times. The first cutover was followed by two patch releases: `20d9729` (a caller's cancellation counted against a provider's breaker) and `5e035b2` (Ref result blocks without a marker refused). The code reviewed for this update is `git diff 7009d2a..HEAD -- services scripts tests deploy docs/FIRECRAWL_PI_SEARCH_INTELLIGENCE_SPEC.md`.

### Current verdicts

| Criterion | Verdict | Changed | Kind of evidence | Evidence | Limitations |
|---|---|---|---|---|---|
| F01 | **PASS** | margin now evidenced | fixture; live (SI5); Pi-live | `SI5/eval/runs/*.json`; `SI6/raw/l01-live.jsonl` (`cold_docs`, `activation_repeat`); `si-semantic.test.mjs` (every explicit cue) | Still 41/43 against 40.85 needed. But 37 of the 41 activations and both misses are fixed rules, unchanged since the collection, and the 4 classifier-dependent queries scored 0.70–0.95 on the Pi against a 0.2 cutoff. |
| F02 | **PASS** | REST hop now live | fixture (with PostgreSQL); Pi-live | `SI6/raw/test-run-9a7a45a.txt` (retrieval 488/488 at HEAD, uncommitted); `si-degraded.test.mjs`; 84 live searches with every partial attributed | The HEAD test record is not committed. |
| F03 | **FAIL** | the silent substitution is fixed; the criterion still fails | model-judged (collection); Pi-live (version report); source; fixture | `SI5/eval/labels.json`, `runs/Q115.json` et al.; `SI6/l01/live-summary.json` `f03`; `versions.mjs`; `coordinator.mjs:265-266` | See "F03 after the change" |
| F04 | **PASS** | | fixture (with PostgreSQL); Pi-fixture; Pi-live (ledger) | `test-run-9a7a45a.txt`; `SI6/raw/l01-fixture.jsonl` (cancellation); `SI6/raw/usage-day-after.txt` | The Pi cancellation exercise reads an in-memory ledger (`si-helpers.mjs:195`); the database-backed exactly-once tests are in the 488. |
| F05 | **PASS** | was BLOCKED | fixture; Pi-live | live REST search, MCP search and scrape on each release (`SI6/raw/live-smoke.jsonl`, `release-1/`, `release-2/`); `verify-functional.txt` ×3; suites at `17429cc` (gateway 101, MCP 51) and HEAD (retrieval 488, root 74) | Release 1's first MCP check answered HTTP 421 and passed on a second attempt (`release-1/live-smoke-mcp.jsonl`). Crawl, map and the legacy route were not rechecked live (ROLLOUT step 8). |
| Q01 | **PASS** | | model-judged | unchanged; my scorer reproduces `scores.json` exactly (0 per-query differences) | Bounded for the unrecorded judge: +47.7% with its influence removed (reproduced) |
| Q02 | **PASS** | | model-judged | unchanged | +0.1067 with the unrecorded judge's influence removed |
| Q03 | **FAIL** | | model-judged | unchanged | Recorded as failed by owner decision |
| L01 | **PASS** | was BLOCKED | Pi-live; Pi-fixture | `SI6/raw/l01-live.jsonl`, `l01-fixture.jsonl`, `release-1/l01-fixture-run*.jsonl`; `SI6/l01/README.md` | Measured on the second release's image; see "L01 on the Pi" |
| O01 | **PASS** | | fixture (with PostgreSQL); source | `test-run-9a7a45a.txt`; schema re-applied idempotently at each cutover (`SI6/raw/cutover.txt`) | No record shows `search_run`/`search_event` rows on the Pi (ROLLOUT step 8 asks for it) |
| V01 | **PASS** | was BLOCKED | live; source; this review | contracts (SI0, SI5 smoke, three release smokes); `deploy/versions.lock.json`; `SI6/verification.json` (18 PASS, 0 NOT_RUN, clean tree); `SI6/raw/redaction.json` (PASS); `SI5/review/ACCEPTANCE-REVIEW.md` | The redaction record names a commit that did not produce it, and the scan was not the last evidence step (see "Redaction") |

**Overall: 9 PASS, 2 FAIL (F03, Q03), 0 BLOCKED. The feature is not accepted as a whole.** Q03 is failed by the owner's recorded decision. F03 is failed and needs either a fix or the owner's explicit acceptance, which ROLLOUT gate 2 requires and no record yet shows; the release is live.

### F03 after the change (question a)

**What changed.**
- `730b623` reads a version from a Context7 library id (`/websites/python_3_10` → 3.10) and leaves out passages whose id names another version.
- Every hard `library@version` now carries a verdict in `coverage.documentation.versions`: `confirmed`, `no_match` or `unconfirmed`. The last two raise `exact_version_no_match` or `exact_version_unconfirmed` with a readable warning.
- The rule is sound on reading and in its tests: years, dates (the MCP `2025-06-18` versions), bare numbers and `/v8/v8` name no version, and `latest` never reaches it because its scope is unrepresentable.
- Its effect on the frozen collection is nil for the gates: of 30 version-scoped top-20 documents in D and D-C7, 4 would lose their Context7 passages. All four are Q117's documents at ranks 15 and 17, graded 1 and 0.

**Live figures, recomputed** from `SI6/raw/l01-live.jsonl` (second release):
- All 16 held-out hard-version queries returned a report: 12 `confirmed`, 4 `unconfirmed` (Q006 `sqlalchemy@2.0`, Q024 `node@18`, Q056 `python@3.14`, Q117 `python@4.0`), and 0 `no_match`.
- Q117 now warns instead of answering silently, which closes the defect in my earlier critical finding.

**Why F03 still fails.**
1. The criterion asks for zero confirmed version mismatches in strict-version outputs. The 20 judged mismatches were in rows the general engines supplied (each found by at least one general engine; one, Q115's `webpack.js.org` page, by Ref too; none by Context7). That path is untouched: `rank.mjs`, `normalize.mjs` and the Brave, Exa, DeepSeek and Tavily adapters have not changed. The milestones record concedes it: "a strict-version request can still list other versions' pages".
2. The new verdict comes only from Context7's scope (`versions.mjs:7-11`), and a warning is raised only when it is not `confirmed` (`coordinator.mjs:266`). The five queries that held 12 of the 20 mismatches (Q002, Q010, Q111, Q115, Q120) now report `confirmed` with no warning. On exactly those answers, the report reads as a confirmation while the rows beside it are other versions' pages.
3. The live run cannot show otherwise. `l01.py` records each search's row count and bytes but not its URLs, so no live output can be checked against the judged labels.
4. The reporting clause is now met at the request level: 75% of requested versions confirmed, 25% unconfirmed. That is a documentation-scope figure, not the confirmed-version coverage of the evidence in the output. The other clauses pass:
   - matching-version evidence kept and attributed (fixtures);
   - no false merges (by construction);
   - unique-provider sentinels, now asserted at their final position (`3826d29`);
   - citations: 754 of D's 960 top-10 URLs captured at collection.

**What would make F03 pass.** Give general rows a version status from deterministic source signals: path and host segments such as `/9.6/`, `/en/6.1/`, `v7.vite.dev`, `whatsnew/3.14.html`. Under a hard version, flag or demote rows of a known other version (spec §11.2: "Exact domain and version violations are removed by code before ranking"), and make the request-level report count rows of other or unknown version. The rule can be measured offline against the 20 judged mismatches and 147 judged matches already labelled, with no new judging. By my reading of the URLs, about 12 of the 20 carry such a segment, so a URL rule alone would not reach zero. Otherwise the owner records F03 as failed, as for Q03.

### L01 on the Pi (question b)

Every figure below was recomputed from the raw records. The percentile rule is nearest rank, as the drivers use.

| Scenario | Labelled | Image | n | p50 | p95 | max | Over 23 s / 60 s |
|---|---|---|---|---|---|---|---|
| cold link-only (documentation off) | live | `d13b5a9b` (2nd release) | 30 (30 cold) | 7,357 ms | 8,706 ms | 9,692 ms | 0 / 0 |
| cold documentation | live | `d13b5a9b` | 30 (30 cold) | 7,456 ms | 11,777 ms | 11,840 ms | 0 / 0 |
| four at once | live | `d13b5a9b` | 8 | 6,126 ms | 7,699 ms | 7,699 ms | 0 / 0 |
| discovery provider stalled (one harness / fresh each) | fixture | `d13b5a9b` | 30 / 30 | 199 / 10,014 ms | 10,015 / 10,018 ms | 10,015 / 10,021 ms | 0 / 0 |
| Jev stalled (one harness / fresh each) | fixture | `d13b5a9b` | 30 / 30 | 200 / 8,010 ms | 8,012 / 8,012 ms | 8,013 / 8,013 ms | 0 / 0 |
| four at once | fixture | `d13b5a9b` | 32 | 400 ms | 802 ms | 803 ms | 0 / 0 |

**The criterion as written is met.**
- **The named scenarios meet the target.** The single-active cold scenarios of spec §23.3 (general, documentation-positive, one discovery provider stalled, Jev stalled) each have at least 30 observations and a p95 of 11.8 s or less, against 23 s. Searches were at least 54 s apart, so one was active at a time.
- **Deadlines held.** No search passed the 60 s deadline.
- **No leak or OOM.** Over 426 memory samples, firecrawl-core peaked at 1,757 MiB and the retrieval service at 62 MiB, and the host never fell below 4,711 MiB available.
- **No post-cancel send and no fan-out.** In the cancellation exercise, 8 searches threw CANCELLED, the 8 survivors finished at Jev's own 8 s timeout, and none was left reserved. Four-at-once stays bounded.
- **Labelled and tied.** Live and fixture runs are labelled apart, each tied to its image.

**Limits.**
- **The final release was not re-measured.** The measurements ran on the second release; the third differs only in `adapters/ref.mjs` and its test (`git diff 20d9729 5e035b2 -- services`).
- **Documentation latency on the final release rests on 6 searches.** The 30-search documentation scenario ran while Ref was failing in 10 of 30. On the final release, the 5 Ref replays and the smoke took 6.6–12.6 s.
- **The stalls are coordinator-level fixtures.** They ran in a throwaway container with the test harness's in-memory ledger, not end to end through the gateway and core; the margin is about 13 s.
- **One table row is cold-only.** The README's `activation_repeat` row gives figures over its 3 cold searches only.

### F01's margin (question c)

The count margin is still zero by construction (41/43). What was missing was evidence that the 41 does not depend on chance, and it is now there.
- 23 activations come from explicit library hints, 7 from `required`, 4 from deterministic signals and 3 from unresolved technical signals. All are fixed rules in `documentation.mjs`, unchanged since the collection; both misses (Q060, Q084) are deterministic `nontechnical` suppressions.
- The 4 classifier-dependent queries activated in all 5 observations each on the Pi: Q081 0.85–0.86, Q085 0.70–0.72, Q094 0.76–0.77, Q096 0.94–0.95. Because decisions are cached for 900 s, each query got two or three fresh classifier answers, not five; the README says so and the disposition's "asked five times" does not.
- A fixture now exercises every explicit cue word. I judge the margin adequately evidenced. A rule change or a new Jev build could still move it, so F01 belongs in any rerun after either.

### V01 (question d)

Nothing V01 lists is missing:
- **Hosted contracts:** SI0, the SI5 smoke, and a smoke on each release.
- **Build identity:** the lock and the cutover agree.
- **Review outcomes:** every finding of my report has an outcome.
- **Metrics:** they reproduce.
- **Redaction:** the scan passes.
- **Rollback profile:** the fixture `si-discovery.test.mjs:757` is in the 488, and the earlier releases' images are kept as `retained-*` tags.

Two record faults remain, below. They do not make anything V01 lists false, so V01 is PASS with them named.

### Redaction (question e)

The scan passes: 2,827 inputs, 59 live-secret hashes, 4 positive controls, 0 real hits, 0 unclassified, 319 classified, 52 of them through SI6's 20 exceptions.

**The changes did not weaken it.**
- Over the 1,741 files the endpoint check covers, the word-bounded match drops exactly one hit the substring match had: the schema name in `evidence/post-m9/streaming/local-suites.json`. No whole-word mention exists anywhere.
- `--also` adds only exact (path, rule, value-hash) exceptions, and cannot except a live-secret or endpoint hit.

**The exceptions are honest.** Each of the 20 matches its hits; I read each in masked context:
- placeholder `name:password` URLs in tests, and the desktop app's URL-validation cases;
- the 100.64.0.0/10 filter constant;
- sed patterns in a redaction script;
- the owner's checkout path in two archived scripts;
- a placeholder `sk-ant-test…0000` key;
- a tailnet-style fixture host name in a test;
- `public_text`: `/home/…` path segments and a JWT-shaped pagination cursor, all inside public URLs from captured provider results.

**Two faults.**
1. **The record misnames its code.** `raw/redaction.json` names `source_commit` `25e3593`, but its own input hashes show it ran `c67ea38`'s scanner (`66624db1…`) and `1cf45d2`'s exceptions (`e372c5df…`). Those were committed 13 s after the scan's 11:00:36Z start; at `25e3593` the scanner differs and the exceptions file does not exist.
2. **The scan was not run last** (CLAUDE.md §33.2). `PROGRESS.md`, `ACCEPTANCE-REVIEW.md` and `verification.json` changed after it, and since then `test-run-9a7a45a.txt` and this update.

A minor point: the word-bound look-behind also excludes `.`, which the false positive did not need.

### What the records misstate (question f)

- **Overstated in two places:**
  - "none confirmed wrongly" (`SI6/l01/README.md:58`, `ACCEPTANCE-REVIEW.md:137`). What was measured is that the one expect-no-match query was not confirmed (`live-summary.json` `confirmed_on_expect_no_match`). Whether the 12 confirmed versions are right was not checked.
  - The disposition's "asked five times each" (`ACCEPTANCE-REVIEW.md:146`): two or three fresh answers each.
- **Understated in two places:** `docs/FIRECRAWL_PI_MILESTONES.md:654` ("Known gaps: Q03 fails") and `PROGRESS.md` name Q03 as the only failed gate; F03 fails too.
- **Image id typo:** `PROGRESS.md:16` and `docs/FIRECRAWL_PI_MILESTONES.md:653` give the access gateway as `cf06cece…`; the lock and cutover say `cf06cecd…`.
- **Superseded note:** `SI5/acceptance/post-freeze-adapter-changes.md` predates `730b623` and `5e035b2`. I measured the first's effect (none on the gates); the second's cannot be measured, because the raw answers were not kept.
- **Steps not done or not recorded:** the patch procedure's step 6 fixture benchmark was skipped for the third release (the README gives its reason), and step 8's ledger, records, legacy-route, crawl and map checks are not in the evidence.
- **Confirmed accurate:**
  - the refused first cutover (the hold is cleared by the script's exit trap, `pi-cutover.sh:34`);
  - the firewall (canonical and guard-table hashes unchanged);
  - the host diff attribution;
  - the three backups;
  - the day's spend (Exa 1,360,000 µUSD over 80 searches, Jev 151,820 over 850 decisions, DeepSeek 57,000; Context7 34 settled + 10 uncertain, Ref 39 + 5);
  - the unrecorded-judge bound (A 0.4982, B 0.6251, C 0.7318, D 0.7358; 1,430 documents, 42 grades reset; 86 adjudicated documents, of which 78 to a grade and 8 to unjudged);
  - the labels: byte-identical to those I scored, apart from the added judge map, which now records 63 queries for Muse Spark and lists the 33 unrecorded.

### The changed code (review)

- **Cancellation (`provider.mjs`, `common.mjs`).** Sound. The lane's hard bound fires after the transport's own deadline timer (`coordinator.mjs:94`, grace ≤250 ms), so a stalled provider still ends `timedOut` and counts. Only a real parent abort is neutral, and a written request keeps its reservation uncertain. The test has a positive control.
- **The exact-version report (`versions.mjs`, `adapters/context7.mjs`).** Sound as a report. Its gap is F03's, above.
- **Ref (`adapters/ref.mjs:66-75`).** Widened. An unmarked block is now a result unless its link is on `ref.tools` or its text opens with a known refusal. So an unrecognised notice linking elsewhere, such as a status page or a payment link, becomes a billed result. `5e035b2`'s message says so. That reopens the hole the SI5 review's W13 closed.
- **The judge scripts and `labels.mjs`.** `judge-api.mjs` and `judge-api-lib.mjs` now record each script's hash, the commit and a dirty flag, and their tests pass; `labels.mjs` records which model judged which queries.
- **`pi-cutover.sh` and `score.mjs`.** `pi-cutover.sh` now reads the service's own image and refuses unless exactly one line is found. `score.mjs` computes recall@10 last, so the earlier intervals did not move; its recall@10 interval agrees with mine (10.36 to 14.59).

### Still open

- F03's failure, and the owner's decision on it.
- The general rows' version blindness.
- The redaction scan to run last, at a clean committed tree, after this update.
- The HEAD test record to be committed.
- Result URLs in any future live record, so live outputs can be checked against the labels.
- The cold documentation scenario on the final release.
- The unrecorded second-round judge's model and containment (given; bounded above).

## Second update — 2026-10-20, the final release

| | |
|---|---|
| Written | 2026-10-20T13:00Z (UTC), by the same reviewer (Opus 5.5; no sub-agents; no Pi, Docker, SSH or network access; no evidence-writing script) |
| Candidate | HEAD `e9e9d082398a98dd92783490d1bd6dc92ed6dd5a`, code tree clean. This file's two updates are uncommitted working-tree changes; the committed copy is still the record written at `7009d2a`. |
| Deployed | The fourth release: retrieval `ea6aac99…`, access gateway `60406db3…`, MCP gateway `acc75611…` built from `ad767a7`, with the API image `c2585732…`; cutover at deployed commit `d68ed054dde9`, end marker 11:49:44Z, all four healthy (`SI6/raw/cutover.txt`); the same ids in `deploy/versions.lock.json` and `deploy/compose.yaml`. |
| Ran | `node --test tests/*.test.mjs`: 74 of 74, 0 skipped. `scripts/si5/version-rule-measure.mjs`: output identical to the committed `SI5/acceptance/version-rule-measure.json`. My own read-only probes of the shipped functions and recomputations from the raw records, below. |

The code reviewed is `git diff 9a7a45a..HEAD -- services scripts tests deploy docs/FIRECRAWL_PI_SEARCH_INTELLIGENCE_SPEC.md`:
- the exact-version rule for the engines' rows (`versions.mjs` `urlVersionCheck`, `hardVersions`, `versionRowReport`; `normalize.mjs` `prepareCandidates`; `coordinator.mjs` `versionRows` and `version_rows_unverified`);
- the Ref lone-notice guard (`adapters/ref.mjs`);
- the redaction scan's self-identification and the verifier's check of it;
- `sameVersion` moved into `versions.mjs`;
- the normalizer's identity, now `si-normalize/2`.

### Final verdicts

| Criterion | Verdict | Kind of evidence | What changed since the first update |
|---|---|---|---|
| F01 | **PASS** | fixture; live (SI5); Pi-live | unchanged |
| F02 | **PASS** | fixture (with PostgreSQL); Pi-live | The final code's record is committed: retrieval 493/493 with PostgreSQL, root 74, gateway 101, MCP 51, 0 skipped (`SI6/raw/test-run-56dd9b3.txt`, clean tree). |
| F03 | **FAIL** | model-judged (labels joined to the final release's live row URLs); Pi-live; source; fixture | Fails on both readings (below) |
| F04 | **PASS** | fixture (with PostgreSQL); Pi-fixture; Pi-live (ledger) | Post-cutover ledger: every search category settled, `reserved_rows_left=0` (`SI6/raw/post-cutover-checks.txt`) |
| F05 | **PASS** | fixture; Pi-live | On the final release: REST and MCP search carry `fcpi.search` at the top level and in 5/5 rows, scrape 200, `functional PASS (d68ed054dde9)`; the legacy route answers 200 with 10 results, a crawl completed, a map answers 200 |
| Q01 | **PASS** | model-judged | Unchanged. With the URL rule applied offline: +47.8% (`version-rule-measure.json`, reproduced) |
| Q02 | **PASS** | model-judged | Unchanged; +0.1053 with the rule applied offline |
| Q03 | **FAIL** | model-judged | Unchanged; failed by the owner's recorded decision |
| L01 | **PASS** | Pi-live; Pi-fixture | The documentation scenario was rerun on the final image (below) |
| O01 | **PASS** | fixture (with PostgreSQL); Pi-live | Now with Pi rows: 107 `search_run` and 924 `search_event` rows in three hours (`post-cutover-checks.txt`) |
| V01 | **PASS** | live; source; this review | The redaction record now names what produced it, and the verifier checks it (below) |

**Overall: 9 PASS, 2 FAIL (F03, Q03), 0 BLOCKED. The feature is not accepted as a whole.**

### F03 on the final release (question a)

I recomputed every figure from `SI6/raw/l01-live-docs.jsonl`, the final release's 30 cold documentation searches, whose records now carry each search's row URLs. For the 16 held-out hard `library@version` queries, I joined each returned URL to the collection's judged labels:

- **160 rows:** 101 judged a match, **17 judged a version mismatch**, 17 unknown, 1 not applicable, 24 never judged.
- **The system's own count:** 23 confirmed, 137 unverified, and 91 candidates removed before ranking.
- **Verdicts:** 11 `confirmed` and 5 `unconfirmed`.
- **No false confirmation:** no row the URL rule confirmed is a judged mismatch, here or anywhere in the collection's pool.

All 17 remaining mismatches state no release the rule reads. 8 sit on a moving head (`/docs/current/`, `/docs/devel/`, `/en/latest/`, `/aws/latest/`, a `main` file); 9 are a blog, a mirror, a discussion, or a bare major (`/3/`, `/2/`).

**My verdict stays FAIL, on both readings of "zero confirmed version mismatches in strict-version outputs".**
1. **On the plain reading** (mismatches confirmed by the independent, source-backed judgments), 17 of 160 rows (10.6%) are confirmed mismatches.
2. **On the narrower reading** (mismatches the system's own evidence confirms), which I set aside before because the system confirmed nothing, the system now does read evidence. Even so, one returned row states another release in its own URL:
   - **Input:** Q117 (`python@4.0`).
   - **Row:** rank 4, `https://docs.python.org/3.4/whatsnew/index.html`; `urlVersionCheck` says `mismatch`, stating 3.4.
   - **Path:** the URL check runs only for a candidate with no `documentation` field (`normalize.mjs:83`), and the row reached the answer through a documentation lane, whose version is "judged by its scope" (spec §6.1). Ref has no version scope, and a Context7 scope can be `unknown`, so the URL's own evidence was never applied.
   - **Outcome:** the row is counted `unverified` instead of being removed, although spec §11.2 now says a violation "known … from … the release a URL itself states" is removed by code.

What changed is real and is to the release's credit:
- **Silent confirmation is gone.** A `confirmed` verdict no longer reads as a claim about every row, because `versionRows` and `version_rows_unverified` count and warn.
- **Detectable violations are removed.** Q117's judged mismatches fell from 8 to 1, with 42 candidates removed.
- **Coverage and the unknown rate are reported.** 23 of 160 rows confirmed (14.4%) and 137 unverified (85.6%), and unknowns are not counted as confirmed.

The criterion still asks for zero, and 85.6% unverified shows how far a version-blind web search is from version-specific evidence.

**Is the record's wording accurate and sufficient?** Mostly yes:
- **Accurate where it matters:** `SI6/l01/README.md` ("F03 stays failed as the criterion is written"), `PROGRESS.md` ("F03 fails as written and is recorded so") and the milestones section ("F03 fails as written", with the live figures). The milestones section also says, accurately, that "No separate owner decision on F03 is recorded: the release is merged under the owner's standing instruction of 2026-10-20 to proceed until everything is merged". Whether that standing instruction counts as ROLLOUT gate 2's "accepted" is the owner's call; the record does not claim more.
- **Two gaps:**
  - The milestones section and the C1 disposition say the rule "flags 2 rows judged a match". It flags 3 rows not judged a mismatch, the third being Q117's grade-3 "What's New in 3.15", judged not applicable. That page is the evidence that 4.0 does not exist.
  - No record mentions the documentation-lane path above.

### The version rule's false exclusions (question b)

**Yes, there is a false-exclusion path, and it is measured.** The library tie is a substring test, `seen.names.includes(lib)` over the flattened host and path (`versions.mjs:47-48`). So a version stated by *another product whose name contains the library's* counts as this library's release. Through the shipped `urlVersionCheck`, each of these comes out `mismatch` and would be removed before ranking:
- `node-postgres`'s `/tree/v8.11.0/` and `node-postgres.com/8.11/` for `node@18` (corpus query Q024 asks for `node@18` and `pg`, and node-postgres is `pg`);
- Celery's `/en/v5.3.6/django/` for `django@5.2`;
- `reactrouter.com/6.28.0/` and Preact's `/guide/v10/` for `react@19`;
- `docs.python-requests.org/en/2.31.0/` for `python@3.14`;
- `next-auth.js.org/v3/` for `next@15`;
- `v2.vitest.dev` for `vite@6`;
- `geopandas.org/en/v0.14.4/` for `pandas@2.0`.

A 3-character name such as `aws` (from `hashicorp/aws`) ties any URL containing "aws".

**On the corpus**, over every general-delivered labelled document of the 16 hard-version queries (not only D's top 10), the rule would remove 46 documents. 35 are judged mismatches, and **11 are not, 6 of them relevant (grade ≥2)**:
- Q117's grade-3 `docs.python.org/3/whatsnew/3.15.html` and grade-2 3.13/3.14 What's New pages (judged not applicable: for a version that does not exist, they are the answer);
- Q116's grade-2 pandas 1.5 `DataFrame.append` page (judged a match);
- Q120's two grade-2 `hashicorp/aws/6.x/…/version-4-upgrade` guides (judged a match).

One is the substring tie itself: CloudNativePG's `/docs/1.29/postgresql_conf`, removed for `postgresql@17`. Over D's top 10, the committed measurement's precision is 11 of 14 flagged rows. No gate verdict changes. The tests (`si-versions.test.mjs`) cover "another library's page" only with URLs that do not contain the library's name at all, so no test can fail on the substring tie.

### The Ref lone-notice guard (question c)

The guard is `texts.length === 1 && docs.length === 1 && plain.length === 1 && NOTICE.test(plain[0])` (`ref.mjs:112`). Each part has a case in `si-semantic.test.mjs`:
- three lone notices fail closed;
- two blocks with notice words are results;
- the `owner/repo - slug` form is a result;
- a lone prose block without the words is a result.

The maintenance notice from my report would have been a result on the previous code. I did not see the mutation checks the disposition mentions, so I cannot confirm them.

**The rule is not sound in either direction**, and I showed both through the shipped `parseRefSearch`:
- **Over-exclusion.** NOTICE is a list of single words (`rate`, `limits`, `plans`, `upgrade`, `verify`, `unavailable` …). Genuine lone results such as "Configure rate limits for the API gateway", "Upgrade guide from Vite 5 to Vite 6" and "How to verify a webhook signature" become `contract` / `ref_unrecognized_text`. That is a `contract_failure`, and three identical ones in a row put Ref on a 15-minute hold (`availability.mjs:113-118`, `CONTRACT_HOLD_AFTER = 3`). The W1 disposition's "leaves Ref's lane partial for that search" understates it: this is the same failure mode `5e035b2` fixed. None happened in the final release's 30 documentation searches (0 contract failures).
- **Under-exclusion.** Notices that avoid the list remain billed results with an external link: "Your trial has ended. Continue at …", "Your account has been suspended …" and "Search is temporarily degraded …". So does any notice sent as a second text beside a real result.

### V01 and the redaction record (question d)

The record now names what produced it, and the verifier checks it.
- **The record** (`SI6/raw/redaction.json`):
  - `source_commit` `4489b87` and `code_dirty: false`;
  - `scanner_sha256` equal to the scanner at HEAD;
  - `also` naming `evidence/search-intelligence/SI6/redaction-classifications.json` with its sha256 equal to the committed file;
  - 2,848 inputs, 59 live-secret hashes, 4 positive controls, 0 real hits, 0 unclassified.
- **Timing:** the scan ran at 12:33:32Z, after the last code commit, and the only file changed since is `verification.json`, which the verifier wrote 7 s later.
- **The verifier** (`scripts/si6/verify.mjs`, 18 PASS at a clean tree) accepts only a passing scan with `code_dirty === false` and the scanner hash at HEAD.
- **One gap:** it does not compare `also.sha256` with the committed exceptions file. Because `code_dirty` excludes `evidence/`, a scan run with an edited, uncommitted exceptions file would still verify. The values agree today.
- **Still to do:** this file's two updates postdate the scan and are uncommitted, so the scan should run once more after they are committed.

### Misstatements (question e)

- **The flagged-row count:** "flags 2 rows judged a match" (`docs/FIRECRAWL_PI_MILESTONES.md`, Known gaps; `ACCEPTANCE-REVIEW.md`, second-round C1). It is 3 rows not judged a mismatch, one of them a grade-3 answer. The post-freeze note says 3, correctly.
- **The W1 effect:** "leaves Ref's lane partial for that search" understates it (see question c).
- **"A documentation row, which a scope judges"** (`SI5/acceptance/post-freeze-adapter-changes.md`) is not true of Ref, which has no version scope.
- **Mixed runs:** the milestones L01 bullet joins the link-only run's memory floor ("never fell below 4.7 GB", from the second release's 4,711 MiB) to the final release's retrieval peak of 67 MiB. That run's floor was 4,674 MiB.
- **Confirmed against the files:**
  - the second-round S1 test record (493/493 retrieval, 74, 101, 51, clean tree);
  - S2's rerun (p50 8,016, p95 12,094, max 13,025 ms; 24 complete, 6 partial; 0 Ref contract failures; floor 4,674 MiB; core 1,796 MiB, retrieval 67 MiB);
  - S3's and S4's README wording;
  - S6's image ids;
  - S7's post-cutover checks;
  - S8's note;
  - S9's look-behind;
  - W3's row URLs;
  - the fourth release's cutover, lock and firewall (content unchanged);
  - the snapshot attribution's counts.

### Still open

- F03 fails. The owner's decision on it rests on the standing instruction, and no explicit acceptance is recorded.
- The URL rule's substring tie and its removal of relevant pages; the documentation-lane gap.
- The Ref guard's single-word vocabulary.
- The verifier's unchecked exceptions hash.
- This file to be committed, and the redaction scan to run after it.

## Third update — 2026-10-20, the fifth release

| | |
|---|---|
| Written | 2026-10-20T14:05Z (UTC), by the same reviewer (Opus 5.5; no sub-agents; no Pi, Docker, SSH or network access; no evidence-writing script) |
| Candidate | HEAD `bbfec85f3902e1b627dfc3927dac38c41deb4d76`, code tree clean; the second update is committed in `bcb9565` |
| Deployed | The fifth release: retrieval `0b3ab03a…`, access gateway `7fc4eccd…`, MCP gateway `9edf2895…` built from `2c9b629`, with the API image `c2585732…`; cutover at deployed commit `54bb6b1dbeba`, end marker 13:09:25Z (`SI6/raw/cutover.txt`); the same ids in `deploy/versions.lock.json` and `deploy/compose.yaml` |
| Ran | `node --test tests/*.test.mjs`: 74 of 74, 0 skipped. `scripts/si5/version-rule-measure.mjs`: output identical to the committed `SI5/acceptance/version-rule-measure.json`. Probes of the shipped `urlVersionCheck`, `prepareCandidates` and `parseRefSearch`, and recomputations from `SI6/raw/l01-live-docs.jsonl` and `SI6/raw/release-4/`. |

The code reviewed is `git diff 4489b87..HEAD -- services scripts tests deploy docs/FIRECRAWL_PI_SEARCH_INTELLIGENCE_SPEC.md`:
- `versions.mjs`: the library tie, now structural;
- `normalize.mjs`: a documentation candidate is exempt from the URL check only when its own scope confirms the version;
- `adapters/ref.mjs`: phrase-level notice patterns, and a lone notice that is neutral;
- `scripts/si6/verify.mjs`: the exceptions file's hash checked against HEAD;
- `scripts/si5/version-rule-measure.mjs`, the tests, the spec sentence in §6.1, and the image pins.

**A correction to my second update:** of the 11 non-mismatch documents the substring rule would have removed, 7 were graded relevant (≥2), not 6. My own list there names seven.

### Final verdicts

| Criterion | Verdict | Kind of evidence | Change since the second update |
|---|---|---|---|
| F01 | **PASS** | fixture; live (SI5); Pi-live | none |
| F02 | **PASS** | fixture (with PostgreSQL); Pi-live | final code's record: retrieval 495/495, root 74, gateway 101, MCP 51, 0 skipped (`SI6/raw/test-run-669a39e.txt`, clean tree; no source change since) |
| F03 | **FAIL** | model-judged (labels joined to live row URLs); Pi-live; source; fixture | Fails on the plain reading; the narrower reading's live count is now 0 (below) |
| F04 | **PASS** | fixture (with PostgreSQL); Pi-fixture; Pi-live | A lone Ref notice keeps its reservation uncertain, which I agree with (below) |
| F05 | **PASS** | fixture; Pi-live | the fifth release's live smoke and functional check |
| Q01 | **PASS** | model-judged | unchanged; +47.7% with the structural rule applied offline |
| Q02 | **PASS** | model-judged | unchanged; +0.1053 offline |
| Q03 | **FAIL** | model-judged | unchanged; failed by the owner's recorded decision |
| L01 | **PASS** | Pi-live; Pi-fixture | The fifth release's documentation scenario: p50 8,484, p95 13,929, max 14,101 ms (none over 23 s), host floor 4,730 MiB, retrieval peak 59 MiB (recomputed) |
| O01 | **PASS** | fixture; Pi-live | none |
| V01 | **PASS** | live; source; this review | the redaction record and verifier now pin the exceptions file too (below) |

**Overall: 9 PASS, 2 FAIL (F03, Q03), 0 BLOCKED. The feature is not accepted as a whole.**

### What changed, and whether it moves a verdict

**F03 (question e, recomputed).** All figures were recomputed from `SI6/raw/l01-live-docs.jsonl`, the fifth release's run, and they agree with `SI6/l01/f03-live-summary.json`.
- **Rows:** 160, of which 106 are judged a match, **16 judged a version mismatch**, 1 not applicable, 20 unknown and 17 never judged.
- **The system's count:** 21 confirmed (13.1%), 139 unverified (86.9%), 88 candidates removed.
- **Verdicts:** 11 `confirmed`, 5 `unconfirmed`.
- **Rows the shipped rule itself calls another release's page that still reached an answer:** 0 on the fifth release, against 1 on the fourth (`release-4/`: Q117's `/3.4/` page, the case of my W1).
- **Rows a URL confirmed that are judged mismatches:** 0.

The whole-pool measure reproduces: 617 general-delivered labelled documents, 43 removed (34 judged mismatches, 9 not, 7 of those relevant). D's top 10 still loses 11 of 20 judged mismatches, and 4 non-mismatch rows are flagged.

On the plain reading (mismatches confirmed by the independent, source-backed judgments), 16 of 160 rows remain, so **F03 stays FAIL**. On the narrower reading (mismatches the system's own evidence confirms), the fifth release's live answers now hold none, and the reporting clause is met (13.1% confirmed, 86.9% unknown, unknowns not counted as confirmed). The rule can still confirm a wrong-version row (Warning 1 below), though none was observed live or in the pool.

I keep the plain reading I have applied since the first review. Choosing the narrower one would be a change of the bar that belongs to the owner or the spec, not to the reviewer. The records state this accurately: `SI6/l01/README.md`, `PROGRESS.md` and the milestones section say "F03 fails as written", with the live figures. The milestones section also says that no separate owner decision is recorded beyond the standing instruction of 2026-10-20 to proceed until everything is merged. That is sufficient as a record; whether it is ROLLOUT gate 2's "accepted" is the owner's call.

**The structural tie (question a).** Every substring case from my W2 now comes out `unknown` through the shipped function:
- node-postgres (both forms), Celery's Django page, React Router, Preact, python-requests, next-auth, vitest, geopandas, CloudNativePG;
- an `aws` substring.

Each is now a test (`si-versions.test.mjs`) that would have failed on the substring rule. The structural tie still has two false paths, shown with inputs:
- **A host label with the library's site affix ties every version label of that host, including a sub-product's.** `https://v3.router.vuejs.org/guide/` (Vue Router 3, the router for Vue 2) is a **match** for `vue@3.5` and a mismatch for `vue@2.7`.
- **A path segment equal to the name ties every version after it, so a GitHub organisation or registry named like the library ties its other products.**
  - **Mismatches, removed before ranking:** `github.com/redis/redis-py/tree/v5.0.1`, `github.com/django/channels/tree/4.0.0` and `github.com/python/mypy/tree/v1.8.0` for `redis@7.2`, `django@5.2` and `python@3.14`; `pypi.org/project/redis/5.0.1/`, `pkg.go.dev/github.com/redis/go-redis/v9` and `rubygems.org/gems/redis/versions/5.0.8` for `redis@7.2`; `npmjs.com/package/mongodb/v/6.3.0` for `mongodb@7.0`.
  - **Matches, so false confirmations:** `github.com/django/channels/tree/4.0.0` for `django@4.0`, and `github.com/webpack/webpack-dev-server/tree/v4.15.1` and `github.com/webpack/webpack-cli/releases/tag/v4.10.0` for `webpack@4`.
  - None of these occurs in the corpus pool or the live run, whose 9 pool non-mismatches are all pages whose subject is another release. That cost is now stated in spec §6.1.
- **The `owner/name` form needs the two segments consecutive** (`/hashicorp/other/aws/6.0.0/` is `unknown`), and I found no false path in it. **The affix tie also covers AngularJS for `angular`** (`code.angularjs.org/1.8.2/` removed for `angular@17`), which I count as a correct removal.

**Documentation candidates (question b).** Through `prepareCandidates`, a Ref candidate with no scope and a Context7 candidate with an `unknown` scope are checked by URL and removed when it states another release. A `scope_only` candidate is kept and carries no URL verdict. The fifth release's 0 confirms it live.

**The Ref notice guard (question c).**
- **Both directions now parse as intended.** My three titles parse as results ("Configure rate limits …", "Upgrade guide from Vite 5 to Vite 6", "How to verify a webhook signature"), and my three notices return `{kind: "error", reason: "temporarily_unavailable", detail: "ref_unrecognized_notice"}`.
- **A lone notice reaches neither counter.** `judged()` reports the reason `unrecognized_notice`. `report()` gives the breaker `neutral()` for any reason other than `timeout` and `temporarily_unavailable`, and calls `availability.observe()` only for quota, rate, auth and contract reasons (`adapters/common.mjs:61-68`). So a lone notice reaches neither the breaker nor the contract counter, and no downstream code re-reports the lane's `temporarily_unavailable`. `si-ref.test.mjs` checks four in a row: Ref stays eligible, its breaker closed, its rows UNCERTAIN.
- **I agree with keeping the reservation uncertain.** Ref answered, and whether it charges for a notice is not documented. Spec §18.2 releases only an unsent request or a documented non-billable refusal, and the project already keeps Ref's answered failures uncertain.
- **The phrase list still over-matches.** Genuine documentation titles that fail as notices:
  - "Upgrade your app to React 19";
  - "Save a payment method for future payments";
  - "Handling 429 Too Many Requests responses";
  - "Find your API key in the dashboard";
  - "Customer billing portal integration guide";
  - "What to do when the rate limit exceeded error appears";
  - "Retry on failure: please try again with exponential backoff".
- **It still misses some notices,** which pass as results with an external link: "Credits depleted …", "Service unavailable, we are down for maintenance", "You have hit the free plan cap; sign up for Pro", "Sign up to continue searching", "This API key is invalid or revoked", "Monthly allowance used".
- **Both costs are now bounded to one search's Ref lane:** no hold and no breaker verdict. The lane is labelled `temporarily_unavailable`, which tells the caller less than `ref_unrecognized_notice` does. A notice sent as a second text beside a real result is still not detected, as the disposition says.

**The verifier (question d).** `scripts/si6/verify.mjs` now accepts the redaction record only when `also.sha256` equals `git show HEAD:<also.path>`; a different hash fails the check (`exceptions committed false`). The current record names `9752024` and `code_dirty: false`, and its scanner and exceptions hashes match HEAD. It passes over 2,863 inputs, and only `verification.json` changed after it. The verifier (18 PASS) does not pin `also.path` itself, so a different committed exceptions file would also verify; the path is in the record for a reader to see.

**The records (question f).**
- **The third-round table holds against the files,** with three exceptions:
  - W4 says the milestones section gives "the 4 non-mismatch rows flagged in D's top 10"; it gives the pool figures instead (9 not mismatches, 7 relevant).
  - The post-freeze note still says one of the 9 misses "is a documentation row that a scope judges"; under the new rule all 9 are URL-`unknown`, and the rerun table has no `documentation_row` entry.
  - The note and the W2 row call Q116's page "a pandas 1.5 migration page"; it is the 1.5 API reference for `DataFrame.append`.
- **The note discloses one more thing honestly:** the library tie was tightened after the rule had been measured on the held-out labels. So the rule's offline figures are on data that informed its revision, which spec §23.1 treats as regression data, not blind confirmation. Q01–Q03 themselves are unaffected, since they are measured on the frozen D outputs.
- **The milestones bullets match the files:** the second release's link-only run with its own floor (4,711 MiB) and peak (62 MiB), the fifth release's documentation run, five releases, the final images, and F03's figures.

### Still open

- F03 (failed as written; no explicit owner acceptance beyond the standing instruction).
- The tie's sub-product and organisation paths.
- The notice phrase list's over- and under-matches.
- The three record imprecisions above.
- This update to be committed and the redaction scan rerun after it.

## Owner decision on F03 — 2026-10-20 (not the reviewer's)

The owner decided F03 on the narrower reading, choosing the first of three options put to them: read the criterion as zero version mismatches among the rows an output reports as version-confirmed; check each unverified row's page body for a version (a new feature that still cannot reach zero, since some pages never state one); or withhold the unverified rows (about 87% of the general rows). `docs/FIRECRAWL_PI_SEARCH_INTELLIGENCE_SPEC.md` §25 states the criterion that way.

The reviewer's matrix above is unchanged: on the plain reading F03 reads FAIL in every update, and the matrix's counts (9 PASS, 2 FAIL) stand as written. Q03 stays failed by the owner's recorded decision. This section answers the question the updates left open, whether the standing instruction to proceed was an explicit acceptance: the owner has now made it explicitly.

What the narrower reading yields on the sixth release's live run (`SI6/l01/narrow-reading-summary.json`, from `analyze-narrow-reading.mjs`): of 160 returned rows 13 are judged version mismatches; none was confirmed by its URL, and at most one (Q112, a `docs.python.org/3/` page for a Python 2.7 query) could have been confirmed by a documentation scope, which the run's record cannot settle row by row. The earlier figure of 0 on the fifth release (above) was the reviewer's; this one is the bound the sixth release's record supports.
