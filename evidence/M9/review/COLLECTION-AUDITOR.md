## Code Review: M9 source receipts

### Summary
The receipt model holds up: exact hashes, exit code, before/after spans and first-frame stamps are all bound, and old raw cannot be accepted by hashing alone. But three concrete bugs need fixing first: the absolute evidence path sends producer writes outside the M9 root, M8-R01's directory input can never match a receipt, and a staged rename slips past the dirty check.

### 🔴 Critical Issues (Must Fix)

1. **Absolute `FCPI_<M>_EVIDENCE` sends producer state outside the regression root**, `scripts/m9/collect-input.mjs:11` and `:20`
   - **Problem:** `base` is absolute (`resolve(...)`), and the wrapper exports it as `FCPI_<M>_EVIDENCE`. Several producers then call `join(ROOT, EV, …)`, and `join` does not reset on an absolute second argument:
     - `scripts/m3/e2e.mjs:23`
     - `scripts/m4/mcp-e2e.mjs:29`
     - `scripts/m7/e2e.mjs:178`
   - **Risk trace:** `node scripts/m9/collect-input.mjs M3 a01 raw/e2e-jobs.txt -- node scripts/m3/e2e.mjs jobs` sets `STATE=<ROOT><repository-root>/evidence/M9/regression/M3/raw/e2e-state.json`.
     - If that directory doesn't exist, `saveState` fails with ENOENT and exits nonzero, so every M3/M4 e2e phase is unattributable.
     - If it gets created (M7 artifacts), an untracked `Users/…` tree appears outside `evidence/`. Then `after.clean=false`, and every later collection refuses ("Commit code before collecting").
     - Either way the writes leave the selected M9 root. This is also the only path where `<owner-home>` can reach raw output.
   - **Fix:** export the same relative root that `scripts/m9/verify.mjs:33` already uses.
     ```js
     const rel='evidence/M9/regression/'+group+'/',base=resolve(rel).slice(0,-0||undefined).replace(/\/$/,''),path=resolve(base,name??'');
     // …
     const r=spawnSync(command[0],command.slice(1),{env:{...process.env,[`FCPI_${group}_EVIDENCE`]:rel},encoding:'utf8',timeout:10800000,maxBuffer:128*1024*1024});
     ```
     Minimal form: keep line 11 as is, add `const rel='evidence/M9/regression/'+group+'/';`, and replace `base+'/'` with `rel` on line 20. The `scripts/m1/pi-target.conf` read already requires the cwd to be the repo root, so the relative path resolves correctly.

2. **Directory inputs never match their receipt (M8-R01 / AC15 can never be bound)**, `scripts/m9/verify.mjs:38`
   - **Problem:** `scripts/m8/verify.mjs:391` declares `` `${EV}reboots/` `` with a trailing slash. `collect-input.mjs:26` records `receipt.path` via `resolve()`, which strips that slash. So `x.path===input` and `receipt.path===input` are never equal.
   - **Risk trace:** `get(8,'R01')` → `matches=[]` → `attributed=false` → `tested_bound=false` → AC15 is stuck at NOT_RUN, even with an honest receipt for `reboots`.
   - **Fix:**
     ```js
     const bindings=inputPaths.map(input=>{const key=input.replace(/\/+$/,''),matches=receipts.filter(x=>x.path===key);try{const isText=!input.endsWith('/')&& !/\.json$/.test(input);return {path:input,...collectionVerdict(key,matches.length===1?matches[0]:null,inputHash(key),isText?text(input):'',sameCode)};}catch{return {path:input,attributed:false,bound:false};}});
     ```

3. **A staged rename out of `evidence/` passes the clean check**, `scripts/m9/collect-input.mjs:13` (same pattern at `scripts/m9/verify.mjs:75`)
   - **Problem:** porcelain v1 prints renames and copies as `R  evidence/a -> scripts/b`. `slice(3)` starts with `evidence/`, so the entry is treated as evidence-only.
   - **Risk trace:**
     1. `git mv evidence/M9/x.mjs scripts/m5/e2e-helper.mjs` (staged) leaves uncommitted code under `scripts/`.
     2. `before.clean` and `after.clean` are both `true`, and `local=HEAD` passes `sameCode`.
     3. The receipt is attributed, so a dirty span is accepted. The same entry also yields `codeDirty=false` in the acceptance gate.
   - **Fix (both sites):**
     ```js
     .some(x=>x.slice(3).split(' -> ').some(p=>!p.startsWith('evidence/')))
     ```

