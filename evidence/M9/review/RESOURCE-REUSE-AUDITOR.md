# Code Review: M9 resource evidence reuse (auditor)

## Summary
I reviewed `scripts/m9/resource-reuse.mjs`, the reuse and `sameCode` changes in `scripts/m9/verify.mjs`, and `tests/contracts/m9-resource-reuse.test.mjs`. For context I read `scripts/m9/evidence-checks.mjs`, `scripts/m9/collection.mjs`, and the top of `deploy/versions.lock.json` and `scripts/m8/verify.mjs`. I didn't run anything.

The historical bytes are pinned by SHA-256, the targeted inputs go through the existing receipt binding, and compose equivalence uses an allow-list. The gaps are in what the evaluator doesn't check: what the runtime-delta hash covers and where it starts, gaps between samples, whether the incident ran inside the workload window, and rename handling in the proof-only rule.

Every fix below stays inside the three proof-only paths. None of them invalidates the 82a1153 receipts, and none requires a second 24-hour soak.

## Critical Issues
None. I couldn't confirm a false PASS without collector output or git history I can't see. W2 and W3 would become false PASSes if the frozen sampler appends to its file after a restart, or if the incident ran outside the workload window.

## Warnings
**W1. The runtime-delta assessment doesn't cover all runtime inputs** (`scripts/m9/verify.mjs`, `reusedResources()`)
- **Missing paths:** the pathspec leaves out `patches/` and `deploy/versions.lock.json`. The lock pins the upstream Firecrawl tag and commit and the runtime npm integrity hashes (`deploy/versions.lock.json:9-17`, `:57-108`).
- **Image changes are invisible:** `sameResourceCompose` drops the `image` field of access-gateway, retrieval-service and browser-worker. A re-pin or patch-series change to one of those images never shows up in the assessed delta.
- **Lock-only re-pins after the run:** `sameCode` also excludes the lock. So a lock-only re-pin after the targeted run still treats the 82a1153 samples as equivalent, even though they measured a different image. Only the other services are protected, by exact digest equality in compose.
- **Wrong baseline:** the delta starts from the hard-coded `55d756…`, not from the commit where M8 accepted the soak. Runtime changes between 286bb54 and 55d756 are never assessed.
- **Hash isn't reproducible:** it's taken over plain `git diff` output, which changes with git config (`color.diff=always`, `noprefix`, `diff.external`, textconv, rename detection).
- **`null` can match:** if git throws, `runtimeDeltaHash` stays `null` and matches an assessment that also holds `null`. Today only the compose failure in the same `try` hides this.
- **New incident files are missed:** listing the four `incident-*.sh` scripts by name won't pick up new incident helpers.
- **Patch:**
```js
const rt=['services','deploy','patches','scripts/ops','scripts/m9/incident-*'];
runtimeDeltaHash=sha(execFileSync('git',['diff','--no-color','--no-ext-diff','--no-textconv','--no-renames','--full-index','--binary','--src-prefix=a/','--dst-prefix=b/',resourceBaseline,head,'--',...rt],{maxBuffer:8*1024*1024}));
execFileSync('git',['diff','--quiet',m8AcceptedSha,resourceBaseline,'--',...rt]); // or start the hashed delta at m8AcceptedSha
```
  - Take `m8AcceptedSha` from the `repository_sha` in the pinned `evidence/M8/verification.json`.
  - In `resourceReuseVerdict`, also require `/^[0-9a-f]{64}$/.test(runtimeDeltaHash??'')`.
  - `AC16-applicability.json` must then be regenerated. That's evidence work only; nothing runs on the Pi.

**W2. Nothing checks for gaps between samples or for a second run in the same file** (`resourceReuseVerdict`)
- **Current checks:** only a count of at least 110, increasing timestamps, and a span of at least 1750 s.
- **Not checked:**
  - the longest gap between samples;
  - that there is exactly one `meta` and one `end` frame (`frames()` merges repeated `### samples` sections and keeps only `meta[0]`/`end[0]`);
  - an upper limit on `end.utc`;
  - that the samples cover the workload window.
- **Reachable case:** 110 samples, then a stall or a Wi-Fi-watchdog reboot, then a restarted sampler appending to the same file. That passes. If the OOM counters reset at boot or container restart, the outage leaves no failing sample.
- **Patch** (place it after `w` and `window` are parsed):
```js
cond.single_run=f.meta?.length===1&&f.end?.length===1&&w.meta?.length===1;
cond.continuity=samples.every((s,i)=>!i||Date.parse(s.utc)-Date.parse(samples[i-1].utc)<=45000)&&Date.parse(samples[0].utc)<=window.start_epoch*1000+60000&&Date.parse(samples.at(-1).utc)>=window.end_epoch*1000&&Date.parse(end.utc)<=window.end_epoch*1000+120000;
```
  If the sampler records a `boot_id`, also require it to stay the same throughout.

**W3. The incident concurrency check only proves presence, and its memory cap can't fail**
- **Presence only:** `concurrent_incident` accepts any one sample that contains the unit. It doesn't require that sample to fall inside `[start_epoch,end_epoch]` or to overlap requests in flight. `incidentVerdict` records no timestamps (`scripts/m9/evidence-checks.mjs:54-70`), so the samples are the only timing evidence.
- **Cap is always met:** `memory_peak<=768*MIB` is already guaranteed by `MemoryMax===805306368` (`scripts/m9/evidence-checks.mjs:63`). A unit that ran right at its cap passes, while the 15 services must stay under 90 %.
- **Patch:**
```js
const unit='fcpi-incident-'+incidentId+'.service',hits=samples.filter(s=>(s.models??[]).some(m=>m.unit===unit));
cond.concurrent_incident=hits.length>0&&hits.every(s=>Date.parse(s.utc)>=window.start_epoch*1000&&Date.parse(s.utc)<=window.end_epoch*1000)&&concurrent.every(m=>m.memory_current>0&&m.memory_peak>0&&m.memory_peak<.9*805306368);
```
  If request rows carry `utc`, also require at least one request inside the span of matching samples.

