#!/usr/bin/env bash
# M1 native proofs (decision D2): prove each M1 component runs natively on this
# 16 KiB-page kernel BEFORE any persistence, secret wiring or Compose layer is built.
# Runs ON the Pi:  ssh ... 'bash -s -- up|probe|down' < scripts/m1/pi-native-proofs.sh
#
# The proof stack is deliberately minimal and disposable: plain `docker run` on an
# internal proof network, tmpfs or a labelled proof volume for data, throwaway
# credentials held only in /run/fcpi-proof (tmpfs). It tests native execution, not
# the final configuration; the Compose stack is verified separately.
# Every resource carries the label fcpi.proof=m1; `down` removes them by exact name.
set -uo pipefail
export LC_ALL=C
export PATH="/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"
mode=${1:?usage: pi-native-proofs.sh up|probe|down}

REPO=/opt/firecrawl-pi
NET=fcpi-proof
SUBNET=10.231.250.0/24
SEC=/run/fcpi-proof
RMQ_VOL=fcpi-proof-rabbitmq-data
LBL=(--label fcpi.proof=m1)
IMG_CORE=ghcr.io/firecrawl/firecrawl@sha256:6157ce24e6867f013704c1cf2b752ec1ea7a3f730da09014b511d1049c8651af
IMG_REDIS=redis@sha256:41a10b18bd238fa7837b1615b2b5b113edff1654233238ac82d87e6fb5531f44
IMG_RMQ=rabbitmq@sha256:1a4b64d98915c38f496d1047f427baecdf0f5f73a773c8f2f7a515ce9763b5f8
IMG_NUQ=fcpi/nuq-postgres@sha256:ef257b914120c04cc7250d6120123c42e7fae75ce314e2a67a37f3a31de4c180
IMG_NODE=node@sha256:a0ddbc73510e98f5e824fd64266ffe1c2c343ba9cf260d95ca2985ad632a3f3e
FIXTURE_URL=http://m1.fixture.fcpi.test:8080/static.html
CONTAINERS=(fcpi-proof-pg fcpi-proof-redis fcpi-proof-rabbitmq fcpi-proof-fixture fcpi-proof-core fcpi-proof-gateway)

