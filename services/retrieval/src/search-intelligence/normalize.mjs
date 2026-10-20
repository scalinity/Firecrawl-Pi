// Normalization and the candidate pool (docs/FIRECRAWL_PI_SEARCH_INTELLIGENCE_SPEC.md §5.3, §10). Deterministic throughout:
// the order providers answered in never changes an identity, a tie or which documents are kept.
//   - a query keeps its case, punctuation, quoted literals, negations and version strings; only Unicode form and the
//     whitespace outside quotes are normalized (R and r, or a case-sensitive path, are different queries);
//   - a URL loses only an explicit list of tracking parameters; its path case, other parameters and their order, and a
//     trailing slash stay, and http/https or www/bare hosts are never equated;
//   - a document is its URL without the fragment, plus its documentation version when one is actually known, so two known
//     versions stay two documents and an unknown version never inherits a known one;
//   - a provider contributes one observation per document, at its best rank.
import { createHash } from "node:crypto";
import { getDomain } from "tldts";
import { urlVersionCheck } from "./versions.mjs";

export const TRACKING_PARAMS = Object.freeze(["utm_source", "utm_medium", "utm_campaign", "utm_term", "utm_content", "gclid", "fbclid"]);
export const sha256 = (s) => createHash("sha256").update(s).digest("hex");
// Exact passage identity after benign line-ending normalization only.
export const contentHash = (text) => sha256(String(text).replace(/\r\n?/g, "\n"));
export const utf8Bytes = (s) => Buffer.byteLength(s, "utf8");

export function normalizeQueryText(q) {
  const parts = String(q).normalize("NFC").split('"');
  return parts.map((p, i) => (i % 2 === 0 ? p.replace(/\s+/g, " ") : p)).join('"').trim();
}

// null when the URL is not one a result may carry: http(s) only, no userinfo, at most 2 KiB.
export function normalizeUrl(raw) {
  if (typeof raw !== "string" || raw.length > 2048) return null;
  let u;
  try { u = new URL(raw.trim()); } catch { return null; }
  if (!["http:", "https:"].includes(u.protocol) || u.username || u.password || !u.hostname) return null;
  const fragment = u.hash ? u.hash.slice(1) : null;
  u.hash = "";
  if (u.search) {
    const kept = [...u.searchParams].filter(([k]) => !TRACKING_PARAMS.includes(k));
    if (kept.length !== [...u.searchParams].length) u.search = kept.length ? `?${new URLSearchParams(kept).toString()}` : "";
  }
  return { url: u.toString(), fragment, host: u.hostname.replace(/\.$/, "") };
}

// Exact hostname or subdomain membership at a label boundary: example.com.evil.test and notexample.com do not match example.com.
export function hostMatches(host, domain) { return host === domain || host.endsWith(`.${domain}`); }
export const registrableHost = (host) => getDomain(host, { allowPrivateDomains: true }) ?? host;

// The local checks that make an explicit constraint hard whatever a provider did with it (spec §5.3). freshness is a
// discovery preference and filters nothing; strict_publication needs a timestamp identified as publication metadata.
export function checkConstraints(doc, constraints) {
  const statuses = [];
  if (constraints.includeDomains.length) {
    const ok = constraints.includeDomains.some((d) => hostMatches(doc.host, d));
    statuses.push({ constraint: "includeDomains", status: ok ? "satisfied" : "violated" });
    if (!ok) return { ok: false, why: "domain_not_included", statuses };
  }
  if (constraints.excludeDomains.some((d) => hostMatches(doc.host, d))) return { ok: false, why: "domain_excluded", statuses: [...statuses, { constraint: "excludeDomains", status: "violated" }] };
  if (constraints.excludeDomains.length) statuses.push({ constraint: "excludeDomains", status: "satisfied" });
  const bounded = constraints.publishedAfter || constraints.publishedBefore;
  if (bounded && constraints.dateMode === "strict_publication") {
    const p = doc.publication;
    if (!p || p.meaning !== "published" || !Number.isFinite(Date.parse(p.at))) return { ok: false, why: "publication_unverified", statuses: [...statuses, { constraint: "publication", status: "unverified" }] };
    const at = Date.parse(p.at);
    if ((constraints.publishedAfter && at < Date.parse(constraints.publishedAfter)) || (constraints.publishedBefore && at >= Date.parse(constraints.publishedBefore)))
      return { ok: false, why: "publication_out_of_range", statuses: [...statuses, { constraint: "publication", status: "violated" }] };
    statuses.push({ constraint: "publication", status: "satisfied", basis: p.basis });
  } else if (bounded) statuses.push({ constraint: "publication", status: "preference" });
  return { ok: true, statuses };
}

