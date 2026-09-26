#!/usr/bin/env bash
# Tailscale Serve as the gateway's private TLS path (FIRECRAWL_PI_SPEC.md §19.1; M0's plan: tailnet
# :8443, because Pi-hole holds :443). The owner approved installation and account association in M3.
# Runs ON the Pi:   ssh … 'bash /opt/firecrawl-pi/scripts/m3/pi-tailscale.sh <install|up|serve|status>'
#   install  Tailscale's apt repository for this release, its signing key accepted only with the
#            fingerprint Tailscale publishes, and the tailscale package;
#   up       joins the tailnet as "fcpi" without touching the host's DNS (the Pi is the LAN's DNS
#            server), without routes, exit node or Tailscale SSH; prints the login URL for the owner;
#   serve    serves https://<machine>.<tailnet>.ts.net:8443 to the gateway's loopback publication,
#            tailnet only (never Funnel), and writes that origin to the gateway's host-side file, so
#            the tailnet's name stays out of the repository; restarts the gateway to read it;
#   status   what the evidence needs, with the tailnet's names replaced by <pi-tailnet-name>.
set -euo pipefail
export LC_ALL=C
export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
FPR=2596A99EAAB33821893C0A79458CA832957F5868   # Tailscale Inc. (Package repository signing key)
KEYRING=/usr/share/keyrings/tailscale-archive-keyring.gpg
LIST=/etc/apt/sources.list.d/tailscale.list
ORIGINS=/etc/firecrawl-pi/secrets/gateway/served-origins
PORT=8443
die() { echo "pi-tailscale: $*" >&2; exit 1; }
. /etc/os-release
CODENAME=$VERSION_CODENAME
name() { sudo -n tailscale status --json | jq -r '.Self.DNSName // empty' | sed 's/\.$//'; }
# Tailnet names are replaced by their shape, not by the live name: after a logout or with a stale
# origins file the live name is unknown or different, and the evidence must still carry none.
redact() { sed -E 's/[A-Za-z0-9-]+\.[A-Za-z0-9-]+\.ts\.net/<pi-tailnet-name-host>/g; s/[A-Za-z0-9-]+\.ts\.net/<pi-tailnet-name>/g'; }

