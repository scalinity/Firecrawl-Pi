#!/usr/bin/env bash
# Prove each failure branch of fcpi-data-check stops the stack without writing anything.
# Runs ON the Pi:  ssh ... 'bash /opt/firecrawl-pi/scripts/m1/pi-mount-branches.sh'
#
# With the stack stopped, each branch points the check at a deliberately wrong config
# through the systemd manager environment (PI_CONFIG_FILE; no unit file is edited), then
# `systemctl start fcpi-stack` must fail, no project container may run, and a metadata
# manifest of /srv/firecrawl-pi (path, type, size, mtime, owner, mode) must be unchanged.
# A last case bypasses the check and shows Compose itself refuses to create a missing
# bind source (create_host_path: false). The stack is started again at the end.
set -uo pipefail
export LC_ALL=C
export PATH="/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"
REPO=/opt/firecrawl-pi
CFG=/etc/firecrawl-pi/config.env
T=/run/fcpi-branch-test
ABSENT_DIR=/srv/firecrawl-pi/data-absent-m1-test
ABSENT_BIND=/srv/firecrawl-pi/data/absent-m1-test

D() { sudo -n docker "$@"; }
sec() { printf '### %s\n' "$1"; }
manifest() { sudo -n find /srv/firecrawl-pi -xdev -printf '%p|%y|%s|%T@|%u:%g|%m\n' | sort | sha256sum | cut -c1-64; }
running() { D ps -q --filter label=com.docker.compose.project=fcpi | wc -l; }

sec meta
date -u +%Y-%m-%dT%H:%M:%SZ
echo "source_commit=$(cat $REPO/.fcpi-source-commit)"

sec positive_control
sudo -n $REPO/deploy/host/fcpi-data-check.sh 2>&1; echo "check_exit=$?"

sec stop
sudo -n systemctl stop fcpi-stack.service; echo "stop_exit=$? running_containers=$(running)"
M0=$(manifest); echo "manifest=$M0 entries=$(sudo -n find /srv/firecrawl-pi -xdev | wc -l)"

sudo -n install -d -m 0700 -o root -g root $T
mkcfg() { sudo -n sh -c "sed '$2' $CFG > $T/$1.env && chmod 0600 $T/$1.env"; }
mkcfg uuid_mismatch 's/^PI_DATA_MOUNT_ID=.*/PI_DATA_MOUNT_ID=00000000-0000-4000-8000-000000000000/'
mkcfg data_id_mismatch 's/^PI_DATA_ID=.*/PI_DATA_ID=00000000-0000-4000-8000-000000000001/'
mkcfg data_dir_absent "s#^PI_DATA_DIR=.*#PI_DATA_DIR=$ABSENT_DIR#"
# Compose copies: one bind that would create its host path, one bind whose source is absent.
sudo -n sh -c "awk 'done != 1 && /bind: \\{ create_host_path: false \\}/ {done = 1; next} {print}' $REPO/deploy/compose.yaml > $T/compose-creates-path.yaml"
sudo -n sh -c "sed 's#source: /srv/firecrawl-pi/data/redis\$#source: $ABSENT_BIND#' $REPO/deploy/compose.yaml > $T/compose-absent-source.yaml"
mkcfg bind_creates_host_path "s#^PI_COMPOSE_FILE=.*#PI_COMPOSE_FILE=$T/compose-creates-path.yaml#"
mkcfg bind_source_absent "s#^PI_COMPOSE_FILE=.*#PI_COMPOSE_FILE=$T/compose-absent-source.yaml#"
echo "compose_creates_path_diff_lines=$(sudo -n diff $REPO/deploy/compose.yaml $T/compose-creates-path.yaml | grep -c '^[<>]')"
echo "compose_absent_source_diff_lines=$(sudo -n diff $REPO/deploy/compose.yaml $T/compose-absent-source.yaml | grep -c '^[<>]')"

for b in uuid_mismatch data_id_mismatch data_dir_absent bind_creates_host_path bind_source_absent; do
  sec "branch_$b"
  sudo -n systemctl set-environment PI_CONFIG_FILE=$T/$b.env
  sudo -n systemctl start fcpi-stack.service 2>&1 | head -2
  echo "stack_start_exit=${PIPESTATUS[0]}"
  echo "data_check_result=$(systemctl show -p Result --value fcpi-data-check.service) stack_active=$(systemctl is-active fcpi-stack.service)"
  # The message of exactly this run of the check, by its systemd invocation ID.
  inv=$(systemctl show -p InvocationID --value fcpi-data-check.service)
  echo "check_message=$(sudo -n journalctl _SYSTEMD_INVOCATION_ID=$inv --no-pager -o cat | grep -m1 'fcpi-data-check: FAIL')"
  # The same config through the check directly, as a cross-check of the reason.
  direct=$(sudo -n env PI_CONFIG_FILE=$T/$b.env $REPO/deploy/host/fcpi-data-check.sh 2>&1); echo "direct_check_exit=$? direct_message=$direct"
  echo "running_containers=$(running)"
  M=$(manifest); echo "manifest_unchanged=$([ "$M" = "$M0" ] && echo yes || echo NO)"
  echo "absent_dir_created=$(test -e $ABSENT_DIR && echo YES || echo no) absent_bind_created=$(sudo -n test -e $ABSENT_BIND && echo YES || echo no)"
  sudo -n systemctl unset-environment PI_CONFIG_FILE
  sudo -n systemctl reset-failed fcpi-stack.service fcpi-data-check.service 2>/dev/null
done

sec compose_refuses_missing_bind
# Bypass the check: Compose itself must refuse to start a service whose bind source is
# absent, and must not create the path. Project fcpi-m1probe, removed by name afterwards.
# The probe reuses the fixture's image from the deployed Compose file (already present).
PROBE_IMAGE=$(D compose -f $REPO/deploy/compose.yaml config --format json | jq -r .services.fixture.image)
echo "probe_image=$PROBE_IMAGE"
cat <<EOF | sudo -n tee $T/probe.yaml >/dev/null
name: fcpi-m1probe
services:
  probe:
    image: $PROBE_IMAGE
    pull_policy: never
    network_mode: none
    command: ["node", "-e", "0"]
    volumes:
      - type: bind
        source: $ABSENT_BIND
        target: /x
        bind: { create_host_path: false }
EOF
D compose -f $T/probe.yaml up -d 2>&1 | tail -2
echo "probe_up_exit=${PIPESTATUS[0]}"
echo "absent_bind_created=$(sudo -n test -e $ABSENT_BIND && echo YES || echo no)"
M=$(manifest); echo "manifest_unchanged=$([ "$M" = "$M0" ] && echo yes || echo NO)"
D compose -f $T/probe.yaml down 2>&1 | tail -1
echo "probe_resources_left=$( (D ps -aq --filter label=com.docker.compose.project=fcpi-m1probe; D network ls -q --filter label=com.docker.compose.project=fcpi-m1probe) | wc -l)"
sudo -n rm -rf -- $T && echo "removed $T"

sec restart
sudo -n systemctl start fcpi-stack.service; echo "start_exit=$? stack_active=$(systemctl is-active fcpi-stack.service) data_check_result=$(systemctl show -p Result --value fcpi-data-check.service)"
D compose -p fcpi ps -a --format '{{.Service}} {{.State}} {{.Health}}'
echo "manager_env_PI_CONFIG_FILE=$(systemctl show-environment | grep -c '^PI_CONFIG_FILE=')"
echo end
