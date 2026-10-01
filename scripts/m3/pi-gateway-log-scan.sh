#!/usr/bin/env bash
# The access gateway's log, counted only (spec §24: no secret, authorization value, Cloud host or target
# URL in logs), for the container that runs now: its identity and creation time, how many lines and
# request and job records it holds, whether its first line is still the start's first event,
# "clients_loaded" (the control that rotation dropped nothing), and a count per forbidden pattern. Nothing from the log itself
# is printed. Runs ON the Pi, read-only; scripts/m3/pi-persistence.sh calls it before it recreates the
# containers, so the instance that served the live phases is scanned before it goes, and
# scripts/m3/pi-collect-stack.sh at the end, for the instance that replaced it:
#   bash /opt/firecrawl-pi/scripts/m3/pi-gateway-log-scan.sh
set -uo pipefail
export LC_ALL=C
export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
c=$(sudo -n docker ps -aq --filter label=com.docker.compose.project=fcpi --filter label=com.docker.compose.service=access-gateway)
[ -n "$c" ] && [ "$(printf '%s\n' "$c" | wc -l)" -eq 1 ] || { echo "scan=failed reason=not-exactly-one-gateway-container"; exit 1; }
# Read past any NUL block a power cut left in docker's own log file, which `docker logs` would stop at (lib.sh).
L=$(sudo -n bash -c '. /opt/firecrawl-pi/scripts/ops/lib.sh; container_log "$1"' _ "$c")
# The first line by parameter expansion: `printf | head -1` can end printf with SIGPIPE on a long log, and
# under pipefail that failure appended a stray "unreadable" line (CLAUDE.md §33.6).
first=${L%%$'\n'*}
first_event=$(printf '%s\n' "$first" | jq -r '.event // "none"' 2>/dev/null || echo unreadable)
echo "instance=$(sudo -n docker inspect -f '{{.Id}}' "$c" | cut -c1-12) created=$(sudo -n docker inspect -f '{{.Created}}' "$c") started=$(sudo -n docker inspect -f '{{.State.StartedAt}}' "$c") lines=$(printf '%s\n' "$L" | grep -c .) request_records=$(printf '%s\n' "$L" | grep -c '"request_id"') job_records=$(printf '%s\n' "$L" | grep -c '"event":"job"') starts=$(printf '%s\n' "$L" | grep -c '"event":"listening"') first_event=$first_event"
for pat in 'firecrawl\.dev' 'firecrawl\.com' 'mendable' 'fcpi_[a-z0-9]+_[0-9a-f]{64}' 'Bearer [A-Za-z0-9]' '[Aa]uthorization' 'm3\.fixture\.fcpi\.test'; do
  echo "pattern=$pat count=$(printf '%s\n' "$L" | grep -cE "$pat")"
done