case "${1:-}" in
  install)
    T=$(mktemp -d); trap 'rm -rf "$T"' EXIT
    curl -fsSL "https://pkgs.tailscale.com/stable/debian/$CODENAME.noarmor.gpg" -o "$T/key.gpg"
    # The whole file becomes apt's signed-by keyring, so it must hold one primary key, Tailscale's:
    # a second key appended to a genuine one would otherwise be trusted too. The first fingerprint
    # gpg lists is the primary's; subkeys follow it.
    keys=$(gpg --show-keys --with-colons "$T/key.gpg")
    n=$(printf '%s\n' "$keys" | awk -F: '$1 == "pub"' | wc -l)
    [ "$n" -eq 1 ] || die "the downloaded keyring holds $n primary keys, not one"
    got=$(printf '%s\n' "$keys" | awk -F: '$1 == "fpr" {print $10; exit}')
    [ "$got" = "$FPR" ] || die "the downloaded key's fingerprint is $got, not $FPR"
    curl -fsSL "https://pkgs.tailscale.com/stable/debian/$CODENAME.tailscale-keyring.list" -o "$T/list"
    want="deb [signed-by=$KEYRING] https://pkgs.tailscale.com/stable/debian $CODENAME main"
    [ "$(grep -v '^#' "$T/list" | grep -v '^$')" = "$want" ] || die "the repository list is not the one expected"
    sudo -n install -m 0644 -o root -g root "$T/key.gpg" "$KEYRING"
    sudo -n install -m 0644 -o root -g root "$T/list" "$LIST"
    echo "key_fingerprint=$got"
    # Only this repository's lists are refreshed; the host's other sources are left as they are.
    sudo -n apt-get update -o Dir::Etc::sourcelist="$LIST" -o Dir::Etc::sourceparts=- -o APT::Get::List-Cleanup=0 2>&1 | tail -2
    sudo -n env DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends tailscale 2>&1 | tail -3
    echo "installed=$(dpkg-query -W -f '${Version}' tailscale) tailscaled=$(systemctl is-active tailscaled)"
    ;;
  up)
    # tailscale up prints the login URL and waits; the wait is cut short, and tailscaled finishes
    # the login in the background once the owner approves it.
    sudo -n timeout 25 tailscale up --accept-dns=false --accept-routes=false --ssh=false --hostname=fcpi 2>&1 | grep -Eo 'https://login\.tailscale\.com/\S+' | head -1 || true
    echo "backend=$(sudo -n tailscale status --json | jq -r .BackendState)"
    ;;
  serve)
    [ "$(sudo -n tailscale status --json | jq -r .BackendState)" = Running ] || die "tailscale is not logged in"
    n=$(name); [ -n "$n" ] || die "no MagicDNS name: enable MagicDNS for the tailnet"
    sudo -n tailscale serve --bg --https=$PORT http://127.0.0.1:3380 2>&1 | redact
    tmp=$(sudo -n mktemp /etc/firecrawl-pi/secrets/gateway/.origins.XXXXXX)
    printf '# the Tailscale Serve origin (scripts/m3/pi-tailscale.sh)\nhttps://%s:%s\n' "$n" "$PORT" | sudo -n tee "$tmp" >/dev/null
    sudo -n chown 3380:3380 "$tmp" && sudo -n chmod 0600 "$tmp" && sudo -n mv -f "$tmp" "$ORIGINS"
    sudo -n docker restart fcpi-access-gateway-1 >/dev/null
    for _ in $(seq 1 60); do [ "$(sudo -n docker inspect -f '{{.State.Health.Status}}' fcpi-access-gateway-1)" = healthy ] && break; sleep 2; done
    echo "origin=https://<pi-tailnet-name-host>:$PORT gateway=$(sudo -n docker inspect -f '{{.State.Health.Status}}' fcpi-access-gateway-1)"
    ;;
  status)
    # All of it passes through redact, so no line can carry a tailnet name out.
    {
    echo "### meta"
    echo "utc=$(date -u +%Y-%m-%dT%H:%M:%SZ) source_commit=$(cat /opt/firecrawl-pi/.fcpi-source-commit)"
    echo "### keyring"
    # apt's signed-by keyring for the repository, as installed: one primary key, Tailscale's.
    gpg --show-keys --with-colons "$KEYRING" 2>/dev/null | awk -F: '$1 == "pub" {n++} $1 == "fpr" && !f {f = $10} END {print "primary_keys=" n + 0 " primary_fpr=" f}'
    echo "### tailscale"
    echo "version=$(tailscale version | head -1) tailscaled=$(systemctl is-active tailscaled) enabled=$(systemctl is-enabled tailscaled)"
    sudo -n tailscale status --json | jq -r '"backend=\(.BackendState) magicdns_suffix_set=\(.MagicDNSSuffix != "") self_online=\(.Self.Online) tailnet_addresses=\(.Self.TailscaleIPs | length) peers=\(.Peer // {} | length)"'
    sudo -n tailscale debug prefs 2>/dev/null | jq -r '"corp_dns=\(.CorpDNS) route_all=\(.RouteAll) run_ssh=\(.RunSSH) advertise_routes=\(.AdvertiseRoutes // [] | length) exit_node=\((.ExitNodeID // "") != "") hostname=\(.Hostname)"'
    echo "### serve"
    sudo -n tailscale serve status --json 2>/dev/null | jq -c '{tcp: (.TCP // {} | keys), web: (.Web // {} | to_entries | map({host_port: (.key | sub("^[^:]*"; "<pi-tailnet-name-host>")), handlers: (.value.Handlers | to_entries | map({(.key): .value.Proxy}) | add)})), funnel: (.AllowFunnel // {} | length)}'
    echo "### origins_file"
    sudo -n sh -c "stat -c '%u:%g %a' $ORIGINS; grep -v '^#' $ORIGINS"
    echo "### guard"
    # The tailnet's rules in the loaded guard, and the installed guard file they came from.
    echo "guard_file_sha256=$(sudo -n sha256sum /etc/firecrawl-pi/fcpi-guard.nft | cut -c1-64) tailnet_rules=$(sudo -n nft -j list chain inet fcpi_guard input | jq '[.nftables[] | select(.rule) | select([.rule.expr[] | .match? | select(.left.meta.key == "iifname" and .right == "tailscale0")] | length > 0)] | length')"
    echo "### resolv"
    echo "resolv_conf_sha256=$(sha256sum /etc/resolv.conf | cut -c1-64) nameservers=$(grep -c '^nameserver' /etc/resolv.conf)"
    echo "### listeners"
    sudo -n ss -Hltnup | awk '/tailscaled/ {print $1, $5}' | sed -E 's/100\.[0-9]+\.[0-9]+\.[0-9]+/<tailnet-address>/; s/\[fd7a:[^]]*\]/[<tailnet-address-v6>]/'
    echo "end"
    } | redact
    ;;
  *) die "usage: pi-tailscale.sh install|up|serve|status" ;;
esac
