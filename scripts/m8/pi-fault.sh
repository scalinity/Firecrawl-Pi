#!/usr/bin/env bash
# M8's injected failures (FIRECRAWL_PI_SPEC.md §24.2, M8 "Automated Verification", AC15-AC17, AC23), ON the Pi, one case
# per run, as root:   ssh … 'sudo -n bash /opt/firecrawl-pi/scripts/m8/pi-fault.sh <case>'
# Each case injects one failure into project fcpi only, observes the platform through the gateway (as the soak client)
# and fcpi status, removes the failure and observes the recovery, printing one JSON record per step under "### <case>".
# Every negative observation has its positive control in the same case (the healthy state before, the same request
# answered after). scripts/m8/faults.mjs runs the cases in order and the reboot from outside; scripts/m8/verify.mjs
# judges them. Nothing here touches a named volume, a service outside the project, or a live provider.
set -uo pipefail
. /opt/firecrawl-pi/scripts/ops/lib.sh
need_root
CASE=${1:?case}
C=(docker compose -p fcpi -f "$REPO/deploy/compose.yaml")
SOAK=/etc/firecrawl-pi/secrets/clients/soak.token
M1=http://m1.fixture.fcpi.test:8080 M2=http://m2.fixture.fcpi.test:8080 M3=http://m3.fixture.fcpi.test:8080
echo "### $CASE"
out() { jq -cn --arg utc "$(utc)" --arg step "$1" --argjson d "${2:-"{}"}" '{utc:$utc,step:$step} + $d'; }
brief() { bash "$REPO/scripts/ops/status.sh" --json 2>/dev/null | jq -c '{healthy, api: .core.api, worker: .core.worker, rest: .rest.ready, ledger: .rest.ledger_ok, mcp: .mcp.ready,
  queue_ok: .queue.ok, search: .capabilities.search, browser: .capabilities.browser, admission: {dispatch: .admission.dispatch, browser: .admission.browser, reasons: .admission.reasons},
  incidents: (.incidents | keys), not_healthy: [.services | to_entries[] | select(.value.health != "healthy" or .value.state != "running") | .key]}'; }
