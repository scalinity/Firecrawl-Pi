// What a hard library@version request got (docs/FIRECRAWL_PI_SEARCH_INTELLIGENCE_SPEC.md §6.1): for each requested version, whether Context7's
// scope for it confirmed the version, found no documentation for it, or could not say. The discovery engines are blind to versions, so only a
// documentation scope can confirm one; without this report a request for a version that does not exist came back as a complete answer made
// of other versions' pages. A scope with no verdict (documentation off, its lane failed, an older cached answer) is unconfirmed.
const VERDICTS = new Set(["confirmed", "no_match", "unconfirmed"]);

// The libraries of a request that ask for a particular release (not "latest").
export const hardVersions = (request) => (request.intelligence?.libraries ?? []).filter((l) => l.version && !/^latest$/i.test(l.version)).map((l) => ({ name: l.name, version: l.version }));

// Two versions agree when one is a prefix of the other on a dot boundary ("3.10" and "3.10.4"), never on a different number.
export function sameVersion(a, b) {
  const seg = (v) => String(v).replace(/^v/i, "").split(".");
  const x = seg(a), y = seg(b);
  for (let i = 0; i < Math.min(x.length, y.length); i++) if (x[i] !== y[i]) return false;
  return true;
}

export function exactVersionReport(request, docsOutcomes) {
  const context7 = docsOutcomes.find((o) => o.provider === "context7");
  return hardVersions(request).map((l) => {
    const sub = context7?.suboperations?.find((s) => s.scope?.version === l.version && s.scope.libraries?.[0] === l.name.slice(0, 120));
    return { library: l.name, version: l.version, verdict: VERDICTS.has(sub?.versionVerdict) ? sub.versionVerdict : "unconfirmed" };
  });
}

// What a URL says about the release it documents, with no page read (spec §11.2: exact known version violations are removed by code before ranking).
// Only a path segment or host label that is itself a version counts (/en/6.1/, v7.vite.dev, latest-v20.x, whatsnew/3.14.html): a bare number, a year,
// a date, an id and the words latest, stable, current and dev state no release. It counts only when the URL also names the library, since another
// library's page says nothing about this one.
const SEGMENT = [/^v?(\d{1,3}(?:\.\d{1,3}){1,2})$/i, /^v(\d{1,3})$/i, /^v?(\d{1,3})\.x$/i, /^latest-v(\d{1,3})(?:\.x)?$/i, /^(\d{1,3}(?:\.\d{1,3}){1,2})\.(?:html?|md|txt|rst)$/i];
const flat = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, "");
function urlStates(url) {
  let u;
  try { u = new URL(url); } catch { return null; }
  const stated = [];
  for (const token of [...u.hostname.split("."), ...u.pathname.split("/")].filter(Boolean)) for (const re of SEGMENT) { const m = re.exec(token); if (m) { stated.push(m[1]); break; } }
  return { stated, names: flat(u.hostname + u.pathname) };
}

// { status: "match" | "mismatch" | "unknown" } for one URL against the hard versions of a request. A URL that states the requested release line, even beside
// another (the notes of 5.2 kept in the 6.1 tree), is not shown to be another release.
export function urlVersionCheck(url, hard) {
  const seen = urlStates(url);
  if (!seen || !seen.stated.length) return { status: "unknown" };
  let mismatch = null;
  for (const { name, version } of hard) {
    const lib = flat(String(name).split("/").at(-1));
    if (lib.length < 3 || !seen.names.includes(lib)) continue;
    if (seen.stated.some((v) => sameVersion(version, v))) return { status: "match", library: name };
    mismatch ??= { status: "mismatch", library: name, observed: seen.stated[0] };
  }
  return mismatch ?? { status: "unknown" };
}

// What the returned rows say about the requested versions: the rows a documentation scope or a URL confirmed, the rows nothing says anything about, and
// the rows a URL showed to be another release and left out. Null when the request asks for no hard version.
const confirms = (d) => (d.constraintStatus ?? []).some((c) => c.constraint === "version" && c.status === "satisfied") || (d.documentation?.scopes ?? []).some((s) => s.status === "scope_only" || s.status === "match");
export function versionRowReport(request, rows, excluded) {
  if (!hardVersions(request).length) return null;
  const confirmed = rows.filter(confirms).length;
  return { returned: rows.length, confirmed, unverified: rows.length - confirmed, excluded };
}
