// A hard library@version request (docs/FIRECRAWL_PI_SEARCH_INTELLIGENCE_SPEC.md §6.1): the version a Context7 library id names, the
// comparison with the requested one, and the report that says, per requested version, whether any evidence confirmed it, found no
// documentation for it, or could not say. Without the report a request for a version that does not exist (Python 4.0) came back
// as a complete answer made of other versions' pages.
import { test } from "node:test";
import assert from "node:assert/strict";
import { versionOfLibraryId, sameVersion } from "../src/search-intelligence/adapters/context7.mjs";
import { exactVersionReport, hardVersions, urlVersionCheck, versionRowReport } from "../src/search-intelligence/versions.mjs";

test("a library id names its version in a trailing version segment or a trailing underscore version, and nothing else does", () => {
  for (const [id, want] of [["/websites/python_3_10", "3.10"], ["/websites/django_5_2_3", "5.2.3"], ["/vercel/next.js/v14.3.0-canary.87", "14.3.0"], ["/org/proj/v5", "5"],
    ["/django/django/5.2", "5.2"], ["/org/proj/V2.1", "2.1"]]) assert.equal(versionOfLibraryId(id), want, id);
  // Years, bare numbers, one underscore number, words, malformed input and a library whose own name looks like a version (v8, v3) name no
  // version: a wrong guess would drop good passages.
  for (const id of ["/vuejs/docs", "/websites/mobx_2024_01", "/org/proj/2024", "/org/proj/20", "/websites/c_17", "/websites/python_3", "/websites/example_com", "/org/lib/latest",
    "/org/proj/v", "/org/proj/v1.2.3.4.5", "/v8/v8", "/vuejs/v3", "/ruby/3.2", "", null, undefined, 42, {}]) assert.equal(versionOfLibraryId(id), null, String(id));
});

test("two versions agree when one is a dot-boundary prefix of the other, and never on a different number", () => {
  for (const [a, b] of [["3.10", "3.10.4"], ["v3.5", "3.5.2"], ["3", "3.10"], ["4.0", "4"], ["3.5.2", "3.5"], ["V2", "2.0.1"]]) assert.equal(sameVersion(a, b), true, `${a} ${b}`);
  for (const [a, b] of [["4.0", "3.10"], ["3.1", "3.10"], ["3.10", "3.1"], ["5", "15"], ["2.0", "2.1"], ["3.5", "4"]]) assert.equal(sameVersion(a, b), false, `${a} ${b}`);
});

const lib = (name, version) => ({ name, ...(version ? { version } : {}) });
const sub = (name, version, versionVerdict) => ({ scope: { libraries: [name], version }, status: "ok", reason: null, detail: null, ...(versionVerdict ? { versionVerdict } : {}) });
const c7 = (...subs) => ({ provider: "context7", status: "success_results", suboperations: subs });

test("the report names each requested version's verdict, leaves unversioned and latest requests out, and says unconfirmed when nothing can say", () => {
  const request = { intelligence: { libraries: [lib("python", "4.0"), lib("vue", "3.5"), lib("react"), lib("node", "latest")] } };
  assert.deepEqual(exactVersionReport(request, [c7(sub("python", "4.0", "no_match"), sub("vue", "3.5", "confirmed"))]), [
    { library: "python", version: "4.0", verdict: "no_match" }, { library: "vue", version: "3.5", verdict: "confirmed" }]);
  // No Context7 outcome (documentation off, or its lane did not run), a scope it never answered, and an older cached answer with no verdict.
  assert.deepEqual(exactVersionReport(request, []), [{ library: "python", version: "4.0", verdict: "unconfirmed" }, { library: "vue", version: "3.5", verdict: "unconfirmed" }]);
  assert.deepEqual(exactVersionReport(request, [c7(sub("python", "4.0"))]).map((x) => x.verdict), ["unconfirmed", "unconfirmed"]);
  assert.deepEqual(exactVersionReport({ intelligence: { libraries: [lib("react")] } }, [c7()]), []);
  assert.deepEqual(exactVersionReport({ intelligence: {} }, []), []);
});

