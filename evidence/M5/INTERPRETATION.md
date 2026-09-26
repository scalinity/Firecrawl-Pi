# M5 interpretation — search, structured extraction and documents

**Evidence window.** It runs from 2026-09-26 18:35:06Z (BEFORE snapshot) to 22:11:40Z (AFTER snapshot), across one reboot at 20:55Z that the host's own Wi-Fi watchdog ordered (section 8). The final evidence ran on the boot after it, inside one guard-counter window from 22:03:32Z to 22:11:04Z, with the guard's table the same (handle 12) at both ends:

- the fixture phase, 22:03:32Z to 22:07:21Z;
- the live phase, 22:07:22Z to 22:07:57Z.

**What ran.** The stack ran the code deployed at `8903e1e`:

- the patched API image `4ae6468f`, built from `73ec6c6` with patch series `33c9333a`;
- the retrieval, gateway and MCP images built on the Pi from `0165ae0`;
- SearXNG `2026.9.25-12f8b6515` at arm64 digest `d9ca82c1`.

**Artifacts.**

- **Checks:** `verification.json`, written by `scripts/m5/verify.mjs`: 31 checks, each recomputed from the raw transcripts in `raw/`. Every record shows `code_dirty=false`. Fixture and live results are separate checks (`evidence_class`):
  - the live checks are S05 (search), E05 (model) and D03 (parser);
  - the fixture evidence is `raw/e2e-fixture.txt`, the live evidence `raw/e2e-live.txt`.
- **Lockfile:** `deploy/versions.lock.json`, resolved from this evidence by `scripts/m5/build-lock.mjs`. It holds SearXNG's digest and settings, the API image and patch series, the three service images, the budget policy (`2530424b`) with its six versioned rate cards, and the capability manifest (`96c27667`).
- **Review:** `review/REVIEW.md`, the `/review-2` report of record (two agents, both on Opus 5.5):
  - of its 29 findings, 28 are fixed with their commits and 1 is deferred to M7;
  - M2's carried S6 is fixed;
  - 14 more found during M5 are recorded as F1–F14, each with an outcome.
- **BEFORE/AFTER:** `snapshot-before.txt`, `snapshot-after.txt` and the attributed diff `snapshot-diff.txt`, written by X04.
- **Redaction:** X05's 23 rules fire on their controls. It then compares the SHA-256 of 27 live secrets (15 of them client token files on the Pi; the Pi holds no provider key) against 638 tracked and new files, with 0 findings. The Pi's LAN address, SSH target, gateway address and Wi-Fi network appear only as placeholders.

**State: IMPLEMENTED_PENDING_LIVE.**

- **What passed:** 29 checks pass on the final window. Among them, S05 is live: a live SearXNG query through REST and MCP, with engine traffic leaving only through the guarded search proxy.
- **What remains:** E05 (the live model) and D03 (the live parser) are `BLOCKED_CREDENTIAL`. The Pi holds no provider key, paid dispatch is off, and every paid cap is zero. M5's acceptance criteria require live evidence for extraction and documents, so M5 is not accepted.
- **What clears it:** the owner's model and LlamaParse credentials and an approved budget (the milestones document's blocker register, M5).

## 1. Search, and how its failure is typed (M2's S6)

- **SearXNG runs private and has no route of its own.**
  - The container is on the internal network `fcpi_search`, whose only other member is the retrieval service.
  - Its outgoing proxy is the retrieval service's search proxy, a standing session with its own credential. That proxy lets requests through by the host's selection: only the fixture engines' host while it is `fixture`, only the live engines' hosts (policy `search.engineHosts.live`) while it is `live`.
  - Engine traffic therefore passes the same SSRF, Cloud-denylist and counting rules as every other acquisition (spec §13), and nothing leaves the home connection for a host outside that allowlist.
  - S04 shows the posture: no default route, three public hosts refused, and the proxy answering 407 without its credential as the positive control.
- **SearXNG's own settings.** JSON output only (HTML answers 403), one worker and no limiter. The engine set is DuckDuckGo, Bing and Brave, plus two fixture engines.
- **Native on this kernel.** Every one of SearXNG's 93 AArch64 ELF objects has LOAD segments aligned to at least the 16 KiB page (S04).
- **Four outcomes reach the caller, never an empty list for a failure.** The retrieval service tells them apart before the core sees an answer, and patch 0007 carries a typed failure through upstream's search code to the controller:
  - results (200);
  - a true empty answer (200, `web: []`);
  - a partial answer (200 with a warning naming each engine that did not answer);
  - a failure: SEARCH_ENGINES_FAILED 502, SEARCH_BACKEND_UNAVAILABLE 503 (a backend that accepts no connection within 2 s), or SEARCH_TIMEOUT 504 (one that connects and stalls past the 10 s deadline).
