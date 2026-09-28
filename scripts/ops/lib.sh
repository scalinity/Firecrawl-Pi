# shellcheck shell=bash
# Shared by the host operations command (scripts/fcpi) and its timers (deploy/host/fcpi-*.service), ON the Pi.
# Sourced, never run. Everything here acts on Compose project fcpi or the project's own paths:
#   /var/lib/firecrawl-pi   durable operations state (boot records, incidents, restarts, backups, releases)
#   /var/log/firecrawl-pi   metadata logs: one host sample a minute, functional probes (14 days), daily aggregates (90)
#   /run/firecrawl-pi       what the services read: the admission state (tmpfs, created at boot by systemd-tmpfiles)
# The gateway is reached as agents reach it, on its loopback publication, with the operator's client token read into
# memory and handed to curl through a file descriptor, never on a command line.
export LC_ALL=C
export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
REPO=${FCPI_REPO:-/opt/firecrawl-pi}
STATE=/var/lib/firecrawl-pi
LOGD=/var/log/firecrawl-pi
RUND=/run/firecrawl-pi
ADMISSION=$RUND/admission/admission.json
HOLDS=$RUND/holds
OPS_TOKEN=/etc/firecrawl-pi/secrets/clients/ops.token
GW=http://127.0.0.1:3380
MODERN=2026-07-28
# The services the supervisor may restart when Docker marks them unhealthy. The data services are never restarted by
# it (spec §24.1): their own restart policy revives a crash, and a health failure opens an incident instead.
SAFE_SERVICES="access-gateway mcp-gateway retrieval-service browser-worker searxng firecrawl-core fixture fixture-m2 fixture-m3 fixture-m5 fixture-m6 fixture-m7"
DATA_SERVICES="nuq-postgres redis rabbitmq"

utc() { date -u +%Y-%m-%dT%H:%M:%SZ; }
now_s() { date +%s; }
boot_hash() { sha256sum </proc/sys/kernel/random/boot_id | cut -c1-64; }
source_commit() { cat "$REPO/.fcpi-source-commit" 2>/dev/null || echo unknown; }
die() { echo "fcpi: $*" >&2; exit 2; }
need_root() { [ "$(id -u)" = 0 ] || die "this command needs root (run it with sudo)"; }

# write_atomic <path> <mode>: stdin to a new file renamed over <path>, so a reader sees the old file or the new one.
write_atomic() {
  local t
  t=$(mktemp "$1.XXXXXX") || return 1
  if cat >"$t" && chmod "$2" "$t" && mv -f "$t" "$1"; then return 0; fi
  rm -f "$t"; return 1
}
# append_line <path> <line>: one JSON line, the file created 0640.
append_line() { [ -e "$1" ] || install -m 0640 /dev/null "$1"; printf '%s\n' "$2" >>"$1"; }

# The container of a Compose service of project fcpi (running or not), by label, resolved at each call: an ID resolved
# before `docker compose up` can be stale after it (CLAUDE.md §33.6).
cid() { docker ps -aq --filter label=com.docker.compose.project=fcpi --filter "label=com.docker.compose.service=$1" | head -1; }

# restic with the repository's backend credentials (the file FCPI_RESTIC_ENV_FILE names, when backup.env names one) in
# its own environment only: docker, curl and jq, which the backup and restore scripts also run, never see them. exec
# runs the binary, not this function.
restic() { ( if [ -n "${FCPI_RESTIC_ENV_FILE-}" ]; then set -a; . "$FCPI_RESTIC_ENV_FILE"; set +a; fi; exec restic "$@" ); }

# repo_lock: the one lock the backup, the repository check and the restore test share (one restic repository, one data
# filesystem), on descriptor 8, waited for up to FCPI_LOCK_WAIT_S seconds (default three hours; each unit's start timeout
# is its own run's bound plus that wait):
# persistent timers that fire together after downtime then run one after another instead of the later ones giving up.
repo_lock() { exec 8>"$RUND/backup.lock"; flock -w "${FCPI_LOCK_WAIT_S:-10800}" 8; }

# pg <sql>: a read-only query as the superuser over the database container's local socket (psql -At, | separated).
pg() {
  local c; c=$(cid nuq-postgres); [ -n "$c" ] || return 1
  timeout 20 docker exec -i -e PGOPTIONS='-c default_transaction_read_only=on -c statement_timeout=10000' "$c" \
    psql -X -q -At -F '|' -U postgres -d postgres -v ON_ERROR_STOP=1 -c "$1" 2>/dev/null
}

