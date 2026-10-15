## Code Review: Playground app, Agent and backend changes

### Summary
Reviewed `92b0743...0fe74d3` with two independent specialists, DB2 (debugger) and CA2 (code auditor), both GPT-6.1-Sol xhigh as a substitution for unavailable Opus 5.5. One critical issue and six warnings require remediation.

**Scope:**

- Tier 1, full new code: `LLM-DEMO.html`, `scripts/playground/server.mjs`, `scripts/playground/agent.mjs`, `tests/playground.test.mjs`, `tests/playground-agent.test.mjs`.
- Tier 1, changed lines with context and callers/callees: `services/access/src/{extractor,jsonscrape,validate}.mjs`, `services/retrieval/src/{budget,extract,server}.mjs`, and their changed tests.
- Tier 2, consistency: deployment Compose, budget/capability policies, versions lock, playground README and both canonical documents.
- Tier 3: generated overview snapshots and captured evidence received bounded consistency inspection. Historical raw captures and dependency locks were not reviewed line by line.
- Tauri native code was excluded and independently reviewed in `evidence/playground/desktop/review/REVIEW.md`.
- Reviewers ran no tests, builds, live calls or mutations. This scope covers all substantive app/backend code written during the session, including Pi model/budget propagation.

### 🔴 Critical Issues (Must Fix)

1. **A1: Partial extraction can dispatch again after budget/provider failure** - `scripts/playground/agent.mjs:213` _(unique to DB1's lane)_
   - Problem: Failed extraction units only set a partial flag. The gateway returns HTTP 200 if another unit succeeded, retaining that earlier unit's decision.
   - Risk: Chunk one requests page B → chunk two reports BUDGET_EXHAUSTED, PROVIDER_RATE_LIMITED or PROVIDER_UNCERTAIN → HTTP 200 with failed-unit metadata → Agent follows the earlier decision and dispatches B, potentially consuming more budget.
   - Fix: Retain received evidence, then stop before any next action:
     ```js
     const failedUnit = response.fcpi?.extraction?.units?.find(unit => unit.ok === false);
     // After retaining the current verified findings/result:
     if (failedUnit) {
       const failure = failedUnit.failure?.class;
       stop(typeof failure === 'string' && /^[A-Z0-9_]{1,80}$/.test(failure)
         ? failure : 'EXTRACTION_PARTIAL',
         'Page extraction did not finish; no further requests were sent.');
       break;
     }
     ```

### 🟡 Warnings (Should Fix)

1. **A2: Expected earlier missing fields permanently prevent completion** - `scripts/playground/agent.mjs:212` _(unique to DB1's lane)_
   - Problem: Any page warning permanently sets extractionPartial, including ordinary missing-required fields that a subsequent page resolves.
   - Suggestion: Distinguish missing current facts from incomplete acquisition; evaluate required structured values against the final result.
2. **A3: Follow-up search selects old candidates ahead of its own results** - `scripts/playground/agent.mjs:187` _(unique to DB1's lane)_
   - Problem: Search chooses from the entire insertion-ordered candidate map. An old unrelated link can displace a new focused result within the page cap.
   - Suggestion: Select from the current query's usable unvisited results; keep the shared map for explicit visits. Test empty follow-up results.
3. **A4: Definitive local Crawl rejection locks correction** - `LLM-DEMO.html:370` _(unique to DB1's lane)_
   - Problem: An invalid FTP URL creates pendingCrawl, receives local 400, then blocks changing to HTTPS because the pending signature is treated as uncertain forever.
   - Suggestion: Clear pending submission on a definitive pre-dispatch local rejection; preserve its key for genuine uncertainty.
4. **A5: Unsupported result-schema roots are accepted before paid work** - `scripts/playground/agent.mjs:55` _(corroborated: both agents)_
   - Problem: Wrapped validation accepts scalar/array schemas, but completion requires a non-array object. Null schemas are silently omitted by truthiness.
   - Suggestion: Validate the supplied schema itself as the documented object schema before dispatch. Cover null, array and scalar roots.
5. **A6: Required values under anyOf can be falsely considered complete** - `scripts/playground/agent.mjs:237` _(unique to CA1's lane)_
   - Problem: The new Agent caller trusts pre-existing missingRequired(), which skips anyOf. A required object branch containing a required null value passes the nullable strict shape and can report completed.
   - Suggestion: Check matching anyOf branches for required unknown values; cover missing and populated controls. The helper predates the diff, but this caller is new.
6. **A7: Unicode serialization expands valid responses beyond bridge limit** - `scripts/playground/server.mjs:48` _(unique to CA1's lane)_
   - Problem: Python's default ensure_ascii escapes non-ASCII text. Valid gateway JSON below 8 MiB can exceed the local 9 MiB envelope cap after serialization.
   - Suggestion: Use UTF-8 serialization with ensure_ascii=False and test the actual remote serializer at the byte boundary.

### 🔵 Suggestions (Consider)

None.

### ✅ Good Practices

- Fixed SSH commands use JSON stdin; credentials stay on the Pi.
- Exact Host/Origin guards and validated fixed routes protect the local bridge.
- Content is rendered as text, and navigation candidates are discovered URLs.
- Cancellation, model identity, no fallback, settled accounting and unknown usage have focused tests.
- Budget/capability hashes match the deployment lock and pinned source.

### Verdict

[x] ❌ Request Changes (critical issues)
[ ] ⚠️ Approve with Suggestions
[ ] ✅ Approve

### Remediation outcomes

All findings addressed with focused regression coverage:

| Finding | Outcome | Commit |
| --- | --- | --- |
| A1 | Fixed: retain evidence and stop on any failed extraction unit before another dispatch. | `54a9af2` |
| A2 | Fixed: later grounded results can resolve earlier missing facts; incomplete acquisition remains partial. | `943ce1d` |
| A3 | Fixed: follow-up selection uses the current search results; empty results stop. | `013b567` |
| A4 | Fixed: definitive local rejection permits correction; uncertain submissions retain their original key. | `ca5d2f7` |
| A5 | Fixed: reject null, scalar and array root schemas before dispatch. | `d2f220c` |
| A6 | Fixed: check required unknown values in matching anyOf branches. | `a9c1f66` |
| A7 | Fixed: remote Python serializes UTF-8 without ASCII expansion; actual serializer tested with a 5.4 MB Unicode response. | `3a4528b` |

Verification: 43 Node tests passed across the desktop, bridge and Agent suites. Browser regression checks passed for corrected local rejection and preserved uncertain submission. The earlier review verdict above records the original findings. Attribution tags DB1/CA1 refer to the debugger/auditor lanes in this pair (DB2/CA2).
