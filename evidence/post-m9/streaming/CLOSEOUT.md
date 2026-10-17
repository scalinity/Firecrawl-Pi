# Streamed model calls, concurrent requests and the Agent on Sonnet

State: **VERIFIED_LIVE** on 2026-10-17. A model call is streamed and runs to its end, so it settles at its real usage instead of holding its worst-case reservation as uncertain; model requests run concurrently; a call left in flight by a stopped service is marked and listed at the next start; the playground Agent runs on Claude Sonnet 5.5 at high effort and reads a page whole. A latent crash in every outbound connection was found on the way and fixed.

## Why calls were stuck

Every model call was sent unstreamed, with a 128,000-token cap, and cut by a wall clock: the model's 300 s timeout or the caller's deadline, whichever came first. An unstreamed call's usage arrives only with its whole answer, so a call cut after it was sent could never be priced: it became UNCERTAIN, kept its whole reservation ($2.58 for an Agent-sized Opus page) and nothing could settle it. Opus writes about 130 tokens/s, so any answer over roughly 40,000 tokens, thinking included, ended that way; about seven would have filled the $20 monthly LLM cap that Haiku shares. Anthropic's documentation advises against exactly this: a large `max_tokens` without streaming, which the SDKs refuse for calls expected to pass 10 minutes.

Measured on live streams (`raw/stream-probes/`): input usage arrives within about 3 s, a ping every 30 s while the model thinks, and the exact cumulative usage with the end; thinking is billed but never streamed, so a stream cut part-way still cannot be priced. The fix therefore never cuts a live call.

## What changed

| | before | now |
|---|---|---|
| a sent model call | cut at min(model timeout, deadline); cut means UNCERTAIN, whole reservation held | streamed and run to its end (90 s of silence or a 30-minute ceiling end it); settled at its usage |
| the caller | waited at most the model timeout | waits until its deadline or until it cancels, then gets EXTRACTION_STILL_RUNNING, counted as a dispatched call |
| a retry | — | an extract job (stable submission key) reuses the stored answer; a json scrape gets 504 with no retry offered, since a repeat would pay again |
| model requests at once | one; others waited and were refused RESOURCE_BUSY | no count limit; each holds its reservation while it runs, so the budget bounds them |
| a call in flight at a restart | RESERVED forever, held and not listed | marked UNCERTAIN at the next start and listed, with what it holds |
| the Agent's model | Opus 5.5 high, each long page read in 32,000-token parts whose decisions were merged | Sonnet 5.5 high, up to 150,000 input tokens read in one call |

Commits: `2a905b0` concurrency · `0140e91` streaming and detached calls · `88d8e4c` start-up sweep · review fixes `dc4c639` (connection bound), `cf9722b` (stream reader), `8fd4969` (sweep total), `d9348db` (still-running class, probe, logging, buffer, spec) · `2d761cf` per-model input cap · `2a78a36` comparison record · `a9ec1f5` Agent on Sonnet · `2857236` asynchronous lookup · image pins `4d6dd0a`, `5d91186`.

## What was verified

- **PASS:** every Pi suite in the final images on native ARM64, with a real PostgreSQL (`raw/pi-suites-final.txt`): 299 retrieval tests (the start-up sweep's included), 6 gateway ledger, 48 gateway, 47 MCP, 3 grammars, 32 gateway unit, 46 gateway contract, 4 MCP contract; 0 failed, nothing left behind. Locally at the final code: 268 retrieval (31 database tests skip without one), 96 gateway, 58 root (`local-suites.json`).
- **PASS:** the new tests can fail: seventeen guards were each removed in turn and each removal failed its test (`mutation-checks.json`).
- **PASS:** the cutover recreated only the retrieval service, the gateway and the MCP gateway, with no job in flight and no model call reserved; all three healthy on the pinned images (`raw/cutover.txt`). The start-up sweep found no orphaned call.
- **PASS:** live through the Pi on the final images (`raw/live/live-final.jsonl`, `raw/ledger-after.txt`): a default Haiku extraction streamed and settled at 61 micro-USD; a Sonnet Agent run on the long tallest-buildings page read the whole page in one call (181,470 input tokens) and completed with the right three buildings in 16 s, settled at 370,800 micro-USD against its 2,179,923 reservation, no part merged. Every call since the cutover settled at its usage; the month holds nothing reserved and no call this month is UNCERTAIN (41 settled, 2 released).
- **PASS:** MCP `tools/list` on the Pi offers `claude-sonnet-5-5` as the json format's opt-in model; connected clients see it after reconnecting.
- **PASS:** the model choice (`../agent-models/`): 64 Agent runs on eight tasks; Sonnet 14/16 correct, Opus 13/16, Haiku 11/16 with thinking and 6/16 without; with whole-page reads Sonnet completed 10 of 16 runs instead of 4.
- **PASS:** review of record with every finding's outcome (`review/REVIEW.md`).
- **PASS:** the host. The firewall's raw (`e1e3a82a…`), canonical (`65b18fd5…`) and guard (`f291c0ce…`) hashes and its four sorted chains are identical before and after (`raw/firewall-before.txt`, `raw/firewall-after.txt`); all 30 lines of the snapshot difference are attributed (`snapshot-attribution.json`).
- **PASS:** the desktop app was rebuilt and installed at `/Applications/Firecrawl Pi.app`; its 13 packaged files are byte-identical to the repository, and its Agent names Sonnet.

## Found on the way

- **A failed connection could end the retrieval service.** The pinned lookup every outbound connection uses (pages, the proxy, providers) answered synchronously, so a connect that failed at once, as Linux does when the host has no route, raised its error before the request listened for it: an uncaught exception. A Wi-Fi loss on this host is such a moment. The connection test's first run in the Pi's container showed it (`raw/pi-suites-first-run.txt`, test 232); fixed in `2857236`.
- **The Agent's decision was merged from a page's parts,** which held back every model; fixed by the per-model input cap.
- **One short Sonnet run ended INVALID_AGENT_DECISION** (`raw/live/live-final.jsonl`): a decision that broke the Agent's own rules, refused rather than guessed; the same task completed in two reruns, and none of the comparison's 32 Sonnet runs did this.
- **18 of 106 page fetches failed on the Pi during the comparison** (domains learned as blocking with no proxy available, residential-proxy errors, 403 blocks), for every model alike. Retrieval reliability, not changed here.

## Rollback (documented, NOT_RUN)

Deploy `3ad46ef` with `scripts/m1/deploy.sh` (its pins carry the former images), recreate the retrieval service, the access gateway and the MCP gateway with `docker compose -p fcpi -f /opt/firecrawl-pi/deploy/compose.yaml up -d --no-deps --wait --force-recreate retrieval-service access-gateway mcp-gateway`, and reinstall the former desktop app from that commit with `npm run package` in `desktop/`.

## Spend

Outside the Pi's ledger, on the Agent's key: about $0.75 for the stream probes, $10.33 for the comparison and $3.58 for the Sonnet rerun. Through the Pi after the cutover: $0.38 for the live checks.
