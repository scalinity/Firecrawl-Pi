#!/usr/bin/env bash
# The unplanned reset during M4's evidence window, ON the Pi, from the journal and the firmware: which
# boots the BEFORE and AFTER snapshots belong to (each journal boot's ID hashed as the snapshots hash
# /proc's), how the earlier boot ended, the Wi-Fi loss before it, any local action after that loss,
# undervoltage, the reset reason, and the new boot's kernel, page size and recovery. Changes nothing.
# The Wi-Fi network's name, its access point's address and the connection's UUID are redacted.
#   ssh … 'bash -s -- <window-open UTC>' < scripts/m4/pi-reboot-record.sh
set -uo pipefail
export LC_ALL=C
export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
REPO=/opt/firecrawl-pi
SINCE=${1:?usage: pi-reboot-record.sh <window-open UTC, e.g. 2026-09-26T17:21:47Z>}
[[ $SINCE =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9:]{8}Z$ ]] || { echo "bad time: $SINCE" >&2; exit 1; }
J=(sudo -n journalctl --no-pager --utc -o short-iso)
sec() { printf '### %s\n' "$1"; }
# Journal lines as "<UTC time> <identifier>: <message>", without the host name, redacted.
clean() { sed -E "s/^([^ ]+) [^ ]+ /\1 /; s/bssid=[0-9a-f:]{17}/bssid=<bssid>/g; s/'[^']*' \(([0-9a-f-]{36})\)/'<wifi-ssid>' (<connection-uuid>)/g; s/(connection|access point) '[^']*'/\1 '<wifi-ssid>'/g" | cut -c1-220; }
hash_id() { local d; d=$(printf '%s' "$1" | sed -E 's/^(.{8})(.{4})(.{4})(.{4})(.{12})$/\1-\2-\3-\4-\5/'); printf '%s\n' "$d" | sha256sum | cut -c1-64; }
count() { grep -c -E "$1" || true; }

sec meta
echo "utc=$(date -u +%Y-%m-%dT%H:%M:%SZ) source_commit=$(cat $REPO/.fcpi-source-commit) window_open=$SINCE"

sec boots
# The last two boots: index, the hashed ID, and the first and last entry the journal holds for each.
sudo -n journalctl --list-boots --no-pager 2>/dev/null | awk 'NR>1 && ($1=="-1" || $1=="0") {print $1, $2}' | while read -r idx id; do
  first=$(sudo -n journalctl -b "$idx" --no-pager --utc -o short-iso -n +1 2>/dev/null | head -1 | cut -d' ' -f1)
  last=$(sudo -n journalctl -b "$idx" --no-pager --utc -o short-iso -n 1 2>/dev/null | tail -1 | cut -d' ' -f1)
  echo "idx=$idx boot_id_sha256=$(hash_id "$id") first=$first last=$last"
done

sec current
echo "boot_id_sha256=$(sha256sum </proc/sys/kernel/random/boot_id | cut -c1-64) kernel=$(uname -r) page_size=$(getconf PAGESIZE) up_since_utc=$(date -u -d "@$(( $(date +%s) - $(cut -d. -f1 /proc/uptime) ))" +%Y-%m-%dT%H:%M:%SZ)"
echo "rsts=$(vcgencmd get_rsts 2>/dev/null | cut -d= -f2) throttled_this_boot=$(vcgencmd get_throttled 2>/dev/null | cut -d= -f2)"
echo "$(systemctl show -p RuntimeWatchdogUSec -p RebootWatchdogUSec | paste -sd' ' -)"

sec old_boot_end
echo "last_entries:"
"${J[@]}" -b -1 -n 3 2>/dev/null | clean | sed -E 's/^([^ ]+ [^:]+):.*/  \1/'
echo "shutdown_markers=$("${J[@]}" -b -1 2>/dev/null | count 'systemd-shutdown|Reached target .*(Shutdown|Reboot|Power-Off|Final Step)|reboot: (Restarting|Power down)|Stopping .*docker\.service')"

sec wifi_loss
"${J[@]}" -b -1 --since "${SINCE/T/ }" -u NetworkManager -u wpa_supplicant 2>/dev/null \
  | grep -E 'CTRL-EVENT-DISCONNECTED|ssid-not-found|link timed out|Activation: failed|secrets are required|need-auth|state is now' | clean
"${J[@]}" -b -1 -k --since "${SINCE/T/ }" 2>/dev/null | grep -E 'brcmf|brcmfmac' | clean

sec local_actions_after_loss
loss=$("${J[@]}" -b -1 --since "${SINCE/T/ }" -u wpa_supplicant 2>/dev/null | grep -m1 'CTRL-EVENT-DISCONNECTED' | cut -d' ' -f1)
echo "loss_utc=${loss:-none}"
if [ -n "$loss" ]; then
  after=$("${J[@]}" -b -1 --since "$(date -u -d "$loss + 1 second" '+%Y-%m-%d %H:%M:%S')" 2>/dev/null)
  echo "sudo_commands=$(printf '%s\n' "$after" | count 'sudo\[[0-9]+\]: .*COMMAND=') ssh_logins=$(printf '%s\n' "$after" | count 'Accepted (publickey|password)') sessions=$(printf '%s\n' "$after" | count 'New session') console_logins=$(printf '%s\n' "$after" | count 'login\[[0-9]+\]|getty')"
fi

sec undervoltage
echo "old_boot=$("${J[@]}" -b -1 -k 2>/dev/null | count '[Uu]ndervoltage|under-voltage') this_boot=$("${J[@]}" -b 0 -k 2>/dev/null | count '[Uu]ndervoltage|under-voltage')"

sec recovery
# The new boot, in order: the kernel, dockerd's gate (the data check and the guard), dockerd, the stack's
# unit, and every project container's start and health.
echo "kernel_first=$("${J[@]}" -b 0 -k -n +1 2>/dev/null | head -1 | cut -d' ' -f1) $(sudo -n journalctl -b 0 -k --no-pager -o cat -n +2 2>/dev/null | grep -m1 -o 'Linux version [^ ]*')"
for u in docker.service fcpi-stack.service; do
  echo "$u $(systemctl show -p ActiveState -p ActiveEnterTimestamp -p ExecMainStatus "$u" | paste -sd' ' -)"
done
"${J[@]}" -b 0 -u docker.service 2>/dev/null | grep -E 'fcpi|data check|guard|Started|Starting' | grep -v -E 'level=(info|debug)' | clean | head -8
sudo -n docker ps -a --filter label=com.docker.compose.project=fcpi --format '{{.ID}}' | while read -r c; do
  sudo -n docker inspect -f '{{index .Config.Labels "com.docker.compose.service"}} started={{.State.StartedAt}} status={{.State.Status}} health={{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}} restarts={{.RestartCount}}' "$c"
done | sort

echo end
