#!/usr/bin/env bash
# The stateless nftables ruleset (scripts/m1/pi-nft-ruleset.sh) with the host's own addresses replaced
# before anything leaves the Pi: the guard's host-local set holds the Pi's LAN network and, since M2,
# the router's public address (CLAUDE.md §33.2). Runs ON the Pi:
#   ssh … 'bash /opt/firecrawl-pi/scripts/m3/pi-nft-ruleset.sh' > evidence/M3/raw/nft-ruleset.txt
set -euo pipefail
export LC_ALL=C
export PATH="/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"
REPO=/opt/firecrawl-pi
LAN=$(sed -n 's/^PI_LAN_ADDRESS=//p' "$REPO/scripts/m1/pi-target.conf")
[[ $LAN =~ ^([0-9]+)\.([0-9]+)\.([0-9]+)\.[0-9]+$ ]] || { echo "PI_LAN_ADDRESS is not an IPv4 address" >&2; exit 1; }
NET="${BASH_REMATCH[1]}\\.${BASH_REMATCH[2]}\\.${BASH_REMATCH[3]}\\.0"
# Single quotes: in double quotes bash would expand the pattern's $# (scripts/m2/pi-egress-probe.sh).
WAN=$(sudo -n sed -n 's#^\([0-9.]*\)/32$#\1#p' /etc/firecrawl-pi/egress-local.extra 2>/dev/null | head -1)
# The installed guard file's hash (X04 compares it with deploy/host/fcpi-guard.nft) and the unredacted
# ruleset's, computed as the host snapshot computes nft_ruleset_sha256, so the rules listed here are tied
# to the AFTER snapshot's hash.
echo "# guard_file_sha256=$(sudo -n sha256sum /etc/firecrawl-pi/fcpi-guard.nft | cut -c1-64) ruleset_sha256=$(sudo -n nft -s list ruleset 2>/dev/null | sha256sum | cut -c1-64)"
bash "$REPO/scripts/m1/pi-nft-ruleset.sh" | sed -E "s/${LAN//./\\.}/<pi-lan-address>/g; s/${NET}([^0-9]|$)/<pi-lan-network>\\1/g${WAN:+; s/${WAN//./\\.}/<pi-wan-address>/g}"
