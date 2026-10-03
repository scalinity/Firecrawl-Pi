#!/usr/bin/env bash
# One bounded owner-authorized validation window. Base Compose and its zero caps stay unchanged.
# Run ON the Pi: pi-validation.sh start|stop|status. A transient timer closes the window after 45 minutes;
# reboot also starts only base Compose. The monthly category caps prevent crossing midnight resetting spend.
set -euo pipefail
export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
REPO=/opt/firecrawl-pi
DIR=/etc/firecrawl-pi/pre-m9-validation
C=(sudo -n docker compose -p fcpi -f "$REPO/deploy/compose.yaml")
case ${1:-} in
  start)
    # Proxy stays refused until the required provider-side cap has been verified by the operator.
    proxy_cap=${FCPI_PRE_M9_PROXY_CAP_MICROUSD:-0}
    case $proxy_cap in 0|200000) ;; *) echo 'proxy validation cap must be 0 or 200000 microUSD' >&2; exit 2 ;; esac
    sudo -n test ! -e "$DIR/override.yaml" || { echo 'validation window already exists; stop it first' >&2; exit 2; }
    sudo -n install -d -m 0750 -o 3310 -g 3310 "$DIR"
    # Lower than owner ceilings: $0.05 model, $0.20 proxy, $0.05 enhanced, 100 free parser credits.
    expires=$(date -u -d '+45 minutes' +%Y-%m-%dT%H:%M:%SZ)
    jq --arg expires "$expires" --argjson proxy_cap "$proxy_cap" '.validationExpiresAt = $expires | .categories.llm.caps = {day:50000,month:50000} |
        .categories.proxy.caps = {day:$proxy_cap,month:$proxy_cap} |
        .categories.enhanced.caps = {day:50000,month:50000} |
        .categories.parser.caps = {month:100} | .paidTotal.caps.day = 300000 |
        .parsing.maxPages = 10 |
        (.rateCards[] | select(.subject == "llamaparse-cost-effective") | .microUsdPerCredit) = 0' \
      "$REPO/deploy/policies/budget.json" | sudo -n tee "$DIR/budget.json" >/dev/null
    sudo -n chown 3310:3310 "$DIR/budget.json"
    sudo -n chmod 0600 "$DIR/budget.json"
    sudo -n tee "$DIR/override.yaml" >/dev/null <<'YAML'
services:
  retrieval-service:
    restart: "no"
    environment:
      PI_PAID_DISPATCH_ENABLED: "true"
    volumes:
      - type: bind
        source: /etc/firecrawl-pi/pre-m9-validation/budget.json
        target: /srv/policy/budget.json
        read_only: true
        bind:
          create_host_path: false
YAML
    sudo -n chmod 0600 "$DIR/override.yaml"
    # Arm the shutoff before paid dispatch can become true. A failed start always resets to base Compose.
    trap 'bash "$REPO/scripts/pre-m9/pi-validation.sh" stop' ERR
    sudo -n systemd-run --quiet --unit=fcpi-pre-m9-stop --on-active=45m \
      /bin/bash "$REPO/scripts/pre-m9/pi-validation.sh" stop
    "${C[@]}" -f "$DIR/override.yaml" config -q
    "${C[@]}" -f "$DIR/override.yaml" up -d --no-deps --force-recreate --wait --wait-timeout 180 retrieval-service
    echo "validation_started utc=$(date -u +%Y-%m-%dT%H:%M:%SZ) expires=$expires policy_sha256=$(sudo -n sha256sum "$DIR/budget.json" | cut -d' ' -f1) shutoff=45min"
    ;;
  stop)
    "${C[@]}" up -d --no-deps --force-recreate --wait --wait-timeout 180 retrieval-service
    sudo -n rm -f "$DIR/override.yaml" "$DIR/budget.json"
    sudo -n systemctl stop fcpi-pre-m9-stop.timer 2>/dev/null || true
    echo "validation_stopped utc=$(date -u +%Y-%m-%dT%H:%M:%SZ) paid_dispatch=false production_caps=zero"
    ;;
  status)
    sudo -n systemctl is-active fcpi-pre-m9-stop.timer || true
    sudo -n docker inspect -f '{{range .Config.Env}}{{println .}}{{end}}' fcpi-retrieval-service-1 | sed -n '/^PI_PAID_DISPATCH_ENABLED=/p'
    ;;
  *) echo 'usage: pi-validation.sh start|stop|status' >&2; exit 2 ;;
esac
