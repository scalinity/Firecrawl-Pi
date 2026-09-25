#!/usr/bin/env bash
# Take an M0 integrity snapshot of the Pi and store it on the Mac.
# Usage: scripts/m0/snapshot.sh before|after
set -euo pipefail
label=${1:?usage: snapshot.sh before|after}
root=$(cd "$(dirname "$0")/../.." && pwd)
out="$root/evidence/M0/snapshot-$label.txt"
mkdir -p "$root/evidence/M0"
ssh -i ~/.ssh/pi -o IdentitiesOnly=yes -o BatchMode=yes -o ConnectTimeout=15 danny@pi.local 'bash -s' \
  <"$root/scripts/m0/pi-snapshot.sh" >"$out"
grep -q '^end$' "$out" || { echo "snapshot $label incomplete: $out" >&2; exit 1; }
echo "$out"
