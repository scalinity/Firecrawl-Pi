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
// a date, an id and the words latest, stable, current and dev state no release. It counts only for a URL that names the library structurally, since another
// product's page says nothing about this one: the name is a whole host label (or one with a site affix: djangoproject, nodejs, vuejs, name-docs), or a whole
// path segment that comes before the release, or, for owner/name, two consecutive path segments. A substring of another name or host ties nothing
// (node-postgres, preactjs, celeryq.dev/…/django/, vitest, python-requests, next-auth.js.org).
const SEGMENT = [/^v?(\d{1,3}(?:\.\d{1,3}){1,2})$/i, /^v(\d{1,3})$/i, /^v?(\d{1,3})\.x$/i, /^latest-v(\d{1,3})(?:\.x)?$/i, /^(\d{1,3}(?:\.\d{1,3}){1,2})\.(?:html?|md|txt|rst)$/i];
const flat = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, "");
const versionOf = (token) => { for (const re of SEGMENT) { const m = re.exec(token); if (m) return m[1]; } return null; };
function urlParts(url) {
  let u;
  try { u = new URL(url); } catch { return null; }
  const host = u.hostname.split(".").filter(Boolean).map((text) => ({ text, flat: flat(text), version: versionOf(text) }));
  const path = u.pathname.split("/").filter(Boolean).map((text) => ({ text, flat: flat(text), version: versionOf(text) }));
  return { host, path };
}
// The release versions this URL states for the library, or null when the URL does not name the library.
function statedFor(parts, name) {
  const segs = String(name).split("/"), lib = flat(segs.at(-1)), owner = segs.length > 1 ? flat(segs.at(-2)) : null;
  if (lib.length < 3) return null;
  const all = (list) => list.filter((x) => x.version !== null).map((x) => x.version);
  if (owner) {
    const at = parts.path.findIndex((x, i) => x.flat === owner && parts.path[i + 1]?.flat === lib);
    return at < 0 ? null : all(parts.path.slice(at + 2));
  }
  const site = new Set([lib, `${lib}js`, `${lib}project`, `${lib}docs`, `docs${lib}`]);
  if (parts.host.some((x) => site.has(x.flat))) return [...all(parts.host), ...all(parts.path)];
  const at = parts.path.findIndex((x) => x.flat === lib);
  return at < 0 ? null : all(parts.path.slice(at + 1));
}

// { status: "match" | "mismatch" | "unknown" } for one URL against the hard versions of a request. A URL that states the requested release line, even beside
// another (the notes of 5.2 kept in the 6.1 tree), is not shown to be another release.
export function urlVersionCheck(url, hard) {
  const parts = urlParts(url);
  if (!parts) return { status: "unknown" };
  let mismatch = null;
  for (const { name, version } of hard) {
    const stated = statedFor(parts, name);
    if (!stated?.length) continue;
    if (stated.some((v) => sameVersion(version, v))) return { status: "match", library: name };
    mismatch ??= { status: "mismatch", library: name, observed: stated[0] };
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
