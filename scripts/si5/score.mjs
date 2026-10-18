#!/usr/bin/env node
// SI5's metrics (docs/FIRECRAWL_PI_SEARCH_INTELLIGENCE_SPEC.md §23.2), from committed data only: the sanitized runs
// (eval/runs/), the labels (eval/labels.json) and the corpus. Held-out queries only.
//   - nDCG@10 (gain 2^g-1, discount log2(rank+1), ideal from the judged pool), precision@5/@10 and primary-source presence@10
//     (grade >= 2), pooled recall@20 against the judged relevant set (grade >= 2), independent-anchor recall@20, unjudged
//     counts; a query with no relevant pooled document scores 0 and is listed;
//   - documentation evidence coverage on documentation-positive queries: the share of predeclared requirements supported by a
//     verified passage within a profile's top 10 (any section, and acquired page only);
//   - activation correctness, wrong-version rate, each provider's unique relevant contribution, leave-one-provider-out recall
//     sensitivity, the fully eligible five-engine subset, timing and usage;
//   - paired, category-stratified bootstrap 95% intervals (10,000 resamples, fixed seed) for the gated differences.
// Unjudged documents count as no gain and are reported, never treated as judged irrelevant in the counts.
//   node scripts/si5/score.mjs   (writes eval/scores.json and prints the gates)
import { readFileSync, writeFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";

const root = new URL("../../", import.meta.url).pathname;
const { normalizeUrl } = await import(new URL("../../services/retrieval/src/search-intelligence/normalize.mjs", import.meta.url).href);
const EVAL = join(root, "evidence/search-intelligence/SI5/eval");
const read = (p) => JSON.parse(readFileSync(p, "utf8"));
const corpus = read(join(root, "evidence/search-intelligence/SI0/corpus/corpus-v1.json"));
const labels = read(join(EVAL, "labels.json"));
const anchors = existsSync(join(EVAL, "anchors.json")) ? read(join(EVAL, "anchors.json")) : { queries: {} };
const PROFILES = ["A", "B", "C", "D", "D-C7", "D-Ref"], PRIMARY = new Set(["official_docs", "repository", "release_notes", "paper", "standard"]);
const GENERAL = ["serper", "brave", "exa", "deepseek", "tavily"], DISCOVERY = [...GENERAL, "context7", "ref"];
const mean = (a) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : null);
const docPositive = (q) => ["positive", "ambiguous_positive"].includes(q.documentationRelevance);

