// Asynchronous jobs (FIRECRAWL_PI_SPEC.md §16.2, §21.3): submission, reconciliation, progress,
// archival and retention. All of it runs on one serial chain, so dispatch, reconciliation and
// archival never race each other inside the process; the ledger's guarded transitions and advisory
// lock cover everything else.
//
// Submission. A job is claimed (RECEIVED → SUBMITTING) and posted to the core with the job's
// submission key in `origin`, over a connection of its own:
//   - no connection was ever made → it cannot have arrived: back to RECEIVED, retried later;
//   - 200 with an id → QUEUED, mapped to that upstream id;
//   - a 4xx other than 408/429 → the core refused it before creating anything: FAILED;
//   - anything else (timeout or reset after connecting, 5xx) → SUBMISSION_UNCERTAIN.
// Reconciliation. An uncertain job is looked up by its marker in NuQ's job data: found → mapped to
// the earliest upstream group (any later duplicate is cancelled); not found once the settle window
// has passed → back to RECEIVED, and only then submitted again. Nothing is resubmitted blindly.
// Route holds (M6, src/routing.mjs). The domains of a job that needs the residential route (a bulk job, or one whose
// pages ask for it) are held on that route just before it is submitted. Only the retrieval service's refusal (409,
// the route lost since admission) fails the job as PROXY_REQUIRED unsent; an unreachable service or a 5xx (a restart,
// a database fault) leaves it RECEIVED for the next round, and any other answer is the gateway's own error
// (ROUTE_HOLD_INVALID) (review W5). The hold is released when the job ends or goes back to the queue, so a job
// waiting there, and one cancelled before submission, holds nothing (review S16); it lapses on its own after
// limits.proxy.holdMinutes.
import { randomUUID } from "node:crypto";
import { needsRoute, holdUrls } from "./routing.mjs";

const PATH = { crawl: "/v2/crawl", batch: "/v2/batch/scrape" };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TERMINAL_UPSTREAM = new Set(["completed", "failed", "cancelled"]);
// How long past its deadline an open job may hold the single upstream slot before it is closed.
const STALL_GRACE_MINUTES = 30;

