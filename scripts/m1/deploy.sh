#!/usr/bin/env bash
# Copy the committed, tracked repository files to /opt/firecrawl-pi on the Pi and
# record the source commit there. There is no git remote (a first push needs a
# full-history scan), so the Pi receives files, not a clone.
#   - refuses to run when a tracked file differs from HEAD, so the recorded commit
#     describes exactly what was copied;
#   - verifies every copied file's SHA-256 on the Pi;
#   - then removes every file under /opt/firecrawl-pi that the archive does not contain
#     (except .fcpi-source-commit), and the directories that leaves empty, so a deploy of
#     an older commit is exactly that commit (evidence/M1/review/REVIEW.md, R16).
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
# The removal below compares newline-separated path lists, so no tracked path may hold one.
[ "$(git ls-tree -r -z --name-only HEAD | tr -cd '\n' | wc -c | tr -d ' ')" = 0 ] || { echo "a tracked path contains a newline" >&2; exit 1; }
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
# Only after every hash is verified: remove what the archive does not contain. The list
# goes over stdin; `comm -23` keeps the paths present on the Pi and absent from the archive.
sed -E 's/^[0-9a-f]{64}  //' "$sums" | LC_ALL=C sort >"$work/list"
"${SSH[@]}" "$PI" "set -o pipefail; l=\$(mktemp) && cat >\"\$l\" && cd $DEST && sudo -n find . -type f ! -path ./.fcpi-source-commit | LC_ALL=C sort | LC_ALL=C comm -23 - \"\$l\"; s=\$?; rm -f \"\$l\"; exit \$s" <"$work/list" >"$work/stale"
"${SSH[@]}" "$PI" "set -e; cd $DEST; while IFS= read -r f; do sudo -n rm -f -- \"\$f\"; echo \"removed \$f\"; done; sudo -n find . -mindepth 1 -type d -empty -print -delete | sed 's/^/removed-dir /'" <"$work/stale"
echo "deployed commit $sha ($(wc -l <"$sums" | tr -d ' ') files, hashes verified, $(wc -l <"$work/stale" | tr -d ' ') stale files removed) to $PI:$DEST"
