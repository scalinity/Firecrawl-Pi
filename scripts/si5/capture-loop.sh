#!/bin/bash
# SI5's capture driver: rebuilds the judged pool (pool.mjs) and captures the URLs not yet captured (capture.mjs, one Pi batch at
# a time) every two minutes, until evidence/search-intelligence/SI5/eval/private/capture-done exists. Each pass is restartable:
# capture.mjs skips any URL with a definitive capture and retries the rest.
#   nohup scripts/si5/capture-loop.sh &      (stop: touch evidence/search-intelligence/SI5/eval/private/capture-done)
cd "$(dirname "$0")/../.." || exit 1
P=evidence/search-intelligence/SI5/eval/private
while [ ! -e $P/capture-done ]; do
  node scripts/si5/pool.mjs >> $P/capture.log 2>&1
  node scripts/si5/capture.mjs >> /dev/null 2>> $P/capture.log
  sleep 120
done
echo "$(date -u +%FT%TZ) capture loop ended" >> $P/capture.log
