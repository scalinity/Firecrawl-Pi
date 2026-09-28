#!/usr/bin/env bash
# M8's host installation, ON the Pi, idempotent (every step checks before it changes):
#   1. restic from Debian's signed archive, at RESTIC_VERSION below (trixie's; scripts/m8/build-lock.mjs records it in the
#      version lock from this script's transcript);
#   2. the operations state and log directories (/var/lib/firecrawl-pi, /var/log/firecrawl-pi) and the backup staging
#      area on the data filesystem (/srv/firecrawl-pi/backup-staging, root 0700);
#   3. /etc/tmpfiles.d/fcpi.conf, applied now (the admission directory the gateway and the retrieval service mount);
#   4. the project's systemd units: fcpi.slice (no swap, re-asserted at every reload: M4 F2), the tick, probe, boot-record,
#      backup, backup-check and restore-test units and timers, and fcpi-stack.service (which now reports containers
#      outside the project: M1 R12); then daemon-reload, and the timers and the boot record enabled;
#   5. /usr/local/bin/fcpi pointing at the deployed command;
#   6. the operator's gateway client (label ops, principal operator: read, scrape, map), which the probe, the boot
#      record and fcpi status use, and the soak's client (label soak, principal soak: every scope), if absent.
# A daemon-reload lifts the swap limit of every container not yet under fcpi.slice (F2): scripts/m8/pi-up-m8.sh recreates
# the stack under the slice next. Prints what it did; no secret.   ssh … 'bash /opt/firecrawl-pi/scripts/m8/pi-init-m8.sh'
set -euo pipefail
export LC_ALL=C PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
REPO=/opt/firecrawl-pi
H=$REPO/deploy/host
sec() { printf '### %s\n' "$1"; }
sec meta
echo "utc=$(date -u +%Y-%m-%dT%H:%M:%SZ) source_commit=$(cat $REPO/.fcpi-source-commit)"

sec restic
RESTIC_VERSION=0.18.0-1+b4
want=$RESTIC_VERSION
have=$(dpkg-query -W -f '${Version}' restic 2>/dev/null || true)
if [ "$have" != "$want" ]; then sudo -n apt-get -q -o Dpkg::Use-Pty=0 install -y --no-install-recommends "restic=$want" 2>&1 | tail -2; fi
echo "restic_package=$(dpkg-query -W -f '${Version}' restic) restic_sha256=$(sha256sum /usr/bin/restic | cut -c1-64) $(restic version | head -1)"

sec directories
sudo -n install -d -m 0755 -o root -g root /var/lib/firecrawl-pi /var/lib/firecrawl-pi/boots /var/lib/firecrawl-pi/releases /var/lib/firecrawl-pi/verify
sudo -n install -d -m 0700 -o root -g root /var/lib/firecrawl-pi/alerts /var/lib/firecrawl-pi/backup /var/lib/firecrawl-pi/supervisor /var/lib/firecrawl-pi/doctor
sudo -n install -d -m 0750 -o root -g adm /var/log/firecrawl-pi /var/log/firecrawl-pi/samples /var/log/firecrawl-pi/probe
sudo -n install -d -m 0700 -o root -g root /srv/firecrawl-pi/backup-staging
[ "$(findmnt -no UUID --target /srv/firecrawl-pi/backup-staging)" = "$(sudo -n sh -c '. /etc/firecrawl-pi/config.env; echo $PI_DATA_MOUNT_ID')" ] \
  || { echo "the staging area is not on the data filesystem" >&2; exit 1; }
sudo -n stat -c '%U:%G %a %n' /var/lib/firecrawl-pi /var/lib/firecrawl-pi/alerts /var/lib/firecrawl-pi/backup /var/log/firecrawl-pi /srv/firecrawl-pi/backup-staging

sec tmpfiles
sudo -n install -m 0644 -o root -g root $H/tmpfiles-fcpi.conf /etc/tmpfiles.d/fcpi.conf
sudo -n systemd-tmpfiles --create /etc/tmpfiles.d/fcpi.conf
stat -c '%U:%G %a %n' /run/firecrawl-pi/admission /run/firecrawl-pi/admission/admission.json

sec units
changed=0
for f in fcpi.slice fcpi-stack.service fcpi-tick.service fcpi-tick.timer fcpi-probe.service fcpi-probe.timer fcpi-boot-record.service \
         fcpi-backup.service fcpi-backup.timer fcpi-backup-check.service fcpi-backup-check.timer fcpi-restore-test.service fcpi-restore-test.timer; do
  if ! cmp -s $H/$f /etc/systemd/system/$f; then sudo -n install -m 0644 -o root -g root $H/$f /etc/systemd/system/$f; echo "installed $f"; changed=1; fi
done
[ $changed = 1 ] && sudo -n systemctl daemon-reload && echo "daemon-reload (lifts the swap limit of containers not yet under fcpi.slice until they are recreated)"
sudo -n systemctl start fcpi.slice
for t in fcpi-tick.timer fcpi-probe.timer fcpi-backup.timer fcpi-backup-check.timer fcpi-restore-test.timer; do sudo -n systemctl enable --now "$t" 2>&1 | grep -v '^Created symlink' || true; done
sudo -n systemctl enable fcpi-boot-record.service 2>&1 | grep -v '^Created symlink' || true
echo "fcpi.slice MemorySwapMax=$(systemctl show -p MemorySwapMax --value fcpi.slice) memory.swap.max=$(cat /sys/fs/cgroup/fcpi.slice/memory.swap.max)"
systemctl is-enabled fcpi-tick.timer fcpi-probe.timer fcpi-backup.timer fcpi-backup-check.timer fcpi-restore-test.timer fcpi-boot-record.service | paste -sd' ' -

sec command
sudo -n ln -sfn $REPO/scripts/fcpi /usr/local/bin/fcpi
readlink /usr/local/bin/fcpi

sec clients
for c in "ops operator read,scrape,map" "soak soak read,scrape,map,crawl,batch,cancel,search,extract"; do
  set -- $c
  if sudo -n test -f /etc/firecrawl-pi/secrets/clients/$1.token; then echo "kept client $1"; else bash $REPO/scripts/m3/pi-client-token.sh create "$1" "$2" "$3" >/dev/null && echo "created client $1 ($2: $3)"; fi
done
echo end
