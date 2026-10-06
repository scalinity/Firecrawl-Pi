// FCPI access gateway (FIRECRAWL_PI_SPEC.md §16, §19.1, §20.3, §21): the only host-published service
// and the one policy boundary in front of the core.
//   - Host must be one of the origins the gateway is served at (DNS rebinding); a browser Origin must
//     be allow-listed (none is by default); no CORS headers are ever sent.
//   - Every route needs a bearer token from the client registry; 401 for a missing or unknown one
//     (429 once failures pass their per-minute budget), 403 for a missing scope. Upstream challenges,
//     which name Firecrawl Cloud, never pass through.
//   - Routes, options and limits come from the capability manifest; an option it refuses is answered
//     with UNSUPPORTED_OPTION before any work begins; known native routes it does not enable are 501.
//   - Crawls and batch scrapes are durable jobs (src/jobs.mjs): a receipt commits before the answer,
//     every lookup is by the credential's principal, results are archived and served after the core
//     forgets them. Identity headers are never forwarded: the gateway builds each upstream request.
//   - /mcp (M4) passes the same Host, Origin and token checks, then goes to the MCP service (src/mcp.mjs),
//     whose tools call these REST routes back with the same token (spec §7.2, §20.1).
//   - M5: /v2/search is a synchronous route like scrape; the json scrape format and /v2/extract jobs send
//     pages the core scraped to the retrieval service's budgeted model adapter (src/extractor.mjs,
//     src/extract.mjs), whose failures reach the caller typed.
//   - M6: a crawl or batch past the manifest's bulkPages asks for the residential route from the start, is
//     refused as PROXY_REQUIRED when the route cannot be had, and holds its domains on that route for its life
//     (src/routing.mjs).
//   - M7: /v2/scrape serves screenshots and the safe action subset, each capture stored as an owner-bound artifact at
//     /platform/v1/artifacts/{id} (src/artifacts.mjs), and a cache of successful answers per principal and request
//     (maxAge, storeInCache); /platform/v1/changes compares a page with its last version (src/changes.mjs); crawl, batch
//     and extract jobs may name an approved webhook, whose events the outbox delivers (src/outbox.mjs). Every request to
//     the core carries the principal's owner tag in its origin.
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { pipeline } from "node:stream/promises";
import { loadConfig } from "./src/config.mjs";
import { makeRegistry, makeFailureLimiter, originFor } from "./src/auth.mjs";
import { validateBody, requestHash, RequestError } from "./src/validate.mjs";
import { makeStore, AdmissionError, SCHEMA_VERSION } from "./src/store.mjs";
import { openArchive } from "./src/archive.mjs";
import { makeUpstream, sendJson } from "./src/upstream.mjs";
import { makeJobs } from "./src/jobs.mjs";
import { makeMcpProxy } from "./src/mcp.mjs";
import { makeExtractor } from "./src/extractor.mjs";
import { makeExtractJobs } from "./src/extract.mjs";
import { makeJsonScrape } from "./src/jsonscrape.mjs";
import { routeBody, routeRefusal } from "./src/routing.mjs";
import { storeCaptures } from "./src/artifacts.mjs";
import { makeChanges } from "./src/changes.mjs";
import { makeOutbox } from "./src/outbox.mjs";
import { makeAdmission } from "./src/admission.mjs";
import { makeIncidentActions } from "./src/incidents.mjs";
import { jobOutcome } from "./src/outcome.mjs";
import { mapStartUrl, mergeMapLinks } from "./src/maplinks.mjs";

const log = (o) => console.log(JSON.stringify({ utc: new Date().toISOString(), service: "access-gateway", ...o }));
const cfg = loadConfig(process.env);
const M = cfg.manifest, L = M.limits;
const registry = makeRegistry(cfg.clientsFile, M.scopes, log);
const failures = makeFailureLimiter(L.auth.failuresPerMinute);
const archive = await openArchive(cfg.artifactRoot);
const store = makeStore(cfg, log);
const upstream = makeUpstream(cfg);
const extractor = cfg.extractUrl ? makeExtractor({ url: cfg.extractUrl, token: cfg.extractToken }) : null;
const jobs = makeJobs({ cfg, store, upstream, archive, routes: extractor, log: (o) => log({ build: cfg.build, ...o }) });
const extractJobs = extractor ? makeExtractJobs({ cfg, store, upstream, archive, extractor, log: (o) => log({ build: cfg.build, ...o }) }) : null;
// M7: the webhook outbox's delivery round (it needs the retrieval service, which alone may reach a receiver), and changes.
const outbox = extractor ? makeOutbox({ store, extractor, limits: L, log: (o) => log({ build: cfg.build, ...o }) }) : null;
// quotaBytes is defined below; the route reads it at call time.
const changes = makeChanges({ cfg, store, upstream, archive, originFor, quotaBytes: () => quotaBytes() });
const PATH = { ...jobs.PATH, extract: "/v2/extract" };
const started = Date.now();
// M8: the host's admission state (src/admission.mjs), read before any new work is accepted.
const admission = makeAdmission(cfg.admissionFile);
const incidentActions = cfg.incidents ? makeIncidentActions(cfg.incidents) : null;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Exact templates, matched against the raw request path (never decoded or normalised), so an
// encoded or doubled segment simply does not match.
const template = (p) => new RegExp(`^${p.replace(/[.*+?^$()|[\]\\]/g, "\\$&").replace(/\{id\}/g, "([0-9A-Za-z-]{1,64})")}$`);
const ROUTES = M.routes.map((r) => ({ ...r, re: template(r.path) }));
const DISABLED = M.not_enabled.map((r) => ({ ...r, re: template(r.path) }));

let syncInFlight = 0, statusReads = 0, extrasInFlight = 0;
let quota = null;
const quotaBytes = async () => (quota ??= await archive.quotaBytes());

