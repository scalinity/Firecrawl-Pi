#!/usr/bin/env bash
# M0 read-only follow-up probe. Runs ON the Pi through `ssh ... bash -s`, writes
# nothing on the Pi. Same constraints and redaction rules as pi-audit.sh.
# Contains the single permitted credential-free GET to a public IP-echo endpoint.
set -u
export LC_ALL=C
sec() { printf '### %s\n' "$1"; }
h() { printf '%s' "$1" | sha256sum | cut -c1-64; }

probes() {
  sec probe_time
  date -u +%Y-%m-%dT%H:%M:%SZ

  sec proc_sys
  # Read directly: `sysctl` is in /usr/sbin, which is not on a non-login PATH.
  for k in vm/swappiness vm/overcommit_memory vm/min_free_kbytes vm/dirty_ratio vm/dirty_background_ratio \
           kernel/unprivileged_userns_clone user/max_user_namespaces kernel/apparmor_restrict_unprivileged_userns \
           net/ipv4/ip_forward net/ipv4/ip_local_port_range net/ipv6/conf/all/disable_ipv6 net/ipv6/conf/wlan0/disable_ipv6 \
           net/ipv6/conf/all/forwarding net/ipv4/conf/all/rp_filter fs/inotify/max_user_watches; do
    f=/proc/sys/$k
    printf '%s=%s\n' "$(echo "$k" | tr / .)" "$( [ -r "$f" ] && tr '\t' ' ' <"$f" || echo ABSENT)"
  done

  sec boot_config
  # Read-only views of boot configuration (never written).
  echo "--- /boot/firmware/cmdline.txt (as configured, before firmware additions)"
  sed -E 's/rpi-imager-[0-9]+/rpi-imager-<id>/' /boot/firmware/cmdline.txt 2>/dev/null
  echo "--- /boot/firmware/config.txt (non-comment lines)"
  grep -vE '^\s*(#|$)' /boot/firmware/config.txt 2>/dev/null
  echo "--- kernel images present"
  ls /boot/firmware/ 2>/dev/null | grep -E '^kernel' | tr '\n' ' '; echo

  sec journald
  grep -hE '^\s*Storage=' /etc/systemd/journald.conf /etc/systemd/journald.conf.d/*.conf 2>/dev/null || echo "Storage= not set (default auto)"
  echo "var_log_journal=$( [ -d /var/log/journal ] && echo present || echo absent)"
  echo "journal_disk_usage=$(sudo -n journalctl --disk-usage 2>/dev/null)"

  sec zram_writeback
  printf 'backing_dev=%s\n' "$(cat /sys/block/zram0/backing_dev 2>/dev/null)"
  printf 'bd_stat=%s\n' "$(cat /sys/block/zram0/bd_stat 2>/dev/null)"
  printf 'mm_stat=%s\n' "$(cat /sys/block/zram0/mm_stat 2>/dev/null)"
  printf 'writeback_limit_enable=%s writeback_limit=%s\n' "$(cat /sys/block/zram0/writeback_limit_enable 2>/dev/null)" "$(cat /sys/block/zram0/writeback_limit 2>/dev/null)"
  losetup -l -n -O NAME,BACK-FILE,SIZELIMIT,RO 2>/dev/null || echo "losetup unavailable"
  ls -ls /var/swap 2>/dev/null
  systemctl cat rpi-zram-writeback.timer 2>/dev/null | grep -E '^(OnCalendar|OnUnitActiveSec|OnBootSec)'

  sec nm_ipv6
  nmcli -t -f GENERAL.DEVICE,IP6.ADDRESS,IP6.GATEWAY device show wlan0 2>/dev/null | sed -E 's/(fe80::)[0-9a-f:]+/\1<link-local>/'
  nmcli -g ipv6.method,ipv6.addr-gen-mode connection show "$(nmcli -g GENERAL.CONNECTION device show wlan0 2>/dev/null)" 2>/dev/null | tr '\n' ' '; echo

  sec wifi_link
  # Signal and rate only; no SSID/BSSID.
  iw dev wlan0 link 2>/dev/null | grep -E 'signal|tx bitrate|rx bitrate' || echo "iw unavailable"

  sec inbound_evidence
  # Evidence of reachability from outside the local subnet, without scanning:
  # sshd connection sources recorded in the journal, counted by class only.
  # The subnet is read from the interface, not hard-coded.
  cidr=$(ip -4 -o addr show scope global 2>/dev/null | awk '{print $4}' | head -1)
  printf 'local_cidr=%s\n' "${cidr:-UNKNOWN}"
  sudo -n fail2ban-client status sshd 2>/dev/null | grep -E 'Currently failed|Total failed|Currently banned|Total banned'
  srcs=$(sudo -n journalctl -u ssh.service --no-pager -o cat 2>/dev/null | grep -oE 'from [0-9]+\.[0-9]+\.[0-9]+\.[0-9]+' | awk '{print $2}')
  classify='function n(a, p) { split(a, p, "."); return ((p[1]*256+p[2])*256+p[3])*256+p[4] }
    BEGIN { split(cidr, c, "/"); size = 2^(32-c[2]); base = int(n(c[1])/size)*size }
    { if (n($1) >= base && n($1) < base+size) print "local " $1; else print "outside " $1 }'
  printf '%s\n' "$srcs" | grep . | awk -v cidr="$cidr" "$classify" \
    | awk '{ c[$1]++ } END { printf "sshd_journal_sources local_subnet=%d outside_subnet=%d\n", c["local"], c["outside"] }'
  printf '%s\n' "$srcs" | grep . | sort -u | awk -v cidr="$cidr" "$classify" | grep -c '^outside' | sed 's/^/distinct_outside_sources=/'
  sudo -n journalctl -u ssh.service --no-pager -o short-iso 2>/dev/null | head -1 | cut -c1-25 | sed 's/^/journal_first_entry=/'
  sudo -n journalctl -u ssh.service --no-pager -o cat 2>/dev/null | grep -cE 'Invalid user|preauth' | sed 's/^/preauth_or_invalid_user_lines=/'

  sec ip_echo
  # The single permitted credential-free GET to a public IP-echo endpoint.
  # Only a SHA-256 of the answer is printed: the raw address never leaves the Pi.
  # FCPI_SKIP_IP_ECHO=1 skips the request (used once the permitted GET is spent).
  if [ "${FCPI_SKIP_IP_ECHO:-0}" = 1 ]; then
    echo "api.ipify.org => SKIPPED (FCPI_SKIP_IP_ECHO=1; no request sent)"
  else
    lan_ip=${cidr%/*}
    egress=$(curl -s --max-time 10 https://api.ipify.org 2>/dev/null)
    if printf '%s' "$egress" | grep -qE '^[0-9]{1,3}(\.[0-9]{1,3}){3}$'; then
      printf 'api.ipify.org => EGRESS_IP_SHA256:%s (raw value withheld; differs from interface: %s)\n' \
        "$(h "$egress")" "$( [ "$egress" != "$lan_ip" ] && echo yes || echo no)"
    else
      echo "api.ipify.org => UNAVAILABLE (no IPv4 literal returned within 10s)"
    fi
    unset egress
  fi
}

out=$(probes 2>&1)
for mac in $(printf '%s\n' "$out" | grep -oiE '([0-9a-f]{2}[:-]){5}[0-9a-f]{2}' | sort -u); do
  out=${out//$mac/MAC_SHA256:$(h "$(printf '%s' "$mac" | tr 'A-F-' 'a-f:')")}
done
printf '%s\n' "$out"
echo "end"
