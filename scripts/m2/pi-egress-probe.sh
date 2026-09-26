#!/usr/bin/env bash
# M2's egress evidence, ON the Pi:  ssh … 'bash -s' < scripts/m2/pi-egress-probe.sh
# Runs scripts/m2/egress-probe.mjs inside the core, the browser worker, the retrieval service and
# the M2 fixture, and prints the guard's counters (inet fcpi_guard) before and after, so each
# refusal the retrieval service meets shows as the drop rule it hit. Also prints each container's
# network attachments, default route and DNS settings, since every container on a non-internal
# network must name its own DNS upstream (CLAUDE.md §33.1). The LAN address is replaced by
# <pi-lan-address> in everything printed. Changes nothing.
set -uo pipefail
export LC_ALL=C
export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
REPO=/opt/firecrawl-pi
D() { sudo -n docker "$@"; }
cid() { D ps -q --filter label=com.docker.compose.project=fcpi --filter "label=com.docker.compose.service=$1"; }
sec() { printf '### %s\n' "$1"; }
LAN=$(sed -n "s/^PI_LAN_ADDRESS=//p" "$REPO/scripts/m1/pi-target.conf")
[ -n "$LAN" ] || { echo "no PI_LAN_ADDRESS" >&2; exit 1; }
redact() { sed "s/${LAN//./\\.}/<pi-lan-address>/g"; }
# One line per counted guard rule: its comment and packet count (the verdict sits between them).
counters() { sudo -n nft list table inet fcpi_guard | grep 'counter packets' | sed -E 's/.*counter packets ([0-9]+) bytes [0-9]+.*comment "([a-z0-9_]+)".*/\2 packets=\1/'; }

sec meta
echo "utc=$(date -u +%Y-%m-%dT%H:%M:%SZ) source_commit=$(cat $REPO/.fcpi-source-commit)"

sec attachments
for c in $(D ps -q --filter label=com.docker.compose.project=fcpi); do
  D inspect "$c" | jq -r '.[0] | "\(.Config.Labels["com.docker.compose.service"]) networks=\([.NetworkSettings.Networks | keys[]] | join(",")) dns=\((.HostConfig.Dns // []) | join(",")) network_mode=\(.HostConfig.NetworkMode)"'
done
for n in $(D network ls -q --filter label=com.docker.compose.project=fcpi); do
  D network inspect "$n" | jq -r '.[0] | "network \(.Name) internal=\(.Internal) subnet=\(.IPAM.Config[0].Subnet) gateway=\(.IPAM.Config[0].Gateway // "") bridge=\(.Options["com.docker.network.bridge.name"]) gateway_mode_ipv4=\(.Options["com.docker.network.bridge.gateway_mode_ipv4"] // "nat") ipv6=\(.EnableIPv6)"'
done
for s in firecrawl-core browser-worker retrieval-service fixture-m2 access-gateway; do
  c=$(cid "$s")
  echo "$s default_route=$(D exec "$c" awk 'NR>1 && $2=="00000000" {print "yes"; f=1} END {if (!f) print "no"}' /proc/net/route 2>/dev/null) resolv_nameservers=$(D exec "$c" awk '/^nameserver/ {print $2}' /etc/resolv.conf 2>/dev/null | tr '\n' , | sed 's/,$//')"
done

sec guard_before
counters
sec probes
for pair in core:firecrawl-core browser:browser-worker retrieval:retrieval-service fixture:fixture-m2; do
  role=${pair%%:*}; c=$(cid "${pair#*:}")
  D exec -i -e ROLE="$role" -e PI_LAN_ADDRESS="$LAN" "$c" node --input-type=module - <"$REPO/scripts/m2/egress-probe.mjs" 2>&1 | redact
done
sec guard_after
counters
sec end
echo end
