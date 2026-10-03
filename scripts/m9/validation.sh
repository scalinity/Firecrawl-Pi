#!/usr/bin/env bash
# Fresh M9 grant only. Timer and absolute expiry are armed before paid dispatch;
# base Compose and its zero caps are never edited. Credentials confer no consent.
set -euo pipefail
R=/opt/firecrawl-pi D=/etc/firecrawl-pi/m9-validation
C=(sudo -n docker compose -p fcpi -f "$R/deploy/compose.yaml")
case ${1:-} in
 start)
  sudo -n test -s "$D/consent.json" || { echo 'fresh M9 owner consent absent' >&2; exit 2; }
  g=$(sudo -n cat "$D/consent.json")
  jq -e --arg source "$(cat "$R/.fcpi-source-commit")" '.scope=="M9 acceptance" and .source_commit==$source and (.expires_at|fromdateiso8601)>now and (.expires_at|fromdateiso8601)<=now+3600 and .llm_micro_usd<=20000 and .proxy_micro_usd<=100000 and .enhanced_micro_usd<=100000 and .parser_credits<=20 and .llm_micro_usd>=0 and .proxy_micro_usd>=0 and .enhanced_micro_usd>=0 and .parser_credits>=0' <<<"$g" >/dev/null || exit 2
  sudo -n test ! -e "$D/override.yaml" || exit 2
  jq --argjson g "$g" '.validationExpiresAt=$g.expires_at | .categories.llm.caps={day:$g.llm_micro_usd,month:$g.llm_micro_usd} | .categories.proxy.caps={day:$g.proxy_micro_usd,month:$g.proxy_micro_usd} | .categories.enhanced.caps={day:$g.enhanced_micro_usd,month:$g.enhanced_micro_usd} | .categories.parser.caps={month:$g.parser_credits} | .paidTotal.caps={day:($g.llm_micro_usd+$g.proxy_micro_usd+$g.enhanced_micro_usd),month:($g.llm_micro_usd+$g.proxy_micro_usd+$g.enhanced_micro_usd)} | .parsing.maxPages=2 | (.rateCards[]|select(.subject=="llamaparse-cost-effective")|.microUsdPerCredit)=0' "$R/deploy/policies/budget.json" | sudo -n tee "$D/budget.json" >/dev/null
  sudo -n chown 3310:3310 "$D/budget.json"; sudo -n chmod 0600 "$D/budget.json"
  sudo -n tee "$D/override.yaml" >/dev/null <<'YAML'
services:
  retrieval-service:
    restart: "no"
    environment:
      PI_PAID_DISPATCH_ENABLED: "true"
    volumes:
      - type: bind
        source: /etc/firecrawl-pi/m9-validation/budget.json
        target: /srv/policy/budget.json
        read_only: true
        bind: { create_host_path: false }
YAML
  sudo -n chmod 0600 "$D/override.yaml"
  trap 'bash "$R/scripts/m9/validation.sh" stop' ERR
  sudo -n systemd-run --quiet --unit=fcpi-m9-stop --on-active=45m /bin/bash "$R/scripts/m9/validation.sh" stop
  "${C[@]}" -f "$D/override.yaml" up -d --no-deps --force-recreate --wait --wait-timeout 180 retrieval-service
  echo 'm9_validation=true timer=45m absolute_expiry=true source_bound=true'
  ;;
 stop)
  "${C[@]}" up -d --no-deps --force-recreate --wait --wait-timeout 180 retrieval-service
  sudo -n rm -f "$D/override.yaml" "$D/budget.json" "$D/consent.json"
  sudo -n systemctl stop fcpi-m9-stop.timer 2>/dev/null || true
  echo 'm9_validation=false production_paid=false caps=zero'
  ;;
 *) echo 'usage: validation.sh start|stop' >&2; exit 2 ;;
esac
