# M4 review — /review-2 report of record

- **Run:** 2026-09-26. `/review-2` with two agents, both on **Opus 5.5** (the Agent tool's `opus` alias), as CLAUDE.md §5 requires: DB1 (debugger) and CA1 (code auditor).
- **Scope:** every change from `0abf44c` (M3's close) to `4d34e39`, except the owner's documentation commit `704cb04`: 34 files, 3,157 changed lines.
- **Orchestrator's pass:** at the owner's request, the orchestrator ran its own pass while the agents worked. Its findings are tagged *orchestrator's pass*; one suspicion it probed and cleared is recorded under Good practices.
- **Found during M4, outside the review:** eight items found while implementing and collecting evidence are recorded as F1–F8, so the milestones that own them take them from this report (CLAUDE.md §5).

## Code Review: M4 — Modern stateless MCP (services/mcp, the gateway's /mcp route, scripts/m4)

### Summary

The security model holds. No reviewer found a way around authentication, Host/Origin, the identity headers or SSRF, and the delegated-token design keeps the REST gateway as the only policy boundary. One critical finding blocks: a verifier check (A02) cannot pass on correct behaviour. Nine warnings concern guarantees M4 states: the payload bound, idempotent submission, the memory envelope, and the verifier's blind spots.

**Scope (so the reader knows what was and wasn't reviewed):**

- **The large-changeset guard triggered.**
  - **Tier 1, full review:** `services/mcp/*`, `services/access/server.mjs`, `services/access/src/config.mjs`, `services/access/src/mcp.mjs`, `deploy/compose.yaml`, `deploy/policies/capabilities.json`, `deploy/clients/*`, `scripts/m4/verify.mjs`, `scripts/m4/real-clients.mjs`.
  - **Tier 2, skimmed:** the other `scripts/m4/*` files, `services/mcp/test/*`, `services/access/test/mcp.test.mjs`, `tests/fixtures/m3/server.mjs`.
  - **Tier 3, acknowledged only:** `services/mcp/package-lock.json`, `.gitignore`.
  - Confidence is high on Tier 1; there may be false negatives in Tier 2.
- **Out of scope:**
  - the core's heap and the swap-limit reset themselves (F1, F2);
  - M5 and later features;
  - the owner's documentation commit.
- **Run by the agents:** the local unit and integration suites (30 of 30 pass) and read-only probes. No builds and no Pi access.

### 🔴 Critical Issues (Must Fix)

1. **C1 — A02 cannot pass when the tool behaves correctly** - `scripts/m4/verify.mjs:394-395` _(unique to DB1's lane)_
   - Problem: A02 sums `originalBytes` only over the fields that were cut. On the fixture (a 100 KiB page in three formats), `fitDocument` cuts exactly one field, so the sum is about 102 KB and can never exceed 262,144.
   - Risk: DB1 reproduced it with the real `shape()`: `text_bytes=261650`, one cut, `orig=102721`. A02 would FAIL a correct tool, and M4 could not reach ACCEPTED. A larger page is no way out: it runs into F1.
   - Fix: prove the page was over the limit from what the answer reports, the bytes returned plus the bytes cut (a lower bound on the original size, since JSON escaping only adds bytes):
     ```js
     const removed = Object.values(cuts).reduce((a, c) => a + ((c.originalBytes ?? 0) - (c.returnedBytes ?? 0)), 0);
     const ok = b?.status === 200 && b.is_error === null && b.text_bytes > 0 && b.text_bytes <= 262144 && Object.keys(cuts).length >= 1
       && Object.values(cuts).every((c) => Number.isFinite(c.originalBytes) && c.returnedBytes < c.originalBytes)
       && b.text_bytes + removed > 262144 && sentinelOf(b.sentinel, "big");
     ```

### 🟡 Warnings (Should Fix)

1. **W1 — Two branches exceed the 256 KiB tool payload bound** - `services/mcp/src/tools.mjs:121-126, 86-109`, `services/mcp/server.mjs:63-65` _(corroborated: both agents and the orchestrator's pass)_
   - Problem: each branch enforces the bound its own way, and nothing checks the final text.
     - The map branch shrinks the link list to fit the full budget, then adds its marker on top: 262,171 bytes in a probe.
     - `fitDocument` gives up when the bulk is in a field it cannot cut. With large `metadata`, the answer was 347,193 bytes (orchestrator) and 300,359 bytes (CA1), marked a success, and the marker named a 1-byte cut.
   - Suggestion: measure the map answer with its marker in place, and have `runTool` turn any answer over the bound into a `RESULT_TOO_LARGE` tool error. Add tests for both cases.
2. **W2 — A lost answer to a keyless MCP submission invites a duplicate job** - `services/mcp/server.mjs:56-61`, `services/mcp/src/tools.mjs:44,73` _(corroborated: both agents)_
   - Problem: the gateway commits the receipt before it answers. If the MCP hop then fails (a client disconnect, the REST timeout, a restart), the tool returns no id, only "the gateway did not answer". An agent's keyless retry creates a second job (spec §16.2, §17.3; CLAUDE.md §19).
   - Suggestion: the two agents proposed different fixes.
     - DB1: always send a key (`mcp:<uuid>` when the caller gives none), and on a transport failure answer `SUBMISSION_UNCERTAIN` carrying that key, telling the agent to call again with the same arguments and key.
     - CA1: make `idempotencyKey` a required argument of the submit tools.
3. **W3 — M01 cannot see a container restart, and passed over one** - `scripts/m4/verify.mjs:541-549` _(unique to DB1's lane)_
   - Problem: samples are taken only at the ends of phases, and M01 never compares `started_at`. In the recorded evidence, the core's `started_at` moves from 13:06:37Z (end-wire) to 15:34:30Z (every later sample) because of the F1 heap abort. M01 read the reset cgroup values and passed.
   - Suggestion:
     - Take a `start-<phase>` sample before each phase does any work.
     - Fail when the core's or the gateway's instance or `started_at` changes between any two samples.
     - Allow the MCP service's to change only across its restart and stop steps, and name any restart in `actual`.
4. **W4 — The configured memory envelope is unmeasured** - `deploy/policies/capabilities.json:164`, `services/mcp/src/rest.mjs:32-43` _(unique to CA1's lane)_
   - Problem: 4 concurrent calls × 8 MiB answers, each concatenated, stringified, parsed and shaped, against a 192 MiB cap with no swap. One 7.6 MiB answer cost about 50 MiB of RSS. The recorded peaks (48-55 MiB) come only from answers of 300 KB or less.
   - Suggestion: measure four concurrent large reads and size the answer cap from the result. Release the chunks after concatenating them. Set an explicit heap ceiling so a failure is predictable.
5. **W5 — The auth-before-/mcp ordering and the failure branches are untested** - `services/access/server.mjs:310`, `services/access/test/mcp.test.mjs`, `services/mcp/src/rest.mjs:31,36,49`, `services/mcp/server.mjs:46`, `services/access/src/mcp.mjs:39` _(unique to CA1's lane)_
   - Problem: moving the `/mcp` hook above the token check would still pass all 30 M4 unit tests and M3's 40 contract tests. No test covers TOO_LARGE, TIMEOUT, UNAVAILABLE, OVERLOADED or the exchange deadline.
   - Suggestion:
     - A gateway-level test with a recording fake MCP service: a missing token, a foreign Host and a foreign Origin get 401, 421 and 403, and the fake sees no request.
     - RestError tests against a local server.
     - A tool-call OVERLOADED test.
6. **W6 — P02 claims something it never checks, and the claim is false for `not_json`** - `scripts/m4/verify.mjs:256-265`, `scripts/m4/mcp-e2e.mjs:302` _(unique to DB1's lane)_
   - Problem: P02's `expected` says none of the rejected cases "was served as a 2025-era request", but P02 never checks it. The SDK sends every POST with a non-JSON body to its legacy leg, so the `not_json` case is logged as a legacy `serve`.
   - Suggestion: record `serve` records with their request ids, assert that no JSON-bodied rejected case reached the factory, and restate the `not_json` line as the legacy leg's parse error.
7. **W7 — The log scans hit the §33.6 pipefail trap, and a false line is in the evidence** - `scripts/m4/pi-mcp-log-scan.sh:14`, [PRE-EXISTING] `scripts/m3/pi-gateway-log-scan.sh:16` _(unique to DB1's lane)_
   - Problem: `printf '%s\n' "$L" | head -1 | jq … || echo unreadable` can end the producer with SIGPIPE on a large log. The `gateway_log_scan` section of `evidence/M4/raw/stack.txt` holds a stray `unreadable` line after `first_event=clients_loaded`.
   - Suggestion: take the first line by parameter expansion, so no producer is left to kill, in both scripts.
8. **W8 — The held real-client run sits outside the verifier's window and deployment checks** - `scripts/m4/verify.mjs` (X01 `inside`, G01 `deployed`) _(corroborated: DB1 and the orchestrator's pass)_
   - Problem: X01 checks only the six driver phases against the guard window, and G01 ignores `raw/real-clients.txt`'s deployed commit. The run could fall outside the window, or run against a stale deployment, unnoticed.
   - Suggestion: when the file exists, require its `pi_utc` inside the window and its commit among those G01 checks.
9. **W9 — The core's heap abort (F1) leaves a retry loop open through MCP** - `services/mcp/src/tools.mjs:112`, `services/access/src/upstream.mjs:63-68` _(unique to CA1's lane)_
   - Problem: a scrape that aborts the core is relayed as a bare 502. An agent that retries the same page restarts the whole core each time, disrupting crawls in flight.
   - Suggestion: name this path in F1's deferral, and add to the scrape 502 error: "if this recurs for the same URL, do not retry it unchanged".

### 🔵 Suggestions (Consider)

1. **S1 — The status tool gives up on a page over the answer cap** - `services/mcp/server.mjs:60` _(corroborated: DB1 and the orchestrator's pass)_
   - Current: RESULT_TOO_LARGE, with a hint that repeats itself even when `limit` is already 1.
   - Better: retry once at `limit=1`, as the gateway does for running jobs. When `limit` was already 1, say the document is too large to carry and give its results address.
2. **S2 — Raw client header text is logged** - `services/mcp/server.mjs:107-108` _(corroborated: CA1 and the orchestrator's pass; CWE-117)_
   - Current: `mcp-method`, `mcp-name` and `mcp-protocol-version` are logged verbatim.
   - Better: the gateway's pattern-or-`invalid` rule.
3. **S3 — O01's route check is vacuous for all but two tools** - `scripts/m4/verify.mjs:407-408` _(unique to DB1's lane)_
   - Current: the fallback compares a route with itself.
   - Better: build the tool-to-route map from the manifest, with no fallback.
4. **S4 — The Codex template is never exercised** - `scripts/m4/real-clients.mjs:86-87` _(unique to DB1's lane)_
   - Current: the server settings are restated as `-c` overrides.
   - Better: build them from `deploy/clients/codex.config.toml`.
5. **S5 — An exception from `shape()` or the progress `notify()` leaves no tool record** - `services/mcp/server.mjs:53,63` _(unique to DB1's lane)_
   - Current: only the REST call is guarded.
   - Better: record a failed outcome, then rethrow.
6. **S6 — The same grammars are copied in both services** - `services/mcp/server.mjs:83`, `services/mcp/src/tools.mjs:10-11` _(unique to CA1's lane)_
   - Current: the identity, UUID and key patterns are copied by hand, and the scope list is capped at 64 characters.
   - Better: a test that asserts the copies match, and a higher cap.
7. **S7 — A batch cannot be cancelled through MCP** - `deploy/policies/capabilities.json` _(unique to CA1's lane)_
   - Current: `batch.cancel` is an enabled route with no tool.
   - Better: a `firecrawl_cancel_batch` tool.
8. **S8 — A running job's page gives no resume point** - `services/mcp/src/tools.mjs:150-151` _(unique to CA1's lane)_
   - Current: `nextSkip: null` when every current document fits.
   - Better: `skip + returned` while the job is not finished.
9. **S9 — REST startup depends on the MCP section even without MCP** - `services/access/src/config.mjs:103-106` _(unique to CA1's lane)_
   - Current: the MCP checks run even without `PI_MCP_URL`.
   - Better: run them only when it is set.
10. **S10 — Verifier edges in P04 and R01** - `scripts/m4/verify.mjs:292, 563-564`, `scripts/m4/real-clients.mjs` _(corroborated: CA1 and the orchestrator's pass)_
    - Current: P04 requires the legacy notification case to end `ok`, so fixing the limitation would fail it. R01's `.every` over exchanges passes when none were logged. A trailing period or backtick fails a correct answer.
    - Better: accept `ok` or `cancelled` and record which; require at least three exchanges per client; normalise the answer line.
11. **S11 — The Claude Code run is not isolated from built-in tools and user settings** - `scripts/m4/real-clients.mjs:73-74` _(unique to CA1's lane)_
    - Current: `--strict-mcp-config` limits MCP servers only.
    - Better: disallow the built-in tools, and record permission denials and tool use from the JSON output.
12. **S12 — `clientInfo` is never recorded** - `services/mcp/server.mjs` _(orchestrator's pass)_
    - Current: the log names only the validated token label.
    - Better: log a sanitised product name and version (from `_meta` on modern requests; from `oninitialized` and `getClientVersion()` at a 2025-era `initialize`), as descriptive data only, so a real client is visible on the server side.
13. **S13 — The real-client tokens carry all six scopes** _(orchestrator's pass)_
    - Current: `m4claude` and `m4codex` hold read, scrape, map, crawl, batch and cancel.
    - Better: only what the prompt needs, `read,scrape,crawl` (spec §18's "allowed tool scopes").

### ✅ Good Practices

- **Delegated token:** the gateway re-authorizes every tool call (scope, owner binding, admission, receipts). The `x-fcpi-*` headers only describe the caller and grant nothing, and the core never receives an Authorization header.
- **Proxy hygiene:** header allow-lists in both directions; identity rebuilt at the gateway; the query string dropped; `agent: false` per exchange; no CORS, cookie or session headers passed.
- **Schemas:** tool schemas are generated from the manifest with `additionalProperties: false`, the SDK validates them before any handler runs, and ids go through `encodeURIComponent`.
- **Counters and cancellation:** counters are decremented on every path, and cancellation works end to end in both eras, request id 0 included.
- **Tests and tokens:** the server test spawns the real process with the real SDK over raw HTTP in both eras. Tokens reach processes only on stdin or in the environment.
- **Cleared by the orchestrator's pass:** a suspected race between the MCP service's keep-alive pool and the gateway's 5 s keep-alive timeout. On Node 22.23.3 (the MCP image) there were 0 resets in 30 reuses timed at 4.99-5.5 s.

### Verdict

[x] ❌ Request Changes (critical issues)
[ ] ⚠️ Approve with Suggestions
[ ] ✅ Approve

## Found during M4, outside the review

1. **F1 — The core's API process aborts on a large page** - `evidence/M4/raw/core-heap-probe.txt`, `evidence/M4/raw/core-heap-probe-sizes.txt`
   - Problem: a 614 KB page of text paragraphs aborts the core's API process with a V8 heap failure at its 256 MiB old-space cap (`NODE_OPTIONS=--max-old-space-size=256`). The harness then restarts the whole core container, cutting every job in flight.
   - Evidence: reproduced on a freshly restarted core, over REST with no MCP involved. 100 KiB in three formats, 200 KiB and 400 KiB pass in 0.23, 0.74 and 2.0 s; the time grows faster than linearly, and 600 KiB aborts. Spec §22 already requires "graceful failures for oversized documents rather than … uncontrolled allocation".
2. **F2 — A systemd reload removes every container's swap limit** - `evidence/M4/raw/owner-session.txt`
   - Problem: the owner's `apt upgrade` at 15:51Z reloaded systemd nine times, and every project container's `memory.swap.max` went from 0 (as M3 recorded it) to `max`, including containers never recreated since M3. runc writes the limit to cgroupfs rather than as a unit property, so any reload undoes it. Containers can then swap past their memory caps into the host's 2 GiB zram.
3. **F3 — A 2025-era SDK client's cancellation is not honoured** - `evidence/M4/raw/e2e-cancel.txt`
   - Problem: the SDK's 2025-era client cancels by sending `notifications/cancelled` (it has no per-request abort in that era). Stateless serving hands that notification to a fresh instance that holds nothing of the running request, so the request runs on.
   - Evidence: a 2025-era request whose connection closes is cancelled, like a modern one.
4. **F4 — The next boot changes kernel** - `evidence/M4/raw/owner-session.txt`
   - Problem: the owner's upgrade staged `linux-image-6.18.50+rpt-rpi-2712` and new `raspi-firmware`, while 6.18.34 runs. Decision D2 (the 16 KiB-page kernel) holds for the running kernel; the next boot needs its page size, the stack's recovery and Chromium verified again.
5. **F5 — Codex refused the crawl on the workstation** - `evidence/M4/raw/real-clients-codex-refused.txt`
   - Problem: headless `codex exec` runs with `approval_policy=never`, and in its default `auto` mode it asks before any MCP tool not marked read-only. `firecrawl_crawl` creates a job and is honestly marked so. Codex therefore refused it without sending it, and answered `CRAWL=unavailable DOCS=0`. The driver granted Claude Code the prompt's three tools with `--allowedTools`, but gave Codex no equivalent.
   - Evidence: Codex's stderr shows `MCP tool call requires approval, but approval policy is never` twice, and the Pi recorded one tool call from `m4codex` (the scrape) and no crawl job. R01 failed it on `codex_answer`, `codex_crawl_finished` and `codex_calls`.
6. **F6 — S12's fix held serving instances in a module-level Map** - `services/mcp/server.mjs`
   - Problem: to log a 2025-era client's name, S12's fix kept each request's `McpServer` in a module-level `Map` keyed by the gateway's request id, deleted when the response closed. K01 refuses any `new Map(` in the server as a possible session map. The first full verifier run after `/address` failed K01 on `no_session_state`, with every other check passing.
   - Evidence: the entry lived only until its request closed, so no state crossed requests. It was still a string-keyed store with a manual delete, the shape session state takes.
7. **F7 — The Pi's Wi-Fi failed, and the host restarted without a shutdown** - `evidence/M4/raw/reboot.txt`
   - Problem: at 17:22:19Z, during the SDK phase, the Pi's Wi-Fi disconnected on the Pi's side, and its scans stopped finding the access point, which stayed up for the workstation. At 17:28:49Z the kernel reported the Wi-Fi chip's SDIO bus down, and the driver was reloaded. The journal ends at 17:29:45Z with no shutdown sequence. The next boot, at 17:30:50Z, came up on the staged kernel 6.18.50 (F4). The firmware's reset register reads 0x1000, the power-on reset.
   - Evidence: there was no sudo command, login or session after the loss, and no undervoltage in either boot's kernel log. The window's SDK, cancel, restart and stopped phases and its memory probe failed for want of the host.
8. **F8 — At boot, the guard's local-network set could stay empty** - `deploy/host/fcpi-egress-local.sh`, `evidence/M4/raw/egress-local-before-install.txt`
   - Problem: dockerd's drop-in runs `fcpi-egress-local.sh` before Wi-Fi is up. The script found no connected network and exited, and dockerd's restart policies revived the containers while the freshly loaded guard's `egress_local_v4` set was empty. The stack unit's own run filled it 7 s later. The drop-ins assume the retrieval service refuses to acquire while its list names no network. But its copy of the list persists across boots, so that never engages. A network that came up after both runs would have left the guard's set empty until the next restart.
   - Evidence: in a throwaway network namespace with no connected route, the installed script exited 1 and left the set empty.

## Outcomes

Recorded after `/address` (CLAUDE.md §5).

| ID | Severity | Finding | Outcome | Commits |
|---|---|---|---|---|
| C1 | 🔴 | A02 cannot pass when the tool behaves correctly | Fixed: A02 requires the bytes returned plus the bytes cut to exceed the limit, a lower bound on the whole answer; checked against the real shaping on a fixture-shaped page, and a control under the limit still fails | `3ad994f` |
| W1 | 🟡 | Two branches exceed the 256 KiB tool payload bound | Fixed: the map answer is measured with its marker in place, and every answer's final text is checked, one still over the limit refused as RESULT_TOO_LARGE; both tests fail on the old code, the map one built so 500 links leave 60 bytes | `d8eabab` |
| W2 | 🟡 | A lost answer to a keyless MCP submission invites a duplicate job | Fixed, as DB1 proposed: every submission carries the caller's key or one made for it (mcp:<uuid>), returned in the answer, and a lost answer is SUBMISSION_UNCERTAIN carrying it. CA1's required key was not taken: it would push agents to invent keys, and one reused for different jobs is refused as a conflict | `42cd54d` |
| W3 | 🟡 | M01 cannot see a container restart, and passed over one | Fixed: every phase samples before it starts, and M01 fails when the core's or the gateway's start time moves between two samples, while the MCP service's must move exactly across its deliberate restart and stop (the control); on the recorded evidence it now names the core's restart | `6c7d9f1` |
| W4 | 🟡 | The memory envelope is unmeasured | Fixed: measured in the MCP image on the Pi, four concurrent reads at the 8 MiB cap peaked at 189 MB and 207.6 MB, past the 201.3 MB cgroup cap. The cap is 4 MiB, the oversized document is cut in place instead of copied, each page document is measured once, the chunks are released, and a 96 MiB heap ceiling is set: 145.1 MB peak (72% of the cap). M02 checks the envelope as measured | `6136d24`, `d6787c2` |
| W5 | 🟡 | The auth-before-/mcp ordering and the failure branches are untested | Fixed: a gateway-level contract suite runs the real gateway against a recording fake MCP service (every refusal reaches nothing; the validated identity is forwarded; no route without PI_MCP_URL), and the REST client's four failure codes, the tool-call OVERLOADED path and the exchange deadline before and after headers are tested; G02 requires them | `95d1a76` |
| W6 | 🟡 | P02 claims something it never checks, and the claim is false for not_json | Fixed: serve records are kept with their request ids; P02 requires the eight JSON-bodied cases never to reach the factory, the non-JSON body the legacy leg only, and the control the modern leg | `4f02749` |
| W7 | 🟡 | The log scans hit the §33.6 pipefail trap | Fixed in both scans (M3's gateway scan too): the first line is taken by parameter expansion; reproduced with a 200,000-line log, where the old form appended the stray line | `151b304` |
| W8 | 🟡 | The held real-client run sits outside the verifier's window and deployment checks | Fixed: once raw/real-clients.txt exists, its start must lie in X01's window and its deployed commit is among those G01 compares with HEAD | `95563d9` |
| W9 | 🟡 | The core's heap abort leaves a retry loop open through MCP | Fixed: a scrape's 502 carries advice not to retry the same URL unchanged; the core's heap itself is F1, deferred to M8 | `d5d612f` |
| S1 | 🔵 | The status tool gives up on a page over the answer cap | Fixed: it reads the page again at limit=1; a single document still over the cap is reported with the REST results route that serves it whole | `5c9b0aa` |
| S2 | 🔵 | Raw client header text is logged | Fixed: Mcp-Method, Mcp-Name and MCP-Protocol-Version are logged as their value when it matches the header's grammar, invalid otherwise | `faf22a8` |
| S3 | 🔵 | O01's route check is vacuous for all but two tools | Fixed: the tool-to-route map comes from the manifest, with no fallback | `9ceb516` |
| S4 | 🔵 | The Codex template is never exercised | Fixed: the real Codex run takes its server from deploy/clients/codex.config.toml, with the served origin in place of its placeholder | `31d7739` |
| S5 | 🔵 | An exception from shape() or notify() leaves no tool record | Fixed: any exception the cancellation branch has not recorded is recorded as failed, then rethrown; tested with a malformed gateway answer that makes shaping throw | `e494691` |
| S6 | 🔵 | The same grammars are copied in both services | Fixed: a test reads each pattern from both services' sources and checks they agree on a corpus (run on the Pi against the deployed tree, required by G02); the MCP service's scope-list cap is raised from 64 to 256 characters | `d0eea92` |
| S7 | 🔵 | A batch cannot be cancelled through MCP | Fixed: firecrawl_cancel_batch, a platform extension on batch.cancel | `92e9251` |
| S8 | 🔵 | A running job's page gives no resume point | Fixed: while a job is not finished, nextSkip is the skip after what the answer returned | `b257618` |
| S9 | 🔵 | REST startup depends on the MCP section even without MCP | Fixed: the gateway checks the manifest's mcp section only when PI_MCP_URL is set | `d43f729` |
| S10 | 🔵 | Verifier edges in P04 and R01 | Fixed: P04 records the 2025-era notification case as ok or cancelled; R01 needs at least three exchanges per client; the answer line is normalised | `5951b01` |
| S11 | 🔵 | The Claude Code run is not isolated from built-in tools and user settings | Fixed: no built-in tool (--tools "") and no user settings (--setting-sources project, in an empty directory); --bare is not used because it skips the keychain the login lives in; R01 requires no permission denial | `c20d1da` |
| S12 | 🔵 | clientInfo is never recorded | Fixed: tool records carry a modern request's clientInfo (from the SDK's envelope, where it lifts the reserved keys) and exchange records a 2025-era initialize's, sanitised and descriptive only; R01 reports each real client's own name | `086338b`, `ab338f4` |
| S13 | 🔵 | The real-client tokens carry all six scopes | Fixed: m4claude and m4codex were revoked and recreated on the Pi with read,scrape,crawl; the driver records each token's scopes and R01 requires exactly those | `9c4d37c` |
| F1 | Found during M4 | The core's API process aborts on a large page | Deferred to M8: the core's heap lies outside M4's Scope (MCP); spec §22 makes the heap ceiling a measured, rebalanced budget, and M8's Scope holds the final resource tuning and the 24-hour soak that measures it. M4 closed the MCP retry path (W9) and records the threshold: 400 KiB passes in 2.0 s, 614 KB aborts | |
| F2 | Found during M4 | A systemd reload removes every container's swap limit | Deferred to M8: host lifecycle is M8's Scope, which the fix needs (keeping the limits across reloads, or detecting their loss, in the startup unit and fcpi status). M4 recreated the whole stack at its final bring-up so every limit applies again, and M01 and X03 require memory.swap.max 0 at the window's end | `ee91a9d` |
| F3 | Found during M4 | A 2025-era SDK client's cancellation is not honoured | Rejected, with the evidence: stateless serving has no instance that holds the running request, by design (spec §18: features needing a legacy return channel are not promised); a 2025-era request whose connection closes is cancelled, id 0 included (evidence/M4/raw/e2e-cancel.txt), and P04 records the notification case without requiring it | |
| F4 | Found during M4 | The next boot changes kernel | Fixed: the reset (F7) made 6.18.50 live during M4, so it was verified here, not at M8. D2's 16 KiB pages hold, the stack came up through the gated start (the data check passed, 11 containers healthy), and M2's Chromium checks B01–B07 pass on the new kernel (`evidence/M2/kernel-6.18.50/`). The proof's stray-process count no longer counts the running worker's own processes. H01 requires all of it | `69f9929`, `e70e4ad` |
| F5 | Found during M4 | Codex refused the crawl on the workstation | Fixed: the driver grants both clients the prompt's three tools from one list, Claude Code as --allowedTools and Codex as a per-tool approval_mode="approve" override, which Codex validates (a misspelled mode stops it). The template keeps Codex's default, which asks before a crawl. The platform's annotations were right and are unchanged | `2bc5c68` |
| F6 | Found during M4 | S12's fix held serving instances in a module-level Map | Fixed: the instance is held in a WeakMap keyed by the request's own auth object, which the adapter hands to the factory by reference in both eras, so no other request can present the key and the entry goes with the request. S12's test reads the 2025-era name from the exchange record through it (39 of 39 pass). K01 is unchanged and passes | `4fa7121` |
| F7 | Found during M4 | The Pi's Wi-Fi failed, and the host restarted without a shutdown | Rejected, with the evidence: not a platform defect. The radio dropped on the Pi's side, with no local action after the loss, and the reset register reads a power-on reset (`evidence/M4/raw/reboot.txt`); whether power was interrupted is a physical fact the logs cannot settle. Everything the reset put in doubt is re-established in M4, not deferred, and H01 checks it: the reset tied to both snapshots (X04), D2 and Chromium on 6.18.50 (F4), M3's sentinel in PostgreSQL, Redis and RabbitMQ, PostgreSQL's completed WAL redo, no job left open, every archive file and live document whole, and the whole window re-run on the new boot. The gap it exposed is F8 | `5c92ca6`, `0fd261b`, `e70e4ad` |
| F8 | Found during M4 | At boot, the guard's local-network set could stay empty | Fixed: with no connected network, the script fills the set with the IPv4 networks its file already names, so the guard and the retrieval service agree and the set is never empty. Proven in a throwaway network namespace: before installation the installed copy exited 1 with the set empty, while the repository's filled it; after installation both fill it, and the host's set matches the file (H01) | `2f5cba5`, `c19cfee` |

### Found during `/address`, beyond the review

- **The status page was shaped at a quadratic cost.** While W4 was being measured: for each document, the shaping serialized the whole trial page again, and a document too large alone was first deep-copied. Both were removed in `6136d24`; together with the answer cap they took the peak from 207.6 MB to 145.1 MB.
- **The SDK lifts the reserved envelope keys out of `_meta`.** Found implementing S12: a modern request's `clientInfo` is in `extra.mcpReq.envelope`, not `_meta` (a user `_meta` key such as `progressToken` stays in `_meta`).
- **A malformed map answer made shaping throw.** A gateway answer whose `links` is not a list fails `.slice()`. It is now recorded (S5) and returned as an error, which is the right outcome for a malformed answer, so shaping was left as it is.
- **The in-image suites confirmed the regression tests on the real runtime.** Run before the images were rebuilt, the MCP suite inside the deployed image failed exactly the three new W1 and W2 tests, and the new gateway-level contract suite passed on the gateway image.

### Reruns after `/address`

Every affected check reran on the final evidence window at the verified commit (`evidence/M4/verification.json`), and 27 of 27 pass:

- the in-image suites: the MCP service 39 of 39, the gateway's unit suite 27 of 27, M3's contract suite 40 of 40, M4's `/mcp` contract suite 3 of 3 and the shared-grammar test 3 of 3;
- all six live phases, the memory envelope and both real clients;
- H01, on the boot after the reset.

The window was collected several times after `/address`, and each collection added to the record:

- the first found F5 and F6;
- a later one was cut short by the reset (F7), whose aftermath found F8;
- the whole window then ran again on the new boot, from a fresh bring-up.
