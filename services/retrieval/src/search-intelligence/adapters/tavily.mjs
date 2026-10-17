// Tavily Search (docs/FIRECRAWL_PI_SEARCH_INTELLIGENCE_SPEC.md §5.2; contract verified 2026-10-17 in
// evidence/search-intelligence/SI0/provider-contracts-2026-10-17.md §4): POST /search with a bearer key, advanced depth, 20
// results, three chunks per source, no answer or raw content, usage and published dates included, no automatic parameters.
// Include domains go with include_domains_mode "restrict" (only when there are some: the mode alone is a 400). 432 (plan or key
// limit) and 433 (pay-as-you-go limit) are quota; 429 is a rate limit with Retry-After. usage.credits settles the call; without
// it, the documented two credits do. Whether a failed search costs credits is not documented (SI0 contract evidence §4: it is
// stated only for Extract and Map), so every answered failure keeps its reservation, uncertain (spec §18.2).
import { outcome } from "../contracts.mjs";
import { parseRetryAfter } from "../availability.mjs";
import { parseJson, str } from "./common.mjs";
import { sha256, normalizeQueryText } from "../normalize.mjs";

export const TAVILY_CONTRACT = "tavily-search-v1/2026-10-17";
const ymd = (iso) => iso.slice(0, 10);

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
      const base = { provider: "tavily", kind: "search", constraints: [{ mode: request.constraints.includeDomains.length || request.constraints.excludeDomains.length ? "native" : "none" }] };
      const res = await dispatch.call({ sub: ctx.sub, pre: ctx.pre, kind: "search", callKey: `search:${request.logicalSearchId}:tavily:search:v1`, logicalId: request.logicalSearchId, searchId: request.logicalSearchId,
        requestHash: sha256(`${TAVILY_CONTRACT}\n${buf}`), amount: ctx.sub.card.creditsPerOperation, signal: ctx.signal, deadlineAt: ctx.deadlineAt, timeoutMs: L.providerTimeoutsMs.tavily, maxBytes: L.responseBytes.tavily,
        http: { path: "/search", headers: { "content-type": "application/json", accept: "application/json", authorization: `Bearer ${ctx.pre.key}` }, body: buf } });
      if (!res.ok) { await dispatch.report(ctx.sub, ctx.pre.epoch, { reason: res.reason }, { answered: false }); return outcome({ ...base, status: "failed", reason: res.reason, detail: res.detail, dispatchState: res.dispatchState, queueMs: res.queueMs }); }
      const { response, close } = res, timing = { queueMs: res.queueMs, startedAt: res.startedAt, dispatchState: "response_received" };
      const data = parseJson(response.body);
      const requestId = str(data?.request_id, 128, null);
      if (response.status !== 200) {
        let reason = "temporarily_unavailable", retryAt = null;
        if (response.status === 432 || response.status === 433) reason = "quota_exhausted";
        else if (response.status === 429) { reason = "rate_limited"; retryAt = parseRetryAfter(response.headers["retry-after"]); }
        else if (response.status === 401) reason = "auth_failed";
        else if (response.status === 400 || response.status === 422) reason = "unsupported_request";
        await close.uncertain(`Tavily answered HTTP ${response.status}; whether a failed search is charged is not documented`);
        const providerCode = response.status === 432 ? "plan_or_key_limit" : response.status === 433 ? "paygo_limit" : `http_${response.status}`;
        const verdict = { reason, retryAt, retryBasis: retryAt ? "documented" : null, providerCode, detail: providerCode };
        await dispatch.report(ctx.sub, ctx.pre.epoch, verdict);
        return outcome({ ...base, ...timing, status: "failed", reason, detail: providerCode, retryAt, providerRequestId: requestId, error: { httpStatus: response.status, providerCode, retryable: reason !== "auth_failed", messageCode: `tavily_${reason}` } });
      }
      const credits = data?.usage?.credits;
      const measured = Number.isInteger(credits) && credits >= 0;
      await close.settle(measured ? credits : ctx.sub.card.creditsPerOperation, { usage: measured ? { credits, basis: "provider_reported" } : { credits: ctx.sub.card.creditsPerOperation, basis: "documented" }, detail: "Tavily advanced search" });
      if (!data || !Array.isArray(data.results)) {
        await dispatch.report(ctx.sub, ctx.pre.epoch, { reason: "contract_failure", providerCode: "tavily_shape" });
        return outcome({ ...base, ...timing, status: "failed", reason: "contract_failure", detail: "tavily_response_shape", providerRequestId: requestId });
      }
      const candidates = data.results.flatMap((x, i) => {
        if (!x || typeof x.url !== "string" || typeof x.title !== "string") return [];
        const pub = typeof x.published_date === "string" && Number.isFinite(Date.parse(x.published_date)) ? { at: new Date(x.published_date).toISOString(), basis: "provider_estimate", meaning: "published_or_updated" } : null;
        return [{ url: x.url, title: x.title.slice(0, 500), description: str(x.content, 2000), rank: i + 1, rawScore: Number.isFinite(x.score) ? x.score : null, publication: pub }];
      });
      if (data.results.length && !candidates.length) {
        await dispatch.report(ctx.sub, ctx.pre.epoch, { reason: "contract_failure", providerCode: "tavily_results_invalid" });
        return outcome({ ...base, ...timing, status: "failed", reason: "contract_failure", detail: "tavily_results_invalid", providerRequestId: requestId });
      }
      await dispatch.report(ctx.sub, ctx.pre.epoch, { success: true });
      return outcome({ ...base, ...timing, status: candidates.length ? "success_results" : "success_empty", upstreamResultCount: data.results.length, candidates, providerRequestId: requestId,
        usage: { credits: measured ? credits : ctx.sub.card.creditsPerOperation, basis: measured ? "provider_reported" : "documented" } });
    },
  };
}
