// Ref over MCP (docs/FIRECRAWL_PI_SEARCH_INTELLIGENCE_SPEC.md §6.2; contract verified 2026-10-17 in
// evidence/search-intelligence/SI0/provider-contracts-2026-10-17.md §6): Streamable HTTP at api.ref.tools/mcp with the
// x-ref-api-key header, through the official MCP client and a policy-checked fetch bridge (no redirects, no other host,
// bounded bodies, the request permit per POST, a stream slot for the optional receive stream, no transparent reconnection).
//   - One isolated session per logical search, never shared: Ref suppresses repeated results and conditions reads on the
//     session's searches. Its lease goes to the coordinator, which closes it after any selected reads.
//   - Billable: ref_search_documentation and ref_read_url, one credit each, each its own metered operation. Initialization,
//     tool listing and session close are bounded protocol exchanges, recorded but not metered.
//   - Answers: the hosted format is not documented. The legacy text blocks ("overview: …\nurl: …\nmoduleId: …") and the exact
//     "No results found" sentinel are recognized; known error texts (which arrive without isError) and isError are failures; any
//     other text is a contract failure, never an empty result. A URL inside an error is never a hit. No JSON results envelope is
//     assumed. A read is a query-conditioned excerpt, never a full document.
import { outcome } from "../contracts.mjs";
import { sha256, contentHash, normalizeQueryText, normalizeUrl } from "../normalize.mjs";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";

export const REF_CONTRACT = "ref-mcp-v1/2026-10-17";
export const NO_RESULTS = "No results found";
const AUTH = [/Ref is not correctly configured/i, /Please verify your email/i, /\binvalid api key\b/i, /\bunauthori[sz]ed\b/i];
const QUOTA = [/\b(out of|no remaining|insufficient|not enough) credits\b/i, /\bcredit limit (reached|exceeded)\b/i];
const ERRORS = [/^Error during documentation search:/i, /^Error reading URL:/i, /^Error:/i];
const BLOCK = /overview:[ \t]?([\s\S]*?)\r?\nurl:[ \t]?(\S+)[ \t]*\r?\nmoduleId:[ \t]?([^\r\n]*)/g;

const textsOf = (result) => (Array.isArray(result?.content) ? result.content.filter((c) => c?.type === "text" && typeof c.text === "string").map((c) => c.text) : null);
function classifyError(text) {
  if (AUTH.some((r) => r.test(text))) return { kind: "error", reason: "auth_failed", detail: "ref_auth_text" };
  if (QUOTA.some((r) => r.test(text))) return { kind: "error", reason: "quota_exhausted", detail: "ref_quota_text" };
  if (ERRORS.some((r) => r.test(text.trim()))) return { kind: "error", reason: "temporarily_unavailable", detail: "ref_error_text" };
  return null;
}

// A search tool result: { kind: "results", docs: [{ url, overview, moduleId }] } | { kind: "empty" } | { kind: "error", reason, detail } |
// { kind: "contract", detail }.
export function parseRefSearch(result) {
  const texts = textsOf(result);
  if (!texts) return { kind: "contract", detail: "ref_no_content" };
  const joined = texts.join("\n");
  if (result.isError) return classifyError(joined) ?? { kind: "error", reason: "temporarily_unavailable", detail: "ref_is_error" };
  const err = texts.map((t) => classifyError(t)).find(Boolean);
  if (err) return err;
  if (texts.length === 1 && texts[0].trim() === NO_RESULTS) return { kind: "empty" };
  const docs = [];
  for (const t of texts) for (const m of t.matchAll(BLOCK)) if (normalizeUrl(m[2])) docs.push({ url: m[2], overview: m[1].trim().slice(0, 2000), moduleId: m[3].trim().slice(0, 300) });
  if (!docs.length) return { kind: "contract", detail: "ref_unrecognized_text" };
  return { kind: "results", docs };
}
// A read tool result: { kind: "text", text } | { kind: "error", … } | { kind: "contract", … }.
export function parseRefRead(result, maxChars) {
  const texts = textsOf(result);
  if (!texts) return { kind: "contract", detail: "ref_no_content" };
  const joined = texts.join("\n");
  if (result.isError) return classifyError(joined) ?? { kind: "error", reason: "temporarily_unavailable", detail: "ref_is_error" };
  const err = classifyError(joined);
  if (err) return err;
  if (!joined.trim()) return { kind: "contract", detail: "ref_empty_read" };
  return { kind: "text", text: joined.slice(0, maxChars), truncated: joined.length > maxChars };
}

