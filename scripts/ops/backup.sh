#!/usr/bin/env bash
# fcpi backup (FIRECRAWL_PI_SPEC.md §26), as root ON the Pi, by fcpi-backup.timer nightly or by hand. restic, encrypted,
# to the repository /etc/firecrawl-pi/backup.env names (FCPI_RESTIC_REPOSITORY; the Pi's own key in
# FCPI_RESTIC_PASSWORD_FILE; backend credentials, if any, in FCPI_RESTIC_ENV_FILE). The repository's second key, the
# recovery key, is the owner's and never on the Pi.
#   1. canaries, before anything stops: up to three retained results (their documents' hashes as the gateway serves them
#      to their own principal), up to two live artifacts, and every job still in flight, for the restore test;
#   2. brief coordinated quiescence, at most five minutes (spec §26): admissions paused (a hold), in-flight work drained
#      for up to two minutes, the application services stopped, a PostgreSQL logical dump, the data services stopped
#      cleanly, their data directories copied to the staging area, and everything started again whatever happened;
#   3. after the stack is back: the staged copy, the content-addressed result store (immutable files, backed up live),
#      the deployed tree and the host configuration go into one snapshot (tag fcpi-data); the secrets directory is
#      streamed into a second (tag fcpi-secrets) by restic's own tar command, so no plaintext copy is ever staged;
#   4. retention (seven daily, four weekly, three monthly) only after both snapshots succeed; the staging copy is
#      removed once uploaded.
# Browser scratch, caches and full logs are not included. /var/lib/firecrawl-pi/backup/last.json records the last
# success (fcpi status shows its age; the tick opens backup_stale past 26 hours); history.jsonl every attempt.
#   fcpi backup [--no-quiesce-check]
set -uo pipefail
. "$(dirname "$(readlink -f "$0")")/lib.sh"
need_root
exec 8>"$RUND/backup.lock"; flock -n 8 || die "another backup or restore test is running"
B=$STATE/backup; mkdir -p "$B"; chmod 0700 "$B"
RUN=$(date -u +%Y%m%dT%H%M%SZ)
record() { # record <result> <json extra>
  local line; line=$(jq -cn --arg utc "$(utc)" --arg run "$RUN" --arg r "$1" --argjson x "$2" '{utc:$utc,run:$run,result:$r} + $x')
  append_line "$B/history.jsonl" "$line"; printf '%s\n' "$line" | write_atomic "$B/last-attempt.json" 0600
  [ "$1" = PASS ] && printf '%s\n' "$line" | write_atomic "$B/last.json" 0600
  echo "$line"
}
CONF=/etc/firecrawl-pi/backup.env
[ -r "$CONF" ] || { record NOT_CONFIGURED '{"error":"/etc/firecrawl-pi/backup.env is absent: no backup repository is configured"}'; exit 3; }
# shellcheck disable=SC1090
. "$CONF"
: "${FCPI_RESTIC_REPOSITORY:?}" "${FCPI_RESTIC_PASSWORD_FILE:?}"
export RESTIC_REPOSITORY=$FCPI_RESTIC_REPOSITORY RESTIC_PASSWORD_FILE=$FCPI_RESTIC_PASSWORD_FILE RESTIC_CACHE_DIR=$STATE/restic-cache
# Backend credentials reach restic alone (lib.sh restic).
OFFDEVICE=${FCPI_BACKUP_OFFDEVICE:-unknown}
# The repository's kind (its scheme, or local for a path), never its address.
case $RESTIC_REPOSITORY in /*) KIND=local ;; *) KIND=${RESTIC_REPOSITORY%%:*} ;; esac
. /etc/firecrawl-pi/config.env
DATA=${PI_DATA_DIR:?}
STAGE_ROOT=/srv/firecrawl-pi/backup-staging
[ "$(findmnt -no UUID --target "$STAGE_ROOT")" = "$PI_DATA_MOUNT_ID" ] || { record FAIL '{"error":"the staging area is not on the data filesystem"}'; exit 1; }
restic cat config >/dev/null 2>&1 || { record FAIL "$(jq -cn --arg k "$KIND" '{error:"the repository cannot be opened",repository_kind:$k}')"; exit 1; }

# Room for the copy: the three data directories twice over, plus 1 GiB.
need=$(( $(du -sb "$DATA/postgres" "$DATA/redis" "$DATA/rabbitmq" | awk '{s += $1} END {print s}') * 2 + 1073741824 ))
free=$(df -B1 --output=avail "$STAGE_ROOT" | tail -1)
[ "$free" -gt "$need" ] || { record FAIL "$(jq -cn --argjson n "$need" --argjson f "$free" '{error:"not enough room to stage",need:$n,free:$f}')"; exit 1; }
# One fixed path, so restic groups every night's snapshot together for retention (it groups by host and paths); the run
# is named inside, in backup-meta.json. A copy an earlier run staged but never uploaded is replaced.
S=$STAGE_ROOT/current
rm -rf "$S"; mkdir -m 0700 "$S"

# ---- 1. canaries ---------------------------------------------------------------------------------------------------
canary_jobs=$(pg "SELECT j.id, j.client_label, j.kind, j.state, count(d.*) FROM fcpi_platform.job j JOIN fcpi_platform.job_document d ON d.job_id = j.id
  WHERE j.state IN ('SUCCEEDED','PARTIAL') AND j.results_expire_at > now() + interval '1 day' AND j.kind IN ('crawl','batch')
  GROUP BY j.id HAVING count(d.*) BETWEEN 1 AND 10 ORDER BY j.finished_at DESC LIMIT 3")
canaries=()
while IFS='|' read -r id label kind state docs; do
  [ -n "$id" ] && [ -r "/etc/firecrawl-pi/secrets/clients/$label.token" ] || continue
  path=/v2/crawl/$id; [ "$kind" = batch ] && path=/v2/batch/scrape/$id
  OPS_TOKEN=/etc/firecrawl-pi/secrets/clients/$label.token GW_TIMEOUT=30 gw GET "$path"
  [ "$GW_STATUS" = 200 ] || continue
  h=$(jq -cS '.data' <<<"$GW_BODY" | sha256sum | cut -c1-64)
  canaries+=("$(jq -cn --arg id "$id" --arg l "$label" --arg k "$kind" --arg s "$state" --argjson n "$docs" --arg h "$h" --arg p "$path" '{job:$id,label:$l,kind:$k,state:$s,documents:$n,path:$p,data_sha256:$h}')")
done <<<"$canary_jobs"
artifacts=$(pg "SELECT id, principal, sha256 FROM fcpi_platform.artifact WHERE expires_at > now() + interval '1 day' ORDER BY created_at DESC LIMIT 2" \
  | jq -Rsc 'split("\n") | map(select(. != "") | split("|") | {id: .[0], principal: .[1], sha256: .[2]})')
inflight=$(pg "SELECT id, client_label, kind, state FROM fcpi_platform.job WHERE state IN ('RECEIVED','SUBMITTING','SUBMISSION_UNCERTAIN','QUEUED','RUNNING')" \
  | jq -Rsc 'split("\n") | map(select(. != "") | split("|") | {job: .[0], label: .[1], kind: .[2], state: .[3]})')

# ---- 2. quiescence -------------------------------------------------------------------------------------------------
COMPOSE=(docker compose -p fcpi -f "$REPO/deploy/compose.yaml")
APP="access-gateway mcp-gateway firecrawl-core retrieval-service browser-worker searxng"
t_q0=$(now_s); drained=false; stopped=false
# The services running before the backup, which resume starts again as they were: compose start never recreates a
# container, so a deployed commit not yet cut over does not go live here and a service stopped on purpose stays stopped.
was_running=$("${COMPOSE[@]}" ps --status running --services 2>/dev/null | tr '\n' ' ')
[ -n "${was_running// /}" ] || was_running="$DATA_SERVICES $APP"
resume() {
  if [ "$stopped" = true ]; then
    # shellcheck disable=SC2086
    "${COMPOSE[@]}" start --wait --wait-timeout 600 $was_running >/dev/null 2>&1 || "${COMPOSE[@]}" start $was_running >/dev/null 2>&1
    stopped=false
  fi
  hold_clear backup
}
trap 'resume' EXIT
hold_set backup 900
# The five minutes (spec §26) are one budget the drain, the dump and the copy share; each step gets what is left of it
# less a reserve for the steps after it, never under 30 s. A copy that cannot fit fails the run and the stack starts
# again: availability first, and the quiescence incident says the staging needs redesign.
QMAX=300
budget() { local s=$(( QMAX - ($(now_s) - t_q0) - $1 )); [ "$s" -ge 30 ] || s=30; echo "$s"; }
# In-flight work gets up to FCPI_BACKUP_DRAIN_S (default and ceiling 120) to finish; what is still running then is
# captured as it stands, its receipt durable in the ledger (the restore test proves it is still tracked).
drain_s=${FCPI_BACKUP_DRAIN_S:-120}; [[ $drain_s =~ ^[0-9]+$ ]] && [ "$drain_s" -le 120 ] || drain_s=120
while :; do
  n=$(pg "SELECT (SELECT count(*) FROM nuq.queue_scrape WHERE status IN ('queued','active')) + (SELECT count(*) FROM fcpi_platform.job WHERE state IN ('SUBMITTING','RUNNING','QUEUED'))")
  [ "$n" = 0 ] && { drained=true; break; }
  [ $(( $(now_s) - t_q0 + 5 )) -le "$drain_s" ] || break
  sleep 5
done
dump_ok=false
pgc=$(cid nuq-postgres)
stopped=true
# shellcheck disable=SC2086
"${COMPOSE[@]}" stop $APP >/dev/null 2>&1
if timeout "$(budget 120)" docker exec "$pgc" pg_dump -U postgres -d postgres -Fc >"$S/postgres.dump" 2>"$S/pg_dump.err" && [ -s "$S/postgres.dump" ]; then dump_ok=true; fi
"${COMPOSE[@]}" stop redis rabbitmq nuq-postgres >/dev/null 2>&1
# The copy is taken only from stopped data services: a copy of a live PostgreSQL directory is torn.
still_running=""
for s in $DATA_SERVICES; do [ "$(docker inspect -f '{{.State.Running}}' "$(cid "$s")" 2>/dev/null)" = false ] || still_running+="$s "; done
copy_ok=false
if [ -z "$still_running" ]; then
  mkdir -m 0700 "$S/data"
  copy_ok=true
  for d in postgres redis rabbitmq; do timeout "$(budget 60)" cp -a "$DATA/$d" "$S/data/$d" || copy_ok=false; done
  cp -a "$DATA/.fcpi-data-id" "$S/data/" || copy_ok=false
fi
resume
trap - EXIT
quiesce_s=$(( $(now_s) - t_q0 ))
up_ok=true; for c in firecrawl-core access-gateway nuq-postgres; do [ "$(docker inspect -f '{{.State.Health.Status}}' "$(cid $c)" 2>/dev/null)" = healthy ] || up_ok=false; done
if [ "$copy_ok" != true ] || [ "$dump_ok" != true ]; then
  record FAIL "$(jq -cn --argjson q "$quiesce_s" --argjson c "$copy_ok" --argjson d "$dump_ok" --argjson u "$up_ok" --arg sr "$still_running" \
    '{error:"the staged copy is incomplete",quiesce_s:$q,quiesce_exceeded:($q > 300),copy_ok:$c,dump_ok:$d,stack_healthy_after:$u} + (if $sr == "" then {} else {data_services_not_stopped:$sr} end)')"
  exit 1
fi

# ---- 3. the snapshots ----------------------------------------------------------------------------------------------
lock_sha=$(sha256sum "$REPO/deploy/versions.lock.json" | cut -c1-64)
images=$(docker compose -p fcpi -f "$REPO/deploy/compose.yaml" config --format json 2>/dev/null | jq -c '.services | map_values(.image)')
# The images the backed-up data was written by: a deployed tree not yet cut over differs from them, and the restore needs
# to know.
running_images=$(docker ps --filter label=com.docker.compose.project=fcpi --format '{{.Label "com.docker.compose.service"}}	{{.Image}}' \
  | jq -Rsc 'split("\n") | map(select(. != "") | split("\t") | {key: .[0], value: .[1]}) | from_entries')
schema=$(pg "SELECT max(version) FROM fcpi_platform.schema_version")
jq -n --arg run "$RUN" --arg utc "$(utc)" --arg commit "$(source_commit)" --arg lock "$lock_sha" --argjson images "$images" --argjson ri "${running_images:-null}" --arg schema "$schema" \
  --argjson c "$(printf '%s\n' "${canaries[@]}" | jq -sc 'map(select(. != null))')" --argjson a "$artifacts" --argjson i "$inflight" \
  --argjson q "$quiesce_s" --argjson dr "$drained" --arg boot "$(boot_hash)" \
  '{run:$run,utc:$utc,source_commit:$commit,versions_lock_sha256:$lock,images:$images,running_images:$ri,
    deployed_matches_running:(if ($ri | type) == "object" then all($ri | to_entries[]; $images[.key] == null or $images[.key] == .value) else null end),
    platform_schema_version:($schema|tonumber? // null),
    canaries:{results:$c,artifacts:$a,inflight:$i},quiesce_s:$q,drained:$dr,boot:$boot}' >"$S/backup-meta.json"
# A backup whose metadata did not compute (an empty image map, a failed jq) would restore without its canaries or its
# version check: it fails here rather than at the next monthly restore test.
jq -e '(.run | type) == "string" and (.versions_lock_sha256 | test("^[0-9a-f]{64}$")) and (.images | type) == "object" and (.images | length) > 0
  and (.canaries.results | type) == "array" and (.canaries.artifacts | type) == "array" and (.canaries.inflight | type) == "array"' \
  "$S/backup-meta.json" >/dev/null 2>&1 || { record FAIL '{"error":"backup-meta.json is incomplete: the run, version lock, images or canaries did not compute"}'; exit 1; }
(cd "$S" && find . -type f ! -name MANIFEST.sha256 -print0 | sort -z | xargs -0 sha256sum >MANIFEST.sha256)
t_u0=$(now_s)
out=$(restic backup --json --tag fcpi-data --host fcpi-pi --exclude-caches "$S" "$DATA/artifacts" "$REPO" /etc/firecrawl-pi \
  --exclude /etc/firecrawl-pi/secrets 2>"$B/restic-data.err" | tail -1)
snap_data=$(jq -r 'select(.message_type == "summary") | .snapshot_id // empty' <<<"$out" 2>/dev/null)
added=$(jq -r 'select(.message_type == "summary") | .data_added // 0' <<<"$out" 2>/dev/null)
out2=$(restic backup --json --tag fcpi-secrets --host fcpi-pi --stdin-filename fcpi-secrets.tar --stdin-from-command -- tar -C /etc/firecrawl-pi -cf - secrets 2>"$B/restic-secrets.err" | tail -1)
snap_sec=$(jq -r 'select(.message_type == "summary") | .snapshot_id // empty' <<<"$out2" 2>/dev/null)
upload_s=$(( $(now_s) - t_u0 ))
x=$(jq -cn --arg d "$snap_data" --arg s "$snap_sec" --argjson a "${added:-0}" --argjson q "$quiesce_s" --argjson u "$upload_s" --argjson dr "$drained" \
  --arg k "$KIND" --arg off "$OFFDEVICE" --argjson up "$up_ok" --arg commit "$(source_commit)" --arg lock "$lock_sha" \
  --argjson nc "${#canaries[@]}" --argjson ni "$(jq length <<<"$inflight")" \
  '{snapshot_data:$d,snapshot_secrets:$s,data_added:$a,quiesce_s:$q,quiesce_exceeded:($q > 300),upload_s:$u,drained:$dr,repository_kind:$k,offdevice:$off,
    stack_healthy_after:$up,source_commit:$commit,versions_lock_sha256:$lock,canary_results:$nc,inflight_jobs:$ni}')
if [ -z "$snap_data" ] || [ -z "$snap_sec" ]; then record FAIL "$(jq -c '. + {error:"a snapshot did not complete; the staged copy is kept for the next run"}' <<<"$x")"; exit 1; fi

# ---- 4. retention --------------------------------------------------------------------------------------------------
restic forget --host fcpi-pi --keep-daily 7 --keep-weekly 4 --keep-monthly 3 --prune >"$B/restic-forget.log" 2>&1; fr=$?
rm -rf "$S"
record PASS "$(jq -c --argjson f "$fr" '. + {forget_exit:$f}' <<<"$x")"
