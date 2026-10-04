I classify this as **INCORRECT_TEST_FORMULATION**, with `classification_basis` CURRENT_SOURCE_FORMULATION_ONLY. The qualification is mostly honest, but one claim is still unsupported (C1). Remediation is not quite enough yet; one more zero-cost fix is needed before you request the grant.

## /review-2 confirmation — remediation of R01–R14

### Summary
I read `AUDITOR.md`, `dispositions.json`, the six corpus-v2 evidence files, all of `scripts/m9/corpus-v2.mjs`, `corpus-v2-live.mjs`, `corpus-v2-verify.mjs` and `tests/contracts/m9-corpus-v2.test.mjs`, and the changed lines of `collect.mjs` and `redaction.mjs`. I ran nothing. I did not see any private corpus, source, rawHtml or consent file, and did not check the 49-test PASS or the 20/20 preflight myself.

**Confirmed in code:**
- **R01:** post-close cleanup is checked against live state (`collect.mjs:26`, `corpus-v2.mjs:144-147`).
- **R02:** the request-plan hash is checked at freeze, consent and window.
- **R05:** exact argv, file hashes and ≥49 tests are required.
- **R06/R07:** HMAC-based correlation and a pre-dispatch preflight are in place.
- **R08:** 115 s deadline and ≥42 min remaining.
- **R09, R11–R13:** fixed.
- **R10:** the rejection is acceptable.
- The other 18 criteria, P19, 90%/≥18, ≤3 attempts and the 905-file history check are unchanged.

### Critical

**C1. The fact that separates a test problem from a real retrieval failure is recorded nowhere and checked nowhere.**
- `premise-decision.json:25,31` claims `identity_in_title_only` and "Both place identity in title" for the 2373-byte browser HTML the provider actually received.
- `source-inspection.json` has old-phrase fields only for the independent 577-byte fetch and the historical Markdown. It has none for the historical rawHtml body.
- `corpus-v2.mjs:36` only hash-pins `doc.rawHtml`. The absence check at `corpus-v2.mjs:39` and the title check at `:40` run against `html`, the independent fetch, which is a different variant.
- If the old phrase was in the rawHtml body but missing from the Markdown, these would be **REAL_RETRIEVAL_FAILUREs**, and the revision would hide them. This is the exact claim that remains unsupported.
- Patch, inside the `changed` block (no cost):
```js
const rb = visibleBody(doc?.rawHtml ?? '');
if (new RegExp(before.required_text,'i').test(rb) || !new RegExp(body,'i').test(rb) ||
    doc.rawHtml.match(/<title[^>]*>([^<]*)<\/title>/i)?.[1] !== title) return false;
```
- Also record `historical_raw_html_body_has_old_phrase` in `source-inspection.json`.

**C2. A regression from the R04 fix means several premise tests now pass for the wrong reason.**
- In `m9-corpus-v2.test.mjs:50` and `:53-55`, the test changes `html`/`markdown` after their hashes were stored in `inspectionText`.
- `revisionIntegrity` therefore returns `false` at the hash check (`corpus-v2.mjs:35`) before it reaches the semantic checks at `:38-42`.
- If you deleted lines 39-42, those tests would still pass. Only `metadata.title='wrong'` actually exercises the semantic logic.
- Fix: have `fixture()` take a mutator and rebuild `inspectionText` and `source_inspection_sha256` after the change. Add a rawHtml-body-identity case for C1.

### Warnings
- **W1.** `freeze.json:12` still says plain `"classification": "INCORRECT_TEST_FORMULATION"` with no qualifier. The qualifiers live only in `premise-decision.json`, and nothing binds that file: the gate (`corpus-v2-verify.mjs:26-28`, `corpus-v2-live.mjs:45-47`) only lists it as an input. Add `premise_decision_sha256` to `gate.json` and check it.
- **W2.** The outcome effect is understated. "A fresh result could change the count" (`premise-decision.json:36`) leaves out what the code already shows at `corpus-v2.mjs:37,42`: both preserved P01/P02 outputs meet the new criteria. Applied hypothetically and without rescoring, the old lineage would go from 17/20 to 19/20, across the 18 threshold. Say that in one sentence.

### Suggestions
- **Late dispatch:** `corpus-v2-live.mjs:87` sends a paid request whenever `left > 0`. A request sent with a few seconds left can still incur provider cost, then fails the window anyway. Refuse when `left < 115000` plus a small margin for the close-out calls.
- **Readable JS-option consent:** consent is currently a boolean plus a hash over the private URLs (`corpus-v2-live.mjs:16`). Have the consent repeat `premise-decision.request_profile`, including the P07/P08 waits and `onlyMainContent:false`, and check that it matches exactly.
- **Timestamp format:** `corpus-v2.mjs:99` compares months by slicing raw strings. Also require `x === new Date(x).toISOString()`.
- **Row scan:** `acquisitionRows()` (`corpus-v2-live.mjs:65`) reads the whole table more than 21 times, at over 1 MiB each. Filtering with `url_hmac = expected` would save time against the 42-minute budget.

### Good practices
- R01 checks the live state after close, not the repo copy: overlay absence (`collect.mjs:26`) plus the running container's env for paid dispatch.
- Correlation requires exactly one match on both receipts and log events, and is tested with a concurrent target and duplicate events.
- The normalization preflight runs again inside the driver and is stored in `raw`.
- Window expiry, month crossing and partial runs all fail closed. The disclosure that completion is not guaranteed is accurate: the 20×145 s floor (48.3 min) does not fit a 45-minute grant.
- No old results are rescored, and history is pinned by hash.

### Verdict
**Criterion integrity: APPROVED_AFTER_REMEDIATION once C1 and C2 are fixed (both cost nothing). It is not approved as-is.**
- Using the owner-required enum is honest, given `CURRENT_SOURCE_FORMULATION_ONLY`, `CRITERION_NOT_SATISFIABLE_BY_OBSERVED_SOURCE`, author intent UNKNOWN and source history UNKNOWN.
- What it does not yet support is the claim that the HTML the provider received had the identity only in its title. Until the rawHtml check runs, REAL_RETRIEVAL_FAILURE cannot be ruled out.

**Remediation:** R01–R14 are sufficient apart from C1, C2 and W1. Fix those, commit, and redo the review gate. Then ask the owner for the exact fresh grant together with explicit approval of the frozen P07/P08 caller options (1 s / 10 s waits, `onlyMainContent:false`). Nothing here counts as live acceptance, and the new corpus is still NOT_RUN.