# call <METHOD> <path> [body]: as the soak client; CALL holds {status, ms, code, class, error}, GW_BODY the answer.
call() {
  OPS_TOKEN=$SOAK GW_TIMEOUT=${CT:-120} gw "$@"
  CALL=$(jq -cn --arg s "$GW_STATUS" --argjson ms "$GW_MS" --arg b "$GW_BODY" '($b | fromjson? // {}) as $j
    | {status: ($s | tonumber), ms: $ms, code: ($j.code // null), class: ((($j.error // "") | capture("Retrieval failed: (?<c>[A-Z_]+)")? | .c) // null), error: (($j.error // null) | if . then .[0:200] else . end)}')
}
has() { grep -q -- "$1" <<<"$GW_BODY"; }
static() { call POST /v2/scrape "{\"url\":\"$M1/static.html?f=$CASE-$RANDOM\",\"formats\":[\"markdown\"]}"; CALL=$(jq -c --argjson s "$(has fcpi-m1-static-7f3a && echo true || echo false)" '. + {sentinel: $s}' <<<"$CALL"); }
crawl() { call POST /v2/crawl "{\"url\":\"$M3/\",\"limit\":12}"; JOB=$(jq -r '.id // empty' <<<"$GW_BODY" 2>/dev/null); }
job() { OPS_TOKEN=$SOAK GW_TIMEOUT=30 gw GET "/platform/v1/jobs/$1"; jq -c '.job | {state, completed, total, archived, errorCount, error}' <<<"$GW_BODY" 2>/dev/null || echo "{\"http\":$GW_STATUS}"; }
wait_job() { local id=$1 end=$(( $(now_s) + ${2:-600} )) s; while :; do s=$(job "$id"); jq -e '.state | IN("SUCCEEDED","PARTIAL","FAILED","CANCELLED","EXPIRED")' <<<"$s" >/dev/null 2>&1 && break; [ "$(now_s)" -ge "$end" ] && break; sleep 5; done; echo "$s"; }
# until_ <seconds> <command line>: seconds until it held, or -1.
until_() { local t0; t0=$(now_s); while :; do eval "$2" >/dev/null 2>&1 && { echo $(( $(now_s) - t0 )); return 0; }; [ $(( $(now_s) - t0 )) -ge "$1" ] && { echo -1; return 1; }; sleep 3; done; }
ready() { bash "$REPO/scripts/ops/status.sh" --json 2>/dev/null | jq -e '.healthy and .mcp.ready and (.services | all(.[]; .state == "running" and (.health == "healthy" or .health == "none")))' >/dev/null; }
svc() { cid "$1"; }
pid_of() { docker inspect -f '{{.State.Pid}}' "$(svc "$1")"; }
restarts() { docker inspect -f '{{.RestartCount}}' "$(svc "$1")"; }
started() { docker inspect -f '{{.State.StartedAt}}' "$(svc "$1")"; }
swap_all() { local bad=0 n=0; for c in $(docker ps -q --filter label=com.docker.compose.project=fcpi); do n=$((n + 1)); read -r p id < <(docker inspect -f '{{.HostConfig.CgroupParent}} {{.Id}}' "$c")
  [ "$(cat "/sys/fs/cgroup/${p:-system.slice}/docker-$id.scope/memory.swap.max")" = 0 ] || [ "$(cat "/sys/fs/cgroup/${p:-system.slice}/memory.swap.max")" = 0 ] || bad=$((bad + 1)); done; echo "{\"containers\":$n,\"swap_allowed\":$bad}"; }
tick() { bash "$REPO/scripts/ops/tick.sh"; }
notices() { ls "$STATE"/alerts/outbox/ 2>/dev/null | grep -c -- "$1" || true; }
oom_sum() { local s=0 v; for c in $(docker ps -q --filter label=com.docker.compose.project=fcpi); do read -r p id < <(docker inspect -f '{{.HostConfig.CgroupParent}} {{.Id}}' "$c")
  v=$(awk '$1 == "oom_kill" {print $2}' "/sys/fs/cgroup/${p:-system.slice}/docker-$id.scope/memory.events"); s=$((s + ${v:-0})); done; echo $s; }
IMG_NODE=$(sed -n 's#^ *image: \(node@sha256:[0-9a-f]\{64\}\)$#\1#p' "$REPO/deploy/compose.yaml" | head -1)

case $CASE in
docker_restart)
  out before "$(jq -cn --argjson b "$(brief)" '{status:$b}')"
  crawl; out submitted "$(jq -c --arg j "$JOB" '{call: ., job: $j}' <<<"$CALL")"
  t0=$(now_s); systemctl restart docker.service; rc=$?
  s=$(until_ 600 ready)
  out ready "$(jq -cn --argjson rc $rc --argjson s "$s" --argjson b "$(brief)" --argjson sw "$(swap_all)" --arg st "$(systemctl is-active fcpi-stack.service)" '{restart_exit:$rc, ready_after_s:$s, status:$b, swap:$sw, stack_unit:$st}')"
  out job_after "$(jq -cn --argjson j "$(wait_job "$JOB" 600)" '{job:$j}')"
  static; out static_after "$CALL" ;;

mcp_crash)
  crawl; out submitted "$(jq -c --arg j "$JOB" '{call: ., job: $j}' <<<"$CALL")"
  r0=$(restarts mcp-gateway); out before "$(jq -cn --argjson b "$(brief)" --argjson r "$r0" '{status:$b, restarts:$r}')"
  kill -9 "$(pid_of mcp-gateway)"
  static; out rest_during "$CALL"
  s=$(until_ 180 'GW_TIMEOUT=10 mcp tools/list "{}"; [ "$GW_STATUS" = 200 ]')
  # As the job's own principal: another principal's token is answered 404, as owner scoping requires.
  OPS_TOKEN=$SOAK GW_TIMEOUT=60 mcp tools/call "$(jq -cn --arg id "$JOB" '{name:"firecrawl_check_crawl_status",arguments:{id:$id}}')"
  out mcp_after "$(jq -cn --argjson s "$s" --arg st "$GW_STATUS" --argjson r "$(restarts mcp-gateway)" --argjson r0 "$r0" --arg b "$GW_BODY" \
    '{back_after_s:$s, restarts_delta:($r - $r0), handle_call_status:($st|tonumber), handle_call_ok:(($b | fromjson? // {}) | (.result != null and .result.isError != true)),
      handle_result:(($b | fromjson? // {}) | {isError: .result.isError, error: .error, text: ((.result.content[0].text // "") | .[0:160])})}')" ;;

api_child_crash)
  crawl; out submitted "$(jq -c --arg j "$JOB" '{call: ., job: $j}' <<<"$CALL")"
  c=$(svc firecrawl-core); r0=$(restarts firecrawl-core) s0=$(started firecrawl-core)
  out before "$(jq -cn --argjson b "$(brief)" '{status:$b}')"
  p=$(docker top "$c" -eo pid,args | awk '$2 == "node" && $3 == "dist/src/index.js" && NF == 3 {print $1}' | head -1)
  kill -9 "$p"; t0=$(now_s)
  sleep 3; static; out rest_during "$CALL"
  s=$(until_ 180 '[ "$(bash $REPO/scripts/ops/status.sh --json | jq -r .core.api)" = false ]'); out detected "$(jq -cn --argjson s "$s" --argjson b "$(brief)" '{api_down_seen_after_s:$s, status:$b}')"
  s=$(until_ 600 ready)
  out recovered "$(jq -cn --argjson s "$s" --argjson r "$(restarts firecrawl-core)" --argjson r0 "$r0" --arg st "$(started firecrawl-core)" --arg s0 "$s0" \
    '{ready_after_s:$s, container_restarts_delta:($r - $r0), container_restarted:($st != $s0)}')"
  out job_after "$(jq -cn --argjson j "$(wait_job "$JOB" 600)" '{job:$j}')" ;;

worker_child_crash)
  # A hung NuQ worker (SIGSTOP), the degraded state spec §24.1 names: its health endpoint stops answering while the API
  # stays live. The harness does not see a stopped child, so recovery is the supervisor's restart of the core once
  # Docker marks it unhealthy. (A worker killed outright makes the harness stop the whole core, as api_child_crash shows.)
  c=$(svc firecrawl-core); r0=$(restarts firecrawl-core); sup0=$(jq -c 'select(.service == "firecrawl-core")' "$STATE/supervisor/restarts.jsonl" 2>/dev/null | wc -l)
  out before "$(jq -cn --argjson b "$(brief)" --arg t "$(docker top "$c" -eo pid,args | awk 'NR > 1 {$1=""; print}' | sort | uniq -c | tr -s ' ' | tr '\n' ';')" '{status:$b, processes:$t}')"
  p=$(docker top "$c" -eo pid,args | awk '$2 == "node" && $3 == "dist/src/services/worker/nuq-worker.js" && NF == 3 {print $1}' | head -1)
  [ -n "$p" ] || { out no_worker_process '{}'; exit 1; }
  kill -STOP "$p"
  s=$(until_ 180 '[ "$(bash $REPO/scripts/ops/status.sh --json | jq -r ".core.worker")" = false ]')
  out detected "$(jq -cn --argjson s "$s" --argjson b "$(brief)" '{worker_down_seen_after_s:$s, status:$b}')"
  s=$(until_ 600 ready)
  out recovered "$(jq -cn --argjson s "$s" --argjson r "$(restarts firecrawl-core)" --argjson r0 "$r0" --argjson b "$(brief)" \
    --argjson sup "$(( $(jq -c 'select(.service == "firecrawl-core")' "$STATE/supervisor/restarts.jsonl" 2>/dev/null | wc -l) - sup0 ))" '{ready_after_s:$s, container_restarts_delta:($r - $r0), supervisor_restarts:$sup, status:$b}')"
  crawl; out job_after "$(jq -cn --argjson j "$(wait_job "$JOB" 600)" '{job:$j}')" ;;

postgres_down)
  out before "$(jq -cn --argjson b "$(brief)" '{status:$b}')"
  key=m8-pg-$(date +%s)
  "${C[@]}" stop nuq-postgres >/dev/null 2>&1
  GW_EXTRA_HEADERS="x-idempotency-key: $key" call POST /v2/crawl "{\"url\":\"$M3/\",\"limit\":12}"; out submit_during "$CALL"
  static; out scrape_during "$CALL"
  CT=20 call GET /platform/v1/status; out platform_status_during "$(jq -c --arg b "$GW_BODY" '. + {ledger_ok: ($b | fromjson? // {}).ledger.ok}' <<<"$CALL")"
  out status_during "$(jq -cn --argjson b "$(brief)" '{status:$b}')"
  "${C[@]}" start nuq-postgres >/dev/null 2>&1
  s=$(until_ 600 ready); out recovered "$(jq -cn --argjson s "$s" --argjson b "$(brief)" '{ready_after_s:$s, status:$b}')"
  GW_EXTRA_HEADERS="x-idempotency-key: $key" call POST /v2/crawl "{\"url\":\"$M3/\",\"limit\":12}"; id1=$(jq -r '.id // empty' <<<"$GW_BODY"); out submit_after "$CALL"
  GW_EXTRA_HEADERS="x-idempotency-key: $key" call POST /v2/crawl "{\"url\":\"$M3/\",\"limit\":12}"; id2=$(jq -r '.id // empty' <<<"$GW_BODY"); out submit_again "$CALL"
  n=$(pg "SELECT count(*) FROM fcpi_platform.idempotency WHERE key LIKE '%$key%'" 2>/dev/null || echo "?")
  out idempotent "$(jq -cn --arg a "$id1" --arg b "$id2" --arg n "$n" '{first:$a, second:$b, same:($a == $b and $a != ""), idempotency_rows:$n}')"
  out job_after "$(jq -cn --argjson j "$(wait_job "$id1" 600)" '{job:$j}')" ;;

