#!/usr/bin/env bash
# The Compose file as the Pi renders it (V16, V18 and V22 read it). Secrets appear by name
# and file path only; no value is rendered. Runs ON the Pi:
#   ssh ... 'bash /opt/firecrawl-pi/scripts/m1/pi-rendered-compose.sh'
set -euo pipefail
export LC_ALL=C
export PATH="/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"
sudo -n docker compose -p fcpi -f /opt/firecrawl-pi/deploy/compose.yaml config --format json
