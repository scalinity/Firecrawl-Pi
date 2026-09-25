#!/usr/bin/env bash
# Proof of the two paths that only run on empty data (REVIEW.md R11): a new PostgreSQL data
# directory, where initdb/020-fcpi-core-role.sh creates fcpi_core, and a broker's first
# boot, where 30-fcpi.conf gives the default user no tags. Runs ON the Pi:
#   ssh ... 'bash /opt/firecrawl-pi/scripts/m1/pi-fresh-init-proof.sh'
# Each proof is a throwaway container of the pinned image the stack runs: tmpfs data, no
# network, a read-only root filesystem, the service's uid, throwaway secrets that are never
# printed, and the label fcpi.transient. Both containers and the secrets are removed.
set -uo pipefail
export LC_ALL=C
export PATH="/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"
REPO=/opt/firecrawl-pi
T=/run/fcpi-fresh-init-proof
PGC=fcpi-fresh-init-pg; RMC=fcpi-fresh-init-rabbitmq
D() { sudo -n docker "$@"; }
sec() { printf '### %s\n' "$1"; }
image() { D inspect -f '{{.Config.Image}}' "$(D ps -q --filter label=com.docker.compose.project=fcpi --filter "label=com.docker.compose.service=$1")"; }
cleanup() { D rm -f "$PGC" "$RMC" >/dev/null 2>&1; sudo -n rm -rf -- "$T"; }
trap cleanup EXIT
cleanup
gen_hex() { head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n'; }
put() { sudo -n install -m 0600 -o "${2%:*}" -g "${2#*:}" /dev/null "$1" && sudo -n tee "$1" >/dev/null; }

sec meta
date -u +%Y-%m-%dT%H:%M:%SZ
echo "source_commit=$(cat $REPO/.fcpi-source-commit)"
PGI=$(image nuq-postgres); RMI=$(image rabbitmq)
echo "postgres_image=$PGI"
echo "rabbitmq_image=$RMI"
sudo -n install -d -m 0755 -o root -g root $T
gen_hex | put $T/postgres_password 5432:5432
gen_hex | put $T/postgres_core_role_password 5432:5432
printf 'default_user = fcpi\ndefault_pass = %s\n' "$(gen_hex)" | put $T/40-fcpi-default-user.conf 5672:5672

sec postgres_initdb
D run -d --name $PGC --label fcpi.transient=fresh-init-proof --network none --read-only --user 5432:5432 \
  --cap-drop ALL --security-opt no-new-privileges:true --memory 512m --pids-limit 128 \
  --tmpfs /var/lib/postgresql/data:mode=1777,size=256m --tmpfs /var/run/postgresql:mode=1777,size=4m --tmpfs /tmp:size=64m \
  -e PGDATA=/var/lib/postgresql/data/pgdata -e POSTGRES_DB=postgres -e POSTGRES_USER=postgres \
  -e POSTGRES_PASSWORD_FILE=/run/secrets/postgres_password \
  -v $T/postgres_password:/run/secrets/postgres_password:ro \
  -v $T/postgres_core_role_password:/run/secrets/postgres_core_role_password:ro \
  -v $REPO/deploy/nuq-postgres/initdb/020-fcpi-core-role.sh:/docker-entrypoint-initdb.d/020-fcpi-core-role.sh:ro \
  -v $REPO/deploy/nuq-postgres/fcpi-core-role.psql:/docker-entrypoint-initdb.d/fcpi-core-role.psql:ro \
  "$PGI" postgres -c shared_buffers=32MB >/dev/null
# The entrypoint restarts the server after initdb; wait for the final server, not the
# temporary one ("PostgreSQL init process complete" comes between them).
for i in $(seq 1 120); do
  D logs $PGC 2>&1 | grep -q 'PostgreSQL init process complete' && D exec $PGC pg_isready -q 2>/dev/null && break
  sleep 1
done
echo "ready_after_s=$i"
echo "initdb_scripts=$(D logs $PGC 2>&1 | grep -oE '(running|ignoring) /docker-entrypoint-initdb\.d/[^ ]+' | tr '\n' ';')"
echo "init_errors=$(D logs $PGC 2>&1 | grep -cE '(ERROR|FATAL):')"
q() { D exec $PGC psql -U postgres -d postgres -X -Atc "$1" 2>&1; }
echo "role=$(q "select rolname||' super='||rolsuper||' createrole='||rolcreaterole||' createdb='||rolcreatedb||' replication='||rolreplication||' bypassrls='||rolbypassrls from pg_roles where rolname='fcpi_core'")"
echo "superuser_has_password=$(q "select rolpassword is not null from pg_authid where rolname='postgres'")"
echo "fcpi_core_has_password=$(q "select rolpassword is not null from pg_authid where rolname='fcpi_core'")"
echo "nuq_owner=$(q "select pg_get_userbyid(nspowner) from pg_namespace where nspname='nuq'")"
echo "nuq_tables=$(q "select count(*) from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='nuq' and c.relkind in ('r','p')")"
echo "fcpi_core_owned_objects=$(q "select (select count(*) from pg_class where relowner=r.oid)+(select count(*) from pg_type where typowner=r.oid)+(select count(*) from pg_proc where proowner=r.oid)+(select count(*) from pg_namespace where nspowner=r.oid) from pg_roles r where rolname='fcpi_core'")"
echo "fcpi_core_privileges=$(q "select string_agg(distinct privilege_type, ',' order by privilege_type) from information_schema.table_privileges where grantee='fcpi_core' and table_schema='nuq'")"
echo "fcpi_core_tables_with_dml=$(q "select count(*) from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='nuq' and c.relkind in ('r','p') and has_table_privilege('fcpi_core', c.oid, 'SELECT,INSERT,UPDATE,DELETE')")"
echo "cron_job_owners=$(q "select string_agg(username||':'||n, ' ' order by username) from (select username, count(*) n from cron.job group by 1) s")"
D rm -f $PGC >/dev/null

sec rabbitmq_first_boot
D run -d --name $RMC --label fcpi.transient=fresh-init-proof --network none --read-only --user 5672:5672 \
  --cap-drop ALL --security-opt no-new-privileges:true --memory 512m --pids-limit 256 \
  --tmpfs /var/lib/rabbitmq:mode=1777,size=64m --tmpfs /tmp:size=16m -e RABBITMQ_NODENAME=rabbit@localhost \
  -v $REPO/deploy/rabbitmq/30-fcpi.conf:/etc/rabbitmq/conf.d/30-fcpi.conf:ro \
  -v $T/40-fcpi-default-user.conf:/etc/rabbitmq/conf.d/40-fcpi-default-user.conf:ro \
  "$RMI" >/dev/null
for i in $(seq 1 120); do D exec $RMC rabbitmqctl -q await_startup >/dev/null 2>&1 && break; sleep 1; done
echo "ready_after_s=$i"
echo "users=$(D exec $RMC rabbitmqctl list_users -q 2>&1 | awk 'NR>1 {print $1 $2}' | tr '\n' ' ')"
echo "default_user_tags_env=$(D exec $RMC rabbitmqctl eval 'application:get_env(rabbit, default_user_tags).' 2>&1)"
D rm -f $RMC >/dev/null

sec cleanup
cleanup
trap - EXIT
echo "leftover_transient_containers=$(D ps -aq --filter label=fcpi.transient | wc -l)"
echo "leftover_secret_dir=$([ -e $T ] && echo yes || echo no)"
echo end
