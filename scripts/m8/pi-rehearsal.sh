#!/usr/bin/env bash
# The upgrade and rollback rehearsal (FIRECRAWL_PI_SPEC.md §27, AC19), ON the Pi, as root, in the isolated restored copy
# only (Compose project fcpi-restore, every network internal, no egress, webhooks suppressed, paid dispatch off):
#   ssh … 'sudo -n bash /opt/firecrawl-pi/scripts/m8/pi-rehearsal.sh'
#   1. the copy, restored from the newest backup (fcpi restore-test --keep), passes its checks: the baseline;
#   2. a reversible configuration change: the gateway's core deadline changed and the gateway recreated; the checks pass
#      on the candidate; then it is reverted and they pass again;
#   3. a controlled candidate failure: the retrieval service moved to the previous release's image (M7's, which does not
#      know M8's configuration and refuses to start); the copy fails its start; rolled back to the baseline image and
#      configuration, it passes its checks again, the canary results unchanged;
#   4. a schema-sensitive rollback: the candidate ledger migration (tests/fixtures/m8/ledger-v4-candidate.sql) applied to
#      the copy's database; the baseline gateway refuses the migrated ledger (it is never run against it); the rollback
#      restores the pre-migration database from the backup together with the baseline images, and the checks pass;
#   5. the copy is taken down and removed.
# One JSON record per step under "### rehearsal"; scripts/m8/verify.mjs judges them.
set -uo pipefail
# The on-card fixture repository, not the owner's off-device one (scripts/ops/lib.sh BACKUP_ENV); the scripts it runs inherit it.
export FCPI_BACKUP_ENV=/etc/firecrawl-pi/backup-fixture.env
. /opt/firecrawl-pi/scripts/ops/lib.sh
need_root
R=/srv/firecrawl-pi/restore-test P=fcpi-restore
PREV_RETRIEVAL=${1:?usage: pi-rehearsal.sh <the previous release retrieval image>}
out() { jq -cn --arg utc "$(utc)" --arg step "$1" --argjson d "${2:-"{}"}" '{utc:$utc,step:$step} + $d'; }
checks() { local o rc; o=$(bash "$REPO/scripts/ops/restore-test.sh" --check 2>&1); rc=$?; jq -cn --argjson rc $rc --arg o "$o" '{exit:$rc, checks:($o | split("\n") | map(fromjson? // empty) | last // null), pass:($rc == 0)}'; }
up() { docker compose -p "$P" -f "$1" up -d --wait --wait-timeout 300 "${@:2}" >/dev/null 2>&1; echo $?; }
echo "### rehearsal"
trap 'bash "$REPO/scripts/ops/restore-test.sh" --teardown >/dev/null 2>&1' EXIT
base=$(bash "$REPO/scripts/ops/restore-test.sh" --keep 2>&1 | tail -1)
out baseline "$(jq -cn --argjson b "$(jq -c . <<<"$base" 2>/dev/null || echo null)" '{restore_test:$b}')"
jq -e '.result == "PASS"' <<<"$base" >/dev/null || exit 1
cp "$R/compose.json" "$R/compose.baseline.json"
# 2. a reversible configuration change.
jq '.services["access-gateway"].environment.PI_CORE_TIMEOUT_MS = "100000"' "$R/compose.baseline.json" >"$R/compose.candidate-config.json"
rc=$(up "$R/compose.candidate-config.json" access-gateway)
out candidate_config "$(jq -cn --argjson rc "$rc" --arg env "$(docker inspect -f '{{range .Config.Env}}{{println .}}{{end}}' "$(docker ps -q --filter label=com.docker.compose.project=$P --filter label=com.docker.compose.service=access-gateway)" | grep ^PI_CORE_TIMEOUT_MS=)" --argjson c "$(checks)" '{up_exit:$rc, env:$env, checks:$c}')"
rc=$(up "$R/compose.baseline.json" access-gateway)
out reverted_config "$(jq -cn --argjson rc "$rc" --arg env "$(docker inspect -f '{{range .Config.Env}}{{println .}}{{end}}' "$(docker ps -q --filter label=com.docker.compose.project=$P --filter label=com.docker.compose.service=access-gateway)" | grep ^PI_CORE_TIMEOUT_MS=)" --argjson c "$(checks)" '{up_exit:$rc, env:$env, checks:$c}')"
# 3. a controlled candidate failure: an image that refuses this release's configuration.
jq --arg img "$PREV_RETRIEVAL" '.services["retrieval-service"].image = $img' "$R/compose.baseline.json" >"$R/compose.candidate-image.json"
rc=$(up "$R/compose.candidate-image.json" retrieval-service)
rs=$(docker ps -aq --filter label=com.docker.compose.project=$P --filter label=com.docker.compose.service=retrieval-service)
out candidate_image "$(jq -cn --argjson rc "$rc" --arg img "$(docker inspect -f '{{.Config.Image}}' "$rs")" --arg st "$(docker inspect -f '{{.State.Status}} {{.State.ExitCode}} restarts={{.RestartCount}}' "$rs")" \
  --arg log "$(container_log "$rs" | grep -a -o 'unknown configuration keys[^"]*' | head -1)" '{up_exit:$rc, image:$img, state:$st, refusal:$log}')"
