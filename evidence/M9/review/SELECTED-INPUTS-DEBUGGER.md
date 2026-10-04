## Code Review: M9 selected evidence inputs

### Summary
I traced all 95 legacy checks selected by the `fresh` map in `scripts/m9/verify.mjs:9-25` through their verifiers in `scripts/m2/` to `scripts/m8/`. That covers helper reads (`phase`, `E`, `FX`/`LIVE`, `FAULTS`/`step`, `SOAK`, `chainOf`, `png`), conditional `has()` side files, directory walks and template-built paths.

- **Input coverage:** apart from the known M3-P02 pair, I found no other gap. Every evidence file a selected check reads is in its `input_paths`, either under the M9 base or as a declared directory. Files outside `evidence/` (the policy files, `deploy/host/fcpi-guard.nft`, `docs/FIRECRAWL_PI_SPEC.md`) are either repo code checked by `sameCode`, or the spec, which `acceptance.json` hashes. The helpers that read undeclared side files (`samples()`, `rebootTie`, `ownerContext`, `bootChain`, M3's `readdirSync` sweep) are only used by checks that aren't selected (B00, G01, M01/M02, X01, X04, H04, V01).
- **J03 / K5:** the verifier correctly fails the current run. The failure comes from the evidence driver, not the runtime.

### Critical Issues (Must Fix)
1. **M3-P02 side inputs not declared (known; still open at HEAD).** `scripts/m3/verify.mjs:761-773` reads `raw/tailscale-status.txt` and `raw/tailnet-check.txt`, but `scripts/m3/verify.mjs:830` records only `c.inputs`.
   - **Reachable problem:** fresh bindings on the three declared files can carry a PASS built on unbound older copies of those two files. That reaches M3-P02 and therefore AC02.
   - **Smallest fix**, following the M5-D03 pattern:
     ```js
     input_paths: c.inputs.concat(id === "P02" ? [`${RAW}tailscale-status.txt`, `${RAW}tailnet-check.txt`].filter(has) : []),
     ```

2. **The M3-J03 K5 positive control cannot fire as the driver is written.** The problem is in `scripts/m3/e2e.mjs:410-414`.
   - **What happens:** K5 submits the same six-page `/slow/` crawl as K4 and waits for `completed >= 1`, which the index page alone satisfies. It then runs the core-log scan, which rescans every stored instance log (`scripts/m2/pi-core-logs.sh:65-71`), then a resources sample, and only then kills the core.
   - **Evidence that nothing was in flight:** `evidence/M9/regression/M3/raw/e2e-crash.txt:46-51` shows the scan ending at 12:37:04, the kill at 12:37:07 and the finish at 12:37:33, with attempts `[1,1,1,1,1,1]` and 0 stalled pages. Earlier scans in the same file took about 10–12 s.
     - The finish came 26 s after the kill.
     - NuQ only requeues an active row whose lock is at least one minute old (`deploy/nuq-postgres/nuq.sql:132`).
     - So no page was active when the core died. This is a structural race, not a flaky count.
   - **Why J03's other K5 condition still passed:** `core_killed.ledger.state === "RUNNING"` reads the gateway's ledger, which lags NuQ.
   - **Why not a fixture precondition:** none will do. The 2 s page delay (`tests/fixtures/m3/server.mjs:45`) and `limit: 6` are code. Pruning the Pi's stored core logs would mutate evidence and only shorten the race.
   - **Smallest driver repair (no runtime change):**
     - Move the `k5-before-core-kill` log scan and `resources("before-core-kill-k5")` above the K5 submit. A `docker kill`/`start` keeps the container ID and its log; `crash-after` (line 421) rereads it whole, and X01's instance accounting keys on IDs.
     - Then gate the kill on an active NuQ row, counting and killing in one Pi-side shell:
     ```js
     let active = 0, ledgerAtKill = null;
     for (let i = 0; i < 240 && !active; i++) {
       const lj = ledgerJob(k5.json.id);
       if (lj?.upstream) { ledgerAtKill = lj;
         // Count and kill in one Pi-side shell, so the core dies while NuQ holds one of this crawl's pages active.
         active = Number(pi(`n=$(sudo -n docker exec ${cname("nuq-postgres")} psql -U postgres -d postgres -q -At -X -c "SELECT count(*) FROM nuq.queue_scrape WHERE group_id = '${lj.upstream}' AND status = 'active'") && [ "$n" -ge 1 ] && sudo -n docker kill ${cname("firecrawl-core")} >/dev/null && echo "$n" || echo 0`).trim()) || 0; }
       if (!active) await sleep(250);
     }
     if (!active) D(`kill ${cname("firecrawl-core")}`);   // never seen in flight: recorded as 0, and J03 fails
     out("k5_core_crash_running", { case: "core_killed", id: k5.json.id, ledger: ledgerAtKill, active_at_kill: active, result: cname("firecrawl-core") });
     ```
   - **Proof stays with the verifier:** `stalled_pages >= 1` at `scripts/m3/verify.mjs:381` remains the proof, so a lost race still fails J03, and therefore AC14.

### Warnings (Should Fix)
1. **Both fixes force a full re-collection.** Both edit `scripts/`, so strict `sameCode` (`scripts/m9/verify.mjs:7`) un-binds every current receipt.
   - Land P02, K5 and the optional J03 change in one commit, then redeploy and re-collect every M2–M8 regression input once. Don't re-collect only the M3 crash phase.
   - Any dry run of `scripts/m3/verify.mjs` must set `FCPI_M3_EVIDENCE` to the M9 base, so the accepted `evidence/M3/verification.json` isn't rewritten.

### Suggestions (Consider)
1. **Record the precondition in J03.** At `scripts/m3/verify.mjs:377-382`, also require `one(c.k5_core_crash_running, "core_killed")?.active_at_kill >= 1`, and say so in `expected`. The evidence would then show the interruption at the kill as well as the stall afterwards, and the gateway-ledger condition that passed in this run would no longer stand alone.
2. **Optional margin:** raise K5's `limit` from 6 to 12 at `scripts/m3/e2e.mjs:410`. J03 sets no page count for K5; only K4's `archived === 6` is checked.

### Good Practices
- J03 already fails a run with zero stalls (`scripts/m3/verify.mjs:381`), so a run with no interruption can't pass.
- Optional side files are declared whenever they're present: M5-D03 at `scripts/m5/verify.mjs:699`, and M7-B01/B02 at `scripts/m7/verify.mjs:758`.
- M7's saved PNG paths are fixed by the collector to `raw/artifacts/<sha>.png` (`scripts/m7/e2e.mjs:177-183`), which is inside the declared directory.
- M8-R01's `boot-*` record sits under the declared `reboots/` directory (`scripts/m8/verify.mjs:391-397`).
- M9 refuses external `evidence/` inputs and requires every declared base input to be bound (`scripts/m9/verify.mjs:37-40`).
- Directory inputs are hashed recursively, and symlinks are refused (`scripts/m9/collection.mjs:5-12`).

### Verdict
Request Changes
