#!/bin/sh
# firecrawl-core entrypoint (project-owned, mounted read-only over the upstream image).
# Upstream reads its credentials only from environment variables and has no _FILE
# support, so this wrapper loads the mounted secret files into the process
# environment (spec §20.3); the values therefore never appear in `docker inspect`.
# It then drops to uid/gid 3002 with no capabilities and no-new-privileges, and hands
# over to the image's own entrypoint and command (node dist/src/harness.js --start-docker).
set -eu
secret() {
  [ -r "/run/secrets/$1" ] || { echo "fcpi-core-entrypoint: secret $1 is missing" >&2; exit 1; }
  tr -d '\n' <"/run/secrets/$1"
}
POSTGRES_PASSWORD=$(secret core_postgres_password)
NUQ_RABBITMQ_URL=$(secret core_nuq_rabbitmq_url)
REDIS_URL=$(secret core_redis_url)
REDIS_RATE_LIMIT_URL=$REDIS_URL
# The pi-resilient engine's credential for the retrieval service (M2).
PI_RETRIEVAL_TOKEN=$(secret core_retrieval_token)
HOME=/tmp
export POSTGRES_PASSWORD NUQ_RABBITMQ_URL REDIS_URL REDIS_RATE_LIMIT_URL PI_RETRIEVAL_TOKEN HOME
exec setpriv --reuid=3002 --regid=3002 --clear-groups --inh-caps=-all --ambient-caps=-all --no-new-privs \
  docker-entrypoint.sh "$@"
