// A hard library@version request (docs/FIRECRAWL_PI_SEARCH_INTELLIGENCE_SPEC.md §6.1): the version a Context7 library id names, the
// comparison with the requested one, and the report that says, per requested version, whether any evidence confirmed it, found no
// documentation for it, or could not say. Without the report a request for a version that does not exist (Python 4.0) came back
// as a complete answer made of other versions' pages.
import { test } from "node:test";
import assert from "node:assert/strict";
import { versionOfLibraryId, sameVersion } from "../src/search-intelligence/adapters/context7.mjs";
import { exactVersionReport } from "../src/search-intelligence/versions.mjs";

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
