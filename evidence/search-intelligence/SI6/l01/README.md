# L01: measured performance on the Pi

Spec §25's criterion L01: named single-active-search cold link-only Pi scenarios meet p95 ≤ 23 seconds; request deadline boundaries remain respected; no resource leak, post-cancel send, OOM or unbounded fan-out appears in targeted exercises; live measurements and injected failures are labeled separately. This directory holds the drivers and analyses, `../raw/` the raw observations.

## What ran on which image

| Measurement | Where | Release | Retrieval image | Raw record | Analysis |
|---|---|---|---|---|---|
| Live searches, 84 in one paced run | the deployed platform on the Pi, through the gateway's loopback publication | second (candidate `20d972934c7c`, deployed `587e1236822d`) | `d13b5a9b0a53` | `raw/l01-live.jsonl` | `live-summary.json` |
| Fixture stalls, four at once, cancellation | a throwaway container on the Pi from the same image | second | `d13b5a9b0a53` | `raw/l01-fixture.jsonl` | `fixture-summary.json` |
| The same fixture scenarios, before the cancellation fix | the first release's image | first (candidate `e83cabd20c77`) | `9a68963492ad` | `raw/release-1/l01-fixture-run1.jsonl`, `run2.jsonl` | the cancellation survivors in them |
| Ref replay of five queries | the deployed platform | third (candidate `5e035b212302`, deployed `4b1c11e555aa`) | `1cb9b68bc4d2` | `raw/live-ref-replay.jsonl` | below |
| Live documentation scenario again, 30 cold searches with each row's URL recorded | the deployed platform | fourth (candidate `ad767a743ea9`, deployed `d68ed054dde9`) | `ea6aac99572f` | `raw/release-4/l01-live-docs.jsonl` | `release-4/live-docs-summary.json`, `release-4/f03-live-summary.json` |
| The same scenario on the fifth release | the deployed platform | fifth (candidate `2c9b62929e82`, deployed `54bb6b1dbeba`) | `0b3ab03a26a3` | `raw/release-5/l01-live-docs.jsonl` | `release-5/live-docs-summary.json`, `release-5/f03-live-summary.json` |
| The same scenario on the sixth, final release | the deployed platform | sixth (candidate `ecb8733335d2`, deployed `352fad56db01`) | `62e06882e333` | `raw/l01-live-docs.jsonl` | `live-docs-summary.json`, `f03-live-summary.json` |

The third release differs from the second only in `adapters/ref.mjs` (and its test): `git diff 20d9729 5e035b2 -- services`. The link-only latency, the fixtures and the cancellation behaviour do not depend on it, so they were not repeated on the later releases; the later patches change candidate preparation (the exact-version rule, which does nothing for a request with no hard version, as in every link-only and fixture scenario measured), the Ref parser (not called when documentation is off) and a verifier. The sixth release's own documentation run below is the measurement on the final image.

## Live (labelled live)

One search active at a time except `concurrent4_live`, one search every 62 seconds to stay under the platform's own 60-an-hour admission (no admission wait occurred). The deployed policy's timings, the real providers, the Pi's real memory.

| Scenario | Searches | Cold | p50 | p95 | max | Over 23 s | Over the 60 s deadline |
|---|---|---|---|---|---|---|---|
| `cold_link_only` (documentation off) | 30 | 30 | 7,357 ms | 8,706 ms | 9,692 ms | 0 | 0 |
| `cold_docs` (documentation on) | 30 | 30 | 7,456 ms | 11,777 ms | 11,840 ms | 0 | 0 |
| `concurrent4_live` (two rounds of four at once) | 8 | 8 | 6,126 ms | 7,699 ms | 7,699 ms | 0 | 0 |
| `activation_repeat` (limit varied), the 3 cold ones | 16 | 3 | 6,797 ms | 7,369 ms | 7,369 ms | 0 | 0 |

The other 13 `activation_repeat` searches were served in part from cache (the decision and lane caches), so they are not cold timings; over all 16 the p50 is 3,117 ms and the p95 and max 9,176 ms.

