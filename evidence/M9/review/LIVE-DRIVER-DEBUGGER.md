## Code Review

### Summary
The request bodies now pass the gateway's actual `validateBody`. Scrape `maxAge`/`storeInCache` and the extract `x-idempotency-key` header are accepted, and the old `cacheMode`/body `idempotencyKey` fields are rejected. `liveExitCode` correctly returns nonzero on any 400, a missing or failed poll, empty results, or fewer than 18/20 usable. The source-equivalence split is correct: `verify.mjs` checks corpus and research with `sameCode(...,false)` and everything else with `independent=true`. Two gate defects can still spend the single fresh authorization on a run that fails or cannot be attributed.

### Critical Issues
1. **`scripts/m9/live.mjs:9,19`: the preflight checks a manifest that is never shown to be the deployed one, and evidence is attributed to the Pi's commit, not the driver's.**
   - `validateLiveRequests` reads the local working-copy `deploy/policies/capabilities.json` and `validate.mjs`.
   - `testedSource` is read from `/opt/firecrawl-pi/.fcpi-source-commit`.
   - Nothing compares the two, or checks that the local tree is clean.
   - Trace (normal workflow): commit the driver fix, don't redeploy since services are unchanged, then run. The Pi still reports `909d997…`. `verify.mjs` then computes `sameCode('909d997…',false)`, and that diff includes `scripts/m9/live.mjs`. `onlyProofChanges(...,false)` returns false, so M9-CORPUS and M9-RESEARCH can never PASS after a fully paid, successful run.
   - Reverse trace: a dirty local driver runs against a Pi at HEAD and is recorded as HEAD.
   - The "actual gateway manifest" requirement is also unmet whenever the Pi deploy differs from the local checkout.
   - Minimal fix: before the consent and token reads, abort unless all of the following hold:
     - `git status --porcelain -- services deploy scripts tests patches` is empty.
     - `git rev-parse HEAD === testedSource`.
     - `sha256sum` of the Pi's `/opt/firecrawl-pi/deploy/policies/capabilities.json` and `services/access/src/validate.mjs` matches the local files.

2. **`scripts/m9/live.mjs:10,15`: the authorization and review gates don't bind to this delta or to a fresh window.**
   - The review gate is `review.includes('Remediation complete')`. The prior round's remediated `REVIEW.md` already satisfies it before this review is recorded or addressed.
   - The consent check covers only `scope` and `expires_at`. The closed window ended with unused time, so if its `consent.json` remains, `expires_at > now` holds and paid calls dispatch under the CLOSED authorization.
   - Minimal fix:
     - Require `reviewVerdict(review).complete` with a remediation row naming the current HEAD.
     - Require the consent to carry an `issued_at` (or window id) later than `closed_utc` in `evidence/M9/work/live-window.json`.
     - Abort if the consent matches the closed window.

### Warnings
1. **`scripts/m9/live.mjs:28`: the poll budget is shorter than the gateway's own extract bound, and non-terminal polls are dropped.**
   - The loop polls 50 × 1.5 s ≈ 75 s. The manifest allows `scrapeTimeoutMs: 60000` plus model time, within `deadlineMinutes: 20`.
   - Trace: the extract scrape takes about 55 s and the model about 25 s. The loop exits with no `poll/read` step, so `researchComplete` is false and the exit is 1.
   - The paid extract's outcome is never recorded, and a rerun regenerates the key, re-dispatching the extract and all 20 scrapes.
   - Minimal fix:
     - Poll until `min(consent.expires_at, submit + manifest.limits.extract.deadlineMinutes)`.
     - Push the last non-terminal poll as `poll/read`; `researchComplete` still fails it.

### Suggestions
- `tests/contracts/m9-live.test.mjs:24`: `research[0]` is the search body, not a scrape. Mutate `plan.corpus[0]` and `research[2]` with `cacheMode`, since those are the requests that actually failed.
- `scripts/m9/live-contract.mjs:26-32`: also check that a `GET /v2/extract/{id}` route exists, so the poll path is covered by the manifest preflight.
- `scripts/m9/live.mjs:24`: `url` is unused, because the plan now owns the target. Remove it.

### Good Practices
- Request generation is pure and shared by the driver and the tests. Validation runs through the real gateway `validateBody` before any network or consent I/O.
- The exit code is derived from raw responses, and `verify.mjs` reuses the same `researchComplete` for the research verdict.
- `liveProducerPaths` gives independent equivalence only. Services, lock, collector and incident paths stay non-equivalent, and the test asserts this.
- No M8 24h repeat is triggered; resource reuse is untouched by these paths.

### Verdict
**REQUEST CHANGES.** The request-contract repair is correct. Fix Critical 1 and Critical 2, plus Warning 1, before obtaining fresh owner authorization. As written, a single authorized run can burn paid calls on evidence that `verify.mjs` will reject, or can dispatch under the closed window's authorization.