# gw <METHOD> <path> [json body]: sets GW_STATUS (000 when nothing answered), GW_BODY and GW_MS.
gw() {
  local method=$1 path=$2 body=${3-} tok out t0
  GW_STATUS=000 GW_BODY="" GW_MS=0
  tok=$(cat "$OPS_TOKEN" 2>/dev/null) || { GW_BODY='{"error":"no operator token"}'; return 1; }
  out=$(mktemp) || return 1
  local args=(-sS -m "${GW_TIMEOUT:-20}" -o "$out" -w '%{http_code}' -X "$method" -H 'Accept: application/json, text/event-stream')
  [ -n "$body" ] && args+=(-H 'Content-Type: application/json' --data-binary "$body")
  [ -n "${GW_EXTRA_HEADERS-}" ] && while IFS= read -r h; do [ -n "$h" ] && args+=(-H "$h"); done <<<"$GW_EXTRA_HEADERS"
  t0=$(date +%s%N)
  # The token reaches curl through a descriptor opened on curl's own command line: a process substitution inside an
  # assignment is closed when the assignment ends.
  GW_STATUS=$(curl "${args[@]}" -H @<(printf 'Authorization: Bearer %s\n' "$tok") "$GW$path" 2>/dev/null) || GW_STATUS=${GW_STATUS:-000}
  GW_MS=$(( ($(date +%s%N) - t0) / 1000000 ))
  GW_BODY=$(cat "$out"); rm -f "$out"
  [ "${#GW_STATUS}" = 3 ] || GW_STATUS=000
  return 0
}
# mcp <method> <params json>: one modern (2026-07-28) request to /mcp; GW_BODY is the JSON-RPC answer (the last SSE
# data line when the service streams).
mcp() {
  local method=$1 params=$2 name body
  name=$(jq -r '.name // empty' <<<"$params")
  body=$(jq -cn --arg m "$method" --argjson p "$params" --arg v "$MODERN" \
    '{jsonrpc:"2.0",id:1,method:$m,params:($p + {_meta:{"io.modelcontextprotocol/protocolVersion":$v,"io.modelcontextprotocol/clientCapabilities":{},"io.modelcontextprotocol/clientInfo":{name:"fcpi",version:"1"}}})}')
  GW_EXTRA_HEADERS=$(printf 'MCP-Protocol-Version: %s\nMcp-Method: %s\n%s' "$MODERN" "$method" "${name:+Mcp-Name: $name}") gw POST /mcp "$body"
  if [[ $GW_BODY == *"data: "* ]]; then GW_BODY=$(grep '^data: ' <<<"$GW_BODY" | tail -1 | cut -c7-); fi
}

# obj <file>: the file's JSON object, or {} when it is absent, empty, unreadable or not an object. A state file is read
# through this, so one bad write can never wedge every later run.
obj() { local v; v=$(jq -ce 'if type == "object" then . else error("not an object") end' "$1" 2>/dev/null) && [ -n "$v" ] && printf '%s\n' "$v" || echo '{}'; }
# put_obj <file> <mode> <json>: writes the value only if it is a JSON object; otherwise logs and keeps the old file.
put_obj() {
  if [ -n "$3" ] && jq -e 'type == "object"' >/dev/null 2>&1 <<<"$3"; then printf '%s\n' "$3" | write_atomic "$1" "$2"
  else logger -t fcpi-tick -p user.err -- "not written: $1 (the computed state was not a JSON object)"; return 1; fi
}

