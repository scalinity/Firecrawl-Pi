#!/usr/bin/env bash
# The functional probe (FIRECRAWL_PI_SPEC.md §24.1, §25), run by fcpi-probe.timer every five minutes as root, ON the Pi.
# It exercises a controlled fixture, never a third-party page: a scrape of the M1 static fixture through the gateway
# (its sentinel must be in the Markdown), a modern MCP tools/list, and the gateway's platform status (core, ledger,
# providers). The result goes to /var/log/firecrawl-pi/probe/<UTC day>.jsonl and /var/lib/firecrawl-pi/probe-last.json,
# which fcpi status shows as the cached functional check and the tick turns into an incident after two failures in a
# row. The probe also watches the tick: a last sample older than three minutes opens the tick_stale incident here,
# since a stopped tick cannot report itself.
set -uo pipefail
. "$(dirname "$(readlink -f "$0")")/lib.sh"
need_root
exec 9>"$RUND/probe.lock"; flock -n 9 || exit 0
mkdir -p "$LOGD/probe"
T=$(utc)
FIXTURE=http://m1.fixture.fcpi.test:8080/static.html SENTINEL=fcpi-m1-static-7f3a

GW_TIMEOUT=60 gw POST /v2/scrape "$(jq -cn --arg u "$FIXTURE" '{url:$u,formats:["markdown"]}')"
scrape_ok=false; [ "$GW_STATUS" = 200 ] && jq -e --arg s "$SENTINEL" '.success == true and (.data.markdown | contains($s))' <<<"$GW_BODY" >/dev/null 2>&1 && scrape_ok=true
scrape=$(jq -cn --argjson ok "$scrape_ok" --arg st "$GW_STATUS" --argjson ms "$GW_MS" --arg code "$(jq -r '.code // empty' <<<"$GW_BODY" 2>/dev/null)" '{ok:$ok,status:($st|tonumber),ms:$ms,code:($code|if .=="" then null else . end)}')
GW_TIMEOUT=20 mcp tools/list '{}'
mcp_ok=false; [ "$GW_STATUS" = 200 ] && jq -e '(.result.tools | length) > 0' <<<"$GW_BODY" >/dev/null 2>&1 && mcp_ok=true
mcpj=$(jq -cn --argjson ok "$mcp_ok" --arg st "$GW_STATUS" --argjson ms "$GW_MS" '{ok:$ok,status:($st|tonumber),ms:$ms}')
GW_TIMEOUT=20 gw GET /platform/v1/status
plat='{"ok":false}'
[ "$GW_STATUS" = 200 ] && plat=$(jq -c --argjson ms "$GW_MS" '{ok:true, ms:$ms, core_live:.core.live, ledger_ok:.ledger.ok,
  providers:(.providers // null | if type == "object" then (del(.budgets) | tostring | .[0:600]) else null end)}' <<<"$GW_BODY" 2>/dev/null || echo '{"ok":false}')

prev=0; [ -r "$STATE/probe-last.json" ] && prev=$(jq -r '.consecutive_failures // 0' "$STATE/probe-last.json")
ok=false; [ "$scrape_ok" = true ] && [ "$mcp_ok" = true ] && ok=true
# A failure while a hold is in force (the backup stops the services, an operator pauses work) is recorded but not
# counted: the hold caused it.
held=false; [ -n "$(holds_live)" ] && held=true
fails=0; if [ "$ok" != true ]; then if [ "$held" = true ]; then fails=$prev; else fails=$((prev + 1)); fi; fi
line=$(jq -cn --arg utc "$T" --arg boot "$(boot_hash)" --argjson ok "$ok" --argjson held "$held" --argjson f "$fails" --argjson s "$scrape" --argjson m "$mcpj" --argjson p "$plat" \
  '{utc:$utc,boot:$boot,ok:$ok,held:$held,consecutive_failures:$f,scrape:$s,mcp:$m,platform:$p}')
append_line "$LOGD/probe/${T%%T*}.jsonl" "$line"
printf '%s\n' "$line" | write_atomic "$STATE/probe-last.json" 0644

# The tick's freshness.
# A sample file without a readable time (a partial write) counts as no sample, never as an arithmetic error that ends
# the probe before this check.
age=999999; st=$(jq -r '.utc | fromdateiso8601' "$RUND/last-sample.json" 2>/dev/null); [[ $st =~ ^[0-9]+$ ]] && age=$(( $(now_s) - st ))
flag=$STATE/alerts/tick-stale.open
if [ "$age" -gt 180 ] && [ ! -e "$flag" ]; then notice opened tick_stale "{\"sample_age_s\":$age}"; touch "$flag"
elif [ "$age" -le 180 ] && [ -e "$flag" ]; then notice cleared tick_stale "{\"sample_age_s\":$age}"; rm -f "$flag"; fi
exit 0
