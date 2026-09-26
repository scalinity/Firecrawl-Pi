// The MCP service's memory envelope, measured (M4's M02): run inside the MCP image on the Pi by
// scripts/m4/pi-mcp-memory-probe.sh, with the deployed capability manifest at /srv/policy/capabilities.json.
// It starts the image's own server.mjs (with the NODE_OPTIONS the container runs with) against a fake
// gateway whose status answers are as large as the MCP service accepts (restResponseMaxBytes, less a
// margin), fires maxToolCalls status reads at once, three rounds, in two shapes (a page of many documents,
// and one document over the payload limit, which is copied and cut), and prints the server's resident
// memory before and its peak (VmHWM) after, as JSON lines. Loopback only; writes only its own manifest
// copy to /tmp.
import { createServer, request } from "node:http";
import { spawn } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";

const manifest = JSON.parse(readFileSync("/srv/policy/capabilities.json", "utf8"));
const L = manifest.mcp.limits;
const JOB = "0f8fad5b-d9cb-469f-a165-70867728950e";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const status = (pid) => Object.fromEntries(readFileSync(`/proc/${pid}/status`, "utf8").split("\n").filter((l) => /^Vm(RSS|HWM):/.test(l)).map((l) => [l.split(":")[0], Number(l.replace(/\D+/g, "")) * 1024]));

// The fake gateway: every status read answers a completed page just under the MCP service's answer cap.
let shape = "page";
const answerBytes = L.restResponseMaxBytes - 65536;
const body = (limit) => {
  const n = shape === "page" ? limit : 1;
  const each = Math.floor(answerBytes / n) - 256;
  return JSON.stringify({ success: true, status: "completed", completed: n, total: n, creditsUsed: n, expiresAt: "2026-10-03T00:00:00.000Z",
    data: Array.from({ length: n }, (_, i) => ({ markdown: "x".repeat(each), metadata: { sourceURL: `https://example.com/${i}` } })) });
};
// Each answer is built once and served from memory, so the fake adds little to the container and the
// server's own peak (VmHWM) is the measure, read against the service's cap.
const cache = new Map();
const fake = createServer((req, res) => {
  const u = new URL(req.url, "http://gw");
  const key = `${shape}:${u.searchParams.get("limit")}`;
  if (!cache.has(key)) cache.set(key, Buffer.from(body(Number(u.searchParams.get("limit") ?? L.statusPageDefault))));
  const b = cache.get(key);
  res.writeHead(200, { "content-type": "application/json", "content-length": b.length, "x-request-id": "00000000-0000-4000-8000-000000000000" });
  res.end(b);
});
await new Promise((r) => fake.listen(0, "127.0.0.1", r));
writeFileSync("/tmp/capabilities.json", JSON.stringify(manifest));
const child = spawn(process.execPath, ["/srv/mcp/server.mjs"], { cwd: "/srv/mcp", stdio: ["ignore", "pipe", "inherit"],
  env: { PATH: process.env.PATH, NODE_OPTIONS: process.env.PROBE_NODE_OPTIONS ?? "", PI_MCP_LISTEN_PORT: "0", PI_MCP_REST_URL: `http://127.0.0.1:${fake.address().port}`, PI_CAPABILITIES_FILE: "/tmp/capabilities.json", PI_CLOUD_ACCESS_ENABLED: "false" } });
let buf = "";
const port = await new Promise((resolve, reject) => {
  child.stdout.on("data", (c) => { buf += c; for (const l of buf.split("\n")) { try { const o = JSON.parse(l); if (o.event === "listening") resolve(o.port); } catch { /* partial */ } } });
  child.on("exit", (c) => reject(new Error(`server exited ${c}`)));
});
const META = { "io.modelcontextprotocol/protocolVersion": "2026-07-28", "io.modelcontextprotocol/clientCapabilities": {} };
const call = (limit) => new Promise((resolve) => {
  const data = Buffer.from(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "firecrawl_check_crawl_status", arguments: { id: JOB, limit }, _meta: META } }));
  const q = request({ host: "127.0.0.1", port, method: "POST", path: "/mcp", headers: { host: "127.0.0.1:3380", "content-type": "application/json", "content-length": data.length, accept: "application/json, text/event-stream",
    authorization: `Bearer fcpi_probe_${"0".repeat(64)}`, "x-fcpi-client": "probe", "x-fcpi-principal": "probe", "x-fcpi-scopes": "read", "x-request-id": "00000000-0000-4000-8000-000000000001",
    "mcp-protocol-version": "2026-07-28", "mcp-method": "tools/call", "mcp-name": "firecrawl_check_crawl_status" } }, (res) => {
    const c = []; res.on("data", (x) => c.push(x)); res.on("end", () => { try { const r = JSON.parse(Buffer.concat(c).toString()); resolve({ ok: !r.result?.isError, bytes: Buffer.byteLength(r.result?.content?.[0]?.text ?? "") }); } catch { resolve({ ok: false }); } });
  });
  q.on("error", () => resolve({ ok: false }));
  q.end(data);
});
await sleep(1500);
const base = status(child.pid);
console.log(JSON.stringify({ event: "baseline", node: process.version, node_options: process.env.PROBE_NODE_OPTIONS ?? "", rest_response_max_bytes: L.restResponseMaxBytes, max_tool_calls: L.maxToolCalls, rss: base.VmRSS }));
for (const s of ["page", "one_large_document"]) {
  shape = s;
  const results = [];
  for (let round = 0; round < 3; round++) results.push(...(await Promise.all(Array.from({ length: L.maxToolCalls }, () => call(L.statusPageMax)))));
  await sleep(500);
  cache.clear();
  const st = status(child.pid);
  console.log(JSON.stringify({ event: "shape", shape: s, answer_bytes: answerBytes, concurrent: L.maxToolCalls, calls: results.length, ok: results.filter((r) => r.ok).length,
    max_text_bytes: Math.max(...results.map((r) => r.bytes ?? 0)), rss_after: st.VmRSS, peak_rss: st.VmHWM, alive: child.exitCode === null }));
}
child.kill(); fake.close();
