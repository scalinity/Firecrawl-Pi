#!/usr/bin/env bash
# Build M7's four project images on the Pi from the deployed commit, as M3-M6 built theirs: the retrieval service (the
# enhanced tier, the browser extras, webhook delivery), the access gateway (artifacts, the cache, changes, the outbox),
# the MCP service (the new schemas) and the browser worker (the action subset), each FROM its digest-pinned base,
# packages from its lockfile by npm ci with integrity checks and install scripts off, the deployed commit recorded in it.
# Nothing compiles, so they build beside the running stack.
#   ssh … 'bash -s' < scripts/m7/pi-build-images.sh
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
build() { # build <image name> <context> [dockerfile]
  sec "build_$1"
  local start rc
  start=$(date +%s)
  set +e
  sudo -n docker buildx build --platform linux/arm64 --progress=plain --provenance=false --sbom=false \
    --build-arg FCPI_SOURCE_COMMIT="$commit" ${3:+-f "$3"} --load -t "fcpi/$1:m7" "$2" 2>&1
  rc=$?
  set -e
  echo "build_exit=$rc image=fcpi/$1:m7 elapsed_s=$(( $(date +%s) - start )) mem_available_mib=$(mem)"
  [ "$rc" = 0 ] || exit "$rc"
}
build retrieval $REPO/services/retrieval
build access-gateway $REPO/services/access
build mcp-gateway $REPO/services/mcp
build browser $REPO/services/browser $REPO/deploy/browser/Dockerfile
sec images
for i in retrieval access-gateway mcp-gateway browser; do
  sudo -n docker image inspect "fcpi/$i:m7" --format "fcpi/$i:m7 id={{.Id}} os={{.Os}} arch={{.Architecture}} size={{.Size}} user={{.Config.User}}"
  sudo -n docker image inspect "fcpi/$i:m7" --format '{{range .Config.Env}}{{println .}}{{end}}' | grep '^FCPI_SOURCE_COMMIT=' | sed "s#^#fcpi/$i:m7 #"
done
echo "leftover_transient_containers=$(sudo -n docker ps -a --filter label=fcpi.transient --format '{{.ID}}' | wc -l)"
sec end
echo end
