## Code Review: SI4 — Durable operational evidence

### Summary

Two fresh-context reviewers read SI4's changeset (`d3d6d19..HEAD` at review time) read-only, both on `claude-opus-5-5`: DB1 (`db1-bugs-si4`, debugger lane: logic, runtime, integration) and CA1 (`ca1-audit-si4`, code-auditor lane: architecture, privacy, data integrity, performance, test quality). `telemetry.mjs` is new and was read whole; the shared files were reviewed in their telemetry, recording, reduction, retention and status hunks. The two reports are merged here with duplicates combined.

The design holds: writes are best effort with a bounded, counted backlog; usage comes from the ledger only; a day is recomputed whole in one transaction under an advisory lock, and the watermark only moves forward; SQL parameter numbering and the Store/FakeStore/telemetry shapes match; days are read as text and bounded in UTC.

One defect blocks acceptance, found by both reviewers: a cancelled search's run is recorded with none of the lane outcomes it had already dispatched and paid for. The warnings concern retention against the reduction (sources deleted before the reduction is done with them), usage relabelled after 30 days, the trace kept past the spec's 14 days, an unkeyed fingerprint described as private, unrecorded Serper breaker transitions, coalesced callers and refusals, telemetry's unguarded synchronous half, the reduction's cost under a backlog, an unread policy bound, events with no ledger reference, and test gaps.

**Scope:** nine files: `src/search-intelligence/telemetry.mjs` (new), `coordinator.mjs` (run records), `src/store.mjs` (run, event, reduction and prune SQL), `deploy/nuq-postgres/fcpi-retrieval-schema.sql` (SI4 tables), `src/server.mjs` (wiring, hourly maintenance, stop drain, status), `adapters/common.mjs` (watched breakers), `test/si-telemetry.test.mjs`, `test/si-records.test.mjs`, `test/si-helpers.mjs`.

### 🔴 Critical Issues (Must Fix)

1. **C1 — A cancelled search's run is recorded with none of its lane outcomes** - `services/retrieval/src/search-intelligence/coordinator.mjs` (`execute`, the cancellation check before `seen` is assigned) (DB1, CA1)
   - Problem: `seen.lanes` and `seen.activation` are assigned after the cancellation throw, although every lane outcome and the activation have already been awaited by then.
   - Risk: a caller disconnects, an MCP cancel arrives, the flight's deadline fires or a stop drains during discovery. The lanes return (Brave, Exa, Tavily or DeepSeek may already have succeeded and spent), the check throws `CANCELLED`, and `finally` records `{ outcome: "cancelled", lanes: [], activation: null }`. No `lane` or `docs_activation` event is written for operations that were dispatched, contrary to spec §21.1 ("every external operation outcome … never sampled away"). The cancelled test checks only the run's outcome, so it passes.
   - Fix:
     ```js
     const all = [...generalOutcomes, ...docsOutcomes, ...(searxngOutcome ? [searxngOutcome] : [])];
     Object.assign(seen, { lanes: all, activation });
     if (parent.signal.aborted && signal.aborted) throw new Denied("CANCELLED", "the caller cancelled");
     ```
     and assert the cancelled run's lane events in `si-records.test.mjs`.

### 🟡 Warnings (Should Fix)

1. **W1 — Retention can delete sources the next reduction recomputes from** - `services/retrieval/src/store.mjs` (`pruneSearchState`, `reduceSearchDaily`); `services/retrieval/src/server.mjs` (hourly maintenance) (DB1, CA1)
   - Problem: each pass re-reduces the watermark's own day (`from = reduced_through`), but prune deletes events on that day (`<=`) once 14 days old and deletes runs at 30 days with no watermark gate; prune also runs when the reduction failed. After a stall of 14 days or more, the first good pass rebuilds day w from partial sources; past 30 days, unreduced runs are deleted outright. Spec §21.1: "Retain source events until the reduction checkpoint succeeds."
   - Suggestion: gate both deletes strictly below the watermark, and test prune-then-reduce under a stalled watermark.

