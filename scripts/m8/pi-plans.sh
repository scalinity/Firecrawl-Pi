#!/usr/bin/env bash
# The upgrade and rollback plans (FIRECRAWL_PI_SPEC.md §27), ON the Pi, as root, read-only:
#   ssh … 'sudo -n bash /opt/firecrawl-pi/scripts/m8/pi-plans.sh <staged candidate directory>'
# The deployed tree's hash (every file's SHA-256, sorted, hashed), fcpi upgrade --plan against the staged candidate,
# fcpi rollback --plan, and the tree's hash again, each as a JSON line under its own section: the plans change nothing.
set -uo pipefail
. /opt/firecrawl-pi/scripts/ops/lib.sh
need_root
C=${1:?staged candidate directory}
tree() { jq -cn --arg utc "$(utc)" --arg h "$(cd "$REPO" && find . -type f -print0 | sort -z | xargs -0 sha256sum | sha256sum | cut -c1-64)" '{utc:$utc,sha256:$h}'; }
echo "### meta"; echo "utc=$(utc) source_commit=$(source_commit) candidate=$(cat "$C/.fcpi-source-commit")"
echo "### tree"; tree
echo "### upgrade_plan"; bash "$REPO/scripts/ops/plan.sh" upgrade --plan "$C" | jq -c .
echo "### rollback_plan"; bash "$REPO/scripts/ops/plan.sh" rollback --plan | jq -c .
echo "### tree"; tree
echo "### end"
