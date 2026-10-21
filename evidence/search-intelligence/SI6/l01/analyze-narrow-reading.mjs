// F03 on the narrower reading (spec §25: zero version mismatches among the rows an output reports as version-confirmed), on a live documentation run.
// A row is confirmed by a documentation scope or by its URL (spec §6.1). When the run recorded each row's own version constraint status (`rowVersion`, from the seventh
// release's run on), the count is exact: in a hard-version query a row is reported version-confirmed when its status is "satisfied" (its URL states the release) or absent
// (a candidate whose documentation scope confirmed the release skips the URL check and gets no version entry of its own: normalize.mjs prepareCandidates), and the count is
// cross-checked per query against the response's own `versionRows.confirmed`. An earlier record has only `urls` and
// `versionRows`: the URL part is then recomputed with the shipped rule and the scope part is bounded (per query, the rows a scope confirmed = versionRows.confirmed - the rows
// whose URL confirms, and a judged mismatch whose URL does not confirm can be confirmed only by a scope, at most as many times as there are such rows). Reads the run's
// records (l01.py), the frozen corpus and the labels; prints one JSON object. It judges nothing.
//   node analyze-narrow-reading.mjs ../raw/l01-live-docs.jsonl > narrow-reading-summary.json
// The sixth release's run (`raw/release-6/l01-live-docs.jsonl`) has no `rowVersion`, so its summary is the bound; the seventh's is exact.
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

let rows = 0, judgedMismatch = 0, urlConfirmedMismatch = 0, atMostScope = 0, queries = 0, exactRuns = 0, reportedConfirmedMismatch = 0;
const disagree = [];
const reportedConfirmed = { rows: 0, byJudged: {} };
const detail = [];
for (const r of runs.filter((x) => plan.get(x.id)?.hardVersion && x.status === 200)) {
  queries++;
  const hard = hardVersions({ intelligence: corpus.get(r.id)?.searchIntelligence ?? {} }), L = labels[r.id] ?? {};
  const rv = Array.isArray(r.rowVersion) ? r.rowVersion : null;
  if (rv) exactRuns++;
  const stat = (r.urls ?? []).map((u, i) => { const c = normalizeUrl(u)?.url ?? u; return { url: urlVersionCheck(c, hard).status, judged: L[c]?.versionStatus ?? "unlabelled", reported: rv ? (rv[i] === "satisfied" || rv[i] == null ? "confirmed" : "unverified") : undefined }; });
  if (rv && r.versionRows && stat.filter((s) => s.reported === "confirmed").length !== r.versionRows.confirmed) disagree.push({ id: r.id, rowsReportedConfirmed: stat.filter((s) => s.reported === "confirmed").length, versionRowsConfirmed: r.versionRows.confirmed });
  rows += stat.length;
  for (const s of stat) if (s.reported === "confirmed") { reportedConfirmed.rows++; reportedConfirmed.byJudged[s.judged] = (reportedConfirmed.byJudged[s.judged] ?? 0) + 1; if (s.judged === "mismatch") reportedConfirmedMismatch++; }
  const urlConfirmed = stat.filter((s) => s.url === "match").length, scopeConfirmed = Math.max(0, (r.versionRows?.confirmed ?? 0) - urlConfirmed);
  const mismatch = stat.filter((s) => s.judged === "mismatch"), byUrl = mismatch.filter((s) => s.url === "match").length, others = mismatch.length - byUrl;
  judgedMismatch += mismatch.length;
  urlConfirmedMismatch += byUrl;
  atMostScope += Math.min(others, scopeConfirmed);
  if (mismatch.length) detail.push({ id: r.id, judgedMismatch: mismatch.length, ...(rv ? { reportedConfirmed: mismatch.filter((s) => s.reported === "confirmed").length } : { confirmedByUrl: byUrl, rowsAScopeConfirmed: scopeConfirmed, judgedMismatchWithoutUrlConfirmation: others, couldBeScopeConfirmed: Math.min(others, scopeConfirmed) }) });
}
const exact = exactRuns === queries && queries > 0;
console.log(JSON.stringify({ queries, rowsReturned: rows, judgedMismatchRows: judgedMismatch,
  ...(exact ? { exact: true, agreesWithVersionRowsPerQuery: disagree.length === 0, ...(disagree.length ? { disagreements: disagree } : {}), rowsReportedVersionConfirmed: reportedConfirmed.rows, reportedConfirmedByJudgedStatus: reportedConfirmed.byJudged, judgedMismatchReportedConfirmed: reportedConfirmedMismatch }
    : { exact: false, judgedMismatchConfirmedByUrl: urlConfirmedMismatch, judgedMismatchAtMostConfirmedByScope: atMostScope }), detail }, null, 1));
