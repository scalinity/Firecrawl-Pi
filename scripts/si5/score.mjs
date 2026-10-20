#!/usr/bin/env node
// SI5's metrics (docs/FIRECRAWL_PI_SEARCH_INTELLIGENCE_SPEC.md §23.2), from committed data only: the sanitized runs
// (eval/runs/), the labels (eval/labels.json), the frozen configuration (eval/frozen.json) and the corpus. Held-out queries only.
//   - nDCG@10 (gain 2^g-1, discount log2(rank+1), ideal from the judged pool) and its condensed form (unjudged documents
//     dropped from the list, as a sensitivity check), precision@5/@10 and primary-source presence@10 (grade >= 2), pooled
//     recall@20 against the judged relevant set (grade >= 2), independent-anchor recall@20, unjudged counts; a query with no
//     relevant pooled document scores 0 and is listed. A ranked list repeating a canonical URL counts it once, at its first rank;
//   - documentation evidence coverage on documentation-positive queries: the share of predeclared requirements supported within
//     a profile's top 10 by a document graded 1 or more and not of a mismatched version. A passage on the captured page counts
//     for every profile listing the document (one capture); an excerpt, or a documentation passage from the passage round,
//     counts only for a profile whose own lanes delivered it. Reported in that form ("any") and from the page alone;
//   - activation correctness, wrong-version rate, each provider's unique relevant contribution, leave-one-provider-out recall
//     sensitivity, the five-engine subset (queries every general engine could represent), timing and usage;
//   - paired, category-stratified bootstrap 95% intervals (10,000 resamples, an exact mod-2^31 generator, fixed seed) for the
//     gated differences and the relative improvement, each saying whether it excludes zero.
// Every held-out query is accounted for: one not scored is listed with its reason, and a gate is NOT_MEASURED unless all of
// them are scored, every run is from a recorded collector commit with a clean tree, and the replays it compares took D's
// answers (no miss, no divergence, internal top 20 extending the public answer). A with no acquisition (no Serper answer, or a
// failed legacy request) is not a ranking result: those queries are left out of A's figures and Q01 and listed. Q03 also needs
// the passage round for every top-10 document carrying a documentation passage. Unjudged documents count as no gain and are
// reported, never treated as judged irrelevant in the counts.
//   node scripts/si5/score.mjs   (writes eval/scores.json and prints the gates)
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const root = new URL("../../", import.meta.url).pathname;
const { normalizeUrl } = await import(new URL("../../services/retrieval/src/search-intelligence/normalize.mjs", import.meta.url).href);
const EVAL = join(root, "evidence/search-intelligence/SI5/eval");
const read = (p) => JSON.parse(readFileSync(p, "utf8"));
const corpus = read(join(root, "evidence/search-intelligence/SI0/corpus/corpus-v1.json"));
const labels = read(join(EVAL, "labels.json"));
const frozen = read(join(EVAL, "frozen.json"));
const anchors = existsSync(join(EVAL, "anchors.json")) ? read(join(EVAL, "anchors.json")) : { queries: {} };
// Each pooled URL's capture through the Pi (eval/captures.json): a profile's selected-page acquisition success is the share of its
// top 10 captured (spec §23.2).
const captured = new Map((existsSync(join(EVAL, "captures.json")) ? read(join(EVAL, "captures.json")).captures : []).map((c) => [c.url, c.status === "captured"]));
const PROFILES = ["A", "B", "C", "D", "D-C7", "D-Ref"], REPLAYS = ["B", "C", "D-C7", "D-Ref"], PRIMARY = new Set(["official_docs", "repository", "release_notes", "paper", "standard"]);
const GENERAL = ["serper", "brave", "exa", "deepseek", "tavily"], DISCOVERY = [...GENERAL, "context7", "ref"];
const DELIVERED = new Set(["success_results", "success_empty", "partial"]);
const mean = (a) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : null);
const docPositive = (q) => ["positive", "ambiguous_positive"].includes(q.documentationRelevance);
const commits = new Set([frozen.repositoryCommit, ...(frozen.collectorRevisions ?? []).map((r) => r.repositoryCommit)]);

// Every held-out query: scored, or listed with why not.
const heldout = corpus.queries.filter((q) => q.split === "heldout");
const excluded = {}, queries = [];
for (const q of heldout) {
  const path = join(EVAL, "runs", `${q.id}.json`);
  if (!existsSync(path)) { excluded[q.id] = "not_collected"; continue; }
  const run = read(path);
  if (!commits.has(run.repositoryCommit) || run.codeDirty !== false) { excluded[q.id] = `run_not_from_a_recorded_clean_collector (${String(run.repositoryCommit).slice(0, 7)})`; continue; }
  if (!labels.queries[q.id]) { excluded[q.id] = "not_labelled"; continue; }
  queries.push({ q, run });
}

