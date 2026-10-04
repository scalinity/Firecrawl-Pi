# Hosted MCP independent review

Candidate: a5e1c9042bd7b162628d306b4072d19487050e5d. Base: 311069d8bae453f29894f09f8e577ff25e9d21f8.

Two independent fresh-context reviewers, DB1 debugger and CA1 code auditor, ran the repository's /review-2 equivalent read-only. Opus 5.5 was unavailable in the review-agent runtime; both used gpt-6.1-sol under AGENTS.md §5. No implementation context/history was inherited. Review covered all seven changed files, their tests and downstream gateway boundaries. No public ingress or provider dispatch preceded remediation.

## Findings and dispositions

| ID | Finding | Outcome |
| --- | --- | --- |
| DB1-W1 / CA1-3 | Caller departure did not immediately cancel an upstream exchange | FIXED: race forwarding against caller EOF; cancel both tasks, close upstream and release permits; tests cover departure before headers and between SSE events. Commit recorded below. |
| DB1-W2 / CA1 recovery suggestion | Interrupted runtime-key provisioning prevented matching setup from resuming | FIXED: matching partial installations resume; publish staged complete files by hard link, validate both existing files before writes, reject conflicting rotations. Commit recorded below. |
| CA1-1 | Claimed the old remote program appended literal backslash-n rather than a newline | REJECTED: exact candidate AST evaluation and subsequent remote-program parsing prove suffix bytes [10], a single newline. See escaping-proof.json. No key was entered or dispatched to prove this. |
| CA1-2 | Secret created under inherited umask before chmod | FIXED: staged files are created private by mkstemp; credentials remain mode 0600 throughout write/publication. Fixture injects a pre-write failure under ordinary permissions. Commit recorded below. |
| CA1 response-cap suggestion | Truncated responses were logged like completed 200 responses | FIXED: response_too_large outcome identifies truncation independently of the already-sent HTTP status. Commit recorded below. |

## Security findings

Neither reviewer established an authentication bypass, request-smuggling path or selectable upstream. Exact /mcp routing, fixed loopback forwarding, dedicated identities, header allowlisting, redirect denial, body/header/time/concurrency bounds and existing gateway Origin/SSRF checks were retained. No new Cloud fallback or provider spending path was introduced. Runtime credentials do not appear in arguments or checked-in configuration.

## Remediation

Equivalent /address is used because this runtime has no /address command. Findings are handled independently of the original implementation; no push is authorized. Twelve affected fixtures pass, including key byte accuracy, restrictive creation modes, resumable setup, mismatch/symlink denial and both caller cancellation phases. Live account verification remains distinct from fixture proof.

Remediation commit: c7fd84ecd614939a2ce368d604555dd269619716.

Verdict: implementation remediation complete; live deployment and hosted account verification still required.


## Follow-up review and operational remediation

The same two independent reviewers examined the committed standard-HTTPS changes and the later TCP half-close correction. Both approved the focused source remediation without claiming hosted UI acceptance or rerunning live probes.

| ID | Finding | Outcome |
| --- | --- | --- |
| DB1-W3 | Verifier failure classification did not reliably preserve ordinary transport failures | FIXED in 19d5bdc2814b803b4909232afd15cf8a017b016a; failures become explicit FAIL records. |
| DB1-W4 | Controlled scrape needed content validation rather than transport success | FIXED in 19d5bdc2814b803b4909232afd15cf8a017b016a; fixture heading, content hash and request ID recorded. |
| DB1-W5 | Malformed SSE and partial evidence needed explicit failure | FIXED in 19d5bdc2814b803b4909232afd15cf8a017b016a; malformed responses fail and completed records are retained. |
| DB1-W6 | SSH forwarding readiness could be inferred too early | FIXED in 19d5bdc2814b803b4909232afd15cf8a017b016a; both ports, child exit/error and readiness deadline checked. |
| DB1-W7 / CA1-5 | HTTPS default-port Host form was not accepted or proven correctly | FIXED source in 19d5bdc2814b803b4909232afd15cf8a017b016a, verifier guard/provenance in 35336ddbe320b27714719522b62d88b51e5a6df6; stale live configuration corrected by running the committed installer migration and restarting ingress at 2026-10-04T03:50 UTC. Prior :10000-derived verifier runs do not prove bare port-443 Host behavior and are superseded. |
| DB1-W8 | Forward shutdown and evidence provenance could hang or fail during cleanup | FIXED in 19d5bdc2814b803b4909232afd15cf8a017b016a; child completion watched from creation, bounded shutdown, deployed source collected before probes. |
| CA1-4 | Native client proof could be mistaken for hosted invocation | FIXED in 19d5bdc2814b803b4909232afd15cf8a017b016a; evidence explicitly marks private transport and hosted_product_invocation=false. |
| DB1-W9 | A clean TCP request-direction FIN was incorrectly treated as abandonment of the response | FIXED in c35cbe69fc2b77f9bf4b8e2d42a79477110def9e; keep forwarding after clean EOF, observe actual transport closure/reset and failed response writes, drain headers, prefer completed response when both tasks finish, retain 130-second timeout and deterministic cleanup. |

DB1-W9 is a protocol defect under RFC 9112 section 9.6. The controlled real-socket JSON half-close fails against 19d5bdc and both JSON and SSE pass after remediation (half-close-regression.json). The baseline test stops at its first JSON assertion; it does not independently establish a baseline SSE failure. This does not prove half-close caused the earlier Funnel ECONNRESET. The failed public run remains retained. A clean FIN cannot distinguish a graceful full client close from a write half-close; without reset/failed write/transport closure, cleanup remains bounded by the exchange deadline.

Final focused DB1 and CA1 verdicts: no remaining source blocker in these changes. Local 17-test fixture run passes; Pi fixtures and fresh external proof are recorded separately. Native global-client proofs and historical M9 acceptance remain separate from hosted product acceptance.


## Final evidence-verifier review

Both existing independent reviewers performed a focused read-only review of the new post-M9 redaction verifier. The same gpt-6.1-sol substitution applies; Opus5.5 was unavailable in the review-agent runtime. This is source review, not a substitute for live product acceptance.

| ID | Finding | Outcome |
| --- | --- | --- |
| CA1-6 / DB1-W10 | Missing hosted credentials could be skipped while inclusion flags claimed true | FIXED in 552f0ccff734b9bdbc591de6067e375eb96533a7: explicit regular/nonsymlink/readable/nonempty admission, newline-only rejection, mandatory tagged hashes checked exactly once, flags derived from validated inventory. Seven exact-loop inventory cases PASS, without fixture plaintext output. |
| DB1-W11 | Whole-token hashing missed secrets embedded in assignment/header/URL prefixes | FIXED in 552f0ccff734b9bdbc591de6067e375eb96533a7: retain whole-token candidates and separately extract ordinary prefix/userinfo components, including percent decoding. Nine hash-specific positive controls PASS; report explicitly limits arbitrary transformed/truncated encodings. |

Both reviewers approved the corrected verifier by source inspection, with no remaining blocker. They did not independently rerun the fixtures. Final repository scan and fixtures are retained separately. All accepted source findings are fixed; the literal-newline allegation remains rejected with evidence. No finding was silently deferred.
