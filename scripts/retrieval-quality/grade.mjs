#!/usr/bin/env node
// Grades the platform's retrieval quality through its MCP interface, as an agent uses it, against ground truth fetched
// directly from each target. Every criterion is fixed here before a run; a test's grade is A+ only when all of its
// criteria hold, then A, B, C, D by the share that hold (90, 80, 70, 60 %), F below. Each page's acquisition record
// is read back from the retrieval service's log on the Pi (its strategies, route and proxy spend), so "stayed on the
// home connection" and "spent nothing" are measured, not assumed.
//   node scripts/retrieval-quality/grade.mjs [--paid]      (--paid adds the residential-route test, which spends)
// Writes evidence/post-m9/retrieval-quality/grade-<utc>.json: measurements and the hashes of the raw answers, never
// the pages themselves. The MCP token comes from the login keychain (scripts/m9/mcp-headers.sh) and is never printed.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");
const PAID = process.argv.includes("--paid");
// The Pi's SSH target, as every script reads it: the one definition, sourced by bash (CLAUDE.md §33.1).
const [target, key] = execFileSync("bash", ["-c", '. "$1" && printf "%s\\n%s" "$PI_SSH_TARGET" "$PI_SSH_KEY"', "_", join(ROOT, "scripts/m1/pi-target.conf")], { encoding: "utf8" }).split("\n");
const ssh = (cmd) => execFileSync("ssh", ["-i", key, "-o", "IdentitiesOnly=yes", "-o", "BatchMode=yes", "-o", "ConnectTimeout=15", target, cmd], { encoding: "utf8", maxBuffer: 256 * 1048576 });
const sha = (s) => createHash("sha256").update(s).digest("hex");
const git = (...a) => execFileSync("git", ["-C", ROOT, ...a], { encoding: "utf8" }).trim();

const host = JSON.parse(ssh("tailscale status --json")).Self.DNSName.replace(/\.$/, "");
const ENDPOINT = `https://${host}:8443/mcp`;
const AUTH = JSON.parse(execFileSync(join(ROOT, "scripts/m9/mcp-headers.sh"), ["claude"], { encoding: "utf8" })).Authorization;
const MODERN = "2026-07-28";
const META = { "io.modelcontextprotocol/protocolVersion": MODERN, "io.modelcontextprotocol/clientCapabilities": {}, "io.modelcontextprotocol/clientInfo": { name: "fcpi-quality-grader", version: "1" } };
const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) fcpi-quality-grader";

