#!/usr/bin/env bash
# The off-device backup account (FIRECRAWL_PI_SPEC.md §26), ON the owner's VPS, as root, idempotent:
#   ssh … 'sudo bash -s -- <Pi backup public key>' < scripts/m8/vps-backup-account.sh
# A dedicated user, fcpi-backup, that can do one thing: SFTP inside /srv/fcpi-backup, whose only writable directories are
# restic/ (the repository) and heartbeat/ (the Pi's dated status for the VPS watchdog, scripts/m8/vps-watchdog.sh). No shell, no forwarding, no TTY, public-key login only, and only with the Pi's backup key
# (scripts/m8/pi-backup-setup.sh sshkey), marked restrict. The sshd drop-in holds a Match block for that user alone,
# is checked with sshd -t before sshd reloads, and is removed again if the check fails, so no other login changes.
# Nothing else on the host is touched. Prints the account, the directory's free space and the host key's fingerprint.
set -euo pipefail
PUB=${1:?usage: vps-backup-account.sh <ssh-ed25519 public key>}
[[ $PUB =~ ^ssh-ed25519\ [A-Za-z0-9+/=]+(\ .*)?$ ]] || { echo "not an ssh-ed25519 public key" >&2; exit 2; }
U=fcpi-backup C=/srv/fcpi-backup D=/etc/ssh/sshd_config.d/60-fcpi-backup.conf
id "$U" >/dev/null 2>&1 || useradd --system --home-dir "$C" --no-create-home --shell /usr/sbin/nologin "$U"
install -d -m 0755 -o root -g root "$C"            # a chroot must be root's and not writable by the user
install -d -m 0700 -o "$U" -g "$U" "$C/restic"
install -d -m 0700 -o "$U" -g "$U" "$C/heartbeat"      # the Pi's dated status, which the VPS watchdog reads
install -d -m 0755 -o root -g root /etc/ssh/fcpi-backup
printf 'restrict %s\n' "$PUB" >/etc/ssh/fcpi-backup/authorized_keys
chmod 0644 /etc/ssh/fcpi-backup/authorized_keys
grep -qE '^\s*Include\s+/etc/ssh/sshd_config\.d/\*\.conf' /etc/ssh/sshd_config || { echo "sshd_config does not include sshd_config.d; not changed" >&2; exit 3; }
cat >"$D" <<EOF
# The Firecrawl Pi platform's off-device backup account: SFTP only, inside $C (scripts/m8/vps-backup-account.sh).
Match User $U
    AuthorizedKeysFile /etc/ssh/fcpi-backup/authorized_keys
    AuthenticationMethods publickey
    ChrootDirectory $C
    ForceCommand internal-sftp -d /restic
    AllowTcpForwarding no
    AllowAgentForwarding no
    X11Forwarding no
    PermitTTY no
    PermitTunnel no
EOF
chmod 0644 "$D"
if ! sshd -t 2>/tmp/fcpi-sshd-check.$$; then cat /tmp/fcpi-sshd-check.$$ >&2; rm -f "$D" /tmp/fcpi-sshd-check.$$; echo "sshd -t failed; the drop-in was removed" >&2; exit 4; fi
rm -f /tmp/fcpi-sshd-check.$$
systemctl reload ssh 2>/dev/null || systemctl reload sshd
echo "account=$(id "$U")"
echo "chroot=$C repository_dir=$C/restic free=$(df -h --output=avail "$C" | tail -1 | tr -d ' ')"
ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub
