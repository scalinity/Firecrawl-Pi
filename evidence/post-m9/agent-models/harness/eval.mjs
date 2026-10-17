// Agent quality by model. The real Agent loop (scripts/playground/agent.mjs, copied with only MODEL/EFFORT changed) runs
// unchanged; search and page retrieval go to the Pi through the playground's own SSH forwarder; the json format the Agent
// asks for is answered on this workstation by the real retrieval extractor (src/extract.mjs: same prompt, chunking,
// schema, repair, streaming transport) calling the Anthropic API with the Agent's key. Only the model differs per arm.
//   node eval.mjs <out.jsonl> [reps] [arm,arm...]
import { readFileSync, writeFileSync, appendFileSync, mkdirSync, mkdtempSync, rmSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { BlockList } from "node:net";
const R = "/Users/danny/Documents/Tools/Firecrawl";
const HERE = new URL(".", import.meta.url).pathname;
// The key file and the per-arm Agent copies live in a private temporary directory, never beside this file.
const WORK = mkdtempSync(`${tmpdir()}/fcpi-agent-eval-`);
const { makeModelAdapter, makeExtractor } = await import(`${R}/services/retrieval/src/extract.mjs`);
const { loadBudgetPolicy } = await import(`${R}/services/retrieval/src/budget.mjs`);
const { makePublicResolver } = await import(`${R}/services/retrieval/src/resolve.mjs`);
const { sshForward } = await import(`${R}/scripts/playground/server.mjs`);
const { cutText } = await import(`${R}/services/access/src/extract.mjs`);
const MAX_DOC = JSON.parse(readFileSync(`${R}/deploy/policies/capabilities.json`, "utf8")).limits.extract.maxDocumentBytes;

const [out, repsArg = "2", armsArg] = process.argv.slice(2);
const ARMS = {
  "opus-high": { model: "claude-opus-5-5", effort: "high" },
  "sonnet-high": { model: "claude-sonnet-5-5", effort: "high" },
  "haiku-none": { model: "claude-haiku-5-5", effort: "none" },
  "haiku-high": { model: "claude-haiku-5-5", effort: "high" },
};
const arms = armsArg ? armsArg.split(",") : Object.keys(ARMS);
const SPEND_LIMIT = 25_000_000; // micro-USD across the whole run

// The key, read from .env into a 0600 file the adapter reads; removed at exit.
const env = Object.fromEntries(readFileSync(`${R}/.env`, "utf8").split("\n").filter((l) => /^[A-Z_]+=/.test(l)).map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1).trim().replace(/^["']|["']$/g, "")]));
const providersDir = `${WORK}/providers`;
mkdirSync(providersDir, { mode: 0o700 });
writeFileSync(`${providersDir}/agent_anthropic_api_key`, env.AGENT_ANTHROPIC_API_KEY, { mode: 0o600 });
chmodSync(`${providersDir}/agent_anthropic_api_key`, 0o600);
const cleanup = () => rmSync(WORK, { recursive: true, force: true });
process.on("exit", cleanup);
process.on("SIGINT", () => { cleanup(); process.exit(130); });

function budgetFor({ model, effort }) {
  const b = JSON.parse(readFileSync(`${R}/deploy/policies/budget.json`, "utf8"));
  if (!b.rateCards.some((c) => c.subject === model) && model === "claude-sonnet-5-5") b.rateCards.push({ id: "anthropic/claude-sonnet-5-5@2026-10-17", subject: "claude-sonnet-5-5", effectiveFrom: "2026-10-17", effectiveTo: null,
    inputPerMTok: 2000000, cachedInputPerMTok: 200000, cacheWritePerMTok: 2500000, outputPerMTok: 10000000, source: "models.md: $2/$10 per MTok, cache reads $0.20" });
  // The deployed entry when the policy has one at this effort (its input cap included), otherwise the arm's own.
  const deployed = b.models[model]?.reasoningEffort === effort ? { ...b.models[model], provider: "anthropic-agent" } : null;
  const entry = deployed ?? { provider: "anthropic-agent", category: "llm", reasoningEffort: effort, ...(effort === "none" ? {} : { maxOutputTokens: 128000, requestTimeoutMs: 300000 }) };
  // The deployed validator holds Haiku to effort none; the Haiku-with-thinking arm is set after loading.
  b.models[model] = model === "claude-haiku-5-5" ? { provider: "anthropic-agent", category: "llm", reasoningEffort: "none" } : entry;
  const p = loadBudgetPolicy(JSON.stringify(b));
  p.models[model] = entry;
  p.providers["anthropic-agent"].paid = false; // no ledger here: spend is summed below and capped by SPEND_LIMIT
  return p;
}

const local = new BlockList();
for (const [a, n] of [["10.0.0.0", 8], ["172.16.0.0", 12], ["192.168.0.0", 16], ["127.0.0.0", 8], ["169.254.0.0", 16], ["100.64.0.0", 10]]) local.addSubnet(a, n, "ipv4");
const policy = { ports: [80, 443], maxRedirects: 3, cloudDenylist: ["firecrawl.dev", "*.firecrawl.dev"], localCidrs: local, fixtures: [] };
const resolvePublic = makePublicResolver({});

// An in-memory ledger: every row is new (each read has its own logical id).
const rows = new Map();
const store = {
  async reserveBudget(r) { const row = { ...r, state: "RESERVED", reserved: r.amount, created_at: new Date().toISOString() }; rows.set(r.id, row); return { reservation: row }; },
  async settleBudget(id, actual, f) { Object.assign(rows.get(id), { state: "SETTLED", actual, ...f }); return rows.get(id); },
  async releaseBudget(id, detail) { Object.assign(rows.get(id), { state: "RELEASED", actual: 0, detail }); },
  async markBudgetUncertain(id, detail) { Object.assign(rows.get(id), { state: "UNCERTAIN", detail }); },
};
let spent = 0;
const settledCost = (logical) => [...rows.values()].filter((r) => r.logicalId.startsWith(logical)).reduce((n, r) => n + (r.state === "SETTLED" ? r.actual : r.state === "UNCERTAIN" ? r.reserved : 0), 0);

const pi = sshForward();
const agents = {};
for (const arm of arms) {
  const { model, effort } = ARMS[arm];
  const src = readFileSync(`${R}/scripts/playground/agent.mjs`, "utf8").replaceAll("'../../", `'${R}/`)
    .replace(/const MODEL = '[a-z0-9-]+';/, `const MODEL = '${model}';`).replace("const EFFORT = 'high';", `const EFFORT = '${effort}';\nmanifest.formats.objects.json.model.value = MODEL; manifest.formats.objects.json.reasoningEffort.value = EFFORT;`);
  if (!src.includes(`const MODEL = '${model}';`) || !src.includes(`const EFFORT = '${effort}';`)) throw new Error("agent.mjs constants not found");
  writeFileSync(`${WORK}/agent-${arm}.mjs`, src);
  const budget = budgetFor(ARMS[arm]);
  const logs = [];
  const adapter = makeModelAdapter({ store, getBudget: () => budget, paidDispatch: false, providersDir, getPolicy: () => policy, resolvePublic, lookupFixture: async () => [], log: (o) => logs.push(o) });
  agents[arm] = { run: (await import(`${WORK}/agent-${arm}.mjs`)).runAgent, extract: makeExtractor({ adapter, getBudget: () => budget, getSelection: () => ({ extractionModel: "claude-haiku-5-5" }), log: (o) => logs.push(o) }), logs };
}

// What the gateway's json scrape does (services/access/src/jsonscrape.mjs), with the extraction run here.
const forwardFor = (arm, prefix) => async (request, signal) => {
  const json = request.body?.formats?.find((f) => f && typeof f === "object" && f.type === "json");
  if (request.path !== "/v2/scrape" || !json) return pi(request, signal);
  const t0 = Date.now();
  const strings = request.body.formats.filter((f) => typeof f === "string");
  const r = await pi({ ...request, body: { ...request.body, formats: [...new Set([...strings, "markdown"])] }, timeout: 125 }, signal);
  if (r.status !== 200 || r.data?.success !== true || !r.data?.data) return r;
  const doc = r.data.data;
  const md = cutText(doc.markdown, MAX_DOC);
  let x;
  try {
    x = await agents[arm].extract({ logicalId: `${prefix}:${randomUUID()}`, schema: json.schema, prompt: json.prompt ?? null, model: json.model, reasoningEffort: json.reasoningEffort,
      documents: [{ url: doc.metadata?.url ?? request.body.url, markdown: md.text }], deadline: new Date(t0 + 110000 + 10000 + 300000).toISOString() });
  } catch (e) { x = { ok: false, failure: { class: e.code ?? "EXTRACTION_ERROR", detail: String(e.message).slice(0, 200) } }; }
  const extraction = { model: x.model ?? null, requestedModel: x.requestedModel ?? null, reasoningEffort: x.reasoningEffort ?? null, sources: x.sources, missingRequired: x.missingRequired, units: x.units ?? [], usage: x.usage ?? null };
  if (x.ok !== true) return { status: 500, data: { success: false, code: x.failure?.class ?? "EXTRACTION_FAILED", error: x.failure?.detail ?? "", fcpi: { extraction } } };
  doc.json = x.data;
  if (!strings.includes("markdown")) delete doc.markdown;
  const warnings = [...(md.cut ? [`the page's markdown was cut at ${MAX_DOC} bytes before extraction`] : []),
    ...extraction.units.filter((u) => !u.ok).map((u) => `part ${u.part} of the page was not extracted (${u.failure?.class ?? "UNIT_FAILED"}), so its values may be missing`), ...(x.warnings ?? [])];
  if (warnings.length) doc.warning = [doc.warning, ...warnings].filter(Boolean).join("; ");
  return { status: 200, data: { success: true, data: doc, fcpi: { extraction } } };
};

const TASKS = JSON.parse(readFileSync(`${HERE}tasks.json`, "utf8"));
for (const arm of arms) console.log(JSON.stringify({ arm, maxInputTokens: budgetFor(ARMS[arm]).models[ARMS[arm].model].maxInputTokens ?? "extraction default" }));
const reps = Number(repsArg);
const jobs = [];
for (let rep = 1; rep <= reps; rep++) for (const t of TASKS) for (const arm of arms) jobs.push({ rep, t, arm });
let next = 0;
async function worker() {
  while (next < jobs.length) {
    const { rep, t, arm } = jobs[next++];
    if (spent > SPEND_LIMIT) { appendFileSync(out, JSON.stringify({ arm, task: t.id, rep, skipped: "spend limit" }) + "\n"); continue; }
    const prefix = `eval:${arm}:${t.id}:${rep}`;
    const t0 = Date.now();
    let result, error = null;
    try { result = await agents[arm].run({ prompt: t.prompt, urls: t.urls ?? [], maxPages: t.maxPages ?? 4, ...(t.schema ? { schema: t.schema } : {}) }, { forward: forwardFor(arm, prefix) }); }
    catch (e) { error = String(e.message).slice(0, 300); }
    const cost = settledCost(prefix); spent += cost;
    const calls = agents[arm].logs.filter((l) => l.event === "model_call" && String(l.logical_id).startsWith(prefix))
      .map((l) => ({ outcome: l.outcome, ms: l.ms, prompt: l.prompt_tokens, completion: l.completion_tokens, cost: l.cost_micro_usd, finish: l.finish_reason }));
    const rec = { arm, task: t.id, rep, wallMs: Date.now() - t0, costMicroUsd: cost, error,
      status: result?.status, success: result?.success, code: result?.code ?? null, answer: result?.answer ?? null, result: result?.result ?? null,
      findings: result?.findings?.map((f) => ({ claim: f.claim, quote: f.quote.slice(0, 300), source_url: f.source_url })) ?? [],
      sources: result?.sources?.map((s) => s.url) ?? [], steps: result?.steps?.map((s) => ({ tool: s.tool, state: s.state, code: s.code ?? null, ms: s.elapsedMs })) ?? [],
      limitations: result?.limitations ?? [], calls };
    appendFileSync(out, JSON.stringify(rec) + "\n");
    console.log(JSON.stringify({ done: `${arm}/${t.id}/${rep}`, status: rec.status, code: rec.code, s: Math.round(rec.wallMs / 1000), usd: (cost / 1e6).toFixed(3), spentUsd: (spent / 1e6).toFixed(2) }));
  }
}
await Promise.all([worker(), worker()]);
console.log(JSON.stringify({ finished: jobs.length, spentUsd: (spent / 1e6).toFixed(2) }));
