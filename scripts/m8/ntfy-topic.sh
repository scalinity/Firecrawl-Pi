#!/usr/bin/env bash
# The owner's ntfy topic (FIRECRAWL_PI_SPEC.md §25), ON the workstation. An anonymous ntfy.sh topic is guarded only by
# its name, so the name is a secret: 64 random hex characters (256 bits), generated here and kept in the owner's macOS
# login keychain as "fcpi ntfy topic" (account fcpi). From there it goes over SSH stdin to the Pi
# (/etc/firecrawl-pi/secrets/alerts/ntfy_topic, 0600), with /etc/firecrawl-pi/alerts.env naming the ntfy notifier, and to
# the clipboard, for subscribing in the ntfy app. It is never printed, never on a command line and never in the
# repository. Run again, it keeps the keychain's topic and rewrites the Pi's copy.
#   scripts/m8/ntfy-topic.sh [--clipboard]
set -euo pipefail
root=$(cd "$(dirname "$0")/../.." && pwd)
# shellcheck source=scripts/m1/pi-target.conf
. "$root/scripts/m1/pi-target.conf"
SVC="fcpi ntfy topic" ACC=fcpi
if security find-generic-password -a "$ACC" -s "$SVC" >/dev/null 2>&1; then echo "kept: the login keychain already holds \"$SVC\""
else
  t=$(openssl rand -hex 32)
  printf 'add-generic-password -a %s -s "%s" -l "%s" -j "%s" -w %s\n' "$ACC" "$SVC" "$SVC" \
    "The Firecrawl Pi platform's private ntfy.sh topic: subscribe to it in the ntfy app. Anyone holding it can read and send its notices." "$t" | security -i >/dev/null
  unset t
  echo "stored in the login keychain as \"$SVC\" (account $ACC)"
fi
topic() { security find-generic-password -a "$ACC" -s "$SVC" -w; }
[[ $(topic) =~ ^[0-9a-f]{64}$ ]] || { echo "the keychain's topic is not 64 hex characters" >&2; exit 2; }
SSH=(ssh -i "$PI_SSH_KEY" -o IdentitiesOnly=yes -o BatchMode=yes "$PI_SSH_TARGET")
topic | "${SSH[@]}" 'sudo -n install -d -m 0700 -o root -g root /etc/firecrawl-pi/secrets/alerts && sudo -n sh -c "umask 077; cat >/etc/firecrawl-pi/secrets/alerts/ntfy_topic.new && mv -f /etc/firecrawl-pi/secrets/alerts/ntfy_topic.new /etc/firecrawl-pi/secrets/alerts/ntfy_topic"'
printf 'FCPI_ALERT_COMMAND=/opt/firecrawl-pi/scripts/ops/notify-ntfy.sh\n' | "${SSH[@]}" 'sudo -n sh -c "umask 077; cat >/etc/firecrawl-pi/alerts.env.new && mv -f /etc/firecrawl-pi/alerts.env.new /etc/firecrawl-pi/alerts.env"'
echo "written on the Pi: /etc/firecrawl-pi/secrets/alerts/ntfy_topic and /etc/firecrawl-pi/alerts.env"
if [ "${1:-}" = --clipboard ]; then topic | tr -d '\n' | pbcopy; echo "the topic is on the clipboard: paste it into the ntfy app's subscribe dialog (server ntfy.sh), then clear the clipboard"; fi
