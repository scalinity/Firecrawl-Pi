// Context7 v3 search (docs/FIRECRAWL_PI_SEARCH_INTELLIGENCE_SPEC.md §6.1; contract verified 2026-10-17 in
// evidence/search-intelligence/SI0/provider-contracts-2026-10-17.md §5): GET /api/v3/search with a bearer key and type=json
// (the REST default is text). Each explicit library with a version is its own single-library request (a version is strict
// only for one library), at most four, run together inside this lane; libraries without versions share one multi-library
// request; no library hint means one request on the query alone. Each request is one metered call. A documented no-match
// (404 no_documentation_found) is a valid empty; any other 404, 503 search_failed or a malformed body is a failure. One empty
// and one failed scope make the lane partial, never complete.
//
// Versions: Context7 may fall back from a requested version to current docs and flag it (version.libraries[].status and
// served). A served version known to differ from the requested one is a mismatch, and its passages are left out; an
// unverified fallback with no served version stays as explicitly unknown-version context; a verified scope is the provider's
// scope (scope_only), never a confirmed per-page version. Returned rules are provider metadata and are not used.
// codeId/pageId are source URLs only when they are http(s) URLs; a passage without one becomes auxiliary context with
// sourceUrl null, never a fabricated link.
import { outcome } from "../contracts.mjs";
import { parseRetryAfter } from "../availability.mjs";
import { parseJson, str } from "./common.mjs";
import { sha256, contentHash, normalizeQueryText, normalizeUrl } from "../normalize.mjs";

export const CONTEXT7_CONTRACT = "context7-v3/2026-10-17";
const VERSION = /^([Ll][Aa][Tt][Ee][Ss][Tt]|[Vv]?[0-9]+([._][0-9]+){0,2}([-+][a-zA-Z0-9.-]+)?)$/;

// The scopes one search asks: [{ libraries: [name...], version: string|null, key }]. A version Context7's pattern cannot
// express is not sent as a version; its scope is reported unsupported rather than silently widened to latest.
export function context7Scopes(request) {
  const libs = request.intelligence.libraries ?? [];
  const versioned = libs.filter((l) => l.version), plain = libs.filter((l) => !l.version);
  const scopes = versioned.map((l) => ({ libraries: [l.name.slice(0, 120)], version: l.version, representable: VERSION.test(l.version) && !/^latest$/i.test(l.version) }));
  if (plain.length || !versioned.length) scopes.push({ libraries: plain.map((l) => l.name.slice(0, 120)), version: null, representable: true });
  return scopes.slice(0, 4).map((s) => ({ ...s, key: sha256(JSON.stringify([s.libraries, s.version])).slice(0, 16) }));
}

const httpUrl = (v) => (typeof v === "string" && normalizeUrl(v) ? v : null);

