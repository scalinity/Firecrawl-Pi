// FCPI browser worker (FIRECRAWL_PI_SPEC.md §12): bounded Chromium execution and nothing else.
//   - one Chromium process, warm, with one context and one page at a time; recycled after 50
//     pages or 30 minutes; a context never outlives its deadline or 120 s;
//   - the sandbox is on (chromiumSandbox) under deploy/browser/seccomp.json, never --no-sandbox;
//   - every request leaves through the retrieval service's proxy under the attempt's credential
//     (the network is internal; there is no other route); media and service workers are blocked,
//     subresources are counted and capped per page;
//   - a context that does not close within 5 s, or a browser that dies, has its process tree
//     killed and the browser relaunched before the next render;
//   - M7: a render may carry a screenshot and the finite action subset (runHooks), served only while
//     PI_BROWSER_EXTRAS_ENABLED is true; a context still never outlives the render's deadline.
// POST /render (bearer credential of the retrieval service, compared by SHA-256), GET /healthz.
import http from "node:http";
import { readFileSync, readdirSync } from "node:fs";
import { createHash, timingSafeEqual } from "node:crypto";
import { chromium } from "playwright-core";

const KNOWN = new Set(["PI_BROWSER_LISTEN", "PI_CREDENTIALS_DIR", "PI_BROWSER_EXTRAS_ENABLED", "PI_BROWSER_RECYCLE_PAGES", "PI_BROWSER_RECYCLE_MS"]);
const unknown = Object.keys(process.env).filter((k) => k.startsWith("PI_") && !KNOWN.has(k));
if (unknown.length) throw new Error(`unknown configuration keys: ${unknown.join(", ")}`);
const [LISTEN_HOST, LISTEN_PORT] = (process.env.PI_BROWSER_LISTEN ?? "").split(":");
if (!LISTEN_HOST || !LISTEN_PORT) throw new Error("PI_BROWSER_LISTEN must be ip:port");
const EXTRAS = process.env.PI_BROWSER_EXTRAS_ENABLED === "true";
const RECYCLE_PAGES = Number(process.env.PI_BROWSER_RECYCLE_PAGES ?? 50);
const RECYCLE_MS = Number(process.env.PI_BROWSER_RECYCLE_MS ?? 30 * 60 * 1000);
const CLOSE_GRACE_MS = 5000;
const CONTEXT_MAX_MS = 120000;
// A rendered document is bounded like a direct body (25 MiB): a script can build any DOM without
// touching the network, so the proxy's byte count alone does not limit it.
const HTML_MAX_CHARS = 25 * 1024 * 1024;
// A hash of the wrong length would make timingSafeEqual throw on every request: fail at startup.
const tokenHex = readFileSync(`${process.env.PI_CREDENTIALS_DIR}/browser_token_sha256`, "utf8").trim().replace(/^sha256:/, "");
if (!/^[0-9a-f]{64}$/i.test(tokenHex)) throw new Error("browser_token_sha256 is not a SHA-256 hex digest");
const tokenHash = Buffer.from(tokenHex, "hex");
const BUILD = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version;
const log = (o) => console.log(JSON.stringify({ utc: new Date().toISOString(), service: "browser", build: BUILD, ...o }));

let browser = null, launchedAt = 0, pagesServed = 0, busy = false, launches = 0;

async function launch() {
  const t = Date.now();
  const b = await chromium.launch({
    headless: true,
    chromiumSandbox: true,
    // Each context names its own proxy (the attempt's credential); Chromium needs a launch-level
    // placeholder for that, which no request ever uses.
    proxy: { server: "http://per-context" },
    args: ["--force-webrtc-ip-handling-policy=disable_non_proxied_udp", "--webrtc-ip-handling-policy=disable_non_proxied_udp"],
    timeout: 30000,
  });
  browser = b;
  launchedAt = Date.now(); pagesServed = 0; launches++;
  // Only this instance's own disconnect clears it: a retired browser that disconnects late must not
  // clear its successor (review finding W12).
  b.on("disconnected", () => { log({ event: "browser_disconnected" }); if (browser === b) browser = null; });
  log({ event: "browser_launched", version: b.version(), ms: Date.now() - t, launches });
}

