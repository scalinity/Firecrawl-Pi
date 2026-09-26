#!/usr/bin/env bash
# M2 host initialisation, beside scripts/m1/pi-init.sh (which it does not replace). Runs ON the Pi
# from the deployed copy:  ssh … 'bash /opt/firecrawl-pi/scripts/m2/pi-init-m2.sh'
# Idempotent, in M1's manner: creates what is missing, never overwrites a secret, stops on a
# half-created pair rather than repairing it, and prints names, owners and modes only.
#   - secrets: the retrieval service's PostgreSQL password (with the initdb copy), the core's
#     credential for the retrieval service (the service holds only its SHA-256), and the retrieval
#     service's credential for the browser worker (the worker holds only its SHA-256);
#   - the guard, with its fcpi-egress rules, checked with nft -c and installed under
#     /etc/firecrawl-pi, and the host-networks script, installed there too; the dockerd drop-in
#     that runs the script after the guard loads; the stack unit, which runs it too;
#   - the host-networks list, generated now, so the retrieval service's bind mount has a source.
set -euo pipefail
export LC_ALL=C
export PATH="/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"
umask 077
REPO=/opt/firecrawl-pi
ETC=/etc/firecrawl-pi
S=$ETC/secrets

sec() { printf '### %s\n' "$1"; }
die() { echo "pi-init-m2: STOP: $*" >&2; exit 1; }
gen_hex() { head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n'; }
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
# pair <a> <owner-a> <b> <owner-b> <value-a-cmd> <value-b-cmd>: both files are created together
# from one generated value, or both already exist; one without the other stops the script.
pair() {
  local a=$1 oa=$2 b=$3 ob=$4 fa=$5 fb=$6
  if ! exists "$a" && ! exists "$b"; then
    local v; v=$(gen_hex)
    "$fa" "$v" | put "$a" "$oa" 0600
    "$fb" "$v" | put "$b" "$ob" 0600
  elif exists "$a" && exists "$b"; then
    echo "kept    $a and $b"
  else
    die "$a and $b must exist together"
  fi
}
same() { printf '%s' "$1"; }
token() { printf 'fcpi_%s_%s' "$TOKEN_LABEL" "$1"; }
token_hash() { printf 'sha256:%s\n' "$(printf 'fcpi_%s_%s' "$TOKEN_LABEL" "$1" | sha256sum | cut -c1-64)"; }
install_if_changed() { # install_if_changed <source> <target> <mode>
  if ! sudo -n cmp -s "$1" "$2"; then sudo -n install -m "$3" -o root -g root "$1" "$2"; echo "installed $2"; else echo "kept    $2"; fi
}

sec meta
date -u +%Y-%m-%dT%H:%M:%SZ
echo "source_commit=$(cat $REPO/.fcpi-source-commit 2>/dev/null)"
exists $S || die "$S is absent: run scripts/m1/pi-init.sh first"

sec secrets
# The retrieval service's own PostgreSQL role (fcpi_retrieval, DML on its schema only): one copy
# for the service (uid 3310), one for the initdb script (uid 5432).
pair $S/retrieval_postgres_password 3310:3310 $S/postgres_retrieval_role_password 5432:5432 same same
# The core's credential for the retrieval service; the service keeps only its SHA-256.
TOKEN_LABEL=core
pair $S/core_retrieval_token 0:0 $S/retrieval_core_token_sha256 3310:3310 token token_hash
# The retrieval service's credential for the browser worker; the worker keeps only its SHA-256.
TOKEN_LABEL=browser
pair $S/retrieval_browser_token 3310:3310 $S/browser_token_sha256 3320:3320 token token_hash

sec host_files
sudo -n /usr/sbin/nft -c -f $REPO/deploy/host/fcpi-guard.nft || die "deploy/host/fcpi-guard.nft does not parse"
install_if_changed $REPO/deploy/host/fcpi-guard.nft $ETC/fcpi-guard.nft 0644
install_if_changed $REPO/deploy/host/fcpi-egress-local.sh $ETC/fcpi-egress-local.sh 0755
D=/etc/systemd/system/docker.service.d
for f in 10-fcpi-data-check.conf 20-fcpi-guard.conf 30-fcpi-egress-local.conf; do
  install_if_changed $REPO/deploy/host/docker.service.d/$f $D/$f 0644
done
install_if_changed $REPO/deploy/host/fcpi-stack.service /etc/systemd/system/fcpi-stack.service 0644
sudo -n systemctl daemon-reload
# Load the guard now (the drop-in loads it at the next dockerd start); the load replaces the
# table in one transaction and empties its host-networks set, which the script then fills.
sudo -n /usr/sbin/nft -f $ETC/fcpi-guard.nft || die "loading inet fcpi_guard failed"
echo "loaded  inet fcpi_guard"
sudo -n $ETC/fcpi-egress-local.sh || die "fcpi-egress-local.sh failed"
echo "docker ExecStartPre=$(systemctl show -p ExecStartPre --value docker.service | grep -o 'path=[^ ;]*' | tr '\n' ' ')"
echo "fcpi-stack ExecStartPre=$(systemctl show -p ExecStartPre --value fcpi-stack.service | grep -o 'path=[^ ;]*' | tr '\n' ' ')"
echo "guard_rules=$(sudo -n nft -j list table inet fcpi_guard | jq '[.nftables[] | select(.rule)] | length') local_v4_elements=$(sudo -n nft -j list set inet fcpi_guard egress_local_v4 | jq '[.nftables[] | select(.set) | .set.elem // [] | length] | add')"

sec inventory
sudo -n sh -c "stat -c '%u:%g %a %n' $S/retrieval_postgres_password $S/postgres_retrieval_role_password $S/core_retrieval_token $S/retrieval_core_token_sha256 $S/retrieval_browser_token $S/browser_token_sha256 $ETC/fcpi-guard.nft $ETC/fcpi-egress-local.sh $ETC/egress-local.cidrs"
echo end
