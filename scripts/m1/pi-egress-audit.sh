#!/usr/bin/env bash
# Egress instrument for the internal project bridges (fcpi-core, fcpi-fixture).
#   start: (re)create the counting-only nft tables `bridge fcpi_audit` and `inet fcpi_audit`;
#          they never drop or accept anything themselves, and are runtime-only (gone after
#          a reboot)
#   read:  print the counters
# Runs ON the Pi:  ssh ... 'bash /opt/firecrawl-pi/scripts/m1/pi-egress-audit.sh start|read'
#
# Frames between containers on one bridge are switched at layer 2 and never reach the
# inet hooks (Engine 28+ no longer forces br_netfilter), so the bridge-family table sees
# every frame entering fcpi-core or fcpi-fixture. `all_frames_into_internal_bridges` is
# the positive control: container traffic must raise it, which proves the instrument
# sees the bridges. Every other counter must stay 0: IPv4 addressed off the internal
# subnets, any IPv6, and (inet) anything delivered to the host or routed out.
set -euo pipefail
export LC_ALL=C
export PATH="/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"
mode=${1:?usage: pi-egress-audit.sh start|read}
BR='{ "fcpi-core", "fcpi-fixture" }'
NETS='{ 10.231.1.0/24, 10.231.3.0/24 }'

case "$mode" in
start)
  sudo -n nft -f - <<EOF
table bridge fcpi_audit
flush table bridge fcpi_audit
table bridge fcpi_audit {
  chain audit_pre {
    type filter hook prerouting priority -300; policy accept;
    meta ibrname $BR counter comment "all_frames_into_internal_bridges"
    meta ibrname $BR ether type ip ip daddr != $NETS counter comment "ipv4_off_subnet_on_internal_bridges"
    meta ibrname $BR ether type ip6 counter comment "ipv6_on_internal_bridges"
  }
}
table inet fcpi_audit
flush table inet fcpi_audit
table inet fcpi_audit {
  chain audit_fwd {
    type filter hook forward priority -300; policy accept;
    iifname $BR counter comment "routed_out_of_internal_bridges"
  }
  chain audit_in {
    type filter hook input priority -300; policy accept;
    iifname $BR counter comment "delivered_to_host_from_internal_bridges"
  }
}
EOF
  echo "started $(date -u +%Y-%m-%dT%H:%M:%SZ)"
  ;;
read)
  echo "read $(date -u +%Y-%m-%dT%H:%M:%SZ)"
  for fam in bridge inet; do
    sudo -n nft -j list table $fam fcpi_audit | jq -r --arg fam "$fam" '.nftables[] | select(.rule) | .rule
      | "\(.comment) family=\($fam) packets=\([.expr[] | select(.counter) | .counter.packets][0]) bytes=\([.expr[] | select(.counter) | .counter.bytes][0])"'
  done
  ;;
esac
