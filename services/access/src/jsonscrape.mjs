// The json scrape format (FIRECRAWL_PI_SPEC.md §14; M5): the page is scraped as markdown through the core,
// then read by the retrieval service's model adapter under the request's id as its logical id. The format
// spends the model budget, so it needs the 'extract' scope as /v2/extract does. A failed extraction answers
// with the adapter's typed class and status; a requested format is never silently dropped (spec §9.4), and
// a part of the page the model could not read is named, not passed off as values the page lacks.
import { cutText } from "./extract.mjs";
import { originFor } from "./auth.mjs";

export function makeJsonScrape({ cfg, M, upstream, extractor }) {
  return async function jsonScrape(ctx, body, json) {
    // The json format draws on the model budget: a token that may only scrape cannot spend it (review W7).
    if (!ctx.client.scopes.has("extract")) return ctx.send(403, { success: false, code: "INSUFFICIENT_SCOPE", error: "The json format spends the model budget and needs the 'extract' scope." });
    const t0 = Date.now();
    const deadline = t0 + cfg.coreTimeoutMs + 10000;
    const controller = new AbortController();
    let disconnected = false;
    const abort = () => controller.abort();
    const lost = () => { disconnected = true; abort(); };
    const closed = () => { if (!ctx.res?.writableEnded) lost(); };
    const gone = () => disconnected || Boolean(ctx.res?.destroyed || ctx.req?.aborted);
    const stopped = () => {
      if (!controller.signal.aborted && !gone()) return false;
      if (!gone()) ctx.send(504, { success: false, code: "REQUEST_TIMEOUT", error: "The request deadline was reached; no further extraction was sent." });
      return true;
    };
    ctx.res?.once("close", closed);
    ctx.req?.once("aborted", lost);
    // Retain the existing five-second margin for the extraction service to report its deadline outcome.
    const timer = setTimeout(abort, cfg.coreTimeoutMs + 15000);
    try {
      if (gone()) abort();
      if (stopped()) return;
      const wanted = body.formats.filter((f) => typeof f === "string");
      const formats = [...new Set([...wanted, "markdown"])];
      let r;
      try { r = await upstream.call("POST", "/v2/scrape", { body: { ...body, formats, origin: originFor(ctx.client.principal, "scrape") }, timeoutMs: cfg.coreTimeoutMs, maxBytes: 16 * 1048576, signal: controller.signal }); }
      // Never 502 for the gateway's own failure: a client library retries 502 by resubmitting (review W14).
      catch (e) {
        if (stopped()) return;
        return ctx.send(e.code === "TIMEOUT" ? 504 : 503, { success: false, code: e.code === "TIMEOUT" ? "UPSTREAM_TIMEOUT" : "UPSTREAM_UNAVAILABLE", error: e.code === "TIMEOUT" ? "The core did not answer in time." : "The core is unavailable." }, e.code === "TIMEOUT" ? {} : { "retry-after": "10" });
      }
      if (stopped()) return;
      if (r.status !== 200 || r.json?.success !== true || !r.json?.data) return ctx.send(r.status === 200 ? 500 : r.status, r.json ?? { success: false, code: "UPSTREAM_ERROR", error: `The core answered ${r.status}.` });
      const doc = r.json.data;
      // The extraction's deadline is what is left of the request's; the gateway waits five seconds past it, so an
      // answer the retrieval service sends at its deadline (a paid one, perhaps) still arrives (review W14).
      // The model reads the page's markdown up to the extraction limit; the gateway sends no more (review W4).
      const md = cutText(doc.markdown, M.limits.extract.maxDocumentBytes);
      const left = deadline - Date.now();
      if (left <= 0) { abort(); stopped(); return; }
      let x;
      try {
        x = await extractor.extract({ logicalId: `scrape:${ctx.id}`, schema: json.schema, prompt: json.prompt ?? null,
          ...(json.model ? { model: json.model, reasoningEffort: json.reasoningEffort } : {}),
          documents: [{ url: doc.metadata?.url ?? body.url, markdown: md.text }], deadline: new Date(deadline).toISOString() }, left + 5000, controller.signal);
      } catch (e) {
        if (stopped()) return;
        return ctx.send(503, { success: false, code: "EXTRACTION_UNAVAILABLE", error: `The extraction service could not be reached (${e.code}); the page was scraped but not extracted.` }, { "retry-after": "10" });
      }
      if (stopped()) return;
      const units = x.json?.units ?? [];
      const extraction = { model: x.json?.model ?? null, requestedModel: x.json?.requestedModel ?? null,
        reasoningEffort: x.json?.reasoningEffort ?? null, sources: x.json?.sources,
        missingRequired: x.json?.missingRequired, units, usage: x.json?.usage ?? null };
      if (x.status !== 200 || x.json?.ok !== true) {
        const f = x.json?.failure ?? { class: "EXTRACTION_FAILED", detail: `the extraction service answered ${x.status} without a successful extraction` };
        return ctx.send(x.status !== 200 ? x.status : 500, { success: false, code: f.class, error: `The page was scraped, but its json format failed: ${f.detail}`, fcpi: { extraction } }, f.retryAfter ? { "retry-after": String(f.retryAfter) } : {});
      }
      doc.json = x.json.data;
      if (!wanted.includes("markdown")) delete doc.markdown;
      // A part of the page no answer came for is named, with the reason, so its nulls are not read as absent values (review S9).
      const warnings = [...(md.cut ? [`the page's markdown was cut at ${M.limits.extract.maxDocumentBytes} bytes before extraction`] : []),
        ...units.filter((u) => !u.ok).map((u) => `part ${u.part} of the page was not extracted (${u.failure?.class ?? "UNIT_FAILED"}), so its values may be missing`),
        ...(x.json.warnings ?? [])];
      if (warnings.length) doc.warning = [doc.warning, ...warnings].filter(Boolean).join("; ");
      ctx.send(200, { success: true, data: doc, fcpi: { extraction } });
    } finally {
      clearTimeout(timer);
      ctx.res?.removeListener("close", closed);
      ctx.req?.removeListener("aborted", lost);
    }
  };
}
