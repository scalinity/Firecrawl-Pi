#!/usr/bin/env bash
# Egress instrument for the internal project bridges (fcpi-core, fcpi-fixture).
#   start: (re)create nft table inet fcpi_audit with counting rules only; it never drops
#          or accepts anything itself, and it is runtime-only (gone after a reboot)
#   read:  print the counters
# Runs ON the Pi:  ssh ... 'bash /opt/firecrawl-pi/scripts/m1/pi-egress-audit.sh start|read'
# `all_from_internal` is the positive control: bridged container traffic must raise it,
# which proves these hooks see packets from the bridges. Every other counter must stay 0.
set -euo pipefail
export LC_ALL=C
export PATH="/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"
mode=${1:?usage: pi-egress-audit.sh start|read}
BR='{ "fcpi-core", "fcpi-fixture" }'
NETS='{ 10.231.1.0/24, 10.231.3.0/24 }'

case "$mode" in
start)
  sudo -n nft -f - <<EOF
table inet fcpi_audit
flush table inet fcpi_audit
table inet fcpi_audit {
  chain pre {
    type filter hook prerouting priority -300; policy accept;
    iifname $BR counter comment "all_from_internal"
    iifname $BR meta nfproto ipv4 ip daddr != $NETS counter comment "ipv4_off_subnet_from_internal"
    iifname $BR meta nfproto ipv6 counter comment "ipv6_from_internal"
  }
  chain fwd {
    type filter hook forward priority -300; policy accept;
    iifname $BR oifname != $BR counter comment "forwarded_out_of_internal"
  }
  chain inp {
    type filter hook input priority -300; policy accept;
    iifname $BR counter comment "to_host_from_internal"
  }
}
EOF
  echo "started $(date -u +%Y-%m-%dT%H:%M:%SZ)"
  ;;
read)
  echo "read $(date -u +%Y-%m-%dT%H:%M:%SZ)"
  sudo -n nft -j list table inet fcpi_audit | jq -r '.nftables[] | select(.rule) | .rule
    | "\(.comment) packets=\([.expr[] | select(.counter) | .counter.packets][0]) bytes=\([.expr[] | select(.counter) | .counter.bytes][0])"'
  ;;
esac
