// Provider budgets (FIRECRAWL_PI_SPEC.md §14, §15, §28.3): the budget policy file (PI_BUDGET_POLICY_FILE),
// validated at startup with unknown keys refused; the rate card in effect for a model or parser; the
// arithmetic of reservations and settlements; and a breaker per provider. The ledger itself is in
// store.mjs, where every reservation is one transaction.
const CAT_KEYS = ["paid", "unit", "caps"];
const TOP_KEYS = ["schema", "comment", "notifyAtFraction", "categories", "paidTotal", "providers", "models", "parsers", "proxies", "enhancers", "rateCards", "extraction", "parsing", "proxying", "enhancing", "breaker"];
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

// Search intelligence (docs/FIRECRAWL_PI_SEARCH_INTELLIGENCE_SPEC.md §18): each external search, documentation and decision
// API is one adapter contract at one fixed origin. A fixture provider of the same API is a project fixture over http.
export const SEARCH_APIS = Object.freeze({
  "serper-v1": { kind: "search", origin: "https://google.serper.dev", lane: "serper" },
  "brave-web-v1": { kind: "search", origin: "https://api.search.brave.com", lane: "brave" },
  "exa-search-v1": { kind: "search", origin: "https://api.exa.ai", lane: "exa" },
  "deepseek-search-v1": { kind: "search", origin: "https://api.deepseek.com", lane: "deepseek" },
  "tavily-search-v1": { kind: "search", origin: "https://api.tavily.com", lane: "tavily" },
  "context7-v3": { kind: "documentation", origin: "https://context7.com", lane: "context7" },
  "ref-mcp-v1": { kind: "documentation", origin: "https://api.ref.tools", lane: "ref" },
  "openrouter-decisions-v1": { kind: "decision", origin: "https://openrouter.ai", lane: "jev" },
});
// The aggregate profile's exact rosters: one subject of each API, never fewer (spec §4: no engine is silently omitted).
export const GENERAL_APIS = ["serper-v1", "brave-web-v1", "exa-search-v1", "deepseek-search-v1", "tavily-search-v1"];
export const DOCUMENTATION_APIS = ["context7-v3", "ref-mcp-v1"];
export const JEV_MODEL = "typesafe/jev-1.14";
// How a search, documentation or decision rate card meters one operation, and the category unit each basis counts in.
const BILLING_UNITS = { credits_per_operation: "credits", micro_usd_per_operation: "micro_usd", requests: "requests", decision_tokens: "micro_usd" };

// The shared daily cap across the paid categories in micro-USD, or null when the policy sets none. A cap set later counts
// only the reservations made while it is set, as every category's period row does.
export const paidTotalDayCap = (policy) => policy.paidTotal.caps.day ?? null;

// A session policy's absolute lease survives process and daemon restarts. Check at dispatch, including
// after asynchronous waits; already-dispatched work may still settle, poll, and delete its upload.
export function paidDispatchActive(policy, enabled, now = Date.now()) {
  return enabled && (policy.validationExpiresAt === undefined || now < Date.parse(policy.validationExpiresAt));
}

