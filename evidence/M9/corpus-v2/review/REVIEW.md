## Code Review: M9 corpus revision 2

### Summary
Two fresh native claude-opus-5-5 reviewers independently found the body-plus-title correction defensible, subject to evidence safeguards, honest intent qualification, and explicit authorization of the frozen browser options. No model substitution. Original 17/20 evidence remains immutable. Scope: all four new proof files and the two collection/redaction output diffs, criterion evidence and canonical authority. No tests or provider calls run by reviewers; private corpus inputs could not be directly read.

### 🔴 Critical Issues (Must Fix)
1. **R01: Post-window cleanup can falsely PASS from a pre-window snapshot** — scripts/m9/corpus-v2-verify.mjs:34 _(corroborated: both agents)_
   - Problem: collection timestamp is not ordered after close; repo caps do not prove overlay removal.
   - Risk: pre-window collection → paid run → mark window CLOSED without shutdown → stale zero-cap snapshot produces false ACCEPTED.
   - Fix:
     ```js
     const cleanAfter = Date.parse(current.utc) > Date.parse(window.closed_utc) && current.checks.validation_absent === true;
     ```

### 🟡 Warnings (Should Fix)
- **R02: Freeze and explicitly authorize recovered JS request options** — scripts/m9/corpus-v2.mjs:17 (Both reviewers). See the two preserved per-agent reports for exact original paths, traces and suggestions.
- **R03: Qualify classification; original author intent and source drift unknown** — scripts/m9/corpus-v2.mjs:17 (Both reviewers). See the two preserved per-agent reports for exact original paths, traces and suggestions.
- **R04: Pin private justification inputs to public hashes** — scripts/m9/corpus-v2.mjs:17 (Auditor). See the two preserved per-agent reports for exact original paths, traces and suggestions.
- **R05: Require all affected fixture files and a meaningful test count** — scripts/m9/corpus-v2.mjs:17 (Auditor). See the two preserved per-agent reports for exact original paths, traces and suggestions.
- **R06: Target-bound correlation amid concurrent IDs; pure helper tests** — scripts/m9/corpus-v2.mjs:17 (Both reviewers). See the two preserved per-agent reports for exact original paths, traces and suggestions.
- **R07: Zero-cost URL-normalization/HMAC preflight** — scripts/m9/corpus-v2.mjs:17 (Both reviewers). See the two preserved per-agent reports for exact original paths, traces and suggestions.
- **R08: Remaining-window planning and bounded timeout** — scripts/m9/corpus-v2.mjs:17 (Debugger). See the two preserved per-agent reports for exact original paths, traces and suggestions.
- **R09: Fresh gate provenance must replace old source/finding count** — scripts/m9/corpus-v2.mjs:17 (Debugger). See the two preserved per-agent reports for exact original paths, traces and suggestions.

### 🔵 Suggestions (Consider)
- **R10: Confirm literal criterion regex escaping** — scripts/m9/corpus-v2.mjs:17 (Both reviewers). Original details in per-agent reports.
- **R11: Successful rows report no terminal failure** — scripts/m9/corpus-v2.mjs:17 (Debugger). Original details in per-agent reports.
- **R12: Refuse window crossing a UTC month** — scripts/m9/corpus-v2.mjs:17 (Auditor). Original details in per-agent reports.
- **R13: Public request hashes** — scripts/m9/corpus-v2.mjs:17 (Auditor). Original details in per-agent reports.
- **R14: Fixture coverage of source/cleanup/history/budget gates** — scripts/m9/corpus-v2.mjs:17 (Both reviewers). Original details in per-agent reports.

### ✅ Good Practices
- Fresh full20-run required; original905files hashed and untouched.
- Same18/20threshold, unchanged P19 and three-attempt bounds.
- Body and title are separate AND assertions; metadata alone cannot pass.
- Credentials/HMAC keys remain isolated; prior spending authority expires.

### Verdict
[x] ❌ Request Changes. Saved before /address. Findings must be resolved and independently checked before requesting a spending grant.

