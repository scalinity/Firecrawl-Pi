# /review-2: debugger (M9 corpus revision 2)

## Summary
I reviewed the four new proof files, the two output-path diffs, the five new evidence files, the original request builder (`scripts/m9/live-contract.mjs`), the prior recheck evaluator (`scripts/m9/resource-reuse.mjs`), the log scanner (`scripts/m7/pi-retrieval-log-scan.sh`), the URL HMAC in `services/retrieval/src/acquire.mjs`, and SPEC §31.1 and AC03.

**Criterion integrity: a defensible correction, but the label and one adjacent change need fixing before a grant.**
- **What makes it defensible.** The old P01/P02 assertion cannot be met by any correct retrieval of the current source: the phrase sits only in `<title>`. Membership, denominator, the 18/20 threshold, the 3-attempt limit and P19 are unchanged and checked structurally (`scripts/m9/corpus-v2.mjs:17-41`). The 17/20 record stays immutable, and a full fresh 20-target run is required.
- **The new criterion is stricter, not easier.** It needs body content AND an exact title. Metadata alone cannot pass. Fixtures confirm this.
- **The label is not supported.** "INCORRECT_TEST_FORMULATION" claims the author meant something different, and nothing proves that. Widely known older versions of this page had the identity in a body heading, with different purpose wording. That points at least as strongly to source drift. This comes from general knowledge, not repo evidence.
  - The defensible label is "assertion unsatisfiable against the current source; cause unknown."
  - Note that SPEC 31.1's listed remedies are routing/provider revision or failing acceptance. Revising criteria rests on the owner's explicit authorization, not on the spec.
- **The request plan goes beyond "assertions only."** P07/P08 now get wait actions and `onlyMainContent:false` (Warning 1).

**Not run:** I executed nothing, ran no tests, and made no provider or Pi calls. The private corpus, URLs, `required_text` values and raw run files were not readable, so I could not check escaping in the actual criteria or the contents of the 905-file manifest.

## Critical Issues

**C1. The cleanup proof is not ordered after the run, so the usage gate can pass before cleanup has happened.**
- **Where:** `scripts/m9/corpus-v2-verify.mjs:34-35, 58-60`
- **Problem:** `M9-V2-USAGE` takes `current.checks.zero_caps/paid/cloud` as the post-run cleanup proof, and `M9-CURRENT` only checks `source_commit === head`. Nothing requires `current/versions.json` to be collected after the window closed. Separately, `zero_caps` reads the repo's `deploy/policies/budget.json` (`scripts/m9/collect.mjs:20-21`), which is always zero. It never looks at the active validation budget overlay. Only `paid`, read from the container environment, observes the runtime.
- **Trace:**
  1. Run `collect.mjs --corpus-v2` before opening the window. `paid=false` and `zero_caps=true` are recorded at the same HEAD.
  2. Open the window and run the driver.
  3. `live-window.json` gets marked CLOSED by hand, but paid dispatch is left enabled.
  4. The verifier gives `M9-CURRENT` PASS and `M9-V2-USAGE` PASS, and the result can be ACCEPTED while paid dispatch is still live.
- **Fix:**
```js
const cleanupObserved = Number.isFinite(Date.parse(current?.utc)) && Number.isFinite(Date.parse(window?.closed_utc)) &&
  Date.parse(current.utc) > Date.parse(window.closed_utc);
budget &&= cleanupObserved && costs.openai_micro_usd === 0 && /* existing conditions */ ...;
```
Apply the same `cleanupObserved` condition to the `M9-CURRENT` row whenever `raw` exists.

## Warnings

1. **`scripts/m9/corpus-v2.mjs:51` vs `scripts/m9/live-contract.mjs:8-11`.** The original frozen plan sent P07/P08 with no actions. They passed only on rechecks that used these options. The v2 plan adopts the recheck options, so the measurement procedure for two rows outside P01/P02 changes after results were seen. These are already-supported caller options, and the old 17/20 lineage counted P07/P08 under them, so this doesn't make things easier than the record that was accepted. Still, `freeze.json` does not bind the request plan at all. **Suggestion:** declare it in `premise-decision.json` and add `request_plan_sha256` to the freeze, checked in `revisionIntegrity` and `fullRunVerdict`.

