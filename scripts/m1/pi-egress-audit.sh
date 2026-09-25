#!/usr/bin/env bash
# Egress instrument for the internal project bridges (fcpi-core, fcpi-fixture).
#   start: (re)create the counting-only nft tables `bridge fcpi_audit` and `inet fcpi_audit`;
#          they never drop or accept anything themselves, and are runtime-only (gone after
#          a reboot)
#   read:  print every counter and every recorded flow
# Runs ON the Pi:  ssh ... 'bash /opt/firecrawl-pi/scripts/m1/pi-egress-audit.sh start|read'
#
# Frames between containers on one bridge are switched at layer 2 and never reach the
# inet hooks (Engine 28+ no longer forces br_netfilter), so a bridge-family table counts
# them. This kernel lacks CONFIG_NFT_BRIDGE_META (no `meta ibrname`), so the bridge rules
# match the internal subnets rather than bridge names, which also survives the veth
# renames that container recreation causes.
#
# Counter classes, by comment:
#   ipv4_from_internal_subnets     positive control: container traffic must raise it
#   info_*                         informational: link-scoped IPv6 (fe80::/10, ff02::/16),
#                                  which cannot leave the link
#   every other counter            must stay 0
# Every must-be-zero and informational rule also records (source, destination, protocol)
# in a dynamic set, so a non-zero count is always explained by what it saw.
set -euo pipefail
export LC_ALL=C
export PATH="/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"
mode=${1:?usage: pi-egress-audit.sh start|read}
BR='{ "fcpi-core", "fcpi-fixture" }'   # inet rules only
NETS='{ 10.231.1.0/24, 10.231.3.0/24 }'
LINK6='{ fe80::/10, ff02::/16 }'

case "$mode" in
start)
  sudo -n nft -f - <<EOF
table bridge fcpi_audit
delete table bridge fcpi_audit
table bridge fcpi_audit {
  set seen_v4_off { type ipv4_addr . ipv4_addr . inet_proto; flags dynamic; size 4096; }
  set seen_v6 { type ipv6_addr . ipv6_addr . inet_proto; flags dynamic; size 4096; }
  chain audit_pre {
    type filter hook prerouting priority -300; policy accept;
    ether type ip ip saddr $NETS counter comment "ipv4_from_internal_subnets"
    ether type ip ip saddr $NETS ip daddr != $NETS add @seen_v4_off { ip saddr . ip daddr . meta l4proto } counter comment "ipv4_from_internal_to_off_subnet"
    ether type ip6 ip6 daddr != $LINK6 add @seen_v6 { ip6 saddr . ip6 daddr . meta l4proto } counter comment "ipv6_beyond_link_scope_on_any_bridge"
    ether type ip6 ip6 daddr $LINK6 add @seen_v6 { ip6 saddr . ip6 daddr . meta l4proto } counter comment "info_ipv6_link_scope_on_any_bridge"
  }
}
table inet fcpi_audit
delete table inet fcpi_audit
table inet fcpi_audit {
  set seen_in_v4 { type ipv4_addr . ipv4_addr . inet_proto; flags dynamic; size 4096; }
  set seen_in_v6 { type ipv6_addr . ipv6_addr . inet_proto; flags dynamic; size 4096; }
  chain audit_fwd {
    type filter hook forward priority -300; policy accept;
    iifname $BR counter comment "routed_out_of_internal_bridges"
  }
  chain audit_in {
    type filter hook input priority -300; policy accept;
    iifname $BR meta nfproto ipv4 add @seen_in_v4 { ip saddr . ip daddr . meta l4proto } counter comment "ipv4_to_host_from_internal_bridges"
    iifname $BR meta nfproto ipv6 ip6 daddr != $LINK6 add @seen_in_v6 { ip6 saddr . ip6 daddr . meta l4proto } counter comment "ipv6_beyond_link_scope_to_host"
    iifname $BR meta nfproto ipv6 ip6 daddr $LINK6 add @seen_in_v6 { ip6 saddr . ip6 daddr . meta l4proto } counter comment "info_ipv6_link_scope_to_host"
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
  for s in "bridge fcpi_audit seen_v4_off" "bridge fcpi_audit seen_v6" "inet fcpi_audit seen_in_v4" "inet fcpi_audit seen_in_v6"; do
    sudo -n nft -j list set $s | jq -r --arg s "$s" '.nftables[] | select(.set) | .set.elem // [] | .[] | (.elem.val // .) | .concat
      | "flow set=\($s | gsub(" "; ":")) src=\(.[0]) dst=\(.[1]) l4proto=\(.[2])"'
  done
  ;;
esac
