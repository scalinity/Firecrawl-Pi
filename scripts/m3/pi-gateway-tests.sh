#!/usr/bin/env bash
# The gateway's unit tests and contract suite, ON the Pi, inside the image the stack runs (the pinned
# Node 22.23.3):   ssh … 'bash -s' < scripts/m3/pi-gateway-tests.sh
# The image is the one deploy/compose.yaml names for access-gateway; the tests, the manifest and the
# platform schema are the deployed commit's, mounted read-only. The ledger's tests get a throwaway
# PostgreSQL (the pinned postgres base image, data in tmpfs, trust authentication) on an internal
# network of their own; the test container has no capabilities, a read-only root with a tmpfs /tmp and
# the gateway's uid. Every throwaway container and network carries the label fcpi.transient and is removed.
set -uo pipefail
export LC_ALL=C
export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
REPO=/opt/firecrawl-pi
D() { sudo -n docker "$@"; }
image=$(sed -n 's#^ *image: \(fcpi/access-gateway@sha256:[0-9a-f]\{64\}\)$#\1#p' "$REPO/deploy/compose.yaml")
PGIMG=$(jq -r '.images.nuq_postgres_base.selected | "postgres@\(.arm64_manifest_digest)"' "$REPO/deploy/versions.lock.json")
N=fcpi-gwtest-$$
# The throwaway PostgreSQL and network go however the script ends (an SSH session that drops included).
trap 'sudo -n docker rm -f "$N-pg" >/dev/null 2>&1; sudo -n docker network rm "$N" >/dev/null 2>&1' EXIT
echo "### meta"
echo "utc=$(date -u +%Y-%m-%dT%H:%M:%SZ) source_commit=$(cat $REPO/.fcpi-source-commit) image=${image:-absent} test_postgres=$PGIMG"
[ -n "$image" ] || { echo "no gateway image in compose.yaml"; exit 1; }
# NetworkManager leaves project fcpi-* bridges unmanaged; a default br-* bridge
# can otherwise become an unintended host network configuration change.
D network create --internal -o com.docker.network.bridge.name=fcpi-g$$ -o com.docker.network.bridge.gateway_mode_ipv4=isolated --label fcpi.transient=gateway-tests "$N" >/dev/null
D run -d --rm --name "$N-pg" --network "$N" --label fcpi.transient=gateway-tests --read-only --user 999:999 --cgroup-parent fcpi.slice \
  --cap-drop ALL --security-opt no-new-privileges:true --memory 192m --memory-swap 192m --cpus 0.3 --pids-limit 64 \
  --tmpfs /var/lib/postgresql/data:uid=999,gid=999,mode=0700,size=256m --tmpfs /var/run/postgresql:uid=999,gid=999,mode=0700,size=8m --tmpfs /tmp:size=16m \
  -e POSTGRES_HOST_AUTH_METHOD=trust "$PGIMG" >/dev/null
# Over TCP: the entrypoint's temporary init server listens on the socket only, so this waits for the real one.
for _ in $(seq 1 90); do D exec "$N-pg" pg_isready -h 127.0.0.1 -U postgres -q 2>/dev/null && break; sleep 1; done
sleep 1
run() { # run <section> <command…>: one node --test run in the gateway image
  local s=$1; shift
  echo "### $s"
  D run --rm --network "$N" --read-only --tmpfs /tmp:size=64m --cap-drop ALL --security-opt no-new-privileges:true --user 3380:3380 \
    --cgroup-parent fcpi.slice --memory 384m --memory-swap 384m --cpus 0.5 --pids-limit 64 \
    --label fcpi.transient=gateway-tests -e FCPI_TEST_PG="$N-pg" -e FCPI_GATEWAY_DIR=/srv/access \
    -e FCPI_TEST_MANIFEST=/srv/policy/capabilities.json -e FCPI_TEST_SCHEMA=/srv/schema.sql \
    -v "$REPO/services/access/test:/srv/access/test:ro" \
    -v "$REPO/tests/contracts/m3-gateway.test.mjs:/srv/contracts/m3-gateway.test.mjs:ro" \
    -v "$REPO/deploy/policies/capabilities.json:/srv/policy/capabilities.json:ro" \
    -v "$REPO/deploy/nuq-postgres/fcpi-platform-schema.sql:/srv/schema.sql:ro" \
    "$image" "$@" 2>&1
  echo "test_exit=$?"
}
run unit_tap node --test --test-reporter=tap --test-timeout=60000 test/validate.test.mjs test/auth.test.mjs test/archive.test.mjs
run contract_tap node --test --test-reporter=tap --test-timeout=120000 /srv/contracts/m3-gateway.test.mjs
echo "node_version=$(D run --rm --network none --read-only --user 3380:3380 --cap-drop ALL --security-opt no-new-privileges:true --cgroup-parent fcpi.slice --memory 64m --memory-swap 64m --cpus 0.2 --pids-limit 32 --label fcpi.transient=gateway-tests "$image" node --version 2>&1)"
D rm -f "$N-pg" >/dev/null 2>&1; D network rm "$N" >/dev/null 2>&1
echo "### transient"
echo "leftover_transient_containers=$(D ps -aq --filter label=fcpi.transient | wc -l) leftover_transient_networks=$(D network ls -q --filter label=fcpi.transient | wc -l)"
echo "### end"
echo end
