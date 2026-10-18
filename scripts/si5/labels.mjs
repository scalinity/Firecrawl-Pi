#!/usr/bin/env node
// SI5's judgment records (docs/FIRECRAWL_PI_SEARCH_INTELLIGENCE_SPEC.md §23.1), in three stages:
//   second   after the first judge, once every collected held-out query has a first judgment: choose the second judge's set
//            before it sees any first label — a stratified 20% of each category's first-round documents, unjudged ones
//            included (a fixed hash order, not a choice), plus every version conflict, suspected mirror and document the first
//            judge raised a question about — and write those as separate packets (packets-second/), recording the hash of
//            every first-judgment file the choice was made from;
//   adjudicate  after the second judge: every disagreement that matters (grades two or more apart, opposite sides of the
//            relevance line at 2, or judged against unjudged) becomes an adjudication packet showing both labels;
//   final    merge: the first label stands unless adjudicated. A grade outside the scale (0-3 or null) is no grade, and a
//            version mismatch is held to the scale's cap of 1. Every cited passage is checked against the document file,
//            which must be the file its judge read (its hash in the packet keys); a grade of 1 or more whose passage is not
//            in the file becomes unjudged (unverified_span). Writes eval/labels.json (per query and canonical URL: grade, the
//            original labels, the resolution, verification, source type, version status, the file and capture hashes, and
//            the verified passages as hashes with their offsets and, for an excerpt, the lanes that delivered it), with
//            the agreement figures. The judges' free text (reason, questions) stays in eval/private/labels-text.json, and
//            labels.json carries only its hashes; no credential value may appear in either. The passage round's judgments
//            (judgments/passages/, from packets-passages/) add each document's verified documentation-passage support
//            (docRequirements, with the lanes that delivered each passage; none when the passages are of a mismatched version),
//            and mark the document docPassagesJudged.
// Judgments live in eval/private/judgments/{first,second,adjudication}/<id>.json; eval/judges.json (scripts/si5/judges.mjs)
// records who judged with which prompt; final refuses when a prompt on disk no longer matches it, a judge was shown other than
// its prompt, or a judge reached outside its packet without a classified note.
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
// A judgment's document id is the packet's id; a judge that wrote the file name (<id>.md, as index.json lists it) named the same
// document, so the suffix is dropped and counted.
let idsFromFileNames = 0;
const idOf = (x) => { const s = String(x); if (s.endsWith(".md")) { idsFromFileNames++; return s.slice(0, -3); } return s; };
const judged = (round) => (existsSync(join(J, round)) ? readdirSync(join(J, round)).filter((f) => /^Q\d+\.json$/.test(f)).map((f) => read(join(J, round, f)))
  .map((f) => ({ ...f, judgments: (f.judgments ?? []).map((j) => ({ ...j, id: idOf(j.id) })) })) : []);
const keysOf = (id) => read(join(PRIV, "packet-keys", `${id}.json`));
const docFile = (q, doc) => join(PRIV, "packets", q, "docs", `${doc}.md`);
// The scale (judge-prompt.md): 0-3, or null for unjudged. Anything else is no grade: never coerced into one.
const GRADES = new Set([0, 1, 2, 3]);
const gradeOf = (g) => (g === null || g === undefined ? null : GRADES.has(g) ? g : undefined);
const VERSION = new Set(["match", "mismatch", "unknown", "not_applicable"]);
const SOURCE = new Set(["official_docs", "repository", "release_notes", "paper", "standard", "vendor_blog", "news", "forum", "q_and_a", "tutorial", "aggregator", "mirror", "other"]);
const relevant = (g) => g !== null && g !== undefined && g >= 2;

