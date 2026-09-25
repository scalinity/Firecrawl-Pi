#!/usr/bin/env bash
# M1 host initialisation. Runs ON the Pi from the deployed copy:
#   ssh ... 'bash /opt/firecrawl-pi/scripts/m1/pi-init.sh'
# Idempotent: creates what is missing and never overwrites a secret, the data ID or
# the config. A half-initialised pair (for example a data ID without its config line,
# or a Redis password without its ACL) stops the script instead of being "repaired",
# because silently regenerating one side is exactly the mismatch fcpi-data-check guards.
# Prints names, owners and modes only; no secret value is ever printed or logged.
set -euo pipefail
export LC_ALL=C
export PATH="/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"
umask 077
REPO=/opt/firecrawl-pi
ETC=/etc/firecrawl-pi
S=$ETC/secrets
DATA=/srv/firecrawl-pi/data
UUID_EXPECTED=15f4c6be-1102-4331-9904-f78e78afd1fd

sec() { printf '### %s\n' "$1"; }
die() { echo "pi-init: STOP: $*" >&2; exit 1; }
gen_hex() { head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n'; }
exists() { sudo -n test -e "$1"; }
# put <path> <owner> <mode>: write stdin to <path> atomically, only if <path> is absent.
put() {
  if exists "$1"; then cat >/dev/null; echo "kept    $1"; return; fi
  local tmp; tmp=$(sudo -n mktemp "$(dirname "$1")/.fcpi-tmp.XXXXXX")
  sudo -n tee "$tmp" >/dev/null
  sudo -n chown "$2" "$tmp" && sudo -n chmod "$3" "$tmp" && sudo -n mv -T "$tmp" "$1"
  echo "created $1"
}
mkd() { # mkd <dir> <owner> <mode>: create if absent; an existing directory is left as it is
  if exists "$1"; then echo "kept    $1/"; else sudo -n install -d -o "${2%:*}" -g "${2#*:}" -m "$3" "$1" && echo "created $1/"; fi
}

sec meta
date -u +%Y-%m-%dT%H:%M:%SZ
echo "source_commit=$(cat $REPO/.fcpi-source-commit 2>/dev/null)"

sec directories
# Before creating anything: the nearest existing ancestor of the data directory (the mount
# point itself, once a dedicated device is configured) must already be on the expected
# filesystem, so a missing data device never receives even an empty tree.
anc=$DATA; while [ ! -e "$anc" ]; do anc=$(dirname "$anc"); done
[ "$(findmnt -n -o UUID --target "$anc")" = "$UUID_EXPECTED" ] || die "$anc (nearest existing ancestor of $DATA) is not on filesystem $UUID_EXPECTED"
mkd $ETC 0:0 0755
mkd $S 0:0 0700
mkd $S/clients 0:0 0700
mkd /srv/firecrawl-pi 0:0 0755
# 0700: the service uids below own their subdirectories, and nothing else on the host
# needs to traverse into the data tree.
mkd $DATA 0:0 0700
mkd $DATA/postgres 5432:5432 0700
mkd $DATA/redis 6379:6379 0700
mkd $DATA/rabbitmq 5672:5672 0700
[ "$(findmnt -n -o UUID --target $DATA)" = "$UUID_EXPECTED" ] || die "$DATA is not on filesystem $UUID_EXPECTED"

sec data_identity
if exists $DATA/.fcpi-data-id && exists $ETC/config.env; then
  echo "kept    $DATA/.fcpi-data-id and $ETC/config.env"
elif ! exists $DATA/.fcpi-data-id && ! exists $ETC/config.env; then
  id=$(cat /proc/sys/kernel/random/uuid)
  (umask 022; printf '%s\n' "$id" | put $DATA/.fcpi-data-id 0:0 0644)
  sed "s/^PI_DATA_ID=.*/PI_DATA_ID=$id/" $REPO/deploy/config.env.example | grep -v '^#' | put $ETC/config.env 0:0 0600
else
  die "exactly one of $DATA/.fcpi-data-id and $ETC/config.env exists"
fi

sec secrets
if ! exists $S/postgres_password && ! exists $S/core_postgres_password; then
  pw=$(gen_hex)
  printf '%s' "$pw" | put $S/postgres_password 5432:5432 0600
  printf '%s' "$pw" | put $S/core_postgres_password 0:0 0600
  unset pw
elif exists $S/postgres_password && exists $S/core_postgres_password; then
  echo "kept    $S/postgres_password and $S/core_postgres_password"
else
  die "postgres_password and core_postgres_password must be created together"
fi
if ! exists $S/rabbitmq_default_user_conf && ! exists $S/core_nuq_rabbitmq_url; then
  pw=$(gen_hex)
  printf 'default_user = fcpi\ndefault_pass = %s\n' "$pw" | put $S/rabbitmq_default_user_conf 5672:5672 0600
  printf 'amqp://fcpi:%s@rabbitmq:5672' "$pw" | put $S/core_nuq_rabbitmq_url 0:0 0600
  unset pw
elif exists $S/rabbitmq_default_user_conf && exists $S/core_nuq_rabbitmq_url; then
  echo "kept    $S/rabbitmq_default_user_conf and $S/core_nuq_rabbitmq_url"
else
  die "rabbitmq_default_user_conf and core_nuq_rabbitmq_url must be created together"
fi
if ! exists $S/redis_users_acl && ! exists $S/core_redis_url; then
  pw=$(gen_hex)
  printf 'redis://:%s@redis:6379' "$pw" | put $S/core_redis_url 0:0 0600
  printf 'user default on #%s ~* &* +@all\nuser health on nopass -@all +ping\n' "$(printf '%s' "$pw" | sha256sum | cut -c1-64)" \
    | put $S/redis_users_acl 6379:6379 0600
  unset pw
elif exists $S/redis_users_acl && exists $S/core_redis_url; then
  echo "kept    $S/redis_users_acl and $S/core_redis_url"
else
  die "redis_users_acl and core_redis_url must be created together"
fi
if ! exists $S/gateway_token_hashes && ! exists $S/clients/m1-verify.token; then
  tok="fcpi_m1v_$(gen_hex)"
  printf '%s' "$tok" | put $S/clients/m1-verify.token 0:0 0600
  printf 'm1-verify sha256:%s\n' "$(printf '%s' "$tok" | sha256sum | cut -c1-64)" | put $S/gateway_token_hashes 3380:3380 0600
  unset tok
elif exists $S/gateway_token_hashes && exists $S/clients/m1-verify.token; then
  echo "kept    $S/gateway_token_hashes and $S/clients/m1-verify.token"
else
  die "gateway_token_hashes and clients/m1-verify.token must be created together"
fi
# Erlang cookie: generated here, before the broker's first start, so no CLI call can
# create a root-owned one first (evidence/M1/raw/native-proofs-up-attempt1.txt).
gen_hex | tr '0-9a-f' 'A-P' | put $DATA/rabbitmq/.erlang.cookie 5672:5672 0400

sec systemd_units
for u in fcpi-data-check.service fcpi-stack.service; do
  if ! sudo -n cmp -s $REPO/deploy/host/$u /etc/systemd/system/$u; then
    sudo -n install -m 0644 -o root -g root $REPO/deploy/host/$u /etc/systemd/system/$u && echo "installed /etc/systemd/system/$u"
  else
    echo "kept    /etc/systemd/system/$u"
  fi
done
# dockerd runs the data check before every start (see the drop-in for why).
D=/etc/systemd/system/docker.service.d
sudo -n install -d -m 0755 -o root -g root $D
if ! sudo -n cmp -s $REPO/deploy/host/docker.service.d/10-fcpi-data-check.conf $D/10-fcpi-data-check.conf; then
  sudo -n install -m 0644 -o root -g root $REPO/deploy/host/docker.service.d/10-fcpi-data-check.conf $D/10-fcpi-data-check.conf && echo "installed $D/10-fcpi-data-check.conf"
else
  echo "kept    $D/10-fcpi-data-check.conf"
fi
sudo -n systemctl daemon-reload
echo "docker ExecStartPre=$(systemctl show -p ExecStartPre --value docker.service | grep -o 'path=[^ ;]*' | tr '\n' ' ')"
sudo -n systemctl enable fcpi-stack.service 2>&1 | sed 's/^/systemctl: /'
echo "fcpi-stack enabled=$(systemctl is-enabled fcpi-stack.service)"

sec inventory
sudo -n sh -c "stat -c '%u:%g %a %s %n' $ETC $ETC/config.env $S $S/* $S/clients $S/clients/* $DATA $DATA/.fcpi-data-id $DATA/postgres $DATA/redis $DATA/rabbitmq $DATA/rabbitmq/.erlang.cookie" 2>&1
echo end
