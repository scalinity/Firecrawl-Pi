## Code Review: SI1 — General discovery, ledger reporting, availability and the aggregate coordinator

### Summary

Two fresh-context reviewers read `main..bdf91d8` (`2a6251333e3fa1572af25cd2e8aec375b5a955be..bdf91d8477d5483664dfba77f697c58340e9eae2`, 38 files, +9,401/−112) read-only, both on `claude-opus-5-5`: DB1 (debugger lane: logic, runtime, integration) and CA1 (code-auditor lane: architecture, data integrity, security, performance). The review model is the canonical one, so no model substitution applies. One procedural substitution: the runtime offers no `TeamCreate`, so the two reviewers ran as named background `Agent` teammates and their reports were read from their own transcripts. The orchestrator checked both critical traces against the code before accepting them: `common.mjs:113/127` and `:55-56` give one result two breaker verdicts, and `coordinator.mjs:266` aborts an abandoned flight without closing it.

The ledger discipline holds (reserve, then permit, then send, with exactly one close; no transaction across network I/O; an unsent/uncertain split carried through the transport). Three defects block acceptance: the breaker counts every failed call twice, an abandoned search stays joinable, and the Serper lane writes availability under the live provider's name whatever the selection.

Findings are merged across the two lanes; where both flagged the same defect, the source column names both.

### 🔴 Critical Issues (Must Fix)

1. **C1 — Every failed metered call gives the breaker two verdicts** - `services/retrieval/src/search-intelligence/adapters/common.mjs:52-58,108-128`; callers `adapters/brave.mjs:47`, `exa.mjs:33`, `deepseek.mjs:44`, `tavily.mjs:35` (DB1-C1, CA1-W1)
   - Problem: `call()` judges the breaker on every `ok:false` path (`failure()` for a possibly-sent timeout or unavailability, `neutral()` otherwise). Each adapter then passes the same result to `report()`, which judges it again.
   - Risk:
     - (a) Two possibly-sent timeouts within 60 s count four failures, so the breaker opens for five minutes after two failed calls; the configured threshold is three (`budget.json` `breaker.failures`). `si-discovery.test.mjs` passes only because it never counts the requests actually sent.
     - (b) In half-open state, a concurrent search refused by `admit()` returns `breaker_open`. `report()` then calls `neutral()`, which clears the in-flight probe's `probing` flag, so a third search sends a second paid probe, and a failed first probe no longer reopens the breaker.
     - (c) A local refusal before send (`NOT_READY`, an SSRF denial, a deadline that passed) is neutral in `call()` but becomes `failure()` in `report()`, so a local condition trips all four metered breakers.
   - Fix:
```js
// common.mjs: call() owns the breaker's verdict for every ok:false result; report() on that path only informs availability.
async function report(sub, epoch, result, { answered = true } = {}) {
  const br = breakerFor(sub.provider);
  if (result.success) { br.success(); await availability.observe(sub.provider, epoch, { success: true }); return; }
  if (answered) { if (["timeout", "temporarily_unavailable"].includes(result.reason)) br.failure(); else br.neutral(); }
  if (["quota_exhausted", "rate_limited", "auth_failed", "contract_failure"].includes(result.reason)) await availability.observe(sub.provider, epoch, result);
}
// adapters: if (!res.ok) { await dispatch.report(ctx.sub, ctx.pre.epoch, { reason: res.reason }, { answered: false }); ... }
```

2. **C2 — An abandoned search stays joinable, so an identical retry is answered CANCELLED** - `services/retrieval/src/search-intelligence/coordinator.mjs:140-148,168,256-266`; `services/retrieval/src/search.mjs` `backendGet` (DB1-C2)
   - Problem: When the last subscriber leaves, `leave()` aborts the flight's controller but neither marks it closed nor removes it from `flights`; only `execute()`'s `finally` does. During the wind-down, cancelled general lanes resolve `failed`, which launches the SearXNG fallback on the already-aborted parent, and `backendGet` adds its listener to a signal that is already aborted, so that request runs to completion or its deadline.
   - Risk: Caller A searches "q" and disconnects at t≈1 s. The lanes return cancelled, SearXNG fallback starts and runs for seconds. At t≈2 s caller B sends the same query in the same deadline class, finds the flight with `closed=false`, subscribes, and `execute` throws `Denied("CANCELLED")` at `:168`: B never cancelled but receives HTTP 499 after waiting.
   - Fix:
