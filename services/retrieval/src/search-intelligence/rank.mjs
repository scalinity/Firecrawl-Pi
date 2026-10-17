// Ranking (docs/FIRECRAWL_PI_SEARCH_INTELLIGENCE_SPEC.md §11). Deterministic fusion first: reciprocal rank fusion with k=60,
// each provider one vote per document at its best rank, SearXNG weighted 0.75 as the supplementary lane; raw provider scores
// are kept for debugging and never averaged across providers. Jev's advice, where present, is blended in (§11.2); the final
// selection prefers source diversity without forcing an irrelevant provider into the answer (§11.3).
import { registrableHost } from "./normalize.mjs";

export const RRF_K = 60;
export const WEIGHTS = Object.freeze({ serper: 1, brave: 1, exa: 1, deepseek: 1, tavily: 1, context7: 1, ref: 1, searxng: 0.75 });
const R_SCALE = 3 / (RRF_K + 1); // three providers agreeing at rank 1: the fixed consensus cap, not the pool's best

export function fuse(docs) {
  for (const d of docs) {
    const rrf = d.observations.reduce((n, o) => n + (WEIGHTS[o.provider] ?? 0) / (RRF_K + o.rank), 0);
    d.fusion = { rrf, normalized: Math.min(1, rrf / R_SCALE) };
  }
  return docs;
}

// Query terms that matter literally: quoted phrases, identifiers (dots, underscores, colons, slashes, parentheses), version
// strings, and words of three or more letters outside a small stop list. Case is folded only for comparison.
const STOP = new Set("the and for with from that this what how why when where which who are was were does did can could should would will into about over under your you our their there have has had not but use using get set".split(" "));
export function queryTerms(query) {
  const terms = new Set();
  for (const m of query.matchAll(/"([^"]{2,200})"/g)) terms.add(m[1].toLowerCase());
  const bare = query.replace(/"[^"]*"/g, " ");
  for (const t of bare.split(/\s+/)) {
    const w = t.replace(/^[^\p{L}\p{N}_.@/:-]+|[^\p{L}\p{N}_)(.@/:-]+$/gu, "").toLowerCase();
    if (!w || w.startsWith("-")) continue;
    if (/[._:/()]/.test(w) || /\d/.test(w) || (w.length >= 3 && !STOP.has(w))) terms.add(w.replace(/[.,;:]+$/, ""));
  }
  return [...terms].filter(Boolean);
}
// The fraction of the query's literal terms the document's title, description and passages hold, with requested library
// versions counted as terms (spec §11.1: literal/version/domain relevance before RRF when filling the shortlist).
export function literalRelevance(doc, query, intelligence = {}) {
  const terms = queryTerms(query);
  for (const l of intelligence.libraries ?? []) if (l.version) terms.push(String(l.version).toLowerCase());
  if (!terms.length) return 0;
  const text = `${doc.title}\n${doc.description}\n${doc.passages.map((p) => p.text ?? "").join("\n")}`.toLowerCase();
  return terms.filter((t) => text.includes(t)).length / terms.length;
}

const byId = (a, b) => (a.documentId < b.documentId ? -1 : a.documentId > b.documentId ? 1 : 0);
// The documents Jev assesses (spec §11.1): each provider's top seedPerProvider first, so a uniquely relevant discovery of one
// provider is never shortlisted away by consensus, then literal relevance, then RRF, ties by document id.
export function shortlist(docs, { max, seedPerProvider, providers }) {
  const chosen = new Set();
  for (const p of providers) {
    const own = docs.filter((d) => d.observations.some((o) => o.provider === p)).sort((a, b) => a.observations.find((o) => o.provider === p).rank - b.observations.find((o) => o.provider === p).rank || byId(a, b));
    for (const d of own.slice(0, seedPerProvider)) { if (chosen.size >= max) break; chosen.add(d); }
  }
  const rest = docs.filter((d) => !chosen.has(d)).sort((a, b) => b.literal - a.literal || b.fusion.rrf - a.fusion.rrf || byId(a, b));
  for (const d of rest) { if (chosen.size >= max) break; chosen.add(d); }
  return [...chosen];
}

// Jev's blend (spec §11.2): Q from the relevance Score (0..4 levels, normalized), the direct-answer and evidence Nouls; the
// Score's own confidence, when reported, sets how much Q counts (0.325..0.65), a neutral 0.5 when it is absent.
export function blend(R, s) {
  const L = s.relevance / 4, D = s.directness, E = s.evidence;
  const c = Number.isFinite(s.confidence) ? Math.min(1, Math.max(0, s.confidence)) : 0.5;
  const Q = 0.5 * L + 0.3 * D + 0.2 * E;
  const a = 0.65 * (0.5 + 0.5 * c);
  return { Q, a, S: (1 - a) * R + a * Q };
}

// The final selection (spec §11.3): by score with a soft same-host penalty (0.08 for a second result from one registrable
// host, 0.16 after), off for an explicit single-domain search; a soft republication group adds 0.08 per member already
// chosen. Each displacement is recorded. Nothing is invented to fill the limit.
export function selectFinal(docs, limit, { singleDomain = false } = {}) {
  const left = [...docs], out = [], hosts = new Map(), groups = new Map();
  while (out.length < limit && left.length) {
    let best = null;
    for (const d of left) {
      const h = registrableHost(d.host), n = hosts.get(h) ?? 0;
      const penalty = (singleDomain ? 0 : n === 0 ? 0 : n === 1 ? 0.08 : 0.16) + (d.softGroup ? 0.08 * (groups.get(d.softGroup) ?? 0) : 0);
      const adjusted = d.score - penalty;
      if (!best || adjusted > best.adjusted || (adjusted === best.adjusted && byId(d, best.d) < 0)) best = { d, adjusted, penalty };
    }
    const top = left.reduce((m, d) => (!m || d.score > m.score || (d.score === m.score && byId(d, m) < 0) ? d : m), null);
    if (top !== best.d) top.displaced ??= { code: "diversity_penalty", by: best.d.documentId };
    out.push(best.d);
    left.splice(left.indexOf(best.d), 1);
    const h = registrableHost(best.d.host);
    hosts.set(h, (hosts.get(h) ?? 0) + 1);
    if (best.d.softGroup) groups.set(best.d.softGroup, (groups.get(best.d.softGroup) ?? 0) + 1);
  }
  out.forEach((d, i) => { d.finalRank = i + 1; });
  return out;
}
