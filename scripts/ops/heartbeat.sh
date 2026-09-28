#!/usr/bin/env bash
# The heartbeat the VPS watchdog reads (FIRECRAWL_PI_SPEC.md §25), run by fcpi-heartbeat.timer every minute as root, ON
# the Pi. A dated status, from what the tick and the probe already recorded (nothing is asked of the gateway), goes over
# SFTP to the backup account on the owner's VPS (heartbeat/pi.status), with the backup's own SSH key and pinned host key:
# the account can do nothing else, so no endpoint on the Pi and no inbound path to it exist for this. Key=value lines, so
# the VPS reads them without a JSON tool; "end=1" last, so a partly written file is never taken for a whole one. The VPS
# times each arrival by its own clock. Holds operational state only: times, ages, true/false, counts.
set -uo pipefail
. "$(dirname "$(readlink -f "$0")")/lib.sh"
need_root
exec 9>"$RUND/heartbeat.lock"; flock -n 9 || exit 0
# shellcheck disable=SC1090
. "$BACKUP_ENV" 2>/dev/null
[[ ${FCPI_RESTIC_REPOSITORY:-} =~ ^sftp:([^@:/]+@[^:/]+): ]] || { logger -t fcpi-heartbeat -- "no sftp backup repository: no heartbeat sent"; exit 0; }
dest=${BASH_REMATCH[1]}
K=/etc/firecrawl-pi/secrets/backup
s=$(obj "$RUND/last-sample.json") p=$(obj "$STATE/probe-last.json") a=$(obj "$STATE/alerts/state.json") now=$(now_s)
age() { local t; t=$(jq -r "$1 // empty | fromdateiso8601" <<<"$2" 2>/dev/null); [[ $t =~ ^[0-9]+$ ]] && echo $(( now - t )) || echo -1; }
core=$(jq -r '[.containers[]? | select(.service == "firecrawl-core")][0].health // "unknown"' <<<"$s")
body=$(printf 'utc=%s\nboot=%s\ncommit=%s\ntick_age_s=%s\nprobe_ok=%s\nprobe_age_s=%s\ncore_health=%s\nopen_incidents=%s\nend=1\n' \
  "$(utc)" "$(boot_hash | cut -c1-12)" "$(source_commit | cut -c1-12)" "$(age .utc "$s")" "$(jq -r '.ok // false | tostring' <<<"$p")" "$(age .utc "$p")" \
  "$core" "$(jq -r '[.[] | select(.open)] | length' <<<"$a")")
t=$(mktemp "$RUND/heartbeat.XXXXXX"); printf '%s' "$body" >"$t"
timeout 30 sftp -q -i "$K/ssh_ed25519" -o IdentitiesOnly=yes -o BatchMode=yes -o StrictHostKeyChecking=yes -o UserKnownHostsFile="$K/known_hosts" \
  -o ConnectTimeout=15 -b - "$dest" >/dev/null 2>&1 <<EOF; rc=$?
put $t /heartbeat/pi.status
EOF
rm -f "$t"
[ "$rc" = 0 ] || logger -t fcpi-heartbeat -p user.warning -- "heartbeat not delivered (sftp exit $rc)"
exit 0
