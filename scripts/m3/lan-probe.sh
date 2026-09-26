#!/usr/bin/env bash
# Runs on the workstation, a LAN neighbour of the Pi (an unauthorized vantage point): every project
# port must be closed on the Pi's LAN address, M3's included. sshd on 22 is the positive control that
# shows the probe can see an open port. Pipe through scripts/m2/redact-lan.sh before saving.
#   scripts/m3/lan-probe.sh | scripts/m2/redact-lan.sh > evidence/M3/raw/lan-probe.txt
set -uo pipefail
# shellcheck source=scripts/m1/pi-target.conf
. "$(cd "$(dirname "$0")/../m1" && pwd)/pi-target.conf"
PI=$PI_LAN_ADDRESS
echo "### meta"
echo "utc=$(date -u +%Y-%m-%dT%H:%M:%SZ)"
echo "vantage=workstation on the Pi's LAN; target=$PI"
echo "### project_ports"
# 3380 the gateway's loopback publication, 3300 its container port, 3002-3008 the core, 5432
# PostgreSQL, 6379 Redis, 5672/4369/25672/15692 RabbitMQ, 3310/3312 the retrieval service and its
# proxy, 3320 the browser worker, 9090 Prometheus, 8443 the reserved Tailscale Serve port.
for p in 3380 3300 3002 3004 3005 3006 3007 3008 5432 6379 5672 4369 25672 15692 3310 3312 3320 9090 8443; do
  if nc -z -G 3 -w 3 "$PI" "$p" >/dev/null 2>&1; then echo "port=$p open"; else echo "port=$p closed"; fi
done
echo "### control"
if nc -z -G 3 -w 3 "$PI" 22 >/dev/null 2>&1; then echo "port=22 open"; else echo "port=22 closed"; fi
echo "end"
