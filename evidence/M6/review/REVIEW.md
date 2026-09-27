# M6 review — /review-2 report of record

Milestone M6 (residential proxy and anti-bot routing policy), reviewed as the diff `e08c31f..c0c052c` under CLAUDE.md §5. Two read-only agents ran in parallel, both on **Opus 5.5** (the Agent tool's `opus` alias): DB1, a debugger, and CA1, a code auditor. The session's tool set had no team tools, so the two agents were spawned directly with the Agent tool and reported to the orchestrating session. The orchestrator merged their reports below. Outcomes are recorded under **Outcomes**, findings made during M6 outside the review are listed under **Found during M6, outside the review**, and the finding an earlier review deferred to M6 under **Carried from earlier reviews**.

## Code Review: M6 — residential proxy and anti-bot routing policy (services/retrieval, services/access, patch 0009, deploy/, scripts/m6)

### Summary
56 files (4,087 inserted lines) were reviewed by 2 specialist agents (1 debugger and 1 code auditor, both on Opus 5.5). Both traced every egress path and found none on which stealth, held, proxy-first or learned work reaches the home connection, none that dispatches without a reservation, and none that passes four attempts. Both independently found one critical ledger defect: reconciliation charges the same provider-over-local difference again on every run. They also found 13 warnings, concentrated in the breaker's classification, the meter's cap, the residential TLS handshake, the gateway's hold protocol and the untested reconciliation and search-leg code.

**Scope:**
- **Reviewed:**
  - Tier 1, in full (the diff plus context): `services/retrieval/src/{residential,route,acquire,proxy,httpfetch,store,reconcile,server,budget,policy,browser,quality}.mjs`, `services/access/src/{routing,jobs,config,extractor}.mjs`, `services/access/server.mjs`, `patches/0009-residential-route-option.patch`, `deploy/nuq-postgres/fcpi-retrieval-schema.sql`, `deploy/policies/{egress,budget,capabilities}.json`, `deploy/host/fcpi-guard.nft`.
  - Tier 2, skimmed for shape changes: `deploy/compose.yaml`, `deploy/searxng/settings.yml`, `tests/fixtures/m6/{fixture,server}.mjs`, the changed retrieval and gateway tests, `scripts/m6/*`, `scripts/m5/{pi-selection,pi-provider-key}.sh`.
- **Acknowledged, content not reviewed (Tier 3):** `docs/FIRECRAWL_PI_SPEC.md`, `deploy/secrets.template`, `patches/series.json`, `services/retrieval/package.json`.
- **Confidence:** high on Tier 1. False negatives are possible in Tier 2.
- **Out of scope:** enhanced providers (M7), live Decodo credentials (none exist), evidence files.
- **Not run by the reviewers:** the test suite, linters, the type checker and the build. This was a read-only review.

### 🔴 Critical Issues (Must Fix)

**Introduced in this changeset:**

1. **C1 — Reconciliation charges the same adjustment again on every run** - `services/retrieval/src/reconcile.mjs:46-57`, `services/retrieval/src/store.mjs:280-286`, `services/retrieval/src/server.mjs:131-139` _(corroborated: both agents)_
   - Problem: `measured` counts only `kind = 'proxy'` rows, so an adjustment already recorded (a `kind = 'reconcile'` row, whose call key is random) is never seen by a later run. The hourly timer reconciles yesterday and today, and the endpoint does the same. Reconciling today also charges the bytes of rows still RESERVED, which the provider already reports, and charges them again when they settle.
   - Risk: Independently flagged by both reviewers. A day whose report shows 0.10 GB more than the ledger is charged 400,000 micro-USD every hour for about 48 hours; the usage rows pass every cap, the residential route turns PROXY_REQUIRED (BUDGET_EXHAUSTED) on invented charges, and the ledger stops matching the provider's bill.
   - Fix:
     ```js
     // count earlier adjustments as covered, record only the new delta, reconcile only a closed day
     const already = await store.proxyAdjustedBytes(providerName, day);
     const measured = local.settledBytes + local.uncertainBytes + already;
     // server.mjs timer: only periodStarts(new Date(Date.now() - 86400e3)).day, and only with paid dispatch on
     ```

### 🟡 Warnings (Should Fix)

**Introduced in this changeset:**

1. **W1 — The provider breaker counts failures that are not the provider's** - `services/retrieval/src/residential.mjs:176,187,202` _(unique to DB1's lane)_
   - Problem: A tunnel opened near an attempt's deadline times out as PROVIDER_UNREACHABLE because the deadline was short, and an exit that cannot reach a dead target answers CONNECT with an error; both count on the breaker, so a page with three unreachable subresource hosts closes the residential route for five minutes. The breaker is read with `state()`, never `admit()`, so half-open is not honoured.
   - Suggestion: A deadline-limited timeout is DEADLINE_EXCEEDED and skips the breaker; count only 407/402/429, no connection, and a timeout at the full connect timeout; treat a 502/504 CONNECT answer as a target failure; admit through the breaker.
