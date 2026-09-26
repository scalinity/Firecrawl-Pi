#!/usr/bin/env bash
# FCPI: create the platform ledger's schema and the gateway's role when a new data directory is
# initialised, after 010-nuq.sql and 030-fcpi-retrieval.sh (M3). Sourced by the postgres image's
# entrypoint like 020-fcpi-core-role.sh, so docker_process_sql runs as the superuser over the local
# socket. The password reaches psql through stdin only.
fcpi_pw=$(tr -d '\n' </run/secrets/postgres_gateway_role_password)
if [ -z "$fcpi_pw" ]; then echo "040-fcpi-platform: secret postgres_gateway_role_password is empty" >&2; exit 1; fi
docker_process_sql </docker-entrypoint-initdb.d/fcpi-platform-schema.psql
# Neither the statement nor an error about it may reach the server log with the password.
printf "SET log_statement = 'none';\nSET log_min_error_statement = panic;\n\\\\set pw '%s'\nALTER ROLE fcpi_gateway PASSWORD :'pw';\n" "$fcpi_pw" | docker_process_sql
unset fcpi_pw
# The platform network (fcpi_platform, 10.231.7.0/24) is the gateway's alone: from it, only
# fcpi_gateway may connect, only to the postgres database, with its password; any other role is
# refused before authentication. First in the file, since pg_hba's first match wins; the entrypoint
# has written its own rules by now and starts the server with these. scripts/m3/pi-platform-db.sh
# writes the same lines on an existing data directory.
fcpi_hba="$PGDATA/pg_hba.conf"
{ printf '%s\n' '# fcpi-platform-network' 'host postgres fcpi_gateway 10.231.7.0/24 scram-sha-256' 'host all all 10.231.7.0/24 reject'; cat "$fcpi_hba"; } >"$fcpi_hba.fcpi"
mv "$fcpi_hba.fcpi" "$fcpi_hba"
unset fcpi_hba
