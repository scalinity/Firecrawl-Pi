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
echo "nuq_owner=$(q "select pg_get_userbyid(nspowner) from pg_namespace where nspname='nuq'")"
echo "nuq_relations=$(q "select count(*) from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='nuq' and c.relkind in ('r','p','v','m','S')")"
echo "nuq_relations_not_owned=$(q "select count(*) from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='nuq' and c.relkind in ('r','p','v','m','S') and pg_get_userbyid(c.relowner)<>'fcpi_core'")"
echo "nuq_types_not_owned=$(q "select count(*) from pg_type t join pg_namespace n on n.oid=t.typnamespace where n.nspname='nuq' and t.typtype in ('e','d') and pg_get_userbyid(t.typowner)<>'fcpi_core'")"
echo "tcp_sessions=$(q "select coalesce(string_agg(u, ' ' order by u), 'none') from (select usename||':'||count(*) u from pg_stat_activity where client_addr is not null group by usename) s")"

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
