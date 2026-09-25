#!/usr/bin/env bash
# M1 stack evidence collector. Runs ON the Pi from the deployed copy:
#   ssh ... 'bash /opt/firecrawl-pi/scripts/m1/pi-collect-stack.sh'
# Prints a sectioned transcript that scripts/m1/verify.mjs parses. It makes two scrapes
# of the fixture and a few gateway requests; otherwise it only reads state.
# Never printed: container Env or Config sections, secret values, tokens. Secrets that a
# probe needs travel on stdin, never in argv or the environment of a docker command.
set -uo pipefail
export LC_ALL=C
export PATH="/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"
REPO=/opt/firecrawl-pi
S=/etc/firecrawl-pi/secrets
GW=http://127.0.0.1:3380
FIXTURE_URL=http://m1.fixture.fcpi.test:8080/static.html
SERVICES=(nuq-postgres redis rabbitmq firecrawl-core access-gateway fixture)

D() { sudo -n docker "$@"; }
sec() { printf '### %s\n' "$1"; }
cid() { D compose -p fcpi ps -q "$1"; }
name() { D inspect -f '{{.Name}}' "$(cid "$1")" | tr -d /; }
CORE=$(name firecrawl-core); PG=$(name nuq-postgres); RD=$(name redis); RMQ=$(name rabbitmq); GWC=$(name access-gateway); FX=$(name fixture)

sec meta
date -u +%Y-%m-%dT%H:%M:%SZ
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

sec process_elf
# Every process in every project container, read from the host: uid and the ELF machine
# of /proc/<pid>/exe (183 = aarch64).
for s in "${SERVICES[@]}"; do
  id=$(D inspect -f '{{.Id}}' "$(cid "$s")")
  for pid in $(cat /sys/fs/cgroup/system.slice/docker-$id.scope/cgroup.procs); do
    m=$(sudo -n head -c 20 /proc/$pid/exe 2>/dev/null | od -An -tu1 -j18 -N2 | awk '{print $1 + 256 * $2}')
    uid=$(awk '/^Uid:/ {print $2}' /proc/$pid/status 2>/dev/null)
    printf '%s pid=%s uid=%s e_machine=%s comm=%s args=%s\n' "$s" "$pid" "$uid" "${m:-?}" "$(cat /proc/$pid/comm 2>/dev/null)" "$(tr '\0' ' ' </proc/$pid/cmdline 2>/dev/null | cut -c1-90)"
  done
done

sec core_processes
D exec "$CORE" ps -eo pid,ppid,user,rss,args --no-headers | sed -E 's/ +/ /g; s/^ //' | grep -v ' ps -eo '

sec cgroups
for s in "${SERVICES[@]}"; do
  p=/sys/fs/cgroup/system.slice/docker-$(D inspect -f '{{.Id}}' "$(cid "$s")").scope
  printf '%s memory.max=%s memory.swap.max=%s cpu.max=%s pids.max=%s memory.current=%s memory.peak=%s anon=%s file=%s shmem=%s pids.current=%s\n' "$s" \
    "$(cat $p/memory.max)" "$(cat $p/memory.swap.max)" "$(tr ' ' / <$p/cpu.max)" "$(cat $p/pids.max)" "$(cat $p/memory.current)" "$(cat $p/memory.peak)" \
    "$(awk '$1=="anon"{print $2}' $p/memory.stat)" "$(awk '$1=="file"{print $2}' $p/memory.stat)" "$(awk '$1=="shmem"{print $2}' $p/memory.stat)" "$(cat $p/pids.current)"
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
for n in fcpi_access fcpi_core fcpi_fixture; do
  D network inspect "$n" | jq -r '.[0] | "\(.Name) internal=\(.Internal) subnet=\(.IPAM.Config[0].Subnet) gateway_mode_ipv4=\(.Options["com.docker.network.bridge.gateway_mode_ipv4"] // "nat") bridge=\(.Options["com.docker.network.bridge.name"]) ipv6=\(.EnableIPv6) members=\([.Containers[].Name] | sort | join(","))"'
