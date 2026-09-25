#!/usr/bin/env bash
# Network sections appended to M0's snapshot (scripts/m0/pi-snapshot.sh) by
# scripts/m1/snapshot.sh: the nftables table and chain list, where M0's snapshot records
# only a hash of the ruleset, and the kernel's forwarding switches
# (evidence/M1/review/REVIEW.md, R8). Runs ON the Pi through `ssh ... bash -s`; read-only,
# prints to stdout only. nft is queried only if nf_tables is already loaded, so listing
# can never load a netfilter module.
set -u
export LC_ALL=C
export PATH="/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"
sec() { printf '### %s\n' "$1"; }
loaded() { lsmod | awk '{print $1}' | grep -qx nf_tables; }

sec nft_tables
if loaded; then sudo -n nft list tables | sort; else echo "SKIPPED nf_tables module not loaded"; fi

sec nft_chains
if loaded; then
  sudo -n nft -j list chains | jq -r '.nftables[] | select(.chain) | .chain
    | "\(.family) \(.table) \(.name) hook=\(.hook // "-") prio=\(.prio // "-") policy=\(.policy // "-")"' | sort
else
  echo "SKIPPED nf_tables module not loaded"
fi

sec forwarding
for f in /proc/sys/net/ipv4/ip_forward /proc/sys/net/ipv6/conf/all/forwarding /proc/sys/net/ipv6/conf/default/forwarding; do
  printf '%s=%s\n' "$f" "$(cat "$f")"
done
echo "end"
