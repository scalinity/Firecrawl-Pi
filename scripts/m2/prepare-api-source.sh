#!/usr/bin/env bash
# Prepare the patched Firecrawl API source: a clean checkout of the pinned upstream commit with
# patches/ applied in order. Each patch file's SHA-256 and the series hash are checked against
# patches/series.json before anything is applied, and the result must be the series' recorded
# tree, so the build input is exactly the reviewed series and nothing else.
#   scripts/m2/prepare-api-source.sh <empty-dest-dir>
set -euo pipefail
root=$(cd "$(dirname "$0")/../.." && pwd)
dest=${1:?usage: prepare-api-source.sh <empty-dest-dir>}
series=$root/patches/series.json
commit=$(jq -r .upstream.commit "$series")
repo=$(jq -r .upstream.repository "$series")
sha() { shasum -a 256 "$1" | cut -c1-64; }

listing=$(jq -r '.patches[] | "\(.sha256)  \(.file)"' "$series")
[ "$(printf '%s\n' "$listing" | shasum -a 256 | cut -c1-64)" = "$(jq -r .series_sha256 "$series")" ] || { echo "series hash differs from patches/series.json" >&2; exit 1; }
while read -r want file; do
  [ "$(sha "$root/patches/$file")" = "$want" ] || { echo "patch $file does not hash to $want" >&2; exit 1; }
done <<<"$listing"

[ ! -e "$dest" ] || [ -z "$(ls -A "$dest")" ] || { echo "$dest is not empty" >&2; exit 1; }
git init -q "$dest"
git -C "$dest" fetch -q --depth 1 "$repo" "$commit"
git -C "$dest" -c advice.detachedHead=false checkout -q FETCH_HEAD
[ "$(git -C "$dest" rev-parse HEAD)" = "$commit" ] || { echo "checkout is not $commit" >&2; exit 1; }
[ -z "$(git -C "$dest" status --porcelain)" ] || { echo "checkout is not clean" >&2; exit 1; }
echo "fcpi-source: upstream=$repo commit=$commit"
while read -r want file; do
  git -C "$dest" apply --check "$root/patches/$file"
  git -C "$dest" apply "$root/patches/$file"
  echo "fcpi-source: applied $file sha256=$want"
done <<<"$listing"
git -C "$dest" add -A
tree=$(git -C "$dest" write-tree)
[ "$tree" = "$(jq -r .result_tree "$series")" ] || { echo "patched tree $tree differs from the series' result tree" >&2; exit 1; }
echo "fcpi-source: result_tree=$tree series_sha256=$(jq -r .series_sha256 "$series")"