// Every Chromium process in this container is this worker's; after a failed close or a crash they
// are killed outright, so no stale renderer keeps memory or a socket.
function killStrays() {
  let n = 0;
  for (const pid of readdirSync("/proc").filter((d) => /^\d+$/.test(d))) {
    try {
      const cmd = readFileSync(`/proc/${pid}/cmdline`, "utf8");
      if (/chrome-headless-shell|chrome-linux-arm64\/chrome/.test(cmd)) { process.kill(Number(pid), "SIGKILL"); n++; }
    } catch { /* already gone */ }
  }
  return n;
}

async function retire(reason) {
  const b = browser;
  browser = null;
  if (b) await Promise.race([b.close().catch(() => {}), new Promise((r) => setTimeout(r, CLOSE_GRACE_MS))]);
  const killed = killStrays();
  log({ event: "browser_retired", reason, killed });
}

async function ensureBrowser() {
  if (browser && (pagesServed >= RECYCLE_PAGES || Date.now() - launchedAt >= RECYCLE_MS)) await retire("recycle");
  if (!browser) await launch();
}

// The page is settled when its visible text has stopped changing for a second, or when the
// budget runs out; a delayed client render is therefore captured, a static page costs one second.
async function settle(page, budgetMs) {
  const until = Date.now() + budgetMs;
  await page.waitForLoadState("networkidle", { timeout: Math.max(Math.min(5000, until - Date.now()), 1) }).catch(() => {});
  let last = -1, stableSince = Date.now();
  while (Date.now() < until) {
    const len = await page.evaluate(() => (document.body?.innerText ?? "").length).catch(() => -1);
    if (len !== last) { last = len; stableSince = Date.now(); }
    else if (Date.now() - stableSince >= 1000) return;
    await new Promise((r) => setTimeout(r, 250));
  }
}

// M7: the action subset (spec §12), run in order after the page settles, then the screenshot the formats asked for. The
// retrieval service has already held the list to the subset (wait for milliseconds or a selector, click, scroll,
// screenshot, scrape), at most ten, with at most 15 s of explicit waiting; this refuses anything else again and bounds
// every step by the render's deadline. A step that cannot be done (a selector that never appears, a click with nothing
// to click) fails the render as ACTION_FAILED. Captures hold at most EXTRAS_MAX_BYTES in all, content captures at most
// the page's own limit. Returns { screenshot, actions: { screenshots, scrapes } }.
const EXTRAS_MAX_BYTES = 16 * 1024 * 1024;
const SELECTOR_WAIT_MS = 5000;
async function runHooks(page, hooks, deadline, maxHtml, startHost) {
  const out = { screenshot: null, actions: { screenshots: [], scrapes: [] } };
  const fail = (cls, why) => Object.assign(new Error(why), { failureClass: cls });
  let captured = 0, scraped = 0;
  const left = () => { const ms = deadline - Date.now() - 1000; if (ms <= 0) throw fail("TIMEOUT", "the render's deadline came during its actions"); return ms; };
  const shot = async (fullPage) => {
    const c = await capture(page, fullPage, Math.min(left(), 10000));
    captured += c.bytes;
    if (captured > EXTRAS_MAX_BYTES) throw fail("RESOURCE_LIMIT", `the render's captures exceed ${EXTRAS_MAX_BYTES} bytes`);
    return c;
  };
  const actions = hooks?.actions ?? [];
  if (actions.length > 10) throw fail("UNSUPPORTED_CAPABILITY", "more than 10 actions");
  for (const [i, a] of actions.entries()) {
    try {
      if (a.type === "wait" && typeof a.selector === "string") await page.waitForSelector(a.selector, { state: "attached", timeout: Math.min(SELECTOR_WAIT_MS, left()) });
      else if (a.type === "wait") await page.waitForTimeout(Math.min(Number(a.milliseconds) || 0, 15000, left()));
      else if (a.type === "click") {
        await page.click(String(a.selector), { timeout: Math.min(5000, left()) });
        // A click that navigates on this host is let load before the next step. One that would take the page to another
        // host is refused by the route, which leaves Chromium on its own error page: the action failed, and says so.
        await page.waitForLoadState("load", { timeout: Math.min(5000, left()) }).catch(() => {});
        let host = null;
        try { host = new URL(page.url()).host; } catch { /* not a URL */ }
        if (host !== startHost) throw fail("ACTION_FAILED", `action ${i + 1} (click) tried to take the page to another host, which is refused`);
      } else if (a.type === "scroll") {
        const dy = a.direction === "up" ? -800 : 800;
        if (typeof a.selector === "string") await page.locator(a.selector).first().evaluate((el, d) => el.scrollBy(0, d), dy, { timeout: Math.min(5000, left()) });
        else await page.mouse.wheel(0, dy);
        await page.waitForTimeout(Math.min(250, left())); // the page's own scroll handlers run
      } else if (a.type === "screenshot") out.actions.screenshots.push(await shot(a.fullPage === true));
      else if (a.type === "scrape") {
        const html = await page.content();
        scraped += html.length;
        if (scraped > maxHtml) throw fail("SIZE_LIMIT", `the render's content captures exceed ${maxHtml} characters`);
        out.actions.scrapes.push({ url: page.url(), html });
      } else throw fail("UNSUPPORTED_CAPABILITY", `action ${String(a.type).slice(0, 40)}`);
    } catch (e) {
      if (e.failureClass) throw e;
      if (/Target (page|closed)|has been closed/i.test(e.message)) throw e; // the deadline or the caller closed the context
      throw fail("ACTION_FAILED", `action ${i + 1} (${a.type}) could not be done: ${String(e.message).split("\n")[0].slice(0, 200)}`);
    }
  }
  if (hooks?.screenshot) out.screenshot = await shot(hooks.screenshot.fullPage === true);
  return out;
}