// Reads the body, refusing it past the cap. The remainder is drained (to 8x the cap) rather than
// left unread, because closing a socket with unread input resets it and can destroy the 413.
function readBody(req) {
  const cap = L.bodyBytes;
  return new Promise((resolve, reject) => {
    const tooLarge = () => new RequestError(413, "BODY_TOO_LARGE", `The request body exceeds ${cap} bytes.`);
    const chunks = [];
    let size = 0, over = Number(req.headers["content-length"] ?? 0) > cap;
    req.on("data", (c) => {
      size += c.length;
      if (over) { if (size > 8 * cap) req.destroy(); return; }
      if (size <= cap) return chunks.push(c);
      over = true; chunks.length = 0; reject(tooLarge());
    });
    req.on("end", () => (over ? reject(tooLarge()) : resolve(Buffer.concat(chunks))));
    req.on("error", reject);
    if (over) reject(tooLarge());
  });
}
async function readJson(req) {
  const buf = await readBody(req);
  try { return JSON.parse(buf.toString("utf8")); } catch { throw new RequestError(400, "BAD_REQUEST", "The request body is not valid JSON."); }
}

const withTimeout = (p, ms) => Promise.race([p.catch(() => {}), new Promise((r) => setTimeout(r, ms).unref())]);
const nativeStatus = (s) => ({ SUCCEEDED: "completed", PARTIAL: "completed", FAILED: "failed", CANCELLED: "cancelled" })[s] ?? "scraping";
const iso = (d) => (d ? new Date(d).toISOString() : undefined);

function pageParams(url) {
  const sp = url.searchParams;
  const int = (k, min, max) => {
    if (!sp.has(k)) return null;
    const v = sp.get(k);
    if (!/^\d{1,10}$/.test(v) || Number(v) < min || Number(v) > max) throw new RequestError(400, "BAD_REQUEST", `'${k}' must be an integer from ${min} to ${max}.`);
    return Number(v);
  };
  return { skip: int("skip", 0, 1e9) ?? 0, limit: int("limit", 1, L.results.pageMaxLimit), explicitLimit: sp.has("limit") };
}

// retry: what sending this request again does. "same" for a submission with an idempotency key (it
// returns this job), "new" for one without (it creates a second job), "read" for a read.
const RETRY = {
  same: "Retry this request with the same idempotency key, or read the receipt.",
  new: "Read the receipt: sent again without an idempotency key, this request would create a second job.",
  read: "Retry shortly, or read the receipt.",
};
function uncertain(ctx, job, retry) {
  ctx.send(503, { success: false, code: "SUBMISSION_UNCERTAIN", id: job.id, receipt: `${ctx.origin}/platform/v1/jobs/${job.id}`,
    error: `The job is recorded, but whether the core has accepted it is still being reconciled. ${RETRY[retry]}` }, { "retry-after": "10" });
}

// ---- asynchronous submissions ------------------------------------------------------------------------
function submissionAnswer(ctx, route, job, invalidURLs, keyed) {
  if (job.state === "SUBMITTING" || job.state === "SUBMISSION_UNCERTAIN") return uncertain(ctx, job, keyed ? "same" : "new");
  if (job.state === "FAILED" && job.http_status && !job.upstream_id) return ctx.send(job.http_status, { success: false, code: job.error_code, error: job.error });
  ctx.send(200, { success: true, id: job.id, url: `${ctx.origin}${PATH[route.kind]}/${job.id}`, ...(route.kind === "batch" ? { invalidURLs } : {}),
    ...(route.kind === "extract" ? { urlTrace: [], ...(invalidURLs.length ? { invalidURLs } : {}) } : {}) });
}

const extractionUnavailable = (ctx) => ctx.send(503, { success: false, code: "EXTRACTION_UNAVAILABLE", error: "Extraction is not configured in this deployment (PI_EXTRACT_URL is unset); every other route is unaffected." });
async function submit(ctx, route) {
  if (route.kind === "extract" && !extractor) return extractionUnavailable(ctx);
  const raw = await readJson(ctx.req);
  const v = validateBody(route.body, raw, M);
  const { units, invalidURLs } = v;
  // A job that needs the residential route (bulk, or asking for it) is refused before any receipt when it cannot be had.
  const { body, needsRoute } = routeBody(route.kind, v.body, M);
  const idemKey = ctx.req.headers["x-idempotency-key"];
  if (idemKey !== undefined && !/^[A-Za-z0-9._:-]{8,128}$/.test(idemKey)) throw new RequestError(400, "BAD_REQUEST", "x-idempotency-key must be 8-128 characters of letters, digits and ._:-");
  // Before any refusal that depends on the moment (the residential route, the webhook check): a retry of a job already
  // accepted gets its receipt, and a key reused for another request 409; only a new receipt is refused (review W4, M7
  // review S10). True when it answered.
  const replayed = async () => {
    const prior = idemKey !== undefined ? await store.idempotentJob({ principal: ctx.client.principal, kind: route.kind, idemKey, hash: requestHash(route.kind, body) }) : null;
    if (prior?.conflict) { ctx.send(409, { success: false, code: "IDEMPOTENCY_CONFLICT", error: "This idempotency key was used with a different request in the last 24 hours." }); return true; }
    if (prior?.job) { ctx.job = prior.job.id; await submissionAnswer(ctx, route, prior.job, invalidURLs, true); return true; }
    return false;
  };
  if (needsRoute) {
    const r = extractor ? await extractor.routes().catch(() => null) : null;
    const residential = r?.status === 200 ? r.json?.residential : null;
    if (!residential?.available) {
      if (await replayed()) return;
      const x = routeRefusal(residential);
      log({ event: "route_refused", request_id: ctx.id, kind: route.kind, units, reason: x.body.route.residential });
      return ctx.send(x.status, x.body, x.retryAfter ? { "retry-after": String(x.retryAfter) } : {});
    }
  }
  // M7: a webhook's destination must be one the retrieval service approves (the egress policy's list), checked before
  // any receipt is written; a retry of a job already accepted gets its receipt whatever the list says now.
  if (body.webhook) {
    const c = extractor ? await extractor.webhookCheck(body.webhook.url).catch(() => null) : { status: 200, json: { allowed: false, reason: "NO_DELIVERY_SERVICE" } };
    if (c?.status !== 200 || typeof c.json?.allowed !== "boolean") {
      if (await replayed()) return;
      return ctx.send(503, { success: false, code: "WEBHOOK_CHECK_UNAVAILABLE", error: "Whether the webhook destination is approved could not be checked; nothing was accepted." }, { "retry-after": "10" });
    }
    if (!c.json.allowed) {
      if (await replayed()) return;
      return ctx.send(400, { success: false, code: "UNSUPPORTED_OPTION", option: "webhook.url", error: `The webhook destination is not approved in this deployment (${c.json.reason}); nothing was accepted.` });
    }
  }
  let admitted;
  try {
    admitted = await store.admit({ principal: ctx.client.principal, clientLabel: ctx.client.label, kind: route.kind, body, hash: requestHash(route.kind, body), units, idemKey, quotaBytes: await quotaBytes() });
  } catch (e) {
    if (e instanceof AdmissionError) return ctx.send(e.status, { success: false, code: e.code, error: e.message }, { "retry-after": String(e.retryAfter) });
    log({ event: "ledger_unavailable", request_id: ctx.id, error: e.message });
    // Never 502: a client library retries 502 by resubmitting (upstream apps/js-sdk httpClient.ts).
    return ctx.send(503, { success: false, code: "PLATFORM_UNAVAILABLE", error: "The job ledger is unavailable, so nothing was accepted; retry later." }, { "retry-after": "10" });
  }
  if (admitted.conflict) return ctx.send(409, { success: false, code: "IDEMPOTENCY_CONFLICT", error: "This idempotency key was used with a different request in the last 24 hours." });
  ctx.job = admitted.job.id;
  let job = admitted.job;
  // An extraction runs for minutes: its receipt is the answer, and the runner takes it from there.
  if (route.kind === "extract") { void extractJobs.kick().catch(() => {}); return submissionAnswer(ctx, route, job, invalidURLs, idemKey !== undefined); }
  if (["RECEIVED", "SUBMITTING", "SUBMISSION_UNCERTAIN"].includes(job.state)) {
    await withTimeout(jobs.kick(), cfg.submitTimeoutMs + 10000);
    job = (await store.getJobAny(job.id)) ?? job;
  }
  submissionAnswer(ctx, route, job, invalidURLs, idemKey !== undefined);
}

