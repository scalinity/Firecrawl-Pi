// The complex-document fallback (FIRECRAWL_PI_SPEC.md §15): the core parses every PDF natively first and
// asks here only for a scan-only document, a native-quality failure or a complex layout. The parser must
// be listed in the budget policy with a rate card in effect; without its credential the answer is
// PARSER_REQUIRED, never empty success. Credits (pages × the rate card's credits per page) are reserved
// before the upload and settled from the pages the provider returned. Results are cached by the
// document's bytes, the parser, its tier and version, and the owner; the uploaded file is deleted from
// the provider when its job names it.
//
// The provider's contract is LlamaParse's REST API v2: POST /api/v2/parse/upload (multipart: file and a
// JSON configuration) starts a job; GET /api/v2/parse/{id}?expand=markdown answers { job: { status },
// markdown: { pages: [{ page_number, markdown }] } } until the status is COMPLETED, FAILED or CANCELLED.
import { createHash, randomUUID } from "node:crypto";
import { rateCardFor, periodStarts, Breaker } from "./budget.mjs";
import { providerRequest, readCredential, ProviderError } from "./provider.mjs";
import { ExtractionFailure, canonical } from "./extract.mjs";

const fail = (c, d, x) => new ExtractionFailure(c, d, x);
const sha = (b) => createHash("sha256").update(b).digest("hex");
const sleep = (ms, signal) => new Promise((r) => { const t = setTimeout(r, ms); signal?.addEventListener("abort", () => { clearTimeout(t); r(); }, { once: true }); });

function multipart(fields) {
  const boundary = `fcpi-${randomUUID()}`;
  const parts = [];
  for (const f of fields) {
    parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${f.name}"${f.filename ? `; filename="${f.filename}"` : ""}\r\n${f.type ? `Content-Type: ${f.type}\r\n` : ""}\r\n`));
    parts.push(Buffer.isBuffer(f.value) ? f.value : Buffer.from(f.value));
    parts.push(Buffer.from("\r\n"));
  }
  parts.push(Buffer.from(`--${boundary}--\r\n`));
  return { body: Buffer.concat(parts), contentType: `multipart/form-data; boundary=${boundary}` };
}

