#!/usr/bin/env bash
# Egress instrument for the internal project bridges (fcpi-core, fcpi-fixture).
#   start: (re)create the counting-only nft tables `bridge fcpi_audit` and `inet fcpi_audit`;
#          they never drop or accept anything themselves, and are runtime-only (gone after
#          a reboot)
#   read:  print the counters
# Runs ON the Pi:  ssh ... 'bash /opt/firecrawl-pi/scripts/m1/pi-egress-audit.sh start|read'
#
# Frames between containers on one bridge are switched at layer 2 and never reach the
# inet hooks (Engine 28+ no longer forces br_netfilter), so a bridge-family table counts
# them. This kernel lacks CONFIG_NFT_BRIDGE_META (no `meta ibrname`), so the bridge rules
# match the internal subnets rather than bridge names, which also survives the veth
# renames that container recreation causes. `ipv4_from_internal_subnets` is the positive
# control: container traffic must raise it, which proves the instrument sees the bridges.
# Every other counter must stay 0: IPv4 from the internal subnets addressed anywhere
# else, IPv6 on any bridge (no project network has IPv6), and (inet) anything from the
# internal bridges delivered to the host or routed out.
set -euo pipefail
export LC_ALL=C
export PATH="/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"
mode=${1:?usage: pi-egress-audit.sh start|read}
BR='{ "fcpi-core", "fcpi-fixture" }'   # inet rules only
NETS='{ 10.231.1.0/24, 10.231.3.0/24 }'

case "$mode" in
start)
  sudo -n nft -f - <<EOF
table bridge fcpi_audit
delete table bridge fcpi_audit
table bridge fcpi_audit {
  chain audit_pre {
    type filter hook prerouting priority -300; policy accept;
    ether type ip ip saddr $NETS counter comment "ipv4_from_internal_subnets"
    ether type ip ip saddr $NETS ip daddr != $NETS counter comment "ipv4_from_internal_to_off_subnet"
    ether type ip6 counter comment "ipv6_on_any_bridge"
  }
}
table inet fcpi_audit
delete table inet fcpi_audit
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
