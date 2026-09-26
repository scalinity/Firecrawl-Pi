#!/usr/bin/env bash
# NuQ failure tests for review findings R1, R2 and R3, ON the Pi:
#   ssh … 'bash -s -- <test>' < scripts/m2/pi-nuq-tests.sh
# test:
#   broker  M2-B01 (R2, PC-NUQ-CONNECT) and R1 (#4244). The core's restart policy is off for the
#           test, so a harness exit would show as an exited core rather than a quiet restart. The
#           broker is stopped for at least 35 s; a synchronous scrape submitted during the outage
#           must complete through PostgreSQL. Once the broker is back, the core's reply queue
#           (nuq.queue_scrape.listen.*) must have one consumer within 60 s and a synchronous
#           scrape must complete through it. The core must not restart. The policy is restored.
#   kill    M2-B02. The NuQ worker is killed during a synchronous scrape of a slow page, and what
#           the client, the core and the job go through is recorded until the job ends.
#   stall   M2-R3. A batch scrape of a slow page that answers 503 is stalled twice by freezing the
#           NuQ worker until NuQ's lock reaper requeues the job. Its logical page may see at most
#           four acquisition attempts in total (without one budget, three runs would make six).
# v1 and v2 synchronous scrapes run inside the API process with no NuQ job (skipNuq), so the
# synchronous path through NuQ and its reply queue is v0's. Signals go to the worker as its own
# uid, 3002: root in the core has no CAP_KILL.
set -uo pipefail
export LC_ALL=C
export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
REPO=/opt/firecrawl-pi
test=${1:?usage: pi-nuq-tests.sh broker|kill|stall}
D() { sudo -n docker "$@"; }
cid() { D ps -q --filter label=com.docker.compose.project=fcpi --filter "label=com.docker.compose.service=$1"; }
sec() { printf '### %s_%s\n' "$test" "$1"; }
now() { date -u +%Y-%m-%dT%H:%M:%S.%3NZ; }
CORE=$(cid firecrawl-core); PG=$(cid nuq-postgres); RMQ=$(D ps -aq --filter label=com.docker.compose.project=fcpi --filter label=com.docker.compose.service=rabbitmq)
RS=$(cid retrieval-service); FX=$(cid fixture-m2)
M2=http://m2.fixture.fcpi.test:8080
sql() { D exec -i "$PG" psql -U postgres -d postgres -At -F $'\t' -X -c "$1"; }
core_state() { D inspect -f 'status={{.State.Status}} health={{if .State.Health}}{{.State.Health.Status}}{{end}} restarts={{.RestartCount}} started={{.State.StartedAt}} policy={{.HostConfig.RestartPolicy.Name}}' "$CORE"; }
listen_consumers() { D exec "$RMQ" rabbitmqctl -q list_queues -p / name consumers 2>/dev/null | awk '$1 ~ /^nuq\.queue_scrape\.listen\./ {n++; c+=$2} END {printf "listen_queues=%d consumers=%d\n", n, c}'; }
worker_pid() { D exec --user 3002 "$CORE" pgrep -f '^node dist/src/services/worker/nuq-worker.js' 2>/dev/null | head -1; }
job_row() { sql "SELECT id, status, coalesce(stalls,0), coalesce(to_char(locked_at AT TIME ZONE 'UTC','HH24:MI:SS'),''), listen_channel_id IS NOT NULL, left(coalesce(failedreason,''),160) FROM nuq.queue_scrape WHERE id = '$1';"; }
# A synchronous v0 scrape from inside the core, on loopback as the gateway reaches it; one JSON line.
v0() { # case id, url, timeout ms
  D exec -e CASE="$1" -e URL="$2" -e TIMEOUT="$3" "$CORE" node -e '
const t0 = Date.now(), T = Number(process.env.TIMEOUT);
const out = (o) => console.log(JSON.stringify({ case: process.env.CASE, started: new Date(t0).toISOString(), ...o, ms: Date.now() - t0 }));
fetch("http://127.0.0.1:3002/v0/scrape", { method: "POST", headers: { "content-type": "application/json" },
  body: JSON.stringify({ url: process.env.URL, timeout: T }), signal: AbortSignal.timeout(T + 30000) })
  .then(async (r) => { const j = await r.json().catch(() => null); const md = j?.data?.markdown ?? j?.data?.content ?? "";
    out({ http: r.status, success: j?.success ?? null, error: typeof j?.error === "string" ? j.error.slice(0, 200) : null,
      sentinels: [...md.matchAll(/fcpi-m[12]-[a-z]+-[0-9a-f]{4}/g)].map((m) => m[0]) }); })
  .catch((e) => out({ error: `client: ${e.message}` }));' 2>&1
  echo "exec_exit=$?"
}
# The core's lines about NuQ's broker paths, its worker's locks and the harness, since $1.
core_log() {
  D logs --since "$1" "$CORE" 2>&1 | sed -E 's/\x1b\[[0-9;]*m//g' |
    grep -E 'NuQ (sender|listener|job sent|backed-up)|falling back to postgres|waiting by polling|terminated unexpectedly|Shutting down|All services running|Could not update job status|renew lock|Acquired job|ECONNREFUSED' | cut -c1-400
}
start=$(now)
sec meta
echo "utc=$start source_commit=$(cat $REPO/.fcpi-source-commit)"
echo "core=$(D inspect -f '{{.Id}} image={{.Image}}' "$CORE") $(core_state)"

