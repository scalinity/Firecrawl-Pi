#!/usr/bin/env bash
# Every reboot since M7's BEFORE snapshot, ON the Pi, from the journal: M4's recorder (scripts/m4/pi-reboot-record.sh)
# for a chain of boots rather than one. Each boot the journal holds, from the one the BEFORE snapshot was taken in to
# the current one, with its hashed ID (as the snapshots hash /proc's); for each that ended: its last entry, its
# orderly-shutdown markers, the host's own Wi-Fi watchdog's recovery steps and whether it rebooted the host, the Wi-Fi
# loss before that, any local action after the loss, and undervoltage; then the current boot and the stack's
# recovery. Changes nothing. The watchdog's lines are its recovery steps only; the Wi-Fi network's name, its access
# point's address, the connection's UUID and the gateway's address are never printed.
#   ssh … 'bash -s -- <BEFORE boot_id_sha256>' < scripts/m7/pi-reboot-record.sh
set -uo pipefail
export LC_ALL=C
export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
REPO=/opt/firecrawl-pi
BEFORE=${1:?usage: pi-reboot-record.sh <boot_id_sha256 of the BEFORE snapshot>}
[[ $BEFORE =~ ^[0-9a-f]{64}$ ]] || { echo "bad boot hash: $BEFORE" >&2; exit 1; }
J=(sudo -n journalctl --no-pager --utc -o short-iso)
sec() { printf '### %s\n' "$1"; }
clean() { sed -E "s/^([^ ]+) [^ ]+ /\1 /; s/bssid=[0-9a-f:]{17}/bssid=<bssid>/g; s/'[^']*'/'<redacted>'/g; s/[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+/<address>/g" | cut -c1-220; }
hash_id() { local d; d=$(printf '%s' "$1" | sed -E 's/^(.{8})(.{4})(.{4})(.{4})(.{12})$/\1-\2-\3-\4-\5/'); printf '%s\n' "$d" | sha256sum | cut -c1-64; }
count() { grep -c -E "$1" || true; }

sec meta
echo "utc=$(date -u +%Y-%m-%dT%H:%M:%SZ) source_commit=$(cat $REPO/.fcpi-source-commit) before_boot=$BEFORE"

# The journal's boots from the BEFORE snapshot's to the current one (index 0).
mapfile -t ALL < <(sudo -n journalctl --list-boots --no-pager 2>/dev/null | awk 'NR>1 {print $1, $2}')
chain=() started=0
for b in "${ALL[@]}"; do
  idx=${b%% *} id=${b#* }
  [ "$(hash_id "$id")" = "$BEFORE" ] && started=1
  [ $started = 1 ] && chain+=("$idx")
done
# The journal (capped) may have rotated the BEFORE boot out: then every boot it still holds, for a record made while it
# held BEFORE's to be joined to (X04).
before_found=yes
if [ ${#chain[@]} = 0 ]; then before_found=no; for b in "${ALL[@]}"; do chain+=("${b%% *}"); done; fi
echo "before_found=$before_found"

sec boots
for idx in "${chain[@]}"; do
  id=$(sudo -n journalctl --list-boots --no-pager | awk -v i="$idx" 'NR>1 && $1 == i {print $2}')
  first=$("${J[@]}" -b "$idx" -n +1 2>/dev/null | head -1 | cut -d' ' -f1)
  last=$("${J[@]}" -b "$idx" -n 1 2>/dev/null | tail -1 | cut -d' ' -f1)
  echo "idx=$idx boot_id_sha256=$(hash_id "$id") first=$first last=$last"
done

for idx in "${chain[@]}"; do
  [ "$idx" = 0 ] && continue
  sec "ended_${idx#-}"
  loss=$("${J[@]}" -b "$idx" -u wpa_supplicant 2>/dev/null | grep 'CTRL-EVENT-DISCONNECTED' | tail -1 | cut -d' ' -f1)
  wd=$("${J[@]}" -b "$idx" -t net-watchdog 2>/dev/null)
  after=""
  [ -n "$loss" ] && after=$("${J[@]}" -b "$idx" --since "$(date -u -d "$loss + 1 second" '+%Y-%m-%d %H:%M:%S')" 2>/dev/null)
  last=$("${J[@]}" -b "$idx" -n 1 2>/dev/null | tail -1 | cut -d' ' -f1)
  markers=$("${J[@]}" -b "$idx" 2>/dev/null | count 'systemd-shutdown|Reached target .*(Shutdown|Reboot|Power-Off|Final Step)|reboot: (Restarting|Power down)|Stopping .*docker\.service')
  rebooted=no; printf '%s\n' "$wd" | grep 'recovery 3/3: .*rebooting' >/dev/null && rebooted=yes
  sudo_n=$(printf '%s\n' "$after" | count 'sudo\[[0-9]+\]: .*COMMAND=')
  ssh_n=$(printf '%s\n' "$after" | count 'Accepted (publickey|password)')
  sess_n=$(printf '%s\n' "$after" | count 'New session')
  console_n=$(printf '%s\n' "$after" | count 'login\[[0-9]+\]|getty')
  uv=$("${J[@]}" -b "$idx" -k 2>/dev/null | count '[Uu]ndervoltage|under-voltage')
  echo "last=$last shutdown_markers=$markers watchdog_reboot=$rebooted loss_utc=${loss:-none} sudo_commands=$sudo_n ssh_logins=$ssh_n sessions=$sess_n console_logins=$console_n undervoltage=$uv"
  printf '%s\n' "$wd" | grep -E 'recovery [0-9]/3' | clean
done

sec current
echo "boot_id_sha256=$(sha256sum </proc/sys/kernel/random/boot_id | cut -c1-64) kernel=$(uname -r) page_size=$(getconf PAGESIZE) up_since_utc=$(date -u -d "@$(( $(date +%s) - $(cut -d. -f1 /proc/uptime) ))" +%Y-%m-%dT%H:%M:%SZ)"
echo "rsts=$(vcgencmd get_rsts 2>/dev/null | cut -d= -f2) throttled_this_boot=$(vcgencmd get_throttled 2>/dev/null | cut -d= -f2)"

sec recovery
# The current boot: dockerd's gate (the data check and the guard), dockerd, the stack's unit, each project container.
for u in docker.service fcpi-stack.service; do echo "$u $(systemctl show -p ExecMainStatus -p ActiveState "$u" | paste -sd' ' -)"; done
"${J[@]}" -b 0 -t fcpi-data-check.sh -t fcpi-egress-local.sh 2>/dev/null | clean | head -4
sudo -n docker ps -a --filter label=com.docker.compose.project=fcpi --format '{{.Label "com.docker.compose.service"}}' | sort | while read -r s; do
  c=$(sudo -n docker ps -aq --filter label=com.docker.compose.project=fcpi --filter "label=com.docker.compose.service=$s" | head -1)
  sudo -n docker inspect -f "$s status={{.State.Status}} health={{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}} restarts={{.RestartCount}}" "$c"
done
echo end
