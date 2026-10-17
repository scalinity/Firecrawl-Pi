// Exa Search (docs/FIRECRAWL_PI_SEARCH_INTELLIGENCE_SPEC.md §5.2; contract verified 2026-10-17 in
// evidence/search-intelligence/SI0/provider-contracts-2026-10-17.md §2): POST /search with x-api-key, auto search, 20 results,
// bounded highlights, no generated answer, summary or page text. Domains and publication dates use Exa's native filters
// (never the deprecated, ignored crawl-date ones); local checks still enforce them. Results keep Exa's order; there is no
// comparable score. Each answer's costDollars.total settles the call; without it the reservation's documented maximum
// settles it, labelled an estimate. Errors are {requestId, error, tag}; an unknown tag is a generic error for its status.
import { outcome } from "../contracts.mjs";
import { parseRetryAfter } from "../availability.mjs";
import { parseJson, str } from "./common.mjs";
import { sha256, normalizeQueryText } from "../normalize.mjs";

export const EXA_CONTRACT = "exa-search-v1/2026-10-17";
const QUOTA_TAGS = new Set(["NO_MORE_CREDITS", "API_KEY_BUDGET_EXCEEDED", "TEAM_BUDGET_EXCEEDED"]);

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
      const base = { provider: "exa", kind: "search", constraints: [{ mode: request.constraints.includeDomains.length || request.constraints.excludeDomains.length ? "native" : "none" }] };
      const res = await dispatch.call({ sub: ctx.sub, pre: ctx.pre, kind: "search", callKey: `search:${request.logicalSearchId}:exa:search:v1`, logicalId: request.logicalSearchId, searchId: request.logicalSearchId,
        requestHash: sha256(`${EXA_CONTRACT}\n${buf}`), amount: ctx.sub.card.microUsdPerOperation, signal: ctx.signal, deadlineAt: ctx.deadlineAt, timeoutMs: L.providerTimeoutsMs.exa, maxBytes: L.responseBytes.exa,
        http: { path: "/search", headers: { "content-type": "application/json", accept: "application/json", "x-api-key": ctx.pre.key }, body: buf } });
      if (!res.ok) { await dispatch.report(ctx.sub, ctx.pre.epoch, { reason: res.reason }, { answered: false }); return outcome({ ...base, status: "failed", reason: res.reason, detail: res.detail, dispatchState: res.dispatchState, queueMs: res.queueMs }); }
      const { response, close } = res, timing = { queueMs: res.queueMs, startedAt: res.startedAt, dispatchState: "response_received" };
      const data = parseJson(response.body);
      const requestId = str(data?.requestId, 128, null) ?? str(response.headers?.["x-request-id"], 128, null);
      if (response.status !== 200) {
        const tag = str(data?.tag, 64, null);
        let reason = "temporarily_unavailable", retryAt = null;
        if (response.status === 402 || QUOTA_TAGS.has(tag)) reason = "quota_exhausted";
        else if (response.status === 429) { reason = "rate_limited"; retryAt = parseRetryAfter(response.headers["retry-after"]); }
        else if (response.status === 401 || response.status === 403) reason = "auth_failed";
        else if (response.status === 400) reason = "unsupported_request";
        // A refusal (4xx) or a documented unbilled overload (503) is released; a 500/504's charge is not documented: uncertain.
        if (response.status < 500 || response.status === 503) await close.release(`Exa answered HTTP ${response.status}${tag ? ` ${tag}` : ""}`);
        else await close.uncertain(`Exa answered HTTP ${response.status}; whether it was billed is not documented`);
        const verdict = { reason, retryAt, retryBasis: retryAt ? "documented" : null, providerCode: tag ?? `http_${response.status}`, detail: tag ?? `http_${response.status}` };
        await dispatch.report(ctx.sub, ctx.pre.epoch, verdict);
        return outcome({ ...base, ...timing, status: "failed", reason, detail: verdict.detail, retryAt, providerRequestId: requestId, error: { httpStatus: response.status, providerCode: tag, retryable: reason !== "auth_failed", messageCode: `exa_${reason}` } });
      }
      // Settled first, valid or not: the call was billed as Exa reports it.
      const total = data?.costDollars?.total;
      const measured = Number.isFinite(total) && total >= 0;
      await close.settle(measured ? Math.ceil(total * 1e6) : ctx.sub.card.microUsdPerOperation, { usage: measured ? { costDollars: data.costDollars, basis: "provider_reported" } : { basis: "estimated_reservation_maximum" }, detail: "Exa search" });
      if (!data || !Array.isArray(data.results)) {
        await dispatch.report(ctx.sub, ctx.pre.epoch, { reason: "contract_failure", providerCode: "exa_shape" });
        return outcome({ ...base, ...timing, status: "failed", reason: "contract_failure", detail: "exa_response_shape", providerRequestId: requestId });
      }
      const candidates = data.results.flatMap((x, i) => {
        if (!x || typeof x.url !== "string" || typeof x.title !== "string") return [];
        const highlights = Array.isArray(x.highlights) ? x.highlights.filter((h) => typeof h === "string").map((h) => h.slice(0, 1600)) : [];
        const pub = typeof x.publishedDate === "string" && Number.isFinite(Date.parse(x.publishedDate)) ? { at: new Date(x.publishedDate).toISOString(), basis: "provider_estimate", meaning: "published" } : null;
        return [{ url: x.url, title: x.title.slice(0, 500), description: (highlights[0] ?? "").slice(0, 2000), rank: i + 1, resultId: str(x.id, 256, null), snippets: highlights.slice(0, 3), publication: pub }];
      });
      if (data.results.length && !candidates.length) {
        await dispatch.report(ctx.sub, ctx.pre.epoch, { reason: "contract_failure", providerCode: "exa_results_invalid" });
        return outcome({ ...base, ...timing, status: "failed", reason: "contract_failure", detail: "exa_results_invalid", providerRequestId: requestId });
      }
      await dispatch.report(ctx.sub, ctx.pre.epoch, { success: true });
      return outcome({ ...base, ...timing, status: candidates.length ? "success_results" : "success_empty", upstreamResultCount: data.results.length, candidates, providerRequestId: requestId,
        usage: measured ? { microUsd: Math.ceil(total * 1e6), basis: "provider_reported" } : { microUsd: ctx.sub.card.microUsdPerOperation, basis: "estimated" } });
    },
  };
}