### Dispositions
- R01: FIXED — 086428f; Fresh post-close collection and runtime validation-overlay absence, with negative fixtures.
- R02: FIXED — 3ebdc9e; Frozen request_plan_sha256; live driver refuses without explicit owner authorization of recovered JS caller options.
- R03: FIXED — 68b86dd; Owner-required classification enum retained with CURRENT_SOURCE_FORMULATION_ONLY, neutral observed condition and author/source-history UNKNOWN; correction is not a historical-author claim.
- R04: FIXED — 1f2da4f; Source/old rawHTML/Markdown and matching initial request-profile hashes all pinned; tamper fixtures.
- R05: FIXED — c2b1df8; Exact3suite argv/file hashes/counts required; final49-test minimum in11d5ce5.
- R06: FIXED — cb9f598; Fresh receipt and exact target binding select amid concurrent other targets; duplicate/ambiguous log fixtures.
- R07: FIXED — bbb6ca6; Before dispatch compare all20 oracle HMACs to stored historical acquisition hashes; actual zero-provider preflightPASS.
- R08: FIXED — 11d5ce5; Requires≥42minutes remaining; each request has115s absolute deadline bounded by grant expiry. Proposed20×145s admission floor exceeds45minutes and cannot be granted; slow all-timeout batch remainsFAIL, not a guaranteed finish.
- R09: FIXED — 8bdb360; Fresh gates carry FRESH_REVISION_2 and their execution source; stale finding_count removed.
- R10: REJECTED; No defect: both real P01/P02 criteria are literal-regex equivalents, including escaped trailing period. Hash-backed criterion-literal-proof.jsonPASS.
- R11: FIXED — 614cd55; Recovered successes report null terminal failure; real failures retained.
- R12: FIXED — 80399bb; UTC-month-crossing windows refused by readiness and acceptance.
- R13: FIXED — 10b296a; Public complete-run record includes request-plan and per-request hashes.
- R14: FIXED — bc7a733; Source/cleanup/fixture/admission/correlation/history mutation cases tested;49affectedtestsPASS.

Remediation is committed and all49 affected fixture tests pass. Independent remediation confirmation is pending. The new corpus and provider execution remain NOT_RUN.

### Independent remediation confirmation
Both native Opus5.5 reviewers confirm the qualified owner-required classification and most remediations. Additional direct evidence/test gaps were found; no grant is requested while they remain. Original reports: DEBUGGER-REMEDIATION.md and AUDITOR-REMEDIATION.md.

- R15: FIXED — 0c370a1; Both actual historical rawHTML bodies lack old phrase, contain the purpose sentence and expected title; helper independently verifies all three.
- R16: FIXED — deb821b; Semantic source mutations rebind hashes before assertions; separate tampering fixtures remain. Raw-body identity/omitted-purpose/wrong-title regressions explicitly FAIL.
- R17: FIXED — d804ebc; Review gate pins premise_sha256 in driver and verifier; qualified freeze classification and reviewed/execution-held state retained.
- R18: FIXED — 897a99f; Record states old criteria permit at most17/20 with still-failing P19; correction can decide acceptance. No historical rescore.
- R19: FIXED — 936a8f7; Dispatch refuses unless115s request deadline plus15s cleanup margin remain.
- R20: FIXED — c9f0907; Fresh consent must repeat exact readable P07/P08 wait_ms and onlyMainContent options, plus frozen plan hash.
- R21: FIXED — c9f0907; Canonical UTC times accept ISO seconds or milliseconds; offsets and24:00normalization reject; month comparisons use parsedUTC.
- R22: FIXED — 35380d9; After single baseline read, per-request DB reads select only exact url_hmac; historical preflight selects exactly20 validated receipt IDs.
- R23: FIXED — 88242fc; Consent budget month must match live UTC month; historical preflight revalidates retained rows before any dispatch. October applicability and30day retention documented; later month must rederive.
- R24: FIXED — 88242fc; Zero-provider live observation confirms core110000ms vs client115000ms; driver rechecks≤110000before dispatch and stores it in raw receipt.
- R25: REJECTED; Accepted privacy limitation, not a defect: request/criterion hashes permit guess confirmation and are integrity evidence, not confidentiality; private full URLs/content remain off Git.
- R26: REJECTED; No correctness defect: concurrent same-target requests cause explicit ambiguity FAIL; no false success. Session/queue exclusivity will be rechecked before live, without a redundant owner command.

### Final remediation gate
Both native reviewers conditionally approved the qualified current-source correction after direct evidence/test/binding fixes. Those conditions are now implemented and52affectedtestsPASS; all27findings are FIXED or REJECTED (no unresolved finding). Correction is different from the old predicate, not a logical superset: real body-purpose text AND exact metadata title replace the unsatisfiable identity-in-body check. Historical author intent/source-change chronology remain UNKNOWN. All905originalM9files remain intact; no old score is changed. Actual HTML-body evidence and independent-source evidence both rule out missing original identity text in Markdown for these two cases.

Criterion integrity: APPROVED_AFTER_REMEDIATION, conditional execution held for a fresh owner grant and explicit readable frozen JS caller-option consent. No live success or full acceptance claimed. New20-target run remains NOT_RUN. Each outcome and commit is in dispositions.json; read-only review provenance and verbatim reports are retained. Source-equivalence fix R27 preserves real execution timestamps/SHAs instead of retagging old evidence.
