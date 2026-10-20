# Q03: where the documentation helpers fall short

Q03 asks for documentation evidence coverage at least 10 points above C (the five engines plus Jev, no documentation helpers) on the 43 documentation-positive held-out queries (spec §25). It **fails**: D is **+1.9 points** over C, with a 95% interval of -0.8 to +5.4. The release records it as failed and ships with the gap described here. The gate is not relabelled, its threshold is not lowered, and the result is the same with or without the Reddit exclusion (`gate-reclassification.md`).

Every figure below comes from `eval/scores.json` (`perQuery[*].activation`, `perQuery[*].profiles`, `gates`, `docsAblations`, `uniqueRelevant`) over the 96 held-out queries, with the labels in `eval/labels.json`.

## When the helpers fire

| Queries | Count | Helpers fired | Rate |
|---|---|---|---|
| Explicit documentation requests | 10 | 10 | 100% |
| Documentation-positive (the explicit ones included) | 43 | 41 | 95.3% |
| All other queries | 53 | 33 | 62.3% |

- **Misses are few.** Q060 (`recent_models_tools`) and Q084 (`difficult_semantic`) were classed `nontechnical` with no signal.
- **There is no margin on F01's 95% threshold.** 41 of 43 is the least that passes (95% of 43 is 40.85); one more miss, 40 of 43, is 93.0% and fails.
- **Over-firing is common.** The 33 firings on queries that did not need documentation have these reasons: `unresolved_technical_signal` 15, `classifier_positive` 10, `deterministic_signal` 6, `classifier_timeout_possibly_technical` 1, `explicit_docs_request` 1.
- **By category, other queries fired the helpers most in** `github_repositories` 7 of 7, `coding_infrastructure_research` 6 of 6, `recent_models_tools` 4 of 4, `time_sensitive` 5 of 8 and `scientific_technical_research` 4 of 8, and least in `general_web` 1 of 8 and `difficult_semantic` 0 of 2.

Each firing runs both documentation providers, which are metered (a Context7 request, and Ref calls that use credits) and add latency, for no benefit this evaluation measures. That is the first room for improvement.

## What the firing gap explains and what it does not

The gap you asked to have stated is real, but it is mostly about over-firing and ranking, not about missed queries. On the 43 documentation-positive queries:

- **The two misses cost nothing on this gate.** Q060 and Q084 already had complete coverage under D (1.00).
- **D beat C on 3 queries (Q081, Q106, Q116), lost to C on 1 (Q004), and tied on 39.** Three gains less one loss is the +1.9 points.
- **Where coverage is still incomplete, the helpers did fire.** Six queries stay below full coverage under D (Q004, Q024, Q031, Q082, Q090, Q119) and the helpers fired on all six, so a different firing rule would not have closed them.
- **Q004 is a regression from firing.** `explicit_libraries` activated correctly; C covered R1, R2 and R3, D covered R1 and R2. The documentation results took a top-10 place that a general result needed (nDCG@10 0.515 to 0.456). How the two are blended is the second room for improvement.
- **The target cannot be reached on this corpus.** C already covers 91.9% of the requirements, so even full coverage under D adds at most 8.1 points to the measure the gate uses. Page-only coverage has room (C 81.8%, D 83.3%, and 16 queries below full under D), where a 10-point gain is arithmetically possible.
- **Unjudged documents do not explain it.** Across these 43 queries, 2 documents in D's top 10 were unjudged and no documentation passage was.
- **Each provider adds a little.** Context7 alone adds 2 requirements over C and Ref alone adds 1; each also surfaces relevant documents no other provider returned (Context7 88, Ref 33).

## Room for improvement

1. **Firing precision.** Two rules cause 25 of the 33 unnecessary firings, and both are set to favour recall. `unresolved_technical_signal` (15) fires on technical vocabulary alone, a technology with a technical word or two technical words, and never asks the classifier (`documentation.mjs`: it "cannot be ruled out by a low score"). `classifier_positive` (10) fires when Jev's probability is 0.2 or more, a threshold "kept low for recall" (spec §13). Tuning either one, on the 24 tuning queries, is the lever. Recall has to stay at or above 41 of 43, so there is no spare query.
2. **The blend when the helpers fire.** Find why Q004's documentation results displaced a general result that carried R3, and whether the blended ranker can keep both.
3. **The target.** A 10-point gain on this measure cannot be met at C's level. Whether to restate it, for example on page-only coverage, is a deliberate spec change for the owner to make, not something applied to this record.

Rules for any of this work (spec §23, §25): tune only on the 24 tuning queries; the held-out set stays frozen and is never relabelled as tuning after its scores were seen; thresholds are not lowered to obtain a pass.
