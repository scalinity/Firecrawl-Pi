#!/usr/bin/env bash
# M8's evidence window from the workstation, in order, into FCPI_M8_EVIDENCE (default evidence/M8/):
#   1. the guard-counter snapshot that opens the window (collect-open.sh);
#   2. M8's host installation, idempotent, as its record (pi-init-m8.sh);
#   3. every injected failure and the normal reboot (faults.mjs);
#   4. the core's heap on large pages (pi-heap-probe.sh, M4 F1);
#   5. the fixture backup and the isolated restore test (pi-backup-proof.sh); then the live records (pi-backup-live.sh,
#      pi-notify-live.sh), each of which only records "configured=no" while the owner input it needs is absent, and the
#      external watchdog's proof (watchdog-live.sh: the Pi's heartbeat stopped until the VPS notices, then restored);
#   6. the upgrade and rollback rehearsal in the isolated copy (pi-rehearsal.sh, M7's retrieval image as the candidate
#      that refuses this release's configuration);
#   7. the read-only plans against M7's release staged as a candidate (stage.sh, pi-plans.sh);
#   8. the paced soak for <hours> (or <N>m, for a dry run only: the soak check needs 24 hours), the Redis user's statistics
#      reset before it and read after it;
#   9. the close (collect-close.sh).
# The soak runs on the Pi and survives a workstation that sleeps; the window waits for it here.
#   scripts/m8/window.sh <soak hours>|<N>m
set -euo pipefail
root=$(cd "$(dirname "$0")/../.." && pwd)
# shellcheck source=scripts/m1/pi-target.conf
. "$root/scripts/m1/pi-target.conf"
SSH=(ssh -i "$PI_SSH_KEY" -o IdentitiesOnly=yes -o BatchMode=yes -o ConnectTimeout=15 -o ServerAliveInterval=15 -o ServerAliveCountMax=8 "$PI_SSH_TARGET")
H=${1:?usage: window.sh <soak hours>}
export FCPI_M8_EVIDENCE=${FCPI_M8_EVIDENCE:-evidence/M8/}
EV=$FCPI_M8_EVIDENCE; case $EV in /*) ;; *) EV=$root/$EV ;; esac
R=$EV/raw; mkdir -p "$R" "$EV/reboots"
M7_RETRIEVAL=fcpi/retrieval@sha256:9c92d952c5701a35302614250d2cfd067a79c9c5a2c473bbceef2e83fb84651a
step() { echo "$(date -u +%H:%M:%SZ) $*"; }
step open; "$root/scripts/m8/collect-open.sh"
step init; "${SSH[@]}" 'bash /opt/firecrawl-pi/scripts/m8/pi-init-m8.sh' >"$R/init-m8.txt" 2>&1
step faults; node "$root/scripts/m8/faults.mjs" >"$R/faults.txt" 2>"$R/faults.err" || true
step heap; "${SSH[@]}" 'bash -s -- 400 614 1024 1536 2048' <"$root/scripts/m8/pi-heap-probe.sh" >"$R/heap.txt" 2>&1
step backup; "${SSH[@]}" 'sudo -n bash /opt/firecrawl-pi/scripts/m8/pi-backup-proof.sh' >"$R/backup-fixture.txt" 2>&1
step live; "${SSH[@]}" 'sudo -n bash /opt/firecrawl-pi/scripts/m8/pi-backup-live.sh' >"$R/backup-live.txt" 2>&1
"${SSH[@]}" 'sudo -n bash /opt/firecrawl-pi/scripts/m8/pi-notify-live.sh' >"$R/notify-live.txt" 2>&1
"$root/scripts/m8/watchdog-live.sh" >"$R/watchdog-live.txt" 2>"$R/watchdog-live.err"
step rehearsal; "${SSH[@]}" "sudo -n bash /opt/firecrawl-pi/scripts/m8/pi-rehearsal.sh $M7_RETRIEVAL" >"$R/rehearsal.txt" 2>&1
step plans; "$root/scripts/m8/stage.sh" 19f047f >/dev/null
cand=$("${SSH[@]}" 'ls -1d /opt/firecrawl-pi-candidate/19f047f* | head -1')
"${SSH[@]}" "sudo -n bash /opt/firecrawl-pi/scripts/m8/pi-plans.sh $cand" >"$R/plans.txt" 2>&1
step soak; "${SSH[@]}" 'sudo -n bash /opt/firecrawl-pi/scripts/m8/pi-redis.sh reset' >/dev/null
run=$("${SSH[@]}" "bash /opt/firecrawl-pi/scripts/m8/pi-soak.sh start $H" | sed -n '/^{/,$p' | jq -r .run)   # the JSON after the selection line
until "${SSH[@]}" "sudo -n grep -q '\"class\":\"end\"' /var/log/firecrawl-pi/soak/$run.jsonl" 2>/dev/null; do sleep 120; done
"${SSH[@]}" "bash /opt/firecrawl-pi/scripts/m8/pi-soak.sh collect $run" >"$R/soak.txt"
"${SSH[@]}" 'sudo -n bash /opt/firecrawl-pi/scripts/m8/pi-redis.sh stats' >"$R/redis-soak.txt"
"${SSH[@]}" 'bash /opt/firecrawl-pi/scripts/m8/pi-soak.sh stop' >/dev/null
step close; "$root/scripts/m8/collect-close.sh"
step done
