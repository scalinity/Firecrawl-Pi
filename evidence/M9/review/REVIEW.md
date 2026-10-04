## Code Review: M9

### Summary

Two fresh independent native Claude Code contexts reviewed 55d756c5fb12fc5e741ab4145c47a7d7fdee1237..bec90502fcff74e04b3fde5ac772cece47d7e417 on exact claude-opus-5-5. The runtime Agent selector has no Opus alias, so native debugger/code-auditor contexts implement the permitted equivalent review mechanism; there is no model substitution. The 61-file change triggered the large-change guard: incident/auth/deployment/acceptance/validation/onboarding paths received full review; legacy Redis, tests and docs were skimmed; generated overview/metadata received consistency checks separately. The debugger's restricted hook prevented its intended diff command, so its direct full-file review has that confidence limit. Complete independent reports are DEBUGGER.md and AUDITOR.md.

### 🔴 Critical Issues (Must Fix)

1. **DB1-C1 / CA1-C1: reject stale proposal bases.** Concrete traces and proposed patches are retained in the independent reports.
2. **DB1-C2 / CA1-W2: make preparation failures explicit and recoverable.** Concrete traces and proposed patches are retained in the independent reports.
3. **DB1-C3 / CA1-C2: actions must not block outage notices.** Concrete traces and proposed patches are retained in the independent reports.
4. **CA1-C3: ignored files must never enter approved images.** Concrete traces and proposed patches are retained in the independent reports.
5. **DB1-C4 / CA1-W8: recompute acceptance from bound raw evidence.** Concrete traces and proposed patches are retained in the independent reports.
6. **DB1-C5 / CA1-C4: retain reachable recovery when a candidate gateway fails.** Concrete traces and proposed patches are retained in the independent reports.

### 🟡 Warnings (Should Fix)

Preserve paired crash-safe deployment and source import, protect existing tests, enforce UTC launch/retention bounds, separate completed resumes from old results, verify native clients against exact output and Pi arrival, strengthen owner approval identity, and cover the privileged control paths with fixtures. Individual evidence and suggestions remain in both independent reports.

### 🔵 Suggestions (Consider)

Fix report-link consumption/notification loops, global-config crash recovery, shutdown cleanup, metadata wording and fresh-init order; retain the owner's existing Git identity.

### ✅ Good Practices

Ed25519 grants, public-key-only gateway verification, durable exclusive nonce consumption, independent root verification, bounded unprivileged model execution, isolated test containers, secret-free native header helpers and honest pending-live states are present.

### Verdict

[x] ❌ Request Changes
[ ] ⚠️ Approve with Suggestions
[ ] ✅ Approve

## Finding dispositions

| Finding | Disposition | Evidence / commit |
|---|---|---|
| DB1-C1 | FIXED | 863a2dd: stale proposal bases rejected before tests or deployment; root fixture PASS. |
| DB1-C2 | FIXED | 93131c3, 07952a5, cccbb0c, 9a2f62b: OAuth/binary preflight, standalone owner-readable clone, UTC ledger and failure cleanup; root fixtures PASS. |
| DB1-C3 | FIXED | 931e14e: outage notification remains independent of unavailable action infrastructure; root fixture PASS. |
| DB1-C4 | FIXED | 114d913, 438eb60, 9215317, fe0100d: raw-evidence producers and recomputation, negative controls, exact content/protocol/resource checks; 19 local tests PASS. Acceptance remains ungranted pending its live inputs. |
| DB1-C5 | FIXED | a94a949, f0d315e, cccbb0c, 922d9af: retained accepted images and paired state/source return with interruption cleanup; partial cutover and failed rollback fixtures PASS. Real gateway startup FAIL and recovered image remain recorded. |
| DB1-W1 | FIXED | 93131c3: failed resume cannot harvest an old result; terminal status and credential cleanup; root fixture PASS. |
| DB1-W2 | FIXED | d8cba60: bounded named source allowlist, immutable existing gating tests and denied ignored/nested bytes; new direct test allowed; root fixtures PASS. |
| DB1-W3 | FIXED | a94a949, f0d315e, cccbb0c: separate bounded apply unit, cleanup traps, fixed hold, paired restore and rollback; root fixtures PASS. |
| DB1-W4 | FIXED | 9a9c224: trusted Tailscale owner login factor supplements signed grant; spoofed/untrusted identity denied by actual gateway contract fixtures. |
| DB1-W5 | FIXED | 325d82d, 9a2f62b, fe0100d: /static.html with exact native tool-result parsing, one request and correlated Pi arrival; positive and negative parser tests PASS. Native execution still held until this remediation record. |
| DB1-W6 | FIXED | 017d249, 0c76670, b45c626: 15 privileged control fixtures PASS at fe0100d; covers preflight, stale apply, ledger, path denial, source metadata, paired rollback and actual local archive deployment. |
| DB1-S1 | FIXED | 93131c3, 9a2f62b: root-owned UTC counter, four launches including resume, damaged ledger fail closed; fifth launch fixture PASS. |
| DB1-S2 | FIXED | 93131c3: secret detection consumes complete input and avoids grep SIGPIPE false rejection; hashed controls PASS. |
| DB1-S3 | FIXED | 9a9c224: immutable report view avoids action consumption and report-link notification loops; HTTP contract tests PASS. |
| DB1-S4 | FIXED | 438eb60: AC22 is a conditional binary PASS with capability NOT_REQUIRED and selected profile NOT_ENABLED; no enabled hosted parity claimed. |
| DB1-S5 | FIXED | 07952a5: owner subscription refresh is separated from isolated model; binary bind retained while owner secret directories inaccessible. Pinned/preflight fixtures PASS; actual model launch remains held until this record. |
| DB1-S6 | FIXED | f0d315e: rerunning global installation repairs a missing header helper without duplicating or replacing other servers; local fixtures PASS. |
| DB1-S7 | FIXED | f0d315e, fe0100d: bounded validation cleanup removes consent/overrides, restores zero caps, stops retrieval if restoration fails; expiry and cleanup tests PASS. No expired grant reused. |
| DB1-S8 | FIXED | 746088c: notification names the incident agent and blocked/rejected proof notices are independent and deduplicated; root fixture PASS. Suggested fcpi branch prefix rejected under owner instruction requiring codex/. |
| DB1-S9 | FIXED | 4fbfe72: guarded fresh initialization precedes gateway mount/recreation; audited data device required; privileged guard fixtures PASS. |
| CA1-C1 | FIXED | 863a2dd: stale proposal bases rejected before tests or deployment; root fixture PASS. |
| CA1-C2 | FIXED | 931e14e: outage notification remains independent of unavailable action infrastructure; root fixture PASS. |
| CA1-C3 | FIXED | d8cba60, 6e32597, df51e27: named tracked tree and candidate archive bind tested bytes to deployed bytes; ignored content denied; root fixtures PASS. |
| CA1-C4 | FIXED | a94a949, f0d315e, cccbb0c, 922d9af: retained accepted images and paired state/source return with interruption cleanup; partial cutover and failed rollback fixtures PASS. Real gateway startup FAIL and recovered image remain recorded. |
| CA1-W1 | FIXED | 93131c3, 9a2f62b: root-owned UTC counter, four launches including resume, damaged ledger fail closed; fifth launch fixture PASS. |
| CA1-W2 | FIXED | 93131c3, 07952a5, cccbb0c, 9a2f62b: OAuth/binary preflight, standalone owner-readable clone, UTC ledger and failure cleanup; root fixtures PASS. |
| CA1-W3 | FIXED | 93131c3: failed resume cannot harvest an old result; terminal status and credential cleanup; root fixture PASS. |
| CA1-W4 | FIXED | a94a949, f0d315e, cccbb0c: separate bounded apply unit, cleanup traps, fixed hold, paired restore and rollback; root fixtures PASS. |
| CA1-W5 | FIXED | a94a949: private Pi history export/import and ancestry guard prevent workstation overwriting a Pi-only approved fix; local fixture coverage PASS. No remote publication. |
| CA1-W6 | FIXED | d8cba60: bounded named source allowlist, immutable existing gating tests and denied ignored/nested bytes; new direct test allowed; root fixtures PASS. |
| CA1-W7 | FIXED | 9a9c224: trusted Tailscale owner login factor supplements signed grant; spoofed/untrusted identity denied by actual gateway contract fixtures. |
| CA1-W8 | FIXED | 114d913, 438eb60, 9215317, fe0100d: raw-evidence producers and recomputation, negative controls, exact content/protocol/resource checks; 19 local tests PASS. Acceptance remains ungranted pending its live inputs. |
| CA1-W9 | FIXED | 325d82d, 9a2f62b, fe0100d: /static.html with exact native tool-result parsing, one request and correlated Pi arrival; positive and negative parser tests PASS. Native execution still held until this remediation record. |
| CA1-W10 | FIXED | 017d249, 0c76670, b45c626: 15 privileged control fixtures PASS at fe0100d; covers preflight, stale apply, ledger, path denial, source metadata, paired rollback and actual local archive deployment. |
| CA1-S1 | FIXED | f0d315e: callback replacement uses literal-safe handling; local callback fixture PASS. |
| CA1-S2 | FIXED | 93131c3: secret detection consumes complete input and avoids grep SIGPIPE false rejection; hashed controls PASS. |
| CA1-S3 | FIXED | 9a9c224: immutable report view avoids action consumption and report-link notification loops; HTTP contract tests PASS. |
| CA1-S4 | FIXED | 6e32597, 746088c: infrastructure block leaves approval unconsumed; malformed/expired proof rejected and noticed, with separate apply queue; privileged infrastructure fixture PASS. |
| CA1-S5 | FIXED | 07952a5: owner subscription refresh is separated from isolated model; binary bind retained while owner secret directories inaccessible. Pinned/preflight fixtures PASS; actual model launch remains held until this record. |
| CA1-S6 | REJECTED | Owner AGENTS instructions require existing Git configuration and prohibit adding commit identity. Existing Pi owner configuration is reused unchanged; hooks/fsmonitor are disabled during named trusted commits. Root relocation fixture copies the existing owner file, without identity overrides (9c118c4). |
| CA1-S7 | FIXED | 746088c: notification names the incident agent and blocked/rejected proof notices are independent and deduplicated; root fixture PASS. Suggested fcpi branch prefix rejected under owner instruction requiring codex/. |
| SELF-01 | FIXED | a42d5f1: static overview and unit state now show M9 IN_PROGRESS; no acceptance or later milestone advertised. |
| SELF-02 | FIXED | 325d82d, 9a2f62b, fe0100d: /static.html with exact native tool-result parsing, one request and correlated Pi arrival; positive and negative parser tests PASS. Native execution still held until this remediation record. |

