#!/usr/bin/env bash
# State after the unplanned reset during M4's window, ON the Pi: whether what was durable before the power
# went is still there and whole. The data stores' recovery lines from this boot; the lines the power cut
# left damaged in each container's log file; M3's sentinels in
# PostgreSQL, Redis and RabbitMQ, written before M4 began (read only: the RabbitMQ read requeues); every
# job the ledger admitted since the window opened, with its state now, so none is left stranded; the
# archive, every file checked against its name; every live job document's archived file. Changes
# nothing.   ssh … 'bash -s -- <window-open UTC>' < scripts/m4/pi-after-reset.sh
set -uo pipefail
export LC_ALL=C
export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
REPO=/opt/firecrawl-pi
S=/etc/firecrawl-pi/secrets
ART=/srv/firecrawl-pi/data/artifacts
SINCE=${1:?usage: pi-after-reset.sh <window-open UTC>}
[[ $SINCE =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9:]{8}Z$ ]] || { echo "bad time: $SINCE" >&2; exit 1; }
sec() { printf '### %s\n' "$1"; }
D() { sudo -n docker "$@"; }
cid() { D compose -p fcpi ps -q "$1"; }
pg() { D exec "$(cid nuq-postgres)" psql -U postgres -v ON_ERROR_STOP=1 -q -At -X -c "$1" 2>&1; }
redis_cmd() {
  sudo -n sed -n 's#^redis://:\(.*\)@redis:6379$#\1#p' $S/core_redis_url \
    | D exec -i "$(cid redis)" sh -c 'read -r p; REDISCLI_AUTH="$p" exec redis-cli --no-auth-warning "$@"' sh "$@" 2>&1
}
amqp_read() { D exec -i -u 0 -e SENTINEL_MODE=read "$(cid firecrawl-core)" node --input-type=module - <"$REPO/scripts/m1/core-amqp-sentinel.mjs" 2>&1; }
logs() { D logs --since "$(D inspect -f '{{.State.StartedAt}}' "$(cid "$1")")" "$(cid "$1")" 2>&1; }

sec meta
echo "utc=$(date -u +%Y-%m-%dT%H:%M:%SZ) source_commit=$(cat $REPO/.fcpi-source-commit) boot_id_sha256=$(sha256sum </proc/sys/kernel/random/boot_id | cut -c1-64) window_open=$SINCE"

sec recovery_logs
# PostgreSQL's from its raw log file: the power loss left NUL bytes in the lines being written, and
# `docker logs` skips what follows them (see container_logs).
sudo -n grep -a -o -E '"log":"[^"]{0,40}(starting PostgreSQL|redo (starts|done)|end-of-recovery|ready to accept)[^"]{0,60}' "$(D inspect -f '{{.LogPath}}' "$(cid nuq-postgres)")" \
  | sed -E 's/^"log":"//; s/\\n$//' | cut -c1-120 | sed 's/^/postgres: /' | tail -4
logs redis | grep -E 'Loading|loaded|Done loading|AOF|RDB|Ready to accept' | sed -E 's/^[0-9]+:[A-Z] [^*#-]*[*#-] //' | cut -c1-160 | sed 's/^/redis: /' | head -8
logs rabbitmq | grep -E 'Server startup complete|recover|Recover' | cut -c1-160 | sed 's/^/rabbitmq: /' | head -6

sec container_logs
# Each project container's log file: lines holding NUL bytes, left where the power cut a write. A reader
# through `docker logs` misses what follows them, so no log scan may read a log from before the reset.
for s in $(D compose -p fcpi ps --format '{{.Service}}' | sort); do
  echo "$s lines_with_nul=$(sudo -n grep -a -c -P '\x00' "$(D inspect -f '{{.LogPath}}' "$(cid "$s")")" || true) created=$(D inspect -f '{{.Created}}' "$(cid "$s")" | cut -c1-19)Z"
done

sec sentinels
echo "postgres_read=$(pg "select v from fcpi_m3_sentinel.sentinel where k = 'm3'")"
echo "redis_read=$(redis_cmd GET fcpi:m3:sentinel)"
echo "rabbitmq_read=$(amqp_read)"

sec jobs_since_window
pg "select j.id || ' kind=' || j.kind || ' state=' || j.state || ' upstream=' || (j.upstream_id is not null) || ' archived=' || coalesce(j.archived::text, 'null')
      || ' created=' || to_char(j.created_at at time zone 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS\"Z\"')
      || ' finished=' || coalesce(to_char(j.finished_at at time zone 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS\"Z\"'), 'none')
      || ' documents=' || (select count(*) from fcpi_platform.job_document d where d.job_id = j.id)
    from fcpi_platform.job j where j.created_at >= '$SINCE'::timestamptz order by j.created_at"
echo "open_since_window=$(pg "select count(*) from fcpi_platform.job where created_at >= '$SINCE'::timestamptz and state in ('RECEIVED','SUBMITTING','SUBMISSION_UNCERTAIN','QUEUED','RUNNING')")"
echo "open_before_window=$(pg "select count(*) from fcpi_platform.job where created_at < '$SINCE'::timestamptz and state in ('RECEIVED','SUBMITTING','SUBMISSION_UNCERTAIN','QUEUED','RUNNING')")"
echo "ledger jobs=$(pg 'select count(*) from fcpi_platform.job') events=$(pg 'select count(*) from fcpi_platform.job_event') documents=$(pg 'select count(*) from fcpi_platform.job_document')"

sec archive
tmp=$(mktemp); trap 'rm -f "$tmp" "$tmp.names" "$tmp.docs"' EXIT
sudo -n sh -c "cd $ART/results 2>/dev/null && find . -name '*.json' -type f | LC_ALL=C sort" >"$tmp"
bad=0
while read -r f; do n=$(basename "$f" .json); h=$(sudo -n sha256sum "$ART/results/$f" | cut -c1-64); [ "$n" = "$h" ] || bad=$((bad + 1)); done <"$tmp"
echo "files=$(wc -l <"$tmp") files_whose_content_differs_from_name=$bad"
sed -E 's#.*/##; s#\.json$##' "$tmp" | sort -u >"$tmp.names"
pg "select distinct d.sha256 from fcpi_platform.job_document d join fcpi_platform.job j on j.id = d.job_id
    where j.state in ('SUCCEEDED','PARTIAL') and (j.results_expire_at is null or j.results_expire_at > now())" | sort -u >"$tmp.docs"
echo "live_documents=$(grep -c . "$tmp.docs") without_archive_file=$(comm -23 "$tmp.docs" "$tmp.names" | grep -c . || true)"

echo end
