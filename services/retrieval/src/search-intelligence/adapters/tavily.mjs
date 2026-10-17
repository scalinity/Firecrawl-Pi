// Tavily Search (docs/FIRECRAWL_PI_SEARCH_INTELLIGENCE_SPEC.md §5.2; contract verified 2026-10-17 in
// evidence/search-intelligence/SI0/provider-contracts-2026-10-17.md §4): POST /search with a bearer key, advanced depth, 20
// results, three chunks per source, no answer or raw content, usage and published dates included, no automatic parameters.
// Include domains go with include_domains_mode "restrict" (only when there are some: the mode alone is a 400). 432 (plan or key
// limit) and 433 (pay-as-you-go limit) are quota; 429 is a rate limit with Retry-After. usage.credits settles the call; without
// it, the documented two credits do. Whether a failed search costs credits is not documented (SI0 contract evidence §4: it is
// stated only for Extract and Map), so every answered failure keeps its reservation, uncertain (spec §18.2).
import { parseRetryAfter } from "../availability.mjs";
import { meteredSearch, str } from "./common.mjs";
import { sha256, normalizeQueryText } from "../normalize.mjs";

export const TAVILY_CONTRACT = "tavily-search-v1/2026-10-17";
const ymd = (iso) => iso.slice(0, 10);
// The credits Tavily reports for a call, or null when it reports none.
const reportedCredits = (data) => { const credits = data?.usage?.credits; return Number.isInteger(credits) && credits >= 0 ? credits : null; };

export function tavilyBody(request, maxResults) {
  const c = request.constraints;
  return { query: normalizeQueryText(request.originalQuery), search_depth: "advanced", max_results: maxResults, chunks_per_source: 3, include_answer: false, include_raw_content: false,
    include_usage: true, include_published_date: true, auto_parameters: false,
    ...(c.includeDomains.length ? { include_domains: c.includeDomains, include_domains_mode: "restrict" } : {}), ...(c.excludeDomains.length ? { exclude_domains: c.excludeDomains } : {}),
    ...(c.publishedAfter ? { start_date: ymd(c.publishedAfter) } : {}), ...(c.publishedBefore ? { end_date: ymd(c.publishedBefore) } : {}) };
}

export function makeTavily({ dispatch, limits }) {
  return {
    id: "tavily", api: "tavily-search-v1", contractVersion: TAVILY_CONTRACT,
    representable: () => ({ ok: true }),
    cacheIdentity: (request) => tavilyBody(request, limits().candidates.general),
    async search(request, ctx) {
      const L = limits(), body = tavilyBody(request, L.candidates.general), buf = Buffer.from(JSON.stringify(body));
      const documented = ctx.sub.card.creditsPerOperation;
      return meteredSearch({ dispatch, ctx, id: "tavily",
        base: { provider: "tavily", kind: "search", constraints: [{ mode: request.constraints.includeDomains.length || request.constraints.excludeDomains.length ? "native" : "none" }] },
        call: { sub: ctx.sub, pre: ctx.pre, kind: "search", callKey: `search:${request.logicalSearchId}:tavily:search:v1`, logicalId: request.logicalSearchId, searchId: request.logicalSearchId,
          requestHash: sha256(`${TAVILY_CONTRACT}\n${buf}`), amount: documented, signal: ctx.signal, deadlineAt: ctx.deadlineAt, timeoutMs: L.providerTimeoutsMs.tavily, maxBytes: L.responseBytes.tavily,
          http: { path: "/search", headers: { "content-type": "application/json", accept: "application/json", authorization: `Bearer ${ctx.pre.key}` }, body: buf } },
        answered: (data) => ({ providerRequestId: str(data?.request_id, 128, null) }),
        refusal(response) {
          let reason = "temporarily_unavailable", retryAt = null;
          if (response.status === 432 || response.status === 433) reason = "quota_exhausted";
          else if (response.status === 429) { reason = "rate_limited"; retryAt = parseRetryAfter(response.headers["retry-after"]); }
          else if (response.status === 401) reason = "auth_failed";
          else if (response.status === 400 || response.status === 422) reason = "unsupported_request";
          const providerCode = response.status === 432 ? "plan_or_key_limit" : response.status === 433 ? "paygo_limit" : `http_${response.status}`;
          return { reason, retryAt, providerCode, close: "uncertain", note: `Tavily answered HTTP ${response.status}; whether a failed search is charged is not documented` };
        },
        closing(data) {
          const credits = reportedCredits(data);
          return { settle: credits ?? documented, usage: credits !== null ? { credits, basis: "provider_reported" } : { credits: documented, basis: "documented" }, note: "Tavily advanced search" };
        },
        results: (data) => (data && Array.isArray(data.results) ? data.results : null),
        candidate(x, i) {
          if (typeof x.url !== "string" || typeof x.title !== "string") return null;
          const pub = typeof x.published_date === "string" && Number.isFinite(Date.parse(x.published_date)) ? { at: new Date(x.published_date).toISOString(), basis: "provider_estimate", meaning: "published_or_updated" } : null;
          return { url: x.url, title: x.title.slice(0, 500), description: str(x.content, 2000), rank: i + 1, rawScore: Number.isFinite(x.score) ? x.score : null, publication: pub };
        },
        success(data) {
          const credits = reportedCredits(data);
          return { usage: { credits: credits ?? documented, basis: credits !== null ? "provider_reported" : "documented" } };
        },
      });
    },
  };
}
