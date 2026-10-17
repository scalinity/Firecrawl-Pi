# Search intelligence — progress and continuation note

Feature contract: `docs/FIRECRAWL_PI_SEARCH_INTELLIGENCE_SPEC.md` (v1.0, design baseline `88d8e4c`); kickoff: `docs/CLAUDE_CODE_IMPLEMENTATION_KICKOFF.txt`.
Branch `search-intelligence` (from `main` at `2a62513`), pushed to `origin/search-intelligence`. Evidence lives under `evidence/search-intelligence/SI0`–`SI6`.

## State by milestone

| Milestone | State | Evidence |
|---|---|---|
| SI0 reconcile and freeze | IMPLEMENTED | `SI0/corpus/` (frozen corpus, sha256 `b4ae2b8f…f724`), `SI0/provider-contracts-2026-10-17.md`, `SI0/BASELINE.md` |
| SI1 registry, lifecycle, five-engine discovery | IMPLEMENTED: reviewed (`/review-2`, Opus 5.5) and remediated; every finding has an outcome | `SI1/review/REVIEW.md` (3 critical, 7 warnings, 19 suggestions, 3 found during remediation: 29 fixed, 2 rejected with evidence, 1 deferred to SI6) |
| SI2 docs and Jev | IMPLEMENTED, in review: Context7 v3; Ref over the official MCP client through `adapters/ref-bridge.mjs` (streamed answers, stream slots apart from request permits, withdrawn calls never sent late) metered by `dispatch.meter()`; selected Ref reads and lease ownership in the coordinator; Jev decisions; documentation activation; server wiring. `/review-2` (Opus 5.5) running over `bdf91d8..HEAD` in `services/retrieval` | `services/retrieval/test/si-ref.test.mjs`, `si-docs-search.test.mjs`, `si-jev-search.test.mjs`, `si-docs-decisions.test.mjs`, `si-semantic.test.mjs`; review to `SI2/review/REVIEW.md` |
| SI3 native REST/MCP and evidence | IN_PROGRESS: gateway validation and trusted headers, MCP schema and shaping, playground limitations, core patch 0011 (compiles for linux/arm64) and `evidence.mjs` committed; the `POST /internal/search/evidence` route waits on the SI2 review (it edits `server.mjs`) | `services/access/test/search-intelligence.test.mjs`, `services/mcp/test/search-intelligence.test.mjs`, `services/retrieval/test/si-evidence.test.mjs`, `patches/series.json` |
| SI4 durable operational evidence | IN_PROGRESS: `search_run`, `search_event`, `search_daily` and the watermark (schema), Store methods, the daily reduction and retention, `telemetry.mjs` committed; coordinator and server wiring, availability/breaker transition events and status next | `services/retrieval/test/si-telemetry.test.mjs` |
| SI5 evaluation and integration readiness | NOT_STARTED | |
| SI6 release preparation | NOT_STARTED; owns the deferred SI1 finding S19 (CLAUDE.md §11 wording on unknown prices) | |

## Decisions taken (with reasons)

- Live roster: `serper-google`, `brave-web`, `exa-search`, `deepseek-search`, `tavily-search`; docs `context7-docs`, `ref-context`; decisions `jev-1.14` (`typesafe/jev-1.14`). Fixture roster `fcpi-fixture-*` at `*.fixture.fcpi.test` hosts, so a fixture selection runs the aggregate end to end with no live call.
- Every new provider is `paid: true` (it bills money or a purchased credit pool): the paid-dispatch switch therefore stops them; Serper stays unpaid (existing allocation). New categories are reporting-only (`caps: {}`): no new cap.
- Exa's reservation is 37,000 micro-USD (documented $0.017 plus highlights at the contents rate if billed, which Exa does not state); `costDollars.total` settles it.
- Billing on refusals (spec §18.2: release only on non-dispatch or a documented non-billable refusal): Brave (success-only billing) and DeepSeek (failed searches free) release any non-2xx; Exa releases only its documented-unbilled 503; Tavily, OpenRouter (Jev), Context7 and Ref keep every answered failure UNCERTAIN, since SI0 records their charging of failures as not established; Context7's documented no-documentation 404 settles one request.
- One call, one breaker verdict: `dispatch.call()` judges every result it returns unanswered, and adapters report those with `{ answered: false }` (availability only). An unsent call counts as a failure only when the provider was unreachable. Serper keeps its own breaker under the same rule; quota, 429, 401/403 and cancellation are neutral.
- Availability belongs to the subject's provider (never a literal live name), keeps rows written while a read was in flight, and ignores a success dispatched before the refusal it would clear.
- A complete answer is stored whole when hybrid-ranked or ranked deterministically because no decision layer is configured; its key carries the decision identity and the policy's search-intelligence limits. A joining caller reports `usage: []` with `usageOf`.
- The rate token is taken after the outbound permit, so queued tokens cannot burst past a provider's documented QPS on the wire.
- `prune({ retainCategories })` keeps every row of live Serper's lifetime-allocation categories (computed from the current budget at each prune); the fixture Serper is neither capped by the allocation nor retained.

## Commands

- Local retrieval suite: `$SCRATCH/bin/rtx.sh [test files]` (copies the container layout); database suites need the disposable PostgreSQL: Colima started (`colima start`, no flags), container `fcpi-si-testpg` (pinned image, label `fcpi.transient=si-db-tests`, `127.0.0.1:55432`), then `FCPI_TEST_PG=127.0.0.1 PGPORT=55432 CONC=1 rtx.sh`. Stop and remove both at session end (Colima was stopped when this session began).
- Mutation check of a fix's tests: `$SCRATCH/bin/rtx-at.sh HEAD "src/<file> ..." test/<file>` runs the working tree's tests over `HEAD`'s copies of the named source files; a new test must fail there.
- Last full run: 398 tests, 398 pass, 0 skipped (with PostgreSQL), at `a3e69fc`; since then `si-evidence.test.mjs` (5/5) and `si-telemetry.test.mjs` (6/6, PostgreSQL) pass alone. `serper.test.mjs`'s "deadline covers slow admission and DNS" bounds the caller at 90 ms and can fail under CPU contention (seen once while the full suite ran beside it; three solo runs pass).

## Next actions

1. SI2: save the review of record to `SI2/review/REVIEW.md`, run `/address`, rerun the affected suites.
2. SI3: the `POST /internal/search/evidence` route over `evidence.mjs`, native chain tests including the deadline beyond 15 s, the Pi fixture stack.
3. SI4: wire `telemetry.mjs` into the coordinator (cancelled and failed runs included) and the server (hourly reduction before prune, drained stop), availability and breaker transition events, additive status with the telemetry-loss counter.
4. SI5–SI6 per the kickoff; `deploy/versions.lock.json` still records the series without patch 0011 (re-pinned with the rebuilt image in SI6).
