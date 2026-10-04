# M9 implementation observations

Initial local fixtures: 16 PASS, then two additional root-proof/restore-control checks PASS. Initial native Pi fixtures: gateway 74 PASS, retrieval 192 PASS, HTTP approval contract 4 PASS (270 total, no skips/failures). The final collector attempted a Git diff in /opt/firecrawl-pi, which is deliberately an archive with no .git; that collector assumption was corrected and will be rerun. These exploratory records preceded the final clean-source verification and are not acceptance.

The native CLI alias opus resolved to claude-opus-5-5 in a benign Max-subscription readiness call. The review can therefore use two fresh independent native contexts on that exact model; the orchestration runtime's own agent selector does not expose Opus. The recorded native mechanism replaces that unavailable selector, not the review model. USD printed by Claude is an API-equivalent estimate, not an invoice or authorization for new API billing.

The PRE-M9 provider grant is expired. No new backend paid call, public-corpus acquisition, destructive restore or deployment rollback has run in M9 yet. Native fixture tests use an internal disposable namespace and no production credentials. Production dispatch/caps remain false/zero. Automatic incident investigation remains disabled until review, independent fixtures and a bounded real subscription invocation pass.
