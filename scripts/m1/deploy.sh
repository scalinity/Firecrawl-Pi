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
# shellcheck source=scripts/m1/pi-target.conf
. "$root/scripts/m1/pi-target.conf"
SSH=(ssh -i "$PI_SSH_KEY" -o IdentitiesOnly=yes -o BatchMode=yes -o ConnectTimeout=15)
PI=$PI_SSH_TARGET
DEST=/opt/firecrawl-pi

cd "$root"
# Code must be committed: the copy is `git archive HEAD`, so an uncommitted change would
# silently not be deployed. Evidence transcripts are excluded, because they are rewritten
# while a verification window is open and never affect what the Pi runs.
git diff --quiet HEAD -- . ':(exclude)evidence' || { echo "tracked files outside evidence/ differ from HEAD; commit first" >&2; exit 1; }
sha=$(git rev-parse HEAD)
# One archive is built, hashed from its own extracted contents, and sent: the hashes the Pi
# checks describe exactly what it received, whatever the working tree holds.
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
git -c tar.umask=0022 archive --format=tar HEAD >"$work/src.tar"
mkdir "$work/tree" && tar -xf "$work/src.tar" -C "$work/tree"
(cd "$work/tree" && find . -type f -print0 | xargs -0 shasum -a 256) >"$work/sums"
sums=$work/sums

"${SSH[@]}" "$PI" "sudo -n install -d -m 0755 -o root -g root $DEST"
"${SSH[@]}" "$PI" "sudo -n tar -x --no-same-owner -f - -C $DEST" <"$work/src.tar"
"${SSH[@]}" "$PI" "cd $DEST && sha256sum --quiet --strict -c - && printf '%s\n' '$sha' | sudo -n tee .fcpi-source-commit >/dev/null" <"$sums"
echo "deployed commit $sha ($(wc -l <"$sums" | tr -d ' ') files, hashes verified) to $PI:$DEST"
