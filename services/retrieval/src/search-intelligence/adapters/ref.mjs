// Ref over MCP (docs/FIRECRAWL_PI_SEARCH_INTELLIGENCE_SPEC.md §6.2; contract verified 2026-10-17 in
// evidence/search-intelligence/SI0/provider-contracts-2026-10-17.md §6): Streamable HTTP at api.ref.tools/mcp with the
// x-ref-api-key header, through the official MCP client and ref-bridge.mjs's policy-checked fetch (the session's endpoint only,
// no redirects, bounded bodies, a request permit per POST, a stream slot for the optional receive stream, no reconnection).
//   - One isolated session per logical search, never shared: Ref suppresses repeated results and conditions reads on the
//     session's searches. Its lease goes to the coordinator, which closes it after any selected reads.
//   - Billable: ref_search_documentation and ref_read_url, one credit each, each its own metered operation. Initialization,
//     tool listing and session close are bounded protocol exchanges, recorded but not metered.
//   - Answers: the hosted server answers each search result as its own text block, a description (page='…' section='…', or a
//     breadcrumb) then the result's URL alone on the last line (live contract smoke 2026-10-18,
//     evidence/search-intelligence/SI5/live-smoke.json); the legacy text blocks ("overview: …\nurl: …\nmoduleId: …") and the exact
//     "No results found" sentinel are recognized too. Known error texts (which arrive without isError) and isError are failures;
//     any other text is a contract failure, never an empty result. A URL inside an error is never a hit. No JSON results envelope
//     is assumed. A read is a query-conditioned excerpt, never a full document.
//   - Verdicts: each billable call is one (dispatch.meter's fail() for a call without a usable answer, report() for an answer);
//     a session that fails to open or lacks the tools counts only as an unmetered exchange (dispatch.observe).
import { outcome } from "../contracts.mjs";
import { sha256, contentHash, normalizeQueryText, normalizeUrl } from "../normalize.mjs";
import { mcpFailure } from "./common.mjs";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";

export const REF_CONTRACT = "ref-mcp-v1/2026-10-18";
export const NO_RESULTS = "No results found";
// Selected reads (spec §6.2): at most two a logical execution, for documents whose passages hold no excerpt of this length.
export const MAX_READS = 2, USEFUL_EXCERPT_CHARS = 200;
// Less time than this left for a read (the policy's floor for refReadMs) and none is started: it would be written and lost.
export const READ_MIN_MS = 500;
// Ref's refusals are whole messages with fixed openings (SI0 contract evidence §6). They are matched only at the start of a
// text block that is not a result: a result's overview or a read's page may quote the same words about something else, and
// provider-relayed documentation is data, never a signal about this account. A block is first tried as a result (a hosted
// block's description has its own shape), so a result whose breadcrumb says "unauthorized" stays a result.
const AUTH = [/^Ref is not correctly configured\b/i, /^Please verify your email at https:\/\/ref\.tools\b/i, /^(Error:\s*)?(invalid api key|unauthori[sz]ed)\b/i];
const QUOTA = [/^(Error:\s*)?((out of|no remaining|insufficient|not enough) credits|credit limit (reached|exceeded))\b/i];
const SEARCH_ERRORS = [/^Error during documentation search:/i, /^Error:/i];
// A read's success is the page itself, which may begin with anything ("Unauthorized" on a target's own 401 page): only Ref's
// documented read refusals count.
const READ_AUTH = AUTH.slice(0, 2), READ_ERRORS = [/^Error reading URL:/i];

