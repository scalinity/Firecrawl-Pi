// The restore test's client (scripts/ops/restore-test.sh), run in a throwaway container of the restored gateway image
// on the restored copy's own internal access network, so it reaches that gateway and nothing else. It reads its plan on
// stdin (the gateway's address, the tokens of the restored client registry, the requests to make) and prints one JSON
// line per request with the status and the body; the host side compares hashes, so both sides hash one canonical form.
// Nothing here decides a verdict. node:http, not fetch: fetch will not send the Host header the gateway checks.
import { request } from "node:http";
import { createHash } from "node:crypto";
const plan = JSON.parse(await new Response(process.stdin).text());
const out = (o) => process.stdout.write(`${JSON.stringify(o)}\n`);
const base = new URL(plan.base);
function send(r) {
  return new Promise((resolve) => {
    const data = r.body === undefined ? undefined : Buffer.from(JSON.stringify(r.body));
    const headers = { host: plan.host, accept: "application/json, text/event-stream", ...(r.token ? { authorization: `Bearer ${plan.tokens[r.token]}` } : {}),
      ...(data ? { "content-type": "application/json", "content-length": data.length } : {}), ...(r.headers ?? {}) };
    const t0 = Date.now();
    const req = request({ host: base.hostname, port: base.port, method: r.method, path: r.path, headers, timeout: r.timeoutMs ?? 90000 }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => {
        const buf = Buffer.concat(chunks), sse = /text\/event-stream/.test(res.headers["content-type"] ?? "");
        let body = null;
        if (r.binary) body = { sha256: createHash("sha256").update(buf).digest("hex"), bytes: buf.length };
        else { const text = buf.toString(); try { body = JSON.parse(sse ? text.split("\n").filter((l) => l.startsWith("data: ")).at(-1).slice(6) : text); } catch { body = { unparsed: text.slice(0, 300) }; } }
        resolve({ id: r.id, status: res.statusCode, ms: Date.now() - t0, body });
      });
    });
    req.on("timeout", () => req.destroy(new Error("timeout")));
    req.on("error", (e) => resolve({ id: r.id, status: 0, ms: Date.now() - t0, error: String(e.message ?? e).slice(0, 200) }));
    req.end(data);
  });
}
for (const r of plan.requests) out(await send(r));