// ---- job lookups -------------------------------------------------------------------------------------
async function jobFor(ctx, route, id) {
  if (!UUID.test(id)) throw new RequestError(400, "BAD_REQUEST", "Invalid job ID format. Job ID must be a valid UUID.");
  const job = await store.getJob(id.toLowerCase(), ctx.client.principal);
  if (!job || (route.kind && job.kind !== route.kind)) { ctx.send(404, { success: false, error: "Job not found" }); return null; }
  ctx.job = job.id;
  return job;
}
const expired = (ctx, job) => ctx.send(410, { success: false, code: "EXPIRED", error: `This job's results passed their retention on ${iso(job.results_expire_at)}.` });

async function status(ctx, route, id) {
  const job = await jobFor(ctx, route, id);
  if (!job) return;
  const { skip, limit, explicitLimit } = pageParams(ctx.url);
  const self = (s) => `${ctx.origin}${PATH[job.kind]}/${job.id}?skip=${s}${explicitLimit ? `&limit=${limit}` : ""}`;
  const expiresAt = iso(job.results_expire_at) ?? new Date(Date.now() + L.results.retentionDays * 86400000).toISOString();
  if (job.state === "EXPIRED") return expired(ctx, job);
  if (job.state === "SUBMISSION_UNCERTAIN") return uncertain(ctx, job, "read");
  if (job.state === "RECEIVED" || job.state === "SUBMITTING") {
    return ctx.send(200, { success: true, status: "scraping", completed: 0, total: 0, creditsUsed: 0, expiresAt, data: [], createdAt: iso(job.created_at) });
  }
  if (job.state === "QUEUED" || job.state === "RUNNING") {
    // A running job's page is buffered, parsed and served again: at most pageMaxBytes each, and at most
    // maxStatusReadsInFlight at once, so polling clients cannot push the gateway past its memory cap.
    if (statusReads >= L.admission.maxStatusReadsInFlight) {
      return ctx.send(503, { success: false, code: "OVERLOADED", error: `${statusReads} status reads of running jobs are already in flight (limit ${L.admission.maxStatusReadsInFlight}); retry shortly.` }, { "retry-after": "5" });
    }
    statusReads += 1;
    let r;
    try {
      for (const lim of [limit ?? L.results.pageDefaultLimit, 1]) {
        try { r = await upstream.call("GET", `${PATH[job.kind]}/${job.upstream_id}?skip=${skip}&limit=${lim}`, { timeoutMs: 30000, maxBytes: L.results.pageMaxBytes }); break; }
        catch (e) { if (e.code !== "TOO_LARGE") return ctx.send(503, { success: false, code: "UPSTREAM_UNAVAILABLE", error: "The core did not answer; retry." }, { "retry-after": "5" }); r = null; }
      }
    } finally { statusReads -= 1; }
    if (!r) return ctx.send(503, { success: false, code: "RESULT_TOO_LARGE", error: "The next document is larger than a status page may carry; it is served from the archive once the job ends." }, { "retry-after": "30" });
    if (r.status !== 200 || !r.json) return ctx.send(503, { success: false, code: "UPSTREAM_UNAVAILABLE", error: `The core answered ${r.status}; retry.` }, { "retry-after": "5" });
    const b = r.json, data = Array.isArray(b.data) ? b.data : [];
    // `next` only while documents remain past this page, so a client following it never spins on an
    // unfinished job (upstream also sets it for any running job).
    const more = (b.completed ?? 0) > skip + data.length;
    // fcpi.state is the job's own: the core may already say "completed" while the gateway archives the job, and the outcome
    // (its failed pages, by class) is known only once the job is finished, so a caller waits for a finished state.
    return ctx.send(200, { success: b.success !== false, status: b.status, completed: b.completed ?? 0, total: b.total ?? 0, creditsUsed: b.creditsUsed ?? 0, expiresAt,
      ...(more ? { next: self(skip + data.length) } : {}), data, ...(b.createdAt ? { createdAt: b.createdAt } : {}), ...(b.warning ? { warning: b.warning } : {}),
      fcpi: { state: job.state } });
  }
  // Finished: served from the archive, whatever the core still holds.
  const pageLimit = limit ?? L.results.pageDefaultLimit;
  const rows = await store.documentsPage(job.id, skip, pageLimit);
  const page = [];
  let bytes = 0;
  for (const row of rows) { if (page.length && bytes + row.bytes > L.results.pageMaxBytes) break; page.push(row); bytes += row.bytes; }
  const next = skip + page.length < job.archived ? self(skip + page.length) : undefined;
  // Always success true: a finished job's outcome is its status ("failed" with its error). The official
  // client throws on success false and retries it as an unknown error until the job expires
  // (apps/js-sdk/firecrawl/src/v2/utils/errorHandler.ts), even for a job the core refused.
  // fcpi: the job's own outcome (src/outcome.mjs), since "completed" also names a job some of whose pages failed.
  const head = { success: true, status: nativeStatus(job.state), completed: job.archived, total: job.total ?? job.archived, creditsUsed: job.credits_used ?? 0,
    expiresAt, ...(next ? { next } : {}), ...(job.error ? { error: job.error } : {}), createdAt: iso(job.created_at), completedAt: iso(job.finished_at), fcpi: jobOutcome(job) };
  const res = ctx.res;
  res.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "x-request-id": ctx.id });
  // One pipeline for the whole answer (the head, each archived document, the close), so no document
  // adds listeners to the response.
  async function* body() {
    yield `${JSON.stringify(head).slice(0, -1)},"data":[`;
    for (let i = 0; i < page.length; i++) { if (i) yield ","; yield* archive.stream(page[i].sha256); }
    yield "]}";
  }
  try {
    await pipeline(body, res);
    ctx.logged(200);
  } catch (e) {
    log({ event: "archive_read_failed", request_id: ctx.id, job: job.id, error: e.message });
    res.destroy();
    ctx.logged(500);
  }
}

