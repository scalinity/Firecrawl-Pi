# Streamed model calls review of record

Date: 2026-10-17. Scope: the change `3ad46ef..88d8e4c` (`2a905b0` model requests run concurrently, `0140e91` streamed Messages API calls that run to their end, `88d8e4c` model calls left in flight by a stopped service marked uncertain at start). Two fresh, read-only reviewers on the `opus` alias (Opus 5.5): a debugger (DB1) and a code auditor (CA1), each given the diff, the live stream measurements and the intent, and told to change nothing. The `/review-2` skill's team tools are not provided in this harness, so the two agents were spawned directly and addressed by name: a substitution, recorded here. Their independence comes from their fresh context.

## Code Review: streamed model calls, concurrency and the start-up sweep

### Summary
Streaming did what it was for: a long call settles at its usage instead of holding its worst-case reservation as uncertain, and the start-up sweep makes an orphaned hold visible. Both reviewers found the same critical defect: the new "still running" answer invited a retry that, on the json scrape path, could never reuse the running call and sent a second paid one. The warnings were the bookkeeping that detaching a call from its caller disturbs (the breaker's probe, the usage totals, logging) and bounds the new path lacked (connection, final usage). Findings both reviewers made are numbered once and say so.

### 🔴 Critical Issues (Must Fix)
1. **C1 — A json scrape's "retry reuses its answer" was false, and the retry paid again** _(DB1 C1, CA1 C1: corroborated)_ — `services/retrieval/src/extract.mjs`, `services/access/src/jsonscrape.mjs`
   - Problem: a streamed call that outlasted its caller's wait answered EXTRACTION_IN_FLIGHT, retryable after 30 s, saying a retry would reuse its answer; a json scrape names each call after its own request (`scrape:<request id>`), so a retry sent a second paid call while the first ran on.
   - Outcome: **fixed** in `d9348db`. The caller waits until its deadline (or until it cancels) and then gets EXTRACTION_STILL_RUNNING, a class of its own that counts as a dispatched call. Extract jobs, whose logical id is their stable submission key, treat it as transient and reuse the stored answer in their next round; the gateway answers a json scrape with 504 and no Retry-After, saying the call runs on and is billed and that a repeat starts a new paid call. The spec names which routes reuse an answer. Tested: the still-running answer with its reuse under a stable id, the gateway's 504 without Retry-After, the job's deferral; each mutation-checked.

### 🟡 Warnings (Should Fix)
1. **W1 — A detached call was reported as never dispatched** _(DB1 W5, CA1 W1)_ — `services/retrieval/src/extract.mjs`
   - Outcome: **fixed** in `d9348db` with C1's class, which is not in the before-dispatch set: the extraction's usage is reported unknown with a warning, not zero. Mutation-checked.
2. **W2 — The half-open breaker's probe was handed back while it was still in flight** _(DB1 W1, CA1 W2)_ — `services/retrieval/src/extract.mjs`
   - Outcome: **fixed** in `d9348db`: a call whose caller has left keeps the probe, its own outcome settles it, and a non-provider failure hands it back. Tested: a second call is refused while the probe runs, and the probe's answer closes the breaker. Mutation-checked.
3. **W3 — Connection and handshake were bounded only by the 30-minute ceiling** _(DB1 W2, CA1 W3)_ — `services/retrieval/src/provider.mjs`
   - Outcome: **fixed** in `dc4c639`: the idle timer starts when the request is created; firing before the send is PROVIDER_UNREACHABLE with sent false, so the reservation is released. Tested against an address that never answers. Mutation-checked.
4. **W4 — A stream that ended without its final usage was settled at a placeholder** _(DB1 W3)_ — `services/retrieval/src/anthropic.mjs`
   - Outcome: **fixed** in `cf9722b`: a stream is complete only when a message_delta carried usage; otherwise it stays UNCERTAIN with its whole reservation. The fixture stream now sends message_start's placeholder count, as the API does. Mutation-checked.
5. **W5 — A failure after the caller left was never logged** _(DB1 W4, CA1 W4)_ — `services/retrieval/src/extract.mjs`
   - Outcome: **fixed in part** in `d9348db`: a failure that is not a provider outcome (a ledger error) is logged with its call key once the caller has gone, and the status and stop log count running calls. **Not done:** logging the provider's request id before settling; a ledger error after a paid answer is the one case it would add, and the call key names the row to match by time in the console.
6. **W6 — Model concurrency has no count limit, and the spec contradicted itself** _(CA1 W5)_ — `docs/FIRECRAWL_PI_SPEC.md`, `services/retrieval/src/extract.mjs`
   - Outcome: **fixed in part** in `d9348db`: the spec now exempts model calls from the adapters' semaphores and says why (each holds its reservation while it runs, so the budget bounds how many run), and a stream's buffer is sized to its model's output cap (1 MiB plus 128 bytes a token: about 1.5 MiB for Haiku, 17 MiB for the Agent's model) instead of a fixed 16 MiB. **Rejected:** a per-provider count limit, since removing the one-request limit was the owner's instruction.
