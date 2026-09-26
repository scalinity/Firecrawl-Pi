#!/usr/bin/env node
// D1 admission sources (evidence/M0/review/DECISIONS.md, D1), fetched from public endpoints
// without credentials into evidence/M2/sources/. Workstation-side; changes nothing anywhere else.
//   node scripts/m2/d1-collect.mjs <playwright-version> <chromium-version> <v8-revision> <v8-branch>
// Writes, each with its URL and retrieval time in sources/index.txt:
//   - the npm registry's dist-tags for playwright and the playwright-core release's metadata;
//   - that release's browsers.json, read from the registry tarball after its integrity check;
//   - every Chrome Releases post since 2019-01-01 (one JSON line each: id, date, title, URL,
//     Linux version, content SHA-256 and every sentence that says "in the wild"), from which the
//     verifier derives the in-the-wild CVE list itself;
//   - Chromium's DEPS line for V8 at the bundled tag, the V8 ancestry of that revision naming the
//     in-the-wild bugs, the V8 branch log after it, and the milestone's branch point.
import { writeFileSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { ROOT } from "../m0/lib.mjs";

const [PW, CHROMIUM, V8_REV, V8_BRANCH] = process.argv.slice(2);
if (!PW || !/^\d+\.\d+\.\d+\.\d+$/.test(CHROMIUM ?? "") || !/^[0-9a-f]{40}$/.test(V8_REV ?? "") || !/^\d+\.\d+$/.test(V8_BRANCH ?? ""))
  throw new Error("usage: d1-collect.mjs <playwright-version> <chromium-version> <v8-revision-40hex> <v8-branch>");
const OUT = resolve(ROOT, "evidence/M2/sources");
mkdirSync(OUT, { recursive: true });
const sha256 = (b) => createHash("sha256").update(b).digest("hex");
const utc = () => new Date().toISOString().replace(/\.\d+Z$/, "Z");
const index = [];
const save = (name, body, url) => {
  writeFileSync(resolve(OUT, name), body);
  index.push(`${name}\t${url}\t${utc()}\t${sha256(body)}`);
};
// googlesource answers 503 intermittently (the M0 review met the same); retry, then fail loudly.
async function get(url, { tries = 20, as = "text" } = {}) {
  let last;
  for (let i = 1; i <= tries; i++) {
    try {
      const r = await fetch(url, { headers: { "user-agent": "fcpi-d1-collect" }, signal: AbortSignal.timeout(60000) });
      if (r.ok) return as === "buffer" ? Buffer.from(await r.arrayBuffer()) : await r.text();
      last = `HTTP ${r.status}`;
    } catch (e) { last = e.message; }
    await new Promise((res) => setTimeout(res, 3000 + 2000 * i));
  }
  throw new Error(`${url}: ${last} after ${tries} attempts`);
}
const gitilesJson = (t) => JSON.parse(t.replace(/^\)\]\}'\n/, ""));

// 1. npm: dist-tags, release metadata, and browsers.json from the verified tarball.
const pwMeta = JSON.parse(await get("https://registry.npmjs.org/playwright"));
save("npm-playwright-dist-tags.json", JSON.stringify({ "dist-tags": pwMeta["dist-tags"], time_of_latest: pwMeta.time[pwMeta["dist-tags"].latest] }, null, 2) + "\n", "https://registry.npmjs.org/playwright");
const coreUrl = `https://registry.npmjs.org/playwright-core/${PW}`;
const core = JSON.parse(await get(coreUrl));
save(`playwright-core-${PW}-registry.json`, JSON.stringify({ name: core.name, version: core.version, dist: core.dist, dependencies: core.dependencies ?? {}, engines: core.engines }, null, 2) + "\n", coreUrl);
const tgz = await get(core.dist.tarball, { as: "buffer" });
const integrity = "sha512-" + createHash("sha512").update(tgz).digest("base64");
if (integrity !== core.dist.integrity) throw new Error(`playwright-core ${PW} tarball integrity mismatch`);
const browsersJson = execFileSync("tar", ["-xzOf", "-", "package/browsers.json"], { input: tgz });
save(`playwright-core-${PW}-browsers.json`, browsersJson, `${core.dist.tarball} (package/browsers.json, tarball sha256 ${sha256(tgz)})`);

