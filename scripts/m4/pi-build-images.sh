#!/usr/bin/env bash
# Build M4's two images on the Pi from the deployed commit, as M3 built the gateway: the MCP service
# (services/mcp) and the access gateway with its /mcp route (services/access), each FROM the
# digest-pinned node base, its packages from its lockfile by npm ci with integrity checks and install
# scripts off. Nothing compiles, so they build beside the running stack. The deployed commit is passed
# in and recorded in each image.
#   ssh … 'bash -s' < scripts/m4/pi-build-images.sh
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

build() { # build <image name> <context>
  sec "build_$1"
  local start rc
  start=$(date +%s)
  set +e
  sudo -n docker buildx build --platform linux/arm64 --progress=plain --provenance=false --sbom=false \
    --build-arg FCPI_SOURCE_COMMIT="$commit" --load -t "fcpi/$1:m4" "$2" 2>&1
  rc=$?
  set -e
  echo "build_exit=$rc image=fcpi/$1:m4 elapsed_s=$(( $(date +%s) - start )) mem_available_mib=$(mem)"
  [ "$rc" = 0 ] || exit "$rc"
}
build mcp-gateway $REPO/services/mcp
build access-gateway $REPO/services/access

sec images
for i in mcp-gateway access-gateway; do
  sudo -n docker image inspect "fcpi/$i:m4" --format "fcpi/$i:m4 id={{.Id}} os={{.Os}} arch={{.Architecture}} size={{.Size}} user={{.Config.User}}"
  sudo -n docker image inspect "fcpi/$i:m4" --format '{{range .Config.Env}}{{println .}}{{end}}' | grep '^FCPI_SOURCE_COMMIT=' | sed "s#^#fcpi/$i:m4 #"
done
echo "leftover_transient_containers=$(sudo -n docker ps -a --filter label=fcpi.transient --format '{{.ID}}' | wc -l)"
sec end
echo end