export function loadBudgetPolicy(text) {
  const p = JSON.parse(text);
  exact(p, TOP_KEYS, "budget policy", ["validationExpiresAt", "searches", "searching", "documentationSearches", "decisions"]);
  p.searches ??= {};
  p.documentationSearches ??= {};
  p.decisions ??= {};
  if (p.validationExpiresAt !== undefined && (typeof p.validationExpiresAt !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(p.validationExpiresAt)
    || !Number.isFinite(Date.parse(p.validationExpiresAt)) || new Date(p.validationExpiresAt).toISOString().replace(".000Z", "Z") !== p.validationExpiresAt)) throw new Error("validationExpiresAt must be an exact UTC timestamp");
  if (p.schema !== "fcpi.budget-policy/v1") throw new Error("budget policy schema must be fcpi.budget-policy/v1");
  if (!(p.notifyAtFraction > 0 && p.notifyAtFraction < 1)) throw new Error("notifyAtFraction must lie strictly between 0 and 1");
  for (const [name, c] of Object.entries(p.categories)) {
    exact(c, CAT_KEYS, `category ${name}`);
    if (typeof c.paid !== "boolean") throw new Error(`category ${name}.paid must be a boolean`);
    if (!["micro_usd", "credits", "requests"].includes(c.unit)) throw new Error(`category ${name}.unit must be micro_usd, credits or requests`);
    // No cap ({}) is a reporting-only category: its usage is totalled per day and month with no ceiling. Only search,
    // documentation and decision subjects may draw on one (checked with the subjects below); zero still means no allocation.
    if (!c.caps || typeof c.caps !== "object" || Array.isArray(c.caps)) throw new Error(`category ${name}.caps must be an object`);
    const periods = Object.keys(c.caps);
    if (periods.some((k) => !["day", "month"].includes(k))) throw new Error(`category ${name}.caps must name day and/or month`);
    for (const k of periods) nonNegInt(c.caps[k], `category ${name}.caps.${k}`);
  }
  exact(p.paidTotal, ["unit", "caps"], "paidTotal");
  if (p.paidTotal.unit !== "micro_usd") throw new Error("paidTotal.unit must be micro_usd");
  // The shared daily cap is optional: with no day, no cap spans the paid categories and each keeps its own.
  exact(p.paidTotal.caps, [], "paidTotal.caps", ["day"]);
  if (p.paidTotal.caps.day !== undefined) nonNegInt(p.paidTotal.caps.day, "paidTotal.caps.day");
  for (const [name, v] of Object.entries(p.providers)) {
    exact(v, ["kind", "baseUrl", "credential", "paid"], `provider ${name}`, ["maxTokensParam", "store", "usageUrl", "usageCredential", "usageDedicated", "session", "api"]);
    if (!["model", "parser", "proxy", "enhanced", "search", "documentation", "decision"].includes(v.kind)) throw new Error(`provider ${name}.kind is unsupported`);
    const u = new URL(v.baseUrl);
    const fixture = /\.fixture\.fcpi\.test$/.test(u.hostname);
    if (["search", "documentation", "decision"].includes(v.kind)) {
      const api = Object.hasOwn(SEARCH_APIS, v.api ?? "") ? SEARCH_APIS[v.api] : null;
      if (!api || api.kind !== v.kind) throw new Error(`provider ${name}.api must be a ${v.kind} API (${Object.keys(SEARCH_APIS).filter((k) => SEARCH_APIS[k].kind === v.kind).join(", ")})`);
      if (u.pathname !== "/" || u.search || u.hash || u.username || u.password) throw new Error(`provider ${name}: a ${v.kind} baseUrl must be an origin`);
      // Serper keeps its proven contract: the existing credit allocation (unpaid) and a credential file, fixture or not.
      if (v.api === "serper-v1" && (v.paid !== false || typeof v.credential !== "string" || !/^[a-z0-9_]{3,64}$/.test(v.credential)))
        throw new Error(`provider ${name}: Serper uses an existing credit allocation and a credential file`);
      if (fixture) {
        if (u.protocol !== "http:" || v.paid !== false) throw new Error(`provider ${name}: a fixture ${v.kind} provider is unpaid and served over http`);
        if (v.credential !== null && !/^[a-z0-9_]{3,64}$/.test(v.credential ?? "")) throw new Error(`provider ${name}.credential must be a file name or null`);
      } else {
        if (u.origin !== api.origin) throw new Error(`provider ${name}: unsupported ${v.kind} origin for ${v.api} (only ${api.origin})`);
        if (typeof v.paid !== "boolean" || typeof v.credential !== "string" || !/^[a-z0-9_]{3,64}$/.test(v.credential)) throw new Error(`provider ${name}: a ${v.kind} provider states paid and names a credential file`);
      }
      continue;
    }
    // M7: an enhanced-retrieval provider always authenticates, a fixture one included, so the credential's path is
    // exercised end to end; a paid one is a public https service and an unpaid one a project fixture. Only Zyte API's
    // documented contract is implemented (enhanced.mjs).
    if (v.kind === "enhanced") {
      if (v.paid === fixture) throw new Error(`provider ${name}: a paid enhanced provider is a public service and an unpaid one a project fixture`);
      if ((v.paid && u.protocol !== "https:") || (!v.paid && u.protocol !== "http:") || u.pathname !== "/" || u.search || u.username) throw new Error(`provider ${name}: an enhanced provider's baseUrl is an origin (https, or http for a fixture)`);
      if (typeof v.credential !== "string" || !/^[a-z0-9_]{3,64}$/.test(v.credential)) throw new Error(`provider ${name}.credential must be a file name`);
      if (v.api !== "zyte-v1") throw new Error(`provider ${name}.api must be zyte-v1`);
      continue;
    }
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
    if (v.kind === "model") {
      if (v.api !== undefined && !["openai-chat", "anthropic-messages"].includes(v.api)) throw new Error(`provider ${name}.api must be openai-chat or anthropic-messages`);
      if (v.api === "anthropic-messages") {
        // The Messages API names its token cap max_tokens itself and has no store switch; its origin takes /v1/messages.
        if (v.maxTokensParam !== undefined || v.store !== undefined) throw new Error(`provider ${name}: the Messages API takes neither maxTokensParam nor store`);
        if (u.pathname !== "/" || u.search || u.hash || u.username || u.password) throw new Error(`provider ${name}: a Messages API baseUrl is an origin`);
        if (v.paid && u.origin !== "https://api.anthropic.com") throw new Error(`provider ${name}: a paid Messages API provider is https://api.anthropic.com`);
      } else if (!["max_completion_tokens", "max_tokens"].includes(v.maxTokensParam)) throw new Error(`provider ${name}.maxTokensParam must be max_completion_tokens or max_tokens`);
    }
  }
  const subjectOf = (kind, map) => {
    for (const [name, m] of Object.entries(map)) {
      exact(m, kind === "decision" ? ["provider", "category", "model"] : ["provider", "category"], `${kind} ${name}`, kind === "parser" ? ["tier", "version"] : kind === "model" ? ["reasoningEffort", "maxOutputTokens", "requestTimeoutMs", "maxInputTokens"] : []);
      if (kind === "model") {
        // The Messages API takes every level; the chat API was built and tested at none and xhigh only.
        const messagesApi = p.providers[m.provider]?.api === "anthropic-messages";
        const efforts = messagesApi ? ["none", "low", "medium", "high", "xhigh", "max"] : ["none", "xhigh"];
        if (m.reasoningEffort !== undefined && !efforts.includes(m.reasoningEffort)) throw new Error(`model ${name}.reasoningEffort must be ${efforts.slice(0, -1).join(", ")} or ${efforts.at(-1)}`);
        // The two production models keep the settings they are priced and tested at.
        if (name === "claude-haiku-5-5" && m.reasoningEffort !== "none") throw new Error("model claude-haiku-5-5.reasoningEffort must be none");
        if (name === "claude-sonnet-5-5" && m.reasoningEffort !== "high") throw new Error("model claude-sonnet-5-5.reasoningEffort must be high");
        // The Messages API defaults to medium effort when none is sent, so a model on it states its setting.
        if (messagesApi && m.reasoningEffort === undefined) throw new Error(`model ${name}.reasoningEffort must be stated`);
        // These ceilings are the Messages API's own limits (128,000 output tokens for a model that reasons) and the longest wait the
        // gateway's extended deadline allows (300 s); they apply to every model, not to the Agent's alone.
        if (m.maxOutputTokens !== undefined) posInt(m.maxOutputTokens, 100, m.reasoningEffort && m.reasoningEffort !== "none" ? 128000 : 4000, `model ${name}.maxOutputTokens`);
        if (m.requestTimeoutMs !== undefined) posInt(m.requestTimeoutMs, 1000, 300000, `model ${name}.requestTimeoutMs`);
        // A model's own input cap per extraction unit, in place of extraction.maxInputTokens: a model with a large context window can
        // read a whole page in one call. 200,000 stays far inside the 5.5 models' 1M window; Haiku 5.5 is priced higher above
        // 100,000 prompt tokens, so its cap stays below that by the estimate's margin.
        if (m.maxInputTokens !== undefined) posInt(m.maxInputTokens, 1000, name === "claude-haiku-5-5" ? 80000 : 200000, `model ${name}.maxInputTokens`);
      }
      const prov = p.providers[m.provider], cat = p.categories[m.category];
      if (!prov || prov.kind !== kind) throw new Error(`${kind} ${name} names ${m.provider}, which is not a ${kind} provider`);
      if (!cat) throw new Error(`${kind} ${name} names unknown category ${m.category}`);
      if (cat.paid !== prov.paid) throw new Error(`${kind} ${name}: a paid provider draws on a paid category and an unpaid one on an unpaid category`);
      // Serper keeps its credit category; the other search, documentation and decision subjects take the unit their rate
      // card's billing basis counts in (checked with the rate cards) and may draw on a reporting-only category.
      const metered = ["search", "documentation", "decision"].includes(kind) && prov.api !== "serper-v1";
      if (!metered && !Object.keys(cat.caps).length) throw new Error(`${kind} ${name}: category ${m.category} has no cap; only search, documentation and decision subjects may draw on a reporting-only category`);
      if (!metered && cat.unit !== (["parser", "search"].includes(kind) ? "credits" : "micro_usd")) throw new Error(`${kind} ${name}: category ${m.category} counts the wrong unit`);
      if (kind === "parser" && (typeof m.tier !== "string" || typeof m.version !== "string")) throw new Error(`parser ${name} needs a tier and a version`);
      // Jev is requested by its exact release, never a moving alias; a fixture decision provider names its own.
      if (kind === "decision" && (/\.fixture\.fcpi\.test$/.test(new URL(prov.baseUrl).hostname) ? !/^[a-z0-9._/-]{1,80}$/.test(m.model ?? "") : m.model !== JEV_MODEL)) throw new Error(`decision ${name}.model must be ${JEV_MODEL}`);
    }
  };
  subjectOf("model", p.models);
  subjectOf("parser", p.parsers);
  subjectOf("proxy", p.proxies);
  subjectOf("enhanced", p.enhancers);
  subjectOf("search", p.searches);
  subjectOf("documentation", p.documentationSearches);
  subjectOf("decision", p.decisions);
  // One name per subject across every map, so a rate card names exactly one thing.
  const subjectMaps = [p.models, p.parsers, p.proxies, p.enhancers, p.searches, p.documentationSearches, p.decisions];
  for (const [i, a] of subjectMaps.entries()) for (const b of subjectMaps.slice(i + 1)) for (const k of Object.keys(a)) if (Object.hasOwn(b, k)) throw new Error(`subject ${k} is listed twice`);
  if (!Array.isArray(p.rateCards)) throw new Error("rateCards must be a list");
  const ids = new Set();
  for (const r of p.rateCards) {
    const searchApi = (map) => (Object.hasOwn(map, r.subject) ? p.providers[map[r.subject].provider].api : null);
    const isSearch = searchApi(p.searches) === "serper-v1";
    // A metered search, documentation or decision subject (every one but Serper): billing names how one operation is counted.
    const meteredApi = (Object.hasOwn(p.searches, r.subject) && !isSearch ? searchApi(p.searches) : null) ?? searchApi(p.documentationSearches) ?? searchApi(p.decisions);
    if (meteredApi) {
      const sub = p.searches[r.subject] ?? p.documentationSearches[r.subject] ?? p.decisions[r.subject];
      const decision = Object.hasOwn(p.decisions, r.subject);
      if (!Object.hasOwn(BILLING_UNITS, r.billing ?? "") || (decision !== (r.billing === "decision_tokens"))) throw new Error(`rate card ${r.id}.billing must be ${decision ? "decision_tokens" : "credits_per_operation, micro_usd_per_operation or requests"}`);
      exact(r, ["id", "subject", "effectiveFrom", "effectiveTo", "billing", "source", ...{ credits_per_operation: ["creditsPerOperation"], micro_usd_per_operation: ["microUsdPerOperation"],
        requests: ["microUsdPerRequest"], decision_tokens: ["inputPerMTok", "outputPerMTok"] }[r.billing]], `rate card ${r.id}`, r.billing === "credits_per_operation" ? ["microUsdPerCredit"] : r.billing === "micro_usd_per_operation" ? ["emptyFree"] : []);
      if (p.categories[sub.category].unit !== BILLING_UNITS[r.billing]) throw new Error(`rate card ${r.id}: ${r.billing} counts ${BILLING_UNITS[r.billing]}, but category ${sub.category} counts ${p.categories[sub.category].unit}`);
      if (r.billing === "credits_per_operation") { posInt(r.creditsPerOperation, 1, 100, `rate card ${r.id}.creditsPerOperation`); if (r.microUsdPerCredit !== undefined && r.microUsdPerCredit !== null) posInt(r.microUsdPerCredit, 1, 1e6, `rate card ${r.id}.microUsdPerCredit`); }
      if (r.billing === "micro_usd_per_operation") { posInt(r.microUsdPerOperation, 1, 1e6, `rate card ${r.id}.microUsdPerOperation`); if (r.emptyFree !== undefined && typeof r.emptyFree !== "boolean") throw new Error(`rate card ${r.id}.emptyFree must be a boolean`); }
      // A request's monetary price is the plan's, which is often unknown: null records that it is unknown, never zero.
      if (r.billing === "requests" && r.microUsdPerRequest !== null) posInt(r.microUsdPerRequest, 1, 1e6, `rate card ${r.id}.microUsdPerRequest`);
      // Only the OpenRouter Decisions card may price output at zero (Jev's documented free output).
      if (r.billing === "decision_tokens") { posInt(r.inputPerMTok, 1, 1e9, `rate card ${r.id}.inputPerMTok`); nonNegInt(r.outputPerMTok, `rate card ${r.id}.outputPerMTok`); if (r.outputPerMTok === 0 && meteredApi !== "openrouter-decisions-v1") throw new Error(`rate card ${r.id}: only the OpenRouter Decisions card may price output at zero`); }
      if (typeof r.source !== "string" || !r.source) throw new Error(`rate card ${r.id}.source must name where the price was read`);
      if (ids.has(r.id)) throw new Error(`rate card ${r.id} appears twice`);
      ids.add(r.id);
      if (!DATE.test(r.effectiveFrom) || (r.effectiveTo !== null && (!DATE.test(r.effectiveTo) || r.effectiveTo <= r.effectiveFrom))) throw new Error(`rate card ${r.id}: effective dates must be YYYY-MM-DD, the end after the start`);
      continue;
    }
    const isParser = Object.hasOwn(p.parsers, r.subject), isProxy = Object.hasOwn(p.proxies, r.subject), isEnhancer = Object.hasOwn(p.enhancers, r.subject);
    if (!Object.hasOwn(p.models, r.subject) && !isParser && !isProxy && !isEnhancer && !isSearch) throw new Error(`rate card ${r.id} names an unknown subject ${r.subject}`);
    exact(r, isSearch ? ["id", "subject", "effectiveFrom", "effectiveTo", "creditsPerSearch", "source"]
      : isParser ? ["id", "subject", "effectiveFrom", "effectiveTo", "creditsPerPage", "microUsdPerCredit", "source"]
      : isProxy ? ["id", "subject", "effectiveFrom", "effectiveTo", "microUsdPerGB", "billing", "source"]
      : isEnhancer ? ["id", "subject", "effectiveFrom", "effectiveTo", "microUsdPerHttpRequest", "microUsdPerBrowserRequest", "billing", "source"]
      : ["id", "subject", "effectiveFrom", "effectiveTo", "inputPerMTok", "cachedInputPerMTok", "outputPerMTok", "source"], `rate card ${r.id}`, !isParser && !isProxy && !isEnhancer && !isSearch ? ["cacheWritePerMTok"] : []);
    if (isSearch && r.creditsPerSearch !== 1) throw new Error("Serper search must reserve one credit");
    if (r.cacheWritePerMTok !== undefined) posInt(r.cacheWritePerMTok, 1, 1e9, `rate card ${r.id}.cacheWritePerMTok`);
    // M7: Zyte prices a request by the target's tier, which no answer reports; the card holds the highest tier's price for
    // each request type, and a successful response is charged at it (spec §28.3: a conservative maximum).
    if (isEnhancer) {
      posInt(r.microUsdPerHttpRequest, 1, 1e6, `rate card ${r.id}.microUsdPerHttpRequest`);
      posInt(r.microUsdPerBrowserRequest, 1, 1e6, `rate card ${r.id}.microUsdPerBrowserRequest`);
      if (r.billing !== "successful_response_at_highest_tier") throw new Error(`rate card ${r.id}.billing must be successful_response_at_highest_tier`);
    }
    if (ids.has(r.id)) throw new Error(`rate card ${r.id} appears twice`);
    ids.add(r.id);
    if (!DATE.test(r.effectiveFrom) || (r.effectiveTo !== null && (!DATE.test(r.effectiveTo) || r.effectiveTo <= r.effectiveFrom))) throw new Error(`rate card ${r.id}: effective dates must be YYYY-MM-DD, the end after the start`);
    if (isParser) { posInt(r.creditsPerPage, 1, 1000, `rate card ${r.id}.creditsPerPage`); nonNegInt(r.microUsdPerCredit, `rate card ${r.id}.microUsdPerCredit`); }
    else if (isProxy) {
      // Bytes are priced per decimal GB (1e9 bytes, the larger count of the two readings of "GB"), both directions.
      posInt(r.microUsdPerGB, 1, 1e9, `rate card ${r.id}.microUsdPerGB`);
      if (r.billing !== "upload_plus_download_per_1e9_bytes") throw new Error(`rate card ${r.id}.billing must be upload_plus_download_per_1e9_bytes`);
    } else if (!isEnhancer && !isSearch) for (const k of ["inputPerMTok", "cachedInputPerMTok", "outputPerMTok"]) posInt(r[k], 1, 1e9, `rate card ${r.id}.${k}`);
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
  // M7: the enhanced provider used unless the host's selection names another (null: none), spec §9.3's 40 s ceiling for
  // its one dispatch, and the largest answer read from it (its body arrives base64-encoded).
  exact(p.enhancing, ["defaultEnhancer", "requestTimeoutMs", "maxResponseBytes"], "enhancing");
  if (p.enhancing.defaultEnhancer !== null && !Object.hasOwn(p.enhancers, p.enhancing.defaultEnhancer)) throw new Error("enhancing.defaultEnhancer must be a listed enhancer or null");
  posInt(p.enhancing.requestTimeoutMs, 1000, 40000, "enhancing.requestTimeoutMs");
  posInt(p.enhancing.maxResponseBytes, 65536, 48 * 1048576, "enhancing.maxResponseBytes");
  if (p.searching !== undefined) {
    const S = p.searching;
    exact(S, ["defaultSearch", "allocationCredits", "requestTimeoutMs", "maxResponseBytes"], "searching", ["profile", "generalSubjects", "documentationSubjects", "decisionSubject", "searxngMode", "fixtureRoster"]);
    if (S.defaultSearch !== null && !Object.hasOwn(p.searches, S.defaultSearch)) throw new Error("searching.defaultSearch must be listed or null");
    if (S.defaultSearch !== null && p.providers[p.searches[S.defaultSearch].provider].api !== "serper-v1") throw new Error("searching.defaultSearch is the legacy profile's Serper subject");
    posInt(S.allocationCredits, 0, 2443, "searching.allocationCredits");
    posInt(S.requestTimeoutMs, 1000, 8000, "searching.requestTimeoutMs");
    posInt(S.maxResponseBytes, 65536, 4 * 1048576, "searching.maxResponseBytes");
    // The profile: "legacy" is the accepted Serper-first search with SearXNG fallback, kept as the explicit rollback; "aggregate"
    // runs the five general engines together (spec §5), with Context7 and Ref when documentation helps and Jev's advice.
    S.profile ??= "legacy";
    if (!["aggregate", "legacy"].includes(S.profile)) throw new Error("searching.profile must be aggregate or legacy");
    const rosterKeys = ["generalSubjects", "documentationSubjects", "decisionSubject"];
    const roster = (r, where, fixture) => {
      exact(r, rosterKeys, where);
      const apiOf = (map, s) => (Object.hasOwn(map, s) ? p.providers[map[s].provider] : null);
      const check = (list, map, apis, label) => {
        if (!Array.isArray(list) || list.length !== apis.length || new Set(list).size !== list.length) throw new Error(`${where}.${label} must list exactly ${apis.length} subjects`);
        const got = list.map((s) => { const prov = apiOf(map, s); if (!prov) throw new Error(`${where}.${label}: ${s} is not listed`); return prov; });
        if ([...new Set(got.map((x) => x.api))].sort().join() !== [...apis].sort().join()) throw new Error(`${where}.${label} must hold one subject of each of ${apis.join(", ")}`);
        // A fixture selection never reaches a live provider; the live roster may be pointed at fixtures (tests do).
        if (fixture && got.some((x) => !/\.fixture\.fcpi\.test$/.test(new URL(x.baseUrl).hostname))) throw new Error(`${where}.${label} must name fixture providers only`);
      };
      check(r.generalSubjects, p.searches, GENERAL_APIS, "generalSubjects");
      check(r.documentationSubjects, p.documentationSearches, DOCUMENTATION_APIS, "documentationSubjects");
      check([r.decisionSubject], p.decisions, ["openrouter-decisions-v1"], "decisionSubject");
    };
    if (S.profile === "aggregate" || rosterKeys.some((k) => k in S)) roster(Object.fromEntries(rosterKeys.map((k) => [k, S[k]])), "searching", false);
    S.searxngMode ??= "fallback";
    if (!["fallback", "additional"].includes(S.searxngMode)) throw new Error("searching.searxngMode must be fallback or additional");
    // The roster a fixture selection uses: fixture providers of the same APIs, so the aggregate runs end to end without a live call.
    if (S.fixtureRoster !== undefined) roster(S.fixtureRoster, "searching.fixtureRoster", true);
  }
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
export function modelCost(card, { promptTokens, cachedTokens = 0, cacheWriteTokens = 0, completionTokens }) {
  const cached = Math.min(cachedTokens, promptTokens);
  const written = Math.min(cacheWriteTokens, promptTokens - cached);
  return Math.ceil(((promptTokens - cached - written) * card.inputPerMTok + cached * card.cachedInputPerMTok + written * (card.cacheWritePerMTok ?? card.inputPerMTok) + completionTokens * card.outputPerMTok) / 1e6);
}

// The conservative maximum a model call can cost: its input can hold no more tokens than bytes (every
// token of a byte-level tokenizer covers at least one byte), and its output no more than it may write.
export const maxModelCost = (card, inputBytes, maxOutputTokens) => modelCost({ ...card, inputPerMTok: Math.max(card.inputPerMTok, card.cacheWritePerMTok ?? 0) }, { promptTokens: inputBytes, completionTokens: maxOutputTokens });

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
  // onChange hears each transition a verdict causes ({ from, to, retryAfterS }: to open, back to closed), for the operational
  // record; the half-open state comes with time, not with a verdict, and is not reported.
  constructor({ failures, windowMs, openMs }, now = () => Date.now(), onChange = null) {
    Object.assign(this, { limit: failures, windowMs, openMs, now, onChange });
    this.fails = []; this.openUntil = 0; this.probing = false;
  }
  #report(from) { const to = this.state(); if (this.onChange && from !== to) this.onChange({ from, to, retryAfterS: to === "open" ? this.retryAfterS() : null }); }
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
  success() { const from = this.state(); this.fails = []; this.openUntil = 0; this.probing = false; this.#report(from); }
  failure() {
    const t = this.now(), from = this.state();
    if (this.probing) { this.probing = false; this.openUntil = t + this.openMs; this.fails = []; this.#report(from); return; }
    this.fails = this.fails.filter((x) => t - x < this.windowMs);
    this.fails.push(t);
    if (this.fails.length >= this.limit) { this.openUntil = t + this.openMs; this.fails = []; }
    this.#report(from);
  }
  // The call ended without a provider verdict (the caller's own refusal): a probe slot is returned.
  neutral() { this.probing = false; }
  retryAfterS() { return Math.max(1, Math.ceil((this.openUntil - this.now()) / 1000)); }
}
