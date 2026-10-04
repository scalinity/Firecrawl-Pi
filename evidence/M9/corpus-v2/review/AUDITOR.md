## /review-2 — code-auditor (M9 corpus revision 2)

### Summary
**Scope:** I read the 4 new files in full, the 2 modified files, the 5 new evidence files, the callers (`live-contract.mjs`, `evidence-checks.mjs`, `resource-reuse.mjs`, `collection.mjs`, `pi-retrieval-log-scan.sh`, the retrieval HMAC code), the prior `evidence/M9/acceptance.json`, SPEC §31.1/AC03 and the M9 milestone text.

**Not run or not seen:** I executed nothing: no tests, no provider calls, no git commands. I did not see the private corpus, the private source HTML or the review gate. I did not verify the 42-test pass claim.

**Criterion-integrity verdict: a defensible correction, with conditions. It is not unsupported goalpost movement.**
- SPEC §31.1 lists "title/metadata" as a separate required assertion for static pages, and AC03 says "expected Markdown/HTML/links/metadata". Both the independently fetched source and the preserved run HTML put the identity only in `<title>`. So the old check measured a phrase the page body never had at measurement time. It did not measure whether retrieval worked.
- The replacement is stricter, not looser. It needs a full body sentence **and** an exact title match. Membership, the denominator of 20, the 18/20 threshold, P19, and the 3-attempt limit are all enforced (`corpus-v2.mjs:17-27`). The old 17/20 stays immutable, and a full fresh run of all 20 is required.
- **Conditions:**
  - The record must say plainly that this change decides the outcome: exactly the two failures flip.
  - "INCORRECT_TEST_FORMULATION" overstates what is known (W2).
  - The JS request-plan change is a second post-hoc change outside the authorized scope (W1).

### Critical Issues

**C1. Post-run cleanup ("fresh zero caps") can pass using a snapshot taken before the run**
- `scripts/m9/corpus-v2-verify.mjs:34-35, 58-60`
- **Problem:** `M9-CURRENT` and `M9-V2-USAGE` accept any `corpus-v2/current/versions.json` whose `source_commit === head`. Nothing checks that it was collected after the window closed. Also, `zero_caps` reads the repo copy of `deploy/policies/budget.json` (`scripts/m9/collect.mjs:20-21`), not the live validation overlay.
- **Trace:**
  1. The current-version record is re-collected during the fixture phase, as the context describes; it shows `paid=false`.
  2. The window is opened and the live driver requires `paidDispatch === true` (`corpus-v2-live.mjs:49`).
  3. The run completes and shutoff is skipped or fails.
  4. The verifier still passes cleanup from the earlier snapshot.
- **Risk:** Paid dispatch could be left enabled while the evidence says it was cleaned up. That is a false PASS on budget/security evidence.
- **Fix (minimal):**
```js
// corpus-v2-verify.mjs, inside the budget block before line 58
const cleanedAfter = Number.isFinite(Date.parse(current?.utc)) && Date.parse(current.utc) > Date.parse(window.closed_utc);
budget &&= cleanedAfter && costs.openai_micro_usd === 0 && ...
```
Also make `M9-CURRENT` require `current.utc > window.closed_utc` whenever `raw` exists. Record live evidence that the overlay is gone or at zero caps (`/etc/firecrawl-pi/m9-validation/budget.json`); repo bytes do not prove this.

### Warnings

**W1. The JS request plan differs from the original first-run plan**
- `scripts/m9/corpus-v2.mjs:49-51` compared with `scripts/m9/live-contract.mjs:8-11`.
- **Problem:** The original batch sent P07/P08 with no `actions` and no `onlyMainContent`. Both failed and passed only on rechecks. v2 now uses per-target waits (P08 = 10 s, picked after seeing results) and `onlyMainContent:false`, which widens the Markdown that `required_text` is checked against.
- No criteria hash changes. But this is a measurement change beyond "P01/P02 assertions only", and neither `freeze.json` nor `premise-decision.json` records it.
- **Suggestion:** Choose one:
  - Add `request_plan_sha256` to the freeze, disclose the change in the premise decision, and get explicit owner approval.
  - Revert to the original plan.

