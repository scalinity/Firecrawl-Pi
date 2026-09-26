// M3 controlled fixture (spec §31.1's controlled site graph): the targets M3's REST, job and crash
// tests fetch, served on the internal fixture network as m3.fixture.fcpi.test and reached only through
// the retrieval service's fixture allowlist. One JSON line per request (method, path, status, time), so
// a test proves what arrived, and when. Node built-ins only.
//   /             index of a 12-page graph (the index and p01-p11), with duplicate and fragment links
//   /pNN          graph pages, each with its sentinel fcpi-m3-pNN-…
//   /sitemap.xml  the 12 graph pages; /robots.txt allows all and names the sitemap
//   /slow/        index of 30 pages that each answer after 2 s: a crawl long enough to cancel
//   /missing      404; /gate 401 (an authentication gate, a per-item failure)
//   /delay?ms=N   a page that answers after N ms (at most 20 s): holds synchronous requests open
//   /big?kb=N     (M4) a page of N KiB of text paragraphs (1-2048, default 600): larger than an MCP tool payload may carry
import { createServer } from "node:http";
import { createHash } from "node:crypto";

const PORT = Number(process.env.FIXTURE_PORT ?? 8080);
const ORIGIN = "http://m3.fixture.fcpi.test:8080";
const sentinel = (name) => `fcpi-m3-${name}-${createHash("sha256").update(`fcpi-m3/${name}`).digest("hex").slice(0, 4)}`;
const page = (title, body) => `<!doctype html>\n<html lang="en"><head><meta charset="utf-8"><title>${title}</title></head><body><main>${body}</main></body></html>\n`;
const pad = (n) => String(n).padStart(2, "0");
const link = (href, text = href) => `<li><a href="${href}">${text}</a></li>`;

// The graph: the index links p01-p04; p01-p04 link on to p05-p11, with duplicates, a self link and a
// fragment; every leaf links back. Depth 2 from the index; 12 unique pages.
const GRAPH = {
  "/": ["/p01", "/p02", "/p03", "/p04"],
  "/p01": ["/p05", "/p06", "/p01", "/"],
  "/p02": ["/p07", "/p08", "/p05"],
  "/p03": ["/p09", "/p10", "/p01#top"],
  "/p04": ["/p11", "/p09", "/p02"],
};
for (let i = 5; i <= 11; i++) GRAPH[`/p${pad(i)}`] = ["/", "/p01"];
const graphPage = (path) => {
  const name = path === "/" ? "index" : path.slice(1);
  return page(`FCPI M3 ${name}`, `<h1>FCPI M3 ${name}</h1><p>A page of M3's controlled site graph.</p><p>Sentinel: <strong>${sentinel(name)}</strong></p><ul>${GRAPH[path].map((h) => link(h)).join("")}</ul>`);
};
const SLOW = Array.from({ length: 30 }, (_, i) => `/slow/s${pad(i + 1)}`);

async function answer(url) {
  const p = url.pathname;
  if (GRAPH[p]) return [200, "text/html; charset=utf-8", graphPage(p)];
  if (p === "/robots.txt") return [200, "text/plain", `User-agent: *\nAllow: /\nSitemap: ${ORIGIN}/sitemap.xml\n`];
  if (p === "/sitemap.xml") return [200, "application/xml", `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${Object.keys(GRAPH).map((k) => `<url><loc>${ORIGIN}${k}</loc></url>`).join("\n")}\n</urlset>\n`];
  if (p === "/slow/") return [200, "text/html; charset=utf-8", page("FCPI M3 slow index", `<h1>Slow pages</h1><ul>${SLOW.map((h) => link(h)).join("")}</ul>`)];
  if (SLOW.includes(p)) {
    await new Promise((r) => setTimeout(r, 2000));
    return [200, "text/html; charset=utf-8", page(`FCPI M3 ${p}`, `<h1>Slow page ${p.slice(6)}</h1><p>Answered after two seconds.</p><p>Sentinel: <strong>${sentinel(p.slice(6))}</strong></p>`)];
  }
  if (p === "/missing") return [404, "text/html; charset=utf-8", page("Not found", "<h1>Not found</h1><p>No such page here.</p>")];
  if (p === "/gate") return [401, "text/html; charset=utf-8", page("Sign in required", "<p>Authentication required.</p>")];
  if (p === "/delay") {
    await new Promise((r) => setTimeout(r, Math.min(Number(url.searchParams.get("ms") ?? 1000), 20000)));
    return [200, "text/html; charset=utf-8", page("FCPI M3 delayed", `<h1>Delayed page</h1><p>Answered after a deliberate delay.</p><p>Sentinel: <strong>${sentinel("delay")}</strong></p>`)];
  }
  if (p === "/big") {
    const kb = Math.min(Math.max(Number(url.searchParams.get("kb") ?? 600) || 600, 1), 2048);
    const para = (i) => `<p>Paragraph ${i} of the large page: ${"lorem ipsum dolor sit amet ".repeat(20)}</p>`;
    return [200, "text/html; charset=utf-8", page("FCPI M3 big", `<h1>Large page</h1><p>Sentinel: <strong>${sentinel("big")}</strong></p>${Array.from({ length: Math.ceil((kb * 1024) / 580) }, (_, i) => para(i)).join("")}`)];
  }
  return [404, "text/html; charset=utf-8", page("Not found", "<p>No such page.</p>")];
}

createServer(async (req, res) => {
  const url = new URL(req.url, "http://fixture");
  let status = 500;
  try {
    const [code, type, body] = await answer(url);
    status = code;
    const buf = Buffer.from(body);
    res.writeHead(code, { "content-type": type, "content-length": buf.length, "cache-control": "no-store", ...(code === 401 ? { "www-authenticate": 'Basic realm="fixture"' } : {}) });
    res.end(req.method === "HEAD" ? undefined : buf);
  } catch {
    res.writeHead(500).end();
  }
  console.log(JSON.stringify({ utc: new Date().toISOString(), host: req.headers.host ?? null, method: req.method, path: url.pathname, query: url.search || null, status }));
}).listen(PORT, "0.0.0.0", () => console.log(JSON.stringify({ utc: new Date().toISOString(), listening: PORT })));
for (const sig of ["SIGTERM", "SIGINT"]) process.on(sig, () => process.exit(0));
