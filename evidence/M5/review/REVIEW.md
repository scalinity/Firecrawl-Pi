# M5 review — /review-2 report of record

Milestone M5 (search, structured extraction and documents), reviewed as the diff `10cdc59..b81d847` under CLAUDE.md §5. Two read-only agents ran in parallel, both on **Opus 5.5** (the Agent tool's `opus` alias): DB1, a debugger, and CA1, a code auditor. The session's tool set had no team tools, so the two agents were spawned directly with the Agent tool and reported to the orchestrating session. The orchestrator merged their reports below. Outcomes are recorded under **Outcomes**, and findings made during M5 outside the review are listed under **Found during M5, outside the review**.

## Code Review: M5 — search, structured extraction and documents (services/retrieval, services/access, services/mcp, patches 0007–0008, deploy/, scripts/m5)

### Summary
69 files (5,660 inserted lines) were reviewed by 2 specialist agents (1 debugger and 1 code auditor, both on Opus 5.5). Neither found a defect that meets the Critical bar. Every route to unauthorised spend they traced is closed today, because `PI_PAID_DISPATCH_ENABLED=false` and every paid cap is 0. They did find 15 warnings and 14 suggestions, concentrated at the edges of the budget ledger, in the parser's settlement, in the gateway's extraction buffering and in the resumption of extraction jobs. These must be closed before paid dispatch is ever switched on.

**Scope:**
- **Reviewed:**
  - Tier 1, in full (the diff plus context): `services/retrieval/src/{budget,store,extract,provider,parse,search,jsonschema,server,policy,proxy,acquire}.mjs`, `deploy/nuq-postgres/fcpi-{retrieval,platform}-schema.sql`, `patches/0007-typed-search-failures.patch`, `patches/0008-document-policy-and-parser-fallback.patch`, `services/access/server.mjs`, `services/access/src/{extract,extractor,store,validate,config,archive}.mjs`, `services/mcp/src/tools.mjs`, `deploy/policies/{budget,capabilities,egress}.json`, `deploy/compose.yaml`, `deploy/searxng/*`, `deploy/secrets.template`, `scripts/m5/pi-{selection,provider-key,init-m5}.sh`, `scripts/m3/pi-client-token.sh`, `services/retrieval/Dockerfile`.
  - Tier 2, skimmed for shape changes: the M5 unit tests, `tests/fixtures/m5/{providers,server}.mjs`, `scripts/m5/e2e.mjs`, `scripts/m5/verify.mjs`, and the other `scripts/m5` collectors.
- **Acknowledged, content not reviewed (Tier 3):** `tests/fixtures/m5/documents.mjs`, `patches/series.json`, `docs/*.md` and `ORCHESTRATION.html`.
- **Confidence:** high on Tier 1. False negatives are possible in Tier 2.
- **Out of scope:** M6 and later work (proxies, enhanced providers, backups).
- **Not run by the reviewers:** the test suite, linters, the type checker and the build. This was a read-only review.

### 🔴 Critical Issues (Must Fix)
None.

### 🟡 Warnings (Should Fix)

**Introduced in this changeset:**

1. **W1 — The parser can bill more pages than were reserved, and the settlement hides it** - `services/retrieval/src/parse.mjs:98,151` _(corroborated: both agents)_
   - Problem: The reservation is `pages × creditsPerPage`, where `pages` is the core's native page count (`x-fcpi-pages`). The upload tells LlamaParse `max_pages: 100`, and the settlement is clamped with `Math.min(pagesOut.length, pages)`. A PDF the provider counts as longer is billed in full but recorded at the reserved figure (CWE-682). The model path settles above its reservation and says so (`extract.mjs:149`).
   - Suggestion: Send `max_pages: pages`, settle the pages actually returned without the clamp, note any settlement above the reservation, and test it.
2. **W2 — Reservation and settlement lock the usage rows in different orders, and a failed settle leaves the reservation RESERVED** - `services/retrieval/src/store.mjs:180-181, 229-235` _(corroborated: both agents)_
   - Problem: `reserveBudget` locks day → month → `_paid_total`, while `#close` updates in the order of an unordered SELECT. Reservations are taken before the model gate, so a reserve can overlap a settle. When the settle loses the resulting deadlock (40P01), the paid answer is lost, the caller gets a 500, the row stays RESERVED for good, and every retry is refused as EXTRACTION_UNCERTAIN.
   - Suggestion: Use one deterministic order in both places (`ORDER BY period`, with `_paid_total` last), and retry once on 40P01/40001.
3. **W3 — Paid parser spend is outside the paid-total daily cap** - `services/retrieval/src/parse.mjs:61`, `deploy/policies/budget.json` (`microUsdPerCredit`) _(corroborated: both agents)_
   - Problem: The parser passes `paidTotalCap: null`, and `microUsdPerCredit` is validated but never used. Spec §28.3's "$2/day total variable cost" therefore counts models only.
   - Suggestion: Reserve the parser's credits, converted to micro-USD, against `_paid_total` in the same transaction.
4. **W4 — The gateway buffers whole pages for extraction, and an oversized body is retried until the job's deadline** - `services/access/src/extract.mjs:30,36,59,69`, `services/access/server.mjs:330`, `services/retrieval/src/server.mjs:221` _(corroborated: both agents)_
   - Problem: Each page's markdown is kept whole (up to 16 MiB, and up to 10 pages) inside the 160 MiB gateway, although the adapter cuts every document to 1 MiB. Eight or more pages of about 3 MiB pass the retrieval service's 21 MiB body cap. The socket is then destroyed, which the gateway reads as `extractor_unavailable`, and it re-sends every `pollMs` for 20 minutes before closing the job as JOB_DEADLINE_EXCEEDED.
   - Suggestion: Cut each document to the adapter's `maxDocumentBytes` at the gateway, and treat a refusal of a fully written body as final.
5. **W5 — An HTML page that contains "%PDF-" in its first KiB is handled as a PDF and fails** - `services/retrieval/src/acquire.mjs:243-247` _(corroborated: both agents; CA1 rated it a Suggestion, and the higher rating is taken)_
   - Problem: The magic bytes are matched anywhere in the first 1,024 bytes and override a declared `text/html`, so an ordinary page fails in patch 0008 as DOCUMENT_MALFORMED.
   - Suggestion: Trust the magic only at the start of the body, after an optional BOM and whitespace.
6. **W6 — Readiness reports every parser breaker as closed** - `services/retrieval/src/server.mjs:148,183` _(corroborated: both agents; DB1 rated it a Suggestion, and the higher rating is taken)_
   - Problem: `/readyz` asks the model adapter for each provider's breaker. Parser breakers live in `makeParser`, so an open LlamaParse breaker shows as `closed`, and `/internal/providers` prints `see parser` (spec §20).
   - Suggestion: Expose `breakerState` from the parser, dispatch on the provider's kind, and test it.
7. **W7 — The json scrape format spends the model budget under the `scrape` scope** - `services/access/server.mjs:312-313`, `deploy/policies/capabilities.json` _(unique to CA1's lane)_
   - Problem: `/v2/extract` requires the new `extract` scope, but `POST /v2/scrape` with a json format reaches the budgeted extraction with only `scrape` checked. A least-privilege token can therefore draw on the model budget (CWE-285).
   - Suggestion: Refuse the json format with 403 INSUFFICIENT_SCOPE without `extract`, and add a case to the e2e suite.
8. **W8 — The pi search route can still fall through upstream's catch-all to an empty result** - `patches/0007-typed-search-failures.patch:96-101,140` _(only CA1 — DB1 was in scope but didn't flag)_
   - Problem: `search()` rethrows only a `PiSearchError`. Any other error on the pi path (an unset `SEARXNG_ENDPOINT`, a TypeError in the mapping) becomes an empty 200, which is S6 again. The core's own 15 s timeout is reported as SEARCH_BACKEND_UNAVAILABLE when it should be SEARCH_TIMEOUT.
   - Suggestion: Make every error on the pi branch leave typed, and map a TimeoutError to SEARCH_TIMEOUT (504).
9. **W9 — Page content stays in the budget ledger for 90 days** - `services/retrieval/src/store.mjs:236-237,300`, `extract.mjs:149`, `parse.mjs:152` _(unique to CA1's lane)_
   - Problem: `budget_reservation.result` holds model answers and full parse markdown. Settled rows are pruned at 90 days, while the parse cache and job results expire at 7.
   - Suggestion: Clear `result` on rows settled more than 7 days ago; only a retry window needs it.
10. **W10 — A half-open breaker can wedge until restart** - `services/retrieval/src/extract.mjs:76,82,115,132`, `services/retrieval/src/parse.mjs:58,61,100,104-107` _(unique to DB1's lane)_
    - Problem: `admit()` sets `probing`, and several exits never record a verdict: `reserveBudget` throwing, a non-ProviderError from the request, `releaseBudget` throwing, and an upload answered 200 with no job id. After any of them, every call is PROVIDER_UNAVAILABLE until the process restarts.
    - Suggestion: Record a neutral verdict in a `finally` when none was recorded, and fail the missing-job-id path.
11. **W11 — A 2xx other than 200, or a gateway-class 5xx, releases a reservation for work that may have been billed** - `services/retrieval/src/parse.mjs:87-94,101`, `services/retrieval/src/extract.mjs:129-137` _(unique to DB1's lane)_
    - Problem: Spec §28.3 releases only reservations that were demonstrably unused. A 201/202 upload has created a job, and a 502/504 after the body was delivered may have run the work, yet both are released.
    - Suggestion: Accept any 2xx upload, mark 500/502/503/504 after delivery as uncertain, and keep releasing on the 4xx refusals.
12. **W12 — A retried PARSE_EMPTY comes back as empty success** - `services/retrieval/src/parse.mjs:65,152-155` _(unique to DB1's lane)_
    - Problem: The first call settles `markdown: ""`, then throws PARSE_EMPTY. A retry under the same logical id reuses the settled row and returns `ok: true` with empty text, so a scan becomes an empty document and a complex layout loses its native text.
    - Suggestion: Apply the same empty check on the reuse path.
13. **W13 — A resumed extraction job can fail for good after money was spent** - `services/access/src/extract.mjs:57-58,71-78`, `services/retrieval/src/extract.mjs:84-91` _(unique to DB1's lane)_
    - Problem: (a) Scrape failures are not recorded, so a resumed job may scrape a different document set. Its request hash then changes, and every settled call key is refused as LOGICAL_ID_CONFLICT. (b) A retry that lands while the first call is still in flight meets a RESERVED row and gets EXTRACTION_UNCERTAIN. In both cases the runner closes the job FAILED on any non-ok answer, ignoring `retryable`.
    - Suggestion: Freeze the document set before the first extractor call, and give an in-flight reservation a retryable class that keeps the job RUNNING.
14. **W14 — A json-format scrape can time out at the gateway just after the retrieval service has spent** - `services/access/server.mjs:334-339`, `services/retrieval/src/extract.mjs:47-53,112,279` _(unique to DB1's lane)_
    - Problem: The gateway's timeout equals the deadline it sends. The adapter can still send after that deadline: the provider timeout has a 1 s floor, the repair call has no deadline check, and the gate checks the deadline only while it is busy. The client then gets 503 for a paid extraction, and a retry pays again.
    - Suggestion: Give the gateway a margin over the deadline it sends, and refuse to start any call past the deadline.
15. **W15 — Test gaps on critical paths** - `services/access/server.mjs:322-354`, `services/retrieval/test/m5-helpers.mjs`, `deploy/nuq-postgres/fcpi-platform-schema.sql:99-105` _(unique to CA1's lane)_
    - Problem: None of the following has a test: the gateway's json scrape (status passthrough, retry-after, dropped markdown, unreachable extractor); a parse settling above its reservation; the parser breaker in readiness; the ledger's v1→v2 migration; or reserve and settle running concurrently on PostgreSQL.
    - Suggestion: Add them with the fixes above.

### 🔵 Suggestions (Consider)

**Introduced in this changeset:**

1. **S1 — The parse cache is not really keyed by owner** - `patches/0008-document-policy-and-parser-fallback.patch:144`, `services/retrieval/src/parse.mjs:51` _(unique to CA1's lane)_
   - Current: `x-fcpi-owner` is upstream's `teamId`, and upstream runs every client as one team.
   - Better: Carry the gateway principal through, or state that the cache is shared per deployment.
2. **S2 — The parse reuse path does not compare request hashes** - `services/retrieval/src/parse.mjs:63-66` _(unique to CA1's lane)_
   - Current: A SETTLED row is reused without checking its `request_hash`.
   - Better: Mirror the model adapter's LOGICAL_ID_CONFLICT check.
3. **S3 — Inherited property names get past the answer validator** - `services/retrieval/src/jsonschema.mjs:47,118`, `services/retrieval/src/extract.mjs:203` _(corroborated: both agents)_
   - Current: `k in s.properties` walks the prototype chain, and the name regex admits `__proto__`.
   - Better: Use `Object.hasOwn`, and refuse `__proto__`.
4. **S4 — Re-reserving deletes the earlier RELEASED row** - `services/retrieval/src/store.mjs:188` _(unique to CA1's lane)_
   - Current: The released attempt's `detail` is lost.
   - Better: Keep the row under a suffixed call key.
5. **S5 — The standing search-proxy session's refusal list grows without bound** - `services/retrieval/src/proxy.mjs:31-34,54,59` _(corroborated: both agents)_
   - Current: Only `counters()` trims `denied`, and nothing calls it.
   - Better: Cap the list in `refuse`.
6. **S6 — `die` is used before it is defined** - `scripts/m3/pi-client-token.sh:19-20` _(unique to CA1's lane)_
   - Current: When the regex check fails, the result is "command not found".
   - Better: Define `die()` first.
7. **S7 — The parse path holds three copies of a large PDF** - `services/retrieval/src/server.mjs:195`, `services/retrieval/src/parse.mjs:21-30` _(unique to CA1's lane)_
   - Current: A 25 MiB PDF costs about 75 MiB transient.
   - Better: Build the multipart body from its parts without one more concatenation.
8. **S8 — A 429 does not stop the extraction's later units** - `services/retrieval/src/extract.mjs:32-33` _(unique to CA1's lane)_
   - Current: Later chunks keep calling the provider until the breaker opens.
   - Better: Add PROVIDER_RATE_LIMITED to STOPPING.
9. **S9 — A json scrape reports partial unit failures as full success** - `services/access/server.mjs:340-348` _(unique to DB1's lane)_
   - Current: Values from failed chunks look absent.
   - Better: Add a warning for each failed unit, and return `units`.
10. **S10 — Wrong failure classes for a missing page header or an oversized body** - `services/retrieval/src/server.mjs:195-196` _(unique to DB1's lane)_
    - Current: A missing header is reported as DOCUMENT_TOO_MANY_PAGES ("0 pages"), and an overflow as INVALID_REQUEST.
    - Better: Report INVALID_REQUEST and DOCUMENT_TOO_LARGE respectively.
11. **S11 — `requestHash` does not cover the chunking parameters** - `services/retrieval/src/extract.mjs:251` _(unique to DB1's lane)_
    - Current: A changed `maxInputTokens` reuses answers from different chunk boundaries.
    - Better: Hash `maxInputTokens` and the instruction text's version.
12. **S12 — An overdue resumed job discards a completed, paid extraction** - `services/access/src/extract.mjs:46-50` _(unique to DB1's lane)_
    - Current: A resume past the deadline fails without asking for the stored answers.
    - Better: Make one reuse-only call before failing.
13. **S13 — `pi-selection.sh` reports failure for a no-op change** - `scripts/m5/pi-selection.sh:22-37` _(unique to DB1's lane)_
    - Current: An identical file is rewritten, and the script waits 75 s for a log line that never comes.
    - Better: Report "unchanged" without waiting.
14. **S14 — Engines that SearXNG skips count as answered** - `services/retrieval/src/search.mjs:84-86` _(unique to DB1's lane)_
    - Current: With `pageno > 1`, an engine without paging is not queried, yet it counts as answered, so the result can be a false "true empty".
    - Better: Accept only page 1, which is all the core sends.

### ✅ Good Practices
- A reservation is one transaction of conditional `UPDATE … WHERE reserved + settled + $amount <= cap` statements. A call-key race falls back to reading the winning row, and the race is tested against real PostgreSQL.
- The refusals run in order (allowlist → rate card in effect → paid switch → credential → breaker), all before any reservation. An unknown price or an ended rate card fails closed, and the budget policy refuses unknown keys and overlapping cards at startup.
- The provider client never follows redirects and pins the resolved address. It tells "sent" from "not sent" by the socket's connect event, so a reservation is released only when the request demonstrably never left.
- The client cannot choose the model or the search engines: the host selection chooses among what the policies list.
- Search logs only a query hash, caches only complete answers, and keeps its four outcomes typed end to end.
- The strict-schema conversion makes every property nullable and judges "required" on the merged result, so no value is invented to fill a gap in one chunk.
- Extraction jobs stay out of the core's upstream slot and the runner's queries, and their status goes through the principal-and-kind check.

### Verdict
[ ] ❌ Request Changes (critical issues)
[x] ⚠️ Approve with Suggestions
[ ] ✅ Approve

## Carried from earlier reviews

| ID | Finding | Outcome | Commits |
|---|---|---|---|
| M2 S6 | Search failures look like empty results (patch 0005 returned [] when the search backend failed) | Fixed: patch 0007 carries a typed PiSearchError through searxng_search, search() and the controller, and the retrieval service tells results, a true empty answer, a partial answer and each failure apart before the core sees them; W8 closed the last path to an empty result. Proven against the real SearXNG by S01 (REST) and S02 (MCP): 200 with web [] for a true empty answer, 502 SEARCH_ENGINES_FAILED, 503 SEARCH_BACKEND_UNAVAILABLE and 504 SEARCH_TIMEOUT | `7512e2a`, `2f57361`, `88ef412`, `73ec6c6` |

## Found during M5, outside the review

1. **F1 — SearXNG crashed on the fixture engine and fetched rule lists from the Internet** - `deploy/searxng/settings.yml`
   - SearXNG's curl allowed only https, so the http fixture engine failed inside SearXNG before any request reached the search proxy. The tracker-URL plugin also fetched rule lists at start.
2. **F2 — A failed extraction answered 200 with ok false** - `services/retrieval/src/server.mjs`, `services/access/src/extract.mjs`
   - The gateway reported a paid-dispatch refusal as a 502 instead of the refusal's own 402.
3. **F3 — The selection script never saw the service apply a selection** - `scripts/m5/pi-selection.sh`
   - It passed `docker logs --since` an `@`-prefixed epoch, so every read failed and the script timed out.
4. **F4 — A stopped SearXNG was reported as a timeout, and an extraction job extracted from error pages** - `services/retrieval/src/search.mjs`, `services/access/src/extract.mjs`
   - A stopped SearXNG surfaced as SEARCH_TIMEOUT rather than SEARCH_BACKEND_UNAVAILABLE, and the job took text from pages whose target answered an error status.
5. **F5 — An unconfigured extraction service took REST down** - `services/access/src/config.mjs`
   - The gateway refused to start when extraction was enabled without `PI_EXTRACT_URL` (spec §20, AC23).
6. **F6 — M3's contract test used version 2 as "a newer ledger"** - `tests/contracts/m3-gateway.test.mjs`
   - M5's extract kind makes version 2 the current ledger.
7. **F7 — A warm parse cache kept the fixture pass from exercising the parser** - `scripts/m5/e2e.mjs`
   - The cache is keyed by bytes, so an earlier pass's parses answered the scan and complex cases with no upload.
8. **F8 — The reservation race's day cap is shared by every pass on one day** - `scripts/m5/e2e.mjs`, `scripts/m5/verify.mjs`
   - A fixed-size race left room for a single grant, which cannot show overlapping reservations. B02 also summed every day's usage.
9. **F9 — SearXNG's engine tunnels were logged only when they closed** - `services/retrieval/src/proxy.mjs`
   - SearXNG keeps its engine connections open after its last request, so the first live pass read the log before any live tunnel had closed, and S05 found no engine connection to attribute.
10. **F10 — S05 assumed a live engine returns nothing for a nonsense query** - `scripts/m5/verify.mjs`
    - Bing answered the quoted nonsense query with five loose matches, which the platform relayed as a 200 partial answer (evidence/M5/raw/e2e-live.txt).
11. **F11 — Two of the three live engines refuse the home connection** - `deploy/searxng/settings.yml`, `evidence/M5/raw/e2e-live.txt`
    - Brave answered "too many requests" and DuckDuckGo a CAPTCHA on every live query, so live search runs on Bing alone; the platform reports each such answer as partial, naming the two engines.
12. **F12 — The host rebooted during M5's window** - `evidence/M5/raw/reboot.txt`, `evidence/M5/raw/reboot-cause.txt`
    - The Pi's Wi-Fi was lost at 20:43:11Z; the owner's Wi-Fi watchdog (net-watchdog.service, enabled since before M4) bounced the Wi-Fi, then reloaded its driver, and at 20:55:12Z, still without the gateway, rebooted the host in an orderly shutdown. The gated start (data check, guard, dockerd, fcpi-stack) brought every service back; no project work ran on the Pi at the time.
13. **F13 — SearXNG's configuration left Bing disabled** - `deploy/searxng/settings.yml`
    - SearXNG ships Bing disabled and keep_only does not enable it, so S04 found two of the three live engines enabled; queries named Bing explicitly, so it was asked all the same.
14. **F14 — A synthetic test credential was assigned to a variable the redaction scan matches** - `services/retrieval/test/proxy.test.mjs`
    - S5's proxy test named its synthetic credential password, which X05's credential-assignment rule matched.

## Outcomes

| ID | Severity | Finding | Outcome | Commits |
|---|---|---|---|---|
| W1 | 🟡 | The parser can bill more pages than were reserved, and the settlement hides it | Fixed: the upload asks for the reserved pages only (max_pages = the core's count), and the settlement is the pages returned times the rate card's credits, noting any amount above the reservation; tested with a provider that parses past the limit | `d5997cd` |
| W2 | 🟡 | Reservation and settlement lock the usage rows in different orders | Fixed: one lock order (day, month, then the paid total) for reserving and settling, a settlement retried once on a lock-wait failure, and each reservation records the periods it drew on; PostgreSQL tests run twenty settlements beside twenty reservations and a settlement after the caps changed | `6a56c92` |
| W3 | 🟡 | Paid parser spend is outside the paid-total daily cap | Fixed: a paid parser reserves its credits times the rate card's micro-USD per credit against the paid total in the same transaction (reservation column paid_total_rate); PostgreSQL test | `2738096` |
| W4 | 🟡 | The gateway buffers whole pages for extraction | Fixed: the manifest gains limits.extract.maxDocumentBytes (1 MiB, the budget policy's figure); the runner archives and sends each page's markdown cut to it, the json format sends the same cut text, and each cut is named in the warnings, so no request can pass the retrieval service's body cap; tested with 3 MiB pages | `b0924ff` |
| W5 | 🟡 | An HTML page that contains %PDF- in its first KiB is handled as a PDF | Fixed: the magic settles the type at the start of the body, or within the first KiB only for a body declared a PDF or opaque; a body declared a PDF that starts as HTML is HTML; tested | `fce42bb` |
| W6 | 🟡 | Readiness reports every parser breaker as closed | Fixed: the parser exposes its breakers, and /readyz and /internal/providers read each provider's from the adapter of its kind; tested | `e699220` |
| W7 | 🟡 | The json scrape format spends the model budget under the scrape scope | Fixed: the json format needs the extract scope and scraping search results the scrape scope, both 403 INSUFFICIENT_SCOPE before any work; unit-tested, and the fixture phase checks both with controls (E01, S01) | `1f9e4dc` |
| W8 | 🟡 | The pi search route can still fall through upstream's catch-all to an empty result | Fixed in patch 0007: every other error of the pi branch becomes SEARCH_BACKEND_ERROR (502), an unset endpoint SEARCH_BACKEND_UNAVAILABLE, and the core's own timeout SEARCH_TIMEOUT (504); the API image was rebuilt from it (evidence/M5/raw/api-build.log) | `73ec6c6` |
| W9 | 🟡 | Page content stays in the budget ledger for 90 days | Fixed: pruning clears the stored answer of rows settled more than seven days ago and keeps their amounts and usage; PostgreSQL test | `e993c81` |
| W10 | 🟡 | A half-open breaker can wedge until restart | Fixed: each adapter records whether a call took the probe and hands it back in a finally when no verdict was recorded; an upload with no job id counts as a failure; tested in both adapters | `3a20c0b` |
| W11 | 🟡 | A 2xx other than 200, or a gateway-class 5xx, releases a reservation for work that may have been billed | Fixed: any 2xx upload starts its job; a 502 or 504 keeps the reservation UNCERTAIN (PROVIDER_UNCERTAIN) for the model and the parser; the provider's own refusals, 500 and 503 among them, are still released; tested | `08adacc` |
| W12 | 🟡 | A retried PARSE_EMPTY comes back as empty success | Fixed: the reuse path applies the same empty check; the test fails on the old code | `0fe0e75` |
| W13 | 🟡 | A resumed extraction job can fail for good after money was spent | Fixed: a page's failure is archived like its text, so a resume sends the same documents; the adapter answers a reservation still in flight as EXTRACTION_IN_FLIGHT (409, retryable); the runner keeps the job RUNNING on it, RETRIEVAL_NOT_READY or RETRIEVAL_ERROR, until its deadline; tested on both sides | `8d34559` |
| W14 | 🟡 | A json-format scrape can time out at the gateway just after the retrieval service has spent | Fixed: the model gate refuses a passed deadline, the adapter starts no request with less than a second left (before reserving and after waiting for the slot), and the gateway waits five seconds past the deadline it sends; tested in the adapter and the json-format module | `5ecea35`, `1f9e4dc` |
| W15 | 🟡 | Test gaps on critical paths | Fixed: the json format gained its own module and tests (scope, typed failures and Retry-After, unreachable service, core refusal, deadline margin, unit warnings); a parse settled above its reservation, the parser breaker in readiness and reserve beside settle on PostgreSQL are tested with W1, W6 and W2; a contract test proves the ledger's v1 to v2 migration; G02 requires them all on the Pi | `1f9e4dc`, `d5997cd`, `e699220`, `6a56c92`, `f498ddd`, `3afd200` |
| S1 | 🔵 | The parse cache is not really keyed by owner | Deferred to M7: its Implementation Work adds correct owner/options/freshness cache keys and it owns AC21 (docs/FIRECRAWL_PI_MILESTONES.md, M7), and carrying the gateway's principal into the core's parse request is that work; the module comment now states that the cache is shared across the deployment's one team until then | `82c94a7` |
| S2 | 🔵 | The parse reuse path does not compare request hashes | Fixed: a reused parse whose request hash differs is LOGICAL_ID_CONFLICT, as in the model adapter; tested | `390ca5a` |
| S3 | 🔵 | Inherited property names get past the answer validator | Fixed: membership is Object.hasOwn throughout and __proto__ is refused as a property name; tested with names from Object.prototype | `bb03da5` |
| S4 | 🔵 | Re-reserving deletes the earlier RELEASED row | Fixed: the released row is kept under its call key suffixed #released-<id>; PostgreSQL test | `0484839` |
| S5 | 🔵 | The standing search-proxy session's refusal list grows without bound | Fixed: a standing session keeps no refusal list (each refusal is logged by host) and the unused counters() is removed; tested through the proxy | `a93ebb4` |
| S6 | 🔵 | die is used before it is defined | Fixed: die is defined before the scope check | `3e99a6e` |
| S7 | 🔵 | The parse path holds three copies of a large PDF | Fixed: providerRequest takes a body as a list of buffers and the parser sends the multipart parts without joining them | `37e8612` |
| S8 | 🔵 | A 429 does not stop the extraction's later units | Fixed: PROVIDER_RATE_LIMITED stops the extraction; tested with two documents and one provider request | `98ddbc5` |
| S9 | 🔵 | A json scrape reports partial unit failures as full success | Fixed: each unit no answer came for is named in the page's warning and the units are returned under fcpi.extraction; tested | `1f9e4dc` |
| S10 | 🔵 | Wrong failure classes for a missing page header or an oversized body | Fixed: a missing or non-numeric x-fcpi-pages is INVALID_REQUEST and a body past the parser's limit DOCUMENT_TOO_LARGE (413) | `6a6a9d4` |
| S11 | 🔵 | requestHash does not cover the chunking parameters | Fixed: the request hash includes the input-token cap and the instruction text's hash; a retry under a changed cap is LOGICAL_ID_CONFLICT; tested | `09a26a6` |
| S12 | 🔵 | An overdue resumed job discards a completed, paid extraction | Fixed: when every page's outcome is archived, a job past its deadline makes one reuseOnly call that returns stored answers and sends nothing new; tested on both sides | `ba1fea1` |
| S13 | 🔵 | pi-selection.sh reports failure for a no-op change | Fixed: a selection the file already holds is reported unchanged at once | `a4128ca` |
| S14 | 🔵 | Engines that SearXNG skips count as answered | Fixed: the search route serves page 1 only, all the core asks for; tested | `5897a1d` |
| F1 | — | SearXNG crashed on the fixture engine and fetched rule lists from the Internet | Fixed: plain http enabled for the fixture engine alone, and the tracker-URL plugin disabled | `dbe3e71` |
| F2 | — | A failed extraction answered 200 with ok false | Fixed: an extraction no unit of which succeeded answers with its failure class's status (402 for the paid-dispatch switch) | `ada91ce` |
| F3 | — | The selection script never saw the service apply a selection | Fixed: docker logs --since gets a plain epoch | `d33c1e2` |
| F4 | — | A stopped SearXNG was reported as a timeout, and an extraction job extracted from error pages | Fixed: no connection within 2 s is SEARCH_BACKEND_UNAVAILABLE, and a page whose target answered an error is a named failure (TARGET_HTTP_<n>) | `88ef412` |
| F5 | — | An unconfigured extraction service took REST down | Fixed: the gateway starts without PI_EXTRACT_URL, and the json format and extraction answer 503 EXTRACTION_UNAVAILABLE | `542a115` |
| F6 | — | M3's contract test used version 2 as a newer ledger | Fixed: the test writes version 3 and expects the build's 2 | `b16e7df` |
| F7 | — | A warm parse cache kept the fixture pass from exercising the parser | Fixed: the fixture phase deletes the fixture parser's own cache rows first and records the count; D02 requires it | `624af16` |
| F8 | — | The reservation race's day cap is shared by every pass on one day | Fixed: the race's document is sized from the day cap left, and B02 sums only the day the race ran in | `b81d847` |
| F9 | — | SearXNG's engine tunnels were logged only when they closed | Fixed: a standing session's tunnel is logged when it opens and again with its byte counts when it closes | `d86ea00` |
| F10 | — | S05 assumed a live engine returns nothing for a nonsense query | Fixed: S05 requires the nonsense query to be answered 200 or with a typed failure and every partial answer to name the engines that did not answer, and reports the query's result count; the true empty answer is proven against the real SearXNG with the fixture engine (S01, S02) | `248c927` |
| F11 | — | Two of the three live engines refuse the home connection | Deferred to M6: its Scope supplies the residential proxy adapter, proxy-first routing and anti-bot failure classification, and routing search-engine traffic that a target rate-limits or challenges on the home IP is that work; M5's platform already reports such an answer as partial and names the engines, and its search still answers from Bing |  |
| F12 | — | The host rebooted during M5's window | Rejected, with the evidence that it is not a project defect: the previous boot's journal shows the owner's net-watchdog.service ordering the reboot after its third recovery (raw/reboot-cause.txt, redacted) and an orderly shutdown, and raw/reboot.txt ties the BEFORE and AFTER snapshots to the two boots; the gated start restored the stack, and X04 attributes the reboot's own six changes under that tie | `0165ae0` |
| F13 | — | SearXNG's configuration left Bing disabled | Fixed: the settings enable Bing, and S04 checks all three live engines enabled | `f3e5aeb` |
| F14 | — | A synthetic test credential was assigned to a variable the redaction scan matches | Fixed: the variable is renamed, and the scan's rule is left strict | `9b5c5f4` |