# ---- admission (spec §23.1) ------------------------------------------------------------------------------------------
# The services read $ADMISSION (a tmpfs file, mounted read-only into the gateway and the retrieval service):
#   dispatch paused: the gateway refuses new work with 503 HOST_PRESSURE and a Retry-After (never 502);
#   browser paused:  the retrieval service refuses the browser tier (RESOURCE_BUSY) and ordinary HTTP goes on.
# The tick's pressure state ($RUND/pressure.json) and any hold ($HOLDS/<name>, holding its expiry in epoch seconds)
# decide it. A hold past its expiry is removed, so a backup that died cannot pause the platform for good. The file
# carries its time: a service ignores one older than three minutes (a stopped tick must not pause the platform).
# Writers take $RUND/admission.lock, so a tick that listed the holds just before a backup took one cannot write its
# older view over the backup's (reopening dispatch while the backup drains), nor re-apply a hold just cleared.
admission_write() {
  ( flock -w 20 7 || logger -t fcpi-tick -p user.warning -- "admission written without its lock (held past 20 s)"
    admission_write_locked ) 7>"$RUND/admission.lock"
}
admission_write_locked() {
  local p holds=() h exp
  p=$(obj "$RUND/pressure.json")
  mkdir -p "$HOLDS"
  for h in "$HOLDS"/*; do
    [ -f "$h" ] || continue
    exp=$(cat "$h" 2>/dev/null); [[ $exp =~ ^[0-9]+$ ]] || exp=0
    if [ "$exp" -le "$(now_s)" ]; then rm -f "$h"; continue; fi
    holds+=("$(basename "$h")")
  done
  jq -cn --arg utc "$(utc)" --argjson p "$p" --args '$ARGS.positional as $holds
    | ($p.dispatch_reasons // []) as $dr | ($p.browser_reasons // []) as $br
    | { utc: $utc,
        dispatch: (if ($dr | length) > 0 or ($holds | length) > 0 then "paused" else "open" end),
        browser: (if ($dr | length) > 0 or ($br | length) > 0 or ($holds | length) > 0 then "paused" else "open" end),
        reasons: ($dr + $br + ($holds | map("hold:" + .))) }' "${holds[@]}" \
    | write_atomic "$ADMISSION" 0644
}
# holds_live: the names of the holds in force now, one a line (an expired hold is not one, removed or not).
holds_live() { local h exp; for h in "$HOLDS"/*; do [ -f "$h" ] || continue; exp=$(cat "$h" 2>/dev/null); [[ $exp =~ ^[0-9]+$ ]] && [ "$exp" -gt "$(now_s)" ] && basename "$h"; done; return 0; }
# hold_set <name> <seconds> / hold_clear <name>: a pause taken by a command (backup, restore, operator), applied at once.
hold_set() { mkdir -p "$HOLDS"; echo $(( $(now_s) + $2 )) | write_atomic "$HOLDS/$1" 0644; admission_write; }
hold_clear() { rm -f "$HOLDS/$1"; admission_write; }

# ---- incidents and notices (spec §25) ---------------------------------------------------------------------------------
# One notice when an incident opens and one when it clears, kept across reboots in $STATE/alerts/state.json. Each notice
# goes to the journal (tag fcpi-alert), to $STATE/alerts/outbox/, and, when /etc/firecrawl-pi/alerts.env names a
# command (FCPI_ALERT_COMMAND), to that command on stdin within 20 s. A failed delivery is recorded and retried on the
# next tick, at most five times; it never blocks the tick or any service.
notice() { # notice <kind: opened|cleared> <key> <detail json>
  local kind=$1 key=$2 detail=$3 n id
  id="$(date -u +%Y%m%dT%H%M%SZ)-$kind-$(printf '%s' "$key" | tr -c 'A-Za-z0-9_.-' '_')"
  n=$(jq -cn --arg utc "$(utc)" --arg kind "$kind" --arg key "$key" --arg id "$id" --argjson d "$detail" --arg boot "$(boot_hash)" \
    '{utc:$utc,id:$id,kind:$kind,incident:$key,detail:$d,boot:$boot,delivered:false,attempts:0}')
  mkdir -p "$STATE/alerts/outbox"; chmod 0700 "$STATE/alerts"
  printf '%s\n' "$n" | write_atomic "$STATE/alerts/outbox/$id.json" 0600
  logger -t fcpi-alert -p "user.$([ "$kind" = opened ] && echo warning || echo notice)" -- "$n"
}
# At most three deliveries and 30 s a tick, oldest first: with the channel down, a backlog of pending notices would
# otherwise spend 20 s each and run the tick past its unit's start timeout, every minute.
deliver_notices() {
  local f cmd="" n t0 tries=0 since
  [ -r /etc/firecrawl-pi/alerts.env ] && cmd=$(sed -n 's/^FCPI_ALERT_COMMAND=//p' /etc/firecrawl-pi/alerts.env | tail -1)
  # The value as an env file writes it: one pair of surrounding quotes is not part of the command.
  case $cmd in \"*\") cmd=${cmd#\"}; cmd=${cmd%\"} ;; \'*\') cmd=${cmd#\'}; cmd=${cmd%\'} ;; esac
  [ -n "$cmd" ] || return 0
  # Only notices raised since the channel was configured (alerts.env's time): a channel set up later is not sent the
  # whole 90-day outbox at once; older notices stay in the outbox and the journal.
  since=$(stat -c %Y /etc/firecrawl-pi/alerts.env)
  t0=$(now_s)
  for f in "$STATE"/alerts/outbox/*.json; do
    [ -f "$f" ] || continue
    n=$(cat "$f")
    [ "$(jq -r --argjson s "$since" '.delivered == false and .attempts < 5 and (.utc | fromdateiso8601) >= $s' <<<"$n" 2>/dev/null)" = true ] || continue
    [ "$tries" -lt 3 ] && [ $(( $(now_s) - t0 )) -lt 30 ] || break
    tries=$((tries + 1))
    if printf '%s\n' "$n" | timeout 20 sh -c "$cmd" >/dev/null 2>&1; then
      jq -c --arg t "$(utc)" '.delivered=true | .delivered_at=$t | .attempts+=1' <<<"$n" | write_atomic "$f" 0600
    else
      jq -c --arg t "$(utc)" '.attempts+=1 | .last_failure=$t' <<<"$n" | write_atomic "$f" 0600
    fi
  done
}
