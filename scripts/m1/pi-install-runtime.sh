#!/usr/bin/env bash
# M1 container runtime install. Runs ON the Pi through `ssh ... 'bash -s' -- <mode>`.
#   mode=plan     add Docker's apt source (signing key fingerprint checked), refresh
#                 only that source, and simulate the pinned install; changes nothing else
#   mode=install  the pinned install, then hold the five packages at those versions
# Idempotent: a second run with the same versions changes nothing.
#
# docker-ce is chosen over Debian's docker.io 26.1.5 because Engine 28.0.0
# (moby#49325) stops neighbour hosts reaching ports mapped on a loopback address,
# and this LAN is flat; see evidence/M1/sources/moby-v28.0.0-release-notes-excerpt.txt.
set -euo pipefail
export LC_ALL=C DEBIAN_FRONTEND=noninteractive
export PATH="/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"
mode=${1:?usage: pi-install-runtime.sh plan|install}

KEY_URL=https://download.docker.com/linux/debian/gpg
KEY_FPR=9DC858229FC7DD38854AE2D88D81803C0EBFCD88
KEYRING=/etc/apt/keyrings/docker.asc
SOURCES=/etc/apt/sources.list.d/docker.sources
PKGS=(
  "docker-ce=5:29.8.1-1~debian.13~trixie"
  "docker-ce-cli=5:29.8.1-1~debian.13~trixie"
  "containerd.io=2.3.5-1~debian.13~trixie"
  "docker-compose-plugin=5.5.1-1~debian.13~trixie"
  "docker-buildx-plugin=0.37.1-1~debian.13~trixie"
)
sec() { printf '### %s\n' "$1"; }

sec meta
date -u +%Y-%m-%dT%H:%M:%SZ
echo "mode=$mode"

sec signing_key
tmp=$(mktemp)
# A throwaway GNUPGHOME: gpg would otherwise create ~/.gnupg on first use.
gnupghome=$(mktemp -d)
trap 'rm -f "$tmp"; rm -rf "$gnupghome"' EXIT
curl -fsSL --proto '=https' "$KEY_URL" -o "$tmp"
fprs=$(GNUPGHOME="$gnupghome" gpg --show-keys --with-colons "$tmp" 2>/dev/null | awk -F: '$1=="fpr"{print $10}')
echo "$fprs" | sed 's/^/fingerprint=/'
echo "$fprs" | grep -qx "$KEY_FPR" || { echo "FAIL: expected fingerprint $KEY_FPR"; exit 1; }
if ! sudo -n cmp -s "$tmp" "$KEYRING" 2>/dev/null; then
  sudo -n install -d -m 0755 /etc/apt/keyrings
  sudo -n install -m 0644 "$tmp" "$KEYRING"
  echo "installed $KEYRING"
else
  echo "unchanged $KEYRING"
fi
echo "keyring_sha256=$(sha256sum "$KEYRING" | cut -c1-64)"

sec apt_source
want=$(printf '%s\n' "Types: deb" "URIs: https://download.docker.com/linux/debian" "Suites: trixie" \
  "Components: stable" "Architectures: arm64" "Signed-By: $KEYRING")
if [ "$(sudo -n cat "$SOURCES" 2>/dev/null)" != "$want" ]; then
  printf '%s\n' "$want" | sudo -n tee "$SOURCES" >/dev/null
  sudo -n chmod 0644 "$SOURCES"
  echo "wrote $SOURCES"
else
  echo "unchanged $SOURCES"
fi
cat "$SOURCES"

# Refresh only Docker's list, so the Debian and Raspberry Pi lists stay as audited.
sec apt_update_docker_only
sudo -n apt-get update -o Dir::Etc::sourcelist="$SOURCES" -o Dir::Etc::sourceparts=- \
  -o APT::Get::List-Cleanup=0 2>&1 | tail -5

sec candidates
apt-cache policy docker-ce docker-ce-cli containerd.io docker-compose-plugin docker-buildx-plugin iptables \
  | grep -E '^[a-z]|Installed|Candidate'

sec simulate
sudo -n apt-get install -s --no-install-recommends "${PKGS[@]}" | grep -E '^(Inst|Conf|Remv)' || true

if [ "$mode" = install ]; then
  sec install
  sudo -n apt-get install -y --no-install-recommends "${PKGS[@]}" 2>&1 | grep -E '^(Setting up|Unpacking|E:|W:)' || true
  sudo -n apt-mark hold docker-ce docker-ce-cli containerd.io docker-compose-plugin docker-buildx-plugin
  sec installed
  dpkg-query -W -f='${Package} ${Version} ${Status}\n' docker-ce docker-ce-cli containerd.io \
    docker-compose-plugin docker-buildx-plugin iptables 2>&1
  apt-mark showhold
  sudo -n docker version --format '{{.Server.Version}} api={{.Server.APIVersion}} os/arch={{.Server.Os}}/{{.Server.Arch}}'
  sudo -n docker compose version
  sudo -n docker buildx version
fi
echo "end"
