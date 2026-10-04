## Summary

The concern holds, and the false acceptance can actually happen. `scripts/m9/verify.mjs` binds every M2–M8 regression row to `repository_sha`. That value is the commit the legacy verifier ran at (`repoState()` in `scripts/m0/lib.mjs:18-21`), not the commit of the code the raw evidence exercised. Each legacy G01 check has a `deployed_code_is_head` condition that compares the raw stamps against HEAD (M3 `scripts/m3/verify.mjs:209-219`, M4 `:214-227`, M5 `:216-222`, M6 `:223-230`, M7 `:278-283`, M8 `:287-292`). M9 never selects any G01, so that condition never reaches the gate. Today's `IN_PROGRESS` result is honest only because the stored stamps are `6e43824`, one commit behind HEAD `14de77b`. The next run at HEAD restamps every row and clears that.

## Critical

**C1. Regression rows bind to the verifier's commit, not the code that was exercised. A rerun at HEAD binds raw evidence collected at older commits.**

Where: `scripts/m9/verify.mjs:33` (`source_commit:rec?.repository_sha??…`) and `:37` (`bound=current.every(x=>sameCode(x.source_commit)…)`).

Trace using the evidence as it is now:
1. `evidence/M9/regression/M8/raw/faults.txt:2` was collected with `deployed_commit` `591dff27…`. It is the only input of M8 I01–I04, I07–I11, I15, O01–O03 and R02/R03 (`scripts/m8/verify.mjs:391-582`).
2. The M5/M7 `raw/e2e-fixture.txt` files were collected with `deployed_commit` `e683c919…`, and M6's with `de9164dc…`.
3. In `evidence/M9/regression/M{5,6,7,8}/verification.json`, M5-I01, M6-R06, M6-R07, M7-E03 and M8-I08…I11 are all PASS. They are stamped `6e43824…`.
4. AC23 is built from exactly those rows (`scripts/m9/verify.mjs:7,21`). Today it stays `NOT_RUN` only because `sameCode('6e43824…')` against `14de77b` is false.
5. Running `node scripts/m9/verify.mjs` at `14de77b` restarts each legacy verifier at `:26-32`. Every record is then stamped `14de77b`, `sameCode(head)` returns true, and `bound` becomes true. AC23 turns PASS while its fault evidence was exercised at `591dff2`/`e683c91`/`de9164d`, not at HEAD.
6. In your scenario (H changes the tick runtime, then a fresh current collector read at H, e.g. `raw/watchdog-live.txt` or `supervisor-rerun.txt` stamped H), the same path accepts fault rows the code at H never faced. Once the other M9 gates pass, nothing else stops `ACCEPTED`.

Caveat: I could not run `git diff` (Read/Grep only). That `591dff2..14de77b` touches `services|deploy|scripts|tests|patches` is an inference: the two intervening commits are `fix(verification)` commits, and verifiers live under `scripts/`.

Two different sources are being treated as one:
- **Verifier source**: `repository_sha`. This decides whether today's checker logic is current, and it should stay required.
- **Tested source**: the raw stamps (`deployed_commit` = what the Pi ran, `source_commit` = the collector/driver HEAD) plus `run.json` `source_commit`/`end_source_commit`. M9 never reads these for M2–M8.

The fix should keep built-image provenance separate. The `image-build.txt`/`api-build.log` checks with `dirSame` on service directories stay in the legacy G01s, which M9 deliberately skips. None of those files exist under `evidence/M9/regression/`, so the patch below never asks for old `:mN` image labels or rebuilds.

Smallest M9-only fix: require every tested-source commit for the milestone to pass the existing `sameCode`, alongside the verifier stamp.