async function errors(ctx, route, id) {
  const job = await jobFor(ctx, route, id);
  if (!job) return;
  if (job.state === "EXPIRED") return expired(ctx, job);
  if (job.state === "SUBMISSION_UNCERTAIN") return uncertain(ctx, job, "read");
  if (job.state === "QUEUED" || job.state === "RUNNING") {
    const r = await upstream.call("GET", `${PATH[job.kind]}/${job.upstream_id}/errors`, { timeoutMs: 15000, maxBytes: 4 * 1048576 }).catch(() => null);
    if (r?.status === 200 && Array.isArray(r.json?.errors)) return ctx.send(200, { errors: r.json.errors, robotsBlocked: r.json.robotsBlocked ?? [] });
    return ctx.send(503, { success: false, code: "UPSTREAM_UNAVAILABLE", error: "The core did not answer; retry." }, { "retry-after": "5" });
  }
  ctx.send(200, job.errors ?? { errors: [], robotsBlocked: [] });
}

async function cancel(ctx, route, id) {
  let job = await jobFor(ctx, route, id);
  if (!job) return;
  const done = () => ctx.send(200, { status: "cancelled" });
  if (job.state === "EXPIRED") return expired(ctx, job);
  if (job.state === "CANCELLED") return done();
  if (["SUCCEEDED", "PARTIAL", "FAILED"].includes(job.state)) return ctx.send(409, { success: false, error: "Crawl is already completed" });
  job = await store.requestCancel(job.id);
  if (job.state === "RECEIVED" && (await store.cancelUnsubmitted(job.id))) return done();
  if (job.state === "QUEUED" || job.state === "RUNNING") {
    const d = await upstream.call("DELETE", `${PATH[job.kind]}/${job.upstream_id}`, { timeoutMs: 15000 }).catch(() => null);
    if (d?.status === 409) return ctx.send(409, { success: false, error: "Crawl is already completed" });
    if (d?.status === 200) await store.cancelSent(job.id);
  }
  // The intent is durable: the dispatcher never submits a cancelled job, and the poller sends the
  // upstream cancellation once the job is mapped (or again, if this attempt failed).
  done();
}

// ---- extraction status (M5) ---------------------------------------------------------------------------
// Upstream's extract status shape (status processing | completed | failed | cancelled, data, sources,
// expiresAt), served from the ledger and the archived result, with the platform's own detail under fcpi:
// the model, the units and their failures, the pages that could not be scraped, and the usage.
async function extractStatus(ctx, route, id) {
  const job = await jobFor(ctx, route, id);
  if (!job) return;
  if (job.state === "EXPIRED") return expired(ctx, job);
  const expiresAt = iso(job.results_expire_at) ?? new Date(Date.now() + L.results.retentionDays * 86400000).toISOString();
  if (job.state === "RECEIVED" || job.state === "RUNNING") return ctx.send(200, { success: true, status: "processing", data: null, expiresAt, createdAt: iso(job.created_at) });
  const row = (await store.documentKeys(job.id)).find((r) => r.doc_key === "result");
  const result = row ? JSON.parse((await archive.read(row.sha256)).toString("utf8")) : {};
  const pageFailures = job.errors?.errors ?? [];
  const warnings = [...(result.warnings ?? []), ...pageFailures.map((e) => `${e.url}: ${e.code}: ${e.error}`)];
  const tokens = result.usage ? result.usage.promptTokens + result.usage.completionTokens : undefined;
  ctx.send(200, { success: true, status: { SUCCEEDED: "completed", PARTIAL: "completed", FAILED: "failed", CANCELLED: "cancelled" }[job.state], data: result.data ?? null,
    sources: result.sources ?? {}, expiresAt, ...(job.error ? { error: job.error } : {}), ...(warnings.length ? { warning: warnings.join("; ").slice(0, 8000) } : {}),
    ...(tokens !== undefined ? { tokensUsed: tokens } : {}), createdAt: iso(job.created_at), completedAt: iso(job.finished_at),
    fcpi: { state: job.state, errorCode: job.error_code ?? null, model: result.model ?? null, missingRequired: result.missingRequired ?? [], units: result.units ?? [], usage: result.usage ?? null, pageFailures } });
}

// ---- platform routes --------------------------------------------------------------------------------
const receipt = (ctx, job, events, hooks) => ({
  id: job.id, kind: job.kind, state: job.state, createdAt: iso(job.created_at), updatedAt: iso(job.updated_at), submittedAt: iso(job.submitted_at),
  finishedAt: iso(job.finished_at), deadline: iso(job.deadline), resultsExpireAt: iso(job.results_expire_at), metadataExpireAt: iso(job.metadata_expire_at),
  submissionKey: job.submission_key, upstreamId: job.upstream_id, units: job.units, dispatchAttempts: job.dispatch_attempts,
  cancelRequestedAt: iso(job.cancel_requested_at), upstreamStatus: job.upstream_status, completed: job.completed, total: job.total, archived: job.archived,
  errorCount: job.errors?.errors?.length ?? 0, error: job.error ? { code: job.error_code, message: job.error, httpStatus: job.http_status } : null,
  results: `${ctx.origin}${PATH[job.kind]}/${job.id}`, ...(events ? { events: events.map((e) => ({ at: iso(e.at), from: e.from_state, to: e.to_state, detail: e.detail })) } : {}),
  // M7: the job's webhook events and their delivery, a DEAD one among them with its last status and error (the dead letter).
  ...(hooks ? { webhooks: hooks.map((h) => ({ eventId: h.id, type: h.type, state: h.state, attempts: h.attempts, lastStatus: h.last_status, lastError: h.last_error,
    createdAt: iso(h.created_at), deliveredAt: iso(h.delivered_at) })) } : {}),
});

