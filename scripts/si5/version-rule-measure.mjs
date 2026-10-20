#!/usr/bin/env node
// The deterministic URL version rule (spec §11.2: exact known version violations are removed by code before ranking), measured offline against SI5's
// judged labels. The rule is the code's own (versions.mjs urlVersionCheck, applied as prepareCandidates applies it: to a candidate no documentation lane
// delivered). It was defined from the spec's principle before it was measured and was not adjusted afterwards, so this is a measurement of it, not a fit.
//   - Reproduction first: the macro nDCG@10 of profiles A, B, C and D is recomputed from the stored runs and labels as score.mjs computes it, and must equal
//     the published scores.json before anything else is reported.
//   - The rule against the labels: for the held-out queries with a hard library@version, each of D's top-10 rows by its judged version status and the rule's verdict.
//   - The same rule over the whole judged pool: every general-delivered document of those queries that the judges labelled, and what the rule would remove.
//   - The effect on the gated measures if the rule is applied to the aggregate profiles' stored top-20 lists (B, C and D share the normalizer; A does not),
//     removing the flagged rows and letting the next-ranked rows move up. That is an approximation of a rerun: fusion and the shortlist would be recomputed
//     without the removed rows. It is exact for the order of the rows that remain, and every row that moves up is in the labelled pool (top 20).
//   node scripts/si5/version-rule-measure.mjs   (prints JSON; evidence/search-intelligence/SI5/acceptance/version-rule-measure.json holds a run)
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = new URL("../../", import.meta.url).pathname;
const { urlVersionCheck, hardVersions } = await import(new URL("../../services/retrieval/src/search-intelligence/versions.mjs", import.meta.url).href);
const { normalizeUrl } = await import(new URL("../../services/retrieval/src/search-intelligence/normalize.mjs", import.meta.url).href);
const EVAL = join(root, "evidence/search-intelligence/SI5/eval");
const read = (p) => JSON.parse(readFileSync(p, "utf8"));
const corpus = read(join(root, "evidence/search-intelligence/SI0/corpus/corpus-v1.json")), labels = read(join(EVAL, "labels.json")), scores = read(join(EVAL, "scores.json"));
const DOCS = new Set(["context7", "ref"]);
const mean = (a) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : null);
const round = (x) => (x === null ? null : +x.toFixed(4));

const per = {};
for (const q of corpus.queries.filter((x) => x.split === "heldout")) {
  let run; try { run = read(join(EVAL, "runs", `${q.id}.json`)); } catch { continue; }
  const L = labels.queries[q.id]; if (!L) continue;
  const g = (u) => (L[u] && L[u].grade !== null && L[u].grade !== undefined ? L[u].grade : null);
  const judged = Object.values(L).map((x) => x.grade).filter((x) => x !== null && x !== undefined).sort((a, b) => b - a);
  const idcg = judged.slice(0, 10).reduce((s, x, i) => s + (2 ** x - 1) / Math.log2(i + 2), 0);
  const hard = hardVersions({ intelligence: q.searchIntelligence ?? {} });
  const aMissing = run.profiles.A.source === "none" || !!run.profiles.A.failure;
  const rows = (p) => (p === "A" ? run.profiles.A.top : run.profiles[p].top20).map((d) => ({ url: d.canonicalUrl, providers: (d.providers ?? []).map((x) => x[0]), scopes: d.documentation?.scopes ?? [] }));
  // As prepareCandidates applies it: a candidate is checked by its URL unless its own documentation scope confirms the version; a row stays when any lane's candidate stays.
  const confirmed = (d) => d.scopes.some((s) => s.status === "scope_only" || s.status === "match");
  const verdict = (d) => (hard.length === 0 || d.providers.length === 0 ? "unknown" : confirmed(d) ? "scope_confirmed" : urlVersionCheck(normalizeUrl(d.url)?.url ?? d.url, hard).status);
  const flagged = (d) => verdict(d) === "mismatch";
  const ndcg = (list) => (idcg > 0 ? [...new Set(list)].slice(0, 10).reduce((s, u, i) => s + (2 ** (g(u) ?? 0) - 1) / Math.log2(i + 2), 0) / idcg : 0);
  const profile = (p, withRule) => ndcg(rows(p).filter((d) => !(withRule && p !== "A" && flagged(d))).map((d) => d.url));
  per[q.id] = { q, hard, aMissing, L, rows, flagged, verdict, run, plain: Object.fromEntries(["A", "B", "C", "D"].map((p) => [p, profile(p, false)])), ruled: Object.fromEntries(["A", "B", "C", "D"].map((p) => [p, profile(p, true)])) };
}
const ids = Object.keys(per), withA = ids.filter((id) => !per[id].aMissing);
const macro = (set, which, p) => mean(set.map((id) => per[id][which][p]));

