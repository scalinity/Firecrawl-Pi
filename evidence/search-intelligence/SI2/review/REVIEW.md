## Code Review: SI2 — Co-primary documentation, Ref MCP sessions, Jev decisions and semantic ranking

### Summary

Two fresh-context reviewers read `bdf91d8..HEAD` (`bdf91d8477d5483664dfba77f697c58340e9eae2..a3e69fc`) under `services/retrieval` read-only, both on `claude-opus-5-5`. DB1 (`db1-bugs-si2`) took the debugger lane: logic, runtime and integration, including the MCP client 2.1.0 internals. CA1 (`ca1-audit-si2`) took the code-auditor lane: architecture, security, performance, data integrity and test quality.

The accounting and transport core holds:
- each reservation has exactly one closer;
- the Ref bridge is the MCP client's only route out;
- a withdrawn operation is never written after its reservation is released;
- Jev's instructions never contain candidate text.

Two defects block acceptance:
- Ref reads its account-refusal phrases inside ordinary documentation text, which switches the lane off indefinitely (both reviewers).
- The caller's query reaches Ref with `ref_src=private` directives intact (CA1).

Twelve warnings concern the session goodbye, SSE failure handling, deadlines for a cached discovery, cache identity, activation false positives and untested egress paths.

**Scope:**
- **Reviewed:** the changeset is 31 files and +2,858/−280, so the large-changeset guard applied.
  - **Tier 1, full review:**
    - new files: `adapters/ref-bridge.mjs`, `adapters/ref.mjs`, `adapters/context7.mjs`, `decisions.mjs`, `documentation.mjs`;
    - modified files: `src/provider.mjs` (streaming transport and shared `prepare()`), `adapters/common.mjs` (reserve, meter, observe, mcpFailure), `coordinator.mjs` (docs lanes, leases, Ref reads, aggregate store key) and `src/server.mjs` (wiring).
  - **Tier 2, skimmed:**
    - `normalize.mjs`, `budget.mjs`, `package.json`, `permits.mjs`;
    - the SI1 remediation edits to `brave`, `exa`, `deepseek`, `tavily`, the Serper lane, `availability.mjs`, `search.mjs` and `serper.mjs`;
    - the SI2 tests, read for test quality: `si-helpers`, `si-ref`, `si-docs-search`, `si-jev-search`, `si-docs-decisions`, `si-semantic`.
  - **Tier 3, acknowledged only:** `package-lock.json`, `si-discovery`, `si-capacity`, `si-store`.
- **Out of scope, as stated in the review context:**
  - SI3 outside `services/retrieval`, i.e. gateway, MCP server, core patch and playground;
  - SI4 telemetry;
  - the dashboard;
  - SI1 findings already dispositioned.
- **Not run by the reviewers:** test suite, linters, build.
  - CA1 ran read-only in-memory `node` snippets against the real modules to confirm C1, W8 and W9.
  - The orchestrator independently reproduced C1 on the real parsers.

Paths below are relative to `services/retrieval/src/search-intelligence/` unless they start with `services/` or `test/`.

### 🔴 Critical Issues (Must Fix)

**Introduced in this changeset:**

