#!/usr/bin/env bash
# M3 stack evidence collector, derived from scripts/m2/pi-collect-stack.sh for M3's ten services and
# eight networks. Runs ON the Pi from the deployed copy:
#   ssh ... 'bash /opt/firecrawl-pi/scripts/m3/pi-collect-stack.sh'
# Prints a sectioned transcript that scripts/m3/verify.mjs parses. It only reads state, except for one
# unauthenticated gateway request. Never printed: container Env or Config sections, secret values,
# tokens; the one image environment line printed is the gateway's recorded source commit.
set -uo pipefail
export LC_ALL=C
export PATH="/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"
REPO=/opt/firecrawl-pi
S=/etc/firecrawl-pi/secrets
SERVICES=(nuq-postgres redis rabbitmq firecrawl-core access-gateway fixture retrieval-service browser-worker fixture-m2 fixture-m3)
NETWORKS=(fcpi_access fcpi_api fcpi_platform fcpi_core fcpi_fixture fcpi_acquire fcpi_browser fcpi_egress)

D() { sudo -n docker "$@"; }
sec() { printf '### %s\n' "$1"; }
cid() { D compose -p fcpi ps -q "$1"; }
name() { D inspect -f '{{.Name}}' "$(cid "$1")" | tr -d /; }
CORE=$(name firecrawl-core); PG=$(name nuq-postgres); RD=$(name redis); RMQ=$(name rabbitmq); GWC=$(name access-gateway); RS=$(name retrieval-service)

sec meta
echo "utc=$(date -u +%Y-%m-%dT%H:%M:%SZ)"
echo "source_commit=$(cat $REPO/.fcpi-source-commit)"
echo "host_page_size=$(getconf PAGESIZE) kernel=$(uname -r) uname_m=$(uname -m)"
echo "boot_id_sha256=$(sha256sum </proc/sys/kernel/random/boot_id | cut -c1-64)"
echo "binfmt_misc_handlers=$(ls /proc/sys/fs/binfmt_misc 2>/dev/null | grep -vE '^(register|status)$' | tr '\n' , | sed 's/,$//')"

sec containers
for s in "${SERVICES[@]}"; do
  c=$(cid "$s")
  img=$(D inspect -f '{{.Image}}' "$c")
  D inspect "$c" | jq -r --arg s "$s" --arg plat "$(D image inspect "$img" | jq -r '.[0] | "\(.Os)/\(.Architecture)"')" '.[0] |
    "\($s) name=\(.Name | ltrimstr("/")) image=\(.Image) platform=\($plat) state=\(.State.Status) health=\(.State.Health.Status // "none") restarts=\(.RestartCount) user=\(.Config.User // "") readonly_rootfs=\(.HostConfig.ReadonlyRootfs) privileged=\(.HostConfig.Privileged) network_mode=\(.HostConfig.NetworkMode) cap_drop=\((.HostConfig.CapDrop // []) | join(",")) cap_add=\((.HostConfig.CapAdd // []) | join(",")) security_opt=\((.HostConfig.SecurityOpt // []) | join(",")) docker_sock_mount=\([.Mounts[] | select(.Source | test("docker.sock"))] | length) started_at=\(.State.StartedAt)"'
  echo "$s uname_m=$(D exec "$c" uname -m 2>/dev/null)"
done

sec gateway_image
img=$(D inspect -f '{{.Image}}' "$GWC")
D image inspect "$img" --format '{{range .Config.Env}}{{println .}}{{end}}' | grep '^FCPI_SOURCE_COMMIT=' | sed 's/^/image_/'
D inspect "$GWC" | jq -r '.[0] | "mounts=\([.Mounts[] | "\(.Destination):\(if .RW then "rw" else "ro" end)"] | sort | join(","))"'

sec process_elf
for s in "${SERVICES[@]}"; do
  id=$(D inspect -f '{{.Id}}' "$(cid "$s")")
  for pid in $(cat /sys/fs/cgroup/system.slice/docker-$id.scope/cgroup.procs); do
    m=$(sudo -n head -c 20 /proc/$pid/exe 2>/dev/null | od -An -tu1 -j18 -N2 | awk '{print $1 + 256 * $2}')
    uid=$(awk '/^Uid:/ {print $2}' /proc/$pid/status 2>/dev/null)
    printf '%s pid=%s uid=%s e_machine=%s comm=%s args=%s\n' "$s" "$pid" "$uid" "${m:-?}" "$(cat /proc/$pid/comm 2>/dev/null)" "$(tr '\0' ' ' </proc/$pid/cmdline 2>/dev/null | cut -c1-90)"
  done
done

