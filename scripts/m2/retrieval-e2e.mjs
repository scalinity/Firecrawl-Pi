// M2's retrieval cases, run inside the firecrawl-core container by scripts/m2/pi-retrieval-tests.sh
// (docker exec -i … node --input-type=module -). From there it reaches the core's API on loopback,
// as the gateway does, and the retrieval service on fcpi_acquire with the core's own credential
// (read from its secret file, never printed). One JSON line per case: what was asked, what came
// back, and the scrape id the collector joins with the service's attempt rows and logs.
//   GROUP=static|browser|budget|pacing|permits|cancel|paths|ssrf  (comma-separated)
//   LAN_ADDRESS: the host's LAN address, for the one LAN-literal case; recorded only as "lan".
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";

const CORE = "http://127.0.0.1:3002";
const RS = "http://retrieval-service:3310";
const M2 = "http://m2.fixture.fcpi.test:8080";
const TOKEN = readFileSync("/run/secrets/core_retrieval_token", "utf8").trim();
const groups = new Set((process.env.GROUP ?? "").split(",").filter(Boolean));
const out = (o) => console.log(JSON.stringify({ utc: new Date().toISOString(), ...o }));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// Sentinels count only in visible text: a fixture's scripts carry the text they will write.
const visible = (html) => html.replace(/<(script|style|noscript|template)\b[\s\S]*?<\/\1\s*>/gi, " ");

async function scrape(id, url, extra = {}, api = "v2") {
  const t0 = Date.now();
  const body = api === "v2" ? { url, formats: ["markdown"], timeout: 60000, ...extra } : { url, formats: ["markdown"], timeout: 60000, ...extra };
  let r, j = null;
  try {
    r = await fetch(`${CORE}/${api}/scrape`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(150000) });
    j = await r.json().catch(() => null);
  } catch (e) { return out({ case: id, kind: "core", url_label: label(url), error: `client: ${e.message}`, ms: Date.now() - t0 }); }
  const md = j?.data?.markdown ?? "";
  out({ case: id, kind: "core", api, url_label: label(url), http: r.status, success: j?.success ?? null, code: j?.code ?? null,
    error: typeof j?.error === "string" ? j.error.slice(0, 240) : null, statusCode: j?.data?.metadata?.statusCode ?? null,
    scrapeId: j?.data?.metadata?.scrapeId ?? null, sentinels: [...md.matchAll(/fcpi-m[12]-[a-z]+-[0-9a-f]{4}/g)].map((m) => m[0]),
    markdown_chars: md.length, warning: j?.data?.warning ? String(j.data.warning).slice(0, 160) : null, ms: Date.now() - t0 });
}

// The LAN address is an identifier: evidence records the label only.
const label = (url) => (process.env.LAN_ADDRESS && url.includes(process.env.LAN_ADDRESS) ? url.replace(process.env.LAN_ADDRESS, "<lan>") : url);

