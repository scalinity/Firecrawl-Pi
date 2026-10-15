# Local Agent critical review — 2026-10-15

A separate fresh-context implementation reviewer inspected the additive local playground feature and reproduced the findings below with in-memory fixtures. This is not a new milestone acceptance review. Review runtime: GPT-6.1 Sol, xhigh. Full-suite and live execution are recorded separately.

| ID | Severity | Finding | Outcome |
|---|---|---|---|
| R1 | P1 | `scripts/playground/agent.mjs`: a rejected quotation could survive in the synthesized answer/result alongside one accepted finding. | Fixed: withhold the decision answer/result and preserve only verified findings as partial; mixed valid/invalid quotation regression passes. |
| R2 | P1 | `services/access/src/jsonscrape.mjs` and `extractor.mjs`: a client disconnect during acquisition could still start extraction, chunks or repair. | Fixed: propagate disconnect and deadline through SSH, acquisition, internal HTTP, chunks, and repair; real-socket regressions pass. A harmless Pi fixture closed the remote connection in 14 ms; already dispatched provider work may settle. |
| R3 | P2 | `services/retrieval/src/extract.mjs`: requested model was echoed while provider resolved identity was ignored. | Fixed: validate and report the resolved model identity and distinguish configured effort; mismatch fixtures stop without fallback. |
| R4 | P2 | `services/retrieval/src/extract.mjs`: missing usage became false measured zeros. | Fixed: preserve unknown token totals and distinguish conservative charges; missing-usage fixture passes. |
| R5 | P2 | Gateway failure discarded usage already incurred before a repair budget denial; Agent reported zero spend. | Fixed: retain failure metadata and mark absent totals unknown; repair-budget fixture preserves the initial settled call and cost. |

The reviewer found no XSS, request-guard, or unbounded-page defect in the inspected paths. That is a bounded review result, not proof of absence. The optional schema UI and 1,200-character task limit were also aligned with the engine contract.

A separate harmless SSH-disconnect probe confirmed that terminating local SSH alone leaves its remote Python child alive. The exact disposable process was terminated after the probe. R2 therefore includes the SSH-to-HTTP lifecycle rather than assuming that killing SSH cancels remote work.

Fresh remediation review: 46 focused tests PASS; a separate integrated engine → JSON scrape → Agent repair-denial fixture retained one settled call and 17 micro-USD while returning failed. Runtime and deployment receipts identify the final source commit. No hosted Agent task was submitted.