// The query sent to Ref: the original, plus the caller's library and language hints Ref's tool asks for when absent from it.
export function refQuery(request) {
  const q = normalizeQueryText(request.originalQuery), low = q.toLowerCase();
  const hints = [...(request.intelligence.libraries ?? []).map((l) => (l.version ? `${l.name} ${l.version}` : l.name)), request.intelligence.programmingLanguage].filter((h) => h && !low.includes(h.toLowerCase()));
  return [q, ...hints].join(" ").slice(0, 500);
}

// The sessions server.mjs gives the adapter: the official MCP client (pinned 2.1.0) over makeFetch's policy-checked bridge
// (provider.mjs makeSafeFetch: Ref's origin and /mcp only, no redirect, bounded bodies, a request permit per POST, a stream
// slot for the optional receive stream). Reconnection is off: a dropped stream is a limitation, never a replay. Each session
// lists its tools once; posts() counts the POSTs actually written, so a failed tool call can tell unsent from possibly sent.
export function makeRefSessionFactory({ makeFetch, clientInfo = { name: "fcpi-retrieval", version: "1" }, log = () => {} }) {
  return async function openSession({ sub, pre, request, signal, deadlineAt }) {
    const bridge = makeFetch({ sub, key: pre.key, searchId: request.logicalSearchId, signal, deadlineAt });
    const transport = new StreamableHTTPClientTransport(new URL(`${sub.prov.baseUrl.replace(/\/$/, "")}/mcp`), {
      fetch: bridge.fetch, requestInit: { headers: { "x-ref-api-key": pre.key } },
      reconnectionOptions: { maxRetries: 0, initialReconnectionDelay: 1000, maxReconnectionDelay: 1000, reconnectionDelayGrowFactor: 1 } });
    const client = new Client(clientInfo, { capabilities: {} });
    client.onerror = (e) => log({ event: "si_ref_client_error", error: String(e?.message ?? e).slice(0, 160) });
    const timeout = () => Math.max(1, deadlineAt - Date.now());
    let closed = false;
    const close = async () => {
      if (closed) return;
      closed = true;
      // A bounded goodbye: the session's DELETE when the server issued one, then the client and every open stream are ended.
      await Promise.race([transport.terminateSession?.().catch(() => {}), new Promise((r) => setTimeout(r, 1000))]);
      await client.close().catch(() => {});
      bridge.closeAll();
    };
    try {
      await client.connect(transport, { signal, timeout: timeout() });
      const listed = await client.listTools(undefined, { signal, timeout: timeout() });
      const tools = new Set((listed?.tools ?? []).filter((t) => typeof t?.name === "string" && t.inputSchema && typeof t.inputSchema === "object").map((t) => t.name));
      return { client, tools, sentPosts: () => bridge.postsWritten(), close };
    } catch (e) { await close(); throw e; }
  };
}