// Ref's legacy result blocks, read line by line in linear time: a line opening "overview:" (the overview may run over several
// lines), then "url: <url>", then "moduleId:" on the very next line. A url line not followed by moduleId is overview text.
function blocksOf(text) {
  const out = [], lines = text.split(/\r?\n/);
  let overview = null;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.startsWith("overview:")) { overview = [line.slice(9).replace(/^[ \t]/, "")]; continue; }
    if (overview === null) continue;
    const u = /^url:[ \t]?(\S+)[ \t]*$/.exec(line);
    if (u && lines[i + 1]?.startsWith("moduleId:")) {
      const ov = overview.join("\n"), moduleId = lines[i + 1].slice(9).replace(/^[ \t]/, "");
      out.push({ overview: ov, url: u[1], moduleId, title: moduleId.trim() || ov.split(/[.\n]/)[0] });
      overview = null;
      i++;
      continue;
    }
    overview.push(line);
  }
  return out;
}
// The hosted result block: one result per text block, its description first and its URL alone on the last line. The
// description has one of the two shapes Ref's hosted service sends: page='…' and section='…' fields, or a breadcrumb
// (a > b). Any other text that ends in a URL (a notice with a link) is not a result.
const HOSTED_SHAPE = /\bpage='|\bsection='|\S > \S/;
function hostedBlockOf(text) {
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  if (lines.length < 2 || !/^https?:\/\/\S+$/.test(lines.at(-1))) return null;
  const head = lines.slice(0, -1).join("\n");
  if (!HOSTED_SHAPE.test(head)) return null;
  // A field's value runs to its closing quote before the next field or the line's end, so an apostrophe inside it stays.
  const page = /\bpage='(.*?)'(?=\s+section='|\s*$)/m.exec(head)?.[1] ?? null, section = /\bsection='(.*)'\s*$/m.exec(head)?.[1] ?? null;
  return { url: lines.at(-1), overview: page || section ? [page, section].filter(Boolean).join(" — ") : head, moduleId: page ?? "", title: page || lines[0] };
}

const textsOf = (result) => (Array.isArray(result?.content) ? result.content.filter((c) => c?.type === "text" && typeof c.text === "string").map((c) => c.text) : null);
function classifyError(text, { auth = AUTH, errors = SEARCH_ERRORS } = {}) {
  const t = text.trim();
  if (auth.some((r) => r.test(t))) return { kind: "error", reason: "auth_failed", detail: "ref_auth_text" };
  if (QUOTA.some((r) => r.test(t))) return { kind: "error", reason: "quota_exhausted", detail: "ref_quota_text" };
  if (errors.some((r) => r.test(t))) return { kind: "error", reason: "temporarily_unavailable", detail: "ref_error_text" };
  return null;
}

// A search tool result: { kind: "results", docs: [{ url, overview, moduleId }] } | { kind: "empty" } | { kind: "error", reason, detail } |
// { kind: "contract", detail }. Results first, then the exact no-results sentinel, then a leading refusal; anything else is a
// contract failure, never an empty result. A URL inside an error is never a hit.
export function parseRefSearch(result) {
  const texts = textsOf(result);
  if (!texts) return { kind: "contract", detail: "ref_no_content" };
  if (result.isError) return classifyError(texts.join("\n")) ?? { kind: "error", reason: "temporarily_unavailable", detail: "ref_is_error" };
  // A block is a result when it parses as one; otherwise one that opens with a refusal is an error whatever it quotes.
  const refusals = texts.map(() => null);
  const docs = [];
  texts.forEach((t, i) => {
    const legacy = blocksOf(t), hosted = legacy.length ? null : hostedBlockOf(t);
    if (!legacy.length && !hosted) { refusals[i] = classifyError(t); return; }
    for (const b of legacy.length ? legacy : [hosted]) if (normalizeUrl(b.url)) docs.push({ url: b.url, overview: b.overview.trim().slice(0, 2000), moduleId: b.moduleId.trim().slice(0, 300), title: b.title.trim().slice(0, 300) });
  });
  if (docs.length) return { kind: "results", docs };
  if (texts.length === 1 && texts[0].trim() === NO_RESULTS) return { kind: "empty" };
  return refusals.find(Boolean) ?? { kind: "contract", detail: "ref_unrecognized_text" };
}
// A read tool result: { kind: "text", text } | { kind: "error", … } | { kind: "contract", … }. Judged by isError or by its
// first block opening with one of Ref's read refusals; the rest is the page.
export function parseRefRead(result, maxChars) {
  const texts = textsOf(result);
  if (!texts) return { kind: "contract", detail: "ref_no_content" };
  const joined = texts.join("\n");
  if (result.isError) return classifyError(joined, { auth: READ_AUTH, errors: READ_ERRORS }) ?? { kind: "error", reason: "temporarily_unavailable", detail: "ref_is_error" };
  const err = texts.length ? classifyError(texts[0], { auth: READ_AUTH, errors: READ_ERRORS }) : null;
  if (err) return err;
  if (!joined.trim()) return { kind: "contract", detail: "ref_empty_read" };
  return { kind: "text", text: joined.slice(0, maxChars), truncated: joined.length > maxChars };
}

// The query sent to Ref: the original, plus the caller's library and language hints Ref's tool asks for when absent from it.
// Ref's own query directives (ref_src=private and any other ref_<name>=<value>) are never taken from caller text (spec §6.2):
// this adapter searches public documentation only. The cache identity is this query, so it carries the scrubbed form too.
const REF_DIRECTIVE = /(^|\s)ref_[a-z0-9_]*\s*=\s*\S*/gi;
const scrub = (s) => String(s).replace(REF_DIRECTIVE, " ").replace(/\s+/g, " ").trim();
export function refQuery(request) {
  const q = scrub(normalizeQueryText(request.originalQuery)), low = q.toLowerCase();
  const hints = [...(request.intelligence.libraries ?? []).map((l) => scrub(l.version ? `${l.name} ${l.version}` : l.name)), request.intelligence.programmingLanguage ? scrub(request.intelligence.programmingLanguage) : null]
    .filter((h) => h && !low.includes(h.toLowerCase()));
  return [q, ...hints].join(" ").slice(0, 500);
}

// The sessions server.mjs gives the adapter: the official MCP client (pinned 2.1.0) in its default 2025-era handshake, over
// ref-bridge.mjs's fetch. Reconnection is off: a dropped stream is a limitation, never a replay. Each session lists its tools
// once; op() gives a billable call its handle on the bridge (whether its request was written; withdrawing it if not).
export function makeRefSessionFactory({ makeFetch, clientInfo = { name: "fcpi-retrieval", version: "1" }, log = () => {} }) {
  return async function openSession({ sub, pre, request, signal, deadlineAt }) {
    const endpoint = new URL(`${sub.prov.baseUrl.replace(/\/$/, "")}/mcp`);
    const bridge = makeFetch({ sub, key: pre.key, searchId: request.logicalSearchId, endpoint, signal, deadlineAt });
    const transport = new StreamableHTTPClientTransport(endpoint, { fetch: bridge.fetch,
      reconnectionOptions: { maxRetries: 0, initialReconnectionDelay: 1000, maxReconnectionDelay: 1000, reconnectionDelayGrowFactor: 1 } });
    const client = new Client(clientInfo, { capabilities: {} });
    // Codes only: an HTTP error's message carries the provider's response body (spec §24 keeps provider text out of logs).
    client.onerror = (e) => log({ event: "si_ref_client_error", code: typeof e?.code === "string" || Number.isInteger(e?.code) ? e.code : e?.name ?? "error", status: Number.isInteger(e?.status) ? e.status : null });
    const timeout = () => Math.max(1, deadlineAt - Date.now());
    let closed = false;
    const close = async () => {
      if (closed) return;
      closed = true;
      // A bounded goodbye: the session's DELETE when the server issued one, then the client and every open stream are ended.
      let bound;
      await Promise.race([transport.terminateSession?.().catch(() => {}), new Promise((r) => { bound = setTimeout(r, 1000); })]);
      clearTimeout(bound);
      await client.close().catch(() => {});
      bridge.closeAll();
    };
    try {
      await client.connect(transport, { signal, timeout: timeout() });
      const listed = await client.listTools(undefined, { signal, timeout: timeout() });
      const tools = new Set((listed?.tools ?? []).filter((t) => typeof t?.name === "string" && t.inputSchema && typeof t.inputSchema === "object").map((t) => t.name));
      return { client, tools, op: bridge.op, close };
    } catch (e) {
      await close();
      // The verdict travels with the error: whether anything was written decides what the failure says about the service.
      // Judged by the request that failed (the latest), and a handshake the client could not accept is the server's contract.
      const handshake = e?.code === undefined && e?.status === undefined && /protocol version|initialize result/i.test(String(e?.message));
      const verdict = handshake ? { reason: "contract_failure", detail: "ref_handshake", dispatchState: "response_received", breaker: "neutral" }
        : mcpFailure(e, { sent: bridge.lastWritten(), cancelled: !!signal?.aborted });
      throw Object.assign(new Error(`Ref session did not open: ${String(e?.code ?? e?.message ?? e).slice(0, 120)}`), { verdict });
    }
  };
}

// session: (ctx) => { client, tools, op(), close() } — the MCP client over the policy-checked bridge (server.mjs supplies it).
export function makeRef({ dispatch, limits, openSession, log = () => {} }) {
  // One billable tool call inside a session: reserved first, sent by the client, closed exactly once. A call without a usable
  // answer is judged and closed here (meter's fail); an answer is the caller's to close and report.
  async function tool(session, { request, ctx, kind, op, name, args, deadlineAt }) {
    const callKey = `search:${request.logicalSearchId}:ref:${op}:v1`;
    const m = await dispatch.meter({ sub: ctx.sub, pre: ctx.pre, kind, callKey, logicalId: request.logicalSearchId, requestHash: sha256(`${REF_CONTRACT}\n${name}\n${JSON.stringify(args)}`), amount: ctx.sub.card.creditsPerOperation });
    if (!m.ok) return { ok: false, reason: m.reason, detail: m.detail, dispatchState: m.dispatchState ?? "not_sent" };
    const handle = session.op(callKey, { signal: ctx.signal, deadlineAt });
    const startedAt = Date.now();
    try {
      // Raced against the operation's transport failure, which the client itself would only report, never reject with.
      const result = await Promise.race([handle.failure, session.client.callTool({ name, arguments: args }, { signal: ctx.signal, timeout: Math.max(1, deadlineAt - Date.now()), maxTotalTimeout: Math.max(1, deadlineAt - Date.now()), headers: handle.header })]);
      return { ok: true, result, close: m.close, startedAt };
    } catch (e) {
      // The client's timeout leaves its request with the transport: withdrawn first, so an unwritten one is never written.
      handle.withdraw();
      return { ok: false, ...(await m.fail(e, { sent: handle.written(), cancelled: ctx.signal.aborted })) };
    }
  }

  // Settles a billable answer: a recognized answer costs its credit; any other answer, an authentication refusal included, is
  // kept uncertain, since the hosted server's error charging is not documented (SI0 contract evidence §6, spec §18.2).
  async function closeFor(close, parsed, credits) {
    if (["results", "empty", "text"].includes(parsed.kind)) return close.settle(credits, { usage: { credits }, detail: "Ref tool call" });
    return close.uncertain(`Ref answered without a recognized result (${parsed.detail}); whether it charged is unknown`);
  }
  // The one verdict of an answered call: a recognized answer is a success; an error text or an unknown shape is its reason.
  async function judged(ctx, parsed, startedAt) {
    if (["results", "empty", "text"].includes(parsed.kind)) { await dispatch.report(ctx.sub, ctx.pre.epoch, { success: true, dispatchedAt: startedAt }); return null; }
    const reason = parsed.kind === "contract" ? "contract_failure" : parsed.reason;
    await dispatch.report(ctx.sub, ctx.pre.epoch, { reason, providerCode: parsed.detail, detail: parsed.detail });
    return reason;
  }
  // A session that did not open: an unmetered exchange's verdict.
  async function openFailed(ctx, e) {
    const v = e?.verdict ?? mcpFailure(e, { sent: false, cancelled: ctx.signal.aborted });
    log({ event: "si_ref_session_failed", reason: v.reason, detail: v.detail });
    await dispatch.observe(ctx.sub, ctx.pre.epoch, v);
    return v;
  }

  return {
    id: "ref", api: "ref-mcp-v1", contractVersion: REF_CONTRACT,
    representable: (request) => (refQuery(request) ? { ok: true } : { ok: false, detail: "query_only_provider_directives" }),
    cacheIdentity: (request) => ({ q: refQuery(request) }),
    async search(request, ctx) {
      const L = limits(), t0 = Date.now(), base = { provider: "ref", kind: "docs_search", startedAt: new Date(t0).toISOString() };
      let session;
      try { session = await openSession({ sub: ctx.sub, pre: ctx.pre, request, signal: ctx.signal, deadlineAt: ctx.deadlineAt }); }
      catch (e) {
        const v = await openFailed(ctx, e);
        return outcome({ ...base, status: "failed", reason: v.reason, detail: `session_open:${v.detail}`, dispatchState: "not_sent" });
      }
      let keep = false;
      try {
        const tools = session.tools;
        if (!tools.has("ref_search_documentation") || !tools.has("ref_read_url")) {
          await dispatch.observe(ctx.sub, ctx.pre.epoch, { reason: "contract_failure", detail: "ref_tools_missing", breaker: "neutral" });
          return outcome({ ...base, status: "failed", reason: "contract_failure", detail: "ref_tools_missing", dispatchState: "not_sent" });
        }
        const r = await tool(session, { request, ctx, kind: "docs_search", op: "search", name: "ref_search_documentation", args: { query: refQuery(request) }, deadlineAt: ctx.deadlineAt });
        if (!r.ok) {
          // fail() has judged the breaker: this report only informs availability.
          await dispatch.report(ctx.sub, ctx.pre.epoch, { reason: r.reason, providerCode: r.detail }, { answered: false });
          // Usage counts settled credits; an operation the ledger holds as possibly charged is counted apart.
          return outcome({ ...base, status: "failed", reason: r.reason, detail: r.detail, dispatchState: r.dispatchState, ...(r.dispatchState !== "not_sent" && r.detail !== "operation_already_recorded" ? { usage: { credits: 0, uncertain: 1 } } : {}) });
        }
        const parsed = parseRefSearch(r.result);
        await closeFor(r.close, parsed, ctx.sub.card.creditsPerOperation);
        const failure = await judged(ctx, parsed, r.startedAt);
        if (failure) return outcome({ ...base, status: "failed", reason: failure, detail: parsed.detail, dispatchState: "response_received", usage: { credits: 0, uncertain: 1 } });
        const retrievedAt = new Date().toISOString();
        const requested = (request.intelligence.libraries ?? []).filter((l) => l.version);
        const candidates = (parsed.kind === "results" ? parsed.docs : []).slice(0, L.candidates.docsPerProvider).map((d, i) => ({
          url: d.url, providerUrl: d.url, title: (d.title || d.url).slice(0, 300), description: d.overview.slice(0, 600), rank: i + 1,
          documentation: { scopes: requested.length ? requested.map((l) => ({ libraryName: l.name, requestedVersion: l.version, observedVersion: null, status: "unknown", basis: "query_hint", provider: "ref" })) : [], moduleId: d.moduleId || null, observedVersion: null },
          retrievedAt }));
        keep = true;
        return { ...outcome({ ...base, status: candidates.length ? "success_results" : "success_empty", upstreamResultCount: parsed.kind === "results" ? parsed.docs.length : 0, candidates, dispatchState: "response_received",
          usage: { credits: ctx.sub.card.creditsPerOperation, basis: "documented" } }), lease: lease(session, request, ctx, "discovery") };
      } finally {
        if (!keep) await session.close().catch(() => {});
      }
    },
    // A read for a cached discovery: a fresh session first repeats the search as its context (its own metered operation),
    // since a read is conditioned on the session's searches; at most once per logical execution.
    async contextLease(request, ctx) {
      let session;
      try { session = await openSession({ sub: ctx.sub, pre: ctx.pre, request, signal: ctx.signal, deadlineAt: ctx.deadlineAt }); } catch (e) { await openFailed(ctx, e); return null; }
      // As for a discovery: a session without both tools gets no metered call.
      if (!session.tools.has("ref_search_documentation") || !session.tools.has("ref_read_url")) {
        await dispatch.observe(ctx.sub, ctx.pre.epoch, { reason: "contract_failure", detail: "ref_tools_missing", breaker: "neutral" });
        await session.close().catch(() => {});
        return null;
      }
      const epoch = Date.now().toString(36);
      const r = await tool(session, { request, ctx, kind: "docs_search", op: `context_init:${epoch}`, name: "ref_search_documentation", args: { query: refQuery(request) }, deadlineAt: ctx.deadlineAt });
      if (!r.ok) { await dispatch.report(ctx.sub, ctx.pre.epoch, { reason: r.reason, providerCode: r.detail }, { answered: false }); await session.close().catch(() => {}); return null; }
      const parsed = parseRefSearch(r.result);
      await closeFor(r.close, parsed, ctx.sub.card.creditsPerOperation);
      if (await judged(ctx, parsed, r.startedAt)) { await session.close().catch(() => {}); return null; }
      return lease(session, request, ctx, epoch);
    },
    // Selected reads of this provider's documents among those provisionally returned (spec §6.2), inside the semantic phase:
    // at most MAX_READS without an excerpt, concurrently, each within refReadMs. The discovery's session is used; without one
    // (a discovery served from cache) admit() gives the subject for one fresh session, whose context search comes first and is
    // metered on its own. A failure is an enrichment limitation, never a retry. The fresh lease is returned for the caller to
    // close with the search.
    async enrich({ request, documents, lease, admit, signal, semanticClose }) {
      const selected = documents.filter((d) => d.observations.some((o) => o.provider === "ref") && !d.passages.some((p) => String(p.text ?? "").trim().length >= USEFUL_EXCERPT_CHARS)).slice(0, MAX_READS);
      if (!selected.length) return { attempted: 0, usage: [], limitation: null };
      const t0 = Date.now(), L = limits();
      const usage = [];
      let fresh = null, contextInit = false;
      if (!lease) {
        const a = admit();
        if (a?.pre?.eligible) {
          // The fresh session's opening and context search run in the semantic phase, leaving the reads a read's full time.
          fresh = await this.contextLease(request, { sub: a.sub, pre: a.pre, signal, deadlineAt: Math.max(t0 + READ_MIN_MS, semanticClose - L.refReadMs), selection: a.selection });
          contextInit = true;
          if (fresh) usage.push({ provider: "ref", operation: "context_init", credits: a.sub.card.creditsPerOperation, basis: "documented" });
        }
        if (!fresh) return { attempted: selected.length, usage, limitation: "session_unavailable", elapsedMs: Date.now() - t0, record: { selected: selected.length, read: 0, contextInit, limitation: "session_unavailable" } };
        lease = fresh;
      }
      // Each read has up to refReadMs from when it can start, within the semantic phase.
      const readClose = Math.min(semanticClose, Date.now() + L.refReadMs);
      if (readClose - Date.now() < READ_MIN_MS) return { attempted: selected.length, usage, limitation: "no_time_for_reads", elapsedMs: Date.now() - t0, record: { selected: selected.length, read: 0, contextInit, limitation: "no_time_for_reads" }, lease: fresh };
      const results = await Promise.all(selected.map((d) => lease.read(d.observations.find((o) => o.provider === "ref").providerUrl, { signal, deadlineAt: readClose })));
      let read = 0;
      const failures = [];
      results.forEach((r, i) => {
        if (!r.ok) { failures.push(r.reason); return; }
        const d = selected[i];
        read++;
        if (!d.passages.some((p) => p.contentHash === r.passage.contentHash)) d.passages.unshift(r.passage);
        usage.push({ provider: "ref", operation: "read", ...r.usage });
      });
      const limitation = failures.length ? failures[0] : null;
      return { attempted: selected.length, usage, limitation, elapsedMs: Date.now() - t0, record: { selected: selected.length, read, contextInit, ...(limitation ? { limitation } : {}) }, lease: fresh };
    },
  };

  // epoch names the session in its reads' operation keys: a read is conditioned on its session's searches, so the same URL
  // read in another session is another operation. The discovery session's epoch is fixed, so a re-execution of the logical
  // search never resends its reads, as no other recorded operation is resent.
  function lease(session, request, ctx, epoch) {
    let reads = 0, closed = false;
    return {
      async read(providerUrl, { signal, deadlineAt }) {
        if (closed || reads >= MAX_READS) return { ok: false, reason: "platform_restricted", detail: closed ? "session_closed" : "read_slots_used" };
        reads++;
        const rctx = { ...ctx, signal };
        const r = await tool(session, { request, ctx: rctx, kind: "docs_read", op: `read:${epoch}:${sha256(providerUrl).slice(0, 24)}`, name: "ref_read_url", args: { url: providerUrl }, deadlineAt });
        if (!r.ok) { await dispatch.report(ctx.sub, ctx.pre.epoch, { reason: r.reason, providerCode: r.detail }, { answered: false }); return r; }
        // An excerpt is held to the evidence hook's per-document bound (spec §12), so a read can always be evaluated whole.
        const parsed = parseRefRead(r.result, limits().evidence.maxDocumentBytes);
        await closeFor(r.close, parsed, ctx.sub.card.creditsPerOperation);
        const failure = await judged(rctx, parsed, r.startedAt);
        if (failure) return { ok: false, reason: failure, detail: parsed.detail, dispatchState: "response_received" };
        const retrievedAt = new Date().toISOString();
        return { ok: true, passage: { passageId: sha256(`ref\n${providerUrl}\n${contentHash(parsed.text)}`).slice(0, 24), sourceUrl: providerUrl, sourceIdentifier: providerUrl, provider: "ref", kind: "ref_context_excerpt",
          text: parsed.text, contentHash: contentHash(parsed.text), retrievedAt, completeness: "excerpt", truncated: parsed.truncated }, usage: { credits: ctx.sub.card.creditsPerOperation, basis: "documented" } };
      },
      async close() { if (closed) return; closed = true; await session.close().catch(() => {}); },
      get reads() { return reads; },
    };
  }
}
