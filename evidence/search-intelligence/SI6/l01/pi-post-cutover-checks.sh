#!/usr/bin/env bash
# The checks ROLLOUT.md step 8 lists beyond the functional suite and the live search, on the Pi after a cutover: the ledger's rows for the search categories, the
# operational records of recent searches, the core's legacy search route, and a map and a crawl through the gateway. Read-only apart from the one crawl of
# example.com (a single page). No secret is printed: the gateway token is read into a header file descriptor, never into an argument.
#   ssh … 'sudo -n bash -s' < pi-post-cutover-checks.sh
set -uo pipefail
export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
sec() { printf '### %s\n' "$1"; }
PG=$(docker ps -q --filter label=com.docker.compose.project=fcpi --filter label=com.docker.compose.service=nuq-postgres </dev/null)
q() { docker exec -i "$PG" psql -q -U postgres -d postgres -At -F'|'; }
TOKEN=/etc/firecrawl-pi/secrets/clients/m9codex.token
auth() { printf 'authorization: Bearer %s\n' "$(tr -d '\n' <"$TOKEN")"; }
gw() { curl -s -m "$1" -o /tmp/si6-body.$$ -w '%{http_code}' -H @<(auth) -H 'content-type: application/json' "${@:3}" "http://127.0.0.1:3380$2"; }

sec meta
echo "utc=$(date -u +%FT%TZ) deployed_commit=$(cut -c1-12 /opt/firecrawl-pi/.fcpi-source-commit)"

sec ledger_search_categories_last_3h
q <<'SQL'
select provider, kind, unit, state, count(*), coalesce(sum(actual), 0) from fcpi_retrieval.budget_reservation
where created_at > now() - interval '3 hours' and kind in ('search','docs_search','docs_read','decision') group by 1,2,3,4 order by 1,2,3,4;
SQL
echo "reserved_rows_left=$(echo "select count(*) from fcpi_retrieval.budget_reservation where state = 'RESERVED';" | q)"

sec operational_records_last_3h
echo "search_run_rows=$(echo "select count(*) from fcpi_retrieval.search_run where accepted_at > now() - interval '3 hours';" | q)"
echo "search_event_rows=$(echo "select count(*) from fcpi_retrieval.search_event where observed_at > now() - interval '3 hours';" | q)"
echo "search_event_by_type=$(echo "select string_agg(event_type || ':' || n, ',' order by event_type) from (select event_type, count(*) n from fcpi_retrieval.search_event where observed_at > now() - interval '3 hours' group by 1) t;" | q)"
echo "provider_availability=$(echo "select string_agg(provider || ':' || state, ',' order by provider) from fcpi_retrieval.provider_availability;" | q)"

sec legacy_route
CORE=$(docker ps -q --filter label=com.docker.compose.project=fcpi --filter label=com.docker.compose.service=firecrawl-core </dev/null)
docker exec -i "$CORE" node -e "fetch('http://retrieval-service:3310/searxng/search?q=vue+reactivity+ref&format=json').then(async (r) => { const j = await r.json(); console.log(JSON.stringify({ status: r.status, keys: Object.keys(j).sort().join(','), results: (j.results ?? []).length })); }).catch((e) => console.log(JSON.stringify({ error: String(e.message).slice(0, 80) })))" </dev/null

sec map
code=$(gw 60 /v2/map -d '{"url":"https://example.com"}'); echo "http=$code links=$(jq -r '(.links // []) | length' /tmp/si6-body.$$ 2>/dev/null)"

sec crawl
code=$(gw 60 /v2/crawl -d '{"url":"https://example.com","limit":1}'); id=$(jq -r '.id // empty' /tmp/si6-body.$$ 2>/dev/null); echo "submit_http=$code id_present=$([ -n "$id" ] && echo yes || echo no)"
if [ -n "$id" ]; then
  for i in $(seq 1 30); do
    code=$(gw 30 "/v2/crawl/$id" -X GET); st=$(jq -r '.status // empty' /tmp/si6-body.$$ 2>/dev/null)
    [ "$st" = completed ] || [ "$st" = failed ] || [ "$st" = cancelled ] && break
    sleep 2
  done
  echo "status_http=$code status=$st pages=$(jq -r '(.data // []) | length' /tmp/si6-body.$$ 2>/dev/null) completed=$(jq -r '.completed // empty' /tmp/si6-body.$$ 2>/dev/null)"
fi
rm -f /tmp/si6-body.$$
sec end
