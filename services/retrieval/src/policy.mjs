// Configuration: the service's environment and the egress policy file (FIRECRAWL_PI_SPEC.md §29,
// PI_EGRESS_POLICY_FILE), both validated at startup; unknown keys fail. The host's own connected
// networks come from a separate file the host writes at every stack start
// (deploy/host/fcpi-egress-local.sh), because the LAN this host sits on may use a globally
// routable range; without that file no acquisition runs.
import { readFileSync } from "node:fs";
import { BlockList, isIP } from "node:net";

const ENV_KEYS = new Set(["PI_RETRIEVAL_LISTEN", "PI_RETRIEVAL_PROXY_LISTEN", "PI_EGRESS_POLICY_FILE", "PI_EGRESS_LOCAL_CIDRS_FILE",
  "PI_RESOLVER", "PI_BROWSER_URL", "PI_CREDENTIALS_DIR", "PI_POSTGRES_HOST", "PI_POSTGRES_DB", "PI_POSTGRES_USER",
  "PI_BROWSER_EXTRAS_ENABLED", "PI_PAID_DISPATCH_ENABLED", "PI_CLOUD_ACCESS_ENABLED", "PI_MAX_URL_ACQUISITIONS", "PI_MAX_BROWSER_PAGES",
  // M5: search, extraction and parsing.
  "PI_SEARCH_URL", "PI_SEARCH_PROXY_LISTEN", "PI_EXTRACT_LISTEN", "PI_BUDGET_POLICY_FILE", "PI_PROVIDERS_DIR", "PI_SELECTION_FILE",
  // M7: webhook delivery.
  "PI_WEBHOOK_DELIVERY",
  // M8: the host's admission file (src/admission.mjs).
  "PI_ADMISSION_FILE"]);

// An internal service's URL: http at a fixed address, since a name would be looked up through the
// egress bridge's resolver rather than Docker's.
function fixedHttp(v, key) {
  const u = new URL(v);
  if (u.protocol !== "http:" || !/^\d+\.\d+\.\d+\.\d+$/.test(u.hostname) || u.username || u.password) throw new Error(`${key} must be an http URL at a fixed address`);
  return u.toString();
}

export function loadEnv(env) {
  const unknown = Object.keys(env).filter((k) => k.startsWith("PI_") && !ENV_KEYS.has(k));
  if (unknown.length) throw new Error(`unknown configuration keys: ${unknown.join(", ")}`);
  const need = (k) => { if (!env[k]) throw new Error(`${k} is required`); return env[k]; };
  const listen = (v) => { const m = /^(\d+\.\d+\.\d+\.\d+):(\d+)$/.exec(v); if (!m) throw new Error(`listen address ${v} is not ip:port`); return { host: m[1], port: Number(m[2]) }; };
  const exactlyFalse = (k) => { if ((env[k] ?? "false") !== "false") throw new Error(`${k} must be false in this release`); };
  // Cloud access stays off in every release. Paid dispatch is a switch the owner turns on only with an approved
  // budget (spec §28.3). M7: the browser extras (screenshots and the action subset) are a switch too, so the optional
  // capability can be turned off without touching basic retrieval; webhook delivery is "enabled" or "suppressed"
  // (a restore or rollback holds every event unsent). Anything else stops startup.
  const flag = (k, fallback, values) => { const v = env[k] ?? fallback; if (!values.includes(v)) throw new Error(`${k} must be ${values.join(" or ")}`); return v; };
  const paid = flag("PI_PAID_DISPATCH_ENABLED", "false", ["true", "false"]);
  exactlyFalse("PI_CLOUD_ACCESS_ENABLED");
  const extras = flag("PI_BROWSER_EXTRAS_ENABLED", "false", ["true", "false"]);
  const webhooks = flag("PI_WEBHOOK_DELIVERY", "suppressed", ["enabled", "suppressed"]);
  const urlPermits = Number(env.PI_MAX_URL_ACQUISITIONS ?? 2), browserPermits = Number(env.PI_MAX_BROWSER_PAGES ?? 1);
  if (!(urlPermits >= 1 && urlPermits <= 2) || browserPermits !== 1) throw new Error("PI_MAX_URL_ACQUISITIONS must be 1 or 2 and PI_MAX_BROWSER_PAGES 1 (spec §23.1)");
  const resolver = need("PI_RESOLVER");
  if (isIP(resolver) !== 4) throw new Error("PI_RESOLVER must be an IPv4 address");
  return {
    listen: listen(need("PI_RETRIEVAL_LISTEN")), proxyListen: listen(need("PI_RETRIEVAL_PROXY_LISTEN")),
    policyFile: need("PI_EGRESS_POLICY_FILE"), localCidrsFile: need("PI_EGRESS_LOCAL_CIDRS_FILE"), resolver,
    browserUrl: new URL(need("PI_BROWSER_URL")), credentialsDir: need("PI_CREDENTIALS_DIR"),
    postgres: { host: need("PI_POSTGRES_HOST"), database: need("PI_POSTGRES_DB"), user: need("PI_POSTGRES_USER") },
    permits: { url: urlPermits, browser: browserPermits },
    paidDispatch: paid === "true", browserExtras: extras === "true", webhookDelivery: webhooks,
    searchUrl: fixedHttp(need("PI_SEARCH_URL"), "PI_SEARCH_URL"),
    searchProxyListen: listen(need("PI_SEARCH_PROXY_LISTEN")), extractListen: listen(need("PI_EXTRACT_LISTEN")),
    budgetFile: need("PI_BUDGET_POLICY_FILE"), providersDir: need("PI_PROVIDERS_DIR"), selectionFile: need("PI_SELECTION_FILE"),
    admissionFile: env.PI_ADMISSION_FILE || null,
  };
}

