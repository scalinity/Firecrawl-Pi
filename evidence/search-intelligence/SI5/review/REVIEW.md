## Code Review: SI5 — Evaluation, corpus collection and live contract

### Summary
`/review-2` on the SI5 commits (`03a76bb..65ec1b9`): the corpus collector, the judged pool, the capture, the blind packets, the labels and the score (`scripts/si5/`), the three adapter fixes, the degraded matrix (`services/retrieval/test/si-degraded.test.mjs`) and the committed records under `evidence/search-intelligence/SI5/`, read-only, while the collection was running. Both agents ran on Opus 5.5 (DB1, bugs; CA1, architecture, quality, security and data integrity). Their findings are merged below, with each source named; a finding both raised is listed once.

The replay design held: replays cannot dispatch discovery, every committed run was at one clean commit, every internal top 20 extended its public answer. The defects were in what the evaluation would conclude from that data: Q03 credited every profile with documentation excerpts only D received, the bootstrap's generator cycled, held-out queries could drop silently, and the collection shared the database the retrieval suites truncate. Several transient failures became permanent unjudged data, and the D-Ref replay could send a live Ref search.

### 🔴 Critical Issues (Must Fix)
1. **Q03 credits excerpts by URL, not by the lanes that delivered them, and never shows D's documentation passages** (DB1 C1, CA1 W6) - `scripts/si5/packets.mjs:36-39,58`, `scripts/si5/labels.mjs:109`, `scripts/si5/score.mjs:54,61,117,122`
   - Problem: packets merged every lane's text per URL, unattributed; a requirement supported by a Context7 or Ref excerpt was credited to every profile listing the URL, so C (documentation off) got D's documentation evidence. D's own Context7 snippets and Ref reads never reached a packet at all.
   - Risk: 12 queries had 14 URLs in C's top 10 that Context7 or Ref also returned; D − C coverage comes out low, so Q03 can fail when it should pass.
   - Fix: keep each excerpt line's lanes in the private keys, credit an excerpt only to a profile whose lanes delivered it, and judge D's documentation passages (or gate Q03 on page-only coverage).
2. **The collection and the live smoke share the database the retrieval suites truncate and drop** (CA1 C1) - `scripts/si5/collect.mjs:93-104,193-201,225`, `scripts/si5/live-smoke.mjs:86-97`
   - Problem: the collection's admission, ledger, availability and cache lived in FCPI_TEST_PG's `postgres` database, which `si-store.test.mjs` truncates and drops.
   - Risk: observed: a suite run wrote fixture ledger rows into Q048's and Q052's records. Possible: a truncation resets the hourly admission and the caps, drops a query's ledger, or fails D mid-search, and a failed run is never redone.
   - Fix: give the collection and the smoke their own databases; record the database in each run.