7. **W7 — Shutdown cut detached calls without a record** _(CA1 W6, DB1 S2)_ — `services/retrieval/src/server.mjs`
   - Outcome: **fixed** in `d9348db`: the stop log and the provider status report how many calls are running with no caller; the start-up sweep (`88d8e4c`, and `8fd4969` for what it holds) marks them. **Rejected:** waiting for them at stop, since a call runs for minutes and the sweep already accounts for it.

### 🔵 Suggestions (Consider)
1. **S1 — The caller's cancellation did not end its wait** _(DB1 S1, CA1 S2)_: **fixed** in `d9348db` (a cancelled caller is answered at once; the call runs on and settles). Mutation-checked.
2. **S2 — The stream reader trusted provider shapes** _(CA1 S1, DB1 S4)_: **fixed** in `cf9722b` (a content index must be an integer below 64, a delta sets only the stop fields, a null event is skipped). **Rejected:** bare-CR line endings, which the API does not send.
3. **S3 — Any failure during half-open re-opens the breaker** _(DB1 S3)_: **rejected**: with concurrent calls a failure from a call admitted while closed can re-open a half-open breaker, which errs toward fewer calls to a provider that has just failed; the probe's own bookkeeping is W2.
4. **S4 — Stale slot wording in M5 scripts** _(DB1 S5, CA1 S3)_: **rejected**: `scripts/m5/e2e.mjs` and `scripts/m5/verify.mjs` describe the accepted M5 run, and the M5 verifier must reproduce its accepted record byte for byte (CLAUDE.md §33.3).
5. **S5 — The policy comment omitted two uncertain cases** _(CA1 S4)_: **fixed** in `d9348db`.
6. **S6 — The Agent and timeout-chain comments described 300 s as a cut** _(CA1 S5)_: **fixed** in `d9348db` (the spec states the model timeout is the time the deadlines leave a call, not a limit on it).
7. **S7 — The start-up sweep logged only a count** _(CA1 S6)_: **fixed in part** in `8fd4969` (it returns and logs the micro-USD the swept rows hold). **Not done:** logging their call keys; the ledger holds them.
8. **S8 — Test robustness and coverage** _(DB1 S6)_: **fixed in part**: the steady-stream test sends chunks at a third of the idle limit (`dc4c639`), the concurrency test asserts overlap rather than wall time (`d9348db`), the fixture's placeholder usage (`cf9722b`), and tests for the probe, the cancellation and the json scrape's answer (`d9348db`). **Not added:** a test that a 200 answer which is not a stream is UNCERTAIN (the reader returns no message, which takes the incomplete path).

### ✅ Good Practices
- The detached promise always carries a rejection handler; timers are cleared on every exit.
- The ledger cannot settle twice: closing and marking uncertain both require the row's current state.
- The start-up sweep is one conditional update with positive and negative controls in its test, and runs before any route is served.
- `/v2/extract` jobs, with their stable key, do reuse a running call's answer.

### Verdict
[ ] ❌ Request Changes (critical issues)
[ ] ⚠️ Approve with Suggestions
[x] ✅ Approve after remediation: every finding above has an outcome and none is unresolved. Rejected whole: S3, S4. Rejected or not done in part, with the reason beside it: W5, W6, W7, S2, S7, S8.
