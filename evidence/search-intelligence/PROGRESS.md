# Search intelligence — progress and continuation note

Feature contract: `docs/FIRECRAWL_PI_SEARCH_INTELLIGENCE_SPEC.md` (v1.0, design baseline `88d8e4c`); kickoff: `docs/CLAUDE_CODE_IMPLEMENTATION_KICKOFF.txt`.
Branch `search-intelligence` (from `main` at `2a62513`), pushed to `origin/search-intelligence`. Evidence lives under `evidence/search-intelligence/SI0`–`SI6`.

## State by milestone

| Milestone | State | Evidence |
|---|---|---|
| SI0 reconcile and freeze | IMPLEMENTED (baseline record pending in `SI0/BASELINE.md`) | `SI0/corpus/` (frozen corpus, sha256 `b4ae2b8f…f724`), `SI0/provider-contracts-2026-10-17.md` |
| SI1 registry, lifecycle, five-engine discovery | IN_PROGRESS: modules, adapters, store, transport and tests committed; server wiring next | `services/retrieval/test/si-discovery.test.mjs` (23 PASS), `si-store.test.mjs` (8 PASS on PostgreSQL) |
| SI2 docs and Jev | NOT_STARTED | |
| SI3 native REST/MCP and evidence | NOT_STARTED | |
| SI4 durable operational evidence | NOT_STARTED | |
| SI5 evaluation and integration readiness | NOT_STARTED | |
| SI6 release preparation | NOT_STARTED | |

## Decisions taken (with reasons)

- Live roster: `serper-google`, `brave-web`, `exa-search`, `deepseek-search`, `tavily-search`; docs `context7-docs`, `ref-context`; decisions `jev-1.14` (`typesafe/jev-1.14`). Fixture roster `fcpi-fixture-*` at `*.fixture.fcpi.test` hosts, so a fixture selection runs the aggregate end to end with no live call.
- Every new provider is `paid: true` (it bills money or a purchased credit pool): the owner's paid-dispatch switch therefore stops them; Serper stays unpaid (existing allocation). New categories are reporting-only (`caps: {}`): no new cap.
- Exa's reservation is 37,000 micro-USD (documented $0.017 plus highlights at the contents rate if billed, which Exa does not state); `costDollars.total` settles it.
- Billing on refusals: Brave (success-only billing) and DeepSeek (failed searches free) release on any non-2xx; Exa and Tavily release 4xx and keep 5xx uncertain (undocumented), Exa's 503 released (documented unbilled).
- Serper keeps its own breaker; quota, 429, 401/403 and caller cancellation are breaker-neutral (previously `success()`, which erased failures).
- `prune({ retainCategories })` keeps every row of a lifetime-allocation category (Serper); other search rows prune at 90 days.

## Commands

- Local retrieval suite: `$SCRATCH/bin/rtx.sh [test files]` (copies the container layout); database suites need the disposable PostgreSQL: Colima started (`colima start`, no flags), container `fcpi-si-testpg` (pinned image, label `fcpi.transient=si-db-tests`, `127.0.0.1:55432`), then `FCPI_TEST_PG=127.0.0.1 PGPORT=55432 CONC=1 rtx.sh`. Stop and remove both at session end (Colima was stopped when this session began).
- Last full run: 330 tests, 330 pass, 0 skipped (with PostgreSQL), after the `m5-store` expected-shape update.

## Next actions

1. Wire `server.mjs`: `POST /internal/search` (core token), `GET /searxng/search` through `coordinator.legacyGet`, shutdown drain of tracked tasks, prune retention, availability in `/internal/providers`.
2. Write `SI0/BASELINE.md` (drift since `88d8e4c`, credential name mapping, Pi state, test inventory, unresolved live-contract list).
3. SI2: Context7 v3, Ref MCP (stream transport, isolated sessions), documentation activation, Jev Decisions adapter, semantic rerank and soft duplicate groups.
