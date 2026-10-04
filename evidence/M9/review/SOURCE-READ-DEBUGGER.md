# Review: M9 delta adding a hash-bound source-read proof to incident acceptance (vs `68c6c1e`)

## Summary
I read every changed file and the code that calls into them: `incident-prepare.sh`, `incident-control.sh`, `incident-hook.sh`, the private-file helpers in `verify.mjs`, and `scripts/ops/tick.sh`. The delta does what it claims:
- The prompt now names exact files to read.
- Acceptance additionally requires a private transcript whose SHA-256 matches the proof. In that transcript, a `Read` call on `$W/tree/scripts/ops/tick.sh` must be paired by id with a successful, line-numbered `tool_result` that contains `queue_unreadable`.
- No hook rule, tool, unit property, model, resource, source or auth check was loosened.

I found no way for this to accept a run that should fail, and no security loss. There is one fail-open evidence gap in the live recorder, and one format assumption that could fail a genuine run.

## Critical Issues
None

## Warnings
1. **A missing transcript aborts `incident-live.mjs` before the proof is written, so the failed run leaves no record.**
   - **Trace:** `scripts/m9/incident-live.mjs:16` calls `pi(...cat .../${session}.jsonl)` without a try/catch. `execFileSync` throws on a non-zero exit, which happens when:
     - `incident-agent.sh` exits before the CLI writes a session file (bad or expired token, CLI crash, early failure of the systemd namespace setup), or
     - `session-id` can't be read, so the path becomes `.../.jsonl`.
   - **Effect:** the script dies after writing `<id>.json` (line 15) and before writing `evidence/M9/incident-proof.json` (line 22). The previous proof stays in place. That isn't a false acceptance: the old proof has no `transcript_sha256`, so `incidentVerdict` returns false. But the held daily launch is used up and the failure is never recorded, which the raw-result path (line 14) deliberately avoids.
   - **Smallest patch** (same pattern as `raw`):
     ```js
     let transcript='';try{transcript=pi(`sudo -n cat /var/lib/firecrawl-pi/incidents/work/${id}/run/auth/projects/-var-lib-firecrawl-pi-incidents-work-${id}-empty/$(sudo -n cat /var/lib/firecrawl-pi/incidents/work/${id}/session-id).jsonl`);}catch{}
     ```
     An empty transcript then fails `incidentSourceRead`, because `JSON.parse('')` throws. So the proof is written as `IMPLEMENTED_UNVERIFIED` with an honest hash.

## Suggestions
1. **Confirm the line-number format before spending the held launch.** `scripts/m9/evidence-checks.mjs:40` expects lines like `^\s*\d+\t`. Some Claude Code versions have rendered Read output as `     N→line` (U+2192 arrow). The pinned CLI (2.1.283, `deploy/versions.lock.json`) has never produced a successful Read in a recorded transcript; the last run's reads were all denied. So the format is untested against the real binary. If it uses the arrow, a genuine read fails closed and the launch is wasted.
   - **Option A:** check a local transcript from the same CLI version.
   - **Option B:** accept both forms: `/^\s*\d+(?:\t|→)/m`.
   - I couldn't check this myself: the private store is outside this review's read scope.
2. **The Read result may not be a plain string.** The check requires `typeof c.content==='string'`. If the CLI ever records a Read result as an array of `{type:'text'}` blocks, that also fails closed. It's worth checking against the same sample as Suggestion 1.
3. **Process note:** the delta touches `scripts/` and `tests/`. That means:
   - `sameCode(proof.source_commit)` requires commit and redeploy before the live run.
   - `incident-live.mjs:8` refuses to run if the deployed commit differs from HEAD.
   - `deploy.sh` refuses to deploy while these tracked changes are uncommitted.

   Per the deployed-code cascade, do a dry run of the verifier first.

## Good Practices
- **Tool calls and results are paired by id**, not just by finding a string. Denied reads are excluded by `is_error!==true` together with the line-number check, and the tests cover a mismatched id, an error result, a wrong incident path, a denied-style message and invalid JSONL.
- **The transcript is hash-bound** to the public proof (`transcript_sha256`). The test that appends one space and the test with an all-zero hash show that editing either side breaks acceptance.
- **`incidentVerdict(raw,proof)` without a transcript now returns false.** Old callers can't silently skip the new requirement.
- **The transcript can't be forged from inside the run.** It sits under `$W/run/auth`. `$W/run` is writable by the unit, but `incident-hook.sh:31-38` only allows Write/Edit under `$W/tree`.
- **Privacy:** `backup.sh:160` already excludes `run/auth/**`, so the transcript is never backed up. It is stored privately with mode 0600 and kept out of Git.
- **The derived path is correct.** It matches `CLAUDE_CONFIG_DIR="$W/run/auth"` (`incident-prepare.sh:92`) and cwd `$W/empty` (`incident-agent.sh:10`).
- **The hook tests pin the contract:** `tick.sh` is allowed (`scripts/ops/*`), while the tree directory and `README.md` are denied, as in the earlier run.
- **The named files exist:** `tick.sh` declares `queue_unreadable` at line 151 (220 lines total, well within one Read), and `status.sh`, `probe.sh` and `lib.sh` are all present.
- **Out of scope here:** nothing in this delta touches M2, production paid settings, or automatic-investigation enablement.

## Verdict
- [ ] Approve
- [x] Approve with warnings (fix Warning 1; settle Suggestion 1 before using the held launch)
- [ ] Request changes