// session: (ctx) => { client, sentPosts(), close() } — the MCP client over the policy-checked bridge (server.mjs supplies it);
// meter: dispatch.meter — a ledger reservation for an operation whose transport is not dispatch's own.
export function makeRef({ dispatch, limits, openSession, log = () => {} }) {
  // One billable tool call inside a session: reserved first, sent by the client, closed exactly once.
  async function tool(session, { request, ctx, kind, op, name, args, deadlineAt }) {
    const callKey = `search:${request.logicalSearchId}:ref:${op}:v1`;
    const m = await dispatch.meter({ sub: ctx.sub, kind, callKey, logicalId: request.logicalSearchId, requestHash: sha256(`${REF_CONTRACT}\n${name}\n${JSON.stringify(args)}`), amount: ctx.sub.card.creditsPerOperation });
    if (!m.ok) return { ok: false, reason: m.reason, detail: m.detail, dispatchState: "not_sent" };
    const before = session.sentPosts();
    try {
      const result = await session.client.callTool({ name, arguments: args }, undefined, { signal: ctx.signal, timeout: Math.max(1, deadlineAt - Date.now()), maxTotalTimeout: Math.max(1, deadlineAt - Date.now()) });
      return { ok: true, result, close: m.close };
    } catch (e) {
      // Whether the call left: the bridge counts the POSTs it wrote. Not written: released; written: unknown, kept whole.
      if (session.sentPosts() === before) { await m.close.release(`Ref ${name} not sent: ${String(e?.code ?? e?.message ?? e).slice(0, 80)}`); return { ok: false, reason: ctx.signal.aborted ? "cancelled" : "temporarily_unavailable", detail: "not_sent", dispatchState: "not_sent" }; }
      await m.close.uncertain(`Ref ${name} sent, no answer: ${String(e?.code ?? e?.message ?? e).slice(0, 80)}`);
      return { ok: false, reason: ctx.signal.aborted ? "cancelled" : /timeout|timed out/i.test(String(e?.message)) ? "timeout" : "temporarily_unavailable", detail: "possibly_sent", dispatchState: "possibly_sent" };
    }
  }

  // Settles a billable answer: a recognized answer costs its credit; any other answer, an authentication refusal included, is
  // kept uncertain, since the hosted server's error charging is not documented (SI0 contract evidence §6, spec §18.2).
  async function closeFor(close, parsed, credits) {
    if (["results", "empty", "text"].includes(parsed.kind)) return close.settle(credits, { usage: { credits }, detail: "Ref tool call" });
    return close.uncertain(`Ref answered without a recognized result (${parsed.detail}); whether it charged is unknown`);
  }

  return {
    id: "ref", api: "ref-mcp-v1", contractVersion: REF_CONTRACT,
    representable: () => ({ ok: true }),
    cacheIdentity: (request) => ({ q: refQuery(request) }),
    async search(request, ctx) {
      const L = limits(), t0 = Date.now(), base = { provider: "ref", kind: "docs_search", startedAt: new Date(t0).toISOString() };
      let session;
      try { session = await openSession({ sub: ctx.sub, pre: ctx.pre, request, signal: ctx.signal, deadlineAt: ctx.deadlineAt }); }
      catch (e) {
        log({ event: "si_ref_session_failed", error: String(e?.code ?? e?.message ?? e).slice(0, 160) });
        const reason = ctx.signal.aborted ? "cancelled" : /401|403|unauthori/i.test(String(e?.message)) ? "auth_failed" : "temporarily_unavailable";
        await dispatch.report(ctx.sub, ctx.pre.epoch, { reason, providerCode: "session_open" });
        return outcome({ ...base, status: "failed", reason, detail: "session_open_failed", dispatchState: "not_sent" });
      }
      let keep = false;
      try {
        const tools = session.tools;
        if (!tools.has("ref_search_documentation") || !tools.has("ref_read_url")) {
          await dispatch.report(ctx.sub, ctx.pre.epoch, { reason: "contract_failure", providerCode: "ref_tools_missing" });
          return outcome({ ...base, status: "failed", reason: "contract_failure", detail: "ref_tools_missing", dispatchState: "response_received" });
        }
        const r = await tool(session, { request, ctx, kind: "docs_search", op: "search", name: "ref_search_documentation", args: { query: refQuery(request) }, deadlineAt: ctx.deadlineAt });
        if (!r.ok) { await dispatch.report(ctx.sub, ctx.pre.epoch, { reason: r.reason }); return outcome({ ...base, status: "failed", reason: r.reason, detail: r.detail, dispatchState: r.dispatchState }); }
        const parsed = parseRefSearch(r.result);
        await closeFor(r.close, parsed, ctx.sub.card.creditsPerOperation);
        if (parsed.kind === "error" || parsed.kind === "contract") {
          const reason = parsed.kind === "contract" ? "contract_failure" : parsed.reason;
          await dispatch.report(ctx.sub, ctx.pre.epoch, { reason, providerCode: parsed.detail, detail: parsed.detail });
          return outcome({ ...base, status: "failed", reason, detail: parsed.detail, dispatchState: "response_received" });
        }
        await dispatch.report(ctx.sub, ctx.pre.epoch, { success: true, dispatchedAt: t0 });
        const retrievedAt = new Date().toISOString();
        const requested = (request.intelligence.libraries ?? []).filter((l) => l.version);
        const candidates = (parsed.kind === "results" ? parsed.docs : []).slice(0, L.candidates.docsPerProvider).map((d, i) => ({
          url: d.url, providerUrl: d.url, title: (d.moduleId || d.overview.split(/[.\n]/)[0] || d.url).slice(0, 300), description: d.overview.slice(0, 600), rank: i + 1,
          documentation: { scopes: requested.length ? requested.map((l) => ({ libraryName: l.name, requestedVersion: l.version, observedVersion: null, status: "unknown", basis: "query_hint", provider: "ref" })) : [], moduleId: d.moduleId || null, observedVersion: null },
          retrievedAt }));
        keep = true;
        return { ...outcome({ ...base, status: candidates.length ? "success_results" : "success_empty", upstreamResultCount: parsed.kind === "results" ? parsed.docs.length : 0, candidates, dispatchState: "response_received",
          usage: { credits: ctx.sub.card.creditsPerOperation, basis: "documented" } }), lease: lease(session, request, ctx) };
      } finally {
        if (!keep) await session.close().catch(() => {});
      }
    },
    // A read for a cached discovery: a fresh session first repeats the search as its context (its own metered operation),
    // since a read is conditioned on the session's searches; at most once per logical execution.
    async contextLease(request, ctx) {
      let session;
      try { session = await openSession({ sub: ctx.sub, pre: ctx.pre, request, signal: ctx.signal, deadlineAt: ctx.deadlineAt }); } catch { return null; }
      const r = await tool(session, { request, ctx, kind: "docs_search", op: `context_init:${Date.now().toString(36)}`, name: "ref_search_documentation", args: { query: refQuery(request) }, deadlineAt: ctx.deadlineAt });
      if (!r.ok) { await session.close().catch(() => {}); return null; }
      await closeFor(r.close, parseRefSearch(r.result), ctx.sub.card.creditsPerOperation);
      return lease(session, request, ctx);
    },
  };

  function lease(session, request, ctx) {
    let reads = 0, closed = false;
    return {
      async read(providerUrl, { signal, deadlineAt }) {
        if (closed || reads >= 2) return { ok: false, reason: "platform_restricted", detail: closed ? "session_closed" : "read_slots_used" };
        reads++;
        const r = await tool(session, { request, ctx: { ...ctx, signal }, kind: "docs_read", op: `read:${sha256(providerUrl).slice(0, 24)}`, name: "ref_read_url", args: { url: providerUrl }, deadlineAt });
        if (!r.ok) return r;
        const parsed = parseRefRead(r.result, 48 * 1024);
        await closeFor(r.close, parsed, ctx.sub.card.creditsPerOperation);
        if (parsed.kind !== "text") return { ok: false, reason: parsed.kind === "contract" ? "contract_failure" : parsed.reason, detail: parsed.detail };
        const retrievedAt = new Date().toISOString();
        return { ok: true, passage: { passageId: sha256(`ref\n${providerUrl}\n${contentHash(parsed.text)}`).slice(0, 24), sourceUrl: providerUrl, sourceIdentifier: providerUrl, provider: "ref", kind: "ref_context_excerpt",
          text: parsed.text, contentHash: contentHash(parsed.text), retrievedAt, completeness: "excerpt", truncated: parsed.truncated } };
      },
      async close() { if (closed) return; closed = true; await session.close().catch(() => {}); },
      get reads() { return reads; },
    };
  }
}
