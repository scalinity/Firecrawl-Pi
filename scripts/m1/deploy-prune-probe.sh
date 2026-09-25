#!/usr/bin/env bash
# Evidence that scripts/m1/deploy.sh removes files the deployed commit does not contain
# (REVIEW.md R16): plant one file and its directory under /opt/firecrawl-pi, deploy HEAD,
# and read what is left. Runs on the workstation; this is the deploy itself, not a copy.
#   scripts/m1/deploy-prune-probe.sh > <evidence file>
set -uo pipefail
root=$(cd "$(dirname "$0")/../.." && pwd)
# shellcheck source=scripts/m1/pi-target.conf
. "$root/scripts/m1/pi-target.conf"
SSH=(ssh -i "$PI_SSH_KEY" -o IdentitiesOnly=yes -o BatchMode=yes -o ConnectTimeout=15 "$PI_SSH_TARGET")
DEST=/opt/firecrawl-pi
PROBE=tests/closeout-stale/probe.txt
sec() { printf '### %s\n' "$1"; }

sec meta
date -u +%Y-%m-%dT%H:%M:%SZ
echo "head=$(git -C "$root" rev-parse HEAD)"
echo "archive_files=$(git -C "$root" ls-tree -r --name-only HEAD | wc -l | tr -d ' ')"
echo "probe_tracked=$(git -C "$root" ls-files --error-unmatch "$PROBE" >/dev/null 2>&1 && echo yes || echo no)"

sec plant
"${SSH[@]}" "sudo -n install -d -m 0755 $DEST/tests/closeout-stale && printf 'not in any commit\n' | sudo -n tee $DEST/$PROBE >/dev/null && echo planted=yes pi_files=\$(sudo -n find $DEST -type f | wc -l)"

sec deploy
bash "$root/scripts/m1/deploy.sh" 2>&1
echo "deploy_exit=$?"

sec after
"${SSH[@]}" "echo stale_file_present=\$(test -e $DEST/$PROBE && echo yes || echo no) stale_dir_present=\$(test -e $DEST/tests/closeout-stale && echo yes || echo no) source_commit=\$(cat $DEST/.fcpi-source-commit) pi_files=\$(sudo -n find $DEST -type f | wc -l)"
echo end
