#!/usr/bin/env bash
# Create the retrieval service's schema and role on the existing NuQ data directory (M2), as the
# superuser over the local socket inside nuq-postgres: DDL never runs through the core or the
# service (CLAUDE.md §33.1). Idempotent. The role's password is read from its secret file and
# reaches psql over stdin only. Then prints the role's rights, for the credentials check.
#   ssh … 'bash /opt/firecrawl-pi/scripts/m2/pi-retrieval-db.sh'
set -euo pipefail
export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
REPO=/opt/firecrawl-pi
S=/etc/firecrawl-pi/secrets
sec() { printf '### %s\n' "$1"; }
PG=$(sudo -n docker ps -q --filter label=com.docker.compose.project=fcpi --filter label=com.docker.compose.service=nuq-postgres)
[ -n "$PG" ] || { echo "nuq-postgres is not running" >&2; exit 1; }
psql() { sudo -n docker exec -i "$PG" psql -U postgres -d postgres -v ON_ERROR_STOP=1 -q -X "$@"; }

sec meta
echo "utc=$(date -u +%Y-%m-%dT%H:%M:%SZ)"
echo "source_commit=$(cat $REPO/.fcpi-source-commit)"

sec schema
psql <"$REPO/deploy/nuq-postgres/fcpi-retrieval-schema.sql"
{ printf '\\set pw %s\n' "$(sudo -n cat $S/retrieval_postgres_password)"; echo "ALTER ROLE fcpi_retrieval PASSWORD :'pw';"; } | psql
echo "applied=yes"

sec rights
psql -At <<'SQL'
SELECT 'role=' || rolname || ' super=' || rolsuper || ' createrole=' || rolcreaterole || ' createdb=' || rolcreatedb || ' replication=' || rolreplication || ' bypassrls=' || rolbypassrls || ' has_password=' || (rolpassword IS NOT NULL)
  FROM pg_authid WHERE rolname = 'fcpi_retrieval';
SELECT 'schema_owner=' || pg_get_userbyid(nspowner) FROM pg_namespace WHERE nspname = 'fcpi_retrieval';
SELECT 'owned_objects=' || count(*) FROM pg_class c WHERE c.relowner = (SELECT oid FROM pg_roles WHERE rolname = 'fcpi_retrieval');
-- A comma list in has_table_privilege means "any of"; the four DML rights are checked one by one.
SELECT 'tables=' || count(*)
  || ' tables_with_dml=' || count(*) FILTER (WHERE has_table_privilege('fcpi_retrieval', c.oid, 'SELECT') AND has_table_privilege('fcpi_retrieval', c.oid, 'INSERT')
                                              AND has_table_privilege('fcpi_retrieval', c.oid, 'UPDATE') AND has_table_privilege('fcpi_retrieval', c.oid, 'DELETE'))
  || ' tables_with_other_rights=' || count(*) FILTER (WHERE has_table_privilege('fcpi_retrieval', c.oid, 'TRUNCATE,REFERENCES,TRIGGER'))
  FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'fcpi_retrieval' AND c.relkind = 'r';
SELECT 'schema_create=' || has_schema_privilege('fcpi_retrieval', 'fcpi_retrieval', 'CREATE') || ' nuq_usage=' || has_schema_privilege('fcpi_retrieval', 'nuq', 'USAGE');
SQL
echo end
