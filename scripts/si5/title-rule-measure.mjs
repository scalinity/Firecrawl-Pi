#!/usr/bin/env node
// Would a title rule add anything to the shipped URL rule for strict-version requests? Measured offline against SI5's judged labels, like version-rule-measure.mjs.
// The rule was fixed before it was measured: a title states a release of library L when L's name is followed, optionally by "v", "version" or "release", by a version token;
// it confirms when a tied token is the requested release line, and mismatches when tied tokens exist and none is the requested line. Only the rows the URL rule leaves
// unverified are examined (a row a documentation scope confirms is judged by the scope). The stored runs keep each candidate's title in full and its snippets only as hashes,
// so a snippet rule cannot be measured offline.
//   node scripts/si5/title-rule-measure.mjs   (prints a table of the rule's verdicts against the judges' version status, then the rows; SI5/acceptance/title-rule-measure.txt holds a run)
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = new URL("../../", import.meta.url).pathname;
const { urlVersionCheck, hardVersions, sameVersion } = await import(new URL("../../services/retrieval/src/search-intelligence/versions.mjs", import.meta.url).href);
const { normalizeUrl } = await import(new URL("../../services/retrieval/src/search-intelligence/normalize.mjs", import.meta.url).href);
const EVAL = join(root, "evidence/search-intelligence/SI5/eval");
const read = (p) => JSON.parse(readFileSync(p, "utf8"));
const corpus = read(join(root, "evidence/search-intelligence/SI0/corpus/corpus-v1.json")), labels = read(join(EVAL, "labels.json"));

const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const TOKEN = String.raw`(\d{1,3}(?:\.\d{1,3}){0,2})(?:\.x)?(?![\d.]*\d)`;
function titleCheck(title, hard) {
  const found = [];
  for (const h of hard) {
    const words = String(h.name).split(/[\s._/-]+/).filter(Boolean).map(esc).join(String.raw`[\s._-]?`);
    const re = new RegExp(String.raw`(?<![A-Za-z0-9])${words}\s*(?:v|version|ver\.?|release)?\s*${TOKEN}`, "gi");
    for (const m of title.matchAll(re)) found.push({ lib: h.name, want: h.version, got: m[1] });
  }
  if (!found.length) return { status: "unknown" };
  return found.some((f) => sameVersion(f.got, f.want)) ? { status: "confirmed", found } : { status: "mismatch", found };
}

const rows = [];
for (const q of corpus.queries.filter((x) => x.split === "heldout")) {
  const hard = hardVersions({ intelligence: q.searchIntelligence ?? {} });
  if (!hard.length) continue;
  let run; try { run = read(join(EVAL, "runs", `${q.id}.json`)); } catch { continue; }
  const L = labels.queries[q.id]; if (!L) continue;
  for (const [rank, d] of run.profiles.D.top20.entries()) {
    const url = d.canonicalUrl, lab = L[url];
    if ((d.documentation?.scopes ?? []).some((s) => s.status === "scope_only" || s.status === "match")) continue;
    const u = urlVersionCheck(normalizeUrl(url)?.url ?? url, hard).status;
    if (u === "mismatch" || u === "confirmed") continue;
    rows.push({ q: q.id, rank: rank + 1, url, title: d.title, judged: lab?.versionStatus ?? "unlabelled", grade: lab?.grade ?? null, t: titleCheck(String(d.title ?? ""), hard) });
  }
}
const tally = (list) => { const t = {}; for (const r of list) { const k = `${r.t.status} | ${r.judged}`; t[k] = (t[k] ?? 0) + 1; } return t; };
const top10 = rows.filter((r) => r.rank <= 10);
console.log(JSON.stringify({ urlUnverifiedRows: rows.length, byTitleVerdict_judged_top20: tally(rows), top10Rows: top10.length, byTitleVerdict_judged_top10: tally(top10) }, null, 1));
console.log("--- title mismatches (any rank) ---");
for (const r of rows.filter((x) => x.t.status === "mismatch")) console.log(r.q, r.rank, r.judged, "g=" + r.grade, JSON.stringify(r.t.found.map((f) => `${f.lib}:${f.got}!=${f.want}`)), "|", String(r.title).slice(0, 90));
console.log("--- judged mismatches with title unknown (the residual), top 10 ---");
for (const r of top10.filter((x) => x.judged === "mismatch" && x.t.status === "unknown")) console.log(r.q, r.rank, "g=" + r.grade, r.url.slice(0, 80), "|", String(r.title).slice(0, 70));