redis_down|rabbitmq_down)
  s0=${CASE%_down}
  out before "$(jq -cn --argjson b "$(brief)" '{status:$b}')"
  "${C[@]}" stop "$s0" >/dev/null 2>&1
  crawl; j=$JOB; out submit_during "$(jq -c --arg j "$j" '. + {job:$j}' <<<"$CALL")"
  CT=130 static; out scrape_during "$CALL"   # past the gateway's 110 s core deadline, so its own typed answer is recorded
  sleep 35; out status_during "$(jq -cn --argjson b "$(brief)" '{status:$b}')"
  "${C[@]}" start "$s0" >/dev/null 2>&1
  s=$(until_ 600 ready); out recovered "$(jq -cn --argjson s "$s" --argjson b "$(brief)" '{ready_after_s:$s, status:$b}')"
  [ -n "$j" ] && out job_after "$(jq -cn --argjson j "$(wait_job "$j" 900)" '{job:$j}')"
  static; out static_after "$CALL" ;;

browser_crash)
  out before "$(jq -cn --argjson b "$(brief)" '{status:$b}')"
  b=$(svc browser-worker)
  ( OPS_TOKEN=$SOAK GW_TIMEOUT=150 gw POST /v2/scrape "{\"url\":\"$M2/js-hold.html?k=m8-$RANDOM\",\"formats\":[\"markdown\"]}"
    printf '%s\n' "$GW_STATUS $(jq -r '.error // .code // "ok"' <<<"$GW_BODY" 2>/dev/null | head -c 200)" >"$RUND/fault-browser.txt" ) &
  bg=$!
  until_ 60 "[ \$(docker exec --user 3320 $b sh -c 'pgrep -c -f [c]hrome-headless-shell || true') -gt 0 ]" >/dev/null
  n0=$(docker exec --user 3320 "$b" sh -c 'pgrep -c -f [c]hrome-headless-shell || true')
  docker exec --user 3320 "$b" sh -c 'pkill -9 -f [c]hrome-headless-shell || true'
  wait $bg
  out render_killed "$(jq -cn --arg r "$(cat "$RUND/fault-browser.txt")" --argjson n "$n0" '{chrome_processes_killed:$n, answer:$r}')"
  rm -f "$RUND/fault-browser.txt"
  sleep 5
  held=$(pg "SELECT count(*) FROM fcpi_retrieval.permit WHERE kind = 'browser' AND holder IS NOT NULL AND lease_until > now()")
  left=$(docker exec --user 3320 "$b" sh -c 'pgrep -c -f [c]hrome-headless-shell || true')
  # The worker relaunches Chromium after it: the next render is asked every five seconds, at most a minute, and each refusal
  # before the replacement serves is recorded with its class.
  t0=$(now_s) tries=0 refusals='[]'
  while :; do
    tries=$((tries + 1)); call POST /v2/scrape "{\"url\":\"$M2/js.html?f=m8-$RANDOM\",\"formats\":[\"markdown\"]}"
    has fcpi-m2-js-5c1e && break
    refusals=$(jq -c --argjson c "$CALL" '. + [$c | {status, class, code}]' <<<"$refusals")
    [ $(( $(now_s) - t0 )) -ge 60 ] && break; sleep 5
  done
  out next_render "$(jq -c --argjson s "$(has fcpi-m2-js-5c1e && echo true || echo false)" --arg held "$held" --arg left "$left" --argjson b "$(brief)" --argjson r "$refusals" --argjson t "$tries" --argjson w "$(( $(now_s) - t0 ))" \
    '. + {sentinel:$s, browser_permits_held:$held, chrome_left_before_next:$left, tries:$t, served_after_s:$w, refusals_before:$r, host:$b}' <<<"$CALL")" ;;

