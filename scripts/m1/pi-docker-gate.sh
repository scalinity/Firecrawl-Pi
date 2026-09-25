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
# Restart=always retries; wait out StartLimitBurst so a late success could not be missed.
for i in $(seq 1 30); do [ "$(systemctl show -p ActiveState --value docker.service)" = failed ] && break; sleep 2; done
echo "docker=$(systemctl is-active docker.service) result=$(systemctl show -p Result --value docker.service) dockerd_processes=$(pgrep -xc dockerd)"
echo "check_failures=$(sudo -n journalctl -u docker.service --since "$since" --no-pager -o cat | grep -c 'fcpi-data-check: FAIL: filesystem UUID')"
echo "writers=$(writers)"
M=$(manifest); echo "manifest_unchanged=$([ "$M" = "$M0" ] && echo yes || echo NO)"

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
echo end