done
for b in fcpi-access fcpi-core fcpi-fixture; do echo "bridge $b addresses=$(ip -4 -br addr show dev $b 2>/dev/null | awk '{print $3}')"; done

sec core_health
D exec -i "$CORE" node --input-type=module - <"$REPO/scripts/m1/core-probe.mjs"

sec postgres_health
q() { D exec "$PG" psql -U postgres -Atc "$1" 2>&1; }
echo "select_1=$(q 'select 1')"
echo "version=$(q 'select version()')"
echo "pg_cron_launcher_backends=$(q "select count(*) from pg_stat_activity where backend_type = 'pg_cron launcher'")"
echo "cron_jobs=$(q 'select count(*) from cron.job')"
echo "cron_runs_last_10min_succeeded=$(q "select count(*) from cron.job_run_details where status = 'succeeded' and start_time > now() - interval '10 minutes'")"
echo "cron_runs_last_10min_failed=$(q "select count(*) from cron.job_run_details where status = 'failed' and start_time > now() - interval '10 minutes'")"
echo "connections=$(q 'select count(*) from pg_stat_activity') max_connections=$(q 'show max_connections')"
q "select name || '=' || current_setting(name) || ' source=' || source from pg_settings where name in ('shared_buffers','work_mem','max_connections','max_wal_size','min_wal_size','fsync','full_page_writes','synchronous_commit','cron.database_name','data_directory') order by name"
echo "process_uid=$(D exec "$PG" sh -c 'stat -c %u /proc/1')"

sec redis_health
echo "health_user_ping=$(D exec "$RD" redis-cli --no-auth-warning --user health --pass - PING 2>&1)"
echo "health_user_info_denied=$(D exec "$RD" redis-cli --no-auth-warning --user health --pass - INFO server 2>&1 | head -1)"
echo "no_auth_ping=$(D exec "$RD" redis-cli PING 2>&1 | head -1)"
# The default user's password reaches redis-cli on stdin, never in argv or docker's env.
sudo -n sed -n 's#^redis://:\(.*\)@redis:6379$#\1#p' $S/core_redis_url | D exec -i "$RD" sh -c 'read -r p; export REDISCLI_AUTH="$p"; redis-cli --no-auth-warning INFO persistence; redis-cli --no-auth-warning INFO memory; redis-cli --no-auth-warning INFO server' 2>&1 \
  | tr -d '\r' | grep -E '^(aof_enabled|aof_last_write_status|aof_last_bgrewrite_status|rdb_changes_since_last_save|mem_allocator|maxmemory_human|maxmemory_policy|used_memory_human|redis_version|arch_bits):'

sec rabbitmq_health
R() { D exec -u 5672 "$RMQ" "$@" 2>&1; }
echo "ping=$(R rabbitmq-diagnostics -q ping | tr '\n' ' ')"
echo "check_running=$(R rabbitmq-diagnostics -q check_running >/dev/null && echo ok || echo failed)"
echo "check_local_alarms=$(R rabbitmq-diagnostics -q check_local_alarms >/dev/null && echo ok || echo failed)"
echo "server_version=$(R rabbitmq-diagnostics -q server_version)"
echo "node=$(R rabbitmqctl eval 'node().')"
echo "memory_high_watermark_bytes=$(R rabbitmqctl eval 'vm_memory_monitor:get_memory_limit().')"
echo "users=$(R rabbitmqctl list_users -q | awk 'NR>1 {print $1 $2}' | tr '\n' ' ')"
echo "enabled_plugins=$(R rabbitmq-plugins list -e -m -q | tr '\n' ' ')"
echo "cookie=$(D exec "$RMQ" stat -c '%u:%g %a' /var/lib/rabbitmq/.erlang.cookie)"
echo "process_uid=$(D exec "$RMQ" sh -c 'stat -c %u /proc/1')"
R rabbitmqctl list_queues -q name type durable auto_delete exclusive messages consumers