async function platformJob(ctx, route, id) {
  const job = await jobFor(ctx, route, id);
  if (job) ctx.send(200, { success: true, job: receipt(ctx, job, await store.events(job.id), job.request?.webhook ? await store.jobWebhooks(job.id) : null) });
}
async function platformJobs(ctx) {
  const sp = ctx.url.searchParams;
  const limit = sp.has("limit") ? Number(sp.get("limit")) : 20;
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new RequestError(400, "BAD_REQUEST", "'limit' must be an integer from 1 to 100.");
  ctx.send(200, { success: true, jobs: (await store.listJobs(ctx.client.principal, limit)).map((j) => receipt(ctx, j)) });
}
async function platformStatus(ctx) {
  const t0 = Date.now();
  const core = await upstream.call("GET", "/v0/health/liveness", { timeoutMs: 3000, maxBytes: 65536 }).then((r) => ({ live: r.status === 200, ms: Date.now() - t0 }), () => ({ live: false, ms: Date.now() - t0 }));
  let ledger = { ok: false }, summary = null;
  try { summary = await store.summary(); ledger = { ok: true }; } catch (e) { ledger = { ok: false, error: e.message }; }
  // The providers (M5), from the retrieval service: each one's credential present or not, its breaker, the
  // host's selection and the budgets, never a secret. Unreachable, it says so; REST is not affected.
  const providers = extractor ? await extractor.providers().then((r) => (r.status === 200 ? r.json : { error: `HTTP ${r.status}` }), (e) => ({ error: e.code })) : null;
  ctx.send(200, { success: true, service: "access-gateway", build: cfg.build, instance: jobs.instance, uptimeSeconds: Math.round((Date.now() - started) / 1000),
    core, ledger, providers, admission: await admission.read(), jobs: summary?.states ?? null, archive: { bytes: summary?.archiveBytes ?? null, quotaBytes: await quotaBytes() },
    capabilities: { routes: M.routes.map((r) => `${r.method} ${r.path}`), notEnabled: M.not_enabled.map((r) => `${r.method} ${r.path}`), formats: M.formats.allowed },
    limits: L });
}

// ---- synchronous routes -----------------------------------------------------------------------------
const overloaded = (ctx) => ctx.send(503, { success: false, code: "OVERLOADED", error: `${syncInFlight} synchronous requests are already in flight (limit ${L.admission.maxSyncInFlight}); retry shortly.` }, { "retry-after": "5" });
// What the core is sent for a synchronous route: the body without the gateway's own cache options, and the principal's
// owner tag in its origin (M7).
function coreBody(ctx, route, body) {
  const { maxAge: _a, storeInCache: _s, ...rest } = body;
  return { ...rest, origin: originFor(ctx.client.principal, route.id) };
}
async function sync(ctx, route) {
  const raw = await readJson(ctx.req);
  const { body } = validateBody(route.body, raw, M);
  // M5: a scrape asking for the json format is scraped, then extracted (below).
  const json = route.id === "scrape" ? (body.formats ?? []).find((f) => typeof f === "object" && f.type === "json") : null;
  if (json) return extractor ? scrapeWithJson(ctx, coreBody(ctx, route, body), json) : extractionUnavailable(ctx);
  // Search that scrapes its results acquires those pages: a token needs the 'scrape' scope for it (review W7).
  if (route.id === "search" && body.scrapeOptions && !ctx.client.scopes.has("scrape")) return ctx.send(403, { success: false, code: "INSUFFICIENT_SCOPE", error: "Scraping search results needs the 'scrape' scope." });
  // M7: a scrape with a screenshot or actions returns captures, stored as artifacts before the answer leaves (below).
  const extras = route.id === "scrape" && ((body.formats ?? []).some((f) => (typeof f === "object" ? f.type : f) === "screenshot") || (body.actions ?? []).length > 0);
  if (extras) return scrapeWithExtras(ctx, route, body);
  if (route.id === "map") return mapWithPageLinks(ctx, route, body);
  if (syncInFlight >= L.admission.maxSyncInFlight) return overloaded(ctx);
  if (route.id === "scrape") return cachedScrape(ctx, route, body);
  syncInFlight += 1;
  upstream.forward(ctx.res, route.path, coreBody(ctx, route, body), (status) => { syncInFlight -= 1; ctx.logged(status); }, { "x-request-id": ctx.id });
}