let seq = 0;
async function mcp(name, args) {
  const t0 = Date.now();
  const res = await fetch(ENDPOINT, { method: "POST", signal: AbortSignal.timeout(170000),
    headers: { authorization: AUTH, "content-type": "application/json", accept: "application/json, text/event-stream", "mcp-protocol-version": MODERN, "mcp-method": "tools/call", "mcp-name": name },
    body: JSON.stringify({ jsonrpc: "2.0", id: ++seq, method: "tools/call", params: { name, arguments: args, _meta: META } }) });
  const text = await res.text();
  const msg = (res.headers.get("content-type") ?? "").includes("text/event-stream")
    ? JSON.parse(text.split("\n").filter((l) => l.startsWith("data:")).map((l) => l.slice(5)).filter((d) => d.includes('"result"') || d.includes('"error"')).at(-1))
    : JSON.parse(text);
  if (msg.error) throw new Error(`${name}: JSON-RPC error ${JSON.stringify(msg.error)}`);
  const body = msg.result.content.find((c) => c.type === "text")?.text ?? "null";
  return { isError: msg.result.isError === true, payload: JSON.parse(body), ms: Date.now() - t0, bytes: Buffer.byteLength(text), sha256: sha(text) };
}
const direct = async (url) => { const r = await fetch(url, { headers: { "user-agent": UA }, signal: AbortSignal.timeout(30000) }); return { status: r.status, text: await r.text() }; };
const unescape = (s) => s.replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">");
const norm = (s) => unescape(s).replace(/\\([\\[\]()*_#.!-])/g, "$1").replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/\s+/g, " ").trim().toLowerCase();
const grade = (criteria) => {
  const passed = criteria.filter((c) => c.pass).length, share = passed / criteria.length;
  return { grade: share === 1 ? "A+" : share >= 0.9 ? "A" : share >= 0.8 ? "B" : share >= 0.7 ? "C" : share >= 0.6 ? "D" : "F", passed, of: criteria.length, criteria };
};
const c = (name, pass, measured) => ({ name, pass: !!pass, measured });
const scrapeIds = new Set();
const noteId = (d) => { const id = d?.metadata?.scrapeId; if (id) scrapeIds.add(id); return id; };

const started = new Date();
const tests = {};
// The proxy ledger's day and month rows (reserved plus settled micro-USD), read before and after, so a paid run measures
// what it spent rather than assuming it.
const proxyLedger = async () => { const c = await mcp("firecrawl_capabilities", {}); return Object.fromEntries((c.payload.providers?.budgets ?? []).filter((b) => b.category === "proxy").map((b) => [b.period, b.reserved + b.settled])); };
const ledgerBefore = PAID ? await proxyLedger() : null;

// T1: a static catalogue page, default options.
{
  const url = "https://books.toscrape.com/catalogue/page-1.html";
  const gt = (await direct(url)).text;
  const titles = [...gt.matchAll(/<h3><a href="[^"]+" title="([^"]+)"/g)].map((m) => unescape(m[1]));
  const prices = [...gt.matchAll(/<p class="price_color">([^<]+)<\/p>/g)].map((m) => m[1]);
  const r = await mcp("firecrawl_scrape", { url, formats: ["markdown"], onlyMainContent: true });
  const md = r.payload.data?.markdown ?? ""; noteId(r.payload.data);
  const mdn = norm(md);
  const tFound = titles.filter((t) => mdn.includes(norm(t))).length, pFound = prices.filter((p) => md.includes(p)).length;
  tests.static_catalogue = { url, ms: r.ms, sha256: r.sha256, ...grade([
    c("every title (full, from the link's title)", tFound === titles.length && titles.length === 20, `${tFound}/${titles.length}`),
    c("every price", pFound === prices.length && prices.length === 20, `${pFound}/${prices.length}`),
    c("the result count", /\*\*1000\*\* results/.test(md), /\*\*1000\*\* results/.test(md)),
    c("the next-page link", md.includes("catalogue/page-2.html"), md.includes("catalogue/page-2.html")),
    c("no site navigation (category sidebar) in main content", !md.includes("Historical Fiction"), md.includes("Historical Fiction") ? "sidebar present" : "absent"),
    c("status 200 reported", r.payload.data?.metadata?.statusCode === 200, r.payload.data?.metadata?.statusCode),
    c("answered within 15 s", r.ms < 15000, r.ms),
  ]) };
}

// T2: a page whose content a script writes from inline data, default options (no actions, no wait).
{
  const url = "https://quotes.toscrape.com/js/";
  const gt = (await direct(url)).text;
  const data = JSON.parse(/var data = (\[[\s\S]*?\]);\s*\n\s*for/.exec(gt)[1]);
  const r = await mcp("firecrawl_scrape", { url, formats: ["markdown"], onlyMainContent: true });
  const md = norm(r.payload.data?.markdown ?? ""); noteId(r.payload.data);
  const q = data.filter((d) => md.includes(norm(d.text))).length;
  const a = data.filter((d) => md.includes(norm(d.author.name))).length;
  const t = data.filter((d) => d.tags.every((tag) => md.includes(tag))).length;
  const w = await mcp("firecrawl_scrape", { url, formats: ["markdown"], waitFor: 1000 });
  const wmd = norm(w.payload.data?.markdown ?? ""); noteId(w.payload.data);
  const act = await mcp("firecrawl_scrape", { url, formats: ["markdown"], actions: [{ type: "wait", selector: ".quote" }] });
  noteId(act.payload.data);
  tests.js_rendered = { url, ms: r.ms, sha256: r.sha256, ground_truth_static_quotes: (gt.match(/class="quote"/g) ?? []).length, ...grade([
    c("every quote, with default options", q === 10, `${q}/10`),
    c("every author", a === 10, `${a}/10`),
    c("every quote's tags", t === 10, `${t}/10`),
    c("waitFor answers the rendered page too", data.every((d) => wmd.includes(norm(d.text))), `${data.filter((d) => wmd.includes(norm(d.text))).length}/10`),
    c("an actions scrape carries no advice to use the /interact endpoint", !/\/interact/.test(JSON.stringify(act.payload)), JSON.stringify(act.payload.data?.warning ?? null)),
    c("answered within 30 s", r.ms < 30000, r.ms),
  ]) };
}

// T3: a large real-world article.
{
  const url = "https://en.wikipedia.org/wiki/Raspberry_Pi";
  const gt = (await direct(url)).text.split('id="mw-content-text"')[1];
  const h2 = [...gt.matchAll(/<h2[^>]*>(.*?)<\/h2>/gs)].map((m) => unescape(m[1].replace(/<[^>]+>/g, "")).trim());
  const h3n = (gt.match(/<h3[ >]/g) ?? []).length, tables = (gt.match(/class="wikitable/g) ?? []).length + (/class="infobox/.test(gt) ? 1 : 0);
  const r = await mcp("firecrawl_scrape", { url, formats: ["markdown"], onlyMainContent: true });
  const md = r.payload.data?.markdown ?? ""; noteId(r.payload.data);
  const lines = md.split("\n");
  const mdH2 = lines.map((l, i) => (/^-{3,}\s*$/.test(l) && i > 0 && lines[i - 1].trim() ? lines[i - 1].trim() : /^## /.test(l) ? l.slice(3).trim() : null)).filter(Boolean).map(norm);
  const h2Found = h2.filter((h) => mdH2.some((x) => x.includes(norm(h)))).length;
  const h3Found = lines.filter((l) => /^### (?!#)/.test(l)).length;
  const mdTables = lines.filter((l) => /^\|(\s*:?-{2,}:?\s*\|)+\s*$/.test(l)).length;
  const facts = ["Cortex-A76", "BCM2712", "Eben Upton", "RP2040", "Raspberry Pi OS", "Raspberry Pi Foundation"];
  const inPage = (md.match(/\]\(https:\/\/en\.wikipedia\.org\/wiki\/Raspberry_Pi#/g) ?? []).length;
  const linkShare = md.length ? (md.match(/\]\([^)]*\)/g) ?? []).join("").length / md.length : 1;
  tests.real_world_article = { url, ms: r.ms, sha256: r.sha256, markdown_bytes: Buffer.byteLength(md), truncated: r.payload.truncated ?? null, link_markup_share: Number(linkShare.toFixed(3)), ...grade([
    c("every h2 section, the last ones included", h2Found === h2.length, `${h2Found}/${h2.length}`),
    c("every h3 subsection", h3Found >= h3n, `${h3Found}/${h3n}`),
    c("every table (data tables and the infobox)", mdTables >= tables, `${mdTables}/${tables}`),
    c("the article's key facts", facts.every((f) => md.includes(f)), facts.filter((f) => md.includes(f)).length + "/" + facts.length),
    c("the whole article in one answer (nothing cut)", !r.payload.truncated, r.payload.truncated ? JSON.stringify(r.payload.truncated.fields) : "complete"),
    c("no in-page anchor links", inPage === 0, inPage),
    c("link markup under half of the markdown", linkShare < 0.5, linkShare.toFixed(3)),
    c("answered within 30 s", r.ms < 30000, r.ms),
  ]) };
}

// T4: search.
{
  const query = "Raspberry Pi 5 specifications RAM CPU", limit = 8;
  const r = await mcp("firecrawl_search", { query, limit });
  const web = r.payload.data?.web ?? [];
  // "Raspberry Pi 5", "Pi 5", "RPi5" and the official "raspberrypi/5" path all name the board.
  const relevant = web.filter((w) => /raspberry\s*pi\s*5|\br?pi\s*5\b|raspberrypi\/5\b/i.test(`${w.title} ${w.description} ${w.url}`)).length;
  const official = web.slice(0, 3).some((w) => /(^|\.)raspberrypi\.com$/.test(new URL(w.url).hostname));
  tests.search = { query, ms: r.ms, sha256: r.sha256, results: web.map((w) => w.url), warning: r.payload.warning ?? null, ...grade([
    c("as many results as asked", web.length === limit, `${web.length}/${limit}`),
    c("at least seven of eight about the Raspberry Pi 5", relevant >= 7, `${relevant}/${web.length}`),
    c("an official raspberrypi.com source in the top three", official, official),
    c("no duplicate URLs", new Set(web.map((w) => w.url)).size === web.length, new Set(web.map((w) => w.url)).size),
    c("every engine answered", !r.payload.warning, r.payload.warning ?? "none"),
    c("answered within 20 s", r.ms < 20000, r.ms),
  ]) };
}

// T5, T6: map, with a sitemap and without one.
{
  const url = "https://docs.astral.sh/uv/";
  const sm = [...(await direct("https://docs.astral.sh/uv/sitemap.xml")).text.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1].replace(/\/$/, ""));
  const r = await mcp("firecrawl_map", { url });
  const got = new Set((r.payload.links ?? []).map((l) => l.url.replace(/\/$/, "")));
  const covered = sm.filter((u) => got.has(u)).length, off = [...got].filter((u) => new URL(u).hostname !== "docs.astral.sh").length;
  tests.map_with_sitemap = { url, ms: r.ms, sha256: r.sha256, sources: r.payload.fcpi?.sources ?? null, ...grade([
    c("every sitemap URL", covered === sm.length && sm.length > 0, `${covered}/${sm.length}`),
    c("nothing off the site", off === 0, off),
    c("says where its links came from", !!r.payload.fcpi?.sources, JSON.stringify(r.payload.fcpi?.sources ?? null)),
    c("answered within 30 s", r.ms < 30000, r.ms),
  ]) };
}
{
  const url = "https://books.toscrape.com/";
  const page = (await direct(url)).text;
  const base = new URL(url);
  const truth = new Set([...page.matchAll(/href="([^"#]+)"/g)].map((m) => { try { return new URL(m[1], base); } catch { return null; } })
    .filter((u) => u && u.hostname === base.hostname && /^https?:$/.test(u.protocol) && !/\.(css|js|ico|png|jpg)$/.test(u.pathname)).map((u) => (u.search = "", u.href.replace(/\/$/, ""))));
  const r = await mcp("firecrawl_map", { url });
  const got = new Set((r.payload.links ?? []).map((l) => l.url.replace(/\/$/, "")));
  const covered = [...truth].filter((u) => got.has(u)).length, off = [...got].filter((u) => new URL(u).hostname !== base.hostname).length;
  tests.map_without_sitemap = { url, ms: r.ms, sha256: r.sha256, sources: r.payload.fcpi?.sources ?? null, links: got.size, ...grade([
    c("every same-site link the start page carries", covered === truth.size && truth.size > 50, `${covered}/${truth.size}`),
    c("nothing off the site", off === 0, off),
    c("says the links came from the start page, and that a crawl finds the rest", r.payload.fcpi?.sources?.page > 0 && /crawl/i.test(r.payload.fcpi?.note ?? ""), JSON.stringify(r.payload.fcpi ?? null)),
    c("answered within 30 s", r.ms < 30000, r.ms),
  ]) };
}

// T7: a crawl past the old 20-page bulk threshold: a category's every product page, on the home connection.
async function crawl(args, label) {
  const s = await mcp("firecrawl_crawl", args);
  if (s.isError) return { submit: s.payload };
  const id = s.payload.id;
  let st;
  for (const until = Date.now() + 25 * 60e3; Date.now() < until; ) {
    st = await mcp("firecrawl_check_crawl_status", { id, limit: 20 });
    // Finished when the job's own state is final, not when the core first says completed (it may still be archiving).
    if (!st.isError && ["SUCCEEDED", "PARTIAL", "FAILED", "CANCELLED"].includes(st.payload.fcpi?.state)) break;
    await new Promise((r) => setTimeout(r, 5000));
  }
  const docs = [...(st.payload.data ?? [])];
  for (let skip = st.payload.nextSkip; skip !== null && skip !== undefined; ) {
    const p = await mcp("firecrawl_check_crawl_status", { id, skip, limit: 20 });
    docs.push(...(p.payload.data ?? [])); skip = p.payload.nextSkip;
  }
  docs.forEach(noteId);
  return { id, status: st.payload, docs, label };
}
{
  const url = "https://books.toscrape.com/catalogue/category/books/mystery_3/index.html";
  const cat = (await direct(url)).text;
  const products = new Set([...cat.matchAll(/<h3><a href="([^"]+)"/g)].map((m) => new URL(m[1], url).href));
  const truthPages = new Set([url, ...products, "https://books.toscrape.com/catalogue/category/books/mystery_3/page-2.html"]);
  const r = await crawl({ url, limit: 60, maxDiscoveryDepth: 2, crawlEntireDomain: true, includePaths: ["^/catalogue/[^/]+_\\d+/index\\.html$", "^/catalogue/category/books/mystery_3/"], scrapeOptions: { formats: ["markdown"], onlyMainContent: true } }, "mystery");
  const got = new Set((r.docs ?? []).map((d) => d.metadata?.sourceURL ?? d.metadata?.url));
  const page2 = await direct("https://books.toscrape.com/catalogue/category/books/mystery_3/page-2.html");
  for (const m of page2.text.matchAll(/<h3><a href="([^"]+)"/g)) truthPages.add(new URL(m[1], "https://books.toscrape.com/catalogue/category/books/mystery_3/page-2.html").href);
  const covered = [...truthPages].filter((u) => got.has(u)).length;
  tests.crawl_beyond_old_threshold = { url, job: r.id ?? null, expected_pages: truthPages.size, fcpi: r.status?.fcpi ?? null, ...grade([
    c("admitted without the residential route (more than 20 pages)", !!r.id, r.id ? "admitted" : JSON.stringify(r.submit)),
    c("every page of the category, both listing pages and every product", covered === truthPages.size, `${covered}/${truthPages.size}`),
    c("the outcome says SUCCEEDED with nothing failed", r.status?.fcpi?.state === "SUCCEEDED" && r.status?.fcpi?.failed === 0, JSON.stringify(r.status?.fcpi ?? null)),
    c("no -1 credits shown", !("creditsUsed" in (r.status ?? {})) || r.status.creditsUsed >= 0, r.status?.creditsUsed ?? "omitted"),
  ]) };
}

// T8: a batch with a page that cannot be had: the outcome names it and why.
{
  const urls = ["https://books.toscrape.com/catalogue/page-3.html", "https://books.toscrape.com:8080/catalogue/page-3.html"];
  const s = await mcp("firecrawl_batch_scrape", { urls, formats: ["markdown"] });
  let st = null;
  if (!s.isError) {
    for (const until = Date.now() + 10 * 60e3; Date.now() < until; ) {
      st = await mcp("firecrawl_batch_status", { id: s.payload.id });
      if (!st.isError && ["SUCCEEDED", "PARTIAL", "FAILED", "CANCELLED"].includes(st.payload.fcpi?.state)) break;
      await new Promise((r) => setTimeout(r, 4000));
    }
    (st?.payload.data ?? []).forEach(noteId);
  }
  const o = st?.payload.fcpi;
  const f = o?.failures?.[0];
  tests.failure_honesty = { urls, job: s.payload.id ?? null, submit: s.isError ? s.payload : null, fcpi: o ?? null, ...grade([
    c("the good page is served", (st?.payload.data ?? []).length === 1, (st?.payload.data ?? []).length),
    c("the outcome is PARTIAL with one page failed", o?.state === "PARTIAL" && o?.failed === 1, JSON.stringify(o ?? null)),
    c("the failure names its class, a detail and the URL", !!f?.class && !!f?.detail && f?.urls?.[0] === urls[1], JSON.stringify(f ?? null)),
  ]) };
}

// T9, T10 (--paid): the residential route when asked for, and the fallback search engine when the home connection's
// engine answers too few, each metered against the approved budget.
if (PAID) {
  const url = "https://books.toscrape.com/catalogue/page-4.html";
  const gt = (await direct(url)).text;
  const titles = [...gt.matchAll(/<h3><a href="[^"]+" title="([^"]+)"/g)].map((m) => unescape(m[1]));
  const r = await mcp("firecrawl_scrape", { url, formats: ["markdown"], proxy: "stealth" });
  noteId(r.payload.data);
  const md = norm(r.payload.data?.markdown ?? "");
  tests.residential_route = { url, ms: r.ms, proxyUsed: r.payload.data?.metadata?.proxyUsed ?? null, error: r.isError ? r.payload : null, titles: `${titles.filter((t) => md.includes(norm(t))).length}/${titles.length}` };
  // The fallback search engine is tested only while the policy names one (deploy/policies/egress.json).
  const fallbackEngines = JSON.parse(readFileSync(join(ROOT, "deploy/policies/egress.json"), "utf8")).search.fallbackEngines.live;
  if (fallbackEngines.length) {
    const query = `fcpi residential fallback probe ${Date.now().toString(36)} zqxvw`;
    const q = await mcp("firecrawl_search", { query, limit: 5 });
    tests.search_fallback = { query, ms: q.ms, results: (q.payload.data?.web ?? []).length, warning: q.payload.warning ?? null, error: q.isError ? q.payload : null };
  } else tests.search_fallback_configured = { engines: [], note: "no live fallback engine is configured, so none is tested" };
}

// Each page's acquisition record, from the retrieval service's log.
const since = Math.floor(started.getTime() / 1000) - 5;
const logs = ssh(`sudo -n docker logs --since ${since} fcpi-retrieval-service-1 2>&1 | grep -E '"event":"(acquisition|fetch)"' || true`).split("\n").filter(Boolean).map((l) => { try { return JSON.parse(l.slice(l.indexOf("{"))); } catch { return null; } }).filter(Boolean);
const acq = logs.filter((l) => l.event === "acquisition"), fetches = logs.filter((l) => l.event === "fetch");
if (PAID) {
  const raw = ssh(`sudo -n docker logs --since ${Math.floor(started.getTime() / 1000) - 5} fcpi-retrieval-service-1 2>&1 | grep -E '"event":"(search|proxy_tunnel_closed)"' || true`).split("\n").filter(Boolean).map((l) => { try { return JSON.parse(l.slice(l.indexOf("{"))); } catch { return null; } }).filter(Boolean);
  const searches = raw.filter((l) => l.event === "search" && l.fallback === true);
  const brave = raw.filter((l) => l.event === "proxy_tunnel_closed" && l.target_host === "search.brave.com" && l.route === "residential");
  const after = await proxyLedger();
  const spent = { day: (after.day ?? 0) - (ledgerBefore.day ?? 0), month: (after.month ?? 0) - (ledgerBefore.month ?? 0) };
  const stealth = acq.find((l) => (l.strategies ?? []).some((x) => x.startsWith("residential")));
  Object.assign(tests.residential_route, { spent_micro_usd: spent, ...grade([
    c("the stealth page took the residential route", JSON.stringify(stealth?.strategies) === '["residential_http"]', JSON.stringify(stealth?.strategies ?? null)),
    c("its content is every title on the page", tests.residential_route.titles === "20/20", tests.residential_route.titles),
    c("its spend was metered into the proxy ledger", (stealth?.proxy_micro_usd ?? 0) > 0 && spent.day > 0, `${stealth?.proxy_micro_usd ?? 0} micro-USD; ledger day +${spent.day}`),
  ]) });
  if (tests.search_fallback) Object.assign(tests.search_fallback, { searches_with_fallback: searches.length, brave_tunnels: brave.map((b) => ({ out: b.bytes_out, in: b.bytes_in })), ...grade([
    c("the home connection's engine answered too few, so the fallback was asked", searches.length >= 1, searches.map((x) => x.outcome).join(",") || "none"),
    c("Brave answered through the residential route", brave.some((b) => b.bytes_in > 0) && !(searches[0]?.unresponsive > 0), JSON.stringify(brave.map((b) => b.bytes_in))),
    c("the search answered without an error", !tests.search_fallback.error, JSON.stringify(tests.search_fallback.error ?? "no error")),
  ]) });
}
const mine = acq.filter((l) => scrapeIds.has(l.logical_id));
const spend = logs.reduce((n, l) => n + (l.proxy_micro_usd ?? 0), 0);
const byId = Object.fromEntries(mine.map((l) => [l.logical_id, { strategies: l.strategies, route: l.route_reason, escalations: l.escalations, verdict: l.verdict, failure: l.failure, ms: l.ms, proxy_micro_usd: l.proxy_micro_usd }]));
const residential = acq.filter((l) => (l.strategies ?? []).some((s) => s.startsWith("residential")));
const wanted = PAID ? 1 : 0; // the stealth page; search tunnels are not acquisitions
tests.home_connection_first = { acquisitions_in_window: acq.length, matched_to_answers: mine.length, fetches_in_window: fetches.length, proxy_micro_usd: spend, residential_acquisitions: residential.length, ...grade([
  c("the log was read (positive control: every answer's scrapeId found)", mine.length > 0 && mine.length >= scrapeIds.size - 1, `${mine.length}/${scrapeIds.size}`),
  c(PAID ? "only the stealth page took the residential route" : "every acquisition stayed on the home connection", residential.length === wanted, residential.length),
  c(PAID ? "only the stealth page's acquisition spent" : "nothing was spent", PAID ? spend > 0 && acq.filter((l) => (l.proxy_micro_usd ?? 0) > 0).length === 1 : spend === 0, spend),
  c("the JS page was rendered in the browser after its HTTP shell", Object.values(byId).some((x) => JSON.stringify(x.strategies) === '["direct_http","direct_browser"]'), "see acquisitions"),
  c("a waitFor page started in the browser", Object.values(byId).some((x) => (x.escalations ?? []).includes("wait_for")), "see acquisitions"),
]) };

const out = { schema: "fcpi.retrieval-quality-grade/v1", utc: started.toISOString(), finished: new Date().toISOString(), source_commit: git("rev-parse", "HEAD"),
  code_dirty: git("status", "--porcelain", "--", "services", "deploy", "scripts", "tests") !== "", deployed_commit: ssh("cat /opt/firecrawl-pi/.fcpi-source-commit").trim(),
  endpoint: "https://<pi-tailnet-host>:8443/mcp", protocol: MODERN, paid: PAID, tests, acquisitions: byId,
  summary: Object.fromEntries(Object.entries(tests).filter(([, v]) => v.grade).map(([k, v]) => [k, v.grade])),
  not_graded: Object.entries(tests).filter(([, v]) => !v.grade).map(([k, v]) => ({ test: k, note: v.note ?? null })) };
const dir = join(ROOT, "evidence/post-m9/retrieval-quality");
mkdirSync(dir, { recursive: true });
const file = join(dir, `grade-${out.utc.replace(/[:.]/g, "").replace("Z", "Z")}.json`);
writeFileSync(file, JSON.stringify(out, null, 2) + "\n");
console.log(JSON.stringify(out.summary, null, 1));
console.log(`wrote ${file.slice(ROOT.length + 1)}`);
