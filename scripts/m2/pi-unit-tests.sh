#!/usr/bin/env bash
# The retrieval service's unit tests, ON the Pi, inside the image the stack runs:
#   ssh … 'bash -s' < scripts/m2/pi-unit-tests.sh
# The image is the one deploy/compose.yaml names for retrieval-service; the tests, fixtures and
# policy are the deployed commit's, mounted read-only. The container has no network, a read-only
# root filesystem, no capabilities and the service's uid, and is removed afterwards.
set -uo pipefail
export LC_ALL=C
export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
REPO=/opt/firecrawl-pi
D() { sudo -n docker "$@"; }
image=$(sed -n 's#^ *image: \(fcpi/retrieval@sha256:[0-9a-f]\{64\}\)$#\1#p' "$REPO/deploy/compose.yaml")
echo "### meta"
echo "utc=$(date -u +%Y-%m-%dT%H:%M:%SZ) source_commit=$(cat $REPO/.fcpi-source-commit) image=${image:-absent}"
[ -n "$image" ] || { echo "no retrieval image in compose.yaml"; exit 1; }
echo "### tap"
D run --rm --network none --read-only --cap-drop ALL --security-opt no-new-privileges:true --user 3310:3310 \
  --label fcpi.transient=unit-tests \
  -v "$REPO/services/retrieval/test:/srv/retrieval/test:ro" \
  -v "$REPO/tests/fixtures:/srv/retrieval/fixtures:ro" \
  -v "$REPO/deploy/policies:/srv/retrieval/policy:ro" \
  "$image" sh -c 'node --test test/*.test.mjs' 2>&1
echo "test_exit=$?"
echo "### transient"
echo "leftover_transient_containers=$(D ps -aq --filter label=fcpi.transient | wc -l)"
echo "### end"
echo end
