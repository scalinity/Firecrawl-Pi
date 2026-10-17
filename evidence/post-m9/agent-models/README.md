# Agent model comparison

Date: 2026-10-17. Question: is the playground Agent as good on a cheaper model as on Claude Opus 5.5 at high effort? Result: Claude Sonnet 5.5 at high effort matched Opus at about half the cost and was chosen; Claude Haiku 5.5 did not. The comparison also found that the Agent's decision was being merged from a long page's parts, which held back every model, and the fix for that was measured on Sonnet.

## Method

- **What ran.** The real Agent loop (`scripts/playground/agent.mjs`, copied per arm with only its model and effort changed) against the live web. Search and page retrieval went to the Pi through the playground's own SSH forwarder, exactly as the desktop app sends them. The `json` format each page read asks for was answered on the workstation by the real retrieval extractor (`services/retrieval/src/extract.mjs`: same prompts, chunking, schema checks, repair and streamed transport), calling the Anthropic API with the Agent's key. Only the model differed between arms. Harness: `harness/eval.mjs`, tasks: `harness/tasks.json`, scoring: `harness/score.py`. The committed harness keeps its key file and Agent copies in a temporary directory; the run used the scratchpad.
- **Arms.** Opus 5.5 at high effort (the Agent's model until then); Sonnet 5.5 at high effort; Haiku 5.5 with thinking off (the default extraction setting); Haiku 5.5 at high effort.
- **Tasks.** Eight, each run twice per arm (64 runs): a fact in a long documentation page (T1), a figure from an official site (T2), a two-step question (T3), a comparison of two facts (T4), a structured result against a schema (T5), a question with no answer, where the right outcome is not to invent one (T6), a table in a long page (T7) and a licence on a code host (T8). Up to four pages per run.
- **Scoring.** An answer is correct when every expected fact appears in it (T5: the structured result matches; T6: no population figure is asserted). "Completed" is the Agent's own verdict: a finished answer whose every quotation was found verbatim on its cited page.

## Results

| arm | correct | completed | answers withheld for an unverifiable quotation | median run | mean cost | total |
|---|---|---|---|---|---|---|
| Opus 5.5 high | 13/16 | 5/16 | 2 | 27 s | $0.405 | $6.48 |
| Sonnet 5.5 high | 14/16 | 4/16 | 0 | 19 s | $0.218 | $3.48 |
| Haiku 5.5 high | 11/16 | 2/16 | 4 | 17 s | $0.011 | $0.17 |
| Haiku 5.5, thinking off | 6/16 | 2/16 | 9 | 11 s | $0.012 | $0.19 |

Haiku failed the two-step task (T3) and the structured result (T5) in every run, and with thinking off most of its answers were withheld because a "quotation" it returned was not on the page. Sonnet and Opus were within one answer of each other, so the cheaper and faster one was chosen (`score-comparison.json`, `raw/comparison.jsonl`).

### Two causes that were not the model

- **The decision was merged from a page's parts.** A page longer than 32,000 tokens was split into parts, the Agent's decision was extracted from each part, and the parts were merged by keeping the first value: a later part's "finish" lost to an earlier part's "search". 20 of the 51 runs that did not complete had their decision overruled this way, for every model alike (the `$.complete: parts disagree` limitations in `raw/comparison.jsonl`). The fix gives the Agent's model its own input cap of 150,000 tokens, so a page is read in one call.
- **The Pi could not fetch some pages.** 18 of the 106 page fetches during the comparison failed on the Pi: six PROXY_REQUIRED (domains learned as blocking), six residential-proxy provider errors or an open breaker, and six BLOCKED_PUBLIC_CONTENT (403). T2's official site and T6's search results were affected in every arm. This is retrieval reliability, separate from the model, and is not changed here.

### Sonnet with the whole page in one call

| | correct | completed | withheld | median run | mean cost |
|---|---|---|---|---|---|
| before (parts merged) | 14/16 | 4/16 | 0 | 19 s | $0.218 |
| after (150,000-token unit) | 12/16 | 10/16 | 3 | 11 s | $0.224 |

T1, T4 and T7 went from partial to completed in both runs, and every completed run was correct. T3 regressed: both runs withheld their answer, one because a quotation reshaped the page's link markup, and one read the whole Oppenheimer article and reported his doctorate as not stated (`score-sonnet-whole-page.json`, `raw/sonnet-whole-page.jsonl`).

## Limits

- Two runs per task and arm: a difference of one or two answers is within noise.
- The extraction ran on the workstation, not the Pi, so the Pi's own ledger did not see these calls. The comparison ran on a clean tree at `88d8e4c`; the Sonnet rerun ran at `2d761cf` (the per-model input cap) with the Sonnet policy entry that the next commit holds.
- Spend outside the Pi's ledger: $10.33 for the comparison, $3.58 for the rerun, and about $0.75 for three earlier streaming probes, all on the Agent's key.
