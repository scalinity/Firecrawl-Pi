# Code Review: M9 resource evidence reuse (debugger)

## Summary
I reviewed the proposed `scripts/m9/resource-reuse.mjs`, the reuse and `sameCode` paths in `scripts/m9/verify.mjs`, and `tests/contracts/m9-resource-reuse.test.mjs`. I also read three files: `scripts/m9/collection.mjs`, `evidence/M9/work/AC16-applicability.json` (as data) and `patches/series.json`. I ran nothing.

What works:
- **Historical bytes:** pinned and never retagged.
- **Exemption:** an exact allow-list of three paths.
- **Compose comparison:** strict.

Where it breaks:
- **The assessment:** its conclusion is never checked, and nothing ties it to the lock file it says it assessed.
- **Timing:** the targeted measurements are not tied to the right time window.

None of the findings needs a second 24-hour soak.

## Critical Issues

**C1. The evaluator never reads the assessment's conclusion, and the assessment file isn't hashed into acceptance.**
- **Path:** `cond.assessment` (`scripts/m9/resource-reuse.mjs`) checks only four things: the baseline, `source_commit`, `runtime_delta_sha256` and a substring of `owner_instruction`. It ignores `state`, `duplicate_24h_soak`, `soak_execution_source` and `historical_inputs` (`evidence/M9/work/AC16-applicability.json:7-24`, `:88-90`). The file is also missing from `files` in `scripts/m9/verify.mjs`.
- **Input:** the same file with `"duplicate_24h_soak":"REQUIRED"` or `"state":"INVALIDATED"`, and the instruction text unchanged.
- **Wrong result:** `M9-RESOURCE-REUSE` passes, and AC16 is bound through `ACCEPTED_M8_REUSE` even though the assessment refused reuse. The file can also be edited after acceptance without leaving a trace.
- **Patch:**
```js
// scripts/m9/resource-reuse.mjs
export const executionSource='6366dd8b5b080c3059203412cabd6b8ad7d7832b';
cond.assessment=assessment?.schema==='fcpi.m9-resource-applicability/v1'&&['APPLICABILITY_PENDING_TARGETED_TESTS'].includes(assessment.state)&&assessment.duplicate_24h_soak==='NOT_SCHEDULED'&&assessment.soak_execution_source===executionSource&&Object.entries(acceptedResourceHashes).every(([p,h])=>assessment.historical_inputs?.some(x=>x.path===p&&x.sha256===h))&&/* existing four checks */;
// scripts/m9/verify.mjs: add to files[]
'evidence/M9/work/AC16-applicability.json','evidence/M9/resource-reuse.json'
```

**C2. Nothing ties down the images of the three services that are skipped in the compose comparison: access-gateway, retrieval-service and browser-worker.**
- **Path:** three checks all skip them:
  - `runtimeDeltaHash` excludes `deploy/versions.lock.json` from the diff.
  - `sameResourceCompose` deletes `.image` for those three services.
  - `sameCode` also excludes the lock, and it is applied to the samples, the receipts and the assessment.
- **Input:** a commit after the targeted run that changes only `deploy/versions.lock.json`, re-pinning `browser-worker` to an image with a different Chromium or base layer.
- **Wrong result:** the delta hash doesn't change, the compose still counts as equivalent, and every sample still counts as source-equivalent. Reuse passes for an image that was never assessed or tested.
- **The current data already conflicts:** the assessment lists `deploy/versions.lock.json` under `changed_runtime_paths` (`AC16-applicability.json:31`), and its `runtime_delta_paths` (`:93-101`) has no exclusion. So one of two things is true:
  - Its hash came from a different pathspec than the verifier uses, and reuse would fail today even with good evidence.
  - Or it hashed a diff that leaves out the lock it claims to have assessed.
- **Core image:** the Firecrawl core image stays covered by the compose comparison, because `patches/series.json` patches only `apps/api`.
- **Patch:**
```js
// scripts/m9/resource-reuse.mjs
export const runtimeDeltaPaths=['services','deploy','scripts/ops','scripts/m9/incident-agent.sh','scripts/m9/incident-prepare.sh','scripts/m9/incident-control.sh','scripts/m9/incident-hook.sh'];
// add to cond.assessment
&&JSON.stringify(assessment.runtime_delta_paths)===JSON.stringify(runtimeDeltaPaths)
// scripts/m9/verify.mjs
runtimeDeltaHash=sha(execFileSync('git',['diff','--full-index','--no-color','--no-ext-diff','--no-textconv','--no-renames',resourceBaseline,head,'--',...runtimeDeltaPaths],{maxBuffer:8*1024*1024}));
```
Then regenerate `runtime_delta_sha256` from the exported pathspec. That edits only the evidence document; no runtime work is needed.

## Warnings

**W1. The delta starts from the wrong commit.**
- The soak ran at `6366dd8`, but the delta starts at `55d756`. Any runtime change between those two commits is outside the hashed delta.
- Fix: diff from `executionSource`. If the two commits' trees are identical at these paths, the diff output is byte-identical, so this costs nothing; if not, the check fails safely.
- Make sure `55d756` is reachable from a ref (a tag). Otherwise garbage collection or a fresh clone makes `git show` fail and reuse fails permanently.

**W2. The delta hash is unstable.** Two things can make the final run fail even with good evidence:
- Without `--full-index`, git shortens the commit hashes in `index` lines. It may use longer prefixes as objects are added, e.g. once the >1000 M9 evidence files are committed.
- Git settings also change the diff bytes: `diff.external`, textconv, `color.diff=always`, `diff.algorithm` and `diff.noprefix`.

The C2 patch fixes this.

