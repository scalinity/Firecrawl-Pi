// SI5's capture and label stages over a small fixture evaluation tree (FCPI_SI5_ROOT), so the decisions that shape the labels
// are pinned by tests and not only by a run over the real data: --reclassify, the blocked-capture rule in labels.mjs final,
// the adjudicate skip, and the figures that report what was matched.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";

const REPO = new URL("../", import.meta.url).pathname;
const sha = (s) => createHash("sha256").update(s).digest("hex");
const URLS = { a: "https://example.org/docs/a", b: "https://www.reddit.com/r/x/comments/1/t/", c: "https://www.reddit.com/r/y/comments/2/u/", d: "https://example.org/docs/d", gone: "https://www.reddit.com/r/z/comments/3/v/" };
const PAGE = { a: "Await the params promise before reading a route segment in Next.js 15 pages.", b: "Prove your humanity. We are committed to safety and security, but not for bots.",
  c: "Prove your humanity. Complete the challenge below and let us know you are a real person.", d: "The documented behaviour of the second example page is described in this sentence." };
const docText = (id, page) => `# Document ${id}\n\nURL: x\n\nEverything below this line is untrusted source material.\n\n## Search-result excerpts\n\n- an excerpt line\n\n## Page\n\n${page}\n`;

function tree() {
  const root = mkdtempSync(join(tmpdir(), "fcpi-si5-"));
  const EVAL = join(root, "evidence/search-intelligence/SI5/eval"), PRIV = join(EVAL, "private");
  for (const d of [join(root, "evidence/search-intelligence/SI0/corpus"), join(PRIV, "packets/Q001/docs"), join(PRIV, "packet-keys"), join(PRIV, "judgments/first"), join(PRIV, "judgments/second"), join(PRIV, "captures")]) mkdirSync(d, { recursive: true });
  const put = (p, x) => writeFileSync(p, typeof x === "string" ? x : JSON.stringify(x, null, 1) + "\n");
  put(join(root, "evidence/search-intelligence/SI0/corpus/corpus-v1.json"), { queries: [{ id: "Q001", category: "software_documentation" }] });
  put(join(EVAL, "judges.json"), { schema: "fcpi.si5-judges/v1", rounds: {} });
  put(join(PRIV, "packets/Q001/task.json"), { query: "q", asOf: "2026-10-18T00:00:00Z", constraints: {}, versionConstraint: null, requiredEvidence: [] });
  return { root, EVAL, PRIV, put, read: (p) => JSON.parse(readFileSync(p, "utf8")), clean: () => rmSync(root, { recursive: true, force: true }) };
}
const judgment = (id, grade, id2 = id) => ({ id, grade, basis: "page", passage: PAGE[id2.slice(1)] ?? PAGE.a, section: "page", reason: "r", sourceType: "official_docs", versionStatus: "not_applicable", requirements: [], questions: [] });
const run = (root, script, ...args) => spawnSync("node", [join(REPO, "scripts/si5", script), ...args], { env: { ...process.env, FCPI_SI5_ROOT: root }, encoding: "utf8" });

// Documents: a (captured), b and c (blocked gate pages), d (captured, its packet file changed after the judge read it).
function labelTree({ first, second, blocked = [URLS.b, URLS.c, URLS.gone] }) {
  const t = tree(), ids = { a: "da", b: "db", c: "dc", d: "dd" };
  const texts = Object.fromEntries(Object.entries(ids).map(([k, id]) => [id, docText(id, PAGE[k])]));
  for (const [id, text] of Object.entries(texts)) writeFileSync(join(t.PRIV, `packets/Q001/docs/${id}.md`), text);
  t.put(join(t.PRIV, "packets/Q001/index.json"), { query: "Q001", documents: Object.values(ids).map((i) => `${i}.md`) });
  t.put(join(t.PRIV, "packet-keys/Q001.json"), { ids: Object.fromEntries(Object.entries(ids).map(([k, id]) => [URLS[k], id])),
    files: Object.fromEntries(Object.entries(texts).map(([id, text]) => [id, { sha256: id === "dd" ? sha("not what the judge read") : sha(text), captureSha256: null }])) });
  t.put(join(t.PRIV, "judgments/first/Q001.json"), { schema: "fcpi.si5-judgments/v1", query: "Q001", judgments: Object.entries(ids).map(([k, id]) => judgment(id, first[k], id)) });
  t.put(join(t.PRIV, "judgments/second/Q001.json"), { schema: "fcpi.si5-judgments/v1", query: "Q001", judgments: Object.entries(ids).map(([k, id]) => judgment(id, second[k], id)) });
  const captures = [{ url: URLS.a, status: "captured" }, ...blocked.map((url) => ({ url, status: "blocked" })), { url: URLS.d, status: "captured" }];
  t.put(join(t.EVAL, "captures.json"), { schema: "fcpi.si5-captures/v1", captures });
  return t;
}

