#!/usr/bin/env bash
# Compare the BEFORE and AFTER snapshots. Exit 0 only when they are identical
# apart from this audit's own SSH session.
#
# Excluded, because they are the audit's own connection rather than host state:
#   - the `meta` section (timestamp; boot ID is checked separately below);
#   - `session-<n>.scope` units, one per SSH login.
set -euo pipefail
root=$(cd "$(dirname "$0")/../.." && pwd)
before="$root/evidence/M0/snapshot-before.txt"
after="$root/evidence/M0/snapshot-after.txt"
out="$root/evidence/M0/snapshot-diff.txt"

strip() {
  awk '/^### /{skip=($2=="meta")} !skip' "$1" | grep -Ev '^session-[0-9]+\.scope$'
}
boot() { grep '^boot_id_sha256=' "$1"; }

{
  echo "# M0 BEFORE/AFTER snapshot diff"
  echo "# before: $(sed -n 2p "$before")  after: $(sed -n 2p "$after")"
  echo "# excluded: meta section, session-<n>.scope units (the audit's own SSH logins)"
  if [ "$(boot "$before")" = "$(boot "$after")" ]; then echo "# boot_id: unchanged (no reboot)"; else echo "# boot_id: CHANGED"; fi
  diff <(strip "$before") <(strip "$after") || true
} >"$out"

if [ "$(boot "$before")" = "$(boot "$after")" ] && diff -q <(strip "$before") <(strip "$after") >/dev/null; then
  echo "EMPTY"; exit 0
else
  echo "NON-EMPTY: see $out"; exit 1
fi
