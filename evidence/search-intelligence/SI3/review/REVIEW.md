## Code Review: SI3 — Native REST/MCP search and acquired evidence

### Summary

Two fresh-context reviewers read SI3's changeset (`bdf91d8..HEAD` at review time) read-only, both on `claude-opus-5-5`. DB1 (`db1-bugs-si3`, debugger lane) traced logic, runtime and integration. It read the patched upstream TypeScript from the source maps in `fcpi/firecrawl-api:m2`, in throwaway `--rm --network none --read-only` containers labelled `fcpi.transient`; none was left. CA1 (`ca1-audit-si3`, code-auditor lane) covered architecture, security, performance and test quality, and measured two performance findings with in-memory replicas that wrote no files. The two reports are merged here, with duplicates combined.

The trust boundary holds. The gateway builds the four trusted search headers itself (allowlisted names, printable values of at most 128 characters), and no inbound header passes through; the core accepts trusted identifiers only as a complete set; a failed search is a typed error and never an empty list; and an evidence failure annotates rows without failing the search.

One defect blocks acceptance. The core's evidence-payload trim loop does superlinear work on content it does not control, and it blocks the core API's event loop for seconds to minutes (CA1, measured). Eleven warnings cover timing (the core gives up on the evidence call before the retrieval service can answer), the legacy rollback profile dropping domain constraints, the Agent's auxiliary context, a deadline that restarts, a quadratic regex, drifted bounds and term rules, MCP compaction, and tests that do not reach the patched call sites.

**Scope:** 17 files and patch 0011 (+564 lines) in full.
- **Core (patch 0011):** `apps/api/src/search/fcpi.ts` (new), the v2 search controller, `executeSearch`, `search/v2`, `mergeScrapedContent`, the strict search schema and entities.
- **Gateway:** `services/access/server.mjs`, `src/upstream.mjs`, `src/validate.mjs`.
- **MCP:** `services/mcp/src/tools.mjs`.
- **Retrieval:** `src/search-intelligence/evidence.mjs`, `coordinator.mjs` (evidence route, legacy profile), `src/server.mjs` (the evidence route).
- **Playground:** `scripts/playground/agent.mjs`.
- **Verification:** `scripts/si3/native-chain.{mjs,sh}`, `patches/series.json`, and the new tests.

### 🔴 Critical Issues (Must Fix)

1. **C1 — The evidence body-trim loop does superlinear work and blocks the core API (CWE-400/CWE-407)** - `patches/0011-search-intelligence-context.patch` (`fcpi.ts` `evidencePayload`, `selectWindows`, `attachFcpiEvidence`) (CA1)
   - Problem:
     - Each iteration removes one window, then re-serializes the whole payload; its sort comparator stringifies every document's windows again.
     - Windows per document are unbounded: one per paragraph containing a query term, and the core's term list keeps stop words such as "the".
     - The loop removes the last window by position, not the lowest-priority one (spec §12 asks for lower-priority windows first).
     - The payload is built before the time check, so the work runs even with no time left.
   - Risk: a scraped search (`{query: "how to use the fetch api", limit: 10, scrapeOptions: {formats: ["markdown"]}}`) whose results include a page of about 20,000 short paragraphs containing "the" gives 6,737 windows and a 919 KB body. In the replica: one such page cost 3,093 pops and 6.5 s of synchronous CPU, two cost 45 s, three ran past 60 s. A Pi 5 is slower. The core's event loop is blocked meanwhile: every sync route, job submission, status poll and the health check stalls.
   - Fix: cap windows per document, keep each window's priority, track sizes incrementally, drop the lowest-priority window first, and check the time before building:
     ```ts
     const MAX_WINDOWS_PER_DOC = 48;
     // selectWindows: stop adding past the cap; remember each window's rank.
     // evidencePayload: measure the body once; subtract each removed window's own size;
     //   remove the lowest-priority window of the largest document until the body fits.
     // attachFcpiEvidence: return "no_time" before calling evidencePayload when too little remains.
     ```
     Add a trim-path check to the native chain: three short-paragraph documents, asserting the body fits and the build stays fast.

### 🟡 Warnings (Should Fix)

