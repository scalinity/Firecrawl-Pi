// The json scrape format (FIRECRAWL_PI_SPEC.md §14; M5): the page is scraped as markdown through the core,
// then read by the retrieval service's model adapter under the request's id as its logical id. The format
// spends the model budget, so it needs the 'extract' scope as /v2/extract does. A failed extraction answers
// with the adapter's typed class and status; a requested format is never silently dropped (spec §9.4), and
// a part of the page the model could not read is named, not passed off as values the page lacks.
import { cutText } from "./extract.mjs";

export function makeJsonScrape({ cfg, M, upstream, extractor }) {
  return async function jsonScrape(ctx, body, json) {
    // The json format draws on the model budget: a token that may only scrape cannot spend it (review W7).
    if (!ctx.client.scopes.has("extract")) return ctx.send(403, { success: false, code: "INSUFFICIENT_SCOPE", error: "The json format spends the model budget and needs the 'extract' scope." });
    const t0 = Date.now();
    const wanted = body.formats.filter((f) => typeof f === "string");
    const formats = [...new Set([...wanted, "markdown"])];
    let r;
    try { r = await upstream.call("POST", "/v2/scrape", { body: { ...body, formats }, timeoutMs: cfg.coreTimeoutMs, maxBytes: 16 * 1048576 }); }
    catch (e) { return ctx.send(e.code === "TIMEOUT" ? 504 : 502, { success: false, code: e.code === "TIMEOUT" ? "UPSTREAM_TIMEOUT" : "UPSTREAM_UNAVAILABLE", error: e.code === "TIMEOUT" ? "The core did not answer in time." : "The core is unavailable." }); }
    if (r.status !== 200 || r.json?.success !== true || !r.json?.data) return ctx.send(r.status === 200 ? 502 : r.status, r.json ?? { success: false, code: "UPSTREAM_ERROR", error: `The core answered ${r.status}.` });
    const doc = r.json.data;
    // The extraction's deadline is what is left of the request's; the gateway waits five seconds past it, so an
    // answer the retrieval service sends at its deadline (a paid one, perhaps) still arrives (review W14).
    const left = Math.max(1000, cfg.coreTimeoutMs + 10000 - (Date.now() - t0));
    // The model reads the page's markdown up to the extraction limit; the gateway sends no more (review W4).
    const md = cutText(doc.markdown, M.limits.extract.maxDocumentBytes);
    let x;
    try {
      x = await extractor.extract({ logicalId: `scrape:${ctx.id}`, schema: json.schema, prompt: json.prompt ?? null,
        documents: [{ url: doc.metadata?.url ?? body.url, markdown: md.text }], deadline: new Date(Date.now() + left).toISOString() }, left + 5000);
    } catch (e) { return ctx.send(503, { success: false, code: "EXTRACTION_UNAVAILABLE", error: `The extraction service could not be reached (${e.code}); the page was scraped but not extracted.` }, { "retry-after": "10" }); }
    const failure = x.status === 200 && x.json?.ok ? null : (x.json?.failure ?? null);
    if (failure || x.status !== 200) {
      const f = failure ?? { class: "EXTRACTION_FAILED", detail: `the extraction service answered ${x.status}` };
      return ctx.send(x.status !== 200 ? x.status : 502, { success: false, code: f.class, error: `The page was scraped, but its json format failed: ${f.detail}` }, f.retryAfter ? { "retry-after": String(f.retryAfter) } : {});
    }
    doc.json = x.json.data;
    if (!wanted.includes("markdown")) delete doc.markdown;
    // A part of the page no answer came for is named, with the reason, so its nulls are not read as absent values (review S9).
    const units = x.json.units ?? [];
    const warnings = [...(md.cut ? [`the page's markdown was cut at ${M.limits.extract.maxDocumentBytes} bytes before extraction`] : []),
      ...units.filter((u) => !u.ok).map((u) => `part ${u.part} of the page was not extracted (${u.failure?.class ?? "UNIT_FAILED"}), so its values may be missing`),
      ...(x.json.warnings ?? [])];
    if (warnings.length) doc.warning = [doc.warning, ...warnings].filter(Boolean).join("; ");
    ctx.send(200, { success: true, data: doc, fcpi: { extraction: { model: x.json.model, sources: x.json.sources, missingRequired: x.json.missingRequired, units, usage: x.json.usage } } });
  };
}
