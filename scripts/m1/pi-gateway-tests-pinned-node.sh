#!/usr/bin/env bash
# The gateway's contract suite on the Node that serves it: the pinned image the
# access-gateway container runs (REVIEW.md R10; V05 runs it on the workstation's Node).
# Runs ON the Pi:  ssh ... 'bash /opt/firecrawl-pi/scripts/m1/pi-gateway-tests-pinned-node.sh'
# The throwaway container has no network (loopback only), a read-only root filesystem, no
# capabilities and the gateway's uid; the repository is mounted read-only; --rm removes it.
set -uo pipefail
export LC_ALL=C
export PATH="/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"
REPO=/opt/firecrawl-pi
sec() { printf '### %s\n' "$1"; }

sec meta
date -u +%Y-%m-%dT%H:%M:%SZ
echo "source_commit=$(cat $REPO/.fcpi-source-commit)"
GW=$(sudo -n docker ps -q --filter label=com.docker.compose.project=fcpi --filter label=com.docker.compose.service=access-gateway)
IMG=$(sudo -n docker inspect -f '{{.Config.Image}}' "$GW")
echo "image=$IMG"

sec run
sudo -n docker run --rm --pull never --network none --read-only --tmpfs /tmp:size=16m \
  --user 3380:3380 --cap-drop ALL --security-opt no-new-privileges:true --label fcpi.transient=gateway-contract-tests \
  -v $REPO/tests:/w/tests:ro -v $REPO/services:/w/services:ro -w /w "$IMG" \
  sh -c 'echo "node_version=$(node --version)"; exec node --test --test-reporter=tap tests/contracts/m1-gateway.test.mjs' 2>&1
echo "exit=$?"
echo "leftover_transient_containers=$(sudo -n docker ps -aq --filter label=fcpi.transient | wc -l)"
echo end
