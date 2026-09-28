#!/usr/bin/env bash
# The host tick (FIRECRAWL_PI_SPEC.md §24.1, §25), run by fcpi-tick.timer every 60 s as root, ON the Pi:
#   1. one host sample, appended to /var/log/firecrawl-pi/samples/<UTC day>.jsonl: memory, swap, temperature, the
#      throttle flags, the data filesystem's free space and inodes, the card's cumulative writes, and per container its
#      state, health, restarts, cgroup memory (current, peak, swap, the effective swap limit), OOM kills and card writes;
#      the NuQ queue (queued, oldest queued age, active) and the ledger's open jobs; containers outside project fcpi; the
#      admission state the services were reading;
#   2. the admission pressure (spec §23.1): dispatch pauses below 1 GiB available memory or at the critical disk mark
#      (the smaller of 10 % or 2 GiB free), browser work pauses at 75 °C; each resumes after two recovered samples
#      (memory at 1.25 GiB, temperature under 70 °C, disk off the critical mark);
#   3. the supervisor: a safe-to-restart service Docker marks unhealthy (three failed checks 30 s apart) is restarted,
#      at most three times in 15 minutes; after that, or for a data service, an incident opens instead;
#   4. incidents, each noticed once when it opens and once when it clears (scripts/ops/lib.sh notice);
#   5. retention: samples and probes 14 days, the daily aggregate 90 days.
# A test may place a reading in /run/firecrawl-pi/inject/temp_c (tmpfs, gone at reboot): the sample then records
# injected_temp=true, so evidence never passes an injected reading off as the sensor's.
set -uo pipefail
. "$(dirname "$(readlink -f "$0")")/lib.sh"
need_root
exec 9>"$RUND/tick.lock"; flock -n 9 || exit 0
mkdir -p "$STATE"/{alerts,supervisor} "$LOGD"/samples; chmod 0700 "$STATE/alerts"
NOW=$(now_s) T=$(utc) DAY=${T%%T*}
# shellcheck disable=SC1091
. /etc/firecrawl-pi/config.env 2>/dev/null
DATA=${PI_DATA_DIR:-/srv/firecrawl-pi/data}

# ---- 1. the sample ---------------------------------------------------------------------------------------------------
mi() { awk -v k="$1:" '$1 == k {print int($2 / 1024)}' /proc/meminfo; }
avail=$(mi MemAvailable) total=$(mi MemTotal) swap_total=$(mi SwapTotal) swap_free=$(mi SwapFree)
temp_c=$(awk '{printf "%.1f", $1 / 1000}' /sys/class/thermal/thermal_zone0/temp 2>/dev/null || echo null)
injected_temp=false
if [ -r "$RUND/inject/temp_c" ]; then temp_c=$(cat "$RUND/inject/temp_c"); injected_temp=true; fi
throttled=$(vcgencmd get_throttled 2>/dev/null | cut -d= -f2); throttled=${throttled:-unknown}
read -r d_size d_avail d_itotal d_iavail < <(df -B1 --output=size,avail,itotal,iavail "$DATA" 2>/dev/null | tail -1)
card_dev=$(lsblk -no PKNAME "$(findmnt -no SOURCE --target "$DATA")" 2>/dev/null | head -1); card_dev=${card_dev:-mmcblk0}
card_mm=$(cat "/sys/block/$card_dev/dev" 2>/dev/null)
card_wsect=$(awk -v d="$card_dev" '$3 == d {print $10}' /proc/diskstats)
host_oom=$(awk '$1 == "oom_kill" {print $2}' /proc/vmstat)
# The slice's own count covers every container under it: a container's scope count restarts at 0 when its restart
# policy recreates the scope, and Docker clears State.OOMKilled at the restart, so neither sees a main process killed.
slice_oom=$(awk '$1 == "oom_kill" {print $2}' /sys/fs/cgroup/fcpi.slice/memory.events 2>/dev/null)