sec gateway_tests
T=$(mktemp -d)
gwreq() { # gwreq <label> <method> <path> <token-mode:none|wrong|valid> [body]
  local hdr=/dev/null
  case "$4" in
    valid) sudo -n sed 's/^/Authorization: Bearer /' $S/clients/m1-verify.token >"$T/h" ;;
    wrong) printf 'Authorization: Bearer fcpi_m1v_%s' "$(head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n')" >"$T/h" ;;
    none) : >"$T/h" ;;
  esac
  code=$(curl -sS -m 90 -o "$T/b" -D "$T/d" -w '%{http_code}' -X "$2" -H @"$T/h" -H 'content-type: application/json' ${5:+--data-binary "$5"} "$GW$3")
  printf '%s status=%s www_authenticate=%s body=%s\n' "$1" "$code" "$(grep -i '^www-authenticate:' "$T/d" | cut -d' ' -f2- | tr -d '\r' | tr ' ' '_')" \
    "$(jq -c 'if .data.markdown then .data.markdown |= ("b64:" + @base64) else . end | {success, error, code, markdown: .data.markdown, statusCode: .data.metadata.statusCode}' "$T/b" 2>/dev/null || head -c 120 "$T/b")"
  rm -f "$T/h"
}
FIX="{\"url\":\"$FIXTURE_URL\",\"formats\":[\"markdown\"]}"
gwreq missing_token POST /v2/scrape none "$FIX"
gwreq wrong_token POST /v2/scrape wrong "$FIX"
gwreq missing_token_admin POST /admin/integration/create-user none '{}'
gwreq valid_token_admin POST /admin/integration/create-user valid '{}'
gwreq valid_token_unlisted_route POST /v2/crawl valid "$FIX"
gwreq valid_token_non_fixture_target POST /v2/scrape valid '{"url":"https://api.firecrawl.dev/","formats":["markdown"]}'
gwreq valid_token_internal_target POST /v2/scrape valid '{"url":"http://nuq-postgres.fcpi.test:5432/","formats":["markdown"]}'
gwreq valid_token_fixture_scrape POST /v2/scrape valid "$FIX"
rm -rf "$T"

sec direct_scrape
D exec -i -e SCRAPE_URL="$FIXTURE_URL" "$CORE" node --input-type=module - <"$REPO/scripts/m1/core-scrape.mjs"

sec egress_structure
for c in "$CORE" "$FX" "$PG" "$RD" "$RMQ" "$GWC"; do
  echo "$c default_route=$(D exec "$c" awk 'NR>1 && $2=="00000000" {print "yes"; f=1} END {if (!f) print "no"}' /proc/net/route 2>/dev/null) nameserver=$(D exec "$c" awk '/^nameserver/ {print $2}' /etc/resolv.conf 2>/dev/null | tr '\n' ,)"
done

sec egress_probes
echo "core $(D exec -i "$CORE" node --input-type=module - <"$REPO/scripts/m1/core-egress-probe.mjs" 2>&1)"
echo "fixture $(D exec -i "$FX" node --input-type=module - <"$REPO/scripts/m1/core-egress-probe.mjs" 2>&1)"
echo "host_control_example_com=$(getent ahostsv4 example.com >/dev/null && echo resolves || echo fails)"

sec core_log_scan
logs=$(D logs "$CORE" 2>&1 | sed -E 's/\x1b\[[0-9;]*m//g')
for pat in 'firecrawl\.dev' 'duckduckgo' 'getaddrinfo' 'EAI_AGAIN' 'ENOTFOUND' 'posthog' 'sentry\.io' 'ENETUNREACH' 'integrations\.'; do
  echo "pattern=$pat count=$(grep -ciE "$pat" <<<"$logs")"
done
echo "log_lines=$(wc -l <<<"$logs") since=$(D inspect -f '{{.State.StartedAt}}' "$CORE")"
echo end
