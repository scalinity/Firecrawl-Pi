#!/usr/bin/env bash
# FCPI: create the core's own role when a new data directory is initialised, after
# 010-nuq.sql has built the NuQ schema. The file is not executable, so the postgres
# image's entrypoint sources it and provides docker_process_sql, which connects as the
# superuser over the local socket. The password reaches psql through stdin only.
fcpi_pw=$(tr -d '\n' </run/secrets/postgres_core_role_password)
if [ -z "$fcpi_pw" ]; then echo "020-fcpi-core-role: secret postgres_core_role_password is empty" >&2; exit 1; fi
{ printf "\\\\set pw '%s'\n" "$fcpi_pw"; cat /docker-entrypoint-initdb.d/fcpi-core-role.psql; } | docker_process_sql
unset fcpi_pw
