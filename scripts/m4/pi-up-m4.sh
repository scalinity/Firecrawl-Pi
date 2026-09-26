#!/usr/bin/env bash
# Bring the stack to M4's Compose file, ON the Pi:
#   1. the fail-closed data check (read-only), which also proves every bind source exists;
#   2. everything, waiting for health: the gateway recreated on its new image and fcpi_mcp, the MCP
#      service created on fcpi_mcp, every other service unchanged;
#   3. the M3 fixture recreated, so it serves the /big page M4 added (its bind-mounted server file
#      changed, which Compose alone does not see).
# Never removes a volume.   ssh … 'bash /opt/firecrawl-pi/scripts/m4/pi-up-m4.sh'
set -euo pipefail
export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
REPO=/opt/firecrawl-pi
C=(sudo -n docker compose -p fcpi -f $REPO/deploy/compose.yaml)
sec() { printf '### %s\n' "$1"; }

sec meta
echo "utc=$(date -u +%Y-%m-%dT%H:%M:%SZ) source_commit=$(cat $REPO/.fcpi-source-commit)"
sec data_check
sudo -n sh $REPO/deploy/host/fcpi-data-check.sh
sec up
"${C[@]}" up -d --wait --wait-timeout 900 2>&1 | tail -6
sec fixture
"${C[@]}" up -d --wait --wait-timeout 120 --force-recreate --no-deps fixture-m3 2>&1 | tail -2
sec ps
"${C[@]}" ps -a --format '{{.Service}} {{.State}} {{.Health}} {{.Image}}'
echo end