1. **C1 — Ref's auth and quota phrases match inside result overviews and read content, so a doc page that says "Unauthorized" holds the Ref account until its key changes** - `adapters/ref.mjs:19-30,42-43,53-54` _(corroborated: both agents)_
   - Problem: `AUTH` and `QUOTA` are unanchored (`/\bunauthori[sz]ed\b/i`, `/\binvalid api key\b/i`, `/Please verify your email/i`, `/\b(out of|no remaining|insufficient|not enough) credits\b/i`). `parseRefSearch` runs `classifyError` on every text block *before* it parses result blocks. `parseRefRead` runs it on the whole excerpt. The SI0 contract (`evidence/search-intelligence/SI0/provider-contracts-2026-10-17.md` §6) documents Ref's refusals as whole messages with fixed openings, and a read returns the page content verbatim. Provider-relayed documentation is being used as an account signal (CWE-20; spec §6.2 "untrusted provider text is data").
   - Risk: independently flagged by both reviewers, and reproduced by CA1 and by the orchestrator on the real parsers:
     - `overview: Handling 401 Unauthorized responses with interceptors` gives `auth_failed`;
     - "Twilio: insufficient credits error 20003" gives `quota_exhausted`;
     - a read containing "rejected as Unauthorized (401)" gives `auth_failed`.

     Trace for the query "axios interceptor refresh token on 401 unauthorized" with documentation active:
     1. Ref returns normal blocks, and `parseRefSearch` answers `auth_failed`.
     2. `closeFor` keeps a billed success UNCERTAIN.
     3. `judged` calls `dispatch.report({reason:"auth_failed"})`, and `availability.observe` persists `auth_failed`.
     4. `availability.check` then refuses Ref on every search until the credential epoch changes, restarts included. Quota text has no `retryAt`, so it is held the same way.

     One ordinary documentation search disables a co-primary lane indefinitely.
   - Fix: parse result blocks first. Classify error text only when nothing was recognized, and only when a block *starts* with a documented refusal. A read is judged by `isError` or its leading block alone.
     ```js
     const AUTH = [/^Ref is not correctly configured\b/i, /^Please verify your email at https:\/\/ref\.tools\//i, /^(Error:\s*)?(invalid api key|unauthori[sz]ed)\b/i];
     const QUOTA = [/^(Error:\s*)?((out of|no remaining|insufficient|not enough) credits|credit limit (reached|exceeded))\b/i];
     function classifyError(text) {
       const t = text.trim();
       if (AUTH.some((r) => r.test(t))) return { kind: "error", reason: "auth_failed", detail: "ref_auth_text" };
       if (QUOTA.some((r) => r.test(t))) return { kind: "error", reason: "quota_exhausted", detail: "ref_quota_text" };
       if (ERRORS.some((r) => r.test(t))) return { kind: "error", reason: "temporarily_unavailable", detail: "ref_error_text" };
       return null;
     }
     // parseRefSearch: results first, then the exact sentinel, then a leading refusal, else contract_failure.
     // parseRefRead: classifyError(texts[0]) only.
     ```
     Add regression cases: a block whose overview mentions "401 Unauthorized" is a hit; a read with "Please verify your email" or "insufficient credits" midway is text; Ref stays available after such a search.

2. **C2 — The caller's query reaches Ref with private-workspace directives intact** - `adapters/ref.mjs:59-64` _(unique to CA1's lane)_
   - Problem: spec §6.2 says "provider directives such as `ref_src=private` are not admitted from caller query syntax in this adapter". `refQuery` forwards `normalizeQueryText(originalQuery)` and free-form library names, which can be 1–200 characters, without neutralizing anything. Nothing under `src/` mentions `ref_src` (CWE-74; exposure CWE-200).
   - Risk: trace for `originalQuery: "ref_src=private deployment runbook"`, or `libraries: [{ name: "ref_src=private" }]`, with documentation required:
     1. `ref_search_documentation({ query: "ref_src=private deployment runbook" })` is sent.
     2. Ref searches the account's private sources.
     3. Those results become candidates. They are sent to OpenRouter as Jev excerpts, stored in the provider and aggregate caches, and returned.

     A prompt-injected agent can be steered into sending such a query. Whether anything leaks depends on what the account indexes, but the required control is absent.
   - Fix: scrub directive tokens from the query and the hints. `cacheIdentity` uses `refQuery`, so the cache key follows.
     ```js
     const REF_DIRECTIVE = /(^|\s)ref_[a-z]+\s*=\s*\S+/gi;
     const scrub = (s) => String(s).replace(REF_DIRECTIVE, " ").replace(/\s+/g, " ").trim();
     export function refQuery(request) {
       const q = scrub(normalizeQueryText(request.originalQuery)), low = q.toLowerCase();
       const hints = [...(request.intelligence.libraries ?? []).map((l) => scrub(l.version ? `${l.name} ${l.version}` : l.name)),
         request.intelligence.programmingLanguage && scrub(request.intelligence.programmingLanguage)].filter((h) => h && !low.includes(h.toLowerCase()));
       return [q, ...hints].join(" ").slice(0, 500);
     }
     ```

