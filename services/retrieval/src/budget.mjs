// Provider budgets (FIRECRAWL_PI_SPEC.md §14, §15, §28.3): the budget policy file (PI_BUDGET_POLICY_FILE),
// validated at startup with unknown keys refused; the rate card in effect for a model or parser; the
// arithmetic of reservations and settlements; and a breaker per provider. The ledger itself is in
// store.mjs, where every reservation is one transaction.
const CAT_KEYS = ["paid", "unit", "caps"];
const TOP_KEYS = ["schema", "comment", "notifyAtFraction", "categories", "paidTotal", "providers", "models", "parsers", "proxies", "rateCards", "extraction", "parsing", "proxying", "breaker"];
const EXTRACTION_KEYS = ["defaultModel", "maxInputTokens", "maxOutputTokens", "maxRepairs", "maxDocuments", "maxDocumentBytes", "maxChunks", "maxSchemaBytes",
  "maxSchemaDepth", "maxSchemaProperties", "maxPromptChars", "requestTimeoutMs", "resultMaxBytes"];
const PARSING_KEYS = ["defaultParser", "maxPages", "maxBytes", "cacheDays", "jobTimeoutMs"];

function exact(obj, keys, where, optional = []) {
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) throw new Error(`${where} must be an object`);
  const extra = Object.keys(obj).filter((k) => !keys.includes(k) && !optional.includes(k));
  const missing = keys.filter((k) => !(k in obj));
  if (extra.length || missing.length) throw new Error(`${where}: unknown ${extra.join(",") || "-"}; missing ${missing.join(",") || "-"}`);
}
const nonNegInt = (v, where) => { if (!Number.isSafeInteger(v) || v < 0) throw new Error(`${where} must be a non-negative integer`); return v; };
const posInt = (v, lo, hi, where) => { if (!Number.isSafeInteger(v) || v < lo || v > hi) throw new Error(`${where} must be an integer in ${lo}..${hi}`); return v; };
const DATE = /^\d{4}-\d{2}-\d{2}$/;