### 🟡 Warnings (Should Fix)
1. **The bootstrap's generator is degenerate, and the relative-improvement interval is missing** (DB1 W1, CA1 W1) - `score.mjs:85-86,115-116`: `seed * 1103515245` exceeds double precision; the state cycles after about 10,466 draws, so 10,000 resamples recycle it; Q01 is gated on a relative improvement with no interval and no `excludesZero`.
2. **Held-out queries are dropped silently** (DB1 W2) - `score.mjs:32`: an uncollected or unlabelled query leaves every mean and gate unlisted.
3. **Coverage counts support from documents that should not supply it** (DB1 W3) - `score.mjs:54`: documents graded 0, nulled as unverified, or of a mismatched version supply requirements.
4. **Labels accept any grade value** (DB1 W4) - `labels.mjs:98-100`: 4, 2.5 or "3" flow into `2 ** g - 1`.
5. **Judgment records carry no capture or packet-file hash, and packets are rewritten** (DB1 W5, CA1 W7) - `labels.mjs:110`, `packets.mjs`: `final` can check a passage against a file the judge never saw.
6. **The second judge's sample never rechecks the first judge's nulls** (DB1 W6) - `labels.mjs:57`.
7. **The D-Ref replay can dispatch a live Ref search and reads** (DB1 W7) - `collect.mjs:143,251`, `ref.mjs:276-283`, `coordinator.mjs:315-325`: a replayed Ref discovery has no lease, so a documentation-required query's enrichment opens a fresh live session outside the admission; Q105, Q111 and Q117 were still to come.
8. **Replay lanes are checked against live availability and breakers before the held answer, and the checks are not enforced** (DB1 W8, CA1 W12) - `coordinator.mjs:112-118`: a provider D's later calls held is skipped in a replay, recorded as `rate_limited` or `breaker_open`, not as a miss; pool and score read neither `replayMisses` nor `top20MatchesPublic`.
9. **The frozen manifest has gaps, and no consumer checks a run's commit** (DB1 W9, CA1 W2) - `collect.mjs:52-53,78-91,225`: the collector, the retrieval lockfile and the schema are not hashed; `--only` trials skip the freeze and write into `runs/`, which a full run then adopts.
10. **A scores 0 when its acquisition is missing** (DB1 W10) - `collect.mjs:264`, `score.mjs:37,52`.
11. **Capture turns transient failures into permanent ones** (DB1 W11, CA1 W9) - `capture.mjs:33,58-70,79-88`: a forwarder 503, a rate limit, a cooldown or a job still running all wrote final capture files, never retried.
12. **The capture's direct-allowance guard fails open** (DB1 W12) - `capture.mjs:38-39,47`: psql without `ON_ERROR_STOP` prints nothing on an SQL error, read as 0 used.
13. **Ref's hosted parsing has two holes** (DB1 W13, CA1 W4) - `ref.mjs:31,59-65,84-90`: the refusal check runs before the structural parse, so a breadcrumb such as `unauthorized-errors > handling` becomes `auth_failed`; any two-line text ending in a URL is a result, so an unrecognised refusal with a link settles as a billed answer.
14. **The degraded matrix is short of spec §23.3** (DB1 W14, CA1 W8) - `si-degraded.test.mjs`: no circuit-open cell for Context7 or Ref, no cancellation of Context7, Ref or Jev alone, no Serper allocation cell, no valid-empty-among-every-failure cell with documentation active, no Context7 429 with a past or absent reset.
15. **The committed live smoke does not establish what it claims** (CA1 W3) - `live-smoke.mjs`, `SI5/live-smoke.json`: no Ref read was ever exercised live, the record names no commit (and predates the Brave and Context7 fixes), and the script cannot fail.
16. **Judges are isolated by instruction only, and their free text reaches the public labels unchecked** (CA1 W5) - `packets.mjs:17`, `judge-prompt.md:5-7`, `labels.mjs:110-111` (CWE-1427, CWE-538).
17. **Judgment provenance falls short of §23.1** (CA1 W7) - `labels.mjs:54-69,86-87,110-113`: prompt hashes taken at `final` from working files; `judges.json` written by nothing; no passage locator or label revision; `second` can sample a partial round.
18. **Key copies survive an interrupted run** (CA1 W10; DB1 suggestion) - `collect.mjs:61-64`, `live-smoke.mjs:46-47,174-177` (CWE-459): cleanup runs only on `exit`, which a default SIGINT or SIGTERM skips.
19. **Packets tell the judge the expected outcome** (CA1 W11; DB1 suggestion) - `packets.mjs:49`: `expectNoMatch` is not an evaluator input in §23.1.

### 🔵 Suggestions (Consider)
1. **Deduplicate canonical URLs within a ranked list before scoring** (DB1).
2. **`ledgerDelta` counts an earlier query's state changes against this one** (DB1) - `collect.mjs:197-201`.
3. **`hostedBlockOf` cuts a `page='…'` value at an apostrophe, and a breadcrumb title at its first dot** (DB1) - `ref.mjs:236`.
4. **`eligibleFive` means "all five answered", not "all five could represent the query"** (DB1) - `score.mjs:48`.
5. **Context7 reads an empty `ratelimit-remaining` header as 0** (DB1).
6. **A shared harness for live-smoke.mjs and collect.mjs** (CA1): about 50 duplicated lines that already differ.
7. **Allowlist the sanitizers** (CA1) - `collect.mjs:206-207`: auxiliary entries would keep Context7 breadcrumbs (latent: 0 entries).
8. **Committed run records carry titles while the header says provider text appears only as hashes** (CA1).
9. **Bound reported resets to a plausible window** (CA1) - `context7.mjs:58`, `availability.mjs:47` (CWE-20).
10. **Record the Pi's month-to-date spend beside the workstation collection's** (CA1): the two ledgers bound separately what are presumably the same accounts.
11. **Record the capture's client identity and the platform's residential and enhanced spend** (CA1).
12. **State the bulk-threshold decision** (CA1): 2,637 distinct URLs delivered as 25-page jobs, under the 5,000-a-day allowance.
13. **Report a condensed nDCG** (CA1), unjudged documents dropped, as a sensitivity check.
14. **Cap or normalize excerpt multiplicity and Context7's library-id titles** (CA1): both can signal the provider.
15. **Commit capture-loop.sh** (CA1).
16. **Export the cache-key prefixes from coordinator.mjs** (CA1) rather than matching them as strings in the replay stores.
17. **[PRE-EXISTING] A provider-cache hit drops the lane's kind** (CA1) - `coordinator.mjs:70`.
18. **live-smoke.mjs is mode 644 with no shebang** (CA1).

