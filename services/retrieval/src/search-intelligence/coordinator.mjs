// The logical search (docs/FIRECRAWL_PI_SEARCH_INTELLIGENCE_SPEC.md §5, §9.4, §14, §17). One execution per admitted search:
//   1. a complete aggregate cache entry answers without admission or dispatch (marked reuse, never five fresh calls);
//   2. otherwise the shared hourly admission counts it once, whatever it then dispatches;
//   3. every eligible general engine is launched before any answer is awaited, and no early answer ends the fan-out; a lane
//      that cannot run is skipped with one of the spec's reasons; SearXNG runs at most once, as fallback, augmentation or
//      (by configuration) alongside;
//   4. documentation lanes start as soon as activation is known (explicitly at once; otherwise overlapping discovery);
//   5. normalization, constraints and fusion are deterministic; Jev's advice, when it arrives in time, is blended in;
//   6. the outcome says what happened: complete, partial or a typed failure (no lane validated) — never an empty success
//      standing in for a failure; Jev's success is never discovery coverage.
// Callers asking the same search at once share one execution (reference-counted: one caller's cancellation detaches it,
// the work stops only when every caller has gone or its own deadline passes). Adapter and settlement tasks are tracked so
// a stop can drain them.
import { randomUUID } from "node:crypto";
import { Denied } from "../ssrf.mjs";
import { validateSearchRequest, outcome, skipped, failed, validated, GENERAL, DOCUMENTATION, VERSIONS, RESPONSE_SCHEMA } from "./contracts.mjs";
import { prepareCandidates, buildPool, sha256, normalizeQueryText } from "./normalize.mjs";
import { fuse, literalRelevance, shortlist, blend, selectFinal } from "./rank.mjs";
import { SEARCH_APIS } from "../budget.mjs";

const LABEL = { serper: "Serper", brave: "Brave", exa: "Exa", deepseek: "DeepSeek", tavily: "Tavily", context7: "Context7", ref: "Ref", searxng: "SearXNG", jev: "Jev" };
const REASON_TEXT = { not_configured: "not configured", temporarily_unavailable: "unavailable", breaker_open: "paused after repeated failures", rate_limited: "rate limited",
  quota_exhausted: "quota exhausted", auth_failed: "authentication failed", contract_failure: "answered in an unexpected form", unsupported_request: "cannot represent this query",
  platform_restricted: "restricted by this deployment", timeout: "timed out", cancelled: "cancelled", capacity_unavailable: "no capacity in time", internal_failure: "failed internally" };
const sleep = (ms, signal) => new Promise((r) => { const t = setTimeout(r, ms); signal?.addEventListener("abort", () => { clearTimeout(t); r(); }, { once: true }); });
const iso = (t) => new Date(t).toISOString();

