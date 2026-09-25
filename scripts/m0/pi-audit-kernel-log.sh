#!/usr/bin/env bash
# M0 read-only follow-up: kernel log lines retained for the current boot, to
# establish whether any audit probe produced a kernel event (for example a
# module request). Runs ON the Pi through `ssh ... bash -s`; writes nothing on
# the Pi. MAC addresses and the machine-id (journald names its directory after it)
# are hashed, and link-local IDs and the imager instance id masked, before output
# leaves the Pi.
set -u
export LC_ALL=C
export PATH="/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"
h() { printf '%s' "$1" | sha256sum | cut -c1-64; }
out=$(
  printf '### probe_time\n%s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  printf '### kernel_log_current_boot\n'
  sudo -n journalctl -k -b 0 --no-pager -o short-iso --utc 2>&1 | tail -200
  printf '### dmesg_tail\n'
  sudo -n dmesg --time-format iso 2>&1 | tail -40
)
mid=$(cat /etc/machine-id 2>/dev/null)
if [ -n "$mid" ]; then out=${out//$mid/MACHINE_ID_SHA256:$(h "$mid")}; fi
serial=$(tr -d '\0' </proc/device-tree/serial-number 2>/dev/null)
if [ -n "$serial" ]; then out=${out//$serial/SERIAL_SHA256:$(h "$serial")}; fi
for mac in $(printf '%s\n' "$out" | grep -oiE '([0-9a-f]{2}[:-]){5}[0-9a-f]{2}' | sort -u); do
  out=${out//$mac/MAC_SHA256:$(h "$(printf '%s' "$mac" | tr 'A-F-' 'a-f:')")}
done
# Same non-functional identifiers as pi-audit.sh: boot-time kernel lines print the imager instance id.
printf '%s\n' "$out" | sed -E -e 's/fe80::[0-9a-fA-F:]+/fe80::<link-local>/g' -e 's/rpi-imager-[0-9]+/rpi-imager-<id>/g'
echo end
