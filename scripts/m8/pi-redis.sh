#!/usr/bin/env bash
# The core's Redis command set (M1 review finding R11, deferred to M8), ON the Pi, as root:
#   pi-redis.sh stats          INFO commandstats (each command's calls, rejected and failed counts), the ACL users with their
#                              rules (password hashes removed) and the ACL log's denials, one section each
#   pi-redis.sh reset          CONFIG RESETSTAT and ACL LOG RESET, so the next stats cover one measured workload alone
# Redis is asked as the operator's user fcpi_ops once scripts/m8/pi-redis-narrow.sh has made it, before that as the user
# the core's URL names, with the password passed over stdin into the container's own environment for redis-cli (never
# a command line, never printed).
set -euo pipefail
. /opt/firecrawl-pi/scripts/ops/lib.sh
need_root
core_user=$(sed -nE 's#^redis://([^:@]*):.*#\1#p' /etc/firecrawl-pi/secrets/core_redis_url); core_user=${core_user:-default}
if [ -f /etc/firecrawl-pi/secrets/redis_ops_password ]; then user=fcpi_ops; pw() { tr -d '\n' </etc/firecrawl-pi/secrets/redis_ops_password; echo; }
else user=$core_user; pw() { sed -nE 's#^redis://[^:@]*:([^@]*)@.*#\1#p' /etc/firecrawl-pi/secrets/core_redis_url; }; fi
r() { pw | docker exec -i "$(cid redis)" sh -c 'read -r p; REDISCLI_AUTH="$p" exec redis-cli --no-auth-warning --user "$0" "$@"' "$user" "$@"; }
case ${1:-} in
  stats)
    echo "### meta"; echo "utc=$(utc) source_commit=$(source_commit) user=$user core_user=$core_user"
    echo "### commandstats"; r INFO commandstats | tr -d '\r' | grep '^cmdstat_'
    echo "### acl_users"; r ACL LIST | tr -d '\r' | sed -E 's/ #[0-9a-f]{64}/ #<hash>/g; s/ >[^ ]+/ ><password>/g'
    echo "### acl_log"; r ACL LOG 100 | tr -d '\r' | paste -sd' ' - | head -c 4000; echo
    echo "### end" ;;
  reset) r CONFIG RESETSTAT; r ACL LOG RESET ;;
  *) die "usage: pi-redis.sh stats | reset" ;;
esac
