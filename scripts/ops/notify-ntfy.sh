#!/usr/bin/env bash
# One notice to the owner's phone through ntfy (FIRECRAWL_PI_SPEC.md §25), ON the Pi, as root: the command
# /etc/firecrawl-pi/alerts.env names (FCPI_ALERT_COMMAND), which the tick runs with one notice's JSON on stdin
# (scripts/ops/lib.sh deliver_notices, within 20 s). It publishes to the hosted ntfy.sh over HTTPS as JSON posted to the
# server's root, the topic inside the body, so the topic never appears in a URL, on a command line or in a log. The topic
# (/etc/firecrawl-pi/secrets/alerts/ntfy_topic, 0600: 64 random hex characters, the only thing guarding an anonymous
# topic) is a secret. A message holds operational metadata only: its class, the incident in plain words, the short
# incident id, and on recovery the duration; never a detail value, a URL, a name from a log or anything scraped.
# Exit 0 only when ntfy accepted the message.
#
# The event model the owner's phone receives, one class a message (M9 adds the authenticated actions; "actions" is
# already in the schema and left empty in M8, which exposes no control endpoint):
#   incident_opened, recovery_succeeded, recovery_failed                   M8: the tick's incidents
#   recovery_attempted, investigation_started, diagnosis_ready, approval_required     M9's incident workflow
#   watchdog_unreachable, watchdog_reachable                                the VPS watchdog (scripts/m8/vps-watchdog.sh)
set -uo pipefail
export LC_ALL=C PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
TOPIC_FILE=${FCPI_NTFY_TOPIC_FILE:-/etc/firecrawl-pi/secrets/alerts/ntfy_topic}
[ -r "$TOPIC_FILE" ] || { echo "no $TOPIC_FILE" >&2; exit 2; }
n=$(cat); jq -e 'type == "object" and (.kind | type) == "string" and (.incident | type) == "string"' >/dev/null 2>&1 <<<"$n" || { echo "not a notice" >&2; exit 2; }
key=$(jq -r .incident <<<"$n") kind=$(jq -r .kind <<<"$n")
base=${key%%:*} svc=${key#*:}; [ "$svc" = "$key" ] && svc=""
# The incident in plain words, and how urgent an opening is: 5 when the platform cannot serve or cannot watch itself,
# 4 when it degrades or its safety net fails, 3 for the rest.
case $base in
  core_unhealthy) what="Firecrawl core unhealthy"; pri=5 ;;
  queue_unreadable) what="Job queue unreadable (PostgreSQL)"; pri=5 ;;
  functional_probe_failing) what="Functional probe failing (scrape or MCP)"; pri=5 ;;
  tick_stale) what="Host monitor (tick) stopped"; pri=5 ;;
  disk_critical) what="Data disk critically low; new work paused"; pri=5 ;;
  restart_budget_or_data_service) what="Automatic restarts exhausted for ${svc:-a service}"; pri=5 ;;
  queue_stalled) what="Job queue stalled"; pri=4 ;;
  memory_low) what="Available memory low; new work paused"; pri=4 ;;
  temperature_high) what="Temperature high; browser work paused"; pri=4 ;;
  oom_kill) what="Out-of-memory kill${svc:+ in $svc}"; pri=4 ;;
  swap_limit_lost) what="Swap limit lost${svc:+ for $svc}"; pri=4 ;;
  redis_acl_denied) what="Redis refused a command to the core"; pri=4 ;;
  backup_missing|backup_stale) what="Backup overdue"; pri=4 ;;
  backup_quiescence_over_budget) what="Backup held the platform past five minutes"; pri=4 ;;
  backup_check_failed|backup_check_stale) what="Backup repository check failed or overdue"; pri=4 ;;
  restore_test_failed|restore_test_stale) what="Restore test failed or overdue"; pri=4 ;;
  restore_copy_running) what="Restore copy left running"; pri=4 ;;
  disk_low) what="Data disk low"; pri=3 ;;
  throttle_flag) what="Power or thermal throttle flag set"; pri=3 ;;
  foreign_container) what="Container outside the project"; pri=3 ;;
  *) what="Incident $base"; pri=4 ;;
esac
id=$(jq -r '.incident_id // "-"' <<<"$n")
[[ $id =~ ^[0-9a-f]{8}$ ]] || exit 2
dur() { local s=$1; if [ "$s" -ge 3600 ]; then printf '%dh %02dm' $((s / 3600)) $((s % 3600 / 60)); elif [ "$s" -ge 60 ]; then printf '%dm %02ds' $((s / 60)) $((s % 60)); else printf '%ds' "$s"; fi; }
case $kind in
  opened) if [ "$base" = restart_budget_or_data_service ]; then class=recovery_failed title="Firecrawl Pi — Recovery failed"; tags='["x"]'
          else class=incident_opened title="Firecrawl Pi — Incident"; if [ "$pri" -ge 5 ]; then tags='["rotating_light"]'; else tags='["warning"]'; fi; fi
          msg="$what."$'\n'"Incident: $id" ;;
  cleared) class=recovery_succeeded title="Firecrawl Pi — Recovered" pri=3 tags='["white_check_mark"]'
           msg="$what: cleared."$'\n'"Incident: $id"$'\n'"Duration: $(dur "$(jq -r '.duration_s // 0' <<<"$n")")" ;;
  recovery_attempted|investigation_started|diagnosis_ready|approval_required|deployment_failed)
    class=$kind; pri=4; tags='["mag"]'
    case $kind in
      recovery_attempted) title='Firecrawl Pi — Recovery attempted' ;;
      investigation_started) title='Firecrawl Pi — Investigation started' ;;
      diagnosis_ready) title='Firecrawl Pi — Claude diagnosis' ;;
      approval_required) title='Firecrawl Pi — Approval required' ;;
      deployment_failed) title='Firecrawl Pi — Deployment failed' ;;
    esac
    msg="$what."$'\n'"Incident: $id" ;;
  *) echo "unknown notice kind $kind" >&2; exit 2 ;;
esac
actions='[]'
if [ -r /etc/firecrawl-pi/incidents.env ] && grep -qx 'FCPI_INCIDENT_ENABLED=true' /etc/firecrawl-pi/incidents.env; then
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
    # A concrete patch and its test result are visible in the private report.
    jq --arg base "$base" --rawfile patch "/var/lib/firecrawl-pi/incidents/work/$id/patch.diff" '. + {proposal_base_sha:.base_sha,base_sha:$base,patch:$patch}' "$report" >"$C/reports/$id.new"
    chmod 0640 "$C/reports/$id.new"; chown root:3380 "$C/reports/$id.new"; mv "$C/reports/$id.new" "$C/reports/$id.json"
    patch=$(jq -r .patch_sha "$report"); tests=$(jq -r .tests_sha "$report")
    msg+=$'\n'"Files changed: $(jq -r .changed_files "$report"); test exit: $(jq -r .test_exit "$report")."$'\n'"Patch: ${patch:0:12}"
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
    "$image" node /repo/scripts/m9/incident-actions.mjs) || exit 1
fi
jq -cn --rawfile t "$TOPIC_FILE" --arg title "$title" --arg msg "$msg" --argjson pri "$pri" --argjson tags "$tags" --arg class "$class" --arg id "$id" \
  --argjson actions "$actions" '{topic: ($t | gsub("\\s"; "")), title: $title, message: $msg, priority: $pri, tags: ($tags + ["fcpi", $class]), actions: $actions}' \
  | curl -sS --proto =https --tlsv1.2 --max-time 15 --fail-with-body -H 'Content-Type: application/json' --data-binary @- https://ntfy.sh/ >/dev/null
