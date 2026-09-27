#!/usr/bin/env bash
# The patched API image of record for M7 (patch 0010): built from a clean tree on the workstation's Colima VM with every
# step run (scripts/m2/build-api-image.sh --no-cache, decision D6), carried to the Pi (scripts/m5/push-api-image.sh),
# and pinned in deploy/compose.yaml by the image id the Pi now holds, committed alone with a build(m7) message. Colima
# must already be running (CLAUDE.md §33.7: whoever started it stops it). Writes evidence/M7/raw/api-build.log and
# evidence/M7/raw/api-push.txt.
#   scripts/m7/api-image.sh
set -euo pipefail
root=$(cd "$(dirname "$0")/../.." && pwd)
[ -z "$(git -C "$root" status --porcelain -- . ':(exclude)evidence')" ] || { echo "the tree has uncommitted changes outside evidence/: the build of record needs a clean tree" >&2; exit 1; }
colima status >/dev/null 2>&1 || { echo "Colima is not running (start it bare, and stop it after if you started it)" >&2; exit 1; }
R=$root/evidence/M7/raw
mkdir -p "$R"
"$root/scripts/m2/build-api-image.sh" "$R/api-build.log" --no-cache >/dev/null
grep -q '^build_exit=0 ' "$R/api-build.log" || { echo "the API build failed; see $R/api-build.log" >&2; exit 1; }
"$root/scripts/m5/push-api-image.sh" "$R/api-build.log" >"$R/api-push.txt"
id=$(sed -n 's/^id=\(sha256:[0-9a-f]\{64\}\) os=linux arch=arm64 .*/\1/p' "$R/api-build.log")
sed -i '' -E "s#fcpi/firecrawl-api@sha256:[0-9a-f]{64}#fcpi/firecrawl-api@$id#" "$root/deploy/compose.yaml"
echo "firecrawl-api -> $id"
if git -C "$root" diff --quiet -- deploy/compose.yaml; then echo "digest unchanged"; exit 0; fi
git -C "$root" add deploy/compose.yaml
git -C "$root" commit -q -m "build(m7): run the API image built with patch series $(jq -r '.series_sha256[0:8]' "$root/patches/series.json")"
