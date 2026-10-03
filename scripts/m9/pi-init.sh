#!/usr/bin/env bash
# Install M9's project-only incident state and units, leaving automatic agent use
# disabled until fixture verification and independent review/remediation complete.
set -euo pipefail
. "$(dirname "$(readlink -f "$0")")/../ops/lib.sh"
need_root
# Check the audited data identity before creating any M9 state. The full bind
# guard runs after these new sources exist, so no shadow data tree is possible.
. /etc/firecrawl-pi/config.env
[ -d "$PI_DATA_DIR" ] && [ "$(findmnt -n -o UUID --target "$PI_DATA_DIR")" = "$PI_DATA_MOUNT_ID" ] && [ "$(cat "$PI_DATA_DIR/.fcpi-data-id")" = "$PI_DATA_ID" ] || die 'audited data device absent'
D=$STATE/incidents C=$STATE/incidents/control
install -d -m 0751 -o root -g root "$D" "$D/work"
install -d -m 0750 -o root -g 3380 "$C"
install -d -m 0700 -o root -g root "$C/processed" "$C/dismissed"
install -d -m 0750 -o 3382 -g 3380 "$C/grants"
install -d -m 0700 -o 3380 -g 3380 "$C/requests"
install -d -m 0750 -o root -g 3380 "$C/reports"
if [ ! -e /etc/firecrawl-pi/secrets/incident_signing_key ]; then
 t=$(mktemp /etc/firecrawl-pi/secrets/incident-key.XXXXXX)
 openssl genpkey -algorithm ED25519 >"$t"; chown 3382:3380 "$t"; chmod 0600 "$t"
 ln "$t" /etc/firecrawl-pi/secrets/incident_signing_key; rm -f "$t"
fi
openssl pkey -in /etc/firecrawl-pi/secrets/incident_signing_key -pubout >"$C/public-key.pem.new"
chmod 0640 "$C/public-key.pem.new"; chown root:3380 "$C/public-key.pem.new"; mv "$C/public-key.pem.new" "$C/public-key.pem"
if [ ! -e /etc/firecrawl-pi/incidents.env ]; then printf 'FCPI_INCIDENT_ENABLED=false\n' | write_atomic /etc/firecrawl-pi/incidents.env 0600; fi
bash "$REPO/deploy/host/fcpi-data-check.sh"
for u in fcpi-incident.service fcpi-incident.timer; do install -m 0644 "$REPO/deploy/host/$u" "/etc/systemd/system/$u"; done
systemctl daemon-reload
systemctl enable --now fcpi-incident.timer
echo 'incident_units_installed=true automatic_agent_enabled=false'
