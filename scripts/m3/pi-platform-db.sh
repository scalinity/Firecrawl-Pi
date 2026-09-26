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
  # Neither the statement nor an error about it may reach the server log with the password.
  { printf 'SET log_statement = %s;\nSET log_min_error_statement = panic;\n\\set pw %s\n' "'none'" "$pw"; echo "ALTER ROLE fcpi_gateway PASSWORD :'pw';"; } | psql
  unset pw
  sec hba
  # The platform network (fcpi_platform, 10.231.7.0/24) is the gateway's alone: from it, only
  # fcpi_gateway may connect, only to the postgres database, with its password; any other role is
  # refused before authentication. The lines go first (pg_hba's first match wins), once, as
  # initdb/040-fcpi-platform.sh writes them on a new data directory; then the server reloads.
  sudo -n docker exec -i -u 5432:5432 "$PG" sh -s <<'SH'
set -eu
hba="$PGDATA/pg_hba.conf"
if ! grep -qx '# fcpi-platform-network' "$hba"; then
  { printf '%s\n' '# fcpi-platform-network' 'host postgres fcpi_gateway 10.231.7.0/24 scram-sha-256' 'host all all 10.231.7.0/24 reject'; cat "$hba"; } >"$hba.fcpi"
  mv "$hba.fcpi" "$hba"
  echo "hba=added"
else
  echo "hba=present"
fi
SH
  psql -At -c "SELECT 'reloaded=' || pg_reload_conf()"
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
  FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'fcpi_platform' AND c.relkind = 'r' AND c.relname <> 'schema_version';
SELECT 'schema_version=' || (SELECT max(version) FROM fcpi_platform.schema_version)
  || ' gateway_version_select=' || has_table_privilege('fcpi_gateway', 'fcpi_platform.schema_version', 'SELECT')
  || ' gateway_version_write=' || has_table_privilege('fcpi_gateway', 'fcpi_platform.schema_version', 'INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER');
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
-- pg_cron grants SELECT on its own tables to PUBLIC (row security limits each role to its own
-- jobs), so every role sees them; they are listed apart from what the reader was granted.
SELECT 'reader_tables=' || string_agg(n.nspname || '.' || c.relname, ',' ORDER BY n.nspname, c.relname)
  FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE has_table_privilege('fcpi_nuq_reader', c.oid, 'SELECT') AND n.nspname NOT IN ('pg_catalog', 'information_schema', 'cron');
SELECT 'cron_tables_public_select=' || string_agg(c.relname, ',' ORDER BY c.relname)
  FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'cron' AND c.relkind = 'r' AND has_table_privilege('public', c.oid, 'SELECT');
SQL

sec hba_rules
# The rules the server has loaded, in match order.
psql -At <<'SQL'
SELECT 'hba_rule n=' || rule_number || ' type=' || type || ' db=' || array_to_string(database, ',') || ' user=' || array_to_string(user_name, ',')
  || ' address=' || coalesce(address, '') || ' mask=' || coalesce(netmask, '') || ' method=' || coalesce(auth_method, '') || ' error=' || coalesce(error, '')
  FROM pg_hba_file_rules ORDER BY line_number;
SQL

sec hba_probe
# From the platform network, as the gateway would connect: a throwaway container of the PostgreSQL
# image (no capabilities, read-only, the service's uid) tries each role with a wrong password. The
# gateway's role must reach password authentication, the positive control that the probe reached the
# server; every other role must be refused by pg_hba first. Only the classification is printed.
img=$(sudo -n docker inspect -f '{{.Config.Image}}' "$PG")
for role in fcpi_gateway fcpi_core fcpi_retrieval postgres; do
  out=$(sudo -n docker run --rm --network fcpi_platform --label fcpi.transient=hba-probe --read-only --tmpfs /tmp:size=8m --cap-drop ALL \
    --security-opt no-new-privileges:true --user 5432:5432 --entrypoint psql "$img" \
    "host=nuq-postgres port=5432 dbname=postgres user=$role password=not-the-password connect_timeout=10" -Atc 'select 1' 2>&1 || true)
  case "$out" in
    *"pg_hba.conf rejects connection"*) result=rejected_by_hba ;;
    *"password authentication failed"*) result=password_failed ;;
    *) result=other ;;
  esac
  echo "probe role=$role result=$result"
done
echo "leftover_transient=$(sudo -n docker ps -aq --filter label=fcpi.transient=hba-probe | wc -l)"
echo end