// Map (src/maplinks.mjs): the core's map, which reads the site's sitemap, and the links the start page carries, fetched
// together; a caller asking for the sitemap alone gets only the core's answer. The start page is fetched like a scrape
// (an ordinary paced acquisition on the auto route, which may take the residential route when the home connection is
// blocked), so it needs the 'scrape' scope, as search's page acquisition does, and it keeps the map's timeout; without
// the scope the map answers from the sitemap alone (review R6). A client that leaves cancels both core requests, a core
// map that fails ends the page fetch at once, and the core's Retry-After is passed on (review R7). The answer says how
// many links each source gave, and why the page gave none when it did not.
const MAP_PAGE_NOTE = "No sitemap listed links here; these are the links the start page carries. A crawl discovers the pages beyond them.";
async function mapWithPageLinks(ctx, route, body) {
  if (syncInFlight >= L.admission.maxSyncInFlight) return overloaded(ctx);
  syncInFlight += 1;
  const ac = new AbortController();
  const left = () => { if (!ctx.res.writableEnded) ac.abort(); };
  ctx.res.on("close", left);
  try {
    const start = mapStartUrl(body.url);
    const wantsPage = body.sitemap !== "only", mayFetch = wantsPage && ctx.client.scopes.has("scrape");
    const page = !mayFetch ? null : upstream.call("POST", "/v2/scrape", {
      body: coreBody(ctx, route, { url: body.url, formats: ["links"], onlyMainContent: false, ...(body.timeout ? { timeout: body.timeout } : {}) }),
      timeoutMs: cfg.coreTimeoutMs, maxBytes: 8 * 1048576, signal: ac.signal }).then((r) => r, (e) => ({ error: e.code ?? "UPSTREAM_UNAVAILABLE" }));
    let r;
    try { r = await upstream.call("POST", route.path, { body: coreBody(ctx, route, { ...body, url: start }), timeoutMs: cfg.coreTimeoutMs, maxBytes: 8 * 1048576, signal: ac.signal }); }
    catch (e) {
      ac.abort();
      if (e.code === "CANCELLED") return ctx.logged(499);
      const timedOut = e.code === "TIMEOUT";
      return ctx.send(timedOut ? 504 : 503, { success: false, code: timedOut ? "UPSTREAM_TIMEOUT" : "UPSTREAM_UNAVAILABLE", error: timedOut ? "The core did not answer in time." : "The core did not answer." });
    }
    if (r.status !== 200 || r.json?.success !== true) {
      ac.abort();
      const retryAfter = r.headers?.["retry-after"];
      return ctx.send(r.status === 200 ? 503 : r.status, r.json ?? { success: false, code: "UPSTREAM_ERROR", error: `The core answered ${r.status}.` }, retryAfter ? { "retry-after": String(retryAfter) } : {});
    }
    const core = Array.isArray(r.json.links) ? r.json.links : [];
    if (!wantsPage) return ctx.send(200, { ...r.json, fcpi: { sources: { sitemap: core.length } } });
    const p = page ? await page : { error: "SCRAPE_SCOPE_REQUIRED" };
    if (p.error === "CANCELLED") return ctx.logged(499);
    const ok = p.status === 200 && p.json?.success === true;
    const merged = mergeMapLinks(body, core, ok && Array.isArray(p.json.data?.links) ? p.json.data.links : [], M.bodies.map.fields.limit.default);
    const { warning, ...rest } = r.json;
    const fcpi = { sources: { sitemap: core.length, page: merged.added },
      ...(ok ? {} : { pageError: p.error ?? p.json?.code ?? `HTTP ${p.status}` }),
      ...(core.length === 0 && merged.added > 0 ? { note: MAP_PAGE_NOTE } : {}) };
    ctx.extra = { map: fcpi.sources };
    // The core's "only N results" warning spoke of its own links; it stands only if the merged answer is that short too.
    return ctx.send(200, { ...rest, links: merged.links, ...(warning && merged.links.length <= 1 ? { warning } : {}), fcpi });
  } finally { syncInFlight -= 1; ctx.res.off("close", left); }
}

// M7: the scrape cache (spec §21.3, AC21). A cached answer is served only to the principal that stored it, only for the
// same request (its hash without the cache options), and only when younger than the maxAge the caller gives (0, the
// default, never reads). A successful answer whose page answered 2xx is stored for limits.cache.lifetimeSeconds when the
// caller asks for the cache (storeInCache true, or a maxAge, unless storeInCache is false): a plain scrape writes nothing
// to the Pi's storage that nothing would read (review S3). An error page, a failure or an answer past the archive's size
// is never stored. A hit reaches
// neither the core nor any provider, so it costs no attempt and no money. The answer is stored already marked as the hit
// it will be (metadata.cacheState "hit", cachedAt), so a hit sends the stored bytes as they are, one buffer, within the
// synchronous admission limit (review W9).
const CACHE_MARK = Buffer.from('"cacheState":"hit"');
async function cachedScrape(ctx, route, body) {
  const principal = ctx.client.principal, maxAge = body.maxAge ?? 0;
  const { maxAge: _a, storeInCache: _s, ...request } = body;
  const key = requestHash("scrape", request);
  syncInFlight += 1;
  if (maxAge > 0) {
    let buf = null, hit = null;
    try {
      hit = await store.cacheGet(principal, key, maxAge);
      buf = hit ? await archive.read(hit.sha256).catch(() => null) : null;
    } catch (e) { syncInFlight -= 1; throw e; }
    if (buf?.includes(CACHE_MARK)) {
      ctx.extra = { cache: "hit" };
      ctx.res.writeHead(200, { "content-type": "application/json; charset=utf-8", "content-length": buf.length, "cache-control": "no-store", "x-request-id": ctx.id,
        "x-fcpi-cache": "hit", "x-fcpi-cached-at": iso(hit.created_at) });
      ctx.res.end(buf);
      syncInFlight -= 1;
      return ctx.logged(200);
    }
  }
  ctx.extra = { cache: "miss" };
  const keep = !(body.storeInCache === true || (maxAge > 0 && body.storeInCache !== false)) ? null : { maxBytes: L.results.archiveResponseMaxBytes, onComplete: async (status, buf) => {
    if (status !== 200 || !buf) return;
    let j = null;
    try { j = JSON.parse(buf.toString("utf8")); } catch { return; }
    const code = j?.data?.metadata?.statusCode;
    if (j?.success !== true || !(code >= 200 && code < 300) || !j.data?.metadata) return;
    Object.assign(j.data.metadata, { cacheState: "hit", cachedAt: new Date().toISOString() });
    const marked = Buffer.from(JSON.stringify(j));
    j = null;
    if ((await store.archiveBytes()) + marked.length > (await quotaBytes()) || !(await archive.hasRoom(marked.length))) return;
    const put = await archive.put(marked);
    await store.cachePut(principal, key, put.sha256, put.bytes, L.cache.lifetimeSeconds);
    log({ event: "cache_stored", request_id: ctx.id, principal, bytes: put.bytes });
  } };
  upstream.forward(ctx.res, route.path, coreBody(ctx, route, request), (status) => { syncInFlight -= 1; ctx.logged(status); }, { "x-request-id": ctx.id, "x-fcpi-cache": "miss" }, keep);
}

