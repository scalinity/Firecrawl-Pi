## Code Review: PRE-M9 provider closure

### Summary

Two independent fresh agents (DB1 debugger and CA1 code auditor) reviewed the diff `c622e80..44fc097`,
all 15 changed files, their relevant callers, and redacted evidence. **Model substitution:** Opus 5.5
is unavailable in this Codex runtime; both reviewers ran GPT-6.1 Sol at high effort, with no inherited
execution context. They ran no tests, builds, SSH commands or provider dispatches. One critical and
two warnings require remediation before live dispatch.

Scope: changed code plus enclosing functions/callers; new scripts in full; deployment/version metadata
and available fixture evidence. M8 historical interpretation, M9 F13/onboarding/incident agent/final
acceptance, publication, provider-account changes and credential values were outside this review.
All paths below are repository-relative. This report supplements the historical milestone reviews.

### 🔴 Critical Issues (Must Fix)

1. **C1 — Paid authorization can survive the validation window** — `scripts/pre-m9/pi-validation.sh:40`
   _(corroborated: both agents; CA1 critical, DB1 warning; higher severity retained)_
   - Problem: A transient one-shot timer is the sole expiry control. Compose failure under `set -e`
     leaves the paid container configured with `restart: unless-stopped`; adapters retain a boolean
     authorization without an absolute deadline (CWE-613).
   - Risk: Start validation → Docker is unavailable when the timer invokes stop → Compose fails and
     cleanup exits → Docker later revives the paid container. The existing M8 stack unit intentionally
     does not reconcile on a daemon restart, so unused caps remain spendable after the grant expires;
     a later UTC month renews them. Independently flagged by both reviewers.
   - Fix: Keep the cleanup timer, disable restart for the temporary container, and enforce a validated
     absolute lease dynamically before every new paid dispatch, including after asynchronous waits.
     Already dispatched work may settle and clean up.
     ```js
     export function paidDispatchActive(policy, enabled, now = Date.now()) {
       return enabled && (policy.validationExpiresAt === undefined ||
         now < Date.parse(policy.validationExpiresAt));
     }
     // Paid adapters reject an expired lease before reservation and before sending new work.
     ```
     ```yaml
     services:
       retrieval-service:
         restart: "no"
     ```

### 🟡 Warnings (Should Fix)

