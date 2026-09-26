#!/usr/bin/env bash
# Host snapshot from M1's close-out on: M0's scripts/m0/pi-snapshot.sh followed by
# scripts/m1/pi-snapshot-net.sh, written to one file.
#   scripts/m1/snapshot.sh <output-file>
# M0's script is unchanged, so its recorded provenance still names the version that ran.
set -euo pipefail
root=$(cd "$(dirname "$0")/../.." && pwd)
# shellcheck source=scripts/m1/pi-target.conf
. "$root/scripts/m1/pi-target.conf"
SSH=(ssh -i "$PI_SSH_KEY" -o IdentitiesOnly=yes -o BatchMode=yes -o ConnectTimeout=15 "$PI_SSH_TARGET")
out=${1:?usage: snapshot.sh <output-file>}
# Tailscale's addresses (a host address in 100.64.0.0/10, one in fd7a:115c:a1e0::/48) identify the owner's
# tailnet node, so they are replaced before the file is written (CLAUDE.md §33.2); a network with its mask,
# as the guard names 100.64.0.0/10, is kept.
{ "${SSH[@]}" 'bash -s' <"$root/scripts/m0/pi-snapshot.sh"; "${SSH[@]}" 'bash -s' <"$root/scripts/m1/pi-snapshot-net.sh"; } \
  | sed -E 's#100\.(6[4-9]|[7-9][0-9]|1[01][0-9]|12[0-7])\.[0-9]{1,3}\.[0-9]{1,3}([^0-9/.]|$)#<tailnet-address>\2#g; s#fd7a:115c:a1e0:[0-9a-f:]*[0-9a-f]#<tailnet-address-v6>#g' >"$out"
echo "wrote $out ($(wc -l <"$out" | tr -d ' ') lines)"
