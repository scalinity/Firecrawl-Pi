#!/usr/bin/env bash
# The paced fixture soak's workload (FIRECRAWL_PI_SPEC.md §23.2, M8 "Automated Verification", AC16), ON the Pi, run by
# fcpi-soak.service (scripts/m8/pi-soak.sh installs it for the soak and removes it after). A deterministic schedule by
# minute m since the start, every request through the gateway on its loopback publication as the soak client, only to
# controlled fixtures (no public target, no paid provider: the soak selects the fixture engine, model and parser, no
# proxy and no enhancer):
#   every minute    a static scrape (M1 fixture) and the platform status
#   m % 5 == 1      a script-rendered page (the browser tier)          m % 5 == 2   MCP tools/list and a scrape tool call
#   m % 10 == 3     search (the fixture engine)                         m % 10 == 7  map of the M3 site graph
#   m % 15 == 4     a PDF                                               m % 15 == 9  a json-format extraction (fixture model)
#   m % 30 == 11    a crawl of the M3 graph (12 pages)                  m % 30 == 26 a batch of five M3 pages
#   m % 30 == 17    a viewport screenshot                               m % 60 == 30 a change check
# Jobs are polled each minute until they end. One JSON line per request or job end goes to
# /var/log/firecrawl-pi/soak/<run>.jsonl: its class, status, time, verdict and code. The run ends at its end time and
# resumes after a reboot, picking up at the minute the clock says; a minute that passed while the host was down is
# recorded as missed, never replayed.   (fcpi-soak.service: scripts/m8/soak.sh run)
set -uo pipefail
. /opt/firecrawl-pi/scripts/ops/lib.sh
need_root
CUR=$STATE/soak/current.json
[ -r "$CUR" ] || die "no soak is configured ($CUR)"
RUN=$(jq -r .run "$CUR") START=$(jq -r .start_epoch "$CUR") END=$(jq -r .end_epoch "$CUR")
LOG=$LOGD/soak/$RUN.jsonl; mkdir -p "$LOGD/soak"
export OPS_TOKEN=/etc/firecrawl-pi/secrets/clients/soak.token
M1=http://m1.fixture.fcpi.test:8080 M2=http://m2.fixture.fcpi.test:8080 M3=http://m3.fixture.fcpi.test:8080
rec() { # rec <m> <class> <ok> [code] [detail]
  append_line "$LOG" "$(jq -cn --arg utc "$(utc)" --argjson m "$1" --arg c "$2" --argjson ok "$3" --arg st "$GW_STATUS" --argjson ms "${GW_MS:-0}" \
    --arg code "${4-}" --arg d "${5-}" --arg boot "$(boot_hash | cut -c1-12)" \
    '{utc:$utc,m:$m,class:$c,ok:$ok,status:($st|tonumber),ms:$ms,code:(if $code == "" then null else $code end),detail:(if $d == "" then null else $d end),boot:$boot}')"
}
code_of() { jq -r '.code // empty' <<<"$GW_BODY" 2>/dev/null | head -c 60; }
has() { [ "$GW_STATUS" = 200 ] && grep -q -- "$1" <<<"$GW_BODY"; }
okj() { [ "$GW_STATUS" = 200 ] && jq -e "$1" <<<"$GW_BODY" >/dev/null 2>&1; }
t() { eval "$1" && echo true || echo false; }   # the verdict of one command line, quotes kept
scrape() { GW_TIMEOUT=120 gw POST /v2/scrape "$1"; }
declare -A PENDING=()   # job id -> "kind m epoch_submitted"
poll() {
  local id kind m0 e0 path st
  for id in "${!PENDING[@]}"; do
    read -r kind m0 e0 <<<"${PENDING[$id]}"
    path=/v2/crawl/$id; [ "$kind" = batch ] && path=/v2/batch/scrape/$id
    GW_TIMEOUT=30 gw GET "$path"
    st=$(jq -r '.status // empty' <<<"$GW_BODY" 2>/dev/null)
    if [[ $st =~ ^(completed|failed|cancelled)$ ]]; then
      local want=12; [ "$kind" = batch ] && want=5
      local done; done=$(jq -r '.completed // 0' <<<"$GW_BODY")
      GW_MS=$(( ($(now_s) - e0) * 1000 ))
      rec "$m0" "${kind}_done" "$(t "[ $st = completed ] && [ $done -ge $want ]")" "$st" "completed=$done"
      unset "PENDING[$id]"
    elif [ $(( $(now_s) - e0 )) -gt 1800 ]; then GW_MS=0; rec "$m0" "${kind}_done" false TIMEOUT "no end after 30 minutes"; unset "PENDING[$id]"; fi
  done
}
last=-1
while :; do
  now=$(now_s); [ "$now" -ge "$END" ] && break
  m=$(( (now - START) / 60 ))
  if [ "$m" -le "$last" ]; then sleep $(( 60 - (now - START) % 60 )); continue; fi
  # Minutes that passed with no run (a reboot, a stopped service) are recorded, not replayed.
  if [ "$last" -ge 0 ] && [ $((m - last)) -gt 1 ]; then GW_STATUS=000 GW_MS=0; rec "$((last + 1))" missed false MISSED "$((m - last - 1)) minutes without a run"; fi
  last=$m
  scrape "{\"url\":\"$M1/static.html\",\"formats\":[\"markdown\"]}"; rec "$m" static "$(t 'has fcpi-m1-static-7f3a')" "$(code_of)"
  GW_TIMEOUT=20 gw GET /platform/v1/status; rec "$m" status "$(t 'okj ".core.live == true and .ledger.ok == true"')" "$(code_of)"
  case $((m % 5)) in
    1) scrape "{\"url\":\"$M2/js.html?soak=$m\",\"formats\":[\"markdown\"]}"; rec "$m" js "$(t 'has fcpi-m2-js-5c1e')" "$(code_of)" ;;
    2) GW_TIMEOUT=20 mcp tools/list '{}'; rec "$m" mcp_list "$(t 'okj "(.result.tools | length) > 0"')"
       GW_TIMEOUT=120 mcp tools/call "{\"name\":\"firecrawl_scrape\",\"arguments\":{\"url\":\"$M1/static.html\",\"formats\":[\"markdown\"]}}"
       rec "$m" mcp_scrape "$(t 'has fcpi-m1-static-7f3a')" ;;
  esac
  case $((m % 10)) in
    3) GW_TIMEOUT=120 gw POST /v2/search '{"query":"fcpi soak fixture","limit":3}'; rec "$m" search "$(t 'okj ".success == true and (.data | tostring | length) > 20"')" "$(code_of)" ;;
    7) GW_TIMEOUT=120 gw POST /v2/map "{\"url\":\"$M3/\"}"; rec "$m" map "$(t 'okj "(.links | length) >= 5"')" "$(code_of)" ;;
  esac
  case $((m % 15)) in
    4) scrape "{\"url\":\"$M2/doc.pdf?soak=$m\",\"formats\":[\"markdown\"]}"; rec "$m" pdf "$(t 'has fcpi-m2-pdf-4e7a')" "$(code_of)" ;;
    9) scrape "{\"url\":\"$M1/static.html\",\"formats\":[{\"type\":\"json\",\"schema\":{\"type\":\"object\",\"properties\":{\"title\":{\"type\":\"string\"}}}}]}"
       rec "$m" extract "$(t 'okj ".success == true and .data.json != null"')" "$(code_of)" ;;
  esac
  case $((m % 30)) in
    11) GW_TIMEOUT=60 gw POST /v2/crawl "{\"url\":\"$M3/\",\"limit\":12}"; id=$(jq -r '.id // empty' <<<"$GW_BODY" 2>/dev/null)
        rec "$m" crawl_submit "$(t '[ -n "$id" ]')" "$(code_of)"; [ -n "$id" ] && PENDING[$id]="crawl $m $(now_s)" ;;
    26) GW_TIMEOUT=60 gw POST /v2/batch/scrape "{\"urls\":[\"$M3/p01\",\"$M3/p02\",\"$M3/p03\",\"$M3/p04\",\"$M3/p05\"]}"; id=$(jq -r '.id // empty' <<<"$GW_BODY" 2>/dev/null)
        rec "$m" batch_submit "$(t '[ -n "$id" ]')" "$(code_of)"; [ -n "$id" ] && PENDING[$id]="batch $m $(now_s)" ;;
    17) scrape "{\"url\":\"http://m7shot.fixture.fcpi.test:8080/bands?soak=$m\",\"formats\":[\"screenshot\"]}"; rec "$m" screenshot "$(t 'okj ".data.screenshot != null"')" "$(code_of)" ;;
  esac
  if [ $((m % 60)) = 30 ]; then GW_TIMEOUT=120 gw POST /platform/v1/changes "{\"url\":\"http://m7chg.fixture.fcpi.test:8080/doc?soak=$RUN\"}"
    rec "$m" changes "$(t 'okj ".changeStatus | IN(\"new\",\"same\",\"changed\")"')" "$(code_of)"; fi
  poll
done
append_line "$LOG" "$(jq -cn --arg utc "$(utc)" --arg run "$RUN" '{utc:$utc,class:"end",run:$run}')"
