# Serper search review of record

Date: 2026-10-15. Scope: additive post-M9 Google search integration against `148d0c4`. Two fresh, read-only reviewers used **GPT-6.1 Sol** because Opus 5.5 is unavailable in this runtime; this is the permitted §5 model substitution. Review method: `/review-2`; remediation: `source-command-address` (`/address` equivalent). Neither reviewer read credentials or made a live provider call.

## Code Review: Serper search integration

### Summary
The two reviewers reproduced three failure-path defects and identified one coverage gap. No critical security or credit-accounting defect was found. Live calls are held until all four findings have an outcome and affected verification passes.

### Critical Issues (Must Fix)
None found.

### Warnings (Should Fix)
1. **R1 — Deadline excludes reservation and DNS** — `services/retrieval/src/serper.mjs`
   - Problem: The transport timer starts after DNS, and the timeout was computed before ledger admission. A fixture lookup delayed 100 ms dispatched after a 20 ms timeout, returning after 107 ms. Slow DNS could consume the ten-second search deadline and Yahoo fallback window.
   - Fix: Apply an absolute deadline across ledger admission, DNS, connection and response; prevent late dispatch and release an unsent reservation after expiry. Test delayed admission and DNS.
   - Outcome: FIXED in `dacb577`. Regression verification: 255/255 Pi retrieval tests PASS, zero skips; `evidence/post-m9/serper-search/fixtures.json`.
2. **R2 — Ledger errors strand a half-open breaker** — `services/retrieval/src/serper.mjs`
   - Problem: Failed settlement followed by failed uncertainty bookkeeping exits before breaker completion. A half-open probe keeps `probing=true`, refusing later calls even after database recovery.
   - Fix: Complete the breaker independently of bookkeeping and preserve unresolved reservations conservatively. Test recovery of a half-open probe after database errors.
   - Outcome: FIXED in `dacb577`. Regression verification: 255/255 Pi retrieval tests PASS, zero skips; `evidence/post-m9/serper-search/fixtures.json`.
3. **R3 — Cache failure discards Google results** — `services/retrieval/src/search.mjs`
   - Problem: The provider catch also catches cache writes. A successful, settled Google response followed by a failed cache insert incorrectly invokes Yahoo and can return `SEARCH_BACKEND_UNAVAILABLE`.
   - Fix: Keep successful results when caching fails; report cache failure independently. Test with Yahoo unavailable.
   - Outcome: FIXED in `dacb577`. Regression verification: 255/255 Pi retrieval tests PASS, zero skips; `evidence/post-m9/serper-search/fixtures.json`.
4. **R4 — Exhaustion and uncertain-send coverage missing** — `services/retrieval/test/serper.test.mjs`
   - Problem: The test title claimed exhausted-credit coverage but exercised only missing credentials and cancellation. The in-memory ledger does not enforce lifetime caps.
   - Fix: Test an exhausted reservation with a credential present and assert zero dispatches; test sent/unknown exceptions retaining credits. Establish lifetime enforcement with real PostgreSQL concurrency, calendar-change and pruning tests.
   - Outcome: FIXED in `dacb577`. Regression verification: 255/255 Pi retrieval tests PASS, zero skips; `evidence/post-m9/serper-search/fixtures.json`.

### Suggestions (Consider)
None.

### Good Practices
- The PostgreSQL transaction lock serializes allocation reservations across months.
- Search reservation amounts survive pruning; uncertain dispatch outcomes retain credit.
- Production provider origin and credential filenames are restricted.
- Fixture selection bypasses Serper and fallback metadata names Google failures.
- Documentation labels live capability unverified until measured.

### Verdict
Approve with suggestions, conditional on R1–R4 remediation and verification. No live verification performed by the review.

Remediation recheck: both reviewers inspected the fixes. The debugger independently reproduced the deadline returning at 21 ms for a 20 ms budget and confirmed no late dispatch and preserved Google results on cache failure. The auditor confirmed deadline and breaker fixes by inspection. Reviewer test-execution limits: neither reran PostgreSQL; those results are recorded by the executing session.
