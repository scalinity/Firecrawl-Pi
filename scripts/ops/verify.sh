#!/usr/bin/env bash
# fcpi verify <suite> (FIRECRAWL_PI_SPEC.md §25), as root ON the Pi. Each suite writes its checks, each PASS or FAIL with
# what it saw, to /var/lib/firecrawl-pi/verify/<suite>-<UTC>.json, prints them, and exits 1 when any fails.
#   ops         the host's invariants: the data check passes, the guard is loaded, dockerd's drop-ins and the project's
#               units, slice, timers and tmpfiles entry are the deployed ones and active, every fcpi container runs
#               under fcpi.slice with swap denied, no container outside the project, the tick, the admission file and
#               the probe are fresh, NetworkManager's project file is in place
#   functional  the functional probe, now
#   services    the service test suites inside the running images (scripts/m8/pi-suites.sh)
set -uo pipefail
. "$(dirname "$(readlink -f "$0")")/lib.sh"
need_root
suite=${1:-}; OUT=$STATE/verify; mkdir -p "$OUT"
R='[]'
chk() { R=$(jq -c --arg id "$1" --arg st "$([ "$2" = 0 ] && echo PASS || echo FAIL)" --arg d "$3" '. + [{id:$id,state:$st,detail:$d}]' <<<"$R"); }
same() { [ -f "$1" ] && [ -f "$2" ] && cmp -s "$1" "$2"; }
age_of() { [ -r "$1" ] && echo $(( $(now_s) - $(jq -r '.utc | fromdateiso8601' "$1" 2>/dev/null || echo 0) )) || echo 999999; }
case $suite in
  ops)
    d=$("$REPO/deploy/host/fcpi-data-check.sh" 2>&1); chk data_check $? "$d"
    nft list table inet fcpi_guard >/dev/null 2>&1; chk guard_loaded $? "table inet fcpi_guard"
    bad=""; for f in "$REPO"/deploy/host/docker.service.d/*.conf; do same "$f" "/etc/systemd/system/docker.service.d/$(basename "$f")" || bad+="$(basename "$f") "; done
    [ -z "$bad" ]; chk docker_dropins $? "differ or absent: ${bad:-none}"
    bad=""; for f in "$REPO"/deploy/host/fcpi-*.service "$REPO"/deploy/host/fcpi-*.timer "$REPO"/deploy/host/fcpi.slice; do same "$f" "/etc/systemd/system/$(basename "$f")" || bad+="$(basename "$f") "; done
    same "$REPO/deploy/host/tmpfiles-fcpi.conf" /etc/tmpfiles.d/fcpi.conf || bad+="tmpfiles "
    [ -z "$bad" ]; chk units_installed $? "differ or absent: ${bad:-none}"
    bad=""; for t in fcpi-tick.timer fcpi-probe.timer fcpi-backup.timer fcpi-backup-check.timer fcpi-restore-test.timer fcpi-heartbeat.timer; do
      [ "$(systemctl is-enabled "$t" 2>/dev/null)" = enabled ] && [ "$(systemctl is-active "$t" 2>/dev/null)" = active ] || bad+="$t "; done
    for u in fcpi-boot-record.service fcpi-stack.service; do [ "$(systemctl is-enabled "$u" 2>/dev/null)" = enabled ] || bad+="$u "; done
    [ "$(systemctl is-active fcpi-stack.service)" = active ] || bad+="fcpi-stack-inactive "
    [ -z "$bad" ]; chk units_enabled_active $? "not enabled or not active: ${bad:-none}"
    s=$(cat /sys/fs/cgroup/fcpi.slice/memory.swap.max 2>/dev/null); p=$(systemctl show -p MemorySwapMax --value fcpi.slice)
    [ "$s" = 0 ] && [ "$p" = 0 ]; chk slice_swap_zero $? "memory.swap.max=$s MemorySwapMax=$p"
    h=$(cat /sys/fs/cgroup/fcpi.slice/memory.high 2>/dev/null); hp=$(systemctl show -p MemoryHigh --value fcpi.slice)
    [[ $h =~ ^[0-9]+$ ]] && [ "$h" = "$hp" ]; chk slice_memory_high $? "memory.high=$h MemoryHigh=$hp"
    ins=$(docker inspect $(docker ps -q --filter label=com.docker.compose.project=fcpi) 2>/dev/null | jq -r '.[] | "\(.Name) \(.HostConfig.CgroupParent) \(.Id)"')
    n=$(wc -l <<<"$ins"); out=$(awk '$2 != "fcpi.slice" {print $1}' <<<"$ins" | tr '\n' ' ')
    [ "$n" -ge 10 ] && [ -z "$out" ]; chk containers_in_slice $? "$n running, outside fcpi.slice: ${out:-none}"
    lifted=""; while read -r name parent id; do [ -n "$id" ] || continue
      [ "$(cat "/sys/fs/cgroup/$parent/docker-$id.scope/memory.swap.max" 2>/dev/null)" = 0 ] || [ "$(cat "/sys/fs/cgroup/$parent/memory.swap.max" 2>/dev/null)" = 0 ] || lifted+="$name "
    done <<<"$ins"
    [ -z "$lifted" ]; chk containers_swap_denied $? "swap allowed: ${lifted:-none}"
    f=$(docker ps -a --format '{{.Names}}\t{{.Label "com.docker.compose.project"}}\t{{.Label "fcpi.transient"}}' | awk -F '\t' '$2 != "fcpi" && $3 == "" {print $1}' | tr '\n' ' ')
    [ -z "$f" ]; chk no_foreign_containers $? "outside project fcpi: ${f:-none}"
    a=$(age_of "$RUND/last-sample.json"); [ "$a" -le "$STALE_S" ]; chk tick_fresh $? "last sample ${a} s old"
    a=$(age_of "$ADMISSION"); [ "$a" -le "$STALE_S" ]; chk admission_fresh $? "admission file ${a} s old: $(jq -c '{dispatch,browser,reasons}' "$ADMISSION" 2>/dev/null)"
    a=$(age_of "$STATE/probe-last.json"); ok=$(jq -r .ok "$STATE/probe-last.json" 2>/dev/null)
    [ "$a" -le 660 ] && [ "$ok" = true ]; chk probe_recent_ok $? "last probe ${a} s old, ok=$ok"
    same "$REPO/deploy/host/NetworkManager/90-fcpi-unmanaged.conf" /etc/NetworkManager/conf.d/90-fcpi-unmanaged.conf; chk nm_unmanaged $? "90-fcpi-unmanaged.conf"
    ;;
  functional)
    # A probe that started now: probe.sh leaves at once while the timer's probe holds its lock, so it is run again until
    # the recorded result is newer than this suite's start (the timer's own, begun before it, does not count).
    t0=$(utc); p='{}'
    for _ in $(seq 1 24); do
      bash "$(dirname "$(readlink -f "$0")")/probe.sh"
      p=$(obj "$STATE/probe-last.json")
      [[ "$(jq -r '.utc // ""' <<<"$p")" > "$t0" || "$(jq -r '.utc // ""' <<<"$p")" == "$t0" ]] && break
      p='{}'; sleep 5
    done
    [ "$p" != '{}' ]; chk probe_ran_now $? "a probe begun at or after $t0"
    jq -e .scrape.ok <<<"$p" >/dev/null; chk rest_fixture_scrape $? "$(jq -c .scrape <<<"$p")"
    jq -e .mcp.ok <<<"$p" >/dev/null; chk mcp_tools_list $? "$(jq -c .mcp <<<"$p")"
    jq -e '.platform.core_live == true and .platform.ledger_ok == true' <<<"$p" >/dev/null; chk platform_status $? "$(jq -c '.platform | {core_live, ledger_ok}' <<<"$p")"
    ;;
  services)
    log=$OUT/services-$(date -u +%Y%m%dT%H%M%SZ).txt
    bash "$REPO/scripts/m8/pi-suites.sh" >"$log" 2>&1
    while read -r sec ex; do chk "$sec" "$ex" "test_exit=$ex ($log)"; done < <(awk '/^### /{s=$2} /^test_exit=/{split($0,a,"="); print s, a[2]}' "$log")
    # Every suite must have reported: a runner that died before a section would otherwise pass with fewer checks.
    missing=""; for s in retrieval_tap ledger_tap gateway_m7_tap mcp_tap grammars_tap gateway_unit_tap gateway_contract_tap gateway_mcp_contract_tap ops_syntax restore_isolation; do
      awk -v s="$s" '/^### /{c=$2} c == s && /^test_exit=/{f=1} END{exit !f}' "$log" || missing+="$s "; done
    [ -z "$missing" ]; chk suites_complete $? "suites with no result: ${missing:-none}"
    left=$(docker ps -aq --filter label=fcpi.transient | wc -l); [ "$left" = 0 ]; chk no_transient_left $? "$left transient containers"
    ;;
  *) die "usage: fcpi verify ops|functional|services" ;;
esac
f=$OUT/$suite-$(date -u +%Y%m%dT%H%M%SZ).json
jq -n --arg utc "$(utc)" --arg s "$suite" --arg c "$(source_commit)" --argjson r "$R" '{utc:$utc,suite:$s,commit:$c,checks:$r,result:(if all($r[]; .state == "PASS") then "PASS" else "FAIL" end)}' | tee "$f" \
  | jq -r '"\(.suite) \(.result) (\(.commit[0:12]))", (.checks[] | "  \(.state)  \(.id)  \(.detail | .[0:160])")'
find "$OUT" -name '*.json' -mtime +30 -delete
jq -e '.result == "PASS"' "$f" >/dev/null
