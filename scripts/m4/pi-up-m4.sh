#!/usr/bin/env bash
# Bring the stack to M4's Compose file, ON the Pi:
#   1. the fail-closed data check (read-only), which also proves every bind source exists;
#   2. every service recreated, waiting for health: the gateway on its image and fcpi_mcp, the MCP
#      service on fcpi_mcp, the M3 fixture serving the /big page M4 added (its bind-mounted server file
#      changed, which Compose alone does not see), and every other container too, because a systemd
#      reload during the window reset every running container's memory.swap.max from 0 to max
#      (evidence/M4/review/REVIEW.md, F2): a new container gets its limits applied again;
#   3. every container's memory.swap.max, which must be 0 again.
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
"${C[@]}" up -d --wait --wait-timeout 900 --force-recreate 2>&1 | tail -6
sec swap
for c in $(sudo -n docker ps -q --filter label=com.docker.compose.project=fcpi); do
  echo "$(sudo -n docker inspect -f '{{index .Config.Labels "com.docker.compose.service"}}' "$c") memory.swap.max=$(cat /sys/fs/cgroup/system.slice/docker-$(sudo -n docker inspect -f '{{.Id}}' "$c").scope/memory.swap.max)"
done
sec ps
"${C[@]}" ps -a --format '{{.Service}} {{.State}} {{.Health}} {{.Image}}'
echo end
