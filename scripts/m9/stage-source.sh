#!/usr/bin/env bash
# Stage only committed main history in a project-owned isolated mirror on the Pi.
# This never rewrites the Mac repo, remote, or another session's worktree.
set -euo pipefail
root=$(cd "$(dirname "$0")/../.." && pwd)
. "$root/scripts/m1/pi-target.conf"
cd "$root"
[ "$(git branch --show-current)" = main ] || exit 2
git diff --quiet HEAD -- . ':(exclude)evidence' || exit 2
sha=$(git rev-parse HEAD); t=$(mktemp); trap 'rm -f "$t"' EXIT
# The repository already contains the source history; the bundle is transferred
# privately and is never an evidence artifact or an external publication.
git bundle create "$t" main >/dev/null
ssh -i "$PI_SSH_KEY" -o IdentitiesOnly=yes -o BatchMode=yes "$PI_SSH_TARGET" "sudo -n bash -c 'set -e; d=/var/lib/firecrawl-pi/incidents; t=\$(mktemp); trap \"rm -f \\\"\$t\\\"\" EXIT; cat >\"\$t\"; [ -d \"\$d/source.git\" ] || git init --bare \"\$d/source.git\" >/dev/null; git --git-dir=\"\$d/source.git\" fetch \"\$t\" refs/heads/main:refs/heads/main; git --git-dir=\"\$d/source.git\" cat-file -e $sha^{commit}; chmod -R go-rwx \"\$d/source.git\"'" <"$t"
echo "staged_source_sha=$sha"