// 1. Reproduction of the published figures.
const published = { A: scores.gates.Q01.ndcgA, D: scores.gates.Q01.ndcgD };
const reproduced = { A: macro(withA, "plain", "A"), D: macro(withA, "plain", "D") };
const reproduces = Math.abs(reproduced.A - published.A) < 1e-9 && Math.abs(reproduced.D - published.D) < 1e-9;

// 2. The rule against the labels, for D's top-10 rows of the held-out queries with a hard version.
const hardIds = ids.filter((id) => per[id].hard.length);
const table = {};
for (const id of hardIds) {
  const r = per[id];
  for (const d of r.rows("D").slice(0, 10)) {
    const label = r.L[d.url]?.versionStatus ?? "unlabelled";
    const rule = r.verdict(d);
    table[`${label} | ${rule}`] = (table[`${label} | ${rule}`] ?? 0) + 1;
  }
}
const sum = (pred) => Object.entries(table).filter(([k]) => pred(k)).reduce((s, [, v]) => s + v, 0);

// 2b. The same rule over the whole judged pool: every document a general lane delivered for these queries that the judges labelled.
const pool = { generalDeliveredLabelled: 0, removed: 0, removedJudgedMismatch: 0, removedNotMismatch: 0, removedRelevant: 0, removedNotMismatchExamples: [] };
for (const id of hardIds) {
  const r = per[id], seen = new Set();
  for (const lane of r.run.profiles.D.lanes.filter((l) => ["serper", "brave", "exa", "deepseek", "tavily"].includes(l.provider))) for (const c of lane.candidates ?? []) {
    const u = normalizeUrl(c.url)?.url; if (!u || seen.has(u) || !r.L[u]) continue; seen.add(u);
    pool.generalDeliveredLabelled++;
    if (urlVersionCheck(u, r.hard).status !== "mismatch") continue;
    pool.removed++;
    if (r.L[u].versionStatus === "mismatch") pool.removedJudgedMismatch++; else { pool.removedNotMismatch++; if ((r.L[u].grade ?? 0) >= 2) pool.removedRelevant++; if (pool.removedNotMismatchExamples.length < 12) pool.removedNotMismatchExamples.push(`${id} grade ${r.L[u].grade ?? "none"} ${r.L[u].versionStatus ?? "unlabelled"} ${u.slice(0, 90)}`); }
  }
}

// 3. The effect on the gated measures.
const q01 = (which) => { const a = macro(withA, which, "A"), d = macro(withA, which, "D"); return { ndcgA: round(a), ndcgD: round(d), relativeImprovement: round(d / a - 1) }; };
const q02 = (which) => ({ ndcgB: round(macro(ids, which, "B")), ndcgC: round(macro(ids, which, "C")), diff: round(macro(ids, which, "C") - macro(ids, which, "B")) });
const perQuery = hardIds.map((id) => ({ id, hard: per[id].hard.map((h) => `${h.name}@${h.version}`).join(","), rowsFlaggedInD: per[id].rows("D").filter(per[id].flagged).length, ndcgD: round(per[id].plain.D), ndcgDWithRule: round(per[id].ruled.D) }));

console.log(JSON.stringify({
  reproduction: { published, reproduced: { A: round(reproduced.A), D: round(reproduced.D) }, equal: reproduces },
  heldOutQueriesScored: ids.length, queriesWithAHardVersion: hardIds.length,
  ruleAgainstLabels: { rowsByLabelAndRule: table,
    judgedMismatchRows: sum((k) => k.startsWith("mismatch")), caughtByRule: sum((k) => k === "mismatch | mismatch"), missedByRule: sum((k) => k.startsWith("mismatch") && !k.endsWith("| mismatch")),
    judgedMatchOrNotApplicableRowsFlagged: sum((k) => /^(match|not_applicable|unknown|unlabelled) \| mismatch$/.test(k)), flaggedRowsJudgedMatch: sum((k) => k === "match | mismatch"),
    rowsAgreeingWithRuleMatch: sum((k) => k === "match | match") },
  wholePool: pool,
  effectOnGatedMeasures: { Q01_DoverA: { without: q01("plain"), withRule: q01("ruled") }, Q02_CoverB: { without: q02("plain"), withRule: q02("ruled") } },
  perHardVersionQuery: perQuery,
}, null, 1));
if (!reproduces) { console.error("the stored runs do not reproduce the published macro nDCG@10: nothing above is a measurement of SI5's data"); process.exit(1); }
