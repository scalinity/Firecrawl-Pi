# M9 Cloud-window independent auditor review

**Summary**

I reviewed only the material you pasted, without opening the repository or running anything. The pinned exception is narrow. `cloudWindowVerdict` exempts one exact, hash-pinned scan block for one named stored log, with its count fixed at six and its newest line before the window. The original probe is pinned by its own hash, and the M8 X01 failure is kept as `legacy_state`. No other block may report a Cloud line it cannot explain. One reachable false PASS remains in the acceptance wiring, and there are several gaps where evidence is not bound.

**Critical Issues**

1. **Any legacy M8-X01 failure is replaced by the narrower Cloud-window result** (`scripts/m9/verify.mjs`, inside `get`). The code sets `state: …id==='X01'&&rec?.state==='FAIL'?currentCloudWindow().state:…` without checking *why* X01 failed. `cloudWindowVerdict` re-checks only these things:
   - the classifier's `dns_unexplained` and `cloud_unexplained` counts;
   - that each block has a startup control;
   - the two accepted-packet counters;
   - that the guard table handle is unchanged.

   Suppose a current X01 run fails on anything else, such as an egress-probe outcome, a guard-rule assertion or a missing section. X01 is then reported as PASS, which is exactly the broad exemption you ruled out. The focused tests never exercise this path, because they only call the helper.

   **Minimal fix:** pass the legacy record into the override. Override only when its recorded failure detail is exactly the Cloud-unexplained finding for `stored_fc9fbe6cdf11`, and leave every other FAIL as FAIL. Add a mutation test in which X01 fails for some other reason and acceptance stays FAIL.

**Warnings**

1. **The log scan is not bound in time to the window's close.** Only the open snapshot's `utc` is parsed. Nothing requires the close to come after the open, or the scan in `core-logs-final.txt` to come after the close. If the scan ran before the window closed, a refused Cloud attempt in the gap would never be seen, while the counters stay at zero. **Fix:** parse the close and log-scan `utc` values and require open < close ≤ scan time.

2. **The handle check passes when both handles are missing.** `handle(a)===handle(z)` is true when both are `undefined`, so a table reload would go undetected if the collector stopped emitting `guard_table_handle`. **Fix:** require each handle to match `/^\d+$/`.

3. **The close counters may come from the wrong section.** `s.counters??s.guard_after` prefers `counters`. If `egress-probe.txt` holds both, an earlier snapshot could stand in for the close. **Fix:** name the section the close must use.

4. **Duplicate section names are silently overwritten.** `sections` builds an object with `Object.fromEntries`, so the last duplicate wins. A failing block could therefore be masked by a later block with the same name (the stored names are only 12-hex prefixes). **Fix:** throw on any duplicate key, in all three files.

5. **"Explained" is accepted from the classifier on trust.** In current blocks, any `cloud_refusal`, `cloud_refused_job` or `cloud_request_echo` count passes. Your requirement is zero *unintended* attempts, not zero successful ones. So check that `cloud_refusal` counts only lines matching the deliberate fixture probes, for example M2-S03's attempt IDs. Otherwise an unintended attempt that the proxy refused would pass. I could not see the classifier, so this is unconfirmed.

6. **The evaluator gate does not require the Cloud test.** It requires `pass>=14`, but there are 15 tests. Deleting the Cloud test and re-recording would still pass. **Fix:** require at least 15 passes, or require that test's `ok` line in the raw output.

**Suggestions**

- `legacy_test_state:'FAIL'` and `retained_unexplained_lines:6` are hard-coded constants. Write the actual `rec.state` into `cloud-window.json` so the record cannot drift from what it describes.
- Add mutation tests for:
  - a change to `egress_proxy_accepted`;
  - a handle mismatch;
  - a missing handle;
  - a duplicate section;
  - `dns_unexplained=1`;
  - `control … count=0`;
  - an empty log set.
- Word the note as "the proxy refused a deliberate redirect probe; no Cloud egress". "No Cloud call occurred" undersells the fact that an attempt reached the proxy.
- `newest<t` adds nothing, because the pinned block hash already fixes `newest_line_utc`. It does no harm.

**Good Practices**

- The block hash includes the section name, so the exemption cannot be moved to another log.
- `exact_retained_failure===1` fails if the stored history disappears. That keeps the historical failure in place rather than letting it be quietly dropped.
- The probe file is pinned whole. The correlation between the CLOUD_DENIED event and the browser render through `attempt_id` comes from the pinned bytes, not from a summary.
- Previous verification files are moved aside, not overwritten, and the legacy state is recorded next to the interpreted one.
- Missing or unparseable counters become `NaN`, which fails.

**Verdict**

Not ready to accept. Critical issue 1 is a reachable false PASS through the acceptance wiring. Warnings 1–4 leave the window evidence partly unbound. All the fixes are small and local to `scripts/m9/verify.mjs`, `scripts/m9/resource-reuse.mjs` and `tests/contracts/m9-resource-reuse.test.mjs`. The pinned historical exception itself is correctly scoped.

`★ Insight ─────────────────────────────────────`
- Pinning by hash makes an exception exact, but the place that *applies* the exception has to be just as narrow. An override keyed only on "the record failed" hands out a general pass even when the exemption itself is a single block.
- Every negative result needs a time bound as well as a positive control. Zero counters across a window only prove something if the log scan covers the same window.
`─────────────────────────────────────────────────`
