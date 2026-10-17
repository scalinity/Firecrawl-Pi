# Anthropic models for extraction and the Agent

State: **VERIFIED_LIVE** on 2026-10-17, with one open host item (below). Default structured extraction now runs on **Claude Haiku 5.5** and the playground Agent on **Claude Opus 5.5 at high effort**, each on its own Anthropic key held on the Pi. GPT-6 Luna, GPT-6.1 Sol and the OpenAI provider are out of the budget policy. The OpenAI-compatible chat path stays in the adapter for the fixture provider and any compatible replacement.

The proof is narrow and says so: one default extraction and one Agent run through the Pi gateway on a stable public page. The frozen M9 corpus ran on the former model and was **not** rerun.

## What was verified

- **PASS:** 277 retrieval tests on native ARM64 with a real isolated PostgreSQL at the deployed commit (`4778188`), 0 failed, 0 skipped; 93 gateway tests; 44 playground, desktop and Agent tests.
- **PASS:** the default model through the Pi. `/v2/scrape` with a json format returned the right answer (purpose and `is_a_service: false`), with `model` `claude-haiku-5-5`, effort `none`, 424 prompt and 36 completion tokens, **61 micro-USD**.
- **PASS:** the Agent through the Pi, over the same SSH forwarder the desktop app uses. Completed on `claude-opus-5-5` at `high`, answer correct, two findings verified against the page, 1,150 prompt and 238 completion tokens, **9,360 micro-USD**, 6.9 s.
- **PASS:** the ledger. Seven Anthropic rows: five `SETTLED` (total 9,586 micro-USD), two `RELEASED` at 0, none `RESERVED` or `UNCERTAIN` (`raw/ledger.txt`).
- **PASS:** the cutover. Only the three services whose inputs changed were recreated (retrieval, access gateway, MCP gateway); the other twelve containers were untouched; the service reports search `live`, model `claude-haiku-5-5`, selection source `file`, with no startup complaint.
- **PASS:** two-agent review and remediation (`review/REVIEW.md`): 15 findings, none critical; 12 fixed, 2 resolved at cutover, 1 rejected with its reason.

## What the live step found that nothing else could

The first Agent run through the Pi was rejected by the provider. `toStrict` makes an enum nullable as a type array plus `null`, and the Messages API's schema compiler refuses that (`Enum value 'visit' does not match declared type`). Every schema with an enum property would have failed, including the Agent's own `next_action`. Fixed in `f3cec79` (a nullable enum is sent as an `anyOf`); all 14 schema shapes the project generates are accepted afterwards. The two refused attempts cost nothing: both ledger rows are `RELEASED` at 0. The provider's reason reached the error text only because this change keeps the provider's reason on a 400.

## Things worth knowing

- **Opus and the $1/day shared paid cap.** A typical Agent page cost $0.009. A full-size page *reserves* about $0.66 (bytes are counted as tokens at the highest rate, a bound that holds for any tokenizer), so a few of them in a day, or one while anything else is reserving, can hit the daily cap even though the real cost is cents. The cap is yours to change; nothing here touched any cap, authorization or dispatch setting.
- **Output allowance.** Opus 5.5 produced 9,000 tokens in 59.5 s non-streaming (about 151 tokens/s), so the 16,000-token allowance carried over from the former model could not finish inside the 90 s cap, and a call that times out after sending is never re-sent and holds its whole reservation for the day. The allowance is now 8,000 (about 53 s).
- **Schema limits on the provider's side.** The output grammar holds 16 union-typed fields in all, and every property of a strict schema is one. Larger schemas are not refused: they are sent as prompt text, validated locally against the full schema and repaired once. The Agent's own fields use 10 of the 16, so an Agent *result schema* of more than five fields (nested included) runs unconstrained but checked.
- **Direct probes.** About $0.23 was spent calling the API from the workstation to measure its limits (`raw/probes-transcribed.md`). They bypass the Pi, so they are not in its ledger or against its caps.
- **Left in place.** `openai_api_key` is still on the Pi, unused and no longer named by the policy; `OPENAI_API_KEY` and `MODEL_NAME` are still in the workstation's `.env`. Neither was touched.
- **Open host item.** The `nft` ruleset hash differs between this session's BEFORE and AFTER snapshots. AFTER equals the hash recorded on 2026-10-15; BEFORE was a different, unexplained state, and only its hash was kept, so it cannot be diffed. No firewall command was run and no firewall file was changed. The previous session's AFTER snapshot is not retained, so the entry comparison could not be made. Details and the evidence for and against are in `snapshot-attribution.json`. Every other difference (six sections of thirteen, five attributed) is exactly the three recreated containers and one SSH session.
- **A flaky test, not touched.** One residential-proxy tunnel test failed once under the parallel load of a full local run (27 s against a few seconds alone); it passed alone and in both complete runs.

## Rollback (documented, NOT_RUN)

Deploy the commit before the change (`664d47a`) with `scripts/m1/deploy.sh`; set the selection back with `scripts/m5/pi-selection.sh live gpt-6-luna llamaparse-cost-effective decodo-residential zyte-api`; recreate the retrieval service, access gateway and MCP gateway. The previous retrieval image (`sha256:300b999e…`) is still on the Pi and the OpenAI key file was never removed. No database or queue change was made, so nothing needs restoring there.

## Commits

`4956d2f` provider, policy and gateway tests · `d9210b1` Agent pin and label · `4ba6ccf` `cb2eb74` `09b5f23` `c6d5f39` `6fea5ae` `7a8bc9d` `615bca6` `7e001a0` `90f52fd` `dd089fe` review fixes · `a037d3b` Opus allowance from measurement · `fbc3db2` first image pin (superseded) · `f3cec79` nullable-enum fix · `4778188` image pin.

Receipts: `verification.json`, `fixtures.json`, `snapshot-attribution.json`, `raw/`, and `review/REVIEW.md`. Historical M5 and M9 acceptance records are unchanged; this is additive post-M9 verification.
