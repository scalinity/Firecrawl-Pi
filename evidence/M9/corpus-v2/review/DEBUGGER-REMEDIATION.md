## Summary
I reviewed all 14 dispositions against the current `corpus-v2.mjs`, `corpus-v2-live.mjs`, `corpus-v2-verify.mjs`, the test file, and the changed lines in `collect.mjs:20-26` and `redaction.mjs:26-27`. All the fixes are in place:

- **R01:** `cleanupFresh` at `corpus-v2.mjs:144-147`, used at `corpus-v2-verify.mjs:35-36` and `:60`; `validation_absent` at `collect.mjs:26`.
- **R02:** checked at `corpus-v2.mjs:24`, `:94` and `corpus-v2-live.mjs:16`.
- **R04:** `corpus-v2.mjs:34-37`.
- **R05:** `:150-156`. The 24+5+20 `test(` calls add up to 49.
- **R06:** `:158-166` and driver lines `107-118`.
- **R07:** driver `75-77`, plus verdict lines `89` and `116`.
- **R08:** driver `18` and `86-98`.
- **R09:** verify `:17`.
- **R11:** `:75`.
- **R12:** live `:19` and verdict `:99`.
- **R13:** `:79` and `:82`.

I ran nothing. I did not see the private corpus, URLs, criteria or the run/source files. The source-hash, preflight and literal-proof PASS states are as recorded, not checked by me.

**Classification.** The qualifier works where it is written. `premise-decision.json` limits the label to the observed current source. It marks author intent and source history UNKNOWN, labels the capability statement as an inference, and makes no claim about author error or source drift. The spec and milestones docs (`docs/FIRECRAWL_PI_SPEC.md:1289`, `docs/FIRECRAWL_PI_MILESTONES.md:621`) say "relative to the observed current source". With the owner-required enum, that is an honest fix. Two gaps remain (W1, W2).

**I'm correcting my earlier report.** I called the new criterion "stricter". It is *different*, not a superset of the old one:
- A body that has the identity phrase but no purpose sentence passed the old check and fails the new one.
- The new check passes without the identity appearing in the body.

"Not easier, given the observed source" still holds.

## Critical Issues
None.

## Warnings
**W1. The outcome effect is understated** (`premise-decision.json:36`, `:63`). "A fresh result could change the count" is true but too weak.
- Under the old criteria, P01/P02 fail every correct retrieval of the observed source. If P19 still fails, the best possible score is 17/20, below the 18 needed.
- So the correction decides whether acceptance is *reachable at all* unless P19 recovers. That is the claim the owner needs to see, and the record doesn't state it yet.
- Suggested replacement text: `"outcome_determinative": "Under the old P01/P02 assertions and a still-failing P19, at most 17/20 is reachable; this correction can be acceptance-determinative. No old result is rescored."`

**W2. The qualifier is not bound to anything.**
- `freeze.json:12` carries the bare label `INCORRECT_TEST_FORMULATION`.
- `premise-decision.json` is not hashed into the freeze, and neither gate check covers it: `corpus-v2-live.mjs:45-47` and `corpus-v2-verify.mjs:26-28` both skip it.
- The qualifier can therefore be edited after review without failing any check. Its `state` also still reads `PROPOSED_PENDING_INDEPENDENT_REVIEW`.
- Fix: add `gate.premise_sha256 === digest(readFileSync(base + '/premise-decision.json'))` to both reviewed checks, and update `state` before writing the gate.

**W3. The preflight has an expiry date.**
- `services/retrieval/src/store.mjs:443` deletes acquisition rows older than 30 days.
- The preflight depends on the initial batch from 2026-10-03. From about 2026-11-02, `normalizationProof` will refuse to run. It refuses with zero spend, but it blocks the run.
- `budget-plan.json` is also built on an October baseline.
- A grant used in November needs both re-derived. The owner's grant should be used in October.

**W4. The deadline margin is only 5 s.**
- The client's absolute deadline is 115 s. The gateway's core timeout defaults to 110 s (`PI_CORE_TIMEOUT_MS`, `services/access/src/config.mjs:76`).
- If the deployed environment raises that value, or the Tailscale hop adds delay, the client aborts first and ends a batch that can't be rerun.
- I did not see the deployed environment. Confirm the value before the grant.

**W5. Two different month checks** (`corpus-v2.mjs:99` vs `corpus-v2-live.mjs:19`).
- The verdict compares raw string prefixes; `ready()` compares parsed UTC dates.
- A timestamp that doesn't end in `Z` can pass `ready()` and then fail acceptance after money is spent.
- Fix: in the verdict, compare `new Date(x).toISOString().slice(0,7)`, or require timestamps to end in `Z`.

## Suggestions
- Each row's `request_sha256` (`corpus-v2.mjs:79`) is an unsalted hash over the URL, so anyone who guesses a URL can confirm it. This matches the existing unsalted `criteria_sha256` values, so either accept it or note it as a limitation.
- Another client scraping a corpus URL during the window causes an ambiguity, and the run fails safely. Ask the owner to pause other clients for the window.

## Good Practices
- Every fix fails closed and comes with negative test cases.
- Correlation is a pure, tested function.
- Request-plan consent is checked at three points: readiness, verdict and freeze.
- The proposed 20 × 145 s minimum-time floor was turned down with the arithmetic shown, and no completion guarantee is claimed.
- The 32 MiB output buffer (initially 1 MiB) was disclosed rather than hidden.

## Verdict
**Criterion integrity: APPROVED_AFTER_REMEDIATION, on condition that the W1 wording and W2 binding are done.** The remaining unsupported point is not a claim about history; it is the understated outcome effect.

**The existing fixes are sufficient** for asking the owner for two separate things:
- a fresh, exact grant;
- explicit consent to the frozen request plan (`55b89646…`), including the P07/P08 waits (1 s and 10 s) with `onlyMainContent=false`.

Before asking, apply W1/W2, which are text and a gate field, not backend changes, and check W3/W4. No live run or acceptance is claimed.
