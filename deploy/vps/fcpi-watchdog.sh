#!/usr/bin/env bash
# The external watchdog (FIRECRAWL_PI_SPEC.md §25), ON the owner's VPS as root, run every minute by fcpi-watchdog.timer
# and installed by scripts/m8/vps-watchdog-deploy.sh as /usr/local/lib/fcpi-watchdog/fcpi-watchdog.sh. It watches for
# what the Pi cannot report itself: the Pi's heartbeat (scripts/ops/heartbeat.sh, pushed each minute over SFTP to
# /srv/fcpi-backup/heartbeat/pi.status and timed by this host's clock) no longer arriving, or arriving while the Pi's own
# monitor (its tick) has stopped. Each check is classified:
#   heartbeat_missing  no heartbeat for HB_STALE_S: the Pi, its network, or the path here is down; which is not known
#   monitor_stale      heartbeats arrive but the Pi's tick is older than TICK_STALE_S: the Pi cannot send its own notices
#   app_unhealthy      heartbeats arrive, the tick runs, the core is unhealthy or the probe fails: the Pi notifies this
#                      itself, so it is recorded here and not sent
#   ok                 anything else
# An incident opens after THRESHOLD consecutive checks of one failing class and is sent once, urgently for a missing
# heartbeat, and keeps its class and first failure while open, whatever class later failing checks have; it closes
# after two consecutive ok checks and its recovery is sent once, with the outage's duration. Before
# anything is sent, this host checks that it can reach ntfy.sh itself; if it cannot, it records that it is offline and
# claims nothing. The notices go to the owner's ntfy topic (/etc/fcpi-watchdog/ntfy_topic, 0600), inside the JSON body,
# holding operational metadata only. State: /var/lib/fcpi-watchdog/state (key=value); events.jsonl keeps the last 500.
set -uo pipefail
export LC_ALL=C PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
HB=/srv/fcpi-backup/heartbeat/pi.status TOPIC=/etc/fcpi-watchdog/ntfy_topic D=/var/lib/fcpi-watchdog
HB_STALE_S=150 TICK_STALE_S=300 THRESHOLD=3 CLEAR_AFTER=2
mkdir -p "$D"; chmod 0700 "$D"
exec 9>"$D/lock"; flock -n 9 || exit 0
now=$(date +%s) nowu=$(date -u +%Y-%m-%dT%H:%M:%SZ)
iso() { date -u -d "@$1" +%Y-%m-%dT%H:%M:%SZ; }
dur() { local s=$1; if [ "$s" -ge 3600 ]; then printf '%dh %02dm' $((s / 3600)) $((s % 3600 / 60)); elif [ "$s" -ge 60 ]; then printf '%dm %02ds' $((s / 60)) $((s % 60)); else printf '%ds' "$s"; fi; }
event() { printf '{"utc":"%s",%s}\n' "$nowu" "$1" >>"$D/events.jsonl"; tail -n 500 "$D/events.jsonl" >"$D/events.tmp" && mv -f "$D/events.tmp" "$D/events.jsonl"; }
# The state: plain key=value lines this script alone writes, read back into variables of known names.
cls=ok fails=0 goods=0 open=0 first_fail=0 opened_at=0 last_fail=0 last_ok=0 id="" last_seen_cls=ok
if [ -r "$D/state" ]; then while IFS='=' read -r k v; do case $k in cls|fails|goods|open|first_fail|opened_at|last_fail|last_ok|id|last_seen_cls) [[ $v =~ ^[a-z_0-9]*$ ]] && printf -v "$k" '%s' "$v" ;; esac; done <"$D/state"; fi
save() { printf 'cls=%s\nfails=%s\ngoods=%s\nopen=%s\nfirst_fail=%s\nopened_at=%s\nlast_fail=%s\nlast_ok=%s\nid=%s\nlast_seen_cls=%s\n' \
  "$cls" "$fails" "$goods" "$open" "$first_fail" "$opened_at" "$last_fail" "$last_ok" "$id" "$last_seen_cls" >"$D/state.tmp" && mv -f "$D/state.tmp" "$D/state"; }

# ---- this check ------------------------------------------------------------------------------------------------------
mt=$(stat -c %Y "$HB" 2>/dev/null || echo 0); hb_age=$(( now - mt ))
field() { sed -n "s/^$1=//p" "$HB" 2>/dev/null | head -1; }
this=ok
if [ "$mt" = 0 ] || [ "$hb_age" -gt "$HB_STALE_S" ]; then this=heartbeat_missing
elif [ "$(tail -1 "$HB" 2>/dev/null)" != "end=1" ]; then this=ok          # a file caught mid-write; judged next minute
else
  tick=$(field tick_age_s); core=$(field core_health); probe=$(field probe_ok)
  if [[ $tick =~ ^-?[0-9]+$ ]] && { [ "$tick" -lt 0 ] || [ "$tick" -gt "$TICK_STALE_S" ]; }; then this=monitor_stale
  elif [ "$core" != healthy ] || [ "$probe" != true ]; then this=app_unhealthy; fi