2. **W2 — Usage aggregates change profile when their run row expires, and the oldest day shrinks** - `services/retrieval/src/store.mjs` (usage recompute; ledger prune) (DB1, CA1)
   - Problem: usage for the last 90 days is recomputed every hour with its profile from `LEFT JOIN search_run`, but runs are pruned at 30 days, so days 31–90 move from `aggregate/<selection>` to `unlinked` and merge with usage that was never linked. The same ledger rows give different aggregates as retention moves. Separately, settled ledger rows are deleted at `created_at < now() − 90 days` while the recompute covers `day ≥ today − 90`, so that day's total shrinks through its last day.
   - Suggestion: take the usage dimension from something that lives as long as the ledger row, and recompute only days whose sources are complete; test a run older than 30 days.

3. **W3 — The candidate trace is kept 30 days; the spec says 14** - `services/retrieval/src/store.mjs` (prune); `deploy/nuq-postgres/fcpi-retrieval-schema.sql` (DB1, CA1)
   - Problem: spec §21.1 gives candidate trace metadata the 14-day detailed-event retention. The trace lives on `search_run` and goes only with the row at 30 days. It is the most revealing part of a run (up to 128 candidate URLs with Jev's per-document labels) and its largest value (up to 64 KiB).
   - Suggestion: clear `trace` after 14 days in prune, say so in the schema comment, and test it.

4. **W4 — Serper's breaker transitions are never recorded** - `services/retrieval/src/server.mjs`; `services/retrieval/src/serper.mjs` (DB1)
   - Problem: only `makeDispatch`'s breakers are wrapped by `watched`. Serper's lane checks `serper.breakerState`, and its calls go through `serper.mjs`'s own Breaker, so Serper's openings and closings write no `breaker` event ("every circuit transition captured"). The records test covers only DeepSeek.
   - Suggestion: give `makeSerper` the same `onBreaker` hook.

5. **W5 — Telemetry's synchronous work is unguarded on the search path** - `services/retrieval/src/search-intelligence/telemetry.mjs`; `coordinator.mjs` (DB1, CA1)
   - Problem: `write()` catches store failures, but `fingerprint`, `boundedTrace`, the summary and the event building run inline in `execute()`. A throw there discards a computed answer, `finally` then calls `runFinished` again, and a throw inside `finally` replaces the original `Denied` (CANCELLED becomes a 500). No current input was found that throws; spec §21.2 says telemetry must not fail a useful search.
   - Suggestion: guard every telemetry entry point inside `telemetry.mjs`, counting and logging what it catches.

6. **W6 — The query fingerprint is an unkeyed SHA-256 described as private (CWE-759)** - `services/retrieval/src/search-intelligence/telemetry.mjs`; `deploy/nuq-postgres/fcpi-retrieval-schema.sql` (CA1)
   - Problem: every field hashed besides the query has a handful of values, so a common query is recovered by hashing guesses. Spec §20 asks for a keyed fingerprint where an existing secret allows it; `server.mjs` already derives a keyed URL HMAC from `retrieval_browser_token` with a domain label.
   - Suggestion: key the fingerprint the same way (domain label `fcpi.search.fingerprint.v1`).

7. **W7 — Coalesced callers and admission refusals leave no record** - `services/retrieval/src/search-intelligence/coordinator.mjs` (`search`, admission) (CA1)
   - Problem: a caller that joins an in-flight execution never reaches `execute()`, so no run exists for its `logicalSearchId` or `jobId`: §21.2's caller-request count cannot be derived, the core's evidence call (which sends the caller's own logical id) joins no run, and the caller's job's acquisitions join nothing. `SEARCH_RATE_LIMITED` refusals are likewise invisible.
   - Suggestion: record a joined caller's run with no lanes and no usage, so spend stays with the executing run; record refusals.

8. **W8 — The reduction's cost grows with its backlog, and it cannot catch up under the 10 s statement timeout** - `services/retrieval/src/store.mjs` (`reduceSearchDaily`) (CA1)
   - Problem: the histogram is a correlated subquery rescanning the materialized CTE per group (groups × rows); the range `[watermark, yesterday]` is unbounded; the `::date BETWEEN` predicates cannot use the time indexes; the pool's `statement_timeout` is 10 s. Steady state is fine, but after a 14-day stall at the admission ceiling (about 19k rows a day) each pass times out while the range grows, which with W1 turns a stall into loss.
   - Suggestion: build histograms with a second GROUP BY, bound each pass's range, and use range predicates the indexes serve.

9. **W9 — The policy's trace ceiling is validated but never read** - `services/retrieval/src/search-intelligence/telemetry.mjs`; `services/retrieval/src/policy.mjs`; `deploy/policies/egress.json` (CA1)
   - Problem: `search.intelligence.traceMaxBytes` is validated to 4096–65536 to bound this trace, but `boundedTrace` uses the constant `TRACE_BYTES` (CLAUDE.md §21: consumed, not merely documented).
   - Suggestion: pass the policy's value to `boundedTrace`.

10. **W10 — Events carry no reference to their ledger reservations** - `deploy/nuq-postgres/fcpi-retrieval-schema.sql`; `services/retrieval/src/search-intelligence/telemetry.mjs` (CA1)
    - Problem: §21.1 lists a "ledger reservation reference" among an event's fields and the schema comment says rows "refer to it by logical id and call key", but no column holds a call key and outcomes do not carry them. Joining by `(logical_id, provider)` is ambiguous for providers with several metered calls per run (Ref's context, search and reads; Jev's docs detection and rerank batches). `detail.usage` and `summary.usage` copy response-time usage.
    - Suggestion: carry each outcome's reserved call keys into its event and store them; label the usage copies as response-time observations.

11. **W11 — The tests miss the paths SI4's guarantees rest on** - `services/retrieval/test/si-telemetry.test.mjs`; `services/retrieval/test/si-records.test.mjs` (CA1)
    - Problem: nothing re-reduces the watermark day, checks that today stays out of `through`, or reduces empty tables; no PG test checks the profile dimension (`process`, `unlinked`, run-pruned usage); the 64 KiB trace ceiling is never reached; `drain()` returning a remainder, `MAX_STARTED` eviction, the stop sequence and the status counters are untested; cancelled-run lane events, coalesced callers and prune under a stalled watermark are not covered; `telemetryLost >= 2` asserts a range where the count is exact.

### 🔵 Suggestions (Consider)

1. **S1 — Trace bound accounting** - `services/retrieval/src/search-intelligence/telemetry.mjs` (`boundedTrace`) (DB1, CA1): the `truncated` marker is added after the size loop, so the trace can pass its bound by the marker's size; `duplicates.slice(0, 20)` drops pairs without marking; each pop re-serializes the whole trace.
2. **S2 — A deadline expiry is recorded as a cancellation** - `services/retrieval/src/search-intelligence/coordinator.mjs` (DB1, CA1): the flight's deadline close is `cancelled`; telling a timeout from a caller's cancel needs `request.absoluteDeadlineMs <= clock()`.
3. **S3 — FakeStore does not follow the real SQL** - `services/retrieval/test/si-helpers.mjs` (DB1, CA1): `searchRunFinished` replaces the whole row where the upsert keeps `accepted_at`, `versions` and `job_id`; `searchEvents` returns `events.length` where the real one returns the inserted count.
4. **S4 — The first reduction runs an hour after start** - `services/retrieval/src/server.mjs` (DB1, CA1): a service restarted more often than hourly never reduces or prunes. Run one pass shortly after the store is ready.
5. **S5 — Spurious `available→available` transitions are persisted** - `services/retrieval/src/search-intelligence/availability.mjs` (DB1, pre-existing): with no prior row, `undefined !== "available"` fires. Compare against `prior?.state ?? "available"`.
6. **S6 — The evidence event carries no duration** - `services/retrieval/src/search-intelligence/coordinator.mjs` (DB1): spec §21.2 lists evidence timings.
7. **S7 — The new CHECK constraints cannot evolve on an existing database** - `deploy/nuq-postgres/fcpi-retrieval-schema.sql` (CA1): they are inline in `CREATE TABLE IF NOT EXISTS`, and one rejected row loses its run's whole multi-row insert. Use the file's `DROP CONSTRAINT IF EXISTS` / `ADD CONSTRAINT` pattern.
8. **S8 — Breakers are patched in place and the helpers' mappings have drifted** - `services/retrieval/src/search-intelligence/adapters/common.mjs`; `services/retrieval/test/si-helpers.mjs` (CA1): the helpers' transition mappers leave out `retryBasis` and `retryAfterS`.
9. **S9 — The "recorded once" rule is spread over four call sites** - `services/retrieval/src/search-intelligence/coordinator.mjs` (CA1).
10. **S10 — What the daily metrics mean** - `services/retrieval/src/store.mjs` (CA1): cache-hit runs share `runs.complete`'s duration histogram with executions; `empty`, dedup counts, lane failure reasons and evidence duration are not reduced; the bucket edges live only in the SQL; `process` mixes orphaned run events with process transitions; provider names differ (`jev`/`classifier` against the ledger's `openrouter`).
11. **S11 — Nits** - `services/retrieval/src/server.mjs`; `deploy/compose.yaml` (CA1): the stop comment says a write still pending after the drain "is counted lost" but only logs it; Serper's availability balance reads `unknown` although its allocation is derivable from the ledger; the stop window is now 18 s against a 20 s `stop_grace_period`.

### ✅ Good Practices

- Best-effort writes with a bounded backlog (256), counted loss, and log lines that carry only a SQLSTATE or a short error; no query text in logs or status.
- Usage only from the ledger, recomputed whole in one transaction under `pg_advisory_xact_lock`; the watermark only moves forward; a repeated reduction changes nothing, and late settlement is tested.
- No foreign key between events and runs, a start insert of `DO NOTHING` and a finish that tolerates a lost start, so a failed write never cascades; event ids make repeat delivery a no-op.
- Privacy-conscious content: URLs as origin and path, no page text or decision state text, bounded vendor codes; all SQL parameterized.
- The schema applies idempotently, the role keeps DML only, and reapplication over populated tables is tested.
- The stop order drains search work, then telemetry, then closes the pool.

### Verdict

[x] ❌ Request Changes (critical issues)
[ ] ⚠️ Approve with Suggestions
[ ] ✅ Approve

### Finding dispositions

Filled by `/address`. Each finding is fixed (with its commit), rejected (with evidence) or deferred (with the later milestone that owns it and why).

| Finding | Outcome | Evidence |
|---|---|---|
| C1 | Fixed (`24b94ff`) | The lanes and activation are saved for the run record before the cancellation check. The cancelled test asserts an event for every general lane, one that answered included, and fails on the previous coordinator. |
| W1 | Fixed (`1385834`) | Runs and events go only strictly below the watermark. A database test prunes under a watermark stalled 35 days, then reduces, and the days are rebuilt from whole sources; it fails on the previous store. |
| W2 | Fixed (`1385834`) | Usage rows are labelled from the ledger row (a search intelligence call key or `unlinked`, with its category) and recomputed for the 89 days the ledger holds whole. The test prunes the run and reduces again with the label and amount unchanged. |
| W3 | Fixed (`1385834`) | Prune clears `trace` after 14 days and keeps the run to 30; the schema comment says so; the reduction test checks both. |
| W4 | Fixed (`bb32395`) | `Breaker` takes an `onChange` callback that Serper's module passes as the dispatch does. Three cut Serper connections record its breaker opening, with its retry time. |
| W5 | Fixed (`bc0d2a3`) | Every telemetry entry point catches its own throw, counts it lost and logs `si_telemetry_degraded`; the test drives a malformed pool document, a missing request and a missing event. |
| W6 | Fixed (`4b3524c`) | The fingerprint is an HMAC under a key derived from the browser token with the label `fcpi.search.fingerprint.v1`; telemetry refuses to start without a key; the comments call it pseudonymous. |
| W7 | Fixed (`83c24a4`) | A joined caller is recorded as its own run (cache mode `coalesced`, no lanes, no usage) and a refused admission as a `refused` run, both tested. |
| W8 | Fixed (`1385834`) | Each pass reduces at most seven days over index-friendly time ranges, with histograms from a second GROUP BY. The reduction test catches up 20 days in bounded passes. |
| W9 | Fixed (`ddc8cc9`) | Telemetry takes the policy's `traceMaxBytes`; a test bounds a stored trace at 4096 bytes through it. |
| W10 | Fixed (`ce32dd3`) | Each reservation's call key is kept on its preflight. Lane, rerank and Ref-read events store them in `search_event.call_keys`, and every key is a ledger row. They never reach a response, and the schema comment documents the documentation activation's derivable key and labels the usage copies. |
| W11 | Fixed (`0a81ae9`, with the tests of `1385834`, `ddc8cc9`, `83c24a4`, `ce32dd3`, `a0fa575`, `04b0015`, `08811a5`) | Covered: re-reducing the watermark day, today kept out, a first pass over empty tables, the profile dimension (`process`, `unlinked`, run-pruned usage), the byte ceiling, `drain` returning its remainder, start eviction, cancelled-run lanes, coalesced callers, prune under a stalled watermark, the status balance, and the exact loss count (3). |
| S1 | Fixed (`ddc8cc9`) | Room for the marker is kept once anything is dropped, dropped pairs are counted, and each entry is measured once. The test trims by bytes at four bounds and checks the result is within each bound but not short of it. |
| S2 | Fixed (`83c24a4`) | An execution closed by its deadline's backstop is a `timeout`, tested by an admission that outlasts the deadline. Every lane ending at its own bound is all-discovery-failed and stays `failed`. |
| S3 | Fixed (`a0fa575`) | FakeStore keeps the start's fields on finish and returns the count written; a database test requires it to agree with PostgreSQL. |
| S4 | Fixed (`ab365ee`) | A first reduction and prune run a minute after the store is ready, then hourly. Not covered by a test (a one-minute timer). |
| S5 | Fixed (`c4a1aa9`) | The transition check compares with `available` when there is no row; the test sees no transition for a first sub-threshold failure or a re-enable. |
| S6 | Fixed (`7cd768b`) | The evidence event carries `startedAt` and `durationMs`; the harness wires evidence as the server does, and the event is tested through the coordinator. |
| S7 | Fixed (`83c24a4`) | The run outcome and event type CHECKs use the drop-and-add pattern; a database test reapplies the schema over the earlier four-value constraint. |
| S8 | Fixed (`bb32395`) | No breaker method is patched in place, and the availability and breaker event mappers live in telemetry, used by the server and the harness. |
| S9 | Fixed (`5810f09`) | Each exit sets one record holder and `finally` writes it once; the 183 affected tests pass. |
| S10 | Fixed (`04b0015`), in part rejected | Reuse is `reuse.hit` and `reuse.coalesced`, empty answers are `runs.empty`, lane failures keep their reason, and orphaned events are `unlinked`, all tested. Rejected: renaming event providers to the ledger's names. An event names the adapter that acted (`jev`, `classifier`) and the ledger names the provider billed (`openrouter`); W10's call keys join the two exactly. Bucket edges are documented beside the SQL rather than versioned in each row, since they have one definition. |
| S11 | Fixed (`08811a5`) | Serper's balance is `local_allocation_remaining`, derived by the reservation's own sum and tested through the providers route; the stop comment says a pending write is logged and goes with the process, and that the 18 s window stays inside the 20 s grace period. |
