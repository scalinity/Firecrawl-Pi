# Review: final unpaid four-target recheck and compound proof aggregation

**Scope:** the final-round producer (work/final-unpaid-plan), the compound path in `corpusRecheckVerdict` (`scripts/m9/resource-reuse.mjs`), how `scripts/m9/verify.mjs` wires it in, and the chain fixtures. Nothing else was reviewed.

**Verdict: BLOCK. 1 Critical, 3 Low.** Keep the hold until F1 is patched and has a fixture.

---

### F1 — Critical — `scripts/m9/verify.mjs` (`corpusOk`): an aborted final round silently falls back to the two-round proof

**Trace:**
1. The producer writes `live/corpus-final-rechecks.json` with `wx` before any dispatch.
2. P01 is dispatched.
3. A provider reservation appears, or `call` rejects on timeout, or `status()` fails.
4. The producer throws `Paid/provider dispatch occurred unexpectedly`, or exits on the rejection.
5. Neither `evidence/M9/regression/M8/raw/corpus-final-rechecks.json` nor a new `evidence/M9/corpus.json` gets written.
6. In `verify.mjs`, `finalRecheckRecord===null` and `existsSync(finalRecheckPath)===false`, so `corpusRecheckVerdict` runs on the prior round alone with the unchanged `corpus.json`.
7. M9-CORPUS reports PASS at 15/20.

The consumed third attempts and the paid-invariant breach exist only in the private file, so the binary gate never sees them.

**Same branch:** if the final public record exists but `corpus-rechecks.json` is missing or `null`, the code drops into the initial-only `rawCorpus` path. It should fail explicitly instead.

**Patch:**
```js
const finalPrivatePath=join(privateRoot,'live/corpus-final-rechecks.json'),finalStarted=existsSync(finalRecheckPath)||existsSync(finalPrivatePath);
const corpusOk=finalStarted&&!(finalRecheckRecord&&recheckRecord)?false:recheckRecord?recheckOk:(/* existing initial-only branch unchanged */);
```
The `wx` write happens before any dispatch, so the private file is a reliable "round started" marker. Once started, the round must yield a full public record or the gate stays FAIL. That fits the rule that no fourth attempt exists.

**Fixture:** with the private final file present and the public file absent, M9-CORPUS must be FAIL.

---

### F2 — Low — `scripts/m9/resource-reuse.mjs` (`corpusRecheckVerdict`): receipt uniqueness skips the initial batch

`receipts` is shared across the prior and final batches but starts empty. A final item that reuses an initial-batch `scrapeId`/`logical_id` with in-window timestamps would be accepted. Honest gateway UUIDs can't trigger this; the patch closes a replay path.

**Patch:**
```js
receipts=new Set(initial.results.map(r=>r?.json?.data?.metadata?.scrapeId).filter(Boolean))
```
This stays compatible with the existing fixture, where all initial responses share `receipt-11-12`.

---

### F3 — Low — same function: the Cloud delta isn't pinned to one container

`acquisition` (delta ≥4) and `cloud_host=0` are full-container counts. If the retrieval service restarts mid-batch, the pre-restart segment disappears, including any Cloud hit in it. The delta can still pass when `before` is small or other traffic exists.

**Patch:**
```js
const cid=s=>String(s).match(/^container=\S+ started_at=\S+$/m)?.[0];
// add to the batch guard:
||!cid(r.cloud_audit)||cid(r.cloud_audit)!==cid(r.cloud_audit_before)
```
This assumes the scan emits the `container=… started_at=…` line that the `liveCloudVerdict` fixtures use. Confirm that against `pi-retrieval-log-scan.sh` output before applying.

---

### F4 — Low — work/final-unpaid-plan (producer): cumulative attempts and deployed source aren't verifiable

- **Attempts:** the record's `attempts` and the public `fcpi.attempts` show only the final attempt (1), even for targets that used 3 in total. The producer's `usable` bound is per-response. The evaluator does enforce the ≤3 total, so this is a disclosure gap. Fix: add `cumulative_attempts:a+b+used` to each row of the final record only, leaving `corpus.json` untouched.
- **Deployed source:** the producer checks `.fcpi-source-commit===head` but never records it in `raw`, so the evaluator can't re-verify exact deployed source. Fix: store `deployed_commit` in `raw` and require `r.deployed_commit===r.source_commit` for profile 2.
- **Producer hash:** `producer_sha256` is recorded but never compared to a reviewed hash.

---

### Fixture gaps — `tests/contracts/m9-resource-reuse.test.mjs`

`chain()` has no negative case for:
- (a) the same `scrapeId`/`logical_id` in the prior and final batches;
- (b) a final batch carrying profile-1 requests, or a prior batch carrying profile-2 requests;
- (c) initial `attempts_used=2` with prior and final at 1 each (total 4 > 3);
- (d) after F3, differing container identity lines.

---

### Checked, no finding

- **Uncorrelated or receipt-less items fail closed** through the `!sid` and `logical_id` checks.
- **Retries and duplicates are blocked** because the exact sorted four-ID set is required.
- **Batches are time-ordered:** strict `start>previousEnd` chains initial → prior → final.
- **The prior round is hash-bound:** both its raw text and its public record must match `prior_raw_sha256` and `prior_record_sha256`.
- **Request profile is fixed by batch position.** Copying the prior record in as the final one fails both the profile check and the receipt check.
- **Corrupt public JSON fails closed:** it throws after the `IN_PROGRESS` acceptance write.
- **Paid checks cover both rounds:** posture, ledger-key equality and zero proxy/enhanced cost are checked for prior and final.
- **Source equivalence uses `independent=false`** for both rounds.