export function makeContext7({ dispatch, limits }) {
  async function one(request, ctx, scope) {
    const L = limits();
    if (!scope.representable) return { scope, status: "unsupported", detail: "version_not_representable" };
    const params = new URLSearchParams({ query: normalizeQueryText(request.originalQuery).slice(0, 2000), type: "json" });
    for (const l of scope.libraries) params.append("library", l);
    if (scope.version) params.set("version", scope.version);
    if (request.intelligence.programmingLanguage) params.set("language", request.intelligence.programmingLanguage.slice(0, 40));
    const path = `/api/v3/search?${params}`;
    const res = await dispatch.call({ sub: ctx.sub, pre: ctx.pre, kind: "docs_search", callKey: `search:${request.logicalSearchId}:context7:search:${scope.key}:v1`, logicalId: request.logicalSearchId, searchId: request.logicalSearchId,
      requestHash: sha256(`${CONTEXT7_CONTRACT}\n${path}`), amount: 1, signal: ctx.signal, deadlineAt: ctx.deadlineAt, timeoutMs: L.providerTimeoutsMs.context7, maxBytes: L.responseBytes.context7,
      http: { method: "GET", path, headers: { accept: "application/json", authorization: `Bearer ${ctx.pre.key}` } } });
    if (!res.ok) return { scope, status: "failed", reason: res.reason, detail: res.detail, dispatchState: res.dispatchState, unanswered: true };
    const { response, close } = res, data = parseJson(response.body);
    const code = str(data?.error, 64, null);
    if (response.status === 404 && code === "no_documentation_found") { await close.settle(1, { usage: { requests: 1 }, detail: "Context7 search: no documentation found" }); return { scope, status: "empty" }; }
    if (response.status !== 200) {
      let reason = "temporarily_unavailable", retryAt = null;
      if (response.status === 402) reason = "quota_exhausted";
      else if (response.status === 429) { reason = "rate_limited"; retryAt = parseRetryAfter(response.headers["retry-after"]); }
      else if (response.status === 401 || response.status === 403) reason = "auth_failed";
      else if (response.status === 400) reason = "unsupported_request";
      else if (response.status === 404) reason = "contract_failure";
      // Whether a refused call counts against the plan is not documented (SI0 contract evidence §5): uncertain (spec §18.2).
      await close.uncertain(`Context7 answered HTTP ${response.status}${code ? ` ${code}` : ""}; whether the call counted is not documented`);
      return { scope, status: "failed", reason, detail: code ?? `http_${response.status}`, retryAt, providerCode: code ?? `http_${response.status}` };
    }
    await close.settle(1, { usage: { requests: 1 }, detail: "Context7 search" });
    if (!data || !Array.isArray(data.codeSnippets) || !Array.isArray(data.infoSnippets)) return { scope, status: "failed", reason: "contract_failure", detail: "context7_response_shape", providerCode: "context7_shape" };
    return { scope, status: "ok", data, requestId: str(response.headers["x-request-id"] ?? response.headers["x-context7-request-id"], 128, null) };
  }

  // The version Context7 says it served for a library, as a scope record (spec §9.3): never a confirmed per-page version.
  function scopeRecord(scopeResult, libraryId, retrievedAt) {
    const requested = scopeResult.scope.version;
    const v = scopeResult.data?.version?.libraries?.find((x) => x?.libraryId === libraryId) ?? null;
    const served = typeof v?.served === "string" ? v.served : null, status = typeof v?.status === "string" ? v.status : null;
    if (!requested) return { libraryId, requestedVersion: null, observedVersion: null, status: "not_applicable", basis: "none", provider: "context7" };
    if (served && served.replace(/^v/i, "") !== requested.replace(/^v/i, "") && status !== "verified") return { libraryId, requestedVersion: requested, observedVersion: served, status: "mismatch", basis: "provider_scope", provider: "context7", retrievedAt };
    if (status === "verified" || status === "prerelease") return { libraryId, requestedVersion: requested, observedVersion: served, status: "scope_only", basis: "provider_scope", provider: "context7", note: status };
    return { libraryId, requestedVersion: requested, observedVersion: null, status: "unknown", basis: "query_hint", provider: "context7" };
  }

  return {
    id: "context7", api: "context7-v3", contractVersion: CONTEXT7_CONTRACT,
    representable: () => ({ ok: true }),
    cacheIdentity: (request) => ({ q: normalizeQueryText(request.originalQuery), scopes: context7Scopes(request).map((s) => [s.libraries, s.version]), lang: request.intelligence.programmingLanguage ?? null }),
    async search(request, ctx) {
      const L = limits(), scopes = context7Scopes(request), t0 = Date.now();
      const results = await Promise.all(scopes.map((s) => one(request, ctx, s)));
      const retrievedAt = new Date().toISOString();
      const byUrl = new Map(), aux = [];
      let mismatched = 0;
      for (const r of results.filter((x) => x.status === "ok")) {
        const snippets = [...r.data.codeSnippets.map((s) => ({ s, kind: "documentation_code" })), ...r.data.infoSnippets.map((s) => ({ s, kind: "documentation_text" }))];
        for (const { s, kind } of snippets) {
          if (!s || typeof s.libraryId !== "string") continue;
          const text = kind === "documentation_code"
            ? [str(s.codeTitle, 300), str(s.codeDescription, 1500), ...(Array.isArray(s.codeList) ? s.codeList.filter((c) => typeof c?.code === "string").map((c) => `\`\`\`${str(c.language, 40)}\n${c.code.slice(0, 4000)}\n\`\`\``) : [])].filter(Boolean).join("\n")
            : str(s.content, 6000);
          if (!text.trim()) continue;
          const sourceId = kind === "documentation_code" ? str(s.codeId, 2048, null) : str(s.pageId, 2048, null);
          const scope = scopeRecord(r, s.libraryId, retrievedAt);
          if (scope.status === "mismatch") { mismatched++; continue; }
          const sourceUrl = httpUrl(sourceId);
          const passage = { passageId: sha256(`context7\n${sourceId ?? ""}\n${contentHash(text)}`).slice(0, 24), sourceUrl, sourceIdentifier: sourceId, provider: "context7", kind, text, contentHash: contentHash(text), retrievedAt,
            libraryId: s.libraryId, requestedVersion: scope.requestedVersion, observedVersion: scope.observedVersion, versionStatus: scope.status, language: kind === "documentation_code" ? str(s.codeLanguage, 40, null) : null,
            section: str(s.breadcrumb, 300, null), completeness: "excerpt" };
          if (!sourceUrl) { aux.push(passage); continue; }
          const doc = byUrl.get(sourceUrl) ?? { url: sourceUrl, title: str(s.pageTitle, 500) || str(s.codeTitle, 500) || s.libraryId, description: "", passages: [], scopes: [] };
          if (!doc.passages.some((p) => p.contentHash === passage.contentHash)) doc.passages.push(passage);
          if (!doc.scopes.some((x) => x.libraryId === scope.libraryId && x.requestedVersion === scope.requestedVersion)) doc.scopes.push(scope);
          byUrl.set(sourceUrl, doc);
        }
      }
      // At most docsPerProvider documents, in the provider's order; a document's description is its first passage.
      const docs = [...byUrl.values()].slice(0, L.candidates.docsPerProvider);
      const candidates = docs.map((d, i) => ({ url: d.url, title: d.title, description: d.passages[0].text.slice(0, 600), rank: i + 1, passages: d.passages.slice(0, 6),
        documentation: { scopes: d.scopes, observedVersion: null, programmingLanguages: [...new Set(d.passages.map((p) => p.language).filter(Boolean))] } }));
      const subs = results.map((r) => ({ scope: { libraries: r.scope.libraries, version: r.scope.version }, status: r.status, reason: r.reason ?? null, detail: r.detail ?? null }));
      const ok = results.filter((r) => r.status === "ok" || r.status === "empty"), bad = results.filter((r) => r.status === "failed" || r.status === "unsupported");
      // A scope that got no answer was already judged by dispatch.call: reporting it again only informs availability.
      for (const r of results.filter((x) => x.status === "failed")) await dispatch.report(ctx.sub, ctx.pre.epoch, { reason: r.reason, retryAt: r.retryAt ?? null, retryBasis: r.retryAt ? "documented" : null, providerCode: r.providerCode, detail: r.detail }, { answered: !r.unanswered });
      if (ok.length) await dispatch.report(ctx.sub, ctx.pre.epoch, { success: true, dispatchedAt: t0 });
      const base = { provider: "context7", kind: "docs_search", startedAt: new Date(t0).toISOString(), dispatchState: results.some((r) => r.status === "ok" || r.status === "empty") ? "response_received" : "not_sent",
        suboperations: subs, auxiliaryContext: aux, usage: { requests: results.filter((r) => ["ok", "empty"].includes(r.status) || r.dispatchState === "possibly_sent").length }, detail: mismatched ? `${mismatched} passage(s) of a mismatched version left out` : null };
      if (!ok.length) {
        const first = bad.find((r) => r.status === "failed") ?? bad[0];
        return outcome({ ...base, status: "failed", reason: first?.status === "unsupported" ? "unsupported_request" : first?.reason ?? "internal_failure", detail: first?.detail ?? null });
      }
      const empty = !candidates.length && !aux.length;
      return outcome({ ...base, status: bad.length ? "partial" : empty ? "success_empty" : "success_results", upstreamResultCount: results.reduce((n, r) => n + (r.data ? r.data.codeSnippets.length + r.data.infoSnippets.length : 0), 0), candidates });
    },
  };
}
