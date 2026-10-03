#!/usr/bin/env bash
# M7 stack evidence collector, derived from scripts/m6/pi-collect-stack.sh for M7's fifteen services (fixture-m7
# added) and the same eleven networks. Runs ON the Pi from the deployed copy:
#   ssh ... 'bash /opt/firecrawl-pi/scripts/m7/pi-collect-stack.sh'
# Prints a sectioned transcript that scripts/m7/verify.mjs parses. It only reads state, except for one
# unauthenticated gateway request. Never printed: container Env or Config sections, secret values,
# tokens; the only image environment lines printed are the services' recorded source commits.
set -uo pipefail
export LC_ALL=C
export PATH="/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"
REPO=/opt/firecrawl-pi
S=/etc/firecrawl-pi/secrets
SERVICES=(nuq-postgres redis rabbitmq firecrawl-core access-gateway mcp-gateway fixture retrieval-service browser-worker fixture-m2 fixture-m3 searxng fixture-m5 fixture-m6 fixture-m7)
NETWORKS=(fcpi_access fcpi_api fcpi_platform fcpi_mcp fcpi_search fcpi_model fcpi_core fcpi_fixture fcpi_acquire fcpi_browser fcpi_egress)

D() { sudo -n docker "$@"; }
sec() { printf '### %s\n' "$1"; }
cid() { D compose -p fcpi ps -q "$1"; }
name() { D inspect -f '{{.Name}}' "$(cid "$1")" | tr -d /; }
CORE=$(name firecrawl-core); PG=$(name nuq-postgres); RD=$(name redis); RMQ=$(name rabbitmq); GWC=$(name access-gateway); RS=$(name retrieval-service); MCPC=$(name mcp-gateway)

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

sec mcp_image
img=$(D inspect -f '{{.Image}}' "$MCPC")
D image inspect "$img" --format '{{range .Config.Env}}{{println .}}{{end}}' | grep '^FCPI_SOURCE_COMMIT=' | sed 's/^/image_/'
D inspect "$MCPC" | jq -r '.[0] | "mounts=\([.Mounts[] | "\(.Destination):\(if .RW then "rw" else "ro" end)"] | sort | join(",")) ipv4=\([.NetworkSettings.Networks[].IPAddress] | join(","))"'

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
# Tailscale's addresses identify the owner's tailnet node: replaced here, as the snapshot does.
sudo -n ss -Hltnup | awk '{print $1, $5, $7}' | sort | sed -E 's#100\.(6[4-9]|[7-9][0-9]|1[01][0-9]|12[0-7])\.[0-9]{1,3}\.[0-9]{1,3}([^0-9/.]|$)#<tailnet-address>\2#g; s#fd7a:115c:a1e0:[0-9a-f:]*[0-9a-f]#<tailnet-address-v6>#g'

sec networks
for n in "${NETWORKS[@]}"; do
  D network inspect "$n" | jq -r '.[0] | "\(.Name) internal=\(.Internal) subnet=\(.IPAM.Config[0].Subnet) gateway_mode_ipv4=\(.Options["com.docker.network.bridge.gateway_mode_ipv4"] // "nat") bridge=\(.Options["com.docker.network.bridge.name"]) ipv6=\(.EnableIPv6) members=\([.Containers[].Name] | sort | join(","))"'
done
for b in fcpi-access fcpi-api fcpi-platform fcpi-mcp fcpi-search fcpi-model fcpi-core fcpi-fixture fcpi-acquire fcpi-browser fcpi-egress; do echo "bridge $b addresses=$(ip -4 -br addr show dev $b 2>/dev/null | awk '{print $3}')"; done