searxng_down)
  "${C[@]}" stop searxng >/dev/null 2>&1
  call POST /v2/search '{"query":"fcpi fault search","limit":3}'; out search_during "$(jq -c --arg b "$GW_BODY" '. + {results: (($b | fromjson? // {}).data // null | tostring | length)}' <<<"$CALL")"
  static; out scrape_during "$CALL"
  call POST /v2/map "{\"url\":\"$M3/\"}"; out map_during "$(jq -c --arg b "$GW_BODY" '. + {links: ((($b | fromjson? // {}).links // []) | length)}' <<<"$CALL")"
  crawl; j=$JOB
  tick; sleep 61; tick; sleep 61; tick
  out not_resurrected "$(jq -cn --arg st "$(docker inspect -f '{{.State.Status}}' "$(svc searxng)")" --argjson b "$(brief)" --argjson j "$(wait_job "$j" 600)" '{searxng_state:$st, status:$b, crawl:$j}')"
  "${C[@]}" start searxng >/dev/null 2>&1
  s=$(until_ 300 ready)
  call POST /v2/search '{"query":"fcpi fault search","limit":3}'; out search_after "$(jq -c --argjson s "$s" --arg b "$GW_BODY" '. + {ready_after_s:$s, results: (($b | fromjson? // {}).data // null | tostring | length)}' <<<"$CALL")" ;;

