#!/usr/bin/env bash
# Save the public retrievals that back deploy/versions.lock.json literals, each
# with its retrieval time, under evidence/M0/sources/. Read-only against public
# registries and documentation; contacts no Firecrawl Cloud endpoint and the Pi
# not at all. build-lock.mjs reads its values from these files.
set -euo pipefail
root=$(cd "$(dirname "$0")/../.." && pwd)
dir="$root/evidence/M0/sources"; mkdir -p "$dir"
now() { date -u +%Y-%m-%dT%H:%M:%SZ; }
save() { # save <name> <command...>: stdout of the command, wrapped with provenance
  local name=$1; shift
  { printf '# retrieved_utc=%s\n# command=%s\n' "$(now)" "$*"; "$@"; } >"$dir/$name.tmp" && mv "$dir/$name.tmp" "$dir/$name"
}

# MCP TypeScript SDK packages (npm registry metadata only; nothing installed).
for spec in @modelcontextprotocol/server@2.0.0 @modelcontextprotocol/server@2.1.0 @modelcontextprotocol/core@2.0.0 @modelcontextprotocol/node@2.0.0; do
  n=$(printf '%s' "$spec" | tr '@/' '__' | sed 's/^_//')
  save "npm-$n.json" npm view "$spec" name version engines dependencies peerDependencies dist.integrity time.modified --json
done
save npm-mcp-server-dist-tags.json npm view @modelcontextprotocol/server dist-tags --json

# Node 22 releases.
save nodejs-v22.json bash -c "curl -fsS --max-time 30 https://nodejs.org/dist/index.json | jq '[.[] | select(.version|startswith(\"v22.\"))][0:3] | map({version,date,security,lts})'"

# Supported Go releases.
save go-dl.json bash -c "curl -fsS --max-time 30 'https://go.dev/dl/?mode=json' | jq 'map({version,stable})'"

# pg_cron for PostgreSQL 17 on Debian trixie arm64 (PGDG, used by the postgres image).
save pgdg-trixie-arm64-postgresql-17-cron.txt bash -c "curl -fsS --max-time 60 https://apt.postgresql.org/pub/repos/apt/dists/trixie-pgdg/main/binary-arm64/Packages.gz | gunzip | awk '\$1==\"Package:\"{c=(\$2==\"postgresql-17-cron\")} c&&(\$1==\"Package:\"||\$1==\"Version:\"||\$1==\"SHA256:\")'"

# FoundationDB client .deb: published checksum and asset size.
save fdb-7.3.63-clients-aarch64.deb.sha256 curl -fsSL --max-time 30 https://github.com/apple/foundationdb/releases/download/7.3.63/foundationdb-clients_7.3.63-1_aarch64.deb.sha256
save fdb-7.3.63-clients-aarch64-asset.json gh api repos/apple/foundationdb/releases/tags/7.3.63 --jq '[.assets[] | select(.name=="foundationdb-clients_7.3.63-1_aarch64.deb") | {name,size}]'

# Docker CE for Debian trixie arm64.
save docker-ce-trixie-release.txt bash -c "curl -fsS --max-time 30 https://download.docker.com/linux/debian/dists/trixie/Release | grep -E '^(Suite|Codename|Date|Architectures):'"
save docker-ce-trixie-arm64-versions.txt bash -c "curl -fsS --max-time 60 https://download.docker.com/linux/debian/dists/trixie/stable/binary-arm64/Packages | awk '\$1==\"Package:\"{p=\$2} \$1==\"Version:\"&&(p==\"docker-ce\"||p==\"containerd.io\"||p==\"docker-compose-plugin\"||p==\"docker-buildx-plugin\"){print p, \$2}' | sort -V | awk '{last[\$1]=\$2} END{for(k in last) print k, last[k]}' | sort"

# Firecrawl API-image tags (newest first) and the formal Release channel.
save firecrawl-tags-latest.txt gh api 'repos/firecrawl/firecrawl/tags?per_page=5' --jq '.[].name'
save firecrawl-release-latest.json gh api repos/firecrawl/firecrawl/releases/latest --jq '{tag_name,published_at}'

# RabbitMQ release-series support dates (rendered text of the release page).
save rabbitmq-release-information.txt bash -c "curl -fsSL --max-time 30 https://www.rabbitmq.com/release-information | sed 's/<[^>]*>/ /g' | tr -s ' \n' ' ' | grep -oE '(4\.3|4\.2) (4\.[0-9]+\.[0-9]+ Release Notes Release Notes [0-9]+ [A-Z][a-z]+ 20[0-9]{2} [0-9]+ [A-Z][a-z]+ 20[0-9]{2} [0-9]+ [A-Z][a-z]+ 20[0-9]{2})' | head -2"

# Playwright Chromium 1208 arm64 archives (HEAD only).
for z in chromium-linux-arm64.zip chromium-headless-shell-linux-arm64.zip; do
  save "playwright-chromium-1208-$z.head.txt" bash -c "curl -sIL --max-time 30 https://cdn.playwright.dev/dbazure/download/playwright/builds/chromium/1208/$z | grep -iE '^(HTTP|content-length|last-modified)' | tr -d '\r'"
done

# Redis image jemalloc page-size configuration (7.x template and 8.10 release branch).
save redis-jemalloc-lg-page.txt bash -c "gh api repos/docker-library/redis/contents/Dockerfile.template --jq .content | base64 -D | grep -n -- '--with-lg-page'; gh api 'repos/redis/docker-library-redis/contents/alpine/Dockerfile?ref=release/8.10' --jq .content | base64 -D | grep -n -- '--with-lg-page'"
echo "saved to evidence/M0/sources/"