D() { sudo -n docker "$@"; }
sec() { printf '### %s\n' "$1"; }
ts() { date -u +%Y-%m-%dT%H:%M:%SZ; }
gen() { head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n'; }
put() { # put <file> <owner> <content>: a 0600 secret file in the tmpfs proof directory
  printf '%s' "$3" | sudo -n tee "$SEC/$1" >/dev/null && sudo -n chmod 0600 "$SEC/$1" && sudo -n chown "$2" "$SEC/$1"
}
cg() { # effective cgroup limits and usage of a container, from its own scope
  local id; id=$(D inspect -f '{{.Id}}' "$1" 2>/dev/null) || { echo "$1 absent"; return; }
  local p=/sys/fs/cgroup/system.slice/docker-$id.scope
  printf '%s memory.max=%s memory.current=%s memory.peak=%s cpu.max=%s pids.current=%s\n' "$1" \
    "$(cat $p/memory.max)" "$(cat $p/memory.current)" "$(cat $p/memory.peak 2>/dev/null)" "$(cat $p/cpu.max | tr ' ' '/')" "$(cat $p/pids.current)"
}

case "$mode" in
up)
  sec meta; ts
  D network inspect "$NET" >/dev/null 2>&1 || D network create --internal --subnet "$SUBNET" "${LBL[@]}" "$NET" >/dev/null
  sudo -n install -d -m 0700 -o root -g root "$SEC"
  pgpw=$(gen); rmqpw=$(gen)
  put rmq.conf 999:999 "vm_memory_high_watermark.absolute = 256MiB"$'\n'
  put gw-token 65534:65534 "fcpi_proof_$(gen)"
  put gw-hashes 3380:3380 "proof sha256:$(sudo -n cat "$SEC/gw-token" | sha256sum | cut -c1-64)"$'\n'
  D volume inspect "$RMQ_VOL" >/dev/null 2>&1 || D volume create "${LBL[@]}" "$RMQ_VOL" >/dev/null

  D run -d --name fcpi-proof-pg "${LBL[@]}" --network "$NET" --network-alias nuq-postgres \
    --memory 640m --memory-swap 640m --cpus 0.75 --tmpfs /var/lib/postgresql/data:rw,size=512m \
    -e POSTGRES_PASSWORD="$pgpw" -e POSTGRES_DB=postgres "$IMG_NUQ" \
    postgres -c shared_buffers=128MB -c work_mem=4MB -c max_connections=32 -c max_wal_size=1GB -c min_wal_size=80MB >/dev/null
  D run -d --name fcpi-proof-redis "${LBL[@]}" --network "$NET" --network-alias redis \
    --memory 320m --memory-swap 320m --cpus 0.35 --user 999:1000 --read-only --entrypoint redis-server "$IMG_REDIS" \
    --save '' --appendonly no --maxmemory 192mb --maxmemory-policy noeviction --protected-mode no >/dev/null
  D run -d --name fcpi-proof-rabbitmq "${LBL[@]}" --hostname rabbitmq --network "$NET" --network-alias rabbitmq \
    --memory 512m --memory-swap 512m --cpus 0.5 -v "$RMQ_VOL":/var/lib/rabbitmq \
    -v "$SEC/rmq.conf":/etc/rabbitmq/conf.d/30-fcpi.conf:ro \
    -e RABBITMQ_DEFAULT_USER=fcpi -e RABBITMQ_DEFAULT_PASS="$rmqpw" "$IMG_RMQ" >/dev/null
  D run -d --name fcpi-proof-fixture "${LBL[@]}" --network "$NET" --network-alias m1.fixture.fcpi.test \
    --memory 64m --memory-swap 64m --cpus 0.1 --user 65534:65534 --read-only \
    -v "$REPO/tests/fixtures/m1":/fixture:ro "$IMG_NODE" node /fixture/server.mjs >/dev/null
  # Wait for PostgreSQL's init (nuq.sql) and RabbitMQ before the harness connects.
  for i in $(seq 1 90); do D exec fcpi-proof-pg psql -U postgres -Atc "select count(*) from cron.job" 2>/dev/null | grep -qx 36 && break; sleep 2; done
  for i in $(seq 1 90); do D exec -u rabbitmq fcpi-proof-rabbitmq rabbitmq-diagnostics -q ping >/dev/null 2>&1 && break; sleep 2; done
  D run -d --name fcpi-proof-core "${LBL[@]}" --network "$NET" --network-alias firecrawl-core \
    --memory 2304m --memory-swap 2304m --cpus 2.25 \
    -e HOST=0.0.0.0 -e PORT=3002 -e NUQ_WORKER_COUNT=1 -e USE_DB_AUTHENTICATION=false \
    -e POSTGRES_HOST=nuq-postgres -e POSTGRES_PORT=5432 -e POSTGRES_USER=postgres -e POSTGRES_DB=postgres \
    -e POSTGRES_PASSWORD="$pgpw" -e REDIS_URL=redis://redis:6379 -e REDIS_RATE_LIMIT_URL=redis://redis:6379 \
    -e NUQ_RABBITMQ_URL="amqp://fcpi:$rmqpw@rabbitmq:5672" \
    -e ALLOW_LOCAL_WEBHOOKS=true -e DISABLE_WEBHOOK_DELIVERY=true -e SCRAPE_MAX_ATTEMPTS=1 \
    -e NODE_OPTIONS=--max-old-space-size=256 "$IMG_CORE" >/dev/null
  D run -d --name fcpi-proof-gateway "${LBL[@]}" --network "$NET" \
    --memory 160m --memory-swap 160m --cpus 0.3 --user 3380:3380 --read-only \
    -v "$REPO/services/access":/srv/access:ro -v "$SEC/gw-hashes":/run/secrets/gateway_token_hashes:ro \
    -e FCPI_UPSTREAM=http://firecrawl-core:3002 -e FCPI_TOKEN_HASHES_FILE=/run/secrets/gateway_token_hashes \
    -e FCPI_ALLOWED_TARGET_ORIGINS=http://m1.fixture.fcpi.test:8080 "$IMG_NODE" node /srv/access/server.mjs >/dev/null
  sec started; ts
  D ps -a --filter label=fcpi.proof=m1 --format '{{.Names}} {{.State}} {{.Status}}' | sort
  echo end
  ;;

