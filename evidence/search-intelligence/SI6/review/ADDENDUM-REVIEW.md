## Code Review: the changes after SI6's saved review (`bc2e6fd..b811a3c`)

### Summary
Six commits (the Reddit gate, the proxy sweep, the enhanced and parser caps, the SI5 capture and label reclassification, the rebuilt API image of record, the instruction wording) were reviewed by two specialist agents, a debugger (DB1) and a code-auditor (CA1), both on `claude-opus-5-5` as the runtime reported in each transcript, as `CLAUDE.md` §5 requires and not the review skill's default model. No critical issue was found; six warnings and nine suggestions were, and two warnings were raised independently by both reviewers. Verdict: ⚠️ Approve with Suggestions.

**Scope.**
- **Reviewed, diff-anchored against `bc2e6fd` (Tier 1):** `services/retrieval/src/quality.mjs`, `services/retrieval/src/store.mjs` (the `ready()` hunk), `scripts/si5/gate.mjs` (new, full), `scripts/si5/capture.mjs`, `scripts/si5/labels.mjs`, `deploy/policies/budget.json`, `tests/si5-gate.test.mjs` (new, full), and the changed tests `quality`, `m5-store`, `m5-budget`, `m5-parse`, `m7-enhanced`.
- **Skimmed (Tier 2):** the spec and milestones lines, `CLAUDE.md`, `secrets.template`, `SI5/gate-reclassification.md`, `PROGRESS.md`, and the code they depend on (`reconcile.mjs`, `acquire.mjs`, `enhanced.mjs`).
- **Acknowledged, not content-reviewed (Tier 3):** the two build logs, the native-chain record of the lost image, `captures.json`, `ORCHESTRATION.html` (embedded hashes were checked).
- **Not run:** the tests, linters and builds (read-only review). The code was read, not executed; the agents' shell use was read-only, and neither used a write tool.
- **Added after this review and not in its scope:** `scripts/si5/judge-api.mjs`, `judge-api-lib.mjs`, the `judges.mjs` merge (`1147879`).

### 🔴 Critical Issues (Must Fix)
None. Both reviewers constructed the failure traces and found none that corrupts data or overspends a cap.

### 🟡 Warnings (Should Fix)

**Introduced in this changeset:**
1. **W1. The start-up sweep leaves out `enhanced` and `parse`, the two paid kinds the cap change just opened** _(corroborated: both agents)_ - `services/retrieval/src/store.mjs:73-74`
   - Problem: the sweep is an allowlist of kinds. An enhanced dispatch (40 s) or a parse job (120 s) is designed to run past its caller, so a stop or kill mid-call leaves its row `RESERVED` for good. It stays counted against the cap, but is absent from the status's `uncertain` list and the `store_ready` log, and a retry reports "still in flight" for a process that no longer exists. Before `951a544` both caps were 0, so no such row could exist.
   - Fix: drop the kind filter. Every `RESERVED` row older than the process start belongs to a process that no longer exists, and `reconcile` rows are inserted `SETTLED`. Add `enhanced` and `parse` rows to the sweep test.
2. **W2. The Reddit URL sign fires when the caller's own requested URL already carries the parameters** _(corroborated: both agents)_ - `services/retrieval/src/quality.mjs:22-29,144`; `scripts/si5/gate.mjs:7`
   - Problem: `classify` tests only `finalUrl`; a requested URL copied from a browser after the gate is classified a challenge on every tier whatever it returns. It then escalates direct, residential, enhanced (one paid tunnel and one Zyte dispatch with no chance of success) and records a challenge for reddit.com. No test covers it. Zero of the 3,988 SI5 pool URLs carry the parameters, so it is caller input, not corpus input.
   - Fix: count the URL sign only when the redirect added it: `redditGate(finalUrl) && !redditGate(requestedUrl)`, and `!redditGate(c.url)` in `gate.mjs`. The title marker still catches a gate served at such a URL.
