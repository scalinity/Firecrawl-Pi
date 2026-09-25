#!/usr/bin/env bash
# Prove dockerd itself is gated by the fail-closed data check (the unclean-boot path).
# Runs ON the Pi:  ssh ... 'bash /opt/firecrawl-pi/scripts/m1/pi-docker-gate.sh'
#
# After a power loss, dockerd's restart policies revive every container that was running,
# before fcpi-stack.service exists in the boot. This reproduces that path without a reboot:
#   1. stop docker.service and docker.socket alone (--job-mode=ignore-dependencies), so
#      fcpi-stack's `compose stop` never runs and the containers stay marked for revival;
#   2. point the check at a config whose filesystem UUID is wrong (manager environment
#      PI_CONFIG_FILE) and start dockerd: its ExecStartPre must fail, dockerd must stay
#      down, no project uid may run any process, and nothing under /srv/firecrawl-pi may
#      change;
#   3. restore the config and start dockerd: the check passes and the restart policies
#      revive every container, which shows step 2 blocked a real revival.
# A trap restores the environment and dockerd whatever happens.
set -uo pipefail
export LC_ALL=C
export PATH="/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"
REPO=/opt/firecrawl-pi
T=/run/fcpi-gate-test
UIDS=5432,6379,5672,3002,3380,8080

sec() { printf '### %s\n' "$1"; }
manifest() { sudo -n find /srv/firecrawl-pi -xdev -printf '%p|%y|%s|%T@|%u:%g|%m\n' | sort | sha256sum | cut -c1-64; }
writers() { pgrep -u "$UIDS" | wc -l; }
restore() {
  sudo -n systemctl unset-environment PI_CONFIG_FILE
  sudo -n systemctl reset-failed docker.service docker.socket 2>/dev/null
  sudo -n systemctl start docker.socket docker.service
  sudo -n rm -rf -- "$T"
}
trap restore EXIT

sec meta
date -u +%Y-%m-%dT%H:%M:%SZ
echo "source_commit=$(cat $REPO/.fcpi-source-commit)"

sec drop_in
echo "exec_start_pre=$(systemctl show -p ExecStartPre --value docker.service | grep -o 'path=[^ ;]*' | tr '\n' ' ')"
echo "drop_in_sha256=$(sha256sum </etc/systemd/system/docker.service.d/10-fcpi-data-check.conf | cut -c1-64) repo_sha256=$(sha256sum <$REPO/deploy/host/docker.service.d/10-fcpi-data-check.conf | cut -c1-64)"
echo "guard_drop_in_sha256=$(sha256sum </etc/systemd/system/docker.service.d/20-fcpi-guard.conf 2>/dev/null | cut -c1-64) guard_repo_sha256=$(sha256sum <$REPO/deploy/host/docker.service.d/20-fcpi-guard.conf | cut -c1-64)"
echo "restart=$(systemctl show -p Restart --value docker.service) restart_usec=$(systemctl show -p RestartUSec --value docker.service) start_limit_burst=$(systemctl show -p StartLimitBurst --value docker.service) start_limit_interval=$(systemctl show -p StartLimitIntervalUSec --value docker.service)"

sec before
echo "running_containers=$(sudo -n docker ps -q --filter label=com.docker.compose.project=fcpi | wc -l) writers=$(writers)"
echo "restart_policies=$(sudo -n docker ps -q --filter label=com.docker.compose.project=fcpi | xargs sudo -n docker inspect -f '{{.HostConfig.RestartPolicy.Name}}' | sort -u | tr '\n' ' ')"

sec stop_dockerd_alone
sudo -n systemctl stop --job-mode=ignore-dependencies docker.socket docker.service
echo "docker=$(systemctl is-active docker.service) fcpi_stack=$(systemctl is-active fcpi-stack.service) writers=$(writers)"
M0=$(manifest); echo "manifest=$M0"

sec gated_start
sudo -n install -d -m 0700 -o root -g root $T
sudo -n sh -c "sed 's/^PI_DATA_MOUNT_ID=.*/PI_DATA_MOUNT_ID=00000000-0000-4000-8000-000000000000/' /etc/firecrawl-pi/config.env > $T/bad.env && chmod 0600 $T/bad.env"
sudo -n systemctl set-environment PI_CONFIG_FILE=$T/bad.env
since=$(date '+%Y-%m-%d %H:%M:%S')
sudo -n systemctl start --job-mode=ignore-dependencies docker.service 2>&1 | head -1
echo "start_exit=${PIPESTATUS[0]}"
# Restart=always retries; observe until systemd gives up (StartLimitBurst) or 180 s pass,
# sampling every second, so a late or brief dockerd start could not be missed.
t0=$(date +%s); max_dockerd=0; max_writers=0; states=""
while :; do
  n=$(pgrep -xc dockerd); w=$(writers)
  [ "$n" -gt "$max_dockerd" ] && max_dockerd=$n
  [ "$w" -gt "$max_writers" ] && max_writers=$w
  st="$(systemctl show -p ActiveState --value docker.service)/$(systemctl show -p SubState --value docker.service)"
  case " $states " in *" $st "*) ;; *) states="$states $st" ;; esac
  [ "${st%%/*}" = failed ] && break
  [ $(( $(date +%s) - t0 )) -ge 180 ] && break
  sleep 1
done
observed=$(( $(date +%s) - t0 ))
echo "docker=$(systemctl is-active docker.service) result=$(systemctl show -p Result --value docker.service) dockerd_processes=$(pgrep -xc dockerd)"
echo "check_failures=$(sudo -n journalctl -u docker.service --since "$since" --no-pager -o cat | grep -c 'fcpi-data-check: FAIL: filesystem UUID')"
echo "writers=$(writers)"
M=$(manifest); echo "manifest_unchanged=$([ "$M" = "$M0" ] && echo yes || echo NO)"

sec start_limit
echo "observed_s=$observed reached_failed=$([ "$(systemctl show -p ActiveState --value docker.service)" = failed ] && echo yes || echo no) active_state=$(systemctl show -p ActiveState --value docker.service) sub_state=$(systemctl show -p SubState --value docker.service) result=$(systemctl show -p Result --value docker.service) nrestarts=$(systemctl show -p NRestarts --value docker.service)"
echo "states_seen=${states# }"
echo "max_dockerd_processes=$max_dockerd max_writers=$max_writers"

sec restored_start
sudo -n systemctl unset-environment PI_CONFIG_FILE
sudo -n systemctl reset-failed docker.service docker.socket
sudo -n systemctl start docker.socket docker.service; echo "start_exit=$?"
for i in $(seq 1 90); do
  [ "$(sudo -n docker ps -q --filter label=com.docker.compose.project=fcpi --filter health=healthy | wc -l)" = 6 ] && break
  sleep 3
done
echo "docker=$(systemctl is-active docker.service) result=$(systemctl show -p Result --value docker.service) fcpi_stack=$(systemctl is-active fcpi-stack.service)"
echo "revived_healthy=$(sudo -n docker ps -q --filter label=com.docker.compose.project=fcpi --filter health=healthy | wc -l) writers=$(writers)"
echo "manager_env_PI_CONFIG_FILE=$(systemctl show-environment | grep -c '^PI_CONFIG_FILE=')"
# The guard's drop-in reloaded the table at this start (its counters restart at zero).
echo "guard_table=$(sudo -n nft list table inet fcpi_guard >/dev/null 2>&1 && echo present || echo absent) guard_rules=$(sudo -n nft -j list table inet fcpi_guard 2>/dev/null | jq '[.nftables[] | select(.rule)] | length')"
echo end