fi
[ "$this" = ok ] || [ "$this" = app_unhealthy ] && last_ok=$mt
if [ "$this" = app_unhealthy ] && [ "$last_seen_cls" != app_unhealthy ]; then event '"event":"app_unhealthy_seen","note":"the Pi is alive and notifies this itself"'; fi
last_seen_cls=$this

# ---- ntfy --------------------------------------------------------------------------------------------------------------
observer_ok() { curl -sS --proto =https --max-time 10 -o /dev/null https://ntfy.sh/v1/health; }
send() { # send <title> <message> <priority> <tag> <class>
  local t; t=$(tr -dc '0-9a-f' <"$TOPIC")
  [[ $t =~ ^[0-9a-f]{64}$ ]] || { event '"event":"send_skipped","reason":"no topic"'; return 1; }
  printf '{"topic":"%s","title":"%s","message":"%s","priority":%s,"tags":["%s","fcpi","%s"],"actions":[]}' "$t" "$1" "$2" "$3" "$4" "$5" \
    | curl -sS --proto =https --tlsv1.2 --max-time 15 --fail-with-body -H 'Content-Type: application/json' --data-binary @- https://ntfy.sh/ -o /dev/null
}

# ---- the incident ------------------------------------------------------------------------------------------------------
if [ "$this" = heartbeat_missing ] || [ "$this" = monitor_stale ]; then
  # An open incident keeps its class and first failure until it clears: a Pi coming back from an outage can report a
  # stale tick for a minute, which is the same outage, not a new one.
  if [ "$open" = 0 ] && { [ "$fails" = 0 ] || [ "$cls" != "$this" ]; }; then fails=0 first_fail=$now cls=$this; fi
  fails=$((fails + 1)) goods=0 last_fail=$now
  if [ "$open" = 0 ] && [ "$fails" -ge "$THRESHOLD" ]; then
    if ! observer_ok; then event "\"event\":\"observer_offline\",\"class\":\"$this\",\"note\":\"this host cannot reach ntfy.sh; nothing is claimed\""
    else
      id=$(printf '%s:%s' "$this" "$first_fail" | sha256sum | cut -c1-8)
      lastok=$([ "$last_ok" -gt 0 ] && iso "$last_ok" || echo "none seen")
      if [ "$this" = heartbeat_missing ]; then
        msg="Pi/application heartbeat has not arrived for $fails consecutive checks.\nLast heartbeat: $lastok\nIncident: $id"
        send "Firecrawl Pi — External Watchdog" "$msg" 5 rotating_light watchdog_unreachable; rc=$?
      else
        msg="The Pi's heartbeat arrives, but its own monitor has not run for over $((TICK_STALE_S / 60)) minutes, so it cannot send its own notices.\nIncident: $id"
        send "Firecrawl Pi — External Watchdog" "$msg" 4 warning watchdog_unreachable; rc=$?
      fi
      open=1 opened_at=$now
      event "\"event\":\"opened\",\"class\":\"$this\",\"incident_id\":\"$id\",\"first_failed\":\"$(iso "$first_fail")\",\"threshold_crossed\":\"$nowu\",\"consecutive_failures\":$fails,\"sent\":$([ "$rc" = 0 ] && echo true || echo false)"
    fi
  fi
else
  goods=$((goods + 1))
  if [ "$open" = 1 ] && [ "$goods" -ge "$CLEAR_AFTER" ]; then
    out=$(( now - first_fail ))
    send "Firecrawl Pi — Reachable Again" "External heartbeat restored.\nOutage duration: $(dur "$out")\nIncident: $id" 3 white_check_mark watchdog_reachable; rc=$?
    event "\"event\":\"cleared\",\"class\":\"$cls\",\"incident_id\":\"$id\",\"first_failed\":\"$(iso "$first_fail")\",\"last_failed\":\"$(iso "$last_fail")\",\"recovered\":\"$nowu\",\"outage_s\":$out,\"sent\":$([ "$rc" = 0 ] && echo true || echo false)"
    open=0 id="" cls=ok
  fi
  [ "$open" = 0 ] && fails=0
fi
save