3. **W3. No automated test pins the label join, `--reclassify`, the sweep's kind filter or the money contract of a swept row** _(corroborated: both agents)_ - `scripts/si5/labels.mjs`, `scripts/si5/capture.mjs`, `services/retrieval/test/m5-store.test.mjs:227-266`
   - Problem: if the URL form of a capture and of a packet document ever diverged, `captureBlocked: 0` would look like a valid result and every gate grade would stand. The sweep test lost its only negative control, and no test asserts that `budget_usage` is unchanged by the sweep or that the swept row settles at `actual` 0.
   - Fix: an evaluation-root override so a fixture tree can drive the scripts, tests for `capture_blocked`, the `adjudicate` skip and `--reclassify`, and an agreement figure that reports the blocked captures next to the matched ones; add the budget assertions.
4. **W4. One domain's gate can use up the shared residential and enhanced daily caps** _(unique to CA1's lane)_ - `services/retrieval/src/acquire.mjs:394-397,517-520,578,634-655`
   - Problem: spend is bounded per logical page (one enhanced dispatch), per category (the caps) and by the paid switch, but not per domain. A challenge on the enhanced tier is not learned, so a gated domain pays a residential tunnel and a Zyte dispatch on every page, and once the $1 residential day cap is used every other blocked domain fails `PROXY_REQUIRED` for the UTC day.
   - Fix: record an enhanced-tier challenge per domain with the existing routing TTL so later pages of that domain fail without dispatching.
5. **W5. The evaluation's stated reason does not match the rule it applies, and its inputs are not recorded in `labels.json`** _(unique to CA1's lane)_ - `scripts/si5/labels.mjs:43-46`; `evidence/search-intelligence/SI5/gate-reclassification.md`
   - Problem: failed captures (893 before the change) were also judged on excerpts alone and their grades stand, so the note's claim of "a weaker standard than every other document" is false. The rule actually applied is uniform and principled: a judgment made on a capture that the packet misrepresented as captured is void. The exclusion was also applied after provisional scores existed.
   - Fix: state that reason in the code comments and the note, report the results with and without the exclusion, and record `captures.json`'s hash and the hashes of `gate.mjs` and `quality.mjs` in `labels.json`.
