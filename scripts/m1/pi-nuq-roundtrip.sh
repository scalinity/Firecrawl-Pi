#!/usr/bin/env bash
# NuQ round trip on the running broker (decision D3), three cases:
#   1. a job completes through the quorum prefetch queue and the exclusive,
#      auto-delete reply queue;
#   2. a prefetched message that is never consumed expires after 50 s, and the job
#      is still served from PostgreSQL (lock reaper re-queues it, prefetch re-sends it);
#   3. the broker restarts, and a new job completes (upstream #4244 would hang here).
# Runs ON the Pi from the deployed copy:
#   ssh ... 'bash /opt/firecrawl-pi/scripts/m1/pi-nuq-roundtrip.sh <core> <rabbitmq> <postgres>'
# Prints a sectioned transcript; scripts/m1/verify.mjs decides PASS/FAIL from it.
#
# Jobs are submitted with /v0/scrape: at the pinned commit it is the route that enqueues a
# listenable NuQ job and waits on the reply queue (/v1 and /v2 scrape run in-process).
# The v0 controller deletes the NuQ row once it has read the result, so job state is
# observed while the job is in flight, and each case's core log lines are kept by scrape id.
#
# Case 2 pauses the nuq-worker-0 node process with SIGSTOP so nothing consumes the
# prefetch queue. The harness only reacts to a child exiting, so a paused child
# stays in place; SIGCONT resumes it.
set -uo pipefail
export LC_ALL=C
export PATH="/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"
CORE=${1:?core container}; RMQ=${2:?rabbitmq container}; PG=${3:?postgres container}
REPO=/opt/firecrawl-pi
FIXTURE_URL=http://m1.fixture.fcpi.test:8080/static.html
PREFETCH=nuq.queue_scrape.prefetch

