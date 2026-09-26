#!/usr/bin/env bash
# The retrieval service's unit tests, ON the Pi, inside the image the stack runs:
#   ssh … 'bash -s' < scripts/m2/pi-unit-tests.sh
# The image is the one deploy/compose.yaml names for retrieval-service; the tests, fixtures, policy
# and schema are the deployed commit's, mounted read-only. The Store's SQL tests get a throwaway
# PostgreSQL (the pinned postgres base image, data in tmpfs, trust authentication) on an internal
# network of their own; the test container has no capabilities, a read-only root and the service
# uid. Every throwaway container and network carries the label fcpi.transient and is removed.
set -uo pipefail
export LC_ALL=C
export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
REPO=/opt/firecrawl-pi
D() { sudo -n docker "$@"; }
image=$(sed -n 's#^ *image: \(fcpi/retrieval@sha256:[0-9a-f]\{64\}\)$#\1#p' "$REPO/deploy/compose.yaml")
PGIMG=$(jq -r '.images.nuq_postgres_base.selected | "postgres@\(.arm64_manifest_digest)"' "$REPO/deploy/versions.lock.json")
N=fcpi-unit-$$
echo "### meta"
echo "utc=$(date -u +%Y-%m-%dT%H:%M:%SZ) source_commit=$(cat $REPO/.fcpi-source-commit) image=${image:-absent} test_postgres=$PGIMG"
[ -n "$image" ] || { echo "no retrieval image in compose.yaml"; exit 1; }
D network create --internal --label fcpi.transient=unit-tests "$N" >/dev/null
D run -d --rm --name "$N-pg" --network "$N" --label fcpi.transient=unit-tests --tmpfs /var/lib/postgresql/data --tmpfs /var/run/postgresql \
  -e POSTGRES_HOST_AUTH_METHOD=trust "$PGIMG" >/dev/null
for _ in $(seq 1 90); do D exec "$N-pg" pg_isready -U postgres -q 2>/dev/null && break; sleep 1; done
sleep 1
echo "### tap"
D run --rm --network "$N" --read-only --cap-drop ALL --security-opt no-new-privileges:true --user 3310:3310 \
  --label fcpi.transient=unit-tests -e FCPI_TEST_PG="$N-pg" \
  -v "$REPO/services/retrieval/test:/srv/retrieval/test:ro" \
  -v "$REPO/tests/fixtures:/srv/retrieval/fixtures:ro" \
  -v "$REPO/deploy/policies:/srv/retrieval/policy:ro" \
  -v "$REPO/deploy/nuq-postgres/fcpi-retrieval-schema.sql:/srv/retrieval/schema.sql:ro" \
  "$image" sh -c 'node --test --test-timeout=60000 test/*.test.mjs' 2>&1
echo "test_exit=$?"
D rm -f "$N-pg" >/dev/null 2>&1; D network rm "$N" >/dev/null 2>&1
echo "### transient"
echo "leftover_transient_containers=$(D ps -aq --filter label=fcpi.transient | wc -l) leftover_transient_networks=$(D network ls -q --filter label=fcpi.transient | wc -l)"
echo "### end"
echo end
