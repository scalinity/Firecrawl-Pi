#!/usr/bin/env bash
# The MCP service's memory envelope (M4's M02), ON the Pi: scripts/m4/mcp-memory-probe.mjs inside a
# throwaway container of the image deploy/compose.yaml names for mcp-gateway, with the node options the
# service runs with and the deployed capability manifest. No network but loopback, a read-only root with a
# tmpfs /tmp, no capabilities, the service's uid, and the service's memory cap, so the probe fails the way
# the service would; labelled fcpi.transient and removed.
#   ssh … 'bash -s' < scripts/m4/pi-mcp-memory-probe.sh > evidence/M4/raw/mcp-memory-probe.txt
set -uo pipefail
export LC_ALL=C
export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
REPO=/opt/firecrawl-pi
img=$(sed -n 's#^ *image: \(fcpi/mcp-gateway@sha256:[0-9a-f]\{64\}\)$#\1#p' "$REPO/deploy/compose.yaml")
opts=$(sudo -n docker compose -p fcpi -f "$REPO/deploy/compose.yaml" config --format json | jq -r '.services["mcp-gateway"].environment.NODE_OPTIONS // ""')
mem=$(sudo -n docker compose -p fcpi -f "$REPO/deploy/compose.yaml" config --format json | jq -r '.services["mcp-gateway"].mem_limit')
echo "### meta"
echo "utc=$(date -u +%Y-%m-%dT%H:%M:%SZ) source_commit=$(cat $REPO/.fcpi-source-commit) image=${img:-absent} node_options=${opts:-none} mem_limit=$mem"
[ -n "$img" ] || exit 1
echo "### probe"
sudo -n docker run --rm -i --network none --read-only --tmpfs /tmp:size=16m --cap-drop ALL --security-opt no-new-privileges:true --user 3400:3400 \
  --memory 512m --memory-swap 512m --label fcpi.transient=m4-memory-probe -e PROBE_NODE_OPTIONS="$opts" \
  -v "$REPO/deploy/policies/capabilities.json:/srv/policy/capabilities.json:ro" "$img" node --input-type=module - <"$REPO/scripts/m4/mcp-memory-probe.mjs" 2>&1
echo "probe_exit=$?"
echo "### transient"
echo "leftover_transient_containers=$(sudo -n docker ps -aq --filter label=fcpi.transient | wc -l)"
echo "### end"
