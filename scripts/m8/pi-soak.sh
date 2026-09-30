#!/usr/bin/env bash
# The soak's controller, ON the Pi:
#   pi-soak.sh start <hours>|<N>m   records the selection in force, selects the fixture engine, model and parser with no proxy
#                              and no enhancer (scripts/m5/pi-selection.sh), writes the run's window
#                              (/var/lib/firecrawl-pi/soak/current.json), installs and starts fcpi-soak.service
#   pi-soak.sh status          the run's window and its log's counts by class and verdict
#   pi-soak.sh stop            stops and removes the unit, restores the selection recorded at start
#   pi-soak.sh collect <run>   prints the run's log, then the host samples, probes, notices, supervisor restarts and backup runs inside its window, each in
#                              its own section, for evidence/M8/raw/soak/
set -euo pipefail
. /opt/firecrawl-pi/scripts/ops/lib.sh
[ "$(id -u)" = 0 ] || exec sudo -n bash "$0" "$@"
D=$STATE/soak; mkdir -p "$D"; chmod 0700 "$D"
case ${1:-} in
  start)
    h=${2:?hours}; case $h in *m) secs=$(( ${h%m} * 60 )) ;; *) secs=$(( h * 3600 )) ;; esac; [[ ${h%m} =~ ^[0-9]+$ ]] || die "hours, or minutes as <N>m"
    [ -e /etc/systemd/system/fcpi-soak.service ] && die "a soak is installed; stop it first"
    bash $REPO/scripts/m5/pi-selection.sh show >"$D/selection-before.json"
    bash $REPO/scripts/m5/pi-selection.sh fixture fcpi-fixture-model fcpi-fixture-parser none none
    s=$(now_s); run=soak-$(date -u -d "@$s" +%Y%m%dT%H%M%SZ)
    jq -n --arg run "$run" --argjson s "$s" --argjson e $((s + secs)) --arg c "$(source_commit)" \
      '{run:$run,start_epoch:$s,end_epoch:$e,start_utc:($s|todate),end_utc:($e|todate),commit:$c}' | write_atomic "$D/current.json" 0600
    install -m 0644 $REPO/scripts/m8/fcpi-soak.service /etc/systemd/system/fcpi-soak.service
    systemctl daemon-reload && systemctl enable --now fcpi-soak.service 2>&1 | grep -v '^Created symlink' || true
    cat "$D/current.json" ;;
  status)
    cat "$D/current.json"; systemctl is-active fcpi-soak.service || true
    run=$(jq -r .run "$D/current.json"); jq -r '"\(.class) \(.ok)"' "$LOGD/soak/$run.jsonl" 2>/dev/null | sort | uniq -c ;;
  stop)
    systemctl disable --now fcpi-soak.service 2>/dev/null || true
    rm -f /etc/systemd/system/fcpi-soak.service; systemctl daemon-reload
    if [ -s "$D/selection-before.json" ]; then
      b=$(cat "$D/selection-before.json")
      bash $REPO/scripts/m5/pi-selection.sh "$(jq -r .search <<<"$b")" "$(jq -r .extractionModel <<<"$b")" "$(jq -r .parser <<<"$b")" "$(jq -r '.proxy // "none"' <<<"$b")" "$(jq -r '.enhanced // "none"' <<<"$b")"
    fi
    echo "soak unit removed; selection restored" ;;
  collect)
    run=${2:?run}; c=$D/current.json
    s=$(jq -r .start_utc "$c") e=$(jq -r .end_utc "$c")
    echo "### meta"; jq -c '. + {collected_utc: (now | todate)}' "$c"
    echo "### soak_log"; cat "$LOGD/soak/$run.jsonl"
    echo "### samples"; cat "$LOGD"/samples/*.jsonl | jq -c --arg s "$s" --arg e "$e" 'select(.utc >= $s and .utc <= $e)'
    echo "### probes"; cat "$LOGD"/probe/*.jsonl | jq -c --arg s "$s" --arg e "$e" 'select(.utc >= $s and .utc <= $e)'
    echo "### notices"; cat "$STATE"/alerts/outbox/*.json 2>/dev/null | jq -c --arg s "$s" --arg e "$e" 'select(.utc >= $s and .utc <= $e)'
    echo "### supervisor"; jq -c --arg s "$s" --arg e "$e" 'select(.utc >= $s and .utc <= $e)' "$STATE/supervisor/restarts.jsonl" 2>/dev/null || true
    # Each backup run that ended in the window: its start (the run's name) and end bound its hold, which the minute samples
    # can miss entirely when the quiescence is shorter than a minute.
    echo "### backups"; jq -c --arg s "$s" --arg e "$e" 'select(.utc >= $s and .utc <= $e) | {run, utc, result, quiesce_s}' "$STATE/backup/history.jsonl" 2>/dev/null || true
    echo "### end" ;;
  *) die "usage: pi-soak.sh start <hours> | status | stop | collect <run>" ;;
esac