### 🟡 Warnings (Should Fix)

1. **The Pi span is "clean" by stamp only.**
   - **Problem:** The receipt's `clean` flag covers only the Mac's working tree. On the Pi it records `/opt/firecrawl-pi/.fcpi-source-commit` and nothing else. That stamp is written by `scripts/m1/deploy.sh:66`, so any later hand edit under `/opt/firecrawl-pi` goes undetected, and the requirement for a clean Pi span is not proven.
   - **Suggestion:** Record a deployed-tree digest before and after (sorted `sha256sum` of files except the stamp). Compare it with the same digest computed locally from `git archive <pi>` and require both to match.

2. **One invocation can only receipt one output.**
   - **Problem:** `scripts/m8/faults.mjs:70` writes `reboots/driven-*` while its stdout becomes `raw/faults.txt`. R01 needs both bound. A second `--written` run for `reboots` first renames the directory away (`collect-input.mjs:19`), so there's no honest way to produce that receipt.
   - **Suggestion:** Allow repeated `--also <relative-path>` outputs. Each gets its own receipt sharing the same span and exit code; rename only the primary output.

3. **A stale receipt survives when the wrapper fails after the producer ran.**
   - **Problem:** If the `after` SSH call (`:24`) or the manifest parse (`:25`) throws, the old receipt for that path stays in `collection.json`. If the rerun happens to produce identical bytes, that old receipt reattaches to an unverified run.
   - **Suggestion:** Rewrite the manifest without this path's receipt before `spawnSync`.

4. **An undeclared input in a selected check.**
   - **Problem:** `scripts/m5/verify.mjs:491` (D03, part of AC08) reads `${RAW}parser-result.json`, which is not in `input_paths`, so it is never receipt-bound. Its `input_sha256` link to `e2e-live.txt` limits the damage.
   - **Suggestion:** Emit an `optional_input_paths` field (bound whenever the file exists) rather than adding it to the required `inputs`, which would turn a missing file into NOT_RUN.

### 🔵 Suggestions (Consider)

1. **Stamp parsing scope**
   - **Current:** `collectorSources` discards everything before the first `### `. It returns `[]` when the first frame isn't `meta`/`*_meta`.
   - **Better:** Also scan the preamble before the first frame. Include frame-name mismatches in the binding as `embedded_sources:'unparsed'` so they are visible instead of silently empty.

2. **Reserved output names**
   - **Current:** `name` may be `verification.json` or sit under `verification-history/` (`collect-input.mjs:11`). Parent symlinks are not checked.
   - **Better:** Refuse those names, and `lstat` each parent component under `base`.

3. **Test gaps**
   - **Current:** The tests don't cover trailing-slash directory inputs, rename status lines, or the env path given to producers.
   - **Better:** Add one case for each of the three Critical fixes.

4. **Forged manifests**
   - **Current:** `collection.json` receipts are self-asserted.
   - **Better:** Have `verify.mjs` also require the matching private record (by group, id and time) to exist locally, without reading argv or stderr into Git.

### ✅ Good Practices
- `inputHash` refuses symlinks at every level of the walk and hashes sorted relative names together with the bytes.
- `exit_code` uses `r.status??1`, so timeout, signal, ENOBUFS and spawn errors all fail closed.
- An existing output is renamed before the producer runs, so `--written` producers can't silently reuse old raw (a missing file gives `sha256:null`).
- The previous `verification.json` is moved to `verification-history/` before recomputation, and unrun checks come back as NOT_RUN.
- Embedded stamps are read only from the first controlled frame, so image and target stamps in later frames can't stand in for collector identity.
- argv and stderr go to a 0700/0600 private directory outside Git.

### Verdict
[x] ❌ Request Changes (critical issues)
[ ] ⚠️ Approve with Suggestions
[ ] ✅ Approve
