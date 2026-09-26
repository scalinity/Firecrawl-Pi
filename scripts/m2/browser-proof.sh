#!/usr/bin/env bash
# Workstation side of D2's browser proof: verify the playwright-core tarball against the
# registry integrity recorded in evidence/M2/sources, upload it to a temp dir on the Pi, run
# scripts/m2/pi-browser-proof.sh there with the image deploy/browser/Dockerfile names, and save
# the transcript. The Pi must run a deployed commit that holds the proof files.
#   scripts/m2/browser-proof.sh evidence/M2/raw/browser-proof.txt
set -euo pipefail
root=$(cd "$(dirname "$0")/../.." && pwd)
# shellcheck source=scripts/m1/pi-target.conf
. "$root/scripts/m1/pi-target.conf"
SSH=(ssh -i "$PI_SSH_KEY" -o IdentitiesOnly=yes -o BatchMode=yes -o ConnectTimeout=15 "$PI_SSH_TARGET")
out=${1:?usage: browser-proof.sh <output-file>}
img=$(sed -n 's/^FROM \(mcr\.microsoft\.com\/playwright@sha256:[0-9a-f]\{64\}\)$/\1/p' "$root/deploy/browser/Dockerfile")
[ -n "$img" ] || { echo "deploy/browser/Dockerfile has no digest-pinned Playwright FROM line" >&2; exit 1; }
reg=$root/evidence/M2/sources/playwright-core-1.63.0-registry.json
url=$(node -e 'console.log(JSON.parse(require("fs").readFileSync(process.argv[1])).dist.tarball)' "$reg")
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
curl -fsSL -o "$work/pw.tgz" "$url"
node -e 'const fs=require("fs"),c=require("crypto");const want=JSON.parse(fs.readFileSync(process.argv[1])).dist.integrity;
const got="sha512-"+c.createHash("sha512").update(fs.readFileSync(process.argv[2])).digest("base64");
if(got!==want){console.error("playwright-core integrity mismatch");process.exit(1)}' "$reg" "$work/pw.tgz"
"${SSH[@]}" 'rm -rf /tmp/fcpi-m2-browser-proof && mkdir -m 0755 /tmp/fcpi-m2-browser-proof && cat > /tmp/fcpi-m2-browser-proof/playwright-core.tgz' <"$work/pw.tgz"
"${SSH[@]}" "bash -s -- $img" <"$root/scripts/m2/pi-browser-proof.sh" >"$out"
echo "wrote $out ($(wc -l <"$out" | tr -d ' ') lines)"
