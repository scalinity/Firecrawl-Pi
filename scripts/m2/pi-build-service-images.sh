#!/usr/bin/env bash
# Build the retrieval service and browser worker images on the Pi from the deployed commit.
# Both are thin: a digest-pinned base (the gateway's Node image; Playwright 1.63.0's image, which
# the Pi already holds from the browser proof) plus dependencies npm ci installs from a lockfile
# with integrity hashes and install scripts off, and the service's own files. Nothing compiles, so
# the build runs beside the stack, as M1's NuQ build did. The patched API image, the one heavy
# build, is built on the workstation (decision D6; scripts/m2/build-api-image.sh).
#   ssh … 'bash -s -- [retrieval] [browser]' < scripts/m2/pi-build-service-images.sh
set -euo pipefail
export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
REPO=/opt/firecrawl-pi
sec() { printf '### %s\n' "$1"; }
mem() { awk '/^MemAvailable:/ {printf "%d", $2/1024}' /proc/meminfo; }

sec meta
echo "utc=$(date -u +%Y-%m-%dT%H:%M:%SZ)"
echo "source_commit=$(cat $REPO/.fcpi-source-commit)"
echo "builder=$(sudo -n docker buildx version)"
echo "mem_available_mib_before=$(mem)"

build() { # build <name> <tag> <context> [dockerfile]
  sec "build_$1"
  local start rc
  start=$(date +%s)
  set +e
  sudo -n docker buildx build --platform linux/arm64 --progress=plain --provenance=false --sbom=false \
    ${4:+-f "$4"} --load -t "$2" "$3" 2>&1
  rc=$?
  set -e
  echo "build_exit=$rc elapsed_s=$(( $(date +%s) - start )) mem_available_mib=$(mem)"
  [ "$rc" = 0 ] || exit "$rc"
}
# Both by default; `retrieval` or `browser` as arguments builds only those.
want=" ${*:-retrieval browser} "
[[ $want == *" retrieval "* ]] && build retrieval fcpi/retrieval:m2 $REPO/services/retrieval
[[ $want == *" browser "* ]] && build browser fcpi/browser:m2 $REPO/services/browser $REPO/deploy/browser/Dockerfile

sec images
for t in fcpi/retrieval:m2 fcpi/browser:m2; do
  sudo -n docker image inspect "$t" --format "$t id={{.Id}} os={{.Os}} arch={{.Architecture}} size={{.Size}} user={{.Config.User}}"
done
echo "leftover_transient_containers=$(sudo -n docker ps -a --filter label=fcpi.transient --format '{{.ID}}' | wc -l)"
sec end
echo end
