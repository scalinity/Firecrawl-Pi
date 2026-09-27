#!/usr/bin/env bash
# Place a provider's API key where the retrieval service reads it (/etc/firecrawl-pi/secrets/providers/<name>,
# uid 3310, 0600), from stdin only, so the key is never on a command line or in a shell history:
#   ssh … 'bash /opt/firecrawl-pi/scripts/m5/pi-provider-key.sh openai_api_key' < key-file
#   ssh … 'bash /opt/firecrawl-pi/scripts/m5/pi-provider-key.sh llamaparse_api_key --replace' < key-file
#   ssh … 'bash /opt/firecrawl-pi/scripts/m5/pi-provider-key.sh status'
# The name must be a credential the budget policy names. A key present is not an authorization to spend:
# paid dispatch stays off (PI_PAID_DISPATCH_ENABLED=false) and every paid cap stays zero until the owner
# approves a budget (CLAUDE.md §11). Only presence is ever printed.
set -euo pipefail
export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
umask 077
REPO=/opt/firecrawl-pi
P=/etc/firecrawl-pi/secrets/providers
# M6: a proxy provider names its proxy credential ("<username>:<password>") and its usage report's API key.
names=$(jq -r '[.providers[] | (.credential, .usageCredential) | select(. != null)] | unique | .[]' "$REPO/deploy/policies/budget.json")
if [ "${1:-}" = status ]; then
  for n in $names; do if sudo -n test -s "$P/$n"; then echo "$n=present"; else echo "$n=absent"; fi; done; exit 0
fi
name=${1:?usage: pi-provider-key.sh <credential-name> [--replace] < key | status}
grep -qx -- "$name" <<<"$names" || { echo "$name is not a credential the budget policy names" >&2; exit 2; }
if sudo -n test -e "$P/$name" && [ "${2:-}" != --replace ]; then echo "$name exists; pass --replace to change it" >&2; exit 2; fi
tmp=$(sudo -n mktemp "$P/.fcpi-tmp.XXXXXX")
trap 'sudo -n rm -f -- "$tmp"' EXIT
# The key is read by the shell into no variable: tr passes stdin to tee, which writes the file.
tr -d '\r\n' | sudo -n tee "$tmp" >/dev/null
sudo -n test -s "$tmp" || { echo "no key on stdin" >&2; exit 2; }
sudo -n chown 3310:3310 "$tmp" && sudo -n chmod 0600 "$tmp" && sudo -n mv -f "$tmp" "$P/$name"
echo "$name=present bytes=$(sudo -n stat -c %s "$P/$name")"