- **Proof against the real SearXNG.** S01 (REST) and S02 (MCP) prove the outcomes with controlled engine answers, and M01 shows map still working with SearXNG stopped. W8 closed the last path by which an unexpected error on the pi branch could fall through to upstream's catch-all.
- **Limits and cache.** Search is capped at 60 backend queries an hour. Complete answers are cached for 15 minutes; partial and failed answers never are. Queries are logged only as a hash (S03). Only page 1 is served (S14).
- **Live (S05).** Every live query came back partial:
  - Brave answered "too many requests" and DuckDuckGo a CAPTCHA, so live results came from Bing (F11). The platform reported each such answer as partial, naming both engines. Routing search traffic that a target refuses on the home IP is M6's work.
  - A quoted nonsense query also drew five loose matches from Bing, so a live true-empty answer was not observed. That outcome is proven against the fixture engine instead (F10).
  - The guard accepted three web connections in the window, matching the three engine tunnels the proxy logged (X01).

## 2. Model forwarding and accounting

- **The adapter replaces Firecrawl's native model paths.** No native Firecrawl model path is enabled. The `json` format and `/v2/extract` are served by the retrieval service's budgeted adapter, which the gateway reaches over its own internal network with its own credential (section 9).
- **Refusals first, before any reservation:**
  1. allowlist;
  2. a rate card in effect;
  3. the paid switch;
  4. the credential;
  5. the provider's breaker.
- **Reserve before dispatch, settle from measured usage.** The call's maximum cost is reserved atomically before the one active model request, and the call is settled from the provider's own usage counts at the rate card's price (E01: 12 settled fixture calls, each priced by its card). A request that never left is released. One sent with no answer stays reserved whole as UNCERTAIN and is never sent again (E04).
- **What changes the outcome after the review:** a 502 or 504 from a proxy in front of the provider now also keeps the reservation (W11), and no request starts with less than a second of its deadline left (W14).
- **Retries and repair share one logical budget.** A call key names each call inside its logical unit, so a retry reuses a settled answer and never re-sends an unaccounted one. A unit still in flight is EXTRACTION_IN_FLIGHT, retryable (W13).

## 3. Extraction

- **One strict call per chunk.** The caller's schema is checked against a bounded subset (no `$ref`, E03). Each document is split into chunks under the input-token cap, with its URL kept. Each chunk gets one strict Structured Outputs call and at most one repair (E01: exactly two calls for an invalid first answer; 502 EXTRACTION_INVALID_OUTPUT when the repair is still invalid).
- **Merge without inventing.** Answers merge with each value's source URLs. A value the page does not hold stays null, and a required one nobody held is named, never invented.
- **`/v2/extract` is a durable gateway job over explicit URLs** (E02): idempotent, owner-scoped, PARTIAL when a page fails (TARGET_HTTP_404), and chunked across two or more units for a long page.
  - A page's outcome, text or failure, is archived as it lands, so a resumed job sends the same documents (W13).
  - Each page's markdown is cut to the adapter's 1 MiB limit at the gateway (W4).
  - A job resumed past its deadline makes one call that only reuses stored answers (S12).
- **Scopes.** The json format needs the `extract` scope, and scraping search results needs `scrape` (W7).

## 4. Documents and the parser fallback

- **Native first.** A text PDF and a DOCX parse with no provider (D01). The type comes from the bytes: a PDF served as HTML is read as a PDF, and an HTML page served as a PDF as HTML. Only a body that starts with the magic, or one declared a PDF, counts as a PDF (W5).
- **Typed failures, never empty success.** Encrypted, malformed, 26 MiB and 101-page PDFs each fail with their own class.
- **The fallback.** A scan-only or complex-layout PDF goes to the LlamaParse-compatible adapter (D02):
  - it reserves pages × 3 credits before the upload, holds the provider to those pages, and settles at the pages returned (W1);
  - a second parse of the same bytes is a cache hit with no upload;
  - each finished job's upload is deleted.
- **Without a parser credential.** A scan is PARSER_REQUIRED, and a complex layout keeps its native text (B01, D02).
- **The cache is shared per deployment.** Its owner key is the core's one team; per-principal cache keys are M7's work (S1).