Remediation complete for the saved review findings. /address fixes are committed locally; no push occurred. Relevant verification: 19 focused local tests, 273 isolated Pi tests (77 access, 192 retrieval, four actual gateway contracts), and 15 privileged control fixtures PASS. Full acceptance remains IN_PROGRESS. Held paid/public-provider, restore/rollback and native-client/incident execution now proceed in their required order, with fresh owner budget authorization required before paid or free-credit provider dispatch.

| Earlier finding | Disposition | Evidence / commit |
|---|---|---|
| M8-F13 | FIXED | a2ed8a5: restricted stdin Redis helper separates ops INFO from existing core-role fixture SCAN/EXPIRE; four local tests PASS. Current M3 expiry regression remains required. |
| M9-REG-01 | FIXED | 6ec7318, 8d9f9b5, f2b2593: current Docker cgroup parents and disposable revocation-token prerequisite/privilege/read scope. Initial probe FAIL preserved; current regression rerun pending. |
| M9-REG-02 | FIXED | 45ea4a3: explicit cold fixture hint and correlated M6 learned route replace obsolete cold-only browser assumption. Initial negative oversized renderer OOM and failing raw probes preserved; current regression rerun pending. |
| M9-LIVE-01 | FIXED | 31ecbf4: selected private TLS :8443 origin accepted by the held live producer; syntax checked. |

| M9-REG-03 | FIXED | Native tool returned exact Setext heading and a 200 Pi arrival; parser now admits either valid ATX or Setext heading and rejects a non-heading. Initial false negative retained. M3 cancellation fixture limit changed from 30 (correctly refused by M6 paid-disabled bulk policy) to 12; no egress protection changed. Affected tests rerun below. |

| M9-NATIVE-01 | FIXED | Native Codex model metadata refreshed 2026-10-03 offers gpt-6-sol, while the inherited gpt-6.1-sol returns account unsupported before any tool call. Only the client verification invocation now selects supported gpt-6-sol; global model/server settings remain preserved. Existing unrelated Exa OAuth warning is not remediated. Parser rejects built-in shell/web/file/subagent side effects. |

## Current remediation verification, 2026-10-03

At e683c919bffb43daeba0cd7c00138a6665fb40ed, 15 privileged control fixtures, 273 isolated Pi tests and 19 local tests passed. M8-F13's current M3 expiry phase passed. M9-REG-01's corrected authentication and resource probes passed; M9-REG-02's R01/R02/R03/R04/S02 checks passed. Native Claude Code and Codex each returned the required fixture heading from one globally configured MCP scrape, correlated to one HTTP 200 Pi arrival. The initial false parser result, unsupported model result, schema refusal and deliberately injected gateway-fault result remain saved beside the successful proofs. These results do not grant final acceptance.

| Additional finding | Disposition | Evidence / commit |
|---|---|---|
| M9-REG-04 | FIXED | 875b3a6: M8's closing collector reads the M9-owned BEFORE snapshot when its evidence root is overridden. Historical M8 evidence remains untouched. |
| M9-REG-05 | FIXED | 255e732: MCP cancellation uses a 12-page fixture crawl within the selected paid-disabled policy; fresh M4-P04 PASS. The original 30-page bulk refusal remains saved. |
| M9-REG-06 | FIXED | 43f6849, f5f373b: current acceptance rows also require their associated authorization, limits, accounting, cleanup, recovery and observability contracts. Missing inputs remain NOT_RUN. |
| M9-REG-07 | FIXED | c0371b5, a0ae1ed: complete billing reservation/usage row hashes and every ledger/archive/registry hash survived the 09:35 full container recreation; fresh M3-X02 PASS. Both prior cleanup-overlap FAIL records remain preserved. |
| M9-REG-08 | FIXED | e683c91: cold PDF fixture bytes vary with the existing fresh nonce, so a retained PRE-M9 parse cannot substitute for a new scan/parser check. Fresh M5-D02 PASS; initial retained-cache failure remains saved. |
| M9-REG-09 | REJECTED | No cache defect established: the initial search engine timeout correctly produced uncached partial results. The serialized rerun passed all 12 selected M5 checks, including S03, without a cache or request-retry change. Both runs remain saved. Concurrent test load overlapped the failure; its causal role is unverified. |
| M9-REG-10 | REJECTED | The first M7 run lost its connection during the scheduled backup's bounded stack quiescence at 07:30 UTC. Container timestamps and backup history establish that overlap. The failed run is preserved; the complete rerun after successful backup completion passed its webhook, cleanup, cache and error-classification checks. This is an expected availability hold, not a transport defect. |
| M9-REG-11 | FIXED | 7664e0a: the historical E04 verifier assumed an absent Zyte credential. Current paid-disabled routing is now required regardless of credential presence, with both readiness surfaces unavailable and no provider dispatch. Five synthetic controls accept present/absent credentials and reject available readiness, available routing or an unclassified credential state. No runtime egress policy changed. |
| M9-REG-12 | FIXED | Narrow owning-M2 authorization: 4a305dc, f4cbae8, 31668e6, 3ebf4f5 and 79ad1d1 repair canonical classification without allowing any forbidden destination. Final actual native Chromium M2-S03 PASS at da4b451: 16 SSRF_DENIED and four CLOUD_DENIED browser attempts, actual refusal joins, permitted public cross-host positive, unchanged own 403, generic aborted-navigation controls and released permits/healthy services. Original failure hash 326688cdd8f595b7051638327f859ec8865b5918608f0f2f71af857469121599 retained unchanged. |

### Live-remediation delta review

Two further fresh native contexts used the requested Opus 5.5 model. The initial pair found the enabled cleanup race; both final reviewers found no critical issues or warnings. The final pair received the exact diff and reviewed enclosing files/callers with Read/Grep. The first pair could not use git through its read-only hook; that limitation is preserved in its separate reports. `DELTA-DEBUGGER.md`, `DELTA-AUDITOR.md` and `delta-model-provenance.json` are the final delta record.

| Finding | Disposition | Evidence and outcome |
| --- | --- | --- |
| M9-INC-01 | FIXED | Optional absent private paths prevented systemd namespace startup. Only .ssh and .codex use systemd's optional-path prefix; required protected paths remain strict. The failed 226/NAMESPACE launch and manual inactive-token removal are preserved. c4c84f3: namespace settings now start successfully; the next run exposed separate diagnostic/tool-output defects recorded below. 68c6c1e: final namespace and schema diagnosis proof passed; source-read onboarding remains a separate gate. |
| M9-INC-02 | FIXED | Disabled controller skipped cleanup when no agent trap had started. Both disabled/enabled cleanup passes now hold the preparation lock; concurrent preparation and active-unit token preservation have fixtures. Busy preparation reports exit 3. c4c84f3: 21 privileged fixtures PASS, including enabled/disabled lock exclusion, busy launch status and active-token preservation. |
| M9-INC-03 | FIXED | Thousands of privileged archive hash commands extended the probe across legitimate retention deadlines. A single unprivileged recursive scan preserves every content/name hash and the unchanged ledger/billing/registry assertions. Both initial failures are saved; the second coincides with 31 expired results and 43 collected files. a0ae1ed: fresh full M3-X02 PASS after every archive/ledger/billing/registry assertion ran unchanged. |
| M9-DELTA-S1 | FIXED | Busy/active preparation will postpone automatic investigation without consuming a model launch, while other preparation failures remain owner-attention blockers. The four-launch daily cap and one-agent limit remain unchanged. c4c84f3: the active-agent automatic-path fixture PASS, with no worktree, blocked marker or consumed launch. |
| M9-DELTA-S2 | FIXED | The archive process will stream object bytes and enforce its own two-minute deadline, so killing a workstation Docker client cannot leave an unbounded in-container probe. A timeout still fails the unchanged verifier. a0ae1ed: the two-minute streaming checkpoint completed within the successful full persistence run. |
| M9-DELTA-S3 | REJECTED | The two short cleanup passes intentionally have different responsibilities: the pre-gate pass removes inactive authentication without dispatch/notices; the enabled pass also records failures and ages work. A shared abstraction adds scope without changing the verified lock invariant. Both paths have real lock-exclusion fixtures. |

### Incident acceptance bound review

A further fresh Opus 5.5 pair reviewed the shared incident verdict, producer and binary gate. Both reported no critical finding. Their two warnings and suggestions are addressed as follows; reports and provenance are saved before remediation.

| Finding | Disposition | Evidence and outcome |
| --- | --- | --- |
| M9-BOUND-W1 | FIXED | Null or primitive raw JSON must return false, so the binary runner keeps its complete evidence report. Add malformed/edited raw controls. 7724ec4: committed; focused controls PASS. |
| M9-BOUND-W2 | FIXED | Raw systemd swap/tasks strings require exact 0/128 values; no Number coercion of null, empty or false. Add missing and malformed field controls. 7724ec4: committed; focused positive/negative controls PASS. |
| M9-BOUND-W3 | FIXED | Capture and validate actual namespace privileges, permitted write paths, protected paths and CLI binding. Label the tool set as declared by the pinned, source-bound agent/hook rather than a systemd observation. 7724ec4: actual namespace/resource properties are captured and the negative controls PASS. The native unit then started safely; diagnostic output integration required 68c6c1e. 68c6c1e: native isolation/authentication/structured diagnosis passed; source-read onboarding is separately tracked in M9-INC-04. |
| M9-BOUND-S1 | FIXED | Remove the overwritten inline success rule; the producer and final gate use only the shared verdict. 7724ec4: committed; focused positive/negative controls PASS. |
| M9-BOUND-S2 | FIXED | Negative controls cover missing/empty/mixed models, every missing bound, null/empty swap, stale hash, wrong incident and a fabricated invoice. An existing failed proof reports FAIL, not NOT_RUN. 7724ec4: committed; focused positive/negative controls PASS. |
| M9-BOUND-S3 | REJECTED | The exact model baseline is intentional. A helper model or unapproved suffix fails closed and remains unverified; accepting a different model would silently alter the pin. |

### Native diagnostic integration review

The real bounded run at 7724ec4 started with all pinned isolation/resource settings and erased its token, but could not read its 718767-byte input or use native StructuredOutput. Raw failed model output remains private, with a public hash/usage/failure record. Two fresh Opus 5.5 contexts found no critical issue and no reachable new authority. Their warnings and all suggestions are addressed below before the next bounded run.

