#!/usr/bin/env bash
# Close M4's evidence window from the workstation, after the last live phase, in the order the checks
# need: the stack (with the MCP and gateway log scans and the MCP container's reach), every core instance's
# log scanned for Cloud lines, the egress probe that closes the guard-counter window (X01), then the
# rendered Compose file, and last the ruleset and the AFTER snapshot back to back, so the ruleset's hash
# is the snapshot's (X04). Changes nothing on the Pi but saving the core logs it scans (root 0600).
#   scripts/m4/collect-close.sh
set -euo pipefail
root=$(cd "$(dirname "$0")/../.." && pwd)
# shellcheck source=scripts/m1/pi-target.conf
. "$root/scripts/m1/pi-target.conf"
SSH=(ssh -i "$PI_SSH_KEY" -o IdentitiesOnly=yes -o BatchMode=yes -o ConnectTimeout=15 "$PI_SSH_TARGET")
R=$root/evidence/M4/raw
"${SSH[@]}" 'bash /opt/firecrawl-pi/scripts/m4/pi-collect-stack.sh' >"$R/stack.txt"
"${SSH[@]}" 'bash /opt/firecrawl-pi/scripts/m2/pi-core-logs.sh m4-final' >"$R/core-logs-final.txt"
"${SSH[@]}" 'bash -s' <"$root/scripts/m2/pi-egress-probe.sh" >"$R/egress-probe.txt"
"${SSH[@]}" 'bash /opt/firecrawl-pi/scripts/m1/pi-rendered-compose.sh' >"$root/evidence/M4/rendered-compose.json"
"${SSH[@]}" 'bash /opt/firecrawl-pi/scripts/m3/pi-nft-ruleset.sh' >"$R/nft-ruleset.txt" 2>/dev/null
"$root/scripts/m1/snapshot.sh" "$root/evidence/M4/snapshot-after.txt" 2>/dev/null
echo "collected: stack, core logs, egress probe, rendered compose, ruleset, AFTER snapshot"
