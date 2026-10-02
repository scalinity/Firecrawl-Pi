# Owner requirement for M9 (given 2026-09-28 during M8): carry into M9's kickoff prompt at M8's close-out

Additional M9 requirement: **Autonomous Incident Investigation & Recovery**. An addition to M9's scope, bounded; not a
replacement of any M9 acceptance requirement. M8 does not implement it: M8 delivers the notice event model, the ntfy
channel and the VPS watchdog it builds on (scripts/ops/notify-ntfy.sh, deploy/vps/fcpi-watchdog.sh).

## What M8 hands over
- The event model on the owner's phone (ntfy.sh, a private 64-hex topic kept in the owner's login keychain and on the Pi
  and VPS as 0600 secrets): classes incident_opened, recovery_succeeded, recovery_failed (live in M8), recovery_attempted,
  investigation_started, diagnosis_ready, approval_required (reserved for M9), watchdog_unreachable, watchdog_reachable
  (the VPS watchdog). Each message: title, concise metadata-only body with the short incident id, priority, tags with the
  class, and an `actions` array that M8 leaves empty.
- Incidents carry a stable short id (sha256 of key and start, 8 hex) and start time; recoveries carry the duration.
- The VPS watchdog distinguishes a missing heartbeat, a stopped Pi monitor, an unhealthy application on a live Pi
  (recorded only) and its own lost connectivity (claims nothing).

## The flow
deterministic health monitor → incident detected → existing safe runbook recovery first → recovered: ntfy recovery
notice; still unhealthy or repeating: bounded redacted incident bundle → Claude Code launched programmatically →
investigation → ntfy diagnosis with owner actions (Apply Fix, View Report, Roll Back, Dismiss).

## Claude incident agent
- Use the currently supported Claude Code programmatic / Agent SDK mechanism (non-interactive `claude -p`, structured
  JSON output, resumable session ids, explicit tool allowlists, permission modes, hooks). At M9 time, recheck the
  installed Claude Code version and the current official Anthropic documentation before implementing.
- Three authority levels:
  1. Automatic investigation, for meaningful incidents deterministic recovery did not resolve: read project code and
     configuration, redacted diagnostic bundles, logs, resource metrics, git history and diffs, deployed versions; run
     read-only diagnostics and safe tests. Structured output at least: incident id, observed symptom, likely root cause,
     evidence, confidence/uncertainty, affected component, proposed remediation, tests required, whether modification is
     recommended, whether immediate owner attention is required.
  2. Deterministic automatic recovery, only predefined tested runbook actions: restart a project service, recycle a stale
     Chromium process/worker, restart an unhealthy project container, re-run health verification, run another explicitly
     approved M8/M9 recovery script, roll back to an already accepted configuration/image where a tested runbook permits.
     The model never invents "safe" automatic actions.
  3. Agentic code/config remediation: diagnose, create a temporary branch/worktree, edit project-owned code/config, write
     and run tests, produce a patch and a report; STOP before consequential deployment unless a narrowly approved
     deterministic runbook covers it. The owner's action button is the approval boundary. Example notice: "Firecrawl Pi —
     Claude Diagnosis / Cause: … / Proposed fix: … / Verification: 14/14 tests passed in isolated worktree / [Apply Fix]
     [View Report] [Dismiss]".
- Keep the Claude session id per incident; Apply Fix or further analysis resumes the same session. Bounded retention.
- Permissions: never unrestricted bypassPermissions by default; explicit least-privilege tools; hooks or equivalent
  deterministic guards so prohibited operations stay blocked even if attempted. Owner approval required or forbidden:
  public exposure changes, destructive storage operations, deleting production volumes, broad firewall resets, changing
  unrelated services, spending money, enabling a paid provider, changing provider budgets, rotating into a different paid
  service, reimaging, pushing directly to main, destructive database resets, disabling backup/security controls,
  modifying the owner's SSH private keys. Bounded turns, runtime and cost where supported.
- Prefer the owner's existing authenticated Claude Code installation/subscription if programmatic execution can safely use
  it; do not silently introduce Anthropic API billing. If the supported mode needs separate API billing, report it as an
  architecture/cost decision before enabling automatic calls.

## ntfy as the phone approval surface
- Incident: Investigate, Details, Dismiss. Diagnosis: Apply Fix, View Report, Dismiss. Failed deployment: Roll Back, View
  Report. Recovery: View Report, Dismiss.
- Action endpoints authenticated, signed and replay-resistant; never rely on the secrecy of an action URL alone for a
  consequential action; no bearer tokens in notification text; no unauthenticated control API on the public Internet;
  prefer a secure authenticated endpoint or a minimal trusted relay.

## The external watchdog and Claude
- A VPS watchdog notice alone never causes remediation on the VPS; for a Pi-level incident the VPS notifies first.
- When the Pi is reachable again, the Pi-side incident framework may launch Claude to find why it disappeared, from the
  durable boot records, logs and the incident's timestamps.
- A trusted external Claude runner investigating a dead Pi is a separate M9 evaluation, not assumed.