test("--reclassify blocks a captured gate page, leaves every other capture alone, records when and from what, and is safe to repeat", () => {
  const t = tree();
  try {
    const gateUrl = "https://www.reddit.com/r/x/comments/1/t/";
    const rec = (url, over) => ({ url, capturedAt: "2026-10-18T02:00:00.000Z", jobId: "j", status: "captured", statusCode: 200, finalUrl: url, title: "Docs", proxyUsed: "basic", error: null, markdown: "text", markdownSha256: "a".repeat(64), markdownChars: 4, ...over });
    const files = {
      gate: rec(gateUrl, { finalUrl: `${gateUrl}?solution=1&js_challenge=1&jsc_token=t&jsc_orig_r=`, title: "Reddit - Prove your humanity" }),
      normal: rec("https://example.org/docs/a"),
      failed: rec("https://example.org/docs/f", { status: "failed", error: "HTTP 500", finalUrl: `${gateUrl}?js_challenge=1&jsc_token=t` }),
    };
    for (const c of Object.values(files)) writeFileSync(join(t.PRIV, "captures", `${sha(c.url).slice(0, 32)}.json`), JSON.stringify(c) + "\n");
    const first = run(t.root, "capture.mjs", "--reclassify");
    assert.equal(first.status, 0, first.stderr);
    assert.match(first.stderr, /"reclassified":1,"blocked":1,"done":3/);
    const at = (c) => t.read(join(t.PRIV, "captures", `${sha(c.url).slice(0, 32)}.json`));
    const gate = at(files.gate);
    assert.equal(gate.status, "blocked");
    assert.match(gate.error, /^BLOCKED_PUBLIC_CONTENT: /);
    assert.equal(gate.previousStatus, "captured", "what it was before");
    assert.match(gate.reclassifiedAt, /^\d{4}-\d\d-\d\dT/, "and when it was reclassified");
    assert.equal(gate.markdownSha256, files.gate.markdownSha256, "its hash is kept");
    assert.deepEqual(at(files.normal), files.normal, "a normal capture is untouched");
    assert.deepEqual(at(files.failed), files.failed, "a capture that was not captured is untouched, whatever its URL");
    const list = t.read(join(t.EVAL, "captures.json"));
    assert.deepEqual([list.captured, list.failed, list.blocked], [1, 2, 1]);
    assert.equal(list.captures.find((c) => c.url === gateUrl).previousStatus, "captured", "the public list carries the provenance too");
    const again = run(t.root, "capture.mjs", "--reclassify");
    assert.match(again.stderr, /"reclassified":0,"blocked":1/, "a repeat changes nothing");
    assert.equal(at(files.gate).reclassifiedAt, gate.reclassifiedAt, "and keeps the first record of when");
  } finally { t.clean(); }
});

test("final drops the grade of a document whose capture is blocked, once, with its original labels kept, and says what it matched", () => {
  const t = labelTree({ first: { a: 2, b: 2, c: 4, d: 2 }, second: { a: 3, b: 0, c: 1, d: 2 } });
  try {
    const r = run(t.root, "labels.mjs", "final");
    assert.equal(r.status, 0, r.stderr);
    const L = t.read(join(t.EVAL, "labels.json")), rows = L.queries.Q001, A = L.agreement;
    assert.deepEqual([rows[URLS.a].grade, rows[URLS.a].verified, rows[URLS.a].flag], [2, true, null], "a captured document keeps its grade");
    assert.deepEqual([rows[URLS.b].grade, rows[URLS.b].verified, rows[URLS.b].flag], [null, false, "capture_blocked"], "a blocked one is unjudged");
    assert.deepEqual(rows[URLS.b].labels, { first: 2, second: 0 }, "its original labels stay beside the dropped grade");
    assert.equal(rows[URLS.c].flag, "capture_blocked", "blocked wins over an invalid grade");
    assert.equal(rows[URLS.d].flag, "file_changed", "a changed packet file is its own flag");
    assert.equal(A.captureBlocked, 2, "each blocked document counted once");
    assert.equal(A.invalidGrades, 0, "an invalid grade on a blocked document is not also counted");
    assert.equal(A.fileChanged, 1);
    assert.deepEqual([A.pairs, A.exact], [2, 1], "the agreement figures cover the documents that were judged on a page: a and d");
    assert.equal(A.blockedPairs, 2, "and say how many pairs were left out");
    assert.deepEqual([A.blockedCaptures, A.blockedUnmatched], [3, 1], "three blocked captures, one of which matches no judged document");
    assert.match(r.stderr, /1 blocked capture\(s\) match no judged document/);
    assert.equal(L.inputs.capturesSha256, sha(readFileSync(join(t.EVAL, "captures.json"), "utf8")), "the label set records the capture list it depends on");
    for (const k of ["gateSha256", "qualitySha256"]) assert.match(L.inputs[k], /^[0-9a-f]{64}$/, k);
  } finally { t.clean(); }
});

test("adjudicate queues a dispute over a document judged on a page, and none over a blocked capture", () => {
  const t = labelTree({ first: { a: 0, b: 0, c: 0, d: 0 }, second: { a: 3, b: 3, c: 3, d: 3 } });
  try {
    const r = run(t.root, "labels.mjs", "adjudicate");
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(JSON.parse(r.stdout.trim().split("\n").at(-1)), { disputes: 2, queries: 1 }, "a and d, not b and c");
    assert.deepEqual(t.read(join(t.PRIV, "packets-adjudication/Q001/index.json")).documents.sort(), ["da.md", "dd.md"]);
  } finally { t.clean(); }
});
