#!/usr/bin/env bash
# Bring the stack to M7's Compose file, ON the Pi:
#   1. the fail-closed data check (read-only), which also proves every bind source exists;
#   2. the retrieval schema (M7's enhanced ledger kind) and the platform schema (version 3: artifacts, the scrape cache,
#      page versions and the webhook outbox), applied as the superuser over the local socket by M2's and M3's idempotent
#      scripts;
#   3. every service recreated, waiting for health (a new container gets its memory.swap.max applied again, which a
#      systemd reload lifts: evidence/M4/review/REVIEW.md, F2);
#   4. every container's memory.swap.max, which must be 0.
# Never removes a volume.   ssh … 'bash /opt/firecrawl-pi/scripts/m7/pi-up-m7.sh'
set -euo pipefail
export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
REPO=/opt/firecrawl-pi
C=(sudo -n docker compose -p fcpi -f $REPO/deploy/compose.yaml)
sec() { printf '### %s\n' "$1"; }
sec meta
echo "utc=$(date -u +%Y-%m-%dT%H:%M:%SZ) source_commit=$(cat $REPO/.fcpi-source-commit)"
sec data_check
sudo -n sh $REPO/deploy/host/fcpi-data-check.sh
sec config
"${C[@]}" config -q && echo "compose_config=valid"
sec retrieval_schema
bash $REPO/scripts/m2/pi-retrieval-db.sh | sed -n '/^### schema/,/^### rights/p' | grep -v '^### rights'
PG=$(sudo -n docker ps -q --filter label=com.docker.compose.project=fcpi --filter label=com.docker.compose.service=nuq-postgres)
echo "kind_check=$(sudo -n docker exec -i "$PG" psql -U postgres -d postgres -At -X -c "SELECT pg_get_constraintdef(oid) FROM pg_constraint WHERE conname = 'budget_reservation_kind_check'")"
sec platform_schema
bash $REPO/scripts/m3/pi-platform-db.sh >/dev/null && echo "platform_schema=applied"
echo "platform_version=$(sudo -n docker exec -i "$PG" psql -U postgres -d postgres -At -X -c "SELECT max(version) FROM fcpi_platform.schema_version")"
echo "m7_tables=$(sudo -n docker exec -i "$PG" psql -U postgres -d postgres -At -X -c "SELECT string_agg(relname, ',' ORDER BY relname) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'fcpi_platform' AND relkind = 'r' AND relname IN ('artifact', 'page_cache', 'page_version', 'webhook_event')")"
sec up
"${C[@]}" up -d --wait --wait-timeout 900 --force-recreate 2>&1 | tail -8
sec swap
for c in $(sudo -n docker ps -q --filter label=com.docker.compose.project=fcpi); do
  echo "$(sudo -n docker inspect -f '{{index .Config.Labels "com.docker.compose.service"}}' "$c") memory.swap.max=$(cat /sys/fs/cgroup/system.slice/docker-$(sudo -n docker inspect -f '{{.Id}}' "$c").scope/memory.swap.max)"
done
sec ps
"${C[@]}" ps -a --format '{{.Service}} {{.State}} {{.Health}} {{.Image}}'
echo end
