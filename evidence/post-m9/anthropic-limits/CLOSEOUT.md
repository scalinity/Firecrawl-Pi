# Agent limits: Opus output, timeouts, and no shared daily paid cap

State: **VERIFIED_LIVE** on 2026-10-17. The Agent's model (Claude Opus 5.5 at high effort) now has no output cap of its own below the API's maximum of 128,000 tokens and a 300 s model timeout; every layer between a caller and the provider waits at least that long; and the $1 shared daily paid cap is gone. The anthropic credits are promotional, so the owner chose capability over conservation; the $20 monthly LLM cap and the residential proxy's own caps still apply.

## What the limits are now

| layer | before | now |
|---|---|---|
| Opus output tokens | 8,000 (a stopgap of 16,000 and then 20,000 in between) | 128,000, the API maximum (the API requires a number and refuses 128,001) |
| Opus request timeout | 90 s | 300 s |
| gateway deadline for a json request that names its model | 120 s | 420 s (`PI_MODEL_EXTRACT_EXTRA_MS` 300 s), abort timer 425 s |
| MCP REST wait / exchange | 120 s / 130 s | 440 s / 450 s |
| Agent page-read wait / whole run | 125 s / 360 s | 435 s / 900 s (server timer 915 s, UI timer 930 s) |
| shared daily paid cap | $1 | none (`paidTotal.caps` is empty) |

The layers nest: model 300 s, gateway 425 s, MCP 440 s, Agent page 435 s, Agent run 900 s, server 915 s, UI 930 s. `tests/timeout-chain.test.mjs` reads the real values and fails if one layer stops outlasting the one beneath it. A default (Haiku) request is unchanged at 120 s.

## What was verified

- **PASS:** every Pi suite in the final images, on native ARM64 with a real PostgreSQL (`raw/pi-suites-final.txt`): 288 retrieval tests, 24 + 32 + 46 + 4 gateway tests, 47 MCP tests, 3 grammar tests, the ledger migration; 0 failed, 0 left behind. Local: 258 retrieval (30 database tests skip without a database), 95 gateway, 58 playground, desktop, timeout-chain and firewall tests (`fixtures.json`).
- **PASS:** the new tests can fail. Twelve source mutations each failed their test, and the two new database tests fail inside the previous image (`raw/mutation-checks.json`, `raw/pg-tests-on-previous-image.txt`).
- **PASS:** the cutover. Only the retrieval service, access gateway and MCP gateway were recreated, with no job in flight; all three healthy, selection still `live` / `claude-haiku-5-5` (`raw/cutover-final.txt`).
- **PASS:** live, on the final images: a default Haiku extraction (58 micro-USD) and a short Agent run on Opus at high effort (9,380 micro-USD, reservation $2.57), both `SETTLED` with no shared-cap row (`raw/live/final-images.jsonl`, `raw/ledger-after-final-checks.txt`).
- **PASS:** long Opus calls through the Pi (`raw/live-long-extractions.md`): a 240-row, five-chunk copy in 149.9 s that the former limits would have cut, and a 12-variant ask that ran 103.9 s and used 13,406 output tokens, past the former 90 s model timeout. At the 20,000-token stopgap three asks ended as a settled `EXTRACTION_OUTPUT_LIMIT` at exactly the cap, which is what the owner asked to remove.
- **PASS:** a real MCP `tools/call` of `firecrawl_scrape` naming Opus at high effort, sent to `/mcp` on the Pi with the modern protocol headers, ran **189 s** (the MCP wait was 120 s and the exchange 130 s before) and returned all 20 requested variants from one model call of **25,205 output tokens** (past the former 20,000 cap), settled at 506,212 micro-USD (`raw/live/live-mcp-long.json`).
- **PASS:** two-agent review and remediation (`review/REVIEW.md`): 2 critical, 10 warnings and 11 suggestions, every one with an outcome, none unresolved.
- **PASS:** the firewall. The raw ruleset hash flipped to its other known value on the recreate, the canonical hash (`65b18fd5…`) and the project's guard-table hash (`f291c0ce…`) did not move, and the same four chains are sorted (`raw/firewall-final-before.txt`, `raw/firewall-final-after.txt`). The snapshot attribution accounts for every difference in six of thirteen sections and finds the other seven identical (`snapshot-attribution.json`).
- **PASS:** the desktop app was rebuilt, signed with the development identity (not notarized) and installed at `/Applications/Firecrawl Pi.app`; all 13 packaged resources are byte-identical to the repository.

