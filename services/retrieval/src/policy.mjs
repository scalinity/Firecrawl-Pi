// Configuration: the service's environment and the egress policy file (FIRECRAWL_PI_SPEC.md §29,
// PI_EGRESS_POLICY_FILE), both validated at startup; unknown keys fail. The host's own connected
// networks come from a separate file the host writes at every stack start
// (deploy/host/fcpi-egress-local.sh), because the LAN this host sits on may use a globally
// routable range; without that file no acquisition runs.
import { readFileSync } from "node:fs";
import { BlockList, isIP } from "node:net";

const ENV_KEYS = new Set(["PI_RETRIEVAL_LISTEN", "PI_RETRIEVAL_PROXY_LISTEN", "PI_EGRESS_POLICY_FILE", "PI_EGRESS_LOCAL_CIDRS_FILE",
  "PI_RESOLVER", "PI_BROWSER_URL", "PI_CREDENTIALS_DIR", "PI_POSTGRES_HOST", "PI_POSTGRES_DB", "PI_POSTGRES_USER",
  "PI_BROWSER_EXTRAS_ENABLED", "PI_PAID_DISPATCH_ENABLED", "PI_CLOUD_ACCESS_ENABLED", "PI_MAX_URL_ACQUISITIONS", "PI_MAX_BROWSER_PAGES"]);

export function loadEnv(env) {
  const unknown = Object.keys(env).filter((k) => k.startsWith("PI_") && !ENV_KEYS.has(k));
  if (unknown.length) throw new Error(`unknown configuration keys: ${unknown.join(", ")}`);
  const need = (k) => { if (!env[k]) throw new Error(`${k} is required`); return env[k]; };
  const listen = (v) => { const m = /^(\d+\.\d+\.\d+\.\d+):(\d+)$/.exec(v); if (!m) throw new Error(`listen address ${v} is not ip:port`); return { host: m[1], port: Number(m[2]) }; };
  const exactlyFalse = (k) => { if ((env[k] ?? "false") !== "false") throw new Error(`${k} must be false in this release`); };
  // Paid dispatch, Cloud access and the browser extras stay off until their milestones (M5-M7).
  exactlyFalse("PI_PAID_DISPATCH_ENABLED");
  exactlyFalse("PI_CLOUD_ACCESS_ENABLED");
  exactlyFalse("PI_BROWSER_EXTRAS_ENABLED");
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
  };
}

const POLICY_KEYS = ["schema", "direct", "fixtureLimits", "ports", "maxRedirects", "maxBodyBytes", "attempts", "permitLeaseMs",
  "browser", "cloudDenylist", "fixtures", "search"];
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
  if (p.direct.minNavigationGapMs < 2000 || p.direct.perDomainPerHour === null || p.direct.perDomainPerHour > 20 || p.direct.platformPerDay === null || p.direct.platformPerDay > 200) {
    throw new Error("policy.direct may not be looser than spec §10.2 (2 s, 20 per domain per hour, 200 per day)");
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
  exactKeys(p.search, ["backend"], "search");
  if (p.search.backend !== null) {
    const u = new URL(p.search.backend);
    if (!p.fixtures.some((f) => f.host === u.hostname)) throw new Error("search.backend is a fixture host in this release (SearXNG arrives in M5)");
  }
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

export function readSecret(dir, name) {
  const v = readFileSync(`${dir}/${name}`, "utf8").trim();
  if (!v) throw new Error(`secret ${name} is empty`);
  return v;
}
