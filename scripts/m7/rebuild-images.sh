#!/usr/bin/env bash
# Rebuild M7's four service images on the Pi from the committed HEAD and run them, as M6's helper does: deploy HEAD
# (scripts/m1/deploy.sh refuses uncommitted code), build on the Pi (scripts/m7/pi-build-images.sh, its transcript
# appended to evidence/M7/raw/image-build.txt), point deploy/compose.yaml at the new digests, commit that change alone
# with a build(m7) message, and deploy it. It recreates nothing: the new gateway refuses a ledger below schema version 3
# (M3's rule), so scripts/m7/pi-up-m7.sh applies the schemas and then recreates every service together.
#   scripts/m7/rebuild-images.sh
set -euo pipefail
root=$(cd "$(dirname "$0")/../.." && pwd)
# shellcheck source=scripts/m1/pi-target.conf
. "$root/scripts/m1/pi-target.conf"
SSH=(ssh -i "$PI_SSH_KEY" -o IdentitiesOnly=yes -o BatchMode=yes -o ConnectTimeout=15 "$PI_SSH_TARGET")
redact() { sed -E "s#${PI_SSH_TARGET}#<pi-ssh-target>#g"; }
"$root/scripts/m1/deploy.sh" | tail -1 | redact
built=$(git -C "$root" rev-parse --short HEAD)
out=$("${SSH[@]}" 'bash -s' <"$root/scripts/m7/pi-build-images.sh")
mkdir -p "$root/evidence/M7/raw"
printf '%s\n' "$out" >>"$root/evidence/M7/raw/image-build.txt"
for i in retrieval access-gateway mcp-gateway browser; do
  id=$(printf '%s\n' "$out" | sed -n "s#^fcpi/$i:m7 id=\(sha256:[0-9a-f]\{64\}\) .*#\1#p")
  [ -n "$id" ] || { echo "no $i image id in the build transcript" >&2; exit 1; }
  sed -i '' -E "s#fcpi/$i@sha256:[0-9a-f]{64}#fcpi/$i@$id#" "$root/deploy/compose.yaml"
  echo "$i -> $id"
done
if git -C "$root" diff --quiet -- deploy/compose.yaml; then echo "digests unchanged"; exit 0; fi
git -C "$root" add deploy/compose.yaml
git -C "$root" commit -q -m "build(m7): run the service images built from $built"
"$root/scripts/m1/deploy.sh" | tail -1 | redact
echo "deployed; now: ssh … 'bash /opt/firecrawl-pi/scripts/m7/pi-up-m7.sh'"
