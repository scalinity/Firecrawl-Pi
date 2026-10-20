// The pure parts of SI5's API judge (judge-api.mjs): reading a model's reply, holding it to the packet's shape, and splitting
// a long packet by document. Nothing here coerces a value: a grade outside the scale is reported, never repaired (labels.mjs
// final treats it as no grade as well).
const SCHEMA = "fcpi.si5-judgments/v1";
const GRADES = [0, 1, 2, 3, null];
const BASIS = ["page", "excerpt", "both", "none"];
const SOURCE_TYPES = ["official_docs", "repository", "release_notes", "paper", "standard", "vendor_blog", "news", "forum", "q_and_a", "tutorial", "aggregator", "mirror", "other"];
const VERSION_STATUS = ["match", "mismatch", "unknown", "not_applicable"];

// The object between the reply's first "{" and last "}": a model may wrap it in a code fence or a sentence.
export function parseReply(text) {
  const s = String(text ?? ""), a = s.indexOf("{"), b = s.lastIndexOf("}");
  if (a < 0) throw new Error("no JSON object in the reply");
  try { return JSON.parse(b > a ? s.slice(a, b + 1) : s.slice(a)); } catch (e) { throw new Error(`the reply is not valid JSON: ${e.message}`); }
}

// The reasons a parsed reply is not the judgment file for packet q whose documents are ids; none when it is.
export function checkJudgments(r, q, ids) {
  const errs = [];
  if (r?.schema !== SCHEMA) errs.push(`schema is not ${SCHEMA}`);
  if (r?.query !== q) errs.push(`query is ${JSON.stringify(r?.query)}, expected ${q}`);
  if (!Array.isArray(r?.judgments)) return [...errs, "judgments is not an array"];
  const seen = new Set();
  for (const j of r.judgments) {
    const id = j?.id;
    if (!ids.includes(id)) { errs.push(`unexpected ${id}`); continue; }
    if (seen.has(id)) errs.push(`duplicate ${id}`);
    seen.add(id);
    if (!GRADES.includes(j.grade)) errs.push(`${id}: grade ${j.grade} is not on the scale (0 to 3, or null)`);
    if (!BASIS.includes(j.basis)) errs.push(`${id}: basis ${j.basis} is not one of ${BASIS.join(", ")}`);
    if (!SOURCE_TYPES.includes(j.sourceType)) errs.push(`${id}: sourceType ${j.sourceType} is not a known type`);
    if (!VERSION_STATUS.includes(j.versionStatus)) errs.push(`${id}: versionStatus ${j.versionStatus} is not one of ${VERSION_STATUS.join(", ")}`);
    if (typeof j.reason !== "string" || !j.reason.trim()) errs.push(`${id}: reason is empty`);
  }
  for (const id of ids) if (!seen.has(id)) errs.push(`missing ${id}`);
  return errs;
}

// Documents ({ name, text }) in groups whose estimated size (four characters to a token) stays under limitTokens, in order; a
// document over the limit stands alone. Each document is judged on its own, so the split does not change a judgment.
export function chunkDocs(docs, limitTokens) {
  const groups = [];
  let cur = [], size = 0;
  for (const d of docs) {
    const t = Math.ceil(d.text.length / 4);
    if (cur.length && size + t > limitTokens) { groups.push(cur); cur = []; size = 0; }
    cur.push(d); size += t;
  }
  if (cur.length) groups.push(cur);
  return groups;
}
