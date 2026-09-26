#!/usr/bin/env bash
# Close M5's evidence window from the workstation, after the last live phase, in the order the checks need:
# the suites in the running images, the stack (with SearXNG's native proof and reach and the retrieval log
# scan), every core instance's log scanned for Cloud lines, the egress probe that closes the guard-counter
# window (X01), the rendered Compose file, and last the ruleset and the AFTER snapshot back to back, so the
# ruleset's hash is the snapshot's (X04), then the owner's own work on the Pi since the BEFORE snapshot, so
# X04 can attribute what that changed. Changes nothing on the Pi but saving the core logs it scans.
#   scripts/m5/collect-close.sh
set -euo pipefail
root=$(cd "$(dirname "$0")/../.." && pwd)
# shellcheck source=scripts/m1/pi-target.conf
. "$root/scripts/m1/pi-target.conf"
SSH=(ssh -i "$PI_SSH_KEY" -o IdentitiesOnly=yes -o BatchMode=yes -o ConnectTimeout=15 "$PI_SSH_TARGET")
R=$root/evidence/M5/raw
"${SSH[@]}" 'bash -s' <"$root/scripts/m5/pi-suites.sh" >"$R/suites.txt" 2>&1
"${SSH[@]}" 'bash /opt/firecrawl-pi/scripts/m5/pi-collect-stack.sh' >"$R/stack.txt"
"${SSH[@]}" 'bash /opt/firecrawl-pi/scripts/m2/pi-core-logs.sh m5-final' >"$R/core-logs-final.txt"
"${SSH[@]}" 'bash -s' <"$root/scripts/m2/pi-egress-probe.sh" >"$R/egress-probe.txt"
"${SSH[@]}" 'bash /opt/firecrawl-pi/scripts/m1/pi-rendered-compose.sh' >"$root/evidence/M5/rendered-compose.json"
"${SSH[@]}" 'bash /opt/firecrawl-pi/scripts/m3/pi-nft-ruleset.sh' >"$R/nft-ruleset.txt" 2>/dev/null
"$root/scripts/m1/snapshot.sh" "$root/evidence/M5/snapshot-after.txt" 2>/dev/null
since=$(sed -n 2p "$root/evidence/M5/snapshot-before.txt")
[[ $since =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9:]{8}Z$ ]] || { echo "no BEFORE snapshot time" >&2; exit 1; }
"${SSH[@]}" "bash -s -- $since" <"$root/scripts/m4/pi-owner-session.sh" >"$R/owner-session.txt"
echo "collected: suites, stack, core logs, egress probe, rendered compose, ruleset, AFTER snapshot, owner session"