# A container removed between the listing and the inspection makes docker inspect print the rest and fail: whatever it
# printed is merged into one list, so the list is always one JSON array.
insp=$(docker ps -aq | xargs -r docker inspect 2>/dev/null | jq -sc 'add // []' 2>/dev/null); [ -n "$insp" ] || insp='[]'
containers=$(jq -c '[.[] | {id: .Id, name: (.Name | ltrimstr("/")), project: (.Config.Labels["com.docker.compose.project"] // null),
  service: (.Config.Labels["com.docker.compose.service"] // null), transient: (.Config.Labels["fcpi.transient"] != null),
  state: .State.Status, health: (.State.Health.Status // "none"), restarts: .RestartCount, oom_killed: .State.OOMKilled, started: .State.StartedAt,
  mem_limit: .HostConfig.Memory, memswap_limit: .HostConfig.MemorySwap, parent: (.HostConfig.CgroupParent | if . == "" then "system.slice" else . end),
  health_out: ((.State.Health.Log // []) | last | .Output // "" | gsub("\\s+$"; "") | .[0:120]),
  health_at: ((.State.Health.Log // []) | last | .End // null)}]' <<<"$insp")
rows=()
while IFS=$'\t' read -r id parent; do
  p=/sys/fs/cgroup/$parent/docker-$id.scope
  if [ -d "$p" ]; then
    # A read that fails (the container stopping mid-sample) is null, never an empty field that breaks the JSON.
    cur=$(cat "$p/memory.current" 2>/dev/null) peak=$(cat "$p/memory.peak" 2>/dev/null) swc=$(cat "$p/memory.swap.current" 2>/dev/null)
    swm=$(cat "$p/memory.swap.max" 2>/dev/null) pswm=$(cat "/sys/fs/cgroup/$parent/memory.swap.max" 2>/dev/null || echo max)
    oom=$(awk '$1 == "oom_kill" {print $2}' "$p/memory.events" 2>/dev/null)
    wb=$(awk -v d="$card_mm" '$1 == d {for (i = 2; i <= NF; i++) if ($i ~ /^wbytes=/) {sub("wbytes=", "", $i); print $i}}' "$p/io.stat" 2>/dev/null)
    rows+=("$(printf '{"id":"%s","mem_current":%s,"mem_peak":%s,"swap_current":%s,"swap_max":"%s","parent_swap_max":"%s","oom_kill":%s,"card_wbytes":%s}' \
      "$id" "${cur:-null}" "${peak:-null}" "${swc:-null}" "$swm" "$pswm" "${oom:-0}" "${wb:-0}")")
  fi
done < <(jq -r '.[] | select(.state == "running") | [.id, .parent] | @tsv' <<<"$containers")
cg=$(printf '%s\n' "${rows[@]}" | jq -Rsc 'split("\n") | map(fromjson? // empty) | map({key: .id, value: .}) | from_entries')   # a malformed row drops alone
containers=$(jq -c --argjson cg "$cg" 'map(. + ($cg[.id] // {}) | .swap_limited = ((.swap_max == "0") or (.parent_swap_max == "0")) | .id = .id[0:12])' <<<"$containers")
foreign=$(jq -c '[.[] | select(.project != "fcpi" and (.transient | not)) | .name]' <<<"$containers")

q=$(pg "SELECT (SELECT count(*) FROM nuq.queue_scrape WHERE status = 'queued'),
  coalesce((SELECT extract(epoch FROM now() - min(created_at))::int FROM nuq.queue_scrape WHERE status = 'queued'), 0),
  (SELECT count(*) FROM nuq.queue_scrape WHERE status = 'active'),
  (SELECT count(*) FROM fcpi_platform.job WHERE state IN ('RECEIVED','SUBMITTING','SUBMISSION_UNCERTAIN','QUEUED','RUNNING'))")
if [[ $q =~ ^[0-9]+\|[0-9]+\|[0-9]+\|[0-9]+$ ]]; then
  IFS='|' read -r q_queued q_oldest q_active q_open <<<"$q"
  queue=$(printf '{"ok":true,"queued":%s,"oldest_queued_s":%s,"active":%s,"open_jobs":%s}' "$q_queued" "$q_oldest" "$q_active" "$q_open")
else queue='{"ok":false}'; fi

sample=$(jq -cn --arg utc "$T" --arg boot "$(boot_hash)" --arg commit "$(source_commit)" --argjson avail "${avail:-0}" --argjson total "${total:-0}" \
  --argjson swt "${swap_total:-0}" --argjson swf "${swap_free:-0}" --argjson temp "${temp_c:-null}" --argjson inj "$injected_temp" --arg thr "$throttled" \
  --argjson dsize "${d_size:-0}" --argjson davail "${d_avail:-0}" --argjson ditot "${d_itotal:-0}" --argjson diav "${d_iavail:-0}" \
  --arg card "$card_dev" --argjson cws "${card_wsect:-0}" --argjson hoom "${host_oom:-0}" \
  --argjson c "$containers" --argjson f "$foreign" --argjson q "$queue" --argjson adm "$(jq -c "{dispatch, browser, reasons}" "$ADMISSION" 2>/dev/null || echo null)" \
  '{utc:$utc, boot:$boot, commit:$commit, mem:{total_mib:$total, available_mib:$avail, swap_used_mib:($swt - $swf)},
    temp_c:$temp, injected_temp:$inj, throttled:$thr, host_oom_kill:$hoom,
    disk:{size:$dsize, free:$davail, free_pct:(if $dsize > 0 then ($davail * 1000 / $dsize | floor) / 10 else null end),
      inodes_free_pct:(if $ditot > 0 then ($diav * 1000 / $ditot | floor) / 10 else null end)},
    card:{dev:$card, written_sectors:$cws}, containers:$c, foreign:$f, queue:$q, admission:$adm}')
# What is kept is the project's containers with the fields the checks, fcpi status and the daily aggregate read (about 3 KiB a
# minute); the incidents below are judged on the full record.
compact=$(jq -c '.containers |= map(select(.project == "fcpi") | {id, project, service, state, health, restarts, mem_limit, mem_current, mem_peak, swap_limited, oom_kill, card_wbytes}
  + (if .service == "firecrawl-core" then {check: .health_out} else {} end))' <<<"$sample")
append_line "$LOGD/samples/$DAY.jsonl" "$compact"
printf '%s\n' "$compact" | write_atomic "$RUND/last-sample.json" 0644

# ---- 2. pressure -----------------------------------------------------------------------------------------------------
prev=$(obj "$RUND/pressure.json")
disk_crit=$(jq -n --argjson s "${d_size:-0}" --argjson a "${d_avail:-0}" '$a < 2 * 1073741824 or ($s > 0 and $a * 10 < $s)')
disk_low=$(jq -n --argjson s "${d_size:-0}" --argjson a "${d_avail:-0}" '$a < 5 * 1073741824 or ($s > 0 and $a * 100 < $s * 15)')
pressure=$(jq -c --argjson avail "${avail:-0}" --argjson temp "${temp_c:-0}" --argjson dc "$disk_crit" \
  --argjson mp "$MEM_PAUSE_MIB" --argjson mr "$MEM_RESUME_MIB" --argjson tp "$TEMP_PAUSE_C" --argjson tr "$TEMP_RESUME_C" '
  def step(bad; good; key): (.[key] // {on: false, good: 0}) as $s
    | if bad then {on: true, good: 0} elif $s.on and good then (if $s.good + 1 >= 2 then {on: false, good: 0} else {on: true, good: ($s.good + 1)} end)
      elif $s.on then {on: true, good: 0} else {on: false, good: 0} end;
  {memory: step($avail < $mp; $avail >= $mr; "memory"), thermal: step($temp >= $tp; $temp < $tr; "thermal"), disk: step($dc; ($dc | not); "disk")}
  | .dispatch_reasons = ([if .memory.on then "memory" else empty end, if .disk.on then "disk" else empty end])
  | .browser_reasons = ([if .thermal.on then "thermal" else empty end])' <<<"$prev")
put_obj "$RUND/pressure.json" 0644 "$pressure"
admission_write

# ---- 3. the supervisor -----------------------------------------------------------------------------------------------
SUP=$STATE/supervisor/restarts.jsonl
[ -e "$SUP" ] || install -m 0640 /dev/null "$SUP"
exhausted=()
while IFS=$'\t' read -r svc name; do
  recent=$(jq -r --arg s "$svc" --argjson t $((NOW - 900)) 'select(.service == $s and .epoch >= $t) | .epoch' "$SUP" 2>/dev/null | wc -l)
  if [[ " $SAFE_SERVICES " != *" $svc "* ]] || [ "$recent" -ge 3 ]; then exhausted+=("$svc"); continue; fi
  logger -t fcpi-supervisor -- "restarting $svc (unhealthy; $recent restarts in the last 15 minutes)"
  # Recorded before the restart, so a tick killed during it still counts it against the budget.
  append_line "$SUP" "$(jq -cn --arg u "$T" --argjson e "$NOW" --arg s "$svc" '{utc:$u,epoch:$e,service:$s}')"
  timeout 120 docker restart "$name" >/dev/null 2>&1; rc=$?
  logger -t fcpi-supervisor -- "restart of $svc exited $rc"
done < <(jq -r '.[] | select(.project == "fcpi" and .state == "running" and .health == "unhealthy") | [.service, .name] | @tsv' <<<"$containers")
# The restart log keeps a day.
jq -c --argjson t $((NOW - 86400)) 'select(.epoch >= $t)' "$SUP" 2>/dev/null | write_atomic "$SUP" 0640

# ---- 4. incidents ----------------------------------------------------------------------------------------------------
last_backup=$(obj "$STATE/backup/last.json")
last_attempt=$(obj "$STATE/backup/last-attempt.json")
last_check=$(obj "$STATE/backup/last-check.json")
last_restore=$(obj "$STATE/backup/last-restore-test.json")
last_probe=$(obj "$STATE/probe-last.json")
prev_oom=$(obj "$STATE/alerts/oom.json")
# This minute's counts, written only once the incidents are judged, so a minute that could not judge them keeps the
# earlier counts and the next one still sees the increase.
oom_now=$(jq -c --argjson so "${slice_oom:-null}" '{slice: $so, containers: (map({key: .name, value: (.oom_kill // 0)}) | from_entries),
  restarts: (map({key: .name, value: .restarts}) | from_entries)}' <<<"$containers")
exh=$(printf '%s\n' "${exhausted[@]}" | jq -R . | jq -sc 'map(select(. != ""))')
active=$(jq -c --argjson now "$NOW" --argjson mp "$MEM_PAUSE_MIB" --argjson dl "$disk_low" --argjson dc "$disk_crit" --argjson p "$pressure" --argjson lb "$last_backup" --argjson la "$last_attempt" --argjson lc "$last_check" \
  --argjson lr "$last_restore" --argjson po "$prev_oom" --argjson so "${slice_oom:-null}" --argjson exh "$exh" --arg throttled "$throttled" --argjson pr "$last_probe" '
  . as $s | [
    (.containers[] | select(.project == "fcpi" and .service == "firecrawl-core" and .health != "healthy") | {key: "core_unhealthy", detail: {health: .health, state: .state}}),
    (if .queue.ok and .queue.oldest_queued_s > 300 then {key: "queue_stalled", detail: {oldest_queued_s: .queue.oldest_queued_s, queued: .queue.queued}} else empty end),
    (if .queue.ok | not then {key: "queue_unreadable", detail: {}} else empty end),
    (if .mem.available_mib < $mp then {key: "memory_low", detail: {available_mib: .mem.available_mib}} else empty end),
    (if $p.thermal.on then {key: "temperature_high", detail: {temp_c: .temp_c, injected: .injected_temp}} else empty end),
    # Any flag of vcgencmd get_throttled, now or since boot (undervoltage, capping, throttling, soft temperature limit).
    (if ($throttled | test("^0x0*[1-9a-fA-F]")) then {key: "throttle_flag", detail: {throttled: $throttled}} else empty end),
    (if $dc then {key: "disk_critical", detail: {free: .disk.free, free_pct: .disk.free_pct}} elif $dl then {key: "disk_low", detail: {free: .disk.free, free_pct: .disk.free_pct}} else empty end),
    (.containers[] | select(.project == "fcpi" and .state == "running" and (.swap_limited | not)) | {key: "swap_limit_lost:\(.service)", detail: {swap_max: .swap_max, parent_swap_max: .parent_swap_max}}),
    (($po.containers // {}) as $pc | .containers[] | select(.project == "fcpi" and ((.oom_kill // 0) > ($pc[.name] // (.oom_kill // 0)))) | {key: "oom_kill:\(.service)", detail: {oom_kill: .oom_kill}}),
    # Any kill under fcpi.slice, the main process of a container included; the services that restarted or show
    # OOMKilled this minute name the likely one.
    (($po.restarts // {}) as $pr0 | if $so != null and ($po.slice // null) != null and $so > $po.slice then {key: "oom_kill:fcpi.slice",
      detail: {oom_kill: $so, since: $po.slice, restarted: [.containers[] | select(.project == "fcpi" and (.restarts > ($pr0[.name] // .restarts) or .oom_killed == true)) | .service]}} else empty end),
    (if (.foreign | length) > 0 then {key: "foreign_container", detail: {names: .foreign}} else empty end),
    # A restore copy still running long after any restore test or rehearsal would end (a run that died before its
    # teardown): the foreign check leaves it out, being transient, so it shows here.
    ([.containers[] | select(.project == "fcpi-restore" and .state == "running") | .name] as $rc
     | if ($rc | length) > 0 then {key: "restore_copy_running", detail: {containers: $rc}} else empty end),
    ($exh[] | {key: "restart_budget_or_data_service:\(.)", detail: {service: .}}),
    (if ($lb.utc // null) == null then {key: "backup_missing", detail: {reason: ($lb.error // "no backup has completed")}}
     elif ($now - ($lb.utc | fromdateiso8601)) > 93600 then {key: "backup_stale", detail: {last: $lb.utc}} else empty end),
    # The newest backup attempt held the platform quiescent past the five minutes of spec §26: the staging needs redesign.
    (if $la.quiesce_exceeded == true then {key: "backup_quiescence_over_budget", detail: {run: $la.run, quiesce_s: $la.quiesce_s, result: $la.result}} else empty end),
    (if ($lr.result // "") == "FAIL" then {key: "restore_test_failed", detail: {utc: $lr.utc}} else empty end),
    # The monthly restore test and the weekly check, each missed past its period plus a few days (a run that could not
    # take the repository lock leaves its last result in place, so skipped runs show here).
    (if ($lr.utc // null) != null and ($now - ($lr.utc | fromdateiso8601)) > 35 * 86400 then {key: "restore_test_stale", detail: {last: $lr.utc}} else empty end),
    (if ($lc.result // "") == "FAIL" then {key: "backup_check_failed", detail: {utc: $lc.utc, check_exit: $lc.check_exit, prune_exit: $lc.prune_exit}} else empty end),
    (if ($lc.utc // null) != null and ($now - ($lc.utc | fromdateiso8601)) > 9 * 86400 then {key: "backup_check_stale", detail: {last: $lc.utc}} else empty end),
    (if ($pr.consecutive_failures // 0) >= 2 then {key: "functional_probe_failing", detail: {since_failures: $pr.consecutive_failures, scrape: $pr.scrape, mcp: $pr.mcp}} else empty end)
  ]' <<<"$sample")
# Sustained conditions: the core must be unhealthy for two minutes, memory low for over a minute and a restore copy running
# for three hours before they open.
AST=$STATE/alerts/state.json
st=$(obj "$AST")
[ -n "$active" ] && jq -e 'type == "array"' >/dev/null 2>&1 <<<"$active" || { logger -t fcpi-tick -p user.err -- "incidents not judged this minute: the conditions did not compute"; active=null; }
held=false; [ -n "$(holds_live)" ] && held=true
new=$(jq -c --argjson a "$active" --argjson now "$NOW" --argjson held "$held" '
  # While a hold is in force (a backup stopping the services, an operator pausing work), the conditions the hold itself
  # causes are not judged: they neither open nor count towards clearing one that was open before it.
  def byhold: $held and IN("core_unhealthy", "queue_stalled", "queue_unreadable", "functional_probe_failing");
  . as $st | ($a | map(select(.key | byhold | not)) | map({key: .key, value: .detail}) | from_entries) as $act
  | reduce ($act | keys[]) as $k ($st; .[$k] = ((.[$k] // {first: $now, open: false}) | .seen = $now | .clear = 0 | .detail = $act[$k]))
  | reduce (keys[]) as $k (.; if $act[$k] == null and ($k | byhold | not) then .[$k].clear += 1 else . end)' <<<"$st")
hold_for() { case $1 in core_unhealthy) echo 120 ;; memory_low) echo 60 ;; restore_copy_running) echo 10800 ;; *) echo 0 ;; esac; }
for k in $(jq -r 'keys[]' <<<"$new"); do
  e=$(jq -c --arg k "$k" '.[$k]' <<<"$new")
  open=$(jq -r .open <<<"$e") clear=$(jq -r .clear <<<"$e") first=$(jq -r .first <<<"$e")
  if [ "$open" = false ] && [ "$clear" = 0 ] && [ $((NOW - first)) -ge "$(hold_for "${k%%:*}")" ]; then
    notice opened "$k" "$(jq -c .detail <<<"$e")"; new=$(jq -c --arg k "$k" '.[$k].open = true' <<<"$new")
  elif [ "$clear" -ge 2 ]; then
    [ "$open" = true ] && notice cleared "$k" "$(jq -c .detail <<<"$e")"
    new=$(jq -c --arg k "$k" 'del(.[$k])' <<<"$new")
  fi
done
[ "$active" = null ] || { put_obj "$AST" 0600 "$new"; put_obj "$STATE/alerts/oom.json" 0600 "$oom_now"; }
deliver_notices

# ---- 5. retention and the daily aggregate ----------------------------------------------------------------------------
find "$LOGD/samples" "$LOGD/probe" -maxdepth 1 -name '*.jsonl' -mtime +14 -delete 2>/dev/null
find "$STATE/alerts/outbox" -maxdepth 1 -name '*.json' -mtime +90 -delete 2>/dev/null
Y=$(date -u -d yesterday +%Y-%m-%d)
if [ -s "$LOGD/samples/$Y.jsonl" ] && ! grep -q "\"day\":\"$Y\"" "$LOGD/daily.jsonl" 2>/dev/null; then
  agg=$(jq -sc --arg d "$Y" '{day: $d, samples: length, min_available_mib: (map(.mem.available_mib) | min), max_temp_c: (map(.temp_c // 0) | max),
    max_swap_used_mib: (map(.mem.swap_used_mib) | max), min_disk_free: (map(.disk.free) | min),
    card_written_mib: (((map(.card.written_sectors) | max) - (map(.card.written_sectors) | min)) * 512 / 1048576 | floor),
    host_oom_kills: ((map(.host_oom_kill) | max) - (map(.host_oom_kill) | min)),
    peaks: (map(.containers[] | select(.project == "fcpi") | {key: .service, value: (.mem_peak // 0)}) | group_by(.key) | map({key: .[0].key, value: (map(.value) | max)}) | from_entries),
    max_oldest_queued_s: (map(.queue.oldest_queued_s // 0) | max)}' "$LOGD/samples/$Y.jsonl")
  append_line "$LOGD/daily.jsonl" "$agg"
  tail -n 90 "$LOGD/daily.jsonl" | write_atomic "$LOGD/daily.jsonl" 0640
fi
exit 0