// The document file's two sections, whitespace-collapsed, for passage checks.
const flat = (s) => s.replace(/\s+/g, " ").trim();
function sections(q, doc) {
  const t = readFileSync(docFile(q, doc), "utf8");
  const ex = t.indexOf("\n## Search-result excerpts\n"), pg = t.indexOf("\n## Page\n");
  return { text: t, excerpt: flat(t.slice(ex, pg)), page: flat(t.slice(pg + 9)) };
}
// Where a passage is found: its claimed section first, then the other, with its offset in that section; null when in neither.
function locate(sec, passage, claimed) {
  if (typeof passage !== "string" || flat(passage).length < 20) return null;
  const p = flat(passage);
  for (const s of claimed === "excerpt" ? ["excerpt", "page"] : ["page", "excerpt"]) { const at = sec[s].indexOf(p); if (at >= 0) return { section: s, offset: at, inPage: s === "page" || sec.page.includes(p) }; }
  return null;
}
// The lanes that delivered an excerpt passage: the excerpt lines it falls within, in the packet's order (packet keys). A passage
// within one line is that line's lanes; one spanning lines is credited only to the lanes common to all of them.
function excerptSources(sec, keys, url, passage) {
  const p = flat(passage), lines = keys.excerpts?.[url];
  if (!lines) return null;
  let from = 0;
  const spans = lines.map((l) => { const f = `- ${flat(l.text)}`, at = sec.excerpt.indexOf(f, from); if (at >= 0) from = at + f.length; return { start: at, end: at + f.length, sources: l.sources }; });
  const at = sec.excerpt.indexOf(p), end = at + p.length;
  if (at < 0 || spans.some((s) => s.start < 0)) return null;
  const hit = spans.filter((s) => s.start < end && at < s.end);
  if (!hit.length) return null;
  return hit.slice(1).reduce((acc, s) => acc.filter((x) => s.sources.includes(x)), [...hit[0].sources]);
}

// The passage round's support for one document: each requirement's passage located in its file, credited to the lanes of the
// documentation passage(s) it falls within (common to all of them when it spans several).
function passageSupport(q, doc, keys, url, judgment) {
  const t = readFileSync(join(PRIV, "packets-passages", q, "docs", `${doc}.md`), "utf8");
  if (sha(t) !== keys.passageFiles?.[doc]?.sha256) return { flag: "file_changed", reqs: [] };
  const sec = flat(t.slice(t.indexOf("\n## Documentation passages\n")));
  let from = 0;
  const spans = (keys.docPassages?.[url] ?? []).map((x) => { const f = flat(x.text), at = sec.indexOf(f, from); if (at >= 0) from = at + f.length; return { start: at, end: at + f.length, sources: x.sources }; });
  const reqs = (judgment.requirements ?? []).map((x) => {
    if (typeof x.passage !== "string" || flat(x.passage).length < 20) return null;
    const p = flat(x.passage), at = sec.indexOf(p);
    if (at < 0) return null;
    const hit = spans.filter((s) => s.start >= 0 && s.start < at + p.length && at < s.end);
    if (!hit.length) return null;
    return { req: x.req, offset: at, passageSha256: sha(p), sources: hit.slice(1).reduce((acc, s) => acc.filter((y) => s.sources.includes(y)), [...hit[0].sources]) };
  }).filter(Boolean);
  return { flag: null, reqs };
}

function writePacket(dir, q, docs, extra = null) {
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(join(dir, "docs"), { recursive: true });
  copyFileSync(join(PRIV, "packets", q, "task.json"), join(dir, "task.json"));
  for (const d of docs) copyFileSync(docFile(q, d), join(dir, "docs", `${d}.md`));
  writeFileSync(join(dir, "index.json"), JSON.stringify({ query: q, documents: docs.map((d) => `${d}.md`), ...(extra ? { labels: extra } : {}) }, null, 1) + "\n");
}

