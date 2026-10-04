## Code Review: M9 source receipts

### Summary
The receipt prototype fails closed on hashes, exit codes, clean spans and the verifier revision. I found one reachable false-acceptance: a stale soak can pass because its source stamp is named `commit`, which the stamp parser ignores. I also found one path bug that stops every directory input from ever binding, which blocks AC15.

### 🔴 Critical Issues (Must Fix)
1. **The soak's start-commit stamp is never read, so a stale or mixed-code soak passes S01/S02 (AC16)**
   - **File:** `scripts/m9/collection.mjs:18` (stamp producer: `scripts/m8/pi-soak.sh:21-22,40`)
   - **Problem:** `collectorSources` only recognises the keys `source_commit`, `end_source_commit` and `deployed_commit`. The soak's first frame is `### meta` followed by `{"run":…,"commit":"<sha at soak start>",…,"collected_utc":…}`. Its only stamp is under `commit`, so `embedded_sources` comes back as `[]`.
   - **Risk trace:**
     1. A soak is started on the Pi at code A (or one is still left in `/var/lib/firecrawl-pi/soak/current.json`).
     2. Fix commit B is committed and deployed.
     3. `collect-input.mjs M8 soak raw/soak.txt -- ssh … 'bash /opt/firecrawl-pi/scripts/m8/pi-soak.sh collect <run>'` runs in seconds. The receipt span covers only this read: before and after are both B and clean, exit is 0, and the hash matches.
     4. `collectionVerdict` checks the four span commits plus `[]`, so `bound=true`.
     5. M8-S01 and M8-S02 PASS on a soak recorded under code A. M9 counts this as fresh, which is exactly the "old raw attested by hashing" case M9 must reject.
   - **Fix code:**
     ```js
     return [...first.matchAll(/(?<![A-Za-z_])(?:source_commit|end_source_commit|deployed_commit|commit)[=":]+"?([^\s",]*)/g)].map(x=>x[1]);
     ```
     The lookbehind still excludes the `commit` inside `source_commit`/`end_source_commit` (it is preceded by `_`) and prefixed image keys. Add to `tests/contracts/m9-collection.test.mjs`:
     ```js
     assert.deepEqual(collectorSources(`### meta\n{"run":"soak-x","commit":"${old}"}\n### end\n`),[old]);
     ```

2. **Directory inputs can never match a receipt, so M8-R01 (AC15) can never PASS**
   - **File:** `scripts/m9/verify.mjs:38`, with `scripts/m9/collect-input.mjs:11,26`
   - **Problem:** M8-R01 declares `${EV}reboots/` with a trailing slash (`scripts/m8/verify.mjs:391`), so its `input_paths` holds `evidence/M9/regression/M8/reboots/`. `collect-input` builds the receipt path with `resolve()`, which drops the trailing slash and stores `…/M8/reboots`. The exact `x.path===input` filter therefore finds no receipt.
   - **Risk trace:** `get(8,'R01')` → `matches=[]` → `attributed=false` → `tested_bound=false` → AC15 `bound=false` → `NOT_RUN`, whatever was collected. Any other `/`-terminated input behaves the same way.
   - **Fix code (`scripts/m9/verify.mjs:38`):**
     ```js
     const bindings=inputPaths.map(input=>{const key=input.replace(/\/$/,''),matches=receipts.filter(x=>x.path===key);try{const isText=!input.endsWith('/')&& !/\.json$/.test(input);return {path:input,...collectionVerdict(key,matches.length===1?matches[0]:null,inputHash(key),isText?text(input):'',sameCode)};}catch{return {path:input,attributed:false,bound:false};}});
     ```
     Equality stays exact; only the directory spelling is normalised. Add a contract test that uses a directory receipt.

### 🟡 Warnings (Should Fix)
1. **A receipt does not tie the input to its real producer.**
   - **Problem:** The receipt never records which command ran, and the verifier never reads the private argv record. So `collect-input … rendered-compose.json -- cat evidence/M8/rendered-compose.json` gets a fresh receipt for old bytes. The same works with `cp -R` for `reboots/`, and for any text input whose first frame has no stamp. The contract test explicitly allows "unstamped inputs need receipts" to bind on the receipt alone.
   - **Suggestion:** Add `private_record` (the file name) and `command_sha256` to the receipt. Make `collectionVerdict` require that the private record exists, hashes to that value, and names the same path and sha. Whether to add a per-input producer allowlist is a separate owner decision.
2. **The receipt span does not cover state that piled up on the Pi before collection.**
   - **Problem:** `pi-redis.sh stats` (S04 `redis-measured.txt` and `redis-soak.txt`) reports counters accumulated since an unrecorded `reset`. The stamp only shows the commit at read time, so a workload run under older code passes.
   - **Suggestion:** Record the reset's UTC and `source_commit` in a marker on the Pi, print it in the `stats` meta frame as `start_source_commit=`, and add that key to `collectorSources`.
3. **Long producers are killed, and the closing check is fragile.**
   - **Problem:** `scripts/m9/collect-input.mjs:20` uses a 3 h `spawnSync` timeout, which kills `window.sh` and any producer that has to wait for a soak. Line 24 reads the after-span over SSH once with no retry; on this Pi's Wi-Fi, one dropped connection throws and loses the receipt for the whole run. Both fail closed but can never succeed.
   - **Suggestion:** Make the timeout an option, with none by default (the run itself goes detached). Retry `source()` a few times, as `window.sh`'s `retry()` does.
4. **Inputs outside the regression root are silently dropped.**
   - **Problem:** `scripts/m9/verify.mjs:37` filters to `p.startsWith(base)`. For the selected checks this only drops tracked policy files read at HEAD. But any check that declares another milestone's raw (`evidence/M7/...`, as B00, G01 and X04 do) would bind on its other inputs alone.
   - **Suggestion:** Set `tested_bound=false` when a dropped input is under `evidence/`, or when it is not tracked and clean at HEAD.
5. **M5-D03 has an undeclared input.**
   - **Problem:** `scripts/m5/verify.mjs:491` reads `${RAW}parser-result.json` when it exists, and that file can supply the `complex` condition. It is not in `inputs`, so it is never receipted. Its effect is limited because it is checked against `e2e-live.txt`'s sha and logical id.
   - **Suggestion:** When the file exists, add it to `rec.input_paths` so M9 requires a receipt for it.
6. **Stdout mode does not keep exact bytes.**
   - **Problem:** `encoding:'utf8'` (`collect-input.mjs:20`) decodes stdout, so any invalid UTF-8 is replaced with U+FFFD before the file is written and hashed.
   - **Suggestion:** Spawn with `encoding:'buffer'`, write `r.stdout` as is, and decode `stderr` only for the private record.
7. **The dirty check misparses renames.**
   - **Problem:** Porcelain shows `R  evidence/x -> scripts/y`, and `slice(3)` only checks the `evidence/` side, so new code counts as clean. This affects `collect-input.mjs:13`, and the same pattern is at `verify.mjs:75`.
   - **Suggestion:** Use `--porcelain -z`, or check both paths on each side of ` -> `.

### 🔵 Suggestions (Consider)
1. **Where old outputs are moved aside**
   - **Current:** Old outputs are moved to `dirname(path)/initial-collection-*`. For a file collected into `reboots/`, that `.txt` copy stays inside `reboots/`. It then changes the directory hash, and `bootChain` would read it.
   - **Better:** Move them to `base/collection-history/`, outside every declared input.
2. **Side writes from `faults.mjs`**
   - **Current:** `faults.mjs` (receipted as `raw/faults.txt`) also writes `reboots/driven-*.txt`. That changes the hash of a `reboots/` collected earlier, and a later `--written` collection of `reboots/` moves those files away.
   - **Better:** Document the collection order (faults first, then `reboots/`), or receipt `reboots/` from the same run.
3. **Output-path containment**
   - **Current:** Containment is checked on `resolve()`, so a symlinked parent directory can still send writes outside the root.
   - **Better:** Compare `realpathSync(dirname(path))` against `realpathSync(base)` after `mkdirSync`.
4. **Test coverage**
   - **Current:** The tests do not cover directory receipt paths, the `commit` key, or a stamp that appears only after a non-meta first frame.
   - **Better:** Add one assertion for each.

### ✅ Good Practices
- Attribution fails closed: there must be exactly one receipt, exit 0, clean before and after, four 40-hex span commits, and the exact recomputed hash. Any exception sets `bound:false`.
- The previous `verification.json` is moved to history before the verifiers run again, and the legacy runners start from an empty prior, so old summaries cannot come back.
- Directory hashing includes relative names and bytes, and refuses symlinks and special files.
- Only the first metadata frame counts, so stamps inside target content and immutable image build stamps are ignored.
- stderr, and stdout in `--written` mode, go to a 0700/0600 private directory outside Git.
- `collection.json` cannot be used as an output path, and an existing output is moved aside rather than overwritten.

### Verdict
[x] ❌ Request Changes (critical issues)
[ ] ⚠️ Approve with Suggestions
[ ] ✅ Approve