```diff
--- a/scripts/m9/verify.mjs
+++ b/scripts/m9/verify.mjs
@@ -3 +3 @@
-…import{readFileSync,writeFileSync,existsSync}from'node:fs';…
+…import{readFileSync,writeFileSync,existsSync,readdirSync}from'node:fs';…
@@ -32,2 +32,9 @@
 }
-const get=(m,id,old=false)=>{…source_commit:rec?.repository_sha??rec?.source_commit??null,config_or_fixture_hash:rec?.config_or_fixture_hash??null};};
+// repository_sha is the verifier's checkout; the exercised source is what the raw records and run manifests name.
+// initial-* copies are retained history, not current evidence. Image build provenance stays with the legacy G01s.
+const tested=m=>{const b=`evidence/M9/regression/M${m}/`,r=json(b+'run.json'),p=json(b+'unit-tests-provenance.json'),c=[r?.source_commit,r?.end_source_commit,p?.source_commit];
+ for(const f of existsSync(b+'raw')?readdirSync(b+'raw'):[])if(!f.startsWith('initial-'))for(const x of text(b+'raw/'+f).matchAll(/(?:source_commit|deployed_commit|"commit")[=":]+"?([0-9a-f]{40})/g))c.push(x[1]);
+ const commits=[...new Set(c.filter(Boolean))];return {commits,bound:commits.length>0&&commits.every(sameCode)};};
+const testedBy=Object.fromEntries([2,3,4,5,6,7,8].map(m=>[m,tested(m)]));
+const get=(m,id,old=false)=>{…verifier_commit:rec?.repository_sha??rec?.source_commit??null,tested_commits:old?null:testedBy[m].commits,tested_bound:old?null:testedBy[m].bound,config_or_fixture_hash:rec?.config_or_fixture_hash??null};};
@@ -37 +44 @@
- const bound=current.every(x=>sameCode(x.source_commit)&&x.config_or_fixture_hash);
+ const bound=current.every(x=>x.tested_bound&&sameCode(x.verifier_commit)&&x.config_or_fixture_hash);
```

Properties of this fix:
- Equality is not weakened: it uses the same `sameCode` scope.
- Accepted raw files, the `initial-*` history and the older `evidence/M{m}/` rows are untouched.
- It is per milestone, not per check. A stale stamped raw file in `evidence/M9/regression/M{m}/raw/` blocks all of that milestone's selected refs. It can block too much but never accepts falsely, because legacy records don't list their input paths.
- Rows bound today stay unbound until recollection: M8 `faults.txt`@`591dff2`, `guard-window-open.txt`@`68c6c1e`; M3 run.json `31ecbf4→0f08b34` and mixed stamps; M4 `de9164d`/`e683c91`. That is correct, and it matches the existing redeploy/re-collection cost in G01.

## Major

**M1. Raw files without a stamp still bind only through the verifier stamp.**

Several regression raws carry no commit, and the manifests are incomplete:
- M3: `lan-probe.txt`, `sdk-compat.txt`, `tailnet-check.txt`, `stderr-auth.txt`, `e2e-state.json`.
- M4: `e2e-state.json`.
- M8: no `run.json` at all.
- `evidence/M9/regression/M3/run.json` lists 7 phases in `command`, records only 4 `runs`, and its `cancel` run has `exit_code: 1`.

If a selected check reads one of these files, C1's fix doesn't cover it. Under C1 it is skipped, not falsely bound to a newer commit, but it is still unattributed. A stricter follow-up would require every non-`initial-*` raw file to either carry a stamp or appear in that milestone's `run.json` `runs[]` with a matching `sha256`, with that manifest's commits passing `sameCode`. I can't hash files here, so I haven't checked whether current manifest hashes still match.

## Minor

**m1. Stale `verification.json` can be read if a legacy verifier crashes.**

`scripts/m9/verify.mjs:30-31` only checks `r.error`. In `scripts/m8/verify.mjs:969`, `target()` runs outside the per-check `try`. If `scripts/m1/pi-target.conf` is unreadable, the process exits 1 before `writeFileSync` (`:975`). That exit code looks the same as the normal "some subset failed" exit, so M9 reads the previous file. Its stamps would usually fail `sameCode`, but if HEAD is unchanged in scope while raw was replaced, the stale PASS and hash are used. Fix: record `const t0=new Date().toISOString()` before the loop, and in `get()` require `rec.utc>=t0` for current rows.

## Nits

**n1.** `get()` publishes the verifier commit as `source_commit` in `evidence/M9/acceptance.json`. That name suggests tested source; `verifier_commit` (as in the patch) says what it is.

## Verification notes

- I read `scripts/m9/verify.mjs` in full, M8 G01 and the runner/emission code (`scripts/m8/verify.mjs:279-301, 938-978`), the M3/M4/M5 G01 bodies, all six `run.json` manifests and the M2 provenance file, plus every commit stamp under `evidence/M9/regression/`.
- I made no changes and ran no tests or network calls. The `git diff` scope claim is inferred, as noted in C1.
- The older dated proofs and `initial-*` copies are accurately marked, and the patch leaves them as they are.
