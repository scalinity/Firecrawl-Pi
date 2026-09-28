#!/usr/bin/env bash
# The backup repository's configuration (FIRECRAWL_PI_SPEC.md §26), ON the Pi, as root:
#   pi-backup-setup.sh fixture
#       a restic repository on the Pi's own data filesystem (/srv/firecrawl-pi/backup-fixture-repo), for the fixture
#       tests and the rehearsal only, configured in its own /etc/firecrawl-pi/backup-fixture.env. It is on the same card
#       as the data, so it is NOT the off-device backup spec §26 requires, and the file says so (FCPI_BACKUP_OFFDEVICE=no).
#   pi-backup-setup.sh sshkey
#       the backup's own SSH key (secrets/backup/ssh_ed25519, created once): prints its public half only, for the
#       backup account on the off-device host (scripts/m8/vps-backup-account.sh).
#   pi-backup-setup.sh hostkey <host> [<port>]
#       pins the host's ed25519 key in secrets/backup/known_hosts and prints its fingerprint, which must be the one the
#       host itself shows.
#   pi-backup-setup.sh live <sftp:user@host:/path> [<port>]
#       the owner's off-device repository over SFTP, with that key and the pinned host key, opened or initialised with
#       the Pi's own restic key.
#   pi-backup-setup.sh live <repository> [<backend credentials file>]
#       any other off-device backend (rest:…, s3:…, b2:…); its credentials, from a file the owner placed on the Pi,
#       move into the secrets directory (0600).
#   pi-backup-setup.sh recovery-add
#       adds the repository's recovery key, read on stdin (scripts/m8/recovery-key.sh sends it from the workstation, where
#       it is kept): it passes through restic's memory and is never written on the Pi. Then opens the repository with it.
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
case ${1:-} in
  sshkey)
    [ -f "$S/ssh_ed25519" ] || ssh-keygen -q -t ed25519 -N "" -C "fcpi-backup@pi" -f "$S/ssh_ed25519"
    chmod 0600 "$S/ssh_ed25519"; cat "$S/ssh_ed25519.pub"; exit 0 ;;
  hostkey)
    h=${2:?host}; p=${3:-22}
    t=$(mktemp "$S/.kh.XXXXXX"); ssh-keyscan -t ed25519 -p "$p" "$h" 2>/dev/null >"$t"
    [ -s "$t" ] || { rm -f "$t"; die "no ed25519 host key from $h:$p"; }
    mv -f "$t" "$S/known_hosts"; chmod 0600 "$S/known_hosts"
    ssh-keygen -lf "$S/known_hosts"; exit 0 ;;
  recovery-add)
    # shellcheck disable=SC1091
    . /etc/firecrawl-pi/backup.env
    [ "${FCPI_BACKUP_OFFDEVICE:-}" = yes ] || die "backup.env names no off-device repository"
    export RESTIC_REPOSITORY=$FCPI_RESTIC_REPOSITORY RESTIC_PASSWORD_FILE=$FCPI_RESTIC_PASSWORD_FILE RESTIC_CACHE_DIR=$STATE/restic-cache
    pw=$(cat); [ "${#pw}" -ge 32 ] || die "the recovery key read on stdin is shorter than 32 characters"
    n0=$(restic key list --json | jq length)
    # Idempotent: a key that already opens the repository is not added twice.
    restic --password-file <(printf '%s\n' "$pw") cat config >/dev/null 2>&1 \
      || restic key add --host owner-recovery --user owner --new-password-file <(printf '%s\n' "$pw") >/dev/null
    ok=$(restic --password-file <(printf '%s\n' "$pw") cat config >/dev/null 2>&1 && echo yes || echo no); unset pw
    echo "restic keys: $n0 -> $(restic key list --json | jq length); the recovery key opens the repository: $ok"; exit 0 ;;
esac
# The refusal comes before any repository is opened or initialised.
# The fixture repository's configuration is its own file (the fixture proof and the rehearsal read it); backup.env is
# the owner's off-device repository, which the nightly backup, the weekly check and the monthly restore test read.
case ${1:-} in fixture) want=/srv/firecrawl-pi/backup-fixture-repo OUTF=/etc/firecrawl-pi/backup-fixture.env ;; live) want=${2:-} OUTF=/etc/firecrawl-pi/backup.env ;; *) want="" OUTF="" ;; esac
now_repo=$(sed -n 's/^FCPI_RESTIC_REPOSITORY=//p' "${OUTF:-/dev/null}" 2>/dev/null || true)   # absent at the first setup
if [ -n "$want" ] && [ -n "$now_repo" ] && [ "$now_repo" != "$want" ] && [ "$switch" != true ]; then
  die "$OUTF already names another repository (offdevice=$(sed -n 's/^FCPI_BACKUP_OFFDEVICE=//p' "$OUTF")); kept as it is. Add --switch to replace it"
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
    repo=${2:?repository}; key "$S/restic-password"; envf="" sftpc=""
    if [[ $repo =~ ^sftp:([^@:/]+)@([^:/]+):(/.*)$ ]]; then
      u=${BASH_REMATCH[1]} h=${BASH_REMATCH[2]} p=${3:-22}
      [ -f "$S/ssh_ed25519" ] || die "no backup SSH key: run pi-backup-setup.sh sshkey first"
      [ -s "$S/known_hosts" ] || die "no pinned host key: run pi-backup-setup.sh hostkey $h $p first"
      sftpc="ssh -i $S/ssh_ed25519 -o IdentitiesOnly=yes -o BatchMode=yes -o StrictHostKeyChecking=yes -o UserKnownHostsFile=$S/known_hosts -o ServerAliveInterval=30 -p $p $u@$h -s sftp"
    elif [ -n "${3:-}" ]; then envf=$S/backend.env; [ -f "$envf" ] || { install -m 0600 "$3" "$envf" && shred -u "$3" 2>/dev/null || rm -f "$3"; }; fi
    export RESTIC_REPOSITORY=$repo RESTIC_PASSWORD_FILE=$S/restic-password RESTIC_CACHE_DIR=$STATE/restic-cache
    FCPI_RESTIC_ENV_FILE=$envf FCPI_RESTIC_SFTP_COMMAND=$sftpc   # read by lib.sh's restic alone
    if restic cat config >/dev/null 2>&1; then echo "repository opens with the Pi's key"; else restic init >/dev/null && echo "repository initialised with the Pi's key"; fi
    conf="FCPI_RESTIC_REPOSITORY=$repo
FCPI_RESTIC_PASSWORD_FILE=$S/restic-password${envf:+
FCPI_RESTIC_ENV_FILE=$envf}${sftpc:+
FCPI_RESTIC_SFTP_COMMAND=\"$sftpc\"}
FCPI_BACKUP_OFFDEVICE=yes"
    echo "restic keys: $(restic key list --json 2>/dev/null | jq length) (the recovery key is the owner's to add: scripts/m8/recovery-key.sh, from the workstation)" ;;
  *) die "usage: pi-backup-setup.sh fixture | sshkey | hostkey <host> [<port>] | live <repository> [<port>|<credentials file>] | recovery-add  [--switch]" ;;
esac
printf '%s\n' "$conf" | write_atomic "$OUTF" 0600
echo "wrote $OUTF (offdevice=$(sed -n 's/^FCPI_BACKUP_OFFDEVICE=//p' "$OUTF"))"
