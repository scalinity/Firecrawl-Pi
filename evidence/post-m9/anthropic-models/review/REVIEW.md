# Anthropic models review of record

Date: 2026-10-17. Scope: post-M9 change `664d47a...d9210b1` (`4956d2f` provider, policy and gateway tests; `d9210b1` Agent pin, UI label, README). Two fresh, read-only reviewers, a debugger (DB1) and a code-auditor (CA1), each pinned to the `opus` alias, which the project designates as Opus 5.5. Review method: `/review-2` (run directly with the `Agent` tool, because the skill's team tools are not provided in this runtime); remediation: `/address`. Neither reviewer ran tests or builds; the author ran them separately: retrieval 270/270 against a real PostgreSQL, access gateway 93/93, playground and desktop 43/43, all on the reviewed commits.

## Code Review: Anthropic models for extraction and the Agent

### Summary
15 files reviewed against the diff. No critical issue was found. The Messages API codec and the money paths hold: every malformed or absent usage field settles at the full reservation, the 16/17 union boundary matches the limit measured against the live API, and each new HTTP status lands in the right released, settled or uncertain state. The defects are at the edges: a cutover ordering hazard, a stale README claim, a repair shape the Messages API refuses, and an Opus allowance that cannot finish inside its timeout.

Scope: reviewed all 15 changed files (diff-anchored). Skipped: none. Out of scope by instruction: accepted-milestone scripts that still name `gpt-6-luna`, canonical documents, `ORCHESTRATION.html`, `deploy/versions.lock.json`, deployment. Not run by the reviewers: test suite, linters, build.

### 🔴 Critical Issues (Must Fix)
None.

### 🟡 Warnings (Should Fix)
1. **W1 — The Agent README overstates its grammar budget** _(corroborated: both agents)_ — `scripts/playground/README.md:39`
   - Problem: it says a result schema is grammar-constrained "up to 16 nullable fields". The Agent's own decision fields use 10 of the 16 union slots and `result` adds one, so a result schema of more than five fields (nested included) sends the whole decision as prompt text.
   - Fix: correct the text; pin the 5/6 boundary in a test.
2. **W2 — Opus's 16,000-token allowance cannot finish inside its 90 s cap, and a timed-out call strands its reservation** _(corroborated: both agents)_ — `deploy/policies/budget.json:38`
   - Problem: 16,000 tokens in 90 s needs 178 tokens/s sustained, thinking included. A full-size chunk reserves about $0.80 against the $1/day shared paid cap. A call that times out after sending is never re-sent, so its reservation stays counted and blocks every paid provider for the rest of the UTC day.
   - Fix: measure latency and output tokens on real calls, then cap `maxOutputTokens` to what fits. Raising the daily cap is an owner decision (CLAUDE.md §11).
3. **W3 — The policy de-lists the model the live selection file names, which silently turns live search off** _(unique to DB1's lane)_ — `services/retrieval/src/policy.mjs:229`
   - Problem: the Pi's selection file names `gpt-6-luna`. With that model out of the policy, `loadSelection` throws and the whole selection falls back to the defaults, whose `search` is `fixture`.
   - Fix: sequence the cutover so the selection file and the retrieval recreate land together, and record the order.
4. **W4 — A repair after an empty answer sends an empty assistant turn, which the Messages API always rejects** _(unique to DB1's lane)_ — `services/retrieval/src/extract.mjs:368`
   - Problem: a 200 with `content: []`, or a thinking-only `end_turn`, makes the repair fail as `PROVIDER_REJECTED` instead of a clean invalid-output result, and holds the single model slot for a doomed round trip. No money is lost.
   - Fix: send a non-empty placeholder turn; test the case.

### 🔵 Suggestions (Consider)
1. **S1 — Identity is required only for reasoning models** _(unique to CA1's lane)_ — `extract.mjs:350`. Require it on every Messages API call.
2. **S2 — A refusal with an empty-string explanation is not recognised** _(unique to DB1's lane)_ — `anthropic.mjs:61`. Use `||` instead of `??`.
3. **S3 — The wider effort enum also reaches the chat path, which keys on the literal `xhigh`** _(unique to CA1's lane)_ — `budget.mjs:105`.
4. **S4 — The model/effort pair is restated in five places with no cross-file check** _(unique to CA1's lane)_.
5. **S5 — Mutations that survive the new tests** _(unique to CA1's lane)_: a `billing_error` without the credit text; a usage body with only `output_tokens`; an explanation-only refusal; a budget case that is refused for the wrong reason.
6. **S6 — Log the provider's `request-id`** _(unique to CA1's lane)_.
7. **S7 — Comment and wording fixes** _(unique to CA1's lane)_: the overclaiming "never its content" comment (CWE-209); "the Agent's spend is its own"; the stale header comment.
8. **S8 — `openai-chat` is never named by any provider** _(unique to CA1's lane)_.
9. **S9 — Durable extract jobs left running across the deploy fail with `LOGICAL_ID_CONFLICT`** _(corroborated: both agents)_ — `extract.mjs:119`.
10. **S10 — The Haiku card's "over-100K tier is not reached" rests on an estimate, not a bound** _(unique to DB1's lane)_ — `budget.json:62`.
11. **S11 — The `api` switch is scattered across six branches; use one codec per API** _(unique to CA1's lane)_ — `extract.mjs`.

### ✅ Good Practices
- `anthropic.mjs` is a pure wire codec behind one shared reservation, gate and settlement path.
- The paid provider is pinned to `https://api.anthropic.com` at load, on top of DNS pinning, TLS verification and no redirects; the key travels only in `x-api-key`.
- Usage normalization is correct and pinned by a test; malformed counts settle at the full reservation.
- No hidden resend: an over-limit schema is decided deterministically before any request and never retried as a fallback.
- Separate credential files and breakers, with a test that neither key unlocks the other model.
- The ledger needs no migration: no consumer looks up stored subjects or provider names, and `requestHash` binds model and effort, so a settled call from the former models can never be reused.

### Verdict
[ ] ❌ Request Changes (critical issues)
[x] ⚠️ Approve with Suggestions
[ ] ✅ Approve

## Outcomes

Each finding has one outcome: **fixed** (with its commit), **resolved at cutover** (with the evidence), or **rejected** (with the reason). Nothing is deferred to a later milestone: this is an additive post-M9 change with no later milestone to own it.

| Finding | Outcome | Commit / evidence |
|---|---|---|
| W1 README overstates the Agent's grammar budget | **Fixed** | `90f52fd`: README corrected; a test counts the unions in the schema the Agent actually sends for zero, five and six result fields (10, 16, 17). |
| W2 Opus's 16,000-token allowance cannot finish in 90 s | **Fixed**, on measurement | `a037d3b`: 9,000 output tokens took 59.5 s (about 151 tokens/s, `raw/probes-transcribed.md` §3), so the allowance is now 8,000 (about 53 s). Worst-case reservation for a full-size page falls from $0.82 to $0.66. The $1/day shared paid cap itself is the owner's decision and is unchanged. |
| W3 De-listed selection model turns live search off | **Resolved at cutover**, no code change | The selection helper ran beside the recreate. Afterwards the service reports search `live`, model `claude-haiku-5-5`, source `file`, and no `selection_invalid` or policy complaint (`raw/cutover-1.txt`). The suggested code change (replace a de-listed model with the default) was **rejected**: it would silently swallow a mistyped model name that the validator currently refuses. |
| W4 Repair after an empty answer sends an empty assistant turn | **Fixed** | `4ba6ccf`: a placeholder turn; a test whose fixture rejects a blank assistant turn exactly as the API does, for both empty shapes. Verified to fail without the fix. |
| S1 Identity required only for reasoning models | **Fixed** | `09b5f23`; verified to fail without the fix. |
| S2 Empty-string refusal explanation | **Fixed** | `cb2eb74`; verified to fail with `??`. |
| S3 Wider effort enum reaches the chat path | **Fixed** | `6fea5ae`: the chat API keeps `none` and `xhigh`. |
| S4 Pair restated in five places | **Fixed** | `7a8bc9d`: the manifest's pair must name a budget model at that effort with a rate card in effect; the Agent must send exactly the manifest's pair. Verified to fail on a flipped effort. |
| S5 Mutations that survive the tests | **Fixed** | `c6d5f39`: all three named mutations now fail a test; the wrong-reason budget case was removed (the targeted test pins that rule by message). |
| S6 Log the provider's `request-id` | **Fixed** | `615bca6`: answered, refused-status and 502/504 events. |
| S7 Comment and wording fixes | **Fixed** | `7e001a0` |
| S8 `openai-chat` is never named | **Fixed** | `6fea5ae`: the fixture provider names its API. |
| S9 Extract jobs running across the deploy | **Resolved at cutover** | No job in flight at either cutover (`raw/cutover-2.txt`, `in_flight_jobs=0`; the check before the first cutover was a query whose output was read in the session and not saved). |
| S10 Haiku card's prompt-tier claim rests on an estimate | **Fixed** (wording) | `dd089fe`. The residual, a few cents on a pathological page, is accepted and named in the card; every call logs its `prompt_tokens`. |
| S11 One codec per API instead of six branches | **Rejected** | A design preference with no defect. The branches are small and local, the chat path is now only the fixture's, and a codec table would add a layer to code the reviewers found correct. |

### Found after the review, by the live step

The review could not have found this one, because it needs the live API. The first Agent run through the Pi was rejected with `Enum value 'visit' does not match declared type '['string', 'null']'`: `toStrict` makes an enum nullable as a type array plus `null`, and the grammar compiler refuses that. Every schema with an enum property would have failed, including the Agent's own `next_action`. Probing every shape `toStrict` produces showed nullable enums were the only refused class (`raw/probes-transcribed.md` §4); the fixed codec is accepted for all 14 shapes (`raw/schema-battery-after-fix.txt`).

- Fixed in `f3cec79`: a nullable enum is sent as an `anyOf` of a typed enum and `null`. Tests fail without it.
- The refused requests cost nothing: both ledger rows are `RELEASED` at 0 (`raw/ledger.txt`).
- The 400's reason reached the operator in the error text only because of the provider-reason handling this change had added.
- The retrieval image was rebuilt (`4778188`) and recreated; the first image's build log stays as the record of the superseded build.

### Test result that moved

One existing residential-proxy tunnel test (`m6-proxy.test.mjs`, unrelated to models) failed once in a full local run, taking 27 s against a few seconds alone; it passed 3/3 alone with the change, 2/2 on the previous commit, and in both later full runs. It is timing-sensitive under parallel load. It is a pre-existing weakness, not changed here.
