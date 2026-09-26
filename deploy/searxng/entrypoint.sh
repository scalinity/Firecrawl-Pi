#!/bin/sh
# SearXNG's start in FCPI (deploy/compose.yaml): the committed settings (deploy/searxng/settings.yml) are
# copied to the container's tmpfs, the outgoing section is appended with the search proxy's credential,
# and granian starts with one worker. The secrets are read from their files by the shell and reach the
# settings through a here-document and the server's environment, never a command line, so no process
# listing shows them (CLAUDE.md §33.2).
set -eu
key=$(cat /run/secrets/searxng_secret_key)
pw=$(cat /run/secrets/searxng_proxy_password)
[ -n "$key" ] && [ -n "$pw" ] || { echo "fcpi: SearXNG's secrets are missing" >&2; exit 1; }
umask 077
target=/etc/searxng/settings.yml
cat /fcpi/settings.yml > "$target"
cat >> "$target" <<SETTINGS

outgoing:
  request_timeout: 4.0
  max_request_timeout: 8.0
  pool_connections: 10
  pool_maxsize: 4
  enable_http2: false
  retries: 0
  proxies:
    all://:
      - http://searxng:${pw}@10.231.10.10:3313
SETTINGS
unset pw
export SEARXNG_SECRET="$key"
unset key
export SEARXNG_SETTINGS_PATH="$target"
exec /usr/local/searxng/.venv/bin/granian searx.webapp:app