if (stage === "second") {
  // The sample is drawn once, from the whole first round: a sample of a partial round would choose a different set later.
  const pool = read(join(EVAL, "pool.json"));
  const collected = corpus.queries.filter((q) => q.split === "heldout" && pool.queries[q.id]?.collected).map((q) => q.id);
  const firstFiles = Object.fromEntries(collected.filter((q) => existsSync(join(J, "first", `${q}.json`))).map((q) => [q, sha(readFileSync(join(J, "first", `${q}.json`)))]));
  const heldout = corpus.queries.filter((q) => q.split === "heldout").length;
  if (collected.length < heldout || Object.keys(firstFiles).length < collected.length) {
    console.error(`refused: ${heldout - collected.length} held-out queries not collected, ${collected.length - Object.keys(firstFiles).length} without a first judgment`); process.exit(2);
  }
  const first = judged("first"), chosen = {};
  const byCat = new Map();
  for (const f of first) for (const j of f.judgments) (byCat.get(category[f.query]) ?? byCat.set(category[f.query], []).get(category[f.query])).push({ q: f.query, id: j.id });
  // 20% of each category's first-round documents, unjudged included, in a fixed order of their hash (not chosen by any label).
  for (const list of byCat.values()) {
    list.sort((a, b) => (sha(`${a.q}:${a.id}`) < sha(`${b.q}:${b.id}`) ? -1 : 1));
    for (const x of list.slice(0, Math.ceil(list.length * 0.2))) (chosen[x.q] ??= new Set()).add(x.id);
  }
  // Every version conflict, suspected mirror and raised question.
  for (const f of first) for (const j of f.judgments) if (j.versionStatus === "mismatch" || j.sourceType === "mirror" || (j.questions ?? []).length) (chosen[f.query] ??= new Set()).add(j.id);
  rmSync(join(PRIV, "packets-second"), { recursive: true, force: true });
  for (const [q, ids] of Object.entries(chosen)) writePacket(join(PRIV, "packets-second", q), q, [...ids].sort());
  const n = Object.values(chosen).reduce((s, x) => s + x.size, 0);
  writeFileSync(join(EVAL, "second-selection.json"), JSON.stringify({ rule: "20% per category of first-round documents (unjudged included) by fixed hash order, plus every versionStatus mismatch, mirror and raised question",
    documents: n, queries: Object.fromEntries(Object.entries(chosen).map(([q, s]) => [q, s.size])), firstJudgmentSha256: firstFiles }, null, 1) + "\n");
  console.log(JSON.stringify({ secondDocuments: n, queries: Object.keys(chosen).length }));
} else if (stage === "adjudicate") {
  const first = new Map(judged("first").flatMap((f) => f.judgments.map((j) => [`${f.query}:${j.id}`, j])));
  const disputes = {};
  for (const f of judged("second")) for (const j of f.judgments) {
    const a = first.get(`${f.query}:${j.id}`);
    if (!a) continue;
    const g1 = gradeOf(a.grade) ?? null, g2 = gradeOf(j.grade) ?? null;
    const differs = (g1 === null) !== (g2 === null) || (g1 !== null && (Math.abs(g1 - g2) >= 2 || relevant(g1) !== relevant(g2)));
    if (differs) (disputes[f.query] ??= []).push({ id: j.id, first: { grade: g1, reason: a.reason, passage: a.passage, versionStatus: a.versionStatus }, second: { grade: g2, reason: j.reason, passage: j.passage, versionStatus: j.versionStatus } });
  }
  rmSync(join(PRIV, "packets-adjudication"), { recursive: true, force: true });
  for (const [q, list] of Object.entries(disputes)) writePacket(join(PRIV, "packets-adjudication", q), q, list.map((x) => x.id), Object.fromEntries(list.map((x) => [x.id, { judgeA: x.first, judgeB: x.second }])));
  console.log(JSON.stringify({ disputes: Object.values(disputes).reduce((n, l) => n + l.length, 0), queries: Object.keys(disputes).length }));
} else if (stage === "final") {
  // Who judged with which prompt (judges.mjs); a prompt that changed on disk since is a different round.
  const judges = existsSync(join(EVAL, "judges.json")) ? read(join(EVAL, "judges.json")) : null;
  if (!judges) { console.error("refused: eval/judges.json is missing (run scripts/si5/judges.mjs)"); process.exit(2); }
  const changed = [];
  for (const [round, r] of Object.entries(judges.rounds ?? {})) {
    if (r.templateSha256 && sha(readFileSync(join(root, "scripts/si5", r.template))) !== r.templateSha256) changed.push(`${round}:${r.template}`);
    for (const [q, x] of Object.entries(r.queries ?? {})) if (x.promptSha256 && (!existsSync(join(PRIV, x.prompt)) || sha(readFileSync(join(PRIV, x.prompt))) !== x.promptSha256)) changed.push(`${round}:${q}`);
    // A judge shown something other than its prompt, or that reached outside its packet unclassified, judged a different task.
    for (const q of [...(r.uncontained ?? []), ...(r.promptNotExact ?? [])]) changed.push(`${round}:${q} (uncontained or prompt not as recorded)`);
  }
  if (changed.length) { console.error(`refused: ${changed.slice(0, 5).join(", ")}`); process.exit(2); }
  const second = new Map(judged("second").flatMap((f) => f.judgments.map((j) => [`${f.query}:${j.id}`, j])));
  const adj = new Map(judged("adjudication").flatMap((f) => f.judgments.map((j) => [`${f.query}:${j.id}`, j])));
  const out = { schema: "fcpi.si5-labels/v2", labelsScriptSha256: sha(readFileSync(new URL(import.meta.url))), judges: judges.rounds ? Object.fromEntries(Object.entries(judges.rounds).map(([k, r]) => [k, { model: r.model, template: r.template, templateSha256: r.templateSha256 }])) : null, queries: {} };
  const text = {};
  const agree = { pairs: 0, exact: 0, relevanceAgree: 0, withinOne: 0, disputes: 0, adjudicated: 0, unverifiedSpans: 0, invalidGrades: 0, versionCapped: 0, fileChanged: 0, unjudgedFirst: 0, missingFirst: 0, passageDocs: 0, passageDocsUnjudged: 0, passageRequirements: 0, passageUnverified: 0 };
  for (const f of judged("first")) {
    const keys = keysOf(f.query), urls = Object.fromEntries(Object.entries(keys.ids).map(([u, k]) => [k, u]));
    const expected = new Set(read(join(PRIV, "packets", f.query, "index.json")).documents.map((d) => d.slice(0, -3)));
    const rows = {};
    for (const j of f.judgments) {
      if (!expected.has(j.id)) continue;
      expected.delete(j.id);
      const key = `${f.query}:${j.id}`, s = second.get(key), r = adj.get(key);
      const sec = sections(f.query, j.id), file = keys.files?.[j.id] ?? null;
      const final = r ?? j;
      const g1 = gradeOf(j.grade), g2 = s ? gradeOf(s.grade) : null;
      let grade = gradeOf(final.grade), verified = true, flag = null;
      if (grade === undefined) { grade = null; verified = false; flag = "invalid_grade"; agree.invalidGrades++; }
      // The file the judge read: a different one now (or no recorded hash) leaves the label unverifiable.
      if (!file || sha(sec.text) !== file.sha256) { grade = null; verified = false; flag = "file_changed"; agree.fileChanged++; }
      const versionStatus = VERSION.has(final.versionStatus) ? final.versionStatus : null;
      if (grade !== null && grade > 1 && versionStatus === "mismatch") { grade = 1; flag = "version_capped"; agree.versionCapped++; }
      const where = locate(sec, final.passage, final.section);
      if (grade !== null && grade >= 1 && !where) { grade = null; verified = false; flag = "unverified_span"; agree.unverifiedSpans++; }
      if (g1 === null) agree.unjudgedFirst++;
      if (s) {
        const a = g1 ?? null, b = g2 ?? null;
        agree.pairs++;
        if (a === b) agree.exact++;
        if (relevant(a) === relevant(b) && (a === null) === (b === null)) agree.relevanceAgree++;
        if (a !== null && b !== null && Math.abs(a - b) <= 1) agree.withinOne++;
      }
      if (r) agree.adjudicated++;
      const passageOf = (p, at) => ({ section: at.section, offset: at.offset, inPage: at.inPage, passageSha256: sha(flat(p)),
        excerptSources: at.section === "excerpt" ? excerptSources(sec, keys, urls[j.id], p) : null });
      const reqs = (final.requirements ?? []).map((x) => { const at = locate(sec, x.passage, x.section); return at ? { req: x.req, ...passageOf(x.passage, at) } : null; }).filter(Boolean);
      const reason = String(final.reason ?? "").slice(0, 300), questions = (final.questions ?? []).slice(0, 5).map((x) => String(x).slice(0, 200));
      text[`${f.query}:${j.id}`] = { reason, questions };
      rows[urls[j.id]] = { doc: j.id, grade, verified, flag, basis: final.basis ?? null, passage: where ? passageOf(final.passage, where) : null,
        sourceType: SOURCE.has(final.sourceType) ? final.sourceType : null, versionStatus, requirements: reqs, reasonSha256: sha(reason), questions: questions.length, questionsSha256: questions.length ? sha(JSON.stringify(questions)) : null,
        file: file ? { sha256: file.sha256, captureSha256: file.captureSha256 } : null,
        labels: { first: g1 ?? null, ...(s ? { second: g2 ?? null } : {}), ...(r ? { adjudicated: gradeOf(r.grade) ?? null } : {}) },
        provenance: r ? "independent_model_adjudication" : "independent_model_judgment" };
    }
    for (const id of expected) { agree.missingFirst++; rows[urls[id]] = { doc: id, grade: null, verified: false, flag: "missing", labels: { first: null }, provenance: "independent_model_judgment" }; }
    // The passage round, where this query has one.
    const pidx = join(PRIV, "packets-passages", f.query, "index.json");
    if (existsSync(pidx)) {
      const pj = existsSync(join(J, "passages", `${f.query}.json`)) ? read(join(J, "passages", `${f.query}.json`)) : { judgments: [] };
      const byId = new Map((pj.judgments ?? []).map((x) => [idOf(x.id), x]));
      for (const id of read(pidx).documents.map((d) => d.slice(0, -3))) {
        const row = rows[urls[id]], x = byId.get(id);
        if (!row) continue;
        if (!x) { row.docPassagesJudged = false; agree.passageDocsUnjudged++; continue; }
        const { flag, reqs } = passageSupport(f.query, id, keys, urls[id], x);
        const v = VERSION.has(x.versionStatus) ? x.versionStatus : null;
        row.docPassagesJudged = !flag;
        row.docVersionStatus = v;
        row.docRequirements = flag || v === "mismatch" ? [] : reqs;
        if (flag) { row.docFlag = flag; agree.fileChanged++; } else if (v === "mismatch") row.docFlag = "version_mismatch";
        agree.passageDocs++;
        agree.passageRequirements += row.docRequirements.length;
        agree.passageUnverified += (x.requirements ?? []).length - reqs.length;
      }
    }
    out.queries[f.query] = rows;
  }
  agree.disputes = existsSync(join(PRIV, "packets-adjudication")) ? readdirSync(join(PRIV, "packets-adjudication")).reduce((n, q) => n + read(join(PRIV, "packets-adjudication", q, "index.json")).documents.length, 0) : 0;
  out.agreement = { ...agree, idsFromFileNames, exactRate: agree.pairs ? agree.exact / agree.pairs : null, relevanceRate: agree.pairs ? agree.relevanceAgree / agree.pairs : null };
  // No credential value in either record: the judges read untrusted pages, and labels.json is committed.
  const secrets = existsSync(join(root, ".env")) ? readFileSync(join(root, ".env"), "utf8").split("\n").map((l) => /^\s*[A-Z0-9_]+\s*=\s*(.*?)\s*$/.exec(l)?.[1]?.replace(/^(['"])(.*)\1$/, "$2")).filter((v) => v && v.length >= 8) : [];
  const pub = JSON.stringify(out, null, 1), priv = JSON.stringify(text, null, 1);
  if (secrets.some((v) => pub.includes(v) || priv.includes(v))) { console.error("refused: a credential value appears in the labels"); process.exit(2); }
  writeFileSync(join(PRIV, "labels-text.json"), priv + "\n");
  writeFileSync(join(EVAL, "labels.json"), pub + "\n");
  console.log(JSON.stringify(out.agreement));
} else { console.error("usage: labels.mjs second|adjudicate|final"); process.exit(2); }
