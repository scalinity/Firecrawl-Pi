#!/usr/bin/env bash
# Rebuild M8's changed service images on the Pi from the committed HEAD, as M7's helper does: deploy HEAD
# (scripts/m1/deploy.sh refuses uncommitted code), build on the Pi (scripts/m8/pi-build-images.sh, its transcript appended
# to evidence/M8/raw/image-build.txt), point deploy/compose.yaml at the new digests, commit that change alone with a
# build(m8) message, and deploy it. It recreates nothing: scripts/m8/pi-up-m8.sh recreates the stack under fcpi.slice.
#   scripts/m8/rebuild-images.sh [<image> …]     (retrieval, access-gateway, browser; all when none)
set -euo pipefail
root=$(cd "$(dirname "$0")/../.." && pwd)
# shellcheck source=scripts/m1/pi-target.conf
. "$root/scripts/m1/pi-target.conf"
SSH=(ssh -i "$PI_SSH_KEY" -o IdentitiesOnly=yes -o BatchMode=yes -o ConnectTimeout=15 "$PI_SSH_TARGET")
redact() { sed -E "s#${PI_SSH_TARGET}#<pi-ssh-target>#g"; }
"$root/scripts/m1/deploy.sh" | tail -1 | redact
built=$(git -C "$root" rev-parse --short HEAD)
imgs=("$@"); [ ${#imgs[@]} -gt 0 ] || imgs=(retrieval access-gateway browser)
out=$("${SSH[@]}" "bash -s -- ${imgs[*]}" <"$root/scripts/m8/pi-build-images.sh")
mkdir -p "$root/evidence/M8/raw"
printf '%s\n' "$out" >>"$root/evidence/M8/raw/image-build.txt"
for i in "${imgs[@]}"; do
  id=$(printf '%s\n' "$out" | sed -n "s#^fcpi/$i:m8 id=\(sha256:[0-9a-f]\{64\}\) .*#\1#p")
  [ -n "$id" ] || { echo "no $i image id in the build transcript" >&2; exit 1; }
  sed -i '' -E "s#fcpi/$i@sha256:[0-9a-f]{64}#fcpi/$i@$id#" "$root/deploy/compose.yaml"
  echo "$i -> $id"
done
if git -C "$root" diff --quiet -- deploy/compose.yaml; then echo "digests unchanged"; exit 0; fi
git -C "$root" add deploy/compose.yaml
git -C "$root" commit -q -m "build(m8): run the service images built from $built"
"$root/scripts/m1/deploy.sh" | tail -1 | redact
echo "deployed; now: ssh … 'bash /opt/firecrawl-pi/scripts/m8/pi-up-m8.sh'"
