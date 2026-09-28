#!/usr/bin/env bash
# The email notice channel's settings and password (FIRECRAWL_PI_SPEC.md §25), from the workstation, run by the owner in
# a terminal: the SMTP password (for Gmail, an app password) is read without echo, its spaces removed, and written over
# SSH stdin to /etc/firecrawl-pi/secrets/alerts/smtp_password (0600, root) on the Pi; it is never printed, never on a
# command line and never in a file here. /etc/firecrawl-pi/alerts.env (0600) gets the rest, none of it secret:
# FCPI_ALERT_COMMAND (scripts/ops/notify-email.sh), the server, the login, the sender and the recipient.
#   scripts/m8/put-alert-secret.sh --login <smtp login> --to <recipient> [--from <sender>] [--url smtps://smtp.gmail.com:465]
set -euo pipefail
root=$(cd "$(dirname "$0")/../.." && pwd)
# shellcheck source=scripts/m1/pi-target.conf
. "$root/scripts/m1/pi-target.conf"
login="" to="" from="" url=smtps://smtp.gmail.com:465
while [ $# -gt 0 ]; do case $1 in --login) login=$2; shift 2 ;; --to) to=$2; shift 2 ;; --from) from=$2; shift 2 ;; --url) url=$2; shift 2 ;; *) echo "unknown option $1" >&2; exit 2 ;; esac; done
[ -n "$login" ] && [ -n "$to" ] || { echo "usage: put-alert-secret.sh --login <smtp login> --to <recipient> [--from <sender>] [--url smtps://host:port]" >&2; exit 2; }
from=${from:-$login}
for v in "$login" "$to" "$from"; do [[ $v =~ ^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+$ ]] || { echo "not an address: $v" >&2; exit 2; }; done
[[ $url =~ ^smtps://[A-Za-z0-9.-]+(:[0-9]+)?$ ]] || { echo "the URL must be smtps://host[:port]" >&2; exit 2; }
[ -t 0 ] || { echo "run this in a terminal: the password is read without echo" >&2; exit 2; }
IFS= read -r -s -p "SMTP password for $login (not shown): " pw; echo
pw=${pw// /}; [ "${#pw}" -ge 12 ] || { echo "that password is shorter than 12 characters; nothing was written" >&2; exit 2; }
SSH=(ssh -i "$PI_SSH_KEY" -o IdentitiesOnly=yes -o BatchMode=yes "$PI_SSH_TARGET")
printf '%s' "$pw" | "${SSH[@]}" 'sudo -n install -d -m 0700 -o root -g root /etc/firecrawl-pi/secrets/alerts && sudo -n sh -c "umask 077; cat >/etc/firecrawl-pi/secrets/alerts/smtp_password.new && mv -f /etc/firecrawl-pi/secrets/alerts/smtp_password.new /etc/firecrawl-pi/secrets/alerts/smtp_password"'
unset pw
printf 'FCPI_ALERT_COMMAND=/opt/firecrawl-pi/scripts/ops/notify-email.sh\nFCPI_ALERT_SMTP_URL=%s\nFCPI_ALERT_SMTP_USER=%s\nFCPI_ALERT_FROM=%s\nFCPI_ALERT_TO=%s\n' "$url" "$login" "$from" "$to" \
  | "${SSH[@]}" 'sudo -n sh -c "umask 077; cat >/etc/firecrawl-pi/alerts.env.new && mv -f /etc/firecrawl-pi/alerts.env.new /etc/firecrawl-pi/alerts.env"'
echo "written on the Pi: /etc/firecrawl-pi/secrets/alerts/smtp_password and /etc/firecrawl-pi/alerts.env"
