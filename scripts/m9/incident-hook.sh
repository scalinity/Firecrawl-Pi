#!/usr/bin/env bash
# Root-owned PreToolUse guard. Only individual project files and a redacted input
# are readable. No Bash/MCP/agents; no symlinks, hook edits, secrets, deployment,
# budgets, schemas or arbitrary @file prompt expansion are allowed by the launcher.
set -euo pipefail
n=$(cat)
deny() { printf '%s\n' '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"Outside the bounded incident worktree permission contract"}}'; exit 0; }
[ -n "${FCPI_INCIDENT_WORKTREE:-}" ] && [ -n "${FCPI_INCIDENT_INPUT:-}" ] || deny
tool=$(jq -er '.tool_name' <<<"$n") || deny
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
  if [ "$tool" = Read ]; then
    case $rel in services/*|scripts/ops/*|tests/*|docs/FIRECRAWL_PI_SPEC.md|docs/FIRECRAWL_PI_MILESTONES.md|deploy/versions.lock.json) ;; *) deny ;; esac
  else
    # Executable source may be proposed, but the root controller independently
    # rechecks this list, all tests and the signed patch/base binding before deployment.
    case $rel in services/access/src/*.mjs|services/access/test/*.mjs|services/retrieval/src/*.mjs|services/retrieval/test/*.mjs|tests/contracts/*.test.mjs) ;; *) deny ;; esac
    case $rel in */config.mjs|*/auth.mjs|*/incidents.mjs|*/budget*|*/egress*|*/store.mjs|*/schema*|*/admission.mjs|*/security*) deny ;; esac
  fi
fi
printf '%s\n' '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"allow","permissionDecisionReason":"Bounded incident file operation"}}'
