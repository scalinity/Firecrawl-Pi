# M9 Cloud-window independent debugger review

## Summary

The pinned-block design holds up. The hash covers `name+'\n'+block`, and that block already contains `log_sha256`, `saved_utc`, the classification counts, the truncated six lines and `newest_line_utc`. Any extra Cloud line in that stored log changes the hash and fails the check. The `newest < window-open` rule then keeps a current line from borrowing the exemption.

The gap is in the wiring around it. When the legacy M8-X01 result is FAIL, `verify.mjs` replaces it with `cloudWindowVerdict`. Nothing checks *why* the legacy check failed. So any legacy failure that `cloudWindowVerdict` does not re-check is replaced by PASS.

## Critical Issues

**C1: the replacement ignores why M8-X01 failed (false PASS is possible).**
- **Where:** `scripts/m9/verify.mjs`, `get()`: `state: …id==='X01'&&rec?.state==='FAIL'?currentCloudWindow().state:…`
- **The problem:** `cloudWindowVerdict` reads only the collector's `classified` summary line, and only for `instance_*`/`stored_*` sections. A legacy failure caused by anything else turns into PASS. Examples:
  - a block's summary that doesn't add up to its pattern counts;
  - a count of `unexplained` lines that doesn't match `cloud_unexplained + dns_unexplained`;
  - a section with an unknown prefix, such as a scan-error section;
  - a duplicated section name. `Object.fromEntries` keeps the last copy, so an earlier failing `instance_X` is hidden;
  - incomplete instance coverage.
- **What it breaks:** the gate is meant to prove zero Cloud attempts. A current unexplained attempt that only the legacy checker sees would still be accepted. `legacy_test_state:'FAIL'` and `retained_unexplained_lines:6` are hard-coded, not read from the record, so the output hides this.
- **Minimal fix:**
  1. Replace the legacy result only when its failures are exactly `{stored_fc9fbe6cdf11: cloud_unexplained=6}` and the block hash matches. Read this from the X01 record's per-block detail, or re-run the M8-X01 evaluator with only that hash excluded and require PASS.
  2. Otherwise keep FAIL.
  3. Read `legacy_test_state` from `rec.state`.
  4. Add a test: a legacy FAIL with any second cause stays FAIL.

## Warnings

**W1: the per-block summary is trusted, not recomputed.** For every block except the pinned one (which the hash already covers), also require:
- the `firecrawl\.dev`, `firecrawl\.com`, `mendable`, … counts sum to the four cloud classes;
- the `getaddrinfo`, `EAI_AGAIN`, `ENOTFOUND`, `ENETUNREACH` counts sum to the two dns classes;
- the number of `unexplained ` lines equals `cloud_unexplained + dns_unexplained`.

The pinned block already balances (40 = 30+0+4+6). Also reject duplicate section headers and unknown section prefixes, as `frames()` already does for resource frames.

**W2: the window's bounds and its zero-count result have no proof behind them.** `cond.window` reads only the open time. Nothing requires:
- `close.utc > open.utc`, or a minimum duration;
- the window to cover the M9 live runs;
- the log collection (`core-logs-final.txt` meta) to happen at or after close, on equivalent source.

A near-zero-length window passes trivially. The zero `egress_*_accepted` result also has no positive control: no counter in the same evidence is shown to increase. That conflicts with CLAUDE.md §33.3.

**W3: the Cloud mutation test is not required by the acceptance gate.** `M9-RESOURCE-EVALUATOR-TESTS` requires `# pass >= 14`, but the file has 15 tests. Deleting the Cloud test still leaves 14 passing, and the hash checks would simply match the edited file. Require the count to equal 15, or require that test's exact `ok … immutable old failed Cloud probe` line.

**W4: the mutation tests leave several branches untested.** The current mutations only cover:
- the probe hash;
- `currentSecurity` and `inputsBound`;
- `cloud_unexplained` 6→7 and 0→1;
- the web counter.

Untested branches:
- a table-handle mismatch;
- the proxy counter;
- `dns_unexplained` ≠ 0;
- `control=…count=0`;
- `newest ≥ t` (move the open `utc=` to before 08:27:15Z);
- a duplicated section;
- a byte-identical copy of the block under another name;
- removing the block, which should fail on `retained===1`.

## Suggestions

- Record `logs_meta_utc`, `close_utc` and the X01 failure detail in `evidence/M9/cloud-window.json`, so the interpretation can be audited from the file alone.
- The link between scrapeId `01a100d9…` and attempt `de9df76a…` rests on matching timestamps (08:20:45) and the URL. That is acceptable because the bytes are pinned. Say so in the note, since the probe line has `scrapeId:null`.

## Good Practices

- The exemption is a single pinned block: name, content hash and an exact count of one (`retained===1`). It is not a pattern exemption.
- `newest_line_utc < window open` stops a current line from borrowing it.
- The probe file is pinned by its own hash, and its `CLOUD_DENIED` proxy event is real denial evidence, not an inference.
- Current M2-S03 must be PASS on equivalent clean source, so current forbidden redirects classify correctly.
- The guard-table handle must stay the same across the window, which blocks a counter reset from a table reload.
- The legacy FAIL is reported beside the new verdict, not overwritten. The accepted M8 record and the original failed probe stay untouched.

## Verdict

**Not ready to accept.** The pinned historical block is well separated from current logs. But the X01 replacement is not tied to *why* the legacy check failed, which leaves a possible false PASS (C1). Fix C1, then W1–W3. All three are small, local changes to `scripts/m9/resource-reuse.mjs`, `scripts/m9/verify.mjs` and `tests/contracts/m9-resource-reuse.test.mjs`.

`★ Insight ─────────────────────────────────────`
- Hashing the summary block, which itself contains `log_sha256`, pins the conclusion to the underlying log without re-reading it. A legacy-overriding verdict, though, must stay at least as strict as the check it overrides, minus the one excluded item.
- Building a map from keyed sections (`Object.fromEntries`) silently drops duplicates. Parsers that feed a "zero failures" verdict need to reject duplicate keys.
`─────────────────────────────────────────────────`
