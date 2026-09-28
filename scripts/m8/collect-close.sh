#!/usr/bin/env bash
# Close M8's evidence window from the workstation, in the order the checks need: the suites in the running images, the
# stack, fcpi verify ops and fcpi status, every core instance's log scanned for Cloud lines, the egress probe that closes
# the guard-counter window, the rendered Compose file, then the ruleset and the AFTER snapshot back to back (the
# ruleset's hash is the snapshot's), the owner's own work since the BEFORE snapshot, and the reboot records: every
# durable boot record the Pi holds from the BEFORE snapshot on (scripts/ops/boot-record.sh, made at each boot, never
# rewritten) and a recorder chain from the journal, each kept as its own dated file beside the earlier ones, never
# overwriting one (M7 review finding F13). Changes nothing on the Pi but saving the core logs it scans.
#   scripts/m8/collect-close.sh
set -euo pipefail
root=$(cd "$(dirname "$0")/../.." && pwd)
# shellcheck source=scripts/m1/pi-target.conf
. "$root/scripts/m1/pi-target.conf"
SSH=(ssh -i "$PI_SSH_KEY" -o IdentitiesOnly=yes -o BatchMode=yes -o ConnectTimeout=15 "$PI_SSH_TARGET")
EV=${FCPI_M8_EVIDENCE:-$root/evidence/M8/}; R=${EV}raw
mkdir -p "$R" "${EV}reboots"
"${SSH[@]}" 'bash -s' <"$root/scripts/m8/pi-suites.sh" >"$R/suites.txt" 2>&1
"${SSH[@]}" 'bash /opt/firecrawl-pi/scripts/m8/pi-collect-stack.sh' >"$R/stack.txt"
"${SSH[@]}" 'sudo -n /opt/firecrawl-pi/scripts/fcpi verify ops' >"$R/verify-ops.txt" 2>&1 || true
"${SSH[@]}" 'sudo -n /opt/firecrawl-pi/scripts/fcpi status --json' >"$R/status.json" 2>&1 || true
"${SSH[@]}" 'bash /opt/firecrawl-pi/scripts/m8/pi-core-logs.sh m8-final' >"$R/core-logs-final.txt"
"${SSH[@]}" 'bash -s' <"$root/scripts/m2/pi-egress-probe.sh" >"$R/egress-probe.txt"
"${SSH[@]}" 'bash /opt/firecrawl-pi/scripts/m1/pi-rendered-compose.sh' >"${EV}rendered-compose.json"
"${SSH[@]}" 'bash /opt/firecrawl-pi/scripts/m3/pi-nft-ruleset.sh' >"$R/nft-ruleset.txt" 2>/dev/null
"$root/scripts/m1/snapshot.sh" "${EV}snapshot-after.txt" 2>/dev/null
since=$(sed -n 2p "$root/evidence/M8/snapshot-before.txt")
[[ $since =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9:]{8}Z$ ]] || { echo "no BEFORE snapshot time" >&2; exit 1; }
"${SSH[@]}" "bash -s -- $since" <"$root/scripts/m8/pi-owner-session.sh" >"$R/owner-session.txt"
# Every durable boot record the Pi holds, each copied once under its own name (the verifier chooses the window's).
for f in $("${SSH[@]}" "ls -1 /var/lib/firecrawl-pi/boots/ 2>/dev/null"); do
  [[ $f =~ ^[0-9]{8}T[0-9]{6}Z-[0-9a-f]{12}\.txt$ ]] || continue
  [ -e "${EV}reboots/boot-$f" ] || "${SSH[@]}" "cat /var/lib/firecrawl-pi/boots/$f" >"${EV}reboots/boot-$f"
done
before_boot=$(sed -n 's/^boot_id_sha256=//p' "$root/evidence/M8/snapshot-before.txt")
"${SSH[@]}" "bash -s -- $before_boot" <"$root/scripts/m7/pi-reboot-record.sh" >"${EV}reboots/reboot-close-$(date -u +%Y%m%dT%H%M%SZ).txt"
echo "collected: suites, stack, verify ops, status, core logs, egress probe, rendered compose, ruleset, AFTER snapshot, owner session, reboot records"
