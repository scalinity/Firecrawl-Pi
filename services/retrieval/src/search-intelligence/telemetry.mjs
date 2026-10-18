// Search intelligence's operational records (docs/FIRECRAWL_PI_SEARCH_INTELLIGENCE_SPEC.md §21): one search_run row per logical
// execution and one search_event per external operation outcome, documentation activation, Ref read, evidence call and
// availability or circuit transition. They are the inputs a later analytics dashboard needs (§22); nothing here serves one.
//   - Private by construction: a query is kept as its fingerprint, a URL without its query string or fragment, no page text,
//     no decision state text; provider detail is our own bounded codes.
//   - Bounded: a run's candidate trace holds at most 128 documents and 20 duplicate assessments within the policy's
//     traceMaxBytes (64 KiB as deployed), its truncation marker included; the final selection, version qualifications and
//     every provider outcome survive trimming, which is marked.
//   - Best effort: a failed write never touches the search's answer. It is logged (si_telemetry_degraded) and counted, and the
//     writes in flight are tracked so a stop can drain them. Cost stays in the ledger, which these rows only refer to.
import { randomUUID } from "node:crypto";
import { sha256, normalizeQueryText, utf8Bytes } from "./normalize.mjs";
import { VERSIONS } from "./contracts.mjs";

export const TRACE_BYTES = 65536;
// At most this many writes wait on the database: past it a write is counted lost, so a stalled database cannot grow memory.
const TRACE_DOCS = 128, TRACE_PAIRS = 20, MAX_STARTED = 1000, MAX_PENDING = 256;

export const safeUrl = (u) => { try { const x = new URL(u); return `${x.origin}${x.pathname}`.slice(0, 512); } catch { return null; } };
const code = (s) => (typeof s === "string" ? s.slice(0, 120) : null);
export const fingerprint = (r) => sha256(JSON.stringify({ q: normalizeQueryText(r.originalQuery), lang: r.language, c: r.constraints, si: r.intelligence, limit: r.limit, mode: r.resultMode }));

// The run's candidate trace: the final selection first, in its order, then the rest of the pool by its deterministic rank.
// Relevance here is Jev's runtime advice (basis jev_runtime_advice), never a judged label.
export function boundedTrace(pool, final, maxBytes = TRACE_BYTES) {
  const finalIds = new Set(final.map((d) => d.documentId));
  const ordered = [...final, ...pool.filter((d) => !finalIds.has(d.documentId)).sort((a, b) => (a.presemanticRank ?? 1e9) - (b.presemanticRank ?? 1e9))];
  const entry = (d) => ({
    id: d.documentId, url: safeUrl(d.canonicalUrl), providers: d.observations.map((o) => [o.provider, o.rank, !!o.fromCache]),
    ranks: [d.presemanticRank ?? null, d.semanticRank ?? null, d.finalRank ?? null],
    ...(d.documentation?.scopes?.length ? { versions: d.documentation.scopes.slice(0, 4).map((s) => [s.libraryId ?? s.libraryName ?? null, s.requestedVersion ?? null, s.observedVersion ?? null, s.status ?? null]) } : {}),
    ...(d.semantic?.complete ? { semantic: { relevance: d.semantic.relevance, confidence: d.semantic.confidence ?? null, directness: d.semantic.directness, evidence: d.semantic.evidence, sourceKind: d.semantic.sourceKind } }
      : d.semantic ? { semantic: { incomplete: d.semantic.reason ?? "incomplete" } } : {}),
    ...(d.softGroup ? { group: d.softGroup } : {}),
  });
  const documents = ordered.slice(0, TRACE_DOCS).map(entry);
  const pairs = pool.flatMap((d) => (d.duplicateOf ?? []).map((x) => ({ a: d.documentId, b: x.documentId, choice: x.assessment?.choice ?? null, confidence: x.assessment?.confidence ?? null })));
  const trace = { v: 1, relevanceBasis: "jev_runtime_advice", final: final.map((d) => d.documentId), documents, duplicates: pairs.slice(0, TRACE_PAIRS) };
  let dropped = Math.max(0, ordered.length - TRACE_DOCS);
  const duplicatesDropped = Math.max(0, pairs.length - TRACE_PAIRS);
  const marker = (n) => ({ documentsDropped: n, duplicatesDropped, poolSize: pool.length });
  // Room for the marker is kept once anything is dropped (its largest form: no more can be dropped than the pool holds).
  const markRoom = utf8Bytes(JSON.stringify({ truncated: marker(pool.length) }));
  const room = () => (dropped || duplicatesDropped ? markRoom : 0);
  // Trimmed from the end (the lowest-ranked documents outside the final selection), each entry measured once, until it fits.
  const sizes = documents.map((d) => utf8Bytes(JSON.stringify(d)) + 1);
  let bytes = utf8Bytes(JSON.stringify(trace));
  while (bytes + room() > maxBytes && trace.documents.length > final.length) { trace.documents.pop(); bytes -= sizes[trace.documents.length]; dropped++; }
  const truncated = dropped > 0 || duplicatesDropped > 0;
  if (truncated) trace.truncated = marker(dropped);
  return { trace, truncated };
}

