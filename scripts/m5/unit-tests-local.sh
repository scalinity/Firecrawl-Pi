#!/usr/bin/env bash
# The retrieval service's unit tests on the workstation's Colima VM, laid out as scripts/m2/pi-unit-tests.sh
# lays them out on the Pi: the service image built from the working tree (tagged fcpi/retrieval:local, never
# deployed), the tests, fixtures, policies and schema mounted read-only, and a throwaway PostgreSQL (the
# pinned base image, data in tmpfs, trust authentication) on an internal network of its own. Every
# throwaway container and network carries the label fcpi.transient and is removed (CLAUDE.md §33.7).
#   scripts/m5/unit-tests-local.sh [test-file-glob]
set -uo pipefail
root=$(cd "$(dirname "$0")/../.." && pwd)
glob=${1:-test/*.test.mjs}
D() { docker --context colima "$@"; }
PGIMG=$(jq -r '.images.nuq_postgres_base.selected | "postgres@\(.arm64_manifest_digest)"' "$root/deploy/versions.lock.json")
N=fcpi-unit-local-$$
cleanup() { D rm -f "$N-pg" >/dev/null 2>&1; D network rm "$N" >/dev/null 2>&1; }
trap cleanup EXIT
D build -q --platform linux/arm64 -t fcpi/retrieval:local "$root/services/retrieval" >/dev/null || { echo "image build failed"; exit 1; }
D network create --internal --label fcpi.transient=unit-tests-local "$N" >/dev/null
D run -d --rm --name "$N-pg" --network "$N" --label fcpi.transient=unit-tests-local --tmpfs /var/lib/postgresql/data --tmpfs /var/run/postgresql \
  -e POSTGRES_HOST_AUTH_METHOD=trust "$PGIMG" >/dev/null
for _ in $(seq 1 90); do D exec "$N-pg" pg_isready -U postgres -q 2>/dev/null && break; sleep 1; done
sleep 1
D run --rm --network "$N" --read-only --cap-drop ALL --security-opt no-new-privileges:true --user 3310:3310 --tmpfs /tmp \
  --label fcpi.transient=unit-tests-local -e FCPI_TEST_PG="$N-pg" \
  -v "$root/services/retrieval/test:/srv/retrieval/test:ro" \
  -v "$root/tests/fixtures:/srv/retrieval/fixtures:ro" \
  -v "$root/deploy/policies:/srv/retrieval/policy:ro" \
  -v "$root/deploy/nuq-postgres/fcpi-retrieval-schema.sql:/srv/retrieval/schema.sql:ro" \
  fcpi/retrieval:local sh -c "node --test --test-timeout=120000 $glob" 2>&1
rc=$?
echo "test_exit=$rc"
exit $rc
