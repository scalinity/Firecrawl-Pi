#!/usr/bin/env bash
# SI3's native chain on the workstation (docs/FIRECRAWL_PI_SEARCH_INTELLIGENCE_SPEC.md §19.2): the compiled search code of the
# patched core image (fcpi/firecrawl-api:m2, built with patch 0011 by scripts/m2/build-api-image.sh) against the real retrieval
# coordinator on fixture providers, both in one throwaway container: no network (loopback only), read-only root, removed on
# exit. Prints the run's record: a meta section, then native-chain.mjs's JSON. Needs the Colima Docker context running.
#   scripts/si3/native-chain.sh > evidence/search-intelligence/SI3/native-chain.txt
set -euo pipefail
root=$(cd "$(dirname "$0")/../.." && pwd)
image=fcpi/firecrawl-api:m2
# Colima shares only the home directory with its VM, so the layout is staged there.
work=$(mktemp -d "$HOME/.cache/fcpi-si3-chain.XXXXXX")
trap 'rm -rf "$work"' EXIT
r=$root/services/retrieval
cp -R "$r/src" "$r/test" "$r/package.json" "$r/node_modules" "$work/"
cp -R "$root/deploy/policies" "$work/policy"
cp -R "$root/tests/fixtures" "$work/fixtures"
cp "$root/scripts/si3/native-chain.mjs" "$work/"
# The frozen corpus's queries, for the term rule shared by the core and the retrieval service.
cp "$root/evidence/search-intelligence/SI0/corpus/corpus-v1.json" "$work/"
echo "### meta"
echo "utc=$(date -u +%Y-%m-%dT%H:%M:%SZ)"
echo "repository_commit=$(git -C "$root" rev-parse HEAD) code_dirty=$([ -z "$(git -C "$root" status --porcelain -- . ':(exclude)evidence')" ] && echo false || echo true)"
echo "image=$image id=$(docker image inspect "$image" --format '{{.Id}}') platform=$(docker image inspect "$image" --format '{{.Os}}/{{.Architecture}}')"
echo "patch_series_sha256=$(jq -r .series_sha256 "$root/patches/series.json")"
echo "### checks"
set +e
# Hardened as the project's other throwaway runs are (CLAUDE.md §33.1): no capabilities, no privilege gain, an unprivileged
# uid, bounded memory and processes.
docker run --rm --network none --read-only --tmpfs /tmp:size=64m --label fcpi.transient=si3-native-chain \
  --cap-drop ALL --security-opt no-new-privileges --user 65534:65534 --memory 1g --pids-limit 256 \
  -v "$work:/si:ro" -w /si --entrypoint node "$image" /si/native-chain.mjs
status=$?
set -e
echo "### exit"
echo "status=$status"
exit "$status"
