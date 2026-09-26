#!/usr/bin/env bash
# M5's suites ON the Pi, inside the images the stack runs: the retrieval service's (budgets, extraction,
# parsing, search, the ledger's SQL against a throwaway PostgreSQL on an internal network of its own), then
# M4's runner unchanged (scripts/m4/pi-mcp-tests.sh: the MCP service's suites, the gateway's unit suites,
# M3's and M4's gateway contract suites and the grammars), since M5 changes both services. The
# tests, fixtures, policies and schema are the deployed commit's, mounted read-only; each test container has
# no network (the retrieval one only the throwaway database's), no capabilities, a read-only root with a
# small tmpfs, and the service's uid. Every throwaway container and network carries fcpi.transient and is
# removed.   ssh … 'bash -s' < scripts/m5/pi-suites.sh
set -uo pipefail
export LC_ALL=C
export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
REPO=/opt/firecrawl-pi
D() { sudo -n docker "$@"; }
img() { sed -n "s#^ *image: \($1@sha256:[0-9a-f]\{64\}\)\$#\1#p" "$REPO/deploy/compose.yaml"; }
RI=$(img fcpi/retrieval) GI=$(img fcpi/access-gateway) MI=$(img fcpi/mcp-gateway)
PGIMG=$(jq -r '.images.nuq_postgres_base.selected | "postgres@\(.arm64_manifest_digest)"' "$REPO/deploy/versions.lock.json")
N=fcpi-m5-suites-$$
echo "### meta"
echo "utc=$(date -u +%Y-%m-%dT%H:%M:%SZ) source_commit=$(cat $REPO/.fcpi-source-commit) retrieval_image=$RI gateway_image=$GI mcp_image=$MI test_postgres=$PGIMG"
RUN=(--rm --read-only --cap-drop ALL --security-opt no-new-privileges:true --tmpfs /tmp:size=64m --label fcpi.transient=m5-suites)
D network create --internal --label fcpi.transient=m5-suites "$N" >/dev/null
D run -d --rm --name "$N-pg" --network "$N" --label fcpi.transient=m5-suites --tmpfs /var/lib/postgresql/data --tmpfs /var/run/postgresql -e POSTGRES_HOST_AUTH_METHOD=trust "$PGIMG" >/dev/null
for _ in $(seq 1 90); do D exec "$N-pg" pg_isready -U postgres -q 2>/dev/null && break; sleep 1; done
sleep 1
echo "### retrieval_tap"
D run "${RUN[@]}" --network "$N" --user 3310:3310 -e FCPI_TEST_PG="$N-pg" \
  -v "$REPO/services/retrieval/test:/srv/retrieval/test:ro" -v "$REPO/tests/fixtures:/srv/retrieval/fixtures:ro" \
  -v "$REPO/deploy/policies:/srv/retrieval/policy:ro" -v "$REPO/deploy/nuq-postgres/fcpi-retrieval-schema.sql:/srv/retrieval/schema.sql:ro" \
  "$RI" sh -c 'node --version; node --test --test-timeout=120000 test/*.test.mjs' 2>&1
echo "test_exit=$?"
# The gateway ledger's version-1 to version-2 migration, in the gateway image against the same throwaway database.
echo "### ledger_migration_tap"
D run "${RUN[@]}" --network "$N" --user 3380:3380 -e FCPI_TEST_PG="$N-pg" -e FCPI_GATEWAY_DIR=/srv/access -e FCPI_TEST_SCHEMA=/srv/schema.sql \
  -v "$REPO/tests/contracts/m5-ledger-migration.test.mjs:/srv/contracts/m5-ledger-migration.test.mjs:ro" \
  -v "$REPO/deploy/nuq-postgres/fcpi-platform-schema.sql:/srv/schema.sql:ro" \
  "$GI" node --test --test-reporter=tap --test-timeout=60000 /srv/contracts/m5-ledger-migration.test.mjs 2>&1
echo "test_exit=$?"
D rm -f "$N-pg" >/dev/null 2>&1; D network rm "$N" >/dev/null 2>&1
echo "### gateway_m5_tap"
D run "${RUN[@]}" --network none --user 3380:3380 -v "$REPO/services/access/test:/srv/access/test:ro" "$GI" node --test --test-reporter=tap --test-timeout=60000 test/extract.test.mjs test/jsonscrape.test.mjs 2>&1
echo "test_exit=$?"
bash "$REPO/scripts/m4/pi-mcp-tests.sh" | sed -e 's/^### meta$/### m4_runner_meta/' -e '/^### end$/d' -e '/^end$/d'
echo "### transient"
echo "leftover_transient_containers=$(D ps -aq --filter label=fcpi.transient | wc -l) leftover_transient_networks=$(D network ls -q --filter label=fcpi.transient | wc -l)"
echo "### end"
echo end