export function makeCoordinator({ store, getBudget, getPolicy, getSelection, getConfigHashes = () => ({}), dispatch, general, searxng, docs = {}, documentation = null, decisions = null,
  availability, telemetry = null, legacy = null, log = () => {}, clock = Date.now }) {
  const tasks = new Set();
  const track = (p) => { tasks.add(p); p.finally(() => tasks.delete(p)).catch(() => {}); return p; };
  const flights = new Map();
  let cacheFailures = 0;

  const limits = () => getPolicy().search.intelligence;
  // A roster subject's adapter, by its provider's API (the roster's order is configuration, never a pairing).
  const adapterFor = (map, name, adapters) => {
    const api = dispatch.subject(map, name)?.prov?.api;
    return Object.values(adapters).find((a) => a.api === api) ?? null;
  };
  const rosterFor = (selection) => {
    const S = getBudget().searching;
    return selection === "fixture" ? S.fixtureRoster ?? null : { generalSubjects: S.generalSubjects, documentationSubjects: S.documentationSubjects, decisionSubject: S.decisionSubject };
  };

  // ---- cache identities (spec §17): content and configuration, never request ids, deadlines or transient state --------------
  function aggregateKey(request, roster, selection) {
    const r = request;
    return `si.aggregate/v1:${sha256(JSON.stringify({ v: VERSIONS, q: normalizeQueryText(r.originalQuery), lang: r.language, limit: r.limit, mode: r.resultMode, c: r.constraints, si: r.intelligence,
      roster, selection, searxng: getBudget().searching.searxngMode, contracts: Object.fromEntries([...Object.entries(general), ...Object.entries(docs)].map(([k, a]) => [k, a.contractVersion])),
      jev: decisions?.identity?.() ?? null }))}`;
  }
  const providerKey = (adapter, request, selection) => `si.provider/v1:${adapter.id}:${sha256(JSON.stringify({ c: adapter.contractVersion, e: adapter.cacheIdentity(request), k: request.constraints, lang: request.language, selection }))}`;
  const timeSensitive = (request) => !!(request.constraints.publishedAfter || request.constraints.publishedBefore);
  async function cacheEntry(key) { try { return await store.searchCacheEntry(key); } catch (e) { cacheFailures++; log({ event: "si_cache_read_failed", error: e.code ?? e.message }); return null; } }
  async function cachePut(key, value, ttlS) { if (ttlS <= 0) return; try { await store.searchCachePut(key, value, ttlS); } catch (e) { cacheFailures++; log({ event: "si_cache_write_failed", error: e.code ?? e.message }); } }

  // ---- one lane --------------------------------------------------------------------------------------------------------------
  // Runs one adapter for one subject within its own deadline; never throws. pre is the preflight already taken.
  async function runLane({ adapter, sub, pre, request, selection, signal, deadlineAt, kind = "search", useCache = true }) {
    const t0 = clock();
    const L = limits(), ttl = (o) => (o.status === "success_empty" ? L.cacheSeconds.empty : timeSensitive(request) ? L.cacheSeconds.timeSensitive : L.cacheSeconds.success);
    const pkey = useCache && adapter.cacheIdentity ? providerKey(adapter, request, selection) : null;
    if (pkey) {
      const hit = await cacheEntry(pkey);
      if (hit?.response?.status && ["success_results", "success_empty"].includes(hit.response.status)) {
        return { ...outcome({ ...hit.response, provider: adapter.id, fromCache: true, durationMs: clock() - t0, dispatchState: "not_sent", originalRetrievedAt: hit.response.originalRetrievedAt ?? hit.createdAt?.toISOString?.() ?? null }), cacheExpiresAt: hit.expiresAt?.getTime?.() ?? null };
      }
    }
    const child = new AbortController();
    const onParent = () => child.abort();
    signal.addEventListener("abort", onParent, { once: true });
    if (signal.aborted) child.abort();
    let timer;
    const work = track((async () => {
      try { return await adapter.search(request, { sub, pre, signal: child.signal, deadlineAt, selection, kind }); }
      catch (e) { log({ event: "si_adapter_threw", provider: adapter.id, error: e?.message?.slice(0, 200) }); return failed(adapter.id, "internal_failure", "adapter_threw", { kind }); }
      finally {
        // Exactly one close per reservation does not rest on the adapter remembering it: whatever it left open is uncertain now.
        const left = pre ? await dispatch.closeUnclosed?.(pre, "the adapter ended without closing its reservation") : 0;
        if (left) log({ event: "si_unclosed_reservation", provider: adapter.id, count: left });
      }
    })());
    // The lane's hard bound: past its deadline (plus a short grace for the transport's own timer) it is cancelled and reported
    // as timed out; the adapter keeps closing its reservation in the background, tracked, and can send nothing more. The grace
    // stays within half the response margin, so a lane whose deadline is the search's last moment still leaves time to answer.
    const grace = Math.min(250, Math.floor(L.responseMarginMs / 2));
    const bound = new Promise((resolve) => { timer = setTimeout(() => { child.abort(); resolve(failed(adapter.id, signal.aborted ? "cancelled" : "timeout", "lane_deadline", { kind, dispatchState: "possibly_sent" })); }, Math.max(0, deadlineAt - clock()) + grace); });
    let o;
    try { o = await Promise.race([work, bound]); }
    finally { clearTimeout(timer); signal.removeEventListener("abort", onParent); }
    o = { ...o, durationMs: clock() - t0, kind };
    if (pkey && ["success_results", "success_empty"].includes(o.status)) {
      const { candidates, upstreamResultCount, status, providerRequestId, usage, constraints, suboperations, auxiliaryContext } = o;
      await cachePut(pkey, { status, candidates, upstreamResultCount, providerRequestId, usage, constraints, suboperations, auxiliaryContext, originalRetrievedAt: o.completedAt }, ttl(o));
      o.cacheExpiresAt = clock() + ttl(o) * 1000;
    }
    return o;
  }

  // Preflight for one roster subject: eligible ({ sub, pre }) or a skipped outcome. A rate limit that lifts within two seconds,
  // well inside the discovery window, is waited out rather than skipped.
  async function admitLane(adapter, map, subjectName, request, selection, signal, closeAt) {
    // A missing adapter is reported under its API's lane id, as every other outcome is.
    if (!adapter) return { skip: skipped(SEARCH_APIS[dispatch.subject(map, subjectName)?.prov?.api]?.lane ?? subjectName, "not_configured", "adapter_missing") };
    const sub = dispatch.subject(map, subjectName);
    let pre = dispatch.preflight(sub, { selection, breakerState: adapter.breakerState });
    if (!pre.eligible && pre.reason === "rate_limited" && pre.retryAt && pre.retryAt - clock() <= Math.min(2000, closeAt - clock() - 1000)) {
      await sleep(Math.max(0, pre.retryAt - clock()), signal);
      await availability.refresh();
      pre = dispatch.preflight(sub, { selection, breakerState: adapter.breakerState });
    }
    if (!pre.eligible) return { skip: skipped(adapter.id, pre.reason, pre.detail, { retryAt: pre.retryAt ? iso(pre.retryAt) : null }) };
    const rep = adapter.representable?.(request) ?? { ok: true };
    if (!rep.ok) return { skip: skipped(adapter.id, "unsupported_request", rep.detail) };
    return { sub, pre };
  }

  // ---- the execution ---------------------------------------------------------------------------------------------------------
  async function execute(request, signal, roster, selection, aggKey) {
    const L = limits(), tAdmit = clock();
    const cached = await cacheEntry(aggKey);
    if (cached?.response?.search) return { body: cached.response, aggregateHit: { createdAt: cached.createdAt, expiresAt: cached.expiresAt } };
    const adm = await store.admitSearchQuery(getPolicy().search.perHour);
    if (!adm.admitted) throw new Denied("SEARCH_RATE_LIMITED", `${getPolicy().search.perHour} searches reached the backend in the last hour`, { retryable: true, retryAfter: 60 });
    await availability.refresh();
    telemetry?.runStarted?.({ request, selection, roster, admittedAt: iso(tAdmit), configHashes: getConfigHashes() });
    const margin = L.responseMarginMs, hardEnd = request.absoluteDeadlineMs - margin;
    const discoveryClose = Math.min(tAdmit + L.discoveryMs, hardEnd);
    const parent = new AbortController();
    const onCaller = () => parent.abort();
    signal.addEventListener("abort", onCaller, { once: true });
    if (signal.aborted) parent.abort();
    const timings = { admittedAt: iso(tAdmit) };
    try {
      if (!roster) throw new Denied("SEARCH_BACKEND_UNAVAILABLE", "the aggregate profile has no roster for this selection");
      // SearXNG: alongside (additional), or as fallback when a general lane is ineligible now or fails while two seconds remain,
      // or as augmentation when every general answer is empty. At most one orchestration.
      const mode = getBudget().searching.searxngMode;
      let searxngTask = null, searxngWhy = null;
      const launchSearxng = (why) => {
        // Nothing new starts for a search that is cancelled or past its deadline.
        if (searxngTask || !searxng || parent.signal.aborted) return;
        if (why !== "additional" && discoveryClose - clock() < 2000) return;
        searxngWhy = why;
        searxngTask = runLane({ adapter: searxng, sub: null, pre: null, request, selection, signal: parent.signal, deadlineAt: Math.min(discoveryClose, clock() + L.providerTimeoutsMs.searxng), useCache: false });
      };
      if (mode === "additional") launchSearxng("additional");
      // 3. General lanes: each is admitted and launched on its own, so a lane waiting out a short rate limit holds back no other
      // (spec §5.1: launch every eligible lane before awaiting any result). A lane task never rejects.
      const generalAdapters = roster.generalSubjects.map((name) => adapterFor("searches", name, general));
      const generalTasks = roster.generalSubjects.map((name, i) => (async () => {
        const adapter = generalAdapters[i];
        const a = await admitLane(adapter, "searches", name, request, selection, parent.signal, discoveryClose);
        if (a.skip) { launchSearxng("general_lane_ineligible"); return a.skip; }
        return runLane({ adapter, sub: a.sub, pre: a.pre, request, selection, signal: parent.signal, deadlineAt: Math.min(discoveryClose, clock() + L.providerTimeoutsMs[adapter.id]) });
      })().catch((e) => {
        log({ event: "si_admission_threw", subject: name, error: e?.message?.slice(0, 200) });
        return failed(generalAdapters[i]?.id ?? name, "internal_failure", "admission_threw");
      }));
      generalTasks.forEach((t) => t.then((o) => { if (mode === "fallback" && o.status === "failed") launchSearxng("general_lane_failed"); }));
      // 4. Documentation: activation decided now when explicit, otherwise in parallel with discovery (spec §13).
      let docsTasks = [], activation = { active: false, reason: "documentation_layer_unavailable", classifierVersion: VERSIONS.classifier, uncertainty: null };
      const docsReady = (async () => {
        if (!documentation || !roster.documentationSubjects) return;
        activation = await documentation.activate(request, { signal: parent.signal, deadlineAt: Math.min(discoveryClose, clock() + L.classifierMs), selection, decisionSubject: roster.decisionSubject });
        if (!activation.active) return;
        const tDocs = clock();
        timings.documentationActivatedMs = tDocs - tAdmit;
        const docsAdapters = roster.documentationSubjects.map((name) => adapterFor("documentationSearches", name, docs));
        const admits = await Promise.all(roster.documentationSubjects.map((name, i) => admitLane(docsAdapters[i], "documentationSearches", name, request, selection, parent.signal, discoveryClose)));
        docsTasks = admits.map((a, i) => a.skip ? Promise.resolve(a.skip)
          : runLane({ adapter: docsAdapters[i], sub: a.sub, pre: a.pre, request, selection, signal: parent.signal, deadlineAt: Math.min(discoveryClose, tDocs + L.providerTimeoutsMs[docsAdapters[i].id]), kind: "docs_search" }));
      })();
      const generalOutcomes = await Promise.all(generalTasks);
      if (mode === "fallback" && !searxngTask && generalOutcomes.every((o) => o.status === "success_empty" || o.status === "skipped" || o.status === "failed")) launchSearxng("no_general_results");
      await docsReady;
      const docsOutcomes = await Promise.all(docsTasks);
      const searxngOutcome = searxngTask ? await searxngTask : null;
      timings.discoveryMs = clock() - tAdmit;
      if (parent.signal.aborted && signal.aborted) throw new Denied("CANCELLED", "the caller cancelled");

      // 5. Normalize, constrain, pool, fuse.
      const all = [...generalOutcomes, ...docsOutcomes, ...(searxngOutcome ? [searxngOutcome] : [])];
      const prepared = all.filter(validated).map((o) => ({ o, ...prepareCandidates(o.provider, o.candidates, request.constraints) }));
      for (const p of prepared) if (p.o.status !== "partial" && p.o.candidates.length && !p.kept.length) p.o.filteredEmpty = true;
      const { pool, distinct, truncatedPassages } = buildPool(prepared.map((p) => ({ provider: p.o.provider, kept: p.kept, retrievedAt: p.o.originalRetrievedAt ?? p.o.completedAt, fromCache: p.o.fromCache })),
        { poolMax: L.candidates.poolMax, workingSetBytes: L.workingSetBytes });
      const auxiliaryContext = docsOutcomes.flatMap((o) => (validated(o) ? o.auxiliaryContext : []));
      const evidenceLanes = all.filter(validated);
      if (!evidenceLanes.length) {
        const reasons = all.map((o) => `${o.provider}: ${o.reason ?? o.status}`).join(", ");
        telemetry?.runFinished?.({ request, outcome: "failed", lanes: all, timings });
        throw new Denied("SEARCH_ENGINES_FAILED", `no search provider answered (${reasons})`, { retryable: true, retryAfter: 60 });
      }
      fuse(pool);
      for (const d of pool) d.literal = literalRelevance(d, request.originalQuery, request.intelligence);
      const presemantic = [...pool].sort((a, b) => b.fusion.rrf - a.fusion.rrf || b.literal - a.literal || (a.documentId < b.documentId ? -1 : 1));
      presemantic.forEach((d, i) => { d.presemanticRank = i + 1; });
      const providersPresent = [...new Set(evidenceLanes.map((o) => o.provider))];
      const short = shortlist(pool, { max: L.candidates.shortlistMax, seedPerProvider: L.candidates.seedPerProvider, providers: providersPresent.filter((p) => p !== "searxng").concat(providersPresent.includes("searxng") ? ["searxng"] : []) });
      // 5b. Semantic phase (spec §11.2): Jev's advice within its own budget, never past the request's.
      const semanticClose = Math.min(clock() + L.semanticMs, hardEnd);
      let ranking = { mode: "rrf_fallback", reason: decisions ? "semantic_not_run" : "jev_not_configured", version: VERSIONS.ranker, shortlisted: short.length, scored: 0 };
      if (decisions && roster.decisionSubject && semanticClose - clock() > 500) {
        const t = clock();
        const sem = await decisions.rerank({ request, shortlist: short, pool, selection, decisionSubject: roster.decisionSubject, signal: parent.signal, deadlineAt: semanticClose, docsOutcomes, docs });
        timings.semanticMs = clock() - t;
        ranking = { ...ranking, ...sem.ranking };
      } else if (decisions && roster.decisionSubject) ranking.reason = "no_time_for_semantic_phase";
      for (const d of pool) d.score = d.semantic?.complete && ranking.mode !== "rrf_fallback" ? blend(d.fusion.normalized, d.semantic).S : d.fusion.normalized;
      const singleDomain = request.constraints.includeDomains.length === 1;
      const ranked = [...pool].sort((a, b) => b.score - a.score || (a.documentId < b.documentId ? -1 : 1));
      ranked.forEach((d, i) => { d.semanticRank = d.semantic?.complete ? i + 1 : null; });
      const final = selectFinal(ranked, request.limit, { singleDomain });

      // 6. Outcome and response.
      const generalOk = generalOutcomes.filter(validated), docsActive = activation.active;
      const generalMissing = generalOutcomes.filter((o) => !validated(o) || o.status === "partial");
      const docsMissing = docsActive ? docsOutcomes.filter((o) => !validated(o) || o.status === "partial") : [];
      const complete = !generalMissing.length && !docsMissing.length && (!docsActive || docsOutcomes.length === DOCUMENTATION.length);
      const lanes = [...generalOutcomes, ...docsOutcomes];
      const summary = Object.fromEntries([...lanes, ...(searxngOutcome ? [searxngOutcome] : [])].map((o) => [o.provider, { status: o.status, reason: o.reason, detail: o.detail, fromCache: o.fromCache,
        elapsedMs: o.durationMs, queueMs: o.queueMs, resultCount: o.upstreamResultCount, eligibleCount: o.candidates.length, filteredEmpty: !!o.filteredEmpty, dispatchState: o.dispatchState, ...(o.retryAt ? { retryAt: iso(o.retryAt) } : {}),
        ...(o.suboperations?.length ? { suboperations: o.suboperations.slice(0, 12) } : {}) }]));
      const warnings = [];
      for (const o of [...generalMissing, ...docsMissing]) warnings.push(`${o.provider}_${o.status === "partial" ? "partial" : o.reason}`);
      if (ranking.mode === "rrf_fallback" && decisions) warnings.push(`ranking_${ranking.reason}`);
      if (ranking.mode === "hybrid_partial") warnings.push("ranking_partial_semantic");
      if (auxiliaryContext.length) warnings.push("documentation_auxiliary_context");
      const coverage = {
        general: { requested: GENERAL.length, successful: generalOk.length, fromCache: generalOk.filter((o) => o.fromCache).length, missing: generalMissing.map((o) => ({ provider: o.provider, status: o.status, reason: o.reason })) },
        documentation: { activated: docsActive, reason: activation.reason, requested: docsActive ? DOCUMENTATION.length : 0, successful: docsOutcomes.filter(validated).length, missing: docsMissing.map((o) => ({ provider: o.provider, status: o.status, reason: o.reason })) },
        searxng: { used: !!searxngOutcome, why: searxngWhy, status: searxngOutcome?.status ?? null, reason: searxngOutcome?.reason ?? null },
        decisions: { status: ranking.mode === "rrf_fallback" ? (decisions ? "not_used" : "not_configured") : ranking.mode, reason: ranking.reason },
      };
      const usage = lanes.filter((o) => o.usage && !o.fromCache).map((o) => ({ provider: o.provider, ...o.usage })).concat(ranking.usage ?? []);
      const search = {
        schema: RESPONSE_SCHEMA, logicalSearchId: request.logicalSearchId, requestId: request.requestId, profile: "aggregate", selection,
        outcome: complete ? "complete" : "partial", empty: final.length === 0, ...(final.length === 0 && prepared.some((p) => p.o.filteredEmpty) ? { filteredEmpty: true } : {}),
        coverage, providers: summary, documentation: { activation, auxiliaryContext: boundAux(auxiliaryContext) },
        ranking: { mode: ranking.mode, reason: ranking.reason, version: VERSIONS.ranker, shortlisted: ranking.shortlisted, scored: ranking.scored, model: ranking.model ?? null },
        cache: { mode: lanes.some((o) => o.fromCache) ? "partial_reuse" : "miss", servedAt: iso(clock()), originalRetrievedAt: oldest(lanes) },
        timings: { ...timings, totalMs: clock() - tAdmit }, pool: { candidates: all.reduce((n, o) => n + o.candidates.length, 0), distinct, pooled: pool.length, shortlisted: short.length, returned: final.length, truncatedPassages },
        warnings, usage, versions: VERSIONS,
      };
      const web = final.map((d) => ({ url: d.displayUrl, title: d.title, description: d.description, fcpi: { search: rowMeta(d) } }));
      const body = { schema: "fcpi.search-response/v1", web, ...(warnings.length ? { warning: warningText(search) } : {}), search };
      // A complete, fully ranked answer is the only one stored whole; it expires with its oldest input (spec §17). Fully ranked is
      // hybrid, or the deterministic ranking when no decision layer is configured: nothing is waiting to recover, and the key
      // carries the decision layer's identity, so configuring one later never serves this entry. A fallback from a configured
      // layer that failed is degraded and is not stored.
      const fullyRanked = ranking.mode === "hybrid" || (ranking.mode === "rrf_fallback" && ranking.reason === "jev_not_configured");
      if (complete && fullyRanked) {
        const expiries = lanes.filter(validated).map((o) => o.cacheExpiresAt ?? clock() + L.cacheSeconds.success * 1000);
        const ttlS = Math.floor((Math.min(...expiries) - clock()) / 1000);
        await cachePut(aggKey, body, ttlS);
      }
      telemetry?.runFinished?.({ request, outcome: search.outcome, search, lanes: all, pool, final, ranking, timings: search.timings });
      return { body, pool, final };
    } finally {
      signal.removeEventListener("abort", onCaller);
    }
  }

  // ---- in-flight sharing (spec §14.2, §17) -----------------------------------------------------------------------------------
  async function search(raw, { signal }) {
    const request = validateSearchRequest(raw, clock());
    const S = getBudget().searching, selection = getSelection().search;
    if (S.profile === "legacy") return legacyAsInternal(request, signal);
    const roster = rosterFor(selection), aggKey = aggregateKey(request, roster, selection);
    const deadlineClass = request.absoluteDeadlineMs - clock() < 20000 ? "short" : "normal";
    let flight = flights.get(aggKey);
    // Abandoned or expired work is never joinable: closing a flight takes it out of the map before aborting it, so an identical
    // search arriving while the abandoned one winds down starts its own execution.
    const close = (fl) => { fl.closed = true; if (flights.get(aggKey) === fl) flights.delete(aggKey); fl.controller.abort(); };
    if (!flight || flight.deadlineClass !== deadlineClass || flight.closed) {
      const controller = new AbortController();
      flight = { deadlineClass, subscribers: 0, controller, closed: false, logicalSearchId: request.logicalSearchId };
      const fl = flight;
      const deadlineTimer = setTimeout(() => close(fl), Math.max(0, request.absoluteDeadlineMs - clock()));
      flight.promise = track(execute(request, controller.signal, roster, selection, aggKey).finally(() => { clearTimeout(deadlineTimer); fl.closed = true; if (flights.get(aggKey) === fl) flights.delete(aggKey); }));
      flights.set(aggKey, flight);
    }
    const f = flight;
    f.subscribers++;
    const leave = () => { f.subscribers--; if (f.subscribers <= 0 && !f.closed) close(f); };
    let onAbort, timer;
    try {
      const gone = new Promise((_, reject) => {
        onAbort = () => reject(new Denied("CANCELLED", "the caller cancelled"));
        signal?.addEventListener("abort", onAbort, { once: true });
        timer = setTimeout(() => reject(new Denied("SEARCH_TIMEOUT", "the search did not finish within its deadline", { retryable: true })), Math.max(0, request.absoluteDeadlineMs - clock()));
        if (signal?.aborted) onAbort();
      });
      const r = await Promise.race([f.promise, gone]);
      return { status: 200, body: personalize(r, request, f) };
    } finally {
      clearTimeout(timer); signal?.removeEventListener("abort", onAbort); leave();
    }
  }
  // Each caller gets its own request id; a shared execution's logical id stays the one it ran under; a cache hit is reuse.
  function personalize(r, request, f) {
    const body = structuredClone(r.body);
    body.search.requestId = request.requestId;
    if (f.logicalSearchId !== request.logicalSearchId) { body.search.coalesced = true; body.search.callerLogicalSearchId = request.logicalSearchId; }
    if (r.aggregateHit) {
      body.search.cache = { mode: "hit", servedAt: iso(clock()), originalRetrievedAt: body.search.cache?.originalRetrievedAt ?? null, storedAt: iso(new Date(r.aggregateHit.createdAt).getTime()), expiresAt: iso(new Date(r.aggregateHit.expiresAt).getTime()) };
      for (const p of Object.values(body.search.providers)) p.fromCache = true;
      body.search.usage = [];
      body.search.reuseOf = body.search.logicalSearchId;
      body.search.logicalSearchId = request.logicalSearchId;
    }
    return body;
  }

  // The legacy profile behind the new internal route (spec §28: legacy is the explicit rollback): the accepted search,
  // its answer carried in the new response shape.
  async function legacyAsInternal(request, signal) {
    if (!legacy) throw new Denied("SEARCH_BACKEND_UNAVAILABLE", "the legacy profile is not available");
    const u = new URL("http://x/searxng/search");
    u.searchParams.set("q", request.originalQuery);
    // The legacy facade takes letters and hyphens, at most 16 (search.mjs); a tag it would refuse, such as es-419, keeps its
    // primary subtag: SearXNG and Serper then search that language without the region, rather than refusing the search.
    const language = request.language === "auto" || /^[A-Za-z-]{1,16}$/.test(request.language) ? request.language : request.language.split("-")[0];
    u.searchParams.set("language", language);
    const r = await legacy(u.pathname + u.search, signal);
    const b = r.body;
    const web = b.results.slice(0, request.limit).map((x) => ({ url: x.url, title: x.title, description: x.content }));
    const partial = (b.unresponsive_engines ?? []).length > 0;
    return { status: 200, body: { schema: "fcpi.search-response/v1", web, ...(partial ? { warning: `Partial search result: ${b.unresponsive_engines.length} engine(s) did not answer (${b.unresponsive_engines.map((u) => `${u.engine}: ${u.reason || "no reason"}`).join("; ")}).` } : {}),
      search: { schema: RESPONSE_SCHEMA, logicalSearchId: request.logicalSearchId, requestId: request.requestId, profile: "legacy", outcome: partial ? "partial" : "complete", empty: web.length === 0,
        legacy: { engines: b.fcpi?.engines ?? [], answered: b.fcpi?.answered ?? [], unresponsive: b.unresponsive_engines ?? [], cache: b.fcpi?.cache ?? null, provider: b.fcpi?.provider ?? null } } } };
  }

  // The legacy internal GET (spec §19.2): an aggregate search with validated defaults and explicit legacy attribution, answered
  // in SearXNG's shape for a core that still calls it.
  async function legacyGet(inboundUrl, signal) {
    const inbound = new URL(inboundUrl, "http://x");
    const q = inbound.searchParams.get("q") ?? "";
    if (!q.trim() || q.length > 500) throw new Denied("INVALID_REQUEST", "the query must be 1-500 characters");
    if (Number(inbound.searchParams.get("pageno") ?? "1") !== 1) throw new Denied("INVALID_REQUEST", "only the first page of results is served (pageno=1)");
    const language = inbound.searchParams.get("language") || "auto";
    if (!/^[A-Za-z-]{1,16}$/.test(language)) throw new Denied("INVALID_REQUEST", "language must be a language tag");
    if (getBudget().searching.profile === "legacy" && legacy) return legacy(inboundUrl, signal);
    const r = await search({ schema: "fcpi.search-request/v1", requestId: `legacy-internal-${randomUUID()}`, logicalSearchId: randomUUID(), principalId: "legacy-internal",
      originalQuery: q, limit: 10, language: /^(auto|[A-Za-z]{2,8}(-[A-Za-z0-9]{1,8}){0,2})$/.test(language) ? language : "auto", constraints: {}, intelligence: {}, resultMode: "links", absoluteDeadlineMs: clock() + 14000 }, { signal });
    const s = r.body.search;
    const unresponsive = [...s.coverage.general.missing, ...s.coverage.documentation.missing].map((m) => ({ engine: m.provider, reason: m.reason ?? m.status }));
    return { status: 200, body: { results: r.body.web.map((w) => ({ url: w.url, title: w.title, content: w.description })), unresponsive_engines: unresponsive,
      fcpi: { cache: s.cache.mode === "hit" ? "hit" : "miss", engines: Object.keys(s.providers), answered: Object.entries(s.providers).filter(([, p]) => ["success_results", "success_empty", "partial"].includes(p.status)).map(([k]) => k),
        partial: s.outcome === "partial", empty: s.empty, profile: "aggregate", logicalSearchId: s.logicalSearchId } } };
  }

  async function drain(ms) {
    const until = clock() + ms;
    for (const f of flights.values()) f.controller.abort();
    while (tasks.size && clock() < until) await sleep(50);
    return tasks.size;
  }
  return { search, legacyGet, drain, tasks: () => tasks.size, counters: () => ({ accountingFailures: dispatch.counters?.().accountingFailures ?? 0, cacheFailures }), aggregateKey };
}

