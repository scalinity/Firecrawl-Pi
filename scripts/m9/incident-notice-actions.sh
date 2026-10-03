#!/usr/bin/env bash
# Best-effort action generation is separate from delivery of the outage notice.
set -euo pipefail
id=${1:?}; kind=${2:?}; what='Private incident report'
[[ $id =~ ^[0-9a-f]{8}$ ]] || exit 2
  REPO=/opt/firecrawl-pi C=/var/lib/firecrawl-pi/incidents/control
  # Use the private Tailscale Serve origin, never open a new ingress for actions.
  origin=$(grep '^https://.*\.ts\.net$' /etc/firecrawl-pi/secrets/gateway/served-origins | head -1)
  [ -n "$origin" ] || exit 2
  case $kind in
    opened) verbs='["investigate","details","dismiss"]' ;;
    approval_required) verbs='["apply_fix","details","dismiss"]' ;;
    deployment_failed) verbs='["rollback","details"]' ;;
    *) verbs='["details","dismiss"]' ;;
  esac
  base=$(cat "$REPO/.fcpi-source-commit")
  report=/var/lib/firecrawl-pi/incidents/work/$id/harvested.json
  if [ -r "$report" ]; then
    proposal_base=$(jq -r .base_sha "$report")
    if [ "$kind" = approval_required ]; then
      base=$proposal_base
      [ "$base" = "$(cat "$REPO/.fcpi-source-commit")" ] || verbs='["details","dismiss"]'
    fi
    # A concrete patch and its test result are visible in the private report.
    jq --arg base "$base" --rawfile patch "/var/lib/firecrawl-pi/incidents/work/$id/patch.diff" '. + {proposal_base_sha:.base_sha,base_sha:$base,patch:$patch}' "$report" >"$C/reports/$id.new"
    chmod 0640 "$C/reports/$id.new"; chown root:3380 "$C/reports/$id.new"; mv "$C/reports/$id.new" "$C/reports/$id.json"
    patch=$(jq -r .patch_sha "$report"); tests=$(jq -r .tests_sha "$report")
  else
    patch='' tests=''
    jq -n --arg id "$id" --arg base "$base" --arg what "$what" '{schema:"fcpi.incident-report/v1",incident_id:$id,base_sha:$base,state:"OPEN",observed_symptom:$what}' >"$C/reports/$id.new"
    chmod 0640 "$C/reports/$id.new"; chown root:3380 "$C/reports/$id.new"; mv "$C/reports/$id.new" "$C/reports/$id.json"
  fi
  input=$(jq -cn --arg origin "$origin" --arg id "$id" --arg base "$base" --arg patch "$patch" --arg tests "$tests" --argjson actions "$verbs" \
    '{origin:$origin,incident_id:$id,base_sha:$base,patch_sha:(if $patch=="" then null else $patch end),tests_sha:(if $tests=="" then null else $tests end),actions:$actions}')
  image=$(docker inspect -f '{{.Image}}' fcpi-access-gateway-1)
  actions=$(printf '%s\n' "$input" | docker run --rm -i --label fcpi.transient=incident-actions --network none --read-only --user 3382:3380 --cgroup-parent fcpi.slice \
    --cap-drop ALL --security-opt no-new-privileges --memory 128m --memory-swap 128m --cpus 0.3 --pids-limit 32 \
    -v "$REPO:/repo:ro" -v "$C/grants:/grants" -v /etc/firecrawl-pi/secrets/incident_signing_key:/run/secrets/incident_signing_key:ro \
    "$image" node /repo/scripts/m9/incident-actions.mjs) || exit 2
  while IFS= read -r grant; do
    [[ $grant =~ ^[0-9a-f]{32}$ ]] || exit 2
    install -m 0640 -o root -g 3380 "$C/reports/$id.json" "$C/reports/$grant.json"
  done < <(jq -r '.[].url | capture("/action/(?<id>[0-9a-f]{32})").id' <<<"$actions")
  printf '%s\n' "$actions"
