#!/usr/bin/env bash
# Redis probes use the operator for INFO. Fixture key reads/writes use the core's
# existing restricted ACL; fcpi_ops deliberately cannot SCAN or change keys.
# Secrets travel on stdin, never argv. Works before and after M8's ACL migration.
set -euo pipefail
S=/etc/firecrawl-pi/secrets
[[ ${1:-} =~ ^[A-Za-z]+$ || ${1:-} = --scan ]] || { echo "Redis command required" >&2; exit 2; }
if [[ $1 = INFO || $1 = info ]] && sudo -n test -r "$S/redis_ops_password"; then
  user=fcpi_ops
  password() { sudo -n cat "$S/redis_ops_password"; printf '\n'; }
else
  user=$(sudo -n sed -nE 's#^redis://([^:@]*):[^@]+@redis:6379$#\1#p' "$S/core_redis_url")
  user=${user:-default}
  [[ $user = default || $user = fcpi_core ]] || { echo "Unexpected Redis user" >&2; exit 2; }
  password() { sudo -n sed -nE 's#^redis://[^:@]*:([^@]+)@redis:6379$#\1#p' "$S/core_redis_url"; printf '\n'; }
fi
container=$(sudo -n docker compose -p fcpi ps -q redis)
[[ -n $container ]] || { echo "Redis container missing" >&2; exit 1; }
password | sudo -n docker exec -i "$container" sh -c \
  'IFS= read -r p; [ -n "$p" ] || exit 2; REDISCLI_AUTH="$p" exec redis-cli -e --no-auth-warning --user "$0" "$@"' "$user" "$@"
