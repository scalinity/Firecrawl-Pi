#!/usr/bin/env bash
# M5 host initialisation, beside scripts/m1/pi-init.sh and scripts/m2-m3's. Runs ON the Pi from the deployed
# copy:  ssh … 'bash /opt/firecrawl-pi/scripts/m5/pi-init-m5.sh'
# Idempotent, in M2's manner: creates what is missing, never overwrites a secret, stops on a half-created
# pair rather than repairing it, and prints names, owners and modes only.
#   - the gateway's credential for the retrieval service's extraction listener (plaintext for the gateway,
#     its SHA-256 for the service);
#   - SearXNG's credential for the search proxy (plaintext for SearXNG, its SHA-256 for the service) and
#     SearXNG's server secret;
#   - the provider-credential directory, empty: a model or parser key is placed only by
#     scripts/m5/pi-provider-key.sh, and a key present is not an authorization to spend (CLAUDE.md §11);
#   - the selection directory with the production selection: the real model and parser (refused until paid
#     dispatch and a budget are approved) and the fixture search engine (live search egress held until the
#     review is addressed). scripts/m5/pi-selection.sh changes it, the fixture phase included.
set -euo pipefail
export LC_ALL=C
export PATH="/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"
umask 077
REPO=/opt/firecrawl-pi
ETC=/etc/firecrawl-pi
S=$ETC/secrets

sec() { printf '### %s\n' "$1"; }
die() { echo "pi-init-m5: STOP: $*" >&2; exit 1; }
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
# pair <a> <owner-a> <b> <owner-b> <value-a-fn> <value-b-fn>: both from one generated value, or both there.
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
token() { printf 'fcpi_%s_%s' "$TOKEN_LABEL" "$1"; }
token_hash() { printf 'sha256:%s\n' "$(printf 'fcpi_%s_%s' "$TOKEN_LABEL" "$1" | sha256sum | cut -c1-64)"; }
dir() { # dir <path> <owner> <mode>
  if exists "$1"; then echo "kept    $1/"; else sudo -n install -d -o "${2%:*}" -g "${2#*:}" -m "$3" "$1" && echo "created $1/"; fi
}

sec meta
echo "utc=$(date -u +%Y-%m-%dT%H:%M:%SZ) source_commit=$(cat $REPO/.fcpi-source-commit 2>/dev/null)"
exists $S || die "$S is absent: run scripts/m1/pi-init.sh first"

sec secrets
TOKEN_LABEL=gateway
pair $S/gateway_retrieval_token 3380:3380 $S/retrieval_gateway_token_sha256 3310:3310 token token_hash
TOKEN_LABEL=searxng
pair $S/searxng_proxy_password 3330:3330 $S/retrieval_searxng_proxy_sha256 3310:3310 token token_hash
if exists $S/searxng_secret_key; then echo "kept    $S/searxng_secret_key"; else gen_hex | put $S/searxng_secret_key 3330:3330 0600; fi
dir $S/providers 3310:3310 0700

sec selection
dir $ETC/selection 0:0 0755
printf '{ "search": "fixture", "extractionModel": "gpt-4.1-mini-2025-04-14", "parser": "llamaparse-cost-effective" }\n' | put $ETC/selection/selection.json 0:0 0644

sec inventory
sudo -n sh -c "stat -c '%u:%g %a %n' $S/gateway_retrieval_token $S/retrieval_gateway_token_sha256 $S/searxng_proxy_password $S/retrieval_searxng_proxy_sha256 $S/searxng_secret_key $S/providers $ETC/selection $ETC/selection/selection.json"
echo "providers_present=$(sudo -n ls -A $S/providers | wc -l)"
echo "selection=$(sudo -n cat $ETC/selection/selection.json | jq -c .)"
echo end
