#!/usr/bin/env bash
# Open M5's evidence window from the workstation: the guard's counters and table handle (X01 compares them
# with the egress probe that closes the window), a memory sample, and the stack's state before the phases.
#   scripts/m5/collect-open.sh
set -euo pipefail
root=$(cd "$(dirname "$0")/../.." && pwd)
# shellcheck source=scripts/m1/pi-target.conf
. "$root/scripts/m1/pi-target.conf"
SSH=(ssh -i "$PI_SSH_KEY" -o IdentitiesOnly=yes -o BatchMode=yes -o ConnectTimeout=15 "$PI_SSH_TARGET")
R=$root/evidence/M5/raw
mkdir -p "$R"
"${SSH[@]}" 'bash -s -- counters' <"$root/scripts/m2/pi-egress-probe.sh" >"$R/guard-window-open.txt"
echo "opened: $(grep -o 'guard_table_handle=[0-9]*' "$R/guard-window-open.txt" | head -1)"
