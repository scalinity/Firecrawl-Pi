#!/usr/bin/env bash
# Resolve an image reference to its index digest and linux/arm64 manifest digest
# through the registry HTTP API (anonymous pull tokens only; no docker, crane or
# skopeo). The exact bytes of the index and the arm64 manifest are saved under
# evidence/M0/registry/ so the digests can be recomputed offline.
#
# Usage: scripts/m0/resolve-digest.sh <registry> <repository> <tag>
#   e.g. scripts/m0/resolve-digest.sh registry-1.docker.io library/node 22-bookworm-slim
# Prints one JSON object on stdout.
set -euo pipefail
reg=$1 repo=$2 tag=$3
root=$(cd "$(dirname "$0")/../.." && pwd)
dir="$root/evidence/M0/registry"; mkdir -p "$dir"
safe=$(printf '%s_%s_%s' "$reg" "$repo" "$tag" | tr '/:@' '___')
accept='application/vnd.oci.image.index.v1+json,application/vnd.docker.distribution.manifest.list.v2+json,application/vnd.oci.image.manifest.v1+json,application/vnd.docker.distribution.manifest.v2+json'
tmp=$(mktemp -d); trap 'rm -rf "$tmp"' EXIT
now=$(date -u +%Y-%m-%dT%H:%M:%SZ)

jfail() { jq -n --arg reg "$reg" --arg repo "$repo" --arg tag "$tag" --arg now "$now" --arg why "$1" \
  '{registry:$reg, repository:$repo, tag:$tag, resolved_utc:$now, status:"unresolved", unresolved_reason:$why}'; exit 0; }

token=""
fetch() { # fetch <url> <out> [accept]; sets $code; obtains an anonymous bearer token on 401
  local url=$1 out=$2 acc=${3:-$accept} hdr=()
  [ -n "$token" ] && hdr=(-H "Authorization: Bearer $token")
  code=$(curl -sS -L --max-time 60 -D "$tmp/h" -o "$out" -w '%{http_code}' -H "Accept: $acc" ${hdr[@]+"${hdr[@]}"} "$url")
  if [ "$code" = 401 ] && [ -z "$token" ]; then
    local wa realm service scope
    wa=$(grep -i '^www-authenticate:' "$tmp/h" | head -1 | tr -d '\r' || true)
    grep -qi 'realm="' <<<"$wa" || jfail "HTTP 401 without a usable WWW-Authenticate challenge"
    realm=$(sed -E 's/.*realm="([^"]+)".*/\1/' <<<"$wa")
    service=$(sed -nE 's/.*service="([^"]+)".*/\1/p' <<<"$wa")
    scope="repository:$repo:pull"
    token=$(curl -sS --max-time 30 -G "$realm" --data-urlencode "service=$service" --data-urlencode "scope=$scope" | jq -r '.token // .access_token // empty')
    [ -n "$token" ] || jfail "anonymous token request returned no token"
    fetch "$url" "$out" "$acc"
  fi
}

fetch "https://$reg/v2/$repo/manifests/$tag" "$tmp/top"
[ "$code" = 200 ] || jfail "manifest GET returned HTTP $code"
top_digest="sha256:$(shasum -a 256 "$tmp/top" | cut -c1-64)"
hdr_digest=$(grep -i '^docker-content-digest:' "$tmp/h" | tail -1 | awk '{print $2}' | tr -d '\r')
# Pull-by-digest resolves the registry's digest, so it must equal the hash of the saved bytes.
[ -z "$hdr_digest" ] || [ "$hdr_digest" = "$top_digest" ] || jfail "registry digest $hdr_digest != sha256 of saved bytes $top_digest"
mt=$(jq -r '.mediaType // empty' "$tmp/top")
# OCI indexes may omit mediaType in the body; fall back to the Content-Type header.
[ -n "$mt" ] || mt=$(grep -i '^content-type:' "$tmp/h" | tail -1 | awk '{print $2}' | tr -d '\r;' || true)

