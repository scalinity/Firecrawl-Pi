// The pure parts of SI5's API judge (judge-api.mjs): reading a model's reply, holding it to the packet's shape, and splitting
// a long packet by document. Nothing here coerces a value: a grade outside the scale is reported, never repaired (labels.mjs
// final treats it as no grade as well).
const SCHEMA = "fcpi.si5-judgments/v1";
const GRADES = [0, 1, 2, 3, null];
const BASIS = ["page", "excerpt", "both", "none"];
const SOURCE_TYPES = ["official_docs", "repository", "release_notes", "paper", "standard", "vendor_blog", "news", "forum", "q_and_a", "tutorial", "aggregator", "mirror", "other"];
const VERSION_STATUS = ["match", "mismatch", "unknown", "not_applicable"];

// The code a run record came from (SI5 acceptance review W6): each script's hash as read, the repository commit, and whether any
// code outside evidence/ differs from it, asked the way collect.mjs asks. A record without it cannot be tied to a commit.
export function scriptIdentity({ files, read, git, sha }) {
  return { files: Object.fromEntries(files.map((f) => [f, sha(read(f))])), commit: git("rev-parse", "HEAD"), codeDirty: git("status", "--porcelain", "--", ".", ":(exclude)evidence").length > 0 };
}

// The object between the reply's first "{" and last "}": a model may wrap it in a code fence or a sentence.
export function parseReply(text) {
  const s = String(text ?? ""), a = s.indexOf("{"), b = s.lastIndexOf("}");
  if (a < 0) throw new Error("no JSON object in the reply");
  try { return JSON.parse(b > a ? s.slice(a, b + 1) : s.slice(a)); } catch (e) { throw new Error(`the reply is not valid JSON: ${e.message}`); }
}

// What is wrong with one judgment's own fields; nothing when it is well formed.
function fieldErrors(j) {
  const id = j.id, errs = [];
  if (!GRADES.includes(j.grade)) errs.push(`${id}: grade ${j.grade} is not on the scale (0 to 3, or null)`);
  if (!BASIS.includes(j.basis)) errs.push(`${id}: basis ${j.basis} is not one of ${BASIS.join(", ")}`);
  if (!SOURCE_TYPES.includes(j.sourceType)) errs.push(`${id}: sourceType ${j.sourceType} is not a known type`);
  if (!VERSION_STATUS.includes(j.versionStatus)) errs.push(`${id}: versionStatus ${j.versionStatus} is not one of ${VERSION_STATUS.join(", ")}`);
  if (typeof j.reason !== "string" || !j.reason.trim()) errs.push(`${id}: reason is empty`);
  return errs;
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
    errs.push(...fieldErrors(j));
  }
  for (const id of ids) if (!seen.has(id)) errs.push(`missing ${id}`);
  return errs;
}

// The well-formed judgments of a reply for packet q (the first of a document, none of an unexpected one), and the problems found
// in the rest. A reply that stopped early or got some documents wrong still yields what it judged correctly; the caller asks
// again for the documents it did not get. Each document is judged on its own, so asking for fewer changes no judgment.
export function splitJudgments(r, q, ids) {
  const problems = [], valid = [], seen = new Set();
  if (r?.schema !== SCHEMA) problems.push(`schema is not ${SCHEMA}`);
  if (r?.query !== q) problems.push(`query is ${JSON.stringify(r?.query)}, expected ${q}`);
  if (!Array.isArray(r?.judgments)) problems.push("judgments is not an array");
  if (problems.length) return { valid, problems };
  for (const j of r.judgments) {
    const id = j?.id;
    if (!ids.includes(id)) { problems.push(`unexpected ${id}`); continue; }
    if (seen.has(id)) { problems.push(`duplicate ${id}`); continue; }
    seen.add(id);
    const errs = fieldErrors(j);
    if (errs.length) problems.push(...errs); else valid.push(j);
  }
  return { valid, problems };
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