| Finding | Disposition | Evidence and outcome |
| --- | --- | --- |
| M9-DIAG-W1 | FIXED | The readable projection also bounds every serialized line, using short content-line arrays plus a 20KiB/1000-line total limit. Head/tail observation controls must survive native Read limits. 68c6c1e: committed; 26 local and 21 privileged fixtures PASS. The native input/schema integration passed at incident 17685034. |
| M9-DIAG-W2 | FIXED | Remove excerpts before metadata; disclose any final metadata omission. Retain the owner-only complete tarball in this incident for its 14-day lifetime and include its SHA plus a direct original-file manifest SHA. 68c6c1e: committed; 26 local and 21 privileged fixtures PASS. The native input/schema integration passed at incident 17685034. |
| M9-DIAG-S1 | FIXED | Recent notices and supervisor records get priority above ordinary logs; omission, priority, byte/hash and old/wrong bind tuple controls are added. 68c6c1e: committed; 26 local and 21 privileged fixtures PASS. The native input/schema integration passed at incident 17685034. |
| M9-DIAG-S2 | REJECTED | Dynamic container-log ranking is an additional heuristic. The small fixed projection preserves prioritized status/incidents, explicit truncation/omission, original metadata and an owner-only complete bundle; absent observations cannot establish health. No dynamic ranking or automatic reading of additional paths is introduced. |
| M9-DIAG-S3 | REJECTED | An extra incident-ID environment variable duplicates the existing trusted root path identity: the launcher always exports exactly W/input.json, where W has a validated 8-hex ID. The hook derives this immutable ID and rejects malformed/non-string/mismatched schema handles. |
| M9-DIAG-S4 | REJECTED | The tool set is explicitly declared by the pinned, source-bound agent/hook/schema, not claimed as a systemd observation. StructuredOutput is CLI schema serialization without file, shell or network authority; actual namespace/resource properties and raw model usage are separately checked. No broader tool authority is granted. |
| M9-DIAG-S5 | FIXED | Missing diagnostic directories and bad scan markers fail without output, with a clear preparation error. The redaction marker matches the anchored M8-generated format. 68c6c1e: committed; 26 local and 21 privileged fixtures PASS. The native input/schema integration passed at incident 17685034. |

### Native source inspection follow-up

| Finding | Disposition | Evidence and outcome |
| --- | --- | --- |
| M9-INC-04 | FIXED | Incident 17685034 produced a valid healthy diagnosis but attempted the worktree directory and README, which the file-only guard correctly denied. Source inspection was unverified. The launch prompt now names exact existing incident detector/status/probe files without widening permissions; the producer and binary gate require a hash-bound native transcript with a paired successful detector source Read. 591dff2: both Opus 5.5 delta reports were saved before remediation; all affected fixtures passed, then incident e69e0944 passed actual hash-bound source inspection, isolation and token cleanup. The earlier bounded diagnosis and its $0.2164112 API-equivalent estimate remain preserved; no invoice or source inspection success is inferred. |

### Native source-read delta review

Two fresh Opus 5.5 reviewers found no critical issue or false acceptance path. Reports and model provenance were saved before remediation.

| Finding | Disposition | Evidence and outcome |
| --- | --- | --- |
| M9-SOURCE-W1 | FIXED | A failed private transcript fetch must still write this run’s failed proof instead of leaving an older summary. 591dff2: transcript fetch now uses the same empty-input handling as the raw-result fetch; missing/malformed/stale/denied controls PASS and acceptance fails closed. |
| M9-SOURCE-W2 | REJECTED | The pinned Pi CLI’s actual prior successful diagnostic Read uses string content and tab-separated numbered lines. The private transcript hash and observed format are recorded in work/native-read-format.json. No guessed compatibility broadening is needed. A future binary update still requires new pin/protocol evidence. |
| M9-SOURCE-S1 | FIXED | 591dff2 is committed, deployed and staged in the private mirror. All 26 local, 21 privileged and 273 isolated Pi fixtures PASS before the held native execution. No origin push occurred. |

### Final acceptance coverage follow-up

| Finding | Disposition | Evidence and outcome |
| --- | --- | --- |
| M9-REG-13 | FIXED | A duplicate AC23 property overwrote M6-R07 in the current evidence list. Restore the provider-outage isolation gate beside the M8 isolation contracts. 6e43824: the current M6 verifier recomputed R07 PASS from the unchanged component/raw fixture; the actual selected M9 AC23 evidence list contains R07. No runtime routing rule is altered. |
| M9-REG-14 | FIXED | The review verifier checked only the initial 43 rows, leaving later finding outcomes unchecked. Require a unique ID and exact FIXED/REJECTED/RETURNED outcome for every recorded M8/M9 and original review finding; 6e43824: all 28 local controls PASS, including padded, optional-bar, decorated, malformed, pending, duplicate and missing finding controls; original 43 IDs are required exactly. |

### Acceptance coverage independent review

Both fresh Opus 5.5 reviewers confirmed the restored M6-R07 requirement. They found a formatting-dependent omission in the proposed review-row parser, including a reachable padded RETURNED row that could erase the M2 blocker. Reports and provenance were saved before this remediation.

| Finding | Disposition | Evidence and outcome |
| --- | --- | --- |
| M9-COVERAGE-W1 | FIXED | Parse every finding-table body row, require the exact original 43 IDs and exact terminal dispositions, and reject unknown/malformed/duplicate IDs instead of silently omitting them. 6e43824: the whitespace/optional-bar/malformed controls PASS and preserve RETURNED outcomes, while incomplete review rows block acceptance. |
| M9-COVERAGE-S1 | FIXED | An existing malformed/incomplete review reports FAIL; an absent review reports NOT_RUN. 6e43824: both fail-closed states are enforced; all 28 local controls PASS. |
| M9-COVERAGE-S2 | REJECTED | The direct AC23 correction restores the single dropped R07 requirement. Converting the entire supplementary map to a new representation adds churn; focused coverage verification will assert that the actual M6 verifier receives and evaluates R07. No runtime or image changed, so native image rebuilding is neither necessary nor authorized. Actual raw-tested source and current verifier source remain distinct in evidence. |

### Evidence endpoint follow-up

| Finding | Disposition | Evidence and outcome |
| --- | --- | --- |
| M9-REG-15 | FIXED | The reboot’s stderr contains the real bare SSH hostname, while the scanner only compared the full user@host value. Preserve the original outside Git, redact the complete literal hostname in this exact evidence file, and include the configured hostname’s bare form in known-endpoint scanning. Functional Pi target configuration remains intact. No credentials appeared. 14de77b: committed/deployed with 29 local and 21 privileged controls PASS. Current code equality remains strict; native proof and older source-bound operational raw are still held for final collection. |

| M9-REG-16 | FIXED | M9 adds recovery_attempted notices, but the older supervisor probe counted every matching filename as an opened/cleared incident. The fresh probe stopped after the first actual restart. Preserve the original fault run and count only opened/cleared notices for the exact normalized key, then rerun only this case without altering the production restart ledger. 14de77b: all local controls PASS; actual rerun gave restarts 1/2/3 with zero incidents, fourth refused with one opened notice, recovered with exactly one cleared notice. REST stayed 200 throughout. Full initial raw and both fragment sources remain preserved. |

### Operations delta review

Two fresh exact Opus 5.5 contexts reviewed the endpoint detector and supervisor-probe diagnosis. Their reports and provenance were saved before this address pass.

| Finding | Disposition | Evidence and outcome |
| --- | --- | --- |
| M9-OPS-DB-W1 | FIXED | Preserve the whole initial run; write the rerun separately and replace only the selected supervisor section. Add a read-only empty-window refusal to the probe. Never reset the production restart ledger. 14de77b: all local controls PASS; actual rerun gave restarts 1/2/3 with zero incidents, fourth refused with one opened notice, recovered with exactly one cleared notice. REST stayed 200 throughout. Full initial raw and both fragment sources remain preserved. |
| M9-OPS-DB-W2 | FIXED | Current source binding remains strict. Older raw-tested sources remain explicit and block acceptance where current code differs; affected fixtures and source-bound live proofs must run at the settled final code, including the next legitimate UTC-day native launch. No equality exception is added. 14de77b: committed/deployed with 29 local and 21 privileged controls PASS. Current code equality remains strict; native proof and older source-bound operational raw are still held for final collection. |
| M9-OPS-DB-W3 | REJECTED | Exact includes checks intentionally fail closed on possible endpoint substrings. The positive/negative endpoint control passes; no matching historical source/evidence path is in the post-baseline changed set. Historical/private identifiers still require a full-history publication review, which is outside this unpushed task. |
| M9-OPS-DB-S1 | FIXED | Count only exact normalized-key opened/cleared filenames and always print an integer; include absent directory, temporary file, misleading key and action-kind controls. 14de77b: all local controls PASS; actual rerun gave restarts 1/2/3 with zero incidents, fourth refused with one opened notice, recovered with exactly one cleared notice. REST stayed 200 throughout. Full initial raw and both fragment sources remain preserved. |
| M9-OPS-DB-S2 | FIXED | Redact the exact configured bare-host literal in the fault driver output after the full SSH target replacement. Functional SSH configuration remains intact. 14de77b: committed/deployed with 29 local and 21 privileged controls PASS. Current code equality remains strict; native proof and older source-bound operational raw are still held for final collection. |
| M9-OPS-DB-S3 | FIXED | Saved reports contain no real endpoint literals or private paths. Raw native results remain owner-private outside Git. |
| M9-OPS-CA-W1 | FIXED | The probe always prints one integer, including when the outbox is absent. 14de77b: all local controls PASS; actual rerun gave restarts 1/2/3 with zero incidents, fourth refused with one opened notice, recovered with exactly one cleared notice. REST stayed 200 throughout. Full initial raw and both fragment sources remain preserved. |
| M9-OPS-CA-W2 | FIXED | Assert zero recent service restarts before injection; refuse instead of clearing or changing the shared ledger. 14de77b: all local controls PASS; actual rerun gave restarts 1/2/3 with zero incidents, fourth refused with one opened notice, recovered with exactly one cleared notice. REST stayed 200 throughout. Full initial raw and both fragment sources remain preserved. |
| M9-OPS-CA-W3 | FIXED | Commit, deploy and verify hashes before the corrected probe runs; exact tested source is recorded in the rerun. 14de77b: committed/deployed with 29 local and 21 privileged controls PASS. Current code equality remains strict; native proof and older source-bound operational raw are still held for final collection. |
| M9-OPS-CA-W4 | FIXED | Preserve initial failed raw and write the single-case rerun separately; accepted M8 evidence is not overwritten. 14de77b: all local controls PASS; actual rerun gave restarts 1/2/3 with zero incidents, fourth refused with one opened notice, recovered with exactly one cleared notice. REST stayed 200 throughout. Full initial raw and both fragment sources remain preserved. |
| M9-OPS-CA-S1 | FIXED | Match the fixed timestamp-width prefix and literal opened/cleared kind plus literal full normalized key. A different kind/key ending in the target is ignored. 14de77b: all local controls PASS; actual rerun gave restarts 1/2/3 with zero incidents, fourth refused with one opened notice, recovered with exactly one cleared notice. REST stayed 200 throughout. Full initial raw and both fragment sources remain preserved. |
| M9-OPS-CA-S2 | REJECTED | Only the actual full configured literal is targeted; adding guessed case variants is outside this observed redaction. The scanner fails closed on the actual configured endpoint and catches the preserved failure. No blanket rewrite is introduced. |
| M9-OPS-CA-S3 | FIXED | Historical accepted evidence is not rewritten. This scanner covers current/new M9 evidence and post-entry changed paths; future publication requires a full-history scan, including every commit after remote 5ab47b9. |
| M9-OPS-CA-S4 | REJECTED | Missing config values already fail closed. The current required target configuration is present; a speculative parser cleanup is outside the two observed corrections. |

