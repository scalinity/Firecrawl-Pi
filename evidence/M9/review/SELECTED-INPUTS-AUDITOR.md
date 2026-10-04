## Code Review: M9 selected evidence inputs

### Summary
I traced every selected check (ID) in `scripts/m9/verify.mjs:9-25`, through helpers, dynamic paths and side files, in `scripts/m2/verify.mjs` … `scripts/m8/verify.mjs`.

- **Input coverage:** every evidence file these checks read is in `input_paths`, except the known gap in M3-P02.
  - M7 B01/B02 PNGs: the driver only ever writes `raw/artifacts/<sha>.png` (`scripts/m7/e2e.mjs:177-182`), so the declared `raw/artifacts/` directory covers them.
  - M8 R01's `reboots/boot-*` and M5 D03's `parser-result.json` are also covered.
  - The other undeclared reads are repository files that strict `sameCode` already pins.
- **Positive control:** the real problem is at the J03 boundary.
  - The M3 driver's NuQ marker query has been stale since M7's owner-tagged origin. That makes J03 and J04 impossible to pass, and makes J07's negative vacuous.
  - Separately, K5 kills the core only after all six pages have finished.

### Critical Issues (Must Fix)

1. **M3-P02 still lacks its declared side files (the known gap, unpatched at HEAD).**
   - The reads are at `scripts/m3/verify.mjs:761-773` and `:787`. The runner sets `input_paths: c.inputs` at `scripts/m3/verify.mjs:830`.
   - The current regression shows M3-P02 as PASS with only three input paths (`evidence/M9/regression/M3/verification.json:453-459`). AC02 can therefore accept with `tailscale-status.txt` and `tailnet-check.txt` unbound.
   - Smallest patch, same pattern as M5 D03: `input_paths: c.inputs.concat(id === "P02" ? [`${RAW}tailscale-status.txt`, `${RAW}tailnet-check.txt`].filter(has) : [])`

2. **Stale NuQ marker predicate gives J03/J04 false FAILs and a vacuous J07 PASS.**
   - **Cause:** `scripts/m3/e2e.mjs:59` matches `data->>'origin' = 'fcpi:<id>'`. Since M7 the gateway sends `fcpi:<ownerTag>:fcpi:<id>` (`services/access/src/jobs.mjs:33`, `services/access/src/auth.mjs:83`).
   - **Proof it never matches:** the cancel phase's slow crawl ran upstream and archived 5 pages, yet records `marker_groups:0` (`evidence/M9/regression/M3/raw/e2e-cancel.txt:10`). Every `marker_groups` in `e2e-crash.txt` is 0.
   - **Effect on the selected checks:**
     - **M3-J03:** needs `marker_groups === 1` (`scripts/m3/verify.mjs:380-381`), which it can never get.
     - **M3-J04:** FAILs with "upstream jobs for the key=0" (`verification.json:187`).
     - **M3-J07:** PASSes "queued job … upstream=0" (`verification.json:247`). That negative is vacuous because the query returns 0 for everything.
   - **Smallest fix (driver):** at `scripts/m3/e2e.mjs:59`, match `= 'fcpi:${id}' OR LIKE 'fcpi:%:fcpi:${id}'`, in both the `origin` and `scrapeOptions.origin` terms.
   - **Smallest fix (verifier):** at `scripts/m3/verify.mjs:431-432`, add the positive control `s?.marker_groups === 1` (the running slow crawl's) next to `q.marker_groups === 0`.

3. **The K5 kill happens after the crawl is already finished, so J03's positive control can't fire.**
   - **What the driver does** (`scripts/m3/e2e.mjs:410-414`): K5 crawls the same 6-page `/slow/` site as K4. It waits for the receipt's `completed >= 1`, which the instant index page satisfies. It then runs the slow multi-instance core-log scan over SSH and a resource sample before the kill.
   - **What the transcript shows:** K4 finished at 12:36:49 (`e2e-crash.txt:44`). The scan returned at 12:37:04 (`:46`), and the kill landed about 12:37:07 (`:50`).
   - **Result:** about 18 s after submission, all 6 pages had one attempt each and `stalled_pages:0` (`:51`). The NuQ reaper only stalls rows that were `active` when their lock went stale (`deploy/nuq-postgres/nuq.sql:132`), so none were stalled.
   - **No code-free precondition can fix this.** The limit, the gate and the scan are all hard-coded in the driver, and the 2 s delay is hard-coded in `tests/fixtures/m3/server.mjs:45`. Pausing the fixture by hand would be an unrecorded manipulation.
   - **Minimal driver repair, all in `scripts/m3/e2e.mjs:410-414`:**
     - Move the `k5-before-core-kill` core-log scan to before the K5 POST. `crash-after` re-scans the same container anyway.
     - Keep `resources("before-core-kill-k5")` immediately before the kill.
     - Replace the `completed >= 1` gate with a bounded poll that runs the check and the kill in one remote shell: `a=$(…psql -At -c "SELECT count(*) FROM nuq.queue_scrape WHERE group_id='<upstream>' AND status='active'"); echo active=$a; [ "$a" -ge 1 ] && docker kill <core>`. Take the upstream ID from `ledgerJob(...)`. Record `active_at_kill` in the `core_killed` record.
     - Optionally raise K5's limit to 30, using the fixture's 30 slow pages, to widen the window.
   - **Leave J03 unchanged.** `stalled_pages >= 1` stays the after-the-fact proof. If no active row is ever seen, no kill happens and J03 still FAILs; it never passes on a non-interruption.

### Warnings (Should Fix)

1. **Every fix above triggers a full re-collection under strict `sameCode`.**
   - Fixes 1–3 all change `scripts/`, so every regression receipt's collector source stops matching HEAD (`scripts/m9/verify.mjs:7`).
   - Put all M3 driver and verifier fixes into one commit, redeploy, then re-collect M2–M8 from that commit. Splitting them means a second full cascade.
   - None of this touches M2 runtime, so M9-REG-12 is unaffected.

### Suggestions (Consider)

1. `scripts/m3/pi-ledger-snapshot.sh:20` has the same stale marker comparison (`origin = j.submission_key`). It feeds J05 ledger rows; J05 isn't selected. Fix it in the same commit to avoid a later cascade.
2. Some checks read repository policy files they don't declare: `scripts/m5/verify.mjs:326` (S05 reads `deploy/policies/egress.json`) and `scripts/m7/verify.mjs:517` (W01 reads `deploy/policies/capabilities.json`). `sameCode` pins both, so there's no false acceptance. Declaring them would make `config_or_fixture_hash` complete.

### Good Practices
- Any `evidence/` input outside the M9 base makes `tested_bound` false (`scripts/m9/verify.mjs:38-40`), so it fails closed.
- Directory inputs are hashed recursively, and symlinks are refused (`scripts/m9/collection.mjs:5-12`).
- The previous `verification.json` is moved into history before each run (`scripts/m9/verify.mjs:32`), so no stale prior result carries over.
- J03 correctly refused the run with no interruption: it FAILed rather than PASSed.

### Verdict
Request Changes
