// F03 on the Pi: what the final release returned for the held-out queries that carry a hard library@version, set against SI5's judged labels.
// Reads a live run that recorded each search's row URLs (l01.py with `urls` and `versionRows`), the frozen corpus and the labels. Prints one JSON object.
//   node analyze-f03-live.mjs l01-live-docs.jsonl > f03-live-summary.json
// A returned URL is looked up by its canonical form in eval/labels.json (the judged pool of the collection). A URL the judges never saw is "unlabelled": the
// live providers return different pages from day to day, so the comparison is exact only for the rows the pool covers; the unlabelled share is reported.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "../../../..");
const { normalizeUrl } = await import(new URL("../../../../services/retrieval/src/search-intelligence/normalize.mjs", import.meta.url).href);
const read = (p) => JSON.parse(readFileSync(p, "utf8"));
const lines = (f) => readFileSync(f, "utf8").split("\n").filter((l) => l.startsWith("{")).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
const live = lines(process.argv[2]).filter((r) => r.kind === "search" && r.scenario === "cold_docs");
const plan = new Map(read(join(here, "plan-docs.json")).items.map((i) => [i.id, i]));
const labels = read(join(root, "evidence/search-intelligence/SI5/eval/labels.json")).queries;
const scores = read(join(root, "evidence/search-intelligence/SI5/eval/scores.json"));
const count = (xs) => Object.fromEntries([...new Set(xs)].sort().map((k) => [k, xs.filter((x) => x === k).length]));

const perQuery = [];
for (const r of live.filter((x) => plan.get(x.id)?.hardVersion)) {
  const L = labels[r.id] ?? {};
  const rows = (r.urls ?? []).map((u) => { const c = normalizeUrl(u)?.url ?? u; return { url: c, status: L[c]?.versionStatus ?? "unlabelled" }; });
  perQuery.push({ id: r.id, status: r.status, outcome: r.outcome, returned: rows.length, byJudgedStatus: count(rows.map((x) => x.status)), versionRows: r.versionRows ?? null,
    versions: (r.versions ?? []).map((v) => v.verdict), warnings: (r.warnings ?? []).filter((w) => /version/.test(w)), mismatchRows: rows.filter((x) => x.status === "mismatch").map((x) => x.url.slice(0, 110)) });
}
const sum = (f) => perQuery.reduce((n, q) => n + f(q), 0);
const collection = scores.wrongVersion.D;   // { mismatches, versionKnown, queries } over D's top 10 in the collection
console.log(JSON.stringify({
  searches: perQuery.length, answered: perQuery.filter((q) => q.status === 200).length, withRowUrls: perQuery.filter((q) => q.returned > 0).length,
  rowsReturned: sum((q) => q.returned), byJudgedStatus: count(perQuery.flatMap((q) => Object.entries(q.byJudgedStatus).flatMap(([k, n]) => Array(n).fill(k)))),
  judgedMismatchRowsReturnedNow: sum((q) => q.byJudgedStatus.mismatch ?? 0), judgedMatchRowsReturnedNow: sum((q) => q.byJudgedStatus.match ?? 0), collectionD: collection,
  versionRowsTotals: { returned: sum((q) => q.versionRows?.returned ?? 0), confirmed: sum((q) => q.versionRows?.confirmed ?? 0), unverified: sum((q) => q.versionRows?.unverified ?? 0), excluded: sum((q) => q.versionRows?.excluded ?? 0) },
  verdicts: count(perQuery.flatMap((q) => q.versions)), perQuery,
}, null, 1));