## The firewall question, answered

The earlier closeout left one item open: the snapshot's `nft` ruleset hash differed between BEFORE and AFTER with no firewall command run. Docker adds a container's "drop direct access" rules when the container starts, so recreating containers swaps the order of three equivalent pure-match drop rules in `table ip raw`. The raw hash therefore has exactly two values (`86344c11…` and `e1e3a82a…`) and the earlier pair was those two. Capturing the ruleset around each recreate showed the same two-line difference every time (`raw/firewall-experiment.md`); no packet meets a different rule. `scripts/host/firewall-fingerprint.py` sorts only chains made entirely of pure matches with one shared verdict (an allowlist, because a list of dangerous words cannot be complete) and `scripts/host/pi-firewall.sh` runs it on the Pi so the ruleset text, which holds the LAN addresses, never leaves it.

## Things worth knowing

- **Seven calls can fill the month.** An Agent-sized Opus page reserves $2.58 and a full-size page $3.06. A call that times out after sending keeps its whole reservation, nothing settles an uncertain model call, and Haiku shares the category, so about seven such calls would leave no room for another reservation by either model. The status now lists the month's uncertain calls per category. No operator command settles one; it is worth building when the first one appears. Splitting the category so Haiku is not exposed would in effect raise the $20 cap, which is the owner's decision.
- **One model request runs at a time.** A default extraction made during an Opus read waits for the slot and may be refused as busy; the refusal now carries a 30 s retry hint.
- **A reasoning model is not started with under a minute left** (or its own timeout, if shorter), and it cannot be the default selection.
- **MCP clients cache the tool list.** A client connected before this change still advertises the former model pair for the json format until it reconnects (this session's own `firecrawl_scrape` schema did). Reconnect (`/mcp` in Claude Code) to see Opus.
- **Direct probes.** About $0.23 was spent calling the API from the workstation earlier to measure its limits; they bypass the Pi's ledger. The live long runs through the Pi cost about $2.40 in all.
- **Left in place.** `OPENAI_API_KEY` and `MODEL_NAME` remain in the workstation's `.env`; the Pi's `openai_api_key` file was deleted (`raw/provider-secret-names.txt` lists the eight files that remain).

## Rollback (documented, NOT_RUN)

Deploy the commit before the change (`e85c588`) with `scripts/m1/deploy.sh`; it carries the former image pins, policy and manifest. Recreate the retrieval service, access gateway and MCP gateway with `docker compose -p fcpi -f /opt/firecrawl-pi/deploy/compose.yaml up -d --no-deps --wait --force-recreate retrieval-service access-gateway mcp-gateway`. Reinstall the previous desktop app from that commit with `npm run package` in `desktop/`.

## Commits

`1abb6ab` limits and cap · `a5c53b1` gateway extra wait · `2b37772` Agent wait · `3b31ed6` output cap to the maximum · `61ac9cb` `fbbe89f` firewall fingerprint · `3aee83d` Agent run and page floor · `bf83992` MCP limits and timeout-chain test · `9683d39` `6cfab8d` `53aacb6` `85f00b9` `84cf903` `40c6071` `d8c936a` `d112320` review fixes and tests · `9ed6c77` `8c87bd8` `6907870` documents · image pins `2a9e37b` `7cad489` `c7039c7`.

Receipts: `verification.json`, `fixtures.json`, `snapshot-attribution.json`, `raw/`, and `review/REVIEW.md`. Historical M5 and M9 acceptance records are unchanged; this is additive post-M9 verification.

## Later resolution (2026-10-17)

The first three items under "Things worth knowing" no longer hold. Model calls are streamed and run to their end, so a call settles at its usage rather than holding its reservation as uncertain, and a call left in flight by a stopped service is marked and listed at the next start; model requests run concurrently; and the playground Agent runs on Claude Sonnet 5.5 (`evidence/post-m9/streaming/CLOSEOUT.md`, `evidence/post-m9/agent-models/`). A model that reasons is still not started with under a minute of its deadline left, and is still never the default selection.
