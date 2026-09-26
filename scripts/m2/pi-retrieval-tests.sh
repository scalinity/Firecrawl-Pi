#!/usr/bin/env bash
# One phase of M2's retrieval tests, ON the Pi:
#   ssh … 'bash -s -- <phase>' < scripts/m2/pi-retrieval-tests.sh
# phase: static | ssrf | browser | browser-down | budget | pacing | permits | cancel | crash |
#        stress | overcap | paths
# Runs scripts/m2/retrieval-e2e.mjs inside firecrawl-core for that group, then prints, for the
# phase's window: the driver's lines, the retrieval service's, the M2 fixture's and the browser
# worker's logs, the retrieval service's attempt rows and permits (read as the superuser over the
# local socket), container health, and for stress phases one-second memory samples of every fcpi
# cgroup and the host. browser-down stops the browser worker for its window and starts it again;
# crash kills Chromium in the worker during its render. The Pi's LAN address, used as one target
# of the SSRF cases, is replaced by <pi-lan-address> in everything printed.
set -uo pipefail
export LC_ALL=C
export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
REPO=/opt/firecrawl-pi
phase=${1:?usage: pi-retrieval-tests.sh <phase>}
D() { sudo -n docker "$@"; }
LAN=$(sed -n "s/^PI_LAN_ADDRESS=//p" "$REPO/scripts/m1/pi-target.conf")
[ -n "$LAN" ] || { echo "no PI_LAN_ADDRESS in scripts/m1/pi-target.conf" >&2; exit 1; }
redact() { sed "s/${LAN//./\\.}/<pi-lan-address>/g"; }
cid() { D ps -q --filter label=com.docker.compose.project=fcpi --filter "label=com.docker.compose.service=$1"; }
sec() { printf '### %s_%s\n' "$phase" "$1"; }
CORE=$(cid firecrawl-core); RS=$(cid retrieval-service); FX=$(cid fixture-m2); BW=$(cid browser-worker); PG=$(cid nuq-postgres)
start=$(date -u +%Y-%m-%dT%H:%M:%S.%NZ | cut -c1-23)Z

