#!/usr/bin/env node
// SI5's second judging round through an API model (docs/FIRECRAWL_PI_SEARCH_INTELLIGENCE_SPEC.md §23.1). It is the Claude judges'
// task (judge-prompt.md) with each packet supplied inline, because an API model has no file tools: it sees the question, the
// predeclared requirements and the documents of one packet and nothing else, so it cannot reach outside its packet. Its reply
// is held to the packet's shape (judge-api-lib.mjs) and written as eval/private/judgments/second/<query>.json; labels.mjs final
// then checks every cited passage against the document file, as for any judge. The exact prompt sent is saved under
// judge-prompts/ and hashed, and the run's record (model reported, settings, tokens, cost, times) goes to
// eval/private/judge-runs/second.json, which judges.mjs merges into eval/judges.json. The key is read from .env and never printed.
// A query already judged is skipped, so the run can be repeated; a reply that fails its checks is retried once with the failed
// checks shown to the model, and a query that still fails is reported and left unwritten.
//   node scripts/si5/judge-api.mjs --model <OpenRouter model id> [--only Q001,Q002] [--concurrency 4] [--chunk-tokens 150000] [--dry-run]
import { readFileSync, writeFileSync, readdirSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { parseReply, checkJudgments, chunkDocs } from "./judge-api-lib.mjs";

const root = new URL("../../", import.meta.url).pathname;
const EVAL = join(root, "evidence/search-intelligence/SI5/eval"), PRIV = join(EVAL, "private");
const OUT = join(PRIV, "judgments/second"), RUNS = join(PRIV, "judge-runs/second.json");
const arg = (name, dflt) => { const i = process.argv.indexOf(`--${name}`); return i < 0 ? dflt : process.argv[i + 1]; };
const MODEL = arg("model", null), ONLY = arg("only", null)?.split(","), CONCURRENCY = Number(arg("concurrency", "4")), CHUNK = Number(arg("chunk-tokens", "150000")), DRY = process.argv.includes("--dry-run");
const MAX_OUT = 64000;
if (!MODEL) { console.error("usage: judge-api.mjs --model <OpenRouter model id> [--only Q001,Q002] [--concurrency 4] [--chunk-tokens 150000] [--dry-run]"); process.exit(2); }
const sha = (s) => createHash("sha256").update(s).digest("hex");
const say = (o) => process.stderr.write(`${new Date().toISOString()} ${JSON.stringify(o)}\n`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const keyOf = () => [...readFileSync(join(root, ".env"), "utf8").matchAll(/^OPENROUTER_API_KEY=(.*)$/gm)].map((m) => m[1].trim().replace(/^['"]|['"]$/g, "")).filter(Boolean).at(-1) ?? null;
const KEY = DRY ? null : keyOf();
if (!DRY && !KEY) { console.error("OPENROUTER_API_KEY is not set in .env"); process.exit(2); }

const template = readFileSync(join(root, "scripts/si5/judge-prompt.md"), "utf8");
const API_NOTE = "\n\nAPI RUN. You have no tools, no files and no network. Your packet is supplied in the user message below: its task.json, its index.json and every document file, each introduced by a line `=== FILE <name> ===`. Ignore the instructions above about reading, searching or writing files. Reply with ONLY the single JSON object that the output shape above describes for this packet (no code fence, no commentary), with one entry per document in the supplied index.json. A document's `id` is its file name without the `.md` extension (docs/d10d2275044.md has the id d10d2275044).\n";
const promptFor = (q) => template.replaceAll("{{PACKETS}}", `the packet for ${q}, supplied in the user message`).replaceAll("{{OUTDIR}}", "your reply") + API_NOTE;

const selection = JSON.parse(readFileSync(join(EVAL, "second-selection.json"), "utf8"));
const wanted = (Array.isArray(selection.queries) ? selection.queries : Object.keys(selection.queries))
  .filter((q) => !existsSync(join(OUT, `${q}.json`)) && (!ONLY || ONLY.includes(q)));

const loadPacket = (q) => {
  const dir = join(PRIV, "packets-second", q), index = JSON.parse(readFileSync(join(dir, "index.json"), "utf8"));
  return { task: readFileSync(join(dir, "task.json"), "utf8"), docs: index.documents.map((name) => ({ name, text: readFileSync(join(dir, "docs", name), "utf8") })) };
};
const userMessage = (task, q, group) => `=== FILE task.json ===\n${task}\n\n=== FILE index.json ===\n${JSON.stringify({ query: q, documents: group.map((d) => d.name) }, null, 1)}\n\n`
  + group.map((d) => `=== FILE docs/${d.name} ===\n${d.text}`).join("\n\n");

if (DRY) {
  let docs = 0, requests = 0, tokens = 0;
  for (const q of wanted) { const p = loadPacket(q), g = chunkDocs(p.docs, CHUNK), t = Math.round(p.docs.reduce((n, d) => n + d.text.length, 0) / 4); docs += p.docs.length; requests += g.length; tokens += t; say({ query: q, docs: p.docs.length, requests: g.length, estTokens: t }); }
  console.log(JSON.stringify({ queries: wanted.length, documents: docs, requests, estInputTokens: tokens }));
  process.exit(0);
}

async function call(messages) {
  for (let attempt = 1; ; attempt++) {
    let res;
    try {
      res = await fetch("https://openrouter.ai/api/v1/chat/completions", { method: "POST", headers: { authorization: `Bearer ${KEY}`, "content-type": "application/json", "x-title": "fcpi-si5-judge" },
        body: JSON.stringify({ model: MODEL, messages, temperature: 0, max_tokens: MAX_OUT, response_format: { type: "json_object" }, usage: { include: true } }), signal: AbortSignal.timeout(900000) });
    } catch (e) { if (attempt >= 4) throw e; await sleep(5000 * attempt); continue; }
    if (res.status === 402) { say({ fatal: "OpenRouter answered 402: out of credits" }); process.exit(3); }
    if ((res.status === 429 || res.status >= 500) && attempt < 4) { await sleep(5000 * attempt); continue; }
    if (!res.ok) throw new Error(`OpenRouter answered ${res.status}: ${(await res.text()).slice(0, 200)}`);
    return res.json();
  }
}

// One request per document group. A reply that fails its checks is shown to the model with those checks, once.
async function judgeGroup(q, system, task, group, tally) {
  const ids = group.map((d) => d.name.slice(0, -3));
  let messages = [{ role: "system", content: system }, { role: "user", content: userMessage(task, q, group) }], failed = "";
  for (let tries = 1; tries <= 2; tries++) {
    const r = await call(messages);
    tally.requests++; tally.promptTokens += r.usage?.prompt_tokens ?? 0; tally.completionTokens += r.usage?.completion_tokens ?? 0; tally.costUsd += Number(r.usage?.cost ?? 0);
    if (r.model) tally.models.add(r.model);
    const text = r.choices?.[0]?.message?.content ?? "";
    try {
      const errs = checkJudgments(parseReply(text), q, ids);
      if (!errs.length) return parseReply(text).judgments;
      failed = errs.slice(0, 6).join("; ");
    } catch (e) { failed = e.message; }
    // A reply that failed its checks is kept (private, like every judgment) with the reason, for the record.
    mkdirSync(join(PRIV, "judge-runs/failed"), { recursive: true });
    writeFileSync(join(PRIV, `judge-runs/failed/${q}-${ids[0]}-try${tries}.txt`), `finish_reason=${r.choices?.[0]?.finish_reason ?? null} completion_tokens=${r.usage?.completion_tokens ?? null}\nchecks: ${failed}\n\n${text}\n`);
    messages = [...messages, { role: "assistant", content: text }, { role: "user", content: `Your reply failed these checks: ${failed}. Reply again with ONLY the corrected JSON object, for the same documents.` }];
  }
  throw new Error(`${q}: the reply failed its checks twice (${failed})`);
}

async function judgeQuery(q) {
  const started = new Date().toISOString(), p = loadPacket(q), system = promptFor(q), promptFile = `judge-prompts/second-api-${q}.md`;
  mkdirSync(join(PRIV, "judge-prompts"), { recursive: true });
  writeFileSync(join(PRIV, promptFile), system);
  const tally = { requests: 0, promptTokens: 0, completionTokens: 0, costUsd: 0, models: new Set() };
  const judgments = [];
  for (const group of chunkDocs(p.docs, CHUNK)) judgments.push(...await judgeGroup(q, system, p.task, group, tally));
  mkdirSync(OUT, { recursive: true });
  writeFileSync(join(OUT, `${q}.json`), JSON.stringify({ schema: "fcpi.si5-judgments/v1", query: q, judgments }) + "\n");
  const runs = existsSync(RUNS) ? JSON.parse(readFileSync(RUNS, "utf8")) : { schema: "fcpi.si5-judge-runs/v1", round: "second", queries: {} };
  runs.queries[q] = { agent: `openrouter:${MODEL}`, models: [...tally.models].sort(), prompt: promptFile, promptSha256: sha(system), promptRead: "inline_exact", launch: "api_inline", started, ended: new Date().toISOString(),
    toolCalls: 0, flags: [], contained: true, api: { requestedModel: MODEL, requests: tally.requests, promptTokens: tally.promptTokens, completionTokens: tally.completionTokens, costUsd: +tally.costUsd.toFixed(6), temperature: 0, responseFormat: "json_object", maxTokens: MAX_OUT } };
  mkdirSync(join(PRIV, "judge-runs"), { recursive: true });
  writeFileSync(RUNS, JSON.stringify(runs, null, 1) + "\n");
  const nulls = judgments.filter((j) => j.grade === null).length;
  say({ query: q, judged: judgments.length, nulls, requests: tally.requests, promptTokens: tally.promptTokens, costUsd: +tally.costUsd.toFixed(4), model: [...tally.models].join(",") });
}

say({ model: MODEL, queries: wanted.length, concurrency: CONCURRENCY, chunkTokens: CHUNK });
const failures = [], queue = [...wanted];
await Promise.all(Array.from({ length: Math.min(CONCURRENCY, queue.length) }, async () => {
  for (let q; (q = queue.shift()); ) { try { await judgeQuery(q); } catch (e) { failures.push(q); say({ query: q, failed: String(e.message).slice(0, 300) }); } }
}));
say({ done: wanted.length - failures.length, failed: failures });
process.exit(failures.length ? 1 : 0);
