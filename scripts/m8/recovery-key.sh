#!/usr/bin/env bash
# The backup repository's recovery key (FIRECRAWL_PI_SPEC.md §26: kept outside the Pi and apart from the repository), ON
# the workstation. It is generated here and kept in the owner's macOS login keychain as "fcpi restic recovery key"
# (account fcpi), from which the owner copies it into their password manager; then it is sent once to the Pi over SSH
# stdin for restic key add (scripts/m8/pi-backup-setup.sh recovery-add), which holds it in memory only. It is never
# printed, never on a command line and never in a file. Run again, it keeps the keychain's key and adds nothing twice.
#   scripts/m8/recovery-key.sh
set -euo pipefail
root=$(cd "$(dirname "$0")/../.." && pwd)
# shellcheck source=scripts/m1/pi-target.conf
. "$root/scripts/m1/pi-target.conf"
SVC="fcpi restic recovery key" ACC=fcpi
if security find-generic-password -a "$ACC" -s "$SVC" >/dev/null 2>&1; then echo "kept: the login keychain already holds \"$SVC\""
else
  pw=$(openssl rand -base64 48 | tr -d '\n')
  # security -i reads its command on stdin, so the key reaches the keychain without a command line.
  printf 'add-generic-password -a %s -s "%s" -l "%s" -j "%s" -w %s\n' "$ACC" "$SVC" "$SVC" \
    "Recovery key of the Firecrawl Pi platform's off-device restic repository. Copy it into your password manager." "$pw" | security -i >/dev/null
  unset pw
  security find-generic-password -a "$ACC" -s "$SVC" >/dev/null && echo "stored in the login keychain as \"$SVC\" (account $ACC)"
fi
security find-generic-password -a "$ACC" -s "$SVC" -w \
  | ssh -i "$PI_SSH_KEY" -o IdentitiesOnly=yes -o BatchMode=yes "$PI_SSH_TARGET" 'sudo -n bash /opt/firecrawl-pi/scripts/m8/pi-backup-setup.sh recovery-add'
