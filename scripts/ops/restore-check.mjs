// The restore test's client (scripts/ops/restore-test.sh), run in a throwaway container of the restored gateway image
// on the restored copy's own internal access network, so it reaches that gateway and nothing else. It reads its plan on
// stdin (the gateway's address, the tokens of the restored client registry, the requests to make) and prints one JSON
// line per request with the status and the body; the host side compares hashes, so both sides hash one canonical form.
// Nothing here decides a verdict.
const plan = JSON.parse(await new Response(process.stdin).text());
const out = (o) => process.stdout.write(`${JSON.stringify(o)}\n`);
for (const r of plan.requests) {
  const headers = { host: plan.host, accept: "application/json, text/event-stream", ...(r.token ? { authorization: `Bearer ${plan.tokens[r.token]}` } : {}), ...(r.headers ?? {}) };
  if (r.body !== undefined) headers["content-type"] = "application/json";
  const t0 = Date.now();
  try {
    const res = await fetch(`${plan.base}${r.path}`, { method: r.method, headers, body: r.body === undefined ? undefined : JSON.stringify(r.body), signal: AbortSignal.timeout(r.timeoutMs ?? 90000) });
    const buf = Buffer.from(await res.arrayBuffer());
    const sse = /text\/event-stream/.test(res.headers.get("content-type") ?? "");
    let body = null;
    if (r.binary) body = { sha256: (await import("node:crypto")).createHash("sha256").update(buf).digest("hex"), bytes: buf.length };
    else { const text = buf.toString(); try { body = JSON.parse(sse ? text.split("\n").filter((l) => l.startsWith("data: ")).at(-1).slice(6) : text); } catch { body = { unparsed: text.slice(0, 300) }; } }
    out({ id: r.id, status: res.status, ms: Date.now() - t0, body });
  } catch (e) { out({ id: r.id, status: 0, ms: Date.now() - t0, error: String(e.message ?? e).slice(0, 200) }); }
}
