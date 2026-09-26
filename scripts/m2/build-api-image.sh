#!/usr/bin/env bash
# Build the patched Firecrawl API image on the workstation's Colima VM, natively for linux/arm64
# (decision D6; the owner chose the Mac with Colima on 2026-09-26), and write the whole build log.
# The source is scripts/m2/prepare-api-source.sh's output; no provenance or SBOM attestation is
# attached, and buildx's --progress=plain log records every base-image digest and toolchain line.
#   scripts/m2/build-api-image.sh <log-file> [--no-cache]
# --no-cache runs every step, so the log shows every toolchain, install and build line (the build
# of record); cache mounts (pnpm store, cargo registry) still spare the downloads.
set -euo pipefail
root=$(cd "$(dirname "$0")/../.." && pwd)
log=${1:?usage: build-api-image.sh <log-file> [--no-cache]}
nocache=()
[ "${2:-}" = --no-cache ] && nocache=(--no-cache)
series=$root/patches/series.json
commit=$(jq -r .upstream.commit "$series")
series_sha=$(jq -r .series_sha256 "$series")
tag=fcpi/firecrawl-api:m2
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
{
  echo "### meta"
  echo "utc=$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  echo "repository_commit=$(git -C "$root" rev-parse HEAD) code_dirty=$([ -z "$(git -C "$root" status --porcelain -- . ':(exclude)evidence')" ] && echo false || echo true)"
  echo "builder=$(docker buildx version) context=$(docker context show)"
  echo "engine=$(docker version --format '{{.Server.Version}} {{.Server.Os}}/{{.Server.Arch}}')"
  echo "### source"
  "$root/scripts/m2/prepare-api-source.sh" "$work/fc"
  echo "### build"
  start=$(date +%s)
  set +e
  echo "no_cache=${#nocache[@]}"
  docker buildx build --platform linux/arm64 --progress=plain --provenance=false --sbom=false "${nocache[@]}" \
    --build-arg GIT_SHA="$commit" --build-arg FCPI_PATCH_SERIES_SHA256="$series_sha" \
    --load -t "$tag" "$work/fc/apps/api" 2>&1
  rc=$?
  set -e
  echo "build_exit=$rc elapsed_s=$(( $(date +%s) - start ))"
  [ "$rc" = 0 ] || exit "$rc"
  echo "### image"
  docker image inspect "$tag" --format 'id={{.Id}} os={{.Os}} arch={{.Architecture}} size={{.Size}} created={{.Created}}'
  docker image inspect "$tag" --format '{{range .Config.Env}}{{println .}}{{end}}' | grep -E '^(FIRECRAWL_BUILD_SHA|FCPI_PATCH_SERIES_SHA256|NODE_VERSION)='
  echo "### end"
} 2>&1 | tee "$log"