const per = {};
for (const { q, run } of queries) {
  const L = labels.queries[q.id];
  const g = (u) => (L[u] && L[u].grade !== null && L[u].grade !== undefined ? L[u].grade : null);
  const dedupe = (urls) => [...new Set(urls)];
  const list = (p) => dedupe((p === "A" ? run.profiles.A.top : run.profiles[p].top20).map((d) => d.canonicalUrl));
  // A has no acquisition when it has no answer at all: no Serper answer from D, or its own legacy request failed.
  const aMissing = run.profiles.A.source === "none" || !!run.profiles.A.failure;
  const judgedGrades = Object.values(L).map((x) => x.grade).filter((x) => x !== null && x !== undefined).sort((a, b) => b - a);
  const idcg = judgedGrades.slice(0, 10).reduce((s, x, i) => s + (2 ** x - 1) / Math.log2(i + 2), 0);
  const relevantSet = new Set(Object.entries(L).filter(([, x]) => x.grade >= 2).map(([u]) => u));
  // Which providers found each URL (D's lanes), for unique contribution and leave-one-out.
  const foundBy = new Map();
  for (const lane of run.profiles.D.lanes.filter((l) => DISCOVERY.includes(l.provider) && DELIVERED.has(l.status)))
    for (const c of lane.candidates) { const u = normalizeUrl(c.url)?.url; if (u) (foundBy.get(u) ?? foundBy.set(u, new Set()).get(u)).add(lane.provider); }
  // The lanes whose text reached each profile: its own delivered lanes (a replay's are D's answers), or A's one source.
  const sources = (p) => (p === "A" ? new Set(run.profiles.A.source === "d_serper_answer" ? ["serper"] : run.profiles.A.source === "legacy_request" && !run.profiles.A.failure ? ["legacy"] : [])
    : new Set(run.profiles[p].lanes.filter((l) => DELIVERED.has(l.status)).map((l) => l.provider)));
  const reqs = q.requiredEvidence.map((_, i) => `R${i + 1}`);
  const anchorUrls = (anchors.queries?.[q.id] ?? []).map((a) => normalizeUrl(a.url)?.url).filter((u) => u && relevantSet.has(u));
  // Top-10 documents of the documentation profiles carrying a documentation passage, which Q03 needs judged.
  const docPassageUrls = new Set(["D", "D-C7", "D-Ref"].flatMap((p) => (run.profiles[p].top20 ?? []).slice(0, 10).filter((d) => (d.passages ?? []).some((x) => ["context7", "ref"].includes(x.provider))).map((d) => d.canonicalUrl)));
  const generalLanes = GENERAL.map((p) => run.profiles.D.lanes.find((l) => l.provider === p));
  const row = { category: q.category, docPositive: docPositive(q), explicit: !!q.documentationExplicit, versioned: !!q.versionConstraint, idcg, relevant: relevantSet.size, judged: judgedGrades.length,
    pooled: Object.keys(L).length, aMissing, aSource: run.profiles.A.source,
    eligibleFive: generalLanes.every((l) => l && !(l.status === "skipped" && ["unsupported_request", "not_configured"].includes(l.reason))),
    docPassagesUnjudged: [...docPassageUrls].filter((u) => L[u]?.docPassagesJudged !== true).length,
    integrity: { replayMisses: REPLAYS.flatMap((p) => (run.profiles[p].replayMisses ?? []).map((x) => `${p}:${x}`)), divergence: REPLAYS.flatMap((p) => (run.profiles[p].divergence ?? []).map((x) => `${p}:${x}`)),
      top20NotPublic: PROFILES.filter((p) => p !== "A" && run.profiles[p].top20MatchesPublic === false), enrichmentNotReplayed: REPLAYS.flatMap((p) => (run.profiles[p].enrichmentNotReplayed ?? []).map((x) => `${p}:${x.provider}:${x.selected}`)) },
    activation: run.profiles.D.documentation?.activation ?? null, profiles: {}, uniqueRelevant: {}, leaveOneOut: {} };
  for (const p of PROFILES) {
    const urls = list(p), top10 = urls.slice(0, 10), top20 = urls.slice(0, 20), seen = sources(p);
    const dcg = (l) => l.slice(0, 10).reduce((s, u, i) => s + (2 ** (g(u) ?? 0) - 1) / Math.log2(i + 2), 0);
    const rel = (u) => (g(u) ?? -1) >= 2;
    // Confirmed support (spec §23.2, F03): a document graded 1 or more, not of a mismatched version; the page for every profile
    // listing it, an excerpt or documentation passage only for a profile whose lanes delivered it.
    const supports = (u, r, pageOnly) => { const x = L[u]; if (!x || !(x.grade >= 1) || x.versionStatus === "mismatch") return false;
      return [...(x.requirements ?? []), ...(x.docRequirements ?? [])].some((y) => y.req === r && (y.inPage || (!pageOnly && (y.excerptSources ?? y.sources ?? []).some((s) => seen.has(s))))); };
    const covered = (sel, pageOnly) => reqs.filter((r) => sel.some((u) => supports(u, r, pageOnly)));
    row.profiles[p] = (p === "A" && aMissing) ? { missing: true, outcome: `no acquisition: ${run.profiles.A.unmatched ?? run.profiles.A.failure ?? "none"}` } : {
      ndcg10: idcg > 0 ? dcg(urls) / idcg : 0, ndcg10Condensed: idcg > 0 ? dcg(urls.filter((u) => g(u) !== null)) / idcg : 0,
      p5: urls.slice(0, 5).filter(rel).length / 5, p10: top10.filter(rel).length / 10,
      primary10: top10.some((u) => rel(u) && PRIMARY.has(L[u]?.sourceType)) ? 1 : 0,
      recall20: relevantSet.size ? top20.filter((u) => relevantSet.has(u)).length / relevantSet.size : 0,
      recall10: relevantSet.size ? top10.filter((u) => relevantSet.has(u)).length / relevantSet.size : 0,
      anchorRecall20: anchorUrls.length ? anchorUrls.filter((u) => top20.includes(u)).length / anchorUrls.length : null,
      unjudged10: top10.filter((u) => g(u) === null).length, unjudged20: top20.filter((u) => g(u) === null).length, returned: urls.length,
      coverage: reqs.length ? covered(top10, false).length / reqs.length : null, coveragePage: reqs.length ? covered(top10, true).length / reqs.length : null, covered: covered(top10, false),
      acquired10: top10.length ? top10.filter((u) => captured.get(u) === true).length / top10.length : null,
      mismatch10: top10.filter((u) => L[u]?.versionStatus === "mismatch").length, versionKnown10: top10.filter((u) => ["match", "mismatch"].includes(L[u]?.versionStatus)).length,
      outcome: p === "A" ? (run.profiles.A.unmatched ? `unmatched: ${run.profiles.A.unmatched}` : "matched") : run.profiles[p].outcome,
    };
  }
  for (const prov of DISCOVERY) {
    row.uniqueRelevant[prov] = [...relevantSet].filter((u) => foundBy.get(u)?.size === 1 && foundBy.get(u).has(prov)).length;
    // Recall@20 with the relevant set this provider alone contributed to the pool removed.
    const without = new Set([...relevantSet].filter((u) => !(foundBy.get(u)?.size === 1 && foundBy.get(u).has(prov))));
    row.leaveOneOut[prov] = Object.fromEntries(["A", "D"].filter((p) => !(p === "A" && aMissing)).map((p) => [p, without.size ? list(p).slice(0, 20).filter((u) => without.has(u)).length / without.size : 0]));
  }
  const D = run.profiles.D;
  row.timing = { totalMs: D.timings?.totalMs ?? null, discoveryMs: D.timings?.discoveryMs ?? null, semanticMs: D.timings?.semanticMs ?? null, elapsedMs: D.elapsedMs,
    providers: Object.fromEntries(D.lanes.map((l) => [l.provider, l.durationMs])) };
  row.pool = D.pool;
  row.lanes = Object.fromEntries(D.lanes.map((l) => [l.provider, { status: l.status, reason: l.reason }]));
  // A test suite's fixture rows that reached the shared database (before the collection had its own) are not this query's.
  row.ledgerBasis = run.ledgerBasis ?? "table_delta";
  row.ledger = (run.ledger ?? []).filter((r) => !/^fixture-/.test(r.provider));
  if (row.ledger.length !== (run.ledger ?? []).length) row.ledgerFixtureRowsDropped = (run.ledger ?? []).length - row.ledger.length;
  per[q.id] = row;
}

