#!/usr/bin/env bash
# The host's provider selection (/etc/firecrawl-pi/selection/selection.json, read by the retrieval service
# every minute): which search engine set runs, which listed model extraction uses and which listed parser
# takes complex documents, (M6) which listed residential proxy the retrieval service may use, or none, and (M7) which
# listed enhanced provider, or none. It chooses only among what deploy/policies/egress.json and budget.json list.
#   ssh … 'bash /opt/firecrawl-pi/scripts/m5/pi-selection.sh <fixture|live> <model> <parser> [<proxy>|none [<enhancer>|none]]'
# Without the fourth or fifth argument the file's choice is kept (the budget policy's default when it has none).
#   ssh … 'bash /opt/firecrawl-pi/scripts/m5/pi-selection.sh show'
# "live" lets SearXNG's engine requests reach the live engines' hosts: live search egress over the home
# connection, held until the milestone's review is addressed (CLAUDE.md §5). The file is replaced
# atomically, then the service is asked until it reports the new selection, so the caller knows it applies.
set -euo pipefail
export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
REPO=/opt/firecrawl-pi
F=/etc/firecrawl-pi/selection/selection.json
if [ "${1:-}" = show ]; then sudo -n cat "$F"; exit 0; fi
search=${1:?usage: pi-selection.sh <fixture|live> <model> <parser> | show} model=${2:?model} parser=${3:?parser}
case $search in fixture|live) ;; *) echo "search must be fixture or live" >&2; exit 2 ;; esac
jq -e --arg m "$model" '.models | has($m)' "$REPO/deploy/policies/budget.json" >/dev/null || { echo "model $model is not in the budget policy" >&2; exit 2; }
jq -e --arg p "$parser" '.parsers | has($p)' "$REPO/deploy/policies/budget.json" >/dev/null || { echo "parser $parser is not in the budget policy" >&2; exit 2; }
if [ -n "${4:-}" ]; then proxy=$4; else proxy=$(sudo -n cat "$F" 2>/dev/null | jq -r 'if has("proxy") then (.proxy // "none") else empty end'); fi
[ -n "$proxy" ] || proxy=$(jq -r '.proxying.defaultProxy // "none"' "$REPO/deploy/policies/budget.json")
[ "$proxy" = none ] || jq -e --arg x "$proxy" '.proxies | has($x)' "$REPO/deploy/policies/budget.json" >/dev/null || { echo "proxy $proxy is not in the budget policy" >&2; exit 2; }
if [ -n "${5:-}" ]; then enh=$5; else enh=$(sudo -n cat "$F" 2>/dev/null | jq -r 'if has("enhanced") then (.enhanced // "none") else empty end'); fi
[ -n "$enh" ] || enh=$(jq -r '.enhancing.defaultEnhancer // "none"' "$REPO/deploy/policies/budget.json")
[ "$enh" = none ] || jq -e --arg x "$enh" '.enhancers | has($x)' "$REPO/deploy/policies/budget.json" >/dev/null || { echo "enhancer $enh is not in the budget policy" >&2; exit 2; }
sel() { jq -cn --arg s "$search" --arg m "$model" --arg p "$parser" --arg x "$proxy" --arg e "$enh" '{search: $s, extractionModel: $m, parser: $p, proxy: (if $x == "none" then null else $x end), enhanced: (if $e == "none" then null else $e end)}'; }
C=$(sudo -n docker ps -q --filter label=com.docker.compose.project=fcpi --filter label=com.docker.compose.service=retrieval-service)
want=$(sel)
# Already the file's selection: the service loaded it at its start or when it last changed, and rewriting the
# same content would make it log nothing to wait for (its log may no longer hold the line), so nothing is done.
if [ "$(sudo -n cat "$F" | jq -c .)" = "$want" ]; then
  echo "selection applied: search=$search model=$model parser=$parser proxy=$proxy enhanced=$enh utc=$(date -u +%Y-%m-%dT%H:%M:%SZ) (unchanged)"; exit 0
fi
tmp=$(sudo -n mktemp /etc/firecrawl-pi/selection/.fcpi-tmp.XXXXXX)
sel | sudo -n tee "$tmp" >/dev/null
sudo -n chmod 0644 "$tmp" && sudo -n mv -f "$tmp" "$F"
[ -n "$C" ] || { echo "retrieval-service is not running; the selection applies at its start"; exit 0; }
# The service is asked which selection it runs (its /internal/providers, relayed by the gateway's status), never its log:
# a power cut leaves NULs in docker's json-file log, and `docker logs` stops at the first without an error, so a line
# logged after them is never shown. "file" as the source keeps a file the service refused, whose default may be the
# same fixture selection, from passing as applied.
want_run=$(jq -c '. + {source: "file"}' <<<"$want")
end=$((SECONDS + 90))
while [ "$SECONDS" -lt "$end" ]; do
  got=$(sudo -n bash "$REPO/scripts/ops/status.sh" --json 2>/dev/null | jq -c '.capabilities.providers.selection // {} | {search, extractionModel, parser, proxy, enhanced, source}' 2>/dev/null || true)
  if [ "$got" = "$want_run" ]; then
    echo "selection applied: search=$search model=$model parser=$parser proxy=$proxy enhanced=$enh utc=$(date -u +%Y-%m-%dT%H:%M:%SZ)"; exit 0
  fi
  sleep 2
done
echo "the retrieval service did not report the new selection within 90 s (it reports: ${got:-nothing})" >&2; exit 1