sample_memory() { # one line per second until killed: host MemAvailable and every fcpi cgroup's current memory
  # The cgroups are resolved once, so the sampling itself adds no docker calls to the load.
  local pairs=() c
  for c in $(D ps -q --filter label=com.docker.compose.project=fcpi); do
    pairs+=("$(D inspect -f '{{index .Config.Labels "com.docker.compose.service"}}=/sys/fs/cgroup/system.slice/docker-{{.Id}}.scope/memory.current' "$c")")
  done
  while :; do
    local line="t=$(date -u +%H:%M:%S) mem_available_mib=$(awk '/^MemAvailable:/ {printf "%d", $2/1024}' /proc/meminfo)" p
    for p in "${pairs[@]}"; do line="$line ${p%%=*}=$(( $(sudo -n cat "${p#*=}" 2>/dev/null || echo 0) / 1048576 ))"; done
    echo "$line"
    sleep 1
  done
}
cgroup_state() { # per fcpi container: cap, current, peak and memory.events counters
  for c in $(D ps -aq --filter label=com.docker.compose.project=fcpi); do
    local id svc g; id=$(D inspect -f '{{.Id}}' "$c"); svc=$(D inspect -f '{{index .Config.Labels "com.docker.compose.service"}}' "$c")
    g=/sys/fs/cgroup/system.slice/docker-$id.scope
    if sudo -n test -d "$g"; then
      echo "$svc max=$(sudo -n cat $g/memory.max) current=$(sudo -n cat $g/memory.current) peak=$(sudo -n cat $g/memory.peak) $(sudo -n cat $g/memory.events | tr '\n' ' ')"
    else
      echo "$svc cgroup=absent state=$(D inspect -f '{{.State.Status}}' "$c")"
    fi
  done
}

sec meta
echo "utc=$start source_commit=$(cat $REPO/.fcpi-source-commit)"
for s in firecrawl-core retrieval-service fixture-m2 browser-worker; do echo "$s=$(D inspect -f '{{.Id}} image={{.Image}} started={{.State.StartedAt}} restarts={{.RestartCount}}' "$(cid $s)" 2>/dev/null || echo absent)"; done

if [ "$phase" = browser-down ]; then
  sec browser_stop
  D compose -p fcpi -f $REPO/deploy/compose.yaml stop browser-worker 2>&1 | tail -1
  echo "browser_state=$(D inspect -f '{{.State.Status}}' "$BW")"
fi
if [ "$phase" = stress ] || [ "$phase" = overcap ]; then
  sec cgroups_before
  cgroup_state
  sample_memory >/tmp/fcpi-m2-mem.$$ 2>&1 &
  SAMPLER=$!
fi
if [ "$phase" = crash ]; then
  # Kill every Chromium process in the worker 8 s into the slow render; the worker must notice,
  # the attempt must fail typed, the permit must come back and the next render must work.
  ( sleep 8; echo "killed_at=$(date -u +%H:%M:%S) chrome_processes=$(D exec --user 3320 "$BW" sh -c 'pgrep -c -f chrome-headless-shell || true')"; D exec --user 3320 "$BW" sh -c 'pkill -KILL -f chrome-headless-shell'; echo "kill_exit=$?" ) >/tmp/fcpi-m2-kill.$$ 2>&1 &
  KILLER=$!
fi

group=$phase
[ "$phase" = browser-down ] && group=browser-down
sec driver
D exec -i -e GROUP="$group" -e LAN_ADDRESS="$LAN" -e STRESS_MB="${STRESS_MB:-512}" -e OVERCAP_MB="${OVERCAP_MB:-2400}" "$CORE" node --input-type=module - <"$REPO/scripts/m2/retrieval-e2e.mjs" 2>&1 | redact
echo "driver_exit=${PIPESTATUS[0]}"

[ -n "${KILLER:-}" ] && { wait "$KILLER"; sec kill; cat /tmp/fcpi-m2-kill.$$; rm -f /tmp/fcpi-m2-kill.$$; }
if [ -n "${SAMPLER:-}" ]; then
  sleep 3; kill "$SAMPLER" 2>/dev/null; wait "$SAMPLER" 2>/dev/null
  sec memory_samples; cat /tmp/fcpi-m2-mem.$$; rm -f /tmp/fcpi-m2-mem.$$
  sec cgroups_after; cgroup_state
  sec host_oom; sudo -n journalctl -k --since "@$(date -d "$start" +%s)" --no-pager -o short-iso 2>/dev/null | grep -iE 'oom|killed process' | redact | tail -20; echo end
fi
# Every process left in the browser worker after the phase: pid, parent, state, age in seconds and
# name (no arguments). A killed or cancelled render must leave no Chromium process older than the
# phase's end and none defunct.
if [ -n "$BW" ] && [ "$(D inspect -f '{{.State.Status}}' "$BW" 2>/dev/null)" = running ]; then
  sec browser_processes
  echo "utc=$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  D exec --user 3320 "$BW" ps -eo pid=,ppid=,stat=,etimes=,comm= 2>&1
fi
if [ "$phase" = browser-down ]; then
  sec browser_start
  D compose -p fcpi -f $REPO/deploy/compose.yaml up -d --wait --wait-timeout 300 browser-worker 2>&1 | tail -1
fi

sleep 2
sec retrieval_log
D logs --since "$start" "$RS" 2>&1 | redact
sec fixture_log
D logs --since "$start" "$FX" 2>&1 | redact
sec browser_log
{ [ -n "$BW" ] && D logs --since "$start" "$BW" 2>&1; } | redact
sec attempts
D exec -i "$PG" psql -U postgres -d postgres -At -F $'\t' -X <<SQL | redact
SELECT a.logical_id, a.ordinal, a.purpose, a.strategy, a.domain, to_char(a.started_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
       coalesce(to_char(a.finished_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),''), coalesce(a.outcome,''), coalesce(a.target_status::text,''),
       coalesce(a.bytes::text,''), coalesce(a.subresources::text,''), acq.attempts
  FROM fcpi_retrieval.attempt a JOIN fcpi_retrieval.acquisition acq USING (logical_id)
 WHERE a.started_at >= '$start'::timestamptz ORDER BY a.started_at;
SQL
sec permits
D exec "$PG" psql -U postgres -d postgres -At -F $'\t' -X -c "SELECT kind, slot, holder IS NULL, coalesce(to_char(lease_until AT TIME ZONE 'UTC','HH24:MI:SS'),'') FROM fcpi_retrieval.permit ORDER BY 1, 2;"
sec health
for c in $(D ps -aq --filter label=com.docker.compose.project=fcpi); do D inspect -f '{{index .Config.Labels "com.docker.compose.service"}} {{.State.Status}} {{if .State.Health}}{{.State.Health.Status}}{{end}} restarts={{.RestartCount}}' "$c"; done
sec cgroups_end
cgroup_state
echo "host_mem_available_mib=$(awk '/^MemAvailable:/ {printf "%d", $2/1024}' /proc/meminfo)"
sec browser_health
D exec "$RS" node -e "fetch('http://10.231.2.20:3320/healthz').then(r=>r.text()).then(t=>console.log(t),e=>console.log('unreachable'))" 2>&1
sec end
echo end
