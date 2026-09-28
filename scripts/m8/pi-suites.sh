#!/usr/bin/env bash
# M8's suites ON the Pi, inside the images the stack runs: M7's runner unchanged (scripts/m7/pi-suites.sh: the retrieval
# service's suite, whose test/*.test.mjs now includes M8's host-admission tests, the gateway ledger's migrations and
# SQL, the gateway's suites, then M4's runner with M3's contract suite, which now includes M8's HOST_PRESSURE test),
# then every host operations script parsed by bash -n (scripts/fcpi, scripts/ops/*.sh, scripts/m8/*.sh), then the restore
# test's transformation checked against the Compose file the Pi renders.
#   ssh … 'bash -s' < scripts/m8/pi-suites.sh      (fcpi verify services runs it too)
set -uo pipefail
export LC_ALL=C PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
REPO=/opt/firecrawl-pi
bash "$REPO/scripts/m7/pi-suites.sh" | sed -e '/^### end$/d' -e '/^end$/d'
echo "### ops_syntax"
bad=0 n=0
for f in "$REPO/scripts/fcpi" "$REPO"/scripts/ops/*.sh "$REPO"/scripts/m8/*.sh; do
  n=$((n + 1)); if ! out=$(bash -n "$f" 2>&1); then bad=$((bad + 1)); echo "not ok ${f#$REPO/}: $out"; else echo "ok ${f#$REPO/}"; fi
done
echo "files=$n failed=$bad"
echo "test_exit=$([ $bad = 0 ] && echo 0 || echo 1)"
# The restore test's transformation (scripts/ops/restore.jq) on the Compose file the Pi renders now: the copy names no
# host path outside its directory, while production's own file, the positive control, names many.
echo "### restore_isolation"
R=/srv/firecrawl-pi/restore-test
rendered=$(sudo -n docker compose -p fcpi -f "$REPO/deploy/compose.yaml" config --format json 2>/dev/null)
prod=$(jq -L "$REPO/scripts/ops" --arg R "$R" 'include "restore"; outside($R) | length' <<<"$rendered" 2>/dev/null)
copy=$(jq -L "$REPO/scripts/ops" --arg R "$R" 'include "restore"; compose($R) | outside($R) | length' <<<"$rendered" 2>/dev/null)
echo "outside_production=${prod:-none} outside_copy=${copy:-none}"
echo "test_exit=$([ "${copy:-x}" = 0 ] && [ "${prod:-0}" -gt 10 ] && echo 0 || echo 1)"
echo "### end"
echo end