case "$mt" in
  *index*|*manifest.list*)
    cp "$tmp/top" "$dir/$safe.index.json"
    arm=$(jq -r '[.manifests[] | select(.platform.os=="linux" and .platform.architecture=="arm64" and ((.platform.variant // "v8")=="v8"))][0].digest // empty' "$tmp/top")
    plats=$(jq -c '[.manifests[] | select(.platform.os!="unknown") | "\(.platform.os)/\(.platform.architecture)\(if .platform.variant then "/"+.platform.variant else "" end)"]' "$tmp/top")
    if [ -z "$arm" ]; then
      jq -n --arg reg "$reg" --arg repo "$repo" --arg tag "$tag" --arg now "$now" --arg d "$top_digest" --argjson p "$plats" \
        --arg f "evidence/M0/registry/$safe.index.json" \
        '{registry:$reg, repository:$repo, tag:$tag, resolved_utc:$now, status:"unresolved", index_digest:$d, platforms:$p, index_file:$f, unresolved_reason:"index has no linux/arm64 manifest"}'
      exit 0
    fi
    fetch "https://$reg/v2/$repo/manifests/$arm" "$tmp/arm"
    [ "$code" = 200 ] || jfail "arm64 manifest GET returned HTTP $code"
    cp "$tmp/arm" "$dir/$safe.arm64.json"
    arm_calc="sha256:$(shasum -a 256 "$tmp/arm" | cut -c1-64)"
    [ "$arm_calc" = "$arm" ] || jfail "arm64 manifest bytes hash $arm_calc != listed $arm"
    jq -n --arg reg "$reg" --arg repo "$repo" --arg tag "$tag" --arg now "$now" --arg d "$top_digest" --arg hd "$hdr_digest" \
      --arg a "$arm" --arg mt "$mt" --argjson p "$plats" \
      --arg fi "evidence/M0/registry/$safe.index.json" --arg fa "evidence/M0/registry/$safe.arm64.json" \
      '{registry:$reg, repository:$repo, tag:$tag, resolved_utc:$now, status:"resolved", media_type:$mt,
        index_digest:$d, registry_reported_digest:$hd, arm64_manifest_digest:$a, platform:"linux/arm64",
        platforms:$p, index_file:$fi, arm64_manifest_file:$fa}'
    ;;
  *)
    # Single-platform manifest: read the platform from its config blob.
    cfg=$(jq -r '.config.digest // empty' "$tmp/top")
    [ -n "$cfg" ] || jfail "unrecognised manifest media type '$mt'"
    fetch "https://$reg/v2/$repo/blobs/$cfg" "$tmp/cfg" 'application/octet-stream,*/*'
    [ "$code" = 200 ] || jfail "config blob GET returned HTTP $code"
    plat=$(jq -r '"\(.os)/\(.architecture)"' "$tmp/cfg")
    cp "$tmp/top" "$dir/$safe.manifest.json"
    if [ "$plat" = linux/arm64 ]; then st=resolved; why=""; else st=unresolved; why="single-platform manifest for $plat; no linux/arm64 variant published under this tag"; fi
    jq -n --arg reg "$reg" --arg repo "$repo" --arg tag "$tag" --arg now "$now" --arg d "$top_digest" --arg hd "$hdr_digest" \
      --arg mt "$mt" --arg plat "$plat" --arg st "$st" --arg why "$why" --arg f "evidence/M0/registry/$safe.manifest.json" \
      '{registry:$reg, repository:$repo, tag:$tag, resolved_utc:$now, status:$st, media_type:$mt, index_digest:null,
        manifest_digest:$d, registry_reported_digest:$hd, platform:$plat, manifest_file:$f}
        + (if $st=="resolved" then {arm64_manifest_digest:$d} else {unresolved_reason:$why} end)'
    ;;
esac