const queries = corpus.queries.filter((q) => q.split === "heldout" && labels.queries[q.id] && existsSync(join(EVAL, "runs", `${q.id}.json`)));
const per = {};
for (const q of queries) {
  const run = read(join(EVAL, "runs", `${q.id}.json`)), L = labels.queries[q.id];
  const g = (u) => (L[u] && L[u].grade !== null && L[u].grade !== undefined ? L[u].grade : null);
  const list = (p) => (p === "A" ? run.profiles.A.top : run.profiles[p].top20).map((d) => d.canonicalUrl);
  const judgedGrades = Object.values(L).map((x) => x.grade).filter((x) => x !== null && x !== undefined).sort((a, b) => b - a);
  const idcg = judgedGrades.slice(0, 10).reduce((s, x, i) => s + (2 ** x - 1) / Math.log2(i + 2), 0);
  const relevantSet = new Set(Object.entries(L).filter(([, x]) => x.grade >= 2).map(([u]) => u));
  // Which providers found each URL (D's lanes), for unique contribution and leave-one-out.
  const foundBy = new Map();
  for (const lane of run.profiles.D.lanes.filter((l) => DISCOVERY.includes(l.provider) && ["success_results", "success_empty", "partial"].includes(l.status)))
    for (const c of lane.candidates) { const u = normalizeUrl(c.url)?.url; if (u) (foundBy.get(u) ?? foundBy.set(u, new Set()).get(u)).add(lane.provider); }
  const reqs = q.requiredEvidence.map((_, i) => `R${i + 1}`);
  const anchorUrls = (anchors.queries?.[q.id] ?? []).map((a) => normalizeUrl(a.url)?.url).filter((u) => u && relevantSet.has(u));
  const row = { category: q.category, docPositive: docPositive(q), explicit: !!q.documentationExplicit, versioned: !!q.versionConstraint, idcg, relevant: relevantSet.size, judged: judgedGrades.length,
    pooled: Object.keys(L).length, eligibleFive: GENERAL.every((p) => ["success_results", "success_empty"].includes(run.profiles.D.lanes.find((l) => l.provider === p)?.status)),
    activation: run.profiles.D.documentation?.activation ?? null, profiles: {}, uniqueRelevant: {}, leaveOneOut: {} };
  for (const p of PROFILES) {
    const urls = list(p), top10 = urls.slice(0, 10), top20 = urls.slice(0, 20);
    const dcg = top10.reduce((s, u, i) => s + (2 ** (g(u) ?? 0) - 1) / Math.log2(i + 2), 0);
    const rel = (u) => (g(u) ?? -1) >= 2;
    const covered = (sel, pageOnly) => reqs.filter((r) => sel.some((u) => (L[u]?.requirements ?? []).some((x) => x.req === r && (!pageOnly || x.section === "page"))));
    row.profiles[p] = {
      ndcg10: idcg > 0 ? dcg / idcg : 0, p5: urls.slice(0, 5).filter(rel).length / 5, p10: top10.filter(rel).length / 10,
      primary10: top10.some((u) => rel(u) && PRIMARY.has(L[u]?.sourceType)) ? 1 : 0,
      recall20: relevantSet.size ? top20.filter((u) => relevantSet.has(u)).length / relevantSet.size : 0,
      anchorRecall20: anchorUrls.length ? anchorUrls.filter((u) => top20.includes(u)).length / anchorUrls.length : null,
      unjudged10: top10.filter((u) => g(u) === null).length, unjudged20: top20.filter((u) => g(u) === null).length, returned: urls.length,
      coverage: reqs.length ? covered(top10, false).length / reqs.length : null, coveragePage: reqs.length ? covered(top10, true).length / reqs.length : null, covered: covered(top10, false),
      mismatch10: top10.filter((u) => L[u]?.versionStatus === "mismatch").length, versionKnown10: top10.filter((u) => ["match", "mismatch"].includes(L[u]?.versionStatus)).length,
      outcome: p === "A" ? (run.profiles.A.unmatched ? `unmatched: ${run.profiles.A.unmatched}` : "matched") : run.profiles[p].outcome,
    };
  }
  for (const prov of DISCOVERY) {
    row.uniqueRelevant[prov] = [...relevantSet].filter((u) => foundBy.get(u)?.size === 1 && foundBy.get(u).has(prov)).length;
    // Recall@20 with the relevant set this provider alone contributed to the pool removed.
    const without = new Set([...relevantSet].filter((u) => !(foundBy.get(u)?.size === 1 && foundBy.get(u).has(prov))));
    row.leaveOneOut[prov] = Object.fromEntries(["A", "D"].map((p) => [p, without.size ? list(p).slice(0, 20).filter((u) => without.has(u)).length / without.size : 0]));
  }
  const D = run.profiles.D;
  row.timing = { totalMs: D.timings?.totalMs ?? null, discoveryMs: D.timings?.discoveryMs ?? null, semanticMs: D.timings?.semanticMs ?? null, elapsedMs: D.elapsedMs,
    providers: Object.fromEntries(D.lanes.map((l) => [l.provider, l.durationMs])) };
  row.pool = D.pool;
  row.lanes = Object.fromEntries(D.lanes.map((l) => [l.provider, { status: l.status, reason: l.reason }]));
  row.ledger = run.ledger;
  per[q.id] = row;
}

