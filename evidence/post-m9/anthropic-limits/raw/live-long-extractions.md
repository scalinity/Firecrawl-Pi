# Long Opus extractions through the Pi, 2026-10-17

Each ran over the playground's SSH forwarder with the page-read ceiling of 425 s, as `/v2/scrape` with a json format naming claude-opus-5-5 at high effort. Only timing, usage and outcome were printed. The summaries are in `live/live-long-N.json`; the table is built from them. The ask changed between runs 2, 3, 4 and 5 only to find a size that fits.

| run | page | ask | limits in force | wall | outcome | model calls | output tokens | cost |
|---|---|---|---|---|---|---|---|---|
| live-long-1 | Wikipedia population table (240 rows, 5 chunks) | copy every row verbatim | 20,000-token cap, 300 s timeout | 149.9 s | 200 OK | 5 | 17,986 | $0.93 |
| live-long-2 | example.com (one chunk) | 60 variants of 180-220 words | 20,000-token cap | 191.6 s | 502 EXTRACTION_OUTPUT_LIMIT | 1 | 20,000 | $0.40 |
| live-long-3 | example.com (one chunk) | 40 variants of 180-220 words | 20,000-token cap | 171.7 s | 502 EXTRACTION_OUTPUT_LIMIT | 1 | 20,000 | $0.40 |
| live-long-4 | example.com (one chunk) | 20 variants of 120-150 words | 20,000-token cap | 153.4 s | 502 EXTRACTION_OUTPUT_LIMIT | 1 | 20,000 | $0.40 |
| live-long-5 | example.com (one chunk) | 12 variants of 120-150 words | output cap removed (128,000) | 103.9 s | 200 OK | 1 | 13,406 | $0.27 |

## Reading

- Run 1 delivered 240 rows in 149.9 s as five model calls of about 30 s each: the page splits into five chunks. It outlasted the former gateway deadline (120 s) and forwarder ceiling (125 s), and it would have been refused at its second chunk by the former $1/day shared cap (each call reserves up to $0.90, and the first had already settled $0.19).
- Runs 2 to 4 each ran one model call to exactly the 20,000-token cap (153 to 192 s, about 105 to 130 tokens/s) and ended as a settled EXTRACTION_OUTPUT_LIMIT, not a timeout. Even 20 short variants reached the cap, because at high effort much of the budget goes to hidden thinking. This is what the owner asked to remove.
- Run 5, after the cap was set to the model's maximum of 128,000: one call, 103.9 s (past the former 90 s model timeout), 13,406 output tokens, finish reason stop, settled at $0.27 against a reservation of $2.57. The service's own log for it records `output_cap_tokens: 128000` and the provider's request id.
- Total for the five runs: about $2.40, all inside the owner's promotional credit and the $20 monthly LLM cap.