rc=$(up "$R/compose.baseline.json" retrieval-service)
out rolled_back_image "$(jq -cn --argjson rc "$rc" --arg img "$(docker inspect -f '{{.Config.Image}}' "$(docker ps -q --filter label=com.docker.compose.project=$P --filter label=com.docker.compose.service=retrieval-service)")" --argjson c "$(checks)" '{up_exit:$rc, image:$img, checks:$c}')"
# 4. the schema-sensitive rollback.
pgc() { docker ps -q --filter label=com.docker.compose.project=$P --filter label=com.docker.compose.service=nuq-postgres; }
docker exec -i "$(pgc)" psql -X -q -v ON_ERROR_STOP=1 -U postgres -d postgres <"$REPO/tests/fixtures/m8/ledger-v4-candidate.sql" >/dev/null 2>&1; mrc=$?
v=$(docker exec "$(pgc)" psql -X -At -U postgres -d postgres -c "SELECT max(version) FROM fcpi_platform.schema_version")
gw=$(docker ps -aq --filter label=com.docker.compose.project=$P --filter label=com.docker.compose.service=access-gateway)
docker restart "$gw" >/dev/null 2>&1; sleep 15
out migrated "$(jq -cn --argjson m "$mrc" --arg v "$v" --arg st "$(docker inspect -f '{{.State.Status}} exit={{.State.ExitCode}} restarts={{.RestartCount}}' "$gw")" \
  --arg log "$(container_log "$gw" 100 | grep -a -o "the ledger's schema version is [0-9]*, this build needs [0-9]*" | tail -1)" '{migration_exit:$m, schema_version:$v, gateway:$st, refusal:$log}')"
# Roll back: stop the copy, restore the pre-migration database from the backup it was made from, start the baseline.
docker compose -p "$P" -f "$R/compose.baseline.json" stop >/dev/null 2>&1
. "$BACKUP_ENV"; export RESTIC_REPOSITORY=$FCPI_RESTIC_REPOSITORY RESTIC_PASSWORD_FILE=$FCPI_RESTIC_PASSWORD_FILE RESTIC_CACHE_DIR=$STATE/restic-cache
snap=$(jq -r .snapshot "$STATE/backup/last-restore-test.json")
rm -rf "$R/pgrestore"; mkdir -m 0700 "$R/pgrestore"
restic restore "$snap" --target "$R/pgrestore" --include /srv/firecrawl-pi/backup-staging/current/data/postgres >/dev/null 2>&1; rr=$?
mv "$R/data/postgres" "$R/data/postgres.migrated" && mv "$R/pgrestore/srv/firecrawl-pi/backup-staging/current/data/postgres" "$R/data/postgres"
rc=$(up "$R/compose.baseline.json")
v=$(docker exec "$(pgc)" psql -X -At -U postgres -d postgres -c "SELECT max(version) FROM fcpi_platform.schema_version")
out rolled_back_schema "$(jq -cn --argjson rr "$rr" --arg snap "$snap" --argjson rc "$rc" --arg v "$v" --argjson c "$(checks)" '{restore_exit:$rr, snapshot:$snap, up_exit:$rc, schema_version:$v, checks:$c}')"
trap - EXIT
bash "$REPO/scripts/ops/restore-test.sh" --teardown
echo "### end"
