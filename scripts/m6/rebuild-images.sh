#!/usr/bin/env bash
# Rebuild M6's three service images on the Pi from the committed HEAD and run them, as M5's helper does:
# deploy HEAD (scripts/m1/deploy.sh refuses uncommitted code), build on the Pi (scripts/m6/pi-build-images.sh,
# its transcript appended to evidence/M6/raw/image-build.txt), point deploy/compose.yaml at the new digests,
# commit that change alone with a build(m6) message, deploy it, and recreate the three services.
#   scripts/m6/rebuild-images.sh
set -euo pipefail
root=$(cd "$(dirname "$0")/../.." && pwd)
# shellcheck source=scripts/m1/pi-target.conf
. "$root/scripts/m1/pi-target.conf"
SSH=(ssh -i "$PI_SSH_KEY" -o IdentitiesOnly=yes -o BatchMode=yes -o ConnectTimeout=15 "$PI_SSH_TARGET")
redact() { sed -E "s#${PI_SSH_TARGET}#<pi-ssh-target>#g"; }
"$root/scripts/m1/deploy.sh" | tail -1 | redact
built=$(git -C "$root" rev-parse --short HEAD)
out=$("${SSH[@]}" 'bash -s' <"$root/scripts/m6/pi-build-images.sh")
mkdir -p "$root/evidence/M6/raw"
printf '%s\n' "$out" >>"$root/evidence/M6/raw/image-build.txt"
for i in retrieval access-gateway mcp-gateway; do
  id=$(printf '%s\n' "$out" | sed -n "s#^fcpi/$i:m6 id=\(sha256:[0-9a-f]\{64\}\) .*#\1#p")
  [ -n "$id" ] || { echo "no $i image id in the build transcript" >&2; exit 1; }
  sed -i '' -E "s#fcpi/$i@sha256:[0-9a-f]{64}#fcpi/$i@$id#" "$root/deploy/compose.yaml"
  echo "$i -> $id"
done
if git -C "$root" diff --quiet -- deploy/compose.yaml; then echo "digests unchanged"; exit 0; fi
git -C "$root" add deploy/compose.yaml
git -C "$root" commit -q -m "build(m6): run the service images built from $built"
"$root/scripts/m1/deploy.sh" | tail -1 | redact
"${SSH[@]}" 'sudo -n docker compose -p fcpi -f /opt/firecrawl-pi/deploy/compose.yaml up -d --wait --wait-timeout 600 --force-recreate retrieval-service access-gateway mcp-gateway 2>&1 | tail -3'
