#!/usr/bin/env bash
# The fixture backup and isolated restore proof (FIRECRAWL_PI_SPEC.md §26, AC18 on the fixture repository), ON the Pi, as
# root:   ssh … 'sudo -n bash /opt/firecrawl-pi/scripts/m8/pi-backup-proof.sh'
# A screenshot of the M7 fixture first, so a live artifact is backed up; then a slow crawl of the M3 fixture (twenty
# two-second pages, the bulk mark: more would need the residential route), so a job is in flight when the snapshot is
# taken (the backup runs with no drain, FCPI_BACKUP_DRAIN_S=0); then fcpi backup, fcpi status, and fcpi restore-test,
# whose checks include that the in-flight receipt is still tracked in the restored copy and that the artifact hashes and
# is refused to another principal. Prints each command's record under its own section, with the repository's kind and
# whether it is off the device (the fixture repository is not).
set -uo pipefail
# The on-card fixture repository, not the owner's off-device one (scripts/ops/lib.sh BACKUP_ENV); the scripts it runs inherit it.
export FCPI_BACKUP_ENV=/etc/firecrawl-pi/backup-fixture.env
. /opt/firecrawl-pi/scripts/ops/lib.sh
need_root
echo "### meta"
echo "utc=$(utc) source_commit=$(source_commit) repository_kind=$(sed -n 's/^FCPI_RESTIC_REPOSITORY=\([a-z0-9]*\):.*/\1/p; s#^FCPI_RESTIC_REPOSITORY=/.*#local#p' "$BACKUP_ENV") offdevice=$(sed -n 's/^FCPI_BACKUP_OFFDEVICE=//p' "$BACKUP_ENV")"
# A screenshot of the M7 fixture first, so the backup holds a live artifact whose hash and access the restore test proves.
echo "### artifact"
OPS_TOKEN=/etc/firecrawl-pi/secrets/clients/soak.token GW_TIMEOUT=120 gw POST /v2/scrape "{\"url\":\"http://m7shot.fixture.fcpi.test:8080/bands?backup=$(date +%s)\",\"formats\":[\"screenshot\"]}"
echo "{\"status\":$GW_STATUS,\"artifacts\":$(jq -c '[.fcpi.artifacts[]?] | length' <<<"$GW_BODY" 2>/dev/null || echo 0)}"
echo "### inflight"
OPS_TOKEN=/etc/firecrawl-pi/secrets/clients/soak.token GW_TIMEOUT=60 gw POST /v2/crawl '{"url":"http://m3.fixture.fcpi.test:8080/slow/","limit":20}'
echo "{\"status\":$GW_STATUS,\"job\":\"$(jq -r '.id // empty' <<<"$GW_BODY")\"}"
sleep 10
echo "### backup"
t_b0=$(utc)
FCPI_BACKUP_DRAIN_S=0 bash "$REPO/scripts/ops/backup.sh" | tail -1
t_b1=$(utc)
echo "### status_after_backup"
bash "$REPO/scripts/ops/status.sh" --json | jq -c '{healthy, rest: .rest.ready, mcp: .mcp.ready, backup}'
# The notices the backup caused: those opened from its start to three minutes after it (two ticks and the probe after
# the hold ends). The positive control is the ticks during the backup that read the hold, so the tick did judge then.
sleep 180
echo "### notices_across_backup"
opened=$(for f in "$STATE"/alerts/outbox/*.json; do [ -f "$f" ] && jq -c --arg a "$t_b0" 'select(.kind == "opened" and .utc >= $a) | .incident' "$f"; done 2>/dev/null | jq -sc .)
ticks=$(jsonl "$LOGD/samples/$(date -u -d yesterday +%F).jsonl" "$LOGD/samples/$(date -u +%F).jsonl" \
  | jq -c --arg a "$t_b0" --arg b "$t_b1" 'select(.utc >= $a and .utc <= $b and ((.admission.reasons // []) | index("hold:backup")))' | wc -l)
jq -cn --arg a "$t_b0" --arg b "$t_b1" --argjson o "${opened:-[]}" --argjson t "$ticks" '{from:$a, to:$b, opened:$o, ticks_seeing_hold:$t}'
echo "### restore_test"
bash "$REPO/scripts/ops/restore-test.sh" 2>&1 | tail -1
echo "### leftovers"
echo "{\"restore_containers\":$(docker ps -aq --filter label=com.docker.compose.project=fcpi-restore | wc -l),\"restore_dir\":$([ -e /srv/firecrawl-pi/restore-test ] && echo true || echo false),\"staging_current\":$([ -e /srv/firecrawl-pi/backup-staging/current ] && echo true || echo false)}"
echo "### end"
