# Agent limits review of record

Date: 2026-10-17. Scope: the post-M9 change `1abb6ab...c7039c7` (the Opus 5.5 output ceiling and timeouts, the gateway's extra wait for a request that names its model, the removal of the shared daily paid cap, the Agent's 15-minute run, the MCP limits, and the firewall fingerprint). Two fresh, read-only reviewers on the `opus` alias (Opus 5.5): a debugger (DB1) and a code auditor (CA1), each given the diff, the deployed policy and the intent, and told to change nothing. The `/review-2` skill's `TeamCreate`, `TaskCreate`, `TaskUpdate` and `TeamDelete` tools are not provided in this harness (the Agent tool's `team_name` is ignored), so the two agents were spawned directly and addressed by name: a substitution, recorded here. Their independence comes from their fresh context.

CA1's report reached the orchestrator cut off inside its first finding; its full text was read from its transcript, and both reviewers were then shut down.

## Code Review: Agent limits, timeouts and the removal of the shared daily paid cap

### Summary
The ledger handles an absent shared cap correctly and every deadline the change touches is now arithmetic that can be read and pinned. The reviewers found two critical issues, both fixed: the app's own page still aborted the Agent at 370 s, and the firewall fingerprint could report an unchanged ruleset after an order change that alters behaviour. The remaining findings are layers the new deadlines did not reach, missing tests for the new code, and one risk the owner's instruction creates and the status now shows. Findings are numbered once; where both reviewers made the same finding it says so.

