#!/bin/bash
cd /Users/danny/Documents/Tools/Firecrawl; . scripts/m1/pi-target.conf
ssh -i "$PI_SSH_KEY" -o IdentitiesOnly=yes -o BatchMode=yes -o ConnectTimeout=15 -o ServerAliveInterval=30 -o ServerAliveCountMax=20 "$PI_SSH_TARGET" 'sudo -n bash -c '"'"'
mem() { awk "/^MemAvailable:/ {printf \"%d\", \$2/1024}" /proc/meminfo; }
echo "{\"kind\":\"host\",\"phase\":\"before\",\"memAvailableMiB\":$(mem),\"utc\":\"$(date -u +%FT%TZ)\"}"
( while true; do echo "{\"kind\":\"host\",\"phase\":\"during\",\"memAvailableMiB\":$(mem),\"utc\":\"$(date -u +%FT%TZ)\"}"; sleep 10; done ) &
SP=$!
docker run -i --rm --read-only --cap-drop ALL --security-opt no-new-privileges:true --tmpfs /tmp:size=64m --label fcpi.transient=si6-l01 --network none --user 3310:3310 -e N=30 -e ROUNDS=8 \
  -v /opt/firecrawl-pi/services/retrieval/test:/srv/retrieval/test:ro -v /opt/firecrawl-pi/tests/fixtures:/srv/retrieval/fixtures:ro -v /opt/firecrawl-pi/deploy/policies:/srv/retrieval/policy:ro -v /opt/firecrawl-pi/deploy/nuq-postgres/fcpi-retrieval-schema.sql:/srv/retrieval/schema.sql:ro \
  fcpi/retrieval@sha256:d13b5a9b0a535d8642daed4906ee7ef5bb573468fd007f87f94d0772e96282b0 node --input-type=module -
kill $SP 2>/dev/null
echo "{\"kind\":\"host\",\"phase\":\"after\",\"memAvailableMiB\":$(mem),\"utc\":\"$(date -u +%FT%TZ)\"}"
echo "{\"kind\":\"transient\",\"left\":$(docker ps -aq --filter label=fcpi.transient | wc -l)}"
'"'"'' < evidence/search-intelligence/SI6/l01/bench.mjs > evidence/search-intelligence/SI6/raw/l01-fixture.jsonl 2>&1
echo "bench session exit $?"
