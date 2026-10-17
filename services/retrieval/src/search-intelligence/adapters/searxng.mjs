// The SearXNG lane of the aggregate profile (docs/FIRECRAWL_PI_SEARCH_INTELLIGENCE_SPEC.md §5.4): one bounded orchestration of
// the local SearXNG backend (../../search.mjs makeSearxngBackend) per logical search, never the legacy facade, which admits a
// query and tries Serper itself. It counts as one discovery lane with its backend engines nested beneath it: a useful answer
// with engines missing is partial, every missing engine's reason kept; an answer in which no engine answered is a failure,
// never a valid empty. It is local and unmetered, so it has no ledger operation.
import { outcome } from "../contracts.mjs";

export const SEARXNG_CONTRACT = "searxng-backend/1";
const REASONS = { SEARCH_BACKEND_UNAVAILABLE: "temporarily_unavailable", SEARCH_BACKEND_ERROR: "temporarily_unavailable", SEARCH_TIMEOUT: "timeout", CANCELLED: "cancelled" };

export function makeSearxngLane({ backend, limits }) {
  return {
    id: "searxng", api: "searxng-backend", contractVersion: SEARXNG_CONTRACT,
    async search(request, ctx) {
      const t0 = Date.now(), base = { provider: "searxng", kind: "search", startedAt: new Date(t0).toISOString(), dispatchState: "response_received",
        constraints: [{ mode: request.constraints.includeDomains.length || request.constraints.excludeDomains.length ? "postfilter" : "none" }] };
      let run;
      try {
        run = await backend.run(request.originalQuery, request.language === "auto" ? "auto" : request.language, { signal: ctx.signal, deadline: ctx.deadlineAt, maxResults: limits().candidates.searxng, fillTo: limits().candidates.searxng });
      } catch (e) {
        return outcome({ ...base, status: "failed", reason: REASONS[e.failureClass] ?? "temporarily_unavailable", detail: e.failureClass ?? "backend_error", durationMs: Date.now() - t0, dispatchState: "not_sent" });
      }
      const answered = run.queried.filter((e) => !run.failed.has(e));
      const suboperations = run.queried.map((engine) => ({ engine, status: run.failed.has(engine) ? "failed" : "answered", reason: run.failed.get(engine) ?? null }));
      const candidates = run.results.map((r, i) => ({ url: r.url, title: r.title, description: r.content, rank: i + 1, engines: r.engines }));
      if (!answered.length) return outcome({ ...base, status: "failed", reason: "temporarily_unavailable", detail: "no_backend_engine_answered", suboperations, durationMs: Date.now() - t0 });
      return outcome({ ...base, status: run.failed.size ? "partial" : candidates.length ? "success_results" : "success_empty", upstreamResultCount: run.results.length, candidates, suboperations,
        detail: run.failed.size ? `${run.failed.size} backend engine(s) did not answer` : null, durationMs: Date.now() - t0 });
    },
  };
}