proxy_down)
  # The residential route selected and its proxy (on fixture-m6) down; the target is the M3 site on another container,
  # asked for more pages than the bulk mark (20), so the job must use the residential route from the start.
  bash "$REPO/scripts/m5/pi-selection.sh" fixture fcpi-fixture-model fcpi-fixture-parser fcpi-fixture-proxy none >/dev/null
  "${C[@]}" stop fixture-m6 >/dev/null 2>&1
  since=$(date -u +%Y-%m-%dT%H:%M:%SZ)
  call POST /v2/crawl "{\"url\":\"$M3/\",\"limit\":25}"; j=$(jq -r '.id // empty' <<<"$GW_BODY"); out bulk_submit "$(jq -c --arg j "$j" '. + {job:$j}' <<<"$CALL")"
  if [ -n "$j" ]; then
    out bulk_job "$(jq -cn --argjson x "$(wait_job "$j" 600)" '{job:$x}')"
    OPS_TOKEN=$SOAK GW_TIMEOUT=30 gw GET "/v2/crawl/$j/errors"; out bulk_errors "$(jq -c '{classes: ([.errors[]?.error | capture("Retrieval failed: (?<c>[A-Z_]+)")? | .c] | unique), count: (.errors | length)}' <<<"$GW_BODY" 2>/dev/null || echo '{}')"
  fi
  direct=$(pg "SELECT count(*) FROM fcpi_retrieval.attempt WHERE domain = 'm3.fixture.fcpi.test' AND strategy LIKE 'direct%' AND started_at >= '$since'")
  resid=$(pg "SELECT count(*) FROM fcpi_retrieval.attempt WHERE domain = 'm3.fixture.fcpi.test' AND strategy LIKE 'residential%' AND started_at >= '$since'")
  static; out low_risk_during "$(jq -c --arg d "$direct" --arg r "$resid" '. + {bulk_direct_attempts:$d, bulk_residential_attempts:$r}' <<<"$CALL")"
  "${C[@]}" start fixture-m6 >/dev/null 2>&1
  bash "$REPO/scripts/m5/pi-selection.sh" fixture fcpi-fixture-model fcpi-fixture-parser none none >/dev/null
  s=$(until_ 300 ready); out recovered "$(jq -cn --argjson s "$s" --argjson b "$(brief)" '{ready_after_s:$s, status:$b}')" ;;

providers_down)
  bash "$REPO/scripts/m5/pi-selection.sh" fixture fcpi-fixture-model fcpi-fixture-parser none fcpi-fixture-zyte >/dev/null 2>&1 || bash "$REPO/scripts/m5/pi-selection.sh" fixture fcpi-fixture-model fcpi-fixture-parser none none >/dev/null
  "${C[@]}" stop fixture-m5 fixture-m7 >/dev/null 2>&1
  call POST /v2/scrape "{\"url\":\"$M1/static.html\",\"formats\":[{\"type\":\"json\",\"schema\":{\"type\":\"object\",\"properties\":{\"title\":{\"type\":\"string\"}}}}]}"; out extract_during "$CALL"
  call POST /v2/scrape '{"url":"http://m5.fixture.fcpi.test:8080/docs/scan.pdf","formats":["markdown"]}'; out parse_during "$CALL"
  static; out scrape_during "$CALL"
  crawl; out crawl_during "$(jq -cn --argjson j "$(wait_job "$JOB" 600)" '{job:$j}')"
  "${C[@]}" start fixture-m5 fixture-m7 >/dev/null 2>&1
  bash "$REPO/scripts/m5/pi-selection.sh" fixture fcpi-fixture-model fcpi-fixture-parser none none >/dev/null
  s=$(until_ 300 ready)
  call POST /v2/scrape "{\"url\":\"$M1/static.html\",\"formats\":[{\"type\":\"json\",\"schema\":{\"type\":\"object\",\"properties\":{\"title\":{\"type\":\"string\"}}}}]}"
  out extract_after "$(jq -c --argjson s "$s" '. + {ready_after_s:$s}' <<<"$CALL")" ;;

egress_down)
  r=$(svc retrieval-service); r0=$(restarts retrieval-service) s0=$(started retrieval-service)
  docker network disconnect fcpi_egress "$r"
  call POST /v2/scrape '{"url":"http://example.com/","formats":["markdown"]}'; out public_during "$CALL"
  static; out fixture_during "$CALL"
  CT=20 call GET /platform/v1/status; out status_route_during "$CALL"
  route=$(pg "SELECT coalesce(preferred, 'none') || '|' || challenges || '|' || coalesce(last_failure_class, 'none') FROM fcpi_retrieval.domain_route WHERE domain = 'example.com'" || true)
  docker network connect fcpi_egress "$r"
  sleep 5
  ok=$(docker exec "$r" node -e "require('dns').promises.setServers(['10.231.6.1']);new (require('dns').promises.Resolver)().resolve4('example.com').then(a=>console.log(a.length>0),()=>console.log(false))" 2>/dev/null || echo false)
  out recovered "$(jq -cn --arg route "${route:-none}" --arg dns "$ok" --argjson r "$(restarts retrieval-service)" --argjson r0 "$r0" --arg st "$(started retrieval-service)" --arg s0 "$s0" --argjson b "$(brief)" \
    '{domain_route_example:$route, dns_after:$dns, restarts_delta:($r - $r0), restarted:($st != $s0), status:$b}')"
  static; out fixture_after "$CALL" ;;

