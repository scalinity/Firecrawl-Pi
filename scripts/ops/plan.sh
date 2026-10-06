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
#                          commit restores, and whether the data must be restored with it: the ledger moved since, a data
#                          service's image moves back, or the NuQ or retrieval schema file differs (never an older binary
#                          on newer data). The backup named is the newest that finished before the cutover at the previous
#                          release's ledger version (from the backup history), never one taken after a migration.
#   release                records the running release (/var/lib/firecrawl-pi/releases/<UTC>-<commit12>.json): commit,
#                          version lock, images, ledger version, the NuQ and retrieval schema files' hashes, and the
#                          newest backup before it. Bring-up and cutover scripts call it.
set -uo pipefail
. "$(dirname "$(readlink -f "$0")")/lib.sh"
need_root
RD=$STATE/releases; mkdir -p "$RD"
images_of() { docker compose -f "$1/deploy/compose.yaml" config --format json 2>/dev/null | jq -c '.services | map_values(.image)'; }
# Each service's configuration apart from its image (environment, mounts, limits, networks, health check), by hash.
config_of() {
  local r; r=$(docker compose -f "$1/deploy/compose.yaml" config --format json 2>/dev/null) || { echo '{}'; return; }
  for svc in $(jq -r '.services | keys[]' <<<"$r"); do jq -cS --arg s "$svc" '.services[$s] | del(.image)' <<<"$r" | sha256sum | cut -c1-16 | jq -R --arg s "$svc" '{($s): .}'; done | jq -sc 'add // {}'
}
schema_max() { grep -o "schema_version (version) VALUES ([0-9]*)" "$1/deploy/nuq-postgres/fcpi-platform-schema.sql" | grep -o '[0-9]*)' | tr -d ')' | sort -n | tail -1; }
h() { [ -e "$1" ] && sha256sum "$1" | cut -c1-64 || echo absent; }
current_release() {
  jq -n --arg utc "$(utc)" --arg commit "$(source_commit)" --arg lock "$(h "$REPO/deploy/versions.lock.json")" --argjson images "$(images_of "$REPO")" --argjson config "$(config_of "$REPO")" \
    --arg db "$(pg 'SELECT max(version) FROM fcpi_platform.schema_version')" --arg file "$(schema_max "$REPO")" \
    --arg backup "$(jq -r '.utc // empty' "$STATE/backup/last.json" 2>/dev/null)" --arg snap "$(jq -r '.snapshot_data // empty' "$STATE/backup/last.json" 2>/dev/null)" \
    --arg nuq "$(h "$REPO/deploy/nuq-postgres/nuq.sql")" --arg ret "$(h "$REPO/deploy/nuq-postgres/fcpi-retrieval-schema.sql")" \
    '{utc:$utc,commit:$commit,versions_lock_sha256:$lock,images:$images,config:$config,ledger_schema_db:($db|tonumber? // null),ledger_schema_file:($file|tonumber? // null),
      schema_files:{nuq:$nuq,retrieval:$ret}, last_backup_before:(if $backup == "" then null else {utc:$backup,snapshot:$snap} end)}'
}
case ${1:-} in
  release)
    r=$(current_release); f=$RD/$(date -u +%Y%m%dT%H%M%SZ)-$(jq -r '.commit[0:12]' <<<"$r").json
    printf '%s\n' "$r" | write_atomic "$f" 0644; echo "$f" ;;
  upgrade)
    [ "${2:-}" = --plan ] || die "usage: fcpi upgrade --plan <candidate tree>"
    C=${3:?usage: fcpi upgrade --plan <candidate tree>}; [ -f "$C/deploy/compose.yaml" ] && [ -f "$C/.fcpi-source-commit" ] || die "$C is not a staged candidate tree"
    cur=$(current_release)
    jq -n --argjson cur "$cur" --argjson cand "$(images_of "$C")" --argjson ccfg "$(config_of "$C")" --arg cc "$(cat "$C/.fcpi-source-commit")" --arg cl "$(h "$C/deploy/versions.lock.json")" \
      --arg cs "$(schema_max "$C")" \
      --argjson pol "$(for f in budget.json egress.json capabilities.json; do jq -cn --arg f "$f" --arg a "$(h "$REPO/deploy/policies/$f")" --arg b "$(h "$C/deploy/policies/$f")" '{($f): ($a != $b)}'; done | jq -sc add)" \
      --argjson units "$(for f in $( (cd "$C/deploy/host" && ls; cd "$REPO/deploy/host" && ls) 2>/dev/null | grep -E '\.(service|timer|slice|nft|sh|conf)$' | sort -u); do jq -cn --arg f "$f" --arg a "$(h "$REPO/deploy/host/$f")" --arg b "$(h "$C/deploy/host/$f")" '{($f): (if $a == $b then null elif $b == "absent" then "removed" elif $a == "absent" then "added" else "changed" end)}'; done | jq -sc 'add // {}')" '
      ($cur.images | keys + ($cand | keys) | unique) as $svcs
      | [ $svcs[] as $s | select($cur.images[$s] != $cand[$s]) | {service: $s, from: $cur.images[$s], to: $cand[$s]} ] as $moves
      | ($cs | tonumber? // null) as $cschema
      | ([$moves[] | select(.service | IN("nuq-postgres", "redis", "rabbitmq"))]) as $data
      | { plan: "upgrade", from_commit: $cur.commit, to_commit: $cc, version_lock_changes: ($cur.versions_lock_sha256 != $cl),
          image_changes: $moves, data_service_image_changes: $data,
          ledger_schema: {database: $cur.ledger_schema_db, candidate_reaches: $cschema, migrates: ($cschema != null and $cur.ledger_schema_db != null and $cschema > $cur.ledger_schema_db)},
          configuration_changes: ([($cur.config | keys) + ($ccfg | keys) | unique | .[] as $s | select($cur.config[$s] != $ccfg[$s]) | $s]),
          policy_changes: ($pol | with_entries(select(.value)) | keys), host_unit_changes: ($units | with_entries(select(.value != null))),
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
    # The cutover: the first release recorded for the running commit after the previous one. The backup to restore is
    # the newest that finished before it (so its data is from before any migration) at the previous release's ledger
    # version, where the backup recorded one.
    cutover=$(ls -1 "$RD"/*.json | sort | while read -r f; do [[ $f > $prev ]] && [ "$(jq -r .commit "$f")" = "$(jq -r .commit <<<"$cur")" ] && { jq -r .utc "$f"; break; }; done)
    hist=$(jsonl "$STATE/backup/history.jsonl" | jq -sc 'map(select(.result == "PASS"))'); [ -n "$hist" ] || hist='[]'
    jq -n --argjson cur "$cur" --argjson prev "$(cat "$prev")" --arg pf "$(basename "$prev")" --arg cut "$cutover" --argjson hist "$hist" '
      ($cur.images | keys + ($prev.images | keys) | unique) as $svcs
      | [ $svcs[] as $s | select($cur.images[$s] != $prev.images[$s]) | {service: $s, from: $cur.images[$s], to: $prev.images[$s]} ] as $moves
      # A data service image that moves back (a PostgreSQL major version above all) cannot start on data the newer one
      # wrote; a schema file that differs may have migrated the data. Either restores the data (spec §27).
      | [ $moves[] | select(.service | IN("nuq-postgres", "redis", "rabbitmq")) | .service ] as $data_moves
      | [ "nuq", "retrieval" | select(($prev.schema_files // {})[.] != null and $cur.schema_files[.] != $prev.schema_files[.]) ] as $schema_moves
      | (($cur.ledger_schema_db // 0) != ($prev.ledger_schema_db // 0) or ($data_moves | length) > 0 or ($schema_moves | length) > 0) as $restore
      | ($hist | map(select(($cut == "" or .utc < $cut) and ((.platform_schema_version // null) == null or .platform_schema_version == $prev.ledger_schema_db)))
          | max_by(.utc) | if . == null then null else {utc, snapshot: .snapshot_data, run} end) as $pre
      | { plan: "rollback", from_commit: $cur.commit, to_commit: $prev.commit, to_release: $pf, cutover: (if $cut == "" then "unknown: no release recorded for the running commit" else $cut end),
          image_changes: $moves,
          configuration_changes: (if $prev.config then [($cur.config | keys) + ($prev.config | keys) | unique | .[] as $s | select($cur.config[$s] != $prev.config[$s]) | $s] else "unknown: that release recorded no configuration" end),
          ledger_schema: {now: $cur.ledger_schema_db, at_that_release: $prev.ledger_schema_db},
          data_service_image_changes: $data_moves,
          schema_file_changes: (if $prev.schema_files then $schema_moves else "unknown: that release recorded no schema files" end),
          data_restore_needed: $restore,
          backup_to_restore: (if $restore then $pre else null end) }
      | .steps = (if .data_restore_needed then
          ["fcpi hold rollback <seconds>", "stop the stack (systemctl stop fcpi-stack)", "move the paid-dispatch switch aside until spend is reconciled (mv /etc/firecrawl-pi/paid-dispatch.env /etc/firecrawl-pi/paid-dispatch.env.held)",
           "restore the data directories from backup \(.backup_to_restore.snapshot // "NONE RECORDED: stop here") (fcpi help restore)",
           "scripts/m1/deploy.sh of \(.to_commit[0:12]); recreate every service", "reconcile provider spend newer than the backup, then fcpi paid on", "fcpi verify functional; fcpi status; fcpi hold rollback --clear"]
        else ["scripts/m1/deploy.sh of \(.to_commit[0:12])", "recreate the services whose images or configuration differ", "fcpi verify functional; fcpi status"] end)' ;;
  *) die "usage: fcpi upgrade --plan <dir> | fcpi rollback --plan | fcpi release" ;;
esac
