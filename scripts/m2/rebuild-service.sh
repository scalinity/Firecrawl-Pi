#!/usr/bin/env bash
# Rebuild service images on the Pi from the committed HEAD and point deploy/compose.yaml at their
# new digests. Deploys HEAD first (scripts/m1/deploy.sh refuses uncommitted code), appends the
# build transcript to evidence/M2/raw/service-build.txt, and leaves compose.yaml changed for the
# caller to commit and deploy before `up`.
#   scripts/m2/rebuild-service.sh retrieval [browser]
set -euo pipefail
root=$(cd "$(dirname "$0")/../.." && pwd)
# shellcheck source=scripts/m1/pi-target.conf
. "$root/scripts/m1/pi-target.conf"
SSH=(ssh -i "$PI_SSH_KEY" -o IdentitiesOnly=yes -o BatchMode=yes -o ConnectTimeout=15 "$PI_SSH_TARGET")
[ $# -gt 0 ] || { echo "usage: rebuild-service.sh retrieval|browser …" >&2; exit 2; }
for s in "$@"; do case $s in retrieval|browser) ;; *) echo "unknown service $s" >&2; exit 2 ;; esac; done
"$root/scripts/m1/deploy.sh" | tail -1
out=$("${SSH[@]}" "bash -s -- $*" <"$root/scripts/m2/pi-build-service-images.sh")
printf '%s\n' "$out" >>"$root/evidence/M2/raw/service-build.txt"
for s in "$@"; do
  id=$(printf '%s\n' "$out" | sed -n "s#^fcpi/$s:m2 id=\(sha256:[0-9a-f]\{64\}\) .*#\1#p")
  [ -n "$id" ] || { echo "no image id for $s in the build transcript" >&2; exit 1; }
  sed -i '' -E "s#fcpi/$s@sha256:[0-9a-f]{64}#fcpi/$s@$id#" "$root/deploy/compose.yaml"
  echo "$s -> $id"
done
