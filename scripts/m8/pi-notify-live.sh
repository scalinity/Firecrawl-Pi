#!/usr/bin/env bash
# The owner's notification channel (FIRECRAWL_PI_SPEC.md §25; N01), ON the Pi, as root:
#   ssh … 'sudo -n bash /opt/firecrawl-pi/scripts/m8/pi-notify-live.sh' > evidence/M8/raw/notify-live.txt
# While /etc/firecrawl-pi/alerts.env names no FCPI_ALERT_COMMAND, it records configured=no with the reason and sends
# nothing, so N01 is BLOCKED_CREDENTIAL from a record rather than from a missing file. Otherwise a test incident's notices
# (opened, then cleared) go through the channel as the tick delivers them, and each one's delivery record is printed.
set -uo pipefail
. /opt/firecrawl-pi/scripts/ops/lib.sh
need_root
echo "### meta"
cmd=$(sed -n 's/^FCPI_ALERT_COMMAND=//p' /etc/firecrawl-pi/alerts.env 2>/dev/null | tail -1)
if [ -z "$cmd" ]; then
  echo "utc=$(utc) source_commit=$(source_commit) configured=no reason=alerts.env-names-no-FCPI_ALERT_COMMAND"
  echo "### end"; exit 0
fi
echo "utc=$(utc) source_commit=$(source_commit) configured=yes"
key=notify_test_$(date -u +%Y%m%dT%H%M%SZ)
notice opened "$key" '{"test":true}'; notice cleared "$key" '{"test":true}'
# deliver_notices sends at most three a call, oldest first: called until both test notices are out, or five times.
for _ in 1 2 3 4 5; do
  deliver_notices
  [ "$(cat "$STATE"/alerts/outbox/*-"$key".json | jq -s 'map(select(.delivered == true)) | length')" = 2 ] && break
done
echo "### delivered"
for f in "$STATE"/alerts/outbox/*-"$key".json; do jq -c '{id, kind, delivered, attempts}' "$f"; done
echo "### end"