// ---- aggregates and intervals -----------------------------------------------------------------------------------------------
const ids = Object.keys(per);
const macro = (set, p, m) => mean(set.map((id) => per[id].profiles[p][m]).filter((x) => x !== null));
let seed = 0x5eed5;
const rand = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x80000000; };
// Paired, category-stratified bootstrap of mean(f(query)) over the queries in set.
function bootstrap(set, f, n = 10000) {
  const byCat = new Map();
  for (const id of set) (byCat.get(per[id].category) ?? byCat.set(per[id].category, []).get(per[id].category)).push(id);
  const vals = [];
  for (let b = 0; b < n; b++) {
    let s = 0, k = 0;
    for (const list of byCat.values()) for (let i = 0; i < list.length; i++) { const v = f(list[Math.floor(rand() * list.length)]); if (v !== null) { s += v; k++; } }
    vals.push(k ? s / k : 0);
  }
  vals.sort((a, b) => a - b);
  return { point: mean(set.map(f).filter((x) => x !== null)), low: vals[Math.floor(n * 0.025)], high: vals[Math.floor(n * 0.975) - 1], resamples: n, queries: set.length };
}
const diff = (p1, p0, m) => (id) => (per[id].profiles[p1][m] === null || per[id].profiles[p0][m] === null ? null : per[id].profiles[p1][m] - per[id].profiles[p0][m]);
const dpos = ids.filter((id) => per[id].docPositive), five = ids.filter((id) => per[id].eligibleFive);
const metrics = ["ndcg10", "p5", "p10", "primary10", "recall20", "anchorRecall20", "unjudged10", "unjudged20"];
const table = (set) => Object.fromEntries(PROFILES.map((p) => [p, Object.fromEntries(metrics.map((m) => [m, macro(set, p, m)]))]));
const byCategory = Object.fromEntries([...new Set(ids.map((id) => per[id].category))].map((c) => [c, table(ids.filter((id) => per[id].category === c))]));
const nA = macro(ids, "A", "ndcg10"), nD = macro(ids, "D", "ndcg10");
const out = {
  schema: "fcpi.si5-scores/v1", queries: ids.length, all: table(ids), fivePeerSubset: { queries: five.length, ...table(five) }, byCategory,
  noRelevantPooled: ids.filter((id) => per[id].relevant === 0),
  coverage: Object.fromEntries(PROFILES.map((p) => [p, { any: macro(dpos, p, "coverage"), pageOnly: macro(dpos, p, "coveragePage") }])), docPositiveQueries: dpos.length,
  activation: { explicitActivated: ids.filter((id) => per[id].explicit && per[id].activation?.active).length, explicit: ids.filter((id) => per[id].explicit).length,
    docPositiveActivated: dpos.filter((id) => per[id].activation?.active).length, docPositive: dpos.length,
    negativeActivated: ids.filter((id) => !per[id].docPositive && per[id].activation?.active).length, negative: ids.filter((id) => !per[id].docPositive).length },
  wrongVersion: Object.fromEntries(PROFILES.map((p) => { const v = ids.filter((id) => per[id].versioned); return [p, { mismatches: v.reduce((n, id) => n + per[id].profiles[p].mismatch10, 0), versionKnown: v.reduce((n, id) => n + per[id].profiles[p].versionKnown10, 0), queries: v.length }]; })),
  uniqueRelevant: Object.fromEntries(DISCOVERY.map((p) => [p, ids.reduce((n, id) => n + per[id].uniqueRelevant[p], 0)])),
  leaveOneOut: Object.fromEntries(DISCOVERY.map((p) => [p, { A: mean(ids.map((id) => per[id].leaveOneOut[p].A)), D: mean(ids.map((id) => per[id].leaveOneOut[p].D)) }])),
  docsAblations: Object.fromEntries(["context7", "ref"].map((prov) => { const P = prov === "context7" ? "D-C7" : "D-Ref";
    return [prov, { coverage: macro(dpos, P, "coverage"), uniqueRequirementsOverC: dpos.reduce((n, id) => n + per[id].profiles[P].covered.filter((r) => !per[id].profiles.C.covered.includes(r)).length, 0) }]; })),
  gates: {
    Q01: { ndcgA: nA, ndcgD: nD, relativeImprovement: nA > 0 ? (nD - nA) / nA : null, baselineZero: !(nA > 0), ndcgDiff: bootstrap(ids, diff("D", "A", "ndcg10")),
      recallDiff: bootstrap(ids, diff("D", "A", "recall20")), pass: nA > 0 && (nD - nA) / nA >= 0.10 && macro(ids, "D", "recall20") - macro(ids, "A", "recall20") >= 0.10 },
    Q02: { ndcgDiff: bootstrap(ids, diff("C", "B", "ndcg10")), pass: macro(ids, "C", "ndcg10") - macro(ids, "B", "ndcg10") >= 0.02 },
    Q03: { coverageDiff: bootstrap(dpos, diff("D", "C", "coverage")), pageOnlyDiff: bootstrap(dpos, diff("D", "C", "coveragePage")), pass: macro(dpos, "D", "coverage") - macro(dpos, "C", "coverage") >= 0.10 },
  },
  timing: { totalMs: (() => { const t = ids.map((id) => per[id].timing.totalMs).filter(Number.isFinite).sort((a, b) => a - b); return { n: t.length, p50: t[Math.floor(t.length * 0.5)] ?? null, p95: t[Math.ceil(t.length * 0.95) - 1] ?? null, max: t.at(-1) ?? null }; })(),
    label: "workstation, live providers, one search at a time; not a Pi measurement" },
  perQuery: per,
};
writeFileSync(join(EVAL, "scores.json"), JSON.stringify(out, null, 1) + "\n");
const f = (x) => (x === null || x === undefined ? "n/a" : Number(x).toFixed(4));
console.log(`queries ${ids.length}; nDCG@10 A ${f(nA)} B ${f(macro(ids, "B", "ndcg10"))} C ${f(macro(ids, "C", "ndcg10"))} D ${f(nD)}; recall@20 A ${f(macro(ids, "A", "recall20"))} D ${f(macro(ids, "D", "recall20"))}`);
for (const [k, v] of Object.entries(out.gates)) console.log(k, v.pass ? "PASS" : "FAIL", JSON.stringify(v).slice(0, 400));
