#!/usr/bin/env bash
# Create the platform ledger's schema, the gateway's role and the marker lookup on the existing NuQ
# data directory (M3), as the superuser over the local socket inside nuq-postgres: DDL never runs
# through the core, the retrieval service or the gateway (CLAUDE.md §33.1). Idempotent. The role's
# password is read from its secret file and reaches psql over stdin only. Then prints the rights of
# every project role, for the credentials check.
#   ssh … 'bash /opt/firecrawl-pi/scripts/m3/pi-platform-db.sh'        apply, then print rights
#   ssh … 'bash /opt/firecrawl-pi/scripts/m3/pi-platform-db.sh rights' print rights only
set -euo pipefail
export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
REPO=/opt/firecrawl-pi
S=/etc/firecrawl-pi/secrets
sec() { printf '### %s\n' "$1"; }
PG=$(sudo -n docker ps -q --filter label=com.docker.compose.project=fcpi --filter label=com.docker.compose.service=nuq-postgres)
[ -n "$PG" ] || { echo "nuq-postgres is not running" >&2; exit 1; }
psql() { sudo -n docker exec -i "$PG" psql -U postgres -d postgres -v ON_ERROR_STOP=1 -q -X "$@"; }

sec meta
echo "utc=$(date -u +%Y-%m-%dT%H:%M:%SZ) source_commit=$(cat $REPO/.fcpi-source-commit)"

if [ "${1:-}" != rights ]; then
  sec schema
  psql <"$REPO/deploy/nuq-postgres/fcpi-platform-schema.sql"
  pw=$(sudo -n cat $S/gateway_postgres_password)
  [ -n "$pw" ] || { echo "gateway_postgres_password is empty" >&2; exit 1; }
  { printf 'SET log_statement = %s;\n\\set pw %s\n' "'none'" "$pw"; echo "ALTER ROLE fcpi_gateway PASSWORD :'pw';"; } | psql
  unset pw
  echo "applied=yes"
fi

sec rights
psql -At <<'SQL'
SELECT 'role=' || rolname || ' login=' || rolcanlogin || ' super=' || rolsuper || ' createrole=' || rolcreaterole || ' createdb=' || rolcreatedb || ' replication=' || rolreplication || ' bypassrls=' || rolbypassrls || ' has_password=' || (rolpassword IS NOT NULL)
  FROM pg_authid WHERE rolname IN ('fcpi_gateway', 'fcpi_nuq_reader', 'fcpi_core', 'fcpi_retrieval') ORDER BY rolname;
SELECT 'schema_owner=' || pg_get_userbyid(nspowner) FROM pg_namespace WHERE nspname = 'fcpi_platform';
SELECT 'owned_objects role=' || r.rolname || ' n=' || (SELECT count(*) FROM pg_class c WHERE c.relowner = r.oid) || ' functions=' || (SELECT count(*) FROM pg_proc p WHERE p.proowner = r.oid)
  FROM pg_roles r WHERE r.rolname IN ('fcpi_gateway', 'fcpi_nuq_reader') ORDER BY r.rolname;
SELECT 'platform_tables=' || count(*)
  || ' gateway_dml_on=' || count(*) FILTER (WHERE has_table_privilege('fcpi_gateway', c.oid, 'SELECT') AND has_table_privilege('fcpi_gateway', c.oid, 'INSERT')
                                             AND has_table_privilege('fcpi_gateway', c.oid, 'UPDATE') AND has_table_privilege('fcpi_gateway', c.oid, 'DELETE'))
  || ' gateway_other_rights_on=' || count(*) FILTER (WHERE has_table_privilege('fcpi_gateway', c.oid, 'TRUNCATE,REFERENCES,TRIGGER'))
  FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'fcpi_platform' AND c.relkind = 'r';
SELECT 'gateway_schema_create=' || has_schema_privilege('fcpi_gateway', 'fcpi_platform', 'CREATE')
  || ' gateway_nuq_usage=' || has_schema_privilege('fcpi_gateway', 'nuq', 'USAGE')
  || ' gateway_retrieval_usage=' || has_schema_privilege('fcpi_gateway', 'fcpi_retrieval', 'USAGE')
  || ' gateway_public_create=' || has_schema_privilege('fcpi_gateway', 'public', 'CREATE')
  || ' core_platform_usage=' || has_schema_privilege('fcpi_core', 'fcpi_platform', 'USAGE')
  || ' retrieval_platform_usage=' || has_schema_privilege('fcpi_retrieval', 'fcpi_platform', 'USAGE');
SELECT 'lookup owner=' || pg_get_userbyid(p.proowner) || ' security_definer=' || p.prosecdef || ' config=' || coalesce(array_to_string(p.proconfig, ';'), '')
  || ' gateway_execute=' || has_function_privilege('fcpi_gateway', p.oid, 'EXECUTE')
  || ' core_execute=' || has_function_privilege('fcpi_core', p.oid, 'EXECUTE')
  || ' public_execute=' || coalesce((SELECT bool_or(a.grantee = 0) FROM aclexplode(p.proacl) a WHERE a.privilege_type = 'EXECUTE'), true)
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'fcpi_platform' AND p.proname = 'upstream_groups_for_marker';
SELECT 'reader_tables=' || string_agg(c.relname, ',' ORDER BY c.relname)
  FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE has_table_privilege('fcpi_nuq_reader', c.oid, 'SELECT') AND n.nspname NOT IN ('pg_catalog', 'information_schema');
SQL
echo end
