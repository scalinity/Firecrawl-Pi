#!/usr/bin/env bash
# Trusted M9 host controller. Polling never waits for Claude; its isolated unit is
# bounded separately. Grants queue fixed verbs, never shell text or provider policy.
set -euo pipefail
. "$(dirname "$(readlink -f "$0")")/../ops/lib.sh"
need_root
D=$STATE/incidents C=$STATE/incidents/control
# Cleanup also runs while automatic investigation is disabled. A namespace
# failure can prevent the unprivileged agent's EXIT trap from ever starting.
# The preparation lock excludes the interval before its unit has been launched.
exec 9>"$D/prepare.lock"
if flock -n 9; then
 for w in "$D"/work/*; do
  [ -d "$w" ] || continue
  id=${w##*/}; [[ $id =~ ^[0-9a-f]{8}$ ]] || continue
  systemctl is-active --quiet "fcpi-incident-$id.service" && continue
  rm -f "$w/run/auth/access-token"
 done
 flock -u 9
fi
exec 9>&-
[ -r /etc/firecrawl-pi/incidents.env ] || exit 0
grep -qx 'FCPI_INCIDENT_ENABLED=true' /etc/firecrawl-pi/incidents.env || exit 0
exec 7>"$D/control.lock"; flock -n 7 || exit 0
case ${1:-tick} in tick) ;; *) die 'usage: incident-control.sh tick' ;; esac
handled=0
for f in "$C"/requests/*.json; do
 [ -f "$f" ] || continue
 grant=${f##*/}; grant=${grant%.json}; [[ $grant =~ ^[0-9a-f]{32}$ ]] || continue
 [ ! -e "$C/processed/$grant.json" ] || continue
 handled=$((handled + 1)); [ "$handled" -le 16 ] || break
 [ "$(stat -c %s "$f")" -le 8192 ] || { put_obj "$C/processed/$grant.json" 0600 '{"state":"REJECTED_OVERSIZE"}'; continue; }
 raw=$(cat "$f")
 image=$(docker inspect -f '{{.Image}}' "$(cid access-gateway)" 2>/dev/null) || image=''
 proof_rc=1
 if [ -n "$image" ]; then
 if g=$(printf '%s\n' "$raw" | docker run --rm -i --label fcpi.transient=incident-proof --network none --read-only --user 3380:3380 --cgroup-parent fcpi.slice \
  --cap-drop ALL --security-opt no-new-privileges --memory 128m --memory-swap 128m --cpus 0.3 --pids-limit 32 \
  -v "$REPO:/repo:ro" -v "$C:/control:ro" "$image" node /repo/scripts/m9/incident-verify.mjs "$grant" 2>/dev/null); then
  proof_rc=0
 else proof_rc=$?; fi
 fi
 if [ "$proof_rc" != 0 ]; then
  if [ "$proof_rc" = 3 ]; then
   put_obj "$C/processed/$grant.json" 0600 '{"state":"REJECTED_INVALID_OR_EXPIRED_PROOF"}'
   notice diagnosis_ready 'incident_proof' '{"state":"REJECTED_INVALID_OR_EXPIRED_PROOF","owner_attention_required":true}' "$(now_s)" "${grant:0:8}"
  elif [ ! -e "$D/blocked/proof-$grant.json" ]; then
   put_obj "$D/blocked/proof-$grant.json" 0600 '{"state":"PROOF_INFRASTRUCTURE_BLOCKED","approval_consumed":false}'
   notice diagnosis_ready 'incident_proof' '{"state":"PROOF_INFRASTRUCTURE_BLOCKED","approval_consumed":false,"owner_attention_required":true}' "$(now_s)" "${grant:0:8}"
  fi
  continue
 fi
 rm -f "$D/blocked/proof-$grant.json"
 id=$(jq -er .incident_id <<<"$g"); action=$(jq -er .action <<<"$g")
 [[ $id =~ ^[0-9a-f]{8}$ ]] || continue
 # The approved deployed base must still be current; an intervening release needs
 # a new review and a new approval. An old phone notice cannot deploy over it.
 [ "$(jq -r .base_sha <<<"$g")" = "$(source_commit)" ] || {
   put_obj "$C/processed/$grant.json" 0600 '{"state":"REJECTED_STALE_BASE"}'; continue;
 }
 # Journal before executing: crashes cannot turn a partial consequential action
 # into an implicit retry. Such a record stays uncertain for owner investigation.
 put_obj "$C/processed/$grant.json" 0600 "$(jq -c '. + {state:"EXECUTION_STARTED"}' <<<"$g")"
 sync -f "$C/processed/$grant.json"; sync -f "$C/processed"
 rc=0
 case $action in
  investigate) if [ -e "$D/work/$id" ]; then bash "$REPO/scripts/m9/incident-prepare.sh" "$id" --resume || rc=$?; else bash "$REPO/scripts/m9/incident-prepare.sh" "$id" || rc=$?; fi ;;
  details) : ;;
  dismiss) put_obj "$C/dismissed/$id.json" 0600 "$(jq -c '{incident_id,approved_at}' <<<"$g")" ;;
  apply_fix|rollback)
   args=("$id" "$grant"); [ "$action" != rollback ] || args+=(--rollback)
   if systemd-run --quiet --unit="fcpi-incident-apply-$id" --collect --property=Slice=fcpi.slice --property=MemoryMax=512M --property=MemorySwapMax=0 --property=TasksMax=128 --property=RuntimeMaxSec=3600 --property=TimeoutStopSec=120 --property=KillMode=mixed --property=NoNewPrivileges=yes /bin/bash "$REPO/scripts/m9/incident-apply.sh" "${args[@]}"; then
    # The apply unit records the final disposition; tick remains available.
    continue
   else rc=$?; fi ;;
  *) die 'unknown incident action' ;;
 esac
 put_obj "$C/processed/$grant.json" 0600 "$(jq -c --argjson rc "$rc" '. + {state:(if $rc==0 then "EXECUTED" else "FAILED" end),exit_code:$rc,finished_at:now}' <<<"$g")"
