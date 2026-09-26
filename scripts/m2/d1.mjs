// Decision D1's admission test (evidence/M0/review/DECISIONS.md), from the sources that
// scripts/m2/d1-collect.mjs saved in evidence/M2/sources/. scripts/m2/verify.mjs and
// scripts/m2/build-lock.mjs both call it, so the lock and the check cannot disagree.
//   (a) the bundled Chromium is at or above the first stable build carrying the fix;
//   (b) the fix commit is an ancestor of the V8 revision the bundled Chromium pins, and no later
//       commit on that V8 branch names the bug.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { ROOT } from "../m0/lib.mjs";

export const SRC = "evidence/M2/sources/";
const read = (p) => readFileSync(resolve(ROOT, p), "utf8");
const lines = (p) => read(p).split("\n").filter(Boolean).map((l) => JSON.parse(l));
export const vcmp = (a, b) => { const x = a.split(".").map(Number), y = b.split(".").map(Number); for (let i = 0; i < 4; i++) if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) - (y[i] ?? 0); return 0; };

export function d1() {
  const posts = lines(`${SRC}chrome-releases-posts-since-2019.jsonl`);
  const chromium = JSON.parse(read(`${SRC}playwright-core-1.63.0-browsers.json`)).browsers.find((b) => b.name === "chromium");
  const bundled = chromium.browserVersion;
  const tags = JSON.parse(read(`${SRC}npm-playwright-dist-tags.json`));
  const dash = JSON.parse(read(`${SRC}chromiumdash-m153.json`));
  const v8rev = (read(`${SRC}chromium-153.0.8010.12-deps-v8.txt`).match(/'v8_revision': '([0-9a-f]{40})'/) ?? [])[1];
  const anc = lines(`${SRC}v8-${(v8rev ?? "").slice(0, 8)}-ancestry.jsonl`);
  const branch = lines(`${SRC}v8-branch-heads-${dash.v8_branch}-log.jsonl`);
  const pin = branch.findIndex((c) => c.commit === v8rev);
  const later = pin > 0 ? branch.slice(0, pin) : [];
  // Every CVE a post says is exploited in the wild, its crbug id, and the first stable version
  // whose post carries it (a post that names no Linux build gives the first version it names).
  const cves = new Map();
  for (const p of posts) for (const sentence of p.in_the_wild_sentences ?? []) for (const [cve] of sentence.matchAll(/CVE-\d{4}-\d{4,}/g)) {
    const line = (p.in_the_wild_bug_lines ?? []).find((l) => l.includes(cve)) ?? "";
    const bug = (line.match(/^\[\s*(\d+)\s*\]/) ?? [])[1] ?? null;
    const v = p.linux ?? p.version_first ?? null;
    const cur = cves.get(cve);
    if (!cur || (v && (!cur.first_fixed || vcmp(v, cur.first_fixed) < 0))) cves.set(cve, { cve, bug: bug ?? cur?.bug ?? null, first_fixed: v ?? cur?.first_fixed ?? null, published: p.published, component_v8: /in V8/.test(line) });
  }
  const branchPoint = Date.parse(dash.branch_point);
  const rows = [...cves.values()].sort((a, b) => a.cve.localeCompare(b.cve)).map((c) => {
    const a = !!c.first_fixed && vcmp(bundled, c.first_fixed) >= 0;
    const fix = c.bug ? anc.find((x) => (x.fixed ?? []).some((f) => f.split(/[,\s]+/).includes(c.bug))) : null;
    const reopened = c.bug ? later.some((x) => (x.bugs_named ?? []).includes(c.bug)) : false;
    const b = !!fix && !reopened;
    // A fix whose stable post came after the bundled milestone branched may postdate the build
    // though its version number is lower; there (b) is reported beside (a).
    return { ...c, test_a: a, test_b: b, fix_commit: fix?.commit ?? null, after_branch_point: Date.parse(c.published) >= branchPoint, pass: a || b };
  });
  return { bundled, revision: chromium.revision, latest: tags["dist-tags"]?.latest ?? null, v8rev, v8_branch: dash.v8_branch, branch_point: dash.branch_point, later_branch_commits: later.length, rows };
}
