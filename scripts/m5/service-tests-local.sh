#!/usr/bin/env bash
# A service's unit tests on the workstation's Colima VM, inside that service's image built from the working
# tree (tagged fcpi/<service>-test:local, never deployed), the tests and the capability manifest mounted
# read-only, with no network. Throwaway containers carry the label fcpi.transient (CLAUDE.md §33.7).
#   scripts/m5/service-tests-local.sh access|mcp
set -uo pipefail
root=$(cd "$(dirname "$0")/../.." && pwd)
svc=${1:?usage: service-tests-local.sh access|mcp}
case $svc in access) dir=/srv/gateway ;; mcp) dir=/srv/mcp ;; *) echo "unknown service $svc"; exit 2 ;; esac
D() { docker --context colima "$@"; }
workdir=$(sed -n 's/^WORKDIR //p' "$root/services/$svc/Dockerfile" | head -1)
D build -q --platform linux/arm64 -t "fcpi/$svc-test:local" "$root/services/$svc" >/dev/null || { echo "image build failed"; exit 1; }
D run --rm --network none --read-only --cap-drop ALL --security-opt no-new-privileges:true --tmpfs /tmp --label fcpi.transient=service-tests-local \
  -v "$root/services/$svc/test:${workdir:-$dir}/test:ro" -v "$root/deploy/policies:/srv/policy:ro" \
  -e FCPI_TEST_MANIFEST=/srv/policy/capabilities.json "fcpi/$svc-test:local" sh -c 'node --test --test-timeout=120000 test/*.test.mjs' 2>&1
rc=$?
echo "test_exit=$rc"
exit $rc
