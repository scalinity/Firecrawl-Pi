// Probe: stream one Messages API call and record every event's arrival time, type and usage.
// Usage: node stream-probe.mjs <model> <effort|none> <out.json>   (key read from .env, never printed)
import { readFileSync, writeFileSync } from "node:fs";
const [model, effort, out] = process.argv.slice(2);
const env = Object.fromEntries(readFileSync("/Users/danny/Documents/Tools/Firecrawl/.env", "utf8").split("\n").filter((l) => /^[A-Z_]+=/.test(l)).map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1).trim().replace(/^["']|["']$/g, "")]));
const key = env.AGENT_ANTHROPIC_API_KEY;
const schema = { type: "object", additionalProperties: false, required: ["answer", "steps"], properties: { answer: { type: "integer" }, steps: { type: "array", items: { type: "string" } } } };
const body = { model, max_tokens: 32000, stream: true,
  messages: [{ role: "user", content: "Count how many integers between 1 and 5000 have a digit sum divisible by 7 and are themselves prime. Reason carefully, then give the count and a short list of the method steps." }],
  ...(effort === "none" ? { thinking: { type: "disabled" } } : {}),
  output_config: { ...(effort !== "none" ? { effort } : {}), format: { type: "json_schema", schema } } };
const t0 = Date.now();
const res = await fetch("https://api.anthropic.com/v1/messages", { method: "POST", headers: { "content-type": "application/json", "anthropic-version": "2023-06-01", "x-api-key": key }, body: JSON.stringify(body) });
const events = [];
let buf = "", last = Date.now(), maxGap = 0, bytes = 0;
const dec = new TextDecoder();
for await (const chunk of res.body) {
  const now = Date.now(); maxGap = Math.max(maxGap, now - last); last = now; bytes += chunk.length;
  buf += dec.decode(chunk, { stream: true });
  let i;
  while ((i = buf.indexOf("\n\n")) >= 0) {
    const raw = buf.slice(0, i); buf = buf.slice(i + 2);
    const data = raw.split("\n").filter((l) => l.startsWith("data:")).map((l) => l.slice(5).trim()).join("");
    if (!data) continue;
    let j; try { j = JSON.parse(data); } catch { continue; }
    events.push({ ms: now - t0, type: j.type, delta: j.delta?.type ?? null, usage: j.usage ?? j.message?.usage ?? null, stop: j.delta?.stop_reason ?? null, len: (j.delta?.text ?? j.delta?.thinking ?? j.delta?.partial_json ?? "").length });
  }
}
const counts = {}; for (const e of events) { const k = e.delta ? `${e.type}:${e.delta}` : e.type; counts[k] = (counts[k] ?? 0) + 1; }
const gaps = events.slice(1).map((e, i) => e.ms - events[i].ms);
writeFileSync(out, JSON.stringify({ model, effort, status: res.status, requestId: res.headers.get("request-id"), totalMs: Date.now() - t0, firstEventMs: events[0]?.ms, maxGapMs: Math.max(...gaps), maxChunkGapMs: maxGap, bytes, counts,
  usageEvents: events.filter((e) => e.usage), last: events.slice(-3) }, null, 2));
console.log(JSON.stringify({ status: res.status, totalMs: Date.now() - t0, maxGapMs: Math.max(...gaps), counts }));
