#!/usr/bin/env bash
# Internal-port denial from permitted and unauthorized vantage points (milestones M3 "Automated
# Verification"; spec §20.1, AC02), ON the Pi:   ssh … 'bash -s' < scripts/m3/pi-port-probe.sh
#   gateway      the permitted vantage: it must reach the core's API and PostgreSQL (the positive
#                controls) and nothing else internal: no Redis, RabbitMQ, retrieval service
#                (/internal/*), browser worker, fixture, and no host listener through its bridge;
#   access_peer  a throwaway container on fcpi_access, the publication bridge: only the gateway's
#                port is there, and no internal service;
#   default_bridge  a throwaway container on Docker's default bridge (any other container on the
#                host): no project service at all; the host's sshd through the bridge is its control;
#   host         the host itself: only 127.0.0.1:3380 is published; the internal bridges have no
#                host address, so no internal service is reachable from the host either.
# The LAN vantage is scripts/m3/lan-probe.sh on the workstation; the Tailnet vantage does not exist
# until Tailscale is installed. Throwaway containers carry fcpi.transient and are removed. Only
# project addresses are probed; the default-bridge container is never pointed at a public address.
set -uo pipefail
export LC_ALL=C
export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
REPO=/opt/firecrawl-pi
D() { sudo -n docker "$@"; }
cid() { D compose -p fcpi ps -q "$1"; }
ip_on() { D inspect "$(cid "$1")" | jq -r --arg n "$2" '.[0].NetworkSettings.Networks[$n].IPAddress // empty'; }
sec() { printf '### %s\n' "$1"; }
IMG=$(D inspect -f '{{.Config.Image}}' "$(cid fixture)")   # the digest-pinned node image
PROBE=$REPO/scripts/m3/port-probe.mjs

CORE_API=$(ip_on firecrawl-core fcpi_api); CORE_CORE=$(ip_on firecrawl-core fcpi_core)
PG_CORE=$(ip_on nuq-postgres fcpi_core); PG_PLATFORM=$(ip_on nuq-postgres fcpi_platform)
REDIS=$(ip_on redis fcpi_core); RMQ=$(ip_on rabbitmq fcpi_core)
RS_ACQ=10.231.5.10; BW=10.231.2.20; FX3=$(ip_on fixture-m3 fcpi_fixture); GW_ACCESS=$(ip_on access-gateway fcpi_access)
ACCESS_GW=10.231.0.1

sec meta
echo "utc=$(date -u +%Y-%m-%dT%H:%M:%SZ) source_commit=$(cat $REPO/.fcpi-source-commit) probe_image=$IMG"
echo "addresses core_api=$CORE_API core_core=$CORE_CORE pg_core=$PG_CORE pg_platform=$PG_PLATFORM redis=$REDIS rabbitmq=$RMQ retrieval=$RS_ACQ browser=$BW fixture_m3=$FX3 gateway_access=$GW_ACCESS"
counters() { sudo -n nft list table inet fcpi_guard | grep 'counter packets' | grep -E 'access_' | sed -E 's/.*counter packets ([0-9]+) bytes [0-9]+.*comment "([a-z0-9_]+)".*/\2 packets=\1/'; }
sec guard_before
counters

sec gateway
# Names as the gateway resolves them, then addresses, then the host through the bridge.
D exec -i -e ROLE=gateway -e TARGETS="core_api=firecrawl-core:3002 postgres=nuq-postgres:5432 core_worker_health=firecrawl-core:3006 core_prometheus=firecrawl-core:9090 \
redis_name=redis:6379 rabbitmq_name=rabbitmq:5672 retrieval_name=retrieval-service:3310 browser_name=browser-worker:3320 fixture_name=fixture-m3:8080 \
core_on_core_net=$CORE_CORE:3002 postgres_on_core_net=$PG_CORE:5432 redis_ip=$REDIS:6379 rabbitmq_ip=$RMQ:5672 retrieval_ip=$RS_ACQ:3310 retrieval_proxy_ip=10.231.2.10:3312 browser_ip=$BW:3320 fixture_ip=$FX3:8080 \
host_sshd=$ACCESS_GW:22 host_dns=$ACCESS_GW:53 host_http=$ACCESS_GW:80 host_mqtt=$ACCESS_GW:1883 host_airdb=$ACCESS_GW:8080" \
  "$(cid access-gateway)" node --input-type=module - <"$PROBE" 2>&1
echo "--- the retrieval service's acquisition route, by address, from the gateway"
D exec -i -e ROLE=gateway -e HTTP_PATH=/internal/acquire -e TARGETS="retrieval_internal=$RS_ACQ:3310" "$(cid access-gateway)" node --input-type=module - <"$PROBE" 2>&1

sec access_peer
D run --rm -i --network fcpi_access --read-only --cap-drop ALL --security-opt no-new-privileges:true --user 8080:8080 --dns 192.0.2.1 --label fcpi.transient=port-probe \
  -e ROLE=access_peer -e TARGETS="gateway_port=$GW_ACCESS:3300 core_name=firecrawl-core:3002 core_api=$CORE_API:3002 postgres_platform=$PG_PLATFORM:5432 postgres_core=$PG_CORE:5432 redis_ip=$REDIS:6379 rabbitmq_ip=$RMQ:5672 retrieval_ip=$RS_ACQ:3310 browser_ip=$BW:3320 host_sshd=$ACCESS_GW:22" \
  "$IMG" node --input-type=module - <"$PROBE" 2>&1

sec default_bridge
BR=$(D network inspect bridge | jq -r '.[0].IPAM.Config[0].Gateway // empty')
D run --rm -i --network bridge --read-only --cap-drop ALL --security-opt no-new-privileges:true --user 8080:8080 --dns 192.0.2.1 --label fcpi.transient=port-probe \
  -e ROLE=default_bridge -e TARGETS="host_sshd=${BR:-172.17.0.1}:22 host_gateway_publication=${BR:-172.17.0.1}:3380 gateway_access=$GW_ACCESS:3300 core_api=$CORE_API:3002 postgres_platform=$PG_PLATFORM:5432 postgres_core=$PG_CORE:5432 redis_ip=$REDIS:6379 rabbitmq_ip=$RMQ:5672 retrieval_ip=$RS_ACQ:3310 browser_ip=$BW:3320 fixture_ip=$FX3:8080" \
  "$IMG" node --input-type=module - <"$PROBE" 2>&1

sec host
t() { if timeout 3 bash -c "exec 3<>/dev/tcp/$2/$3" 2>/dev/null; then echo "{\"role\":\"host\",\"label\":\"$1\",\"target\":\"$2:$3\",\"outcome\":\"open\"}"; else echo "{\"role\":\"host\",\"label\":\"$1\",\"target\":\"$2:$3\",\"outcome\":\"closed\"}"; fi; }
t gateway_publication 127.0.0.1 3380
for p in 3300 3002 3006 5432 6379 5672 3310 3312 3320 8080; do t "loopback_$p" 127.0.0.1 $p; done
for pair in "core_api $CORE_API 3002" "postgres_platform $PG_PLATFORM 5432" "postgres_core $PG_CORE 5432" "redis $REDIS 6379" "rabbitmq $RMQ 5672" "retrieval $RS_ACQ 3310" "browser $BW 3320" "fixture_m3 $FX3 8080"; do
  set -- $pair; t "$1" "$2" "$3"
done

sec guard_after
counters
sec transient
echo "leftover_transient_containers=$(D ps -aq --filter label=fcpi.transient | wc -l)"
echo end
