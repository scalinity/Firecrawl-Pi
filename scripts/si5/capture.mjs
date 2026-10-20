#!/usr/bin/env node
// SI5's source captures (docs/FIRECRAWL_PI_SEARCH_INTELLIGENCE_SPEC.md §23.1): every pooled URL of eval/pool.json, fetched once
// through the platform's own batch scrape on the Pi (scripts/playground/server.mjs's sshForward, the desktop app's forwarder),
// so the platform's egress policy decides each page's route: direct within the home connection's allowance and per-domain
// pacing, the budgeted residential route only for a block. Batches of 25 (the platform's default batch size, far below its
// 300-page bulk threshold), one at a time. Before each batch it reads the platform's own count of direct navigations in the
// last day (read-only, on the Pi) and waits while that count would pass --ceiling (default 4000 of the 5000 allowance), so
// a reserve stays for every other use of the platform. Markdown only, main content (the platform's defaults).
// Captures are private (page text stays out of Git): eval/private/captures/<sha>.json; eval/captures.json lists each URL's
// outcome and content hash. Restartable: a URL already captured is skipped. Time-sensitive queries go first.
// A page that is a bot interstitial (Reddit's human-verification gate) is stored as blocked, not captured (gate.mjs);
// --reclassify applies that to the captures already stored, with no network.
//   node scripts/si5/capture.mjs [--ceiling 4000] [--max N]
//   node scripts/si5/capture.mjs --reclassify
import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { sshForward } from "../playground/server.mjs";
import { gated, asBlocked } from "./gate.mjs";

