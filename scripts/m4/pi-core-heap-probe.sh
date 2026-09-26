#!/usr/bin/env bash
# The core's heap on large pages, over REST, ON the Pi (evidence for the finding M4 defers to M8):
#   ssh … 'bash -s -- <kb> <formats-json> [<kb> <formats-json> …]' < scripts/m4/pi-core-heap-probe.sh
# Scrapes the M3 fixture's /big?kb=N page through the gateway for each pair in turn, waiting for the core
# to be healthy before each, and records the answer, the core container's start time and restart count,
# its cgroup memory, and any V8 heap failure the core logged. A page the core cannot convert within its
# 256 MiB JavaScript heap aborts its API process, and the harness then restarts the whole container:
# this probe can restart the core, and says so in what it prints. The token goes to curl on stdin.
set -uo pipefail
export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
c=fcpi-firecrawl-core-1
st() { local id p; id=$(sudo -n docker inspect -f '{{.Id}}' $c); p=/sys/fs/cgroup/system.slice/docker-$id.scope
  echo "core started=$(sudo -n docker inspect -f '{{.State.StartedAt}}' $c) restarts=$(sudo -n docker inspect -f '{{.RestartCount}}' $c) health=$(sudo -n docker inspect -f '{{.State.Health.Status}}' $c) memory.current=$(cat $p/memory.current) memory.peak=$(cat $p/memory.peak)"; }
healthy() { for _ in $(seq 1 120); do [ "$(sudo -n docker inspect -f '{{.State.Health.Status}}' $c)" = healthy ] && return 0; sleep 2; done; return 1; }
echo "### meta"
echo "utc=$(date -u +%Y-%m-%dT%H:%M:%SZ) source_commit=$(cat /opt/firecrawl-pi/.fcpi-source-commit) node_options=$(sudo -n docker inspect $c | jq -r '.[0].Config.Env[]' | grep ^NODE_OPTIONS= | cut -d= -f2-)"
while [ $# -ge 2 ]; do
  kb=$1 formats=$2; shift 2
  echo "### probe kb=$kb formats=$formats"
  healthy || echo "core not healthy before the probe"
  since=$(date -u +%Y-%m-%dT%H:%M:%SZ); st
  sudo -n cat /etc/firecrawl-pi/secrets/clients/m4a.token | sed 's/^/Authorization: Bearer /' | \
    curl -sS -m 150 -o /tmp/fcpi-heap-probe.json -w "http=%{http_code} bytes=%{size_download} seconds=%{time_total}\n" -H @- -H 'content-type: application/json' \
      --data "{\"url\":\"http://m3.fixture.fcpi.test:8080/big?kb=$kb\",\"formats\":$formats}" http://127.0.0.1:3380/v2/scrape
  echo "markdown_chars=$(jq -r '.data.markdown // "" | length' /tmp/fcpi-heap-probe.json 2>/dev/null) html_chars=$(jq -r '.data.html // "" | length' /tmp/fcpi-heap-probe.json 2>/dev/null) rawHtml_chars=$(jq -r '.data.rawHtml // "" | length' /tmp/fcpi-heap-probe.json 2>/dev/null)"
  rm -f /tmp/fcpi-heap-probe.json
  sleep 5; st
  echo "heap_failures_logged=$(sudo -n docker logs --since "$since" $c 2>&1 | grep -c 'JavaScript heap out of memory')"
done
echo "### end"
