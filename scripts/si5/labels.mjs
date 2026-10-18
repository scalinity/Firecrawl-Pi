#!/usr/bin/env node
// SI5's judgment records (docs/FIRECRAWL_PI_SEARCH_INTELLIGENCE_SPEC.md §23.1), in three stages:
//   second   after the first judge: choose the second judge's set before it sees any first label — a stratified 20% of each
//            category's judged documents (a fixed hash order, not a choice) plus every version conflict, suspected mirror and
//            document the first judge raised a question about — and write those as separate packets (packets-second/);
//   adjudicate  after the second judge: every disagreement that matters (grades two or more apart, opposite sides of the
//            relevance line at 2, or judged against unjudged) becomes an adjudication packet showing both labels;
//   final    merge: the first label stands unless adjudicated; every cited passage is checked against the document file, and a
//            grade of 1 or more whose passage is not in the file becomes unjudged (unverified_span). Writes eval/labels.json
//            (per query and canonical URL: grade, both original labels, the resolution, verification, source type, version
//            status, verified requirement passages as hashes and the judge provenance) and eval/agreement.json.
// Judgments live in eval/private/judgments/{first,second,adjudication}/<id>.json; the prompt files' hashes are recorded.
//   node scripts/si5/labels.mjs second|adjudicate|final
import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync, rmSync, copyFileSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";

const root = new URL("../../", import.meta.url).pathname;
const EVAL = join(root, "evidence/search-intelligence/SI5/eval"), PRIV = join(EVAL, "private"), J = join(PRIV, "judgments");
const sha = (s) => createHash("sha256").update(s).digest("hex");
const read = (p) => JSON.parse(readFileSync(p, "utf8"));
const corpus = read(join(root, "evidence/search-intelligence/SI0/corpus/corpus-v1.json"));
const category = Object.fromEntries(corpus.queries.map((q) => [q.id, q.category]));
const stage = process.argv[2];
const judged = (round) => (existsSync(join(J, round)) ? readdirSync(join(J, round)).filter((f) => /^Q\d+\.json$/.test(f)).map((f) => read(join(J, round, f))) : []);
const keysOf = (id) => read(join(PRIV, "packet-keys", `${id}.json`)).ids;
const urlOf = (id) => Object.fromEntries(Object.entries(keysOf(id)).map(([u, k]) => [k, u]));
const docFile = (q, doc) => join(PRIV, "packets", q, "docs", `${doc}.md`);
const relevant = (g) => g !== null && g !== undefined && g >= 2;

// The document file's two sections, whitespace-collapsed, for passage checks.
const flat = (s) => s.replace(/\s+/g, " ").trim();
function sections(q, doc) {
  const t = readFileSync(docFile(q, doc), "utf8");
  const ex = t.indexOf("\n## Search-result excerpts\n"), pg = t.indexOf("\n## Page\n");
  return { excerpt: flat(t.slice(ex, pg)), page: flat(t.slice(pg + 9)) };
}
// Where a passage is found: its claimed section first, then the other; null when in neither.
function locate(sec, passage, claimed) {
  if (typeof passage !== "string" || flat(passage).length < 20) return null;
  const p = flat(passage);
  for (const s of claimed === "excerpt" ? ["excerpt", "page"] : ["page", "excerpt"]) if (sec[s].includes(p)) return s;
  return null;
}

function writePacket(dir, q, docs, extra = null) {
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(join(dir, "docs"), { recursive: true });
  copyFileSync(join(PRIV, "packets", q, "task.json"), join(dir, "task.json"));
  for (const d of docs) copyFileSync(docFile(q, d), join(dir, "docs", `${d}.md`));
  writeFileSync(join(dir, "index.json"), JSON.stringify({ query: q, documents: docs.map((d) => `${d}.md`), ...(extra ? { labels: extra } : {}) }, null, 1) + "\n");
}