// ---- aggregates and intervals -----------------------------------------------------------------------------------------------
const ids = Object.keys(per), withA = ids.filter((id) => !per[id].aMissing);
const val = (id, p, m) => per[id].profiles[p][m] ?? null;
const macro = (set, p, m) => mean(set.map((id) => val(id, p, m)).filter((x) => x !== null));
// An exact LCG mod 2^31 (Math.imul keeps the product in 32 bits, so no precision is lost); fixed seed.
let seed = 0x5eed5;
const rand = () => { seed = (Math.imul(seed, 1103515245) + 12345) & 0x7fffffff; return seed / 0x80000000; };
// Paired, category-stratified bootstrap of a statistic over the queries in set: every resample draws each category's own
// number of queries with replacement, and every profile in the statistic is read on those same queries.
function bootstrap(set, stat, n = 10000) {
  const byCat = new Map();
  for (const id of set) (byCat.get(per[id].category) ?? byCat.set(per[id].category, []).get(per[id].category)).push(id);
  const vals = [];
  for (let b = 0; b < n; b++) {
    const sample = [];
    for (const list of byCat.values()) for (let i = 0; i < list.length; i++) sample.push(list[Math.floor(rand() * list.length)]);
    const v = stat(sample);
    if (v !== null && Number.isFinite(v)) vals.push(v);
  }
  vals.sort((a, b) => a - b);
  const low = vals[Math.floor(vals.length * 0.025)] ?? null, high = vals[Math.ceil(vals.length * 0.975) - 1] ?? null;
  return { point: stat(set), low, high, excludesZero: low !== null && (low > 0 || high < 0), resamples: n, usable: vals.length, queries: set.length };
}
const diff = (p1, p0, m) => (sample) => mean(sample.map((id) => (val(id, p1, m) === null || val(id, p0, m) === null ? null : val(id, p1, m) - val(id, p0, m))).filter((x) => x !== null));
const relative = (p1, p0, m) => (sample) => { const a = mean(sample.map((id) => val(id, p0, m)).filter((x) => x !== null)), b = mean(sample.map((id) => val(id, p1, m)).filter((x) => x !== null)); return a > 0 ? b / a - 1 : null; };
const dpos = ids.filter((id) => per[id].docPositive), five = ids.filter((id) => per[id].eligibleFive);
const metrics = ["ndcg10", "ndcg10Condensed", "p5", "p10", "primary10", "recall20", "recall10", "anchorRecall20", "unjudged10", "unjudged20", "acquired10"];
const table = (set) => Object.fromEntries(PROFILES.map((p) => [p, Object.fromEntries(metrics.map((m) => [m, macro(set, p, m)]))]));
const byCategory = Object.fromEntries([...new Set(ids.map((id) => per[id].category))].map((c) => [c, table(ids.filter((id) => per[id].category === c))]));
// What keeps a gate from being measured: an unscored held-out query, or a replay that did not take D's answers.
const integrity = Object.fromEntries(["replayMisses", "divergence", "top20NotPublic", "enrichmentNotReplayed"].map((k) => [k, ids.flatMap((id) => per[id].integrity[k].map((x) => `${id}:${x}`))]));
const blocked = (profiles) => [...(Object.keys(excluded).length ? [`${Object.keys(excluded).length} held-out queries not scored`] : []),
  ...[...integrity.replayMisses, ...integrity.divergence].filter((x) => profiles.includes(x.split(":")[1])),
  ...integrity.top20NotPublic.filter((x) => profiles.includes(x.split(":")[1]))];
