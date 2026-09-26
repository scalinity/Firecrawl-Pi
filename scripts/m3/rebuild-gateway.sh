#!/usr/bin/env bash
# Rebuild the access gateway's image on the Pi from the committed HEAD and point deploy/compose.yaml at
# its new digest. Deploys HEAD first (scripts/m1/deploy.sh refuses uncommitted code), appends the build
# transcript to evidence/M3/raw/gateway-build.txt, and leaves compose.yaml changed for the caller to
# commit and deploy before `up`.
#   scripts/m3/rebuild-gateway.sh
set -euo pipefail
root=$(cd "$(dirname "$0")/../.." && pwd)
# shellcheck source=scripts/m1/pi-target.conf
. "$root/scripts/m1/pi-target.conf"
SSH=(ssh -i "$PI_SSH_KEY" -o IdentitiesOnly=yes -o BatchMode=yes -o ConnectTimeout=15 "$PI_SSH_TARGET")
"$root/scripts/m1/deploy.sh" | tail -1
mkdir -p "$root/evidence/M3/raw"
out=$("${SSH[@]}" 'bash -s' <"$root/scripts/m3/pi-build-gateway.sh")
printf '%s\n' "$out" >>"$root/evidence/M3/raw/gateway-build.txt"
id=$(printf '%s\n' "$out" | sed -n 's#^fcpi/access-gateway:m3 id=\(sha256:[0-9a-f]\{64\}\) .*#\1#p')
[ -n "$id" ] || { echo "no image id in the build transcript" >&2; exit 1; }
sed -i '' -E "s#fcpi/access-gateway@sha256:[0-9a-f]{64}#fcpi/access-gateway@$id#" "$root/deploy/compose.yaml"
echo "access-gateway -> $id"