L01's named scenario is the first row: p95 8.7 s against the 23 s target. All 84 searches answered HTTP 200. Link-only outcomes: 29 complete, 1 partial (DeepSeek could not represent the query; its warning is attributed). The documentation scenario is slower at its tail because Context7 and Ref are held to a 10-second task budget (spec §694), and 5 Context7 calls ran out of it.

**Memory.** 426 samples of the stack's containers (docker stats) and the host, every 10 seconds, across the run: peak resident firecrawl-core 1,757 MiB, rabbitmq 125, searxng 100, nuq-postgres 97, browser-worker 86, retrieval-service 62, mcp-gateway 54, access-gateway 39, redis 12. The host's available memory never fell below 4,711 MiB.

## The documentation scenario again, on the later releases (labelled live)

The acceptance review asked for the 30 cold documentation searches to be rerun on the final image, since the first run met Ref's parser defect in 10 of them. It was run on the fourth release (the exact-version rule for the engines' rows, a lone-notice guard in Ref's parser), the fifth (after the second review found the rule's library tie too loose, documentation candidates unchecked and the notice guard too coarse) and the sixth, the final one (after the third review found the tie still tying sub-products, other repositories of an organisation and same-named packages, and the notice phrases over- and under-matching). Same plan (`plan-docs.json`, the `cold_docs` items of `plan.json`), one search every 62 seconds, no admission wait; every search records its row URLs.

| Scenario | Searches | Cold | p50 | p95 | max | Over 23 s | Outcomes |
|---|---|---|---|---|---|---|---|
| `cold_docs`, fourth release (`ea6aac99572f`; `release-4/`) | 30 | 30 | 8,016 ms | 12,094 ms | 13,025 ms | 0 | 24 complete, 6 partial |
| `cold_docs`, fifth release (`0b3ab03a26a3`; `release-5/`) | 30 | 30 | 8,484 ms | 13,929 ms | 14,101 ms | 0 | 21 complete, 9 partial |
| `cold_docs`, sixth release (`62e06882e333`; `raw/l01-live-docs.jsonl`) | 30 | 30 | 8,021 ms | 12,371 ms | 12,525 ms | 0 | 24 complete, 6 partial |

The images ran: the fourth release (candidate `ad767a743ea9`, deployed `d68ed054dde9`), the fifth (candidate `2c9b62929e82`, deployed `54bb6b1dbeba`) and the sixth (candidate `ecb8733335d2`, deployed `352fad56db01`). Analyses: `live-docs-summary.json` and `f03-live-summary.json` for the sixth, the same names under `release-5/` and `release-4/` for the others.

