// The plan for l01.py: the live searches of L01, F03 and F01 in one paced run (the platform admits 60 searches an hour, so one search a minute serves all
// three). Built from the frozen corpus; nothing here reads a label or a score. Writes plan.json.
//   cold_link_only    30 cold general searches with documentation off (L01's link-only scenario)
//   cold_docs         30 cold documentation-positive searches, the 16 held-out hard-version queries among them (F03's live check) and the four
//                     classifier-dependent ones (F01)
//   activation_repeat the four classifier-dependent queries asked again with another limit, so the answer cache is not served and Jev is asked afresh
//   concurrent4_live  two rounds of four searches at once, for a live look at four-concurrent
import { readFileSync, writeFileSync } from "node:fs";
const corpus = JSON.parse(readFileSync("/Users/danny/Documents/Tools/Firecrawl/evidence/search-intelligence/SI0/corpus/corpus-v1.json", "utf8")).queries;
const bodyOf = (q, over = {}) => { const c = q.constraints ?? {}, si = { ...(q.searchIntelligence ?? {}), ...(over.si ?? {}) };
  if (c.publishedAfter) si.publishedAfter = c.publishedAfter; if (c.publishedBefore) si.publishedBefore = c.publishedBefore;
  return { query: q.query, limit: over.limit ?? 10, ...(c.includeDomains?.length ? { includeDomains: c.includeDomains } : {}), ...(c.excludeDomains?.length ? { excludeDomains: c.excludeDomains } : {}), ...(Object.keys(si).length ? { searchIntelligence: si } : {}) }; };
const byId = (a, b) => (a.id < b.id ? -1 : 1);
const positive = corpus.filter((q) => q.documentationRelevance === "positive").sort(byId), negative = corpus.filter((q) => q.documentationRelevance !== "positive").sort(byId);
// Every held-out query that sends a hard library@version pair, documentation-positive or not (F03's sixteen).
const hard = corpus.filter((q) => q.split === "heldout" && (q.searchIntelligence?.libraries ?? []).some((l) => l.version && !/^latest$/i.test(l.version))).sort(byId);
const classifier = ["Q081", "Q085", "Q094", "Q096"].map((id) => corpus.find((q) => q.id === id));
const docsSet = [...new Map([...hard, ...classifier, ...positive].map((q) => [q.id, q])).values()].slice(0, 30);
const linkSet = negative.filter((q) => !(q.searchIntelligence?.libraries ?? []).length).slice(0, 30);
const concSet = negative.filter((q) => !linkSet.includes(q) && !(q.searchIntelligence?.libraries ?? []).length).slice(0, 8);
const items = [
  ...linkSet.map((q) => ({ scenario: "cold_link_only", id: q.id, body: bodyOf(q, { si: { documentation: "off" } }) })),
  ...docsSet.map((q) => ({ scenario: "cold_docs", id: q.id, hardVersion: hard.includes(q), classifierDependent: classifier.includes(q), body: bodyOf(q) })),
  ...[6, 7, 8, 9].flatMap((limit) => classifier.map((q) => ({ scenario: "activation_repeat", id: `${q.id}@${limit}`, body: bodyOf(q, { limit, si: { documentation: "auto" } }) }))),
  { scenario: "concurrent4_live", id: "g1", group: concSet.slice(0, 4).map((q) => bodyOf(q, { si: { documentation: "off" } })) },
  { scenario: "concurrent4_live", id: "g2", group: concSet.slice(4, 8).map((q) => bodyOf(q, { si: { documentation: "off" } })) },
];
writeFileSync(new URL("plan.json", import.meta.url), JSON.stringify({ gapSeconds: 62, items }, null, 1));
const count = (s) => items.filter((i) => i.scenario === s).length;
console.log(JSON.stringify({ link: count("cold_link_only"), docs: count("cold_docs"), hardVersionIncluded: docsSet.filter((q) => hard.includes(q)).length, hardTotal: hard.length, classifierIncluded: docsSet.filter((q) => classifier.includes(q)).length,
  activationRepeat: count("activation_repeat"), concurrentRounds: count("concurrent4_live"), searches: items.reduce((n, i) => n + (i.group ? i.group.length : 1), 0), sequentialMinutes: Math.round((items.length * 62) / 60) }));
