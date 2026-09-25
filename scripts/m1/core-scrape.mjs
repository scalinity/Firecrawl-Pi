// Runs INSIDE a container that can reach the target API, e.g.
//   docker exec -i -e SCRAPE_URL=... <core> node --input-type=module - < core-scrape.mjs
// POSTs one scrape and prints one JSON line with the outcome and the Markdown.
// Env: SCRAPE_API (default http://127.0.0.1:3002), SCRAPE_URL (required),
//      SCRAPE_TIMEOUT_MS (API-side timeout, default 60000), SCRAPE_TOKEN_FILE (optional bearer token file).
import { readFileSync } from "node:fs";

const api = process.env.SCRAPE_API ?? "http://127.0.0.1:3002";
const timeout = Number(process.env.SCRAPE_TIMEOUT_MS ?? 60000);
const headers = { "content-type": "application/json" };
if (process.env.SCRAPE_TOKEN_FILE) headers.authorization = `Bearer ${readFileSync(process.env.SCRAPE_TOKEN_FILE, "utf8").trim()}`;
const started = Date.now();
const out = { utc_start: new Date(started).toISOString(), url: process.env.SCRAPE_URL };
try {
  const r = await fetch(`${api}/v2/scrape`, {
    method: "POST", headers,
    body: JSON.stringify({ url: process.env.SCRAPE_URL, formats: ["markdown"], timeout }),
    signal: AbortSignal.timeout(timeout + 30000),
  });
  const j = await r.json().catch(() => null);
  Object.assign(out, {
    http_status: r.status,
    success: j?.success ?? null,
    scrape_id: j?.data?.metadata?.scrapeId ?? null,
    source_status: j?.data?.metadata?.statusCode ?? null,
    title: j?.data?.metadata?.title ?? null,
    markdown_b64: typeof j?.data?.markdown === "string" ? Buffer.from(j.data.markdown, "utf8").toString("base64") : null,
    error: j?.error ?? null,
    www_authenticate: r.headers.get("www-authenticate"),
  });
} catch (e) {
  Object.assign(out, { http_status: null, error: `${e.name}: ${e.cause?.code ?? e.message}` });
}
out.elapsed_ms = Date.now() - started;
console.log(JSON.stringify(out));
