#!/usr/bin/env bash
# The search intelligence cutover on the Pi, and its rollback (docs/FIRECRAWL_PI_SEARCH_INTELLIGENCE_SPEC.md §26, SI6): with the
# deployed commit's pins, apply the retrieval schema (additive and idempotent, scripts/m2/pi-retrieval-db.sh) and recreate the
# four services the release changes, the core, the retrieval service, the gateway and the MCP gateway, once no job is in
# flight and no metered call holds a reservation. Run after scripts/m1/deploy.sh has deployed the release commit, or the
# rollback commit, whose pins name the images to run:
#   ssh … 'bash -s' < scripts/si6/pi-cutover.sh > evidence/search-intelligence/SI6/raw/cutover.txt
# Refuses (exit 2) while work is in flight. Every command has its own stdin, since bash -s reads this script from stdin; the
# caller checks the end marker, not only the exit status.
set -euo pipefail
export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
REPO=/opt/firecrawl-pi
sec() { printf '### %s\n' "$1"; }
PG=$(sudo -n docker ps -q --filter label=com.docker.compose.project=fcpi --filter label=com.docker.compose.service=nuq-postgres </dev/null)
[ -n "$PG" ] || { echo "nuq-postgres is not running" >&2; exit 1; }
q() { sudo -n docker exec -i "$PG" psql -U postgres -d postgres -v ON_ERROR_STOP=1 -q -X -At; }

sec meta
echo "utc=$(date -u +%Y-%m-%dT%H:%M:%SZ) deployed_commit=$(cat $REPO/.fcpi-source-commit)"

sec quiet
jobs=$(echo "SELECT count(*) FROM fcpi_platform.job WHERE state IN ('RECEIVED', 'SUBMITTING', 'SUBMISSION_UNCERTAIN', 'QUEUED', 'RUNNING');" | q)
held=$(echo "SELECT count(*) FROM fcpi_retrieval.budget_reservation WHERE state = 'RESERVED';" | q)
echo "in_flight_jobs=$jobs reserved_rows=$held"
if [ "$jobs" != 0 ] || [ "$held" != 0 ]; then echo "end_marker=refused reason=work_in_flight"; exit 2; fi

sec schema
bash $REPO/scripts/m2/pi-retrieval-db.sh </dev/null

sec recreate
set +e
sudo -n docker compose -p fcpi -f $REPO/deploy/compose.yaml up -d --no-deps --wait --force-recreate firecrawl-core retrieval-service access-gateway mcp-gateway </dev/null 2>&1
rc=$?
set -e
echo "compose_exit=$rc"

sec state
for s in firecrawl-core retrieval-service access-gateway mcp-gateway; do
  id=$(sudo -n docker ps -q --filter label=com.docker.compose.project=fcpi --filter label=com.docker.compose.service=$s </dev/null)
  sudo -n docker inspect "$id" --format "$s image={{.Image}} health={{.State.Health.Status}}" </dev/null
done
echo "search_profile=$(jq -r '.searching.profile // "legacy"' $REPO/deploy/policies/budget.json)"
[ "$rc" = 0 ] || { echo "end_marker=failed reason=compose_exit_$rc"; exit 1; }
echo "end_marker=reached utc=$(date -u +%Y-%m-%dT%H:%M:%SZ)"