**W2. The classification goes beyond the evidence**
- `evidence/M9/corpus-v2/premise-decision.json:13,39`
- **Problem:** The record admits there is no pre-freeze source and no statement from the row author. Content drift on the public example pages is at least as plausible as a wrong formulation.
- **Suggestion:** Use a neutral label, e.g. `CRITERION_NOT_SATISFIABLE_BY_OBSERVED_SOURCE`, and keep the "UNKNOWN" source-change note.

**W3. The justification inputs are not tied to their recorded hashes**
- `corpus-v2.mjs:31-36`, called from `corpus-v2-live.mjs:33-35` and `corpus-v2-verify.mjs:20-23`.
- **Problem:** The private `P0x-source.html` and the recheck `document` are trusted as they are. Their hashes are never compared with `source-inspection.json` (`source_sha256`, `historical_markdown_sha256`). `freeze.source_inspection_sha256` is never checked. Editing the private files changes whether `M9-V2-REVISION` passes.
- **Suggestion:**
```js
digest(source.html) === inspection.observations[i].source_sha256 &&
digest(doc.markdown) === inspection.observations[i].historical_markdown_sha256 &&
digest(readFileSync(base+'/source-inspection.json')) === freeze.source_inspection_sha256
```

**W4. The fixture gate is weaker than the row it replaces**
- `corpus-v2-verify.mjs:29-33`
- **Problem:** `M9-RESOURCE-EVALUATOR-TESTS`, which was PASS in the prior acceptance, is overwritten by any run showing `# fail 0`. Nothing requires `tests/contracts/m9-corpus-v2.test.mjs` or the resource-evaluator suite to be in `tests.files`, and there is no minimum test count (compare `fixturesVerdict`, `evidence-checks.mjs:38-43`).
- **Suggestion:** Require both files and a total `# tests` of at least 42.

**W5. One correlation miss fails the whole batch, and the batch can't be rerun**
- `corpus-v2-live.mjs:98-99, 68-69`
- **Problem 1:** A failed response with no `scrapeId` only correlates when `fresh.length === 1`. Any concurrent client or extra acquisition row leaves it uncorrelated, which fails `fullRunVerdict` for all 20. The batch is `wx`, so a 19/20 run would be lost.
- **Problem 2:** Bindings HMAC the raw spec URL. The service HMACs `req.url` (`services/retrieval/src/acquire.mjs:258`), which Firecrawl may normalize, e.g. by adding a trailing slash. This has never been checked against a live run.
- **Suggestion:**
  - Before spending anything, compare the oracle's HMACs with the stored `fcpi_retrieval.acquisition.url_hmac` values from the prior run's rows.
  - Among the fresh IDs, pick by DB `url_hmac` matching and require exactly one match, instead of requiring `fresh.length === 1`.

### Suggestions
- `required_text` is compiled as a RegExp (`corpus-v2.mjs:35-36,57`). Make sure the sentence's `.` is escaped in the private spec, as the fixture does.
- `budgetAdmission` uses only the current UTC month. Refuse windows that cross a month boundary.
- Put `request_sha256` for each row into `corpus.json` so the public record shows the plan.
- Add tests for C1 (snapshot older than the window) and W3 (source files that don't match their hashes).

### Good Practices
- All historical evidence stays untouched:
  - 905-file name and hash manifest plus an empty `git diff` against the base commit.
  - `--corpus-v2` output redirection, with self-exclusion in the redaction scan.
  - `wx` intent records.
- Fail-closed throughout:
  - The 18/20 threshold is tested against 17/20.
  - P19 failure is kept.
  - Attempts are bounded on every row, including failures.
  - No old results are rescored.
- The HMAC key never leaves the container.
- Spending controls:
  - Model spend is pinned to 0.
  - The admission rule (cap − used ≤ new grant) blocks unused old headroom from being reused.
  - Cost rows are tied to fresh logical IDs.
- Gates reused from the prior acceptance depend on an exact allow-list of changed paths plus `codeDirty`.

### Verdict
**CHANGES REQUIRED before any spending request.**
- Fix C1.
- Fix W3 and W4, which are cheap and protect evidence integrity.
- Resolve W1 explicitly: either freeze and disclose the JS plan with owner approval, or revert it.
- Do the zero-spend correlation preflight (W5).

The P01/P02 criterion revision itself is defensible, provided it is labeled neutrally and disclosed as outcome-determinative.
