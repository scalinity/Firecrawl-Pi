#!/usr/bin/env bash
# Supported native subscription refresh, run as the existing owner. No model call,
# API key, browser login, credentials on argv, or agent access to the refresh token.
set -euo pipefail
[ "$(id -un)" = danny ] || exit 2
C=/home/danny/.claude/.credentials.json
export CLAUDE_CODE_OAUTH_REFRESH_TOKEN=$(jq -er '.claudeAiOauth.refreshToken' "$C")
export CLAUDE_CODE_OAUTH_SCOPES=$(jq -er '.claudeAiOauth.scopes | if type=="array" then join(" ") else . end | select(type=="string" and length>0)' "$C")
export DISABLE_UPDATES=1 CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1
unset ANTHROPIC_API_KEY ANTHROPIC_BASE_URL CLAUDE_CODE_OAUTH_TOKEN
exec timeout --kill-after=5 45 /home/danny/.local/bin/claude auth login --claudeai