### ✅ Good Practices
- Replays are fed from memory through a wrapper that fails a missing answer and counts it; the committed runs show zero misses and every top 20 matching its public first ten, which `collect.mjs` checks rather than assumes.
- `selectFinal` is greedy with a stable prefix, so an internal top 20 extends the public top 10.
- The frozen manifest was written before any label; a changed ranking file is refused on restart; a full collection refuses a dirty tree.
- Every written record is refused if a credential value appears in it; partition keys are redacted and bodies recorded as shapes only.
- A grade whose cited passage is not in the document becomes unjudged, never 0; packet ids are random, order shuffled, keys kept apart.
- The Brave and Context7 fixes are narrow, carry live-shaped tests, and fail safe.

### Verdict
[x] ❌ Request Changes (critical issues)
[ ] ⚠️ Approve with Suggestions
[ ] ✅ Approve

### Finding dispositions

The collector was paused after Q098, in its pacing sleep, so W7, W8, W9, C2 and W18 could land before the documentation-required queries Q105, Q111 and Q117. The fixes went on a branch from the frozen commit (`fe923a7`), because HEAD's retrieval code had moved since the freeze and the restart check rightly refuses it; `frozen.json` records the revision from Q099 with its reason, and the branch is merged (`aff463d`). Across all 120 runs: 0 replay misses, 0 divergences, 0 unreplayed reads, every top 20 extending its public answer, A acquired every time.