### 🔴 Critical Issues (Must Fix)
1. **C1 — The browser page aborts every Agent run at 370 s** _(DB1)_ — `LLM-DEMO.html:342`
   - Problem: the page's own timer was not moved with the 900 s run and the 435 s page reads, so a run that reached its second page read was cut off, the Opus call already sent was paid for, and its answer was lost.
   - Outcome: **fixed** in `3aee83d` (the page's timer is 930 s, above the server's 915 s, above the Agent's 900 s; `tests/playground-agent.test.mjs` pins the order and the 15-minute text).
2. **C2 — The canonical firewall hash can hide a reorder that changes behaviour** _(CA1; DB1 found the same as W4)_ — `scripts/host/firewall-fingerprint.py`
   - Problem: a denylist of "rules that continue" left `dup to`, `ct helper set`, DSCP and other `set` statements, set updates, `limit`, `quota` and `ct count` sortable; each was run and a swap left the canonical hash unchanged.
   - Outcome: **fixed** in `61ac9cb`: the sort is an allowlist (pure matches, an optional counter, one shared verdict, an optional comment); anything else keeps its order. Nine behaviour-changing shapes are tested to change the hash. On the Pi it sorts four chains (`ip filter/DOCKER-CT`, `ip filter/DOCKER-INTERNAL`, `ip6 filter/ts-input`, `ip raw/PREROUTING`).

### 🟡 Warnings (Should Fix)
1. **W1 — MCP cuts a model-naming scrape at 120/130 s while the gateway now serves it for 425 s** _(DB1 W1, CA1 W3: corroborated)_ — `deploy/policies/capabilities.json`
   - Outcome: **fixed** in `bf83992`: the MCP REST wait is 440 s and the exchange 450 s. `tests/timeout-chain.test.mjs` reads the policy, Compose file, manifest and Agent and pins every layer outlasting the one beneath it.
2. **W2 — The Agent starts a paid page read it cannot wait for** _(DB1 W2, CA1 W4: corroborated)_ — `scripts/playground/agent.mjs`
   - Outcome: **fixed** in `3aee83d`: a page read is refused with `DEADLINE_EXCEEDED` when less than 150 s of the run is left, before anything is sent. Reviewers' alternative of the whole 435 s wait was not taken: a usual read is far shorter, and the cost of the 150 s floor is a possible abandoned read, not a lost run.
3. **W3 — The server's run timer fires before the Agent's own deadline, dropping the partial result** _(DB1 W3, pre-existing)_ — `scripts/playground/server.mjs`
   - Outcome: **fixed** in `3aee83d`: the server's timer is 15 s after the Agent's.
4. **W4 — The firewall fingerprint hides behaviour-changing reorders** _(DB1 W4)_ — merged with C2.
5. **W5 — The gateway's abort timer is untested** _(DB1 W5, CA1 W7)_ — `services/access/src/jsonscrape.mjs`
   - Outcome: **fixed** in `85f00b9`, on a mocked clock; mutation-checked three ways (drop the extra, widen the margin, give every request the extra).
6. **W6 — Seven uncertain Opus calls (six full-size) end all LLM extraction for the month, and nothing shows it** _(CA1 W1)_ — `deploy/policies/budget.json`, `services/retrieval/src/server.mjs`
   - Problem: with no output cap the 300 s timeout is the binding limit; a call that times out after sending keeps its whole $2.58 (Agent-sized) or $3.06 (full-size) reservation, nothing settles uncertain model rows, and Haiku shares the category.
   - Outcome: **fixed in part.** The status lists the month's uncertain calls per category (`40c6071`, tested against PostgreSQL on the Pi), and the arithmetic is in the policy comment and the spec (`d112320`, `9ed6c77`). **Not built:** an operator command that settles an uncertain model row at a figure from the provider console. No such row exists yet, and the output cap was removed by instruction, so this is the cost of that choice made visible; the command is worth building when the first one appears.
7. **W7 — A minutes-long model call is started with seconds left on the deadline** _(CA1 W2)_ — `services/retrieval/src/extract.mjs`
   - Outcome: **fixed in part** in `9683d39`: a model that reasons needs min(60 s, its timeout) left, at both start checks. **Rejected:** requiring its whole 300 s timeout, which would remove the repair for every Opus call (the 420 s deadline minus the page fetch and the first call), a larger loss than the holds it avoids.
8. **W8 — One model slot is held for up to 300 s by Opus** _(CA1 W5)_ — `services/retrieval/src/extract.mjs`
   - Outcome: **fixed in part** in `d8c936a`: the refusal carries `retryAfter` 30, and the spec says so (`8c87bd8`). **Rejected:** a per-provider slot, which is a design change to the spec's one-request-at-a-time model, not a defect of this change.
9. **W9 — The firewall's canonical hash cannot be recomputed by a verifier** _(CA1 W6)_
   - Outcome: **fixed** in `61ac9cb`: `scripts/host/pi-firewall.sh` prints the raw and canonical hashes of one capture on the Pi, so no ruleset text leaves it (`raw/firewall-final-before.txt`, `raw/firewall-final-after.txt`). **Rejected:** adding the canonical hash to `scripts/m0/pi-snapshot.sh`, which stays unchanged so every earlier snapshot remains comparable with a new one.
10. **W10 — Test gaps on the new code** _(CA1 W7)_ — `services/retrieval/src/{residential,enhanced,parse,reconcile}.mjs`
    - Outcome: **fixed** in `6cfab8d`: a paid provider with no shared cap is tested at the model, parser, residential, enhanced and reconcile call sites, a category cap smaller than a reservation is tested to refuse, and the PostgreSQL ledger is tested with `null`, `undefined` and `0`. Each call-site test was mutation-checked against the former form. **Rejected:** making both stores throw on an `undefined` cap; both now treat it as no cap, tested on the real database, because a throw would turn an omitted setting into an outage. The "jump" test is not vacuous under the allowlist: widening the verdict pattern to accept a jump makes it fail.

### 🔵 Suggestions (Consider)
1. **S1 — Stale "six-minute" text** _(DB1 S1, CA1 S1)_: **fixed** in `3aee83d` and `d112320` (the Agent's comments and README now say two reads that use their whole wait fill the run).
2. **S2 — The page wait equals the gateway's abort timer** _(DB1 S2)_: **fixed** in `3aee83d` (435 s, ten seconds past the 425 s timer, with the three Compose values named in a comment and pinned by `tests/timeout-chain.test.mjs`).
3. **S3 — The extra time follows the request, not the model that runs** _(DB1 S3, CA1 S6)_: **fixed** in `9683d39` for the case DB1 traced: a selection naming a model that reasons is refused. The gateway keys the extra on an explicit `json.model`, which the manifest pins to Opus; **rejected** as a change.
4. **S4 — The guard hash reports ABSENT for no trailing newline or CRLF; truncated input is accepted** _(DB1 S4, CA1 S5)_: **fixed** in `61ac9cb`.
5. **S5 — A comment sits above the wrong function** _(DB1 S5, CA1 S2)_: **fixed** in `6cfab8d`.
6. **S6 — A test title claims a bound it does not assert** _(DB1 S6)_: **fixed** in `6cfab8d` (retitled, and the category cap is now asserted).
7. **S7 — A shared cap set mid-day counts only later reservations** _(DB1 S7)_: **fixed** in `6cfab8d` (stated in the policy comment, as a category's period row behaves).
8. **S8 — No TCP keep-alive on a connection idle for up to 300 s** _(DB1 S8)_: **fixed** in `53aacb6`, tested in `84cf903`.
9. **S9 — The 128,000 and 300,000 ceilings are applied to every model** _(CA1 S3)_: **fixed** in `d112320` (marked as generic in the validator).
10. **S10 — `_paid_total` cannot bind in any shipped policy, and a reconcile row's flag follows the current policy** _(CA1 S4)_: **rejected**: enforcement is unaffected (a category cap trips first, and each row settles by its own flag); recorded here.
11. **S11 — Test polish** _(CA1 S7)_: **fixed** in `3aee83d` (the three Agent timers are tested against each other, not a literal). **Rejected:** removing the repeated cap assertions in the budget test; a duplicate pin costs nothing.

### ✅ Good Practices
- One reader of the shared cap, returning `null` rather than `undefined`; each ledger row settles by the flag it was reserved with.
- The gateway's setting follows its siblings: known, range-checked, default zero.
- No server between the Agent and the provider cuts a long call early (the receive timeouts apply only while a request is received; the SSH forwarder keeps the connection alive).
- The fingerprint keeps each chain's rules as a multiset and runs in linear time.

### Verdict
[ ] ❌ Request Changes (critical issues)
[ ] ⚠️ Approve with Suggestions
[x] ✅ Approve after remediation: every finding above has an outcome and none is unresolved. Rejected whole: S10. Rejected in part, with the reason beside it: W2, W6 (the operator command is not built), W7, W8, W9, W10, S3 and S11. W4 is the same finding as C2.
