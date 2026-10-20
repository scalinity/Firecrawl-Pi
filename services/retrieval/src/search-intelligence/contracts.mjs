// The search-intelligence contracts (docs/FIRECRAWL_PI_SEARCH_INTELLIGENCE_SPEC.md §8, §9): the trusted request the core
// sends to POST /internal/search, the closed set of reasons a provider lane may fail or be skipped for, and the one outcome
// shape every adapter returns. An adapter never throws for a provider's answer: the coordinator turns an unexpected throw
// into internal_failure and keeps its siblings.
import { Denied } from "../ssrf.mjs";

export const REQUEST_SCHEMA = "fcpi.search-request/v1";
export const RESPONSE_SCHEMA = "fcpi.search/v1";
// Versions that enter cache keys and durable records: a change to any of them is a new identity, never a silent reuse.
export const VERSIONS = Object.freeze({ normalizer: "si-normalize/2", ranker: "si-rank/1", rubric: "si-rubric/1", excerpt: "si-excerpt/1", classifier: "si-docs-detect/1", evidence: "si-evidence/1" });

export const GENERAL = ["serper", "brave", "exa", "deepseek", "tavily"];
export const DOCUMENTATION = ["context7", "ref"];
export const FAILURE_REASONS = new Set(["not_configured", "temporarily_unavailable", "breaker_open", "rate_limited", "quota_exhausted", "auth_failed", "contract_failure",
  "unsupported_request", "platform_restricted", "timeout", "cancelled", "capacity_unavailable", "internal_failure"]);
export const STATUSES = new Set(["success_results", "success_empty", "partial", "failed", "skipped"]);

const bad = (msg) => new Denied("INVALID_REQUEST", msg);
const ID = /^[A-Za-z0-9._:-]{8,128}$/, UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i, PRINCIPAL = /^[A-Za-z0-9._:@/-]{1,128}$/;
const INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/;
const only = (o, keys, where) => {
  if (!o || typeof o !== "object" || Array.isArray(o)) throw bad(`${where} must be an object`);
  const extra = Object.keys(o).filter((k) => !keys.includes(k));
  if (extra.length) throw bad(`${where}: unknown ${extra.join(", ")}`);
};

