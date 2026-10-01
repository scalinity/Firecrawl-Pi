#!/usr/bin/env bash
# Installed by scripts/m8/pi-init-m8.sh as /etc/firecrawl-pi/fcpi-docker-log-repair.sh and run before every dockerd start
# (docker.service.d/40-fcpi-docker-log-repair.conf), while no container has its log open. A power cut leaves NUL blocks
# in the json-file driver's logs (ext4 had grown the file before its data reached the card), and `docker logs` stops at
# the first without an error, showing nothing logged after it for as long as the file is kept. As journald does with a
# journal file it finds damaged after an unclean shutdown, what is readable is kept: each damaged file is rewritten with
# every whole JSON line, byte for byte (a NUL run ends a line, so the line after the damage survives), and nothing else,
# with the file's owner and mode, flushed, then renamed over it; each repair is reported in docker.service's journal.
# Docker serves only this project (CLAUDE.md §33.1). A failure here does not keep dockerd down ("-"): the project's own
# readers read past the damage anyway (scripts/ops/lib.sh container_log).
#   fcpi-docker-log-repair.sh [<docker data root>]     (default: daemon.json's data-root, else /var/lib/docker)
set -uo pipefail
export LC_ALL=C PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
root=${1:-$(jq -r '."data-root" // "/var/lib/docker"' /etc/docker/daemon.json 2>/dev/null || echo /var/lib/docker)}
rm -f -- "$root"/containers/*/*.fcpi-repair.* 2>/dev/null   # what a repair cut short by another power cut left
for f in "$root"/containers/*/*-json.log "$root"/containers/*/*-json.log.[0-9]; do
  [ -f "$f" ] && grep -q -a -P '\x00' "$f" || continue
  t=$(mktemp "$f.fcpi-repair.XXXXXX") || continue
  z=$(tr -cd '\000' <"$f" | wc -c) n=$(tr -s '\000' '\n' <"$f" | grep -c .)
  if tr -s '\000' '\n' <"$f" | jq -rR 'select((fromjson? | objects) != null)' >"$t" \
    && chown --reference="$f" -- "$t" && chmod --reference="$f" -- "$t" && sync -- "$t"; then
    k=$(wc -l <"$t"); mv -f -- "$t" "$f"
    c=${f#"$root"/containers/}; echo "fcpi-docker-log-repair: ${c:0:12} log${f##*-json.log} nul_bytes=$z lines_kept=$k lines_dropped=$((n - k))"
  else
    rm -f -- "$t"; echo "fcpi-docker-log-repair: could not repair $f" >&2
  fi
done
exit 0