disk_pressure)
  . /etc/firecrawl-pi/config.env; F=$PI_DATA_DIR/.fcpi-fill-test
  docs0=$(pg "SELECT count(*) FROM fcpi_platform.job_document"); files0=$(find "$PI_DATA_DIR/artifacts/results" -type f | wc -l)
  free=$(df -B1 --output=avail "$PI_DATA_DIR" | tail -1); fill=$(( free - 1536 * 1048576 ))
  [ "$fill" -gt 0 ] && [ "$fill" -lt $((50 * 1073741824)) ] || { out refused "{\"free\":$free}"; exit 1; }
  trap 'rm -f "$F"' EXIT
  n0=$(notices disk_critical)
  fallocate -l "$fill" "$F"; tick; sleep 3
  static; out scrape_during "$CALL"
  CT=20 call GET /platform/v1/jobs; out read_during "$CALL"
  tick
  out state_during "$(jq -cn --argjson b "$(brief)" --arg f "$(df -B1 --output=avail "$PI_DATA_DIR" | tail -1)" --argjson n "$(( $(notices disk_critical) - n0 ))" '{status:$b, free:($f|tonumber), opened_notices:$n}')"
  rm -f "$F"; trap - EXIT
  tick; tick; tick; sleep 3
  pgok=$(docker exec "$(svc nuq-postgres)" pg_isready -U postgres -q && echo true || echo false)
  static
  out recovered "$(jq -cn --argjson c "$CALL" --argjson b "$(brief)" --arg d "$(pg "SELECT count(*) FROM fcpi_platform.job_document")" --arg d0 "$docs0" \
    --arg f "$(find "$PI_DATA_DIR/artifacts/results" -type f | wc -l)" --arg f0 "$files0" --argjson pg "$pgok" --argjson n "$(( $(notices disk_critical) - n0 ))" \
    '{scrape:$c, status:$b, postgres_ready:$pg, documents_before:($d0|tonumber), documents_after:($d|tonumber), files_before:($f0|tonumber), files_after:($f|tonumber), disk_critical_notices:$n}')" ;;

memory_pressure)
  a=$(awk '/^MemAvailable:/ {print int($2 / 1024)}' /proc/meminfo); h=$(( a - 800 ))
  [ "$h" -gt 512 ] && [ "$h" -lt 7000 ] || { out refused "{\"available_mib\":$a}"; exit 1; }
  o0=$(oom_sum); n0=$(notices memory_low)
  trap 'docker rm -f fcpi-m8-hog >/dev/null 2>&1' EXIT
  docker run -d --rm --name fcpi-m8-hog --label fcpi.transient=m8-memory --network none --read-only --cap-drop ALL --security-opt no-new-privileges:true \
    --memory "$((h + 96))m" --memory-swap "$((h + 96))m" --oom-score-adj 1000 --cpus 0.5 --user 65534:65534 "$IMG_NODE" \
    node -e "const k=[];for(let i=0;i<$h/64;i++)k.push(Buffer.alloc(64<<20,1));setInterval(()=>k.length,1e4)" >/dev/null
  s=$(until_ 180 '[ "$(awk "/^MemAvailable:/ {print int(\$2 / 1024)}" /proc/meminfo)" -lt 1024 ]')
  tick; sleep 3; static; out scrape_during "$(jq -c --argjson s "$s" '. + {low_after_s:$s}' <<<"$CALL")"
  sleep 61; tick
  out state_during "$(jq -cn --argjson b "$(brief)" --arg a "$(awk '/^MemAvailable:/ {print int($2 / 1024)}' /proc/meminfo)" --argjson n "$(( $(notices memory_low) - n0 ))" '{status:$b, available_mib:($a|tonumber), opened_notices:$n}')"
  docker rm -f fcpi-m8-hog >/dev/null 2>&1; trap - EXIT
  sleep 5; tick; sleep 5; tick; sleep 5; tick; sleep 3
  static
  out recovered "$(jq -cn --argjson c "$CALL" --argjson b "$(brief)" --argjson o "$(( $(oom_sum) - o0 ))" --argjson n "$(( $(notices memory_low) - n0 ))" '{scrape:$c, status:$b, fcpi_oom_kills:$o, memory_low_notices:$n}')" ;;

thermal_pressure)
  mkdir -p "$RUND/inject"; trap 'rm -f "$RUND/inject/temp_c"' EXIT
  n0=$(notices temperature_high)
  echo 76.0 >"$RUND/inject/temp_c"; tick; sleep 3
  call POST /v2/scrape "{\"url\":\"$M2/js.html?f=m8-thermal-$RANDOM\",\"formats\":[\"markdown\"]}"; out js_during "$CALL"
  static; out static_during "$CALL"
  out state_during "$(jq -cn --argjson b "$(brief)" '{status:$b}')"
  echo 69.0 >"$RUND/inject/temp_c"; tick; tick; tick; sleep 3
  call POST /v2/scrape "{\"url\":\"$M2/js.html?f=m8-thermal-$RANDOM\",\"formats\":[\"markdown\"]}"
  out js_after "$(jq -c --argjson s "$(has fcpi-m2-js-5c1e && echo true || echo false)" --argjson b "$(brief)" --argjson n "$(( $(notices temperature_high) - n0 ))" '. + {sentinel:$s, host:$b, temperature_notices:$n}' <<<"$CALL")"
  rm -f "$RUND/inject/temp_c"; trap - EXIT; tick ;;

