#!/usr/bin/env bash
# The off-device backup and its restore (FIRECRAWL_PI_SPEC.md §26; K03), ON the Pi, as root:
#   ssh … 'sudo -n bash /opt/firecrawl-pi/scripts/m8/pi-backup-live.sh' > evidence/M8/raw/backup-live.txt
# While /etc/firecrawl-pi/backup.env names no off-device repository (FCPI_BACKUP_OFFDEVICE=yes, set by
# scripts/m8/pi-backup-setup.sh live), it records configured=no with the reason and sends nothing, so K03 is
# BLOCKED_CREDENTIAL from a record rather than from a missing file. Otherwise: fcpi backup to that repository, the
# repository's key count (the Pi's own and the owner's recovery key), and fcpi restore-test of that backup.
set -uo pipefail
. /opt/firecrawl-pi/scripts/ops/lib.sh
need_root
echo "### meta"
off=$(sed -n 's/^FCPI_BACKUP_OFFDEVICE=//p' /etc/firecrawl-pi/backup.env 2>/dev/null)
if [ "$off" != yes ]; then
  echo "utc=$(utc) source_commit=$(source_commit) configured=no offdevice=${off:-absent} reason=backup.env-names-no-off-device-repository"
  echo "### end"; exit 0
fi
# shellcheck disable=SC1091
. /etc/firecrawl-pi/backup.env
export RESTIC_REPOSITORY=$FCPI_RESTIC_REPOSITORY RESTIC_PASSWORD_FILE=$FCPI_RESTIC_PASSWORD_FILE RESTIC_CACHE_DIR=$STATE/restic-cache
keys=$(restic key list --json 2>/dev/null | jq length)
echo "utc=$(utc) source_commit=$(source_commit) configured=yes offdevice=yes restic_keys=${keys:-0}"
echo "### backup"; bash "$REPO/scripts/ops/backup.sh" | tail -1
echo "### restore_test"; bash "$REPO/scripts/ops/restore-test.sh" 2>&1 | tail -1
echo "### end"
