#!/usr/bin/env bash
# Build the project images this work changes on the Pi from the deployed commit, as M3-M8 built theirs: each FROM its
# digest-pinned base, packages from its lockfile by npm ci with integrity checks and install scripts off, the deployed
# commit recorded in it. Nothing compiles, so they build beside the running stack. Only the images named are built, so
# an unchanged image keeps the digest it runs under. Each build is tagged with its commit (quality-<12 hex>), so every
# image a commit's Compose file pins stays tagged, and fcpi/<name>@sha256:<id> resolves for a rollback to that commit.
#   ssh … 'bash -s -- <image> …' < scripts/retrieval-quality/pi-build-images.sh     (retrieval, access-gateway, mcp-gateway)
set -euo pipefail
export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
REPO=/opt/firecrawl-pi
sec() { printf '### %s\n' "$1"; }
mem() { awk '/^MemAvailable:/ {printf "%d", $2/1024}' /proc/meminfo; }
commit=$(cat $REPO/.fcpi-source-commit)
[[ $commit =~ ^[0-9a-f]{40}$ ]] || { echo "no deployed commit recorded" >&2; exit 1; }
[ $# -gt 0 ] || { echo "name the images to build" >&2; exit 2; }
TAG=quality-${commit:0:12}
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
    --build-arg FCPI_SOURCE_COMMIT="$commit" --load -t "fcpi/$1:$TAG" "$2" 2>&1
  rc=$?
  set -e
  echo "build_exit=$rc image=fcpi/$1:$TAG elapsed_s=$(( $(date +%s) - start )) mem_available_mib=$(mem)"
  [ "$rc" = 0 ] || exit "$rc"
}
for i in "$@"; do
  case $i in
    retrieval) build retrieval $REPO/services/retrieval ;;
    access-gateway) build access-gateway $REPO/services/access ;;
    mcp-gateway) build mcp-gateway $REPO/services/mcp ;;
    *) echo "unknown image: $i" >&2; exit 1 ;;
  esac
done
sec images
for i in "$@"; do
  sudo -n docker image inspect "fcpi/$i:$TAG" --format "fcpi/$i:$TAG id={{.Id}} os={{.Os}} arch={{.Architecture}} size={{.Size}} user={{.Config.User}}"
  sudo -n docker image inspect "fcpi/$i:$TAG" --format '{{range .Config.Env}}{{println .}}{{end}}' | grep '^FCPI_SOURCE_COMMIT=' | sed "s#^#fcpi/$i:$TAG #"
done
echo "leftover_transient_containers=$(sudo -n docker ps -a --filter label=fcpi.transient --format '{{.ID}}' | wc -l)"
sec end
echo end