1. **W1 — Malformed model envelopes skip conservative settlement** — `services/retrieval/src/extract.mjs:190`
   _(unique to DB1's lane; CA1 independently noted the accounting consequence)_
   - Problem: `typeof json.model` dereferences null after an HTTP 200 malformed JSON or literal null.
   - Risk: A reservation is created → the response parser leaves null → TypeError occurs before
     settlement → HTTP 500 and a stranded RESERVED row replace bounded invalid-output handling.
   - Suggestion: Optional access and regression fixtures covering malformed/null envelopes and the
     conservative charge/one-repair limit.
     ```js
     resolvedModel: typeof json?.model === "string" ? json.model : null
     ```

2. **W2 — Added live observations have no automated verdicts** — `scripts/m6/e2e.mjs:363`
   _(corroborated: both agents)_
   - Problem: Null preservation, parser/enhanced cache, browser routing and synthetic auto escalation
     are printed but not consumed by a verifier. Non-200 or incorrect results can end with exit 0.
   - Suggestion: Add focused closure assertions, correlate ledger/log deltas, fail missing evidence,
     and test deliberately failed records. Synthetic routing remains distinct from anti-bot success.

3. **W3 — Omitted selection fields restore as disabled** — `scripts/m5/e2e.mjs:445`
   - CA1 follow-up found that omitted proxy/enhanced selections resolve to budget defaults, whereas null disables them. The old restoration collapsed both to none. Fixed before live dispatch.

4. **F1 — Resource collector predates M8 cgroup placement** — `scripts/m5/e2e.mjs`
   - The system.slice assumption failed on the current core slice. Dynamic CgroupParent collection retains the same resource assertions.

5. **F2 — M5 harness predates the third fixture engine and M6/M7 services** — `scripts/m5/verify.mjs`
   - Updated engine and service counts, credential-dependent refusal expectations and all five selection dimensions. The residential fixture engine now honors the same empty/failure sentinels. Original failed transcripts are preserved.

6. **F3 — Complex parse preview omits the table body** — `scripts/m5/e2e.mjs`
   - A real 577-character HTML table puts Bolt/Washer beyond the 300-character preview. A read-only retained-result proof now binds full text to its completed event, settled ledger and unchanged original transcript. No additional provider request was made.

7. **F4 — Live cache proof names a nonexistent client token** — `scripts/m7/e2e.mjs`
   - The added cache test used m7cache, a fixture hostname rather than the configured principal. It failed before dispatch. Both requests now use the existing m7 principal, whose canonical init grants cache scope.

### 🔵 Suggestions (Consider)

None.

### ✅ Good Practices

- Production caps remain zero and base Compose keeps paid dispatch disabled.
- Credentials use the existing restricted atomic mechanism over SSH stdin.
- Highest input/cache-write pricing bounds reservations; reported counts are validated.
- 25 local and 353 isolated ARM64 tests passed; the old cgroup collector failure is preserved.
- Synthetic challenge records explicitly avoid claims of real anti-bot success.

### Verdict

[x] Request Changes (before remediation)

### Finding outcomes

| ID | Finding | Severity | Outcome | Commit and evidence |
| --- | --- | --- | --- | --- |
| C1 | Temporal authorization | Critical | Fixed | `f45213d`; both reviewers confirmed dynamic expiry and restart protection; 82 affected local tests PASS |
| W1 | Malformed model envelope | Warning | Fixed | `e78fdaf`; DB1 confirmed bounded failure and conservative settlement |
| W2 | Machine-verifiable added proofs | Warning | Fixed | `a51ec7f`, `0daf52e`, `91fd8f4`; positive and negative verdict controls PASS; CA1 approved |
| W3 | Omitted provider restoration | Warning | Fixed | `3e1c3aa`; omitted, null and explicit fixture expression assertions PASS; CA1 approved |
| F1 | Current cgroup placement | Verification | Fixed | `44fc097`, `4707e2a`; valid real-stack resource JSON, OOM zero |
| F2 | Current fixture/service alignment | Verification | Fixed | `6ad9938`, `61d50c8`, `d50971e`; final 17-check fixture subset PASS, native suites PASS; missing-migration/contract controls FAIL as required; CA1 approved |


| F3 | Truncated complex parse preview | Verification | Fixed | `0fa0e23`, `e24de46`; D03 PASS; wrong logical/input/content hashes each FAIL; DB1 approved |
| F4 | Nonexistent cache client token | Verification | Fixed | `0fa0e23`; existing m7 principal and cache scope verified by DB1; zero dispatch before failure |

Earlier review deferrals: M5 S1 was closed by M7; M5 F11's fixture implementation was closed by M6
and its live proof is part of this closure's M6 L02. M8 F13 remains M9 scope and is not changed here.

### Remediation review

DB1 approved after read-only follow-up. CA1 confirmed C1 closed and flagged the decoded REST class
field in the new automatic-enhanced verdict (W2 follow-up); `0daf52e` corrects it to `.class`, and
`91fd8f4` tests an unrelated decoded failure. No critical issue remains. All paths are relative.
The new native ARM64 image is pinned in `15fc3aa`; 360 isolated ARM64 tests passed with zero transient containers/networks left. Both independent reviewers approved the accumulated remediations; live verification remains separate.

| M2 S6 | Search failures look like empty results (patch 0005 returned [] when the search backend failed) | Fixed: patch 0007 carries a typed PiSearchError through searxng_search, search() and the controller, and the retrieval service tells results, a true empty answer, a partial answer and each failure apart before the core sees them; W8 closed the last path to an empty result. Proven against the real SearXNG by S01 (REST) and S02 (MCP): 200 with web [] for a true empty answer, 502 SEARCH_ENGINES_FAILED, 503 SEARCH_BACKEND_UNAVAILABLE and 504 SEARCH_TIMEOUT | `7512e2a`, `2f57361`, `88ef412`, `73ec6c6` |

| M5 F11 | Two of the three live engines (Brave, DuckDuckGo) refuse the home connection | Fixed: SearXNG's residential-routed engines leave through the retrieval service's search proxy on the residential route, one reserved and settled tunnel each, and are refused, never sent directly, without the route; engine hosts are matched as the allow-list matches them and an unlisted live engine goes residential. Fixture-verified originally; real L02 residential routing now PASS in this closure, with an explicit partial warning for Brave 429 and DuckDuckGo CAPTCHA | `4745007` `c753015` `d6f2041` |

| M5 S1 | The parse cache is not really keyed by owner | Fixed: the gateway sends each principal's owner tag (sixteen hex digits of a SHA-256 of the principal) in the scrape's origin, patch 0010 carries it to the retrieval service as x-fcpi-owner, and the parse cache is read and written only under a valid tag and skipped without one; a scan-only PDF is a cache hit for its own principal and a fresh parse for another (C02) | `c5557a8`, `5ebc7b1`, `e206fc7` |

Additional safety follow-up: `5c60d9a` leaves the proxy validation cap at zero until its provider-side limit is verified. DB1 found no defect; only the explicit 200000 microUSD alternative is accepted. OpenAI/free-parser/Zyte caps and expiry remain bounded.

### Final closure follow-ups

| ID | Finding | Severity | Outcome | Commit and evidence |
| --- | --- | --- | --- | --- |
| F5 | Public HTML fixture encoding/vendor escaping | Verification | Fixed | `767bb9e`; designed raw HTML endpoint and padded Base64 validated; CA1 approved |
| F6 | Current Example Domain content sentinel | Verification | Fixed | `4707e2a`; known current paragraph retained; bad-body/wrong-provider controls FAIL; DB1 approved |
| F7 | Recorded tunnel/strategy schema | Verification | Fixed | `a5550f5`; two requests may reuse one CONNECT tunnel; literal enhanced plus HTTP mode and single settled dispatch; four verdict tests PASS; CA1 approved |
| F8 | Current posture provenance and live Cloud window | Warning | Fixed | `245a900`, `b164690`, `eae2a08`; 18 input hashes, all four driver phases, same guard, bounded connections, parent swap denial; PASS; DB1 approved |

Both independent reviewers approved the accumulated remediation. All five required live gates and five added live proofs PASS. All 14 real-provider reservations SETTLED after socket closure; no UNCERTAIN/RESERVED row remains. Paid dispatch is false, base caps zero. Opus 5.5 was unavailable; the GPT-6.1 Sol substitution remains explicit. The provider-side reduction to 0.05 GB was verified before Decodo dispatch. No provider purchase or account broadening occurred.

Exploratory legacy M5 X01/X02/X03 supplemental FAIL records remain in `evidence/M5/pre-m9-closure/raw/legacy-verifier-probe.json`: current M8 collector places container identity before its log counters, has 15 services rather than 13 and denies swap at the parent, and the restored base container has six startup lines rather than 100 workload lines. Current equivalent controls pass in `evidence/M5/pre-m9-closure/posture-verification.json`, using the retained 291-line whole fixture workload scan, current base scan, saved core logs, all live driver records and the unchanged guard window. These do not claim a retained whole log for every replaced paid container. Historical M5–M8 evidence is unchanged.