async function acquire(id, body, { abortAfterMs } = {}) {
  const t0 = Date.now();
  const ac = new AbortController();
  if (abortAfterMs) setTimeout(() => ac.abort(), abortAfterMs);
  const req = { requestId: randomUUID(), deadline: new Date(Date.now() + 85000).toISOString(), purpose: "page", expect: "html", ...body };
  try {
    const r = await fetch(`${RS}/internal/acquire`, { method: "POST", headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" }, body: JSON.stringify(req), signal: ac.signal });
    const j = await r.json();
    const text = visible(j.body ?? "");
    out({ case: id, kind: "rs", url_label: label(req.url), logicalId: req.logicalAcquisitionId, http: r.status, ok: j.ok, attemptsUsed: j.attemptsUsed, strategies: j.strategies,
      targetStatus: j.targetStatus, verdict: j.quality?.verdict ?? null, failure: j.failure?.class ?? null, retryAfter: j.failure?.retryAfter ?? null,
      sentinels: [...text.matchAll(/fcpi-m[12]-[a-z]+-[0-9a-f]{4}/g)].map((m) => m[0]), subresources: j.subresources ?? null,
      proxyDenied: (j.proxyDenied ?? []).map((d) => `${d.class}:${d.host}`), started: new Date(t0).toISOString(), ms: Date.now() - t0 });
    return j;
  } catch (e) {
    out({ case: id, kind: "rs", url_label: label(req.url), logicalId: req.logicalAcquisitionId, aborted: ac.signal.aborted, error: e.name, started: new Date(t0).toISOString(), ms: Date.now() - t0 });
    return null;
  }
}

// ---- cases ------------------------------------------------------------------------------------
if (groups.has("static")) {
  await scrape("C01-static-m1", "http://m1.fixture.fcpi.test:8080/static.html");
  await scrape("C02-short", `${M2}/short.html`);
  await scrape("C05-cookie-redirect", `${M2}/cookie`);
  await scrape("C07-challenge", `${M2}/challenge`);
  await scrape("C08-login-redirect", `${M2}/members`);
  await scrape("C09-401", `${M2}/auth`);
  await scrape("C10-403", `${M2}/forbidden`);
  await scrape("C11-404", `${M2}/status/404`);
  await scrape("C12-503", `${M2}/status/503`);
  await scrape("C13-large", `${M2}/large`);
  await scrape("C14-gzip-bomb", `${M2}/gzip-bomb`);
  await scrape("C15-slow-timeout", `${M2}/slow?ms=40000`, { timeout: 8000 });
  await scrape("C16-chain-3", `${M2}/chain/3`);
  await scrape("C17-chain-12", `${M2}/chain/12`);
  await scrape("C18-pdf", `${M2}/doc.pdf`);
  await scrape("C19-empty", `${M2}/empty`);
  await scrape("C20-429", "http://cool.fixture.fcpi.test:8080/status/429?retry=30");
  await scrape("C21-429-cooldown", "http://cool.fixture.fcpi.test:8080/short.html");
  await scrape("C22-v1-static", `${M2}/short.html`, {}, "v1");
  await scrape("C23-skip-tls-true", `${M2}/short.html`, { skipTlsVerification: true });
  await scrape("C24-screenshot", `${M2}/short.html`, { formats: ["markdown", "screenshot"] });
  await scrape("C25-actions", `${M2}/short.html`, { actions: [{ type: "wait", milliseconds: 100 }] });
  await scrape("C26-stealth", `${M2}/short.html`, { proxy: "stealth" });
}

if (groups.has("ssrf")) {
  const lan = process.env.LAN_ADDRESS;
  for (const [id, url] of [["S01-literal-redis", "http://10.231.1.5:6379/"], ["S02-literal-loopback", "http://127.0.0.1:3002/"], ["S03-literal-ipv6-loopback", "http://[::1]/"],
    ["S04-metadata", "http://169.254.169.254/latest/meta-data/"], ["S05-hex-loopback", "http://0x7f000001/"], ["S06-service-name", "http://nuq-postgres:5432/"],
    ["S07-cloud-api", "https://api.firecrawl.dev/v1/scrape"], ["S08-file-scheme", "file:///etc/passwd"], ["S16-lan-literal", lan ? `http://${lan}/` : "http://lan.invalid/"],
    ["S17-mapped-ipv6", "http://[::ffff:10.231.1.5]/"], ["S18-cgnat-tailnet", "http://100.100.100.100/"]]) await scrape(id, url);
  for (const [id, to] of [["S09-redirect-redis", "http://10.231.1.5:6379/"], ["S10-redirect-metadata", "http://169.254.169.254/latest/meta-data/"],
    ["S11-redirect-cloud", "https://api.firecrawl.dev/v1/scrape"], ["S12-redirect-loopback", "http://127.0.0.1:3002/"], ["S13-redirect-mapped", "http://[::ffff:10.231.1.5]/"],
    ["S14-redirect-name", "http://redis:6379/"], ["S19-redirect-lan", lan ? `http://${lan}/` : "http://lan.invalid/"]]) {
    await scrape(id, `${M2}/redirect?to=${encodeURIComponent(to)}`);
  }
  // The same targets asked of the retrieval service directly, since the core refuses several of the
  // literals above with its own URL check before they reach it, plus the IPv6, numeric and
  // single-label forms. SR00 is the positive control: a permitted fixture page, asked the same way.
  await acquire("SR00-control", { logicalAcquisitionId: `m2-ssrf-${randomUUID()}`, url: `${M2}/short.html?ssrf=control` });
  for (const [id, url] of [["SR01-redis", "http://10.231.1.5:6379/"], ["SR02-loopback", "http://127.0.0.1:3002/"], ["SR03-ipv6-loopback", "http://[::1]/"],
    ["SR04-hex-loopback", "http://0x7f000001/"], ["SR05-decimal-loopback", "http://2130706433/"], ["SR06-unspecified", "http://0.0.0.0/"],
    ["SR07-ipv6-ula", "http://[fd00::1]/"], ["SR08-ipv6-link-local", "http://[fe80::1]/"], ["SR09-mapped-ipv6", "http://[::ffff:10.231.1.5]/"],
    ["SR10-nat64-private", "http://[64:ff9b::a00:1]/"], ["SR11-service-name", "http://nuq-postgres:5432/"], ["SR12-single-label", "http://redis/"],
    ["SR13-localhost", "http://localhost/"], ["SR14-private-port-80", "http://10.231.1.5/"], ["SR15-file-scheme", "file:///etc/passwd"],
    ["SR16-lan-literal", lan ? `http://${lan}/` : "http://lan.invalid/"], ["SR17-metadata", "http://169.254.169.254/latest/meta-data/"],
    ["SR18-cloud-api", "https://api.firecrawl.dev/v1/scrape"]]) await acquire(id, { logicalAcquisitionId: `m2-ssrf-${randomUUID()}`, url });
}

if (groups.has("browser")) {
  await scrape("C03-js", `${M2}/js.html`);
  await scrape("C04-delayed", `${M2}/delayed.html`);
  await scrape("C06-cookie-js", `${M2}/cookie-js`);
  // Content written 20 s after load: still a shell when the render settles, so no content.
  await scrape("C27-js-late", `${M2}/js-slow.html`);
  // Short, and image-led, pages that carry a script: rendered once, and returned as the page.
  await scrape("C28-short-scripted", `${M2}/short-scripted.html`);
  await scrape("C29-gallery", `${M2}/gallery.html`);
  await scrape("S15-subresources", `${M2}/subresources.html`);
  // The same page asked of the service directly, which returns each refused subresource by host.
  await acquire("S15b-subresources-direct", { logicalAcquisitionId: `m2-subres-${randomUUID()}`, url: `${M2}/subresources.html?direct=1` });
}

if (groups.has("browser-down")) {
  // With the browser worker stopped: static retrieval continues, a JS page fails as its own tier.
  await scrape("I01-static-browser-down", `${M2}/short.html`);
  await scrape("I02-js-browser-down", `${M2}/js.html`, { timeout: 45000 });
}

if (groups.has("budget")) {
  // Four attempts per logical page, however often it is asked for (review finding R3): a target
  // that answers 503 costs two attempts a call (one same-tier retry), so the third call has none.
  const logicalAcquisitionId = `m2-budget-${randomUUID()}`;
  for (const n of [1, 2, 3]) await acquire(`A01-budget-call-${n}`, { logicalAcquisitionId, url: `${M2}/status/503?budget=${logicalAcquisitionId}` });
}

if (groups.has("pacing")) {
  // Direct limits on pace.fixture (spec §10.2): 2 s between navigations, one in flight, then the
  // hourly cap turns direct work into PROXY_REQUIRED instead of more home-IP traffic.
  const P = "http://pace.fixture.fcpi.test:8080";
  for (const n of [1, 2, 3]) await acquire(`A03-pace-sequential-${n}`, { logicalAcquisitionId: `m2-pace-${randomUUID()}`, url: `${P}/short.html?seq=${n}` });
  await Promise.all([1, 2].map((n) => acquire(`A04-pace-concurrent-${n}`, { logicalAcquisitionId: `m2-pace-${randomUUID()}`, url: `${P}/short.html?conc=${n}` })));
  for (let n = 1; n <= 20; n++) {
    const j = await acquire(`A05-pace-cap-${n}`, { logicalAcquisitionId: `m2-pace-${randomUUID()}`, url: `${P}/short.html?cap=${n}` });
    if (j?.failure?.class === "PROXY_REQUIRED") break;
  }
}

if (groups.has("permits")) {
  // At most two URL acquisitions at once (spec §23.1): three slow targets asked together.
  // Three domains, so per-domain pacing (one in flight each) does not serialise them first; none of
  // them is cool.fixture, whose cooldown from the static cases would refuse the request instead.
  const hosts = ["m2", "permit", "permit2"];
  await Promise.all(hosts.map((h, i) => acquire(`A02-permits-${i + 1}`, { logicalAcquisitionId: `m2-permit-${randomUUID()}`, url: `http://${h}.fixture.fcpi.test:8080/slow?ms=4000&permit=${i + 1}` })));
}

if (groups.has("cancel")) {
  // A caller that goes away: the acquisition stops and its permits are free again.
  await acquire("A06-cancel-http", { logicalAcquisitionId: `m2-cancel-${randomUUID()}`, url: `${M2}/slow?ms=30000&cancel=http` }, { abortAfterMs: 2000 });
  await sleep(1500);
  await acquire("A07-cancel-browser", { logicalAcquisitionId: `m2-cancel-${randomUUID()}`, url: `${M2}/js-hold.html?cancel=1` }, { abortAfterMs: 6000 });
  await sleep(1500);
  await acquire("A07b-after-cancel", { logicalAcquisitionId: `m2-cancel-${randomUUID()}`, url: `${M2}/js.html?after=cancel` });
}

if (groups.has("crash")) {
  // The collector kills Chromium while this render runs (review finding R6's crash case).
  await acquire("A08-crash-render", { logicalAcquisitionId: `m2-crash-${randomUUID()}`, url: `${M2}/js-hold.html?crash=1` });
  await acquire("A08b-after-crash", { logicalAcquisitionId: `m2-crash-${randomUUID()}`, url: `${M2}/js.html?after=crash` });
}

if (groups.has("stress")) {
  await acquire("A10-stress-within-cap", { logicalAcquisitionId: `m2-stress-${randomUUID()}`, url: `${M2}/stress.html?mb=${process.env.STRESS_MB ?? 512}` });
}

if (groups.has("overcap")) {
  await acquire("A11-over-cap", { logicalAcquisitionId: `m2-overcap-${randomUUID()}`, url: `${M2}/stress.html?mb=${process.env.OVERCAP_MB ?? 2400}` });
  await acquire("A11b-after-over-cap", { logicalAcquisitionId: `m2-overcap-${randomUUID()}`, url: `${M2}/js.html?after=overcap` });
}

if (groups.has("paths")) {
  // Every traced acquisition path (spec §8.4): a crawl (robots.txt, sitemap, pages), a map with
  // sitemaps (a gzip sitemap through /internal/fetch), and a search whose results are scraped.
  const post = async (path, body) => {
    const r = await fetch(`${CORE}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(120000) });
    return { http: r.status, json: await r.json().catch(() => null) };
  };
  const t0 = Date.now();
  const c = await post("/v2/crawl", { url: `${M2}/`, limit: 4, sitemap: "include", scrapeOptions: { formats: ["markdown"] } });
  let status = null;
  for (let i = 0; i < 90 && c.json?.id; i++) {
    await sleep(2000);
    const s = await fetch(`${CORE}/v2/crawl/${c.json.id}`).then((r) => r.json()).catch(() => null);
    status = s;
    if (s && ["completed", "failed", "cancelled"].includes(s.status)) break;
  }
  out({ case: "P01-crawl", kind: "core", http: c.http, crawlId: c.json?.id ?? null, error: c.json?.error ?? null, status: status?.status ?? null, completed: status?.completed ?? null,
    total: status?.total ?? null, pages: (status?.data ?? []).map((d) => ({ url: d.metadata?.sourceURL ?? d.metadata?.url, scrapeId: d.metadata?.scrapeId ?? null, statusCode: d.metadata?.statusCode ?? null,
      sentinels: [...(d.markdown ?? "").matchAll(/fcpi-m[12]-[a-z]+-[0-9a-f]{4}/g)].map((m) => m[0]) })), ms: Date.now() - t0 });
  const m = await post("/v2/map", { url: `${M2}/`, sitemap: "only", limit: 50 });
  out({ case: "P02-map-gz-sitemap", kind: "core", http: m.http, success: m.json?.success ?? null, error: m.json?.error ?? null, links: (m.json?.links ?? []).map((l) => l.url ?? l) });
  const s = await post("/v2/search", { query: "fcpi fixture", limit: 2, scrapeOptions: { formats: ["markdown"] } });
  const web = s.json?.data?.web ?? s.json?.data ?? [];
  out({ case: "P03-search", kind: "core", http: s.http, success: s.json?.success ?? null, error: s.json?.error ?? null,
    results: (Array.isArray(web) ? web : []).map((d) => ({ url: d.url ?? d.metadata?.sourceURL, scrapeId: d.metadata?.scrapeId ?? null,
      sentinels: [...(d.markdown ?? "").matchAll(/fcpi-m[12]-[a-z]+-[0-9a-f]{4}/g)].map((x) => x[0]) })) });
}
out({ case: "end" });
