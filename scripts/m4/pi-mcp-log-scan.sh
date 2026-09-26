#!/usr/bin/env bash
# The MCP service's log, counted only (spec §24: no secret, authorization value, Cloud host, target URL
# or scraped content in logs), for the container that runs now: its identity and start, how many lines,
# exchange, serve and tool records it holds, how many listening events (one per process start: a restart
# keeps the container's log), whether its first line is still a start's first event (nothing rotated
# away), and a count per forbidden pattern. Nothing from the log itself is printed. Read-only, ON the Pi:
#   bash /opt/firecrawl-pi/scripts/m4/pi-mcp-log-scan.sh
set -uo pipefail
export LC_ALL=C
export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
c=$(sudo -n docker ps -aq --filter label=com.docker.compose.project=fcpi --filter label=com.docker.compose.service=mcp-gateway)
[ -n "$c" ] && [ "$(printf '%s\n' "$c" | wc -l)" -eq 1 ] || { echo "scan=failed reason=not-exactly-one-mcp-container"; exit 1; }
L=$(sudo -n docker logs "$c" 2>&1)
first_event=$(printf '%s\n' "$L" | head -1 | jq -r '.event // "none"' 2>/dev/null || echo unreadable)
n() { printf '%s\n' "$L" | grep -c "$1"; }
echo "instance=$(sudo -n docker inspect -f '{{.Id}}' "$c" | cut -c1-12) created=$(sudo -n docker inspect -f '{{.Created}}' "$c") started=$(sudo -n docker inspect -f '{{.State.StartedAt}}' "$c") lines=$(printf '%s\n' "$L" | grep -c .) exchange_records=$(n '"event":"exchange"') serve_records=$(n '"event":"serve"') tool_records=$(n '"event":"tool"') starts=$(n '"event":"listening"') first_event=$first_event"
for pat in 'firecrawl\.dev' 'firecrawl\.com' 'mendable' 'fcpi_[a-z0-9]+_[0-9a-f]{64}' 'Bearer [A-Za-z0-9]' '[Aa]uthorization' 'm3\.fixture\.fcpi\.test' 'fcpi-m3-[a-z0-9]+-[0-9a-f]{4}'; do
  echo "pattern=$pat count=$(printf '%s\n' "$L" | grep -cE "$pat")"
done
