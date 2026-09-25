// Runs INSIDE the firecrawl-core container (`docker exec -i <core> node --input-type=module - < core-probe.mjs`).
// Probes the harness children's own health endpoints on localhost and prints one JSON line.
// Ports follow harness.ts with NUQ_WORKER_COUNT=1: api 3002, extract-worker 3004,
// queue worker 3005, nuq-worker-0 3006 (its /health runs a PostgreSQL query),
// nuq-prefetch-worker 3007, nuq-reconciler 3008.
const endpoints = {
  api_liveness: "http://127.0.0.1:3002/v0/health/liveness",
  api_readiness: "http://127.0.0.1:3002/v0/health/readiness",
  extract_worker: "http://127.0.0.1:3004/health",
  queue_worker: "http://127.0.0.1:3005/liveness",
  nuq_worker_0: "http://127.0.0.1:3006/health",
  nuq_prefetch_worker: "http://127.0.0.1:3007/health",
  nuq_reconciler: "http://127.0.0.1:3008/health",
};
const out = { utc: new Date().toISOString() };
await Promise.all(Object.entries(endpoints).map(async ([k, url]) => {
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(5000) });
    out[k] = { status: r.status, body: (await r.text()).slice(0, 200) };
  } catch (e) {
    out[k] = { status: null, error: e.cause?.code ?? e.name };
  }
}));
console.log(JSON.stringify(out));
