#!/usr/bin/env bash
# Runs on the workstation, a LAN neighbour of the Pi (an unauthorised vantage point):
# every project port must be closed on the Pi's LAN address. sshd on 22 is the positive
# control that shows the probe can see an open port.
#   scripts/m1/lan-probe.sh > evidence/M1/raw/lan-probe.txt
set -uo pipefail
PI=158.205.34.18
echo "### meta"
date -u +%Y-%m-%dT%H:%M:%SZ
echo "vantage=workstation on the Pi's LAN; target=$PI"
echo "### project_ports"
# 3380 published gateway (loopback only), 3300 gateway container port, 3002-3008 core,
# 5432 PostgreSQL, 6379 Redis, 5672/4369/25672 RabbitMQ AMQP/epmd/distribution, 15692 Prometheus.
for p in 3380 3300 3002 3004 3005 3006 3007 3008 5432 6379 5672 4369 25672 15692; do
  if nc -z -G 3 -w 3 "$PI" "$p" >/dev/null 2>&1; then echo "port=$p open"; else echo "port=$p closed"; fi
done
echo "### control"
if nc -z -G 3 -w 3 "$PI" 22 >/dev/null 2>&1; then echo "port=22 open"; else echo "port=22 closed"; fi
echo "end"
