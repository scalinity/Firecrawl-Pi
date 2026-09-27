// Change detection (FIRECRAWL_PI_SPEC.md §31.3, AC21; M7): POST /platform/v1/changes scrapes a page's markdown through
// the core and compares it with the last successful version this principal saw of the same page under the same
// options. The comparison is of normalized text (each line's whitespace collapsed, blank lines dropped), by hash, with
// a bounded line diff when it changed. Only a successful page with a 2xx status is a version: a challenge, a timeout, a
// parser failure, a login page or an error page is answered as not compared and never replaces the stored version, so
// it can never be reported as a change. This is a comparison the caller asks for, not Firecrawl Cloud Monitor: there
// is no schedule, no semantic analysis and no dashboard.
import { createHash } from "node:crypto";
import { canonical } from "./validate.mjs";

const sha = (s) => createHash("sha256").update(s).digest("hex");
export const DIFF_MAX_LINES = 2000;
export const DIFF_MAX_BYTES = 65536;

export function normalize(markdown) {
  return markdown.split("\n").map((l) => l.replace(/\s+/g, " ").trim()).filter(Boolean).join("\n");
}

// A line diff of two normalized texts, by longest common subsequence: "- " for a removed line, "+ " for an added one,
// "  " for a kept one. Bounded: past DIFF_MAX_LINES lines on either side, only the counts of lines present on one side
// alone are given (a multiset comparison), and the text is cut at DIFF_MAX_BYTES; both say so.
export function lineDiff(before, after) {
  const a = before ? before.split("\n") : [], b = after ? after.split("\n") : [];
  if (a.length > DIFF_MAX_LINES || b.length > DIFF_MAX_LINES) {
    const count = (xs) => xs.reduce((m, x) => m.set(x, (m.get(x) ?? 0) + 1), new Map());
    const ca = count(a), cb = count(b);
    let removed = 0, added = 0;
    for (const [x, n] of ca) removed += Math.max(0, n - (cb.get(x) ?? 0));
    for (const [x, n] of cb) added += Math.max(0, n - (ca.get(x) ?? 0));
    return { text: null, added, removed, truncated: true, reason: `more than ${DIFF_MAX_LINES} lines; counts only` };
  }
  const n = a.length, m = b.length;
  const L = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) L[i][j] = a[i] === b[j] ? L[i + 1][j + 1] + 1 : Math.max(L[i + 1][j], L[i][j + 1]);
  const out = [];
  let i = 0, j = 0, added = 0, removed = 0;
  while (i < n || j < m) {
    if (i < n && j < m && a[i] === b[j]) { out.push(`  ${a[i]}`); i++; j++; }
    else if (j < m && (i >= n || L[i][j + 1] >= L[i + 1][j])) { out.push(`+ ${b[j]}`); j++; added++; }
    else { out.push(`- ${a[i]}`); i++; removed++; }
  }
  let text = out.join("\n"), truncated = false;
  if (Buffer.byteLength(text) > DIFF_MAX_BYTES) { text = Buffer.from(text).subarray(0, DIFF_MAX_BYTES).toString("utf8").replace(/�$/, ""); truncated = true; }
  return { text, added, removed, truncated };
}

// The key a version is kept under: the page and the options that shape its markdown, so only equivalent extractions
// are compared (spec §31.3).
export const versionKey = (body) => sha(canonical({ url: body.url, onlyMainContent: body.onlyMainContent ?? true, waitFor: body.waitFor ?? 0, proxy: body.proxy ?? "auto" }));

export function makeChanges({ cfg, store, upstream, archive, originFor }) {
  return async function changes(ctx, body) {
    const key = versionKey(body);
    const { timeout, ...opts } = body;
    let r;
    try {
      r = await upstream.call("POST", "/v2/scrape", { body: { ...opts, formats: ["markdown"], ...(timeout ? { timeout } : {}), origin: originFor(ctx.client.principal, "changes") },
        timeoutMs: cfg.coreTimeoutMs, maxBytes: 16 * 1048576 });
    } catch (e) {
      // Never 502: that is the core's own answer, which a client library retries by resubmitting.
      return ctx.send(e.code === "TIMEOUT" ? 504 : 503, { success: false, code: e.code === "TIMEOUT" ? "UPSTREAM_TIMEOUT" : "UPSTREAM_UNAVAILABLE", error: "The core did not answer; nothing was compared." }, { "retry-after": "10" });
    }
    const doc = r.status === 200 && r.json?.success === true ? r.json.data : null;
    const status = doc?.metadata?.statusCode ?? null;
    const markdown = typeof doc?.markdown === "string" ? doc.markdown : null;
    // A page with no text (an image or canvas page, or one onlyMainContent emptied) has nothing to compare (review W5).
    const norm = markdown === null ? "" : normalize(markdown);
    if (!doc || !(status >= 200 && status < 300) || !norm) {
      // Not a version: the stored one stays, and nothing is reported as a change.
      const why = !doc ? `the scrape failed (${r.json?.code ?? `HTTP ${r.status}`}: ${String(r.json?.error ?? "").slice(0, 300)})` : !(status >= 200 && status < 300) ? `the page answered ${status}` : markdown === null ? "the page returned no markdown" : "the page returned no text";
      return ctx.send(422, { success: false, code: "NOT_COMPARED", changeStatus: null, url: body.url, error: `No version was taken: ${why}. A failed or error page is never a change event; the previous version is kept.` });
    }
    const nsha = sha(norm);
    const prev = await store.versionGet(ctx.client.principal, key);
    let changeStatus = "new", diff = null;
    if (prev) {
      changeStatus = prev.normalized_sha256 === nsha ? "same" : "changed";
      if (changeStatus === "changed") diff = lineDiff(normalize((await archive.read(prev.sha256)).toString("utf8")), norm);
    }
    const buf = Buffer.from(markdown);
    if (!(await archive.hasRoom(buf.length))) return ctx.send(503, { success: false, code: "STORAGE_QUOTA", error: "The result store is at its free-space floor; the version was not stored." }, { "retry-after": "300" });
    const put = await archive.put(buf);
    await store.versionPut({ principal: ctx.client.principal, key, url: body.url, sha256: put.sha256, bytes: put.bytes, normalizedSha256: nsha });
    ctx.send(200, { success: true, changeStatus, url: body.url, finalUrl: doc.metadata?.url ?? body.url, statusCode: status, contentSha256: nsha,
      previousContentSha256: prev?.normalized_sha256 ?? null, previousScrapeAt: prev ? new Date(prev.scraped_at).toISOString() : null, currentScrapeAt: new Date().toISOString(),
      diff, method: "normalized-content hash and bounded line diff; not Firecrawl Cloud Monitor" });
  };
}
