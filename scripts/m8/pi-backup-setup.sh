#!/usr/bin/env bash
# The backup repository's configuration (FIRECRAWL_PI_SPEC.md §26), ON the Pi, as root:
#   pi-backup-setup.sh fixture
#       a restic repository on the Pi's own data filesystem (/srv/firecrawl-pi/backup-fixture-repo), for the fixture
#       tests and the rehearsal only. It is on the same card as the data, so it is NOT the off-device backup spec §26
#       requires, and /etc/firecrawl-pi/backup.env says so (FCPI_BACKUP_OFFDEVICE=no).
#   pi-backup-setup.sh live <repository> [<backend credentials file>]
#       the owner's off-device repository (sftp:…, rest:…, s3:…, b2:…), opened or initialised with the Pi's own key; its
#       backend credentials, if any, from a file the owner placed on the Pi (moved into the secrets directory, 0600).
#       The repository's recovery key is the owner's to add from their own machine (restic key add), kept off the Pi.
# The Pi's key is generated here into /etc/firecrawl-pi/secrets/backup/restic-password (0600) and never printed. An
# existing key is kept, never overwritten. An existing configuration naming another repository is kept too: switching
# (above all from the live repository back to the fixture one, which would move the nightly backups onto the card
# silently) needs --switch as the last argument.
set -euo pipefail
switch=false; [ "${*: -1}" = --switch ] && { switch=true; set -- "${@:1:$#-1}"; }
. /opt/firecrawl-pi/scripts/ops/lib.sh
need_root
S=/etc/firecrawl-pi/secrets/backup; install -d -m 0700 -o root -g root "$S"
key() { # key <file>: a new 48-byte random key, created only if absent (hard link, so an existing file is never replaced)
  [ -f "$1" ] && { echo "kept $1"; return; }
  local t; t=$(mktemp "$S/.new.XXXXXX"); chmod 0600 "$t"; head -c 48 /dev/urandom | base64 -w0 >"$t"; ln "$t" "$1" && rm -f "$t"; echo "created $1"; }
# The refusal comes before any repository is opened or initialised.
case ${1:-} in fixture) want=/srv/firecrawl-pi/backup-fixture-repo ;; live) want=${2:-} ;; *) want="" ;; esac
now_repo=$(sed -n 's/^FCPI_RESTIC_REPOSITORY=//p' /etc/firecrawl-pi/backup.env 2>/dev/null)
if [ -n "$want" ] && [ -n "$now_repo" ] && [ "$now_repo" != "$want" ] && [ "$switch" != true ]; then
  die "backup.env already names another repository (offdevice=$(sed -n 's/^FCPI_BACKUP_OFFDEVICE=//p' /etc/firecrawl-pi/backup.env)); kept as it is. Add --switch to replace it"
fi
case ${1:-} in
  fixture)
    repo=/srv/firecrawl-pi/backup-fixture-repo; key "$S/fixture-restic-password"
    export RESTIC_REPOSITORY=$repo RESTIC_PASSWORD_FILE=$S/fixture-restic-password RESTIC_CACHE_DIR=$STATE/restic-cache
    if restic cat config >/dev/null 2>&1; then echo "repository exists"; else install -d -m 0700 "$repo"; restic init >/dev/null && echo "repository initialised"; fi
    conf="FCPI_RESTIC_REPOSITORY=$repo
FCPI_RESTIC_PASSWORD_FILE=$S/fixture-restic-password
FCPI_BACKUP_OFFDEVICE=no" ;;
  live)
    repo=${2:?repository}; key "$S/restic-password"
    envf=""; if [ -n "${3:-}" ]; then envf=$S/backend.env; [ -f "$envf" ] || { install -m 0600 "$3" "$envf" && shred -u "$3" 2>/dev/null || rm -f "$3"; }; fi
    export RESTIC_REPOSITORY=$repo RESTIC_PASSWORD_FILE=$S/restic-password RESTIC_CACHE_DIR=$STATE/restic-cache
    FCPI_RESTIC_ENV_FILE=$envf   # read by lib.sh's restic alone
    if restic cat config >/dev/null 2>&1; then echo "repository opens with the Pi's key"; else restic init >/dev/null && echo "repository initialised with the Pi's key"; fi
    conf="FCPI_RESTIC_REPOSITORY=$repo
FCPI_RESTIC_PASSWORD_FILE=$S/restic-password${envf:+
FCPI_RESTIC_ENV_FILE=$envf}
FCPI_BACKUP_OFFDEVICE=yes"
    echo "restic keys: $(restic key list --json 2>/dev/null | jq length) (the recovery key is the owner's to add: restic key add, from a machine that is not the Pi)" ;;
  *) die "usage: pi-backup-setup.sh fixture | live <repository> [<credentials file>]  [--switch]" ;;
esac
printf '%s\n' "$conf" | write_atomic /etc/firecrawl-pi/backup.env 0600
echo "wrote /etc/firecrawl-pi/backup.env (offdevice=$(sed -n 's/^FCPI_BACKUP_OFFDEVICE=//p' /etc/firecrawl-pi/backup.env))"
