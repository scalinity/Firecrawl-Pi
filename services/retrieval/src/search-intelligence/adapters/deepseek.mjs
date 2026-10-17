// DeepSeek Search (docs/FIRECRAWL_PI_SEARCH_INTELLIGENCE_SPEC.md §5.2, §5.3; contract verified 2026-10-17 in
// evidence/search-intelligence/SI0/provider-contracts-2026-10-17.md §3): POST /v1/tools/search with a bearer key,
// {query, count, need_content:false}. The query, operators included, must fit 128 Unicode code points: a query that does not
// fit with its operators is sent alone and filtered locally; one that does not fit at all is not sent and the lane says so
// (unsupported_request:query_too_long) — it is never cut down to an invented "equivalent". localization takes an IP address,
// so it is never set. Search runs under one process-wide token bucket at the documented 5 QPS. Billing as documented: a
// successful search with results costs $0.00075; an empty or failed one is free.
import { parseRetryAfter } from "../availability.mjs";
import { meteredSearch, str } from "./common.mjs";
import { sha256, normalizeQueryText } from "../normalize.mjs";

export const DEEPSEEK_CONTRACT = "deepseek-search-v1/2026-10-17";
export const codePoints = (s) => Array.from(s).length;
const ymd = (iso) => iso.slice(0, 10);

export function compileDeepseek(request) {
  const q = normalizeQueryText(request.originalQuery), c = request.constraints;
  if (codePoints(q) > 128) return { unsupported: "query_too_long" };
  const ops = [];
  if (c.includeDomains.length) ops.push(c.includeDomains.map((d) => `site:${d}`).join(" OR "));
  for (const d of c.excludeDomains) ops.push(`-site:${d}`);
  if (c.publishedAfter) ops.push(`after:${ymd(c.publishedAfter)}`);
  if (c.publishedBefore) ops.push(`before:${ymd(c.publishedBefore)}`);
  const withOps = ops.length ? `${q} ${ops.join(" ")}` : q;
  const domains = c.includeDomains.length + c.excludeDomains.length;
  if (codePoints(withOps) <= 128) return { query: withOps, oriQuestion: ops.length ? q : null, constraintMode: domains ? "native" : "none" };
  return { query: q, oriQuestion: null, constraintMode: domains ? "postfilter" : "none" };
}

export function makeDeepseek({ dispatch, limits, permits }) {
  return {
    id: "deepseek", api: "deepseek-search-v1", contractVersion: DEEPSEEK_CONTRACT,
    representable(request) { const c = compileDeepseek(request); return c.unsupported ? { ok: false, detail: c.unsupported } : { ok: true }; },
    cacheIdentity(request) { const c = compileDeepseek(request); return { query: c.query, ori: c.oriQuestion, count: limits().candidates.general }; },
    async search(request, ctx) {
      const L = limits(), compiled = compileDeepseek(request);
      const body = { query: compiled.query, count: L.candidates.general, need_content: false, ...(compiled.oriQuestion ? { ori_question: compiled.oriQuestion } : {}) };
      const buf = Buffer.from(JSON.stringify(body));
      const price = ctx.sub.card.microUsdPerOperation;
      return meteredSearch({ dispatch, ctx, id: "deepseek",
        base: { provider: "deepseek", kind: "search", constraints: [{ mode: compiled.constraintMode }] },
        call: { sub: ctx.sub, pre: ctx.pre, kind: "search", callKey: `search:${request.logicalSearchId}:deepseek:search:v1`, logicalId: request.logicalSearchId, searchId: request.logicalSearchId,
          requestHash: sha256(`${DEEPSEEK_CONTRACT}\n${buf}`), amount: price, signal: ctx.signal, deadlineAt: ctx.deadlineAt, timeoutMs: L.providerTimeoutsMs.deepseek,
          maxBytes: L.responseBytes.deepseek, rate: permits.deepseek, http: { path: "/v1/tools/search", headers: { "content-type": "application/json", accept: "application/json", authorization: `Bearer ${ctx.pre.key}` }, body: buf } },
        refusal(response, data) {
          const code = str(data?.error?.code, 64, null) ?? str(data?.error?.type, 64, null);
          let reason = "temporarily_unavailable", retryAt = null;
          if (response.status === 402) reason = "quota_exhausted";
          else if (response.status === 429) { reason = "rate_limited"; retryAt = parseRetryAfter(response.headers["retry-after"]); }
          else if (response.status === 401) reason = "auth_failed";
          else if (response.status === 400) reason = "unsupported_request";
          else if (response.status === 413) reason = "contract_failure";
          // Documented: failed requests are not billed.
          return { reason, retryAt, providerCode: code ?? `http_${response.status}`, errorCode: code, close: "release", note: `DeepSeek answered HTTP ${response.status}` };
        },
        closing(data) {
          // A 200 that is not the documented shape: whether it was billed is unknown.
          if (!data || !Array.isArray(data.results)) return { uncertain: "DeepSeek answered 200 without a results list" };
          const n = data.results.length;
          return { settle: n ? price : 0, usage: { results: n, basis: n ? "documented_price" : "documented_free_empty" }, note: "DeepSeek search" };
        },
        results: (data) => (data && Array.isArray(data.results) ? data.results : null),
        candidate(x, i) {
          if (typeof x.url !== "string" || typeof x.title !== "string" || typeof x.snippet !== "string") return null;
          const pub = typeof x.date === "string" && Number.isFinite(Date.parse(x.date)) ? { at: new Date(x.date).toISOString(), basis: "provider_estimate", meaning: "published" } : null;
          return { url: x.url, title: x.title.slice(0, 500), description: x.snippet.slice(0, 2000), rank: i + 1, rawScore: Number.isFinite(x.rerank_score) ? x.rerank_score : null,
            providerSummary: str(x.summary, 1000, null), publication: pub, siteName: str(x.site_name, 200, null), authority: Number.isInteger(x.authority) ? x.authority : null };
        },
        success: (data, list) => ({ usage: { microUsd: list.length ? price : 0, basis: "documented" } }),
      });
    },
  };
}
