#!/usr/bin/env bash
# A filter for evidence that would carry the Pi's LAN address (CLAUDE.md §33.2): stdin to stdout,
# with the address replaced by <pi-lan-address> and its /24 network by <pi-lan-network>. Both come
# from scripts/m1/pi-target.conf, their single definition.
#   scripts/m1/lan-probe.sh | scripts/m2/redact-lan.sh > evidence/M2/raw/lan-probe.txt
set -euo pipefail
root=$(cd "$(dirname "$0")/../.." && pwd)
lan=$(sed -n 's/^PI_LAN_ADDRESS=//p' "$root/scripts/m1/pi-target.conf")
[[ $lan =~ ^([0-9]+)\.([0-9]+)\.([0-9]+)\.[0-9]+$ ]] || { echo "PI_LAN_ADDRESS is not an IPv4 address" >&2; exit 1; }
net="${BASH_REMATCH[1]}\\.${BASH_REMATCH[2]}\\.${BASH_REMATCH[3]}\\.0"
sed -E "s/${lan//./\\.}/<pi-lan-address>/g; s/${net}([^0-9]|$)/<pi-lan-network>\\1/g"
