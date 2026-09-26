// Extraction jobs (FIRECRAWL_PI_SPEC.md §14, §16.1; M5): POST /v2/extract over explicit URLs, run by the
// gateway itself. The receipt commits at admission like a crawl's (src/store.mjs); this runner then, one
// job at a time on a chain of its own, so crawl polling never waits behind an extraction:
//   1. scrapes each URL through the core's /v2/scrape (markdown), under the same retrieval policy as any
//      scrape, archiving each page as it lands, so a restart resumes rather than scrapes again;
//   2. sends the pages to the retrieval service's model adapter with the job's submission key as the
//      logical id: a retried job reuses every model call already settled and never re-sends one whose
//      outcome is unknown;
//   3. archives the result (data, the source URLs of each value, warnings, the units and their usage) and
//      closes the job SUCCEEDED, PARTIAL (a page or unit failed) or FAILED, with the failures named.
// A job past its deadline is closed FAILED. Nothing here chooses a model or holds a provider credential.
import { randomUUID } from "node:crypto";

export function makeExtractJobs({ cfg, store, upstream, archive, extractor, log }) {
  const instance = randomUUID();
  const L = cfg.manifest.limits;
  let chain = Promise.resolve(), timer = null, stopped = false;
  const serial = (fn) => { const p = chain.then(fn, fn); chain = p.catch(() => {}); return p; };
  const say = (o) => log({ event: "extract_job", instance, ...o });
  const note = (job, url, code, error, i) => ({ id: `fcpi:${job.id}:${code}:${i}`, timestamp: new Date().toISOString(), url, code, error: String(error ?? "").slice(0, 2000) });

  async function scrapeOne(job, url, i, have) {
    const key = `source:${i}`;
    const row = have.find((r) => r.doc_key === key);
    if (row) return { doc: JSON.parse((await archive.read(row.sha256)).toString("utf8")) };
    const so = job.request.scrapeOptions ?? {};
    // markdown alone: the model reads text, and the other formats would only cost memory here.
    const body = { ...so, url, formats: ["markdown"], timeout: Math.min(so.timeout ?? L.extract.scrapeTimeoutMs, L.extract.scrapeTimeoutMs), origin: job.submission_key };
    let r;
    try { r = await upstream.call("POST", "/v2/scrape", { body, timeoutMs: cfg.coreTimeoutMs, maxBytes: 16 * 1048576 }); }
    catch (e) { return { failure: { code: `UPSTREAM_${e.code}`, error: `the core did not answer the scrape (${e.code})`, retry: !e.delivered } }; }
    if (r.status !== 200 || r.json?.success !== true || !r.json?.data) return { failure: { code: String(r.json?.code ?? `HTTP_${r.status}`).slice(0, 64), error: r.json?.error ?? `the core answered ${r.status}` } };
    const buf = Buffer.from(JSON.stringify(r.json.data));
    const put = await archive.put(buf);
    await store.addDocuments(job.id, [{ ordinal: i + 1, docKey: key, sha256: put.sha256, bytes: put.bytes }]);
    return { doc: r.json.data };
  }

  async function runOne() {
    const job = await store.claimExtract(instance, L.extract.deadlineMinutes);
    if (!job) return false;
    const urls = job.request.urls;
    if (job.overdue) {
      await store.finishExtract(job.id, "FAILED", { total: urls.length, errorCode: "JOB_DEADLINE_EXCEEDED", error: `the extraction ran past its ${L.extract.deadlineMinutes}-minute deadline` }, "deadline passed");
      say({ job: job.id, action: "deadline" });
      return true;
    }
    say({ job: job.id, action: "run", urls: urls.length, attempt: job.dispatch_attempts });
    const have = await store.documentKeys(job.id);
    const docs = [], errors = [];
    for (const [i, url] of urls.entries()) {
      if (stopped) return false; // resumed by the next process: the job stays RUNNING
      const r = await scrapeOne(job, url, i, have);
      if (r.failure?.retry) { say({ job: job.id, action: "scrape_deferred", url_index: i, reason: r.failure.code }); return false; }
      if (r.failure) { errors.push(note(job, url, r.failure.code, r.failure.error, errors.length)); continue; }
      docs.push({ url: r.doc?.metadata?.url ?? r.doc?.metadata?.sourceURL ?? url, markdown: typeof r.doc?.markdown === "string" ? r.doc.markdown : "" });
    }
    const counts = { total: urls.length };
    if (!docs.length) {
      await store.finishExtract(job.id, "FAILED", { ...counts, completed: 0, errors: { errors, robotsBlocked: [] }, errorCode: "NO_PAGES", error: "no URL could be scraped, so nothing was extracted" }, "every scrape failed");
      say({ job: job.id, action: "finished", state: "FAILED", reason: "NO_PAGES" });
      return true;
    }
    let x;
    try {
      x = await extractor.extract({ logicalId: job.submission_key, schema: job.request.schema, prompt: job.request.prompt ?? null, systemPrompt: job.request.systemPrompt ?? null,
        documents: docs, deadline: new Date(job.deadline).toISOString() }, Math.max(5000, new Date(job.deadline).getTime() - Date.now()));
    } catch (e) {
      // Unreachable: the job stays RUNNING and is tried again (its reservations make that safe); a delivered
      // request that lost its answer is the same, since the retry reuses what was settled.
      say({ job: job.id, action: "extractor_unavailable", reason: e.code, delivered: e.delivered });
      return false;
    }
    const failure = x.status !== 200 ? x.json?.failure ?? { class: `EXTRACTOR_HTTP_${x.status}`, detail: `the extraction service answered ${x.status}` } : (x.json?.ok ? null : x.json?.failure);
    const result = x.status === 200 && x.json ? { data: x.json.data, sources: x.json.sources, warnings: x.json.warnings, missingRequired: x.json.missingRequired,
      model: x.json.model, units: x.json.units, usage: x.json.usage } : { data: null, failure };
    const buf = Buffer.from(JSON.stringify(result));
    const put = await archive.put(buf);
    await store.addDocuments(job.id, [{ ordinal: 0, docKey: "result", sha256: put.sha256, bytes: put.bytes }]);
    for (const u of result.units ?? []) if (!u.ok) errors.push(note(job, u.url, u.failure?.class ?? "UNIT_FAILED", `unit ${u.part}: ${u.failure?.detail ?? "failed"}`, errors.length));
    const to = failure ? "FAILED" : errors.length ? "PARTIAL" : "SUCCEEDED";
    await store.finishExtract(job.id, to, { ...counts, completed: docs.length, errors: { errors, robotsBlocked: [] },
      errorCode: failure?.class ?? null, error: failure ? String(failure.detail ?? "").slice(0, 2000) : null }, `extraction ${to.toLowerCase()}: ${docs.length} of ${urls.length} pages, ${errors.length} failures`);
    say({ job: job.id, action: "finished", state: to, pages: docs.length, failures: errors.length, failure: failure?.class ?? null, cost_micro_usd: result.usage?.costMicroUsd ?? null });
    return true;
  }

  const tick = () => serial(async () => { while (!stopped && (await runOne())); });
  return {
    instance,
    start() { timer = setInterval(() => tick().catch((e) => say({ action: "tick_failed", error: e.message })), cfg.pollMs); tick().catch((e) => say({ action: "tick_failed", error: e.message })); },
    stop() { stopped = true; clearInterval(timer); return chain; },
    kick: () => (stopped ? chain : tick()),
  };
}
