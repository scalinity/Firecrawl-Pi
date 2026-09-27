// Bulk jobs and the residential route (FIRECRAWL_PI_SPEC.md §10.2; M6). A crawl whose limit, or a batch whose URL
// count, passes the manifest's bulkPages (spec §10.2's 20) needs approved proxy egress from the start:
//   - its pages ask the retrieval service for the residential route (the scrape option proxy: "stealth", which the
//     core carries to every page, external links included);
//   - before it is submitted to the core, its start URL's domain (a batch's every domain) is held on the residential
//     route for the job's life, so robots.txt, sitemaps and every auxiliary download of those domains take it too,
//     though the core sends them without the page's options;
//   - it is refused as PROXY_REQUIRED, with nothing recorded and nothing sent, when the route cannot be had at
//     admission, and fails with PROXY_REQUIRED at dispatch if the route was lost meanwhile. It never runs on the
//     home connection instead.
// A bulk job that asks for direct egress only (proxy: "basic") is refused outright: local-only never passes the
// direct limits. M7: so is a bulk job that asks for the enhanced provider (proxy: "enhanced"), which is one paid
// dispatch per page, not a bulk route; its option is never rewritten. A job of any size whose pages ask for the
// residential route (proxy: "stealth") or the enhanced provider, a caller's mark of a difficult target, is held and
// checked the same way, since its robots.txt, sitemaps and discovery fetches carry no route of their own and would
// otherwise leave from the home connection (review W7, M7 review W15).
import { RequestError } from "./validate.mjs";

export function pagesOf(kind, body) {
  if (kind === "crawl") return body.limit;
  if (kind === "batch") return body.urls.length;
  return 1;
}
export const isBulk = (kind, body, M) => (kind === "crawl" || kind === "batch") && pagesOf(kind, body) > M.limits.proxy.bulkPages;
const askedRoute = (kind, body) => (kind === "crawl" ? body.scrapeOptions?.proxy : body.proxy);
// A job whose pages take the residential route, and whose domains are therefore held on it for the job's life.
export const needsRoute = (kind, body, M) => (kind === "crawl" || kind === "batch") && (isBulk(kind, body, M) || ["stealth", "enhanced"].includes(askedRoute(kind, body)));

// The body with its route decided: a bulk job's pages ask for the residential route. Returns { body, bulk, needsRoute }.
export function routeBody(kind, body, M) {
  if (!isBulk(kind, body, M)) return { body, bulk: false, needsRoute: needsRoute(kind, body, M) };
  const asked = askedRoute(kind, body);
  if (asked === "basic") {
    throw new RequestError(400, "PROXY_REQUIRED", `A job of more than ${M.limits.proxy.bulkPages} pages needs the residential route from the start (spec §10.2); proxy 'basic' asks for direct egress only.`);
  }
  if (asked === "enhanced") {
    throw new RequestError(400, "UNSUPPORTED_OPTION", `A job of more than ${M.limits.proxy.bulkPages} pages takes the residential route (spec §10.2); proxy 'enhanced' is one paid dispatch per page and is not offered for bulk jobs.`, { option: kind === "crawl" ? "scrapeOptions.proxy" : "proxy" });
  }
  if (kind === "crawl") return { body: { ...body, scrapeOptions: { ...(body.scrapeOptions ?? {}), proxy: "stealth" } }, bulk: true, needsRoute: true };
  return { body: { ...body, proxy: "stealth" }, bulk: true, needsRoute: true };
}

// The URLs whose domains a job that needs the residential route holds on it.
export const holdUrls = (kind, request) => (kind === "crawl" ? [request.url] : request.urls);

// The refusal a caller gets when the residential route cannot be had for a job that needs it.
export function routeRefusal(residential) {
  const reason = residential?.reason ?? "ROUTE_SERVICE_UNREACHABLE";
  return { status: 429, body: { success: false, code: "PROXY_REQUIRED", error: `This job needs the residential route from the start, which is unavailable (${reason}); nothing was accepted or sent.`, route: { residential: reason } },
    retryAfter: residential?.retryAfter ?? null };
}