// 2. Chrome Releases: every post since 2019, paged by the count each page returns.
const FEED = "https://chromereleases.googleblog.com/feeds/posts/default?published-min=2019-01-01T00:00:00-08:00&alt=json&max-results=100";
const posts = [];
let total = null;
for (let start = 1; ; ) {
  const page = JSON.parse(await get(`${FEED}&start-index=${start}`));
  total = Number(page.feed["openSearch$totalResults"]?.$t ?? total);
  const entries = page.feed.entry ?? [];
  if (!entries.length) break;
  posts.push(...entries);
  start += entries.length;
}
const strip = (s) => s.replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").replace(/&#39;|&#8217;|&rsquo;/g, "'").replace(/&amp;/g, "&").replace(/\s+/g, " ").trim();
const lines = posts.map((e) => {
  const html = e.content?.$t ?? e.summary?.$t ?? "";
  const text = strip(html);
  const itw = text.split(/(?<=\.)\s+/).filter((s) => /in the wild/i.test(s));
  // The bug id of each in-the-wild CVE comes from the post's fix list, "[543557673] Medium CVE-…: …".
  const itwCves = new Set(itw.flatMap((s) => s.match(/CVE-\d{4}-\d{4,7}/g) ?? []));
  const bugLines = [...text.matchAll(/\[\s*(\d{6,})\s*\][^[]{0,40}?(CVE-\d{4}-\d{4,7}):?[^[]{0,120}/g)].filter((m) => itwCves.has(m[2])).map((m) => m[0].trim());
  return JSON.stringify({
    id: e.id.$t, published: e.published.$t, title: e.title.$t, url: (e.link.find((l) => l.rel === "alternate") ?? {}).href ?? null,
    linux: (text.match(/(\d+\.\d+\.\d+\.\d+)[^.]{0,60}?Linux/) ?? [])[1] ?? null,
    security_fixes: Number((text.match(/includes (\d+) security fix/) ?? [])[1] ?? NaN) || null,
    content_sha256: sha256(html),
    in_the_wild_sentences: itw,
    in_the_wild_bug_lines: bugLines,
  });
}).sort();
if (total !== posts.length) throw new Error(`feed reported ${total} posts, fetched ${posts.length}`);
save("chrome-releases-posts-since-2019.jsonl", lines.join("\n") + "\n", `${FEED}&start-index=N (all ${total} posts)`);

// 3. Test (b) inputs: the V8 revision the bundled Chromium pins, its ancestry, the branch after it.
const depsUrl = `https://chromium.googlesource.com/chromium/src/+/refs/tags/${CHROMIUM}/DEPS?format=TEXT`;
const deps = Buffer.from(await get(depsUrl), "base64").toString("utf8");
save(`chromium-${CHROMIUM}-deps-v8.txt`, deps.split("\n").filter((l) => /'v8_revision'/.test(l)).join("\n") + "\n", depsUrl);
const ancUrl = `https://chromium.googlesource.com/v8/v8/+log/${V8_REV}?format=JSON&n=400`;
const anc = gitilesJson(await get(ancUrl)).log;
save(`v8-${V8_REV.slice(0, 8)}-ancestry.jsonl`, anc.map((c) => JSON.stringify({ commit: c.commit, committed: c.committer.time, subject: c.message.split("\n")[0], fixed: [...c.message.matchAll(/^(?:Fixed|Bug):\s*(.+)$/gm)].map((m) => m[1].trim()) })).join("\n") + "\n", ancUrl);
const brUrl = `https://chromium.googlesource.com/v8/v8/+log/refs/branch-heads/${V8_BRANCH}?format=JSON&n=200`;
const br = gitilesJson(await get(brUrl)).log;
save(`v8-branch-heads-${V8_BRANCH}-log.jsonl`, br.map((c) => JSON.stringify({ commit: c.commit, committed: c.committer.time, subject: c.message.split("\n")[0], message_sha256: sha256(c.message), bugs_named: [...c.message.matchAll(/\b(\d{9})\b/g)].map((m) => m[1]) })).join("\n") + "\n", brUrl);

// 4. The milestone's branch point: a fix that reached stable before it was on main when the
//    milestone branched. Only milestone, branch and position are kept (the feed also names people).
const mstone = CHROMIUM.split(".")[0];
const schedUrl = `https://chromiumdash.appspot.com/fetch_milestone_schedule?mstone=${mstone}`;
const sched = JSON.parse(await get(schedUrl)).mstones[0];
const msUrl = "https://chromiumdash.appspot.com/fetch_milestones?only_branched=true";
const ms = JSON.parse(await get(msUrl)).find((m) => String(m.milestone) === mstone);
save(`chromiumdash-m${mstone}.json`, JSON.stringify({ milestone: Number(mstone), branch_point: sched.branch_point, stable_date: sched.stable_date, chromium_branch: ms.chromium_branch, chromium_main_branch_hash: ms.chromium_main_branch_hash, chromium_main_branch_position: ms.chromium_main_branch_position, v8_branch: ms.v8_branch }, null, 2) + "\n", `${schedUrl} ; ${msUrl}`);

writeFileSync(resolve(OUT, "d1-index.txt"), ["# D1 admission sources: file, URL, retrieval UTC, SHA-256 of the saved file (scripts/m2/d1-collect.mjs)", ...index, ""].join("\n"));
console.log(`posts=${posts.length}; ancestry=${anc.length}; branch_log=${br.length}; files=${index.length}`);
