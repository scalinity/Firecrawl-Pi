#!/usr/bin/env bash
# Narrow the core's data-service credentials on an install that predates the core role
# (evidence/M1/review/REVIEW.md, R11). Runs ON the Pi against the running stack:
#   ssh ... 'bash /opt/firecrawl-pi/scripts/m1/pi-narrow-credentials.sh'
#   - PostgreSQL: the core stops using the superuser. Role fcpi_core may read and write
#     NuQ's tables and nothing more (deploy/nuq-postgres/fcpi-core-role.psql), with a new
#     password, so the core no longer holds the superuser's: core_postgres_password is
#     replaced, and its twin postgres_core_role_password is created for the initdb script.
#     The superuser loses its network password.
#   - RabbitMQ: user fcpi keeps its AMQP permissions and loses the administrator tag.
#   - Redis is unchanged: narrowing it needs a measured command set (M8).
# Then it applies the Compose change that switches the core to fcpi_core, after the data
# check passes. Idempotent. Prints names and states only; no secret value is printed or
# passed on a command line (psql reads the password from stdin).
set -euo pipefail
export LC_ALL=C
export PATH="/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"
umask 077
REPO=/opt/firecrawl-pi
S=/etc/firecrawl-pi/secrets
COMPOSE=(sudo -n docker compose -p fcpi -f $REPO/deploy/compose.yaml)

sec() { printf '### %s\n' "$1"; }
die() { echo "pi-narrow-credentials: STOP: $*" >&2; exit 1; }
gen_hex() { head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n'; }
exists() { sudo -n test -e "$1"; }
name() { sudo -n docker ps -q --filter label=com.docker.compose.project=fcpi --filter "label=com.docker.compose.service=$1"; }
TMPS=()
trap 'for t in "${TMPS[@]}"; do sudo -n rm -f -- "$t"; done' EXIT
# fill <tmp> <owner> <mode>: write stdin to a temp file created beside its target.
fill() { sudo -n tee "$1" >/dev/null && sudo -n chown "$2" "$1" && sudo -n chmod "$3" "$1"; }

sec meta
date -u +%Y-%m-%dT%H:%M:%SZ
echo "source_commit=$(cat $REPO/.fcpi-source-commit)"
PG=$(name nuq-postgres); RMQ=$(name rabbitmq)
[ -n "$PG" ] && [ -n "$RMQ" ] || die "nuq-postgres and rabbitmq must be running"

sec secrets
if exists $S/core_postgres_password && exists $S/postgres_core_role_password; then
  # A run interrupted between the link and the rename leaves two different values; that
  # is stopped, not repaired.
  sudo -n cmp -s $S/core_postgres_password $S/postgres_core_role_password || die "core_postgres_password and postgres_core_role_password differ (an interrupted run?)"
  echo "kept    $S/core_postgres_password and $S/postgres_core_role_password"
elif exists $S/core_postgres_password && ! exists $S/postgres_core_role_password; then
  # The pre-role state: the core's file holds the superuser's password. Anything else is
  # an unknown state and is not "repaired".
  sudo -n cmp -s $S/core_postgres_password $S/postgres_password || die "core_postgres_password differs from postgres_password, but postgres_core_role_password is absent"
  twin=$(sudo -n mktemp $S/.fcpi-tmp.XXXXXX); TMPS+=("$twin")
  core=$(sudo -n mktemp $S/.fcpi-tmp.XXXXXX); TMPS+=("$core")
  pw=$(gen_hex)
  printf '%s' "$pw" | fill "$twin" 5432:5432 0600
  printf '%s' "$pw" | fill "$core" 0:0 0600
  unset pw
  # The twin is hard-linked first, which refuses an existing target; the core's file is
  # then replaced by an atomic rename. The running core keeps its old environment until
  # the Compose change below recreates it.
  sudo -n ln -- "$twin" $S/postgres_core_role_password && echo "created $S/postgres_core_role_password"
  sudo -n mv -f -- "$core" $S/core_postgres_password && echo "replaced $S/core_postgres_password (new value, for fcpi_core)"
else
  die "postgres_core_role_password exists without core_postgres_password"
fi
echo "core_equals_superuser=$(sudo -n cmp -s $S/core_postgres_password $S/postgres_password && echo yes || echo no)"
echo "core_role_pair_equal=$(sudo -n cmp -s $S/core_postgres_password $S/postgres_core_role_password && echo yes || echo no)"

sec postgres_role
# Read into a variable first: a failed read inside printf's arguments would go unnoticed
# and set an empty password.
pw=$(sudo -n cat $S/postgres_core_role_password)
[ -n "$pw" ] || die "postgres_core_role_password is empty"
{ printf "\\\\set pw '%s'\n" "$pw"; cat $REPO/deploy/nuq-postgres/fcpi-core-role.psql; } \
  | sudo -n docker exec -i "$PG" psql -U postgres -d postgres -X -q -v ON_ERROR_STOP=1
unset pw
q() { sudo -n docker exec "$PG" psql -U postgres -d postgres -X -Atc "$1"; }
echo "role=$(q "select rolname||' super='||rolsuper||' createrole='||rolcreaterole||' createdb='||rolcreatedb||' replication='||rolreplication||' bypassrls='||rolbypassrls from pg_roles where rolname='fcpi_core'")"
echo "nuq_owner=$(q "select pg_get_userbyid(nspowner) from pg_namespace where nspname='nuq'")"
echo "fcpi_core_privileges=$(q "select string_agg(distinct privilege_type, ',' order by privilege_type) from information_schema.table_privileges where grantee='fcpi_core' and table_schema='nuq'")"
echo "superuser_has_password=$(q "select rolpassword is not null from pg_authid where rolname='postgres'")"

sec rabbitmq_tags
sudo -n docker exec "$RMQ" rabbitmqctl set_user_tags fcpi 2>&1 | tail -1
echo "users=$(sudo -n docker exec "$RMQ" rabbitmqctl list_users -q | awk 'NR>1 {print $1 $2}' | tr '\n' ' ')"

sec apply
sudo -n $REPO/deploy/host/fcpi-data-check.sh
rc=0; "${COMPOSE[@]}" up -d --wait --wait-timeout 900 2>&1 | tail -8 || rc=$?
echo "up_exit=$rc"
[ "$rc" = 0 ] || die "docker compose up failed"
echo "healthy=$(sudo -n docker ps -q --filter label=com.docker.compose.project=fcpi --filter health=healthy | wc -l)"
PG=$(name nuq-postgres) # `up` may have recreated it
# Sessions from other containers; pg_cron's own connections come over loopback.
echo "core_tcp_sessions=$(q "select usename||':'||count(*) from pg_stat_activity where client_addr is not null and host(client_addr) not in ('127.0.0.1','::1') group by usename" | tr '\n' ' ')"
echo end
