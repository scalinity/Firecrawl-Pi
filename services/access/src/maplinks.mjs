// Map's second source (spec §16): the core's map reads only the site's sitemap here (its other sources, a search
// index and a hosted search engine, are Firecrawl Cloud's), so the gateway adds the links the start page itself
// carries, filtered as the core filters its own (apps/api/src/lib/map-utils.ts): the same site (its subdomains
// when includeSubdomains, the default), under the start URL's path, without fragments and (by default) query
// strings, each URL once, within the limit. The core's links come first and keep their order.

const bare = (host) => host.replace(/^www\./i, "").toLowerCase();

// The URL a map starts from: a path whose last segment names a file (index.html) maps the directory that holds
// it, as a site's own links do; the core would otherwise keep only URLs under the file's own path, which none are.
export function mapStartUrl(url) {
  const u = new URL(url);
  u.hash = "";
  u.search = "";
  const last = u.pathname.slice(u.pathname.lastIndexOf("/") + 1);
  if (last.includes(".")) u.pathname = u.pathname.slice(0, u.pathname.length - last.length);
  return u.href;
}

function normal(raw, ignoreQuery) {
  let u;
  try { u = new URL(raw); } catch { return null; }
  if (u.protocol !== "http:" && u.protocol !== "https:") return null;
  u.hash = "";
  if (ignoreQuery) u.search = "";
  return u;
}
const keyOf = (u) => `${bare(u.hostname)}:${u.port}${u.pathname.replace(/\/+$/, "") || "/"}${u.search}`;

// body: the map request (url, includeSubdomains, ignoreQueryParameters, search, limit). coreLinks: the core's
// answer, objects ({ url, title?, description? }) or strings. pageLinks: the start page's links (strings).
// Returns { links, added }: the merged list, and how many of its links came from the page alone.
export function mergeMapLinks(body, coreLinks, pageLinks, defaultLimit = 1000) {
  const start = new URL(mapStartUrl(body.url));
  const subdomains = body.includeSubdomains !== false, ignoreQuery = body.ignoreQueryParameters !== false;
  const prefix = start.pathname === "/" ? null : start.pathname;
  const site = bare(start.hostname);
  const keep = (u) => {
    const h = bare(u.hostname);
    if (u.port !== start.port || !(h === site || (subdomains && h.endsWith(`.${site}`)))) return false;
    return !prefix || u.pathname.startsWith(prefix);
  };
  const seen = new Set(), links = [];
  for (const l of Array.isArray(coreLinks) ? coreLinks : []) {
    const u = normal(typeof l === "string" ? l : l?.url, false);
    if (!u || seen.has(keyOf(u))) continue;
    seen.add(keyOf(u));
    links.push(typeof l === "string" ? { url: l } : l);
  }
  const terms = typeof body.search === "string" ? body.search.toLowerCase().split(/\s+/).filter(Boolean) : [];
  const score = (u) => { let s = ""; try { s = decodeURIComponent(u.href).toLowerCase(); } catch { s = u.href.toLowerCase(); } return terms.filter((t) => s.includes(t)).length; };
  const fromPage = [];
  for (const raw of Array.isArray(pageLinks) ? pageLinks : []) {
    const u = typeof raw === "string" ? normal(raw, ignoreQuery) : null;
    if (!u || !keep(u) || seen.has(keyOf(u))) continue;
    seen.add(keyOf(u));
    fromPage.push(u);
  }
  // With a search term, the page's links that name it come first, as the core ranks its own results by it.
  if (terms.length) fromPage.sort((a, b) => score(b) - score(a));
  const limit = Number.isInteger(body.limit) ? body.limit : defaultLimit;
  const all = [...links, ...fromPage.map((u) => ({ url: u.href }))].slice(0, limit);
  return { links: all, added: Math.max(0, all.length - Math.min(links.length, limit)) };
}