```js
// coordinator.mjs: abandoned or expired work is never joinable
const close = (fl) => { fl.closed = true; if (flights.get(aggKey) === fl) flights.delete(aggKey); fl.controller.abort(); };
const leave = () => { f.subscribers--; if (f.subscribers <= 0 && !f.closed) close(f); };
// execute(): nothing new starts after cancellation
const launchSearxng = (why) => { if (searxngTask || !searxng || parent.signal.aborted) return; /* ... */ };
// search.mjs backendGet, first line of the Promise executor:
if (signal?.aborted) return reject(new Denied("CANCELLED", "the caller cancelled"));
```

3. **C3 — The Serper lane records availability under the live provider's name whatever the selection** - `services/retrieval/src/search-intelligence/adapters/serper.mjs:44,49` (CA1-C1, DB1-W1)
   - Problem: Preflight reads availability for `sub.provider` (`fixture-serper` under the fixture roster), but the lane writes `availability.observe("serper", …)` with a literal name. Fixture outcomes land on the live row in `provider_availability`, which persists across restarts, and the fixture's own row is never written. This breaks the fixture fence of spec §19.2, and no test covers Serper availability.
   - Risk: The live Serper key fails, so the `serper` row becomes `auth_failed`. A verification run switches the selection to fixture; the fixture answers 200 and `observe("serper", …, {success:true})` resets the live row to `available`. Back on live, preflight admits the bad key, the 401 marks the reservation UNCERTAIN, and one of the 2,443 lifetime credits is held for good, once per fixture/live cycle. In the other direction a fixture 429 pauses live Serper.
   - Fix:
```js
// adapters/serper.mjs
await availability.observe(ctx.sub.provider, ctx.pre.epoch, { success: true });
if (["rate_limited", "auth_failed"].includes(reason)) await availability.observe(ctx.sub.provider, ctx.pre.epoch, { reason, providerCode: detail, detail });
```

### 🟡 Warnings (Should Fix)

1. **W1 — Serper deadline timeouts are reported as `temporarily_unavailable`, or as `not_sent` while the ledger row is UNCERTAIN** - `services/retrieval/src/search-intelligence/adapters/serper.mjs:11-27,50`; `services/retrieval/src/serper.mjs:83-87` (DB1-W2)
   - Problem: `reasonOf` maps neither `PROVIDER_TIMEOUT` nor `PROVIDER_UNCERTAIN` with `timedOut` to `timeout`, and an abort racing `markBudgetUncertain` yields an error without `sent`, reported as `not_sent`.
   - Suggestion: Map `PROVIDER_TIMEOUT` and any `timedOut` error to `timeout`, and report `dispatchState: e.sent === false ? "not_sent" : "possibly_sent"`.

2. **W2 — One lane's rate-limit wait delays the launch of every general lane** - `services/retrieval/src/search-intelligence/coordinator.mjs:99-101,130-135` (DB1-W3)
   - Problem: `generalTasks` are built only after `Promise.all(generalAdmits)`, so one lane's wait of up to 2 s holds back all five launches, against spec §5.1.
   - Suggestion: Chain admit and run per lane, deciding the `general_lane_ineligible` fallback as each admit resolves.

3. **W3 — The whole-answer cache is never written, its test says the opposite, and the hit path is untested** - `services/retrieval/src/search-intelligence/coordinator.mjs:191,237,282-293`; `services/retrieval/test/si-discovery.test.mjs:261-274` (DB1-W4, CA1-W5)
   - Problem: No code produces ranking mode `"rrf"`; without a decision layer the mode is `rrf_fallback`, so `cachePut(aggKey)` never runs. Every repeated search spends an hourly admission that the legacy profile served from cache. The test titled "cached whole and served again without admission" asserts two admissions; `personalize`'s hit branch has no test.
   - Suggestion: Decide explicitly whether an answer ranked without a configured decision layer is cacheable, and add a hit-path test (zero admissions, `cache.mode: "hit"`, `reuseOf`, empty `usage`).