**W4. The proof-only rule can be fooled by git's rename detection** (`sameCode` in `scripts/m9/verify.mjs`)
- **Problem:** `git diff --name-only` detects renames by default. A rename such as `scripts/m9/<collector>.mjs` → `scripts/m9/resource-reuse.mjs` lists only the new name, so `onlyProofChanges` returns true even though a collector was deleted.
- **Future risk:** nothing stops a collector from later importing `resource-reuse.mjs`, which would make it affect execution.
- **Patch:** add `--no-renames` to the diff. Add a contract test that no file outside `proofOnlyPaths` imports `scripts/m9/resource-reuse.mjs` or `scripts/m9/verify.mjs`.

**W5. The full acceptance path hasn't been shown to reach PASS** (fails closed, so no false acceptance)
The seven tests cover only `resourceReuseVerdict`, `sameResourceCompose` and `onlyProofChanges`. Three things are untested:
- **(a) Legacy M8 checks:** `scripts/m8/verify.mjs` S01/S02/S04/S05 must pass at the new head on the 6366dd8 bytes. That verifier has its own image-digest logic (`scripts/m8/verify.mjs:33-34`) and doesn't know about the proof-only exemption, so AC16's current checks may come back FAIL or NOT_RUN.
- **(b) `M9-CURRENT`:** it requires `source_commit===head` exactly, so it must be re-collected after the commit.
- **(c) No fresh-soak path:**
  - `reusedBinding` intercepts any file named `soak.txt` or `redis-soak.txt`. On a hash mismatch it returns `bound:false` instead of falling back to receipt binding.
  - `M9-RESOURCE-REUSE` is always required.
  - Together, a justified fresh soak could never be accepted.
- **Recommendation:** dry-run the full gate once operations finish. It rewrites `acceptance.json` and moves the regression `verification.json` files into history, so copy `evidence/M9` first.

**W6. The accepted record doesn't pin the assessment**
- **Unbound:** `evidence/M9/work/AC16-applicability.json` has no receipt and isn't listed in `files`.
- **Barely checked:** its content is tested only with `owner_instruction.includes('no duplicate 24-hour soak')`.
- **Patch:**
  - Add the assessment, `evidence/M9/resource-reuse.json` and the three `targeted-*.txt` files to `files`, and emit an `assessment_sha256`.
  - Require `assessment.paths` to equal the `--no-renames --name-only` delta exactly, with every path classified and none marked material.

## Suggestions
- **`frames()`:** inside `samples`, reject any non-empty line that isn't a JSON record. Today sampler error lines are silently dropped.
- **Latency:** require `Number.isFinite(x.ms)` for every request. A `null` `ms` sorts as 0, and a string produces NaN comparisons; both skew p95.
- **Services:** check that the service names match the compose services and stay the same across samples, not just that there are 15.
- **Redis:**
  - Anchor the regex as `/^core_user=fcpi_core$/m`.
  - Require the capture to come after the workload `end`.
  - Check evictions and `used_memory` against `maxmemory`.
- **Historical pins:** assert that the M8-S01 inputs recorded in the pinned `verification.json` hash to the pinned `soak.txt` and `redis-soak.txt`. Derive the execution source and baseline from those bytes instead of string literals.
- **`reusedBinding`:** match only the exact path `evidence/M9/regression/M8/raw/<name>`.
- **Tests:**
  - One test name mentions "caps", but there is no caps mutation.
  - Add cases for: gaps and duplicate frames, an incident outside the window, a window offset over 60 s, a missing workload class, a tampered `accepted_checks`, a missing assessment baseline or instruction, a `null` delta hash, and a rename in `onlyProofChanges`.
  - The compose test uses `regression/M6`, but the gate reads `regression/M8`.

## Good Practices
- Historical bytes are pinned by SHA-256 and labelled `ACCEPTED_M8_REUSE` with their original execution source. They are never relabelled as current runs.
- Compose equivalence removes only allow-listed items and checks them exactly (environment values, a single bind mount each, `create_host_path:false`, read-only except the requests directory). Anything else fails.
- The proof-only rule is a closed list of exact paths. An empty list is rejected, and the tests reject collector, soak, service, fixture and other test paths.
- Targeted inputs go through receipt, private-record and Pi-tree binding. The commits embedded in them are extracted by `collectorSources` and must pass `sameCode`.
- Parse errors fail closed, and failed conditions are reported by name.
- The incident unit runs in `fcpi.slice`, so the slice memory ceiling covers it.
- `paid_dispatch===false` is checked on every sample.

## Verdict
**CHANGES REQUESTED.** There are no Critical issues.
- **W1–W4:** apply before evaluating the targeted run. They're all evaluator-only changes inside the three proof-only paths, so the frozen receipts stay valid and no new 24-hour soak is needed.
- **W5:** needs an end-to-end dry run before AC16 is claimed.
- **W6:** fix before acceptance.
