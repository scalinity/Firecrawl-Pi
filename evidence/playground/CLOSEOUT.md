# Local Agent — 2026-10-15

The localhost playground now supports a bounded research Agent over the Pi gateway. It accepts a task, optional starting URLs and result schema, streams actual search/read activity, and returns a sourced answer, quotations, documents, model identity, usage and limitations. It explicitly requests GPT-6.1 Sol with xhigh reasoning. Ordinary JSON extraction retains Luna. This foreground workflow is not a durable hosted Agent service.

## Verification

- **PASS:** 61 web/Agent/access tests and 39 extraction/budget tests. `verification.json` records commands, source/configuration hashes, image provenance and receipts. Retrieval tests use the same fixture layout as the existing service runners. The initial direct repository-root invocation failed before those two retrieval suites could load their layout dependencies; the correctly staged run passed 39/39.
- **PASS:** actual browser → localhost bridge → SSH → Pi gateway → retrieval/model → browser flow. `live-agent-rerun.json`: completed, resolved `gpt-6.1-sol`, configured xhigh, one new model call, 4,473 input and 436 output tokens, 13,306 micro-USD accounted cost, about 8.96 seconds, two verified findings. The provider confirms model identity; its response does not attest reasoning effort. These are local accounting figures, not a vendor invoice.
- **FAIL, fixed and rerun:** `live-agent.json` preserves the first run's partial result and 13,286 micro-USD cost. Unused nullable action fields were incorrectly treated as required facts. `8b7d7c4` fixes their schema semantics; the answer is not promoted by suppressing extraction warnings.
- **PASS:** fresh-context critical review and remediation in `review/REVIEW.md`. R1–R5 are fixed by `4bcb097`; R6 by `8b7d7c4`. A harmless Pi fixture confirmed SSH cancellation closed its internal HTTP connection in 14 ms. Work already dispatched to a provider may still settle.
- **PASS:** two native ARM64 image builds and targeted container recreations. `raw/image-build.txt`, `raw/deployment.txt`, and `raw/runtime-policy.txt` identify the build and deployment. All 15 project containers were healthy; the other 13 container identities remained unchanged; no transient containers remained.
- **PASS:** Agent desktop and 390 px visual checks, and refreshed orchestration page in light/dark at desktop and 390 px, without page errors. Task-owned screenshot files were deleted. REA retained observation IDs are in `verification.json`. The live browser event capture is marked incomplete because a selected GET request body was not exposed; both Agent request/response bodies and every scenario action were captured.

## Budget and boundaries

LLM extraction has $20 per calendar month with no category daily cap. Residential proxy has $1 per day/$2 per month. The shared paid-provider cap is $1 per day. Enhanced retrieval and paid parsing remain at zero. Atomic reservations and model allowlisting remain enforced. No alternate provider or Firecrawl Cloud fallback was enabled. No hosted Firecrawl Agent task or connected-provider approval was submitted.

REA recovered the signed-in client contract: submission, polling, trace merging, follow-ups, cooperative cancellation, credit stops, history, sharing and provider controls. `AGENT-RESEARCH.md` identifies artifact hashes, byte ranges, Evidence IDs and semantic limitations. Spark 2's server prompts, planning implementation, model composition, billing and storage remain unknown. No third-party implementation was copied into the local feature.

## Host comparison

`snapshot-entry-diff.json` compares the previous accepted AFTER snapshot with this work's BEFORE; `snapshot-after-diff.json` compares this work's BEFORE/AFTER. No reboot occurred. The two gateway/retrieval container IDs, their overlay/network namespace mounts and systemd scopes changed with recreation. The loopback gateway listener retained its address/port and acquired a new docker-proxy PID. All unrelated container identities, host service names, listener addresses/ports, nft table/chain definitions and forwarding switches stayed unchanged during this deployment.

**Unresolved snapshot finding:** the whole nft ruleset hash differed at entry and changed on recreation, returning exactly to the previous accepted AFTER digest. No firewall command modified rules during this work. A bounded attempt to reproduce the prior digest by changing only one internal bridge address found no match (`firewall-attribution.json`). The complete causal history is unproven; the host comparison is therefore recorded FAIL, separately from functional verification. No full platform requalification is claimed.

## State

The local server remains available at `http://localhost:8767/LLM-DEMO.html`, opened in a Chrome app window. It holds request history in tab memory only. Pi images were built from `4bcb097`; deployment marker `21ac35e` pins those images. The later `8b7d7c4` correction runs in the Mac calling client and requires no Pi image change.

`ORCHESTRATION.html` was realigned against both canonical documents: current budget figures, embedded source hashes and citation ranges. Milestone order and accepted milestone states did not change. The initial unrelated `.DS_Store` remains untracked.
