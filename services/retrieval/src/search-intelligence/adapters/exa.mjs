// Exa Search (docs/FIRECRAWL_PI_SEARCH_INTELLIGENCE_SPEC.md §5.2; contract verified 2026-10-17 in
// evidence/search-intelligence/SI0/provider-contracts-2026-10-17.md §2): POST /search with x-api-key, auto search, 20 results,
// bounded highlights, no generated answer, summary or page text. Domains and publication dates use Exa's native filters
// (never the deprecated, ignored crawl-date ones); local checks still enforce them. Results keep Exa's order; there is no
// comparable score. Each answer's costDollars.total settles the call; without it the reservation's documented maximum
// settles it, labelled an estimate. Errors are {requestId, error, tag}; an unknown tag is a generic error for its status.
import { parseRetryAfter } from "../availability.mjs";
import { meteredSearch, str } from "./common.mjs";
import { sha256, normalizeQueryText } from "../normalize.mjs";

export const EXA_CONTRACT = "exa-search-v1/2026-10-17";
const QUOTA_TAGS = new Set(["NO_MORE_CREDITS", "API_KEY_BUDGET_EXCEEDED", "TEAM_BUDGET_EXCEEDED"]);
// The cost Exa reports for a call in micro-USD, or null when it reports none.
const reportedCost = (data) => { const total = data?.costDollars?.total; return Number.isFinite(total) && total >= 0 ? Math.ceil(total * 1e6) : null; };

export function exaBody(request, numResults) {
  const c = request.constraints;
  return { query: normalizeQueryText(request.originalQuery), type: "auto", numResults, contents: { highlights: { maxCharacters: 1600 } },
    ...(c.includeDomains.length ? { includeDomains: c.includeDomains } : {}), ...(c.excludeDomains.length ? { excludeDomains: c.excludeDomains } : {}),
    ...(c.publishedAfter ? { startPublishedDate: c.publishedAfter } : {}), ...(c.publishedBefore ? { endPublishedDate: c.publishedBefore } : {}) };
}

export function makeExa({ dispatch, limits }) {
  return {
    id: "exa", api: "exa-search-v1", contractVersion: EXA_CONTRACT,
    representable: () => ({ ok: true }),
    cacheIdentity: (request) => exaBody(request, limits().candidates.general),
    async search(request, ctx) {
      const L = limits(), body = exaBody(request, L.candidates.general), buf = Buffer.from(JSON.stringify(body));
      return meteredSearch({ dispatch, ctx, id: "exa",
        base: { provider: "exa", kind: "search", constraints: [{ mode: request.constraints.includeDomains.length || request.constraints.excludeDomains.length ? "native" : "none" }] },
        call: { sub: ctx.sub, pre: ctx.pre, kind: "search", callKey: `search:${request.logicalSearchId}:exa:search:v1`, logicalId: request.logicalSearchId, searchId: request.logicalSearchId,
          requestHash: sha256(`${EXA_CONTRACT}\n${buf}`), amount: ctx.sub.card.microUsdPerOperation, signal: ctx.signal, deadlineAt: ctx.deadlineAt, timeoutMs: L.providerTimeoutsMs.exa, maxBytes: L.responseBytes.exa,
          http: { path: "/search", headers: { "content-type": "application/json", accept: "application/json", "x-api-key": ctx.pre.key }, body: buf } },
        answered: (data, response) => ({ providerRequestId: str(data?.requestId, 128, null) ?? str(response.headers?.["x-request-id"], 128, null) }),
        refusal(response, data) {
          const tag = str(data?.tag, 64, null);
          let reason = "temporarily_unavailable", retryAt = null;
          if (response.status === 402 || QUOTA_TAGS.has(tag)) reason = "quota_exhausted";
          else if (response.status === 429) { reason = "rate_limited"; retryAt = parseRetryAfter(response.headers["retry-after"]); }
          else if (response.status === 401 || response.status === 403) reason = "auth_failed";
          else if (response.status === 400) reason = "unsupported_request";
          // Only the 503 is documented as not processed and not billed (SI0 contract evidence §2); no other status's charge is
          // documented, so its reservation stays whole, uncertain (spec §18.2).
          const unbilled = response.status === 503;
          return { reason, retryAt, providerCode: tag ?? `http_${response.status}`, errorCode: tag, close: unbilled ? "release" : "uncertain",
            note: unbilled ? `Exa answered HTTP 503${tag ? ` ${tag}` : ""}: documented as not billed` : `Exa answered HTTP ${response.status}${tag ? ` ${tag}` : ""}; whether it was billed is not documented` };
        },
        // Settled first, valid or not: the call was billed as Exa reports it.
        closing(data) {
          const cost = reportedCost(data);
          return { settle: cost ?? ctx.sub.card.microUsdPerOperation, usage: cost !== null ? { costDollars: data.costDollars, basis: "provider_reported" } : { basis: "estimated_reservation_maximum" }, note: "Exa search" };
        },
        results: (data) => (data && Array.isArray(data.results) ? data.results : null),
        candidate(x, i) {
          if (typeof x.url !== "string" || typeof x.title !== "string") return null;
          const highlights = Array.isArray(x.highlights) ? x.highlights.filter((h) => typeof h === "string").map((h) => h.slice(0, 1600)) : [];
          const pub = typeof x.publishedDate === "string" && Number.isFinite(Date.parse(x.publishedDate)) ? { at: new Date(x.publishedDate).toISOString(), basis: "provider_estimate", meaning: "published" } : null;
          return { url: x.url, title: x.title.slice(0, 500), description: (highlights[0] ?? "").slice(0, 2000), rank: i + 1, resultId: str(x.id, 256, null), snippets: highlights.slice(0, 3), publication: pub };
        },
        success(data) {
          const cost = reportedCost(data);
          return { usage: cost !== null ? { microUsd: cost, basis: "provider_reported" } : { microUsd: ctx.sub.card.microUsdPerOperation, basis: "estimated" } };
        },
      });
    },
  };
}
