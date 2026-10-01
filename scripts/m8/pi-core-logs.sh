#!/usr/bin/env bash
# M8's copy of scripts/m2/pi-core-logs.sh (M2 review finding R7): every core container instance's whole log is captured
# before the instance is replaced, and scanned for Firecrawl Cloud and direct-egress lines, each with its own positive
# control. Counters cannot see a failed connect on an internal network, so the logs are read.
#   ssh … 'bash /opt/firecrawl-pi/scripts/m8/pi-core-logs.sh <label>'
# M8's changes: a name-resolution failure names a project service in Node's text form too ("Error: getaddrinfo
# EAI_AGAIN redis", "hostname: 'redis'"), as M8's injected broker outages print it, and the bare "syscall:" and "code:"
# lines of that same error object count with the nearest error line above them that names a host, within eight lines; M8 leaves /var/log/firecrawl-pi's own mode
# (0750 root:adm, set by pi-init-m8.sh) as it is.
# The whole log is kept on the Pi (/var/log/firecrawl-pi/core-instances/<id>.log, root 0600); it
# may hold target URLs, so only its line count, hash and scan leave the Pi. Changes nothing else.
set -euo pipefail
export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
label=${1:?usage: pi-core-logs.sh <label>}
DIR=/var/log/firecrawl-pi/core-instances
sudo -n install -d -m 0700 -o root -g root "$DIR"
# Every fcpi core container Docker still knows, running or not: none is replaced unscanned.
ids=$(sudo -n docker ps -aq --no-trunc --filter label=com.docker.compose.project=fcpi --filter label=com.docker.compose.service=firecrawl-core)
printf '### meta\nutc=%s label=%s instances=%s source_commit=%s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$label" "$(printf '%s\n' $ids | grep -c .)" "$(cat /opt/firecrawl-pi/.fcpi-source-commit)"
# The scan of one saved instance log, $1.
scan() {
  local f=$1
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
            svc = "(rabbitmq|redis|nuq-postgres|retrieval-service|access-gateway)"
            internal = "(\"hostname\":\"|hostname: '"'"')" svc "[\"'"'"']|(getaddrinfo|EAI_AGAIN|ENOTFOUND) " svc "$" }
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
        # The nearest error line that names a host decides the bare syscall: and code: lines after it.
        if (l ~ /(getaddrinfo|EAI_AGAIN|ENOTFOUND) [A-Za-z0-9._-]+$/) { last = i; lastint = (l ~ internal) }
        if (l ~ dns) { c = (l ~ internal || (l ~ /^[^A-Za-z]*[^ ]* *(syscall|code): '"'"'(getaddrinfo|EAI_AGAIN|ENOTFOUND)'"'"',?$/ && lastint && i - last <= 8)) ? "internal" : "unexplained"
          n["dns_" c]++; if (c == "unexplained") u[++nu] = l }
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
}
for id in $ids; do
  f=$DIR/$id.log
  # Read past any NUL block a power cut left in docker's own log file, which `docker logs` would stop at (lib.sh).
  sudo -n bash -c '. /opt/firecrawl-pi/scripts/ops/lib.sh; container_log "$1" >"$2.tmp" && chmod 0600 "$2.tmp" && mv -f "$2.tmp" "$2"' _ "$id" "$f"
  printf '### instance_%s\n' "${id:0:12}"
  sudo -n docker inspect -f 'id={{.Id}} image={{.Image}} created={{.Created}} started={{.State.StartedAt}} finished={{.State.FinishedAt}} running={{.State.Running}} restarts={{.RestartCount}} log_driver={{.HostConfig.LogConfig.Type}}' "$id"
  scan "$f"
done
# Every earlier instance whose log was saved here before it was replaced, scanned again with the
# same rules, so each core instance of the milestone has one classified record.
for f in $(sudo -n find "$DIR" -maxdepth 1 -name '*.log' | sort); do
  id=$(basename "$f" .log)
  case " $(echo $ids) " in *" $id "*) continue ;; esac
  printf '### stored_%s\n' "${id:0:12}"
  echo "id=$id saved_utc=$(sudo -n date -u -r "$f" +%Y-%m-%dT%H:%M:%SZ)"
  scan "$f"
done
echo "### end"
echo end
