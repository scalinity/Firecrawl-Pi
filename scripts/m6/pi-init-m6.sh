#!/usr/bin/env bash
# M6 host initialisation, beside scripts/m1-m5's. Runs ON the Pi from the deployed copy:
#   ssh … 'bash /opt/firecrawl-pi/scripts/m6/pi-init-m6.sh'
# Idempotent, in M5's manner: creates what is missing, never overwrites a secret, stops on a half-created pair
# rather than repairing it, and prints names, owners, modes and hashes of nothing secret.
#   - the fixture proxy's credential: "fcpi_fixture:<hex>" in the provider directory for the retrieval service
#     (uid 3310), its SHA-256 for fixture-m6 (uid 8080), both from one generated value. A real provider's
#     credential is placed only by scripts/m5/pi-provider-key.sh, and a key present is not an authorization to
#     spend (CLAUDE.md §11);
#   - the guard with M6's proxy-port rule (deploy/host/fcpi-guard.nft), checked with nft -c, installed if it
#     changed and loaded now, then the host-networks set refilled. No unit file changes, so no systemctl
#     daemon-reload runs: a reload lifts every running container's swap limit (evidence/M4/review/REVIEW.md, F2).
set -euo pipefail
export LC_ALL=C
export PATH="/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"
umask 077
REPO=/opt/firecrawl-pi
ETC=/etc/firecrawl-pi
S=$ETC/secrets
P=$S/providers

sec() { printf '### %s\n' "$1"; }
die() { echo "pi-init-m6: STOP: $*" >&2; exit 1; }
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
install_if_changed() { # install_if_changed <source> <target> <mode>
  if ! sudo -n cmp -s "$1" "$2"; then sudo -n install -m "$3" -o root -g root "$1" "$2"; echo "installed $2"; else echo "kept    $2"; fi
}

sec meta
echo "utc=$(date -u +%Y-%m-%dT%H:%M:%SZ) source_commit=$(cat $REPO/.fcpi-source-commit 2>/dev/null)"
exists $P || die "$P is absent: run scripts/m5/pi-init-m5.sh first"

sec secrets
A=$P/fixture_proxy B=$S/fixture_proxy_sha256
if ! exists $A && ! exists $B; then
  v="fcpi_fixture:$(head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n')"
  printf '%s' "$v" | put $A 3310:3310 0600
  printf 'sha256:%s\n' "$(printf '%s' "$v" | sha256sum | cut -c1-64)" | put $B 8080:8080 0600
  unset v
elif exists $A && exists $B; then
  echo "kept    $A and $B"
else
  die "$A and $B must exist together"
fi
# The pair must still agree (a copy replaced by hand would make every fixture tunnel a 407).
[ "sha256:$(sudo -n cat $A | tr -d '\n' | sha256sum | cut -c1-64)" = "$(sudo -n cat $B | tr -d '\n')" ] || die "$A and $B do not match"
echo "fixture_proxy_pair=match"

sec guard
sudo -n /usr/sbin/nft -c -f $REPO/deploy/host/fcpi-guard.nft || die "deploy/host/fcpi-guard.nft does not parse"
install_if_changed $REPO/deploy/host/fcpi-guard.nft $ETC/fcpi-guard.nft 0644
# The load replaces the table in one transaction (and resets its counters); the host-networks set is refilled at once.
sudo -n /usr/sbin/nft -f $ETC/fcpi-guard.nft || die "loading inet fcpi_guard failed"
sudo -n $ETC/fcpi-egress-local.sh || die "fcpi-egress-local.sh failed"
echo "guard_rules=$(sudo -n nft -j list table inet fcpi_guard | jq '[.nftables[] | select(.rule)] | length') proxy_rule=$(sudo -n nft list table inet fcpi_guard | grep -c 'egress_proxy_accepted') local_v4_elements=$(sudo -n nft -j list set inet fcpi_guard egress_local_v4 | jq '[.nftables[] | select(.set) | .set.elem // [] | length] | add') handle=$(sudo -n nft -a list table inet fcpi_guard | sed -n '1s/.*# handle \([0-9]*\).*/\1/p')"

sec inventory
sudo -n sh -c "stat -c '%u:%g %a %n' $A $B $ETC/fcpi-guard.nft"
echo "providers_present=$(sudo -n ls -A $P | tr '\n' ' ')"
echo end
