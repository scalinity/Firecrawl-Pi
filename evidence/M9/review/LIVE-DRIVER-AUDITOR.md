## Code Review

### Summary
The delta fixes the two rejected fields: scrape bodies now use `maxAge:0`/`storeInCache:false`, and extract moves the key into the `x-idempotency-key` header. Preflight now runs through the gateway's real `validateBody`, and the driver exits nonzero unless the corpus reaches 20/20 completed and ≥18 usable and all five research steps succeed. Old corpus and research evidence are invalidated by `sameCode(…, false)`.

Three pre-dispatch gates still let a fresh paid run start without proper authority, or spend authority on evidence that cannot be accepted.

### Critical Issues

**C1. The review gate accepts the stale REVIEW.md.** `scripts/m9/live.mjs:10`
- The failed first run already passed `review.includes('Remediation complete')`, so the unchanged REVIEW.md still admits paid dispatch.
- That means paid calls are not held until *this* review is remediated.
- **Fix:** require `reviewVerdict(review).complete && reviewVerdict(review).returned.length===0`, and require REVIEW.md to name the current `git rev-parse HEAD` (or the sha256 of `live.mjs` and `live-contract.mjs`). Throw otherwise.

**C2. The closed window's consent is still accepted.** `scripts/m9/live.mjs:14-15`
- The only checks are `scope==='M9 acceptance'` and `expires_at > now`.
- The record says the first window CLOSED "despite unused time", so its `consent.json` can still be unexpired. Re-running the driver inside that remaining time dispatches paid calls under a window that cannot reopen.
- The driver also never enforces the 45-minute bound (`expiry-start<=2700000`). That bound is only checked afterwards, in `liveCloudVerdict`.
- **Fix:** before line 16, read `evidence/M9/work/live-window.json` and throw unless `Date.parse(consent.issued_at) > Date.parse(window.closed_utc)`. Also throw if `Date.parse(consent.expires_at)-Date.parse(consent.issued_at) > 2700000`.

**C3. Preflight checks the local manifest, not the deployed one.** `scripts/m9/live.mjs:9,19`
- `validateLiveRequests` reads the local `deploy/policies/capabilities.json` and local `validate.mjs`.
- `testedSource` is read from the Pi only after preflight and consent, and is never compared to HEAD.
- Failure trace: if the Pi still runs `909d997…` while HEAD contains this fix, the driver spends the fresh grant. Then `verify.mjs` computes `sameCode(rawCorpus.source_commit,false)` over a diff containing `scripts/m9/live.mjs`, gets false, and reports `M9-CORPUS` and `M9-RESEARCH` as FAIL. The single authorization is burned.
- **Fix:** before line 14, throw unless `pi('cat /opt/firecrawl-pi/.fcpi-source-commit').trim()===git rev-parse HEAD` and `git status --porcelain` is empty.

### Warnings

**W1. Accepted corpus/research evidence is not tied to the audited window.** `scripts/m9/verify.mjs:78,84`
- `corpusOk` and `flowOk` never compare `corpus.utc` or `flow.utc` with `live-window.json`.
- `liveCloudVerdict` claims the audit covers "every authorized live operation". But a run under consent A (reachable via C2) combined with a separately recorded window B passes both checks, while B's Cloud-log audit never covered the paid calls.
- **Fix:** require `started_utc ≤ Date.parse(corpus.utc), Date.parse(flow.utc) ≤ required_work_finished_utc` for the window in `evidence/M9/work/live-window.json`.

### Suggestions
- `tests/contracts/m9-live.test.mjs:24`: `cacheMode` is injected into `research[0]` (search), but the actual 400s came from the scrape bodies (`corpus[*]`, `research[2]`). Inject into `corpus[0]` and `research[2]` so the test regresses the real failure.
- `scripts/m9/live.mjs:24`: `const url=…` is dead now that bodies come from `plan`. Remove it.

### Good Practices
- `liveRequests` is the single source of every dispatched body, and every request passes the gateway's own `validateBody` before any I/O.
- `liveExitCode`/`researchComplete` fail closed on non-2xx responses, a missing poll, a non-`completed` job, empty search/map/markdown, a missing receipt id, a null title, and incomplete corpus counts. The tests cover each case.
- `sameCode(…, false)` invalidates old corpus/research evidence. Independent M2–M8, incident, client and resource evidence stays equivalent, while collectors, services, the lock file and incident scripts remain non-equivalent (tested).
- Raw responses stay in the owner-only directory with mode 0600. The token comes from the Keychain and goes only to the Tailscale HTTPS origin.
- Resource reuse is unchanged: no repeat 24-hour soak, and the 30-minute targeted proof stays bound.

### Verdict
**CHANGES REQUIRED.** Fix C1–C3 (and W1) before any fresh owner authorization or paid dispatch. The cacheMode/idempotencyKey repair and the nonzero exit are correct as written.
