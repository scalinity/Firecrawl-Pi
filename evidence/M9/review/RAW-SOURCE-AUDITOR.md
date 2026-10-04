## Code Review: M9 collector-source binding

The native report used a different layout despite the requested format. This saved view maps its categories to /review without changing the original findings; the ORIGINAL report remains beside it. Exact model and raw-result provenance are saved separately.

I've finished the review. `/review` has no single fixed layout, so I used Critical / High / Medium / Low / Nits with **None** for empty categories. I didn't edit anything, run git or tests, or use the network. Commit ancestry is inferred from the evidence stamps only.

### Summary

The concern holds. `scripts/m9/verify.mjs` binds each current regression row to the commit the legacy verifier ran at, not to the commit the collector actually exercised. M9 runs those verifiers itself at HEAD, so the stamp always equals HEAD and the `sameCode` check always passes. An old raw can therefore be counted as current after the runtime has changed, and the gate can return `ACCEPTED` when it shouldn't.

### 🔴 Critical Issues (Must Fix)

**C1. Current regression binding uses the verifier's commit, not the tested source (reachable false acceptance)**

How it happens:
1. `scripts/m9/verify.mjs:26-32` re-runs `scripts/m{2..8}/verify.mjs <ids>` at HEAD against `evidence/M9/regression/M{m}/`.
2. Each legacy record takes `...repo` from `repoState()` (`scripts/m8/verify.mjs:943,948`; `scripts/m0/lib.mjs:21`): `repository_sha = git rev-parse HEAD`. That is the verifier's checkout. The raw's own stamp is never read.
3. `get()` (`scripts/m9/verify.mjs:33`) sets `source_commit: rec.repository_sha ?? …`, so the value is always HEAD.
4. `bound` (`scripts/m9/verify.mjs:37`) is `sameCode(HEAD) && config_or_fixture_hash`. `sameCode(HEAD)` is always true, so in practice binding only checks that the hash is non-null.
5. The one guard against stale raws in the legacy verifiers is each milestone's G01-style `deployed_code_is_head`:
   - M8: `scripts/m8/verify.mjs:289-292`
   - M4–M7: `scripts/m4/verify.mjs:214-227`, `scripts/m5/verify.mjs:216-222`, `scripts/m6/verify.mjs:223-230`, `scripts/m7/verify.mjs:278-283`
   - M3: `scripts/m3/verify.mjs:209-219`

   None of these are in `fresh`, and all of them also require milestone image labels (e.g. `fcpi/<img>:m8`). The M8 one currently shows `"state": "NOT_RUN", "actual": "never run"` at `evidence/M9/regression/M8/verification.json:14-17`.

The evidence already shows the gap:
- `evidence/M9/regression/M8/raw/faults.txt:2` was stamped `deployed_commit 591dff2…`.
- `evidence/M9/regression/M8/verification.json:270-281` records M8-I08 as PASS with `repository_sha 6e43824…`.

So the raw and its recorded source already disagree.

Your scenario: operations raw S (faults at 591dff2), then commit H changes the supervisor tick runtime, then a fresh incident/native read at H. M9 at H re-stamps I08–I11 with H, so `bound=true` and AC23 passes. M9-INCIDENT also passes because its own `source_commit` is H. If everything else is PASS, the result is `ACCEPTED`, even though no fault was injected against H.

**Proposed minimal patch (M9 only; accepted raw untouched; the `sameCode` path set is unchanged for verifier stamps):**

```diff
--- a/scripts/m9/verify.mjs
+++ b/scripts/m9/verify.mjs
@@ -3 +3 @@
-…import{readFileSync,writeFileSync,existsSync}from'node:fs';…
+…import{readFileSync,writeFileSync,existsSync,readdirSync}from'node:fs';…
@@ -6,0 +7,6 @@
+// A raw regression proves the source its collector stamped, not the verifier's
+// HEAD. Pure verifiers never run on the collection path; image build sources
+// (FCPI_SOURCE_COMMIT, repository_commit, built_from_commit) are not collector stamps.
+const runSame=s=>{if(!/^[0-9a-f]{40}$/.test(s??''))return false;try{git('diff','--quiet',s,head,'--','services','deploy','scripts','tests','patches',':(exclude)deploy/versions.lock.json',':(exclude,glob)scripts/m*/verify.mjs');return true;}catch{return false;}};
+const walk=d=>existsSync(d)?readdirSync(d,{withFileTypes:true}).flatMap(e=>e.isDirectory()?walk(join(d,e.name)):[join(d,e.name)]):[];
+const tested={};for(const m of [2,3,4,5,6,7,8])tested[m]=[...new Set(walk(`evidence/M9/regression/M${m}`).filter(p=>!/(^|\/)initial-|verification\.json$/.test(p)).flatMap(p=>[...text(p).matchAll(/(?<![A-Za-z_])(?:(?:end_)?source_commit|deployed_commit|"commit")[=":]+"?([0-9a-f]{40})/g)].map(x=>x[1])))];
@@ -33 +39 @@
-…source_commit:rec?.repository_sha??rec?.source_commit??null,config_or_fixture_hash:…
+…source_commit:rec?.repository_sha??rec?.source_commit??null,collector_commits:old?null:tested[m],config_or_fixture_hash:…
@@ -37 +43 @@
- const bound=current.every(x=>sameCode(x.source_commit)&&x.config_or_fixture_hash);
+ const bound=current.every(x=>sameCode(x.source_commit)&&x.config_or_fixture_hash&&x.collector_commits.length>0&&x.collector_commits.every(runSame));
```

