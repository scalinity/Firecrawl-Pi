#!/usr/bin/env bash
# Close M6's evidence window from the workstation, after the last phase, in the order the checks need: the suites
# in the running images, the stack (the retrieval log scan and fixture-m6's reach among it), every core instance's
# log scanned for Cloud lines, the egress probe that closes the guard-counter window (X01), the rendered Compose
# file, and last the ruleset and the AFTER snapshot back to back, so the ruleset's hash is the snapshot's (X04), then
# the owner's own work on the Pi since the BEFORE snapshot, so X04 can attribute what that changed. Changes nothing
# on the Pi but saving the core logs it scans.
#   scripts/m6/collect-close.sh
set -euo pipefail
root=$(cd "$(dirname "$0")/../.." && pwd)
# shellcheck source=scripts/m1/pi-target.conf
. "$root/scripts/m1/pi-target.conf"
SSH=(ssh -i "$PI_SSH_KEY" -o IdentitiesOnly=yes -o BatchMode=yes -o ConnectTimeout=15 "$PI_SSH_TARGET")
R=$root/evidence/M6/raw
"${SSH[@]}" 'bash -s' <"$root/scripts/m6/pi-suites.sh" >"$R/suites.txt" 2>&1
"${SSH[@]}" 'bash /opt/firecrawl-pi/scripts/m6/pi-collect-stack.sh' >"$R/stack.txt"
"${SSH[@]}" 'bash /opt/firecrawl-pi/scripts/m2/pi-core-logs.sh m6-final' >"$R/core-logs-final.txt"
"${SSH[@]}" 'bash -s' <"$root/scripts/m2/pi-egress-probe.sh" >"$R/egress-probe.txt"
"${SSH[@]}" 'bash /opt/firecrawl-pi/scripts/m1/pi-rendered-compose.sh' >"$root/evidence/M6/rendered-compose.json"
"${SSH[@]}" 'bash /opt/firecrawl-pi/scripts/m3/pi-nft-ruleset.sh' >"$R/nft-ruleset.txt" 2>/dev/null
"$root/scripts/m1/snapshot.sh" "$root/evidence/M6/snapshot-after.txt" 2>/dev/null
since=$(sed -n 2p "$root/evidence/M6/snapshot-before.txt")
[[ $since =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9:]{8}Z$ ]] || { echo "no BEFORE snapshot time" >&2; exit 1; }
"${SSH[@]}" "bash -s -- $since" <"$root/scripts/m4/pi-owner-session.sh" >"$R/owner-session.txt"
echo "collected: suites, stack, core logs, egress probe, rendered compose, ruleset, AFTER snapshot, owner session"