const POLICY_KEYS = ["schema", "direct", "fixtureLimits", "ports", "maxRedirects", "maxBodyBytes", "attempts", "permitLeaseMs",
  "browser", "cloudDenylist", "fixtures", "search", "residential", "routing", "webhooks"];
const LIMIT_KEYS = ["perDomainInFlight", "minNavigationGapMs", "perDomainPerHour", "platformPerDay"];

function exactKeys(obj, keys, where) {
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) throw new Error(`${where} must be an object`);
  const extra = Object.keys(obj).filter((k) => !keys.includes(k));
  const missing = keys.filter((k) => !(k in obj));
  if (extra.length || missing.length) throw new Error(`${where}: unknown ${extra.join(",") || "-"}; missing ${missing.join(",") || "-"}`);
}
const int = (v, lo, hi, where) => { if (!Number.isInteger(v) || v < lo || v > hi) throw new Error(`${where} must be an integer in ${lo}..${hi}`); return v; };

export function loadPolicy(text) {
  const p = JSON.parse(text);
  exactKeys(p, POLICY_KEYS, "policy");
  if (p.schema !== "fcpi.egress-policy/v1") throw new Error("policy schema must be fcpi.egress-policy/v1");
  for (const [name, l] of [["direct", p.direct], ["fixtureLimits", p.fixtureLimits]]) {
    exactKeys(l, LIMIT_KEYS, name);
    int(l.perDomainInFlight, 1, 1, `${name}.perDomainInFlight`);
    int(l.minNavigationGapMs, 0, 60000, `${name}.minNavigationGapMs`);
    if (l.perDomainPerHour !== null) int(l.perDomainPerHour, 1, 100000, `${name}.perDomainPerHour`);
    if (l.platformPerDay !== null) int(l.platformPerDay, 1, 100000, `${name}.platformPerDay`);
  }
  // Spec §10.2's defaults may be tightened, never loosened.
  if (p.direct.minNavigationGapMs < 2000 || p.direct.perDomainPerHour === null || p.direct.perDomainPerHour > 300 || p.direct.platformPerDay === null || p.direct.platformPerDay > 5000) {
    throw new Error("policy.direct may not be looser than spec §10.2 (2 s, 300 per domain per hour, 5000 per day)");
  }
  if (JSON.stringify(p.ports) !== "[80,443]") throw new Error("policy.ports must be [80, 443]");
  int(p.maxRedirects, 0, 20, "maxRedirects");
  int(p.maxBodyBytes, 1024, 64 * 1024 * 1024, "maxBodyBytes");
  exactKeys(p.attempts, ["maxPerPage", "acquisitionDeadlineMs", "httpAttemptMs", "browserAttemptMs"], "attempts");
  if (p.attempts.maxPerPage > 4) throw new Error("attempts.maxPerPage may not exceed 4 (spec §9.3)");
  int(p.attempts.maxPerPage, 1, 4, "attempts.maxPerPage");
  int(p.attempts.acquisitionDeadlineMs, 1000, 90000, "attempts.acquisitionDeadlineMs");
  int(p.attempts.httpAttemptMs, 1000, 15000, "attempts.httpAttemptMs");
  int(p.attempts.browserAttemptMs, 1000, 30000, "attempts.browserAttemptMs");
  int(p.permitLeaseMs, 1000, 180000, "permitLeaseMs");
  // A lease must outlast the longest acquisition and its release, or it could lapse under a live
  // holder and admit one more acquisition than the permits allow (review finding S3).
  if (p.permitLeaseMs < p.attempts.acquisitionDeadlineMs + 30000) throw new Error("permitLeaseMs must be at least attempts.acquisitionDeadlineMs + 30000");
  exactKeys(p.browser, ["maxSubresources", "maxSubresourceBytes", "contextMaxMs"], "browser");
  int(p.browser.maxSubresources, 1, 200, "browser.maxSubresources");
  int(p.browser.maxSubresourceBytes, 1024, 25 * 1024 * 1024, "browser.maxSubresourceBytes");
  int(p.browser.contextMaxMs, 1000, 120000, "browser.contextMaxMs");
  if (!Array.isArray(p.cloudDenylist) || !p.cloudDenylist.includes("*.firecrawl.dev") || !p.cloudDenylist.includes("firecrawl.dev")) {
    throw new Error("policy.cloudDenylist must name firecrawl.dev and *.firecrawl.dev");
  }
  if (!Array.isArray(p.fixtures)) throw new Error("policy.fixtures must be a list");
  for (const f of p.fixtures) {
    exactKeys(f, ["host", "port", "cidr", "limits"], `fixture ${f?.host}`);
    if (!/\.fixture\.fcpi\.test$/.test(f.host)) throw new Error(`fixture ${f.host} must be a *.fixture.fcpi.test name`);
    if (!/^10\.231\.\d+\.0\/24$/.test(f.cidr)) throw new Error(`fixture ${f.host} must name a project /24`);
    if (!["fixture", "direct"].includes(f.limits)) throw new Error(`fixture ${f.host} limits must be fixture or direct`);
  }
  // Search (spec §13): the engine sets the host's selection chooses between, the hosts the live set may
  // reach through the search proxy, and the backend's limits, which may be tightened, never loosened.
  exactKeys(p.search, ["engines", "fallbackEngines", "engineHosts", "engineRoutes", "perHour", "cacheSeconds", "deadlineMs", "maxResults"], "search");
  exactKeys(p.search.engines, ["fixture", "live"], "search.engines");
  // The engines a search asks only when the selection's own engines failed or answered too few (search.mjs): those the
  // home connection cannot reach, on the residential route.
  exactKeys(p.search.fallbackEngines, ["fixture", "live"], "search.fallbackEngines");
  for (const k of ["fixture", "live"]) {
    const l = p.search.fallbackEngines[k];
    if (!Array.isArray(l) || l.length > 6 || l.some((e) => typeof e !== "string" || !/^[a-z0-9 ._-]{1,40}$/.test(e) || p.search.engines[k].includes(e))) throw new Error(`search.fallbackEngines.${k} must list 0 to 6 engine names the selection does not already query`);
  }
  for (const k of ["fixture", "live"]) {
    const l = p.search.engines[k];
    if (!Array.isArray(l) || l.length === 0 || l.length > 6 || l.some((e) => typeof e !== "string" || !/^[a-z0-9 ._-]{1,40}$/.test(e))) throw new Error(`search.engines.${k} must list 1 to 6 engine names`);
  }
  exactKeys(p.search.engineHosts, ["live"], "search.engineHosts");
  const hosts = p.search.engineHosts.live;
  if (!Array.isArray(hosts) || hosts.length === 0 || hosts.some((h) => typeof h !== "string" || !/^[a-z0-9.-]+\.[a-z]{2,}$/.test(h) || /\.fixture\.fcpi\.test$/.test(h))) throw new Error("search.engineHosts.live must list public host names");
  int(p.search.perHour, 1, 60, "search.perHour");
  int(p.search.cacheSeconds, 0, 900, "search.cacheSeconds");
  int(p.search.deadlineMs, 1000, 10000, "search.deadlineMs");
  int(p.search.maxResults, 1, 20, "search.maxResults");
  // M6 (F11): how each engine host's traffic leaves. "residential" hosts go only through the residential proxy and are
  // refused when it is unavailable, never sent from the home connection; every live host is named, and a fixture host
  // may be named only if the policy lists it.
  const routes = p.search.engineRoutes;
  if (!routes || typeof routes !== "object" || Array.isArray(routes)) throw new Error("search.engineRoutes must be an object");
  for (const [h, r] of Object.entries(routes)) {
    if (!["direct", "residential"].includes(r)) throw new Error(`search.engineRoutes.${h} must be direct or residential`);
    if (!hosts.includes(h) && !p.fixtures.some((f) => f.host === h)) throw new Error(`search.engineRoutes names ${h}, which is neither a live engine host nor a fixture`);
  }
  for (const h of hosts) if (!Object.hasOwn(routes, h)) throw new Error(`search.engineRoutes must name the live engine host ${h}`);
  // M6: residential routing (spec §9.5, §10.2). proxyFirstDomains are the explicit, finite overrides: registrable domains
  // (or fixture hosts) that start on the residential route. bulkPages is spec §10.2's threshold past which a job needs
  // approved proxy egress from the start: one domain's hourly direct allowance, so every job within it starts on the home
  // connection; holdMaxMinutes bounds a job's route hold.
  exactKeys(p.residential, ["proxyFirstDomains", "sessionMinutes", "connectTimeoutMs", "bulkPages", "holdMaxMinutes"], "residential");
  const R = p.residential;
  if (!Array.isArray(R.proxyFirstDomains) || R.proxyFirstDomains.length > 500 || R.proxyFirstDomains.some((d) => typeof d !== "string" || !/^[a-z0-9.-]+\.[a-z]{2,}$/.test(d))) throw new Error("residential.proxyFirstDomains must list at most 500 domain names");
  int(R.sessionMinutes, 1, 1440, "residential.sessionMinutes");
  int(R.connectTimeoutMs, 1000, 30000, "residential.connectTimeoutMs");
  if (R.bulkPages !== 300) throw new Error("residential.bulkPages is spec §10.2's 300");
  int(R.holdMaxMinutes, 10, 240, "residential.holdMaxMinutes");
  // Spec §9.5's domain learning: at most 5,000 records, two consistent observations before a preference changes, a
  // 24-hour preference extended by successes to at most seven days, and one bounded cheaper probe after it expires.
  exactKeys(p.routing, ["maxRecords", "observationsToChange", "ttlHours", "maxTtlDays", "probeMinutes"], "routing");
  const G = p.routing;
  int(G.maxRecords, 1, 5000, "routing.maxRecords");
  if (G.observationsToChange !== 2) throw new Error("routing.observationsToChange is spec §9.5's 2");
  int(G.ttlHours, 1, 24, "routing.ttlHours");
  int(G.maxTtlDays, 1, 7, "routing.maxTtlDays");
  int(G.probeMinutes, 1, 60, "routing.probeMinutes");
  // M7: the only URLs a webhook may be delivered to (spec §31.3): each an exact http(s) URL without credentials, query
  // or fragment, a public name or a listed fixture host; empty, no job may ask for a webhook. Delivery follows no
  // redirect and is bounded in time and answer size.
  exactKeys(p.webhooks, ["destinations", "timeoutMs"], "webhooks");
  const W = p.webhooks;
  if (!Array.isArray(W.destinations) || W.destinations.length > 20) throw new Error("webhooks.destinations must list at most 20 URLs");
  for (const d of W.destinations) {
    let u;
    try { u = new URL(d); } catch { throw new Error(`webhooks.destinations: ${d} is not a URL`); }
    if (!["http:", "https:"].includes(u.protocol) || u.username || u.password || u.search || u.hash || u.href !== d) throw new Error(`webhooks.destinations: ${d} must be an exact http(s) URL without credentials, query or fragment`);
    const fixture = p.fixtures.some((f) => f.host === u.hostname && f.port === Number(u.port || (u.protocol === "https:" ? 443 : 80)));
    if (/\.fixture\.fcpi\.test$/.test(u.hostname) ? !fixture : u.protocol !== "https:") throw new Error(`webhooks.destinations: ${d} must be https, or a listed fixture`);
  }
  int(W.timeoutMs, 1000, 15000, "webhooks.timeoutMs");
  return p;
}