### Collector-source binding follow-up

| Finding | Disposition | Evidence and outcome |
| --- | --- | --- |
| M9-REG-17 | FIXED | Recomputed legacy results name the verifier checkout, while their raw collector revisions can be older. M9 currently binds the verifier revision and omits the separate legacy G01 raw-source check. Independently review and enforce the actual exercised source before any final acceptance. Do not relabel old raw, broaden equality, rebuild unchanged images or alter historical M8 interpretation.  9e95c1aaf60d3ec19bd8109490d867cc0bac6137: 36 local contract tests PASS; real clean Pi tree compared with immutable archive, byte/stdin/relative-path/side-output collector exercised in an isolated temporary Git fixture. Current operational recollection remains required. |

### Independent collector-source review

Both exact Opus 5.5 reviewers confirmed a reachable false-acceptance path. Original native reports and format-normalized views were saved before this address pass.

| Finding | Disposition | Evidence and outcome |
| --- | --- | --- |
| M9-RAW-DB-C1 | FIXED | Keep verifier and actual exercised source separate. Bind every selected regression input to an actual collection receipt and reject stale raw meta. Immutable image build sources remain separate.  9e95c1aaf60d3ec19bd8109490d867cc0bac6137: 36 local contract tests PASS; real clean Pi tree compared with immutable archive, byte/stdin/relative-path/side-output collector exercised in an isolated temporary Git fixture. Current operational recollection remains required. |
| M9-RAW-DB-W1 | FIXED | Every selected M9-owned raw/config/directory input requires a matching SHA-bound collection receipt, including inputs without an embedded collector stamp. Missing or incomplete attribution is NOT_RUN.  9e95c1aaf60d3ec19bd8109490d867cc0bac6137: 36 local contract tests PASS; real clean Pi tree compared with immutable archive, byte/stdin/relative-path/side-output collector exercised in an isolated temporary Git fixture. Current operational recollection remains required. |
| M9-RAW-DB-W2 | FIXED | Preserve previous current verifier output in dated M9 history before invoking the legacy checker. A crashed checker leaves no current output to reuse.  9e95c1aaf60d3ec19bd8109490d867cc0bac6137: 36 local contract tests PASS; real clean Pi tree compared with immutable archive, byte/stdin/relative-path/side-output collector exercised in an isolated temporary Git fixture. Current operational recollection remains required. |
| M9-RAW-DB-S1 | FIXED | Report verifier_commit and actual collector source spans separately.  9e95c1aaf60d3ec19bd8109490d867cc0bac6137: 36 local contract tests PASS; real clean Pi tree compared with immutable archive, byte/stdin/relative-path/side-output collector exercised in an isolated temporary Git fixture. Current operational recollection remains required. |
| M9-RAW-CA-C1 | FIXED | Enforce the original strict sameCode path set. The suggested pure-verifier exclusion is rejected: no equality exception is added to avoid recollection. Add only input-path metadata to legacy checker results; no earlier runtime or accepted evidence changes.  9e95c1aaf60d3ec19bd8109490d867cc0bac6137: 36 local contract tests PASS; real clean Pi tree compared with immutable archive, byte/stdin/relative-path/side-output collector exercised in an isolated temporary Git fixture. Current operational recollection remains required. |
| M9-RAW-CA-W1 | FIXED | Source receipts cover each selected file/directory by its exact hash; historical reboot-chain contents remain historical facts, with their current collector span and the actual current fault-driver stamp checked separately.  9e95c1aaf60d3ec19bd8109490d867cc0bac6137: 36 local contract tests PASS; real clean Pi tree compared with immutable archive, byte/stdin/relative-path/side-output collector exercised in an isolated temporary Git fixture. Current operational recollection remains required. |
| M9-RAW-CA-W2 | FIXED | Replace partial group-manifest inference with exact input receipts created around the real command, with clean local and Pi before/after source observations. Never create a fresh receipt by merely hashing older workload output.  9e95c1aaf60d3ec19bd8109490d867cc0bac6137: 36 local contract tests PASS; real clean Pi tree compared with immutable archive, byte/stdin/relative-path/side-output collector exercised in an isolated temporary Git fixture. Current operational recollection remains required. |
| M9-RAW-CA-S1 | FIXED | The exported result names verifier_commit explicitly and records receipt sources without relabeling old raw.  9e95c1aaf60d3ec19bd8109490d867cc0bac6137: 36 local contract tests PASS; real clean Pi tree compared with immutable archive, byte/stdin/relative-path/side-output collector exercised in an isolated temporary Git fixture. Current operational recollection remains required. |
| M9-RAW-CA-S2 | FIXED | Reject dirty current result records independently of the final checkout check.  9e95c1aaf60d3ec19bd8109490d867cc0bac6137: 36 local contract tests PASS; real clean Pi tree compared with immutable archive, byte/stdin/relative-path/side-output collector exercised in an isolated temporary Git fixture. Current operational recollection remains required. |

### Source-receipt delta review

Both exact Opus 5.5 reports were saved before this address pass.

| Finding | Disposition | Evidence and outcome |
| --- | --- | --- |
| M9-COLL-DB-C1 | FIXED | Parse actual soak commit and every controlled sample commit; a read at a newer revision cannot convert an older or mixed-code soak into current proof.  9e95c1aaf60d3ec19bd8109490d867cc0bac6137: 36 local contract tests PASS; real clean Pi tree compared with immutable archive, byte/stdin/relative-path/side-output collector exercised in an isolated temporary Git fixture. Current operational recollection remains required. |
| M9-COLL-DB-C2 | FIXED | Normalize only a directory trailing slash before exact receipt matching.  9e95c1aaf60d3ec19bd8109490d867cc0bac6137: 36 local contract tests PASS; real clean Pi tree compared with immutable archive, byte/stdin/relative-path/side-output collector exercised in an isolated temporary Git fixture. Current operational recollection remains required. |
| M9-COLL-DB-W1 | FIXED | Bind receipts to a hashed owner-private command/result record containing the same exact receipt.  9e95c1aaf60d3ec19bd8109490d867cc0bac6137: 36 local contract tests PASS; real clean Pi tree compared with immutable archive, byte/stdin/relative-path/side-output collector exercised in an isolated temporary Git fixture. Current operational recollection remains required. |
| M9-COLL-DB-W2 | FIXED | Persist the actual Redis-reset source and UTC, emit them with stats, and require the interval start source to bind.  9e95c1aaf60d3ec19bd8109490d867cc0bac6137: 36 local contract tests PASS; real clean Pi tree compared with immutable archive, byte/stdin/relative-path/side-output collector exercised in an isolated temporary Git fixture. Current operational recollection remains required. |
| M9-COLL-DB-W3 | FIXED | Keep long soak execution detached on the Pi; only start/collect calls go through the collector. Retry the closing source probe a bounded number of times. Do not synchronously wait 24 hours in the wrapper.  9e95c1aaf60d3ec19bd8109490d867cc0bac6137: 36 local contract tests PASS; real clean Pi tree compared with immutable archive, byte/stdin/relative-path/side-output collector exercised in an isolated temporary Git fixture. Current operational recollection remains required. |
| M9-COLL-DB-W4 | FIXED | Reject undeclared external evidence inputs instead of silently dropping them; static tracked inputs remain covered by current verifier/code checks.  9e95c1aaf60d3ec19bd8109490d867cc0bac6137: 36 local contract tests PASS; real clean Pi tree compared with immutable archive, byte/stdin/relative-path/side-output collector exercised in an isolated temporary Git fixture. Current operational recollection remains required. |
| M9-COLL-DB-W5 | FIXED | Declare the existing optional parser-result input whenever present without changing the missing-file semantics.  9e95c1aaf60d3ec19bd8109490d867cc0bac6137: 36 local contract tests PASS; real clean Pi tree compared with immutable archive, byte/stdin/relative-path/side-output collector exercised in an isolated temporary Git fixture. Current operational recollection remains required. |
| M9-COLL-DB-W6 | FIXED | Retain exact stdout bytes; invalid UTF-8 cannot be converted into different evidence.  9e95c1aaf60d3ec19bd8109490d867cc0bac6137: 36 local contract tests PASS; real clean Pi tree compared with immutable archive, byte/stdin/relative-path/side-output collector exercised in an isolated temporary Git fixture. Current operational recollection remains required. |
| M9-COLL-DB-W7 | FIXED | Parse NUL-delimited porcelain including both rename/copy paths in collection and final code-dirty checks.  9e95c1aaf60d3ec19bd8109490d867cc0bac6137: 36 local contract tests PASS; real clean Pi tree compared with immutable archive, byte/stdin/relative-path/side-output collector exercised in an isolated temporary Git fixture. Current operational recollection remains required. |
| M9-COLL-DB-S1 | FIXED | Keep all superseded outputs in collection-history outside declared current input directories.  9e95c1aaf60d3ec19bd8109490d867cc0bac6137: 36 local contract tests PASS; real clean Pi tree compared with immutable archive, byte/stdin/relative-path/side-output collector exercised in an isolated temporary Git fixture. Current operational recollection remains required. |
| M9-COLL-DB-S2 | FIXED | Receipt side outputs together with the same actual producer span.  9e95c1aaf60d3ec19bd8109490d867cc0bac6137: 36 local contract tests PASS; real clean Pi tree compared with immutable archive, byte/stdin/relative-path/side-output collector exercised in an isolated temporary Git fixture. Current operational recollection remains required. |
| M9-COLL-DB-S3 | FIXED | Reject symlinked parent paths before any write or rename.  9e95c1aaf60d3ec19bd8109490d867cc0bac6137: 36 local contract tests PASS; real clean Pi tree compared with immutable archive, byte/stdin/relative-path/side-output collector exercised in an isolated temporary Git fixture. Current operational recollection remains required. |
| M9-COLL-DB-S4 | FIXED | Add directory, soak-commit, producer-path, rename, malformed and source-interval controls.  9e95c1aaf60d3ec19bd8109490d867cc0bac6137: 36 local contract tests PASS; real clean Pi tree compared with immutable archive, byte/stdin/relative-path/side-output collector exercised in an isolated temporary Git fixture. Current operational recollection remains required. |
| M9-COLL-CA-C1 | FIXED | Export the relative M9 evidence root expected by the existing producers; absolute roots must not be joined beneath ROOT again.  9e95c1aaf60d3ec19bd8109490d867cc0bac6137: 36 local contract tests PASS; real clean Pi tree compared with immutable archive, byte/stdin/relative-path/side-output collector exercised in an isolated temporary Git fixture. Current operational recollection remains required. |
| M9-COLL-CA-C2 | FIXED | Use the same normalized directory key at the producer and verifier.  9e95c1aaf60d3ec19bd8109490d867cc0bac6137: 36 local contract tests PASS; real clean Pi tree compared with immutable archive, byte/stdin/relative-path/side-output collector exercised in an isolated temporary Git fixture. Current operational recollection remains required. |
| M9-COLL-CA-C3 | FIXED | Reject uncommitted code renames out of evidence at both collection boundaries and the final gate.  9e95c1aaf60d3ec19bd8109490d867cc0bac6137: 36 local contract tests PASS; real clean Pi tree compared with immutable archive, byte/stdin/relative-path/side-output collector exercised in an isolated temporary Git fixture. Current operational recollection remains required. |
| M9-COLL-CA-W1 | FIXED | Require the Pi code-tree hash to match the immutable Git archive for its stamped revision before and after the real command, and in current deployment collection.  9e95c1aaf60d3ec19bd8109490d867cc0bac6137: 36 local contract tests PASS; real clean Pi tree compared with immutable archive, byte/stdin/relative-path/side-output collector exercised in an isolated temporary Git fixture. Current operational recollection remains required. |
| M9-COLL-CA-W2 | FIXED | Support explicit side outputs for the same producer without moving their historical directory aside.  9e95c1aaf60d3ec19bd8109490d867cc0bac6137: 36 local contract tests PASS; real clean Pi tree compared with immutable archive, byte/stdin/relative-path/side-output collector exercised in an isolated temporary Git fixture. Current operational recollection remains required. |
| M9-COLL-CA-W3 | FIXED | Invalidate prior receipts for selected outputs before producer execution; failures after the producer cannot leave an older receipt attached.  9e95c1aaf60d3ec19bd8109490d867cc0bac6137: 36 local contract tests PASS; real clean Pi tree compared with immutable archive, byte/stdin/relative-path/side-output collector exercised in an isolated temporary Git fixture. Current operational recollection remains required. |
| M9-COLL-CA-W4 | FIXED | Receipt-bound optional parser result is included whenever the legacy verifier reads it.  9e95c1aaf60d3ec19bd8109490d867cc0bac6137: 36 local contract tests PASS; real clean Pi tree compared with immutable archive, byte/stdin/relative-path/side-output collector exercised in an isolated temporary Git fixture. Current operational recollection remains required. |
| M9-COLL-CA-S1 | FIXED | Make preamble/first metadata scope explicit and preserve malformed stamps as failures; target-body fields do not supply source identity.  9e95c1aaf60d3ec19bd8109490d867cc0bac6137: 36 local contract tests PASS; real clean Pi tree compared with immutable archive, byte/stdin/relative-path/side-output collector exercised in an isolated temporary Git fixture. Current operational recollection remains required. |
| M9-COLL-CA-S2 | FIXED | Refuse verifier/history/manifest destinations and symlinked parents.  9e95c1aaf60d3ec19bd8109490d867cc0bac6137: 36 local contract tests PASS; real clean Pi tree compared with immutable archive, byte/stdin/relative-path/side-output collector exercised in an isolated temporary Git fixture. Current operational recollection remains required. |
| M9-COLL-CA-S3 | FIXED | Add the three concrete path/rename controls.  9e95c1aaf60d3ec19bd8109490d867cc0bac6137: 36 local contract tests PASS; real clean Pi tree compared with immutable archive, byte/stdin/relative-path/side-output collector exercised in an isolated temporary Git fixture. Current operational recollection remains required. |
| M9-COLL-CA-S4 | FIXED | Require the matching hashed private command/result record without publishing its argv or stderr.  9e95c1aaf60d3ec19bd8109490d867cc0bac6137: 36 local contract tests PASS; real clean Pi tree compared with immutable archive, byte/stdin/relative-path/side-output collector exercised in an isolated temporary Git fixture. Current operational recollection remains required. |

