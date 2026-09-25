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
{ "${SSH[@]}" 'bash -s' <"$root/scripts/m0/pi-snapshot.sh"; "${SSH[@]}" 'bash -s' <"$root/scripts/m1/pi-snapshot-net.sh"; } >"$out"
echo "wrote $out ($(wc -l <"$out" | tr -d ' ') lines)"