**W3. The targeted measurements aren't tied to the workload window in time.**
- **Samples:**
  - They aren't required to fall within `[meta.utc, end.utc]` or the workload window.
  - There is no maximum gap between samples and no upper limit on the run's length.
  - Nothing checks that the host didn't reboot. A reboot (the documented watchdog failure) resets `host_oom_kill` and the per-service `oom_kills` counters.
- **Workload requests:** their timestamps are never checked. 70 requests in the first minute, plus an `end` record, passes.
- **Incident overlap:** one sample anywhere in the sampler run counts, including the tail after `end_epoch`. That doesn't prove the incident ran alongside workload traffic.
- **Redis:** the stats are counted since Redis started, and the capture isn't tied to the window.
- **Patch sketch** (field names must match the collector):
```js
const t=s=>Date.parse(s.utc),t0=Date.parse(meta.utc),t1=Date.parse(end.utc),ws=window.start_epoch*1000,we=window.end_epoch*1000;
cond.sample_times&&=samples.every((s,i)=>t(s)>=t0&&t(s)<=t1&&(!i||t(s)-t(samples[i-1])<=45000))&&t1-t0<=1920000&&!!samples[0].host?.boot_id&&new Set(samples.map(s=>s.host?.boot_id)).size===1;
cond.workload_outcomes&&=[0,1,2,3,4,5].every(k=>requests.some(x=>Date.parse(x.utc)>=ws+k*3e5&&Date.parse(x.utc)<ws+(k+1)*3e5));
cond.concurrent_incident&&=samples.some(s=>t(s)>=ws&&t(s)<=we&&(s.models??[]).some(m=>m.unit===unit));
```
If the frozen collector doesn't record `boot_id` or per-request `utc`, list that as an explicit limitation instead of passing silently.

**W4. A rename can bypass the exemption.** `git diff --name-only` prints only the new name of a renamed file. Renaming e.g. `scripts/m9/collection.mjs` to `scripts/m9/resource-reuse.mjs` would hide the deleted non-exempt file, and `sameCode` would pass. Fix: add `'--no-renames'` to the `sameCode` diff.

**W5. `normalBinding` will likely make reuse fail even with good evidence.**
- `get()` passes `''` for `.json` inputs, but `normalBinding` passes the whole rendered compose JSON to `collectorSources` (`scripts/m9/collection.mjs:18`, `:34`).
- Any `commit` or `source_commit` key in the compose then yields either `''` (pretty-printed `": "`) or a foreign SHA. `inputsBound` becomes false.
- Fix: pass `/\.json$/.test(key)?'':text(key)`.

**W6. The reuse binding is too broad.**
- `reusedBinding` matches on file name only, so any M8 test whose input is `…/soak.txt` or `…/redis-soak.txt`, at any depth, gets the historical binding.
- It would also stop a later, justified fresh soak from binding through receipts.
- Fix: require the exact path `evidence/M9/regression/M8/raw/<name>`, and limit it to the approved test IDs (S01, S02, S04, S05, plus O04 if intended).

**W7. The new tests aren't recorded anywhere in acceptance.**
- The 7 passing evaluator tests aren't recorded in acceptance.
- `sameCode(rootSource)` accepts the root-fixture run from `82a1153`, which couldn't have included `tests/contracts/m9-resource-reuse.test.mjs`.
- Fix: require a test record with `source=<head>` for this file.

## Suggestions
- **More checks:**
  - Add M8-S05 to `accepted_checks`, since AC16 requires it.
  - Pin `evidence/M8/INTERPRETATION.md`, which the assessment lists as a historical input.
  - Check that every source found in `soak.txt` is `6366dd8`, rather than only labelling `historical_execution_source`.
  - Compare the sample service names with the compose service set, not just a count of 15.
- **Smaller fixes:**
  - Require `Number.isFinite(x.ms)` before computing percentiles.
  - Check swap and OOM for the incident unit if the sampler records them.
  - Hash historical files as Buffers rather than utf8 strings.
  - Cache `sameCode` results; it runs git once per sample.
- **Tests:**
  - The compose test reads the untracked M6 regression compose and the working-tree M8 file, while the verifier uses the `55d756` copy and the M8 regression compose.
  - Add mutation tests for C1, C2, W3 and W4.
- **Operational:** M9-CURRENT requires `source_commit===head`. After committing the three files, re-collect `evidence/M9/current/versions.json` (read-only), or that row fails.

## Good Practices
- Historical bytes are pinned by SHA-256 and are never relabelled as a current run (`evidence_mode`, `execution_source`).
- The exemption is an exact list of three paths, and an empty list returns false. Collectors, incident scripts and services stay outside it.
- Every condition must be strictly `true`. Parse and git errors fail safe.
- The compose comparison is canonical and strict. Only five listed incident env/mount additions are allowed, with exact host source, `create_host_path:false` and per-mount read-only settings. The core image is still compared.
- Every sample's commit, the meta/end commits and the workload commit are source-checked, and `paid_dispatch` is checked on every sample.
- Running the legacy verifiers with `FCPI_M8_EVIDENCE` keeps the accepted `evidence/M8/verification.json` from being overwritten. If it is overwritten, `accepted_bytes` catches it.

## Verdict
**CHANGES REQUESTED.**
- **Before acceptance:** fix C1 and C2.
- **Before the targeted run's evidence is evaluated:** fix W2 and W5, since they would make it fail even with good evidence.
- **Then:** regenerate the assessment hash and add mutation tests.

The reuse approach still holds; no finding justifies a second 24-hour soak. The targeted 30-minute run and the incident invocation remain NOT_RUN.