2. **W2 — The meter's cap does not stop tunnels opened after it trips, and a capped browser render is returned as success** - `services/retrieval/src/residential.mjs:67-75`, `services/retrieval/src/acquire.mjs:332` _(unique to DB1's lane)_
   - Problem: `add` destroys sockets only when it first trips and `attach` never checks the cap, so later CONNECTs are tunnelled; the settlement's `Math.min` hides the overshoot; the meter trips before the session's own byte count, so `limited` stays null and the partial page is returned `ok`.
   - Suggestion: Refuse to attach or open once capped, treat `leg.meter.capped` as RESOURCE_LIMIT, and mark an attempt whose bytes pass its reservation UNCERTAIN rather than clamping.
3. **W3 — The residential TLS handshake has no deadline and ignores cancellation** - `services/retrieval/src/residential.mjs:231-236` _(unique to DB1's lane)_
   - Problem: After CONNECT succeeds, `tls.connect` waits for `secureConnect` with no timer or abort listener; a target that never sends ServerHello holds the attempt, its reservation and its permits past the deadline.
   - Suggestion: Bound the handshake by the deadline, listen for the signal, and map network codes to TARGET_UNREACHABLE.
4. **W4 — Replaying an idempotency key for a bulk job gets PROXY_REQUIRED instead of its receipt** - `services/access/server.mjs:129-138` _(unique to DB1's lane)_
   - Problem: The route check runs before `store.admit`, which resolves the key, so a retry after the route became unavailable is told nothing was accepted while the job exists.
   - Suggestion: With a key present, look the admission up first, and refuse only a new receipt.
5. **W5 — A route-hold answer other than 200 or 409 fails the job for good** - `services/access/src/jobs.mjs:46-51` _(corroborated: both agents)_
   - Problem: A 503 RETRIEVAL_NOT_READY during a restart, a 500 or a 400 is recorded as PROXY_REQUIRED although only 409 `held: false` means the route is unavailable.
   - Suggestion: Reject only on 409; requeue on 5xx; treat other 4xx as the gateway's own error.
6. **W6 — The routing record learns under the domain the request started at, not the one that answered** - `services/retrieval/src/acquire.mjs:198,271,341` _(unique to DB1's lane)_
   - Problem: After a cross-domain redirect the final host's challenge is written to the starting domain; a shortener becomes preferred residential while the blocking domain learns nothing. The 429 cooldown already uses the final domain.
   - Suggestion: Learn challenge and adequate observations under the final URL's domain.
7. **W7 — Auxiliary downloads ignore a stealth or basic request's route** - `services/retrieval/src/acquire.mjs:436`, `services/access/src/routing.mjs:22-31` _(corroborated: both agents)_
   - Problem: `/internal/fetch` always decides as `auto`: a stealth crawl of 20 pages or fewer sends its sitemap and discovery fetches directly, and a basic crawl's downloads may escalate to the paid route once the direct caps are spent.
   - Suggestion: Hold the domains of any stealth crawl as for a bulk job; never escalate an auxiliary download to the residential route unless its domain requires that route.
8. **W8 — An adjustment is left out of a category's usage when no usage row exists yet** - `services/retrieval/src/store.mjs:288-296` _(unique to CA1's lane)_
   - Problem: The day and month rows are updated, not created, so a day with no local reservation records a SETTLED reconcile row the caps never see.
   - Suggestion: Insert each usage row before updating it, as `reserveBudget` does.
9. **W9 — A reservation is left RESERVED when an exception interrupts an attempt** - `services/retrieval/src/acquire.mjs:231-235, 299-315, 446-470` _(corroborated: both agents; DB1 rated it a Suggestion, and the higher rating is taken)_
   - Problem: After `legs.open` reserves, an exception from pacing, `setAttemptStrategy`, the render or the settlement itself leaves the reservation RESERVED for good, using up the cap.
   - Suggestion: Settle an opened leg in `finally`: released when nothing was sent, UNCERTAIN when the settlement cannot be completed.
10. **W10 — The proxy credential travels in cleartext to the provider (CWE-319)** - `services/retrieval/src/residential.mjs:178,190`, `services/retrieval/src/budget.mjs:44` _(unique to CA1's lane)_
    - Problem: `Proxy-Authorization: Basic` is sent over plain TCP to `gate.decodo.com:7000`, and the CONNECT line names the target before TLS.
    - Suggestion: Use a TLS endpoint if the provider offers one; otherwise record the exposure and the compensating control (a dedicated sub-user with a provider-side traffic limit).
11. **W11 — Metering is split across three consumers that must each honour patched socket properties** - `services/retrieval/src/residential.mjs:59-91,195-213`, `services/retrieval/src/proxy.mjs:335-345,425-439` _(unique to CA1's lane)_
    - Problem: The CONNECT reader, `Meter.wrap` and proxy.mjs's own listeners count bytes, relying on `fcpiUncounted`, `fcpiCapped` and consumers setting `meter.errored`; a new consumer can under- or double-count. The leg interface differs between `via.open` and `upstream.open`.
    - Suggestion: Have `tunnel()` return only a metered stream that records its own errors, and use one leg interface.
12. **W12 — Critical-path tests stub out the logic they should cover** - `services/retrieval/test/m6-proxy.test.mjs:88-131` _(unique to CA1's lane)_
    - Problem: The F11 test writes its own `upstreamFor`, so `searchUpstream` is never exercised; untested are `reconcileDay` and `providerDayBytes` (the Decodo branch, refusals, a repeated run), the route-hold, route-release and reconcile handlers, the gateway's hold, requeue, reject and release paths, `fetchOnce`'s direct-cap escalation, and a residential browser tunnel that breaks.
    - Suggestion: Test the real search-leg factory, reconcile twice against PostgreSQL, and test the job runner with a fake route client.
13. **W13 — Reconciliation's usage query covers the whole account** - `services/retrieval/src/reconcile.mjs:8-9,32` _(unique to CA1's lane)_
    - Problem: The request carries no sub-user filter, so other traffic on the account is charged to this ledger.
    - Suggestion: Filter by the proxy user, or refuse to reconcile without one.

### 🔵 Suggestions (Consider)

**Introduced in this changeset:**

1. **S1 — The leg sequence is written three times** - `services/retrieval/src/acquire.mjs:217-240, 451-470`, `services/retrieval/src/server.mjs:97-108` _(unique to CA1's lane)_
   - Current: `httpStep`, `fetchOnce` and `searchUpstream` each repeat pace, cap, open, re-pace and settle.
   - Better: One helper, which also gives W9's settle-in-finally one home.
2. **S2 — The route state carries the proxy password** - `services/retrieval/src/residential.mjs:107-111` _(unique to CA1's lane)_
   - Current: `state()` returns `cred`, spread into refusal objects handed across the service.
   - Better: Read the credential in `tunnel()` and keep a boolean in the state.
3. **S3 — The credential file is read synchronously on every availability check** - `services/retrieval/src/residential.mjs:107` _(unique to CA1's lane)_
   - Current: Several synchronous reads per acquisition and per search tunnel.
   - Better: Cache it by modification time.
4. **S4 — The engine route lookup is exact while `allow` matches patterns** - `services/retrieval/src/server.mjs:98` _(unique to CA1's lane)_
   - Current: A pattern host added to `engineHosts.live` would fall through to direct.
   - Better: Match routes as `allow` does, and default an unlisted live host to residential.
5. **S5 — Concurrent first observations can lose an update, and eviction can drop an active preference** - `services/retrieval/src/store.mjs:373-394` _(corroborated: both agents)_
   - Current: `FOR UPDATE` locks nothing for a missing row; the least-recently-updated eviction treats a learned block like an empty row.
   - Better: Insert the row before locking it, and evict rows without a preference first.
6. **S6 — The guard's proxy-port rule is by port only** - `deploy/host/fcpi-guard.nft:46` _(unique to CA1's lane)_
   - Current: Any process on the egress bridge may reach port 7000 of any public address.
   - Better: Say in the comment that the floor is by port, as for 80 and 443.
7. **S7 — Bytes after settlement go unmetered** - `services/retrieval/src/residential.mjs:155`, `services/retrieval/src/acquire.mjs:255` _(unique to CA1's lane)_
   - Current: The tunnel sockets are not destroyed at settlement, so trailing bytes cross unmetered.
   - Better: Destroy the meter's sockets before reading its count.
8. **S8 — A test assertion cannot fail** - `services/retrieval/test/m6-residential.test.mjs:193-201` _(unique to CA1's lane)_
   - Current: `actual <= reserved` is guaranteed by the settlement's `Math.min`.
   - Better: Assert the meter's bytes against the cap and the row's state.
9. **S9 — The upstream stealth retry after `stealthProxy: true` is unchecked** - `patches/0009-residential-route-option.patch:37-40` _(unique to CA1's lane)_
   - Current: Serving `stealthProxy` could enable upstream's retry that adds the feature after a 401, 403 or 429.
   - Better: Confirm against the pinned source.
10. **S10 — No index serves reconciliation's lookups** - `services/retrieval/src/store.mjs:280` _(unique to CA1's lane)_
    - Current: `proxyDay` and `settleUncertainProxy` filter on `(provider, kind, day_start)`.
    - Better: Add a partial index if the table grows.
11. **S11 — The evidence driver builds SQL by interpolation** - `scripts/m6/e2e.mjs:101-103` _(unique to CA1's lane)_
    - Current: Script constants are interpolated into SQL.
    - Better: Use psql variables.
12. **S12 — A capped HTTPS attempt may not be reported as SIZE_LIMIT** - `services/retrieval/src/httpfetch.mjs:104,134` _(unique to DB1's lane)_
    - Current: Through TLS the cap may surface as a reset, TARGET_UNREACHABLE, and earn a same-tier retry with a second reservation.
    - Better: Treat `leg.meter.capped` as SIZE_LIMIT whatever the error.
13. **S13 — A tunnel is left open when a request is refused early** - `services/retrieval/src/httpfetch.mjs:73-74,159-160` _(unique to DB1's lane)_
    - Current: `requestOnce`'s early rejections never destroy the socket `via.open` returned.
    - Better: Destroy it on those returns.
14. **S14 — A CONNECT still pending when a render ends lingers** - `services/retrieval/src/proxy.mjs:169-204` _(unique to DB1's lane)_
    - Current: Sockets join the session only after `openLeg` resolves.
    - Better: Register them before awaiting, and destroy the tunnel if the client is gone.
15. **S15 — A fast or non-page script shell resets the browser learning** - `services/retrieval/src/acquire.mjs:276-277` _(unique to DB1's lane)_
    - Current: A shell not rendered is learned as an adequate HTTP answer.
    - Better: Skip the adequate observation for a script shell.
16. **S16 — A hold can outlive a job cancelled before submission** - `services/access/src/jobs.mjs:36` _(unique to DB1's lane)_
    - Current: A requeued, then cancelled, job never releases its hold.
    - Better: Release on cancellation before submission.
17. **S17 — An auto browser attempt at the direct cap does not escalate** - `services/retrieval/src/acquire.mjs:305-310` _(unique to DB1's lane)_
    - Current: Only the HTTP step moves to residential at the cap.
    - Better: Mirror it in the browser step.
18. **S18 — A malformed proxy credential name surfaces as a 500** - `services/retrieval/src/route.mjs:83` _(unique to DB1's lane)_
    - Current: `sessionUsername` throws a plain Error inside `tunnel()`.
    - Better: Validate the name in `state()` and refuse as BLOCKED_CREDENTIAL.

### ✅ Good Practices
- The no-spill invariant holds on every traced path: stealth, held, proxy-first and learned work start residential before any attempt; a lost probe claim stays residential; a direct-cap refusal becomes residential or PROXY_REQUIRED, never a direct send; browser and search legs refuse rather than go direct.
- Every provider tunnel is reserved before it opens, each attempt under its own call key, and the transactional attempt counter bounds a page at four.
- Provider refusals never reach `learn`; each provider has its own breaker; refusals reach Chromium as a 502 distinct from a policy 403; the guard counts proxy connections apart.
- Every residential hop is still validated and resolved locally first; the provider endpoint is resolved, checked public and pinned by address.
- `sessionUsername` validates the name and session id, so no parameter can be injected into the proxy username; the session id is an HMAC, not the core's job id.
- `startTier` and `observe` are pure and unit-tested; residential navigations share the domain's gap, hold and cooldown and stay off the direct caps.
- Counting only through `Meter.wrap`, and `http.request` with `createConnection` and no agent, are the right patterns.

### Verdict
[x] ❌ Request Changes (critical issues)
[ ] ⚠️ Approve with Suggestions
[ ] ✅ Approve

## Carried from earlier reviews

| ID | Finding | Outcome | Commits |
|---|---|---|---|
| M5 F11 | Two of the three live engines (Brave, DuckDuckGo) refuse the home connection | Fixed: SearXNG's residential-routed engines leave through the retrieval service's search proxy on the residential route, one reserved and settled tunnel each, and are refused, never sent directly, without the route; engine hosts are matched as the allow-list matches them and an unlisted live engine goes residential. Verified with the fixture engine (VERIFIED_LOCAL); the live engines' proof is the held live step, BLOCKED_CREDENTIAL until a Decodo credential with an approved budget exists | `4745007` `c753015` `d6f2041` |

## Found during M6, outside the review

| ID | Severity | Finding | Outcome | Commits |
|---|---|---|---|---|
| F1 | — | `http.request` with `agent: false` ignores `createConnection` and connects by itself, so a residential request would have left directly | Fixed before the commit was made: the residential request passes `createConnection` with no agent option, so the tunnel is the only connection | `4745007` |
| F2 | — | A meter on the raw tunnel socket could undercount what the provider bills, since Node's HTTP and TLS layers may read the handle past its data events | Fixed before the commit was made: bytes are counted only through `Meter.wrap`, in JavaScript where they pass; the review's W11 then made the metered stream the only thing a consumer gets | `4745007` `dc39dd8` |
| F3 | — | The fixture proxy's never-answering mode never read its socket, so the test harness hung waiting for it to close | Fixed before the commit was made: the never-answering mode reads and discards its socket and closes on end | `4745007` |
| F4 | — | Escalation cases on one fixture host taught it a residential preference that steered every later case on that host | Fixed: escalation runs on a fixture name of its own (m6esc), its routing record cleared before each case; learning is B5's, on m6learn | `ab2f5c6` |
| F5 | — | A residential success after a challenge overwrote the reason the routing record's preference exists | Fixed: a residential success keeps the reason the preference exists and only extends it | `8832ae1` |
| F6 | — | The crawl default of 50 pages made every crawl without a limit a bulk job, refused while no proxy is configured (the M3 contract suite failed) | Fixed: a crawl without a limit defaults to spec §10.2's 20 pages and is not bulk; the M3 contract suite passes again, and the validation test's stale expectation of 50 followed | `010cbe1` `ac53ad6` |
| F7 | — | The verifier looked for M6's suites by file name, read the guard's new rule with its counters, and flagged the driver's read of the service's own secret file | Fixed: the verifier recognises M6's suites by their test titles, reads the guard's rule without its counters, and allows the driver's read of the service's own secret file inside its container | `010cbe1` |
| F8 | — | Found by the post-review dry run of the verifier: two M3 contract tests predated M6's bulk rule; one asserted the old crawl default of 50, and its failure left its crawl holding the harness's upstream slot so a later test's batch queued, and the other submitted a 100-page crawl with no route service configured | Fixed: the default is expected as 20, and the 100-page crawl runs against a stand-in for the retrieval service's route endpoints, checking the stealth route, the hold with the gateway's credential and its release; the contract suite passes 40 of 40 in the gateway image on the Pi | `ec72296` |
| F9 | — | Found by the same dry run: G02 looked for the F11 test by its title before the review renamed it, and the Pi's suites did not run the job runner's tests the review added | Fixed: G02 matches the current title, and the Pi's gateway suites include test/jobs.test.mjs | `04cea77` `8530c3d` |

## Outcomes

| ID | Severity | Finding | Outcome | Commits |
|---|---|---|---|---|
| C1 | 🔴 | Reconciliation charges the same adjustment again on every run | Fixed: bytes earlier reconciliations charged count as measured, each adjustment records its own bytes, a day with a reservation still in flight is refused (RECONCILE_IN_FLIGHT, 409), and the timer reconciles only the last closed day while paid dispatch is on; a PostgreSQL test reconciles a day twice and charges it once | `9cf0f83` |
| W1 | 🟡 | The provider breaker counts failures that are not the provider's | Fixed: a deadline-cut timeout is DEADLINE_EXCEEDED and an exit's 502/504 TARGET_UNREACHABLE, neither counted; every tunnel is admitted by the breaker, so half-open lets one probe through; tested | `43a2ad8` |
| W2 | 🟡 | The meter's cap does not stop later tunnels, and a capped render is returned as success | Fixed: a tunnel attached after the cap is cut, a capped render is RESOURCE_LIMIT, and the measured charge is recorded as it is, noting when above the reservation; tested | `7680e24` |
| W3 | 🟡 | The residential TLS handshake has no deadline and ignores cancellation | Fixed: the handshake ends at the hop's deadline (TIMEOUT) or at the cancel, and a network error during it is TARGET_UNREACHABLE; tested with a target that never sends its hello | `7e89b41` |
| W4 | 🟡 | Replaying an idempotency key for a bulk job gets PROXY_REQUIRED instead of its receipt | Fixed: with the route unavailable, a keyed request looks its key up first: a replay gets its receipt, a changed request 409, and only a new receipt is refused; the M6 driver replays B6's keyed crawl with the route gone (R03) | `92a1d20` |
| W5 | 🟡 | A route-hold answer other than 200 or 409 fails the job for good | Fixed: only 409 held: false fails the job as PROXY_REQUIRED; a 5xx requeues it; any other answer is the gateway's own error, ROUTE_HOLD_INVALID, recorded as 500 because a failed job's status is replayed to the client and a client library retries 502; the job runner's first tests cover each answer | `d673d45` `e502333` |
| W6 | 🟡 | The routing record learns under the starting domain, not the one that answered | Fixed: challenges, adequate answers and script-shell renders are learned under the domain that answered; the probe counts only when the requested domain answered; tested with a redirect | `19e5271` |
| W7 | 🟡 | Auxiliary downloads ignore a stealth or basic request's route | Fixed: an auxiliary download past the direct limits is refused as PROXY_REQUIRED unless its domain requires the residential route, and a job of any size whose pages ask for that route holds its domains; both halves tested | `21c1886` `9c6ccfe` |
| W8 | 🟡 | An adjustment is left out of usage when no usage row exists yet | Fixed: each period the category caps gets its usage row before the adjustment is added; PostgreSQL test on a day nothing was reserved | `ebbbe67` |
| W9 | 🟡 | A reservation is left RESERVED when an exception interrupts an attempt | Fixed: every leg a call opened is settled when the call ends, once; a leg with no tunnel is released and a failed settlement leaves the reservation UNCERTAIN, still counted; tested | `cb156a4` |
| W10 | 🟡 | The proxy credential travels in cleartext to the provider (CWE-319) | Fixed: the provider documents no TLS endpoint for the proxy itself, so spec §10.3 now states the exposure (the CONNECT request, credential and target host cross in cleartext; the target's TLS is end to end) and its compensating control: the configured credential is a proxy-only user, never the account's API key, with a provider-side traffic limit where offered | `e8f9c5b` |
| W11 | 🟡 | Metering is split across three consumers | Fixed: tunnel() returns only the metered stream, which records its own break; proxy.mjs pipes it with no meter logic of its own; residential.leg() is the one leg shape every consumer uses | `dc39dd8` |
| W12 | 🟡 | Critical-path tests stub out the logic they should cover | Fixed: tests now drive the real search-leg factory; reconcile a day twice against PostgreSQL, on a day with no usage rows and outside a dedicated account; drive Decodo's usage-report branch against a stand-in API; cover fetchOnce's direct-cap refusal and a held domain; break a residential browser tunnel after it was up; and drive the gateway's job runner through every hold answer, requeue and release. The internal hold, release and reconcile handlers are exercised end to end by the M6 driver (B6, B12, and W4's replay), not by a unit test | `d6f2041` `9cf0f83` `ebbbe67` `21c1886` `d673d45` `3545c7b` `1c912b0` `92a1d20` |
| W13 | 🟡 | Reconciliation's usage query covers the whole account | Fixed: Decodo's report has no per-user filter, so a proxy provider declares usageDedicated and reconciliation refuses a report not declared to cover this deployment alone (RECONCILE_SCOPE_UNKNOWN, 409); Decodo stays undeclared until an account used only by this deployment is configured; tested | `ebbbe67` |
| S1 | 🔵 | The leg sequence is written three times | Fixed: settlement has one home (makeLegs close and closeOpen), the move at the direct cap one helper the HTTP and browser steps share (escalateAtCap), and the search leg one factory in residential.mjs. The six-line open-then-pace block stays in httpStep and fetchOnce, whose failures differ in shape (a returned fail against a thrown Denied) | `cb156a4` `19e5271` `d6f2041` |
| S2 | 🔵 | The route state carries the proxy password | Fixed: the credential is read inside tunnel() and the state carries only whether it is present; tested | `dc39dd8` |
| S3 | 🔵 | The credential file is read synchronously on every availability check | Fixed: cached for five seconds | `dc39dd8` |
| S4 | 🔵 | The engine route lookup is exact while allow matches patterns | Fixed: routes are matched as the allow-list matches hosts, and a live engine host the policy does not name goes residential; tested through the real factory | `d6f2041` |
| S5 | 🔵 | Concurrent first observations can lose an update, and eviction can drop an active preference | Fixed: the row is created before it is locked, and rows that decide nothing are evicted first; a learned preference goes only when preferences alone fill the table | `5034805` |
| S6 | 🔵 | The guard's proxy-port rule is by port only | Fixed: the guard's comment says the floor is by port, as for 80 and 443, and that the endpoint is the retrieval service's decision | `c3020ce` |
| S7 | 🔵 | Bytes after settlement go unmetered | Fixed: the tunnels are closed before the count is read | `7680e24` |
| S8 | 🔵 | A test assertion cannot fail | Fixed: the test asserts the meter's bytes against the cap and the row's recorded charge, which may now exceed the reservation | `7680e24` |
| S9 | 🔵 | The upstream stealth retry after stealthProxy: true is unchecked | Rejected, with the evidence: in the pinned source (7666c1f, apps/api/src/scraper/scrapeURL/index.ts:631-645) the retry that adds stealthProxy fires only for an engine result with status 401, 403 or 429 on an auto request; pi-resilient returns a result only when the retrieval service answered ok, and services/retrieval/src/quality.mjs:97,98,106 classify 429, 401 and 403 as failures, so the engine throws PiRetrievalError and the branch is unreachable. Were it reached, the rerun carries the same logicalAcquisitionId (meta.id) and draws on the same four-attempt budget; the engine-level flag (engines/index.ts:896) is inert because patch 0009 reads the route from meta.options.proxy |  |
| S10 | 🔵 | No index serves reconciliation's lookups | Fixed: a partial index on (provider, day_start) for the proxy and reconcile kinds | `dce03a2` |
| S11 | 🔵 | The evidence driver builds SQL by interpolation | Fixed: values reach psql as variables read as :'name'; checked against the pinned PostgreSQL image with a quote and a backslash | `8661527` |
| S12 | 🔵 | A capped HTTPS attempt may not be reported as SIZE_LIMIT | Fixed: a capped attempt is SIZE_LIMIT whatever error the cut surfaced as, so it never earns a same-tier retry | `7680e24` |
| S13 | 🔵 | A tunnel is left open when a request is refused early | Fixed: a request refused before it was written closes the tunnel opened for it | `cb156a4` |
| S14 | 🔵 | A CONNECT still pending when a render ends lingers | Fixed: the browser's connection joins its session before the leg is awaited, and a tunnel whose client left while it opened is closed at once | `cb156a4` |
| S15 | 🔵 | A fast or non-page script shell resets the browser learning | Fixed: a script shell returned unrendered is not learned as an adequate HTTP answer | `19e5271` |
| S16 | 🔵 | A hold can outlive a job cancelled before submission | Fixed: a held job that goes back to the queue releases its hold and places it again at its next dispatch, so a queued or cancelled-before-submission job holds nothing; tested | `3545c7b` |
| S17 | 🔵 | An auto browser attempt at the direct cap does not escalate | Fixed: it moves to the residential browser through the helper the HTTP step uses; tested | `19e5271` |
| S18 | 🔵 | A malformed proxy credential name surfaces as a 500 | Fixed: a name with anything but letters, digits and underscores is refused as BLOCKED_CREDENTIAL; tested | `dc39dd8` |
