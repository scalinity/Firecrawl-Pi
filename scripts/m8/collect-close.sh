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
SSH=(ssh -i "$PI_SSH_KEY" -o IdentitiesOnly=yes -o BatchMode=yes -o ConnectTimeout=15 -o ServerAliveInterval=15 -o ServerAliveCountMax=8 "$PI_SSH_TARGET")
# Each step only reads, so a dropped connection over the Pi's Wi-Fi is met by trying it again: the output file is written
# afresh each attempt and a script fed on stdin is reopened; the note of a retry goes to stderr, never into the evidence.
run() { local out=$1 in=$2 i; shift 2; for i in 1 2 3 4 5; do "${SSH[@]}" "$@" <"$in" >"$out" 2>"$out.err" && { rm -f "$out.err"; return 0; }; echo "retry $i: $(basename "$out")" >&2; sleep 30; done; cat "$out.err" >&2; rm -f "$out.err"; return 1; }
EV=${FCPI_M8_EVIDENCE:-$root/evidence/M8/}; R=${EV}raw
mkdir -p "$R" "${EV}reboots"
run "$R/suites.txt" "$root/scripts/m8/pi-suites.sh" 'bash -s'
run "$R/stack.txt" /dev/null 'bash /opt/firecrawl-pi/scripts/m8/pi-collect-stack.sh'
run "$R/verify-ops.txt" /dev/null 'sudo -n /opt/firecrawl-pi/scripts/fcpi verify ops 2>&1; true'
run "$R/status.json" /dev/null 'sudo -n /opt/firecrawl-pi/scripts/fcpi status --json 2>&1; true'
run "$R/core-logs-final.txt" /dev/null 'bash /opt/firecrawl-pi/scripts/m8/pi-core-logs.sh m8-final'
run "$R/egress-probe.txt" "$root/scripts/m2/pi-egress-probe.sh" 'bash -s'
run "${EV}rendered-compose.json" /dev/null 'bash /opt/firecrawl-pi/scripts/m1/pi-rendered-compose.sh'
run "$R/nft-ruleset.txt" /dev/null 'bash /opt/firecrawl-pi/scripts/m3/pi-nft-ruleset.sh 2>/dev/null'
"$root/scripts/m1/snapshot.sh" "${EV}snapshot-after.txt" 2>/dev/null
since=$(sed -n 2p "$root/evidence/M8/snapshot-before.txt")
[[ $since =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9:]{8}Z$ ]] || { echo "no BEFORE snapshot time" >&2; exit 1; }
run "$R/owner-session.txt" "$root/scripts/m8/pi-owner-session.sh" "bash -s -- $since"
# Every durable boot record the Pi holds, each copied once under its own name (the verifier chooses the window's).
for f in $("${SSH[@]}" "ls -1 /var/lib/firecrawl-pi/boots/ 2>/dev/null"); do
  [[ $f =~ ^[0-9]{8}T[0-9]{6}Z-[0-9a-f]{12}\.txt$ ]] || continue
  [ -e "${EV}reboots/boot-$f" ] || run "${EV}reboots/boot-$f" /dev/null "cat /var/lib/firecrawl-pi/boots/$f"
done
before_boot=$(sed -n 's/^boot_id_sha256=//p' "$root/evidence/M8/snapshot-before.txt")
run "${EV}reboots/reboot-close-$(date -u +%Y%m%dT%H%M%SZ).txt" "$root/scripts/m7/pi-reboot-record.sh" "bash -s -- $before_boot"
echo "collected: suites, stack, verify ops, status, core logs, egress probe, rendered compose, ruleset, AFTER snapshot, owner session, reboot records"
