# L01: measured performance on the Pi

Spec §25's criterion L01: named single-active-search cold link-only Pi scenarios meet p95 ≤ 23 seconds; request deadline boundaries remain respected; no resource leak, post-cancel send, OOM or unbounded fan-out appears in targeted exercises; live measurements and injected failures are labeled separately. This directory holds the drivers and analyses, `../raw/` the raw observations.

## What ran on which image

| Measurement | Where | Release | Retrieval image | Raw record | Analysis |
|---|---|---|---|---|---|
| Live searches, 84 in one paced run | the deployed platform on the Pi, through the gateway's loopback publication | second (candidate `20d972934c7c`, deployed `587e1236822d`) | `d13b5a9b0a53` | `raw/l01-live.jsonl` | `live-summary.json` |
| Fixture stalls, four at once, cancellation | a throwaway container on the Pi from the same image | second | `d13b5a9b0a53` | `raw/l01-fixture.jsonl` | `fixture-summary.json` |
| The same fixture scenarios, before the cancellation fix | the first release's image | first (candidate `e83cabd20c77`) | `9a68963492ad` | `raw/release-1/l01-fixture-run1.jsonl`, `run2.jsonl` | the cancellation survivors in them |
| Ref replay of five queries | the deployed platform | third (candidate `5e035b212302`, deployed `4b1c11e555aa`) | `1cb9b68bc4d2` | `raw/live-ref-replay.jsonl` | below |

The third release differs from the second only in `adapters/ref.mjs` (and its test): `git diff 20d9729 5e035b2 -- services`. The link-only latency, the fixtures and the cancellation behaviour do not depend on it, so they were not repeated on the third release.

## Live (labelled live)

One search active at a time except `concurrent4_live`, one search every 62 seconds to stay under the platform's own 60-an-hour admission (no admission wait occurred). The deployed policy's timings, the real providers, the Pi's real memory.

| Scenario | Searches | Cold | p50 | p95 | max | Over 23 s | Over the 60 s deadline |
|---|---|---|---|---|---|---|---|
| `cold_link_only` (documentation off) | 30 | 30 | 7,357 ms | 8,706 ms | 9,692 ms | 0 | 0 |
| `cold_docs` (documentation on) | 30 | 30 | 7,456 ms | 11,777 ms | 11,840 ms | 0 | 0 |
| `concurrent4_live` (two rounds of four at once) | 8 | 8 | 6,126 ms | 7,699 ms | 7,699 ms | 0 | 0 |
| `activation_repeat` (limit varied) | 16 | 3 | 6,797 ms | 7,369 ms | 7,369 ms | 0 | 0 |

L01's named scenario is the first row: p95 8.7 s against the 23 s target. All 84 searches answered HTTP 200. Link-only outcomes: 29 complete, 1 partial (DeepSeek could not represent the query; its warning is attributed). The documentation scenario is slower at its tail because Context7 and Ref are held to a 10-second task budget (spec §694), and 5 Context7 calls ran out of it.

**Memory.** 426 samples of the stack's containers (docker stats) and the host, every 10 seconds, across the run: peak resident firecrawl-core 1,757 MiB, rabbitmq 125, searxng 100, nuq-postgres 97, browser-worker 86, retrieval-service 62, mcp-gateway 54, access-gateway 39, redis 12. The host's available memory never fell below 4,711 MiB.

## Fixture (labelled injected failures)

A throwaway container (no network but loopback, read-only root, the service's uid, label `fcpi.transient`), the release's coordinator, adapters and policy timings, loopback provider fixtures. Timings here are fixture timings. The container is removed and the run records no transient container left.

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
- **Exact versions (F03, spec §6.1).** The 16 held-out hard library@version queries each carry a report in `fcpi.search.coverage.documentation.versions`: 12 versions confirmed (75%), 4 unconfirmed (25%), none confirmed wrongly, no query without a report. Q117 (Python 4.0, expected no match) is unconfirmed, with the `exact_version_unconfirmed` warning, not a clean complete answer. Unconfirmed is Context7 stating no version for the passages it returned or timing out (Q024).
- **Documentation activation (F01).** The four queries that depend on the live classifier activated in all 5 observations each, with probabilities 0.94–0.95 (Q096), 0.85–0.86 (Q081), 0.76–0.77 (Q094) and 0.70–0.72 (Q085), against the cutoff of 0.2. Jev's decisions are cached for 900 seconds, so the repeats within that window reuse the first answer; the changing second decimal (0.86 then 0.85) marks the fresh ones.
- **Ref's bounded read (S4).** It did not fire in any of the 46 documentation searches of the run (0 enrichment records). It fired in the smoke search of each of the three releases (`selected: 1, read: 1`: `raw/release-1/live-smoke.jsonl`, `raw/release-2/live-smoke.jsonl`, `raw/live-smoke.jsonl`).
- **Spend that day** (`raw/usage-day-after.txt`): Exa $1.36 (80 searches), Jev $0.15 (850 decisions), DeepSeek $0.06; 80 Brave requests, 160 Tavily credits, 34 Context7 requests and 39 Ref credits settled (10 and 5 more held as uncertain after the timeouts and refused answers), 100 Serper credits of the 2,443 allocation.

## Reproducing

`plan.mjs` writes `plan.json` from the frozen corpus (byte-identical to the run's). `l01.py` runs on the Pi (a systemd unit, `python3 l01.py plan.json out.jsonl`); `analyze-live.mjs l01-live.jsonl` writes `live-summary.json`; `run-fixture-bench.sh` pipes `bench.mjs` into a throwaway container of the retrieval image on the Pi and `analyze.mjs` summarizes it; `live.mjs smoke|versions|f01|ref|refreplay` are the REST and MCP checks.
