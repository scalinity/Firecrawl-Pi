#!/usr/bin/env bash
# Trusted candidate tests: a disposable PostgreSQL on an internal project-only
# network, no production credentials/state/ports, bounded memory and process count.
set -euo pipefail
. "$(dirname "$(readlink -f "$0")")/../ops/lib.sh"
need_root
tree=${1:?candidate worktree}
N=fcpi-incident-tests-$$
PG=$(jq -r '.images.nuq_postgres_base.selected.arm64_manifest_digest' "$REPO/deploy/versions.lock.json")
trap 'docker rm -f "$N-pg" >/dev/null 2>&1; docker network rm "$N" >/dev/null 2>&1' EXIT
docker network create --internal --label fcpi.transient=incident-tests -o com.docker.network.bridge.name=fcpi-i$$ -o com.docker.network.bridge.gateway_mode_ipv4=isolated "$N" >/dev/null
docker run -d --rm --name "$N-pg" --label fcpi.transient=incident-tests --network "$N" --read-only --user 999:999 --cgroup-parent fcpi.slice \
 --cap-drop ALL --security-opt no-new-privileges --memory 192m --memory-swap 192m --cpus 0.3 --pids-limit 64 \
 --tmpfs /var/lib/postgresql/data:uid=999,gid=999,mode=0700,size=256m --tmpfs /var/run/postgresql:uid=999,gid=999,mode=0700,size=8m --tmpfs /tmp:size=16m \
 -e POSTGRES_HOST_AUTH_METHOD=trust "postgres@$PG" >/dev/null
for _ in $(seq 1 60); do docker exec "$N-pg" pg_isready -U postgres -q && break; sleep 1; done
docker exec "$N-pg" pg_isready -U postgres -q
for component in access retrieval; do
 svc=access-gateway uid=3380; [ "$component" != retrieval ] || { svc=retrieval-service; uid=3310; }
 image=$(docker inspect -f '{{.Image}}' "$(cid "$svc")")
 timeout 180 docker run --rm --label fcpi.transient=incident-tests --network "$N" --read-only --user "$uid:$uid" --cgroup-parent fcpi.slice \
  --cap-drop ALL --security-opt no-new-privileges --memory 384m --memory-swap 384m --cpus 0.5 --pids-limit 64 --tmpfs /tmp:size=64m,mode=1777 \
  --mount "type=bind,source=$tree/services/$component/src,target=/srv/$component/src,readonly" \
  --mount "type=bind,source=$tree/services/$component/test,target=/srv/$component/test,readonly" \
  --mount "type=bind,source=$tree/tests/fixtures,target=/srv/$component/fixtures,readonly" \
  --mount "type=bind,source=$tree/deploy/policies,target=/srv/$component/policy,readonly" \
  --mount "type=bind,source=$tree/deploy/nuq-postgres,target=/srv/deploy/nuq-postgres,readonly" \
  --mount "type=bind,source=$tree/deploy/nuq-postgres/fcpi-retrieval-schema.sql,target=/srv/$component/schema.sql,readonly" \
  -e "FCPI_TEST_PG=$N-pg" -e FCPI_TEST_MANIFEST="/srv/$component/policy/capabilities.json" \
  "$image" sh -c 'node --test --test-reporter=tap --test-concurrency=1 --test-timeout=120000 test/*.test.mjs'
done
# Candidate-written contract tests are also executed. The gateway HTTP contract
# loads the real candidate server and verifies its privileged action boundary.
image=$(docker inspect -f '{{.Image}}' "$(cid access-gateway)")
timeout 180 docker run --rm --label fcpi.transient=incident-tests --network "$N" --read-only --user 3380:3380 --cgroup-parent fcpi.slice \
 --cap-drop ALL --security-opt no-new-privileges --memory 384m --memory-swap 384m --cpus 0.5 --pids-limit 64 --tmpfs /tmp:size=64m,mode=1777 \
 -v "$tree:/repo:ro" -v "$tree/services/access/server.mjs:/srv/access/server.mjs:ro" -v "$tree/services/access/src:/srv/access/src:ro" \
 -e "FCPI_TEST_PG=$N-pg" -e FCPI_GATEWAY_DIR=/srv/access -e FCPI_REPO_ROOT=/repo \
 -e FCPI_TEST_SCHEMA=/repo/deploy/nuq-postgres/fcpi-platform-schema.sql -e FCPI_TEST_MANIFEST=/repo/deploy/policies/capabilities.json \
 "$image" node --test --test-concurrency=1 --test-timeout=120000 /repo/tests/contracts/m4-gateway-mcp.test.mjs
# No arbitrary new executable test filenames are accepted for incident patches;
# changes to the explicitly trusted contract above are tested by that invocation.
while IFS= read -r -d '' p; do
 case $p in tests/contracts/*) [ "$p" = tests/contracts/m4-gateway-mcp.test.mjs ] || die 'new contract requires operator review/testing outside automatic apply' ;; esac
done < <(git -C "$tree" diff --name-only -z)