- **Ref (sixth release):** no notice, contract or availability warning in the 30 searches; two `ref_timeout` (Ref past its 10 s budget, a provider-tail event). The second release's run had `ref_contract_failure` in 10 of 30; the fourth and fifth had none. The partials are those two, one Context7 timeout (6 on the fifth release, 2 on the fourth, 5 on the second: the provider's tail varies by the hour), and DeepSeek not representing 3 queries; `exact_version_unconfirmed` appears on 4 hard-version searches.
- **Memory (sixth release):** 149 samples; the host's available memory never fell below 4,747 MiB; peaks core 1,903 MiB, retrieval 71 MiB.
- **Exact versions (F03), the 16 held-out hard library@version queries, 160 returned rows each.** Each returned URL is looked up in the judged labels of the collection (the live providers return pages the judges did not see: 28 of the 160 on the sixth release were never judged, 19 are unknown). Sixth release: **13 rows judged a version mismatch**, 99 a match, 1 not applicable; the search counted 21 rows confirmed (by a scope or by a URL that states the release), 139 unverified, and removed 90 candidates before ranking; the version verdicts were 12 confirmed and 4 unconfirmed. Fifth release: 16 judged mismatches, 21 confirmed, 139 unverified, 88 removed. Fourth release: 17, 23, 137, 91. The collection's D top 10 held 20 judged mismatches. **Rows the shipped rule itself calls another release's page and that still reached an answer: 0 on the fifth and sixth releases, 1 on the fourth** (`docs.python.org/3.4/whatsnew/index.html` for Python 4.0, a documentation row the fourth release's rule left to a scope that stated nothing).
- **What remains in the answers.** The 13 judged-mismatch rows of the sixth release are of two kinds no URL rule can know: 5 name a moving head (`/docs/current/`, a `main` branch file, `/providers/hashicorp/aws/latest/` three times) and 8 state no release the rule accepts (a blog, a mirror, `webpack.js.org/plugins/…` and `docs.webpack.js.org/…` for a webpack 4 request in 6 rows, and two under a bare major, `/3/` and `/2/`, which the rule ignores because a lone number is too often an id). Where URLs do state versions the rule bites: Q117 (Python 4.0, a version that does not exist) went from 8 judged mismatches in the collection to 1, with 42 candidates removed. The live sample differs from the collection's (rows never judged, pages that change by the day), so the live rows cannot show a net fall in the mismatch share; the offline measure on the collection's own rows is in `SI5/acceptance/version-rule-measure.json`.
- **F03 is accepted by the owner on the narrower reading (2026-10-20)**: zero version mismatches among the rows an output reports as version-confirmed (spec §25). It fails on the plain reading, that no returned row is judged another release: the engines are version-blind, and unverified rows are counted and warned (`version_rows_unverified`), not removed. On the sixth release none of the 13 judged mismatches was confirmed by its URL, and at most one could have been confirmed by a documentation scope, which the run's record cannot settle row by row (`analyze-narrow-reading.mjs`, `narrow-reading-summary.json`).

## Fixture (labelled injected failures)

A throwaway container (no network but loopback, read-only root, the service's uid, label `fcpi.transient`), the release's coordinator, adapters and policy timings, loopback provider fixtures. These exercise the search coordinator, the adapters and the shared dispatch, not the path through the gateway and the core, and "0 reservations left" reads the fixture's in-memory ledger, not PostgreSQL. Timings here are fixture timings. The container is removed and the run records no transient container left.

| Scenario | n | p50 | p95 | max | Notes |
|---|---|---|---|---|---|
| baseline | 30 | 198 ms | 204 ms | 208 ms | all complete, hybrid ranking |
| discovery provider stalled, one harness (the breaker opens after three failures) | 30 | 199 ms | 10,015 ms | 10,015 ms | the first searches pay the 10 s timeout, the rest skip the open breaker; all partial |
| discovery provider stalled, a fresh harness each | 30 | 10,014 ms | 10,018 ms | 10,021 ms | every search meets the stall with its breaker closed; all partial |
| Jev stalled, one harness | 30 | 200 ms | 8,012 ms | 8,013 ms | 2 `jev_timeout`, 28 `jev_breaker_open`; deterministic ranking, all complete |
| Jev stalled, a fresh harness each | 30 | 8,010 ms | 8,012 ms | 8,013 ms | 30 `jev_timeout`; all complete |
| four at once, eight rounds | 32 | 400 ms | 802 ms | 803 ms | all complete |
| cancellation: four at once with Jev stalled, two cancelled at 1.5 s, four rounds | 16 | | | | the 8 cancelled threw `CANCELLED`; the 8 survivors completed after Jev's own 8 s timeout (8,032 to 8,043 ms, `jev_timeout`); 0 reservations left `RESERVED` |

No search passed the 60-second request deadline in any scenario. The fixture process's peak resident memory was 110 MiB (cgroup peak 73 MiB) and the host's available memory stayed between 4,875 and 5,055 MiB.

## A defect the cancellation scenario found

On the first release's image the cancellation survivors finished at 1.5 s with `rrf_fallback/jev_breaker_open`, where Jev's own timeout would have taken 8 s. A request cancelled after it was written ended as `PROVIDER_UNCERTAIN`, which the shared dispatch classified as `temporarily_unavailable` and counted against the provider's breaker (policy: 3 failures in 60 s open it for 300 s). A few cancelled searches would have taken Brave, Exa, DeepSeek, Tavily, Context7 or Jev out of every search for five minutes. Fixed in `20d9729`; the regression test fails on the unfixed code (`si-degraded.test.mjs`, "a search cancelled while its providers are answering opens no breaker"). The record of the unfixed run is `raw/release-1/l01-fixture-run2.jsonl`; the fixed run's survivors are in `raw/l01-fixture.jsonl`.

## A defect the live documentation scenario found

Ref's lane failed with `ref_contract_failure` in 10 of the 30 documentation searches and 9 of the 16 activation repeats: 5 were Ref answers the parser refused, and 14 were searches that skipped Ref while it was on a contract hold. Replaying one of them by hand showed Ref's results arriving as `owner/repo - entire-document` blocks and prose summaries, each followed by the URL alone on the last line, none carrying the `page='…'`/`section='…'` or breadcrumb marker the parser required. A search whose blocks were all of that kind was refused as `ref_unrecognized_text`, three such failures in a row put Ref on a 15-minute contract hold that skipped the following 14 searches (the first probe after it succeeded, since the failures depend on the query), and a block beside a marked one was dropped without a trace. Fixed in `5e035b2` (a block of that form is a result unless its description opens with one of Ref's refusals or its link is `ref.tools`). On the third release the five queries whose Ref answers had been refused (Q111, Q112, Q007, Q008, Q009) return Ref results (2, 1, 3, 4 and 6): `raw/live-ref-replay.jsonl`.

## Other live observations (not defects of this release)

- **Context7 exceeded its 10 s budget in 5 of the 30 cold documentation searches** (17%), and in 3 of the 5 replayed queries. Each is attributed (`context7_timeout`), none opened its breaker (never three within 60 s), and the answer is partial. The budget is spec §694's; changing it is a spec decision.
- **Exact versions (F03, spec §6.1).** The 16 held-out hard library@version queries each carry a report in `fcpi.search.coverage.documentation.versions`: 12 versions confirmed (75%), 4 unconfirmed (25%), no query without a report; the one query that expects no match (Q117) was not confirmed. Whether the 12 confirmed verdicts are right was not checked against the rows, and the records of this run keep no URLs; the final release's run above does. Q117 (Python 4.0, expected no match) is unconfirmed, with the `exact_version_unconfirmed` warning, not a clean complete answer. Unconfirmed is Context7 stating no version for the passages it returned or timing out (Q024).
- **Documentation activation (F01).** The four queries that depend on the live classifier activated in all 5 observations each, with probabilities 0.94–0.95 (Q096), 0.85–0.86 (Q081), 0.76–0.77 (Q094) and 0.70–0.72 (Q085), against the cutoff of 0.2. Jev's decisions are cached for 900 seconds, so the repeats within that window reuse the first answer; the changing second decimal (0.86 then 0.85) marks the fresh ones.
- **Ref's bounded read (S4).** It did not fire in any of the 46 documentation searches of the run (0 enrichment records). It fired in the smoke search of each of the three releases (`selected: 1, read: 1`: `raw/release-1/live-smoke.jsonl`, `raw/release-2/live-smoke.jsonl`, `raw/live-smoke.jsonl`).
- **Spend that day** (`raw/usage-day-after.txt`): Exa $1.36 (80 searches), Jev $0.15 (850 decisions), DeepSeek $0.06; 80 Brave requests, 160 Tavily credits, 34 Context7 requests and 39 Ref credits settled (10 and 5 more held as uncertain after the timeouts and refused answers), 100 Serper credits of the 2,443 allocation.

## Reproducing

`plan.mjs` writes `plan.json` from the frozen corpus (byte-identical to the run's). `l01.py` runs on the Pi (a systemd unit, `python3 l01.py plan.json out.jsonl`); `analyze-live.mjs l01-live.jsonl` writes `live-summary.json`; `run-fixture-bench.sh` pipes `bench.mjs` into a throwaway container of the retrieval image on the Pi and `analyze.mjs` summarizes it; `live.mjs smoke|versions|f01|ref|refreplay` are the REST and MCP checks.