sec gateway_unauthenticated
code=$(curl -sS -m 10 -o /dev/null -w '%{http_code}' http://127.0.0.1:3380/platform/v1/status)
echo "status_without_token=$code"

sec gateway_log_scan
# The gateway container that runs now, counted only: see the script.
bash $REPO/scripts/m3/pi-gateway-log-scan.sh

sec mcp_health
D exec "$MCPC" node -e "fetch('http://127.0.0.1:3400/health').then(async r=>console.log(r.status, await r.text()),e=>console.log('unreachable', e.message))" 2>&1

sec mcp_log_scan
bash $REPO/scripts/m4/pi-mcp-log-scan.sh

sec mcp_reach
D exec -i "$MCPC" node --input-type=module - <"$REPO/scripts/m4/mcp-egress-probe.mjs" 2>&1

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
{ bash "$REPO/scripts/ops/redis-cli.sh" INFO persistence; bash "$REPO/scripts/ops/redis-cli.sh" INFO memory; } 2>&1 \
  | tr -d '\r' | grep -E '^(aof_enabled|aof_last_write_status|maxmemory_policy|used_memory_human):'

sec rabbitmq_health
echo "check_running=$(D exec -u 5672 "$RMQ" rabbitmq-diagnostics -q check_running >/dev/null 2>&1 && echo ok || echo failed)"
echo "check_local_alarms=$(D exec -u 5672 "$RMQ" rabbitmq-diagnostics -q check_local_alarms >/dev/null 2>&1 && echo ok || echo failed)"

sec core_health
D exec -i "$CORE" node --input-type=module - <"$REPO/scripts/m1/core-probe.mjs"

sec retrieval_ready
D exec "$RS" node -e "fetch('http://10.231.5.10:3310/readyz').then(async r=>console.log(r.status, await r.text()),e=>console.log('unreachable', e.message))" 2>&1

sec retrieval_image
img=$(D inspect -f '{{.Image}}' "$RS")
D image inspect "$img" --format '{{range .Config.Env}}{{println .}}{{end}}' | grep '^FCPI_SOURCE_COMMIT=' | sed 's/^/image_/'
D inspect "$RS" | jq -r '.[0] | "mounts=\([.Mounts[] | "\(.Destination):\(if .RW then "rw" else "ro" end)"] | sort | join(",")) ipv4=\([.NetworkSettings.Networks | to_entries[] | "\(.key)=\(.value.IPAddress)"] | sort | join(","))"'

# M5: SearXNG, its image, its native proof on this kernel (the M0 obligation: evidence/M0/review/DECISIONS.md,
# D2), and its reach: no route and no name resolution; only the search proxy answers (a 407 without
# SearXNG's credential), the positive control.
SX=$(name searxng)
sec searxng_image
D inspect "$SX" | jq -r '.[0] | "image=\(.Image) user=\(.Config.User) entrypoint=\(.Config.Entrypoint | join(" ")) mounts=\([.Mounts[] | "\(.Destination):\(if .RW then "rw" else "ro" end)"] | sort | join(",")) tmpfs=\(.HostConfig.Tmpfs | keys | sort | join(","))"'
D image inspect "$(D inspect -f '{{.Image}}' "$SX")" | jq -r '.[0] | "version=\(.Config.Labels["org.opencontainers.image.version"]) revision=\(.Config.Labels["org.opencontainers.image.revision"]) license=\(.Config.Labels["org.opencontainers.image.licenses"]) os=\(.Os) arch=\(.Architecture)"'
sec searxng_native
P=$(D inspect -f '{{.State.Pid}}' "$SX")
py=$(D exec "$SX" readlink -f /usr/local/searxng/.venv/bin/python3.14)
echo "python=$py page_size=$(getconf PAGESIZE)"
elf() { # elf <path inside the container>: machine and the smallest LOAD alignment
  local f=/proc/$P/root$1 m a
  m=$(sudo -n readelf -hW "$f" 2>/dev/null | awk -F: '/Machine/ {gsub(/^ +/, "", $2); print $2}')
  a=$(sudo -n readelf -lW "$f" 2>/dev/null | awk '$1=="LOAD" {print $NF}' | sort -u | tr '\n' , | sed 's/,$//')
  echo "elf path=$1 machine=${m:-?} load_align=${a:-?}"
}
elf "$py"
for f in $(D exec "$SX" sh -c 'find /usr/local/searxng/.venv /usr/lib/python3.14/lib-dynload -name "*.so*" -type f 2>/dev/null; ls /usr/lib/libpython3*.so* 2>/dev/null' | sort -u); do elf "$f"; done
echo "granian_workers=$(D exec "$SX" sh -c 'ls /proc | grep -E "^[0-9]+$" | while read p; do cat /proc/$p/comm 2>/dev/null; echo; done' | grep -c '^searxng')"
sec searxng_reach
D exec "$SX" sh -c 'echo "default_route=$(awk "\$2==\"00000000\" {print \"yes\"}" /proc/net/route | head -1)"; for h in example.com api.firecrawl.dev duckduckgo.com; do if wget -q -T 4 -t 1 -O /dev/null "https://$h/" 2>/dev/null; then echo "https_$h=open"; else echo "https_$h=refused"; fi; done; code=$(wget -q -S -T 4 -t 1 -O /dev/null http://10.231.10.10:3313/ 2>&1 | awk "/HTTP\//{print \$2}" | tail -1); echo "search_proxy_control=${code:-none}"' 2>&1
sec searxng_health
D exec "$SX" wget -q -O - http://127.0.0.1:8080/healthz 2>&1; echo
D exec "$SX" wget -q -O - http://127.0.0.1:8080/config 2>/dev/null | jq -c '{engines: [.engines[] | select(.enabled) | .name] | sort, formats: .search_formats? }' 2>/dev/null || echo "config_unreadable"
code=$(D exec "$SX" sh -c 'wget -q -S -O /dev/null "http://127.0.0.1:8080/search?q=x" 2>&1 | awk "/HTTP\//{print \$2}" | tail -1'); echo "html_format_status=${code:-none}"

# M6 and M7: the retrieval service's log, counted, secrets looked for by value (scripts/m7/pi-retrieval-log-scan.sh).
sec retrieval_log_scan
bash $REPO/scripts/m7/pi-retrieval-log-scan.sh
sec provider_files
echo "providers_present=$(sudo -n ls -A $S/providers | wc -l) names=$(sudo -n ls -A $S/providers | tr '\n' ',' | sed 's/,$//') selection=$(sudo -n cat /etc/firecrawl-pi/selection/selection.json | jq -c .)"
# M7: the browser worker's image records the commit it was built from, and its Chromium processes now.
sec browser_image
BW=$(name browser-worker)
img=$(D inspect -f '{{.Image}}' "$BW")
D image inspect "$img" --format '{{range .Config.Env}}{{println .}}{{end}}' | grep '^FCPI_SOURCE_COMMIT=' | sed 's/^/image_/'
echo "chrome_processes=$(D exec --user 3320 "$BW" sh -c 'pgrep -c -f [c]hrome-headless-shell || true') health=$(D exec "$BW" node -e "fetch('http://10.231.2.20:3320/healthz').then(r=>r.text()).then(t=>process.stdout.write(t),()=>process.stdout.write('unreachable'))")"
# M6 and M7: the fixtures' reach: on the internal fixture network alone, with no default route.
for f in fixture-m6 fixture-m7; do
  sec "${f//-/_}_reach"
  FM=$(name $f)
  D exec "$FM" node -e 'const fs=require("fs");const r=fs.readFileSync("/proc/net/route","utf8").split("\n").slice(1).filter(l=>l.split("\t")[1]==="00000000");console.log("default_route="+(r.length?"yes":"no"))' 2>&1
  D inspect "$FM" | jq -r '.[0] | "networks=\([.NetworkSettings.Networks | keys[]] | join(",")) aliases=\([.NetworkSettings.Networks[].Aliases // [] | .[]] | map(select(test("fixture"))) | sort | join(",")) secrets_mounted=\([.Mounts[] | select(.Destination | startswith("/run/secrets")) | .Destination] | sort | join(","))"'
done
# M7: the gateway ledger's version and the outbox's states.
sec ledger_m7
q "select 'platform_version=' || max(version) from fcpi_platform.schema_version"
q "select 'webhook_events=' || coalesce(string_agg(state || ':' || n, ',' order by state), 'none') from (select state, count(*) n from fcpi_platform.webhook_event group by state) s"
q "select 'artifacts=' || count(*) || ' cache_rows=' || (select count(*) from fcpi_platform.page_cache) || ' page_versions=' || (select count(*) from fcpi_platform.page_version) from fcpi_platform.artifact"
echo end