// A PNG of the viewport, or of the full page up to 20,000 px high, at most 10 MiB (spec §12). A full-page capture of a
// taller page is clipped at 20,000 px and says so (truncated); it is never passed off as the whole page.
async function capture(page, fullPage, timeout) {
  const viewport = page.viewportSize();
  const pageHeight = await page.evaluate(() => Math.max(document.documentElement.scrollHeight, document.body?.scrollHeight ?? 0));
  const height = fullPage ? Math.max(1, Math.min(pageHeight, 20000)) : viewport.height;
  const buf = fullPage
    ? await page.screenshot({ type: "png", fullPage: true, clip: { x: 0, y: 0, width: viewport.width, height }, timeout })
    : await page.screenshot({ type: "png", timeout });
  if (buf.length > 10 * 1024 * 1024) throw Object.assign(new Error("a screenshot exceeds 10 MiB"), { failureClass: "RESOURCE_LIMIT" });
  return { mime: "image/png", width: viewport.width, height, truncated: fullPage && pageHeight > 20000, bytes: buf.length, base64: buf.toString("base64") };
}

// signal: aborted when the retrieval service stops waiting (its caller went away); the render then
// ends at once, through the same close-or-retire path as a deadline.
async function render(r, signal) {
  const started = Date.now();
  const deadline = started + Math.min(Number(r.deadlineMs) || 0, r.limits?.contextMaxMs ?? CONTEXT_MAX_MS, CONTEXT_MAX_MS);
  const wantsExtras = !!r.hooks?.screenshot || (r.hooks?.actions ?? []).length > 0;
  if (wantsExtras && !EXTRAS) return { ok: false, failure: { class: "UNSUPPORTED_CAPABILITY", detail: "screenshots and actions are not enabled in this release" } };
  const maxSub = Math.min(Number(r.limits?.maxSubresources) || 200, 200);
  await ensureBrowser();
  const counters = { requests: 0, blocked: 0, overLimit: 0, offHost: 0 };
  // The render starts where the direct attempt's paced chain ended; the main frame may not move to
  // another host, whose navigation no pacing decision covered (review finding C4).
  const startHost = new URL(r.url).host;
  const context = await browser.newContext({
    proxy: { server: r.proxy.server, username: r.proxy.username, password: r.proxy.password },
    userAgent: r.userAgent, viewport: { width: 1280, height: 800 }, serviceWorkers: "block", acceptDownloads: false,
    ignoreHTTPSErrors: false, javaScriptEnabled: true, locale: "en-US",
  });
  // A context never outlives its deadline or its caller: past either, the context is closed from
  // here, and past the grace period the whole browser is retired.
  let expired = false, cancelled = false, crashed = false;
  // One close per render, shared by the deadline, the caller's abort and the render's own end: the
  // render does not return (and the worker stays busy) until it, and any retire it needs, has
  // finished, so a late retire cannot kill the next render's browser (review finding W12).
  let closing = null;
  const closeNow = () => (closing ??= (async () => {
    const closed = await Promise.race([context.close().then(() => true, () => true), new Promise((res) => setTimeout(() => res(false), CLOSE_GRACE_MS))]);
    if (!closed) await retire("context did not close");
  })());
  const killer = setTimeout(() => { expired = true; closeNow(); }, Math.max(deadline - Date.now(), 1));
  const onAbort = () => { cancelled = true; clearTimeout(killer); closeNow(); };
  if (signal?.aborted) onAbort(); else signal?.addEventListener("abort", onAbort, { once: true });
  try {
    await context.route("**/*", (route) => {
      const req = route.request();
      counters.requests++;
      let mainFrameNavigation = false;
      try { mainFrameNavigation = req.isNavigationRequest() && !req.frame().parentFrame(); } catch { /* no frame: not a navigation */ }
      if (mainFrameNavigation && new URL(req.url()).host !== startHost) { counters.offHost++; return route.abort("blockedbyclient"); }
      if (req.resourceType() === "media" || !/^https?:$/.test(new URL(req.url()).protocol)) { counters.blocked++; return route.abort("blockedbyclient"); }
      if (counters.requests > maxSub) { counters.overLimit++; return route.abort("blockedbyclient"); }
      return route.continue();
    });
    const page = await context.newPage();
    // A renderer that dies (in this container, usually the cgroup's memory cap) ends the page alone.
    page.on("crash", () => { crashed = true; });
    page.on("dialog", (d) => d.dismiss().catch(() => {}));
    page.on("popup", (p) => p.close().catch(() => {}));
    const navBudget = Math.max(deadline - Date.now() - 1500, 1000);
    const response = await page.goto(r.url, { waitUntil: "load", timeout: navBudget });
    const settleBudget = Math.max(Math.min(deadline - Date.now() - 1000, 8000 + (Number(r.waitForMs) || 0)), 0);
    if (Number(r.waitForMs) > 0) await page.waitForTimeout(Math.min(Number(r.waitForMs), settleBudget));
    await settle(page, Math.max(Math.min(settleBudget, deadline - Date.now() - 1000), 0));
    const maxHtml = Math.min(Number(r.limits?.maxHtmlChars) || HTML_MAX_CHARS, HTML_MAX_CHARS);
    const extras = wantsExtras ? await runHooks(page, r.hooks, deadline, maxHtml, startHost) : { screenshot: null, actions: null };
    const redirects = [];
    for (let q = response?.request().redirectedFrom(); q; q = q.redirectedFrom()) redirects.unshift({ url: q.url() });
    // Measured inside the renderer, in this container's own cgroup, so an oversized document never
    // crosses into the retrieval service or the core (review finding C3).
    const chars = await page.evaluate(() => document.documentElement?.outerHTML.length ?? 0);
    if (chars > maxHtml) return { ok: false, failure: { class: "SIZE_LIMIT", detail: `rendered document of ${chars} characters exceeds ${maxHtml}` }, subresources: counters, timings: { totalMs: Date.now() - started } };
    const html = await page.content();
    return {
      ok: true, finalUrl: page.url(), status: response?.status() ?? 0, contentType: response?.headers()["content-type"] ?? null, html, redirects,
      subresources: counters, screenshot: extras.screenshot, actions: extras.actions,
      timings: { totalMs: Date.now() - started }, browser: { version: browser?.version() ?? null, pagesServed: pagesServed + 1, launches },
    };
  } catch (e) {
    const cls = e.failureClass ?? (cancelled ? "CANCELLED" : expired ? "TIMEOUT" : browser === null ? "BROWSER_CRASHED" : crashed ? "RENDERER_CRASHED" : /Timeout/i.test(e.name) ? "TIMEOUT" : /net::ERR_/.test(e.message) ? "NAVIGATION_FAILED" : "BROWSER_ERROR");
    // M7: an action that could not be done, or extras past their bounds, will not go better on a second try.
    const final = ["ACTION_FAILED", "UNSUPPORTED_CAPABILITY", "RESOURCE_LIMIT", "SIZE_LIMIT"].includes(cls);
    return { ok: false, failure: { class: cls, detail: String(e.message).split("\n")[0].slice(0, 300), ...(final ? { retryable: false } : {}) }, subresources: counters, timings: { totalMs: Date.now() - started } };
  } finally {
    clearTimeout(killer);
    signal?.removeEventListener("abort", onAbort);
    pagesServed++;
    await closeNow();
  }
}