1. **W1 — The core's evidence timer always fires before the retrieval service's own budget ends** - `patches/0011-search-intelligence-context.patch` (`attachFcpiEvidence`); `services/retrieval/src/search-intelligence/evidence.mjs` (DB1)
   - Problem: the core aborts at `min(4000, D−now−250)` from its start. The retrieval service only sets its own `deadlineAt = min(now+4000, D−250)` after the body transfer, parse, validation and BM25, so a slow Jev path answers after the core has aborted. With 10 scraped documents (about 60 passages, 8 batches, 2 decision permits), anything above about 1 s per Jev call leaves every row `not_evaluated/evidence_unavailable` instead of spec §12's `deterministic_fallback` or `jev_partial`. Near the request deadline both use `D−250`, and the core loses there too. The native chain ran evidence with no Jev delay, so it never met this race.
   - Suggestion: the retrieval service finishes early enough to reply, for example `deadlineAt = min(now + evidenceMs − 500, absoluteDeadlineMs − responseMarginMs − 500)`; add a test with Jev slower than the budget that expects `deterministic_fallback`.

2. **W2 — The legacy rollback profile drops `includeDomains` and `excludeDomains`** - `services/retrieval/src/search-intelligence/coordinator.mjs` (`legacyAsInternal`) (DB1)
   - Problem: before 0011 the core compiled `site:` operators into the query the legacy route received. Now it sends only `originalQuery` plus `constraints`, and `legacyAsInternal` searches `originalQuery` alone. With `searching.profile = "legacy"`, `{query, includeDomains: ["vuejs.org"]}` returns results from any domain, which spec §9.1 forbids. The deployed profile is `aggregate`, so this waits on a rollback.
   - Suggestion: compile the constraints into the legacy query as the core did, filter the returned rows by host, and refuse publication bounds the legacy path cannot honor.

3. **W3 — The Agent drops its whole auxiliary block once four or more entries arrive** - `scripts/playground/agent.mjs` (DB1)
   - Problem: the block is skipped when its serialized size exceeds 900. Four entries of 180 characters serialize to 1,017, so the model receives none. `boundAux` allows 12; the test has one short entry.
   - Suggestion: add entries one at a time while the block fits, and test four long entries.