// A discovery engine is blind to versions, but a URL often states the release it documents (/en/6.1/, v7.vite.dev, whatsnew/3.14.html). Spec §11.2:
// exact known version violations are removed by code before ranking. Only what a URL itself says counts, and only when the URL also names the library.
test("a URL that names the library and states another release is a known mismatch; the same release line matches; anything else says nothing", () => {
  const check = (url, name, version) => urlVersionCheck(url, [{ name, version }]).status;
  for (const [url, name, version, want] of [
    ["https://docs.djangoproject.com/en/5.2/topics/db/", "django", "5.2", "match"],
    ["https://docs.djangoproject.com/en/6.1/topics/db/", "django", "5.2", "mismatch"],
    ["https://docs.djangoproject.com/en/5.2.3/releases/", "django", "5.2", "match"],
    ["https://v6.vite.dev/guide/migration", "vite", "6", "match"],
    ["https://v7.vite.dev/guide/migration", "vite", "6", "mismatch"],
    ["https://docs.python.org/3/whatsnew/3.14.html", "python", "3.14", "match"],
    ["https://docs.python.org/3/whatsnew/3.11.html", "python", "4.0", "mismatch"],
    ["https://nodejs.org/docs/latest-v20.x/api/fs.html", "node", "18", "mismatch"],
    ["https://registry.terraform.io/providers/hashicorp/aws/5.83.0/docs/resources/s3_bucket", "hashicorp/aws", "5", "match"],
    ["https://registry.terraform.io/providers/hashicorp/aws/6.28.0/docs/resources/s3_bucket", "hashicorp/aws", "5", "mismatch"],
    // A URL that states both a release line and the requested one (release notes of 5.2 kept in the 6.1 tree) is not shown to be another release.
    ["https://docs.djangoproject.com/en/6.1/releases/5.2/", "django", "5.2", "match"],
    // Nothing stated: latest, stable, current and dev name no release; years, dates, ids and a bare number are not versions; another library's page says nothing.
    ["https://docs.djangoproject.com/en/dev/topics/db/", "django", "5.2", "unknown"],
    ["https://www.postgresql.org/docs/current/pgstatstatements.html", "postgresql", "17", "unknown"],
    ["https://docs.python.org/3/library/asyncio.html", "python", "3.14", "unknown"],
    ["https://blog.example.org/django/2024/05/12/post", "django", "5.2", "unknown"],
    ["https://blog.example.org/django/posts/12345/", "django", "5.2", "unknown"],
    ["https://blog.example.org/tips/6.1/", "django", "5.2", "unknown"],
    ["https://example.org/go/1.22/", "go", "1.21", "unknown"],
    ["not a url", "django", "5.2", "unknown"], ["", "django", "5.2", "unknown"]]) assert.equal(check(url, name, version), want, `${url} for ${name}@${version}`);
  // Each requested library decides for the URLs that name it; a request with no hard version asks nothing.
  const both = [{ name: "vite", version: "6" }, { name: "django", version: "5.2" }];
  assert.equal(urlVersionCheck("https://docs.djangoproject.com/en/6.1/", both).status, "mismatch");
  assert.equal(urlVersionCheck("https://v6.vite.dev/guide", both).status, "match");
  assert.equal(urlVersionCheck("https://v7.vite.dev/guide", []).status, "unknown");
});

test("the hard versions of a request are its libraries with a version other than latest", () => {
  assert.deepEqual(hardVersions({ intelligence: { libraries: [lib("python", "4.0"), lib("react"), lib("node", "latest"), lib("vue", "3.5")] } }), [{ name: "python", version: "4.0" }, { name: "vue", version: "3.5" }]);
  assert.deepEqual(hardVersions({ intelligence: {} }), []);
});

test("the row report counts the rows a scope or a URL confirmed, the rows nothing says anything about, and the rows left out; a request with no hard version has none", () => {
  const req = { intelligence: { libraries: [lib("vue", "3.5")] } };
  const rows = [{ constraintStatus: [{ constraint: "version", status: "satisfied", basis: "url" }] }, { constraintStatus: [{ constraint: "version", status: "unverified" }] },
    { constraintStatus: [], documentation: { scopes: [{ status: "scope_only" }] } }, { constraintStatus: [], documentation: { scopes: [{ status: "unknown" }] } }, { constraintStatus: [] }];
  assert.deepEqual(versionRowReport(req, rows, 2), { returned: 5, confirmed: 2, unverified: 3, excluded: 2 });
  assert.deepEqual(versionRowReport(req, [], 0), { returned: 0, confirmed: 0, unverified: 0, excluded: 0 });
  assert.equal(versionRowReport({ intelligence: { libraries: [lib("vue")] } }, rows, 0), null);
});
