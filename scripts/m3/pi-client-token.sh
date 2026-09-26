#!/usr/bin/env bash
# Gateway client tokens (FIRECRAWL_PI_SPEC.md §20.3), ON the Pi:
#   pi-client-token.sh create <label> <principal> <scope,scope,…>   new client, or a replacement for rotation
#   pi-client-token.sh revoke <label>                                removes its line and its token file
#   pi-client-token.sh list                                          labels, principals and scopes
# A token is fcpi_<label>_<64 hex>, generated here and written only to
# /etc/firecrawl-pi/secrets/clients/<label>.token (root 0600), for the owner to give its client; the
# registry the gateway reads holds its SHA-256. The registry is replaced atomically (a new file renamed
# over the old), and the gateway sees the new file within a second. Rotation: create a replacement
# label for the same principal, switch the client, then revoke the old label. Prints no token or hash.
set -euo pipefail
export LC_ALL=C
export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
umask 077
S=/etc/firecrawl-pi/secrets
REG=$S/gateway/clients
SCOPES="read scrape map crawl batch cancel"
die() { echo "pi-client-token: $*" >&2; exit 1; }
sudo -n test -f $REG || die "$REG is absent: run scripts/m3/pi-init-m3.sh"
# Only one change at a time: the registry is read, changed and renamed under this lock.
exec 9>/run/lock/fcpi-client-token.lock
flock -w 30 9 || die "another change to the registry is in progress"

# The gateway's parser (services/access/src/auth.mjs parseClients) on stdin: a registry it rejects is
# rejected whole, and the gateway keeps its last good set, so a revocation in such a file would never
# take effect. Each line: <label> <principal> <scope,scope,…> sha256:<64 hex>, known scopes with no
# empty entry, labels unique; blank and # lines are skipped.
valid() {
  local line l label scopes s seen=" "
  while IFS= read -r line || [ -n "$line" ]; do
    l=${line#"${line%%[![:space:]]*}"}; l=${l%"${l##*[![:space:]]}"}
    [[ -z $l || $l == \#* ]] && continue
    [[ $l =~ ^([a-z0-9]{1,32})[[:space:]]+[a-z0-9][a-z0-9-]{0,62}[[:space:]]+([a-z,]+)[[:space:]]+sha256:[0-9a-f]{64}$ ]] || return 1
    label=${BASH_REMATCH[1]} scopes=${BASH_REMATCH[2]}
    [[ $scopes =~ ^[a-z]+(,[a-z]+)*$ ]] || return 1
    for s in ${scopes//,/ }; do [[ " $SCOPES " == *" $s "* ]] || return 1; done
    [[ $seen == *" $label "* ]] && return 1
    seen+="$label "
  done
  return 0
}

replace() { # replace: stdin becomes the registry, atomically, owned by the gateway's uid, only if the gateway would accept it
  local tmp; tmp=$(sudo -n mktemp "$S/gateway/.clients.XXXXXX") || return 1
  # Each step is checked: this runs in a pipeline, where set -e does not stop it.
  if sudo -n tee "$tmp" >/dev/null && sudo -n cat "$tmp" | valid && sudo -n chown 3380:3380 "$tmp" && sudo -n chmod 0600 "$tmp" && sudo -n mv -f -- "$tmp" $REG; then return 0; fi
  sudo -n rm -f -- "$tmp"
  echo "pi-client-token: the gateway would reject the new registry (or it could not be written); nothing changed" >&2
  return 1
}

case "${1:-}" in
  create)
    label=${2:-}; principal=${3:-}; scopes=${4:-}
    [[ $label =~ ^[a-z0-9]{1,32}$ ]] || die "label must be 1-32 lowercase letters or digits"
    [[ $principal =~ ^[a-z0-9][a-z0-9-]{0,62}$ ]] || die "principal must be lowercase letters, digits and hyphens"
    [[ $scopes =~ ^[a-z]+(,[a-z]+)*$ ]] || die "scopes must be a comma list of scope names, with no empty entries"
    for s in ${scopes//,/ }; do [[ " $SCOPES " == *" $s "* ]] || die "unknown scope $s"; done
    sudo -n awk -v l="$label" '$1 == l {f=1} END {exit f ? 0 : 1}' $REG && die "label $label exists: revoke it first, or create a new label"
    sudo -n test -e $S/clients/$label.token && die "$S/clients/$label.token exists: revoke $label first"
    token="fcpi_${label}_$(head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n')"
    hash=$(printf '%s' "$token" | sha256sum | cut -c1-64)
    # The token file first, by hard link so an existing one is never overwritten; then the registry.
    tmp=$(sudo -n mktemp "$S/clients/.token.XXXXXX")
    printf '%s\n' "$token" | sudo -n tee "$tmp" >/dev/null
    sudo -n chown 0:0 "$tmp" && sudo -n chmod 0600 "$tmp"
    sudo -n ln -- "$tmp" $S/clients/$label.token || { sudo -n rm -f -- "$tmp"; die "could not create the token file"; }
    sudo -n rm -f -- "$tmp"
    unset token
    # A registry left unchanged takes the new token file with it, so the label can be created again.
    { sudo -n cat $REG; printf '%s %s %s sha256:%s\n' "$label" "$principal" "$scopes" "$hash"; } | replace \
      || { sudo -n rm -f -- $S/clients/$label.token; die "the registry was not changed, so $label's token file was removed"; }
    echo "created $label principal=$principal scopes=$scopes token_file=$S/clients/$label.token"
    ;;
  revoke)
    label=${2:-}
    [[ $label =~ ^[a-z0-9]{1,32}$ ]] || die "label must be 1-32 lowercase letters or digits"
    sudo -n awk -v l="$label" '$1 == l {f=1} END {exit f ? 0 : 1}' $REG || die "no client $label"
    sudo -n awk -v l="$label" '$1 != l' $REG | replace || die "$label is still registered, and its token file is kept"
    sudo -n rm -f -- $S/clients/$label.token
    echo "revoked $label"
    ;;
  list)
    sudo -n awk '!/^#/ && NF == 4 {print $1, "principal=" $2, "scopes=" $3}' $REG
    ;;
  *) die "usage: pi-client-token.sh create <label> <principal> <scopes> | revoke <label> | list" ;;
esac
