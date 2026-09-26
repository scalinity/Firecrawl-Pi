#!/usr/bin/env bash
# Carry the patched API image built on the workstation's Colima VM (scripts/m2/build-api-image.sh, decision
# D6) to the Pi: docker save on the VM, streamed over SSH into docker load on the Pi, and the image ID the Pi
# now holds compared with the one the build recorded. Nothing is written to disk on either side.
#   scripts/m5/push-api-image.sh <build-log>
set -euo pipefail
root=$(cd "$(dirname "$0")/../.." && pwd)
. "$root/scripts/m1/pi-target.conf"
log=${1:?usage: push-api-image.sh <build-log>}
id=$(sed -n 's/^fcpi\/firecrawl-api:m2 id=\(sha256:[0-9a-f]\{64\}\) .*/\1/p; s/^id=\(sha256:[0-9a-f]\{64\}\) .*/\1/p' "$log" | tail -1)
[[ $id =~ ^sha256:[0-9a-f]{64}$ ]] || { echo "no image id in $log" >&2; exit 1; }
[ "$(docker --context colima image inspect fcpi/firecrawl-api:m2 --format '{{.Id}}')" = "$id" ] || { echo "the VM's fcpi/firecrawl-api:m2 is not the logged build" >&2; exit 1; }
echo "### push"
echo "utc=$(date -u +%Y-%m-%dT%H:%M:%SZ) image=$id"
docker --context colima save fcpi/firecrawl-api:m2 | ssh -i "$PI_SSH_KEY" -o IdentitiesOnly=yes -o BatchMode=yes "$PI_SSH_TARGET" 'sudo -n docker load' | sed 's/^/pi: /'
got=$(ssh -i "$PI_SSH_KEY" -o IdentitiesOnly=yes -o BatchMode=yes "$PI_SSH_TARGET" 'sudo -n docker image inspect fcpi/firecrawl-api:m2 --format "{{.Id}} {{.Architecture}}"')
echo "pi_image=$got"
[ "${got%% *}" = "$id" ] || { echo "the Pi holds ${got%% *}, not $id" >&2; exit 1; }
echo "### end"