const oldest = (lanes) => {
  const ts = lanes.filter((o) => validated(o)).map((o) => o.originalRetrievedAt ?? o.completedAt).filter(Boolean).sort();
  return ts[0] ?? null;
};

// The row's bounded metadata (spec §9.4): identity, provenance, documentation scope, a few passages, ranks and features.
function rowMeta(d) {
  return {
    documentId: d.documentId, canonicalUrl: d.canonicalUrl, originalUrls: d.originalUrls.slice(0, 5),
    observations: d.observations.map((o) => ({ provider: o.provider, rank: o.rank, fromCache: !!o.fromCache, ...(o.fragment ? { fragment: o.fragment } : {}) })),
    ...(d.publication ? { publication: d.publication } : {}), ...(d.documentation ? { documentation: d.documentation } : {}),
    passages: d.passages.slice(0, 3).map((p) => ({ passageId: p.passageId, kind: p.kind, provider: p.provider, sourceUrl: p.sourceUrl ?? null, text: String(p.text ?? "").slice(0, 600), truncated: String(p.text ?? "").length > 600,
      contentHash: p.contentHash, libraryId: p.libraryId ?? null, requestedVersion: p.requestedVersion ?? null, observedVersion: p.observedVersion ?? null, language: p.language ?? null, completeness: p.completeness ?? "excerpt" })),
    ranks: { presemantic: d.presemanticRank, semantic: d.semanticRank ?? null, final: d.finalRank },
    scores: { rrf: round(d.fusion.rrf), normalized: round(d.fusion.normalized), literal: round(d.literal), ...(d.semantic?.complete ? { semantic: d.semantic.public } : {}), final: round(d.score) },
    constraintStatus: d.constraintStatus, ...(d.softGroup ? { softGroup: d.softGroup } : {}), ...(d.displaced ? { displaced: d.displaced } : {}),
  };
}
const round = (x) => (Number.isFinite(x) ? Math.round(x * 1e6) / 1e6 : null);

