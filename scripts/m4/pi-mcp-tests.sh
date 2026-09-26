#!/usr/bin/env bash
# M4's suites ON the Pi, inside the images the stack runs (the pinned Node 22.23.3):
#   ssh … 'bash -s' < scripts/m4/pi-mcp-tests.sh
#   - the MCP service's unit and integration tests in the image deploy/compose.yaml names for
#     mcp-gateway: the real server against a fake gateway over raw HTTP, both eras, loopback only;
#   - the access gateway's unit tests (the /mcp proxy's among them) and M3's contract suite, unchanged,
#     in the image compose.yaml names for access-gateway, with a throwaway PostgreSQL (the pinned
#     postgres base, data in tmpfs, trust authentication) on an internal network of its own.
# The tests and the manifest are the deployed commit's, mounted read-only; test containers have no
# capabilities, a read-only root with a tmpfs /tmp and the service's uid. Every throwaway container and
# network carries the label fcpi.transient and is removed.
set -uo pipefail
export LC_ALL=C
export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
REPO=/opt/firecrawl-pi
D() { sudo -n docker "$@"; }
img() { sed -n "s#^ *image: \(fcpi/$1@sha256:[0-9a-f]\{64\}\)\$#\1#p" "$REPO/deploy/compose.yaml"; }
MCP=$(img mcp-gateway); GW=$(img access-gateway)
PGIMG=$(jq -r '.images.nuq_postgres_base.selected | "postgres@\(.arm64_manifest_digest)"' "$REPO/deploy/versions.lock.json")
N=fcpi-m4test-$$
trap 'sudo -n docker rm -f "$N-pg" >/dev/null 2>&1; sudo -n docker network rm "$N" >/dev/null 2>&1' EXIT
echo "### meta"
echo "utc=$(date -u +%Y-%m-%dT%H:%M:%SZ) source_commit=$(cat $REPO/.fcpi-source-commit) mcp_image=${MCP:-absent} gateway_image=${GW:-absent} test_postgres=$PGIMG"
[ -n "$MCP" ] && [ -n "$GW" ] || { echo "an image is missing from compose.yaml"; exit 1; }

# The MCP service's suites need no network beyond loopback.
mcp_run() {
  local s=$1; shift
  echo "### $s"
  D run --rm --network none --read-only --tmpfs /tmp:size=64m --cap-drop ALL --security-opt no-new-privileges:true --user 3400:3400 \
    --label fcpi.transient=m4-tests -e FCPI_TEST_MANIFEST=/srv/policy/capabilities.json \
    -v "$REPO/services/mcp/test:/srv/mcp/test:ro" -v "$REPO/deploy/policies/capabilities.json:/srv/policy/capabilities.json:ro" \
    "$MCP" "$@" 2>&1
  echo "test_exit=$?"
}
mcp_run mcp_tap node --test --test-reporter=tap --test-timeout=60000 test/tools.test.mjs test/server.test.mjs

D network create --internal --label fcpi.transient=m4-tests "$N" >/dev/null
D run -d --rm --name "$N-pg" --network "$N" --label fcpi.transient=m4-tests --tmpfs /var/lib/postgresql/data --tmpfs /var/run/postgresql \
  -e POSTGRES_HOST_AUTH_METHOD=trust "$PGIMG" >/dev/null
for _ in $(seq 1 90); do D exec "$N-pg" pg_isready -h 127.0.0.1 -U postgres -q 2>/dev/null && break; sleep 1; done
sleep 1
gw_run() {
  local s=$1; shift
  echo "### $s"
  D run --rm --network "$N" --read-only --tmpfs /tmp:size=64m --cap-drop ALL --security-opt no-new-privileges:true --user 3380:3380 \
    --label fcpi.transient=m4-tests -e FCPI_TEST_PG="$N-pg" -e FCPI_GATEWAY_DIR=/srv/access \
    -e FCPI_TEST_MANIFEST=/srv/policy/capabilities.json -e FCPI_TEST_SCHEMA=/srv/schema.sql \
    -v "$REPO/services/access/test:/srv/access/test:ro" \
    -v "$REPO/tests/contracts/m3-gateway.test.mjs:/srv/contracts/m3-gateway.test.mjs:ro" \
    -v "$REPO/deploy/policies/capabilities.json:/srv/policy/capabilities.json:ro" \
    -v "$REPO/deploy/nuq-postgres/fcpi-platform-schema.sql:/srv/schema.sql:ro" \
    "$GW" "$@" 2>&1
  echo "test_exit=$?"
}
gw_run gateway_unit_tap node --test --test-reporter=tap --test-timeout=60000 test/validate.test.mjs test/auth.test.mjs test/archive.test.mjs test/mcp.test.mjs
gw_run gateway_contract_tap node --test --test-reporter=tap --test-timeout=120000 /srv/contracts/m3-gateway.test.mjs
echo "node_versions=mcp:$(D run --rm --network none --label fcpi.transient=m4-tests "$MCP" node --version 2>&1),gateway:$(D run --rm --network none --label fcpi.transient=m4-tests "$GW" node --version 2>&1)"
D rm -f "$N-pg" >/dev/null 2>&1; D network rm "$N" >/dev/null 2>&1
echo "### transient"
echo "leftover_transient_containers=$(D ps -aq --filter label=fcpi.transient | wc -l) leftover_transient_networks=$(D network ls -q --filter label=fcpi.transient | wc -l)"
echo "### end"
echo end