4. **W4 — A reused Serper call key is reported as quota exhausted** - `services/retrieval/src/serper.mjs:48`; `services/retrieval/src/search-intelligence/adapters/serper.mjs:17` (DB1-W5, CA1-W4)
   - Problem: Call keys are stable per `logicalSearchId`; a retry gets `{existing}` from `reserveBudget`, which becomes `SEARCH_CREDITS_EXHAUSTED` and `quota_exhausted/local_allocation_exhausted`.
   - Suggestion: Distinguish `r.existing` and report it as `internal_failure/operation_already_recorded`, as `common.mjs` does.

5. **W5 — Tavily and Exa release 4xx reservations whose non-billing is not established** - `services/retrieval/src/search-intelligence/adapters/tavily.mjs:45`, `exa.mjs:45` (CA1-W2)
   - Problem: Spec §18.2 releases only on non-dispatch or an authoritative non-billable refusal. SI0's contract evidence records Tavily's failed-request billing as NOT ESTABLISHED and documents only Exa's 503 as unbilled, yet every Tavily 4xx and every Exa status below 500 is released.
   - Suggestion: Mark undocumented refusals UNCERTAIN, keeping RELEASED only where the evidence states non-billing.

6. **W6 — The accounting-failure counter is never incremented** - `services/retrieval/src/search-intelligence/coordinator.mjs:32,337`; `services/retrieval/src/server.mjs:149` (CA1-W3)
   - Problem: `makeDispatch` accepts `onAccountingFailure`, but `server.mjs` never passes it, so `/internal/providers` always reports `accountingFailures: 0`.
   - Suggestion: Count in `makeDispatch` and report that count; test it with a throwing `settleBudget`.

7. **W7 — Critical concurrency, availability and ledger-closing paths have no tests** - `permits.mjs`, `availability.mjs:93-99`, `coordinator.mjs:256-279,331-336`, the four adapters (DB1-W6, CA1-W6)
   - Problem: Untested: `PermitPool` fairness, cancellation and deadline paths; `TokenBucket`; the three-contract-failure hold and its probe; one half-open probe under concurrency; an abandoned flight rejoined; Brave non-200 → RELEASED; DeepSeek empty → SETTLED 0 and malformed → UNCERTAIN; Exa without `costDollars`; Tavily 5xx → UNCERTAIN; `drain()` with a reservation in flight.
   - Suggestion: Add focused tests for each, asserting ledger state and actual amount.

### 🔵 Suggestions (Consider)

1. **S1 — The lane grace equals the response margin** - `coordinator.mjs:80,119` (DB1-S1). Current: a stuck lane returns at `deadlineAt + 250`, which under short deadlines races the caller's own timeout. Better: bound lanes at `discoveryClose` and keep the grace within the margin.
2. **S2 — Availability updates are last-writer-wins** - `availability.mjs:51-55,82-84` (DB1-S2). Current: `refresh()` replaces rows wholesale and a late success overwrites a newer refusal. Better: merge by `updated_at`; a success does not clear a state observed after its dispatch.
3. **S3 — `retryAt` has two types** - `coordinator.mjs:104,211` (DB1-S3). Current: ISO strings for skipped lanes, epoch milliseconds for failed ones. Better: ISO in both.
4. **S4 — The missing-adapter skip is keyed by the budget provider name** - `coordinator.mjs:96` (DB1-S4). Better: key it by the API's lane id.
5. **S5 — `legacyAsInternal` forwards languages the legacy facade rejects** - `coordinator.mjs:300-303` (DB1-S5). Current: `es-419` passes request validation and fails `/^[A-Za-z-]{1,16}$/`. Better: map to the primary subtag or `auto`.
6. **S6 — `connect()` uses `availability` before its declaration** - `server.mjs:103` vs `:147` (DB1-S6). Better: declare it first.
7. **S7 — Exactly-once close depends on each adapter remembering it** - `common.mjs:130` (CA1-S1). Better: a `finish()` that marks an unclosed row UNCERTAIN in `runLane`'s `finally`.
8. **S8 — `PermitPool` keeps one map entry per search forever** - `permits.mjs:17-23` (CA1-S2). Better: delete the key when its count reaches zero.
9. **S9 — `paidTotalRate` falls back to 1** - `common.mjs:93` (CA1-S3). Better: refuse in `call()` too when a paid-total cap exists without a valuation.
10. **S10 — The global API permit is held while waiting for DeepSeek's token** - `common.mjs:113-114` (CA1-S4). Better: take the token before the permit.
11. **S11 — [PRE-EXISTING] Serper's lifetime SUM scans the whole table** - `store.mjs:238` (CA1-S5). Better: an index on `budget_reservation(category)`.
12. **S12 — The fixture Serper inherits the live lifetime cap and its rows are never pruned** - `serper.mjs`, `server.mjs:108` (CA1-S6). Better: apply the lifetime cap to live subjects only and prune fixture categories.
13. **S13 — `snippets` is produced but never read** - `brave.mjs:76`, `exa.mjs:63` vs `normalize.mjs:106` (CA1-S7). Better: map them to `passages` or stop requesting them.
14. **S14 — The aggregate key leaves out limits that shape the answer** - `coordinator.mjs:46-51` (CA1-S8). Better: include the policy and budget hashes.
15. **S15 — Coalesced callers each carry the full `usage`** - `coordinator.mjs:282-293` (CA1-S9). Better: `usage: []` with `usageOf` for subscribers that did not run the execution.
16. **S16 — The unauthenticated legacy GET fans out to five metered providers (CWE-306, bounded)** - `server.mjs:284` (CA1-S10). Current: only the core shares `fcpi_acquire`, and `perHour` bounds it. Better: retire the aggregate path there once the core uses `POST /internal/search`.
17. **S17 — The four HTTP adapters repeat one skeleton** - `brave.mjs`, `exa.mjs`, `deepseek.mjs`, `tavily.mjs` (CA1-S11). Better: one shared metered-search helper.
18. **S18 — Two statements on one line** - `budget.mjs:302` (CA1-S12).
19. **S19 — The canonical texts disagree on unknown prices** - `deploy/policies/budget.json` Brave `microUsdPerRequest: null` (CA1-S13). Current: CLAUDE.md §11 says fail closed on unknown price; spec §18.1 dispatches Brave at an unknown monetary price. Better: reconcile the canonical wording.

