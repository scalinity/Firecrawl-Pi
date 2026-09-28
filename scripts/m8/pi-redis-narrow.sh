#!/usr/bin/env bash
# Narrow the core's Redis credential to the command set M8 measured (M1 review finding R11), ON the Pi, as root,
# idempotent:   ssh … 'sudo -n bash /opt/firecrawl-pi/scripts/m8/pi-redis-narrow.sh'
# The core connected as Redis's `default` user, which may run every command. After this:
#   user default   off
#   user health    PING only, no password (the container's health check)
#   user fcpi_core the same password hash the default user had, keys ~* and channels &*, and only the commands in
#                  deploy/redis/fcpi-core.rules (measured with scripts/m8/pi-redis.sh over every suite and a paced
#                  workload; the verifier's S04 requires no command rejected and no ACL denial across the soak)
#   user fcpi_ops  the operator's reads: INFO, ACL LIST and ACL LOG, CONFIG RESETSTAT and PING, with its own password
#                  (redis_ops_password, root 0600, mounted into no container), for scripts/m8/pi-redis.sh
# and the core's URL names fcpi_core. The secret files are rewritten together, atomically, by sed on the files
# themselves: no password is printed, passed on a command line or held in a variable (the new operator password's
# SHA-256, the value Redis's ACL file holds, is). Then Redis and the core are recreated so both read them.
set -euo pipefail
. /opt/firecrawl-pi/scripts/ops/lib.sh
need_root
S=/etc/firecrawl-pi/secrets ACL=$S/redis_users_acl URL=$S/core_redis_url OPS=$S/redis_ops_password
OPS_RULES='~* -@all +info +acl|list +acl|log +config|resetstat +ping'
# The operator's password, created once (hard link, so an existing file is never replaced).
if [ ! -f "$OPS" ]; then t=$(mktemp "$S/.new.XXXXXX"); chmod 0600 "$t"; head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n' >"$t"; ln "$t" "$OPS" && rm -f "$t"; fi
opsh=$(tr -d '\n' <"$OPS" | sha256sum | cut -c1-64)
RULES=$(grep -Ev '^[[:space:]]*(#|$)' "$REPO/deploy/redis/fcpi-core.rules" | tr '\n' ' ' | sed 's/ *$//')
[[ $RULES =~ ^~\*\ \&\*\ -@all(\ \+[a-z|]+)+$ ]] || die "deploy/redis/fcpi-core.rules must read ~* &* -@all +<command> …"
# The rules as a sed replacement: & (which the channel pattern &* holds), \ and / escaped.
RSED=$(sed 's/[&\\/]/\\&/g' <<<"$RULES")
echo "### meta"; echo "utc=$(utc) source_commit=$(source_commit)"
echo "### narrow"
if grep -q '^user fcpi_core ' "$ACL" && grep -q '^redis://fcpi_core:' "$URL" && grep -q '^user default off' "$ACL"; then
  # Already narrowed: bring the rules to the committed ones, keeping the hash.
  t=$(mktemp "$ACL.XXXXXX"); chmod --reference="$ACL" "$t"; chown --reference="$ACL" "$t"
  { grep -v '^user fcpi_ops ' "$ACL" | sed -E "s/^(user fcpi_core on #[0-9a-f]{64}) .*/\1 $RSED/"; echo "user fcpi_ops on #$opsh $OPS_RULES"; } >"$t" && mv -f "$t" "$ACL"
  echo "already narrowed; rules refreshed"
else
  grep -Eq '^user default on #[0-9a-f]{64} ~\* &\* \+@all$' "$ACL" || die "the ACL file is not the M1 shape this script migrates"
  grep -Eq '^redis://:[^@]+@redis:6379$' "$URL" || die "the core's URL is not the M1 shape this script migrates"
  ta=$(mktemp "$ACL.XXXXXX"); chmod --reference="$ACL" "$ta"; chown --reference="$ACL" "$ta"
  tu=$(mktemp "$URL.XXXXXX"); chmod --reference="$URL" "$tu"; chown --reference="$URL" "$tu"
  { echo "user default off"; grep '^user health ' "$ACL"; sed -En "s/^user default on (#[0-9a-f]{64}) .*/user fcpi_core on \1 $RSED/p" "$ACL"; echo "user fcpi_ops on #$opsh $OPS_RULES"; } >"$ta"
  sed -E 's#^redis://:#redis://fcpi_core:#' "$URL" >"$tu"
  [ "$(grep -c '^user ' "$ta")" = 4 ] && grep -q '^redis://fcpi_core:' "$tu" || { rm -f "$ta" "$tu"; die "the rewritten files are not complete"; }
  mv -f "$ta" "$ACL" && mv -f "$tu" "$URL"
  echo "narrowed: default off, fcpi_core with $(wc -w <<<"$RULES") rule words"
fi
sed -E 's/#[0-9a-f]{64}/#<hash>/' "$ACL"
echo "### recreate"
docker compose -p fcpi -f "$REPO/deploy/compose.yaml" up -d --wait --wait-timeout 600 --force-recreate redis firecrawl-core 2>&1 | tail -3
echo "### end"
