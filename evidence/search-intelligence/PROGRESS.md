# Search intelligence — progress and continuation note

Feature contract: `docs/FIRECRAWL_PI_SEARCH_INTELLIGENCE_SPEC.md` (v1.0, design baseline `88d8e4c`); kickoff: `docs/CLAUDE_CODE_IMPLEMENTATION_KICKOFF.txt`.
Branch `search-intelligence` (from `main` at `2a62513`), pushed to `origin/search-intelligence`. Evidence lives under `evidence/search-intelligence/SI0`–`SI6`.

## State by milestone

| Milestone | State | Evidence |
|---|---|---|
| SI0 reconcile and freeze | IMPLEMENTED | `SI0/corpus/` (frozen corpus, sha256 `b4ae2b8f…f724`), `SI0/provider-contracts-2026-10-17.md`, `SI0/BASELINE.md` |
| SI1 registry, lifecycle, five-engine discovery | IMPLEMENTED: reviewed (`/review-2`, Opus 5.5) and remediated; every finding has an outcome | `SI1/review/REVIEW.md` (3 critical, 7 warnings, 19 suggestions, 3 found during remediation: 29 fixed, 2 rejected with evidence, 1 deferred to SI6) |
| SI2 docs and Jev | IMPLEMENTED: reviewed (`/review-2`, Opus 5.5) and remediated; every finding fixed | `SI2/review/REVIEW.md` (2 critical, 12 warnings, 14 suggestions, 2 found during remediation) |
| SI3 native REST/MCP and evidence | IMPLEMENTED: reviewed and remediated; every finding fixed; the native chain passes 25 of 25 on the revised patch 0011's image (`b0f561ce`) and its eight new checks fail on the previous patch's | `SI3/review/REVIEW.md` (1 critical, 11 warnings, 12 suggestions), `SI3/review/native-chain-after-address.txt`, `SI3/review/native-chain-previous-patch.txt`, `SI3/native-chain.txt` |
| SI4 durable operational evidence | IMPLEMENTED: reviewed and remediated; every finding fixed but one suggestion's provider renaming (rejected with its reason) | `SI4/review/REVIEW.md` (1 critical, 11 warnings, 11 suggestions) |
| SI5 evaluation and integration readiness | IN_PROGRESS: live contract smoke (all seven providers live, three contract fixes); degraded matrix 8/8; the 120-query corpus collection (D live, B/C/D-C7/D-Ref replayed from D's answers, A legacy) at the frozen configuration `8598be4`; captures through the Pi; blind first-round judging (Sonnet 5.5 judges); `/review-2` of SI5's code running | `SI5/live-smoke.json`, `SI5/degraded-matrix.txt`, `SI5/eval/{frozen.json,runs/,pool.json,captures.json,anchors.json}` |
| SI6 release preparation | IN_PROGRESS: canonical spec, CLAUDE.md/AGENTS.md (S19's wording) and ORCHESTRATION.html reconciled; the API image build of record running; cutover, key and lock helpers; rollout and rollback written | `SI6/ROLLOUT.md`, `SI6/raw/api-build.log`, `scripts/si6/` |
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
- Last full run: 471 tests, 471 pass, 0 skipped (with PostgreSQL), after the SI3/SI4 remediation at `2ecdc84`; gateway 101, MCP 51, root 61. Node 26.12.0 on the workstation since 2026-10-18 03:01 UTC (a Homebrew upgrade outside this work); the services run Node 22 in their images.
- The evaluation: `scripts/si5/collect.mjs` (detached, log `SI5/eval/private/collect.log`), `scripts/si5/pool.mjs` and `capture.mjs` (a detached loop, `SI5/eval/private/capture-loop.sh`, ends when `SI5/eval/private/capture-done` exists), `packets.mjs`, then the judges, `labels.mjs second|adjudicate|final`, `score.mjs`. Page and provider text stays in `SI5/eval/private/` (ignored).
## Next actions

1. SI5: finish capture and first-round judging, the second judge's stratified 20% (`labels.mjs second`), adjudication, final labels and scores; write `SI5/ACCEPTANCE.md` (F01–V01, PASS/FAIL/BLOCKED with evidence); save and address SI5's review.
2. SI6: record the build of record, review SI6's changes, finalize `ROLLOUT.md` and the milestones document's post-M9 section, refresh ORCHESTRATION.html, check it at 390 px in both themes.
3. The cutover itself waits on the owner's launch authorization (`SI6/ROLLOUT.md`, "The one remaining boundary"); the Pi measurements (L01) follow it.