const versionKey = (c) => c.documentation?.observedVersion ?? null;
const scopeConfirms = (c) => (c.documentation?.scopes ?? []).some((s) => s.status === "scope_only" || s.status === "match");
export const documentIdOf = (url, observedVersion) => sha256(`${url}\n${observedVersion ?? ""}`).slice(0, 24);

// One provider's candidates, normalized and constrained. Returns the kept candidates (each with its document identity) and
// what was dropped, so an empty lane can say whether the provider found nothing or everything was filtered.
export function prepareCandidates(provider, candidates, constraints, versions = []) {
  const kept = [], dropped = { invalid: 0, constraint: {}, versionMismatch: [] };
  for (const c of candidates) {
    const n = normalizeUrl(c.url);
    if (!n) { dropped.invalid++; continue; }
    const doc = { ...c, canonicalUrl: n.url, host: n.host, fragment: n.fragment };
    const check = checkConstraints(doc, constraints);
    if (!check.ok) { dropped.constraint[check.why] = (dropped.constraint[check.why] ?? 0) + 1; continue; }
    // A hard version (spec §11.2): a candidate whose URL states another release is removed here, before ranking, whatever Jev would say. A documentation
    // candidate whose provider scope confirms the version is left to that scope; one without (Ref has no version scope, a Context7 scope can be unknown) is
    // checked by its URL like any other. A kept row says whether its URL confirmed the version, so "unverified" is never silent.
    const statuses = [...check.statuses];
    if (versions.length && !scopeConfirms(c)) {
      const v = urlVersionCheck(n.url, versions);
      if (v.status === "mismatch") { dropped.constraint.version_mismatch = (dropped.constraint.version_mismatch ?? 0) + 1; dropped.versionMismatch.push(n.url); continue; }
      statuses.push(v.status === "match" ? { constraint: "version", status: "satisfied", basis: "url" } : { constraint: "version", status: "unverified" });
    }
    kept.push({ ...doc, provider, documentId: documentIdOf(n.url, versionKey(c)), constraintStatus: statuses });
  }
  return { kept, dropped };
}

const ORDER = ["serper", "brave", "exa", "deepseek", "tavily", "context7", "ref", "searxng"];
const providerRank = (p) => { const i = ORDER.indexOf(p); return i < 0 ? ORDER.length : i; };