const send = (res, status, body) => {
  const buf = Buffer.from(JSON.stringify(body));
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "content-length": buf.length }).end(buf);
};
function authorized(req) {
  const m = /^Bearer ([\x21-\x7e]{32,512})$/.exec(req.headers.authorization ?? "");
  return !!m && timingSafeEqual(createHash("sha256").update(m[1]).digest(), tokenHash);
}

http.createServer((req, res) => {
  if (req.method === "GET" && req.url === "/healthz") {
    return send(res, 200, { ok: true, browser: browser ? "up" : "idle", version: browser?.version() ?? null, pagesServed, launches, busy });
  }
  if (req.method !== "POST" || req.url !== "/render") return send(res, 404, { error: "not_found" });
  if (!authorized(req)) return send(res, 401, { error: "unauthorized" });
  // One page at a time: the retrieval service holds the only browser permit, so a second render
  // here means a caller outside that contract.
  if (busy) return send(res, 429, { ok: false, failure: { class: "RESOURCE_BUSY", detail: "a render is in progress" } });
  const chunks = [];
  let n = 0;
  req.on("data", (c) => { n += c.length; if (n > 1024 * 1024) req.destroy(); else chunks.push(c); });
  req.on("end", async () => {
    // Checked and set with no await between, so two requests whose bodies end together cannot
    // both start a render (CWE-362; review finding W5); the check above only rejects early.
    if (busy) return send(res, 429, { ok: false, failure: { class: "RESOURCE_BUSY", detail: "a render is in progress" } });
    busy = true;
    let body;
    try { body = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { busy = false; return send(res, 400, { error: "bad_request" }); }
    if (typeof body.url !== "string" || !body.proxy?.server || !body.proxy?.username || !body.proxy?.password) { busy = false; return send(res, 400, { error: "bad_request" }); }
    const started = Date.now();
    const cancel = new AbortController();
    res.on("close", () => { if (!res.writableFinished) cancel.abort(); });
    try {
      const out = await render(body, cancel.signal);
      log({ event: "render", attempt_id: body.attemptId, ok: out.ok, failure: out.failure?.class ?? null, status: out.status ?? null, requests: out.subresources?.requests ?? 0,
        blocked: out.subresources?.blocked ?? 0, over_limit: out.subresources?.overLimit ?? 0, ms: Date.now() - started, pages_served: pagesServed });
      send(res, 200, out);
    } catch (e) {
      await retire(`render failed: ${e.message}`);
      send(res, 200, { ok: false, failure: { class: "BROWSER_ERROR", detail: String(e.message).split("\n")[0].slice(0, 300) } });
    } finally {
      busy = false;
    }
  });
}).listen(Number(LISTEN_PORT), LISTEN_HOST, () => log({ event: "listening", listen: `${LISTEN_HOST}:${LISTEN_PORT}`, extras: EXTRAS }));

for (const sig of ["SIGTERM", "SIGINT"]) process.on(sig, async () => { await retire("shutdown"); process.exit(0); });
