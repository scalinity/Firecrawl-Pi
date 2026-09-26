#!/usr/bin/env bash
# One memory sample, as a JSON line: the cgroups of the services M5 changes or adds (the retrieval service,
# SearXNG, the access gateway, the MCP service, the core) with instance, start time, memory.peak,
# memory.max, memory.current and oom_kill (null for a container not running), the host's oom_kill count
# since boot and MemAvailable. A cgroup's peak lives as long as its container, so the driver samples before
# every stop that would start a new one and at the end of each phase. Read-only. Runs ON the Pi:
#   ssh … 'bash /opt/firecrawl-pi/scripts/m5/pi-resources.sh <label>'
set -uo pipefail
export LC_ALL=C
export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
label=${1:-}
[[ $label =~ ^[a-z0-9-]{1,64}$ ]] || { echo "usage: pi-resources.sh <label: lowercase letters, digits, hyphens>" >&2; exit 2; }
cg() { # cg <compose service>: its running container's cgroup, or null
  local c id p
  c=$(sudo -n docker ps -q --filter label=com.docker.compose.project=fcpi --filter "label=com.docker.compose.service=$1")
  [ -n "$c" ] || { printf 'null'; return; }
  id=$(sudo -n docker inspect -f '{{.Id}}' "$c"); p=/sys/fs/cgroup/system.slice/docker-$id.scope
  printf '{"instance":"%s","started_at":"%s","peak":%s,"max":"%s","current":%s,"oom_kill":%s}' "${id:0:12}" "$(sudo -n docker inspect -f '{{.State.StartedAt}}' "$c")" \
    "$(cat "$p/memory.peak")" "$(cat "$p/memory.max")" "$(cat "$p/memory.current")" "$(awk '$1 == "oom_kill" {print $2}' "$p/memory.events")"
}
printf '{"label":"%s","utc":"%s","retrieval":%s,"searxng":%s,"gateway":%s,"mcp":%s,"core":%s,"vmstat_oom_kill":%s,"mem_available_kib":%s}\n' "$label" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
  "$(cg retrieval-service)" "$(cg searxng)" "$(cg access-gateway)" "$(cg mcp-gateway)" "$(cg firecrawl-core)" "$(awk '$1 == "oom_kill" {print $2}' /proc/vmstat)" "$(awk '/^MemAvailable:/ {print $2}' /proc/meminfo)"