if (stage === "second") {
  const first = judged("first"), chosen = {};
  const byCat = new Map();
  for (const f of first) for (const j of f.judgments) if (j.grade !== null) (byCat.get(category[f.query]) ?? byCat.set(category[f.query], []).get(category[f.query])).push({ q: f.query, id: j.id });
  // 20% of each category's judged documents, in a fixed order of their hash (not chosen by any label).
  for (const list of byCat.values()) {
    list.sort((a, b) => (sha(`${a.q}:${a.id}`) < sha(`${b.q}:${b.id}`) ? -1 : 1));
    for (const x of list.slice(0, Math.ceil(list.length * 0.2))) (chosen[x.q] ??= new Set()).add(x.id);
  }
  // Every version conflict, suspected mirror and raised question.
  for (const f of first) for (const j of f.judgments) if (j.versionStatus === "mismatch" || j.sourceType === "mirror" || (j.questions ?? []).length) (chosen[f.query] ??= new Set()).add(j.id);
  rmSync(join(PRIV, "packets-second"), { recursive: true, force: true });
  for (const [q, ids] of Object.entries(chosen)) writePacket(join(PRIV, "packets-second", q), q, [...ids].sort());
  const n = Object.values(chosen).reduce((s, x) => s + x.size, 0);
  writeFileSync(join(EVAL, "second-selection.json"), JSON.stringify({ rule: "20% per category by fixed hash order, plus every versionStatus mismatch, mirror and raised question", documents: n, queries: Object.fromEntries(Object.entries(chosen).map(([q, s]) => [q, s.size])) }, null, 1) + "\n");
  console.log(JSON.stringify({ secondDocuments: n, queries: Object.keys(chosen).length }));
} else if (stage === "adjudicate") {
  const first = new Map(judged("first").flatMap((f) => f.judgments.map((j) => [`${f.query}:${j.id}`, j])));
  const disputes = {};
  for (const f of judged("second")) for (const j of f.judgments) {
    const a = first.get(`${f.query}:${j.id}`);
    if (!a) continue;
    const g1 = a.grade, g2 = j.grade;
    const differs = (g1 === null) !== (g2 === null) || (g1 !== null && (Math.abs(g1 - g2) >= 2 || relevant(g1) !== relevant(g2)));
    if (differs) (disputes[f.query] ??= []).push({ id: j.id, first: { grade: g1, reason: a.reason, passage: a.passage, versionStatus: a.versionStatus }, second: { grade: g2, reason: j.reason, passage: j.passage, versionStatus: j.versionStatus } });
  }
  rmSync(join(PRIV, "packets-adjudication"), { recursive: true, force: true });
  for (const [q, list] of Object.entries(disputes)) writePacket(join(PRIV, "packets-adjudication", q), q, list.map((x) => x.id), Object.fromEntries(list.map((x) => [x.id, { judgeA: x.first, judgeB: x.second }])));
  console.log(JSON.stringify({ disputes: Object.values(disputes).reduce((n, l) => n + l.length, 0), queries: Object.keys(disputes).length }));
} else if (stage === "final") {
  const second = new Map(judged("second").flatMap((f) => f.judgments.map((j) => [`${f.query}:${j.id}`, j])));
  const adj = new Map(judged("adjudication").flatMap((f) => f.judgments.map((j) => [`${f.query}:${j.id}`, j])));
  const prompts = Object.fromEntries(["judge-prompt.md", "adjudicate-prompt.md"].filter((p) => existsSync(join(root, "scripts/si5", p))).map((p) => [p, sha(readFileSync(join(root, "scripts/si5", p)))]));
  const out = { schema: "fcpi.si5-labels/v1", prompts, judges: existsSync(join(EVAL, "judges.json")) ? read(join(EVAL, "judges.json")) : null, queries: {} };
  const agree = { pairs: 0, exact: 0, relevanceAgree: 0, withinOne: 0, disputes: 0, adjudicated: 0, unverifiedSpans: 0, unjudgedFirst: 0, missingFirst: 0 };
  for (const f of judged("first")) {
    const urls = urlOf(f.query), expected = new Set(read(join(PRIV, "packets", f.query, "index.json")).documents.map((d) => d.slice(0, -3)));
    const rows = {};
    for (const j of f.judgments) {
      if (!expected.has(j.id)) continue;
      expected.delete(j.id);
      const key = `${f.query}:${j.id}`, s = second.get(key), r = adj.get(key);
      const sec = sections(f.query, j.id);
      const final = r ?? j;
      let grade = final.grade ?? null, verified = true;
      const where = locate(sec, final.passage, final.section);
      if (grade !== null && grade >= 1 && !where) { grade = null; verified = false; agree.unverifiedSpans++; }
      if (j.grade === null) agree.unjudgedFirst++;
      if (s) {
        agree.pairs++;
        if (s.grade === j.grade) agree.exact++;
        if (relevant(s.grade) === relevant(j.grade) && (s.grade === null) === (j.grade === null)) agree.relevanceAgree++;
        if (s.grade !== null && j.grade !== null && Math.abs(s.grade - j.grade) <= 1) agree.withinOne++;
      }
      if (r) agree.adjudicated++;
      const reqs = (final.requirements ?? []).map((x) => ({ req: x.req, section: locate(sec, x.passage, x.section), passageSha256: typeof x.passage === "string" ? sha(flat(x.passage)) : null })).filter((x) => x.section);
      rows[urls[j.id]] = { doc: j.id, grade, verified, basis: final.basis ?? null, section: where, passageSha256: where ? sha(flat(final.passage)) : null, reason: String(final.reason ?? "").slice(0, 300),
        sourceType: final.sourceType ?? null, versionStatus: final.versionStatus ?? null, requirements: reqs, questions: (final.questions ?? []).slice(0, 5).map((x) => String(x).slice(0, 200)),
        labels: { first: j.grade ?? null, ...(s ? { second: s.grade ?? null } : {}), ...(r ? { adjudicated: r.grade ?? null } : {}) },
        provenance: r ? "independent_model_adjudication" : "independent_model_judgment" };
    }
    for (const id of expected) { agree.missingFirst++; rows[urls[id]] = { doc: id, grade: null, verified: false, missing: true, labels: { first: null }, provenance: "independent_model_judgment" }; }
    out.queries[f.query] = rows;
  }
  agree.disputes = existsSync(join(PRIV, "packets-adjudication")) ? readdirSync(join(PRIV, "packets-adjudication")).reduce((n, q) => n + read(join(PRIV, "packets-adjudication", q, "index.json")).documents.length, 0) : 0;
  out.agreement = { ...agree, exactRate: agree.pairs ? agree.exact / agree.pairs : null, relevanceRate: agree.pairs ? agree.relevanceAgree / agree.pairs : null };
  writeFileSync(join(EVAL, "labels.json"), JSON.stringify(out, null, 1) + "\n");
  console.log(JSON.stringify(out.agreement));
} else { console.error("usage: labels.mjs second|adjudicate|final"); process.exit(2); }