### Additional collector-input coverage finding

| Finding | Disposition | Evidence and outcome |
| --- | --- | --- |
| M9-REG-18 | FIXED | M7 B01 reads raw/stack.txt and B01/B02 decode PNG files under raw/artifacts, but their selected input_paths currently declare only e2e-fixture.txt. This leaves current screenshot bytes and the core-start comparison outside the collector binding. Declare those actual side inputs in M9 verification metadata; the real M7 fixture producer already receipts raw/artifacts from the same invocation. No runtime or historical acceptance change. 010d6f9e84f732783ab94745a8b5b05cc0f8d2eb: B01/B02 PASS on preserved raw with all three actual input paths emitted; current raw remains unbound until recollected. |

### Selected input and interruption review

Fresh independent exact Opus 5.5 reviews are saved as `SELECTED-INPUTS-DEBUGGER.md` and `SELECTED-INPUTS-AUDITOR.md`; model and private-original hash provenance is in `selected-inputs-model-provenance.json`. Reports existed before address remediation. Only M9 acceptance verification is owned here; no M2 runtime remediation is authorized.

| Finding | Disposition | Evidence / outcome |
|---|---|---|
| M9-INPUT-DB-C1 | FIXED | e4974e7: TLS state and native TLS client proof declared as actual input paths; fresh read-only recollection pending. |
| M9-INPUT-DB-C2 | FIXED | 34246d2: diagnostics precede submission; bounded active slow-page query and core kill share one Pi-side shell; absent witness is a recorded refusal. Current-source full crash phase completed at f72333f; J03 PASS: five active slow-page rows at the kill, six completed documents, one stalled page retried, one upstream job group. |
| M9-INPUT-DB-W1 | REJECTED | Not a code defect: strict sameCode remains unchanged. All selected raw inputs will be recollected after all four local fixes are committed; previous successful raw remains attributed to its original source. |
| M9-INPUT-DB-S1 | FIXED | 34246d2: J03 requires active_at_kill >= 1 and still requires a subsequently stalled page. |
| M9-INPUT-DB-S2 | REJECTED | The existing six-page workload is preserved. An observed active slow page plus the after-the-fact stall proves interruption; increasing the workload is unnecessary and cannot substitute for the witness. |
| M9-INPUT-AUD-C1 | FIXED | e4974e7: duplicate of DB-C1; both TLS side files declared; fresh read-only recollection pending. |
| M9-INPUT-AUD-C2 | FIXED | 51f3e5f: marker query recognizes owner-tagged origins in both JSON locations; J07 also requires one upstream group for its running positive control. Current-source J04/J07 PASS at f72333f, including the running-job positive control. |
| M9-INPUT-AUD-C3 | FIXED | 34246d2: duplicate of DB-C2. Both diagnostic collectors move before submission; actual active slow-page count is checked at the kill. No increased page limit or manually paused fixture. |
| M9-INPUT-AUD-W1 | REJECTED | Not a code defect: all changes committed before one full recollection. No verifier exclusion, relaxed equality, or fabricated receipt was introduced. Recollection remains required and pending. |
| M9-INPUT-AUD-S1 | FIXED | 51f3e5f: the same owner-tagged marker predicate is corrected in pi-ledger-snapshot.sh, covering the related observer without altering runtime. |
| M9-INPUT-AUD-S2 | FIXED | 3ae7bcb: M5 S05 declares the consumed egress policy; M7 W01 declares the consumed capability policy, including them in config_or_fixture_hash. |

### M9 current crash transport finding

The current-source rerun reached K5 after K1–K4 recovered with one upstream group, but its first POST after pre-submission diagnostics failed with `socket hang up`. The saved run is `evidence/M9/work/M3-k5-stale-socket-3ae7bcb/`. The driver uses Node’s pooled default HTTP Agent across intentional service kills; the pooled-socket cause is an inference from this sequence and the actual request options. Fresh per-request TCP connections remove that fixture dependency without retrying an uncertain POST.

| Finding | Disposition | Evidence / disposition |
|---|---|---|
| M9-REG-19 | FIXED | c1fc86a0a21f5caef2079c57351e7a8f6713baac: M9 verification transport: open a fresh connection for each M3 request. Complete current-source crash phase and J03/J04/J07 PASS at f72333f; failed run preserved. |

| M9-REG-20 | FIXED | f72333f81d2c4753bf83d0db359e9ca6c99ef3da: Confirmed M3 fixture boundary overlap: actual bounded supervisor restart at 14:38:55 preceded K3 pause at 14:38:56; six not-delivered attempts returned to RECEIVED. Save the failed receipt/restarts in work/M3-k3-supervisor-overlap-c1fc86a; wait for core health after K2. Actual complete crash phase PASS at f72333f with supervision intact; J03/J04/J07 PASS. |

## Code Review: M2-owned M9-REG-12 candidate, 2026-10-03

### Summary
Two independent native reviewers used exact Opus 5.5. They read the six changed files plus enclosing call paths against f72333f and did not execute tests or edit files. Full reports are M2-REG12-DEBUGGER.md and M2-REG12-AUDITOR.md; immutable input/result hashes and usage are in M2-REG12-provenance.json. The isolated Pi candidate suite subsequently passed 285 tests (77 access, 204 retrieval and four gateway contracts), with no failures or skips; it does not run real Chromium redirect integration.

### 🔴 Critical Issues (Must Fix)
None introduced.

### 🟡 Warnings (Should Fix)
- **Main-frame request can differ from the response supplying status** — services/browser/src/server.mjs:264 (corroborated: both agents). A 403 page plus a blocked subresource and a later aborted navigation can incorrectly match. Use the goto response URL for successful renders; retain the request witness for failed goto.
- **Correlation hash leaves its process** — services/retrieval/src/acquire.mjs:522 (corroborated: both agents). Strip urlHash from returned proxyDenied; correlation stays transient inside the retrieval process.
- **Real browser/proxy integration remains unrun** — scripts/m2/retrieval-e2e.mjs:110 (corroborated: both agents). Run the browser-first denial matrix, a cross-host public positive control and the existing actual subresource control after committed images are deployed.