missing_mount)
  . /etc/firecrawl-pi/config.env
  id0=$(sha256sum "$PI_DATA_DIR/.fcpi-data-id" | cut -c1-64)
  restore() { mountpoint -q "$PI_DATA_DIR" && [ "$(findmnt -no FSTYPE "$PI_DATA_DIR")" = tmpfs ] && umount "$PI_DATA_DIR"; systemctl reset-failed docker.service fcpi-stack.service 2>/dev/null
    systemctl start docker.socket docker.service; systemctl start fcpi-stack.service; }
  trap restore EXIT
  systemctl stop fcpi-stack.service; systemctl stop docker.socket docker.service
  mount -t tmpfs -o size=1m,mode=0755 fcpi-missing-test "$PI_DATA_DIR"
  t0=$(now_s); systemctl start docker.service; drc=$?
  sleep 20
  ds=$(systemctl show docker.service -p ActiveState -p Result -p NRestarts | paste -sd' ' -)
  systemctl start fcpi-stack.service; src=$?
  shadow=$(find "$PI_DATA_DIR" -mindepth 1 | wc -l); running=$(pgrep -c -x dockerd || true)
  jl=$(journalctl --no-pager -o cat --since "@$t0" -t fcpi-data-check.sh 2>/dev/null | grep -c 'FAIL' || true)
  out refused "$(jq -cn --argjson d "$drc" --arg ds "$ds" --argjson s "$src" --argjson sh "$shadow" --argjson r "${running:-0}" --argjson jl "$jl" '{docker_start_exit:$d, docker:$ds, stack_start_exit:$s, shadow_entries:$sh, dockerd_processes:$r, data_check_failures_logged:$jl}')"
  umount "$PI_DATA_DIR"; trap - EXIT
  t1=$(now_s); systemctl reset-failed docker.service fcpi-stack.service; systemctl start docker.socket docker.service; systemctl start fcpi-stack.service
  s=$(until_ 600 ready)
  out recovered "$(jq -cn --argjson s "$s" --argjson t "$(( $(now_s) - t1 ))" --arg id "$(sha256sum "$PI_DATA_DIR/.fcpi-data-id" | cut -c1-64)" --arg id0 "$id0" --argjson b "$(brief)" --argjson sw "$(swap_all)" \
    '{ready_after_s:$s, stack_start_to_ready_s:$t, data_id_unchanged:($id == $id0), status:$b, swap:$sw}')" ;;

supervisor)
  m=$(svc mcp-gateway); n0=$(notices restart_budget_or_data_service_mcp-gateway); sup=$STATE/supervisor/restarts.jsonl
  c0=$(jq -c 'select(.service == "mcp-gateway")' "$sup" 2>/dev/null | wc -l)
  for round in 1 2 3 4; do
    kill -STOP "$(pid_of mcp-gateway)"; t0=$(now_s)
    # Docker marks it unhealthy after three failed checks 30 s apart; the tick (every minute) restarts it within budget.
    s=$(until_ 420 "[ \$(jq -c 'select(.service == \"mcp-gateway\")' $sup 2>/dev/null | wc -l) -gt $((c0 + round - 1)) ] || [ \$(notices restart_budget_or_data_service_mcp-gateway) -gt $n0 ]")
    static
    out "round_$round" "$(jq -cn --argjson s "$s" --argjson r "$(jq -c 'select(.service == "mcp-gateway")' "$sup" | wc -l)" --argjson c0 "$c0" --argjson rest "$CALL" --argjson n "$(( $(notices restart_budget_or_data_service_mcp-gateway) - n0 ))" \
      '{acted_after_s:$s, supervisor_restarts:($r - $c0), rest:$rest, budget_notices:$n}')"
    [ $(( $(notices restart_budget_or_data_service_mcp-gateway) - n0 )) -gt 0 ] && break
    until_ 120 '[ "$(docker inspect -f "{{.State.Health.Status}}" '"$m"')" = healthy ]' >/dev/null
  done
  docker restart "$m" >/dev/null; s=$(until_ 180 ready)
  tick; tick
  out recovered "$(jq -cn --argjson s "$s" --argjson b "$(brief)" '{ready_after_s:$s, status:$b}')" ;;

