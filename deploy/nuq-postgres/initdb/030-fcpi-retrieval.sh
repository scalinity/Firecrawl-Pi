#!/usr/bin/env bash
# FCPI: create the retrieval service's schema and role when a new data directory is initialised,
# after 010-nuq.sql (M2). Sourced by the postgres image's entrypoint like 020-fcpi-core-role.sh, so
# docker_process_sql runs as the superuser over the local socket. The password reaches psql
# through stdin only.
fcpi_pw=$(tr -d '\n' </run/secrets/postgres_retrieval_role_password)
if [ -z "$fcpi_pw" ]; then echo "030-fcpi-retrieval: secret postgres_retrieval_role_password is empty" >&2; exit 1; fi
docker_process_sql </docker-entrypoint-initdb.d/fcpi-retrieval-schema.psql
# Neither the statement nor an error about it may reach the server log with the password.
printf "SET log_statement = 'none';\nSET log_min_error_statement = panic;\n\\\\set pw '%s'\nALTER ROLE fcpi_retrieval PASSWORD :'pw';\n" "$fcpi_pw" | docker_process_sql
unset fcpi_pw
