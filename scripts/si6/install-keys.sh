#!/usr/bin/env bash
# The search intelligence providers' credentials for the Pi (docs/FIRECRAWL_PI_SEARCH_INTELLIGENCE_SPEC.md §20): each of the
# seven new keys is read from the workstation's .env (SI0's variable names) and streamed over SSH into the Pi's own installer,
# scripts/m5/pi-provider-key.sh, which reads it from stdin only and writes it owner-only for the retrieval service's uid. No
# value is ever on a command line, in a variable that is printed, or in the output: only each credential's presence is.
# Run after the release is deployed (the installer accepts only names the deployed budget policy lists). A key already on the
# Pi is kept; pass --replace to change them.
#   scripts/si6/install-keys.sh [--replace]
set -euo pipefail
root=$(cd "$(dirname "$0")/../.." && pwd)
# shellcheck source=scripts/m1/pi-target.conf
. "$root/scripts/m1/pi-target.conf"
SSH=(ssh -i "$PI_SSH_KEY" -o IdentitiesOnly=yes -o BatchMode=yes -o ConnectTimeout=15 "$PI_SSH_TARGET")
replace=${1:-}
[ -z "$replace" ] || [ "$replace" = --replace ] || { echo "usage: install-keys.sh [--replace]" >&2; exit 2; }
for pair in BRAVE_API_KEY:brave_api_key EXA_API_KEY:exa_api_key DEEPSEEK_API_KEY:deepseek_api_key TAVILY_API_KEY:tavily_api_key \
  CONTEXT7_API_KEY:context7_api_key REF_API_KEY:ref_api_key OPENROUTER_API_KEY:openrouter_api_key; do
  var=${pair%%:*} name=${pair#*:}
  # The value goes from the file to the pipe; it is never echoed.
  node -e 'const [f, k] = process.argv.slice(1); const m = require("fs").readFileSync(f, "utf8").split("\n").map((l) => /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(l)).find((x) => x && x[1] === k);
    const v = m ? m[2].replace(/^(["\x27])(.*)\1$/, "$2") : ""; if (!v) process.exit(3); process.stdout.write(v);' "$root/.env" "$var" \
    | "${SSH[@]}" "bash /opt/firecrawl-pi/scripts/m5/pi-provider-key.sh $name $replace" \
    || echo "$name=not_installed (missing in .env, already present, or refused)"
done
"${SSH[@]}" 'bash /opt/firecrawl-pi/scripts/m5/pi-provider-key.sh status' </dev/null