swap_reload)
  # Scopes found at max are F2's lift on the running stack (its trigger is not pinned: a plain reload, a unit added,
  # started, enabled or disabled did not lift a new scope in M8's probes); a container recreated now shows a new scope.
  docker compose -p fcpi -f "$REPO/deploy/compose.yaml" up -d --force-recreate --wait fixture >/dev/null 2>&1
  fx=$(cid fixture); read -r fp fid < <(docker inspect -f '{{.HostConfig.CgroupParent}} {{.Id}}' "$fx")
  fx0=$(cat "/sys/fs/cgroup/$fp/docker-$fid.scope/memory.swap.max"); sw0=$(swap_all)
  before=$(for c in $(docker ps -q --filter label=com.docker.compose.project=fcpi); do read -r p id < <(docker inspect -f '{{.HostConfig.CgroupParent}} {{.Id}}' "$c")
    echo "$(cat /sys/fs/cgroup/$p/docker-$id.scope/memory.swap.max) $(cat /sys/fs/cgroup/$p/docker-$id.scope/memory.max)"; done | sort | uniq -c | tr -s ' ' | tr '\n' ';')
  systemctl daemon-reload; sleep 2
  after=$(for c in $(docker ps -q --filter label=com.docker.compose.project=fcpi); do read -r p id < <(docker inspect -f '{{.HostConfig.CgroupParent}} {{.Id}}' "$c")
    echo "$(cat /sys/fs/cgroup/$p/docker-$id.scope/memory.swap.max) $(cat /sys/fs/cgroup/$p/docker-$id.scope/memory.max)"; done | sort | uniq -c | tr -s ' ' | tr '\n' ';')
  out reload "$(jq -cn --arg b "$before" --arg a "$after" --arg sl "$(cat /sys/fs/cgroup/fcpi.slice/memory.swap.max)" --arg prop "$(systemctl show -p MemorySwapMax --value fcpi.slice)" --argjson sw "$(swap_all)" \
    --argjson sw0 "$sw0" --arg fx0 "$fx0" --arg fx1 "$(cat "/sys/fs/cgroup/$fp/docker-$fid.scope/memory.swap.max")" \
    '{scope_swap_and_memory_max_before:$b, after:$a, recreated_scope_before:$fx0, recreated_scope_after:$fx1, slice_swap_max:$sl, slice_property:$prop, effective_before:$sw0, effective:$sw}')" ;;

foreign_container)
  n0=$(notices foreign_container)
  trap 'docker rm -f fcpi-m8-foreign-probe >/dev/null 2>&1' EXIT
  docker run -d --name fcpi-m8-foreign-probe --label fcpi.m8-probe=foreign --network none --read-only --cap-drop ALL --user 65534:65534 --memory 32m "$IMG_NODE" node -e "setInterval(()=>{},1e4)" >/dev/null
  tick
  out detected "$(jq -cn --arg f "$(bash "$REPO/scripts/fcpi" foreign)" --argjson b "$(bash "$REPO/scripts/ops/status.sh" --json | jq -c .foreign_containers)" --argjson n "$(( $(notices foreign_container) - n0 ))" '{fcpi_foreign:$f, status_foreign:$b, opened_notices:$n}')"
  docker rm -f fcpi-m8-foreign-probe >/dev/null 2>&1; trap - EXIT
  tick; tick
  out cleared "$(jq -cn --arg f "$(bash "$REPO/scripts/fcpi" foreign)" --argjson b "$(bash "$REPO/scripts/ops/status.sh" --json | jq -c .foreign_containers)" --argjson n "$(notices foreign_container)" --argjson n0 "$n0" '{fcpi_foreign:$f, status_foreign:$b, notices_since:($n - $n0)}')" ;;

log_bounds)
  for c in $(docker ps -aq --filter label=com.docker.compose.project=fcpi); do
    read -r name lp mx mf < <(docker inspect -f '{{index .Config.Labels "com.docker.compose.service"}} {{.LogPath}} {{index .HostConfig.LogConfig.Config "max-size"}} {{index .HostConfig.LogConfig.Config "max-file"}}' "$c")
    out container_log "$(jq -cn --arg n "$name" --arg mx "$mx" --arg mf "$mf" --argjson files "$(ls "$lp"* 2>/dev/null | wc -l)" --argjson big "$(stat -c %s "$lp"* 2>/dev/null | sort -n | tail -1)" --argjson total "$(stat -c %s "$lp"* 2>/dev/null | awk '{s+=$1} END {print s+0}')" \
      '{service:$n, max_size:$mx, max_file:$mf, files:$files, largest:$big, total:$total}')"
  done
  out ops_logs "$(jq -cn --arg d "$(du -sb "$LOGD" | cut -f1)" --arg s "$(du -sb "$STATE" | cut -f1)" --arg j "$(journalctl --disk-usage 2>/dev/null | grep -o '[0-9.]*[KMG]' | head -1)" '{var_log_firecrawl_pi_bytes:($d|tonumber), var_lib_firecrawl_pi_bytes:($s|tonumber), journal:$j}')" ;;

doctor)
  o=$(bash "$REPO/scripts/fcpi" doctor 2>&1); rc=$?
  f=$(awk '{print $1}' <<<"$o" | tail -1)
  out bundle "$(jq -cn --argjson rc $rc --arg o "$o" --argjson size "$(stat -c %s "$f" 2>/dev/null || echo 0)" --argjson files "$(tar -tzf "$f" 2>/dev/null | wc -l)" '{exit:$rc, output:$o, size:$size, files:$files}')"
  o=$(bash "$REPO/scripts/fcpi" doctor --self-test 2>&1); rc=$?
  out self_test "$(jq -cn --argjson rc $rc --arg o "$o" '{exit:$rc, output:$o}')" ;;

*) echo "unknown case $CASE" >&2; exit 2 ;;
esac
echo "### end"
