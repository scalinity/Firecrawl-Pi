// Brave Web Search (docs/FIRECRAWL_PI_SEARCH_INTELLIGENCE_SPEC.md §5.2; contract verified 2026-10-17 in
// evidence/search-intelligence/SI0/provider-contracts-2026-10-17.md §1): GET /res/v1/web/search with the subscription token,
// q within 600 characters AND 75 words, count 20, offset 0 (a page index), web results only, extra snippets, no
// decorations. A valid answer may lack the web section (no results). Only successful requests are billed, so a refusal
// releases its reservation; a success counts one request, whose money the plan leaves unknown.
import { parseBraveRateHeaders, parseRetryAfter } from "../availability.mjs";
import { meteredSearch, str } from "./common.mjs";
import { sha256, normalizeQueryText } from "../normalize.mjs";

export const BRAVE_CONTRACT = "brave-web-v1/2026-10-17";
const words = (q) => q.split(/\s+/).filter(Boolean).length;
const fits = (q) => q.length <= 600 && words(q) <= 75;

// The query sent: the original plus documented site operators when they fit; otherwise the original alone with the domains
// enforced locally (postfilter); unrepresentable only when the original itself is over Brave's bounds.
export function compileBrave(request) {
  const q = normalizeQueryText(request.originalQuery), c = request.constraints;
  if (!fits(q)) return { unsupported: q.length > 600 ? "query_too_long" : "too_many_words" };
  const ops = [...(c.includeDomains.length === 1 ? [`site:${c.includeDomains[0]}`] : []), ...c.excludeDomains.map((d) => `-site:${d}`)];
  const withOps = ops.length ? `${q} ${ops.join(" ")}` : q;
  const domains = c.includeDomains.length + c.excludeDomains.length;
  if (fits(withOps) && (c.includeDomains.length <= 1)) return { q: withOps, constraintMode: domains ? "native" : "none" };
  return { q, constraintMode: domains ? "postfilter" : "none" };
}
const ymd = (iso) => iso.slice(0, 10);

export function makeBrave({ dispatch, limits }) {
  return {
    id: "brave", api: "brave-web-v1", contractVersion: BRAVE_CONTRACT,
    representable(request) { const c = compileBrave(request); return c.unsupported ? { ok: false, detail: c.unsupported } : { ok: true }; },
    cacheIdentity(request) {
      const c = compileBrave(request);
      return { q: c.q, constraintMode: c.constraintMode, count: limits().candidates.general, after: request.constraints.publishedAfter ?? null, before: request.constraints.publishedBefore ?? null };
    },
    async search(request, ctx) {
      const L = limits(), compiled = compileBrave(request);
      const params = new URLSearchParams({ q: compiled.q, count: String(L.candidates.general), offset: "0", result_filter: "web", extra_snippets: "true", text_decorations: "false" });
      // Date bounds become Brave's freshness range (a discovery preference; its dates may mean modified, spec §5.3).
      const c = request.constraints;
      if (c.publishedAfter || c.publishedBefore) params.set("freshness", `${ymd(c.publishedAfter ?? "1970-01-01")}to${ymd(c.publishedBefore ?? new Date(ctx.deadlineAt).toISOString())}`);
      const path = `/res/v1/web/search?${params}`;
      return meteredSearch({ dispatch, ctx, id: "brave",
        base: { provider: "brave", kind: "search", startedAt: new Date().toISOString(), constraints: [{ mode: compiled.constraintMode }] },
        call: { sub: ctx.sub, pre: ctx.pre, kind: "search", callKey: `search:${request.logicalSearchId}:brave:search:v1`, logicalId: request.logicalSearchId, searchId: request.logicalSearchId,
          requestHash: sha256(`${BRAVE_CONTRACT}\n${path}`), amount: 1, signal: ctx.signal, deadlineAt: ctx.deadlineAt, timeoutMs: L.providerTimeoutsMs.brave, maxBytes: L.responseBytes.brave,
          http: { method: "GET", path, headers: { accept: "application/json", "x-subscription-token": ctx.pre.key } } },
        // Brave bills successful requests only: a refusal is released. Classify by error.code first, status second.
        refusal(response, data) {
          const code = str(data?.error?.code, 64, null), rate = parseBraveRateHeaders(response.headers);
          let reason = "temporarily_unavailable", retryAt = null;
          if (response.status === 429 || code === "RATE_LIMITED" || code === "QUOTA_LIMITED") {
            reason = code === "QUOTA_LIMITED" ? "quota_exhausted" : rate?.state ?? "rate_limited";
            retryAt = rate?.retryAt ?? parseRetryAfter(response.headers["retry-after"]);
          } else if (code === "SUBSCRIPTION_TOKEN_INVALID" || [401, 403].includes(response.status)) reason = "auth_failed";
          else if (response.status === 402) reason = "quota_exhausted";
          else if (response.status === 422 || response.status === 400) reason = "contract_failure";
          return { reason, retryAt, providerCode: code ?? `http_${response.status}`, errorCode: code, close: "release", note: `Brave answered HTTP ${response.status}` };
        },
        // A 200 counts one request whatever it holds; its validity is judged after.
        closing: () => ({ settle: 1, usage: { requests: 1, money: "unknown" }, note: "Brave web search", fields: { usage: { requests: 1 } } }),
        // A valid answer may lack the web section (no results).
        results(data) {
          if (!data || typeof data !== "object" || typeof data.query?.original !== "string" || (data.web !== undefined && !Array.isArray(data.web?.results))) return null;
          return Array.isArray(data.web?.results) ? data.web.results : [];
        },
        candidate(x, i) {
          if (typeof x.url !== "string" || typeof x.title !== "string") return null;
          const pub = typeof x.page_age === "string" && Number.isFinite(Date.parse(x.page_age)) ? { at: new Date(x.page_age).toISOString(), basis: "provider_estimate", meaning: "published_or_updated" } : null;
          return { url: x.url, title: x.title.slice(0, 500), description: str(x.description, 2000), rank: i + 1, snippets: Array.isArray(x.extra_snippets) ? x.extra_snippets.filter((s) => typeof s === "string").slice(0, 5).map((s) => s.slice(0, 1000)) : [],
            publication: pub, language: str(x.language, 16, null) };
        },
        success: (data) => ({ usage: { requests: 1, money: "unknown" }, providerRequestId: null, detail: typeof data.query.altered === "string" ? "query_altered" : null }),
      });
    },
  };
}
