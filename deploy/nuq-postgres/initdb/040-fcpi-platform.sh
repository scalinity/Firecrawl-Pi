#!/usr/bin/env bash
# FCPI: create the platform ledger's schema and the gateway's role when a new data directory is
# initialised, after 010-nuq.sql and 030-fcpi-retrieval.sh (M3). Sourced by the postgres image's
# entrypoint like 020-fcpi-core-role.sh, so docker_process_sql runs as the superuser over the local
# socket. The password reaches psql through stdin only.
fcpi_pw=$(tr -d '\n' </run/secrets/postgres_gateway_role_password)
if [ -z "$fcpi_pw" ]; then echo "040-fcpi-platform: secret postgres_gateway_role_password is empty" >&2; exit 1; fi
docker_process_sql </docker-entrypoint-initdb.d/fcpi-platform-schema.psql
printf "\\\\set pw '%s'\nALTER ROLE fcpi_gateway PASSWORD :'pw';\n" "$fcpi_pw" | docker_process_sql
unset fcpi_pw