case $test in
broker)
  sec restart_policy_off
  D update --restart=no "$CORE" >/dev/null && echo "core $(core_state)"
  sec before
  echo "rabbitmq=$(D inspect -f '{{.State.Status}} {{.State.Health.Status}}' "$RMQ") $(listen_consumers)"
  v0 B01-before "$M2/short.html?b01=before" 30000
  echo "after_before_scrape $(listen_consumers)"
  sec broker_stop
  t_stop=$(date +%s); echo "utc=$(now)"
  D stop -t 10 "$RMQ" >/dev/null; echo "rabbitmq=$(D inspect -f '{{.State.Status}}' "$RMQ")"
  sleep 5
  sec during
  v0 B01-during "$M2/short.html?b01=during" 60000
  echo "core $(core_state)"
  while [ $(( $(date +%s) - t_stop )) -lt 35 ]; do sleep 1; done
  sec broker_start
  echo "utc=$(now) outage_s=$(( $(date +%s) - t_stop ))"
  D start "$RMQ" >/dev/null
  for _ in $(seq 1 60); do [ "$(D inspect -f '{{.State.Health.Status}}' "$RMQ")" = healthy ] && break; sleep 2; done
  t_up=$(date +%s); echo "healthy_utc=$(now) rabbitmq=$(D inspect -f '{{.State.Status}} {{.State.Health.Status}}' "$RMQ")"
  sec consumers
  # R1: the reply queue must have one consumer within 60 s of the broker being healthy again.
  for _ in $(seq 1 30); do
    line=$(listen_consumers); echo "t+$(( $(date +%s) - t_up ))s $line"
    case $line in *consumers=1) break ;; esac
    sleep 2
  done
  sec after
  v0 B01-after "$M2/short.html?b01=after" 30000
  echo "after_scrape $(listen_consumers)"
  sec core_state
  echo "core $(core_state)"
  D exec --user 3002 "$CORE" ps -eo pid=,ppid=,etimes=,args= 2>&1 | grep -v ' ps ' | cut -c1-100
  sec restart_policy_restore
  if [ "$(D inspect -f '{{.State.Status}}' "$CORE")" != running ]; then
    echo "core not running: starting it"; D compose -p fcpi -f $REPO/deploy/compose.yaml up -d --wait --wait-timeout 300 firecrawl-core 2>&1 | tail -1
  fi
  D update --restart=unless-stopped "$CORE" >/dev/null && echo "core $(core_state)"
  ;;
kill)
  marker=b02-$(cat /proc/sys/kernel/random/uuid)
  sec client_start
  tmp=$(mktemp); v0 B02-client "$M2/slow?ms=20000&$marker=1" 60000 >"$tmp" 2>&1 &
  CLIENT=$!
  job=""
  for _ in $(seq 1 30); do
    job=$(sql "SELECT id FROM nuq.queue_scrape WHERE data->>'url' LIKE '%$marker%' AND status = 'active' LIMIT 1;")
    [ -n "$job" ] && break; sleep 0.5
  done
  echo "job=${job:-none} utc=$(now)"
  [ -n "$job" ] && job_row "$job"
  sleep 3
  sec kill
  pid=$(worker_pid); echo "worker_pid=${pid:-none} utc=$(now)"
  [ -n "$pid" ] && D exec --user 3002 "$CORE" kill -KILL "$pid"; echo "kill_exit=$?"
  sec core_observed
  for i in $(seq 1 45); do echo "t+$((i*2))s $(core_state)"; sleep 2; [ "$(D inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{end}}' "$CORE")" = healthy ] && [ "$i" -gt 5 ] && break; done
  sec client_result
  wait "$CLIENT"; cat "$tmp"; rm -f "$tmp"
  sec core_ready
  for _ in $(seq 1 120); do [ "$(D inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{end}}' "$CORE")" = healthy ] && break; sleep 2; done
  echo "utc=$(now) core $(core_state)"
  sec job_observed
  for i in $(seq 1 60); do
    [ -n "$job" ] || break
    row=$(job_row "$job"); echo "t+$((i*3))s $row"
    case $row in *$'\t'completed$'\t'*|*$'\t'failed$'\t'*) break ;; esac
    sleep 3
  done
  sec attempts
  [ -n "$job" ] && sql "SELECT logical_id, ordinal, strategy, coalesce(outcome,''), coalesce(target_status::text,''), to_char(started_at AT TIME ZONE 'UTC','HH24:MI:SS.MS') FROM fcpi_retrieval.attempt WHERE logical_id = '$job' ORDER BY ordinal;"
  sec fixture_hits
  echo "hits=$(D logs --since "$start" "$FX" 2>&1 | grep -c "$marker")"
  ;;
