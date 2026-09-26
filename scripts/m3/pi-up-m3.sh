#!/usr/bin/env bash
# Bring the stack to M3's Compose file, ON the Pi, in the order its pieces need:
#   1. the fail-closed data check (read-only), which also proves every bind source exists;
#   2. PostgreSQL, recreated onto fcpi_platform with the platform schema's initdb files;
#   3. the platform schema and the gateway's role on the existing data directory (pi-platform-db.sh),
#      before any gateway that needs them runs;
#   4. the retrieval service, recreated so it reads the policy with M3's fixture host (it loads the
#      policy at start, and a single-file bind mount keeps the old file's inode);
#   5. everything else (the gateway on its new image, the M3 fixture), waiting for health.
# Never removes a volume.   ssh … 'bash /opt/firecrawl-pi/scripts/m3/pi-up-m3.sh'
set -euo pipefail
export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
REPO=/opt/firecrawl-pi
C=(sudo -n docker compose -p fcpi -f $REPO/deploy/compose.yaml)
sec() { printf '### %s\n' "$1"; }

sec meta
echo "utc=$(date -u +%Y-%m-%dT%H:%M:%SZ) source_commit=$(cat $REPO/.fcpi-source-commit)"
sec data_check
sudo -n sh $REPO/deploy/host/fcpi-data-check.sh
sec postgres
"${C[@]}" up -d --wait --wait-timeout 300 nuq-postgres 2>&1 | tail -3
sec platform_db
bash $REPO/scripts/m3/pi-platform-db.sh | sed -n '/^### schema/,/^### rights/p' | grep -v '^### rights'
sec retrieval
"${C[@]}" up -d --wait --wait-timeout 300 --force-recreate --no-deps retrieval-service 2>&1 | tail -3
sec up
"${C[@]}" up -d --wait --wait-timeout 900 2>&1 | tail -5
sec ps
"${C[@]}" ps -a --format '{{.Service}} {{.State}} {{.Health}} {{.Image}}'
echo end
