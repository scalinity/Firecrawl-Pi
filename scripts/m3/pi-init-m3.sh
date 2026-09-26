#!/usr/bin/env bash
# M3 host initialisation, beside scripts/m1/pi-init.sh and scripts/m2/pi-init-m2.sh. Runs ON the Pi
# from the deployed copy:  ssh … 'bash /opt/firecrawl-pi/scripts/m3/pi-init-m3.sh'
# Idempotent, in M1's and M2's manner: creates what is missing, never overwrites a secret, stops on a
# half-created pair rather than repairing it, and prints names, owners and modes only.
#   - secrets: the gateway's PostgreSQL password, with the initdb copy (one generated value);
#   - the gateway's registry directory under the secrets directory, with an empty registry;
#   - the artifact root on the data mount, owned by the gateway's uid, with its marker (the data ID),
#     without which the gateway refuses to start.
set -euo pipefail
export LC_ALL=C
export PATH="/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"
umask 077
REPO=/opt/firecrawl-pi
ETC=/etc/firecrawl-pi
S=$ETC/secrets
DATA=/srv/firecrawl-pi/data

sec() { printf '### %s\n' "$1"; }
die() { echo "pi-init-m3: STOP: $*" >&2; exit 1; }
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
pair() { # both files from one generated value, or both already there; one without the other stops
  local a=$1 oa=$2 b=$3 ob=$4
  if ! exists "$a" && ! exists "$b"; then
    local v; v=$(gen_hex)
    printf '%s' "$v" | put "$a" "$oa" 0600
    printf '%s' "$v" | put "$b" "$ob" 0600
  elif exists "$a" && exists "$b"; then
    echo "kept    $a and $b"
  else
    die "$a and $b must exist together"
  fi
}
dir() { # dir <path> <owner> <mode>
  if exists "$1"; then echo "kept    $1/"; else sudo -n install -d -o "${2%:*}" -g "${2#*:}" -m "$3" "$1" && echo "created $1/"; fi
}

sec meta
echo "utc=$(date -u +%Y-%m-%dT%H:%M:%SZ) source_commit=$(cat $REPO/.fcpi-source-commit 2>/dev/null)"
exists $S || die "$S is absent: run scripts/m1/pi-init.sh first"
sudo -n test -f "$DATA/.fcpi-data-id" || die "$DATA/.fcpi-data-id is absent: the data mount is not the project's"

sec secrets
pair $S/gateway_postgres_password 3380:3380 $S/postgres_gateway_role_password 5432:5432
dir $S/gateway 3380:3380 0700
# An empty registry: no client can authenticate until scripts/m3/pi-client-token.sh adds one.
printf '# FCPI gateway clients: written only by scripts/m3/pi-client-token.sh\n' | put $S/gateway/clients 3380:3380 0600
dir $S/clients 0:0 0700

sec artifacts
dir $DATA/artifacts 3380:3380 0700
sudo -n cat "$DATA/.fcpi-data-id" | put "$DATA/artifacts/.fcpi-artifact-root" 3380:3380 0600
[ "$(sudo -n cat "$DATA/artifacts/.fcpi-artifact-root")" = "$(sudo -n cat "$DATA/.fcpi-data-id")" ] || die "the artifact marker does not hold this data mount's ID"
echo "artifact_root_filesystem_uuid=$(sudo -n findmnt -n -o UUID --target $DATA/artifacts)"

sec inventory
sudo -n sh -c "stat -c '%u:%g %a %n' $S/gateway_postgres_password $S/postgres_gateway_role_password $S/gateway $S/gateway/clients $S/clients $DATA/artifacts $DATA/artifacts/.fcpi-artifact-root"
echo end
