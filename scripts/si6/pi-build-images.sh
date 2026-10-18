#!/usr/bin/env bash
# Build the three service images the search intelligence release changes (the retrieval service, the access gateway, the MCP
# gateway) on the Pi from a staged candidate tree (scripts/m8/stage.sh <commit>: git archive of the release commit, every hash
# verified), as scripts/m7/pi-build-images.sh builds from the deployed one. Building from the candidate leaves the deployed tree,
# its policies and the running stack untouched until the deploy that immediately precedes the cutover. Each image is tagged
# fcpi/<name>:si6, so no tag a running pin resolves through (the :m7 tags, the browser worker's among them) moves; the browser
# worker is unchanged and not rebuilt. Each builds FROM its digest-pinned base, packages from its lockfile by npm ci with
# integrity checks and install scripts off, the candidate's commit recorded in it.
#   ssh … 'bash -s -- /opt/firecrawl-pi-candidate/<commit 12>' < scripts/si6/pi-build-images.sh
set -euo pipefail
export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
TREE=${1:?usage: pi-build-images.sh <staged candidate tree>}
[[ $TREE =~ ^/opt/firecrawl-pi-candidate/[0-9a-f]{12}$ ]] || { echo "not a staged candidate tree: $TREE" >&2; exit 2; }
sec() { printf '### %s\n' "$1"; }
mem() { awk '/^MemAvailable:/ {printf "%d", $2/1024}' /proc/meminfo; }
commit=$(cat "$TREE/.fcpi-source-commit")
[[ $commit =~ ^[0-9a-f]{40}$ ]] && [ "${commit:0:12}" = "${TREE##*/}" ] || { echo "the candidate records no matching commit" >&2; exit 1; }
sec meta
echo "utc=$(date -u +%Y-%m-%dT%H:%M:%SZ)"
echo "source_commit=$commit tree=$TREE"
echo "builder=$(sudo -n docker buildx version </dev/null)"
echo "mem_available_mib_before=$(mem)"
build() { # build <image name> <context>
  sec "build_$1"
  local start rc
  start=$(date +%s)
  set +e
  sudo -n docker buildx build --platform linux/arm64 --progress=plain --provenance=false --sbom=false \
    --build-arg FCPI_SOURCE_COMMIT="$commit" --load -t "fcpi/$1:si6" "$2" </dev/null 2>&1
  rc=$?
  set -e
  echo "build_exit=$rc image=fcpi/$1:si6 elapsed_s=$(( $(date +%s) - start )) mem_available_mib=$(mem)"
  [ "$rc" = 0 ] || exit "$rc"
}
build retrieval "$TREE/services/retrieval"
build access-gateway "$TREE/services/access"
build mcp-gateway "$TREE/services/mcp"
sec images
for i in retrieval access-gateway mcp-gateway; do
  sudo -n docker image inspect "fcpi/$i:si6" --format "fcpi/$i:si6 id={{.Id}} os={{.Os}} arch={{.Architecture}} size={{.Size}} user={{.Config.User}}" </dev/null
  sudo -n docker image inspect "fcpi/$i:si6" --format '{{range .Config.Env}}{{println .}}{{end}}' </dev/null | grep '^FCPI_SOURCE_COMMIT=' | sed "s#^#fcpi/$i:si6 #"
done
echo end