Why this patch is safe:
- **Matches the stamps actually present.** It picks up `source_commit=`/`"source_commit":"…"` (M2/M3/M7/M8 raw), `deployed_commit` (M3–M8 e2e, `watchdog-live.txt`, `supervisor-rerun.txt`), the `"commit"` in M8 faults line 149, `end_source_commit`/`source_commit` in `run.json` (the Mac driver), and `M2/unit-tests-provenance.json`.
- **Leaves image build sources out.** The uppercase `FCPI_SOURCE_COMMIT` (`M7/raw/stack.txt:39,42,178,297`) and `repository_commit` don't match, so image provenance stays separate and no older `:mN` labels or rebuilds are required.
- **Skips retained earlier attempts.** It ignores `initial-*`; no verifier reads those (no `initial-` reference under `scripts/`). It also skips verifier outputs.
- **Excludes only pure verifiers.** The only exclusion is `scripts/m*/verify.mjs`. Nothing imports them (checked). `scripts/m9/evidence-checks.mjs` stays in scope because `scripts/m9/incident-live.mjs:4` imports it, which puts it on a collection path. This follows the precedent at `scripts/m3/verify.mjs:209`. If you want strict equality instead, drop that exclusion. The cost is that every M9 verifier commit then forces full re-collection.
- **Conservative failure mode.** Binding is per milestone, not per test, so a stale raw that a selected test doesn't use gives `NOT_RUN`, never a false PASS.
- **Expected effect.** Today's stamps (f2b2593, 27f29d1, 7724ec4, de9164d, e683c91, 591dff2, 68c6c1e, 14de77b) will likely leave several ACs `NOT_RUN` until re-collected. That is the honest result.
- **Not run.** I haven't executed this patch.

### 🟡 Warnings (Should Fix)
None

### 🟡 Warnings (Should Fix)

**M1. Raws with no collector stamp are covered only through their sibling files.** Examples: `M3/raw/lan-probe.txt`, `sdk-compat.txt`, `tailnet-check.txt`, `e2e-state.json`, `M4/raw/e2e-state.json`, `M8/raw/faults.err`. The 40-hex values in `M8/reboots/driven-20261003T103943Z.txt:2` are unlabelled and also ignored. Binding each test exactly would need the legacy verifiers to output their `inputs` lists, which is outside this M9-only fix.

**M2. `run.json` manifests can't be required as the binding.** `scripts/m9/regression.mjs:16` overwrites them on every run. `M3/run.json` lists auth–cancel at 31ecbf4 (cancel `exit_code 1`), but the current `e2e-cancel`/`crash`/`expiry`/`cli` raws are stamped de9164d with no manifest. `M8` has no `run.json` at all. The patch therefore uses them only as extra stamps. Also, the raw `deployed_commit` is the Pi's checkout: if a Mac driver ran with a different uncommitted or reverted variant, nothing records it.

### 🟡 Warnings (Should Fix)

**L1. Misleading field name.** `acceptance.json` reports the verifier's HEAD as `current[].source_commit` (`scripts/m9/verify.mjs:33`). Rename it to `verifier_commit` so readers don't take it for the tested source.

**L2. `code_dirty` isn't read per record.** `get()` ignores each legacy record's `code_dirty`. This is currently harmless because line 69 checks the same tree in the same run.

### 🔵 Suggestions (Consider)
None

### ✅ Good Practices

- Current partial states and immutable initial evidence remain visible.
- Immutable image provenance stays separate from actual test-source attribution.

### Verdict

[x] ❌ Request Changes (critical source-binding defect)
[ ] ⚠️ Approve with Suggestions
[ ] ✅ Approve