4. **W4 — An expired gateway deadline restarts the clock** - `patches/0011-search-intelligence-context.patch` (the controller's deadline) (DB1)
   - Problem: a trusted deadline already in the past becomes `Infinity`, and the core then uses `now + body.timeout`: a fresh full clock, which the acceptance rule forbids.
   - Suggestion: take any finite trusted deadline within 95 s as given; a past one then raises `SEARCH_TIMEOUT` at the `remaining <= 0` check.

5. **W5 — The native chain never runs the patched upstream call sites, and one of its checks cannot fail** - `scripts/si3/native-chain.mjs`; `patches/series.json` (0011's `tests`) (DB1, CA1)
   - Problem: the chain calls the `fcpi.js` exports directly. It never runs the controller's lift of the metadata into `fcpi.search`, `executeSearch` passing `fcpi` to `search()`, `mergeScrapedContent`, the zod `searchIntelligence` schema, the past-or-distant deadline header, the HTML basis of the rendition, or the `evidence_unavailable`, `cancelled`, `no_time` and `acquisition_failed` branches. Its stand-in route maps errors differently from `server.mjs`. series.json claims "REST and MCP search … through the merge". The check `bytes <= 786432` cannot fail with two 48 KiB documents (CLAUDE.md §33.3).
   - Suggestion: load the compiled `mergeScrapedContent` and `searchRequestSchema` (pure) and assert on them; exercise the deadline header and the evidence branches; give the body check an input that needs trimming; correct the series.json claim.

6. **W6 — The HTML-derived rendition's regex is quadratic on unclosed blocks (CWE-1333)** - `patches/0011-search-intelligence-context.patch` (`renditionOf`) (CA1)
   - Problem: `/<(script|style|noscript|template)[\s\S]*?<\/\1>/gi` rescans to the end for every unclosed opening tag. Measured: 5k unclosed `<style>` tags 22 ms, 20k 407 ms, 40k 1,548 ms. It runs when only `html`/`rawHtml` is requested, on attacker-controlled input up to the 25 MiB body ceiling.
   - Suggestion: a linear scan (each opening tag, then one forward search for its own closing tag; an unclosed block runs to the end), and cap the HTML before deriving text.

7. **W7 — The evidence bounds are hardcoded in the core while the policy allows tightening them, and a refusal is swallowed** - `patches/0011-search-intelligence-context.patch`; `services/retrieval/src/policy.mjs` (CA1)
   - Problem: the core's 10 documents, 48 KiB, 512 KiB and 768 KiB, its 4,000 ms cap and 250 ms margin duplicate the egress policy. `policy.mjs` permits tightening them, and `validateEvidencePayload` refuses anything over the bound. A tightened policy would make every scraped search's evidence call fail with a 400, marked `evidence_unavailable`, with no log line because the core's `catch {}` swallows it (CLAUDE.md §21, §24).
   - Suggestion: inject the bounds into the core's configuration or forbid tightening them in the policy, and log the hook's status in the catch.

8. **W8 — The core and the retrieval service extract query terms differently** - `patches/0011-search-intelligence-context.patch` (`TERMS`); `services/retrieval/src/search-intelligence/rank.mjs` (`queryTerms`) (CA1)
   - Problem: the core keeps stop words and treats `-negated` tokens as positive; the retrieval service drops stop words and skips negations. The core spends its 48 KiB per document on stop-word paragraphs before the service scores them, and the inflated window count feeds C1.
   - Suggestion: port the stop list and the negation rule into the core, with a shared check that both extract the same terms.

9. **W9 — MCP compaction never trims the evidence passages** - `services/mcp/src/tools.mjs` (`compactSearchMeta`) (CA1, DB1)
   - Problem: compaction trims `fcpi.search.passages` only. `fcpi.search.evidence.passages` (up to 6×600 characters with locators per row) is never touched, so results are halved while that optional text stays, contrary to the function's own contract and spec §19.3.
   - Suggestion: apply the same cut and omission to evidence passages, and test that metadata cuts alone can avoid dropping a result.

10. **W10 — The gateway's trusted-context builder is untested** - `services/access/server.mjs` (CA1)
    - Problem: the test covers only `forward()`'s allowlist with hand-built headers. Nothing checks that the owner header is `ownerTag(principal)`, that the deadline is now + `timeout` (default 60,000 ms), that the request id is the gateway's, or that scrape, crawl and map carry none of them.
    - Suggestion: a server-level test against a fake core that captures the headers of `/v2/search` and `/v2/scrape`.

11. **W11 — The Agent's coverage limitations are untested** - `scripts/playground/agent.mjs`; `tests/playground-agent.test.mjs` (CA1)
    - Problem: the new test uses `missing: []` and `hybrid`, so the general-missing, documentation-missing and `rrf_fallback` limitation branches never run.
    - Suggestion: a fixture with Brave skipped and Ref failed under `rrf_fallback`, asserting the three limitation strings.

### 🔵 Suggestions (Consider)

1. **S1 — HTML entities are decoded twice** - `patches/0011-search-intelligence-context.patch` (`renditionOf`) (DB1): `&amp;` is decoded before `&lt;`, so `&amp;lt;` becomes `<`. Decode `&amp;` last.
2. **S2 — Impossible dates pass the gateway and the internal contract** - `services/access/src/validate.mjs`; `services/retrieval/src/search-intelligence/contracts.mjs` (`validInstant`) (DB1, CA1): `Date.parse` accepts `2026-02-30T00:00:00Z` and `T24:00:00Z`, which the core's zod schema refuses, so the caller gets the core's message instead of the gateway's. Add a round-trip check.
3. **S3 — Evidence locators do not match MCP's rewritten markdown** - `services/mcp/src/tools.mjs` (DB1): `dropInPageLinks` and `fitDocument` rewrite `markdown`, so locators no longer index or hash what the client receives. Say so in the payload.
4. **S4 — A cancel or timeout during the body read is reported as a backend error** - `patches/0011-search-intelligence-context.patch` (`piIntelligentSearch`) (DB1): an abort during `res.json()` becomes a 502 "no results list". Check the signal and the error's name there.
5. **S5 — The core passes the retrieval service's non-failure statuses through** - `patches/0011-search-intelligence-context.patch` (DB1): a retrieval 401 from a core-token mismatch reaches REST callers as a 401, which looks like their own credentials failing. Map any answer without a typed failure to a 502.
6. **S6 — Two small Agent limitation gaps** - `scripts/playground/agent.mjs` (DB1): an `rrf_fallback/no_candidates` result adds "ranked without semantic advice", which `warningText` deliberately leaves out; the `{omitted: N}` auxiliary count is not carried to the output.
7. **S7 — An unrelated upstream type change and an untyped cast** - `patches/0011-search-intelligence-context.patch` (DB1, CA1): `WebSearchResult.highlights` changes from `string` to `string[]` with no use in SI3 and no entry in series.json; the response uses an `as any` cast.
8. **S8 — The trusted headers rest on network position** - `patches/0011-search-intelligence-context.patch` (CA1, CWE-290): any peer on `fcpi_core` or `fcpi_acquire` can assert an owner tag. Acceptable for a single owner; state it in the module and the spec.
9. **S9 — MCP's auxiliary cut leaves stale metadata and can split surrogate pairs** - `services/mcp/src/tools.mjs`; `scripts/playground/agent.mjs` (CA1): after the cut to 300 characters, `truncated.kept` still says 1500, and `slice` can split a pair. Set `kept` and cut on code points.
10. **S10 — The cancellation comment claims more than the code does** - `patches/0011-search-intelligence-context.patch` (CA1): it says acquisitions' waiting is cancelled; the signal reaches only the search call and the evidence call.
11. **S11 — The native chain's transient container is less hardened than its siblings** - `scripts/si3/native-chain.sh` (CA1): no `--cap-drop ALL`, `--security-opt no-new-privileges`, explicit `--user` or memory and pids limits (CLAUDE.md §33.1).
12. **S12 — A misleading variable name** - `patches/0011-search-intelligence-context.patch` (CA1): `own` holds the gateway's deadline header.

### ✅ Good Practices

- The gateway builds the core's search headers from scratch; only four allowlisted names with printable-ASCII values of at most 128 characters pass, and the tests include spoofed inbound, CRLF-key and `authorization` cases.
- The core accepts trusted identifiers only as a complete, well-formed set; anything else is attributed to `legacy-internal`, never to a made-up user.
- A failed search is a typed `PiSearchError`, never an empty list, and 0007's rule that typed failures pass through `search()` is kept.
- Evidence windows are validated as exact substrings, in order and non-overlapping; the core cuts on code-point boundaries and its byte caps match the policy.
- An evidence failure only annotates rows; evidence runs only after a scrape the request asked for, so link-only searches stay link-only.
- Jev receives passages as state, never as instructions, and its answers are type-checked; no content is logged.
- The Agent labels auxiliary context as uncitable, still verifies every quotation against its page, and returns the entries whole.
- The upstream divergence lives in one new module behind small call-site hooks, and series.json's coverage rows match.

### Verdict

[x] ❌ Request Changes (critical issues)
[ ] ⚠️ Approve with Suggestions
[ ] ✅ Approve

### Finding dispositions

Filled by `/address`. Each finding is fixed (with its commit), rejected (with evidence) or deferred (with the later milestone that owns it and why).

| Finding | Outcome | Evidence |
|---|---|---|
| C1 | Fixed (`14326c8`) | Windows are capped at 48 a document; terms follow the retrieval service's rule; the trim removes the largest document's lowest-priority window with sizes tracked incrementally, after the time check. The native chain's trim-path and hostile-paragraph checks pass on the new image and fail on the previous patch's (`native-chain-after-address.txt`, `native-chain-previous-patch.txt`). |
| W1 | Fixed (`87d64d8`, `14326c8`) | The core sends `evidenceDeadlineMs`, and Jev's advice ends 300 ms before it. A retrieval test with Jev four seconds slow returns deterministic passages inside a 1.5 s core budget; the chain checks the core sends the deadline. |
| W2 | Fixed (`6c2c8a5`) | The legacy profile compiles bare `site:` operators, filters rows by host, refuses strict publication bounds and names an ignored freshness hint. The test fails on the previous coordinator. |
| W3 | Fixed (`a1ce631`) | Auxiliary entries are added one at a time while the block fits; with four 180-character entries, three reach the prompt. The test fails on the previous Agent. |
| W4 | Fixed (`14326c8`) | A past trusted deadline is kept, so the search times out unsent; a distant one is ignored for the request's own (chain check `trusted_deadline_never_restarts`, which fails on the previous patch). |
| W5 | Fixed (`14326c8`, `3a5f87e`) | The chain runs the compiled `mergeScrapedContent` and `searchRequestSchema`, the deadline header cases, the evidence branches, a trim path that can fail, and the server's own failure table (`src/failures.mjs`). `series.json` states what the chain runs and what it does not: the controller's header parsing and `executeSearch` need the full core. |
| W6 | Fixed (`14326c8`) | The rendition scans forward once for each block's closing tag, strips tags with a pattern that stops at the next `<`, and reads at most 2 MiB. The chain measures 40,000 unclosed `<style>` tags and 200,000 stray `<` well under 500 ms; the check fails on the previous patch. |
| W7 | Fixed (`bedd364`, `14326c8`) | The policy pins the evidence bounds the core builds to (a tighter value is refused at load, tested), and the core logs a refused evidence call by status. |
| W8 | Fixed (`14326c8`) | The core's `queryTerms` is the retrieval service's rule; the chain compares the two over the frozen corpus's 120 queries (the core keeps at most 32 terms). |
| W9 | Fixed (`231afac`) | Evidence passage text is cut after passage text and omitted last, each counted; with ten heavy rows all ten results stay. The tests fail on the previous MCP tools. |
| W10 | Fixed (`2924231`) | The builder moves to `src/search-context.mjs` and takes the route. The test checks each header's value, the 60 s default, a fresh search id, no principal name, and no headers on scrape, crawl, map, batch or extract. It runs at unit level, since the gateway's server-level suites run on the Pi. |
| W11 | Fixed (`a1ce631`) | A test with Brave skipped and Ref failed under `rrf_fallback` asserts the three limitation strings. |
| S1 | Fixed (`14326c8`) | `&amp;` is decoded last; the chain checks `&amp;lt;` stays `&lt;`. |
| S2 | Fixed (`e961aa3`) | The gateway and the internal contract require an instant to read back as written; four impossible instants are refused and a leap day accepted. Both tests fail on the previous validators. |
| S3 | Fixed (`231afac`) | A row whose markdown the answer rewrote carries `evidence.locatorBasis: "core_rendition"`; an untouched row does not. |
| S4 | Fixed (`14326c8`) | A cancelled or expired body read is CANCELLED or SEARCH_TIMEOUT (chain check `answer_mapping`). |
| S5 | Fixed (`14326c8`) | An answer without a typed failure becomes a 502 SEARCH_BACKEND_ERROR (chain check `answer_mapping`, which fails on the previous patch). |
| S6 | Fixed (`a1ce631`) | `no_candidates` adds no ranking limitation, and the omitted count reaches the output as `auxiliaryOmitted`. |
| S7 | Fixed (`14326c8`) | `highlights` is back to upstream's `string`, and the cast is gone: `SearchResponse` declares `fcpi`. The image compiles. |
| S8 | Fixed (`14326c8`, `2ecdc84`) | The module comment and the feature spec's §20 state that the headers rest on network position, and name the HMAC a deployment with untrusted peers would need. |
| S9 | Fixed (`231afac`, `a1ce631`) | MCP and the Agent cut on code points; a cut auxiliary text records `kept`. Both are tested with emoji at the cut. |
| S10 | Fixed (`14326c8`) | The controller's comment now says cancellation reaches the search call and the evidence call, and that queued acquisitions keep their own lifetime. |
| S11 | Fixed (`14326c8`) | The chain's container runs with `--cap-drop ALL`, `no-new-privileges`, uid 65534, 1 GiB of memory and 256 processes. |
| S12 | Fixed (`14326c8`) | `own` is renamed `gatewayHeaderMs`. |

After remediation: retrieval 467 of 467 with PostgreSQL (no skips; first recorded as 471, a miscount that a rerun of `2ecdc84` corrected), gateway 101, MCP 51, root 61; the native chain passes 25 of 25 on image `b0f561ce…` at `14326c8`.
