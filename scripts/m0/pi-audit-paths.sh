#!/usr/bin/env bash
# M0 read-only follow-up: re-check utilities that live in /usr/sbin or /sbin.
# pi-audit.sh used `command -v` on the non-login PATH, which excludes /usr/sbin,
# so its "absent" results for sbin tools are not evidence of absence.
# Runs ON the Pi through `ssh ... bash -s`; writes nothing on the Pi.
set -u
export LC_ALL=C
export PATH="/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"
sec() { printf '### %s\n' "$1"; }

sec probe_time
date -u +%Y-%m-%dT%H:%M:%SZ

sec sbin_tools
for t in nft iptables iptables-legacy iptables-nft ip6tables ufw firewall-cmd zramctl dumpe2fs tailscale tailscaled sshd losetup iw sysctl smartctl nvme sensors sqlite3 wget curl jq git node npm docker; do
  printf '%s=%s\n' "$t" "$(command -v "$t" || echo absent)"
done

sec packages
dpkg-query -W -f='${Package} ${Version} ${db:Status-Abbrev}\n' nftables iptables ufw fail2ban zram-tools util-linux e2fsprogs 2>/dev/null

sec zramctl
zramctl 2>/dev/null || echo "zramctl unavailable"

sec losetup
losetup -l -n -O NAME,BACK-FILE,SIZELIMIT,RO 2>/dev/null || echo "losetup unavailable"
echo end