### 🔵 Suggestions (Consider)
- Strengthen BR08 to a permitted cross-host public fixture and add explicit collector/verifier coverage (unique to debugger's lane).
- Cover the actual CONNECT denial record, remove credentials before matching on both sides, and replace the mislabeled public-address synthetic SSRF row with a private fixture (unique to auditor's lane).
- Record security-refusal precedence over an unrelated provider failure (unique to debugger's lane).
- **Pre-existing later JavaScript navigation status drift** — services/browser/src/server.mjs:264 (corroborated: both agents). A later same-host redirect can commit a proxy denial while retaining the initial 200 status. The original M9-REG-12 authorization does not authorize changes to success behavior; verify separately and return to owning M2 if confirmed.
- **Pre-existing malformed request logging** — services/retrieval/src/proxy.mjs:102 (unique to auditor's lane). Inspect actual reachability of full request text in target_host before disposition.

### ✅ Good Practices
Actual proxy refusal is authoritative; page text cannot invent a denial. No policy, routing, retry, pacing, sandbox or spending changes. HTTP matching is exact; HTTPS matching is limited to failed navigation and authority.

### Verdict
[ ] ❌ Request Changes
[x] ⚠️ Approve with Suggestions
[ ] ✅ Approve

/address TODO recorded before remediation: response correlation, internal hash removal, focused/actual test coverage, cross-host positive and verifier wiring, credential normalization, synthetic label, precedence explanation, and verification/disposition of the two pre-existing observations. Each fix is committed locally; publication remains forbidden.

| Finding | Disposition | Evidence / commit |
|---|---|---|
| M9-M2-LOG-01 | FIXED | 2a990db: separately authorized host-only refusal metadata and eight focused proxy tests PASS. Original actual readiness logging failure retained unchanged. Final real runtime matrix is running. |

| Finding | Disposition | Evidence / commit |
|---|---|---|
| M9-M2-NAV-01 | FIXED | 3ebf4f5: minimum initial/post-load classification metadata/propagation under M9-REG-12; 60 focused tests PASS. Original post-load failed real proof retained; actual final Chromium matrix is running. |

| Finding | Disposition | Evidence / commit |
|---|---|---|
| M9-SELF-VALIDATION-01 | FIXED | 179b139: unsupported total-month field removed; d863dd0 enforces the exact 45-minute owner duration and a single UTC-day budget period. Two actual policy/consent contracts PASS; production window remains closed. |

## Code Review: Final remediation at 179b139, 2026-10-03

### Summary
The debugger and auditor independently reviewed the 13-file diff from f72333f and enclosing runtime/caller code. Both used exact Opus 5.5, supplied source plus at most ten read-only lookups, and produced complete reports. No tests/builds/Chromium ran in these contexts. The earlier 35-turn attempts ended without reports and are retained as incomplete attempts. Full reports: FINAL-REMEDIATION-DEBUGGER.md and FINAL-REMEDIATION-AUDITOR.md, with hashes/usage in FINAL-REMEDIATION-provenance.json.

### 🔴 Critical Issues (Must Fix)
No introduced Critical defect found.

### 🟡 Warnings (Should Fix)
- **Standard M9 collector omits browser-redirect** — scripts/m9/regression.mjs:6 (unique to auditor's lane). Add the required phase, which warms its own hint; AC25 must not silently lack S03 evidence.
- **Window may cross budget periods** — scripts/m9/validation.sh:11 (corroborated: both agents, pre-existing). Enforce the owner 45-minute duration and one UTC-day period in the actual consent predicate, retaining category day/month caps and total day cap. Current October 3 window cannot cross month if opened as planned; nevertheless make the bounded surface fail closed.
- **Credentialed redirect correlation unverified** — services/retrieval/src/acquire.mjs:497 (corroborated: both agents). Add an actual Chromium private-redirect row; no normalization change until evidence establishes its result. Network denial stays mandatory.
- **Post-load observation is bounded** — services/browser/src/server.mjs:251 (unique to debugger's lane). S03 proves transitions completed inside the existing settle/deadline window. Later scripts are not observed after the context closes; no unlimited-wait capability is claimed.
- **Pre-existing unmatched browser error page may be reported as success** — services/retrieval/src/acquire.mjs:513 (corroborated: both agents). Off-host route abortion or unmatched tunnel failure can commit chrome-error with an earlier 200. This is not an authoritative proxy policy refusal, so do not invent SSRF/Cloud class. Minimal proposed fallback after existing verdict.failure is NAVIGATION_FAILED, nonretryable. Verify the actual old-worker trace and obtain the narrow owning-M2 exception before changing success handling.

### 🔵 Suggestions (Consider)
- Join refusal events to attempt ids, add this phase to aggregate guard accounting, and test actual consent rejection cases (corroborated: both agents).
- Harmless successful navigationUrl field may remain; DNS rebinding self-denial fails closed. Record these rather than broaden source refactoring (unique to debugger's lane / corroborated respectively).

### ✅ Good Practices
Proxy evidence governs policy classes, hashes remain transient, host-only logging retains CONNECT authority, the production policy validator accepts the exact generator, and cancellation/routing/security/spend boundaries remain unchanged.

### Verdict
[ ] ❌ Request Changes
[x] ⚠️ Approve with Suggestions
[ ] ✅ Approve

/address TODO recorded before remediation: collector wiring, consent period/duration guards and negative contracts, real credentialed row, refusal joins/aggregate guard coverage, bounded-observation limitation, unmatched-error-page verification/owning-M2 authority. The final isolated and real-browser tests remain held/unrun.

Additional implementation finding before /address: M9-SELF-BUILD-01 — the owned native build downloaded all pinned package tarballs but its optional npm audit POST stalled for 893 seconds. Only that verified build process was terminated; production remained healthy with 5019 MiB available. Original build_exit=130 and its hash are retained. Proposed minimal build-only fix: npm ci retains locked integrity and --ignore-scripts, adding --no-audit to the two unchanged-dependency recipes; no runtime or host network change.

| Finding | Disposition | Evidence / commit |
|---|---|---|
| M9-M2-ERROR-01 | FIXED | bc648b5: separately owner-authorized nonretryable committed Chrome error-page guard follows existing policy/provider/verdict classifications. 43 focused tests PASS; original false-success proof retained. Actual final Chromium controls are running. |

### Final review address dispositions

| Finding | Disposition | Evidence / commit |
|---|---|---|
| M9-FINAL-COLLECTOR-01 | FIXED | 14e71bc: browser-redirect is in the standard M9 M2 collector and aggregate guard-accounting phases. Current actual recollection is running. |
| M9-FINAL-CONSENT-01 | FIXED | d863dd0: actual consent predicate refuses duration over 2700 seconds and UTC-day/month crossings. Two production-loader/negative-consent tests PASS. |
| M9-FINAL-CREDENTIAL-01 | FIXED | 79ad1d1: if Chromium strips credentials, classification can use an actual same-host/same-class refusal only when the committed HTTP final URL is independently forbidden by unchanged policy. Exact hashing remains preferred; a public own-403 with a credential-bearing denied subresource remains ACCESS_DENIED. All 46 focused tests PASS. The actual first failed credential proof is preserved; final real proof remains held for rebuilt image. |
| M9-FINAL-JOIN-01 | FIXED | 14e71bc: attempt ids are emitted/parsed and every canonical denied browser attempt must join to its actual matching proxy refusal. |
| M9-FINAL-BOUNDED-01 | REJECTED | The existing settle/deadline window bounds observation. Acceptance proves transitions inside that window; scripts scheduled after context closure are unobserved. No unlimited-wait capability is claimed or required. |
| M9-FINAL-DNS-01 | REJECTED | A changed DNS answer that the guard refuses is fail-closed behavior; no request is permitted to a forbidden destination. No routing/security relaxation is authorized. |
| M9-FINAL-METADATA-01 | REJECTED | Successful navigationUrl is harmless internal fallback metadata. Removing it is a broader unnecessary refactor; actual committed finalUrl supplies successful correlation. |
| M9-FINAL-STRATEGY-01 | REJECTED | Core failures remain fail-closed. S03 now joins actual attempt/refusal ids and checks exact canonical counts/browser strategy in addition to direct controls; no separate runtime defect established. |
| M9-FINAL-NORMALIZATION-01 | REJECTED | Removing URL credentials from all transient hashes could match a refused credential-bearing subresource to a distinct credential-free main document. The focused negative control preserves target identity. BR12 tests the actual browser behavior before any further classification repair. |
| M9-SELF-BUILD-01 | FIXED | 7492e83 adds only --no-audit to two pinned npm ci recipes. Actual native ARM64 builds PASS (retrieval/browser), immutable pins committed in a7794f1. Original 893-second canceled build remains FAIL. |

### Initial M2 review address coverage

| Finding | Disposition | Evidence / commit |
|---|---|---|
| M9-M2-RESPONSE-01 | FIXED | f4cbae8: successful metadata comes from the response supplying status; failed navigation keeps the actual main-frame witness. The own-403/unrelated-denial negative fixtures PASS. |
| M9-M2-HASH-01 | FIXED | 31668e6: urlHash is transient retrieval-process correlation material and is removed from exported proxyDenied. Focused export control PASS. |
| M9-M2-CONNECT-01 | FIXED | 503752d: actual CONNECT refusal tests verify authority and canonical private/Cloud classes. Focused proxy suite PASS. |
| M9-M2-PUBLIC-01 | FIXED | 503752d: BR08 is an actual permitted cross-host fixture redirect and S03 is required in M9 AC25. Current Chromium recollection is running. |
| M9-M2-INTEGRATION-01 | FIXED | a7794f1: committed reviewed browser/retrieval native images are pinned and deployed for the held real denial/positive/subresource matrix. The actual test state remains pending until its output is checked. |
| M9-M2-PRECEDENCE-01 | REJECTED | Authoritative matched main-frame policy refusal has precedence over an unrelated provider error. Existing tests cover both and never derive a policy class from text or an unmatched refusal. |
| M9-M2-SYNTHETIC-01 | FIXED | 503752d: the mislabeled synthetic denied address is replaced by a private controlled address. Synthetic credentials in BR12 are fixture literals, not provider secrets. |

| Finding | Disposition | Evidence / commit |
|---|---|---|
| M9-REG-21 | FIXED | 9c11be9: select pinned attempt_id and stop the collector on SQL failure. Shell syntax PASS; real rows are required in S03. The first missing rows/404 evidence remains preserved. The final cutover will restart only the changed fixture-m2 process. |

The new table ids M9-SELF-VALIDATION-01 and M9-SELF-BUILD-01 correspond to the originally recorded narrative labels SELF-M9-VALIDATION-01 and SELF-M9-BUILD-01. The original review keeps its reserved SELF-01/SELF-02 ids. Both new findings retain their original failure evidence and dispositions.

Actual held browser matrix completed at da4b451: M2-S03 PASS, with all 20 canonical denied attempts joined to real proxy refusal records, BR12 credentialed private denial canonical, BR11 own-403 unchanged, BR13/BR14 generic failure controls, public positive and health/permit checks. Earlier initial and post-load failed proofs remain immutable. Bounded observations inside the renderer settle/deadline window are the proven capability.

| Finding | Disposition | Evidence / commit |
|---|---|---|
| M9-REG-22 | FIXED | 047a42e: wait for the required RUNNING ledger observation before the unchanged same-shell actual-active-row/kill probe. No workload or runtime behavior changes, and the J03 criterion remains unchanged. Node syntax PASS; the first QUEUED witness/recovery remains FAIL against this check and is retained. Fresh actual rerun is required. |

The BR12 raw witness established a credential-normalization mismatch but did not retain its direction. 047a42e corrects the explanatory comment accordingly; classification depends only on the committed forbidden destination and actual refusal, and does not assume a normalization direction.

The M9-REG-22 actual rerun completed at 82a1153: M3-J03 PASS with RUNNING observed, five active pages at the atomic kill, all six documents recovered, one upstream group and one stalled-page retry. The prior QUEUED-witness failure remains retained unchanged.

Current frozen-source verification at 82a1153 additionally confirms M2-S03 PASS (20 canonical denied attempts correlated to actual refusals, public redirect and own-403 controls, committed-error generic failure controls) and all 299 isolated Pi fixture tests PASS (77 access, 218 retrieval, four gateway contract checks). The completed current native Claude Code and Codex global MCP scrape proofs are saved in clients/; previous source proofs remain in history. Remaining operational, 24-hour soak and real-provider acceptance gates are not granted by these results.


## Owner-directed AC16 evidence reuse review — 2026-10-03

Two fresh exact Opus 5.5 contexts independently reviewed the proposed pure-verifier delta. Full saved reports: RESOURCE-REUSE-DEBUGGER.md and RESOURCE-REUSE-AUDITOR.md; immutable prompt/result/report hashes and usage: RESOURCE-REUSE-provenance.json. Reports saved before /address. Current 82a runtime source and completed execution evidence are unchanged; no second24-hour soak is scheduled. This additive review is pending remediation, not an acceptance grant.

## Exact retained Cloud-probe interpretation review — 2026-10-03

Two fresh exact Opus5.5 contexts reviewed the immutable old failure exception and its full gate wiring. CLOUD-WINDOW-DEBUGGER.md and CLOUD-WINDOW-AUDITOR.md saved before remediation; CLOUD-WINDOW-provenance.json pins prompts/results/reports and separates API-equivalent estimates from unknown invoices. Remediation is pending; no live-provider window has opened.

### Address outcomes for the AC16 reuse addendum

| Finding | Disposition | Evidence / commit |
|---|---|---|
| M9-REUSE-DB-C1 | FIXED | 909d997: require explicit reuse decision/state, immutable historical inputs and full assessment hash in acceptance. Current source-bound targeted evidence is mandatory. |
| M9-REUSE-DB-C2 | FIXED | 909d997: lock/image/patch changes participate in source equivalence and assessed runtime hash; every runtime path is classified. |
| M9-REUSE-DB-W1 | FIXED | 909d997: assess from actual soak execution6366dd8, preserving accepted verification286bb54 and committed55d756. The latter remains reachable through main ancestry; no new tag needed. |
| M9-REUSE-DB-W2 | FIXED | 909d997: hash raw full-object mode/blob records with no renames, color, external diff or textconv. This avoids display/config/object-abbreviation variability. |
| M9-REUSE-DB-W3 | FIXED | 909d997: bounded timestamps/gaps, unchanged boot/container identities, sustained request bins, actual model/traffic overlap and reset-bounded Redis measurements. |
| M9-REUSE-DB-W4 | FIXED | 909d997: no-renames diff exposes deleted execution paths; only three exact proof-only paths are exempt. |
| M9-REUSE-DB-W5 | FIXED | 909d997: JSON compose receipts use their bound file hash, not the embedded collector-source text parser. |
| M9-REUSE-DB-W6 | FIXED | 909d997: reuse only exact two historical raw paths for S01/S02/S04/O04; other input/changed-byte paths use ordinary receipt binding. S05 uses current heap evidence. |
| M9-REUSE-DB-W7 | FIXED | 909d997: acceptance requires current-HEAD actual TAP record, exact test/helper/raw hashes, at least17 passes and the Cloud mutation test. |
| M9-REUSE-DB-S1 | FIXED | 909d997: pin interpretation, accepted S05, actual historical sample source and exact service names. |
| M9-REUSE-DB-S2 | FIXED | 909d997: finite latency, model swap/headroom, Buffer hashes and cached source equivalence. |
| M9-REUSE-DB-S3 | FIXED | 909d997: expanded meaningful mutations and strict accepted-M8/current-M8 compose comparison. |
| M9-REUSE-DB-S4 | FIXED | 909d997: recollect exact current source/versions after evaluator commit/deployment. |
| M9-REUSE-CA-W1 | FIXED | 909d997: delta includes patches, lock and all incident helpers from actual soak source; null hashes and missing classifications fail closed. |
| M9-REUSE-CA-W2 | FIXED | 909d997: reject duplicate/error sample frames, coverage gaps, boot/container restarts and misaligned windows. |
| M9-REUSE-CA-W3 | FIXED | 909d997: actual controlled request spans the model unit's active state; model peak must retain10% headroom with zero swap. |
| M9-REUSE-CA-W4 | FIXED | 909d997: no-renames source diff plus actual static/dynamic relative-import contract prevents execution sources importing proof-only helper/verifier. |
| M9-REUSE-CA-W5 | FIXED | 909d997: rerun affected canonical M8 checks and full M9 dry gate with exact current-source collection. Held provider criteria remain NOT_RUN until actual execution. |
| M9-REUSE-CA-W5-FRESH | REJECTED | A future justified fresh24h mode is outside this owner-directed reuse task. Nonmatching historical bytes use ordinary binding, but this selected release requires assessed reuse. A new soak first requires the owner's four-part justification gate; no speculative execution mode added. |
| M9-REUSE-CA-W6 | FIXED | 909d997: assessment and targeted files are hashed into acceptance; every actual changed runtime path must be assessed with nonmaterial rationale. |
| M9-REUSE-CA-S1 | FIXED | 909d997: sample errors, finite timing, actual service names, exact reused paths and cap/coverage/assessment mutation cases. |
| M9-REUSE-CA-S2 | FIXED | 909d997: exact Redis principal token in producer metadata, post-window reset/capture times and bound Redis used/peak/maxmemory, zero evictions/errors. |
| M9-REUSE-CA-S3 | REJECTED | Pinned M8 verification records input paths/config hash rather than separate per-raw input digests. The evaluator pins the accepted verification plus whole historical raw bytes and validates every embedded actual6366dd8 source; it does not invent missing historical metadata. |
| M9-REUSE-CA-S4 | FIXED | 909d997: accepted-M8/current-M8 compose paths and expanded actual evaluator fixtures used. |

### Address outcomes for the retained Cloud-probe interpretation

| Finding | Disposition | Evidence / commit |
|---|---|---|
| M9-CLOUD-DB-C1 | FIXED | 909d997: interpretation requires exactly the current legacy failure detail failed=core_logs, zero web/proxy deltas and exact scan coverage. Each legacy condition is recomputed; a second cause, duplicate or missing section remains FAIL. |
| M9-CLOUD-DB-W1 | FIXED | 909d997: duplicate/unknown scan frames, instance coverage and exact unexplained-line counts are mandatory; the one exempt block and original real proxy-denial probe are immutable whole-byte hashes. |
| M9-CLOUD-DB-W1-SUM | REJECTED | Pattern-count sums are not disjoint: a DNS line can contain both getaddrinfo and EAI_AGAIN, and a Cloud line can name multiple Cloud hosts. Requiring their sum equal classified-line counts would reject valid captures. Source-bound actual M8 classifier remains authoritative; no other unexplained line is exempt. |
| M9-CLOUD-DB-W2 | FIXED | 909d997: require ordered open/close/scan timestamps, minimum measured window, valid unchanged handles and an actual dropped-packet positive control. Separate actual paid-container audit covers all later authorized live work before shutoff. |
| M9-CLOUD-DB-W3 | FIXED | 909d997: actual current evaluator record requires all17 cases plus the exact Cloud mutation test; a count-only summary cannot satisfy acceptance. |
| M9-CLOUD-DB-W4 | FIXED | 909d997: focused mutations cover second failure cause, duplicate frame, DNS, controls, absent/mismatched handle, proxy/web counts and missing old block. |
| M9-CLOUD-DB-S1 | FIXED | 909d997: record actual legacy detail, opening/closing/scan dates and exact retained count. Explicitly describe timestamp/URL and real attempt-id correlation in immutable probe. |
| M9-CLOUD-CA-C1 | FIXED | 909d997: pin the exact legacy failure cause and recompute all original X01 conditions with only the one hash-bound historical exception. |
| M9-CLOUD-CA-W1 | FIXED | 909d997: recollect actual core scan after close; evaluator enforces open<close<=scan. |
| M9-CLOUD-CA-W2 | FIXED | 909d997: missing table handles fail; the unchanged handle must be numeric. |
| M9-CLOUD-CA-W3 | FIXED | 909d997: opening uses counters and closing uses guard_after explicitly. |
| M9-CLOUD-CA-W4 | FIXED | 909d997: duplicate sections fail in all three actual scan/counter inputs. |
| M9-CLOUD-CA-W5 | REJECTED | The source-bound M8 classifier intentionally recognizes deliberate denied job/request echoes. Mandatory M2-S03 correlates actual current forbidden attempts to proxy refusals; original pre-fix probe is whole-byte pinned. Separate actual paid-container scan requires zero Cloud-host lines, so live Cloud attempts cannot borrow a fixture refusal classification. |
| M9-CLOUD-CA-W6 | FIXED | 909d997: exact current test/helper/raw hashes and mandatory Cloud-case TAP line are required. |
| M9-CLOUD-CA-S1 | FIXED | 909d997: actual legacy state/count, focused failure mutations and precise deliberate-probe/no-Cloud-egress wording. |
| M9-CLOUD-CA-S2 | REJECTED | newest<open is redundant with the block hash but useful explicit evidence; retain it rather than weaken the negative timing assertion. |

Remediation complete for both additive reviews after the local evaluator commit and affected fixture/canonical dry reruns recorded below. The original saved reports and failed probes remain unchanged. No second24-hour soak was scheduled or run.

| Finding | Disposition | Evidence / commit |
|---|---|---|
| M9-SELF-RESOURCE-TIME | FIXED | 909d997: timestamp token parser stops at whitespace, including a final metadata newline. Original real-run evaluator FAIL is retained; exact reset/capture bound now parses correctly. |
| M9-SELF-RESOURCE-LATENCY | FIXED | 909d997: apply canonical AC16 p95 static threshold to actual controlled probes, keeping every request success/finite duration mandatory. Original invented every-request threshold FAIL and two8.361/14.056-second startup outliers remain visible; p95 is97ms. A focused mutation distinguishes a single outlier from sustained latency failure. |


## Live driver admission failure — independent addendum, 2026-10-03

The original twenty HTTP400 corpus responses and incomplete research flow are preserved in work/live-driver-failure-20261003/. They establish a driver admission failure, not measured retrieval quality. The first authorization is CLOSED. LIVE-DRIVER-DEBUGGER.md and LIVE-DRIVER-AUDITOR.md are saved before /address with exact Opus5.5 provenance. Corroborated findings: request field admission/false exit, stale review admission, closed consent reuse, execution/deployed contract source mismatch. Additional debugger poll duration and poll-route coverage and auditor audit-window evidence binding are independently scoped defects. Remediation pending; no further paid run authorized.


### Live driver /address completed

Remediation complete at baa9da32381f11b2c00b2b32c1d2c4517209f43b. All 34 directly affected contract/evidence/source-equivalence tests PASS; no new provider call. Native review mechanism uses two fresh Opus5.5 contexts, without model substitution. The initial CLOSED authorization remains unusable.

| Finding | Disposition | Evidence / local fix |
|---|---|---|
| M9-LIVE-SELF-01 | FIXED | baa9da3; Unsupported request fields and false exit fixed; actual gateway fixture admits all frozen requests and rejects original fields. |
| M9-LIVE-DB-C1 | FIXED | baa9da3; Corroborated CA-C3: clean local HEAD, deployed source and exact deployed manifest/validator hashes required before dispatch. |
| M9-LIVE-DB-C2 | FIXED | baa9da3; Corroborated CA-C1/C2: exact reviewed-code/report hashes and complete dispositions required; CLOSED consent, stale source and window longer than45m refused. |
| M9-LIVE-DB-W1 | FIXED | baa9da3; Poll until the existing extract deadline/window bound; retain last pending state and every completed research step rather than discarding nonterminal outcome. |
| M9-LIVE-CA-W1 | FIXED | baa9da3; Corpus/research raw and public records bind exact consent hash plus every request start/end and summary time inside the audited window. |
| M9-LIVE-DB-S1 | FIXED | baa9da3; Corroborated CA suggestion: mutate real corpus/retrieve scrape bodies in regression fixtures. |
| M9-LIVE-DB-S2 | FIXED | baa9da3; GET extract status route now mandatory in manifest preflight. |
| M9-LIVE-DB-S3 | FIXED | baa9da3; Corroborated CA suggestion: unused research URL variable removed. |

Tracked-fixture verification finding M9-LIVE-SELF-02: current-source evaluator import guard failed after the new live test became tracked. Preserve original raw/invalid metadata under work/resource-verifier-tests-tracked-fixture-failure*. The equivalence assertion belongs in the proof-only resource suite; runtime exemptions stay narrow. Remediation pending.

| M9-LIVE-SELF-02 | FIXED | cf93d5a moves the source-equivalence assertion into the existing proof-only verifier suite. The tracked-tree guard now passes without widening runtime exclusions; all34 affected tests PASS. Original failed raw and incorrect exit metadata remain preserved and explicitly invalidated. |


## Unpaid four-target rechecks — independent addendum

UNPAID-RECHECKS-DEBUGGER.md and UNPAID-RECHECKS-AUDITOR.md saved before /address; provenance pins exact inputs/results/model. Fix correlation/attempt persistence, finite window bounds, exact request fields, fail-closed aggregation and independent zero-Cloud positive controls before any egress. No new paid execution or corpus criteria/membership change. Remediation pending.


### Unpaid rechecks /address completed

Remediation complete at 111341f8726208a21484eb436dae9c39bbe4a213. All35 directly affected tests PASS; exact four targets and frozen criteria remain unchanged. No runtime/collector exemption, new provider dispatch or resource assumption change.

| Finding | Disposition | Evidence / fix |
|---|---|---|
| M9-RCHECK-DB-C1 | FIXED | 111341f; Exact distinct scrape receipts must match every acquisition logical_id; mismatch/duplicate mutations fail. |
| M9-RCHECK-DB-C2 | FIXED | 111341f; Corroborated CA-C1: exclusive single-shot private file and persisted responses before correlation prevent dropped attempts/reruns. |
| M9-RCHECK-DB-W1 | FIXED | 111341f; Exact request key sets per class; no extra proxy/actions/static wait fields. |
| M9-RCHECK-DB-W2 | FIXED | 111341f; Corroborated CA-W4: existing invalid recheck evidence fails closed, with no initial-batch fallback. |
| M9-RCHECK-DB-W3 | FIXED | 111341f; Covered initially usable targets, exact cumulative three-attempt boundary, closed-window boundary, class/profile checks and final arithmetic. |
| M9-RCHECK-DB-S1 | FIXED | 111341f; Public per-ID request hash, status and attempt count are checked against private raw. |
| M9-RCHECK-DB-S2 | FIXED | 111341f; Actual before/after whole-container audit counters require at least four new acquisitions and exactly one zeroCloud count. |
| M9-RCHECK-CA-C1 | FIXED | 111341f; Corroborated DB-C2: exclusive record and persisted raw/parse-failure metadata; failed partial run cannot reset attempt history. |
| M9-RCHECK-CA-C2 | FIXED | 111341f; Every outer and per-response timestamp must be finite; missing completion/closed time mutations fail. |
| M9-RCHECK-CA-W1 | FIXED | 111341f; Unique exact Cloud/acquisition fields and actual count increase reject multiline contradictions or old positive controls. |
| M9-RCHECK-CA-W2 | FIXED | 111341f; Proxy microUSD and bytes plus enhanced cost must all be zero. |
| M9-RCHECK-CA-W3 | FIXED | 111341f; Explicit strict source-equivalence mode permits only existing pure proof files for this path; runtime/collector changes remain invalidating. |
| M9-RCHECK-CA-W4 | FIXED | 111341f; Corroborated DB-W2: failed compound evidence cannot fall back to an earlier batch. |
| M9-RCHECK-CA-S1 | FIXED | 111341f; Private served-origin matcher restricts host syntax to accepted tailnet HTTPS suffix. |
| M9-RCHECK-CA-S2 | FIXED | 111341f; Listed negative mutations added; unique IDs, timestamp, fields, attempt boundary and arithmetic tested. |
| M9-RCHECK-CA-S3 | FIXED | 111341f; Evaluator independently requires actual preflight health. |


## Final unpaid round — independent addendum

FINAL-UNPAID-DEBUGGER.md and FINAL-UNPAID-AUDITOR.md saved before /address. Both native Opus5.5 contexts reviewed compound lineage and the final one-attempt caller plan; no substitution. Debugger confirms no reachable false PASS. Auditor critical trace asserting 15/20 could pass is contradicted by the unchanged ≥90% predicate, but its interrupted-round integrity gap is real and will be closed. Corroborated interrupted lineage, receipt uniqueness, log-container identity, finite caps, cumulative disclosure and correlation reliability findings are in scope. Remediation pending; no live recheck executed.


### Final unpaid /address outcomes

Remediation complete; local fix commit 96dfc37a4ccc1ac7c885ed131b2ea5da5d5477b4 with 34 directly affected tests PASS. Earlier failures remain unchanged. The final profile uses an explicit existing browser wait action for all four targets, whole content and raw HTML; no runtime or policy change.

| Finding | Disposition | Evidence / fix |
|---|---|---|
| M9-FINAL-DB-H1 | FIXED | 96dfc37a4ccc1ac7c885ed131b2ea5da5d5477b4; persist intent before dispatch; exclusive file remains; private started marker blocks incomplete public lineage. |
| M9-FINAL-DB-M1 | FIXED | 96dfc37a4ccc1ac7c885ed131b2ea5da5d5477b4; missing/null earlier or final record fails closed. Pure selection helper has direct missing-record fixtures. |
| M9-FINAL-DB-M2 | FIXED | 96dfc37a4ccc1ac7c885ed131b2ea5da5d5477b4; exact logical-id log correlation polls five bounded reads over a widened clock window; no new target retry. Missing receipt remains an honest failed proof. |
| M9-FINAL-DB-L1 | FIXED | 96dfc37a4ccc1ac7c885ed131b2ea5da5d5477b4; require all four named paid categories, nonempty caps and every cap zero. |
| M9-FINAL-DB-L2 | FIXED | 96dfc37a4ccc1ac7c885ed131b2ea5da5d5477b4; positive integer frozen max_attempts ≤3 and positive measured usage required. |
| M9-FINAL-DB-L3 | FIXED | 96dfc37a4ccc1ac7c885ed131b2ea5da5d5477b4; exact unique before/after container/start identity. |
| M9-FINAL-DB-L4 | FIXED | 96dfc37a4ccc1ac7c885ed131b2ea5da5d5477b4; drop speculative heading-only filtering; use existing browser acquisition with full content/raw HTML. Initial missing-heading cause remains UNKNOWN until real capture. |
| M9-FINAL-DB-GAPS | FIXED | 96dfc37a4ccc1ac7c885ed131b2ea5da5d5477b4; missing lineage, replay, source, container, prior hash, cap and body-profile mutations. |
| M9-FINAL-CA-F1 | FIXED | 96dfc37a4ccc1ac7c885ed131b2ea5da5d5477b4; corroborated DB-H1/M1 integrity gap closed. Its asserted 15/20 false PASS is contradicted by unchanged ≥90% predicate; no lowered criterion. |
| M9-FINAL-CA-F2 | FIXED | 96dfc37a4ccc1ac7c885ed131b2ea5da5d5477b4; receipt uniqueness seeded from original batch and shared across both recheck batches. |
| M9-FINAL-CA-F3 | FIXED | 96dfc37a4ccc1ac7c885ed131b2ea5da5d5477b4; corroborated DB-L3 exact container identity from actual scan format. |
| M9-FINAL-CA-F4 | FIXED | 96dfc37a4ccc1ac7c885ed131b2ea5da5d5477b4; final rows disclose/check cumulative attempts; raw deployed commit required; producer SHA compared against actual final plan. |
| M9-FINAL-CA-GAPS | FIXED | 96dfc37a4ccc1ac7c885ed131b2ea5da5d5477b4; compound negative fixtures listed above. |

| M9-FINAL-SELF-ADMISSION | FIXED | 3751b8d56dbc2d9beadcba73d796ff7da0e679ce; zero-ms wait refused before any dispatch at96dfc37. Original collector refusal retained; actual gateway admits all four final profiles at1ms/1s/10s. Twenty evaluator and34 affected tests PASS. Initial stale0ms fixture failed and was corrected; no target or paid execution occurred. |

| M9-FINAL-SELF-STATUS | FIXED | cf7ab14a703dd2af7cb1a90be4593bc7648daf27; failed binary evaluation now retains canonical BLOCKED rather than generic IN_PROGRESS. It cannot grant acceptance; all gates still require PASS. Both canonical documents and existing overview realigned to actual corpus, closed windows, measured accounting and held activation. |