// One event per lane outcome (a general engine, a documentation provider, SearXNG).
function laneEvents(logicalId, lanes, observedAt) {
  return lanes.map((o) => ({ eventId: randomUUID(), logicalId, operation: o.kind ?? "search", provider: o.provider, type: "lane", observedAt, startedAt: o.startedAt ?? null, durationMs: o.durationMs ?? null,
    queueMs: o.queueMs ?? null, status: o.status, reason: o.reason ?? null, code: code(o.detail), retryAt: o.retryAt ? new Date(o.retryAt) : null, resultCount: o.upstreamResultCount ?? null,
    eligibleCount: o.candidates?.length ?? null, cacheOrigin: o.fromCache ? "provider_cache" : null, dispatchState: o.dispatchState ?? null,
    detail: { usage: o.usage ?? null, suboperations: o.suboperations?.length ?? 0, filteredEmpty: !!o.filteredEmpty, providerRequestId: code(o.providerRequestId) } }));
}

export function makeTelemetry({ store, log = () => {}, clock = Date.now, limits = null }) {
  const pending = new Set(), started = new Map();
  let lost = 0, written = 0;
  const write = (what, fn) => {
    if (pending.size >= MAX_PENDING) { lost++; log({ event: "si_telemetry_degraded", what, error: "backlog" }); return Promise.resolve(); }
    const p = (async () => {
      try { await fn(); written++; }
      catch (e) { lost++; log({ event: "si_telemetry_degraded", what, error: String(e?.code ?? e?.message ?? e).slice(0, 120) }); }
    })();
    pending.add(p);
    p.finally(() => pending.delete(p));
    return p;
  };
  const baseOf = (request, { selection, admittedAt, configHashes = {} }) => ({ logicalId: request.logicalSearchId, requestId: request.requestId, principalId: request.principalId, jobId: request.jobId ?? null,
    fingerprint: fingerprint(request), profile: "aggregate", selection, resultMode: request.resultMode, acceptedAt: new Date(admittedAt), versions: { ...VERSIONS, config: configHashes } });
  // The building before a write runs on the search's path: whatever it throws is counted and logged here, never the search's.
  const guard = (what, fn) => (...a) => { try { return fn(...a); } catch (e) { lost++; log({ event: "si_telemetry_degraded", what, error: String(e?.message ?? e).slice(0, 120) }); } };

  return {
    runStarted: guard("run_started", ({ request, selection, admittedAt, configHashes }) => {
      const base = baseOf(request, { selection, admittedAt, configHashes });
      if (started.size >= MAX_STARTED) started.delete(started.keys().next().value);
      started.set(request.logicalSearchId, { base, p: write("run_started", () => store.searchRunStarted(base)) });
    }),
    // outcome: complete | partial | failed | cancelled. search is the response's metadata when there was one.
    runFinished: guard("run_finished", ({ request, outcome, search = null, lanes = [], pool = [], final = [], ranking = null, activation = null, enrichment = null, timings = {}, selection = null }) => {
      const s = started.get(request.logicalSearchId);
      started.delete(request.logicalSearchId);
      const base = s?.base ?? baseOf(request, { selection: selection ?? search?.selection ?? "unknown", admittedAt: clock() });
      const observedAt = new Date(clock());
      const { trace, truncated } = pool.length ? boundedTrace(pool, final, limits?.().traceMaxBytes ?? TRACE_BYTES) : { trace: null, truncated: false };
      const summary = { coverage: search?.coverage ?? null, providers: search?.providers ?? Object.fromEntries(lanes.map((o) => [o.provider, { status: o.status, reason: o.reason ?? null }])),
        warnings: search?.warnings ?? [], usage: (search?.usage ?? []).slice(0, 40), pool: search?.pool ?? null, timings, cache: search?.cache ?? null,
        ranking: ranking ? { mode: ranking.mode, reason: ranking.reason, model: ranking.model ?? null, scored: ranking.scored ?? 0, batches: ranking.batches ?? 0 } : null };
      const events = laneEvents(base.logicalId, lanes, observedAt);
      if (activation) events.push({ eventId: randomUUID(), logicalId: base.logicalId, operation: "docs_activation", provider: "classifier", type: "docs_activation", observedAt,
        status: activation.active ? "active" : "inactive", reason: activation.reason ?? null, detail: { signals: activation.signals ?? [], uncertainty: activation.uncertainty ?? null, jev: activation.jev ?? null } });
      if (ranking && ranking.reason !== "jev_not_configured") events.push({ eventId: randomUUID(), logicalId: base.logicalId, operation: "rerank", provider: "jev", type: "decision", observedAt,
        durationMs: timings.semanticMs ?? null, status: ranking.mode, reason: ranking.reason ?? null, detail: { model: ranking.model ?? null, scored: ranking.scored ?? 0, shortlisted: ranking.shortlisted ?? 0,
          batches: ranking.batches ?? 0, duplicatePairs: ranking.duplicatePairs ?? 0, usage: (ranking.usage ?? []).slice(0, 8) } });
      if (enrichment?.attempted) events.push({ eventId: randomUUID(), logicalId: base.logicalId, operation: "ref_read", provider: "ref", type: "ref_read", observedAt, durationMs: enrichment.elapsedMs ?? null,
        status: enrichment.limitation ? "limited" : "read", reason: enrichment.limitation ?? null, detail: enrichment.record ?? null });
      write("run_finished", async () => {
        await s?.p;
        await store.searchRunFinished({ ...base, completedAt: observedAt, outcome, cacheMode: search?.cache?.mode ?? null, docsActive: activation ? !!activation.active : null, docsReason: activation?.reason ?? null,
          rankingMode: ranking?.mode ?? null, summary, trace, traceTruncated: truncated });
      });
      write("events", () => store.searchEvents(events));
    }),
    // A transition or an operation outside a run's lanes (availability, a breaker, an evidence call).
    event: guard("event", (e) => { write(`event:${e.type}`, () => store.searchEvents([{ eventId: randomUUID(), observedAt: new Date(clock()), ...e }])); }),
    counters: () => ({ telemetryLost: lost, telemetryWritten: written, telemetryPending: pending.size }),
    async drain(ms = 2000) {
      const until = clock() + ms;
      while (pending.size && clock() < until) await Promise.race([Promise.allSettled([...pending]), new Promise((r) => setTimeout(r, 50))]);
      return pending.size;
    },
  };
}
