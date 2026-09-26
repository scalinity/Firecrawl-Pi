#!/bin/sh
# The host's own connected networks, which the retrieval service must never reach and which may
# use globally routable ranges (FIRECRAWL_PI_SPEC.md §20.2). Run as root before every dockerd start
# (docker.service.d/30-fcpi-egress-local.conf) and every stack start (fcpi-stack.service), from
# its installed copy /etc/firecrawl-pi/fcpi-egress-local.sh:
#   1. reads the kernel's connected routes (scope link, IPv4 and IPv6), leaving out Docker's and
#      the project's own bridges and veths, which the special-purpose ranges already cover;
#   2. writes them to /etc/firecrawl-pi/egress-local.cidrs (0644), atomically, for the retrieval
#      service, which refuses every acquisition while that file names no network;
#   3. replaces the guard's egress_local_v4 set with the IPv4 ones, in one nft transaction.
# Networks in /etc/firecrawl-pi/egress-local.extra (one CIDR per line, # comments) are added to both:
# the router's public address, which many routers answer or hairpin from the LAN side, goes there
# (scripts/m2/pi-wan-address.sh; review finding W8).
# The file persists across boots, so the bind mount always has a source; this run refreshes it.
set -eu
export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
OUT=/etc/firecrawl-pi/egress-local.cidrs
# Connected routes print as "<prefix> dev <interface> …"; routes via a gateway do not.
connected='$1 ~ /\// && $2 == "dev" && $3 !~ /^(docker0|br-|veth|fcpi-)/ && $1 !~ /^fe80:/ {print $1}'
v4=$(ip -4 -o route show table main scope link | awk "$connected" | sort -u)
v6=$(ip -6 -o route show table main | awk "$connected" | sort -u)
[ -n "$v4" ] || { echo "fcpi-egress-local: no connected IPv4 network found" >&2; exit 1; }
EXTRA=/etc/firecrawl-pi/egress-local.extra
if [ -f "$EXTRA" ]; then
  x4=$(grep -Ev "^[[:space:]]*(#|$)" "$EXTRA" | grep -E "^[0-9]{1,3}(\.[0-9]{1,3}){3}/[0-9]{1,2}$" || true)
  x6=$(grep -Ev "^[[:space:]]*(#|$)" "$EXTRA" | grep -E "^[0-9a-fA-F:]+:[0-9a-fA-F:]*/[0-9]{1,3}$" || true)
  bad=$(grep -Ev "^[[:space:]]*(#|$)" "$EXTRA" | grep -Evc "^([0-9]{1,3}(\.[0-9]{1,3}){3}/[0-9]{1,2}|[0-9a-fA-F:]+:[0-9a-fA-F:]*/[0-9]{1,3})$" || true)
  [ "${bad:-0}" = 0 ] || { echo "fcpi-egress-local: $EXTRA holds a line that is not a CIDR" >&2; exit 1; }
  v4=$(printf "%s\n" $v4 $x4 | sort -u); v6=$(printf "%s\n" $v6 $x6 | grep . | sort -u || true)
fi
tmp=$(mktemp "$OUT.XXXXXX")
{ echo "# written by fcpi-egress-local.sh at $(date -u +%Y-%m-%dT%H:%M:%SZ); the host's connected networks"; printf '%s\n' $v4 $v6; } >"$tmp"
chmod 0644 "$tmp"
mv -f "$tmp" "$OUT"
elements=$(printf '%s, ' $v4 | sed 's/, $//')
nft -f - <<EOF
flush set inet fcpi_guard egress_local_v4
add element inet fcpi_guard egress_local_v4 { $elements }
EOF
echo "fcpi-egress-local: ipv4=$(printf '%s\n' $v4 | wc -l) ipv6=$(printf '%s\n' $v6 | grep -c . || true)"
