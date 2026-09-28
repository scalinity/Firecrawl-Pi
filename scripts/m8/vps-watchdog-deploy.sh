#!/usr/bin/env bash
# Installs the external watchdog on the owner's VPS (FIRECRAWL_PI_SPEC.md §25), from the workstation, idempotent:
# deploy/vps/fcpi-watchdog.sh as /usr/local/lib/fcpi-watchdog/fcpi-watchdog.sh, its unit and timer, and the owner's ntfy
# topic (from the login keychain, scripts/m8/ntfy-topic.sh) as /etc/fcpi-watchdog/ntfy_topic (0600), each over SSH stdin,
# so the topic is never on a command line or printed. The VPS's address, the owner's key for it and its pinned host key
# are in ~/.config/firecrawl-pi/vps.conf, outside the repository. Prints each installed file's SHA-256 and the timer.
#   scripts/m8/vps-watchdog-deploy.sh
set -euo pipefail
root=$(cd "$(dirname "$0")/../.." && pwd)
# shellcheck disable=SC1090
. "$HOME/.config/firecrawl-pi/vps.conf"
VPS_SSH_KEY=${VPS_SSH_KEY/\$HOME/$HOME} VPS_KNOWN_HOSTS=${VPS_KNOWN_HOSTS/\$HOME/$HOME}
V=(ssh -i "$VPS_SSH_KEY" -o IdentitiesOnly=yes -o BatchMode=yes -o StrictHostKeyChecking=yes -o UserKnownHostsFile="$VPS_KNOWN_HOSTS" "$VPS_SSH_TARGET")
put() { "${V[@]}" "install -d -m 0755 \"\$(dirname $1)\" && umask 077 && cat >$1.new && chmod $2 $1.new && mv -f $1.new $1" <"$3"; }
put /usr/local/lib/fcpi-watchdog/fcpi-watchdog.sh 0755 "$root/deploy/vps/fcpi-watchdog.sh"
put /etc/systemd/system/fcpi-watchdog.service 0644 "$root/deploy/vps/fcpi-watchdog.service"
put /etc/systemd/system/fcpi-watchdog.timer 0644 "$root/deploy/vps/fcpi-watchdog.timer"
security find-generic-password -a fcpi -s "fcpi ntfy topic" -w | tr -d '\n' \
  | "${V[@]}" 'install -d -m 0700 /etc/fcpi-watchdog && umask 077 && cat >/etc/fcpi-watchdog/ntfy_topic.new && mv -f /etc/fcpi-watchdog/ntfy_topic.new /etc/fcpi-watchdog/ntfy_topic'
"${V[@]}" 'systemctl daemon-reload && systemctl enable --now fcpi-watchdog.timer >/dev/null 2>&1
  sha256sum /usr/local/lib/fcpi-watchdog/fcpi-watchdog.sh /etc/systemd/system/fcpi-watchdog.service /etc/systemd/system/fcpi-watchdog.timer
  echo "topic: $(stat -c "%a %U" /etc/fcpi-watchdog/ntfy_topic), $(tr -dc 0-9a-f </etc/fcpi-watchdog/ntfy_topic | wc -c) hex characters"
  systemctl is-enabled fcpi-watchdog.timer; systemctl is-active fcpi-watchdog.timer'
(cd "$root" && sha256sum deploy/vps/fcpi-watchdog.sh deploy/vps/fcpi-watchdog.service deploy/vps/fcpi-watchdog.timer | sed 's/^/repository: /')
