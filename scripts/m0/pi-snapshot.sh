#!/usr/bin/env bash
# M0 integrity snapshot. Runs ON the Pi through `ssh ... bash -s` and prints to
# stdout only: no file, temp file or tee output is written on the Pi.
#
# Values that drift without any state change are normalised away so that the
# BEFORE/AFTER diff shows real changes only:
#   - ss: accept-queue depths (Recv-Q/Send-Q) are dropped;
#   - swap: the "Used" column is dropped;
#   - firewall: hashed from `nft -s` (stateless: no packet/byte counters);
#   - lsmod: module name and size only (use counts move with normal activity).
# lsmod is read before `ss`, because ss's sock_diag query can auto-load
# inet_diag/tcp_diag; reading modules first keeps such a load visible in AFTER.
# A section whose probe could change state is skipped with the reason printed.
set -u
export LC_ALL=C
export PATH="/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"
sec() { printf '### %s\n' "$1"; }

sec meta
date -u +%Y-%m-%dT%H:%M:%SZ
printf 'boot_id_sha256=%s\n' "$(sha256sum </proc/sys/kernel/random/boot_id | cut -c1-64)"

sec systemd_running
systemctl list-units --state=running --no-legend --plain --no-pager | awk '{print $1}' | sort

sec systemd_enabled
systemctl list-unit-files --state=enabled --no-legend --no-pager | awk '{print $1}' | sort

# docker must be checked before any docker command: with docker.service
# inactive and docker.socket active, a docker command would start the daemon.
sec docker_activation
for u in docker.service docker.socket containerd.service; do
  printf '%s=%s\n' "$u" "$(systemctl is-active "$u" 2>/dev/null)"
done

sec docker_ps
if [ "$(systemctl is-active docker.service 2>/dev/null)" = active ]; then
  sudo -n docker ps -a --no-trunc --format '{{.ID}}\t{{.Names}}\t{{.Image}}\t{{.State}}' | sort
else
  echo "SKIPPED docker.service not active; no docker command run"
fi

sec lsmod
lsmod | awk 'NR>1 {print $1, $2}' | sort

sec ss_listen
sudo -n ss -Hlntup | awk '{print $1, $5, $7}' | sort

sec findmnt
findmnt -rn -o TARGET,SOURCE,FSTYPE,OPTIONS | sort

# Only query a firewall backend whose kernel module is already loaded, so that
# listing rules can never auto-load a netfilter module.
sec firewall
if lsmod | awk '{print $1}' | grep -qx nf_tables; then
  if command -v nft >/dev/null 2>&1; then
    printf 'nft_ruleset_sha256=%s\n' "$(sudo -n nft -s list ruleset | sha256sum | cut -c1-64)"
  else
    echo "nft_ruleset_sha256=UNAVAILABLE nft binary absent"
  fi
else
  echo "nft_ruleset_sha256=SKIPPED nf_tables module not loaded"
fi
if lsmod | awk '{print $1}' | grep -qx ip_tables && command -v iptables-legacy-save >/dev/null 2>&1; then
  printf 'iptables_legacy_sha256=%s\n' "$(sudo -n iptables-legacy-save | grep -v '^#' | sed -E 's/\[[0-9]+:[0-9]+\]//' | sha256sum | cut -c1-64)"
else
  echo "iptables_legacy_sha256=SKIPPED ip_tables module not loaded or iptables-legacy-save absent"
fi

sec swap_zram
awk 'NR>1 {print "swap", $1, $2, $3, $5}' /proc/swaps
for d in /sys/block/zram*; do
  [ -e "$d" ] || continue
  printf 'zram %s disksize=%s algo=%s\n' "${d##*/}" "$(cat "$d/disksize")" "$(cat "$d/comp_algorithm")"
done
echo "end"
