#!/usr/bin/env bash
# fcpi usage [--period day|month|<N>d] [--json] (FIRECRAWL_PI_SPEC.md §25, §28), as root ON the Pi, read-only. Over the
# period: the gateway's requests by route and status (from its jobs ledger: jobs by kind and state), acquisitions and
# their attempts by strategy (the escalation tiers) and outcome, bytes fetched, provider calls by category and state with
# reserved against settled amounts (estimated against reconciled spend), each category's period usage against its cap,
# and the residential provider's byte reconciliation. Amounts are the budget policy's integers (micro-USD or credits).
set -uo pipefail
. "$(dirname "$(readlink -f "$0")")/lib.sh"
need_root
period=day json=false
while [ $# -gt 0 ]; do case $1 in --period) period=$2; shift 2 ;; --json) json=true; shift ;; *) die "unknown option $1" ;; esac; done
case $period in day) since="date_trunc('day', now())" ;; month) since="date_trunc('month', now())" ;;
  *) [[ $period =~ ^[0-9]{1,4}d$ ]] || die "period is day, month or <N>d (1-9999)"; since="now() - interval '${period%d} days'" ;; esac
q() { pg "$1" | jq -Rsc --argjson cols "$2" 'split("\n") | map(select(. != "") | split("|") | [$cols, .] | transpose | map({key: .[0], value: (.[1] | tonumber? // .)}) | from_entries)'; }
out=$(jq -n --arg p "$period" --arg utc "$(utc)" \
  --argjson jobs "$(q "SELECT kind, state, count(*), coalesce(sum(units),0) FROM fcpi_platform.job WHERE created_at >= $since GROUP BY 1,2 ORDER BY 1,2" '["kind","state","jobs","units"]')" \
  --argjson acq "$(q "SELECT count(*), coalesce(sum(attempts),0) FROM fcpi_retrieval.acquisition WHERE first_seen >= $since" '["acquisitions","attempts"]')" \
  --argjson tiers "$(q "SELECT strategy, coalesce(outcome,'(running)'), count(*), coalesce(sum(bytes),0) FROM fcpi_retrieval.attempt WHERE started_at >= $since GROUP BY 1,2 ORDER BY 1,2" '["strategy","outcome","attempts","bytes"]')" \
  --argjson calls "$(q "SELECT category, provider, state, count(*), coalesce(sum(reserved),0), coalesce(sum(actual),0) FROM fcpi_retrieval.budget_reservation WHERE created_at >= $since GROUP BY 1,2,3 ORDER BY 1,2,3" '["category","provider","state","calls","reserved","settled"]')" \
  --argjson periods "$(q "SELECT category, period, period_start, reserved, settled FROM fcpi_retrieval.budget_usage WHERE (period = 'day' AND period_start = current_date) OR (period = 'month' AND period_start = date_trunc('month', current_date)::date) ORDER BY 1,2" '["category","period","start","reserved","settled"]')" \
  --argjson recon "$(q "SELECT provider, day, local_bytes, provider_bytes, adjustment_micro_usd FROM fcpi_retrieval.proxy_reconciliation WHERE at >= $since ORDER BY at" '["provider","day","local_bytes","provider_bytes","adjustment_micro_usd"]')" \
  --argjson caps "$(jq -c '.categories | map_values({paid, unit, caps})' "$REPO/deploy/policies/budget.json")" \
  '{utc:$utc, period:$p, jobs:$jobs, acquisitions:$acq[0], attempts_by_tier:$tiers, provider_calls:$calls,
    budget_periods:($periods | map(. + {cap: ($caps[.category].caps[.period] // null), paid: ($caps[.category].paid // null), unit: ($caps[.category].unit // null)})),
    proxy_reconciliation:$recon}')
if [ $json = true ]; then jq . <<<"$out"; else
  jq -r '"usage over \(.period) (to \(.utc))",
    "jobs        \(.jobs | map("\(.kind)/\(.state) \(.jobs)") | join(", ") | if . == "" then "none" else . end)",
    "acquisitions \(.acquisitions.acquisitions // 0), attempts \(.acquisitions.attempts // 0)",
    (.attempts_by_tier[] | "  \(.strategy) \(.outcome): \(.attempts) attempts, \(.bytes) bytes"),
    "provider calls",
    (.provider_calls[] | "  \(.category)/\(.provider) \(.state): \(.calls) calls, reserved \(.reserved), settled \(.settled)"),
    "budget periods (reserved/settled of cap)",
    (.budget_periods[] | "  \(.category) \(.period) \(.start): \(.reserved)/\(.settled) of \(.cap // "-") \(.unit // "")\(if .paid then " (paid)" else "" end)")' <<<"$out"; fi
