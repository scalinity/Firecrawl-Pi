#!/usr/bin/env node
// SI5's judge record (docs/FIRECRAWL_PI_SEARCH_INTELLIGENCE_SPEC.md §23.1): who judged each packet, on which model, with which
// prompt, and whether the judge kept to its packet. Read from the judges' own session transcripts (the directory the agent
// runtime writes, given as an argument; nothing from it is copied): per round the template and its hash, and per query the
// agent, the models its turns reported, the filled prompt's hash, its first and last event times and its tool-call count.
// The prompt asks judges to read only their packets; the transcripts show whether they did. Every tool call is checked for what
// could unblind or bias a judge: the run records, pool, packet keys, captures, anchors, frozen configuration, labels, the
// judging helpers and review reports, credentials, another query's id (its packet, prompt or judgments), a spilled tool output
// the judge was not itself handed, and any network fetch (a web tool, or curl/wget run as a command). Each flag must be
// classified in eval/judge-notes.json ({round, query, flag, classification, note}); a query with an unclassified flag is listed
// as uncontained. The prompt a judge saw is its Read of its prompt file, rebuilt from the numbered lines it was shown and
// compared with the file on disk (promptRead: exact, partial, differs or absent). A query judged again (a later agent, such as
// <query>-r2) is the later judge's, with the earlier one kept under superseded. Writes eval/judges.json, which labels.mjs final
// requires.
//   node scripts/si5/judges.mjs <transcripts directory>
import { readFileSync, writeFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";

const root = new URL("../../", import.meta.url).pathname;
const EVAL = join(root, "evidence/search-intelligence/SI5/eval"), PRIV = join(EVAL, "private");
const dir = process.argv[2];
if (!dir || !existsSync(dir)) { console.error("usage: judges.mjs <transcripts directory>"); process.exit(2); }
const sha = (s) => createHash("sha256").update(s).digest("hex");
// Each round: the agents' name prefix, its template and where its prompts live (relative to private/).
const ROUNDS = {
  first: { prefix: "si5-judge1-", template: "judge-prompt.md", prompt: (n) => `judge-prompts/first-${n}.md` },
  second: { prefix: "si5-judge2-", template: "judge-prompt.md", prompt: (n) => `judge-prompts/second-${n}.md` },
  adjudication: { prefix: "si5-adj-", template: "adjudicate-prompt.md", prompt: (n) => `judge-prompts/adjudicate-${n}.md` },
};
const SENSITIVE = /runs\/|pool\.json|packet-keys|captures(\/|\.json)|frozen\.json|anchors\.json|labels(-text)?\.json|second-selection\.json|judges\.json|\.env\b|judging\/|si5-collect|ca1-|db1-|REVIEW\.md|subagents\//g;
const FETCH_TOOL = /^(WebFetch|WebSearch|mcp__)/, FETCH_CMD = /(^|[;&|]\s*|\$\(\s*|\bxargs\s+)(curl|wget)\s/m;
const notes = existsSync(join(EVAL, "judge-notes.json")) ? JSON.parse(readFileSync(join(EVAL, "judge-notes.json"), "utf8")) : [];
const noteOf = (round, q, flag) => notes.find((n) => n.round === round && n.query === q && n.flag === flag) ?? null;

const rounds = {};
for (const [round, R] of Object.entries(ROUNDS)) {
  const metas = readdirSync(dir).filter((f) => f.endsWith(".meta.json")).map((f) => ({ f, m: JSON.parse(readFileSync(join(dir, f), "utf8")) })).filter(({ m }) => m.name?.startsWith(R.prefix));
  if (!metas.length) continue;
  const queries = {}, models = new Set();
  for (const { f, m } of metas) {
    const suffix = m.name.slice(R.prefix.length), ids = new Set(suffix.match(/Q\d{3}/g) ?? []);
    const lines = readFileSync(join(dir, f.replace(/\.meta\.json$/, ".jsonl")), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
    const seen = new Set(), flags = new Set(), handed = new Set();
    let calls = 0;
    const promptPath = join(PRIV, R.prompt(suffix));
    let promptReadId = null, promptReadPartial = false, promptShown = null;
    for (const l of lines) {
      if (l.type === "assistant" && l.message?.model) seen.add(l.message.model);
      // Spilled outputs the runtime handed this judge: named in its own tool results.
      if (l.type === "user") for (const c of Array.isArray(l.message?.content) ? l.message.content : []) if (c.type === "tool_result") {
        for (const id of JSON.stringify(c.content ?? "").match(/tool-results\/[A-Za-z0-9_-]+\.txt/g) ?? []) handed.add(id);
        if (c.tool_use_id === promptReadId && promptShown === null) {
          const t = Array.isArray(c.content) ? c.content.map((x) => x.text ?? "").join("") : String(c.content ?? "");
          promptShown = t.split("\n").map((x) => /^\s*\d+\t(.*)$/.exec(x)).filter(Boolean).map((x) => x[1]).join("\n");
        }
      }
      for (const c of l.type === "assistant" ? l.message?.content ?? [] : []) {
        if (c.type !== "tool_use" || c.name === "SendMessage") continue;
        calls++;
        if (c.name === "Read" && promptReadId === null && c.input?.file_path === promptPath) { promptReadId = c.id; promptReadPartial = c.input.offset !== undefined || c.input.limit !== undefined; }
        const text = [c.input?.file_path, c.input?.path, c.input?.command, c.input?.pattern, c.input?.url, c.input?.query].filter((x) => typeof x === "string").join("\n");
        if (FETCH_TOOL.test(c.name)) flags.add(`fetch:${c.name}`);
        if (FETCH_CMD.test(c.input?.command ?? "")) flags.add("fetch:command");
        for (const s of text.match(SENSITIVE) ?? []) flags.add(`sensitive:${s}`);
        for (const q of text.match(/\bQ\d{3}\b/g) ?? []) if (!ids.has(q)) flags.add(`query:${q}`);
        for (const t of text.match(/tool-results\/[A-Za-z0-9_-]+\.txt/g) ?? []) if (!handed.has(t)) flags.add(`spill:${t}`);
      }
    }
    for (const s of seen) models.add(s);
    const times = lines.map((l) => l.timestamp).filter(Boolean).sort();
    const onDisk = existsSync(promptPath) ? readFileSync(promptPath, "utf8") : null;
    // A judge given its prompt inline (its first message) rather than told to read the file is compared on that text.
    const first = lines.find((l) => l.type === "user")?.message?.content;
    const inline = typeof first === "string" ? /^<teammate-message[^>]*>\n([\s\S]*?)\n?<\/teammate-message>\s*$/.exec(first)?.[1] ?? null : null;
    const promptRead = onDisk === null ? "absent" : promptShown !== null ? (promptReadPartial ? "partial" : promptShown === onDisk ? "exact" : "differs")
      : inline !== null ? (inline.trim() === onDisk.trim() ? "inline_exact" : "inline_differs") : "absent";
    for (const q of ids) {
      const flagged = [...flags].sort().map((flag) => ({ flag, note: noteOf(round, q, flag) }));
      const rec = { agent: m.name, models: [...seen].sort(), prompt: R.prompt(suffix), promptSha256: onDisk === null ? null : sha(onDisk), promptRead,
        started: times[0] ?? null, ended: times.at(-1) ?? null, toolCalls: calls, flags: flagged, contained: flagged.every((x) => x.note) };
      const was = queries[q];
      if (!was) queries[q] = rec;
      else {
        const [later, earlier] = rec.started > was.started ? [rec, was] : [was, rec];
        const { superseded = [], ...e } = earlier;
        queries[q] = { ...later, superseded: [...(later.superseded ?? []), ...superseded, { agent: e.agent, started: e.started, flags: e.flags, promptRead: e.promptRead }].sort((a, b) => (a.started < b.started ? -1 : 1)) };
      }
    }
  }
  rounds[round] = { template: R.template, templateSha256: sha(readFileSync(join(root, "scripts/si5", R.template))), model: [...models].sort().join(","),
    agents: metas.length, uncontained: Object.entries(queries).filter(([, x]) => !x.contained).map(([q]) => q).sort(),
    promptNotExact: Object.entries(queries).filter(([, x]) => !["exact", "inline_exact"].includes(x.promptRead)).map(([q]) => q).sort(), queries: Object.fromEntries(Object.entries(queries).sort()) };
}
writeFileSync(join(EVAL, "judges.json"), JSON.stringify({ schema: "fcpi.si5-judges/v1", generatedUtc: new Date().toISOString(),
  rule: "a judge reads only its packet and prompt and writes only its output; every reference that could unblind or bias it is flagged and must be classified in judge-notes.json", rounds }, null, 1) + "\n");
console.log(JSON.stringify(Object.fromEntries(Object.entries(rounds).map(([k, r]) => [k, { agents: r.agents, model: r.model, uncontained: r.uncontained, promptNotExact: r.promptNotExact,
  flags: Object.entries(r.queries).flatMap(([q, x]) => x.flags.filter((y) => !y.note).map((y) => `${q} ${y.flag}`)) }]))));
