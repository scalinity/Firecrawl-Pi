// M2 controlled fixture server: the only targets M2's tests fetch. Served on the internal fixture
// network under several host names (m2, pace, m1), reached only through the retrieval service's
// fixture allowlist. It logs one JSON line per request (host, method, path, status, peer), so a
// test proves what arrived and what never did. Node built-ins only.
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { gzipSync } from "node:zlib";
import { join, normalize } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const SITE = join(HERE, "site");
const M1_STATIC = join(HERE, "..", "m1", "site", "static.html");
const PORT = Number(process.env.FIXTURE_PORT ?? 8080);
const ORIGIN = "http://m2.fixture.fcpi.test:8080";

// A one-page PDF saying the sentinel fcpi-m2-pdf-4e7a, rendered from text by macOS's CUPS filter
// (site/doc.pdf); its metadata holds only the producer and two dates.
const pdf = () => readFile(join(SITE, "doc.pdf"));

const html = (title, body, extraHead = "") => `<!doctype html>\n<html lang="en"><head><meta charset="utf-8"><title>${title}</title>${extraHead}</head><body>${body}</body></html>\n`;

const routes = {
  "/cookie": (req) => {
    // A cookie gate: the first answer sets a cookie and redirects to itself; the content appears
    // only when the cookie comes back, as a per-acquisition cookie jar returns it.
    if (/(^|;\s*)fcpi_gate=1(;|$)/.test(req.headers.cookie ?? "")) {
      return [200, { "content-type": "text/html; charset=utf-8" }, html("FCPI M2 cookie fixture", "<main><h1>Past the cookie gate</h1><p>This article is served only to a client that returns the cookie it was given.</p><p>Sentinel: <strong>fcpi-m2-cookie-2a9f</strong></p></main>")];
    }
    return [302, { location: "/cookie", "set-cookie": "fcpi_gate=1; Path=/; HttpOnly", "content-type": "text/plain" }, "redirecting\n"];
  },
  "/cookie-js": (req) => {
    // The same gate set by script: only a browser gets past it.
    if (/(^|;\s*)fcpi_js_gate=1(;|$)/.test(req.headers.cookie ?? "")) {
      return [200, { "content-type": "text/html; charset=utf-8" }, html("FCPI M2 script cookie fixture", "<main><h1>Past the script cookie gate</h1><p>This article is served only after the page's script set a cookie and reloaded.</p><p>Sentinel: <strong>fcpi-m2-cookiejs-7d1c</strong></p></main>")];
    }
    return [200, { "content-type": "text/html; charset=utf-8" }, html("Checking", "<main id=\"content\"><noscript>Please enable JavaScript to continue.</noscript></main><script>document.cookie='fcpi_js_gate=1; path=/';location.reload();</script>")];
  },
  "/empty": () => [200, { "content-type": "text/html; charset=utf-8" }, ""],
  "/auth": () => [401, { "content-type": "text/html; charset=utf-8", "www-authenticate": 'Basic realm="fixture"' }, html("Sign in required", "<p>Authentication required.</p>")],
  "/members": () => [302, { location: "/login?next=/members" }, ""],
  "/login": () => [200, { "content-type": "text/html; charset=utf-8" }, html("Sign in", "<main><h1>Sign in</h1><form method=\"post\"><input name=\"user\"><input type=\"password\" name=\"pw\"><button>Sign in</button></form></main>")],
  "/forbidden": () => [403, { "content-type": "text/html; charset=utf-8" }, html("Forbidden", "<p>You do not have access to this resource.</p>")],
  "/forbidden-navigation": () => [403, { "content-type": "text/html; charset=utf-8" }, html("Forbidden navigation control", '<p>You do not have access to this resource.</p><img src="http://169.254.169.254/latest/meta-data/"><script>setTimeout(()=>location.href="http://169.254.169.254/latest/meta-data/",100)</script>')],
  "/challenge": () => [200, { "content-type": "text/html; charset=utf-8" }, html("Just a moment...", "<div id=\"challenge-running\">Checking your browser before accessing the site.</div><script src=\"/cdn-cgi/challenge-platform/h/b/orchestrate/chl_page/v1\"></script>")],
  "/pdf": async () => [200, { "content-type": "application/pdf" }, await pdf()],
  "/doc.pdf": async () => [200, { "content-type": "application/pdf" }, await pdf()],
  "/": () => [200, { "content-type": "text/html; charset=utf-8" }, html("FCPI M2 fixture index", `<main><h1>Fixture index</h1><p>The pages M2's crawl follows.</p><ul><li><a href="/static.html">static</a></li><li><a href="/short.html">short</a></li><li><a href="/js.html">script-rendered</a></li></ul><p>Sentinel: <strong>fcpi-m2-index-0d5c</strong></p></main>`)],
  "/robots.txt": () => [200, { "content-type": "text/plain" }, `User-agent: *\nDisallow: /private/\nSitemap: ${ORIGIN}/sitemap.xml\nSitemap: ${ORIGIN}/sitemap-index.xml\n`],
  "/sitemap.xml": () => [200, { "content-type": "application/xml" }, `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n<url><loc>${ORIGIN}/static.html</loc></url>\n<url><loc>${ORIGIN}/short.html</loc></url>\n</urlset>\n`],
  "/sitemap-index.xml": () => [200, { "content-type": "application/xml" }, `<?xml version="1.0" encoding="UTF-8"?>\n<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n<sitemap><loc>${ORIGIN}/sitemap-gz.xml.gz</loc></sitemap>\n</sitemapindex>\n`],
  "/sitemap-gz.xml.gz": () => [200, { "content-type": "application/gzip" }, gzipSync(`<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n<url><loc>${ORIGIN}/js.html</loc></url>\n</urlset>\n`)],
  // A body larger than the service's limit, and a small body that decodes to far more than it.
  "/large": () => [200, { "content-type": "text/html; charset=utf-8" }, Buffer.alloc(27 * 1024 * 1024, 0x61)],
  "/gzip-bomb": () => [200, { "content-type": "text/html; charset=utf-8", "content-encoding": "gzip" }, gzipSync(Buffer.alloc(64 * 1024 * 1024, 0x20), { level: 9 })],
  "/search": (req) => {
    // SearXNG's JSON shape, answering every query with fixture pages.
    const q = new URL(req.url, "http://x").searchParams.get("q") ?? "";
    return [200, { "content-type": "application/json" }, JSON.stringify({ query: q, number_of_results: 2, results: [
      { url: `${ORIGIN}/static.html`, title: "FCPI M2 static fixture", content: "A static fixture page.", engine: "fixture" },
      { url: `${ORIGIN}/js.html`, title: "FCPI M2 JS fixture", content: "A page rendered by script.", engine: "fixture" },
    ] })];
  },
  "/static.html": async () => [200, { "content-type": "text/html; charset=utf-8" }, await readFile(M1_STATIC)],
};

