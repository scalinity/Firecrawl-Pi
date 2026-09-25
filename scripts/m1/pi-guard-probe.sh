#!/usr/bin/env bash
# Evidence for the access-bridge guard (deploy/host/fcpi-guard.nft; REVIEW.md R5). Runs ON
# the Pi:  ssh ... 'bash /opt/firecrawl-pi/scripts/m1/pi-guard-probe.sh <phase>'
#   before  the guard's state, then the connect probe from inside the gateway (the
#           positive control: without the guard the host and the Internet answer)
#   after   the same, with the guard loaded, then its counters
#   pregate the counters alone, just before the dockerd gate test restarts dockerd (whose
#           start reloads the table and resets them)
#   end     the counters alone, at the end of the verification window
# The probe's addresses carry no name lookups. Nothing is changed by this script.
set -uo pipefail
export LC_ALL=C
export PATH="/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"
REPO=/opt/firecrawl-pi
phase=${1:?usage: pi-guard-probe.sh before|after|pregate|end}
case $phase in before|after|pregate|end) ;; *) echo "unknown phase $phase" >&2; exit 2 ;; esac
PI_LAN_ADDRESS=$(sed -n "s/^PI_LAN_ADDRESS=//p" "$REPO/scripts/m1/pi-target.conf")

sec() { printf '### %s_%s\n' "$phase" "$1"; }
counters() {
  sudo -n nft -j list table inet fcpi_guard 2>/dev/null | jq -r '.nftables[] | select(.rule) | .rule
    | select(.comment) | "\(.comment) packets=\([.expr[] | select(.counter) | .counter.packets][0])"'
}

sec meta
date -u +%Y-%m-%dT%H:%M:%SZ
echo "source_commit=$(cat $REPO/.fcpi-source-commit)"
echo "guard_table=$(sudo -n nft list table inet fcpi_guard >/dev/null 2>&1 && echo present || echo absent)"
echo "guard_file_sha256=$(sudo -n sha256sum /etc/firecrawl-pi/fcpi-guard.nft 2>/dev/null | cut -c1-64) guard_repo_sha256=$(sha256sum <$REPO/deploy/host/fcpi-guard.nft | cut -c1-64)"

if [ "$phase" = before ] || [ "$phase" = after ]; then
  sec probe
  GW=$(sudo -n docker ps -q --filter label=com.docker.compose.project=fcpi --filter label=com.docker.compose.service=access-gateway)
  echo "gateway $(sudo -n docker exec -i -e PI_LAN_ADDRESS="$PI_LAN_ADDRESS" "$GW" node --input-type=module - <"$REPO/scripts/m1/access-guard-probe.mjs" 2>&1)"
fi

sec counters
counters
echo end
