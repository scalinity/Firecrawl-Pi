#!/usr/bin/env bash
# The fixture backup and isolated restore proof (FIRECRAWL_PI_SPEC.md §26, AC18 on the fixture repository), ON the Pi, as
# root:   ssh … 'sudo -n bash /opt/firecrawl-pi/scripts/m8/pi-backup-proof.sh'
# A slow crawl of the M3 fixture (twenty two-second pages, the bulk mark: more would need the residential route) is started first, so a job is in flight when the snapshot is
# taken (the backup runs with no drain, FCPI_BACKUP_DRAIN_S=0); then fcpi backup, fcpi status, and fcpi restore-test,
# whose checks include that the in-flight receipt is still tracked in the restored copy. Prints each command's record
# under its own section, with the repository's kind and whether it is off the device (the fixture repository is not).
set -uo pipefail
. /opt/firecrawl-pi/scripts/ops/lib.sh
need_root
echo "### meta"
echo "utc=$(utc) source_commit=$(source_commit) repository_kind=$(sed -n 's/^FCPI_RESTIC_REPOSITORY=\([a-z0-9]*\):.*/\1/p; s#^FCPI_RESTIC_REPOSITORY=/.*#local#p' /etc/firecrawl-pi/backup.env) offdevice=$(sed -n 's/^FCPI_BACKUP_OFFDEVICE=//p' /etc/firecrawl-pi/backup.env)"
echo "### inflight"
OPS_TOKEN=/etc/firecrawl-pi/secrets/clients/soak.token GW_TIMEOUT=60 gw POST /v2/crawl '{"url":"http://m3.fixture.fcpi.test:8080/slow/","limit":20}'
echo "{\"status\":$GW_STATUS,\"job\":\"$(jq -r '.id // empty' <<<"$GW_BODY")\"}"
sleep 10
echo "### backup"
FCPI_BACKUP_DRAIN_S=0 bash "$REPO/scripts/ops/backup.sh" | tail -1
echo "### status_after_backup"
bash "$REPO/scripts/ops/status.sh" --json | jq -c '{healthy, rest: .rest.ready, mcp: .mcp.ready, backup}'
echo "### restore_test"
bash "$REPO/scripts/ops/restore-test.sh" 2>&1 | tail -1
echo "### leftovers"
echo "{\"restore_containers\":$(docker ps -aq --filter label=com.docker.compose.project=fcpi-restore | wc -l),\"restore_dir\":$([ -e /srv/firecrawl-pi/restore-test ] && echo true || echo false),\"staging_current\":$([ -e /srv/firecrawl-pi/backup-staging/current ] && echo true || echo false)}"
echo "### end"