probe)
  sec meta; ts
  printf 'host_page_size=%s kernel=%s\n' "$(getconf PAGESIZE)" "$(uname -r)"

  sec containers_platform
  for c in "${CONTAINERS[@]}"; do
    img=$(D inspect -f '{{.Image}}' "$c")
    plat=$(D image inspect "$img" | jq -r '.[0] | "\(.Os)/\(.Architecture)"')
    printf '%s image=%s platform=%s uname_m=%s state=%s restarts=%s\n' "$c" "$img" "$plat" \
      "$(D exec "$c" uname -m 2>/dev/null)" "$(D inspect -f '{{.State.Status}}' "$c")" "$(D inspect -f '{{.RestartCount}}' "$c")"
  done

  sec postgres
  q() { D exec fcpi-proof-pg psql -U postgres -Atc "$1" 2>&1; }
  echo "version=$(q 'select version()')"
  echo "pg_cron_launcher_backends=$(q "select count(*) from pg_stat_activity where backend_type = 'pg_cron launcher'")"
  echo "cron_jobs=$(q 'select count(*) from cron.job')"
  echo "extensions=$(q "select string_agg(extname || ' ' || extversion, ', ' order by extname) from pg_extension")"
  echo "nuq_tables=$(q "select string_agg(tablename, ',' order by tablename) from pg_tables where schemaname = 'nuq'")"
  sleep 20
  echo "cron_runs_succeeded=$(q "select count(*) from cron.job_run_details where status = 'succeeded'")"
  echo "cron_runs_failed=$(q "select count(*) from cron.job_run_details where status = 'failed'")"
  q "select name || '=' || setting || coalesce(unit, '') || ' source=' || source from pg_settings where name in ('shared_buffers','work_mem','max_connections','max_wal_size','min_wal_size','fsync','full_page_writes','synchronous_commit','wal_buffers','cron.database_name','shared_preload_libraries') order by name"

  sec redis
  echo "ping=$(D exec fcpi-proof-redis redis-cli PING)"
  D exec fcpi-proof-redis redis-cli INFO server | grep -E '^(redis_version|arch_bits|os|multiplexing_api):' | tr -d '\r'
  D exec fcpi-proof-redis redis-cli INFO memory | grep -E '^(mem_allocator|used_memory_human|maxmemory_human|maxmemory_policy):' | tr -d '\r'

  sec rabbitmq
  echo "ping=$(D exec -u rabbitmq fcpi-proof-rabbitmq rabbitmq-diagnostics -q ping 2>&1 | tr '\n' ' ')"
  echo "server_version=$(D exec -u rabbitmq fcpi-proof-rabbitmq rabbitmq-diagnostics -q server_version 2>&1)"
  echo "erlang_emu_flavor=$(D exec -u rabbitmq fcpi-proof-rabbitmq rabbitmqctl eval 'erlang:system_info(emu_flavor).' 2>&1)"
  echo "erlang_otp_release=$(D exec -u rabbitmq fcpi-proof-rabbitmq rabbitmqctl eval 'erlang:system_info(otp_release).' 2>&1)"
  echo "check_running=$(D exec -u rabbitmq fcpi-proof-rabbitmq rabbitmq-diagnostics -q check_running >/dev/null 2>&1 && echo ok || echo failed)"
  echo "check_local_alarms=$(D exec -u rabbitmq fcpi-proof-rabbitmq rabbitmq-diagnostics -q check_local_alarms >/dev/null 2>&1 && echo ok || echo failed)"
  echo "memory_high_watermark=$(D exec -u rabbitmq fcpi-proof-rabbitmq rabbitmqctl eval 'vm_memory_monitor:get_memory_limit().' 2>&1)"
  echo "enabled_plugins=$(D exec -u rabbitmq fcpi-proof-rabbitmq rabbitmq-plugins list -e -m -q 2>&1 | tr '\n' ' ')"
  echo "users=$(D exec -u rabbitmq fcpi-proof-rabbitmq rabbitmqctl list_users -q 2>&1 | awk '{print $1}' | tr '\n' ' ')"
  # Healthcheck probe cost inside the 512 MiB cap: sample the container's memory.current
  # every 50 ms while one probe runs, and report the peak above the pre-probe baseline.
  id=$(D inspect -f '{{.Id}}' fcpi-proof-rabbitmq); f=/sys/fs/cgroup/system.slice/docker-$id.scope/memory.current
  for probe in "rabbitmq-diagnostics -q ping" "bash -c '</dev/tcp/127.0.0.1/5672'"; do
    base=$(cat "$f"); peak=$base
    D exec -u rabbitmq fcpi-proof-rabbitmq sh -c "$probe" >/dev/null 2>&1 & pid=$!
    t0=$(date +%s%N)
    while kill -0 $pid 2>/dev/null; do v=$(cat "$f"); [ "$v" -gt "$peak" ] && peak=$v; sleep 0.05; done
    wait $pid; rc=$?
    printf 'probe=%q exit=%s duration_ms=%s baseline_bytes=%s peak_bytes=%s delta_mib=%s\n' "$probe" "$rc" \
      $(( ($(date +%s%N) - t0) / 1000000 )) "$base" "$peak" "$(awk -v a="$peak" -v b="$base" 'BEGIN{printf "%.1f", (a-b)/1048576}')"
  done

  sec core_health
  ok=0
  for i in $(seq 1 120); do
    out=$(D exec -i fcpi-proof-core node --input-type=module - <"$REPO/scripts/m1/core-probe.mjs" 2>/dev/null)
    if echo "$out" | jq -e '[.api_liveness, .extract_worker, .queue_worker, .nuq_worker_0, .nuq_prefetch_worker, .nuq_reconciler] | all(.status == 200)' >/dev/null 2>&1; then ok=1; break; fi
    sleep 3
  done
  echo "ready=$ok after_probe_attempts=$i"
  echo "$out"

  sec core_processes
  D exec fcpi-proof-core ps -eo pid,ppid,user,rss,args --no-headers | sed -E 's/ +/ /g; s/^ //'

  sec core_env_flags
  for v in USE_GO_MARKDOWN_PARSER NUQ_WORKER_COUNT USE_DB_AUTHENTICATION ALLOW_LOCAL_WEBHOOKS DISABLE_WEBHOOK_DELIVERY SCRAPE_MAX_ATTEMPTS NODE_OPTIONS; do
    val=$(D exec fcpi-proof-core sh -c "if [ -n \"\${$v+x}\" ]; then printf '%s' \"\$$v\"; else printf UNSET; fi")
    echo "$v=$val"
  done

  sec elf_alignment
  D exec -i fcpi-proof-core node --input-type=module - /app/native/firecrawl-rs.linux-arm64-gnu.node \
    /app/sharedLibs/go-html-to-md/libhtml-to-markdown.so /usr/local/bin/node <"$REPO/scripts/m1/elf-align.mjs"

  sec scrape_direct
  D exec -i -e SCRAPE_URL="$FIXTURE_URL" fcpi-proof-core node --input-type=module - <"$REPO/scripts/m1/core-scrape.mjs"

  sec native_module_mappings
  D exec fcpi-proof-core sh -c 'for p in /proc/[0-9]*; do n=${p#/proc/}; if grep -q "firecrawl-rs.linux-arm64-gnu.node" $p/maps 2>/dev/null; then echo "rust_module_mapped_by pid=$n cmd=$(tr "\0" " " <$p/cmdline | cut -c1-80)"; fi; if grep -q "libhtml-to-markdown.so" $p/maps 2>/dev/null; then echo "go_library_mapped_by pid=$n"; fi; done; echo scan_done'

  sec gateway
  echo "contract_tests_node=$(D run --rm --network none "${LBL[@]}" "$IMG_NODE" node --version)"
  D run --rm --network none "${LBL[@]}" --user 65534:65534 -v "$REPO":/repo:ro -w /repo "$IMG_NODE" \
    node --test tests/contracts/m1-gateway.test.mjs 2>&1 | grep -E '^(✔|✖|ℹ (tests|pass|fail))'
  echo "authenticated:"
  D run --rm -i --network "$NET" "${LBL[@]}" --user 65534:65534 -v "$SEC/gw-token":/run/token:ro \
    -e SCRAPE_API=http://fcpi-proof-gateway:3300 -e SCRAPE_TOKEN_FILE=/run/token -e SCRAPE_URL="$FIXTURE_URL" \
    "$IMG_NODE" node --input-type=module - <"$REPO/scripts/m1/core-scrape.mjs"
  echo "unauthenticated:"
  D run --rm -i --network "$NET" "${LBL[@]}" --user 65534:65534 \
    -e SCRAPE_API=http://fcpi-proof-gateway:3300 -e SCRAPE_URL="$FIXTURE_URL" \
    "$IMG_NODE" node --input-type=module - <"$REPO/scripts/m1/core-scrape.mjs"

  sec fixture_requests
  D logs fcpi-proof-fixture 2>&1 | tail -20

  sec rabbitmq_queues
  D exec -u rabbitmq fcpi-proof-rabbitmq rabbitmqctl list_queues -q name type durable auto_delete exclusive messages consumers 2>&1

  sec cgroups
  for c in "${CONTAINERS[@]}"; do cg "$c"; done
  echo end
  ;;

down)
  sec meta; ts
  for c in "${CONTAINERS[@]}"; do D rm -f "$c" >/dev/null 2>&1 && echo "removed $c"; done
  D volume rm "$RMQ_VOL" >/dev/null 2>&1 && echo "removed volume $RMQ_VOL"
  D network rm "$NET" >/dev/null 2>&1 && echo "removed network $NET"
  sudo -n rm -rf -- "$SEC" && echo "removed $SEC"
  echo "remaining_proof_resources=$( (D ps -aq --filter label=fcpi.proof=m1; D volume ls -q --filter label=fcpi.proof=m1; D network ls -q --filter label=fcpi.proof=m1) | wc -l)"
  echo end
  ;;
esac
