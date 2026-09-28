#!/usr/bin/env bash
# Stage a candidate tree on the Pi for fcpi upgrade --plan (FIRECRAWL_PI_SPEC.md §27): `git archive <commit>` sent to
# /opt/firecrawl-pi-candidate/<commit 12>/ with every file's SHA-256 verified there and the commit recorded, as
# scripts/m1/deploy.sh sends a deployment. It changes nothing that runs: the deployed tree, the units and the stack are
# untouched, and the candidate directory is replaced whole each time.
#   scripts/m8/stage.sh <commit>
set -euo pipefail
root=$(cd "$(dirname "$0")/../.." && pwd)
# shellcheck source=scripts/m1/pi-target.conf
. "$root/scripts/m1/pi-target.conf"
SSH=(ssh -i "$PI_SSH_KEY" -o IdentitiesOnly=yes -o BatchMode=yes -o ConnectTimeout=15 "$PI_SSH_TARGET")
sha=$(git -C "$root" rev-parse --verify "${1:?usage: stage.sh <commit>}^{commit}")
D=/opt/firecrawl-pi-candidate/${sha:0:12}
work=$(mktemp -d); trap 'rm -rf "$work"' EXIT
git -C "$root" -c tar.umask=0022 archive --format=tar "$sha" >"$work/src.tar"
mkdir "$work/tree" && tar -xf "$work/src.tar" -C "$work/tree"
(cd "$work/tree" && find . -type f -print0 | xargs -0 shasum -a 256) >"$work/sums"
"${SSH[@]}" "sudo -n rm -rf $D && sudo -n install -d -m 0755 -o root -g root $D"
"${SSH[@]}" "sudo -n tar -x --no-same-owner -f - -C $D" <"$work/src.tar"
"${SSH[@]}" "cd $D && sha256sum --quiet --strict -c -" <"$work/sums"
"${SSH[@]}" "printf '%s\n' '$sha' | sudo -n tee $D/.fcpi-source-commit >/dev/null"
echo "staged candidate $sha ($(wc -l <"$work/sums" | tr -d ' ') files, hashes verified) at $D"
