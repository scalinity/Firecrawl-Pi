#!/usr/bin/env bash
# The host's provider selection (/etc/firecrawl-pi/selection/selection.json, read by the retrieval service
# every minute): which search engine set runs, which listed model extraction uses and which listed parser
# takes complex documents. It chooses only among what deploy/policies/egress.json and budget.json list.
#   ssh … 'bash /opt/firecrawl-pi/scripts/m5/pi-selection.sh <fixture|live> <model> <parser>'
#   ssh … 'bash /opt/firecrawl-pi/scripts/m5/pi-selection.sh show'
# "live" lets SearXNG's engine requests reach the live engines' hosts: live search egress over the home
# connection, held until the milestone's review is addressed (CLAUDE.md §5). The file is replaced
# atomically, then the service's own log is awaited for the new selection, so the caller knows it applies.
set -euo pipefail
export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
REPO=/opt/firecrawl-pi
F=/etc/firecrawl-pi/selection/selection.json
if [ "${1:-}" = show ]; then sudo -n cat "$F"; exit 0; fi
search=${1:?usage: pi-selection.sh <fixture|live> <model> <parser> | show} model=${2:?model} parser=${3:?parser}
case $search in fixture|live) ;; *) echo "search must be fixture or live" >&2; exit 2 ;; esac
jq -e --arg m "$model" '.models | has($m)' "$REPO/deploy/policies/budget.json" >/dev/null || { echo "model $model is not in the budget policy" >&2; exit 2; }
jq -e --arg p "$parser" '.parsers | has($p)' "$REPO/deploy/policies/budget.json" >/dev/null || { echo "parser $parser is not in the budget policy" >&2; exit 2; }
tmp=$(sudo -n mktemp /etc/firecrawl-pi/selection/.fcpi-tmp.XXXXXX)
jq -cn --arg s "$search" --arg m "$model" --arg p "$parser" '{search: $s, extractionModel: $m, parser: $p}' | sudo -n tee "$tmp" >/dev/null
sudo -n chmod 0644 "$tmp" && sudo -n mv -f "$tmp" "$F"
since=$(date +%s)
C=$(sudo -n docker ps -q --filter label=com.docker.compose.project=fcpi --filter label=com.docker.compose.service=retrieval-service)
[ -n "$C" ] || { echo "retrieval-service is not running; the selection applies at its start"; exit 0; }
for _ in $(seq 1 75); do
  if sudo -n docker logs --since "@$since" "$C" 2>/dev/null | jq -ce --arg s "$search" --arg m "$model" --arg p "$parser" 'select(.event == "selection_loaded" and .search == $s and .extractionModel == $m and .parser == $p)' 2>/dev/null | grep . >/dev/null; then
    echo "selection applied: search=$search model=$model parser=$parser utc=$(date -u +%Y-%m-%dT%H:%M:%SZ)"; exit 0
  fi
  sleep 1
done
echo "the retrieval service did not report the new selection within 75 s" >&2; exit 1