export function loadBudgetPolicy(text) {
  const p = JSON.parse(text);
  exact(p, TOP_KEYS, "budget policy");
  if (p.schema !== "fcpi.budget-policy/v1") throw new Error("budget policy schema must be fcpi.budget-policy/v1");
  if (!(p.notifyAtFraction > 0 && p.notifyAtFraction < 1)) throw new Error("notifyAtFraction must lie strictly between 0 and 1");
  for (const [name, c] of Object.entries(p.categories)) {
    exact(c, CAT_KEYS, `category ${name}`);
    if (typeof c.paid !== "boolean") throw new Error(`category ${name}.paid must be a boolean`);
    if (!["micro_usd", "credits"].includes(c.unit)) throw new Error(`category ${name}.unit must be micro_usd or credits`);
    const periods = Object.keys(c.caps);
    if (!periods.length || periods.some((k) => !["day", "month"].includes(k))) throw new Error(`category ${name}.caps must name day and/or month`);
    for (const k of periods) nonNegInt(c.caps[k], `category ${name}.caps.${k}`);
  }
  exact(p.paidTotal, ["unit", "caps"], "paidTotal");
  if (p.paidTotal.unit !== "micro_usd") throw new Error("paidTotal.unit must be micro_usd");
  exact(p.paidTotal.caps, ["day"], "paidTotal.caps");
  nonNegInt(p.paidTotal.caps.day, "paidTotal.caps.day");
  for (const [name, v] of Object.entries(p.providers)) {
    exact(v, ["kind", "baseUrl", "credential", "paid"], `provider ${name}`, ["maxTokensParam", "store", "usageUrl", "usageCredential", "usageDedicated", "session"]);
    if (!["model", "parser", "proxy"].includes(v.kind)) throw new Error(`provider ${name}.kind must be model, parser or proxy`);
    const u = new URL(v.baseUrl);
    const fixture = /\.fixture\.fcpi\.test$/.test(u.hostname);
    // M6: a residential proxy speaks the HTTP proxy protocol at host:port and always authenticates, a fixture proxy
    // included; its usage report, where one exists, is an https API (a fixture's is on the fixture network).
    if (v.kind === "proxy") {
      if (u.protocol !== "http:" || !u.port || u.pathname !== "/" || u.search || u.username) throw new Error(`provider ${name}: a proxy's baseUrl is http://host:port`);
      if (v.paid === fixture) throw new Error(`provider ${name}: a paid proxy is a public service and an unpaid one a project fixture`);
      if (typeof v.credential !== "string" || !/^[a-z0-9_]{3,64}$/.test(v.credential)) throw new Error(`provider ${name}.credential must be a file name`);
      // How the sticky session is named in the proxy username; only Decodo's documented form is implemented.
      if (v.session !== "decodo") throw new Error(`provider ${name}.session must be decodo`);
      if (v.usageUrl !== undefined) {
        const q = new URL(v.usageUrl);
        if ((v.paid && q.protocol !== "https:") || (!v.paid && !/\.fixture\.fcpi\.test$/.test(q.hostname))) throw new Error(`provider ${name}.usageUrl must be https (a fixture's on the fixture network)`);
        if (v.usageCredential !== null && !/^[a-z0-9_]{3,64}$/.test(v.usageCredential ?? "")) throw new Error(`provider ${name}.usageCredential must be a file name or null`);
        // Whether the report covers this deployment alone: only then is it reconciled (reconcile.mjs).
        if (typeof v.usageDedicated !== "boolean") throw new Error(`provider ${name}.usageDedicated must be true or false`);
      }
      continue;
    }
    // A paid provider is a public https service with a credential; an unpaid one is a project fixture.
    if (v.paid && (u.protocol !== "https:" || fixture || typeof v.credential !== "string")) throw new Error(`provider ${name}: a paid provider is an https service with a credential`);
    if (!v.paid && (!fixture || u.protocol !== "http:" || v.credential !== null)) throw new Error(`provider ${name}: an unpaid provider must be a project fixture without a credential`);
    if (v.credential !== null && !/^[a-z0-9_]{3,64}$/.test(v.credential)) throw new Error(`provider ${name}.credential must be a file name`);
    if (v.kind === "model" && !["max_completion_tokens", "max_tokens"].includes(v.maxTokensParam)) throw new Error(`provider ${name}.maxTokensParam must be max_completion_tokens or max_tokens`);
  }
  const subjectOf = (kind, map) => {
    for (const [name, m] of Object.entries(map)) {
      exact(m, ["provider", "category"], `${kind} ${name}`, kind === "parser" ? ["tier", "version"] : []);
      const prov = p.providers[m.provider], cat = p.categories[m.category];
      if (!prov || prov.kind !== kind) throw new Error(`${kind} ${name} names ${m.provider}, which is not a ${kind} provider`);
      if (!cat) throw new Error(`${kind} ${name} names unknown category ${m.category}`);
      if (cat.paid !== prov.paid) throw new Error(`${kind} ${name}: a paid provider draws on a paid category and an unpaid one on an unpaid category`);
      if (cat.unit !== (kind === "parser" ? "credits" : "micro_usd")) throw new Error(`${kind} ${name}: category ${m.category} counts the wrong unit`);
      if (kind === "parser" && (typeof m.tier !== "string" || typeof m.version !== "string")) throw new Error(`parser ${name} needs a tier and a version`);
    }
  };
  subjectOf("model", p.models);
  subjectOf("parser", p.parsers);
  subjectOf("proxy", p.proxies);
  if (!Array.isArray(p.rateCards)) throw new Error("rateCards must be a list");
  const ids = new Set();
  for (const r of p.rateCards) {
    const isParser = Object.hasOwn(p.parsers, r.subject), isProxy = Object.hasOwn(p.proxies, r.subject);
    if (!Object.hasOwn(p.models, r.subject) && !isParser && !isProxy) throw new Error(`rate card ${r.id} names an unknown subject ${r.subject}`);
    exact(r, isParser ? ["id", "subject", "effectiveFrom", "effectiveTo", "creditsPerPage", "microUsdPerCredit", "source"]
      : isProxy ? ["id", "subject", "effectiveFrom", "effectiveTo", "microUsdPerGB", "billing", "source"]
      : ["id", "subject", "effectiveFrom", "effectiveTo", "inputPerMTok", "cachedInputPerMTok", "outputPerMTok", "source"], `rate card ${r.id}`);
    if (ids.has(r.id)) throw new Error(`rate card ${r.id} appears twice`);
    ids.add(r.id);
    if (!DATE.test(r.effectiveFrom) || (r.effectiveTo !== null && (!DATE.test(r.effectiveTo) || r.effectiveTo <= r.effectiveFrom))) throw new Error(`rate card ${r.id}: effective dates must be YYYY-MM-DD, the end after the start`);
    if (isParser) { posInt(r.creditsPerPage, 1, 1000, `rate card ${r.id}.creditsPerPage`); nonNegInt(r.microUsdPerCredit, `rate card ${r.id}.microUsdPerCredit`); }
    else if (isProxy) {
      // Bytes are priced per decimal GB (1e9 bytes, the larger count of the two readings of "GB"), both directions.
      posInt(r.microUsdPerGB, 1, 1e9, `rate card ${r.id}.microUsdPerGB`);
      if (r.billing !== "upload_plus_download_per_1e9_bytes") throw new Error(`rate card ${r.id}.billing must be upload_plus_download_per_1e9_bytes`);
    } else for (const k of ["inputPerMTok", "cachedInputPerMTok", "outputPerMTok"]) posInt(r[k], 1, 1e9, `rate card ${r.id}.${k}`);
  }
  // Two cards for one subject may not both be in effect on any day.
  for (const a of p.rateCards) for (const b of p.rateCards) {
    if (a === b || a.subject !== b.subject) continue;
    const endA = a.effectiveTo ?? "9999-12-31", endB = b.effectiveTo ?? "9999-12-31";
    if (a.effectiveFrom < endB && b.effectiveFrom < endA) throw new Error(`rate cards ${a.id} and ${b.id} overlap`);
  }
  exact(p.extraction, EXTRACTION_KEYS, "extraction");
  if (!(p.extraction.defaultModel in p.models)) throw new Error("extraction.defaultModel must be a listed model");
  // Spec §14's ceilings may be tightened, never loosened.
  posInt(p.extraction.maxInputTokens, 1000, 32000, "extraction.maxInputTokens");
  posInt(p.extraction.maxOutputTokens, 100, 4000, "extraction.maxOutputTokens");
  posInt(p.extraction.maxRepairs, 0, 1, "extraction.maxRepairs");
  posInt(p.extraction.maxDocuments, 1, 25, "extraction.maxDocuments");
  posInt(p.extraction.maxDocumentBytes, 1024, 4 * 1048576, "extraction.maxDocumentBytes");
  posInt(p.extraction.maxChunks, 1, 50, "extraction.maxChunks");
  posInt(p.extraction.maxSchemaBytes, 256, 65536, "extraction.maxSchemaBytes");
  posInt(p.extraction.maxSchemaDepth, 1, 10, "extraction.maxSchemaDepth");
  posInt(p.extraction.maxSchemaProperties, 1, 500, "extraction.maxSchemaProperties");
  posInt(p.extraction.maxPromptChars, 1, 20000, "extraction.maxPromptChars");
  posInt(p.extraction.requestTimeoutMs, 1000, 120000, "extraction.requestTimeoutMs");
  posInt(p.extraction.resultMaxBytes, 1024, 4 * 1048576, "extraction.resultMaxBytes");
  exact(p.parsing, PARSING_KEYS, "parsing");
  if (!(p.parsing.defaultParser in p.parsers)) throw new Error("parsing.defaultParser must be a listed parser");
  posInt(p.parsing.maxPages, 1, 100, "parsing.maxPages");
  posInt(p.parsing.maxBytes, 1024, 25 * 1048576, "parsing.maxBytes");
  posInt(p.parsing.cacheDays, 1, 30, "parsing.cacheDays");
  posInt(p.parsing.jobTimeoutMs, 1000, 600000, "parsing.jobTimeoutMs");
  // M6: the residential proxy the deployment uses unless the host's selection names another, and the byte caps that
  // bound each reservation (spec §28.3: reserve a conservative maximum before dispatch).
  exact(p.proxying, ["defaultProxy", "maxAttemptBytes", "maxTunnelBytes"], "proxying");
  if (p.proxying.defaultProxy !== null && !Object.hasOwn(p.proxies, p.proxying.defaultProxy)) throw new Error("proxying.defaultProxy must be a listed proxy or null");
  posInt(p.proxying.maxAttemptBytes, 65536, 64 * 1048576, "proxying.maxAttemptBytes");
  posInt(p.proxying.maxTunnelBytes, 65536, 16 * 1048576, "proxying.maxTunnelBytes");
  exact(p.breaker, ["failures", "windowMs", "openMs"], "breaker");
  posInt(p.breaker.failures, 1, 20, "breaker.failures");
  posInt(p.breaker.windowMs, 1000, 3600000, "breaker.windowMs");
  posInt(p.breaker.openMs, 1000, 3600000, "breaker.openMs");
  return p;
}

