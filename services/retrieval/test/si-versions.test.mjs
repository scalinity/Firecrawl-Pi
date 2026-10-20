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

// The library tie is structural: the name is a whole host label (or the label with a site affix: djangoproject, nodejs, vuejs), or a whole path segment that comes
// before the version, or, for owner/name, two consecutive segments. A substring of another product's name or host ties nothing (SI6 acceptance review, second round).
test("another product's versioned page is not shown to be another release of the requested library", () => {
  const check = (url, name, version) => urlVersionCheck(url, [{ name, version }]).status;
  for (const [url, name, version] of [
    ["https://github.com/brianc/node-postgres/tree/v8.11.0/docs", "node", "18"], ["https://node-postgres.com/8.11/features/pooling", "node", "18"],
    ["https://docs.celeryq.dev/en/v5.3.6/django/first-steps-with-django.html", "django", "5.2"], ["https://reactrouter.com/6.28.0/start/overview", "react", "19"],
    ["https://preactjs.com/guide/v10/getting-started", "react", "19"], ["https://docs.python-requests.org/en/2.31.0/", "python", "3.14"], ["https://next-auth.js.org/v3/getting-started/introduction", "next", "15"],
    ["https://v2.vitest.dev/guide/", "vite", "6"], ["https://geopandas.org/en/v0.14.4/", "pandas", "2.0"], ["https://cloudnative-pg.io/docs/1.29/postgresql_conf/", "postgresql", "17"],
    ["https://docs.aws.amazon.com/aws/6.0.0/guide/", "hashicorp/aws", "5"], ["https://example.org/hashicorp/other/aws/6.0.0/", "hashicorp/aws", "5"]])
    assert.equal(check(url, name, version), "unknown", `${url} for ${name}@${version}`);
  // The forms that do name the library keep working: a library-owned site, the owner/name of a repository or a registry, and a path that names it before the release.
  for (const [url, name, version, want] of [
    ["https://github.com/vitejs/vite/blob/v7.0.0/docs/guide/migration.md", "vite", "6", "mismatch"], ["https://github.com/python/cpython/blob/main/Doc/whatsnew/2.6.rst", "python", "2.7", "unknown"],
    ["https://docs.python.org/3.4/whatsnew/index.html", "python", "4.0", "mismatch"], ["https://pandas.pydata.org/pandas-docs/version/1.5/reference/api/pandas.DataFrame.append.html", "pandas", "2.0", "mismatch"],
    ["https://vuejs.org/v2/guide/reactivity", "vue", "3.5", "mismatch"], ["https://v3.vuejs.org/guide/reactivity", "vue", "3.5", "match"], ["https://nextjs.org/docs/14/app", "next", "15", "unknown"],
    ["https://registry.terraform.io/providers/hashicorp/aws/6.28.0/docs/resources/s3_bucket", "hashicorp/aws", "5", "mismatch"]])
    assert.equal(check(url, name, version), want, `${url} for ${name}@${version}`);
});

// Another product of the same organisation, a sub-product on the library's own site, and a package that shares the library's name are not the library (second round of the
// acceptance review): on a code host the name must be the repository, on a package registry a package's version is the package's, and on the library's own site a version label
// counts only when it is next to the library's label.
test("a sub-product, a same-named organisation and a same-named package do not state the requested library's release", () => {
  const check = (url, name, version) => urlVersionCheck(url, [{ name, version }]).status;
  for (const [url, name, version] of [
    ["https://v3.router.vuejs.org/guide/", "vue", "3.5"], ["https://v3.router.vuejs.org/guide/", "vue", "2.7"],
    ["https://github.com/redis/redis-py/tree/v5.0.1", "redis", "7.2"], ["https://github.com/django/channels/tree/4.0.0", "django", "5.2"], ["https://github.com/django/channels/tree/4.0.0", "django", "4.0"],
    ["https://github.com/python/mypy/tree/v1.8.0", "python", "3.14"], ["https://github.com/webpack/webpack-dev-server/tree/v4.15.1", "webpack", "4"], ["https://github.com/webpack/webpack-cli/releases/tag/v4.10.0", "webpack", "4"],
    ["https://pypi.org/project/redis/5.0.1/", "redis", "7.2"], ["https://pkg.go.dev/github.com/redis/go-redis/v9", "redis", "7.2"], ["https://rubygems.org/gems/redis/versions/5.0.8", "redis", "7.2"],
    ["https://www.npmjs.com/package/mongodb/v/6.3.0", "mongodb", "7.0"]]) assert.equal(check(url, name, version), "unknown", `${url} for ${name}@${version}`);
  // The library's own repository, and its own site's version labels, still count.
  for (const [url, name, version, want] of [
    ["https://github.com/vitejs/vite/blob/v7.0.0/docs/guide/migration.md", "vite", "6", "mismatch"], ["https://github.com/django/django/blob/5.2/docs/releases/5.2.txt", "django", "5.2", "match"],
    ["https://github.com/webpack/webpack/tree/v4.46.0", "webpack", "4", "match"], ["https://v2.vuejs.org/v2/guide/", "vue", "3.5", "mismatch"], ["https://v3.vuejs.org/guide/", "vue", "3.5", "match"]])
    assert.equal(check(url, name, version), want, `${url} for ${name}@${version}`);
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