### 🟡 Warnings (Should Fix)

**Introduced in this changeset:**

1. **W1 — A Ref session closed after its deadline never sends its DELETE** - `adapters/ref-bridge.mjs:87` _(corroborated: both agents)_
   - Problem: the goodbye is bounded by `Math.min(until, Date.now() + 1000)`, and `until` is the session deadline: the lane's, or `readClose`. The coordinator closes leases in `finally`, after a semantic phase of up to 8 s, so the deadline has usually passed. `prepare()` then throws `PROVIDER_TIMEOUT` before sending, `close()` swallows it, and the remote session is abandoned. The fixtures don't show this because the fixture Jev answers instantly.
   - Suggestion: give the DELETE its own one-second bound, for both the permit wait and the send, and test closing a lease after its deadline.

2. **W2 — For a cached discovery, opening the session, the context search and both reads share one `refReadMs` window** - `coordinator.mjs:301,309,315` _(corroborated: both agents)_
   - Problem: `readClose = min(semanticClose, t0 + refReadMs)` bounds `contextLease`, whose four sequential exchanges include the billable search, and also the reads after it. Spec §6.2 clips `context_init` to the remaining semantic-phase deadline and gives *each* read up to 2,000 ms. At real latency the reads start with little or no time left, are written, then time out. Each leaves an UNCERTAIN credit and a breaker failure that our own deadline caused.
   - Suggestion: run `contextLease` under `semanticClose` minus a reserve for the reads, compute `readClose` once it returns, and skip the reads, recording a limitation, below a useful minimum.