export function makeParser({ store, getBudget, getSelection, paidDispatch, providersDir, getPolicy, resolvePublic, lookupFixture, log }) {
  const breakers = new Map();
  const breakerOf = (name) => breakers.get(name) ?? breakers.set(name, new Breaker(getBudget().breaker)).get(name);

  // A parse that took a half-open breaker's one probe and ended with no verdict hands the probe back (review W10).
  return async function parse(args, signal) {
    const hold = {};
    try { return await parseOnce(args, signal, hold); } finally { if (hold.probe && hold.breaker.probing) hold.breaker.neutral(); }
  };
  async function parseOnce({ logicalId, owner, bytes, pages, reason }, signal, hold) {
    const budget = getBudget(), P = budget.parsing;
    const name = getSelection().parser ?? P.defaultParser;
    const pp = budget.parsers[name];
    if (!pp) throw fail("PARSER_NOT_ALLOWED", `parser '${name}' is not in the budget policy`);
    if (typeof logicalId !== "string" || !/^[A-Za-z0-9:._|-]{8,200}$/.test(logicalId)) throw fail("INVALID_REQUEST", "a logical id is required");
    if (!["scan_only", "native_quality", "complex_layout"].includes(reason)) throw fail("INVALID_REQUEST", "reason must be scan_only, native_quality or complex_layout");
    if (bytes.length > P.maxBytes) throw fail("DOCUMENT_TOO_LARGE", `the document is ${bytes.length} bytes; at most ${P.maxBytes}`);
    if (!Number.isInteger(pages) || pages < 1 || pages > P.maxPages) throw fail("DOCUMENT_TOO_MANY_PAGES", `the document has ${pages} pages; at most ${P.maxPages}`);
    if (!bytes.subarray(0, 1024).includes(Buffer.from("%PDF"))) throw fail("UNSUPPORTED_CONTENT", "only PDF documents go to the complex-document parser");
    const prov = budget.providers[pp.provider], cat = budget.categories[pp.category];
    const card = rateCardFor(budget, name);
    if (!card) throw fail("RATE_CARD_MISSING", `no rate card for '${name}' is in effect today`);
    const docSha = sha(bytes);
    const key = sha(canonical({ bytes: docSha, parser: name, tier: pp.tier, version: pp.version, owner: owner ?? "" }));
    const hit = await store.parseCacheGet(key);
    if (hit) { log({ event: "parse", logical_id: logicalId, parser: name, cached: true, pages: hit.pages }); return { ok: true, parser: name, markdown: hit.markdown, pages: hit.pages, cached: true, credits: 0 }; }
    const cred = readCredential(providersDir, prov.credential);
    if (prov.credential && !cred) throw fail("PARSER_REQUIRED", `the document needs the complex-document parser (${reason.replace("_", " ")}), and ${pp.provider} has no credential in this deployment`);
    if (prov.paid && !paidDispatch) throw fail("PAID_DISPATCH_DISABLED", `'${name}' is a paid parser and paid dispatch is disabled (PI_PAID_DISPATCH_ENABLED=false)`);
    const breaker = breakerOf(pp.provider);
    const probe = breaker.state() === "half_open";
    if (!breaker.admit()) throw fail("PROVIDER_UNAVAILABLE", `provider ${pp.provider} failed repeatedly; its breaker is open`, { retryable: true, retryAfter: breaker.retryAfterS() });
    Object.assign(hold, { breaker, probe });
    const amount = pages * card.creditsPerPage;
    const { day, month } = periodStarts();
    const r = await store.reserveBudget({ id: randomUUID(), callKey: `${logicalId}:parse:${docSha.slice(0, 32)}`, logicalId, category: pp.category, caps: cat.caps,
      // A paid parser's credits also count against the paid total's day, in micro-USD (spec §28.3).
      paidTotalCap: prov.paid ? budget.paidTotal.caps.day : null, paidTotalRate: card.microUsdPerCredit,
      provider: pp.provider, subject: name, kind: "parse", unit: "credits", rateCard: card.id, requestHash: key, amount, day, month, notifyAt: budget.notifyAtFraction });
    if (r.existing) {
      breaker.neutral();
      if (r.existing.state === "SETTLED" && r.existing.result?.markdown !== undefined) return { ok: true, parser: name, ...r.existing.result, cached: false, reused: true, credits: Number(r.existing.actual) };
      throw fail("EXTRACTION_UNCERTAIN", `this document's parse was sent before and its outcome is unknown (${r.existing.state}); it is not sent again`);
    }
    if (r.exhausted) {
      breaker.neutral();
      const x = r.exhausted;
      throw fail("BUDGET_EXHAUSTED", `the ${x.category} ${x.period} allowance has ${Math.max(0, x.cap - x.used)} of ${x.cap} credits left; this document reserves ${amount}`);
    }
    for (const n of r.notices ?? []) log({ event: "budget_threshold", category: n.category, period: n.period, used: n.used, cap: n.cap });
    const res = r.reservation;
    const auth = cred ? { authorization: `Bearer ${cred}` } : {};
    // The parse runs to its end even if the caller leaves: the result is settled and cached, so a retry is a
    // cache hit rather than a second charge. Only the job deadline bounds it.
    const call = (method, path, body, extra = {}) => providerRequest({ baseUrl: prov.baseUrl, path, method, body, getPolicy, resolvePublic, lookupFixture,
      headers: { accept: "application/json", ...auth, ...extra }, timeoutMs: 30000, maxBytes: 16 * 1048576 });
    const started = Date.now();
    const settleOrThrow = async (e) => {
      breaker[e.code === "CANCELLED" ? "neutral" : "failure"]();
      if (!e.sent) { await store.releaseBudget(res.id, `not sent: ${e.code}`); throw fail("PROVIDER_UNREACHABLE", e.message, { retryable: true }); }
      await store.markBudgetUncertain(res.id, `${e.code}: ${e.message}`);
      throw fail("PROVIDER_UNCERTAIN", `the parse request may have been processed and no answer came; its ${amount} credits stay reserved`);
    };
    const refused = async (status, what) => {
      await store.releaseBudget(res.id, `provider answered ${status} to the ${what}`);
      if (status === 401 || status === 403) { breaker.failure(); throw fail("PROVIDER_AUTH_FAILED", `${pp.provider} refused the credential (HTTP ${status})`); }
      if (status === 402) { breaker.failure(); throw fail("PROVIDER_BILLING", `${pp.provider} refused for lack of credits (HTTP 402)`); }
      if (status === 429) { breaker.failure(); throw fail("PROVIDER_RATE_LIMITED", `${pp.provider} rate-limited the ${what}`, { retryable: true }); }
      if (status >= 500) { breaker.failure(); throw fail("PROVIDER_ERROR", `${pp.provider} failed with HTTP ${status}`, { retryable: true }); }
      breaker.neutral();
      throw fail("PROVIDER_REJECTED", `${pp.provider} rejected the ${what} (HTTP ${status})`);
    };
    // 1. Upload and start the job.
    const form = multipart([{ name: "file", filename: "document.pdf", type: "application/pdf", value: bytes },
      { name: "configuration", value: JSON.stringify({ tier: pp.tier, version: pp.version, page_ranges: { max_pages: P.maxPages } }) }]);
    let up;
    try { up = await call("POST", "/api/v2/parse/upload", form.body, { "content-type": form.contentType }); } catch (e) { if (e instanceof ProviderError) await settleOrThrow(e); throw e; }
    if (up.status !== 200) await refused(up.status, "upload");
    let jobId = null;
    try { jobId = JSON.parse(up.body.toString("utf8"))?.id ?? null; } catch { /* below */ }
    if (typeof jobId !== "string" || !/^[A-Za-z0-9_-]{1,100}$/.test(jobId)) {
      breaker.failure();
      await store.markBudgetUncertain(res.id, "upload answered without a job id");
      throw fail("PROVIDER_UNCERTAIN", "the provider accepted the upload without naming its job; its credits stay reserved");
    }
    // 2. Poll the job until it ends or the parse deadline passes (an unfinished job may still be charged).
    const until = started + P.jobTimeoutMs;
    let job = null, body = null;
    for (;;) {
      let st;
      try { st = await call("GET", `/api/v2/parse/${jobId}?expand=markdown`, null); } catch (e) {
        if (!(e instanceof ProviderError)) throw e;
        if (Date.now() < until) { await sleep(2000); continue; }
        breaker.failure();
        await store.markBudgetUncertain(res.id, `job ${jobId} unreadable: ${e.code}`);
        throw fail("PROVIDER_UNCERTAIN", `job ${jobId} could not be read before the deadline; its credits stay reserved`);
      }
      if (st.status === 200) {
        try { body = JSON.parse(st.body.toString("utf8")); } catch { body = null; }
        job = body?.job ?? null;
        if (job && ["COMPLETED", "FAILED", "CANCELLED"].includes(job.status)) break;
      } else if (st.status >= 400 && st.status < 500 && st.status !== 404 && st.status !== 429) {
        breaker.failure();
        await store.markBudgetUncertain(res.id, `job ${jobId} status read answered ${st.status}`);
        throw fail("PROVIDER_UNCERTAIN", `job ${jobId}'s status was refused (HTTP ${st.status}); its credits stay reserved`);
      }
      if (Date.now() >= until) {
        breaker.failure();
        await store.markBudgetUncertain(res.id, `job ${jobId} unfinished at the deadline`);
        throw fail("PROVIDER_UNCERTAIN", `job ${jobId} did not finish within ${P.jobTimeoutMs} ms; its credits stay reserved`);
      }
      await sleep(2000);
    }
    const fileId = job.file_id ?? body?.file_id ?? null;
    const removeFile = async () => {
      if (typeof fileId !== "string" || !/^[A-Za-z0-9_-]{1,100}$/.test(fileId)) return "no file id in the job";
      try { const d = await call("DELETE", `/api/v1/files/${fileId}`, null); return `delete answered ${d.status}`; } catch (e) { return `delete failed: ${e.code}`; }
    };
    if (job.status !== "COMPLETED") {
      // A job the provider ended without a result: whether it was charged is not known until reconciled.
      breaker.failure();
      await store.markBudgetUncertain(res.id, `job ${jobId} ended ${job.status}${job.error_message ? `: ${String(job.error_message).slice(0, 200)}` : ""}`);
      log({ event: "parse", logical_id: logicalId, parser: name, outcome: job.status, file: await removeFile(), ms: Date.now() - started });
      throw fail("PARSE_FAILED", `the provider ended the parse ${job.status}; its credits stay reserved until reconciled`);
    }
    breaker.success();
    const pagesOut = Array.isArray(body?.markdown?.pages) ? body.markdown.pages : [];
    const markdown = pagesOut.map((p) => (typeof p.markdown === "string" ? p.markdown : "")).join("\n\n").trim();
    const credits = Math.min(pagesOut.length, pages) * card.creditsPerPage;
    await store.settleBudget(res.id, credits, { usage: { pages: pagesOut.length }, result: { markdown, pages: pagesOut.length }, detail: `job ${jobId}` });
    const fileOutcome = await removeFile();
    log({ event: "parse", logical_id: logicalId, parser: name, outcome: "COMPLETED", reason, pages: pagesOut.length, reserved_credits: amount, credits, file: fileOutcome, ms: Date.now() - started });
    if (!markdown) throw fail("PARSE_EMPTY", `the provider returned no text for ${pagesOut.length} pages`);
    await store.parseCachePut({ key, owner: owner ?? "", bytesSha256: docSha, parser: name, pages: pagesOut.length, markdown, days: P.cacheDays });
    return { ok: true, parser: name, markdown, pages: pagesOut.length, cached: false, credits, file: fileOutcome };
  }
}
