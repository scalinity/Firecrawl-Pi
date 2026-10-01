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
tick() { FCPI_TICK_LOCK_WAIT_S=90 bash "$REPO/scripts/ops/tick.sh"; }   # waits for the timer's run rather than skipping
waitfor() { local end=$(( $(now_s) + $1 )); while [ "$(now_s)" -lt "$end" ]; do tick; eval "$2" && return 0; sleep 10; done; return 1; }
trap 'rm -f "$RUND/inject/temp_c"' EXIT
mkdir -p "$RUND/inject"; echo 80.0 >"$RUND/inject/temp_c"
waitfor 300 '[ -n "$(notices opened)" ]'; hot=0
for _ in 1 2 3; do sleep 15; tick; done                  # further ticks while it is still hot: no second notice
rm -f "$RUND/inject/temp_c"
waitfor 420 '[ -n "$(notices cleared)" ]'
for _ in 1 2 3 4 5 6; do [ "$( { notices opened; notices cleared; } | jq -s 'map(select(.delivered)) | length')" = 2 ] && break; sleep 10; tick; done
hot=$(jsonl "$LOGD/samples/$(date -u +%F).jsonl" | jq -c --arg t "$t0" 'select(.utc >= $t and .injected_temp == true)' | wc -l)
echo "### delivered"
{ notices opened; notices cleared; } | jq -c '{id, kind, incident, incident_id, delivered, attempts}'
# What ntfy's server holds for the topic since the window began, as the phone would receive it: each message's id, time,
# title, priority, tags and incident line, never the topic (the request reaches curl as a config on a descriptor).
if [ -r /etc/firecrawl-pi/secrets/alerts/ntfy_topic ] && [[ $cmd == *notify-ntfy.sh ]]; then
  echo "### ntfy_server"
  since=$(date -u -d "$t0" +%s) iid=$(notices opened | jq -r '.incident_id' | head -1)
  poll() { curl -sS --proto =https --max-time 20 -K <(printf 'url = "https://ntfy.sh/%s/json?poll=1&since=%s"\n' "$(tr -d ' \n' </etc/firecrawl-pi/secrets/alerts/ntfy_topic)" "$since") \
    | jq -c 'select(.event == "message") | {id, time, title, priority, tags, incident: ((.message // "") | capture("Incident: (?<i>[0-9a-f]+)").i // null)}'; }
  # The server can list a message a moment after accepting it: asked again, for up to a minute, until both are there.
  for _ in 1 2 3 4 5 6; do srv=$(poll); [ "$(jq -s --arg i "$iid" 'map(select(.incident == $i)) | length' <<<"$srv")" -ge 2 ] && break; sleep 10; done
  printf '%s\n' "$srv"
fi
echo "### window"
echo "{\"from\":\"$t0\",\"to\":\"$(utc)\",\"opened_notices\":$(notices opened | wc -l),\"cleared_notices\":$(notices cleared | wc -l),\"ticks_reading_injected\":$hot}"
echo "### end"
