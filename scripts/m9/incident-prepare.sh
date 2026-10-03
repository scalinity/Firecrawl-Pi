#!/usr/bin/env bash
# Trusted root preparation; runs after deterministic recovery failed, at most four
# fresh investigations per UTC day. Never runs the agent with root authority.
set -euo pipefail
. "$(dirname "$(readlink -f "$0")")/../ops/lib.sh"
need_root
id=${1:?incident id}; [[ $id =~ ^[0-9a-f]{8}$ ]] || die 'invalid incident id'
D=$STATE/incidents W=$STATE/incidents/work/$id
exec 8>"$D/prepare.lock"; flock -n 8 || exit 0
# One model process at a time, including explicit owner resumes.
systemctl list-units --state=active --type=service 'fcpi-incident-????????.service' --no-legend | grep . >/dev/null && exit 3
[ ! -e "$W" ] || {
  [ "${2:-}" = --resume ] || exit 0
  [ "$(cat "$W/base-sha")" = "$(source_commit)" ] || die 'deployed release changed; start a new investigation'
  [ -s "$W/run/result.json" ] || die 'no resumable completed session'
  [ "$(cat "$W/launch-count")" -lt 2 ] || die 'incident resume limit reached'
}
# Count every launch (including resumes) in an immutable root UTC ledger.
day=$(date -u +%F)
[ ! -e "$D/launches.jsonl" ] || jq -e -s 'all(.[]; (.day|type)=="string" and (.incident_id|test("^[0-9a-f]{8}$")))' "$D/launches.jsonl" >/dev/null || die 'launch ledger damaged; investigation blocked'
count=0
if [ -e "$D/launches.jsonl" ]; then count=$(jq -s --arg day "$day" '[.[]|select(.day==$day)]|length' "$D/launches.jsonl") || die 'launch ledger unreadable'; fi
[ "$count" -lt 4 ] || die 'UTC daily investigation limit reached'
# Pin the native binary before any auth operation or worktree creation.
sha=$(sha256sum /home/danny/.local/bin/claude | cut -c1-64)
[ "$sha" = "$(jq -r .host_packages.claude_code.binary_sha256 "$REPO/deploy/versions.lock.json")" ] || die 'Claude binary differs from pinned version'
valid_token() { jq -e --argjson now "$(date +%s%3N)" '.claudeAiOauth | .accessToken and .subscriptionType == "max" and .expiresAt > ($now + 600000)' /home/danny/.claude/.credentials.json >/dev/null 2>&1; }
if ! valid_token; then
 # Refresh only through the installed CLI's documented noninteractive login.
 # The model still receives only an isolated short-lived access token.
 runuser -u danny -- /usr/bin/env -i PATH=/usr/local/bin:/usr/bin:/bin HOME=/home/danny /bin/bash "$REPO/scripts/m9/incident-auth.sh" >"$D/auth-refresh.txt" 2>&1 || die 'subscription refresh failed; owner attention required'
 chmod 0600 "$D/auth-refresh.txt"
fi
valid_token || die 'subscription access token unavailable or near expiry'
new=false
cleanup_prepare() {
 rc=$?
 if [ "$rc" != 0 ]; then
  rm -f "$W/run/auth/access-token"
  if [ "$new" = true ] && ! systemctl is-active --quiet "fcpi-incident-$id.service"; then
   [ ! -d "$W/tree" ] || rm -rf -- "$W/tree"
   rm -rf -- "$W"
  fi
 fi
}
trap cleanup_prepare EXIT
base=$(source_commit)
# Leave the measured host reserve intact before launching another 768 MiB task.
[ "$(awk '/MemAvailable:/{print $2}' /proc/meminfo)" -ge 2097152 ] || die 'insufficient investigation memory headroom'
[ "$(df -Pk "$D" | awk 'NR==2{print $4}')" -ge 1048576 ] || die 'insufficient investigation disk headroom'
if [ ! -e "$W" ]; then
new=true
git --git-dir="$D/source.git" cat-file -e "$base^{commit}" || die 'deployed source absent from isolated mirror'
# The doctor's own enforced literal-secret scan must pass before any model sees it.
bundle=$(bash "$REPO/scripts/ops/doctor.sh")
bundle=${bundle%% *}; [ -s "$bundle" ] || die 'no diagnostic bundle'
install -d -m 0751 -o root -g root "$W" "$W/empty"
install -d -m 0700 -o danny -g danny "$W/run" "$W/run/auth"
git clone --quiet --no-hardlinks "$D/source.git" "$W/tree"
git -C "$W/tree" switch --detach "$base" >/dev/null
git -C "$W/tree" switch -c "codex/incident-$id" >/dev/null
tar -xzf "$bundle" -C "$W"
diag=$(find "$W" -mindepth 1 -maxdepth 1 -type d -name 'fcpi-doctor-*' | head -1)
# Diagnostic files are bounded/redacted; one JSON input keeps the agent inside its
# Read allowlist. Paths, URLs and @ expansion markers are never promoted into prompts.
find "$diag" -type f -print0 | sort -z | while IFS= read -r -d '' f; do
  jq -cn --arg name "${f#$diag/}" --rawfile content "$f" '{name:$name,content:$content}'
