#!/usr/bin/env bash
# Compare the BEFORE and AFTER snapshots. Exit 0 only when they are identical
# apart from this audit's own SSH session.
#
# Lines are compared keyed by section name and sorted, so a snapshot script
# that reorders its sections cannot produce a false difference.
# Excluded, because they are the audit's own connection rather than host state:
#   - the `meta` section (timestamp; boot ID is checked separately below);
#   - `session-<n>.scope` units, one per SSH login.
set -euo pipefail
root=$(cd "$(dirname "$0")/../.." && pwd)
before="$root/evidence/M0/snapshot-before.txt"
after="$root/evidence/M0/snapshot-after.txt"
out="$root/evidence/M0/snapshot-diff.txt"

keyed() {
  awk '/^### /{sec=$2; next} sec!="" && sec!="meta" {print sec "\t" $0}' "$1" \
    | grep -Ev $'\tsession-[0-9]+\\.scope$' | LC_ALL=C sort
}
# A boot ID only counts as unchanged when both snapshots carry a well-formed hash.
boot() { grep -E '^boot_id_sha256=[0-9a-f]{64}$' "$1" || echo "MISSING"; }
bb=$(boot "$before"); ba=$(boot "$after")
if [ "$bb" != MISSING ] && [ "$bb" = "$ba" ]; then boot_ok=1; else boot_ok=0; fi

{
  echo "# M0 BEFORE/AFTER snapshot diff (section-keyed, sorted)"
  echo "# before: $(sed -n 2p "$before")  after: $(sed -n 2p "$after")"
  echo "# excluded: meta section, session-<n>.scope units (the audit's own SSH logins)"
  if [ "$boot_ok" = 1 ]; then echo "# boot_id: unchanged (no reboot)"; else echo "# boot_id: CHANGED or MISSING (before=$bb after=$ba)"; fi
  diff <(keyed "$before") <(keyed "$after") || true
} >"$out"

if [ "$boot_ok" = 1 ] && diff -q <(keyed "$before") <(keyed "$after") >/dev/null; then
  echo "EMPTY"; exit 0
else
  echo "NON-EMPTY: see $out"; exit 1
fi
