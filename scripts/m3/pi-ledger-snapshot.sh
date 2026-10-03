#!/usr/bin/env bash
# Every job the ledger admitted since <since> (the Pi's clock, which is the database's), one JSON line
# each, with what no-duplicate submission rests on (spec §16.2): its state, its upstream id, whether its
# cancellation was asked, how many distinct upstream jobs in NuQ carry its submission key, and how many
# NuQ rows its upstream group still holds, the control that a count was read while NuQ still held the
# job (pg_cron removes finished rows after an hour). Read-only. Runs ON the Pi:
#   ssh … 'bash /opt/firecrawl-pi/scripts/m3/pi-ledger-snapshot.sh 2026-09-26T09:00:00.000Z'
# scripts/m3/e2e.mjs and scripts/m3/sdk-compat.mjs end every run with it; J05 reads the result.
set -euo pipefail
export LC_ALL=C
export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
since=${1:-}
[[ $since =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\.[0-9]+)?Z$ ]] || { echo "usage: pi-ledger-snapshot.sh <since, ISO 8601 UTC>" >&2; exit 2; }
PG=$(sudo -n docker ps -q --filter label=com.docker.compose.project=fcpi --filter label=com.docker.compose.service=nuq-postgres)
[ -n "$PG" ] || { echo "nuq-postgres is not running" >&2; exit 1; }
sudo -n docker exec -i "$PG" psql -U postgres -d postgres -At -X -q -v ON_ERROR_STOP=1 -v since="$since" <<'SQL'
SELECT json_build_object('id', j.id, 'kind', j.kind, 'state', j.state, 'upstream', j.upstream_id, 'cancel_requested', j.cancel_requested_at IS NOT NULL,
  'dispatch_attempts', j.dispatch_attempts,
  'marker_groups', (SELECT count(DISTINCT q.group_id) FROM (SELECT group_id, data FROM nuq.queue_scrape UNION ALL SELECT group_id, data FROM nuq.queue_scrape_backlog) q
                     WHERE q.group_id IS NOT NULL AND (q.data->>'origin' = j.submission_key OR q.data->>'origin' LIKE 'fcpi:%:' || j.submission_key
                       OR q.data->'scrapeOptions'->>'origin' = j.submission_key OR q.data->'scrapeOptions'->>'origin' LIKE 'fcpi:%:' || j.submission_key)),
  'upstream_rows', (SELECT count(*) FROM nuq.queue_scrape q WHERE j.upstream_id IS NOT NULL AND q.group_id = j.upstream_id))
  FROM fcpi_platform.job j WHERE j.created_at >= :'since'::timestamptz ORDER BY j.created_at;
SQL