// The UTC day as YYYY-MM-DD, and the first day of its month.
export function periodStarts(now = new Date()) {
  const day = now.toISOString().slice(0, 10);
  return { day, month: `${day.slice(0, 7)}-01` };
}

// The one rate card in effect for `subject` today, or null (the caller fails closed).
export function rateCardFor(policy, subject, now = new Date()) {
  const { day } = periodStarts(now);
  return policy.rateCards.find((r) => r.subject === subject && r.effectiveFrom <= day && (r.effectiveTo === null || day < r.effectiveTo)) ?? null;
}

// Micro-USD for proxied bytes, rounded up so settlement never undercounts.
export const proxyCost = (card, bytes) => Math.ceil((bytes * card.microUsdPerGB) / 1e9);

// Micro-USD for a model call, rounded up so settlement never undercounts.
export function modelCost(card, { promptTokens, cachedTokens = 0, completionTokens }) {
  const cached = Math.min(cachedTokens, promptTokens);
  return Math.ceil(((promptTokens - cached) * card.inputPerMTok + cached * card.cachedInputPerMTok + completionTokens * card.outputPerMTok) / 1e6);
}

// The conservative maximum a model call can cost: its input can hold no more tokens than bytes (every
// token of a byte-level tokenizer covers at least one byte), and its output no more than it may write.
export const maxModelCost = (card, inputBytes, maxOutputTokens) => modelCost(card, { promptTokens: inputBytes, completionTokens: maxOutputTokens });

