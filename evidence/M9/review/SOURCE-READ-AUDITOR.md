# Code Review: M9 delta against 68c6c1e (paired native source Read proof)

## Summary
I found no critical issues and no false-acceptance path. The new check only passes when one Claude Code session file meets all of these:
- Its hash matches `proof.transcript_sha256`.
- It contains a `Read` call whose `file_path` is exactly `$W/tree/scripts/ops/tick.sh`.
- The paired `tool_result` is not an error and contains a numbered line plus `queue_unreadable`. That text is really in the file, at `scripts/ops/tick.sh:151`.

Every existing check on the resource limits, model, auth and source commit is still required. The new argument is checked first, so if the transcript is missing, empty, unparseable or has the wrong hash, the run is not accepted.

No permissions were widened:
- **Hook:** `scripts/m9/incident-hook.sh` is unchanged. Its Read allowlist already covered `scripts/ops/*`. Directories and `README.md` are still denied, and the new hook tests pin that.
- **Agent:** the tool flags, `--disallowedTools`, the systemd properties and the settings are unchanged. Only the prompt text changed.
- **Transcript path:** `scripts/m9/incident-prepare.sh:92` sets `CLAUDE_CONFIG_DIR="$W/run/auth"`, and the working directory is `$W/empty` (`scripts/m9/incident-agent.sh:10`). That matches the hard-coded project folder `-var-lib-firecrawl-pi-incidents-work-${id}-empty`.
- **Forgery:** the agent cannot write its own transcript. `$W/run` is writable at the OS level, but the hook limits Edit/Write to `incident_writable` paths under the worktree.

The private copy stays outside Git, in a folder created with mode 0700 and a file written with mode 0600. Only its hash goes into `evidence/M9/incident-proof.json`.

One warning: the checker assumes a result format for the pinned CLI that nothing in the repo confirms. A mismatch fails safe, but it would use up the one held daily launch for nothing.

## Critical Issues
None

## Warnings
- **[`scripts/m9/evidence-checks.mjs:40`] The Read result format for the pinned CLI is assumed, not verified**
  - **Trace:** `scripts/m9/incident-live.mjs:16` fetches the real Claude Code 2.1.283 session file (pinned in `deploy/versions.lock.json:2050`). Line 21 calls `incidentVerdict` → `incidentSourceRead`, which needs `typeof c.content==='string'` and `/^\s*\d+\t/m`. The only example of this format is the hand-written test fixture `'151\tqueue_unreadable'` (`tests/contracts/m9-evidence-bound.test.mjs:17`). Nothing in the repo records how this CLI version writes a Read result in its session file. If it writes `     1→…`, or stores `content` as an array of `{type:'text',text}` blocks, a real and correct Read of `tick.sh` scores `IMPLEMENTED_UNVERIFIED`. That spends the one remaining daily launch with nothing to show for it. This can't cause a false PASS, only a false FAIL. I couldn't confirm the format myself: the review hook blocked reads outside the repo.
  - **Proposed smallest patch:** Before releasing the held launch, run a read-only dry check against the previous run's session file on the Pi. That run did complete a Read of `input.json`, so its `tool_result` shows the exact format. If you prefer to change the code instead, accept both known shapes and keep the pairing and `is_error` checks:
    ```js
    const body=c=>typeof c.content==='string'?c.content:Array.isArray(c.content)?c.content.filter(x=>x?.type==='text'&&typeof x.text==='string').map(x=>x.text).join('\n'):null;
    // ... c.is_error!==true&&typeof body(c)==='string'&&/^\s*\d+(?:\t|→)/m.test(body(c))&&body(c).includes('queue_unreadable')
    ```
    Then add one fixture per accepted shape to `tests/contracts/m9-evidence-bound.test.mjs`.

## Suggestions
- **The run record is lost if the transcript fetch fails.** In `scripts/m9/incident-live.mjs:16`, `pi(...)` for the transcript has no `try/catch`, unlike the raw result fetch on line 14. If the file is missing, the script throws after the launch was spent and the raw result was saved privately. It then never writes `evidence/M9/incident-proof.json` and never records `auth_removed`, and the stale earlier proof stays in place. Acceptance still fails safe. Smallest fix: `let transcript='';try{transcript=pi(...);}catch{}`, so the run's record is always written as `IMPLEMENTED_UNVERIFIED`.
- **Deployment order.** `scripts/m9/incident-agent.sh` runs on the Pi from `/opt/firecrawl-pi`, and `scripts/m9/incident-live.mjs:8` refuses to run unless the deployed commit equals HEAD. So this delta has to be committed and deployed before the live run. Per the usual cascade, any later change to the run path means another redeploy and fresh evidence collection.

## Good Practices
- The `tool_use` and `tool_result` are matched by `tool_use_id`. A Read the hook denied (`is_error:true`), a result for a different file, or a different incident ID can't pass. The tests cover each of these cases, plus a missing transcript, a one-byte change (`transcript+' '`) and a zero hash.
- The transcript is hash-bound in the public proof and checked again by `scripts/m9/verify.mjs:56-57` from the private copy. The summary `state` field never grants a PASS by itself.
- The prompt gives exact allowed file paths and states which paths are off-limits. The fix steers the agent instead of loosening the hook.
- The hook tests pin `allow` for `tick.sh` and `deny` for the worktree directory and `README.md`, which locks in the boundary the earlier run hit.

## Verdict
- [ ] Approve
- [x] Approve with suggestions (do the dry check in the warning before using the held launch)
- [ ] Request changes