const root = new URL("../../", import.meta.url).pathname;
const EVAL = join(root, "evidence/search-intelligence/SI5/eval"), CAP = join(EVAL, "private/captures"), STATE = join(EVAL, "private/capture-state.json");
mkdirSync(CAP, { recursive: true });
const arg = (name, dflt) => { const i = process.argv.indexOf(`--${name}`); return i < 0 ? dflt : process.argv[i + 1]; };
const CEILING = Number(arg("ceiling", "4000")), MAX = Number(arg("max", "1000000")), BATCH = 25;
const sha = (s) => createHash("sha256").update(s).digest("hex");
const fileOf = (url) => join(CAP, `${sha(url).slice(0, 32)}.json`);
const say = (o) => process.stderr.write(`${new Date().toISOString()} ${JSON.stringify(o)}\n`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// The public list: each pooled URL's capture outcome and hash, no text. "failed" counts every capture that is not one
// (blocked ones included); "blocked" counts the bot interstitials among them.
function writeList() {
  const list = readdirSync(CAP).filter((f) => f.endsWith(".json")).map((f) => JSON.parse(readFileSync(join(CAP, f), "utf8")))
    .map((c) => ({ url: c.url, capturedAt: c.capturedAt, status: c.status, statusCode: c.statusCode, proxyUsed: c.proxyUsed, error: c.error, markdownSha256: c.markdownSha256, markdownChars: c.markdownChars }))
    .sort((a, b) => (a.url < b.url ? -1 : 1));
  writeFileSync(join(EVAL, "captures.json"), JSON.stringify({ schema: "fcpi.si5-captures/v1", captured: list.filter((c) => c.status === "captured").length, failed: list.filter((c) => c.status !== "captured").length, blocked: list.filter((c) => c.status === "blocked").length, captures: list }, null, 1) + "\n");
  return list;
}
// No network: a capture stored as captured that is a bot interstitial becomes blocked. Safe to repeat.
if (process.argv.includes("--reclassify")) {
  let n = 0;
  for (const f of readdirSync(CAP).filter((x) => x.endsWith(".json"))) {
    const c = JSON.parse(readFileSync(join(CAP, f), "utf8"));
    if (c.status === "captured" && gated(c)) { writeFileSync(join(CAP, f), JSON.stringify(asBlocked(c)) + "\n"); n++; }
  }
  const list = writeList();
  say({ reclassified: n, blocked: list.filter((c) => c.status === "blocked").length, done: list.length });
  process.exit(0);
}

const corpus = JSON.parse(readFileSync(join(root, "evidence/search-intelligence/SI0/corpus/corpus-v1.json"), "utf8"));
const category = Object.fromEntries(corpus.queries.map((q) => [q.id, q.category]));
const pool = JSON.parse(readFileSync(join(EVAL, "pool.json"), "utf8"));
const later = (id) => (category[id] === "time_sensitive" ? 0 : 1);
const ids = Object.keys(pool.queries).sort((a, b) => later(a) - later(b) || (a < b ? -1 : 1));
const wanted = [...new Set(ids.flatMap((id) => pool.queries[id].documents.map((d) => d.url)))].filter((u) => !existsSync(fileOf(u))).slice(0, MAX);
const state = existsSync(STATE) ? JSON.parse(readFileSync(STATE, "utf8")) : { submissions: [] };
say({ wanted: wanted.length, ceiling: CEILING });

// The platform's direct navigations in the last day, as its pacing counts them (store.mjs), read-only. It fails closed: an
// unreadable count is no room.
const directUsed = () => {
  const out = execFileSync("bash", ["-c", 'source "$1"; ssh -i "$PI_SSH_KEY" -o IdentitiesOnly=yes -o BatchMode=yes -o ConnectTimeout=8 "$PI_SSH_TARGET" "sudo -n docker exec -i fcpi-nuq-postgres-1 psql -q -U postgres -d postgres -At -v ON_ERROR_STOP=1"',
    "fcpi-si5-capture", join(root, "scripts/m1/pi-target.conf")], { input: "SELECT count(*) FROM fcpi_retrieval.direct_nav WHERE NOT fixture AND at > now() - interval '1 day';\n", encoding: "utf8", timeout: 30000 }).trim();
  return /^\d+$/.test(out) ? Number(out) : NaN;
};
const forward = sshForward();
const call = async (req) => { for (let i = 0; ; i++) { try { return await forward(req); } catch (e) { if (i >= 3) throw e; say({ retry: req.path, error: e.message }); await sleep(15000); } } };
// A page of results, retried while the forwarder or the gateway answers anything but 200.
const pageOf = async (req) => { for (let i = 0; ; i++) { const r = await call(req); if (r.status === 200) return r; if (i >= 5) throw new Error(`results page ${req.path} answered ${r.status}`); say({ retry: req.path, status: r.status }); await sleep(15000); } };
// URLs a finished job returned no document and no reason for: retried in a later pass once before being recorded.
state.unreturned ??= {};
for (let i = 0; i < wanted.length; i += BATCH) {
  const urls = wanted.slice(i, i + BATCH);
  // Room for the batch with its redirects and rendering: twice its pages, within the ceiling.
  for (;;) {
    const used = directUsed();
    if (Number.isFinite(used) && used + 2 * urls.length <= CEILING) break;
    say({ waiting: "direct allowance", used });
    await sleep(10 * 60e3);
  }
  const key = `si5-capture-${sha(urls.join("\n")).slice(0, 40)}`;
  const sub = await call({ method: "POST", path: "/v2/batch/scrape", timeout: 60, key, body: { urls, formats: ["markdown"], ignoreInvalidURLs: true } });
  if (sub.status !== 200 || !sub.data?.id) { say({ submit: sub.status, code: sub.data?.code ?? null, error: String(sub.data?.error ?? "").slice(0, 200) }); if (sub.status === 429 || sub.status === 503) { await sleep(60e3); i -= BATCH; continue; } break; }
  state.submissions.push({ at: Date.now(), n: urls.length, id: sub.data.id });
  writeFileSync(STATE, JSON.stringify(state) + "\n");
  // Poll until the job ends (its own deadline is 30 minutes), then read every page of its results. The next batch waits for
  // that end, so batches never overlap.
  let st;
  for (;;) {
    await sleep(10000);
    st = await pageOf({ method: "GET", path: `/v2/batch/scrape/${sub.data.id}?skip=0&limit=1`, timeout: 60 });
    if (["completed", "failed", "cancelled"].includes(st.data?.status)) break;
  }
  const docs = [];
  for (let skip = 0; ; ) {
    const page = await pageOf({ method: "GET", path: `/v2/batch/scrape/${sub.data.id}?skip=${skip}&limit=5`, timeout: 60 });
    const data = Array.isArray(page.data?.data) ? page.data.data : [];
    docs.push(...data);
    skip += data.length;
    if (!data.length || (!page.data.next && skip >= (page.data.total ?? 0))) break;
  }
  const byUrl = new Map();
  for (const d of docs) for (const u of [d.metadata?.sourceURL, d.metadata?.url]) if (u && !byUrl.has(u)) byUrl.set(u, d);
  // The platform's reason for each page it could not return (its route and refusal, e.g. a bot interstitial).
  const errs = await pageOf({ method: "GET", path: `/v2/batch/scrape/${sub.data.id}/errors`, timeout: 60 });
  const errOf = new Map((errs.data?.errors ?? []).map((e) => [e.url, `${e.code ?? "error"}: ${e.error ?? ""}`]));
  for (const u of errs.data?.robotsBlocked ?? []) errOf.set(u, "ROBOTS_BLOCKED");
  const at = new Date().toISOString();
  let ok = 0;
  for (const url of urls) {
    const d = byUrl.get(url) ?? byUrl.get(url.replace(/\/$/, "")) ?? byUrl.get(`${url}/`) ?? null;
    // Neither a document nor a reason: not definitive. It is left for a later pass, and recorded only the second time.
    if (!d && !errOf.has(url) && !(state.unreturned[url] >= 1)) { state.unreturned[url] = (state.unreturned[url] ?? 0) + 1; continue; }
    const md = typeof d?.markdown === "string" ? d.markdown : null;
    const m = d?.metadata ?? {};
    const good = !!md && md.trim().length > 0 && !m.error && (m.statusCode ?? 200) < 400;
    const rec = { url, capturedAt: at, jobId: sub.data.id, status: good ? "captured" : "failed", statusCode: m.statusCode ?? null, finalUrl: m.url ?? null,
      title: m.title ?? null, contentType: m.contentType ?? null, proxyUsed: m.proxyUsed ?? null, error: good ? null : String(m.error ?? errOf.get(url) ?? (d ? (m.statusCode >= 400 ? `HTTP ${m.statusCode}` : "empty_content") : "not_returned")).slice(0, 300),
      jobState: st?.data?.status ?? null, markdown: md, markdownSha256: md ? sha(md) : null, markdownChars: md?.length ?? 0 };
    // A bot interstitial is no capture of the page: stored blocked, with its hashes (gate.mjs).
    const saved = good && gated(rec) ? asBlocked(rec) : rec;
    if (saved.status === "captured") ok++;
    writeFileSync(fileOf(url), JSON.stringify(saved) + "\n");
  }
  writeFileSync(STATE, JSON.stringify(state) + "\n");
  say({ batch: i / BATCH + 1, of: Math.ceil(wanted.length / BATCH), job: st?.data?.status ?? null, ok, failed: urls.length - ok });
}

const list = writeList();
say({ done: list.length });
