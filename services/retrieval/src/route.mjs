// The egress decision for one acquisition and the domain routing record it learns from (FIRECRAWL_PI_SPEC.md
// §9.1, §9.5, §10.2), as pure functions: store.mjs keeps the records and holds, acquire.mjs asks these.
//
// A request's route is the caller's scrape option, carried by the core (patch 0009):
//   basic    direct egress only ("local-only"): never escalates to a paid route, never passes the direct limits;
//   stealth  the residential route from the start, and nothing else;
//   auto     the cheapest permitted route: direct, unless the domain is held for a bulk job, listed proxy-first,
//            or has learned that it blocks the home connection; residential after a public-content challenge on
//            the direct route, or once the direct limits for the domain or the platform are spent.
// Whatever the route, work that needs the residential route and cannot have it fails as PROXY_REQUIRED: it is
// never sent from the home connection instead (spec §10.2).
export const ROUTES = new Set(["auto", "basic", "stealth"]);

const hours = (h) => h * 3600e3;
const minutes = (m) => m * 60e3;
const t = (d) => (d ? new Date(d).getTime() : null);

// The tier the first attempt starts on, and why. record: the domain's routing row or null; held: an active
// route hold (a bulk job's) on the domain; proxyFirst: the domain is a listed override.
// probe: this acquisition is the one cheaper probe after a residential preference expired (spec §9.5).
export function startTier({ route, record, held, proxyFirst, now = Date.now(), routing }) {
  if (route === "basic") return { tier: "direct", reason: "local_only" };
  if (route === "stealth") return { tier: "residential", reason: "requested" };
  if (held) return { tier: "residential", reason: "bulk_hold" };
  if (proxyFirst) return { tier: "residential", reason: "proxy_first_domain" };
  if (record?.preferred === "residential") {
    if (t(record.expires_at) > now) return { tier: "residential", reason: "learned_block" };
    // Expired: one probe on the cheaper route at a time; others keep the residential route while it runs.
    if (t(record.probe_at) && t(record.probe_at) + minutes(routing.probeMinutes) > now) return { tier: "residential", reason: "probe_in_progress" };
    return { tier: "direct", reason: "probe_after_expiry", probe: true };
  }
  return { tier: "direct", reason: "default" };
}

// Whether the first attempt renders in the browser: a domain learned to serve script shells (two consistent
// observations, as for the route) skips the HTTP attempt it would only waste (spec §9.1: known JS targets start
// in a browser).
export const startsInBrowser = (record, now = Date.now()) => record?.prefer_browser === true && t(record.browser_expires_at) > now;

// One observation of an attempt's outcome, and the record it leaves. Returns the changed fields, or null for no
// change. Only a target's own answers teach: provider failures, authentication gates, rate limits and missing
// pages never reach here (the caller filters them), so they cannot poison a domain's record (spec §9.5).
//   tier: the attempt's egress (direct | residential); mode: http | browser; outcome: challenge | adequate |
//   js_rendered (an HTTP script shell that the browser then rendered adequately on the same tier). probe: the
//   attempt was the one cheaper probe after an expired preference.
export function observe(record, { tier, mode = "http", outcome, probe = false }, routing, now = Date.now()) {
  const r = record ?? { preferred: null, challenges: 0, js_count: 0, prefer_browser: false };
  const ttl = hours(routing.ttlHours), cap = routing.maxTtlDays * 86400e3;
  const at = new Date(now);
  let change = null;
  const add = (o) => { change = { ...(change ?? {}), ...o, reason: change ? `${change.reason},${o.reason}` : o.reason }; };
  if (tier === "direct" && outcome === "challenge") {
    // The probe after an expired preference confirms the block at once; otherwise two consistent observations.
    const n = (r.challenges ?? 0) + 1;
    if (probe || r.preferred === "residential") add({ preferred: "residential", set_at: at, expires_at: new Date(now + ttl), challenges: 0, probe_at: null, reason: probe ? "probe_confirmed" : "reconfirmed" });
    else if (n >= routing.observationsToChange) add({ preferred: "residential", set_at: at, expires_at: new Date(now + ttl), challenges: 0, probe_at: null, reason: "consistent_challenges" });
    else add({ challenges: n, reason: "challenge_pending" });
  }
  if (tier === "direct" && outcome === "adequate") {
    if (probe) add({ preferred: null, set_at: null, expires_at: null, challenges: 0, probe_at: null, reason: "probe_cleared" });
    else if ((r.challenges ?? 0) > 0) add({ challenges: 0, reason: "challenge_reset" });
  }
  if (tier === "residential" && outcome === "adequate" && r.preferred === "residential" && t(r.expires_at) > now) {
    // A success on the preferred route extends it by one TTL, never past maxTtlDays from when it was set.
    const until = Math.min(now + ttl, t(r.set_at) + cap);
    if (until > t(r.expires_at)) add({ expires_at: new Date(until), reason: "extended" });
  }
  if (outcome === "js_rendered") {
    const n = (r.js_count ?? 0) + 1;
    if (n >= routing.observationsToChange) add({ prefer_browser: true, browser_expires_at: new Date(now + ttl), js_count: 0, reason: "consistent_js" });
    else add({ js_count: n, reason: "js_pending" });
  }
  // An HTTP answer that needed no browser undoes the script-shell learning.
  if (outcome === "adequate" && mode === "http" && ((r.js_count ?? 0) > 0 || r.prefer_browser)) add({ js_count: 0, prefer_browser: false, browser_expires_at: null, reason: "js_reset" });
  return change;
}

// The Decodo-documented proxy username for one sticky session (help.decodo.com, residential "User:pass
// requests", checked 2026-09-26): "user-<name>-session-<id>-sessionduration-<minutes>". One session per logical
// acquisition keeps one exit for the page, its redirects, cookies and subresources (spec §10.2); independent
// acquisitions rotate. Geography stays unset (spec §10.2).
export function sessionUsername(name, sessionId, minutesValue) {
  if (!/^[A-Za-z0-9_]+$/.test(name)) throw new Error("the proxy username may hold letters, digits and underscores only");
  if (!/^[A-Za-z0-9]{1,64}$/.test(sessionId)) throw new Error("a session id is 1-64 letters and digits");
  return `user-${name}-session-${sessionId}-sessionduration-${minutesValue}`;
}
