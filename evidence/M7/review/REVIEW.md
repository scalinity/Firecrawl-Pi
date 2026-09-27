# M7 review — /review-2 report of record

Milestone M7 (enhanced retrieval and practical Cloud-gap closure), reviewed as the diff `0318b6e..5684565` under CLAUDE.md §5. Two read-only agents ran in parallel, both on **Opus 5.5** (the Agent tool's `opus` alias): DB1, a debugger, and CA1, a code auditor. The session's tool set had no team tools, so the two agents were spawned directly with the Agent tool and reported to the orchestrating session. The orchestrator merged their reports below. Outcomes are recorded under **Outcomes**, findings made during M7 outside the review are listed under **Found during M7, outside the review**, and the finding an earlier review deferred to M7 under **Carried from earlier reviews**.

## Code Review: M7 — enhanced retrieval, browser extras, artifacts, cache, change detection and webhooks (services/retrieval, services/browser, services/access, services/mcp, patch 0010, deploy/, scripts/m7)

### Summary
Two specialist agents reviewed 68 files (4,693 inserted lines): one debugger and one code auditor, both on Opus 5.5. Neither found a critical defect. Both traced one keyed enhanced dispatch per page, UNCERTAIN charges that are never resent, the outbox raised inside `move()`, owner-scoped caches and artifacts, and a webhook allowlist that resolves the name and connects to that address. The warnings cluster on four things:
- a spend limit on the residential route that falls through to the enhanced provider;
- a json scrape that bypasses the extras path (corroborated by both agents);
- the reuse and accounting of a kept or uncertain enhanced answer;
- memory multipliers on buffered paths inside small cgroups.

**Scope:**
- **Reviewed:**
  - Tier 1, in full (the diff plus context): `services/retrieval/src/{enhanced,acquire,budget,webhook,server,parse,policy,route,browser}.mjs`, `services/browser/src/server.mjs`, `services/access/server.mjs`, `services/access/src/{artifacts,changes,outbox,store,auth,validate,upstream,jobs}.mjs`, `patches/0010-enhanced-route-browser-extras-and-owner.patch`, `deploy/nuq-postgres/{fcpi-platform-schema,fcpi-retrieval-schema}.sql`, `deploy/policies/budget.json`, and for CA1 `deploy/policies/{capabilities,egress}.json` and `deploy/compose.yaml`.
  - Tier 2, skimmed for shape changes: `services/access/src/{config,extract,extractor,jsonscrape}.mjs`, `services/mcp/src/tools.mjs`, `deploy/compose.webhooks-suppressed.yaml`, `tests/fixtures/m7/{fixture,server}.mjs`, `scripts/m7/{e2e,verify}.mjs`, and the M7 retrieval, gateway and contract tests.
- **Acknowledged, content not reviewed (Tier 3):** `scripts/m7/*.sh`, `scripts/m7/build-lock.mjs`, `scripts/m5/pi-selection.sh`, `services/*/package.json`, `deploy/browser/Dockerfile`, `deploy/secrets.template`, `patches/series.json`.
- **Confidence:** high on Tier 1. False negatives are possible in Tier 2.
- **Out of scope:** M4 F1/F2 (owned by M8), the absent live Zyte credential, evidence files.
- **Not run by the reviewers:** the test suite, linters, the type checker and the build. This was a read-only review.

### 🔴 Critical Issues (Must Fix)

None.

### 🟡 Warnings (Should Fix)

**Introduced in this changeset:**

1. **W1 — A spent residential budget falls through to the enhanced provider** - `services/retrieval/src/acquire.mjs:549-566` _(only CA1 — DB1 was in scope but didn't flag)_
   - Problem: After a direct challenge on an `auto` page, a residential route that is unavailable for any reason, `BUDGET_EXHAUSTED` included, escalates to the enhanced dispatch. Spec §9.2 says a spend limit is a controlled resource failure with "no implicit higher-cost fallback", and CLAUDE.md §11 says never switch automatically to another paid provider. The route being absent by configuration is a legitimately skipped stage; a spend or health limit is not. This is latent while every paid cap is zero.
   - Suggestion: Let only "not configured" reasons fall through, and fail as PROXY_REQUIRED otherwise. Add a waterfall test with residential at BUDGET_EXHAUSTED and enhanced available that asserts no enhanced reservation is made.
2. **W2 — A scrape that asks for json with a screenshot or actions bypasses the extras path** - `services/access/server.mjs:367`, `services/access/src/jsonscrape.mjs:13-19` _(corroborated: both agents)_
   - Problem: `sync()` sends any scrape with a json format to `scrapeWithJson` before it checks for extras. The object-form screenshot format is filtered out, so it is silently dropped (spec §9.4). `actions` survive in `...body`, so their captures come back as inline data URLs that are never stored as owner-bound artifacts and never counted against `limits.extras.inFlight`. Above 16 MiB the path answers 502. Independently flagged by both reviewers.
   - Suggestion: Compute `extras` before the json branch and refuse the combination as 400 UNSUPPORTED_OPTION (`option: "formats.json"`), and state it in the manifest. Add a gateway test.
3. **W3 — A settled, kept enhanced answer is not reused once the cap is spent, and an auto retry rarely reaches it** - `services/retrieval/src/enhanced.mjs:109-110`, `services/retrieval/src/acquire.mjs:301-305,559-563` _(unique to DB1's lane)_
   - Problem: `availability()` runs before `reserveBudget()`, where the reuse lives. It asks whether there is room for a whole new request, so the page's own settled charge can refuse its reuse as BUDGET_EXHAUSTED, as can a breaker opened since or paid dispatch switched off. On `auto`, a retry walks the waterfall from `direct_http` again, spends its fourth attempt on the target, and gets ATTEMPT_BUDGET_EXHAUSTED without the paid answer.
   - Suggestion: Look the page's reservation up first. In `dispatch()`, a SETTLED row with an answer is returned before any availability check. In `acquire()`, a page with a kept answer goes straight to the enhanced step. Add a test at the small cap.
4. **W4 — An UNCERTAIN enhanced charge is logged as NOT_CHARGED with zero cost** - `services/retrieval/src/enhanced.mjs:153,163`, `services/retrieval/src/acquire.mjs:250-259` _(unique to DB1's lane)_
   - Problem: The ENHANCED_UNCERTAIN returns carry no `charge`. The acquisition record therefore logs `enhanced_state: "NOT_CHARGED"` and leaves the reservation out of its cost, though the ledger keeps it (spec §24).
   - Suggestion: Return `charge: { state: "UNCERTAIN", reserved, actual: null }` at both sites.
5. **W5 — `/platform/v1/changes` fails with a retryable 503 on a page whose markdown is empty** - `services/access/src/changes.mjs:78-81` _(unique to DB1's lane)_
   - Problem: `""` passes the null guard, a zero-byte version violates `CHECK (bytes > 0)`, and the generic catch answers 503 with `retry-after`. A deterministic failure is reported as transient, and each retry is a new scrape (a new paid dispatch under `proxy: "enhanced"`).
   - Suggestion: Answer 422 NOT_COMPARED for empty normalized content.
6. **W6 — Navigations triggered by a click bypass per-domain pacing and the direct caps** - `services/browser/src/server.mjs:123-131` _(unique to DB1's lane)_
   - Problem: The retrieval service paces and counts one navigation per browser attempt. A same-host click that loads a new document leaves on the home connection with no pacing decision and no `direct_nav` row. With ten actions, that can be ten unpaced navigations.
   - Suggestion: Count main-frame navigations after the first in the worker, return the count, and record them against the domain.
7. **W7 — An exception between the enhanced reservation and its settlement leaves it RESERVED for good** - `services/retrieval/src/enhanced.mjs:129-187`, `services/retrieval/src/acquire.mjs:507-511` _(unique to DB1's lane)_
   - Problem: A throw from `settleBudget` or a non-ProviderError from `providerRequest` leaves the row RESERVED. It is counted against the cap and is never marked UNCERTAIN, and the attempt row stays open.
   - Suggestion: Catch after the reservation, mark a still-RESERVED row UNCERTAIN and rethrow, and finish the attempt in `enhancedStep`'s catch.
8. **W8 — MCP scrape payloads with scrape actions are never cut to the tool limit** - `services/mcp/src/tools.mjs:106` _(unique to DB1's lane)_
   - Problem: `fitDocument` cuts only top-level strings and links. `actions.scrapes[].html` can keep the payload over `toolTextMaxBytes`, which breaks the tool description's promise of a marked excerpt.
   - Suggestion: Cut `actions.scrapes[i].html`, largest first, and record each cut. Add a test.
9. **W9 — Cache hits are outside the synchronous admission limit, and each copies the document about five times** - `services/access/server.mjs:384-396` _(unique to CA1's lane)_
   - Problem: A hit reads, stringifies, parses and re-serializes up to 16 MiB without incrementing `syncInFlight`. Concurrent hits of a large page can take the 160 MiB gateway past its limit.
   - Suggestion: Count hits in `syncInFlight`. Better, send the stored bytes as they are, with cache headers.
10. **W10 — The 32 MiB extras response bound is not safe in the gateway's 160 MiB cgroup, and no fixture approaches it** - `services/access/src/upstream.mjs:36-44`, `deploy/policies/capabilities.json` (`limits.extras.responseMaxBytes`) _(unique to CA1's lane)_
    - Problem: Chunks, the concatenated buffer, the string and the parsed object can all be alive at once, about 4× the answer size. The screenshot fixtures compress to small PNGs, so the resource evidence never measures the bound.
    - Suggestion: Size the bound from measurement, release chunks before parsing, and add an incompressible full-page fixture.
11. **W11 — The enhanced answer is encoded to base64 and decoded again in one process** - `services/retrieval/src/enhanced.mjs:183`, `services/retrieval/src/acquire.mjs:515` _(unique to CA1's lane)_
    - Problem: `dispatch()` re-encodes a body of up to 25 MiB, and `enhancedStep` decodes it immediately. Only the kept answer (≤4 MiB) needs base64.
    - Suggestion: Return a Buffer, and build base64 only for the kept answer.
12. **W12 — `/platform/v1/changes` stores versions without the result-quota check** - `services/access/src/changes.mjs:79-81` _(unique to CA1's lane)_
    - Problem: Every other archive writer checks both the quota and the free-space floor. `changes` checks only the floor, so versions can push the ledger past quota and new jobs get STORAGE_QUOTA.
    - Suggestion: Pass `quotaBytes` in and apply the same two-part check.
13. **W13 — New critical-path branches have no tests** - `services/retrieval/src/acquire.mjs:237-240,549-566`, `services/access/server.mjs:157-167,367,399-408` _(unique to CA1's lane)_
    - Problem: No test references:
      - the RETRY_STATUSES guard in `finish()`;
      - residential BUDGET_EXHAUSTED escalation (W1);
      - json with extras (W2);
      - WEBHOOK_CHECK_UNAVAILABLE;
      - the idempotent retry with a destination no longer approved;
      - the cache handler's storage conditions.
    - Suggestion: Add one case per branch.

**Pre-existing:**

1. **W14 — [PRE-EXISTING] The gateway still answers HTTP 502 for its own failures on the forward and json paths, and M7 makes that costlier** - `services/access/src/upstream.mjs:67`, `services/access/src/jsonscrape.mjs:18-19,34` _(corroborated: both agents)_
   - Problem: Every `cachedScrape` miss now goes through `forward()`. A client library that resubmits on 502 creates a new job, and with it a new `enhanced:<logicalId>` call key, so a `proxy: "enhanced"` scrape can be dispatched and paid twice. Newly reachable through M7's paths; independently raised by both reviewers (DB1 within W2).
   - Suggestion: Answer `timedOut ? 504 : 503` with `retry-after` in `forward.fail()`, and 503 in `jsonscrape.mjs`.
2. **W15 — [PRE-EXISTING] Bulk jobs silently rewrite `proxy: "enhanced"` to `"stealth"`, and a small enhanced job's auxiliary downloads go out direct** - `services/access/src/routing.mjs:24,33-34` _(unique to DB1's lane)_
   - Problem: `routeBody` overwrites every asked route but `basic` on bulk jobs, now including `enhanced`, without notice. `needsRoute` holds the route only for `stealth`, so a non-bulk crawl marked `enhanced` fetches robots.txt, sitemaps and discovery pages on the home connection. Newly reachable in M7.
   - Suggestion: Refuse bulk + `enhanced` explicitly, as `basic` is refused, and hold the route for `enhanced` too.

### 🔵 Suggestions (Consider)

**Introduced in this changeset:**

1. **S1 — Reusing a kept enhanced answer does not check that it answers the same request** - `services/retrieval/src/enhanced.mjs:99` _(unique to CA1's lane)_
   - Current: `earlier(row)` returns the answer whenever the call key matches.
   - Better: Compare `row.request_hash` too, and refuse on a mismatch.
2. **S2 — The outbox defers an event forever on any non-200 from the retrieval service, and its lease is shorter than a round** - `services/access/src/outbox.mjs:19-25` _(corroborated: both agents)_
   - Current: A 500 or 400 is deferred every 60 s, with no attempt counted and no dead letter. The 60 s lease is shorter than five 20 s deliveries.
   - Better: Defer only on no connection or a 503, count any other answer as an attempt, and set the lease to at least `limit × timeout`.
3. **S3 — By default every successful scrape is written to disk, though nothing reads it unless `maxAge` is set** - `services/access/server.mjs:399` _(unique to CA1's lane)_
   - Current: `storeInCache` defaults to true.
   - Better: Store only when the caller opts in, or document the cost.
4. **S4 — The LCS table is built on the event loop at 0.3 CPU** - `services/access/src/changes.mjs:34` _(unique to CA1's lane)_
   - Current: Up to 4 M comparisons synchronously.
   - Better: Trim the common prefix and suffix first.
5. **S5 — A capture that fails part-way leaves orphaned artifacts** - `services/access/src/artifacts.mjs:36-47` _(unique to CA1's lane)_
   - Current: Each row commits on its own.
   - Better: Write the files first, then insert every row in one transaction.
6. **S6 — The page itself decides the `truncated` flag** - `services/browser/src/server.mjs:158-164` _(unique to CA1's lane)_
   - Current: `scrollHeight` comes from the page's main world.
   - Better: Also set `truncated` in the gateway when a full-page capture's IHDR height reaches 20000.
7. **S7 — The action subset is defined in five places with no contract test tying them** - `services/retrieval/src/acquire.mjs:277`, `services/access/src/validate.mjs:96`, `services/browser/src/server.mjs:107`, `deploy/policies/capabilities.json` _(unique to CA1's lane)_
   - Current: The layers can drift.
   - Better: Add a test asserting that the manifest's subset matches `ACTIONS`.
8. **S8 — `webhook_event` has no value checks** - `deploy/nuq-postgres/fcpi-platform-schema.sql` _(unique to CA1's lane)_
   - Current: `type` and `attempts` are unconstrained.
   - Better: CHECK the type pattern and `attempts >= 0`.
9. **S9 — The enhanced pacing hold is shorter than the dispatch** - `services/retrieval/src/acquire.mjs:504` _(unique to DB1's lane)_
   - Current: Held for 30 s against a 40 s request timeout.
   - Better: Hold for the longer of the two.
10. **S10 — The webhook refusal skips the idempotency conflict and the accepted-job lookup** - `services/access/server.mjs:159-166` _(unique to DB1's lane)_
    - Current: A reused key answers 400 rather than 409, and a check outage answers 503 before the lookup.
    - Better: Do the idempotent lookup before both refusals.
11. **S11 — `/internal/webhook/check` does not guard the body shape** - `services/retrieval/src/server.mjs` (`/internal/webhook/check`) _(unique to DB1's lane)_
    - Current: A `null` body throws, and the throw surfaces as a 500.
    - Better: `webhooks.check(b?.url)`.

### ✅ Good Practices
- The enhanced dispatch validates and resolves the target, reserves under a key per logical page, and sends once. A concurrent second reservation resolves through the unique key; an unknowable outcome stays UNCERTAIN and is never resent; the final URL is checked again (CLOUD_DENIED is tested).
- The provider's 200 is never taken as success: the target's own status is judged. Provider errors count on the breaker and never teach routing; neutral outcomes hand a half-open probe back.
- The 401/403/429 guard sits on both sides of the boundary, in `finish()` and in patch 0010's adapter.
- Outbox rows are raised inside the transition's own transaction with `ON CONFLICT (job_id, type) DO NOTHING`.
- Webhook egress uses an exact allowlist, validated at load. The name is resolved, the connection goes to that address, no redirect is followed, and the HMAC covers `ts.eventId.body`.
- Artifacts are looked up by id and principal, so another principal's id gets a 404 identical to an unknown one. They are served `private, no-store` and `nosniff`.
- The parse cache fix fails closed: without a 16-hex owner tag it neither reads nor writes.
- `CONTENT_TABLES` drives both the quota sum and the sweep. The v3 migration runs in one transaction and has a contract test. Jobs submitted before M7 still reconcile through the legacy marker.

### Verdict
[ ] ❌ Request Changes (critical issues)
[x] ⚠️ Approve with Suggestions
[ ] ✅ Approve

## Carried from earlier reviews

| ID | Finding | Outcome | Commits |
|---|---|---|---|
| M5 S1 | The parse cache is not really keyed by owner | Fixed: the gateway sends each principal's owner tag (sixteen hex digits of a SHA-256 of the principal) in the scrape's origin, patch 0010 carries it to the retrieval service as x-fcpi-owner, and the parse cache is read and written only under a valid tag and skipped without one; a scan-only PDF is a cache hit for its own principal and a fresh parse for another (C02) | `c5557a8`, `5ebc7b1`, `e206fc7` |

## Found during M7, outside the review

| ID | Severity | Finding | Outcome | Commits |
|---|---|---|---|---|
| F1 | — | Re-applying the retrieval schema at bring-up failed once an enhanced ledger row existed, because M6's five-kind constraint ran after M7's | Fixed: the ledger's kinds are one constraint definition naming all of them; a PostgreSQL test re-applies the schema over an enhanced row | `e56cf95` |
| F2 | — | An enhanced request that was sent and got no answer left no `enhanced` log line | Fixed: every sent request with no answer is logged with outcome UNCERTAIN | `a8feec9` |
| F3 | — | A target's Retry-After relayed through the enhanced provider did not set the domain's cooldown | Fixed: the provider's relayed response headers carry Retry-After into the classification, and a 429 cools the domain for that long | `04e0de6` |
| F4 | — | The fixture receiver's replay control resent the last delivery it received, accepted or not | Fixed: it keeps and replays the last accepted delivery | `487ea43` |
| F5 | — | Found by the first fixture window: an off-host click left Chromium on its own error page, returned as an unsuccessful scrape (SCRAPE_ALL_ENGINES_FAILED) | Fixed: the worker fails the render as ACTION_FAILED, naming the refused navigation | `bfa1f61` |
| F6 | — | Found by the same window: the evidence driver's `pkill -f chrome-headless-shell` matched and ended its own shell, and the unhandled rejection skipped the restoring finally; the collector's process count counted itself; the verifier's test ids lost their check id | Fixed: bracketed patterns match the browser but not their own text, the killer's failure is caught, and the ids carry their check | `3731ca7` |
| F7 | — | Found by the verifier's dry run: X01 and X03 required log line counts chosen before any log existed, X02 counted Docker's own aliases, and the redaction scan flagged two variables and two synthetic test values | Fixed: log reads are judged by their content counts, the fixture by its exact names, and the four literals are allowed by value | `5684565` |
| F8 | — | Found while addressing W12: its fix handed the changes route quotaBytes before that constant's declaration, so the gateway threw on startup; the unit tests build the route themselves and did not see it, the M3 contract suite starting the real server did | Fixed: the route gets a function that reads quotaBytes at call time; the contract suite passes (42 tests) | `21cc2b3` |
| F9 | — | The Pi's own Wi-Fi watchdog rebooted the host three times between the BEFORE snapshot and the final window (reboots at 06:06Z, 06:54Z and 08:10Z), M4's recorder and X04's tie cover a single reboot, and the journal (capped at 32 MiB) rotated the BEFORE boot out within about two hours | Fixed: scripts/m7/pi-reboot-record.sh records the chain from the BEFORE snapshot's boot, or every boot the journal still holds, each ended boot with its orderly shutdown, the watchdog's recovery steps and reboot, the Wi-Fi loss, no local action after it and no undervoltage; collect-close runs it; raw/reboot-early.txt keeps the record made at 06:59Z while the journal held BEFORE's boot, and X04 joins the two only when every ended boot meets that bar | `43b4310`, `bfb02c8`, `9713283` |
| F10 | — | Wi-Fi losses at 05:55Z, 06:46Z and 07:59Z each ended in the watchdog's reboot. The 07:59Z journal shows an inactivity disassociation (reason 4), then failed re-association on a 5,500 MHz (DFS) channel with the regulatory domain reset to WORLD for ten minutes; each loss came minutes after heavy work on the Pi, which is not shown to cause it | Deferred to M8: host stability over a long run, the resource soak and recovery are its scope (its Implementation Work runs the soak); the access point, the regulatory domain and the watchdog are the owner's, outside the project | — |
| F11 | — | Found by the final window's worst case: two incompressible captures (10 MB) killed the core's API child with a V8 heap OOM while it parsed the retrieval service's answer, and the harness stopped the whole core. Measured on the Pi through the inspector: the API child holds 232 MiB live at rest under the 256 MiB ceiling (spec §22's starting value), about 250 MiB after a fixture run; the gateway peaked at 96% of its cap with 10 MB of captures | Fixed: each core child's heap ceiling is 384 MiB inside the container's unchanged memory cap, and each screenshot and all of a page's captures together are bounded at 8 MiB (RESOURCE_LIMIT past it); spec §12 and §22 state both; the evidence captures just under and just over the bound, and B01 requires the core to run the whole window without a restart. With 384 MiB heaps the full run then took the core to 91.5% of its 2,304 MiB cap (M01's line is 90%), the host keeping at least 4,877 MiB available, so the core's cap is 2,560 MiB (spec §22's table) | `b825e57`, `5af987a`, `21e8730` |
| F12 | — | Found while reading the 07:59Z loss: the throwaway networks the M7 suites and the M4 runner create got Docker's default br-<id> bridge, which NetworkManager took over and activated, against CLAUDE.md §33.1 (it leaves only veth*, fcpi-* and docker0 alone) | Fixed: each names its bridge fcpi-s<pid> or fcpi-t<pid>; a probe on the Pi created one, NetworkManager logged no activation, and it was removed | `4bc00bd` |
| F13 | — | X04 fails on the final record: the third reboot (08:10Z) is not tied. The records that tied it (08:11Z, and the 08:35Z close, whose X04 passed) were not kept: each close overwrites raw/reboot.txt and the scratch copy was removed; the journal then rotated the Wi-Fi loss and the watchdog's steps out. Its first twelve lines survive in raw/reboot-0811-partial.txt; the six unexplained lines are the reboot's own (avahi's ephemeral ports, the binfmt_misc automount) | Deferred to M8: reboots, recovery and the host's lifecycle are its Scope, whose reboot tests need durable records (each kept, never overwritten, made soon after the reboot); M7's evidence window is final | — |
| F14 | — | Found reading a window's record: the live phase took the selection as it found it, and the run the 07:59Z Wi-Fi loss cut off had left the fixture selection behind, so that window's public sample ran with the fixture enhancer selected (no page escalated past direct HTTP), while L02 stated the production selection without checking it | Fixed: the live phase selects live search and the budget's default proxy and enhancer before the sample and records it; L02 requires that record (it fails on the earlier window's evidence) | `ce09074` |

## Outcomes

Every finding was fixed in M7; none was rejected or deferred. After /address the retrieval suite (178 tests, the SQL against a throwaway PostgreSQL), the gateway's (70), the MCP service's (43) and the contract suites (54: M3's with M7's two route tests, M4's, the grammars and the ledger migrations) passed on the workstation; the suites in the running images and the evidence window are recorded in evidence/M7/verification.json.

| ID | Severity | Finding | Outcome | Commits |
|---|---|---|---|---|
| W1 | 🟡 | A spent residential budget falls through to the enhanced provider | Fixed: only a residential stage that is not configured, switched off or out of service is skipped; a spend limit or an unknown price ends the page as PROXY_REQUIRED, with no enhanced reservation; spec §9.3 states the rule; tested with the residential day cap at zero and a control with no route selected | `8a9406e`, `21e8730` |
| W2 | 🟡 | A scrape that asks for json with a screenshot or actions bypasses the extras path | Fixed: the combination is refused by name (400 UNSUPPORTED_OPTION, formats.json) before any work, the MCP description says so, and the evidence driver and B02 carry the refusal | `d7a699a` |
| W3 | 🟡 | A settled, kept enhanced answer is not reused once the cap is spent, and an auto retry rarely reaches it | Fixed: the page's reservation is read by its call key before any availability check; a kept answer is returned at a spent cap, after the enhancer is deselected, and for an auto retry with no attempt, pacing or target request | `de0ba01` |
| W4 | 🟡 | An UNCERTAIN enhanced charge is logged as NOT_CHARGED with zero cost | Fixed: both ENHANCED_UNCERTAIN returns carry the charge at its reservation, which the acquisition's cost and log line count | `549463a` |
| W5 | 🟡 | /platform/v1/changes fails with a retryable 503 on a page whose markdown is empty | Fixed: a page whose normalized text is empty is 422 NOT_COMPARED and keeps the stored version | `b786485` |
| W6 | 🟡 | Navigations triggered by a click bypass per-domain pacing and the direct caps | Fixed: the worker counts main-frame navigations the actions start, and on the direct route each is recorded against the domain; a fixture same-host link, an evidence case and B02 require exactly that one counted navigation | `3b839da` |
| W7 | 🟡 | An exception between the enhanced reservation and its settlement leaves it RESERVED for good | Fixed: a still-RESERVED row is marked UNCERTAIN before the error is rethrown, and the attempt is finished as INTERNAL_ERROR; tested with a settlement that throws after a paid answer | `83057c8` |
| W8 | 🟡 | MCP scrape payloads with scrape actions are never cut to the tool limit | Fixed: each actions.scrapes[i].html is cut like the page's formats, largest first, and named in the answer's cuts | `95e6f12` |
| W9 | 🟡 | Cache hits are outside the synchronous admission limit, and each copies the document about five times | Fixed: the answer is stored already marked as the hit it will be, and a hit sends the stored bytes within the admission limit; a route-level contract test covers the hit and the misses | `719b3e4` |
| W10 | 🟡 | The 32 MiB extras response bound is not safe in the gateway's 160 MiB cgroup, and no fixture approaches it | Fixed: chunks and buffer are released before the parse; an answer past the bound is 422; an incompressible fixture, its height chosen per case, measures every hop at the bound. The measurement (F11) set the bounds: 8 MiB of captures per page, 14 MiB of answer | `6218fb2`, `d103552`, `b825e57` |
| W11 | 🟡 | The enhanced answer is encoded to base64 and decoded again in one process | Fixed: the answer carries a Buffer; base64 is built only for the kept answer and for a binary result handed to the core | `13dd1f5` |
| W12 | 🟡 | /platform/v1/changes stores versions without the result-quota check | Fixed: the changes route applies the quota and the free-space floor like every other archive writer (its first form threw at startup, F8) | `eab8084`, `21cc2b3` |
| W13 | 🟡 | New critical-path branches have no tests | Fixed: a test for each named branch: the residential spend limit, json with extras, the cache handler's storage conditions at the route, WEBHOOK_CHECK_UNAVAILABLE and the replay with a destination no longer approved, and the RETRY_STATUSES guard as an exported function | `8a9406e`, `d7a699a`, `719b3e4`, `929ce06`, `1b5add0` |
| W14 | 🟡 | The gateway still answers HTTP 502 for its own failures on the forward and json paths | Fixed: an unreachable core is 503 with Retry-After, a timeout 504 and an unusable answer 500, on both paths; tested at forward() and the json scrape | `de4c890` |
| W15 | 🟡 | Bulk jobs silently rewrite proxy enhanced to stealth, and a small enhanced job's auxiliary downloads go out direct | Fixed: a bulk job asking for the enhanced provider is refused by name (400 UNSUPPORTED_OPTION), and a job of any size asking for it holds its domains on the residential route | `22caf4c` |
| S1 | 🔵 | Reusing a kept enhanced answer does not check that it answers the same request | Fixed: a kept answer is returned only for the request hash it was made for; another is refused as ENHANCED_ALREADY_DISPATCHED | `de0ba01` |
| S2 | 🔵 | The outbox defers an event forever on any non-200 from the retrieval service, and its lease is shorter than a round | Fixed: only no connection, a 503, a 401 or 403, suppression and a missing secret wait; any other answer is a failed attempt; the lease covers five deliveries at their timeout | `9c839c4` |
| S3 | 🔵 | By default every successful scrape is written to disk, though nothing reads it unless maxAge is set | Fixed: a 2xx answer is stored only when the request asks for the cache (storeInCache true, or a maxAge); the driver's cases that test exclusion ask for storage explicitly, and a plain scrape followed by a read is a new miss case | `07acc29` |
| S4 | 🔵 | The LCS table is built on the event loop at 0.3 CPU | Fixed: the common head and tail are trimmed first, and only the differing middle is tabled and bounded | `cb39f98` |
| S5 | 🔵 | A capture that fails part-way leaves orphaned artifacts | Fixed: every capture is checked and written first, and one answer's artifact rows commit in one transaction | `6708f43` |
| S6 | 🔵 | The page itself decides the truncated flag | Fixed: the gateway also marks any capture at the 20,000 px clip height truncated | `35304cc` |
| S7 | 🔵 | The action subset is defined in five places with no contract test tying them | Fixed: a retrieval test asserts the manifest's subset, option names and bounds are what validateHooks accepts | `7514bc0` |
| S8 | 🔵 | webhook_event has no value checks | Fixed: its type and attempts are constrained, dropped and added again so a version-3 ledger gains them | `9331fd3` |
| S9 | 🔵 | The enhanced pacing hold is shorter than the dispatch | Fixed: the enhanced step holds its domain for the longer of the browser attempt and the provider's request timeout | `b26de1c` |
| S10 | 🔵 | The webhook refusal skips the idempotency conflict and the accepted-job lookup | Fixed: a replay's receipt and a reused key's 409 are answered before either webhook refusal; a contract test covers both | `929ce06` |
| S11 | 🔵 | /internal/webhook/check does not guard the body shape | Fixed: a body that is not a JSON object is refused as INVALID_REQUEST | `b93f5af` |
