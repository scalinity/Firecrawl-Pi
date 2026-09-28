#!/usr/bin/env bash
# Bring the stack to M8's Compose file, ON the Pi:
#   1. the fail-closed data check (read-only), which also proves every bind source exists (the admission directory too);
#   2. every service recreated under fcpi.slice, waiting for health;
#   3. every container's cgroup parent and effective swap limit (the scope's and the slice's memory.swap.max);
#   4. the running release recorded (fcpi release), for fcpi rollback --plan.
# Never removes a volume.   ssh … 'bash /opt/firecrawl-pi/scripts/m8/pi-up-m8.sh'
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
sec up
"${C[@]}" up -d --wait --wait-timeout 900 --force-recreate 2>&1 | tail -8
sec swap
for c in $(sudo -n docker ps -q --filter label=com.docker.compose.project=fcpi); do
  read -r svc parent id < <(sudo -n docker inspect -f '{{index .Config.Labels "com.docker.compose.service"}} {{.HostConfig.CgroupParent}} {{.Id}}' "$c")
  echo "$svc parent=$parent scope_swap_max=$(cat /sys/fs/cgroup/$parent/docker-$id.scope/memory.swap.max) slice_swap_max=$(cat /sys/fs/cgroup/$parent/memory.swap.max)"
done
sec release
sudo -n /opt/firecrawl-pi/scripts/fcpi release
sec ps
"${C[@]}" ps -a --format '{{.Service}} {{.State}} {{.Health}} {{.Image}}'
echo end
