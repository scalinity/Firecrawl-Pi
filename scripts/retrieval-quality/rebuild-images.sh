#!/usr/bin/env bash
# Rebuild the service images this work changes on the Pi from the committed HEAD: deploy HEAD (scripts/m1/deploy.sh
# refuses uncommitted code), build on the Pi (scripts/retrieval-quality/pi-build-images.sh, its transcript appended to
# evidence/post-m9/retrieval-quality/raw/image-build.txt), point deploy/compose.yaml and the version lock's image entries
# (image id, build commit, transcript) at the new digests, commit that change alone, and deploy it. It recreates
# nothing: scripts/m8/pi-up-m8.sh recreates the stack under fcpi.slice.
#   scripts/retrieval-quality/rebuild-images.sh <image> …     (retrieval, access-gateway, mcp-gateway)
set -euo pipefail
root=$(cd "$(dirname "$0")/../.." && pwd)
# shellcheck source=scripts/m1/pi-target.conf
. "$root/scripts/m1/pi-target.conf"
SSH=(ssh -i "$PI_SSH_KEY" -o IdentitiesOnly=yes -o BatchMode=yes -o ConnectTimeout=15 "$PI_SSH_TARGET")
redact() { sed -E "s#${PI_SSH_TARGET}#<pi-ssh-target>#g"; }
[ $# -gt 0 ] || { echo "name the images to build" >&2; exit 2; }
"$root/scripts/m1/deploy.sh" | tail -1 | redact
built=$(git -C "$root" rev-parse --short HEAD)
out=$("${SSH[@]}" "bash -s -- $*" <"$root/scripts/retrieval-quality/pi-build-images.sh")
mkdir -p "$root/evidence/post-m9/retrieval-quality/raw"
printf '%s\n' "$out" >>"$root/evidence/post-m9/retrieval-quality/raw/image-build.txt"
for i in "$@"; do
  id=$(printf '%s\n' "$out" | sed -n "s#^fcpi/$i:quality id=\(sha256:[0-9a-f]\{64\}\) .*#\1#p")
  [ -n "$id" ] || { echo "no $i image id in the build transcript" >&2; exit 1; }
  sed -i '' -E "s#fcpi/$i@sha256:[0-9a-f]{64}#fcpi/$i@$id#" "$root/deploy/compose.yaml"
  # The lock (CLAUDE.md §22) names the same image; it round-trips through JSON.stringify(…, null, 2) byte for byte.
  node -e 'const fs = require("fs"), [f, key, id, commit, ev] = process.argv.slice(1); const l = JSON.parse(fs.readFileSync(f, "utf8"));
    if (!l.images[key]) throw new Error(`no lock entry ${key}`); Object.assign(l.images[key], { image_id: id, built_from_commit: commit, evidence: ev });
    fs.writeFileSync(f, JSON.stringify(l, null, 2) + "
");' "$root/deploy/versions.lock.json" "${i//-/_}" "$id" "$(git -C "$root" rev-parse HEAD)" \
    evidence/post-m9/retrieval-quality/raw/image-build.txt
  echo "$i -> $id"
done
if git -C "$root" diff --quiet -- deploy/compose.yaml; then echo "digests unchanged"; exit 0; fi
git -C "$root" add deploy/compose.yaml deploy/versions.lock.json
git -C "$root" commit -q -m "Run the service images built from $built"
"$root/scripts/m1/deploy.sh" | tail -1 | redact
echo "deployed; now: ssh … 'bash /opt/firecrawl-pi/scripts/m8/pi-up-m8.sh'"
