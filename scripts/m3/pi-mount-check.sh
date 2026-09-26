#!/usr/bin/env bash
# A missing data mount fails closed (milestones M3 "missing mount"; spec §21.1, §24.2), ON the Pi:
#   ssh … 'bash -s' < scripts/m3/pi-mount-check.sh
#   1. the data check passes on the real configuration (the positive control);
#   2. with a Compose file whose artifact bind source is absent, the data check refuses, so neither
#      the stack unit nor dockerd would start a writer, and nothing is created at that path;
#   3. the gateway's own image, given an artifact root without the marker (an empty directory, as a
#      missing mount leaves), refuses to start and writes nothing into it.
# Uses PI_CONFIG_FILE and a rendered copy under a private temporary directory; changes nothing else.
set -uo pipefail
export LC_ALL=C
export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
REPO=/opt/firecrawl-pi
D() { sudo -n docker "$@"; }
sec() { printf '### %s\n' "$1"; }
T=$(sudo -n mktemp -d /run/fcpi-mount-check.XXXXXX)
trap 'sudo -n rm -rf "$T"' EXIT
MISSING=/srv/firecrawl-pi/data/artifacts-absent-$$

sec meta
echo "utc=$(date -u +%Y-%m-%dT%H:%M:%SZ) source_commit=$(cat $REPO/.fcpi-source-commit)"

sec control
sudo -n sh $REPO/deploy/host/fcpi-data-check.sh 2>&1; echo "exit=$?"

sec missing_artifact_bind
# The real configuration with PI_COMPOSE_FILE pointing at a copy whose artifact source is absent.
sudo -n sed "s#^PI_COMPOSE_FILE=.*#PI_COMPOSE_FILE=$T/compose.yaml#" /etc/firecrawl-pi/config.env | sudo -n tee "$T/config.env" >/dev/null
sudo -n sed "s#source: /srv/firecrawl-pi/data/artifacts\$#source: $MISSING#" $REPO/deploy/compose.yaml | sudo -n tee "$T/compose.yaml" >/dev/null
echo "copy_names_missing_source=$(sudo -n grep -c "source: $MISSING\$" "$T/compose.yaml")"
sudo -n env PI_CONFIG_FILE="$T/config.env" sh $REPO/deploy/host/fcpi-data-check.sh 2>&1 | sed "s#$MISSING#<missing-artifact-path>#"
echo "exit=${PIPESTATUS[0]}"
echo "missing_path_created=$(sudo -n test -e "$MISSING" && echo yes || echo no)"

sec shadow_artifact_root
# The gateway image as the stack runs it, with an empty artifact root: it must exit before listening.
IMG=$(sed -n 's#^ *image: \(fcpi/access-gateway@sha256:[0-9a-f]\{64\}\)$#\1#p' $REPO/deploy/compose.yaml)
sudo -n install -d -m 0777 "$T/empty" "$T/cred" "$T/clients"
head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n' | sudo -n tee "$T/cred/gateway_postgres_password" >/dev/null
printf '# none\n' | sudo -n tee "$T/clients/clients" >/dev/null
sudo -n chmod 0644 "$T/cred/gateway_postgres_password" "$T/clients/clients"
out=$(D run --rm --network none --read-only --cap-drop ALL --security-opt no-new-privileges:true --user 3380:3380 --label fcpi.transient=mount-check \
  -e PI_CORE_URL=http://firecrawl-core:3002 -e PI_GATEWAY_CLIENTS_FILE=/srv/clients/clients -e PI_ALLOWED_HOSTS=http://127.0.0.1:3380 \
  -e PI_CAPABILITIES_FILE=/srv/policy/capabilities.json -e PI_ARTIFACT_ROOT=/srv/artifacts -e PI_CREDENTIALS_DIR=/srv/cred \
  -e PI_POSTGRES_HOST=nuq-postgres -e PI_POSTGRES_DB=postgres -e PI_POSTGRES_USER=fcpi_gateway \
  -v "$REPO/deploy/policies/capabilities.json:/srv/policy/capabilities.json:ro" -v "$T/empty:/srv/artifacts" -v "$T/cred:/srv/cred:ro" -v "$T/clients:/srv/clients:ro" \
  "$IMG" 2>&1); rc=$?
printf '%s\n' "$out" | grep -o 'lacks \.fcpi-artifact-root[^"]*' | head -1
echo "exit=$rc listening=$(printf '%s\n' "$out" | grep -c '"event":"listening"') files_written=$(sudo -n find "$T/empty" -mindepth 1 | wc -l)"
sec transient
echo "leftover_transient_containers=$(D ps -aq --filter label=fcpi.transient | wc -l)"
echo end
