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
  echo "log_lines=$(sudo -n wc -l "$f" | cut -d" " -f1) log_sha256=$(sudo -n sha256sum "$f" | cut -c1-64)"
  for pat in 'firecrawl\.dev' 'firecrawl\.com' 'mendable' 'integrations\.' 'duckduckgo' 'posthog' 'sentry\.io' 'getaddrinfo' 'EAI_AGAIN' 'ENOTFOUND' 'ENETUNREACH'; do
    echo "pattern=$pat count=$(sudo -n grep -ciE "$pat" "$f" || true)"
  done
  # Every Cloud match is classified. Explained: a refusal (CLOUD_DENIED), a line of a job that
  # was refused (its scrapeId or jobId is on a refusal line), or the core's echo of the URL it
  # was asked for ('Scraping URL "…"'). Every name-resolution failure must name a project
  # service (as a broker outage produces). Anything else is printed, cut, as unexplained.
  sudo -n sed -E 's/\x1b\[[0-9;]*m//g' "$f" | awk '
    # The ids a line names, space-separated (no regex intervals: mawk lacks them).
    function ids(s,   out, m) { out = ""; while (match(s, /(scrapeId|jobId)":"[0-9a-f-]+/)) { m = substr(s, RSTART, RLENGTH); sub(/.*":"/, "", m); out = out " " m; s = substr(s, RSTART + RLENGTH) } return out }
    BEGIN { cloud = "firecrawl\\.(dev|com)|mendable"; dns = "getaddrinfo|EAI_AGAIN|ENOTFOUND"
            internal = "\"hostname\":\"(rabbitmq|redis|nuq-postgres|retrieval-service|access-gateway)\"" }
    { line[NR] = $0 }
    /CLOUD_DENIED/ { k = split(ids($0), a, " "); for (j = 1; j <= k; j++) id[a[j]] = 1 }
    END {
      for (i = 1; i <= NR; i++) {
        l = line[i]
        if (tolower(l) ~ cloud) {
          c = "unexplained"
          if (l ~ /CLOUD_DENIED/) c = "refusal"
          else if (l ~ /Scraping URL "/) c = "request_echo"
          else { k = split(ids(l), a, " "); for (j = 1; j <= k; j++) if (a[j] in id) { c = "refused_job"; break } }
          n["cloud_" c]++; if (c == "unexplained") u[++nu] = l
        }
        if (l ~ dns) { c = (l ~ internal) ? "internal" : "unexplained"; n["dns_" c]++; if (c == "unexplained") u[++nu] = l }
      }
      printf "classified cloud_refusal=%d cloud_refused_job=%d cloud_request_echo=%d cloud_unexplained=%d dns_internal=%d dns_unexplained=%d\n",
        n["cloud_refusal"], n["cloud_refused_job"], n["cloud_request_echo"], n["cloud_unexplained"], n["dns_internal"], n["dns_unexplained"]
      for (i = 1; i <= nu; i++) print "unexplained " substr(u[i], 1, 300)
    }'
  # Positive controls: a line every harness start prints, and the instance's newest log line, so
  # a failed or truncated capture cannot pass as "no Cloud lines".
  echo "control=Starting services count=$(sudo -n grep -c 'Starting services' "$f" || true)"
  # The harness prints "<process> YYYY-MM-DD HH:MM:SS <level> …" in UTC, the container's zone.
  echo "newest_line_utc=$(sudo -n tail -n 200 "$f" | sed -E 's/\x1b\[[0-9;]*m//g' | grep -oE '[0-9]{4}-[0-9]{2}-[0-9]{2} [0-9]{2}:[0-9]{2}:[0-9]{2}' | tail -1 | tr ' ' T)Z"
done
echo "### end"
echo end
