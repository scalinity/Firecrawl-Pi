#!/usr/bin/env bash
# Persistence across destructive container recreation (AC14; CLAUDE.md §23), ON the Pi, for M3's ten
# services:   ssh … 'bash -s' < scripts/m3/pi-persistence.sh
# Writes sentinels to PostgreSQL, Redis and RabbitMQ as M2's collector does, records the platform
# ledger (receipts, events, idempotency keys, document manifest: counts and a hash of their rows), the
# archive's files (count and a hash of their names) and the client registry's hash, then runs
# `docker compose up -d --force-recreate` WITHOUT removing any volume, waits for health, and reads
# everything back, verifying every archived file against its name. The core's log is saved first
# (scripts/m2/pi-core-logs.sh), so no core instance is replaced unscanned.
set -uo pipefail
export LC_ALL=C
export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
REPO=/opt/firecrawl-pi
S=/etc/firecrawl-pi/secrets
ART=/srv/firecrawl-pi/data/artifacts
COMPOSE=(sudo -n docker compose -p fcpi -f $REPO/deploy/compose.yaml)
SERVICES=(nuq-postgres redis rabbitmq firecrawl-core access-gateway fixture retrieval-service browser-worker fixture-m2 fixture-m3)
D() { sudo -n docker "$@"; }
sec() { printf '### %s\n' "$1"; }
cid() { D compose -p fcpi ps -q "$1"; }
ids() { for s in "${SERVICES[@]}"; do echo "$s $(D inspect -f '{{.Id}}' "$(cid "$s")")"; done; }
pgq() { D exec -i "$(cid nuq-postgres)" psql -U postgres -d postgres -At -X "$@"; }
ledger() {
  pgq <<'SQL'
-- Every ledger table's rows are hashed, events and idempotency keys included, not only counted.
SELECT 'ledger jobs=' || (SELECT count(*) FROM fcpi_platform.job) || ' events=' || (SELECT count(*) FROM fcpi_platform.job_event)
  || ' idempotency=' || (SELECT count(*) FROM fcpi_platform.idempotency) || ' documents=' || (SELECT count(*) FROM fcpi_platform.job_document)
  || ' documents_distinct_sha256=' || (SELECT count(DISTINCT sha256) FROM fcpi_platform.job_document)
  || ' rows_sha256=' || encode(sha256(convert_to(
       coalesce((SELECT string_agg(id || '|' || state || '|' || coalesce(upstream_id::text, '') || '|' || archived, ',' ORDER BY id) FROM fcpi_platform.job), '') || '#' ||
       coalesce((SELECT string_agg(job_id || '|' || ordinal || '|' || sha256, ',' ORDER BY job_id, ordinal) FROM fcpi_platform.job_document), '') || '#' ||
       coalesce((SELECT string_agg(id || '|' || job_id || '|' || coalesce(from_state, '') || '|' || to_state || '|' || coalesce(detail, '') || '|' || at, ',' ORDER BY id) FROM fcpi_platform.job_event), '') || '#' ||
       coalesce((SELECT string_agg(principal || '|' || operation || '|' || key || '|' || request_hash || '|' || job_id || '|' || expires_at, ',' ORDER BY principal, operation, key) FROM fcpi_platform.idempotency), ''), 'UTF8')), 'hex');
SELECT 'retrieval_rows acquisitions=' || (SELECT count(*) FROM fcpi_retrieval.acquisition) || ' attempts=' || (SELECT count(*) FROM fcpi_retrieval.attempt);
SQL
}
archive() {
  sudo -n sh -c "cd $ART/results 2>/dev/null && find . -name '*.json' -type f | LC_ALL=C sort" >/tmp/.fcpi-art-$$
  echo "archive files=$(wc -l </tmp/.fcpi-art-$$) names_sha256=$(sha256sum </tmp/.fcpi-art-$$ | cut -c1-64)"
  # Every file's content hashes to its name.
  bad=0
  while read -r f; do n=$(basename "$f" .json); h=$(sudo -n sha256sum "$ART/results/$f" | cut -c1-64); [ "$n" = "$h" ] || bad=$((bad + 1)); done </tmp/.fcpi-art-$$
  echo "archive files_whose_content_differs_from_name=$bad"
  rm -f /tmp/.fcpi-art-$$
}
# M2's helpers (scripts/m2/pi-persistence.sh): the Redis password and the sentinel value travel on stdin.
redis_cmd() {
  sudo -n sed -n 's#^redis://:\(.*\)@redis:6379$#\1#p' $S/core_redis_url \
    | D exec -i "$(cid redis)" sh -c 'read -r p; REDISCLI_AUTH="$p" exec redis-cli --no-auth-warning "$@"' sh "$@" 2>&1
}
amqp_sentinel() { D exec -i -u 0 -e SENTINEL_MODE="$1" -e SENTINEL_VALUE="${2:-}" "$(cid firecrawl-core)" node --input-type=module - <"$REPO/scripts/m1/core-amqp-sentinel.mjs" 2>&1; }
pg() { D exec "$(cid nuq-postgres)" psql -U postgres -v ON_ERROR_STOP=1 -q -Atc "$1" 2>&1; }
registry() { echo "registry sha256=$(sudo -n sha256sum $S/gateway/clients | cut -c1-64) clients=$(sudo -n awk '!/^#/ && NF == 4' $S/gateway/clients | wc -l)"; }

V=fcpi-m3-persist-$(head -c 6 /dev/urandom | od -An -tx1 | tr -d ' \n')
sec meta
echo "utc=$(date -u +%Y-%m-%dT%H:%M:%SZ) source_commit=$(cat $REPO/.fcpi-source-commit) sentinel=$V"

sec core_logs_before
# Its own section headers are indented, so they stay inside this section and do not replace this
# transcript's meta and end sections for a reader.
bash $REPO/scripts/m2/pi-core-logs.sh before-m3-persistence | grep -E '^(### |classified|control=|utc=)' | sed 's/^### /  instance-record /'

sec write
pg "create schema if not exists fcpi_m3_sentinel; create table if not exists fcpi_m3_sentinel.sentinel (k text primary key, v text not null, written_at timestamptz not null default now()); insert into fcpi_m3_sentinel.sentinel (k, v) values ('m3', '$V') on conflict (k) do update set v = excluded.v, written_at = now() returning 'postgres_written=' || v;"
echo "redis_set=$(redis_cmd SET fcpi:m3:sentinel "$V")"
echo "rabbitmq_write=$(amqp_sentinel write "$V")"
ledger; archive; registry
sleep 3   # Redis appendfsync everysec

sec before
ids

sec recreate
"${COMPOSE[@]}" up -d --force-recreate --wait --wait-timeout 900 2>&1 | tail -3
echo "recreate_exit=${PIPESTATUS[0]}"

sec after
ids
"${COMPOSE[@]}" ps -a --format '{{.Service}} {{.State}} {{.Health}}'

sec read
echo "postgres_read=$(pg "select v from fcpi_m3_sentinel.sentinel where k = 'm3'")"
echo "redis_read=$(redis_cmd GET fcpi:m3:sentinel)"
echo "rabbitmq_read=$(amqp_sentinel read)"
ledger; archive; registry
echo end
