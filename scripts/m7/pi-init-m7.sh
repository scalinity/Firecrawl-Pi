#!/usr/bin/env bash
# M7 host initialisation, beside scripts/m1-m6's. Runs ON the Pi from the deployed copy:
#   ssh … 'bash /opt/firecrawl-pi/scripts/m7/pi-init-m7.sh'
# Idempotent, in M5's and M6's manner: creates what is missing, never overwrites a secret, stops on a half-created pair
# rather than repairing it, and prints names, owners, modes and hashes of nothing secret.
#   - the fixture enhanced provider's key: in the provider directory for the retrieval service (uid 3310), its SHA-256
#     for fixture-m7 (uid 8080), both from one generated value. Zyte's own key is placed only by
#     scripts/m5/pi-provider-key.sh, and a key present is not an authorization to spend (CLAUDE.md §11);
#   - the webhook signing secret: one generated value in two files, the retrieval service's (uid 3310), which signs every
#     delivery, and fixture-m7's (uid 8080), whose receiver verifies with its own copy, as any receiver must hold one.
# No unit file, guard rule or network changes: M7 needs no new egress (its fixtures are on the internal fixture network).
set -euo pipefail
export LC_ALL=C
export PATH="/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"
umask 077
REPO=/opt/firecrawl-pi
ETC=/etc/firecrawl-pi
S=$ETC/secrets
P=$S/providers

sec() { printf '### %s\n' "$1"; }
die() { echo "pi-init-m7: STOP: $*" >&2; exit 1; }
exists() { sudo -n test -e "$1"; }
TMPS=()
trap 'for t in "${TMPS[@]}"; do sudo -n rm -f -- "$t"; done' EXIT
put() { # put <path> <owner> <mode>: write stdin to <path> atomically, only if <path> is absent
  if exists "$1"; then cat >/dev/null; echo "kept    $1"; return; fi
  local tmp; tmp=$(sudo -n mktemp "$(dirname "$1")/.fcpi-tmp.XXXXXX"); TMPS+=("$tmp")
  sudo -n tee "$tmp" >/dev/null
  sudo -n chown "$2" "$tmp" && sudo -n chmod "$3" "$tmp"
  if sudo -n ln -- "$tmp" "$1" 2>/dev/null; then echo "created $1"; else echo "kept    $1 (appeared meanwhile)"; fi
  sudo -n rm -f -- "$tmp"
}
hex() { head -c "$1" /dev/urandom | od -An -tx1 | tr -d ' \n'; }

sec meta
echo "utc=$(date -u +%Y-%m-%dT%H:%M:%SZ) source_commit=$(cat $REPO/.fcpi-source-commit 2>/dev/null)"
exists $P || die "$P is absent: run scripts/m5/pi-init-m5.sh first"

sec secrets
# The fixture enhanced provider's key and its SHA-256.
A=$P/fixture_zyte B=$S/fixture_zyte_sha256
if ! exists $A && ! exists $B; then
  v="fcpi-fixture-zyte-$(hex 32)"
  printf '%s' "$v" | put $A 3310:3310 0600
  printf 'sha256:%s\n' "$(printf '%s' "$v" | sha256sum | cut -c1-64)" | put $B 8080:8080 0600
  unset v
elif exists $A && exists $B; then echo "kept    $A and $B"
else die "$A and $B must exist together"; fi
[ "sha256:$(sudo -n cat $A | tr -d '\n' | sha256sum | cut -c1-64)" = "$(sudo -n cat $B | tr -d '\n')" ] || die "$A and $B do not match"
echo "fixture_zyte_pair=match"
# The webhook signing secret, one value in two files.
W=$S/webhook_signing_secret F=$S/fixture_webhook_secret
if ! exists $W && ! exists $F; then
  v=$(hex 32)
  printf '%s\n' "$v" | put $W 3310:3310 0600
  printf '%s\n' "$v" | put $F 8080:8080 0600
  unset v
elif exists $W && exists $F; then echo "kept    $W and $F"
else die "$W and $F must exist together"; fi
sudo -n cmp -s $W $F || die "$W and $F do not hold the same value"
echo "webhook_secret_pair=match"

sec clients
# Two evidence clients of two principals, so owner scoping (artifacts, the cache, page versions, the parse cache) is
# shown between principals; each is created once and kept. Every scope, as M6's evidence clients had.
all=$(jq -r '.scopes | join(",")' $REPO/deploy/policies/capabilities.json)
for c in m7 m7other; do
  if bash $REPO/scripts/m3/pi-client-token.sh list | awk '{print $1}' | grep -x "$c" >/dev/null; then echo "kept    client $c"
  else
    bash $REPO/scripts/m3/pi-client-token.sh create "$c" "$c" "$all" >/dev/null || die "creating client $c failed"
    echo "created client $c"
  fi
done

sec inventory
sudo -n sh -c "stat -c '%u:%g %a %n' $A $B $W $F"
echo "providers_present=$(sudo -n ls -A $P | tr '\n' ' ')"
echo end
