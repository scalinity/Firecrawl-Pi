#!/usr/bin/env bash
# M2 persistence proof, derived from scripts/m1/pi-persistence.sh for M2's nine services: write
# sentinel records into PostgreSQL, Redis and RabbitMQ, count the retrieval service's own rows
# (acquisitions, attempts, domain state), run `docker compose up -d --force-recreate` WITHOUT
# deleting any volume or data directory, and read all of it back from the new containers.
# Capture the core instance's logs first (scripts/m2/pi-core-logs.sh, review finding R7): this
# recreates the core. Runs ON the Pi:  ssh ... 'bash /opt/firecrawl-pi/scripts/m2/pi-persistence.sh'
set -uo pipefail
export LC_ALL=C
export PATH="/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"
REPO=/opt/firecrawl-pi
S=/etc/firecrawl-pi/secrets
COMPOSE=(sudo -n docker compose -p fcpi -f $REPO/deploy/compose.yaml)
SERVICES=(nuq-postgres redis rabbitmq firecrawl-core access-gateway fixture retrieval-service browser-worker fixture-m2)

D() { sudo -n docker "$@"; }
sec() { printf '### %s\n' "$1"; }
name() { D inspect -f '{{.Name}}' "$(D compose -p fcpi ps -q "$1")" | tr -d /; }
ids() { for s in "${SERVICES[@]}"; do echo "$s $(D compose -p fcpi ps -q "$s")"; done; }
redis_cmd() { # redis_cmd <args...>: default user; the password travels on stdin only
  sudo -n sed -n 's#^redis://:\(.*\)@redis:6379$#\1#p' $S/core_redis_url \
    | D exec -i "$(name redis)" sh -c 'read -r p; REDISCLI_AUTH="$p" exec redis-cli --no-auth-warning "$@"' sh "$@" 2>&1
}
# M1's helper: the durable quorum queue fcpi.m1.sentinel holds one test message, "latest value".
amqp_sentinel() { D exec -i -u 0 -e SENTINEL_MODE="$1" -e SENTINEL_VALUE="${2:-}" "$(name firecrawl-core)" node --input-type=module - <"$REPO/scripts/m1/core-amqp-sentinel.mjs" 2>&1; }
pg() { D exec "$(name nuq-postgres)" psql -U postgres -v ON_ERROR_STOP=1 -Atc "$1" 2>&1; }
retrieval_rows() {
  echo "retrieval_rows acquisitions=$(pg 'select count(*) from fcpi_retrieval.acquisition') attempts=$(pg 'select count(*) from fcpi_retrieval.attempt') domains=$(pg 'select count(*) from fcpi_retrieval.domain_state') direct_navs=$(pg 'select count(*) from fcpi_retrieval.direct_nav') newest_attempt=$(pg "select coalesce(to_char(max(started_at) at time zone 'UTC','YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"'),'') from fcpi_retrieval.attempt")"
}

sec meta
date -u +%Y-%m-%dT%H:%M:%SZ
echo "source_commit=$(cat $REPO/.fcpi-source-commit)"
V="m2-sentinel-$(cat /proc/sys/kernel/random/uuid)"
echo "sentinel=$V"

sec write
pg "create schema if not exists fcpi_m2_sentinel; create table if not exists fcpi_m2_sentinel.sentinel (k text primary key, v text not null, written_at timestamptz not null default now()); insert into fcpi_m2_sentinel.sentinel (k, v) values ('m2', '$V') on conflict (k) do update set v = excluded.v, written_at = now() returning 'postgres_written=' || v;"
echo "redis_set=$(redis_cmd SET fcpi:m2:sentinel "$V")"
echo "rabbitmq_write=$(amqp_sentinel write "$V")"
retrieval_rows
sleep 3   # Redis appendfsync everysec

sec before
ids
echo "rabbitmq_node=$(D exec -u 5672 "$(name rabbitmq)" rabbitmqctl eval 'node().' 2>&1)"

sec recreate
t0=$(date +%s)
"${COMPOSE[@]}" up -d --force-recreate --wait --wait-timeout 900 2>&1 | tail -12
echo "recreate_exit=${PIPESTATUS[0]} elapsed_s=$(( $(date +%s) - t0 ))"

sec after
ids
echo "rabbitmq_node=$(D exec -u 5672 "$(name rabbitmq)" rabbitmqctl eval 'node().' 2>&1)"
D compose -p fcpi ps -a --format '{{.Service}} {{.State}} {{.Health}}'

sec read
echo "postgres_read=$(pg "select v from fcpi_m2_sentinel.sentinel where k = 'm2'")"
echo "redis_read=$(redis_cmd GET fcpi:m2:sentinel)"
echo "rabbitmq_read=$(amqp_sentinel read)"
retrieval_rows
echo "permits=$(pg "select string_agg(kind || ':' || slot || ':' || (holder is null)::text, ' ' order by kind, slot) from fcpi_retrieval.permit")"
sudo -n stat -c '%u:%g %a %n' /srv/firecrawl-pi/data /srv/firecrawl-pi/data/postgres /srv/firecrawl-pi/data/redis /srv/firecrawl-pi/data/rabbitmq
echo end
