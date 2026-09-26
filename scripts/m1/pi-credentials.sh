#!/usr/bin/env bash
# Evidence for the core's narrowed data-service credentials (REVIEW.md R11). Runs ON the Pi:
#   ssh ... 'bash /opt/firecrawl-pi/scripts/m1/pi-credentials.sh'
# Read-only. Secret files are compared on the Pi; only yes/no, owners and modes are printed.
set -uo pipefail
export LC_ALL=C
export PATH="/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"
REPO=/opt/firecrawl-pi
S=/etc/firecrawl-pi/secrets
sec() { printf '### %s\n' "$1"; }
name() { sudo -n docker ps -q --filter label=com.docker.compose.project=fcpi --filter "label=com.docker.compose.service=$1"; }
PG=$(name nuq-postgres); RMQ=$(name rabbitmq)
q() { sudo -n docker exec "$PG" psql -U postgres -d postgres -X -Atc "$1" 2>&1; }

sec meta
date -u +%Y-%m-%dT%H:%M:%SZ
echo "source_commit=$(cat $REPO/.fcpi-source-commit)"

sec postgres
echo "role=$(q "select rolname||' super='||rolsuper||' createrole='||rolcreaterole||' createdb='||rolcreatedb||' replication='||rolreplication||' bypassrls='||rolbypassrls from pg_roles where rolname='fcpi_core'")"
echo "superusers=$(q "select string_agg(rolname, ',' order by rolname) from pg_roles where rolsuper")"
echo "superuser_has_password=$(q "select rolpassword is not null from pg_authid where rolname='postgres'")"
echo "nuq_owner=$(q "select pg_get_userbyid(nspowner) from pg_namespace where nspname='nuq'")"
echo "nuq_tables=$(q "select count(*) from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='nuq' and c.relkind in ('r','p')")"
# fcpi_core owns nothing anywhere in this database: no relation, type, function or schema.
echo "fcpi_core_owned_objects=$(q "select (select count(*) from pg_class where relowner=r.oid)+(select count(*) from pg_type where typowner=r.oid)+(select count(*) from pg_proc where proowner=r.oid)+(select count(*) from pg_namespace where nspowner=r.oid) from pg_roles r where rolname='fcpi_core'")"
echo "fcpi_core_privileges=$(q "select string_agg(distinct privilege_type, ',' order by privilege_type) from information_schema.table_privileges where grantee='fcpi_core' and table_schema='nuq'")"
echo "fcpi_core_tables_with_dml=$(q "select count(*) from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='nuq' and c.relkind in ('r','p') and has_table_privilege('fcpi_core', c.oid, 'SELECT,INSERT,UPDATE,DELETE')")"
echo "fcpi_core_schema_create=$(q "select has_schema_privilege('fcpi_core','nuq','CREATE')")"
echo "cron_job_owners=$(q "select string_agg(username||':'||n, ' ' order by username) from (select username, count(*) n from cron.job group by 1) s")"
# Sessions from other containers; pg_cron's own connections come over loopback.
echo "tcp_sessions=$(q "select coalesce(string_agg(u, ' ' order by u), 'none') from (select usename||':'||count(*) u from pg_stat_activity where client_addr is not null and host(client_addr) not in ('127.0.0.1','::1') group by usename) s")"

sec fcpi_core_probe
# As fcpi_core (local socket, trusted inside the container), each in a transaction that is
# rolled back: a DML statement must succeed (the positive control); creating a function in
# the NuQ schema and attaching a trigger to a NuQ table must both be refused.
fq() { printf '%s\n' "$1" | sudo -n docker exec -i "$PG" psql -U fcpi_core -d postgres -X -q -At -v ON_ERROR_STOP=1 2>&1 | tr '\n' ' '; }
echo "dml=$(fq "begin; update nuq.queue_scrape set status = status where false; select 'ok'; rollback;")"
echo "create_function_in_nuq=$(fq "begin; create function nuq.fcpi_probe() returns trigger language plpgsql as \$\$begin return null; end\$\$; rollback;")"
echo "create_trigger_on_nuq=$(fq "begin; create function pg_temp.fcpi_probe() returns trigger language plpgsql as \$\$begin return null; end\$\$; create trigger fcpi_probe after update on nuq.queue_scrape for each statement execute function pg_temp.fcpi_probe(); rollback;")"

sec secrets
echo "core_equals_superuser=$(sudo -n cmp -s $S/core_postgres_password $S/postgres_password && echo yes || echo no)"
echo "core_role_pair_equal=$(sudo -n cmp -s $S/core_postgres_password $S/postgres_core_role_password && echo yes || echo no)"
for f in postgres_password core_postgres_password postgres_core_role_password; do
  echo "$f $(sudo -n stat -c '%u:%g %a' $S/$f 2>/dev/null || echo absent)"
done

sec rabbitmq
echo "users=$(sudo -n docker exec "$RMQ" rabbitmqctl list_users -q | awk 'NR>1 {print $1 $2}' | tr '\n' ' ')"
echo "permissions=$(sudo -n docker exec "$RMQ" rabbitmqctl list_permissions -q | awk 'NR>1 {print $1, $2, $3, $4}' | tr '\n' ';')"
echo end
