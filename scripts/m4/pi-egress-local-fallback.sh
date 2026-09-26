#!/usr/bin/env bash
# F8's proof, ON the Pi: fcpi-egress-local.sh with no connected network, run inside a throwaway network
# namespace, which has its own nftables ruleset, so the host's is never touched. For the installed copy
# and the deployed one: the guard loads there with its egress_local_v4 set empty (the control), the
# script runs, and the set must then hold exactly the IPv4 networks the recorded file names. Last, the
# host's own set against the same file. Networks appear only as a count and a SHA-256 of the sorted
# list. Changes nothing on the host.   ssh … 'bash -s' < scripts/m4/pi-egress-local-fallback.sh
set -uo pipefail
export LC_ALL=C
export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
REPO=/opt/firecrawl-pi
ETC=/etc/firecrawl-pi
FILE=$ETC/egress-local/egress-local.cidrs
sec() { printf '### %s\n' "$1"; }
# A set's or file's IPv4 networks, one per line, sorted, a /32 written as the bare address as nft prints it.
norm() { sed -E 's#/32$##' | grep -E '^[0-9]{1,3}(\.[0-9]{1,3}){3}(/[0-9]{1,2})?$' | sort -u; }
digest() { sha256sum | cut -c1-64; }
elements() { tr -d '\n' | grep -o 'elements = {[^}]*}' | sed -E 's/^elements = \{ *//; s/ *\}$//' | tr ',' '\n' | tr -d ' ' | norm; }

sec meta
echo "utc=$(date -u +%Y-%m-%dT%H:%M:%SZ) source_commit=$(cat $REPO/.fcpi-source-commit)"
inst=$(sha256sum <$ETC/fcpi-egress-local.sh | cut -c1-64); repo=$(sha256sum <$REPO/deploy/host/fcpi-egress-local.sh | cut -c1-64)
echo "installed_sha256=$inst deployed_sha256=$repo installed_is_deployed=$([ "$inst" = "$repo" ] && echo yes || echo no)"

sec recorded
rec=$(norm <"$FILE")
echo "file_written=$(sed -n '1s/^# written by fcpi-egress-local.sh at \([^;]*\);.*/\1/p' "$FILE") ipv4_count=$(printf '%s\n' "$rec" | grep -c .) ipv4_sha256=$(printf '%s\n' "$rec" | digest)"

sec namespace_runs
for which in installed deployed; do
  script=$ETC/fcpi-egress-local.sh; [ $which = deployed ] && script=$REPO/deploy/host/fcpi-egress-local.sh
  out=$(sudo -n unshare -n sh -c "
    nft -f $ETC/fcpi-guard.nft || { echo guard_load=failed; exit 0; }
    echo connected_routes=\$(ip -4 -o route show table main scope link | grep -c . || true)
    echo before=\$(nft list set inet fcpi_guard egress_local_v4 | tr -d '\n' | grep -c 'elements = ' || true)
    msg=\$($script 2>&1); echo exit=\$?; echo \"message=\$msg\" | head -1
    echo '---set'; nft list set inet fcpi_guard egress_local_v4" 2>&1)
  after=$(printf '%s\n' "$out" | sed -n '/^---set$/,$p' | elements)
  printf '%s\n' "$out" | sed -n '/^---set$/q;p' | tr '\n' ' ' | sed "s/^/which=$which /; s/ $//"
  echo " after_count=$(printf '%s\n' "$after" | grep -c .) after_sha256=$(printf '%s\n' "$after" | digest) matches_recorded=$([ -n "$after" ] && [ "$after" = "$rec" ] && echo yes || echo no)"
done

sec host_set
host=$(sudo -n nft list set inet fcpi_guard egress_local_v4 | elements)
echo "count=$(printf '%s\n' "$host" | grep -c .) sha256=$(printf '%s\n' "$host" | digest) matches_recorded=$([ -n "$host" ] && [ "$host" = "$rec" ] && echo yes || echo no)"

echo end
