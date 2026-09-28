#!/usr/bin/env bash
# The owner's notification channel (FIRECRAWL_PI_SPEC.md §25; N01), ON the Pi, as root:
#   ssh … 'sudo -n bash /opt/firecrawl-pi/scripts/m8/pi-notify-live.sh' > evidence/M8/raw/notify-live.txt
# While /etc/firecrawl-pi/alerts.env names no FCPI_ALERT_COMMAND, it records configured=no with the reason and sends
# nothing, so N01 is BLOCKED_CREDENTIAL from a record rather than from a missing file. Otherwise one real incident, the
# tick's own temperature_high: an injected 80 °C reading (/run/firecrawl-pi/inject/temp_c, which every sample marks
# injected) held across several ticks, then removed until the incident clears. The tick opens it and clears it and
# delivers each notice itself; the record holds every temperature_high notice raised in the window (one opened and one
# cleared, however many ticks judged it) with its delivery, and the ticks that read the injected value.
set -uo pipefail
. /opt/firecrawl-pi/scripts/ops/lib.sh
need_root
echo "### meta"
cmd=$(sed -n 's/^FCPI_ALERT_COMMAND=//p' /etc/firecrawl-pi/alerts.env 2>/dev/null | tail -1)
if [ -z "$cmd" ]; then
  echo "utc=$(utc) source_commit=$(source_commit) configured=no reason=alerts.env-names-no-FCPI_ALERT_COMMAND"
  echo "### end"; exit 0
fi
echo "utc=$(utc) source_commit=$(source_commit) configured=yes command=$(basename "${cmd%% *}")"
t0=$(utc) OB=$STATE/alerts/outbox
notices() { for f in "$OB"/*-"$1"-temperature_high.json; do [ -f "$f" ] && jq -c --arg t "$t0" 'select(.utc >= $t)' "$f"; done 2>/dev/null; }
tick() { bash "$REPO/scripts/ops/tick.sh"; }
waitfor() { local end=$(( $(now_s) + $1 )); while [ "$(now_s)" -lt "$end" ]; do tick; eval "$2" && return 0; sleep 10; done; return 1; }
trap 'rm -f "$RUND/inject/temp_c"' EXIT
mkdir -p "$RUND/inject"; echo 80.0 >"$RUND/inject/temp_c"
waitfor 300 '[ -n "$(notices opened)" ]'; hot=0
for _ in 1 2 3; do sleep 15; tick; done                  # further ticks while it is still hot: no second notice
rm -f "$RUND/inject/temp_c"
waitfor 420 '[ -n "$(notices cleared)" ]'
for _ in 1 2 3 4 5 6; do [ "$( { notices opened; notices cleared; } | jq -s 'map(select(.delivered)) | length')" = 2 ] && break; sleep 10; tick; done
hot=$(jq -c --arg t "$t0" 'select(.utc >= $t and .injected_temp == true)' "$LOGD/samples/$(date -u +%F).jsonl" 2>/dev/null | wc -l)
echo "### delivered"
{ notices opened; notices cleared; } | jq -c '{id, kind, incident, delivered, attempts}'
echo "### window"
echo "{\"from\":\"$t0\",\"to\":\"$(utc)\",\"opened_notices\":$(notices opened | wc -l),\"cleared_notices\":$(notices cleared | wc -l),\"ticks_reading_injected\":$hot}"
echo "### end"