const verdict = (why, pass) => (why.length ? "NOT_MEASURED" : pass ? "PASS" : "FAIL");
const nA = macro(withA, "A", "ndcg10"), nDa = macro(withA, "D", "ndcg10");
const q01Why = blocked(["D"]), q02Why = blocked(["B", "C"]);
const q03Why = [...blocked(["C", "D"]), ...(dpos.some((id) => per[id].docPassagesUnjudged) ? [`${dpos.reduce((n, id) => n + per[id].docPassagesUnjudged, 0)} top-10 documents' documentation passages unjudged`] : [])];
const recallGainA = macro(withA, "D", "recall20") - macro(withA, "A", "recall20");
const out = {
  schema: "fcpi.si5-scores/v2", heldout: heldout.length, queries: ids.length, excluded, aMissing: ids.filter((id) => per[id].aMissing),
  integrity, all: table(ids), fivePeerSubset: { queries: five.length, ...table(five) }, byCategory,
  noRelevantPooled: ids.filter((id) => per[id].relevant === 0),
  coverage: Object.fromEntries(PROFILES.map((p) => [p, { any: macro(dpos, p, "coverage"), pageOnly: macro(dpos, p, "coveragePage") }])), docPositiveQueries: dpos.length,
  activation: { explicitActivated: ids.filter((id) => per[id].explicit && per[id].activation?.active).length, explicit: ids.filter((id) => per[id].explicit).length,
    docPositiveActivated: dpos.filter((id) => per[id].activation?.active).length, docPositive: dpos.length,
    negativeActivated: ids.filter((id) => !per[id].docPositive && per[id].activation?.active).length, negative: ids.filter((id) => !per[id].docPositive).length },
  wrongVersion: Object.fromEntries(PROFILES.map((p) => { const v = ids.filter((id) => per[id].versioned && !(p === "A" && per[id].aMissing)); return [p, { mismatches: v.reduce((n, id) => n + val(id, p, "mismatch10"), 0), versionKnown: v.reduce((n, id) => n + val(id, p, "versionKnown10"), 0), queries: v.length }]; })),
  uniqueRelevant: Object.fromEntries(DISCOVERY.map((p) => [p, ids.reduce((n, id) => n + per[id].uniqueRelevant[p], 0)])),
  leaveOneOut: Object.fromEntries(DISCOVERY.map((p) => [p, { A: mean(withA.map((id) => per[id].leaveOneOut[p].A)), D: mean(ids.map((id) => per[id].leaveOneOut[p].D)) }])),
  docsAblations: Object.fromEntries(["context7", "ref"].map((prov) => { const P = prov === "context7" ? "D-C7" : "D-Ref";
    return [prov, { coverage: macro(dpos, P, "coverage"), coveragePage: macro(dpos, P, "coveragePage"), uniqueRequirementsOverC: dpos.reduce((n, id) => n + val(id, P, "covered").filter((r) => !val(id, "C", "covered").includes(r)).length, 0) }]; })),
  gates: {
    Q01: { status: verdict(q01Why, nA > 0 && (nDa - nA) / nA >= 0.10 && recallGainA >= 0.10), notMeasured: q01Why, queries: withA.length, ndcgA: nA, ndcgD: nDa, relativeImprovement: nA > 0 ? (nDa - nA) / nA : null, baselineZero: !(nA > 0),
      relativeImprovementCI: bootstrap(withA, relative("D", "A", "ndcg10")), ndcgDiff: bootstrap(withA, diff("D", "A", "ndcg10")), recallGain: recallGainA, recallDiff: bootstrap(withA, diff("D", "A", "recall20")),
      // The legacy A supplies at most ten documents, so its recall@20 is its recall@10: the gain at equal depth is reported beside the gate's own.
      recall10Gain: macro(withA, "D", "recall10") - macro(withA, "A", "recall10") },
    Q02: { status: verdict(q02Why, macro(ids, "C", "ndcg10") - macro(ids, "B", "ndcg10") >= 0.02), notMeasured: q02Why, ndcgDiff: bootstrap(ids, diff("C", "B", "ndcg10")) },
    Q03: { status: verdict(q03Why, macro(dpos, "D", "coverage") - macro(dpos, "C", "coverage") >= 0.10), notMeasured: q03Why, coverageDiff: bootstrap(dpos, diff("D", "C", "coverage")), pageOnlyDiff: bootstrap(dpos, diff("D", "C", "coveragePage")) },
  },
  timing: { totalMs: (() => { const t = ids.map((id) => per[id].timing.totalMs).filter(Number.isFinite).sort((a, b) => a - b); return { n: t.length, p50: t[Math.floor(t.length * 0.5)] ?? null, p95: t[Math.ceil(t.length * 0.95) - 1] ?? null, max: t.at(-1) ?? null }; })(),
    label: "workstation, live providers, one search at a time; not a Pi measurement" },
  perQuery: per,
};
// Last, so the seeded resampling stream every earlier interval used is untouched by it.
out.gates.Q01.recall10Diff = bootstrap(withA, diff("D", "A", "recall10"));
writeFileSync(join(EVAL, "scores.json"), JSON.stringify(out, null, 1) + "\n");
const f = (x) => (x === null || x === undefined ? "n/a" : Number(x).toFixed(4));
console.log(`held-out ${heldout.length}, scored ${ids.length}, excluded ${Object.keys(excluded).length}, A missing ${out.aMissing.length}; nDCG@10 A ${f(nA)} B ${f(macro(ids, "B", "ndcg10"))} C ${f(macro(ids, "C", "ndcg10"))} D ${f(macro(ids, "D", "ndcg10"))}; recall@20 A ${f(macro(withA, "A", "recall20"))} D ${f(macro(ids, "D", "recall20"))}`);
for (const [k, v] of Object.entries(out.gates)) console.log(k, v.status, v.notMeasured.slice(0, 3).join("; "));