6. **W6. The M5 and M7 end-to-end "production" cases relied on zero caps to stay offline** _(unique to CA1's lane; premise broken by `951a544`)_ - `scripts/m7/e2e.mjs:206-211`, `scripts/m5/e2e.mjs:337-348`
   - Problem: with a Zyte or LlamaParse key present and caps above zero, a rerun sends a real request for a fixture URL. The unit tests were changed to set the zero explicitly; these scripts were not.
   - Fix: set a zero cap, or refuse to run them, when paid dispatch is on and the caps are above zero.

### 🔵 Suggestions (Consider)

**Introduced in this changeset:**
1. **S1. `gate.mjs` applies only the URL half of the platform's gate test** _(corroborated: both agents)_ - `scripts/si5/gate.mjs:1-9`: also match the capture's title, correct the two comments that overstate its agreement with the platform and the statuses labels read.
2. **S2. Classifier edge cases are untested** _(corroborated: both agents)_ - `services/retrieval/test/quality.test.mjs`: add bare `reddit.com`, `old.reddit.com`, an uppercase host, `reddit.com.example.org`, `reddit.com@example.org`, and a requested URL already carrying both parameters.
3. **S3. The sweep's stated rationale is overstated for the deployed proxy** _(unique to CA1's lane)_ - `services/retrieval/src/store.mjs:70-72`: Decodo is `usageDedicated: false`, so `reconcileDay` refuses it with `RECONCILE_SCOPE_UNKNOWN` before the in-flight check, and could never reconcile that row either way. The sweep's real effect is visibility. A swept row settled by reconciliation also records `usage.bytes: 0` as if measured.
4. **S4. Agreement figures mix two populations, and flags can double-count** _(corroborated: both agents)_ - `scripts/si5/labels.mjs`: `pairs`, `exact` and `relevanceAgree` still count blocked documents while `disputes` excludes them; `final` rebuilds the id-to-URL map that `urlsOf` memoizes; the header does not mention `capture_blocked`.
5. **S5. The "other paid caps zero" assertion now checks nothing** _(unique to CA1's lane)_ - `services/retrieval/test/m5-budget.test.mjs:31`: every remaining paid category has `caps: {}`; assert the exact set.
6. **S6. A reclassified capture looks identical to one blocked at capture time** _(unique to CA1's lane)_ - `scripts/si5/capture.mjs`.
7. **S7. Swept proxy rows older than a day are never reconciled automatically** _(unique to DB1's lane)_ - `services/retrieval/src/server.mjs:205`: the hourly loop reconciles only the last closed day; say so in the rollout note.
8. **S8. Two clocks in the sweep's time guard** _(corroborated: both agents)_ - `services/retrieval/src/server.mjs:112`: production passes the process clock; fine on the Pi, which shares one kernel clock.
9. **S9. Known document drift** _(unique — outside both primary lanes)_ - `ORCHESTRATION.html`: four narrative sentences still say the caps are zero (already tracked for SI6's refresh).

**Pre-existing:**
1. **[PRE-EXISTING] P1. The stop handler does not close the two proxy listeners** _(unique to DB1's lane)_ - `services/retrieval/src/server.mjs:393`: search tunnels can reserve during the stop window and then lose the pool; this is the orphan source the sweep now backstops.
2. **[PRE-EXISTING] P2. The same cross-clock fragility the `m5-store` change fixed** _(unique to DB1's lane)_ - `services/retrieval/test/si-store.test.mjs:89`.

### ✅ Good Practices
- The sweep is one atomic `UPDATE` that leaves `budget_usage` alone, so caps, the 80% notice and pruning behave as before; the `startedAt` guard is sound in production (fixed at module load, one kernel clock on the Pi).
- Cap values agree everywhere: `budget.json` and its comment, the spec's three places, the milestones line and `secrets.template`.
- `redditGate` handles hostile URLs (userinfo, suffix and prefix look-alikes, ports, case, percent-encoding, null and unparseable input), and the title marker has no nested quantifiers.
- `--reclassify` is network-free and idempotent, `asBlocked` does not mutate its input and keeps every hash, final labels keep the original grades beside the dropped one, and `captures.json` leaves out `finalUrl`, so no `jsc_token` reaches Git.
- Every test that relied on the committed zero caps now sets the zero explicitly; the evidence arithmetic (154+62=216, 3,095-92=3,003, 893+92=985) checks out.

### Verdict
[ ] ❌ Request Changes (critical issues)
[x] ⚠️ Approve with Suggestions
[ ] ✅ Approve

### Finding dispositions

Nothing ran against the Pi beyond read-only probes: the cutover remains the one boundary, waiting on the owner's launch authorization, and the Pi still runs the previous release. The retrieval suite (478 tests) ran against a disposable PostgreSQL and passed, as did the 72 root tests and the contract tests that touch the ledger, the paid switch and the pre-M9 verdicts.

| Finding | Outcome | Evidence |
|---|---|---|
| W1 | Fixed (`0c87f94`) | The sweep's kind filter is gone: every RESERVED row older than the process start becomes UNCERTAIN. The sweep test now holds enhanced and parse rows. |
| W2 | Fixed (`0ed378d`) | The URL sign counts only when the redirect added the parameters (`redditGate(finalUrl) && !redditGate(requestedUrl)`) in `quality.mjs` and `gate.mjs`; a requested URL already carrying them has a test. |
| W3 | Fixed (`0c87f94`, `049fe8f`) | The sweep tests assert `budget_usage` is unchanged and that a swept row settles at actual 0. `FCPI_SI5_ROOT` lets `tests/si5-labels.test.mjs` drive `capture.mjs --reclassify` and `labels.mjs final` and `adjudicate` over a fixture tree (a mutation check showed the adjudicate test can fail); `labels.json` reports `blockedCaptures` and `blockedUnmatched`. |
| W4 | Fixed (`62716a4`) | An enhanced-tier challenge sets `domain_route.blocked_until` for the routing TTL; an auto page or download on the domain then fails at once as BLOCKED_PUBLIC_CONTENT with no attempt, tunnel or dispatch, and the time left as its retry-after. A deliberate basic, stealth or enhanced request still tests it, an adequate enhanced answer lifts it, and a page whose dispatch was already made keeps its answer. Tests cover the pure rules, the stored column, the acquirer and the download path; removing the download guard or the made-priority rule makes its test fail. Spec 9.5 states the rule. |
| W5 | Fixed (`049fe8f`) | The code comments and `gate-reclassification.md` give the rule actually applied (a judgment made on a capture the packet misrepresented as captured is void), the results are reported before and after the exclusion, and `labels.json` records the hashes of `captures.json`, `gate.mjs` and `quality.mjs`. |
| W6 | Fixed (`91c9c45`) | Both fixture phases stop unless the service reports `paidDispatch` false, before any selection changes; a missing status counts as on. The guard's logic ran against stubbed statuses; the drivers themselves need the Pi and were not run. The live phases are real-provider runs by design and are unchanged. |
| S1 | Fixed (`0ed378d`) | `gate.mjs` also matches the capture's title through `redditGateTitle`, and its header states both halves of the platform's test. |
| S2 | Fixed (`0ed378d`) | Classifier edge cases are in `quality.test.mjs` and `tests/si5-gate.test.mjs`. |
| S3 | Fixed (`0c87f94`) | The comments say the sweep's effect on the deployed, not usage-dedicated, Decodo is visibility; a swept row settled by reconciliation records `measured: false` instead of passing for a measurement of 0 bytes. |
| S4 | Fixed (`049fe8f`) | Blocked pairs are left out of the agreement figures and counted (`blockedPairs`), one flag applies by precedence, `urlsOf` is reused, and the header names `capture_blocked`. |
| S5 | Fixed (`b6c2bcb`) | The test names the exact seven reporting-only paid categories and shows by a control that its assertion fails when a cap is added. |
| S6 | Fixed (`049fe8f`) | A reclassified capture carries `previousStatus` and `reclassifiedAt`, backfilled onto the 92 records and listed in `captures.json`. |
| S7 | Fixed (`865ec6e`) | `ROLLOUT.md` says Decodo's `usageDedicated: false` makes the hourly loop log `RECONCILE_SCOPE_UNKNOWN`, and that a swept proxy row older than the last closed day is never reconciled. |
| S8 | Rejected | `startedAt` is taken once at module load and compared with `created_at` from PostgreSQL, which runs as a Compose service on the same Pi (`deploy/compose.yaml`, `nuq-postgres`), so both read one kernel clock. The cross-clock risk exists only where PostgreSQL is on another machine, as in the workstation tests, which P2 and `m5-store` now take from the database. |
| S9 | Fixed (`81fa12a`) | The four stale sentences in `ORCHESTRATION.html` now state the policy's figures, the footer's $0.50 a day proxy figure included. The three data blocks are byte-identical; checked in light and dark at 1280 px and 390 px. |
| P1 | Fixed (`4ac1f85`) | The stop closes all four listeners; the `stopping` line reports `listeners_open`, which the spawned-service test asserts is 0 (it read 2 before the change). A tunnel already upgraded by CONNECT is not closed by `closeAllConnections()` (checked on Node 26) and ends with the process; the next start's sweep marks any that were still reserved. |
| P2 | Fixed (`876c3f9`) | `si-store` takes the sweep's start time from the database; under a 5 s skew of the process clock the old form fails and the new one passes. |

**Observed while addressing these, not raised by the review:**

- The accepted milestone gates that assert every paid cap is zero read a policy that no longer says so. `scripts/m5/verify.mjs` B01 reads `deploy/policies/budget.json` from the working tree and would report FAIL if rerun now; `scripts/m9/entry.mjs` reads the Pi's deployed policy and, with `m9/collect.mjs` and `pre-m9/posture.mjs`, would report FAIL once the cutover deploys the new caps. They were milestone-close gates, their accepted records are untouched, and none was changed here.
- The hourly proxy reconciliation will log `proxy_reconcile_failed` with `RECONCILE_SCOPE_UNKNOWN` for Decodo after the cutover; this is expected and now stated in `ROLLOUT.md`.