## 5. Provider isolation

- **Acquisition carries on without the providers.** With SearXNG stopped, the paid model refused and the parser unconfigured, a static scrape, a native PDF, a four-page crawl and a map all succeed. A scrape also succeeds while the model's breaker is open (I01).
- **Each provider reports its own state.** Readiness reports each provider's breaker from its own adapter, the parser's included (W6), and folds none of them into acquisition's `ok`. A half-open breaker that ends without a verdict hands its probe back (W10).
- **Memory.** Every service stayed within its cap: the core peaked at 80% of its cap and SearXNG at 32%, with MemAvailable never below 5,115 MiB (M02).

## 6. Budgets and reservations

- **Caps and switches.** Every paid cap in `deploy/policies/budget.json` is zero, and `PI_PAID_DISPATCH_ENABLED=false`. With the production selection, the json format is 402 PAID_DISPATCH_DISABLED with no provider request (B01).
- **Concurrency.** Eight concurrent extractions on the `fixture_race` category are granted exactly the floor of what was left over their equal reservation: 3 granted, 5 BUDGET_EXHAUSTED. Their reservations overlap in time, and the settled total afterwards equals the one before plus the granted calls' actual costs (B02).
- **Lock order.** Reservation and settlement take the usage rows in one order, so they cannot deadlock (W2).
- **The paid total.** A paid parser's credits count against the paid total's day in micro-USD (W3).
- **Rate cards.** Every card is versioned with an effective date and a source: GPT-4.1 Mini at 0.40/0.10/1.60 USD per million tokens, and LlamaParse cost-effective at 3 credits a page. A card that has ended is RATE_CARD_MISSING, and an unlisted model MODEL_NOT_ALLOWED (B03, E03).

## 7. Zero Cloud attempts and host posture

- **No Cloud.** Across the window, the guard accepted no web connection during the fixture phase, and during the live phase only the three the engine tunnels account for. The core's 22 saved logs classify every Cloud line, the retrieval log names no Cloud host, and each driver's sockets went only to the forward (X01).
- **Networks and containers.** The two new networks are internal with exactly two members each. The only host publication is still 127.0.0.1:3380. All 13 containers run aarch64 with swap limit 0 (X02).
- **Unrelated state.** Of the 106 lines that differ between the BEFORE and AFTER snapshots, none remains unexplained (X04).

## 8. The reboot

**What happened.** At 20:43:11Z the Pi lost its Wi-Fi, its only uplink. The owner's Wi-Fi watchdog (`net-watchdog.service`, enabled since before M4) then worked through its recovery steps:

- it bounced the Wi-Fi;
- it reloaded the Wi-Fi driver;
- at 20:55:12Z, the gateway still unreachable, it rebooted the host through logind (`raw/reboot-cause.txt`, redacted).

**The shutdown and the restart.** The shutdown was orderly (95 shutdown markers, `raw/reboot.txt`). No project work ran on the Pi at the time, and the log shows no local command after the loss. The gated start (the data check, the guard, dockerd, fcpi-stack) brought every service back healthy.

**How the evidence accounts for it.** `raw/reboot.txt` ties the BEFORE snapshot to the earlier boot and the AFTER snapshot to the current one. X04 attributes the reboot's own six changes under that tie, as M4's X04 does: two services' ephemeral UDP ports, each chosen again, and one automount made again. Every piece of evidence the checks read was collected after the reboot (F12).

## 9. Deferred findings and deviations

**Deferred:**

- S1 (the parse cache's owner key) goes to M7, whose Implementation Work adds owner/options/freshness cache keys (AC21).
- F11 (two live engines refuse the home connection) goes to M6, whose residential-proxy routing owns it.
- Nothing is deferred to M5 from earlier reviews beyond M2's S6, which is fixed.

**Canonical change.** Extraction is a project-owned adapter, because the evidence forced it (commit `779b743`, spec §14 and the M5 Implementation Work):

- the pinned `json` scrape can make up to nine paid calls;
- the explicit-URL `/v2/extract` makes 2N+2 calls and abandons requests at a 45-second race;
- several call sites name Vertex, Groq and Google.

None of that can be held to one repair inside one logical budget.

**Other deviations:**

- **SearXNG's tag.** It was re-resolved from M0's candidate to the newest tag when M5 began, and its native proof ran on that digest.
- **S05's live nonsense query.** It no longer requires zero results, because a live engine answers loosely. The outcome and its result count are reported, and the true empty answer is proven with the fixture engine (F10).
