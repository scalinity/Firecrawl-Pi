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
- R01: PENDING
- R02: PENDING
- R03: PENDING
- R04: PENDING
- R05: PENDING
- R06: PENDING
- R07: PENDING
- R08: PENDING
- R09: PENDING
- R10: PENDING
- R11: PENDING
- R12: PENDING
- R13: PENDING
- R14: PENDING
