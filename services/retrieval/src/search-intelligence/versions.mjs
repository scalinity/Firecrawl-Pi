// What a hard library@version request got (docs/FIRECRAWL_PI_SEARCH_INTELLIGENCE_SPEC.md §6.1): for each requested version, whether Context7's
// scope for it confirmed the version, found no documentation for it, or could not say. The discovery engines are blind to versions, so only a
// documentation scope can confirm one; without this report a request for a version that does not exist came back as a complete answer made
// of other versions' pages. A scope with no verdict (documentation off, its lane failed, an older cached answer) is unconfirmed.
const VERDICTS = new Set(["confirmed", "no_match", "unconfirmed"]);

export function exactVersionReport(request, docsOutcomes) {
  const context7 = docsOutcomes.find((o) => o.provider === "context7");
  return (request.intelligence?.libraries ?? []).filter((l) => l.version && !/^latest$/i.test(l.version)).map((l) => {
    const sub = context7?.suboperations?.find((s) => s.scope?.version === l.version && s.scope.libraries?.[0] === l.name.slice(0, 120));
    return { library: l.name, version: l.version, verdict: VERDICTS.has(sub?.versionVerdict) ? sub.versionVerdict : "unconfirmed" };
  });
}
