# Build a Postgres image that runs nuq.sql during initdb
#
# Project copy of upstream apps/nuq-postgres/Dockerfile at firecrawl/firecrawl
# 7666c1f9ae8720a6bba271e0f60b6a217f8a5210 (AGPL-3.0; upstream file sha256
# 00108183ba9947db346226e3cc120b92b4cfcc60b215b320ad682f7944e93e45). nuq.sql beside
# it is the unmodified upstream file (sha256 44edb370cfc2601076e174c5461ffdfda8a1051b3c2a87c1b5231d002a66ee77).
# Two packaging edits, both pins:
#   1. FROM names postgres:17.11-trixie by its linux/arm64 manifest digest. Upstream's
#      `ARG PG_MAJOR` / `FROM postgres:${PG_MAJOR}` cannot carry a digest, because the
#      RUN lines reuse PG_MAJOR (the base image's ENV, 17) in the package name and path.
#   2. postgresql-17-cron is installed at an exact PGDG version.

FROM postgres:17.11-trixie@sha256:86fa57b44a1d38f09970f64ac71eb492f7a9cf94d08b85e1c8f07bb0fc0a1761

# Install pg_cron for the specified Postgres major version
RUN set -eux; \
    apt-get update; \
    apt-get install -y --no-install-recommends \
        postgresql-17-cron=1.6.8-1.pgdg13+2; \
    rm -rf /var/lib/apt/lists/*

# Ensure pg_cron is preloaded on first startup by modifying the initdb template
# This must be set before the first server start (init scripts run after start)
RUN set -eux; \
    conf_sample="/usr/share/postgresql/${PG_MAJOR}/postgresql.conf.sample"; \
    sed -ri "s/^#?shared_preload_libraries\s*=.*/shared_preload_libraries = 'pg_cron'/" "$conf_sample"; \
    printf "\n# Added for pg_cron\ncron.database_name = 'postgres'\n" >> "$conf_sample"

# Copy nuq.sql so it is executed as part of the initdb sequence
COPY nuq.sql /docker-entrypoint-initdb.d/010-nuq.sql