sec cgroups
for s in "${SERVICES[@]}"; do
  p=/sys/fs/cgroup/system.slice/docker-$(D inspect -f '{{.Id}}' "$(cid "$s")").scope
  printf '%s memory.max=%s memory.swap.max=%s cpu.max=%s pids.max=%s memory.current=%s memory.peak=%s oom_kill=%s pids.current=%s\n' "$s" \
    "$(cat $p/memory.max)" "$(cat $p/memory.swap.max)" "$(tr ' ' / <$p/cpu.max)" "$(cat $p/pids.max)" "$(cat $p/memory.current)" "$(cat $p/memory.peak)" \
    "$(awk '$1=="oom_kill"{print $2}' $p/memory.events)" "$(cat $p/pids.current)"
done

sec host_memory
grep -E '^(MemTotal|MemAvailable|SwapTotal|SwapFree):' /proc/meminfo

sec published
for s in "${SERVICES[@]}"; do
  D inspect "$(cid "$s")" | jq -r --arg s "$s" '.[0].NetworkSettings.Ports // {} | to_entries[] | select(.value != null) | .value[] as $b | "\($s) \(.key) -> \($b.HostIp):\($b.HostPort)"'
done
echo "--- host listeners (ss -Hltnup)"
sudo -n ss -Hltnup | awk '{print $1, $5, $7}' | sort

sec networks
for n in "${NETWORKS[@]}"; do
  D network inspect "$n" | jq -r '.[0] | "\(.Name) internal=\(.Internal) subnet=\(.IPAM.Config[0].Subnet) gateway_mode_ipv4=\(.Options["com.docker.network.bridge.gateway_mode_ipv4"] // "nat") bridge=\(.Options["com.docker.network.bridge.name"]) ipv6=\(.EnableIPv6) members=\([.Containers[].Name] | sort | join(","))"'
done
for b in fcpi-access fcpi-api fcpi-platform fcpi-core fcpi-fixture fcpi-acquire fcpi-browser fcpi-egress; do echo "bridge $b addresses=$(ip -4 -br addr show dev $b 2>/dev/null | awk '{print $3}')"; done

sec gateway_unauthenticated
code=$(curl -sS -m 10 -o /dev/null -w '%{http_code}' http://127.0.0.1:3380/platform/v1/status)
echo "status_without_token=$code"

sec gateway_log_scan
# The gateway's own log, counted only: its lines (the positive control that it was read), request
# records, and any Cloud host, token, authorization value or target URL, none of which it may carry.
L=$(D logs "$GWC" 2>&1)
echo "lines=$(printf '%s\n' "$L" | grep -c .) request_records=$(printf '%s\n' "$L" | grep -c '"request_id"') job_records=$(printf '%s\n' "$L" | grep -c '"event":"job"')"
for pat in 'firecrawl\.dev' 'firecrawl\.com' 'mendable' 'fcpi_[a-z0-9]+_[0-9a-f]{64}' 'Bearer [A-Za-z0-9]' '[Aa]uthorization' 'm3\.fixture\.fcpi\.test'; do
  echo "pattern=$pat count=$(printf '%s\n' "$L" | grep -cE "$pat")"
done

sec postgres_health
q() { D exec "$PG" psql -U postgres -Atc "$1" 2>&1; }
echo "select_1=$(q 'select 1')"
echo "version=$(q 'select version()')"
echo "cron_jobs=$(q 'select count(*) from cron.job')"
echo "cron_runs_last_10min_failed=$(q "select count(*) from cron.job_run_details where status = 'failed' and start_time > now() - interval '10 minutes'")"
echo "connections=$(q 'select count(*) from pg_stat_activity') max_connections=$(q 'show max_connections')"
echo "gateway_connections=$(q "select count(*) from pg_stat_activity where usename = 'fcpi_gateway'")"
q "select name || '=' || current_setting(name) from pg_settings where name in ('fsync','full_page_writes','synchronous_commit') order by name"

sec redis_health
echo "health_user_ping=$(D exec "$RD" redis-cli --no-auth-warning --user health --pass - PING 2>&1)"
sudo -n sed -n 's#^redis://:\(.*\)@redis:6379$#\1#p' $S/core_redis_url | D exec -i "$RD" sh -c 'read -r p; export REDISCLI_AUTH="$p"; redis-cli --no-auth-warning INFO persistence; redis-cli --no-auth-warning INFO memory' 2>&1 \
  | tr -d '\r' | grep -E '^(aof_enabled|aof_last_write_status|maxmemory_policy|used_memory_human):'

sec rabbitmq_health
echo "check_running=$(D exec -u 5672 "$RMQ" rabbitmq-diagnostics -q check_running >/dev/null 2>&1 && echo ok || echo failed)"
echo "check_local_alarms=$(D exec -u 5672 "$RMQ" rabbitmq-diagnostics -q check_local_alarms >/dev/null 2>&1 && echo ok || echo failed)"

sec core_health
D exec -i "$CORE" node --input-type=module - <"$REPO/scripts/m1/core-probe.mjs"

sec retrieval_ready
D exec "$RS" node -e "fetch('http://10.231.5.10:3310/readyz').then(async r=>console.log(r.status, await r.text()),e=>console.log('unreachable', e.message))" 2>&1
echo end