// The core's advice to use its /interact endpoint, sentence by sentence, with the sentence that introduces it.
function withoutInteractAdvice(warning) {
  return warning.split(/(?<=[.!?])\s+/).filter((x) => !/\/interact\b/i.test(x) && !/^You're using the actions parameter\.$/i.test(x.trim())).join(" ").trim();
}

// M7: a scrape with a screenshot or actions (spec §12). Its answer carries the captures, so it is buffered (at most
// limits.extras.responseMaxBytes: the worker's 8 MiB of captures as base64 and the page, limits.extras.inFlight at a
// time, within the gateway's memory; measured with the incompressible fixture, review W10) and every capture is
// stored as an artifact of the caller's principal before the answer leaves; it is never cached.
async function scrapeWithExtras(ctx, route, body) {
  if (extrasInFlight >= L.extras.inFlight || syncInFlight >= L.admission.maxSyncInFlight) return overloaded(ctx);
  extrasInFlight += 1; syncInFlight += 1;
  try {
    let r;
    try { r = await upstream.call("POST", route.path, { body: coreBody(ctx, route, body), timeoutMs: cfg.coreTimeoutMs, maxBytes: L.extras.responseMaxBytes }); }
    catch (e) {
      // Never 502 for the gateway's own failure: a client library retries 502 by resubmitting.
      // An answer past the bound will be past it again: 422, not a status that invites the same scrape once more.
      const code = e.code === "TIMEOUT" ? "UPSTREAM_TIMEOUT" : e.code === "TOO_LARGE" ? "RESULT_TOO_LARGE" : "UPSTREAM_UNAVAILABLE";
      return ctx.send(e.code === "TIMEOUT" ? 504 : e.code === "TOO_LARGE" ? 422 : 503, { success: false, code, error: code === "RESULT_TOO_LARGE" ? `The answer with its captures exceeds ${L.extras.responseMaxBytes} bytes.` : "The core did not answer." });
    }
    if (r.status !== 200 || r.json?.success !== true || !r.json?.data) return ctx.send(r.status === 200 ? 503 : r.status, r.json ?? { success: false, code: "UPSTREAM_ERROR", error: `The core answered ${r.status}.` });
    let artifacts;
    try { artifacts = await storeCaptures(r.json.data, { principal: ctx.client.principal, origin: ctx.origin, archive, store, quotaBytes: await quotaBytes() }); }
    catch (e) {
      if (e.code === "STORAGE_QUOTA") return ctx.send(503, { success: false, code: "STORAGE_QUOTA", error: "The result store is at its quota; the captures were not kept." }, { "retry-after": "300" });
      if (!e.code) throw e;
      return ctx.send(500, { success: false, code: e.code, error: `The gateway could not store a capture: ${e.message}.` });
    }
    ctx.extra = { artifacts: artifacts.length };
    // The core advises its /interact endpoint for actions; this deployment does not serve it (the manifest's not_enabled).
    // Only that advice is removed: any other warning in the same string stands (review R12).
    if (typeof r.json.data.warning === "string") {
      const kept = withoutInteractAdvice(r.json.data.warning);
      if (kept) r.json.data.warning = kept; else delete r.json.data.warning;
    }
    ctx.send(200, { ...r.json, fcpi: { ...(r.json.fcpi ?? {}), artifacts } });
  } finally { extrasInFlight -= 1; syncInFlight -= 1; }
}

// M7: a stored capture, to its principal only; another principal's answers as an unknown one does (spec §16.1).
async function artifact(ctx, route, id) {
  if (!UUID.test(id)) throw new RequestError(400, "BAD_REQUEST", "Invalid artifact ID format. It must be a valid UUID.");
  const a = await store.getArtifact(id.toLowerCase(), ctx.client.principal);
  if (!a) return ctx.send(404, { success: false, code: "NOT_FOUND", error: "Artifact not found" });
  if (a.expired) return ctx.send(410, { success: false, code: "EXPIRED", error: `This artifact passed its retention on ${iso(a.expires_at)}.` });
  const buf = await archive.read(a.sha256);
  ctx.res.writeHead(200, { "content-type": a.mime, "content-length": buf.length, "cache-control": "private, no-store", "x-content-type-options": "nosniff", "x-request-id": ctx.id,
    "x-fcpi-width": String(a.width), "x-fcpi-height": String(a.height), "x-fcpi-truncated": String(a.truncated), "x-fcpi-expires-at": iso(a.expires_at) });
  ctx.res.end(buf);
  ctx.logged(200);
}

// M7: change detection (src/changes.mjs), inside the synchronous admission limit.
async function platformChanges(ctx, route) {
  const raw = await readJson(ctx.req);
  const { body } = validateBody(route.body, raw, M);
  if (syncInFlight >= L.admission.maxSyncInFlight) return overloaded(ctx);
  syncInFlight += 1;
  try { await changes(ctx, body); } finally { syncInFlight -= 1; }
}

// The json format (src/jsonscrape.mjs), inside the synchronous admission limit.
const jsonScrape = extractor ? makeJsonScrape({ cfg, M, upstream, extractor }) : null;
async function scrapeWithJson(ctx, body, json) {
  if (syncInFlight >= L.admission.maxSyncInFlight) return overloaded(ctx);
  syncInFlight += 1;
  try { await jsonScrape(ctx, body, json); } finally { syncInFlight -= 1; }
}

// ---- the MCP route (src/mcp.mjs), served only when the MCP service's address is configured ------------
const mcp = cfg.mcpUrl ? makeMcpProxy({ url: cfg.mcpUrl, limits: M.mcp.limits, readBody, send: (ctx, status, body, extra) => ctx.send(status, body, extra) }) : null;

const HANDLERS = { scrape: sync, map: sync, search: sync, "extract.submit": submit, "extract.status": extractStatus, "crawl.submit": submit, "batch.submit": submit, "crawl.status": status, "batch.status": status, "crawl.errors": errors,
  "batch.errors": errors, "crawl.cancel": cancel, "batch.cancel": cancel, "platform.status": platformStatus, "platform.jobs": platformJobs, "platform.job": platformJob,
  "platform.artifact": artifact, "platform.changes": platformChanges };

// ---- the server -------------------------------------------------------------------------------------
const server = createServer({ maxHeaderSize: 16384 }, async (req, res) => {
  const t0 = process.hrtime.bigint();
  const rawPath = (req.url ?? "").split("?")[0];
  const ctx = { id: randomUUID(), req, res, route: null, client: null, job: null, done: false };
  ctx.logged = (status, code) => {
    if (ctx.done) return;
    ctx.done = true;
    log({ build: cfg.build, request_id: ctx.id, method: req.method, route: ctx.route ?? "unmatched", status, code: code ?? null, client: ctx.client?.label ?? null,
      principal: ctx.client?.principal ?? null, job: ctx.job, ms: Number(process.hrtime.bigint() - t0) / 1e6, ...ctx.extra });
  };
  ctx.send = (status, body, extra = {}) => { sendJson(res, status, body, { "x-request-id": ctx.id, ...extra }); ctx.logged(status, body?.code); };
  try {
    const host = String(req.headers.host ?? "").toLowerCase();
    ctx.origin = cfg.hosts.get(host);
    if (!ctx.origin) return ctx.send(421, { success: false, code: "MISDIRECTED", error: "This host name is not served here." });
    if (req.headers.origin !== undefined && !cfg.browserOrigins.has(req.headers.origin)) return ctx.send(403, { success: false, code: "ORIGIN_NOT_ALLOWED", error: "Browser origins are not allowed." });
    ctx.url = new URL(req.url.startsWith("/") ? req.url : "/", ctx.origin);
    const action = /^\/platform\/v1\/incidents\/action\/([0-9a-f]{32})$/.exec(rawPath);
    if (action && incidentActions) {
      ctx.route = "platform.incident.action";
      // Signed, one-use grant authentication replaces bearer authentication only
      // on this exact path. Host/Origin checks still precede every action.
      // A view-only grant may be opened by a phone browser. Consequential actions
      // accept only a header signature on POST; no query can approve a deployment.
      const view = req.method === "GET" && [...ctx.url.searchParams.keys()].join() === "proof";
      if (ctx.url.search && !view) return ctx.send(400, { success: false, code: "NO_ACTION_QUERY" });
      const r = await incidentActions.consume(action[1], view ? ctx.url.searchParams.get("proof") : req.headers["x-fcpi-approval"], { method: req.method, bodyBytes: (await readBody(req)).length, ownerLogin: req.headers["tailscale-user-login"] });
      if (r.status === 401) {
        const wait = failures.fail();
        if (wait) return ctx.send(429, { success: false, code: "TOO_MANY_FAILED_ATTEMPTS" }, { "retry-after": String(wait) });
      }
      return ctx.send(r.status, r.body, { "cache-control": "no-store" });
    }
    ctx.client = registry.authenticate(req.headers.authorization);
    if (!ctx.client) {
      const wait = failures.fail();
      if (wait) return ctx.send(429, { success: false, code: "TOO_MANY_FAILED_ATTEMPTS", error: "Too many failed authentication attempts; retry later." }, { "retry-after": String(wait) });
      return ctx.send(401, { success: false, code: "UNAUTHORIZED", error: "Unauthorized: a valid gateway token is required." }, { "www-authenticate": 'Bearer realm="fcpi"' });
    }
    // /mcp: every check above has passed; the MCP service authorizes nothing itself (src/mcp.mjs).
    if (mcp && rawPath === M.mcp.path) { ctx.route = "mcp"; return await mcp.handle(ctx); }
    // Routes not enabled are matched first: upstream registers /v2/crawl/ongoing before /v2/crawl/:jobId.
    const off = DISABLED.find((r) => r.method === req.method && r.re.test(rawPath));
    if (off) return ctx.send(501, { success: false, code: "CAPABILITY_NOT_ENABLED", error: `${off.method} ${off.path} is not enabled in this deployment: ${off.reason}.` });
    let m = null;
    const route = ROUTES.find((r) => r.method === req.method && (m = r.re.exec(rawPath)));
    if (!route) return ctx.send(404, { success: false, code: "NOT_FOUND", error: "No such route." });
    ctx.route = route.id;
    if (!ctx.client.scopes.has(route.scope)) return ctx.send(403, { success: false, code: "INSUFFICIENT_SCOPE", error: `This token lacks the '${route.scope}' scope.` });
    // M8: new work (a synchronous route or a job submission) waits while the host holds dispatch (spec §23.1); 503, never 502,
    // which a client library would resubmit at once.
    if (route.mode === "sync" || route.mode === "async") {
      const a = await admission.read();
      if (a.dispatch === "paused") return ctx.send(503, { success: false, code: "HOST_PRESSURE", error: `The host has paused new work (${a.reasons.join(", ") || "pressure"}); nothing was accepted. Retry later.` }, { "retry-after": "60" });
    }
    await HANDLERS[route.id](ctx, route, m[1]);
  } catch (e) {
    if (e instanceof RequestError) {
      if (!res.headersSent) return ctx.send(e.status, { success: false, code: e.code, error: e.message, ...e.extra }, e.status === 413 ? { connection: "close" } : {});
    } else {
      log({ event: "handler_error", request_id: ctx.id, route: ctx.route, error: e.message });
      if (!res.headersSent) return ctx.send(503, { success: false, code: "PLATFORM_UNAVAILABLE", error: "The gateway could not complete the request; retry later." }, { "retry-after": "10" });
    }
    if (!ctx.done) { res.destroy(); ctx.logged(500); }
  }
});
// The ledger's schema must be the one this build is written for (M3's rollback rule): any other stops
// the process before it serves anything, and so does a ledger without the version table or the right
// to read it (SQL errors, class 42). A ledger that cannot be reached yet is not a mismatch; startup
// waits for it.
for (;;) {
  try {
    const v = await store.schemaVersion();
    if (v === SCHEMA_VERSION) break;
    console.error(`access-gateway: the ledger's schema version is ${v}, this build needs ${SCHEMA_VERSION}; refusing to start`);
    process.exit(1);
  } catch (e) {
    if (String(e.code ?? "").startsWith("42")) { console.error(`access-gateway: the ledger's schema version cannot be read (${e.message}); refusing to start`); process.exit(1); }
    log({ event: "ledger_unreachable_at_start", error: e.message });
    await new Promise((r) => setTimeout(r, 5000));
  }
}

server.headersTimeout = 10000;
server.requestTimeout = Math.max(cfg.coreTimeoutMs, cfg.submitTimeoutMs) + 15000;
server.listen(cfg.port, "0.0.0.0", () => {
  log({ event: "listening", build: cfg.build, instance: jobs.instance, port: server.address().port, clients: registry.size, hosts: [...cfg.hosts.values()], routes: ROUTES.length });
  jobs.start().catch((e) => log({ event: "jobs_start_failed", error: e.message }));
  extractJobs?.start();
  outbox?.start();
});
// Shutdown: job rounds stop at once, then open requests finish (Docker allows 20 s), then the pool closes.
for (const sig of ["SIGTERM", "SIGINT"]) process.on(sig, () => {
  jobs.stop();
  extractJobs?.stop();
  outbox?.stop();
  server.close(async () => { await jobs.stop(); await extractJobs?.stop(); await outbox?.stop(); await store.close().catch(() => {}); process.exit(0); });
});
