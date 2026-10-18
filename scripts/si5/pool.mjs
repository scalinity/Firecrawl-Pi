#!/usr/bin/env node
// SI5's judged pool (docs/FIRECRAWL_PI_SEARCH_INTELLIGENCE_SPEC.md §23.1), by a rule fixed before any judgment exists. For each
// held-out query:
//   - every profile's internal top 20 (A supplies its first ten), whole: no inconvenient ranked result is capped away;
//   - the provider sample: each discovery provider's two best-ranked candidates that pass the query's constraints, that no other
//     provider returned and that no profile ranked in its top 20 (its unique, otherwise unpooled contribution);
//   - the independent primary-source anchors (eval/anchors.json), when present.
// Documents are identified by canonical URL (normalize.mjs). Writes eval/pool.json: per query, each URL and why it is pooled;
// no provider text. Tuning queries are not pooled: no tuning is run, so no tuning label is needed.
//   node scripts/si5/pool.mjs
import { readFileSync, writeFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";

const root = new URL("../../", import.meta.url).pathname;
const si = (p) => import(new URL(`../../services/retrieval/src/search-intelligence/${p}`, import.meta.url).href);
const [{ validateSearchRequest }, { prepareCandidates, normalizeUrl }] = await Promise.all(["contracts.mjs", "normalize.mjs"].map(si));
const EVAL = join(root, "evidence/search-intelligence/SI5/eval"), RUNS = join(EVAL, "private/runs");
const PROFILES = ["A", "B", "C", "D", "D-C7", "D-Ref"], DISCOVERY = ["serper", "brave", "exa", "deepseek", "tavily", "context7", "ref"], SAMPLE = 2;

const corpus = JSON.parse(readFileSync(join(root, "evidence/search-intelligence/SI0/corpus/corpus-v1.json"), "utf8"));
const anchorsPath = join(EVAL, "anchors.json");
const anchors = existsSync(anchorsPath) ? JSON.parse(readFileSync(anchorsPath, "utf8")) : null;
const collected = new Set(readdirSync(RUNS).filter((f) => f.endsWith(".json")).map((f) => f.slice(0, -5)));
const constraintsOf = (q) => validateSearchRequest({ schema: "fcpi.search-request/v1", requestId: "si5-pool-0000", logicalSearchId: "00000000-0000-4000-8000-000000000000", principalId: "si5-pool",
  originalQuery: q.query, limit: 10, language: "en", constraints: q.constraints ?? {}, intelligence: q.searchIntelligence ?? {}, resultMode: "links", absoluteDeadlineMs: Date.now() + 60000 }).constraints;

const out = { schema: "fcpi.si5-pool/v1", rule: { profiles: PROFILES, depth: 20, legacyDepth: 10, providerSample: SAMPLE, discovery: DISCOVERY, anchors: !!anchors }, queries: {} };
for (const q of corpus.queries.filter((x) => x.split === "heldout")) {
  if (!collected.has(q.id)) { out.queries[q.id] = { collected: false, documents: [] }; continue; }
  const run = JSON.parse(readFileSync(join(RUNS, `${q.id}.json`), "utf8"));
  const docs = new Map();
  const add = (url, why) => { if (!url) return; const d = docs.get(url) ?? docs.set(url, { url, why: [] }).get(url); if (!d.why.includes(why)) d.why.push(why); };
  for (const p of PROFILES) {
    const list = p === "A" ? run.profiles.A.top : run.profiles[p].top20;
    list.forEach((d, i) => add(d.canonicalUrl, `${p}@${i + 1}`));
  }
  const ranked = new Set(docs.keys());
  // Which providers returned each canonical URL, across D's lanes (constraints applied as the system applies them).
  const constraints = constraintsOf(q), byUrl = new Map(), kept = {};
  for (const lane of run.profiles.D.lanes.filter((l) => DISCOVERY.includes(l.provider))) {
    kept[lane.provider] = prepareCandidates(lane.provider, lane.candidates, constraints).kept.sort((a, b) => a.rank - b.rank);
    for (const c of kept[lane.provider]) (byUrl.get(c.canonicalUrl) ?? byUrl.set(c.canonicalUrl, new Set()).get(c.canonicalUrl)).add(lane.provider);
  }
  for (const [provider, list] of Object.entries(kept)) {
    const seen = new Set();
    for (const c of list) {
      if (seen.size >= SAMPLE) break;
      if (ranked.has(c.canonicalUrl) || byUrl.get(c.canonicalUrl).size > 1 || seen.has(c.canonicalUrl)) continue;
      seen.add(c.canonicalUrl);
      add(c.canonicalUrl, `sample:${provider}`);
    }
  }
  for (const a of anchors?.queries?.[q.id] ?? []) add(normalizeUrl(a.url)?.url ?? null, "anchor");
  out.queries[q.id] = { collected: true, documents: [...docs.values()].sort((a, b) => (a.url < b.url ? -1 : 1)) };
}
const counts = Object.values(out.queries).map((x) => x.documents.length);
out.summary = { queries: counts.length, collected: Object.values(out.queries).filter((x) => x.collected).length, documents: counts.reduce((a, b) => a + b, 0),
  distinctUrls: new Set(Object.values(out.queries).flatMap((x) => x.documents.map((d) => d.url))).size };
writeFileSync(join(EVAL, "pool.json"), JSON.stringify(out, null, 1) + "\n");
console.log(JSON.stringify(out.summary));