### ✅ Good Practices

- Reservation always precedes dispatch, and a ledger outage returns `not_sent` with no request made.
- `providerRequest` watches the caller's signal and an absolute deadline from its first line, races DNS, and a late lookup opens no socket; it also removed an older listener leak and an already-aborted send.
- `closer.once` settles a reservation at most once and never reports a ledger failure as zero cost.
- Reporting-only periods are a nullable cap inside the existing locked UPDATE, the exact period list is stored on the reservation, and real-PostgreSQL tests cover concurrency, cross-month settlement, idempotent release and re-applying the schema over a populated database.
- Fixed origins come from `SEARCH_APIS`; a live provider cannot point at a fixture or the reverse; credentials travel only in headers, and nothing secret reaches cache keys, logs or `/internal/providers`.
- Availability is kept apart from the breakers, with documented, estimated or unknown retry bases, and nothing polls a paid provider for a top-up.
- Only validated success or empty answers enter the provider cache; SearXNG is never cached as a lane; a partial answer is never stored under the complete key.
- Factoring out `makeSearxngBackend` keeps the legacy facade's behavior identical.

### Verdict

[x] ❌ Request Changes (critical issues)
[ ] ⚠️ Approve with Suggestions
[ ] ✅ Approve

## Found during remediation

Defects outside the reviewers' reports, found while fixing them; each is the same class as a reviewed finding, in code the review range did not cover or in a path it did not name.

1. **F1 — Serper's own breaker counted a local refusal before send as a provider failure** - `services/retrieval/src/serper.mjs` catch block. The C1(c) defect in the adapter that keeps its own breaker: `NOT_READY`, an SSRF denial, an expired deadline or the paid lease opened Serper's breaker after three occurrences in a minute.
2. **F2 — The decision layer and the Context7 adapter judged an unanswered call twice** - `services/retrieval/src/search-intelligence/decisions.mjs`, `adapters/context7.mjs` (SI2 code, committed after the reviewed range). The C1 double verdict, in the two adapters written before the fix.
3. **F3 — Jev, Context7 and Ref released refusals whose charging is not documented** - `decisions.mjs`, `adapters/context7.mjs`, `adapters/ref.mjs` (SI2 code). The W5 rule: SI0's contract evidence records each provider's charging of a failed call as not established, yet OpenRouter and Context7 refusals below 500 and Ref's in-band authentication refusal were released.

## Finding dispositions

