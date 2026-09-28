#!/usr/bin/env bash
# M4's collector for M8's window (each container's cgroup under its own parent, fcpi.slice since M8, and the slice's
# swap limit beside the scope's). The owner's own work on the Pi during the window, as the host records it, so the snapshot diff can
# attribute what it changed (X04) and the swap-limit reset can be traced to its cause. Read-only, ON the Pi:
#   ssh … 'bash -s -- <since-utc>' < scripts/m8/pi-owner-session.sh > evidence/M8/raw/owner-session.txt
# Prints the apt run (its command line, package counts, kernel and firmware entries, the held packages),
# the journal's sudo, reload, tracefs and device-mapper lines, the loopback listeners of processes run by a
# login user, Pi-hole's own UDP sockets, and every project container's memory.swap.max. The owner's user
# name and home directory are replaced with <owner> and <owner-home>.
set -uo pipefail
export LC_ALL=C
export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
since=${1:?usage: pi-owner-session.sh <since-utc, e.g. 2026-09-26T15:14:00Z>}
OWNER=$(id -un 1000); HOMEDIR=$(getent passwd 1000 | cut -d: -f6)
red() { sed -e "s#${HOMEDIR}#<owner-home>#g" -e "s#\b${OWNER}\b#<owner>#g" -E -e 's#fe80::[0-9a-f:%a-z]+#<link-local>#g'; }
echo "### meta"
echo "utc=$(date -u +%Y-%m-%dT%H:%M:%SZ) since=$since running_kernel=$(uname -r) boot_id_sha256=$(sha256sum </proc/sys/kernel/random/boot_id | cut -c1-64)"
echo "### apt_runs"
# Every apt run that started inside the window (history.log's times are the Pi's local time).
sudo -n awk -v s="$(date -d "$since" '+%Y-%m-%d  %H:%M:%S')" '/^Start-Date: /{d=substr($0,13); keep=(d>=s)} keep' /var/log/apt/history.log | while IFS= read -r l; do
  case "$l" in
    Start-Date:*|End-Date:*|Commandline:*|Requested-By:*) echo "$l" ;;
    Install:*|Upgrade:*|Remove:*) k=${l%%:*}; echo "$k packages=$(printf '%s\n' "${l#*: }" | tr -s ')' '\n' | grep -c 'arm64\|all')"
      printf '%s\n' "${l#*: }" | tr -s ')' '\n' | sed 's/^, //' | grep -E '^(linux-image|linux-base|raspi-firmware|firmware-|docker|containerd|tailscale|systemd|runc|nftables|network-manager|openssh)' | sed "s/^/$k /" ;;
  esac
done | red
echo "held=$(apt-mark showhold | tr '\n' ' ')"
echo "### journal"
sudo -n journalctl --since "$since" --no-pager -o short-iso-precise --utc 2>/dev/null \
  | grep -E 'sudo\[[0-9]+\]: .*COMMAND=/usr/bin/apt|systemd\[1\]: Reloading|Automounting of tracing|device-mapper: ioctl' | red
echo "### loopback_listeners"
for p in $(sudo -n ss -Hltnp | grep -E '^LISTEN +[0-9]+ +[0-9]+ +127\.0\.0\.1:' | grep -o 'pid=[0-9]*' | cut -d= -f2 | sort -u); do
  u=$(ps -o uid= -p "$p" | tr -d ' ')
  [ "${u:-0}" -ge 1000 ] || continue
  ports=$(sudo -n ss -Hltnp | grep "pid=$p," | awk '{print $4}' | tr '\n' ' ')
  echo "pid=$p uid=$u started=$(date -u -d "@$(( $(date +%s) - $(ps -o etimes= -p "$p" | tr -d " ") ))" +%Y-%m-%dT%H:%M:%SZ) exe=$(sudo -n readlink "/proc/$p/exe" | red) ports=$ports"
done
echo "### pihole_udp"
sudo -n ss -Hlunp | grep pihole-FTL | awk '{print $4}' | sort
echo "### container_swap"
for c in $(sudo -n docker ps -q --filter label=com.docker.compose.project=fcpi); do
  read -r id parent < <(sudo -n docker inspect -f '{{.Id}} {{.HostConfig.CgroupParent}}' "$c"); parent=${parent:-system.slice}
  echo "$(sudo -n docker inspect -f '{{index .Config.Labels "com.docker.compose.service"}}' "$c") started=$(sudo -n docker inspect -f '{{.State.StartedAt}}' "$c") memory.swap.max=$(cat /sys/fs/cgroup/$parent/docker-$id.scope/memory.swap.max) parent=$parent parent_swap_max=$(cat /sys/fs/cgroup/$parent/memory.swap.max)"
done
echo "### end"
