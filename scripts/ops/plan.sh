#!/usr/bin/env bash
# fcpi upgrade --plan <candidate tree> | fcpi rollback --plan | fcpi release (FIRECRAWL_PI_SPEC.md §27), as root ON the Pi.
# The plans are read-only: they change nothing.
#   upgrade --plan <dir>   compares the deployed tree with a candidate tree staged by scripts/m8/stage.sh
#                          (/opt/firecrawl-pi-candidate/<commit>): each service's image digest, the version lock, the
#                          policies, the host units; the ledger's schema version the candidate's schema file reaches
#                          against the one the database holds; whether a data service's image moves (a major version
#                          needs its own migration). It names the steps spec §27 requires, in order, and whether the
#                          change is schema-sensitive, which decides how it is rolled back.
#   rollback --plan        compares the running release with the previous recorded one: what a redeploy of the previous
#                          commit restores, and whether the ledger moved since, in which case the pre-cutover backup must
#                          be restored with it (never an older gateway on a newer ledger).
#   release                records the running release (/var/lib/firecrawl-pi/releases/<UTC>-<commit12>.json): commit,
#                          version lock, images, ledger version, and the newest backup before it. Bring-up and cutover
#                          scripts call it.
set -uo pipefail
. "$(dirname "$(readlink -f "$0")")/lib.sh"
need_root
RD=$STATE/releases; mkdir -p "$RD"
images_of() { docker compose -f "$1/deploy/compose.yaml" config --format json 2>/dev/null | jq -c '.services | map_values(.image)'; }
schema_max() { grep -o "schema_version (version) VALUES ([0-9]*)" "$1/deploy/nuq-postgres/fcpi-platform-schema.sql" | grep -o '[0-9]*)' | tr -d ')' | sort -n | tail -1; }
h() { [ -e "$1" ] && sha256sum "$1" | cut -c1-64 || echo absent; }
current_release() {
  jq -n --arg utc "$(utc)" --arg commit "$(source_commit)" --arg lock "$(h "$REPO/deploy/versions.lock.json")" --argjson images "$(images_of "$REPO")" \
    --arg db "$(pg 'SELECT max(version) FROM fcpi_platform.schema_version')" --arg file "$(schema_max "$REPO")" \
    --arg backup "$(jq -r '.utc // empty' "$STATE/backup/last.json" 2>/dev/null)" --arg snap "$(jq -r '.snapshot_data // empty' "$STATE/backup/last.json" 2>/dev/null)" \
    '{utc:$utc,commit:$commit,versions_lock_sha256:$lock,images:$images,ledger_schema_db:($db|tonumber? // null),ledger_schema_file:($file|tonumber? // null),
      last_backup_before:(if $backup == "" then null else {utc:$backup,snapshot:$snap} end)}'
}
case ${1:-} in
  release)
    r=$(current_release); f=$RD/$(date -u +%Y%m%dT%H%M%SZ)-$(jq -r '.commit[0:12]' <<<"$r").json
    printf '%s\n' "$r" | write_atomic "$f" 0644; echo "$f" ;;
  upgrade)
    [ "${2:-}" = --plan ] || die "usage: fcpi upgrade --plan <candidate tree>"
    C=${3:?usage: fcpi upgrade --plan <candidate tree>}; [ -f "$C/deploy/compose.yaml" ] && [ -f "$C/.fcpi-source-commit" ] || die "$C is not a staged candidate tree"
    cur=$(current_release)
    jq -n --argjson cur "$cur" --argjson cand "$(images_of "$C")" --arg cc "$(cat "$C/.fcpi-source-commit")" --arg cl "$(h "$C/deploy/versions.lock.json")" \
      --arg cs "$(schema_max "$C")" \
      --argjson pol "$(for f in budget.json egress.json capabilities.json; do jq -cn --arg f "$f" --arg a "$(h "$REPO/deploy/policies/$f")" --arg b "$(h "$C/deploy/policies/$f")" '{($f): ($a != $b)}'; done | jq -sc add)" \
      --argjson units "$(for f in "$C"/deploy/host/*.service "$C"/deploy/host/*.timer "$C"/deploy/host/*.slice "$C"/deploy/host/*.nft "$C"/deploy/host/*.sh; do [ -e "$f" ] || continue; b=$(basename "$f"); jq -cn --arg f "$b" --arg a "$(h "$REPO/deploy/host/$b")" --arg b "$(h "$f")" '{($f): ($a != $b)}'; done | jq -sc 'add // {}')" '
      ($cur.images | keys + ($cand | keys) | unique) as $svcs
      | [ $svcs[] as $s | select($cur.images[$s] != $cand[$s]) | {service: $s, from: $cur.images[$s], to: $cand[$s]} ] as $moves
      | ($cs | tonumber? // null) as $cschema
      | ([$moves[] | select(.service | IN("nuq-postgres", "redis", "rabbitmq"))]) as $data
      | { plan: "upgrade", from_commit: $cur.commit, to_commit: $cc, version_lock_changes: ($cur.versions_lock_sha256 != $cl),
          image_changes: $moves, data_service_image_changes: $data,
          ledger_schema: {database: $cur.ledger_schema_db, candidate_reaches: $cschema, migrates: ($cschema != null and $cur.ledger_schema_db != null and $cschema > $cur.ledger_schema_db)},
          policy_changes: ($pol | with_entries(select(.value)) | keys), host_unit_changes: ($units | with_entries(select(.value)) | keys),
          schema_sensitive: (($cschema != null and $cur.ledger_schema_db != null and $cschema > $cur.ledger_schema_db) or ($data | length) > 0),
          last_backup: $cur.last_backup_before }
      | .rollback = (if .schema_sensitive then "restore the pre-upgrade backup (its data snapshot and secrets) together with a redeploy of \(.from_commit[0:12]); never start the older images on the migrated data"
                     else "redeploy \(.from_commit[0:12]) with scripts/m1/deploy.sh and recreate the changed services; no data restore" end)
      | .steps = ["review the release and security notes of every image that moves", "resolve every new image to an immutable linux/arm64 digest",
          "confirm disk and memory headroom (fcpi status)", "fcpi backup, and confirm it with fcpi restore-test",
          "run the candidate on copied data in an isolated project (the restore test'"'"'s namespace) with provider dispatch off: contracts, security, MCP, acquisition and migration tests",
          "pause admissions (fcpi hold upgrade <seconds>) and drain", "cut over: scripts/m1/deploy.sh of the candidate commit, then recreate the changed services",
          "fcpi verify functional and fcpi status", "accept (fcpi release) or roll back as below"]' ;;
  rollback)
    [ "${2:-}" = --plan ] || die "usage: fcpi rollback --plan"
    cur=$(current_release)
    prev=$(ls -1 "$RD"/*.json 2>/dev/null | sort | while read -r f; do [ "$(jq -r .commit "$f")" != "$(jq -r .commit <<<"$cur")" ] && echo "$f"; done | tail -1)
    [ -n "$prev" ] || die "no earlier release is recorded"
    jq -n --argjson cur "$cur" --argjson prev "$(cat "$prev")" --arg pf "$(basename "$prev")" '
      ($cur.images | keys + ($prev.images | keys) | unique) as $svcs
      | { plan: "rollback", from_commit: $cur.commit, to_commit: $prev.commit, to_release: $pf,
          image_changes: [ $svcs[] as $s | select($cur.images[$s] != $prev.images[$s]) | {service: $s, from: $cur.images[$s], to: $prev.images[$s]} ],
          ledger_schema: {now: $cur.ledger_schema_db, at_that_release: $prev.ledger_schema_db},
          data_restore_needed: (($cur.ledger_schema_db // 0) != ($prev.ledger_schema_db // 0)),
          backup_to_restore: (if ($cur.ledger_schema_db // 0) != ($prev.ledger_schema_db // 0) then $cur.last_backup_before else null end) }
      | .steps = (if .data_restore_needed then
          ["fcpi hold rollback <seconds>", "stop the stack (systemctl stop fcpi-stack)", "restore the data directories from backup \(.backup_to_restore.snapshot // "NONE RECORDED: stop here") (fcpi help restore)",
           "scripts/m1/deploy.sh of \(.to_commit[0:12]); recreate every service", "reconcile provider spend newer than the backup before paid dispatch returns", "fcpi verify functional; fcpi status; fcpi hold rollback --clear"]
        else ["scripts/m1/deploy.sh of \(.to_commit[0:12])", "recreate the services whose images or configuration differ", "fcpi verify functional; fcpi status"] end)' ;;
  *) die "usage: fcpi upgrade --plan <dir> | fcpi rollback --plan | fcpi release" ;;
esac
