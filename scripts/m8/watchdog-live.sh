#!/usr/bin/env bash
# The external watchdog's live proof (FIRECRAWL_PI_SPEC.md §25; N02), from the workstation:
#   scripts/m8/watchdog-live.sh > evidence/M8/raw/watchdog-live.txt
# A controlled loss of the Pi's heartbeat: fcpi-heartbeat.timer stopped on the Pi (the Pi and Firecrawl keep running)
# until the VPS watchdog opens its incident, three more minutes to show no second notice, then the timer started again
# until the incident clears. Records the watchdog's events in the window, its state, the installed script's hash against
# the repository's, and what ntfy's server holds for the owner's topic in the window (each message's id, time, title,
# priority, tags and incident line; never the topic, which reaches curl as a config on a descriptor, nor the VPS's
# address). The timer is started again whatever happens.
set -uo pipefail
root=$(cd "$(dirname "$0")/../.." && pwd)
# shellcheck source=scripts/m1/pi-target.conf
. "$root/scripts/m1/pi-target.conf"
# shellcheck disable=SC1090
. "$HOME/.config/firecrawl-pi/vps.conf"
VPS_SSH_KEY=${VPS_SSH_KEY/\$HOME/$HOME} VPS_KNOWN_HOSTS=${VPS_KNOWN_HOSTS/\$HOME/$HOME}
P=(ssh -i "$PI_SSH_KEY" -o IdentitiesOnly=yes -o BatchMode=yes "$PI_SSH_TARGET")
V=(ssh -i "$VPS_SSH_KEY" -o IdentitiesOnly=yes -o BatchMode=yes -o StrictHostKeyChecking=yes -o UserKnownHostsFile="$VPS_KNOWN_HOSTS" "$VPS_SSH_TARGET")
utc() { date -u +%Y-%m-%dT%H:%M:%SZ; }
# Read line by line (NULs dropped, damaged lines skipped), so one bad line cannot hide the events after it.
events() { "${V[@]}" "cat /var/lib/fcpi-watchdog/events.jsonl 2>/dev/null" | tr -d '\000' | jq -cR --arg t "$t0" 'fromjson? | objects | select(.utc >= $t)'; }
waitfor() { local end=$(( $(date +%s) + $1 )); while [ "$(date +%s)" -lt "$end" ]; do events | jq -e "select(.event == \"$2\")" >/dev/null 2>&1 && return 0; sleep 20; done; return 1; }
t0=$(utc)
echo "### meta"
echo "utc=$t0 deployed_commit=$("${P[@]}" 'cat /opt/firecrawl-pi/.fcpi-source-commit') watchdog_installed_sha256=$("${V[@]}" 'sha256sum /usr/local/lib/fcpi-watchdog/fcpi-watchdog.sh' | cut -c1-64) watchdog_repository_sha256=$(sha256sum "$root/deploy/vps/fcpi-watchdog.sh" | cut -c1-64)"
echo "### before"
"${V[@]}" 'cat /var/lib/fcpi-watchdog/state; echo "heartbeat_age_s=$(( $(date +%s) - $(stat -c %Y /srv/fcpi-backup/heartbeat/pi.status) ))"'
trap '"${P[@]}" "sudo -n systemctl start fcpi-heartbeat.timer" >/dev/null 2>&1' EXIT
"${P[@]}" 'sudo -n systemctl stop fcpi-heartbeat.timer'; t_stop=$(utc)
opened=false; waitfor 540 opened && opened=true; t_open=$(utc)
sleep 180                                                   # three more checks of the same outage: no second notice
"${P[@]}" 'sudo -n systemctl start fcpi-heartbeat.timer && sudo -n systemctl start fcpi-heartbeat.service'; t_start=$(utc)
cleared=false; waitfor 360 cleared && cleared=true
echo "### window"
echo "{\"from\":\"$t0\",\"heartbeat_stopped\":\"$t_stop\",\"opened_seen\":\"$t_open\",\"heartbeat_started\":\"$t_start\",\"to\":\"$(utc)\",\"opened\":$opened,\"cleared\":$cleared}"
echo "### events"
events
echo "### after"
"${V[@]}" 'cat /var/lib/fcpi-watchdog/state'
echo "### ntfy_server"
since=$(date -u -j -f %Y-%m-%dT%H:%M:%SZ "$t0" +%s 2>/dev/null || date -u -d "$t0" +%s)
curl -sS --proto =https --max-time 20 -K <(printf 'url = "https://ntfy.sh/%s/json?poll=1&since=%s"\n' "$(security find-generic-password -a fcpi -s "fcpi ntfy topic" -w | tr -d '\n')" "$since") \
  | jq -c 'select(.event == "message") | {id, time, title, priority, tags, incident: ((.message // "") | capture("Incident: (?<i>[0-9a-f]+)").i // null)}'
echo "### end"
