// F03 on the narrower reading (spec §25: zero version mismatches among the rows an output reports as version-confirmed), on a live documentation run.
// A row is confirmed by a documentation scope or by its URL (spec §6.1). The URL part is recomputed exactly with the shipped rule; the scope part is not recorded per
// row, so it is bounded: per query, the rows a scope confirmed = versionRows.confirmed - the rows whose URL confirms, and a judged mismatch whose URL does not confirm
// can be confirmed only by a scope, at most as many times as there are such rows. Reads the run's records (l01.py with `urls` and `versionRows`), the frozen corpus and
// the labels; prints one JSON object. It judges nothing.
//   node analyze-narrow-reading.mjs ../raw/l01-live-docs.jsonl > narrow-reading-summary.json
// Run on the sixth release's run (`raw/l01-live-docs.jsonl` when it was taken, `raw/release-6/` once a later release is filed).
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url)), root = join(here, "../../../..");
const { urlVersionCheck, hardVersions } = await import(new URL("../../../../services/retrieval/src/search-intelligence/versions.mjs", import.meta.url).href);
const { normalizeUrl } = await import(new URL("../../../../services/retrieval/src/search-intelligence/normalize.mjs", import.meta.url).href);
const read = (p) => JSON.parse(readFileSync(p, "utf8"));
const corpus = new Map(read(join(root, "evidence/search-intelligence/SI0/corpus/corpus-v1.json")).queries.map((q) => [q.id, q]));
const labels = read(join(root, "evidence/search-intelligence/SI5/eval/labels.json")).queries;
const plan = new Map(read(join(here, "plan-docs.json")).items.map((i) => [i.id, i]));
const runs = readFileSync(process.argv[2], "utf8").split("\n").filter((l) => l.startsWith("{")).map((l) => JSON.parse(l)).filter((r) => r.kind === "search" && r.scenario === "cold_docs");

let rows = 0, judgedMismatch = 0, urlConfirmedMismatch = 0, atMostScope = 0, queries = 0;
const detail = [];
for (const r of runs.filter((x) => plan.get(x.id)?.hardVersion && x.status === 200)) {
  queries++;
  const hard = hardVersions({ intelligence: corpus.get(r.id)?.searchIntelligence ?? {} }), L = labels[r.id] ?? {};
  const stat = (r.urls ?? []).map((u) => { const c = normalizeUrl(u)?.url ?? u; return { url: urlVersionCheck(c, hard).status, judged: L[c]?.versionStatus ?? "unlabelled" }; });
  rows += stat.length;
  const urlConfirmed = stat.filter((s) => s.url === "match").length, scopeConfirmed = Math.max(0, (r.versionRows?.confirmed ?? 0) - urlConfirmed);
  const mismatch = stat.filter((s) => s.judged === "mismatch"), byUrl = mismatch.filter((s) => s.url === "match").length, others = mismatch.length - byUrl;
  judgedMismatch += mismatch.length;
  urlConfirmedMismatch += byUrl;
  atMostScope += Math.min(others, scopeConfirmed);
  if (mismatch.length) detail.push({ id: r.id, judgedMismatch: mismatch.length, confirmedByUrl: byUrl, rowsAScopeConfirmed: scopeConfirmed, judgedMismatchWithoutUrlConfirmation: others, couldBeScopeConfirmed: Math.min(others, scopeConfirmed) });
}
console.log(JSON.stringify({ queries, rowsReturned: rows, judgedMismatchRows: judgedMismatch, judgedMismatchConfirmedByUrl: urlConfirmedMismatch, judgedMismatchAtMostConfirmedByScope: atMostScope, detail }, null, 1));