// Auxiliary documentation context (spec §6.3): source-less provider passages, bounded deterministically with provenance kept.
export function boundAux(entries, maxEntries = 12, maxText = 1500) {
  return entries.slice(0, maxEntries).map((e) => ({ ...e, text: String(e.text).slice(0, maxText), ...(String(e.text).length > maxText ? { truncated: { kept: maxText, observed: String(e.text).length } } : {}) }))
    .concat(entries.length > maxEntries ? [{ omitted: entries.length - maxEntries }] : []);
}

// The human-readable warning, derived from the codes (never from a provider's own error text).
function warningText(s) {
  const parts = [];
  const miss = [...s.coverage.general.missing, ...s.coverage.documentation.missing];
  if (miss.length) parts.push(`Partial search coverage: ${miss.map((m) => `${LABEL[m.provider] ?? m.provider} ${m.status === "partial" ? "answered in part" : REASON_TEXT[m.reason] ?? m.reason}`).join("; ")}.`);
  if (s.ranking.mode === "rrf_fallback" && s.coverage.decisions.status !== "not_configured") parts.push(`Deterministic ranking used (${s.ranking.reason.replaceAll("_", " ")}).`);
  if (s.ranking.mode === "hybrid_partial") parts.push("Semantic ranking covered only part of the candidates.");
  if (s.documentation.auxiliaryContext.length) parts.push("Some documentation had no original source URL and is returned separately as auxiliary context.");
  return parts.join(" ");
}
