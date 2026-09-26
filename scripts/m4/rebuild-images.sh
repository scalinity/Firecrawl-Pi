#!/usr/bin/env bash
# Rebuild M4's images on the Pi from the committed HEAD and point deploy/compose.yaml at their new
# digests. Deploys HEAD first (scripts/m1/deploy.sh refuses uncommitted code), appends the build
# transcript to evidence/M4/raw/image-build.txt, and leaves compose.yaml changed for the caller to
# commit and deploy before bringing the stack up (scripts/m4/pi-up-m4.sh).
#   scripts/m4/rebuild-images.sh
set -euo pipefail
root=$(cd "$(dirname "$0")/../.." && pwd)
# shellcheck source=scripts/m1/pi-target.conf
. "$root/scripts/m1/pi-target.conf"
SSH=(ssh -i "$PI_SSH_KEY" -o IdentitiesOnly=yes -o BatchMode=yes -o ConnectTimeout=15 "$PI_SSH_TARGET")
"$root/scripts/m1/deploy.sh" | tail -1
mkdir -p "$root/evidence/M4/raw"
out=$("${SSH[@]}" 'bash -s' <"$root/scripts/m4/pi-build-images.sh")
printf '%s\n' "$out" >>"$root/evidence/M4/raw/image-build.txt"
for i in mcp-gateway access-gateway; do
  id=$(printf '%s\n' "$out" | sed -n "s#^fcpi/$i:m4 id=\(sha256:[0-9a-f]\{64\}\) .*#\1#p")
  [ -n "$id" ] || { echo "no $i image id in the build transcript" >&2; exit 1; }
  sed -i '' -E "s#fcpi/$i@sha256:[0-9a-f]{64}#fcpi/$i@$id#" "$root/deploy/compose.yaml"
  echo "$i -> $id"
done