async function answer(req, url) {
  const p = url.pathname;
  if (routes[p]) return routes[p](req);
  let m;
  if ((m = p.match(/^\/status\/(\d{3})$/))) {
    const code = Number(m[1]);
    const retry = url.searchParams.get("retry");
    return [code, { "content-type": "text/html; charset=utf-8", ...(retry ? { "retry-after": retry } : {}) }, html(`Status ${code}`, `<p>Status ${code}</p>`)];
  }
  if (p === "/redirect") return [302, { location: url.searchParams.get("to") ?? "/static.html" }, ""];
  if ((m = p.match(/^\/chain\/(\d+)$/))) {
    const n = Number(m[1]);
    return n > 0 ? [302, { location: `/chain/${n - 1}` }, ""] : routes["/static.html"]();
  }
  if (p === "/slow") {
    await new Promise((r) => setTimeout(r, Math.min(Number(url.searchParams.get("ms") ?? 1000), 120000)));
    // status=503 (or another 5xx) makes a slow target error, which costs a same-tier retry.
    const code = [500, 502, 503, 504].includes(Number(url.searchParams.get("status"))) ? Number(url.searchParams.get("status")) : 200;
    return [code, { "content-type": "text/html; charset=utf-8" }, html("Slow fixture", "<main><h1>Slow</h1><p>This page answered after a deliberate delay.</p></main>")];
  }
  if (p === "/pixel.png") return [200, { "content-type": "image/png" }, Buffer.from("89504e470d0a1a0a0000000d4948445200000001000000010806000000", "hex")];
  if (p.endsWith(".html")) {
    const file = normalize(p).replace(/^\/+/, "");
    if (file.includes("..")) return [404, {}, ""];
    try { return [200, { "content-type": "text/html; charset=utf-8" }, await readFile(join(SITE, file))]; } catch { /* fall through */ }
  }
  return [404, { "content-type": "text/html; charset=utf-8" }, html("Not found", "<p>No such page.</p>")];
}

createServer(async (req, res) => {
  let status = 500;
  const url = new URL(req.url, "http://fixture");
  try {
    const [code, headers, body] = await answer(req, url);
    status = code;
    const buf = typeof body === "string" ? Buffer.from(body) : body;
    res.writeHead(code, { "cache-control": "no-store", "content-length": buf.length, ...headers });
    res.end(req.method === "HEAD" ? undefined : buf);
  } catch {
    res.writeHead(500).end();
  }
  console.log(JSON.stringify({ utc: new Date().toISOString(), host: req.headers.host ?? null, method: req.method, path: url.pathname, query: url.search || null, status, from: req.socket.remoteAddress, ua: req.headers["user-agent"] ?? null, cookie: req.headers.cookie ? "present" : null }));
}).listen(PORT, "0.0.0.0", () => console.log(JSON.stringify({ utc: new Date().toISOString(), listening: PORT })));
for (const sig of ["SIGTERM", "SIGINT"]) process.on(sig, () => process.exit(0));
