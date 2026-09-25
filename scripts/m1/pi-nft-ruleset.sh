#!/usr/bin/env bash
# The stateless nftables ruleset (no counters), with a header naming when and from which
# deployed commit it was read; V04 and V14 read it. Runs ON the Pi:
#   ssh ... 'bash /opt/firecrawl-pi/scripts/m1/pi-nft-ruleset.sh'
set -euo pipefail
export LC_ALL=C
export PATH="/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"
echo "# collected $(date -u +%Y-%m-%dT%H:%M:%SZ) by scripts/m1/pi-nft-ruleset.sh at source commit $(cat /opt/firecrawl-pi/.fcpi-source-commit): nft -s list ruleset"
sudo -n nft -s list ruleset
