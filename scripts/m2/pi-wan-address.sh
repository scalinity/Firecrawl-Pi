#!/usr/bin/env bash
# The router's public address as a host-local network (review finding W8), ON the Pi:
#   ssh … 'bash /opt/firecrawl-pi/scripts/m2/pi-wan-address.sh'
# Many home routers answer on their public address from the LAN side, or hairpin it to a
# port-forwarded LAN service, so a target that redirects to the address it saw a request come from
# could otherwise reach the LAN (spec §20.2). This measures the address the way M0's audit did (one
# HTTPS request from the host to api.ipify.org: a live call, run only as one of the milestone's held
# live steps), writes it as a /32 to /etc/firecrawl-pi/egress-local.extra (root, 0644) and runs
# fcpi-egress-local.sh, which adds it to the retrieval service's list and the guard's set. The
# address is an identifier: only its SHA-256 is printed, as M0 prints it. A changed public address
# needs this run again.
set -uo pipefail
export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
EXTRA=/etc/firecrawl-pi/egress-local.extra
h() { printf '%s' "$1" | sha256sum | cut -c1-64; }
echo "### meta"
echo "utc=$(date -u +%Y-%m-%dT%H:%M:%SZ) source_commit=$(cat /opt/firecrawl-pi/.fcpi-source-commit)"
echo "### measure"
wan=$(curl -s --max-time 10 https://api.ipify.org 2>/dev/null)
printf '%s' "$wan" | grep -qE '^[0-9]{1,3}(\.[0-9]{1,3}){3}$' || { echo "measured=no"; exit 1; }
echo "measured=yes wan_sha256=$(h "$wan")"
echo "### install"
printf '# The router'"'"'s public address, measured %s by scripts/m2/pi-wan-address.sh (review finding W8).\n%s/32\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$wan" | sudo -n tee "$EXTRA.tmp" >/dev/null
sudo -n chmod 0644 "$EXTRA.tmp" && sudo -n mv -f "$EXTRA.tmp" "$EXTRA"
sudo -n /etc/firecrawl-pi/fcpi-egress-local.sh
echo "### check"
echo "in_cidrs_file=$(grep -qxF "$wan/32" /etc/firecrawl-pi/egress-local.cidrs && echo yes || echo no)"
echo "in_guard_set=$(sudo -n nft get element inet fcpi_guard egress_local_v4 "{ $wan }" >/dev/null 2>&1 && echo yes || echo no)"
unset wan
echo "### end"
echo end
