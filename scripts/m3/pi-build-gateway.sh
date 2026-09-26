#!/usr/bin/env bash
# Build the access gateway's image on the Pi from the deployed commit (M3), as M2 built its service
# images: the digest-pinned node base the gateway already ran on, pg from the lockfile by npm ci with
# integrity checks and install scripts off, and the gateway's own files. Nothing compiles, so it builds
# beside the running stack. The deployed commit is passed in and recorded in the image.
#   ssh … 'bash -s' < scripts/m3/pi-build-gateway.sh
set -euo pipefail
export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
REPO=/opt/firecrawl-pi
sec() { printf '### %s\n' "$1"; }
mem() { awk '/^MemAvailable:/ {printf "%d", $2/1024}' /proc/meminfo; }
commit=$(cat $REPO/.fcpi-source-commit)
[[ $commit =~ ^[0-9a-f]{40}$ ]] || { echo "no deployed commit recorded" >&2; exit 1; }

sec meta
echo "utc=$(date -u +%Y-%m-%dT%H:%M:%SZ)"
echo "source_commit=$commit"
echo "builder=$(sudo -n docker buildx version)"
echo "mem_available_mib_before=$(mem)"

sec build_gateway
start=$(date +%s)
set +e
sudo -n docker buildx build --platform linux/arm64 --progress=plain --provenance=false --sbom=false \
  --build-arg FCPI_SOURCE_COMMIT="$commit" --load -t fcpi/access-gateway:m3 $REPO/services/access 2>&1
rc=$?
set -e
echo "build_exit=$rc elapsed_s=$(( $(date +%s) - start )) mem_available_mib=$(mem)"
[ "$rc" = 0 ] || exit "$rc"

sec images
sudo -n docker image inspect fcpi/access-gateway:m3 --format 'fcpi/access-gateway:m3 id={{.Id}} os={{.Os}} arch={{.Architecture}} size={{.Size}} user={{.Config.User}}'
sudo -n docker image inspect fcpi/access-gateway:m3 --format '{{range .Config.Env}}{{println .}}{{end}}' | grep '^FCPI_SOURCE_COMMIT='
echo "leftover_transient_containers=$(sudo -n docker ps -a --filter label=fcpi.transient --format '{{.ID}}' | wc -l)"
sec end
echo end
