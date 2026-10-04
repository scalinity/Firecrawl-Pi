# M9 execution authority and implementation references

Owner authorization: M9 only; local commits/deployment/fixtures, bounded independent Opus 5.5 review and remediation, global Claude Code/Codex MCP onboarding. No publication, paid subscription, nonzero backend budget or hosted-account ingress consent is inferred. PRE-M9 grant is expired.

Current official Anthropic mechanism checked 2026-10-03: native Claude Code `-p`, structured JSON, explicit session/resume IDs, dontAsk with exact tool allowlist and root-owned PreToolUse guard. OAuth access-token environment mode is supported for automated execution and does not refresh the token during the session. Launcher supplies only an unexpired Max access token and fails closed near expiry; no API credentials/base overrides are inherited. Exact CLI binary/model pins are checked before launch; updates/nonessential traffic are disabled only for these bounded invocations.

Primary references: https://code.claude.com/docs/en/headless ; https://code.claude.com/docs/en/cli-reference ; https://code.claude.com/docs/en/hooks ; https://code.claude.com/docs/en/env-vars ; https://docs.ntfy.sh/publish/ .

Pi ownership: M9 source mirror is root-owned private project state; incident worktrees are separate codex/incident-* branches from the exact deployed base. No other session's checkout is repurposed. Model edits are proposed source/test files only. Deployment authority is a signed, expiring, single-use owner action independently checked by root and bound to the tested frozen patch. Retention is 14 days for completed private worktrees and seven days for expired grants/replay journals (longer than one-hour maximum validity). Failed/uncertain actions are not blindly retried.
