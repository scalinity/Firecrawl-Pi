#!/usr/bin/env bash
# One real request through the gateway to a domain that has needed the residential tier, then the attempt rows it left: whether the residential path answers now,
# or still fails at the provider (PROVIDER_AUTH_FAILED). One page of the domain, so at most a few kilobytes of proxy traffic. Changes nothing else. The gateway token is
# read into a header file descriptor, never into an argument, and nothing it returns is printed beyond counts and the attempt rows' strategy and outcome.
#   ssh … 'sudo -n bash -s' < pi-residential-check.sh
set -uo pipefail
export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
DOMAIN=${DOMAIN:-codex-resets.com}
sec() { printf '### %s\n' "$1"; }
PG=$(docker ps -q --filter label=com.docker.compose.project=fcpi --filter label=com.docker.compose.service=nuq-postgres </dev/null)
q() { docker exec -i "$PG" psql -q -U postgres -d postgres -At -F'|'; }
TOKEN=/etc/firecrawl-pi/secrets/clients/m9codex.token
auth() { printf 'authorization: Bearer %s\n' "$(tr -d '\n' <"$TOKEN")"; }

sec meta
since=$(echo "select clock_timestamp();" | q)
echo "utc=$(date -u +%FT%TZ) deployed_commit=$(cut -c1-12 /opt/firecrawl-pi/.fcpi-source-commit) domain=$DOMAIN"

sec request
code=$(curl -s -m 120 -o /tmp/si6-res.$$ -w '%{http_code}' -H @<(auth) -H 'content-type: application/json' -d "{\"url\":\"https://$DOMAIN/\",\"formats\":[\"markdown\"]}" http://127.0.0.1:3380/v2/scrape)
echo "http=$code success=$(jq -r '.success // empty' /tmp/si6-res.$$ 2>/dev/null) markdown_chars=$(jq -r '(.data.markdown // "") | length' /tmp/si6-res.$$ 2>/dev/null) error=$(jq -r '.error // empty' /tmp/si6-res.$$ 2>/dev/null | cut -c1-120)"
rm -f /tmp/si6-res.$$

sec attempts_since_the_request
echo "select ordinal, strategy, outcome, coalesce(target_status::text, '-') from fcpi_retrieval.attempt where domain = '$DOMAIN' and started_at >= '$since' order by started_at;" | q
sec end