3. **W3 — An SSE answer that errors or ends after its headers leaves the tool call waiting until its deadline, then counts as a timeout against the service** - `adapters/ref-bridge.mjs:92`, `adapters/common.mjs:212` _(unique to DB1's lane)_
   - Problem:
     - In the legacy era the client's `_handleSseStream` only calls `onerror` on a stream error or an end with no response. Nothing rejects the pending request, so `callTool` fails only at its `timeout` with `REQUEST_TIMEOUT`.
     - So an oversized answer (`PROVIDER_RESPONSE_TOO_LARGE`, a contract failure that is neutral for the HTTP adapters) or a cut stream holds the lane for its whole deadline and then trips the breaker as a timeout.
     - Conversely, a JSON answer cut off after its headers rejects `response.json()` with a ProviderError carrying `status: 200`. `mcpFailure` checks status first and calls it a neutral contract failure.
   - Suggestion: have `providerStreamRequest` pass its error to `onEnd(err)`. Record it on the operation and race the tool call against it. Judge a transport `ProviderError` by its string `code` before the `status` branch. Test both an oversized SSE answer and a stream cut after its headers.

4. **W4 — Context7 reports `dispatchState: "not_sent"` for answered or possibly-sent calls, and counts uncertain calls unlike the other adapters** - `adapters/context7.mjs:117-120` _(corroborated: both agents, DB1-W3 and CA1-S4)_
   - Problem: the lane's `dispatchState` is `response_received` only when a scope came back ok or empty. A lane answered with 402, 429 or 503, or one that timed out after writing, is published as `not_sent`. That contradicts the ledger and its own `usage.requests`, which counts possibly-sent calls but leaves out answered refusals and a malformed 200 that was settled at 1. Jev and Ref count neither.
   - Suggestion: derive `dispatchState` from the scope results (any answered gives `response_received`, any possibly sent gives `possibly_sent`). Count answered scopes in `usage.requests`, and report uncertain calls by one rule across adapters.

5. **W5 — An answer whose Ref reads failed is stored whole and served for the cache lifetime, and nothing checks for cancellation before storing** - `coordinator.mjs:268-276` _(unique to DB1's lane)_
   - Problem: `complete` ignores `enrichment.limitation`. A degraded answer with a `ref_enrichment_*` warning built into `body.warning` is stored for the aggregate TTL. That contradicts the rule written just above it: "a fallback from a configured layer that failed is degraded and is not stored". A cancelled search's answer can also be stored when no Jev is configured.
   - Suggestion: store only when `complete && fullyRanked && !enrichment.limitation && !parent.signal.aborted`.

6. **W6 — The aggregate answer is keyed by the Jev build the process saw last, not the one that ranked it, and an alternating backend defeats the caches** - `coordinator.mjs:278`, `decisions.mjs:124-125,174` _(only CA1 — DB1 was in scope but didn't flag)_
   - Problem: `concrete` and `epoch` are process-wide state that concurrent searches update. The key computed at store time can carry build B for an answer build A ranked. Because the family accepts dated builds, a backend that alternates builds bumps `epoch` on every switch, and both caches stop hitting.
   - Suggestion: have `rerank` return the identity its batches actually answered with, and store whole only when all batches agree. Key on the concrete build string itself instead of a counter, so a switch back reuses that build's entries.

7. **W7 — A failed session open is judged by whether anything was written, not by whether the failing request was** - `adapters/ref.mjs:93-99` _(unique to DB1's lane)_
   - Problem: once `initialize` has been written, a `tools/list` that never left (its permit or DNS wait outlasted the deadline, and the Protocol timer fired) is judged timeout plus sent, a breaker failure. Spec §15 counts an unsent call only when the provider was unreachable. The handshake's plain `Error`s ("protocol version is not supported", "invalid initialize result") also fall through to `temporarily_unavailable`, not `contract_failure`.
   - Suggestion: track whether each request was written, keyed by JSON-RPC id, and judge the failing request by its own flag. Map handshake version and shape errors to `contract_failure`.

8. **W8 — Ref's block parser takes time quadratic in the answer size** - `adapters/ref.mjs:22,43` _(unique to CA1's lane)_
   - Problem: the lazy `[\s\S]*?` in `BLOCK` is retried from every `overview:` and scans to the end each time (CWE-1333). CA1 measured 60k characters at 20 ms, 120k at 81 ms and 240k at 305 ms. At the 1 MiB `responseBytes.ref` bound that extrapolates to about 6 s on the workstation, synchronous and uninterruptible, stalling every request the service is handling.
   - Suggestion: a line-by-line overview → url → moduleId state machine, with a scaling test (200k characters in under 50 ms).

9. **W9 — Deterministic activation fires on non-technical queries and spends Ref credits without asking Jev** - `documentation.mjs:15-22,36-37,54` _(only CA1 — DB1 was in scope but didn't flag)_
   - Problem: "compose 2 emails to my boss", "flask of 2 liters price", "pandas 2 cubs born at the zoo" and "rails for 3 stairs" all match `library_version`, and "is www.bbc.co.uk down" matches `api_symbol`. Three causes:
     - `flask`, `rails`, `pip`, `docker`, `compose` and `react` are in both `LIBRARIES` and `COMMON_WORD_LIBRARIES`, and `LIBRARIES` wins;
     - any bare integer is a `VERSION`;
     - one `SYMBOL` alternative matches any three-label hostname.
   - Suggestion: remove the overlap, require a dotted or `v`-prefixed version beside a library, and drop or restrict the hostname alternative. Add these queries to the activation test.

10. **W10 — The bridge's egress rules have no tests** - `adapters/ref-bridge.mjs:59,66,82`; `services/retrieval/src/provider.mjs:166` _(unique to CA1's lane)_
    - Problem: the bridge is the MCP client's only SSRF choke point (CLAUDE.md §13), yet none of these is tested:
      - another host or URL;
      - an unsupported method;
      - a 3xx answer reaching the client and not being followed;
      - an SSE body crossing `responseBytes.ref`;
      - the paid-dispatch recheck before send.

      `providerStreamRequest` has no direct test either.
    - Suggestion: add bridge tests for each of these with `refFixture`.

11. **W11 — The case "request written, then the client times out" is untested** - `adapters/ref.mjs:116-119`, `adapters/ref-bridge.mjs:106-108` _(unique to CA1's lane)_
    - Problem: release versus UNCERTAIN depends on `handle.written()` after `withdraw()`. A server that accepts the POST and then stalls past the deadline is never tested.
    - Suggestion: a stalling fixture tool with a short deadline. Assert the row is UNCERTAIN, the breaker records exactly one failure, and the call is seen once.

12. **W12 — Jev's settled amounts and the real documentation-classifier path are untested** - `decisions.mjs:164-166,188-197` _(unique to CA1's lane)_
    - Problem: no test asserts the settled amount, which is `usage.cost` in micro-USD, else tokens at the card's rate, else the reservation. `classifyDocs` runs only through a stub, and `needs_documentation` appears in no test.
    - Suggestion:
      - assert `usage.cost: 0.000123` settles 123;
      - assert the token-rate amount when no cost is given;
      - run a weak-cue query through the coordinator, asserting one `docs_detect` call, its ledger row and the activation reason.

### 🔵 Suggestions (Consider)

**Introduced in this changeset:**

1. **S1 — The batch bound allows 2 KiB more than the spec** - `decisions.mjs:132` _(unique to CA1's lane)_
   - Current: `maxBytes + 2048`.
   - Better: `maxBytes` exactly; batches are already sized by the identical serialization.
2. **S2 — Jev's reservation assumes output is free** - `decisions.mjs:139-140` vs `:165` _(unique to CA1's lane)_
   - Current: settlement prices `outputPerMTok`, and a card may price output above zero.
   - Better: reserve for the input plus a bounded output allowance, as `maxModelCost` does.
3. **S3 — The classifier's spend is not reported when the classifier fails after settling** - `documentation.mjs:82`, `decisions.mjs:194-196` _(unique to CA1's lane)_
   - Current: neither the invalid-answer branch nor the envelope-failure fallback reports `usage`.
   - Better: return `usage` from every branch after settlement, and copy it onto the fallback activation.
4. **S4 — `providerStreamRequest` duplicates `providerRequest`'s connection logic** - `services/retrieval/src/provider.mjs:128-194` _(unique to CA1's lane)_
   - Current: the remote-address check, the TLS-gated send, the authorization recheck and the timers are copied.
   - Better: one shared connection helper.
5. **S5 — Ref-specific session logic lives in the generic coordinator** - `coordinator.mjs:290-327` _(unique to CA1's lane)_
   - Current: `refReads` reaches into `docs.ref.contextLease`, `docs.ref.api` and the `"ref"` lease key.
   - Better: an `enrich()` on the Ref adapter; the coordinator keeps lifetime and budget only.
6. **S6 — Policy values are inline numbers** - `adapters/ref.mjs:209` (`48 * 1024`), `documentation.mjs:83` (`0.2`), `decisions.mjs:62` (`[1500, 700, 300]`), `decisions.mjs:211` (`0.6`) _(unique to CA1's lane)_
   - Better: name them with their spec section, and move the read bound into `limits()`.
7. **S7 — The MCP client's error log can carry provider response text** - `adapters/ref.mjs:77` _(unique to CA1's lane)_
   - Current: an `SdkHttpError` message reads "Error POSTing to endpoint: <body>".
   - Better: log only `e.code` and `e.status` (§24).
8. **S8 — Some new branches have no tests** - `decisions.mjs:201-214,224-234,256-260`; `coordinator.mjs:309-310` _(unique to CA1's lane)_
   - Current: Jev's duplicate-pair questions and the `session_unavailable` enrichment limitation are never exercised.
   - Better: one test each.
9. **S9 — The Ref tests use fixed sleeps** - `test/si-ref.test.mjs` _(unique to CA1's lane)_
   - Current: `sleep(50)` and `sleep(300)`.
   - Better: poll `fx.log` or `permits.snapshot()` against a deadline.
10. **S10 — The goodbye's 1 s timer is never cleared** - `adapters/ref.mjs:84` _(unique to CA1's lane)_
    - Current: every `close()` leaves a 1 s timer pending.
    - Better: clear or `unref()` it.
11. **S11 — On a retried logical search, a fresh context search is paid for and then both reads are refused** - `adapters/ref.mjs:191,207` _(unique to DB1's lane)_
    - Current: `context_init:<time>` is a new key each run, but `read:<sha(url)>` is stable. A retry pays for a fresh context search, then both reads are refused as `operation_already_recorded`.
    - Better: skip the context search when every selected read is already recorded, or put the session epoch into read keys.
12. **S12 — `contextLease` never checks the session's tools** - `adapters/ref.mjs:188-197` _(unique to DB1's lane)_
    - Current: it calls `ref_search_documentation` on a session that may not offer it, and a refused call is closed UNCERTAIN.
    - Better: the same `tools.has(...)` check `search()` makes, with no reservation.
13. **S13 — A client-side ProtocolError raised before sending is held UNCERTAIN** - `adapters/common.mjs:217` _(unique to DB1's lane)_
    - Current: any integer `code` gives `response_received`; `callTool`'s `assertCompiled()` throws before anything is written.
    - Better: when `!sent`, return `not_sent` and neutral.
14. **S14 — An empty shortlist is reported as a semantic fallback** - `decisions.mjs:264-265` _(unique to DB1's lane)_
    - Current: with no pooled documents, `rerank` returns `rrf_fallback / insufficient_semantic_coverage`. A valid empty answer then warns and is never stored.
    - Better: a distinct reason, treated as fully ranked, with no warning.

### ✅ Good Practices
- The bridge is the MCP client's only route out:
  - it matches the endpoint exactly and follows no redirects;
  - it adds the key on the wire and removes `x-fcpi-operation` before sending, which a test asserts;
  - it reuses `prepare()`'s egress checks.
- `op` / `withdraw` / `written` correctly makes up for the legacy-era client never aborting a fetch in flight, so a withdrawn operation is refused wherever it waits.
- `untilAnswered` ends a held-open SSE answer once every request id is answered, and the request permit returns exactly once. Receive streams take their own slot or get a 405.
- `reserve()` and `meter()` give each call one breaker verdict. An admission refusal never returns a probe slot, and a failed session open takes none.
- Jev's instructions are fixed strings with ids. Candidate text, constraints and the query stay in `state`, and the injection test checks that boundary.
- No lease reaches a cache or a response: `takeLease` strips it, `runLane` caches an explicit field list, and a late lease is closed on arrival.
- The tests use real HTTP fixtures, including a hand-written Streamable HTTP MCP server, and assert ledger row states.

### Verdict
[x] ❌ Request Changes (critical issues)
[ ] ⚠️ Approve with Suggestions
[ ] ✅ Approve

---

### Found during remediation

- **F1: a reported dollar cost could settle one micro-USD high** (`decisions.mjs`, `adapters/exa.mjs`). Writing W12's settlement test showed that `Math.ceil(dollars * 1e6)` turns float error into a whole unit: `0.000123 * 1e6` is `123.00000000000001`, so Jev's `usage.cost` and Exa's `costDollars.total` could settle above the provider's own figure. Fixed in `e8588ec` with one `microUsd()` that rounds to nano-USD before rounding up.
- **F2: the session goodbye also inherited the search's cancellation and the paid-dispatch check** (`adapters/ref-bridge.mjs`). W1 named only the deadline, but a cancelled search's session was never ended either. Fixed with W1 in `99ae89b`.
- **Observation (not a defect):** with only one documentation provider configured, every documentation answer is `partial`, because the fixture roster lists both providers and an unconfigured lane is a named exclusion. No such answer is ever stored whole. This is the honest-coverage rule working as designed. The W5 test configures both providers so that it exercises the storage path.

### Finding dispositions

Filled by `/address`. Each finding is fixed (with its commit), rejected (with evidence) or deferred (with the later milestone that owns it and why).

| Finding | Outcome | Evidence |
|---|---|---|
| C1 | Fixed (`073a85f`) | Refusals match only at the start of a non-result block; reads only Ref's documented read refusals. The new parser and adapter tests fail on the previous parser. |
| C2 | Fixed (`fbdefd4`) | Every `ref_<name>=` directive is scrubbed from the query, the hints and the cache identity, and a directive-only query is not represented. The test fails on the previous `refQuery`. |
| W1 | Fixed (`99ae89b`) | The DELETE has its own one-second bound for its permit and send, and also outlives the search's cancellation and the paid check (F2). The test closes leases after their deadline and after cancellation. |
| W2 | Fixed (`5fdd7ea`, on `0ca99bd`) | The fresh session and its context search get the semantic phase less a read's time. Each read's deadline is taken after that, with under 500 ms left recorded as a limitation. The slow-session test fails after 2 s on the previous code. |
| W3 | Fixed (`55875b5`) | `onEnd(err)` and the operation's failure race the tool call, and `mcpFailure` judges `ProviderError` codes before status. On the previous code the oversized answer waited 6 s and was judged a timeout. |
| W4 | Fixed (`9221458`) | Context7's dispatch state comes from its scopes. Context7, Ref and Jev count settled units as usage and report uncertain operations separately. The Context7 tests fail on the previous adapter. |
| W5 | Fixed (`7c36f66`) | An answer is not stored when enrichment is limited or the search was cancelled. The test has a positive control that the answer with its reads is stored, and fails on the previous coordinator. |
| W6 | Fixed (`9787136`) | `rerank` reports the one build its batches agree on, and mixed builds are not stored. The identity is the build string, with no epoch. The alternation test fails on the previous code. |
| W7 | Fixed (`d34ed6c`) | The bridge records whether the latest POST was written, and handshake errors are contract failures. Both halves of the test fail on the previous logic, the second checked by mutation. |
| W8 | Fixed (`2022a9b`) | A line-by-line block reader replaces the backtracking regex. The scaling test takes 306 ms on the previous parser against a 100 ms bound. |
| W9 | Fixed (`46bb83e`) | The word lists no longer overlap, versions must be dotted or `v`-prefixed, hostnames are excluded and snake_case counts as a symbol. The five reported queries fail on the previous detector. |
| W10 | Fixed (`d5a50b3`) | Tests cover another host, path or query string, an unsupported method, a redirect never followed and the paid authority refusing, each with a positive control. The oversized SSE answer is covered by `55875b5`, and the endpoint test fails with the endpoint check removed. |
| W11 | Fixed (`d5a50b3`) | A read written and then stalled is UNCERTAIN, one failure, and seen once. The test fails when the written flag is forced false. |
| W12 | Fixed (`e8588ec`, `e1a2a44`) | Settlement is tested at the reported cost and at the token rate, which also exposed F1. The real classifier path through the coordinator is tested too. |
| S1 | Fixed (`b8b8d03`) | The bound is `maxBytes` exactly, and the test fails on the previous check. |
| S2 | Fixed (`c0da1fa`) | The reservation adds 64 output tokens per question at the card's output rate. |
| S3 | Fixed (`e1a2a44`) | Every outcome after settlement carries usage, and an uncertain one reports `uncertain: 1`. The test fails on the previous code. |
| S4 | Fixed (`a6a929a`) | One `connection()` helper is shared by both requests. All provider, M5, M6 and M7 suites pass, including the PostgreSQL ones. |
| S5 | Fixed (`0ca99bd`) | `enrich()` is on the Ref adapter. The coordinator decides when, bounds the time and holds the leases. |
| S6 | Fixed (`9854253`) | The read bound comes from `limits().evidence.maxDocumentBytes`, and the remaining values are named with their spec sections. |
| S7 | Fixed (`6c5ca9d`) | The log carries the code and status only, and the test asserts that the response body never appears. |
| S8 | Fixed (`48608bb`) | Tests cover the duplicate-pair question and soft grouping, and the `session_unavailable` limitation. |
| S9 | Fixed (`f209d8c`) | Positive waits poll, and the never-sent checks use a positive-control ordering, checked by mutation. The remaining sleeps measure time and say so. |
| S10 | Fixed (`225b72f`) | The timer is cleared. The test fails on the previous code because the pending timeout fires within 1.1 s. |
| S11 | Fixed (`9a6725a`) | Read keys carry the session's epoch, with the discovery session's fixed. The re-execution test fails on the previous code. |
| S12 | Fixed (`8a45a0c`) | `contextLease` checks the tools before metering. The test fails on the previous code. |
| S13 | Fixed (`fb7cb4e`) | A JSON-RPC error that was not sent is `not_sent` and released, and the verdict table is tested. |
| S14 | Fixed (`9b485e0`) | `no_candidates` gets no warning and counts as fully ranked. The test fails on the previous code. |