Each row states one of CLAUDE.md §5's outcomes. Every fix commit's tests were run against the unfixed source as well (the working tree's tests over `HEAD`'s files): each new or tightened test failed there and passes with the fix.

| ID | Severity | Finding | Outcome |
|---|---|---|---|
| C1 | Critical | Breaker gets two verdicts per failed call | Fixed in `4661759`: `call()` owns the verdict for an unanswered result and `report()` takes `{ answered: false }`; an unsent call counts only when the provider was unreachable. Tests: DeepSeek's breaker opens on the third sent request, two failures leave it closed, one half-open probe under sequential siblings, `NOT_READY` judges nothing. |
| C2 | Critical | Abandoned search stays joinable | Fixed in `2f83a7a`: closing a flight removes it from the map before aborting; no SearXNG launch after abort; `backendGet` refuses an aborted signal before connecting and removes its listener. Test reproduces DB1's trace (the unfixed code answers the second caller CANCELLED). |
| C3 | Critical | Serper availability written under the live name | Fixed in `711bf1e`: availability and the outbound permit use `ctx.sub.provider`. Test: a fixture 429 cools `fixture-serper` and never writes the live row. |
| W1 | Warning | Serper timeout reason and dispatch state | Fixed in `70ea6df`: every Serper failure carries `sent` and `timedOut`; `PROVIDER_TIMEOUT`/`timedOut` map to `timeout`; `not_sent` only when the error says so. Test: a stalled Serper is `timeout`/`possibly_sent` with its row UNCERTAIN. |
| W2 | Warning | One lane's rate wait delays all launches | Fixed in `b7e16dd`: each lane chains its own admission and launch, the ineligible-lane fallback is decided per admission, and a throwing admission resolves to `internal_failure`. Test: Exa rate-limited 1.2 s, the other four dispatched at once. |
| W3 | Warning | Whole-answer cache never written | Fixed in `3be21f1`: a complete answer is stored whole when hybrid-ranked or ranked deterministically because no decision layer is configured (the key carries the decision identity); a fallback from a configured layer is not. The misnamed test now drives the hit path (no admission, empty usage, `reuseOf`, the legacy `hit`); a stub decision layer shows the degraded answer is not stored. |
| W4 | Warning | Reused Serper key reported as quota exhausted | Fixed in `20941f5`: an existing call key throws `SEARCH_OPERATION_RECORDED` and the lane reports `internal_failure/operation_already_recorded`, `possibly_sent`. |
| W5 | Warning | Tavily/Exa 4xx released without established non-billing | Fixed in `372b995`: Exa releases only its documented-unbilled 503; every answered Tavily failure stays UNCERTAIN; Brave and DeepSeek, documented as success-only billing, still release. |
| W6 | Warning | Accounting-failure counter never incremented | Fixed in `0d167f6`: the dispatch counts each failed closing and the coordinator reports that count. Test: four refused settlements count four, logged, rows RESERVED. |
| W7 | Warning | Missing concurrency, availability and ledger-closing tests | Fixed in `a2b6a81` (permit pools, token bucket, contract hold, DeepSeek free empty and malformed 200, Exa estimated cost, Tavily 5xx, Brave by error code, drain mid-search, deadline classes), with the half-open and abandoned-flight cases in `4661759` and `2f83a7a`. |
| S1 | Suggestion | Lane grace equals response margin | Fixed in `41e6acf`: the grace is at most half the response margin. Test: a lane stuck behind a hung ledger under a 3 s deadline still yields the partial answer (the unfixed code fails with SEARCH_TIMEOUT). |
| S2 | Suggestion | Availability last-writer-wins | Fixed in `3113471`: `refresh()` keeps rows written during its read or still being written; every success carries its dispatch time and does not clear a refusal observed after it. |
| S3 | Suggestion | `retryAt` two types | Fixed in `cd0d322`: the provider summary renders `retryAt` as ISO 8601 UTC for failed and skipped lanes alike. |
| S4 | Suggestion | Missing-adapter skip key | Fixed in `eb79b37`: `SEARCH_APIS` names each API's lane id and the skip uses it. |
| S5 | Suggestion | Legacy language subtags | Fixed in `7655c16`: a tag the legacy facade refuses (`es-419`) reaches it as its primary subtag. |
| S6 | Suggestion | `availability` used before declaration | Fixed in `41820f9`: declared beside the store, before `connect()`; no behavior change. |
| S7 | Suggestion | Exactly-once close relies on adapters | Fixed in `52480c7`: closers register under their lane's preflight object and `runLane` marks what an ended adapter left open UNCERTAIN. |
| S8 | Suggestion | PermitPool entries never deleted | Fixed in `e6ad788`: a key whose count reaches zero is deleted. |
| S9 | Suggestion | `paidTotalRate` fallback to 1 | Fixed in `e1a65b4`: `call()` refuses `valuation_unavailable` itself when a paid-total cap applies and the unit has no valuation. |
| S10 | Suggestion | API permit held while waiting for DeepSeek's token | Rejected, with the evidence: taking the token before the permit lets tokens wait out a permit and then be spent together, bursting past DeepSeek's documented 5 QPS on the wire, the limit the bucket exists to keep; the per-provider permit cap bounds the current order's cost to 4 of 28 global permits for at most 0.8 s. The reason is recorded where the order is decided (`69055ce`, `fdc039d`). |
| S11 | Suggestion | Serper lifetime SUM without index | Fixed in `ef0683f`: `budget_reservation_category` index, idempotent; the migration test checks it exists over the baseline and that the planner uses it for the sum. |
| S12 | Suggestion | Fixture Serper lifetime cap and retention | Fixed in `0a52122`: a fixture provider reserves without the lifetime cap, and the retained categories are live Serper's, computed from the current budget at each prune. |
| S13 | Suggestion | `snippets` unread | Fixed in `b41bf10`: provider snippets become `provider_snippet` passages, read by literal relevance and Jev's excerpts. |
| S14 | Suggestion | Aggregate key omits policy limits | Fixed in `86e91a6`: the key includes the policy's search-intelligence limits. |
| S15 | Suggestion | Coalesced callers carry full usage | Fixed in `51b05c3`: a joining caller reports `usage: []` and `usageOf` naming the execution's search. |
| S16 | Suggestion | Unauthenticated legacy GET fan-out | Rejected, with the evidence: spec §19.2 requires keeping legacy `GET /searxng/search` on its existing internal network as a compatibility wrapper with validated defaults and no caller-controlled trusted context, which is what it does. Its listener (`PI_RETRIEVAL_LISTEN` 10.231.5.10:3310) is on `fcpi_acquire`, an `internal: true`, isolated bridge whose only members are `firecrawl-core` and `retrieval-service` (`deploy/compose.yaml:306`, `:615`, `:945`); upstream's search client sends no credential; and every execution passes the shared 60/hour admission. The v2 search controller no longer uses it (patch 0011 sends every v2 search to the authenticated `POST /internal/search`). |
| S17 | Suggestion | Adapter skeleton repeated | Fixed in `b52f498`: `meteredSearch()` in `common.mjs` holds the dispatch, unanswered verdict, refusal and 200 closings, shape check, mapping and success report once; each adapter supplies only its provider's contract. Behavior unchanged: the full retrieval suite passes, 375 tests with PostgreSQL. |
| S18 | Suggestion | Two statements on one line | Fixed in `4ddbdee`: the SearXNG mode default is on its own line. |
| S19 | Suggestion | Canonical texts disagree on unknown prices | Deferred to SI6, whose scope is the canonical-document reconciliation: editing CLAUDE.md requires AGENTS.md byte-identical and ORCHESTRATION.html's embedded snapshot, hashes and ranges refreshed in the same commit (CLAUDE.md §33.4). The code already follows the SI spec (§18.1: an unknown price is never zero, and blocks dispatch only when an applicable monetary cap cannot be evaluated, as `valuation_unavailable`). Proposed CLAUDE.md §11 wording for SI6: "fail closed when an applicable spending cap cannot be evaluated because a price is unknown; never count an unknown price as zero." |
| F1 | Found | Serper's breaker counted local refusals | Fixed in `68c7b50`: a transport error never sent is neutral unless the provider was unreachable; the `NOT_READY` test covers Serper's breaker and rows. |
| F2 | Found | Jev and Context7 judged unanswered calls twice | Fixed in `fad33c3`: both report such results with `{ answered: false }`; new tests drive both through the shared dispatch. |
| F3 | Found | Jev, Context7 and Ref released undocumented refusals | Fixed in `92eb82b`: answered failures stay UNCERTAIN; Context7's documented no-documentation 404 still settles one request. |
