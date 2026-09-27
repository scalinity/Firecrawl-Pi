#!/usr/bin/env bash
# The retrieval service's running container's log, counted (M6's scan with M7's additions): acquisitions with their route
# fields, residential proxy use, route holds, reconciliation, enhanced dispatches, webhook attempts and renders with
# extras, and what must never be there (secrets, Authorization and Proxy-Authorization values, the proxy session
# username, a webhook signature, Cloud hosts), with the lines read as the positive control. The fixture proxy's
# credential, the fixture enhanced provider's key and the webhook signing secret are looked for by value, read here into
# awk's variables and printed only as counts. Read-only. Runs ON the Pi, from scripts/m7/pi-collect-stack.sh and from the
# evidence driver before it recreates the container:
#   ssh … 'bash /opt/firecrawl-pi/scripts/m7/pi-retrieval-log-scan.sh'
set -uo pipefail
export LC_ALL=C
export PATH="/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"
REPO=/opt/firecrawl-pi
S=/etc/firecrawl-pi/secrets
D() { sudo -n docker "$@"; }
RS=$(D ps -q --filter label=com.docker.compose.project=fcpi --filter label=com.docker.compose.service=retrieval-service)
echo "container=$(D inspect -f '{{.Id}}' "$RS" | cut -c1-12) started_at=$(D inspect -f '{{.State.StartedAt}}' "$RS")"
FXC=$(sudo -n cat $S/providers/fixture_proxy 2>/dev/null) ZK=$(sudo -n cat $S/providers/fixture_zyte 2>/dev/null) WS=$(sudo -n cat $S/webhook_signing_secret 2>/dev/null)
D logs "$RS" 2>&1 | FXC="$FXC" ZK="$ZK" WS="$WS" awk '
  BEGIN { fxc = ENVIRON["FXC"]; fxpw = substr(fxc, index(fxc, ":") + 1); zk = ENVIRON["ZK"]; ws = ENVIRON["WS"] }
  { lines++ }
  /"event":"search"/ { search++ } /"event":"model_call"/ { model++ } /"event":"parse"/ { parse++ } /"event":"extraction"/ { extraction++ }
  /"event":"proxy_request"/ { proxied++ } /"route":"residential"/ { residential++ } /"event":"budget_loaded"/ { budget++ } /"event":"selection_loaded"/ { selection++ }
  /"event":"acquisition"/ { acq++; if ($0 ~ /"initial_strategy"/ && $0 ~ /"final_strategy"/ && $0 ~ /"attempts_used"/ && $0 ~ /"route_requested"/ && $0 ~ /"enhanced_state"/) acq_fields++ }
  /"event":"route_held"/ { held++ } /"event":"route_released"/ { released++ } /"event":"proxy_reconciled"/ { reconciled++ }
  /"event":"enhanced"/ { enhanced++ } /"event":"webhook_attempt"/ { webhook++ } /"hooks":\{"screenshot"/ { extras++ }
  /sk-[A-Za-z0-9_-]{20,}/ { key++ } /llx-[A-Za-z0-9]{20,}/ { key++ } /fcpi_[a-z0-9]+_[0-9a-f]{32,}/ { token++ } /Bearer [A-Za-z0-9._~+\/-]{20,}/ { bearer++ }
  /[Pp]roxy-[Aa]uthorization/ { proxyauth++ } /Basic [A-Za-z0-9+\/=]{16,}/ { basic++ } /user-[A-Za-z0-9_]+-session-/ { username++ }
  /[Xx]-[Ff]cpi-[Ss]ignature|v1=[0-9a-f]{64}/ { signature++ }
  (length(fxpw) >= 16 && index($0, fxpw) > 0) { fxcred++ } (length(zk) >= 16 && index($0, zk) > 0) { zkey++ } (length(ws) >= 32 && index($0, ws) > 0) { wsecret++ }
  /firecrawl\.(dev|com)|mendable\.ai/ { cloud++ }
  END { printf "lines=%d search=%d model_call=%d parse=%d extraction=%d proxy_request=%d residential_route=%d budget_loaded=%d selection_loaded=%d acquisition=%d acquisition_with_route_fields=%d route_held=%d route_released=%d proxy_reconciled=%d enhanced=%d webhook_attempt=%d renders_with_extras=%d provider_key_like=%d client_token_like=%d bearer=%d proxy_authorization=%d basic_credential=%d session_username=%d signature=%d fixture_credential=%d fixture_credential_readable=%s zyte_fixture_key=%d zyte_fixture_key_readable=%s webhook_secret=%d webhook_secret_readable=%s cloud_host=%d\n", lines, search, model, parse, extraction, proxied, residential, budget, selection, acq, acq_fields, held, released, reconciled, enhanced, webhook, extras, key, token, bearer, proxyauth, basic, username, signature, fxcred, (length(fxpw) >= 16 ? "yes" : "no"), zkey, (length(zk) >= 16 ? "yes" : "no"), wsecret, (length(ws) >= 32 ? "yes" : "no"), cloud }'
unset FXC ZK WS
echo "budget_policy_sha256_logged=$(D logs "$RS" 2>&1 | jq -r 'select(.event=="budget_loaded") | .budget_sha256' 2>/dev/null | tail -1) budget_policy_sha256_deployed=$(sha256sum $REPO/deploy/policies/budget.json | cut -c1-64)"
echo "switches_logged=$(D logs "$RS" 2>&1 | jq -c 'select(.event=="budget_loaded") | {browser_extras, webhook_delivery, enhancers}' 2>/dev/null | tail -1)"