done
# Expired, consumed grant material is removed after seven days. Replay records
# remain for the same window (longer than the maximum one-hour validity).
find "$C/grants" "$C/requests" "$C/processed" "$C/reports" -type f -name '*.json' -mtime +7 -delete
exec 9>"$D/prepare.lock"
if flock -n 9; then
for w in "$D"/work/*; do
 [ -d "$w" ] || continue
 id=${w##*/}; [[ $id =~ ^[0-9a-f]{8}$ ]] || continue
 systemctl is-active --quiet "fcpi-incident-$id.service" && continue
 rm -f "$w/run/auth/access-token"
 if [ -s "$w/launched-at" ] && [ ! -s "$w/run/result.json" ] && [ ! -e "$w/failed.json" ]; then
  put_obj "$w/failed.json" 0600 '{"state":"INVESTIGATION_FAILED","automatic_retry":false}'
  notice diagnosis_ready "incident_agent:$id" '{"state":"INVESTIGATION_FAILED","automatic_retry":false}' "$(now_s)" "$id"
 fi
 if [ -s "$w/launched-at" ] && [ $(( $(now_s) - $(cat "$w/launched-at") )) -gt 1209600 ]; then
  [ ! -d "$w/tree" ] || rm -rf -- "$w/tree"
  rm -rf -- "$w"; rm -f -- "$C/reports/$id.json"
 fi
done
 flock -u 9
fi
exec 9>&-
# Meaningful unresolved incidents only. Physical thermal/disk conditions are
# noticed by M8 but do not invite a code agent to change their safety boundaries.
while IFS=$'\t' read -r key first; do
 id=$(printf '%s:%s' "$key" "$first" | sha256sum | cut -c1-8)
 [ ! -e "$C/dismissed/$id.json" ] || continue
 [ ! -e "$D/work/$id" ] && [ ! -e "$D/blocked/$id.json" ] || continue
 [ $(( $(now_s) - first )) -ge 120 ] || continue
 rc=0; bash "$REPO/scripts/m9/incident-prepare.sh" "$id" || rc=$?
 # A busy preparation or active agent postpones this incident without spending
 # a launch. Other failures retain their explicit owner-attention disposition.
 [ "$rc" != 3 ] || continue
 if [ "$rc" != 0 ]; then
  put_obj "$D/blocked/$id.json" 0600 '{"state":"PREPARATION_BLOCKED","automatic_retry":false}'
  notice diagnosis_ready "incident_agent:$id" '{"state":"PREPARATION_BLOCKED","automatic_retry":false,"owner_attention_required":true}' "$(now_s)" "$id"
 fi
done < <(jq -r 'to_entries[] | select(.value.open == true) | select(.key | test("^(core_unhealthy|queue_stalled|queue_unreadable|functional_probe_failing|redis_acl_denied|oom_kill:|restart_budget_or_data_service:)")) | [.key,.value.first] | @tsv' "$STATE/alerts/state.json" 2>/dev/null)
for w in "$D"/work/*; do
 [ -d "$w" ] || continue
 [ -s "$w/run/result.json" ] && [ ! -e "$w/harvested.json" ] || continue
 id=${w##*/}
 bash "$REPO/scripts/m9/incident-harvest.sh" "$id" || logger -t fcpi-incident -- 'candidate harvest blocked; inspect private controller state'
done
