#!/usr/bin/env bash
# Copy the committed, tracked repository files to /opt/firecrawl-pi on the Pi and
# record the source commit there. There is no git remote (a first push needs a
# full-history scan), so the Pi receives files, not a clone.
#   - refuses to run when a tracked file differs from HEAD, so the recorded commit
#     describes exactly what was copied;
#   - verifies every copied file's SHA-256 on the Pi;
#   - never deletes on the Pi: a file dropped from Git stays until removed by name.
# Transport is `git archive HEAD` through tar: macOS ships openrsync (protocol 29),
# which lacks --from0 and --chown, and the archive is exactly the tracked files at HEAD.
set -euo pipefail
root=$(cd "$(dirname "$0")/../.." && pwd)
SSH=(ssh -i "$HOME/.ssh/pi" -o IdentitiesOnly=yes -o BatchMode=yes -o ConnectTimeout=15)
PI=danny@pi.local
DEST=/opt/firecrawl-pi

cd "$root"
git diff --quiet HEAD -- || { echo "tracked files differ from HEAD; commit first" >&2; exit 1; }
sha=$(git rev-parse HEAD)
sums=$(mktemp)
trap 'rm -f "$sums"' EXIT
git ls-files -z | xargs -0 shasum -a 256 >"$sums"

"${SSH[@]}" "$PI" "sudo -n install -d -m 0755 -o root -g root $DEST"
git archive --format=tar HEAD | "${SSH[@]}" "$PI" "sudo -n tar -x --no-same-owner -f - -C $DEST"
"${SSH[@]}" "$PI" "cd $DEST && sha256sum --quiet --strict -c - && printf '%s\n' '$sha' | sudo -n tee .fcpi-source-commit >/dev/null" <"$sums"
echo "deployed commit $sha ($(wc -l <"$sums" | tr -d ' ') files, hashes verified) to $PI:$DEST"