// A hostname as the public contract takes it (no scheme, path or port): IDNA-normalized and lower-case, its trailing dot
// dropped. Null when it is not a hostname.
export function normalizeHostname(raw) {
  if (typeof raw !== "string" || !raw || raw.length > 253 || /[/?#@:\\\s]/.test(raw)) return null;
  try {
    const h = new URL(`http://${raw}`).hostname.replace(/\.$/, "");
    return /^[a-z0-9.-]+$/.test(h) && h.includes(".") && !h.startsWith(".") && !h.includes("..") ? h : null;
  } catch { return null; }
}
// An instant that exists: one that reads back as written (Date.parse rolls 2026-02-30 over to March and T24:00 to the next day).
export function validInstant(v) { return typeof v === "string" && INSTANT.test(v) && Number.isFinite(Date.parse(v)) && new Date(v).toISOString().slice(0, 19) === v.slice(0, 19); }

// The options a caller may set (spec §9.1), checked again here though the gateway checked them: the core is a hop of its own.
export function checkIntelligence(si = {}) {
  only(si, ["documentation", "libraries", "programmingLanguage", "evidence"], "intelligence");
  const out = { documentation: si.documentation ?? "auto", evidence: si.evidence ?? "auto" };
  if (!["auto", "required", "off"].includes(out.documentation)) throw bad("intelligence.documentation must be auto, required or off");
  if (!["auto", "off"].includes(out.evidence)) throw bad("intelligence.evidence must be auto or off");
  if (si.libraries !== undefined) {
    if (!Array.isArray(si.libraries) || si.libraries.length > 4) throw bad("intelligence.libraries holds at most four libraries");
    out.libraries = si.libraries.map((l, i) => {
      only(l, ["name", "version"], `intelligence.libraries[${i}]`);
      if (typeof l.name !== "string" || !l.name.trim() || l.name.length > 200) throw bad(`intelligence.libraries[${i}].name must be 1-200 characters`);
      if (l.version !== undefined && (typeof l.version !== "string" || !l.version.trim() || l.version.length > 80)) throw bad(`intelligence.libraries[${i}].version must be 1-80 characters`);
      return { name: l.name.trim(), ...(l.version !== undefined ? { version: l.version.trim() } : {}) };
    });
  }
  if (si.programmingLanguage !== undefined) {
    if (typeof si.programmingLanguage !== "string" || !si.programmingLanguage.trim() || si.programmingLanguage.length > 64) throw bad("intelligence.programmingLanguage must be 1-64 characters");
    out.programmingLanguage = si.programmingLanguage.trim();
  }
  // Conflicting instructions are refused, never silently dropped.
  if (out.documentation === "off" && (out.libraries?.length || out.programmingLanguage)) throw bad("libraries and programmingLanguage need documentation other than off");
  return out;
}

// The trusted request (spec §9.2). now is the receiving clock; the deadline may not lie in the past or more than the
// public maximum (90 s) plus a little skew ahead.
export function validateSearchRequest(r, now = Date.now()) {
  only(r, ["schema", "requestId", "logicalSearchId", "principalId", "jobId", "originalQuery", "limit", "language", "constraints", "intelligence", "resultMode", "absoluteDeadlineMs"], "the search request");
  if (r.schema !== REQUEST_SCHEMA) throw bad(`schema must be ${REQUEST_SCHEMA}`);
  if (typeof r.requestId !== "string" || !ID.test(r.requestId)) throw bad("requestId must be 8-128 letters, digits, dots, colons, dashes or underscores");
  if (typeof r.logicalSearchId !== "string" || !UUID.test(r.logicalSearchId)) throw bad("logicalSearchId must be a UUID");
  if (typeof r.principalId !== "string" || !PRINCIPAL.test(r.principalId)) throw bad("principalId must be 1-128 safe characters");
  if (r.jobId !== undefined && (typeof r.jobId !== "string" || !ID.test(r.jobId))) throw bad("jobId must be 8-128 safe characters");
  if (typeof r.originalQuery !== "string" || !r.originalQuery.trim() || r.originalQuery.length > 500) throw bad("originalQuery must be 1-500 characters");
  if (!Number.isInteger(r.limit) || r.limit < 1 || r.limit > 10) throw bad("limit must be an integer from 1 to 10");
  if (typeof r.language !== "string" || !/^(auto|[A-Za-z]{2,8}(-[A-Za-z0-9]{1,8}){0,2})$/.test(r.language)) throw bad("language must be auto or a language tag");
  if (!["links", "scrape"].includes(r.resultMode)) throw bad("resultMode must be links or scrape");
  if (!Number.isFinite(r.absoluteDeadlineMs) || r.absoluteDeadlineMs <= now || r.absoluteDeadlineMs > now + 95000) throw bad("absoluteDeadlineMs must lie within the next 95 seconds");
  const c = r.constraints ?? {};
  only(c, ["includeDomains", "excludeDomains", "publishedAfter", "publishedBefore", "dateMode"], "constraints");
  const hosts = (list, where) => {
    if (list === undefined) return [];
    if (!Array.isArray(list) || list.length > 20) throw bad(`${where} holds at most 20 hostnames`);
    return [...new Set(list.map((h) => { const n = normalizeHostname(h); if (!n) throw bad(`${where}: ${String(h).slice(0, 80)} is not a hostname`); return n; }))].sort();
  };
  const constraints = { includeDomains: hosts(c.includeDomains, "includeDomains"), excludeDomains: hosts(c.excludeDomains, "excludeDomains"), dateMode: c.dateMode ?? "freshness" };
  // The pinned core refuses both lists at once; the internal contract keeps that until the public one changes (spec §5.3).
  if (constraints.includeDomains.length && constraints.excludeDomains.length) throw bad("includeDomains and excludeDomains cannot both be given");
  if (!["freshness", "strict_publication"].includes(constraints.dateMode)) throw bad("dateMode must be freshness or strict_publication");
  for (const k of ["publishedAfter", "publishedBefore"]) if (c[k] !== undefined) { if (!validInstant(c[k])) throw bad(`${k} must be an ISO-8601 UTC instant ending in Z`); constraints[k] = new Date(c[k]).toISOString(); }
  if (constraints.publishedAfter && constraints.publishedBefore && !(Date.parse(constraints.publishedAfter) < Date.parse(constraints.publishedBefore))) throw bad("publishedAfter must precede publishedBefore");
  return Object.freeze({ schema: REQUEST_SCHEMA, requestId: r.requestId, logicalSearchId: r.logicalSearchId.toLowerCase(), principalId: r.principalId, ...(r.jobId ? { jobId: r.jobId } : {}),
    originalQuery: r.originalQuery, limit: r.limit, language: r.language, constraints: Object.freeze(constraints), intelligence: Object.freeze(checkIntelligence(r.intelligence ?? {})),
    resultMode: r.resultMode, absoluteDeadlineMs: r.absoluteDeadlineMs });
}

// One provider lane's outcome (spec §8.1), with every field present so traces and summaries never guess.
export function outcome(o) {
  if (!STATUSES.has(o.status)) throw new Error(`unknown outcome status ${o.status}`);
  if (o.reason !== undefined && o.reason !== null && !FAILURE_REASONS.has(o.reason)) throw new Error(`unknown failure reason ${o.reason}`);
  if (["failed", "skipped"].includes(o.status) && !o.reason) throw new Error(`a ${o.status} outcome needs a reason`);
  return {
    provider: o.provider, kind: o.kind ?? "search", status: o.status, reason: o.reason ?? null, detail: o.detail ?? null,
    responseValidated: o.responseValidated ?? ["success_results", "success_empty", "partial"].includes(o.status),
    upstreamResultCount: o.upstreamResultCount ?? null, eligibleResultCount: o.candidates?.length ?? 0,
    candidates: o.candidates ?? [], auxiliaryContext: o.auxiliaryContext ?? [],
    startedAt: o.startedAt ?? null, completedAt: o.completedAt ?? new Date().toISOString(), queueMs: o.queueMs ?? 0, durationMs: o.durationMs ?? 0,
    fromCache: o.fromCache ?? false, originalRetrievedAt: o.originalRetrievedAt ?? null, providerRequestId: o.providerRequestId ?? null,
    dispatchState: o.dispatchState ?? "not_sent", usage: o.usage ?? null, suboperations: o.suboperations ?? [], constraints: o.constraints ?? [],
    error: o.error ?? null, truncated: o.truncated ?? null, filteredEmpty: o.filteredEmpty ?? false, retryAt: o.retryAt ?? null,
  };
}
export const skipped = (provider, reason, detail = null, extra = {}) => outcome({ provider, status: "skipped", reason, detail, ...extra });
export const failed = (provider, reason, detail = null, extra = {}) => outcome({ provider, status: "failed", reason, detail, ...extra });
// Whether a lane produced a provider response the search may stand on (a valid empty counts; Jev never does).
export const validated = (o) => ["success_results", "success_empty", "partial"].includes(o.status) && o.responseValidated;
