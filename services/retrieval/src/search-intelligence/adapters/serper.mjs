// Serper in the aggregate profile (docs/FIRECRAWL_PI_SEARCH_INTELLIGENCE_SPEC.md §5.2): the accepted adapter (../../serper.mjs)
// unchanged in its wire contract (q, num 10, hl; organic[]; credits 1), its one-credit metering and its lifetime allocation,
// called with the roster's subject, a stable call key and the search's deadline, and its answer mapped to the common
// outcome. Its own breaker stays the one that judges it. Serper's public pages establish no error tags, so only the
// repository's known mappings are used: an unknown refusal is a failure with its status, never invented quota or emptiness.
import { outcome } from "../contracts.mjs";
import { normalizeQueryText } from "../normalize.mjs";

export const SERPER_CONTRACT = "serper-v1/repository-proven";

function reasonOf(e) {
  const cls = e.failureClass ?? "";
  if (cls === "BLOCKED_CREDENTIAL" || cls === "SEARCH_PROVIDER_DISABLED") return ["not_configured", cls];
  if (cls === "SEARCH_RATE_CARD_MISSING") return ["platform_restricted", "rate_card_missing"];
  if (cls === "SEARCH_PROVIDER_BREAKER_OPEN") return ["breaker_open", "breaker_open"];
  // The fixed allocation of existing credits is spent: Serper's account quota as this deployment holds it.
  if (cls === "SEARCH_CREDITS_EXHAUSTED") return ["quota_exhausted", "local_allocation_exhausted"];
  // The same logical operation is already in the ledger (common.mjs reports it the same way).
  if (cls === "SEARCH_OPERATION_RECORDED") return ["internal_failure", "operation_already_recorded"];
  if (cls === "CANCELLED") return ["cancelled", "cancelled"];
  if (cls === "SEARCH_PROVIDER_TIMEOUT") return ["timeout", "timeout"];
  // The search's absolute deadline reached the transport: before send (PROVIDER_TIMEOUT) or after it, with no answer.
  if (cls === "PROVIDER_TIMEOUT" || e.timedOut) return ["timeout", "timeout"];
  if (cls === "SEARCH_PROVIDER_INVALID_RESPONSE") return ["contract_failure", "serper_response_shape"];
  const http = /^SEARCH_PROVIDER_HTTP_(\d{3})$/.exec(cls)?.[1];
  if (http === "429") return ["rate_limited", "http_429"];
  if (http === "401" || http === "403") return ["auth_failed", `http_${http}`];
  if (http && http >= "500") return ["temporarily_unavailable", `http_${http}`];
  if (http) return ["contract_failure", `http_${http}`];
  return ["temporarily_unavailable", cls.toLowerCase() || "provider_error"];
}

export function makeSerperLane({ serper, limits, permits, availability }) {
  return {
    id: "serper", api: "serper-v1", contractVersion: SERPER_CONTRACT,
    breakerState: (provider) => serper.breakerState(provider),
    representable: () => ({ ok: true }),
    cacheIdentity: (request) => ({ q: normalizeQueryText(request.originalQuery), hl: request.language === "auto" ? null : request.language.split("-")[0].toLowerCase(), num: 10 }),
    async search(request, ctx) {
      // Availability and permits belong to the subject's provider (fixture-serper on the fixture roster), never the live
      // provider's name: a fixture outcome must not change the live account's persisted state (spec §19.2).
      const provider = ctx.sub.provider;
      const L = limits(), t0 = Date.now(), base = { provider: "serper", kind: "search", constraints: [{ mode: request.constraints.includeDomains.length || request.constraints.excludeDomains.length ? "postfilter" : "none" }] };
      let release;
      try { release = await permits.api(provider, request.logicalSearchId, { signal: ctx.signal, deadlineAt: ctx.deadlineAt }); }
      catch (e) { return outcome({ ...base, status: "failed", reason: e.capacity ? "capacity_unavailable" : e.code === "CANCELLED" ? "cancelled" : "timeout", detail: e.code, queueMs: Date.now() - t0 }); }
      const queueMs = Date.now() - t0, startedAt = new Date().toISOString();
      try {
        const results = await serper.search(normalizeQueryText(request.originalQuery), request.language, { signal: ctx.signal, timeoutMs: L.providerTimeoutsMs.serper, subject: ctx.sub.name,
          callKey: `search:${request.logicalSearchId}:serper:search:v1`, logicalId: request.logicalSearchId, deadlineAt: ctx.deadlineAt });
        await availability.observe(provider, ctx.pre.epoch, { success: true, dispatchedAt: startedAt });
        const candidates = results.slice(0, L.candidates.serper).map((r, i) => ({ url: r.url, title: r.title, description: r.content, rank: i + 1 }));
        return outcome({ ...base, status: candidates.length ? "success_results" : "success_empty", upstreamResultCount: results.length, candidates, queueMs, startedAt, dispatchState: "response_received", usage: { credits: 1, basis: "provider_reported" } });
      } catch (e) {
        const [reason, detail] = reasonOf(e);
        if (["rate_limited", "auth_failed"].includes(reason)) await availability.observe(provider, ctx.pre.epoch, { reason, providerCode: detail, detail });
        return outcome({ ...base, status: "failed", reason, detail, queueMs, startedAt, dispatchState: e.sent === false ? "not_sent" : "possibly_sent",
          ...(e.httpStatus ? { error: { httpStatus: e.httpStatus, providerCode: null, retryable: reason !== "auth_failed", messageCode: `serper_${reason}` } } : {}) });
      } finally { release(); }
    },
  };
}