// CIDR lines ("a.b.c.d/n" or "x:y::/n"); blank lines and # comments ignored. Returns a BlockList.
export function loadLocalCidrs(text) {
  const list = new BlockList();
  let n = 0;
  for (const line of text.split("\n").map((l) => l.trim()).filter((l) => l && !l.startsWith("#"))) {
    const [net, bits] = line.split("/");
    const fam = isIP(net);
    if (!fam || !/^\d+$/.test(bits ?? "")) throw new Error(`local CIDR ${line} is not a network`);
    list.addSubnet(net, Number(bits), fam === 4 ? "ipv4" : "ipv6");
    n++;
  }
  if (n === 0) throw new Error("the local CIDR file names no network");
  return { list, count: n };
}

// A credential's SHA-256 as stored ("sha256:" and 64 hex digits, or the digits alone). Anything
// else fails at startup, not as a 500 on every request: timingSafeEqual throws on a length mismatch
// (review finding S3).
export function parseSha256(value, name) {
  const m = /^(?:sha256:)?([0-9a-f]{64})$/i.exec(value);
  if (!m) throw new Error(`secret ${name} is not a SHA-256 hex digest`);
  return Buffer.from(m[1], "hex");
}

export function readSecret(dir, name) {
  const v = readFileSync(`${dir}/${name}`, "utf8").trim();
  if (!v) throw new Error(`secret ${name} is empty`);
  return v;
}

