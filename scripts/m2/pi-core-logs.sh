#!/usr/bin/env bash
# Review finding R7: every core container instance's whole log is captured before the instance is
# replaced, and scanned for Firecrawl Cloud and direct-egress lines, each with its own positive
# control. Counters cannot see a failed connect on an internal network, so the logs are read.
#   ssh … 'bash /opt/firecrawl-pi/scripts/m2/pi-core-logs.sh <label>'
# The whole log is kept on the Pi (/var/log/firecrawl-pi/core-instances/<id>.log, root 0600); it
# may hold target URLs, so only its line count, hash and scan leave the Pi. Changes nothing else.
set -euo pipefail
export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
label=${1:?usage: pi-core-logs.sh <label>}
DIR=/var/log/firecrawl-pi/core-instances
sudo -n install -d -m 0700 -o root -g root /var/log/firecrawl-pi "$DIR"
# Every fcpi core container Docker still knows, running or not: none is replaced unscanned.
ids=$(sudo -n docker ps -aq --no-trunc --filter label=com.docker.compose.project=fcpi --filter label=com.docker.compose.service=firecrawl-core)
printf '### meta\nutc=%s label=%s instances=%s source_commit=%s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$label" "$(printf '%s\n' $ids | grep -c .)" "$(cat /opt/firecrawl-pi/.fcpi-source-commit)"
for id in $ids; do
  f=$DIR/$id.log
  sudo -n sh -c "docker logs '$id' >'$f.tmp' 2>&1 && chmod 0600 '$f.tmp' && mv -f '$f.tmp' '$f'"
  printf '### instance_%s\n' "${id:0:12}"
  sudo -n docker inspect -f 'id={{.Id}} image={{.Image}} created={{.Created}} started={{.State.StartedAt}} finished={{.State.FinishedAt}} running={{.State.Running}} restarts={{.RestartCount}} log_driver={{.HostConfig.LogConfig.Type}}' "$id"
  echo "log_lines=$(sudo -n wc -l <"$f") log_sha256=$(sudo -n sha256sum "$f" | cut -c1-64)"
  for pat in 'firecrawl\.dev' 'firecrawl\.com' 'mendable' 'integrations\.' 'duckduckgo' 'posthog' 'sentry\.io' 'getaddrinfo' 'EAI_AGAIN' 'ENOTFOUND' 'ENETUNREACH'; do
    echo "pattern=$pat count=$(sudo -n grep -ciE "$pat" "$f" || true)"
  done
  # Positive controls: a line every harness start prints, and the instance's newest log line, so
  # a failed or truncated capture cannot pass as "no Cloud lines".
  echo "control=Starting services count=$(sudo -n grep -c 'Starting services' "$f" || true)"
  echo "newest_line_utc=$(sudo -n tail -n 200 "$f" | grep -oE '"(timestamp|utc)":"[0-9T:.-]+Z"' | tail -1 | cut -d'"' -f4)"
done
echo "### end"
echo end
