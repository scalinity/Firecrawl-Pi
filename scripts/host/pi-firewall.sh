#!/usr/bin/env bash
# Pi-side collector: the firewall's fingerprint, computed on the Pi from the deployed scripts/host/firewall-fingerprint.py, so
# a verifier with SSH access can recompute it and no ruleset text (which holds the LAN addresses) leaves the Pi. Changes nothing.
#   ssh <pi> 'bash -s' < scripts/host/pi-firewall.sh
# Prints the raw hash a host snapshot records, the canonical hash that ignores the order of Docker's equivalent drop rules, the
# chains that were sorted, and the project's own inet fcpi_guard table hash (see the script for exactly what is sorted).
set -uo pipefail
export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
REPO=/opt/firecrawl-pi
echo "### meta"
echo "utc=$(date -u +%Y-%m-%dT%H:%M:%SZ) source_commit=$(cat $REPO/.fcpi-source-commit 2>/dev/null || echo unknown)"
echo "### firewall_fingerprint"
sudo -n nft -s list ruleset </dev/null 2>/dev/null | python3 -I "$REPO/scripts/host/firewall-fingerprint.py"
echo "fingerprint_exit=${PIPESTATUS[1]}"
echo "### end"
