# Serper Google search

State: **VERIFIED_LIVE** on 2026-10-15. The existing REST and MCP search paths now prefer Google results through Serper. Yahoo through private SearXNG remains the fallback; a Google failure stays explicit in a partial answer. Raw Google scraping remains unavailable on its separately tested route.

The key was transferred from ignored configuration through SSH stdin into a uid 3310, mode 0600 provider file. No credential appears in the repository or reports. No new service was exposed.

Verification:

- **PASS:** 255 retrieval tests on native ARM64, including real isolated PostgreSQL allocation races, calendar changes, pruning, exhaustion, cancellation, timeout, cache failure and breaker recovery. Zero failed or skipped.
- **PASS:** two distinct live queries, one starting through REST and one through modern stateless MCP, each returned five relevant results. Repeats through the other interface used the shared cache. No MCP initialization or session header was needed.
- **PASS:** two one-credit reservations settled. Account balance changed from 2,443 to 2,441 credits after its reporting delay. No other provider dispatch or new monetary spending occurred during these checks.
- **PASS:** all 15 project containers healthy; only retrieval was recreated. Firewall ruleset exactly unchanged; all snapshot changes attributed. Owned fixture containers removed.
- **PASS:** two-agent review and remediation; all four findings fixed in `dacb577`. GPT-6.1 Sol substituted for unavailable Opus 5.5, recorded in the review.
- **NOT_RUN:** search-plus-scrape in this session, Serper purchases or top-ups. Search alone invokes no LLM extraction.

The fixed allocation is 2,443 existing credits across calendar periods, not a monthly grant. Unknown outcomes keep their reservation; a zero remaining allocation falls back to Yahoo. No purchases, subscription, or automatic reload are configured. Prior LLM and proxy budgets are unchanged.

The initial verifier incorrectly required the REST success envelope inside MCP's tool payload. Retained responses passed the corrected schema check; the searches were not replayed. The immediate account balance lagged the ledger by one credit and reconciled on a read-only poll.

An early image packaging attempt started before source-copy completion and recorded the prior deployment marker. It was never selected or run. The selected image was packaged only after asserting the verified implementation commit. The retrieval schema adds only the search reservation kind; existing rows and data remain intact.

Rollback (documented, NOT_RUN): set `searching.defaultSearch` to `null`, refresh the budget-policy hash in the version lock, commit and deploy, and recreate only retrieval. This returns search to the existing Yahoo path while retaining the current image, expanded schema constraint, and all reservation history. No database or queue data deletion is required.

`ORCHESTRATION.html` was realigned to both canonical documents: primary Serper search, Yahoo fallback, finite credits and measured live status. Runnable milestone ordering and layout are unchanged.

Commits:

- `dacb577` — feat(search): use Serper Google results within existing credits
- `b19a676` — build(search): pin the Serper retrieval image

Receipts: `verification.json`, `fixtures.json`, `snapshot-attribution.json`, `raw/`, and `review/REVIEW.md`. Historical M5/M9 acceptance records are unchanged; this is additive post-M9 verification.