// The pool (spec §5.1, §10): the providers' kept candidates merged into documents, then at most poolMax of them, chosen
// fairly by each provider's own rank (every provider's first, then every provider's second, ...), never by arrival.
export function buildPool(lanes, { poolMax, workingSetBytes }) {
  const docs = new Map();
  for (const lane of [...lanes].sort((a, b) => providerRank(a.provider) - providerRank(b.provider))) {
    for (const c of lane.kept) {
      let d = docs.get(c.documentId);
      if (!d) {
        d = { documentId: c.documentId, canonicalUrl: c.canonicalUrl, displayUrl: c.url, host: c.host, originalUrls: [], title: "", description: "", observations: [],
          passages: [], publication: null, documentation: c.documentation ?? null, constraintStatus: c.constraintStatus, dedupAliases: [], best: null };
        docs.set(c.documentId, d);
      }
      if (!d.originalUrls.includes(c.url)) d.originalUrls.push(c.url);
      // Each observation keeps the exact URL its provider returned (spec §6.2: a Ref read is sent that URL, not the canonical one).
      const prior = d.observations.find((o) => o.provider === c.provider);
      if (!prior) d.observations.push({ provider: c.provider, rank: c.rank, rawScore: c.rawScore ?? null, retrievedAt: lane.retrievedAt, fromCache: lane.fromCache, resultId: c.resultId ?? null, fragment: c.fragment, providerUrl: c.providerUrl ?? c.url });
      else if (c.rank < prior.rank) Object.assign(prior, { rank: c.rank, rawScore: c.rawScore ?? null, resultId: c.resultId ?? null, fragment: c.fragment, providerUrl: c.providerUrl ?? c.url });
      // Title and description come from the best-ranked observation (ties by provider order, which the lane order fixes).
      if (!d.best || c.rank < d.best.rank) { d.best = { rank: c.rank, provider: c.provider }; d.title = c.title ?? ""; d.description = c.description ?? ""; d.displayUrl = c.url; }
      if (!d.publication && c.publication) d.publication = { ...c.publication, provider: c.provider };
      for (const p of c.passages ?? []) if (!d.passages.some((x) => x.contentHash === p.contentHash)) d.passages.push(p);
      // A provider's own snippets of the result (Brave's extra snippets, Exa's highlights) become its passages, so literal
      // relevance and Jev's excerpts read them; they are the provider's text, not acquired page content.
      for (const text of c.snippets ?? []) {
        if (typeof text !== "string" || !text.trim() || text === c.description) continue;
        const h = contentHash(text);
        if (!d.passages.some((x) => x.contentHash === h)) d.passages.push({ passageId: sha256(`${c.provider}\n${c.documentId}\n${h}`).slice(0, 24), provider: c.provider, kind: "provider_snippet", text, contentHash: h });
      }
    }
  }
  const all = [...docs.values()];
  const byProvider = new Map();
  for (const d of all) for (const o of d.observations) (byProvider.get(o.provider) ?? byProvider.set(o.provider, []).get(o.provider)).push({ d, rank: o.rank });
  for (const list of byProvider.values()) list.sort((a, b) => a.rank - b.rank || (a.d.documentId < b.d.documentId ? -1 : 1));
  const chosen = new Set(), providers = [...byProvider.keys()].sort((a, b) => providerRank(a) - providerRank(b));
  for (let i = 0; chosen.size < Math.min(poolMax, all.length); i++) {
    let any = false;
    for (const p of providers) { const e = byProvider.get(p)[i]; if (e) { any = true; if (chosen.size < poolMax) chosen.add(e.d); } }
    if (!any) break;
  }
  const pool = [...chosen].sort((a, b) => (a.documentId < b.documentId ? -1 : 1));
  for (const d of pool) delete d.best;
  // The working set's text is bounded: the lowest-supported documents' passages are cut first; identities, ranks and counts stay.
  let truncatedPassages = 0, bytes = pool.reduce((n, d) => n + utf8Bytes(d.title) + utf8Bytes(d.description) + d.passages.reduce((m, p) => m + utf8Bytes(p.text ?? ""), 0), 0);
  if (bytes > workingSetBytes) {
    const order = [...pool].sort((a, b) => a.observations.length - b.observations.length || Math.min(...b.observations.map((o) => o.rank)) - Math.min(...a.observations.map((o) => o.rank)));
    for (const d of order) {
      while (bytes > workingSetBytes && d.passages.length) { const p = d.passages.pop(); bytes -= utf8Bytes(p.text ?? ""); truncatedPassages++; }
      if (bytes <= workingSetBytes) break;
    }
  }
  return { pool, distinct: all.length, truncatedPassages };
}
