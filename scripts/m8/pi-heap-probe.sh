#!/usr/bin/env bash
# The core's heap on large pages under the 384 MiB ceiling (M4 review finding F1, deferred to M8), ON the Pi:
#   ssh … 'bash -s -- <kb> [<kb> …]' < scripts/m8/pi-heap-probe.sh
# First the API child's live heap at rest; then, for each size, a scrape of the M3 fixture's /big?kb=N page (markdown,
# html and rawHtml, the largest answer a page gives) through the gateway as the soak client, with the answer's status and
# size, the core container's start time, restart count and cgroup memory before and after, any V8 heap failure the core
# logged, and the API child's live heap after a full GC. The live heap is read as M7 measured it: SIGUSR1 to the exact
# process whose arguments are `node dist/src/index.js` (never its sh -c wrapper, which SIGUSR1 would end), then, inside
# the container, HeapProfiler.collectGarbage and process.memoryUsage() over the inspector on 127.0.0.1:9229. The core is
# restarted at the end so the inspector does not stay open. The token goes to curl on stdin; nothing secret is printed.
set -uo pipefail
export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
c=$(sudo -n docker ps -q --filter label=com.docker.compose.project=fcpi --filter label=com.docker.compose.service=firecrawl-core)
cg() { local id parent; read -r id parent < <(sudo -n docker inspect -f '{{.Id}} {{.HostConfig.CgroupParent}}' "$c"); echo "/sys/fs/cgroup/${parent:-system.slice}/docker-$id.scope"; }
st() { local p; p=$(cg); echo "core started=$(sudo -n docker inspect -f '{{.State.StartedAt}}' "$c") restarts=$(sudo -n docker inspect -f '{{.RestartCount}}' "$c") health=$(sudo -n docker inspect -f '{{.State.Health.Status}}' "$c") memory.current=$(cat "$p/memory.current") memory.peak=$(cat "$p/memory.peak")"; }
healthy() { for _ in $(seq 1 120); do [ "$(sudo -n docker inspect -f '{{.State.Health.Status}}' "$c")" = healthy ] && return 0; sleep 2; done; return 1; }
heap() {
  local pid
  pid=$(sudo -n docker top "$c" -eo pid,args | awk '$2 == "node" && $3 == "dist/src/index.js" && NF == 3 {print $1}' | head -1)
  [ -n "$pid" ] || { echo "live_heap=unavailable (no API child)"; return; }
  sudo -n kill -USR1 "$pid"; sleep 2
  sudo -n docker exec -u 3002 "$c" node -e '
    const list = await (await fetch("http://127.0.0.1:9229/json/list")).json();
    const t = list.find((x) => x.type === "node") ?? list[0];
    const ws = new WebSocket(t.webSocketDebuggerUrl); let n = 0; const pend = new Map();
    const call = (method, params = {}) => new Promise((res) => { const id = ++n; pend.set(id, res); ws.send(JSON.stringify({ id, method, params })); });
    ws.onmessage = (e) => { const m = JSON.parse(e.data); if (pend.has(m.id)) { pend.get(m.id)(m.result); pend.delete(m.id); } };
    await new Promise((r) => (ws.onopen = r));
    await call("HeapProfiler.enable"); await call("HeapProfiler.collectGarbage");
    const r = await call("Runtime.evaluate", { expression: "JSON.stringify(process.memoryUsage())", returnByValue: true });
    const u = JSON.parse(r.result.value), mib = (b) => (b / 1048576).toFixed(1);
    console.log(`live_heap_used_mib=${mib(u.heapUsed)} heap_total_mib=${mib(u.heapTotal)} rss_mib=${mib(u.rss)} external_mib=${mib(u.external)} array_buffers_mib=${mib(u.arrayBuffers)}`);
    ws.close(); process.exit(0);' --input-type=module 2>&1 | tail -1
}
echo "### meta"
echo "utc=$(date -u +%Y-%m-%dT%H:%M:%SZ) source_commit=$(cat /opt/firecrawl-pi/.fcpi-source-commit) node_options=$(sudo -n docker inspect "$c" | jq -r '.[0].Config.Env[]' | grep ^NODE_OPTIONS= | cut -d= -f2-) mem_limit=$(sudo -n docker inspect -f '{{.HostConfig.Memory}}' "$c")"
echo "### rest"
healthy || echo "core not healthy at the start"
st; heap
for kb in "$@"; do
  echo "### probe_$kb"
  healthy || echo "core not healthy before the probe"
  # The core's log from the line it had reached, not from a time (docker's timestamps go back after a power cut).
  n0=$(sudo -n docker logs "$c" 2>&1 | wc -l); st
  out=$(mktemp)
  sudo -n cat /etc/firecrawl-pi/secrets/clients/soak.token | sed 's/^/Authorization: Bearer /' | \
    curl -sS -m 150 -o "$out" -w "http=%{http_code} bytes=%{size_download} seconds=%{time_total}\n" -H @- -H 'content-type: application/json' \
      --data "{\"url\":\"http://m3.fixture.fcpi.test:8080/big?kb=$kb\",\"formats\":[\"markdown\",\"html\",\"rawHtml\"]}" http://127.0.0.1:3380/v2/scrape
  echo "code=$(jq -r '.code // "none"' "$out" 2>/dev/null) markdown_chars=$(jq -r '.data.markdown // "" | length' "$out" 2>/dev/null) html_chars=$(jq -r '.data.html // "" | length' "$out" 2>/dev/null) rawHtml_chars=$(jq -r '.data.rawHtml // "" | length' "$out" 2>/dev/null) sentinel=$(grep -c 'fcpi-m3-big' "$out")"
  rm -f "$out"
  sleep 5; st
  echo "heap_failures_logged=$(sudo -n docker logs "$c" 2>&1 | tail -n +"$((n0 + 1))" | grep -a -c 'JavaScript heap out of memory')"
  heap
done
echo "### restart"
sudo -n docker restart "$c" >/dev/null && healthy && echo "core restarted to close the inspector: $(st)"
echo "### end"