| Finding | Outcome | Evidence |
|---|---|---|
| C1 | Fixed (`9aeb071`, `2ae4006`, `91abb65`, `882ad63`) | The packet keys hold each excerpt line's lanes and each file's hash; `final` credits an excerpt passage to the lanes whose lines hold it (all 1,255 excerpt passages so far resolve); the score credits it only to a profile whose own lanes delivered it. D's documentation passages are judged in a passage round (`packets.mjs --passages`, `passages-prompt.md`), and Q03 is NOT_MEASURED until every top-10 document carrying one is judged. |
| C2 | Fixed (`fe923a7`, `c054c5d`, `91abb65`) | The collection moved to its own database `fcpi_si5_eval`, created as a copy of the shared one after Q098 (identical row counts and last reservation), and every later run records it; the smoke uses `fcpi_si5_smoke`. The score drops and counts fixture ledger rows. Q048's and Q052's fixture rows are a recorded limitation of their ledgers only: D succeeded in both, and no run shows a lost ledger or a database-caused failure (the six partial D runs are DeepSeek's `unsupported_request`). |
| W1 | Fixed (`91abb65`) | An exact mod-2^31 LCG (`Math.imul`), no repeat within 2,000,000 draws; Q01's relative improvement has its own paired interval; every interval reports `excludesZero`. |
| W2 | Fixed (`91abb65`) | Every held-out query is scored or listed with its reason; a gate is NOT_MEASURED unless all 96 are scored. |
| W3 | Fixed (`91abb65`) | Only a document graded 1 or more and not of a mismatched version supplies a requirement. |
| W4 | Fixed (`2ae4006`) | A grade outside 0–3 or null is no grade (counted as `invalidGrades`); a mismatched version is capped at 1. |
| W5 | Fixed (`9aeb071`, `2ae4006`) | A built packet is never rewritten; the keys hold each document file's and capture's hash; `final` leaves a label unverifiable when its file differs. |
| W6 | Fixed (`2ae4006`) | The sample is drawn over all first-round documents, unjudged ones included. |
| W7 | Fixed (`fe923a7`) | A replayed adapter enriches with no lease and no admission: what it would read is recorded and nothing is sent (checked with stubs that throw on any dispatch). Landed before Q105, Q111 and Q117; no run in 120 has an unreplayed read. |
| W8 | Fixed (`fe923a7`, `91abb65`) | Replays are admitted whatever D's later calls did to availability or breakers; a lane that still did not take D's answer is a recorded divergence; any miss, divergence or top-20 mismatch makes the gates it touches NOT_MEASURED. |
| W9 | Fixed (`fe923a7`, `2bf847c`, `91abb65`) | The collector, lockfile and schema are recorded per collector revision (the freeze's own from its commit); a restart on another commit needs a reason; trials write to `eval/trials/`; pool and score refuse a run from an unrecorded commit or a dirty tree. |
| W10 | Fixed (`91abb65`) | A with no acquisition is left out of A's figures and Q01 and listed (none in the 120 runs). |
| W11 | Fixed (`337a1e6`) | A non-200 page read is retried; only definitive outcomes are written; a URL the job never answered is retried in a later pass; the next batch waits for the job to end. |
| W12 | Fixed (`337a1e6`) | `ON_ERROR_STOP=1` and a whole-number check; anything else is NaN and fails closed. |
| W13 | Fixed (`7a62351`) | A block is tried as a result first, and a hosted block needs the `page=`/`section=` or breadcrumb shape; the two-line notice fails closed as a contract failure and the breadcrumb is a result, both tested. |
| W14 | Fixed (`15e66dc`, `5f4f1fe`, `a1439a5`) | Each named cell is now a test; the Context7 429 test covers a past, absent, empty and out-of-range reset; the matrix run is recorded (9 of 9 at a clean tree). |
| W15 | Fixed (`c054c5d`, `3a25606`, `a3cdf7c`) | The smoke adds one explicit Ref search and read and exits 4 listing any gap. Its first run failed on a gap: since SI4's `4b3524c`, telemetry refuses to start without a fingerprint key and the smoke passed none, which the old smoke would have recorded silently. Rerun at `3a25606`: every integration settled, including the first live Ref read (2,040 characters, one credit). |
| W16 | Fixed in part (`2ae4006`, `a060358`); in part rejected | The free text stays private, `labels.json` carries its hashes, and neither may hold a credential value. Isolation is now checked rather than assumed: `judges.mjs` reads every judge's own transcript and flags any reference that could unblind it. That found four first-round judges (Q061, Q064, Q050, Q067) opening `judgments/first/Q001.json` to check the output shape; each was judged again with the original kept as superseded, and every later launch states the rule. Rejected: moving the packets outside the repository mid-round would change the paths judges were given, and a Read/Write-only agent could still open sibling files; the per-judge audit is the stronger check. |
| W17 | Fixed (`2ae4006`) | `judges.json` is written from the transcripts: model, the prompt each judge was shown (rebuilt from its Read and compared with the file), timing; `final` refuses a changed prompt or an uncontained judge; each row carries its file and capture hashes, the passage offset, and the labels script's hash; `second` refuses until every collected held-out query has a first judgment and records the hash of each first-judgment file. |
| W18 | Fixed (`fe923a7`, `c054c5d`) | SIGINT, SIGTERM and SIGHUP exit through the cleanup handler. The collector's own pause, by SIGTERM before this fix, left one key directory, removed at once. |
| W19 | Fixed (`9aeb071`) | The field is gone; Q117's and Q119's packets, the two it marked, were built after the change, so no judge saw it set. |
| S1 | Fixed (`91abb65`) | A ranked list counts a repeated canonical URL once, at its first rank. |
| S2 | Fixed (`fe923a7`) | From Q099 each query's ledger is the reservations created during it, in their state at its end (`ledgerBasis`); earlier runs are labelled `table_delta`. |
| S3 | Fixed (`7a62351`) | Tested with an apostrophe in `page='…'` and a dotted breadcrumb. |
| S4 | Fixed (`91abb65`) | The subset is the queries every general engine could represent (no `unsupported_request` or `not_configured` skip). |
| S5 | Fixed (`5f4f1fe`) | Only whole-number headers count. |
| S6 | Rejected | `collect.mjs` is the record of the collection that ran (`fe923a7`, merged unchanged); refactoring it now would make HEAD's collector differ from the one the runs name. Both scripts now carry the same C2 and W18 fixes. |
| S7 | Fixed (`fe923a7`) | Auxiliary entries are recorded as provider, kind and text hash only (0 in the 120 runs). |
| S8 | Fixed (`fe923a7`) | The header states that titles and URLs, which identify each document, are kept. |
| S9 | Fixed (`5f4f1fe`) | A reset is believed only within 35 days, for Context7 and Brave. |
| S10 | Open: recorded with SI5's acceptance | The Pi's month-to-date search and paid spend is read (read-only) and recorded beside the collection's in `ACCEPTANCE.md`. |
| S11 | Open: recorded with SI5's acceptance | The capture's client and the platform's residential and enhanced spend are recorded in `ACCEPTANCE.md`. |
| S12 | Open: recorded with SI5's acceptance | The decision is stated in `ACCEPTANCE.md`. |
| S13 | Fixed (`91abb65`) | `ndcg10Condensed` in every table. |
| S14 | Rejected | Every packet of the round was built with the same excerpt text, and the judged ones cannot be rewritten (W5); changing the rest would judge two packet formats in one round. Recorded as a limitation in `ACCEPTANCE.md`. |
| S15 | Fixed (`46c1941`) | Committed as run, resolving the repository from its own location. |
| S16 | Rejected | The collector is the record of the run (see S6). A prefix drift would show as a replay miss, and all 120 runs show none. |
| S17 | Fixed (`683996e`) | A cache hit keeps its lane's kind; the cached Ref test checks the lane event's operation, and fails without the fix. |
| S18 | Fixed (`c054c5d`) | Mode 755 with a shebang. |
