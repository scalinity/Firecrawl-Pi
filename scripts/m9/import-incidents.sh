#!/usr/bin/env bash
# Read-only to the Pi; import a private approved branch without merging main.
set -euo pipefail
root=$(cd "$(dirname "$0")/../.." && pwd)
. "$root/scripts/m1/pi-target.conf"
id=${1:?incident id}; [[ $id =~ ^[0-9a-f]{8}$ ]] || exit 2
private=$HOME/.local/share/firecrawl-pi/m9/imports
install -d -m 0700 "$private"
t=$(mktemp "$private/bundle.XXXXXX"); trap 'rm -f "$t"' EXIT
ssh -i "$PI_SSH_KEY" -o IdentitiesOnly=yes -o BatchMode=yes "$PI_SSH_TARGET" "sudo -n cat /var/lib/firecrawl-pi/incidents/exports/$id.bundle" >"$t"
git -C "$root" bundle verify "$t" >/dev/null
git -C "$root" fetch "$t" "refs/heads/codex/incident-$id:refs/remotes/pi/incident-$id"
echo "private branch imported as pi/incident-$id; main remains unchanged"