done | jq -sc --arg id "$id" --arg base "$base" '{incident_id:$id,source_commit:$base,diagnostics:.,trust:"untrusted redacted observations"}' >"$W/input.json"
rm -rf -- "$diag"
printf '%s\n' "$base" >"$W/base-sha"
cat /proc/sys/kernel/random/uuid >"$W/session-id"
printf '{"mcpServers":{}}\n' >"$W/mcp.json"
jq -n --arg command "$REPO/scripts/m9/incident-hook.sh" '{hooks:{PreToolUse:[{matcher:".*",hooks:[{type:"command",command:$command,timeout:10}]}]}}' >"$W/settings.json"
echo 0 >"$W/launch-count"
fi
jq -r '.claudeAiOauth.accessToken' /home/danny/.claude/.credentials.json >"$W/run/auth/access-token"
# An old completed result never qualifies as the result of a failed resume.
[ ! -e "$W/run/result.json" ] || mv "$W/run/result.json" "$W/run/result.previous.json"
rm -f "$W/run/result.new.json" "$W/harvested.json" "$W/failed.json"
echo $(( $(cat "$W/launch-count") + 1 )) >"$W/launch-count"
now_s >"$W/launched-at"
jq -cn --arg day "$day" --arg id "$id" --argjson at "$(now_s)" '{day:$day,incident_id:$id,launched_at:$at}' >>"$D/launches.jsonl"
chmod 0600 "$D/launches.jsonl"; sync -f "$D/launches.jsonl"; sync -f "$D"
chown -R danny:danny "$W/tree" "$W/run"
chmod 0600 "$W/run/auth/access-token"
chmod 0644 "$W/settings.json" "$W/input.json" "$W/session-id" "$W/base-sha" "$W/mcp.json"
systemd-run --quiet --unit="fcpi-incident-$id" --uid=danny --gid=danny --collect \
  --property=Slice=fcpi.slice --property=MemoryMax=768M --property=MemorySwapMax=0 --property=CPUQuota=50% --property=TasksMax=128 \
  --property=RuntimeMaxSec=330 --property=TimeoutStopSec=15 --property=KillMode=control-group --property=NoNewPrivileges=yes \
  --property=ProtectSystem=strict --property=ProtectHome=read-only --property=PrivateTmp=yes \
  --property="ReadWritePaths=$W/tree $W/run" --property="InaccessiblePaths=/etc/firecrawl-pi /srv/firecrawl-pi/data /run/docker.sock /home/danny/.ssh /home/danny/.codex /home/danny/.claude $D/control" --property="BindReadOnlyPaths=/home/danny/.local/bin/claude" \
  /usr/bin/env -i PATH=/usr/local/bin:/usr/bin:/bin HOME=/home/danny CLAUDE_CONFIG_DIR="$W/run/auth" \
  /bin/bash "$REPO/scripts/m9/incident-agent.sh" "$id"
notice investigation_started "incident_agent:$id" '{"agent":"subscription","runtime_s":300,"turns":12}' "$(now_s)" "$id"
