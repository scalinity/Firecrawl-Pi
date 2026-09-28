#!/usr/bin/env bash
# fcpi doctor (FIRECRAWL_PI_SPEC.md §25), as root ON the Pi: a bounded diagnostic bundle with enforced redaction, written
# to /var/lib/firecrawl-pi/doctor/fcpi-doctor-<UTC>.tar.gz (0600; the newest five are kept). It holds fcpi status, the
# last hour of host samples and the day's probes, incidents and recent notices, supervisor restarts, the newest boot
# records, each project container's state, limits and health log (never its environment), the last 300 lines of each
# project container's log after redaction, the rendered Compose file, the project units' journal, and host facts.
# Redaction is enforced, not trusted: log lines lose Authorization and Cookie values, bearer tokens, credentials in
# URLs, query strings, key=value secrets and the tailnet's names and addresses (the Serve origin the gateway logs at start is
# kept in the secrets directory, out of the repository); then every file is searched for every value in the secrets directory
# (each client token included), and any hit discards the bundle and fails the command. The bundle stops at 5 MiB.
#   fcpi doctor [--self-test]   --self-test plants real secret values in the bundle, which the check must all find and refuse
set -uo pipefail
. "$(dirname "$(readlink -f "$0")")/lib.sh"
need_root
OUTD=$STATE/doctor; mkdir -p "$OUTD"; chmod 0700 "$OUTD"
W=$(mktemp -d "$RUND/doctor.XXXXXX"); chmod 0700 "$W"
trap 'rm -rf "$W"' EXIT
B=$W/fcpi-doctor-$(date -u +%Y%m%dT%H%M%SZ); mkdir "$B"
red() { sed -E 's/(authorization|cookie|set-cookie|x-api-key|proxy-authorization)(["'"'"']?[:=] *["'"'"']?)[^"'"'"',}]*/\1\2<redacted>/Ig;
  s/Bearer [A-Za-z0-9._~+\/=-]+/Bearer <redacted>/g; s#([a-z][a-z0-9+.-]*://)[^/@ "]+@#\1<redacted>@#Ig; s#(https?://[^ "?]+)\?[^ "]*#\1?<redacted>#g;
  s/\b(password|passwd|secret|token|api[_-]?key)(["'"'"']?[:=] *["'"'"']?)[A-Za-z0-9+\/_.=-]{6,}/\1\2<redacted>/Ig; s/\bfcpi_[a-z0-9]+_[0-9a-f]{32,}\b/<client-token>/g;
  s/\b[a-z0-9-]+\.[a-z0-9-]+\.ts\.net\b/<tailnet-name>/Ig; s/\b100\.(6[4-9]|[7-9][0-9]|1[01][0-9]|12[0-7])\.[0-9]{1,3}\.[0-9]{1,3}\b/<tailnet-address>/g' | cut -c1-2000; }

bash "$(dirname "$(readlink -f "$0")")/status.sh" --json >"$B/status.json" 2>&1
tail -n 60 "$LOGD/samples/$(date -u +%F).jsonl" >"$B/samples-last-hour.jsonl" 2>/dev/null
cp "$LOGD/probe/$(date -u +%F).jsonl" "$B/probes-today.jsonl" 2>/dev/null
cp "$STATE/alerts/state.json" "$B/incidents.json" 2>/dev/null
ls -1t "$STATE"/alerts/outbox/*.json 2>/dev/null | head -20 | xargs -r cat >"$B/notices-recent.jsonl"
cp "$STATE/supervisor/restarts.jsonl" "$B/supervisor-restarts.jsonl" 2>/dev/null
mkdir "$B/boots"; ls -1t "$STATE"/boots/*.txt 2>/dev/null | head -3 | xargs -r -I{} cp {} "$B/boots/"
ls -1 "$STATE"/boots/ >"$B/boots/index.txt" 2>/dev/null
mkdir "$B/containers"
for c in $(docker ps -aq --filter label=com.docker.compose.project=fcpi); do
  s=$(docker inspect -f '{{index .Config.Labels "com.docker.compose.service"}}' "$c")
  docker inspect "$c" | jq '.[0] | {Name, Image, Created, State: (.State | del(.Health.Log) + {HealthLog: (.Health.Log // [] | map({Start, End, ExitCode, Output: (.Output | .[0:300])}))}),
    RestartCount, HostConfig: (.HostConfig | {Memory, MemorySwap, NanoCpus, PidsLimit, CgroupParent, ReadonlyRootfs, CapDrop, CapAdd, SecurityOpt, RestartPolicy}),
    Mounts: [.Mounts[] | {Type, Source, Destination, RW}], Networks: (.NetworkSettings.Networks | keys)}' >"$B/containers/$s.json"
  docker logs --tail 300 "$c" 2>&1 | red >"$B/containers/$s.log"
done
docker compose -p fcpi -f "$REPO/deploy/compose.yaml" config >"$B/compose-rendered.yaml" 2>&1
journalctl --no-pager --utc -o short-iso -n 300 -u fcpi-stack.service -u fcpi-tick.service -u fcpi-probe.service -u fcpi-boot-record.service \
  -u fcpi-backup.service -u fcpi-restore-test.service -u docker.service -t fcpi-alert -t fcpi-supervisor 2>/dev/null | red >"$B/journal-project-units.txt"
{ echo "utc=$(utc) commit=$(source_commit) boot=$(boot_hash) kernel=$(uname -r)"; free -m; df -h / "$REPO" /srv/firecrawl-pi 2>/dev/null
  vcgencmd get_throttled 2>/dev/null; vcgencmd measure_temp 2>/dev/null; cat /sys/fs/cgroup/fcpi.slice/memory.swap.max 2>/dev/null | sed 's/^/fcpi.slice memory.swap.max=/'
  systemctl list-timers 'fcpi-*' --no-pager 2>/dev/null; sha256sum "$REPO/deploy/versions.lock.json"; } >"$B/host.txt" 2>&1

# The self-test: real secret values, each in its own file as a log line would carry it, which the check below must all
# find: a client token, a value from a file with no final newline (most secrets are written with printf '%s'), and,
# when a provider file holds a user:password pair, its password half alone.
planted=0
if [ "${1:-}" = --self-test ]; then
  tokf=$(find /etc/firecrawl-pi/secrets/clients -name '*.token' | head -1)
  nlf=$(find /etc/firecrawl-pi/secrets -type f -size -8k ! -path '*/clients/*' | sort | while read -r f; do
    [ "$(wc -l <"$f")" = 0 ] && [ "$(wc -c <"$f")" -ge 12 ] && { echo "$f"; break; }; done)
  for f in "$tokf" "$nlf"; do [ -n "$f" ] || continue; awk 1 "$f" | sed 's/^/leaked /' >"$B/containers/self-test-$planted.log"; planted=$((planted + 1)); done
  pairf=$(grep -l : /etc/firecrawl-pi/secrets/providers/* 2>/dev/null | head -1)
  if [ -n "$pairf" ]; then awk 1 "$pairf" | grep -v '://' | grep -m1 : | sed -E 's/^[^:]*:/leaked /' >"$B/containers/self-test-$planted.log"; planted=$((planted + 1)); fi
fi
# Enforced redaction: every secret value, searched for literally in every file. awk 1 ends each file's last line, so a
# value written without a final newline is never joined to the next file's first line.
pat=$(mktemp "$W/pat.XXXXXX"); chmod 0600 "$pat"
find /etc/firecrawl-pi/secrets -type f -size -8k -print0 | xargs -0 -r awk 1 | awk 'length($0) >= 12' | sort -u >"$pat"
# Values that are only part of a line are searched for by their secret part too: the password of a URL, the password
# half of a user:password line, the value of a key = value line (RabbitMQ's default_pass), and the Basic (base64) form
# of each user:password pair, as a proxy's Proxy-Authorization carries it.
px=$(mktemp "$W/pat.XXXXXX"); chmod 0600 "$px"
{ grep -Eo '://[^:/@]*:[^@]+@' "$pat" | sed -E 's#^://[^:]*:##; s#@$##'
  grep -v '://' "$pat" | grep : | sed -E 's/^[^:]*://'
  grep -E '^[^=]+=' "$pat" | sed -E 's/^[^=]*=[[:space:]]*//; s/[[:space:]]+$//'
  grep -v '://' "$pat" | grep : | while IFS= read -r l; do printf '%s' "$l" | base64 -w0; echo; done
} | awk 'length($0) >= 8' >"$px"
cat "$px" >>"$pat"; rm -f "$px"
hits=$(grep -rlF -f "$pat" "$B" 2>/dev/null | wc -l); npat=$(wc -l <"$pat")
found=0; [ "$planted" -gt 0 ] && found=$(grep -lF -f "$pat" "$B"/containers/self-test-*.log 2>/dev/null | wc -l)
rm -f "$pat"
st=""; [ "$planted" -gt 0 ] && st="; self-test planted $planted, found $found"
if [ "$hits" != 0 ] || [ "$npat" -lt 5 ]; then echo "fcpi doctor: redaction check failed ($hits files carry a secret, $npat values checked$st); no bundle kept" >&2; exit 1; fi
# The bound: logs are cut first, the largest first, until the bundle fits.
while [ "$(du -sb "$B" | cut -f1)" -gt 5242880 ]; do f=$(ls -S "$B"/containers/*.log 2>/dev/null | head -1); [ -n "$f" ] || break; tail -n 50 "$f" >"$f.t" && mv "$f.t" "$f.cut"; rm -f "$f"; done
echo "secret values checked: $npat; files carrying one: 0" >"$B/REDACTION.txt"
tar -C "$W" -czf "$OUTD/$(basename "$B").tar.gz" "$(basename "$B")" && chmod 0600 "$OUTD/$(basename "$B").tar.gz"
ls -1t "$OUTD"/*.tar.gz | tail -n +6 | xargs -r rm -f
echo "$OUTD/$(basename "$B").tar.gz $(stat -c %s "$OUTD/$(basename "$B").tar.gz") bytes; $npat secret values checked, 0 found"
