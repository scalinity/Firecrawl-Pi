## Review: final unpaid rechecks and compound corpus proof

**Verdict:** No Critical finding. I found no reachable false PASS. Hold dispatch until H1 and M2 are fixed. Both fail closed today, but H1 makes the ≤3-attempt invariant unprovable after a crash, and M2 can burn the last attempts.

### H1 High: a crashed final run drops its attempts from the proof
`work/final-unpaid-plan:15`, `scripts/m9/verify.mjs:78-80`

Trace:
1. The private raw is created with `wx`.
2. `call()` dispatches P01, which is its third attempt.
3. Either the gateway timeout rejects, or the correlation `pi()` throws on an ssh/jq error.
4. The process exits before writing the public record.
5. The item is pushed only after the response arrives, so the raw shows nothing in flight.
6. verify sees `finalRecheckRecord===null` and `existsSync(finalRecheckPath)===false`, so it silently verifies the prior-only lineage.
7. If the partial raw is moved aside (the `live/history/` pattern) and the producer is rerun, P01 spends a fourth attempt and the chain still verifies as 1+1+1.

Patch:
```js
// producer loop: record intent before dispatch (replaces post-call push)
const item={id:targets[i].id,request:bodies[i]};raw.results.push(item);fs.writeFileSync(privatePath,JSON.stringify(raw),{mode:0o600});
const response=item.response=await call(bodies[i]),id=response.json.data?.metadata?.scrapeId;
// verify.mjs:80 (also fixes M1)
const finalPrivate=existsSync(join(privateRoot,'live/corpus-final-rechecks.json'));
const corpusOk=((existsSync(finalRecheckPath)||finalPrivate)&&!finalRecheckRecord)||((existsSync(recheckPath)||finalRecheckRecord)&&!recheckRecord)?false:recheckRecord?recheckOk:(…legacy…);
```
Residual risk: deliberately deleting the private raw remains undetectable.

### M1 Medium: a missing or `null` first-recheck record falls back to the legacy single batch
`scripts/m9/verify.mjs:79-80`

If `corpus-rechecks.json` is `null` or deleted while the final record exists, `recheckOk` becomes `null`. The existing guard covers only the final record, so `recheckRecord?…:legacy` evaluates `live/corpus.json` with no recheck lineage and no attempt accounting. It fails today only because the merged `corpus.json` happens to mismatch the initial raw. The combined patch in H1 fixes this.

### M2 Medium: single-shot correlation can permanently FAIL the corpus
`work/final-unpaid-plan:15`

The producer does one `docker logs --since <Mac clock>` read with no retry. Clock skew between the Pi and the Mac, or a log flush after the response, gives `found.length!==1`. The item is then unbound and the whole compound proof is false. All four targets would be at 3/3, and `wx` blocks a rerun. The unique `logical_id` keeps the match exact, so it is safe to widen the window and poll:
```js
const since=new Date(Date.parse(response.started_utc)-120000).toISOString();
let found=[];for(let k=0;k<5&&!found.length;k++){if(k)await new Promise(r=>setTimeout(r,2000));found=events(since).filter(e=>e.logical_id===id);}
```
A related case: an error body without `metadata.scrapeId` (for example, an action rejection) turns a target that should count as unusable into a FAIL of the whole proof. Confirm the gateway returns `scrapeId` on errors before dispatching.

### L1 Low: `caps_zero` can be vacuously true
At `work/final-unpaid-plan:9`, `.filter(c=>c.paid).every(…)` is true when no entry is marked paid. Use `paid.length>0&&paid.every(…)`. The ledger-key equality check mitigates this.

### L2 Low: `max_attempts` is not validated
In `corpusRecheckVerdict` (`scripts/m9/resource-reuse.mjs`), `spent[i]+used>undefined` evaluates to false, so a missing cap never rejects. Prepend `!Number.isInteger(target.max_attempts)||`. The frozen spec currently defines the field.

### L3 Low: Cloud scans are not pinned to one container
The before and after audits are differenced without comparing their `container=… started_at=…` line (as in the live-Cloud fixture). If the container is recreated mid-batch, the old container's lines are lost. Require identical identity lines in both scans.

### L4 Advisory: `includeTags:['h1']` can only narrow the markdown
The criteria are positive regexes. If the prior P01/P02 markdown was non-empty and lacked the required text, the final static attempts cannot pass. Check the prior private raws before dispatching. Separately, the producer's `usable` calculation (`:18`) ignores cumulative attempts.

### Test gaps
In `tests/contracts/m9-resource-reuse.test.mjs`, these cases are not covered:
- A final batch sent with the profile-1 body.
- A prior batch sent with the profile-2 body.
- A final batch reusing a prior `scrapeId`.
- A `prior_record_sha256` mismatch.
- Paid/Cloud mutations on the prior batch inside the chain.
- An absent `max_attempts`.

The verify.mjs branch selection (H1/M1) has no tests.

### Checked, no issue found
- Profile assignment by batch position matches the producer bodies under `canonical`.
- The window chain is ordered: initial close < prior < final, with every response inside its batch window.
- Each batch checks paid posture, ledger-key equality, `cloud_host=0`, and an acquisition delta of at least 4.
- Source equivalence uses `independent=false` for both batches.
- The prior raw and record hashes are bound.
- Cumulative attempts include the original acquisition.
