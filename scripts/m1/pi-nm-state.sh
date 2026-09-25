#!/usr/bin/env bash
# Evidence for NetworkManager leaving Docker's interfaces alone
# (deploy/host/NetworkManager/90-fcpi-unmanaged.conf; REVIEW.md R14). Runs ON the Pi:
#   ssh ... 'bash /opt/firecrawl-pi/scripts/m1/pi-nm-state.sh <phase> [<since>]'
#   before  device states before the file is installed (the positive control)
#   after   device states once pi-init.sh has installed it and reloaded NM's config
#   window  NM's journal since <since> (UTC, "YYYY-MM-DD HH:MM:SS"): activations on
#           Docker's interfaces and any wlan0 state change
# Read-only.
set -uo pipefail
export LC_ALL=C
export PATH="/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"
phase=${1:?usage: pi-nm-state.sh before|after|window [<since>]}
sec() { printf '### %s_%s\n' "$phase" "$1"; }

sec meta
date -u +%Y-%m-%dT%H:%M:%SZ
echo "conf_sha256=$(sudo -n sha256sum /etc/NetworkManager/conf.d/90-fcpi-unmanaged.conf 2>/dev/null | cut -c1-64 || true)"
echo "repo_conf_sha256=$(sha256sum </opt/firecrawl-pi/deploy/host/NetworkManager/90-fcpi-unmanaged.conf 2>/dev/null | cut -c1-64 || true)"

if [ "$phase" != window ]; then
  sec devices
  # device type state; the Wi-Fi uplink and every Docker interface
  nmcli -t -f DEVICE,TYPE,STATE device | grep -E '^(wlan0|veth[0-9a-f]+|fcpi-[a-z]+|docker0):' | sed 's/:/ /g' | sort
else
  since=${2:?window needs <since>}
  sec journal
  echo "since=$since"
  j=$(sudo -n journalctl -u NetworkManager --since "$since" --utc --no-pager -o cat)
  echo "docker_interface_activations=$(printf '%s\n' "$j" | grep -c -E '\((veth[0-9a-f]+|fcpi-[a-z]+|docker0)\): (Activation|activation):')"
  echo "docker_interface_dhcp_transactions=$(printf '%s\n' "$j" | grep -c -E 'dhcp4 \((veth[0-9a-f]+|fcpi-[a-z]+|docker0)\): activation: beginning transaction')"
  echo "wlan0_state_changes=$(printf '%s\n' "$j" | grep -c -E 'device \(wlan0\): state change')"
  sec devices
  nmcli -t -f DEVICE,TYPE,STATE device | grep -E '^(wlan0|veth[0-9a-f]+|fcpi-[a-z]+|docker0):' | sed 's/:/ /g' | sort
fi
echo end