D() { sudo -n docker "$@"; }
sec() { printf '### %s\n' "$1"; }
ts() { date -u +%Y-%m-%dT%H:%M:%SZ; }
now() { date +%s; }
psq() { D exec "$PG" psql -U postgres -Atc "$1" 2>&1; }
# RabbitMQ CLI calls run as the broker's own uid, so they read its Erlang cookie and can
# never create a root-owned one: the Compose uid (5672), or the image's rabbitmq user.
RMQ_USER=$(D inspect -f '{{.Config.User}}' "$RMQ" 2>/dev/null); RMQ_USER=${RMQ_USER%%:*}; RMQ_USER=${RMQ_USER:-rabbitmq}
queues() { D exec -u "$RMQ_USER" "$RMQ" rabbitmqctl list_queues -q name type durable auto_delete exclusive messages_ready messages consumers 2>&1; }
ready() { D exec -u "$RMQ_USER" "$RMQ" rabbitmqctl list_queues -q name messages_ready 2>/dev/null | awk -v q="$PREFETCH" '$1==q {print $2}'; }
counters() { # non-zero broker-wide counters from rabbitmq_prometheus, read from inside the core network.
  # No `-i` and stdin from /dev/null, so no command here can consume a caller's stdin.
  D exec "$CORE" node --input-type=module -e '
    const t = await (await fetch("http://rabbitmq:15692/metrics", { signal: AbortSignal.timeout(5000) })).text();
    const want = /^rabbitmq_global_messages_(delivered_get_auto_ack|delivered_consume_manual_ack|routed|dead_lettered_expired)_total\{/;
    for (const l of t.split("\n")) if (want.test(l) && Number(l.split(" ").pop()) !== 0) console.log(l);' </dev/null 2>&1
}
scrape() { # scrape [api_timeout_ms]
  D exec -i -e SCRAPE_ENDPOINT=v0 -e SCRAPE_URL="$FIXTURE_URL" -e SCRAPE_TIMEOUT_MS="${1:-60000}" "$CORE" node --input-type=module - <"$REPO/scripts/m1/core-scrape.mjs"
}
joblog() { # joblog <since-epoch> <scrape_id>: the core's NuQ log lines for one job
  [ -n "$2" ] || { echo "no scrape id"; return; }
  D logs --since "$(date -u -d "@$1" +%Y-%m-%dT%H:%M:%SZ)" "$CORE" 2>&1 | sed -E 's/\x1b\[[0-9;]*m//g' \
    | grep -E "$2|NuQ job (prefetch sent|sent|received)" | grep -E "NuQ job|Acquired job|taking job|Job done|$2" | cut -c1-200 | head -20
}
core_state() { D inspect "$CORE" | jq -r '.[0] | "restart_count=\(.RestartCount) started_at=\(.State.StartedAt) status=\(.State.Status)"'; }
core_ready() { # all harness children answer their own health endpoints
  D exec -i "$CORE" node --input-type=module - <"$REPO/scripts/m1/core-probe.mjs" 2>/dev/null \
    | jq -e '[.api_liveness, .extract_worker, .queue_worker, .nuq_worker_0, .nuq_prefetch_worker, .nuq_reconciler] | all(.status == 200)' >/dev/null 2>&1
}

sec meta
ts
echo "source_commit=$(cat /opt/firecrawl-pi/.fcpi-source-commit 2>/dev/null)"
echo "core=$CORE rabbitmq=$RMQ postgres=$PG fixture=$FIXTURE_URL"
core_state

# ---------------------------------------------------------------- case 1
sec case1_counters_before; counters
sec case1_scrape
t1=$(now); c1=$(scrape 60000); echo "$c1"
sec case1_queues; queues
sec case1_counters_after; counters
sec case1_core_log; joblog "$t1" "$(echo "$c1" | jq -r '.scrape_id // empty')"

# ---------------------------------------------------------------- case 2
sec case2_counters_before; counters
sec case2_timeline
wpid=$(D exec "$CORE" ps -eo pid,args --no-headers | awk '$2=="node" && $3 ~ /services\/worker\/nuq-worker\.js$/ {print $1}')
echo "nuq_worker_pid=$wpid"
t0=$(now)
D exec -u 0 "$CORE" kill -STOP "$wpid" && echo "t+0 SIGSTOP nuq-worker-0 at $(ts)"
out2=$(mktemp)
scrape 240000 >"$out2" 2>&1 &
spid=$!
seen_ready=0; seen_expired=0; resumed=0
for i in $(seq 1 150); do
  r=$(ready); row=$(psq "select status || ' stalls=' || coalesce(stalls, 0) from nuq.queue_scrape where data->>'url' = '$FIXTURE_URL' and created_at > to_timestamp($t0) order by created_at desc limit 1")
  el=$(( $(now) - t0 ))
  echo "t+$el ready=${r:-?} job=${row:-none}"
  [ "${r:-0}" -ge 1 ] && [ $seen_ready = 0 ] && seen_ready=1 && echo "t+$el EVENT prefetch_message_ready"
  [ $seen_ready = 1 ] && [ "${r:-0}" = 0 ] && [ $seen_expired = 0 ] && seen_expired=1 && echo "t+$el EVENT prefetch_message_gone_unconsumed"
  # Resume once the expired job was re-queued by the lock reaper and prefetched again, or at 120 s.
  if [ $resumed = 0 ] && { { [ $seen_expired = 1 ] && [ "${r:-0}" -ge 1 ] && echo "$row" | grep -q 'stalls=[1-9]'; } || [ $el -ge 120 ]; }; then
    D exec -u 0 "$CORE" kill -CONT "$wpid" && resumed=1 && echo "t+$el SIGCONT nuq-worker-0 at $(ts)"
  fi
  [ $resumed = 1 ] && ! kill -0 $spid 2>/dev/null && break
  sleep 1
done
[ $resumed = 0 ] && D exec -u 0 "$CORE" kill -CONT "$wpid" && echo "SIGCONT (loop end)"
wait $spid
c2=$(cat "$out2"); rm -f "$out2"
sec case2_scrape; echo "$c2"
sec case2_counters_after; counters
sec case2_core_log; joblog "$t0" "$(echo "$c2" | jq -r '.scrape_id // empty' 2>/dev/null)"

# ---------------------------------------------------------------- case 3
sec case3_restart
core_state
t3=$(now); echo "restart_begin=$(ts)"
D restart "$RMQ" >/dev/null
for i in $(seq 1 120); do D exec -u "$RMQ_USER" "$RMQ" rabbitmq-diagnostics -q ping >/dev/null 2>&1 && break; sleep 1; done
echo "broker_ping_ok_after_s=$(( $(now) - t3 ))"
sleep 5
# The core may have restarted (upstream lets amqp.connect ECONNREFUSED escape the NuQ
# polling loops); wait for it to be running and healthy before submitting.
for i in $(seq 1 90); do
  [ "$(D inspect -f '{{.State.Status}}' "$CORE" 2>/dev/null)" = running ] && core_ready && break
  sleep 2
done
echo "core_ready_after_s=$(( $(now) - t3 ))"
core_state
sec case3_scrape
t3s=$(now); c3=$(scrape 60000); echo "$c3"
sec case3_queues; queues
sec case3_core_log; joblog "$t3s" "$(echo "$c3" | jq -r '.scrape_id // empty')"
sec case3_core_log_since_restart
D logs --since "$(date -u -d "@$t3" +%Y-%m-%dT%H:%M:%SZ)" "$CORE" 2>&1 | sed -E 's/\x1b\[[0-9;]*m//g' \
  | grep -iE 'listener|sender|ECONNREFUSED|terminated unexpectedly|failed with exit code|Shutting down|Starting services' | cut -c1-200 | head -30
echo end