// A token estimate for chunking under the input cap: three bytes per token for ASCII text (o200k and
// cl100k average near four on prose and markdown), one token per character beyond ASCII (CJK runs are
// about one each). The estimate bounds chunks; the reservation holds the byte count, so a misestimate
// can never spend more than was reserved.
export function estimateTokens(text) {
  let ascii = 0, other = 0;
  for (const ch of text) { if (ch.charCodeAt(0) < 128) ascii++; else other++; }
  return Math.ceil(ascii / 3) + other;
}

// A breaker per provider (spec §11's defaults, reused for model and parser providers): `failures`
// provider-level failures within `windowMs` open it for `openMs`, after which one probe is let through;
// its success closes it, its failure opens it again.
export class Breaker {
  constructor({ failures, windowMs, openMs }, now = () => Date.now()) {
    Object.assign(this, { limit: failures, windowMs, openMs, now });
    this.fails = []; this.openUntil = 0; this.probing = false;
  }
  state() {
    if (this.now() < this.openUntil) return "open";
    return this.openUntil ? "half_open" : "closed";
  }
  // True when a call may go out; a half-open breaker admits one probe at a time.
  admit() {
    const s = this.state();
    if (s === "open") return false;
    if (s === "half_open") { if (this.probing) return false; this.probing = true; }
    return true;
  }
  success() { this.fails = []; this.openUntil = 0; this.probing = false; }
  failure() {
    const t = this.now();
    if (this.probing) { this.probing = false; this.openUntil = t + this.openMs; this.fails = []; return; }
    this.fails = this.fails.filter((x) => t - x < this.windowMs);
    this.fails.push(t);
    if (this.fails.length >= this.limit) { this.openUntil = t + this.openMs; this.fails = []; }
  }
  // The call ended without a provider verdict (the caller's own refusal): a probe slot is returned.
  neutral() { this.probing = false; }
  retryAfterS() { return Math.max(1, Math.ceil((this.openUntil - this.now()) / 1000)); }
}