// The host's provider selection (PI_SELECTION_FILE, written by scripts/m5/pi-selection.sh): which engine set
// search uses (fixture, or live, whose egress stays held until the review is addressed), which listed
// model extraction uses by default, and which listed parser takes complex documents. Absent, search stays
// on the fixture set and the policies' defaults apply. It chooses only among what the committed policies
// list, so it widens nothing.
export function loadSelection(text, policy, budget) {
  const s = JSON.parse(text);
  // M6's residential proxy and M7's enhanced provider are optional in the file: a selection written before them keeps
  // the policy's default.
  const { proxy, enhanced, ...rest } = s;
  exactKeys(rest, ["search", "extractionModel", "parser"], "selection");
  if (proxy !== undefined && proxy !== null && !Object.hasOwn(budget.proxies, proxy)) throw new Error("selection.proxy must be a proxy the budget policy lists, or null");
  if (enhanced !== undefined && enhanced !== null && !Object.hasOwn(budget.enhancers, enhanced)) throw new Error("selection.enhanced must be an enhancer the budget policy lists, or null");
  s.proxy = proxy === undefined ? budget.proxying.defaultProxy : proxy;
  s.enhanced = enhanced === undefined ? budget.enhancing.defaultEnhancer : enhanced;
  if (!["fixture", "live"].includes(s.search)) throw new Error("selection.search must be fixture or live");
  if (!Object.hasOwn(budget.models, s.extractionModel)) throw new Error("selection.extractionModel must be a model the budget policy lists");
  // A default request runs inside the ordinary deadline, which would cut a model that reasons off with its whole reservation held:
  // such a model is chosen per request (the Agent's explicit pair), never as the default.
  if (![undefined, "none"].includes(budget.models[s.extractionModel].reasoningEffort)) throw new Error("selection.extractionModel must be a model without a reasoning effort; a model that reasons is chosen per request");
  if (!Object.hasOwn(budget.parsers, s.parser)) throw new Error("selection.parser must be a parser the budget policy lists");
  return s;
}
export const defaultSelection = (budget) => ({ search: "fixture", extractionModel: budget.extraction.defaultModel, parser: budget.parsing.defaultParser, proxy: budget.proxying.defaultProxy,
  enhanced: budget.enhancing.defaultEnhancer });
