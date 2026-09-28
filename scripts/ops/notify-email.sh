#!/usr/bin/env bash
# One notice by email (FIRECRAWL_PI_SPEC.md §25), ON the Pi, as root: the command /etc/firecrawl-pi/alerts.env names
# (FCPI_ALERT_COMMAND), which the tick runs with one notice's JSON on stdin (scripts/ops/lib.sh deliver_notices, within
# 20 s). It sends one plain-text message over SMTPS (implicit TLS, the server's certificate verified) with curl, to the
# server, login, sender and recipient alerts.env names (FCPI_ALERT_SMTP_URL, FCPI_ALERT_SMTP_USER, FCPI_ALERT_FROM,
# FCPI_ALERT_TO). The password is /etc/firecrawl-pi/secrets/alerts/smtp_password (0600, root), handed to curl as a netrc
# through a descriptor, never on a command line and never printed. Exit 0 only when the server accepted the message.
set -uo pipefail
export LC_ALL=C PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
# shellcheck disable=SC1091
. /etc/firecrawl-pi/alerts.env
PW=/etc/firecrawl-pi/secrets/alerts/smtp_password
: "${FCPI_ALERT_SMTP_URL:?}" "${FCPI_ALERT_SMTP_USER:?}" "${FCPI_ALERT_FROM:?}" "${FCPI_ALERT_TO:?}"
[[ $FCPI_ALERT_SMTP_URL =~ ^smtps://([^:/]+)(:[0-9]+)?/?$ ]] || { echo "FCPI_ALERT_SMTP_URL must be smtps://host[:port]" >&2; exit 2; }
host=${BASH_REMATCH[1]}
[ -r "$PW" ] || { echo "no $PW" >&2; exit 2; }
n=$(cat); jq -e 'type == "object" and (.kind | type) == "string" and (.incident | type) == "string"' >/dev/null 2>&1 <<<"$n" || { echo "not a notice" >&2; exit 2; }
kind=$(jq -r .kind <<<"$n") key=$(jq -r .incident <<<"$n") at=$(jq -r .utc <<<"$n") id=$(jq -r .id <<<"$n")
case $kind in opened) what="opened" ;; cleared) what="cleared (recovered)" ;; *) what=$kind ;; esac
msg() {
  printf 'From: %s\r\nTo: %s\r\nSubject: [fcpi] %s: %s\r\nDate: %s\r\nMessage-ID: <%s@fcpi-pi>\r\nMIME-Version: 1.0\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n' \
    "$FCPI_ALERT_FROM" "$FCPI_ALERT_TO" "$kind" "$key" "$(date -R)" "$id"
  printf 'The Firecrawl Pi platform %s the incident %s at %s (UTC).\r\n\r\nfcpi status on the Pi shows its state; each incident is noticed once when it opens and once when it clears.\r\n\r\n' "$what" "$key" "$at"
  jq . <<<"$n" | sed 's/$/\r/'
}
msg | curl -sS --max-time 18 --ssl-reqd --url "$FCPI_ALERT_SMTP_URL" \
  --netrc-file <(printf 'machine %s login %s password %s\n' "$host" "$FCPI_ALERT_SMTP_USER" "$(tr -d ' \n' <"$PW")") \
  --mail-from "$FCPI_ALERT_FROM" --mail-rcpt "$FCPI_ALERT_TO" -T - >/dev/null
