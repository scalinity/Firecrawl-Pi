#!/usr/bin/env bash
# M8's suites ON the Pi, inside the images the stack runs: M7's runner unchanged (scripts/m7/pi-suites.sh: the retrieval
# service's suite, whose test/*.test.mjs now includes M8's host-admission tests, the gateway ledger's migrations and
# SQL, the gateway's suites, then M4's runner with M3's contract suite, which now includes M8's HOST_PRESSURE test),
# then every host operations script parsed by bash -n (scripts/fcpi, scripts/ops/*.sh, scripts/m8/*.sh).
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
echo "### end"
echo end