export function makeJobs({ cfg, store, upstream, archive, log, routes = null }) {
  const instance = randomUUID();
  const L = cfg.manifest.limits;
  const deadlineOf = (kind) => (kind === "crawl" ? L.crawl.deadlineMinutes : L.batch.deadlineMinutes);
  let chain = Promise.resolve();
  const serial = (fn) => { const p = chain.then(fn, fn); chain = p.catch(() => {}); return p; };
  const say = (o) => log({ event: "job", instance, ...o });
  // Best effort: a hold not released lapses at its end.
  const release = (job) => { if (routes && needsRoute(job.kind, job.request, cfg.manifest)) routes.release(job.id).catch((e) => say({ job: job.id, action: "route_release_failed", reason: e.code })); };

  async function dispatchOne() {
    const job = await store.claimNext(instance);
    if (!job) return null;
    say({ job: job.id, kind: job.kind, action: "submit", attempt: job.dispatch_attempts });
    if (needsRoute(job.kind, job.request, cfg.manifest)) {
      let h = null;
      try { h = routes ? await routes.hold(job.id, holdUrls(job.kind, job.request), L.proxy.holdMinutes) : null; }
      catch (e) { await store.markRequeued(job.id, `the route hold could not be placed (${e.code}): the retrieval service was not reached`); say({ job: job.id, action: "requeued", reason: `route hold ${e.code}` }); return job.id; }
      if (!routes || (h.status === 409 && h.json?.held === false)) {
        const why = h?.json?.residential?.reason ?? "ROUTE_SERVICE_UNCONFIGURED";
        await store.markRejected(job.id, 429, "PROXY_REQUIRED", `This job needs the residential route from the start, which is unavailable (${why}); it was not sent.`);
        say({ job: job.id, action: "rejected", reason: "PROXY_REQUIRED", route: why });
        return job.id;
      }
      if (h.status >= 500) { await store.markRequeued(job.id, `the route hold was not placed: the retrieval service answered ${h.status}`); say({ job: job.id, action: "requeued", reason: `route hold ${h.status}` }); return job.id; }
      if (h.status !== 200 || h.json?.held !== true) {
        await store.markRejected(job.id, 502, "ROUTE_HOLD_INVALID", `The retrieval service refused the route hold (HTTP ${h.status}); this is the gateway's own error, and the job was not sent.`);
        say({ job: job.id, action: "rejected", reason: "ROUTE_HOLD_INVALID", status: h.status });
        return job.id;
      }
      say({ job: job.id, action: "route_held", until: h.json.until, domains: h.json.domains });
    }
    let r;
    try {
      r = await upstream.call("POST", PATH[job.kind], { body: { ...job.request, origin: job.submission_key }, timeoutMs: cfg.submitTimeoutMs, maxBytes: 1048576 });
    } catch (e) {
      if (!e.delivered) { await store.markRequeued(job.id, `not delivered (${e.code}): the core was never reached`); say({ job: job.id, action: "requeued", reason: e.code }); release(job); return job.id; }
      await store.markUncertain(job.id, `answer lost after connecting (${e.code})`);
      say({ job: job.id, action: "uncertain", reason: e.code });
      await resolveUncertain();
      return job.id;
    }
    if (r.status === 200 && r.json?.success === true && UUID.test(String(r.json.id))) {
      await store.markSubmitted(job.id, r.json.id, deadlineOf(job.kind), "upstream confirmed the submission");
      say({ job: job.id, action: "submitted", upstream: r.json.id });
    } else if (r.status >= 400 && r.status < 500 && r.status !== 408 && r.status !== 429) {
      await store.markRejected(job.id, r.status, String(r.json?.code ?? "UPSTREAM_REJECTED").slice(0, 64), String(r.json?.error ?? `the core answered ${r.status}`).slice(0, 2000));
      say({ job: job.id, action: "rejected", status: r.status });
      release(job);
    } else if (r.status === 408 || r.status === 429) {
      await store.markRequeued(job.id, `the core answered ${r.status} before creating the job`);
      release(job);
    } else {
      await store.markUncertain(job.id, `the core answered ${r.status}`);
      say({ job: job.id, action: "uncertain", reason: `status ${r.status}` });
      await resolveUncertain();
    }
    return job.id;
  }

  // Each job is handled on its own: a failure on one is logged and the round goes on to the others.
  async function resolveUncertain() {
    for (const job of await store.uncertain(cfg.submitSettleMs)) {
      try { await resolveOne(job); } catch (e) { say({ job: job.id, action: "reconcile_failed", error: e.message }); }
    }
  }

  async function resolveOne(job) {
    const groups = await store.markerGroups(job.submission_key);
    if (groups.length) {
      const [keep, ...extra] = groups;
      await store.markSubmitted(job.id, keep.group_id, deadlineOf(job.kind), `reconciled: upstream ${keep.group_id} carries the submission key`);
      say({ job: job.id, action: "reconciled", upstream: keep.group_id, duplicates: extra.length });
      for (const g of extra) {
        const d = await upstream.call("DELETE", `${PATH[job.kind]}/${g.group_id}`, { timeoutMs: 15000 }).catch((e) => ({ status: e.code }));
        say({ job: job.id, action: "duplicate_cancelled", upstream: g.group_id, status: d.status });
      }
    } else if (job.settled) {
      await store.markRequeued(job.id, `no upstream job carries the submission key ${cfg.submitSettleMs} ms after it was sent`);
      say({ job: job.id, action: "requeued_after_settle" });
      release(job);
    }
  }

  // Counts only: a skip past the end returns the status without documents.
  const statusOf = (job) => upstream.call("GET", `${PATH[job.kind]}/${job.upstream_id}?skip=1000000000&limit=1`, { timeoutMs: 15000, maxBytes: 1048576 });

  async function pollRunning() {
    for (const job of await store.running(STALL_GRACE_MINUTES)) {
      try { await pollOne(job); } catch (e) { say({ job: job.id, action: "poll_failed", error: e.message }); }
      if (job.stalled) await closeStalled(job).catch((e) => say({ job: job.id, action: "close_failed", error: e.message }));
    }
  }

  // A job still open STALL_GRACE_MINUTES after its deadline (its archival keeps failing, or the core
  // never ends it) is closed with the documents already archived, so it stops holding the single
  // upstream slot, and the reason is recorded. The move is guarded: a job this round finished stays so.
  async function closeStalled(job) {
    const n = await store.documentCount(job.id);
    const msg = `the job was still open ${STALL_GRACE_MINUTES} minutes after its deadline, because its results could not be archived or the core did not end it; ${n} documents were archived`;
    const entry = { id: `fcpi:${job.id}:ARCHIVE_INCOMPLETE:0`, timestamp: new Date().toISOString(), url: "", code: "ARCHIVE_INCOMPLETE", error: msg };
    const done = await store.finish(job.id, n ? "PARTIAL" : "FAILED", { status: job.upstream_status, completed: job.completed, total: job.total, creditsUsed: job.credits_used,
      errors: { errors: [entry], robotsBlocked: [] }, errorCode: "ARCHIVE_INCOMPLETE", error: msg }, msg);
    if (done) { say({ job: job.id, action: "closed_incomplete", state: done.state, archived: n }); release(job); }
  }

  async function pollOne(job) {
    if (!job.cancel_sent_at && (job.cancel_requested_at || job.overdue)) {
      const d = await upstream.call("DELETE", `${PATH[job.kind]}/${job.upstream_id}`, { timeoutMs: 15000 }).catch((e) => ({ status: e.code }));
      if (d.status === 200 || d.status === 409) { await store.cancelSent(job.id); job.cancel_sent_at = new Date(); }
      say({ job: job.id, action: job.cancel_requested_at ? "cancel_sent" : "deadline_cancel_sent", status: d.status });
    }
    let s;
    try { s = await statusOf(job); } catch (e) { say({ job: job.id, action: "poll_failed", reason: e.code }); return; }
    if (s.status === 404) { await store.failLost(job.id, "UPSTREAM_STATE_LOST", "The core no longer knows this job and it had not finished; its state cannot be reconstructed."); release(job); return; }
    if (s.status !== 200 || !s.json) return;
    const st = { status: s.json.status, completed: s.json.completed ?? 0, total: s.json.total ?? 0, creditsUsed: s.json.creditsUsed ?? null };
    await store.progress(job.id, st);
    if (!TERMINAL_UPSTREAM.has(st.status)) return;
    // A cancelled job keeps finishing the pages already in flight; archive once they have landed.
    if (st.status === "cancelled" && st.completed < st.total && job.cancel_sent_at && Date.now() - new Date(job.cancel_sent_at).getTime() < 60000) return;
    await finalize(job, st, s.json);
  }

  // Archives every document and the per-item errors, then closes the job. Safe to repeat: documents
  // are keyed by upstream scrape id, so a restart mid-archive continues where it stopped.
  async function finalize(job, st, statusBody) {
    const have = await store.archivedKeys(job.id);
    let ordinal = have.size, skip = 0, limit = 10;
    const archiveErrors = [];
    // An entry the gateway adds to the per-item errors, in upstream's shape ({ id, timestamp, url, code,
    // error }); the URL is empty where it is not known (a document too large to read).
    const note = (code, error, url = "") => ({ id: `fcpi:${job.id}:${code}:${archiveErrors.length}`, timestamp: new Date().toISOString(), url, code, error });
    // Storage is checked before every document, not only at admission: archival stops at the result
    // quota or the filesystem's free-space floor, and the job ends with what it holds.
    const quota = await archive.quotaBytes();
    let used = await store.archiveBytes(), full = false;
    pages: for (;;) {
      let r;
      try {
        r = await upstream.call("GET", `${PATH[job.kind]}/${job.upstream_id}?skip=${skip}&limit=${limit}`, { timeoutMs: 60000, maxBytes: L.results.archiveResponseMaxBytes });
      } catch (e) {
        if (e.code === "TOO_LARGE" && limit > 1) { limit = 1; continue; }
        if (e.code === "TOO_LARGE") { archiveErrors.push(note("ARCHIVE_DOCUMENT_TOO_LARGE", `the document at position ${skip} exceeds ${L.results.archiveResponseMaxBytes} bytes and was not retained`)); skip += 1; continue; }
        say({ job: job.id, action: "archive_interrupted", reason: e.code });
        return; // the next poll resumes
      }
      if (r.status === 404) { await store.failLost(job.id, "UPSTREAM_STATE_LOST", "The core forgot this job before its results were archived."); release(job); return; }
      const docs = Array.isArray(r.json?.data) ? r.json.data : null;
      if (r.status !== 200 || !docs) { say({ job: job.id, action: "archive_interrupted", reason: `status ${r.status}` }); return; }
      // Upstream's `next` carries the position after this page: it counts finished pages that have no
      // stored document but leaves them out of `data`, so an empty page is not the end. It also sets
      // `next` on every page of a job that ended other than "completed", so the end is a `next` that is
      // absent or does not move forward (apps/api/src/controllers/v2/crawl-status.ts).
      const nextSkip = r.json.next ? Number(new URL(r.json.next).searchParams.get("skip")) : null;
      if (r.json.next && !Number.isInteger(nextSkip)) { say({ job: job.id, action: "archive_interrupted", reason: "unreadable next" }); return; }
      const rows = [];
      for (const doc of docs) {
        const key = typeof doc?.metadata?.scrapeId === "string" ? doc.metadata.scrapeId : null;
        if (key && have.has(key)) continue;
        const buf = Buffer.from(JSON.stringify(doc));
        if (used + buf.length > quota || !(await archive.hasRoom(buf.length))) {
          full = true;
          archiveErrors.push(note("STORAGE_QUOTA", `archival stopped at the result store's quota or free-space floor; documents from the page at position ${skip} on were not retained`));
          break;
        }
        const put = await archive.put(buf);
        const docKey = key ?? `sha256:${put.sha256}`;
        if (have.has(docKey)) continue;
        have.add(docKey);
        used += put.bytes;
        rows.push({ ordinal: ordinal++, docKey, sha256: put.sha256, bytes: put.bytes });
      }
      await store.addDocuments(job.id, rows);
      if (full || nextSkip === null || nextSkip <= skip) break pages;
      skip = nextSkip;
      limit = 10;
    }
    // The per-item errors are part of the result: a failed fetch is retried on the next poll, never read
    // as "no errors". A core that has forgotten the job by now leaves them unknown, and the job says so.
    let e;
    try { e = await upstream.call("GET", `${PATH[job.kind]}/${job.upstream_id}/errors`, { timeoutMs: 15000, maxBytes: 4 * 1048576 }); }
    catch (err) { say({ job: job.id, action: "archive_interrupted", reason: `errors ${err.code}` }); return; }
    let errors = { errors: [], robotsBlocked: [] };
    if (e.status === 404) archiveErrors.push(note("UPSTREAM_ERRORS_LOST", "the core forgot this job before its per-item errors were archived; they are unknown"));
    else if (e.status !== 200 || !Array.isArray(e.json?.errors)) { say({ job: job.id, action: "archive_interrupted", reason: `errors status ${e.status}` }); return; }
    else {
      // At most 1,000 of each are kept, and a cut is recorded rather than silent.
      const all = e.json.errors, blocked = Array.isArray(e.json.robotsBlocked) ? e.json.robotsBlocked : [];
      errors = { errors: all.slice(0, 1000), robotsBlocked: blocked.slice(0, 1000) };
      if (all.length > 1000 || blocked.length > 1000) {
        archiveErrors.push(note("ERRORS_TRUNCATED", `${Math.max(0, all.length - 1000)} further per-item errors and ${Math.max(0, blocked.length - 1000)} further robots-blocked URLs were not retained`));
      }
    }
    errors.errors.push(...archiveErrors);
    let to = "SUCCEEDED", code = null, message = null;
    if (st.status === "failed") { to = "FAILED"; code = "UPSTREAM_FAILED"; message = String(statusBody?.error ?? "the job failed upstream").slice(0, 2000); }
    else if (st.status === "cancelled" && !job.cancel_requested_at && job.overdue) { to = "FAILED"; code = "JOB_DEADLINE_EXCEEDED"; message = `the job ran past its ${deadlineOf(job.kind)}-minute deadline and was stopped`; }
    else if (st.status === "cancelled") to = "CANCELLED";
    else if (full) { to = have.size ? "PARTIAL" : "FAILED"; code = "STORAGE_QUOTA"; message = `the result store reached its quota or free-space floor after ${have.size} documents; the rest were not retained`; }
    else if (errors.errors.length) to = "PARTIAL";
    await store.finish(job.id, to, { ...st, errors, errorCode: code, error: message }, `upstream ${st.status}; ${have.size} documents archived, ${errors.errors.length} per-item errors`);
    say({ job: job.id, action: "finished", state: to, archived: have.size, errors: errors.errors.length });
    release(job);
  }

  // At the start of every round, SUBMITTING rows become uncertain: no dispatch is in flight between
  // steps of the chain, so their answers were lost (a previous process died, or a ledger write failed
  // after the claim). Reconciliation then finds them by marker before anything is resubmitted.
  async function prepare() {
    const n = await store.orphanSubmitting();
    if (n) say({ action: "orphaned_submissions", count: n });
  }

  async function tick() {
    await prepare();
    await resolveUncertain();
    await pollRunning();
    while (await dispatchOne());
  }

  let timers = [], stopped = false;
  return {
    instance,
    async start() {
      timers.push(setInterval(() => serial(tick).catch((e) => say({ action: "tick_failed", error: e.message })), cfg.pollMs));
      const sweep = () => serial(async () => {
        const r = await store.sweep();
        const files = await archive.sweep((shas) => store.referenced(shas));
        say({ action: "swept", ...r, files });
      }).catch((e) => say({ action: "sweep_failed", error: e.message }));
      timers.push(setInterval(sweep, 600000));
      sweep();
      serial(tick).catch((e) => say({ action: "tick_failed", error: e.message }));
    },
    // Stops every round: no timer fires again and a kick does nothing, so nothing is claimed while the
    // process shuts down (a claim killed mid-POST would leave an uncertain submission). Resolves when
    // the round in progress has finished.
    stop() { stopped = true; for (const t of timers) clearInterval(t); timers = []; return chain; },
    // Runs one reconciliation and dispatch round; resolves when it has finished.
    kick: () => (stopped ? chain : serial(async () => { await prepare(); await resolveUncertain(); await dispatchOne(); })),
    PATH,
  };
}
