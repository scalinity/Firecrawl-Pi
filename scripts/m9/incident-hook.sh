#!/usr/bin/env bash
# Root-owned PreToolUse guard. Only individual project files and a redacted input
# are readable. No Bash/MCP/agents; no symlinks, hook edits, secrets, deployment,
# budgets, schemas or arbitrary @file prompt expansion are allowed by the launcher.
set -euo pipefail
 . "$(dirname "$(readlink -f "$0")")/incident-paths.sh"
n=$(cat)
deny() { printf '%s\n' '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"Outside the bounded incident worktree permission contract"}}'; exit 0; }
[ -n "${FCPI_INCIDENT_WORKTREE:-}" ] && [ -n "${FCPI_INCIDENT_INPUT:-}" ] || deny
tool=$(jq -er '.tool_name' <<<"$n") || deny
# The CLI's fixed-schema serialization tool has no file, command or network
# authority. It must report this exact incident, never choose another handle.
if [ "$tool" = StructuredOutput ]; then
 id=$(basename "$(dirname "$FCPI_INCIDENT_INPUT")")
 [[ $id =~ ^[0-9a-f]{8}$ ]] || deny
 jq -e --arg id "$id" '.tool_input.incident_id == $id' <<<"$n" >/dev/null || deny
 printf '%s\n' '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"allow","permissionDecisionReason":"Fixed diagnosis schema output only"}}'
 exit 0
fi
p=$(jq -er '.tool_input.file_path' <<<"$n") || deny
case $tool in Read|Edit|Write) ;; *) deny ;; esac
[[ $p = /* ]] || p=$FCPI_INCIDENT_WORKTREE/$p
[[ $p != *$'\n'* && $p != *'@'* ]] || deny
# realpath resolves nonexistent final components; every ancestor must also be free of symlinks.
q=$p
while [[ $q != / && $q != . ]]; do [ ! -L "$q" ] || deny; q=$(dirname "$q"); done
p=$(realpath -m "$p")
root=$(realpath "$FCPI_INCIDENT_WORKTREE")
if [ "$tool" = Read ] && [ "$p" = "$(realpath "$FCPI_INCIDENT_INPUT")" ]; then :
else
  [[ $p = "$root/"* ]] || deny
  rel=${p#"$root/"}
  [[ /$rel/ != */.* ]] || deny
  git -C "$root" check-ignore -q -- "$rel" && deny
  if [ "$tool" = Read ]; then
    case $rel in services/*|scripts/ops/*|tests/*|docs/FIRECRAWL_PI_SPEC.md|docs/FIRECRAWL_PI_MILESTONES.md|deploy/versions.lock.json) ;; *) deny ;; esac
  else
    incident_writable "$root" "$rel" || deny
  fi
fi
printf '%s\n' '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"allow","permissionDecisionReason":"Bounded incident file operation"}}'
