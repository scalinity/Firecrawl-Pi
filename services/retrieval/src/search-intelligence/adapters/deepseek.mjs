// DeepSeek Search (docs/FIRECRAWL_PI_SEARCH_INTELLIGENCE_SPEC.md §5.2, §5.3; contract verified 2026-10-17 in
// evidence/search-intelligence/SI0/provider-contracts-2026-10-17.md §3): POST /v1/tools/search with a bearer key,
// {query, count, need_content:false}. The query, operators included, must fit 128 Unicode code points: a query that does not
// fit with its operators is sent alone and filtered locally; one that does not fit at all is not sent and the lane says so
// (unsupported_request:query_too_long) — it is never cut down to an invented "equivalent". localization takes an IP address,
// so it is never set. Search runs under one process-wide token bucket at the documented 5 QPS. Billing as documented: a
// successful search with results costs $0.00075; an empty or failed one is free.
import { outcome } from "../contracts.mjs";
import { parseRetryAfter } from "../availability.mjs";
import { parseJson, str } from "./common.mjs";
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
      const base = { provider: "deepseek", kind: "search", constraints: [{ mode: compiled.constraintMode }] };
      const res = await dispatch.call({ sub: ctx.sub, pre: ctx.pre, kind: "search", callKey: `search:${request.logicalSearchId}:deepseek:search:v1`, logicalId: request.logicalSearchId, searchId: request.logicalSearchId,
        requestHash: sha256(`${DEEPSEEK_CONTRACT}\n${buf}`), amount: ctx.sub.card.microUsdPerOperation, signal: ctx.signal, deadlineAt: ctx.deadlineAt, timeoutMs: L.providerTimeoutsMs.deepseek,
        maxBytes: L.responseBytes.deepseek, rate: permits.deepseek, http: { path: "/v1/tools/search", headers: { "content-type": "application/json", accept: "application/json", authorization: `Bearer ${ctx.pre.key}` }, body: buf } });
      if (!res.ok) { await dispatch.report(ctx.sub, ctx.pre.epoch, { reason: res.reason }); return outcome({ ...base, status: "failed", reason: res.reason, detail: res.detail, dispatchState: res.dispatchState, queueMs: res.queueMs }); }
      const { response, close } = res, timing = { queueMs: res.queueMs, startedAt: res.startedAt, dispatchState: "response_received" };
      const data = parseJson(response.body);
      if (response.status !== 200) {
        // Documented: failed requests are not billed.
        await close.release(`DeepSeek answered HTTP ${response.status}`);
        const code = str(data?.error?.code, 64, null) ?? str(data?.error?.type, 64, null);
        let reason = "temporarily_unavailable", retryAt = null;
        if (response.status === 402) reason = "quota_exhausted";
        else if (response.status === 429) { reason = "rate_limited"; retryAt = parseRetryAfter(response.headers["retry-after"]); }
        else if (response.status === 401) reason = "auth_failed";
        else if (response.status === 400) reason = "unsupported_request";
        else if (response.status === 413) reason = "contract_failure";
        const verdict = { reason, retryAt, retryBasis: retryAt ? "documented" : null, providerCode: code ?? `http_${response.status}`, detail: code ?? `http_${response.status}` };
        await dispatch.report(ctx.sub, ctx.pre.epoch, verdict);
        return outcome({ ...base, ...timing, status: "failed", reason, detail: verdict.detail, retryAt, error: { httpStatus: response.status, providerCode: code, retryable: reason !== "auth_failed", messageCode: `deepseek_${reason}` } });
      }
      if (!data || !Array.isArray(data.results)) {
        // A 200 that is not the documented shape: whether it was billed is unknown.
        await close.uncertain("DeepSeek answered 200 without a results list");
        await dispatch.report(ctx.sub, ctx.pre.epoch, { reason: "contract_failure", providerCode: "deepseek_shape" });
        return outcome({ ...base, ...timing, status: "failed", reason: "contract_failure", detail: "deepseek_response_shape" });
      }
      const candidates = data.results.flatMap((x, i) => {
        if (!x || typeof x.url !== "string" || typeof x.title !== "string" || typeof x.snippet !== "string") return [];
        const pub = typeof x.date === "string" && Number.isFinite(Date.parse(x.date)) ? { at: new Date(x.date).toISOString(), basis: "provider_estimate", meaning: "published" } : null;
        return [{ url: x.url, title: x.title.slice(0, 500), description: x.snippet.slice(0, 2000), rank: i + 1, rawScore: Number.isFinite(x.rerank_score) ? x.rerank_score : null,
          providerSummary: str(x.summary, 1000, null), publication: pub, siteName: str(x.site_name, 200, null), authority: Number.isInteger(x.authority) ? x.authority : null }];
      });
      await close.settle(data.results.length ? ctx.sub.card.microUsdPerOperation : 0, { usage: { results: data.results.length, basis: data.results.length ? "documented_price" : "documented_free_empty" }, detail: "DeepSeek search" });
      if (data.results.length && !candidates.length) {
        await dispatch.report(ctx.sub, ctx.pre.epoch, { reason: "contract_failure", providerCode: "deepseek_results_invalid" });
        return outcome({ ...base, ...timing, status: "failed", reason: "contract_failure", detail: "deepseek_results_invalid" });
      }
      await dispatch.report(ctx.sub, ctx.pre.epoch, { success: true });
      return outcome({ ...base, ...timing, status: candidates.length ? "success_results" : "success_empty", upstreamResultCount: data.results.length, candidates,
        usage: { microUsd: data.results.length ? ctx.sub.card.microUsdPerOperation : 0, basis: "documented" } });
    },
  };
}
