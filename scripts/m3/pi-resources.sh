#!/usr/bin/env bash
# One memory sample, as a JSON line: the access gateway's and the core's cgroups (instance, start time,
# memory.peak, memory.max, memory.current and oom_kill, or null for a container that is not running),
# the host's oom_kill count since boot (/proc/vmstat) and MemAvailable. A cgroup's peak lives as long as
# its container runs, so the drivers take a sample at the end of every phase and before every kill,
# stop or recreate that would start a new one (M01). Read-only. Runs ON the Pi:
#   ssh … 'bash /opt/firecrawl-pi/scripts/m3/pi-resources.sh <label>'
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
printf '{"label":"%s","utc":"%s","gateway":%s,"core":%s,"vmstat_oom_kill":%s,"mem_available_kib":%s}\n' "$label" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
  "$(cg access-gateway)" "$(cg firecrawl-core)" "$(awk '$1 == "oom_kill" {print $2}' /proc/vmstat)" "$(awk '/^MemAvailable:/ {print $2}' /proc/meminfo)"
