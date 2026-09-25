#!/bin/sh
# Fail-closed data check (evidence/M0/INTERPRETATION.md §2), run by fcpi-data-check.service
# before every start of fcpi-stack.service. Read-only: it writes nothing anywhere.
# Exits non-zero, and so blocks the stack, unless all three hold:
#   1. the filesystem holding PI_DATA_DIR has UUID PI_DATA_MOUNT_ID;
#   2. PI_DATA_DIR/.fcpi-data-id equals PI_DATA_ID;
#   3. every bind mount in the rendered Compose file sets create_host_path: false,
#      and every bind source already exists.
# PI_CONFIG_FILE overrides the config path, so the failure branches can be tested.
set -eu
export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
CONFIG=${PI_CONFIG_FILE:-/etc/firecrawl-pi/config.env}
fail() { echo "fcpi-data-check: FAIL: $*" >&2; exit 1; }

[ -r "$CONFIG" ] || fail "config $CONFIG unreadable"
# shellcheck disable=SC1090
. "$CONFIG"
: "${PI_DATA_MOUNT_ID:?}" "${PI_DATA_DIR:?}" "${PI_DATA_ID:?}" "${PI_COMPOSE_FILE:?}"

[ -d "$PI_DATA_DIR" ] || fail "data directory $PI_DATA_DIR is absent"
uuid=$(findmnt -n -o UUID --target "$PI_DATA_DIR") || fail "findmnt failed for $PI_DATA_DIR"
[ "$uuid" = "$PI_DATA_MOUNT_ID" ] || fail "filesystem UUID of $PI_DATA_DIR is '$uuid', expected '$PI_DATA_MOUNT_ID'"
[ -f "$PI_DATA_DIR/.fcpi-data-id" ] || fail "$PI_DATA_DIR/.fcpi-data-id is absent"
[ "$(cat "$PI_DATA_DIR/.fcpi-data-id")" = "$PI_DATA_ID" ] || fail "data ID in $PI_DATA_DIR/.fcpi-data-id does not match PI_DATA_ID"

rendered=$(docker compose -f "$PI_COMPOSE_FILE" config --format json) || fail "cannot render $PI_COMPOSE_FILE"
# tostring, not `// true`: jq's // treats an explicit false as missing.
binds=$(printf '%s' "$rendered" | jq -r '.services[] | .volumes[]? | select(.type == "bind") | "\(.bind.create_host_path | tostring) \(.source)"')
[ -n "$binds" ] || fail "no bind mounts rendered from $PI_COMPOSE_FILE"
n=0
while read -r create src; do
  [ "$create" = false ] || fail "bind $src does not set create_host_path: false"
  [ -e "$src" ] || fail "bind source $src is absent"
  n=$((n + 1))
done <<EOF
$binds
EOF
echo "fcpi-data-check: OK uuid=$uuid data_id=match binds=$n create_host_path=false"