stall)
  # NuQ's prefetch worker takes a requeued job again at once (active, with a new lock) and hands
  # it to the worker through the broker, so a requeue shows as the stalls count rising, not as a
  # queued row. Each freeze starts when the run's first attempt row appears, so the worker holds
  # the job; the retrieval service, not frozen, finishes that run's attempts meanwhile. The target
  # answers 503 after 1.5 s, so a run spends two attempts in about 4 s and two runs fit inside the
  # logical page's 90 s deadline: without one budget, three runs would make six attempts.
  marker=r3-$(cat /proc/sys/kernel/random/uuid)
  attempts() { sql "SELECT count(*) FROM fcpi_retrieval.attempt WHERE logical_id = '$1';"; }
  sec submit
  D exec -e URL="$M2/slow?ms=1500&status=503&$marker=1" "$CORE" node -e '
fetch("http://127.0.0.1:3002/v2/batch/scrape", { method: "POST", headers: { "content-type": "application/json" },
  body: JSON.stringify({ urls: [process.env.URL], formats: ["markdown"] }) })
  .then(async (r) => { const j = await r.json(); console.log(JSON.stringify({ http: r.status, success: j.success, batchId: j.id ?? null, error: j.error ?? null })); });' 2>&1
  job=""
  for _ in $(seq 1 60); do job=$(sql "SELECT id FROM nuq.queue_scrape WHERE data->>'url' LIKE '%$marker%' LIMIT 1;"); [ -n "$job" ] && break; sleep 0.5; done
  echo "job=${job:-none}"
  [ -n "$job" ] || { echo "no job"; exit 1; }
  pid=$(worker_pid); echo "worker_pid=${pid:-none}"
  for n in 1 2; do
    sec "stall_$n"
    first=$(( 2 * n - 1 ))
    for _ in $(seq 1 400); do [ "$(attempts "$job")" -ge "$first" ] && break; sleep 0.2; done
    D exec --user 3002 "$CORE" kill -STOP "$pid"; echo "stopped utc=$(now) exit=$? attempts=$(attempts "$job")"
    echo "row $(job_row "$job")"
    for _ in $(seq 1 60); do row=$(job_row "$job"); [ "$(printf '%s\n' "$row" | cut -f3)" -ge "$n" ] 2>/dev/null && break; sleep 2; done
    echo "requeued utc=$(now) attempts=$(attempts "$job") row $row"
    D exec --user 3002 "$CORE" kill -CONT "$pid"; echo "continued utc=$(now) exit=$?"
  done
  sec final
  for _ in $(seq 1 90); do row=$(job_row "$job"); case $row in *$'\t'completed$'\t'*|*$'\t'failed$'\t'*) break ;; esac; sleep 2; done
  echo "utc=$(now) $row"
  sec attempts
  sql "SELECT logical_id, ordinal, strategy, coalesce(outcome,''), coalesce(target_status::text,''), to_char(started_at AT TIME ZONE 'UTC','HH24:MI:SS.MS') FROM fcpi_retrieval.attempt WHERE logical_id = '$job' ORDER BY ordinal;"
  sql "SELECT logical_id, attempts FROM fcpi_retrieval.acquisition WHERE logical_id = '$job';"
  sec acquisitions
  D logs --since "$start" "$RS" 2>&1 | grep '"event":"acquisition"' | grep "$job" | cut -c1-420
  sec fixture_hits
  echo "hits=$(D logs --since "$start" "$FX" 2>&1 | grep -c "$marker")"
  ;;
*) echo "unknown test $test" >&2; exit 2 ;;
esac

sec core_log
core_log "$start"
sec health
for c in $(D ps -aq --filter label=com.docker.compose.project=fcpi); do D inspect -f '{{index .Config.Labels "com.docker.compose.service"}} {{.State.Status}} {{if .State.Health}}{{.State.Health.Status}}{{end}} restarts={{.RestartCount}} policy={{.HostConfig.RestartPolicy.Name}}' "$c"; done
sec end
echo end