2. **`scripts/m9/corpus-v2-live.mjs:33-34`.** The historical Markdown that justifies the revision comes from the final recheck, which used `onlyMainContent:false` plus `rawHtml`. The new P01/P02 requests use the default `onlyMainContent`, so the proof was produced under a different request profile than the one that will be scored. **Suggestion:** also confirm the sentence appears in the initial-batch P01/P02 Markdown, which used the same profile as v2. Otherwise, disclose the mismatch.

3. **`scripts/m9/corpus-v2-live.mjs:68-70, 105`.** The expected URL HMAC is computed over the raw spec URL. The service hashes `req.url` as it arrives from the core. If the core normalizes the URL at all (a trailing slash, for example), all 20 rows end up uncorrelated, and the batch cannot be rerun. That would waste the whole grant. **Suggestion:** do a zero-cost preflight before spending. Compare the oracle output against a `url_hmac` kept from a prior acquisition log for the same URL, if one was retained.

4. **`scripts/m9/corpus-v2-live.mjs:79-111`.** The worst case per target is a 130 s timeout plus up to about 10 s of log polling, plus SSH round-trips. Twenty of those can come close to the 45-minute window, and an expiry mid-batch ends a batch that can't be rerun. **Suggestion:** before dispatch, refuse unless the remaining time covers 20 × 145 s, and request the full window.

5. **`scripts/m9/corpus-v2-verify.mjs:15-17`.** `replace()` keeps `evidence_mode:'UNCHANGED_IMPLEMENTATION_REUSE'` and `execution_source: cf7ab14` (and `finding_count: 255` on `M9-REVIEW`) on rows that are actually freshly re-executed: `M9-REVIEW`, `M9-CURRENT`, `M9-REDACTION` and `M9-RESOURCE-EVALUATOR-TESTS`. That provenance is misleading. **Suggestion:** have `replace` set `evidence_mode:'FRESH_REVISION_2'` and `execution_source: head`, and delete the stale `finding_count`.

6. **`tests/contracts/m9-corpus-v2.test.mjs`.** The fixtures cover only `ready()` from the driver. Nothing tests the correlation choice (`scripts/m9/corpus-v2-live.mjs:97-109`): the scrapeId-versus-single-fresh-ID fallback, duplicate log events for one logical ID, or a concurrent fresh ID. The budget wiring and `historicalIntact` are also untested. **Suggestion:** extract the correlation into a pure helper and test those cases.

## Suggestions
- Criteria are compiled with `new RegExp(value,'i')`. Make sure the private P01/P02 sentence escapes `.` and other metacharacters. If not, the match is looser than the "complete sentence" claim. Unescaped criteria won't crash after paying, because `revisionIntegrity` compiles them before dispatch.
- In `scripts/m9/corpus-v2.mjs:69`, `failure` can be non-null on a usable 200 row (from `acquisition.failure`). Report it as `null` when `usable` is true.

## Good Practices
- `wx` intent records before each dispatch make the batch single-shot.
- The URL HMAC key stays on the Pi.
- Every check fails closed (`try/catch → false`).
- `budgetAdmission` bounds absolute cap headroom by the new incremental grant.
- History integrity uses both the git tree and current byte hashes.
- Failed rows still need a target-bound HMAC and a fresh unique ID.
- Fixtures confirm 17/20 still fails and P19 stays a real failure.

## Verdict
**Changes requested before requesting the spending grant.** Fix C1, and resolve or explicitly disclose Warnings 1–3. The criterion change is defensible on unsatisfiability, but not on the claimed author intent: relabel the classification and bind the full request plan into the freeze.
