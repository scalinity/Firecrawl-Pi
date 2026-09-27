// The platform ledger in PostgreSQL (deploy/nuq-postgres/fcpi-platform-schema.sql). Every state change
// is one guarded UPDATE (… WHERE state = ANY(expected)) with its event row in the same transaction,
// so a transition happens once whatever races it. Admission and dispatch take one advisory lock, so
// the open-job caps and the single active upstream job (spec §23.1) hold across concurrent requests.
import pg from "pg";
import { randomUUID } from "node:crypto";

// M7: the webhook events a job's transitions raise (spec §31.3), under upstream's names for each kind. A cancelled job
// raises none: its client cancelled it. Each (job, type) is raised once, whatever repeats the transition.
const EVENT_OF = { QUEUED: "started", RUNNING: "started", SUCCEEDED: "completed", PARTIAL: "completed", FAILED: "failed" };
const EVENT_PREFIX = { crawl: "crawl", batch: "batch_scrape", extract: "extract" };
export const WEBHOOK_EVENTS = ["started", "completed", "failed"];
// Every table that names files in the archive, so its sweep keeps them and the result quota counts them.
const CONTENT_TABLES = ["job_document", "artifact", "page_cache", "page_version"];
const STORED_BYTES = `SELECT (${CONTENT_TABLES.map((t) => `(SELECT coalesce(sum(bytes), 0) FROM fcpi_platform.${t})`).join(" + ")})::bigint AS b`;

export const OPEN = ["RECEIVED", "SUBMITTING", "SUBMISSION_UNCERTAIN", "QUEUED", "RUNNING"];
export const UPSTREAM_ACTIVE = ["SUBMITTING", "SUBMISSION_UNCERTAIN", "QUEUED", "RUNNING"];
export const FINISHED = ["SUCCEEDED", "PARTIAL", "FAILED", "CANCELLED"];
// The ledger schema this code is written for (fcpi_platform.schema_version).
export const SCHEMA_VERSION = 3;
const LOCK = "hashtext('fcpi.platform.admission')";
// Columns a transition may set; the names are code constants, never client input.
const SETTABLE = new Set(["upstream_id", "submitter", "dispatch_attempts", "next_dispatch_at", "submit_started_at", "submitted_at", "deadline",
  "cancel_sent_at", "finished_at", "results_expire_at", "upstream_status", "completed", "total", "credits_used", "errors", "error_code", "error", "http_status"]);

// An SQL expression for a transition field, told apart from a JSON value by a symbol no value carries.
// Each $? in it takes the next of its params as a query parameter, so no value is written into SQL.
const SQL = Symbol("sql");
const sql = (text, params = []) => ({ [SQL]: text, params });

export class AdmissionError extends Error {
  constructor(status, code, message, retryAfter) { super(message); this.status = status; this.code = code; this.retryAfter = retryAfter; }
}

export function makeStore(cfg, log = () => {}) {
  const pool = new pg.Pool({ ...cfg.db, max: 4, connectionTimeoutMillis: 5000, idleTimeoutMillis: 30000, statement_timeout: 15000, application_name: "fcpi-access-gateway" });
  // An idle connection's error (a PostgreSQL restart) must not end the process.
  pool.on("error", (e) => log({ event: "db_idle_error", error: e.message }));
  const L = cfg.manifest.limits;
  const q = (text, values) => pool.query(text, values);

  async function tx(fn) {
    const c = await pool.connect();
    try {
      await c.query("BEGIN");
      const r = await fn(c);
      await c.query("COMMIT");
      return r;
    } catch (e) {
      await c.query("ROLLBACK").catch(() => {});
      throw e;
    } finally { c.release(); }
  }

  // Moves a job from one of `from` to `to`, setting `fields` (SQL expressions are given as
  // sql("...")). Returns the updated row, or null if the job was not in an expected state.
  async function move(c, id, from, to, fields = {}, detail = null) {
    const prev = (await c.query("SELECT state FROM fcpi_platform.job WHERE id = $1 FOR UPDATE", [id])).rows[0];
    if (!prev || !from.includes(prev.state)) return null;
    const sets = ["state = $2", "updated_at = now()"], vals = [id, to];
    for (const [k, v] of Object.entries(fields)) {
      if (!SETTABLE.has(k)) throw new Error(`store: ${k} is not settable`);
      if (v && typeof v === "object" && SQL in v) {
        let text = v[SQL];
        for (const p of v.params) { vals.push(p); text = text.replace("$?", () => `$${vals.length}`); }
        sets.push(`${k} = ${text}`);
      }
      else { vals.push(v && typeof v === "object" ? JSON.stringify(v) : v); sets.push(`${k} = $${vals.length}`); }
    }
    const row = (await c.query(`UPDATE fcpi_platform.job SET ${sets.join(", ")} WHERE id = $1 RETURNING *`, vals)).rows[0];
    await c.query("INSERT INTO fcpi_platform.job_event (job_id, from_state, to_state, detail) VALUES ($1, $2, $3, $4)", [id, prev.state, to, detail]);
    await raise(c, row);
    return row;
  }
  // M7: the outbox row a transition raises for a job that asked for a webhook, in the transition's own transaction, so
  // an event exists exactly when its transition committed (the outbox, spec §31.3). The body is fixed here and signed
  // afresh at each delivery attempt; the event's id is the one a receiver deduplicates on.
  async function raise(c, row) {
    const hook = row.request?.webhook, event = EVENT_OF[row.state];
    if (!hook || !event || !(hook.events ?? WEBHOOK_EVENTS).includes(event)) return;
    const type = `${EVENT_PREFIX[row.kind]}.${event}`;
    const body = JSON.stringify({ success: row.state !== "FAILED", type, id: row.id, data: [], metadata: hook.metadata ?? {},
      ...(row.state === "FAILED" ? { error: row.error ?? "the job failed" } : {}), fcpi: { state: row.state, at: new Date().toISOString() } });
    await c.query(`INSERT INTO fcpi_platform.webhook_event (id, job_id, principal, type, destination, body, state) VALUES ($1, $2, $3, $4, $5, $6, 'PENDING')
      ON CONFLICT (job_id, type) DO NOTHING`, [randomUUID(), row.id, row.principal, type, hook.url, body]);
  }
  const moveTx = (id, from, to, fields, detail) => tx((c) => move(c, id, from, to, fields, detail));
  const retention = sql("now() + $? * interval '1 day'", [L.results.retentionDays]);

  return {
    pool,
    ping: () => q("SELECT 1"),
    schemaVersion: async () => (await q("SELECT max(version) AS v FROM fcpi_platform.schema_version")).rows[0].v,
    close: () => pool.end(),

    // Admits one asynchronous submission. Returns { job, existing } or { conflict }; throws
    // AdmissionError when the open-job caps or the result quota would be exceeded.
    async admit({ principal, clientLabel, kind, body, hash, units, idemKey, quotaBytes }) {
      return tx(async (c) => {
        await c.query(`SELECT pg_advisory_xact_lock(${LOCK})`);
        if (idemKey) {
          const k = (await c.query("SELECT request_hash, job_id FROM fcpi_platform.idempotency WHERE principal = $1 AND operation = $2 AND key = $3 AND expires_at > now()", [principal, kind, idemKey])).rows[0];
          if (k && k.request_hash !== hash) return { conflict: true };
          if (k) {
            const job = (await c.query("SELECT * FROM fcpi_platform.job WHERE id = $1", [k.job_id])).rows[0];
            if (job) return { job, existing: true };
          }
        }
        const open = (await c.query("SELECT count(*)::int AS n, coalesce(sum(units), 0)::int AS units FROM fcpi_platform.job WHERE state = ANY($1)", [OPEN])).rows[0];
        if (open.n >= L.admission.maxOpenJobs) throw new AdmissionError(503, "OVERLOADED", `The platform already holds ${open.n} open jobs (limit ${L.admission.maxOpenJobs}); retry later.`, 30);
        if (open.units + units > L.admission.maxOpenUnits) throw new AdmissionError(503, "OVERLOADED", `Open jobs already hold ${open.units} page units and this one adds ${units} (limit ${L.admission.maxOpenUnits}); retry later.`, 30);
        const used = (await c.query(STORED_BYTES)).rows[0].b;
        if (Number(used) >= quotaBytes) throw new AdmissionError(503, "STORAGE_QUOTA", "The result store is at its quota; new jobs are refused until retention frees space.", 300);
        const id = randomUUID();
        const job = (await c.query(`INSERT INTO fcpi_platform.job (id, principal, client_label, kind, state, submission_key, request_hash, request, units, metadata_expire_at)
          VALUES ($1, $2, $3, $4, 'RECEIVED', $5, $6, $7, $8, now() + $9 * interval '1 day') RETURNING *`,
          [id, principal, clientLabel, kind, `fcpi:${id}`, hash, JSON.stringify(body), units, L.results.metadataDays])).rows[0];
        await c.query("INSERT INTO fcpi_platform.job_event (job_id, from_state, to_state, detail) VALUES ($1, NULL, 'RECEIVED', $2)", [id, `admitted by ${clientLabel}`]);
        if (idemKey) await c.query(`INSERT INTO fcpi_platform.idempotency (principal, operation, key, request_hash, job_id, expires_at)
          VALUES ($1, $2, $3, $4, $5, now() + $6 * interval '1 hour')
          ON CONFLICT (principal, operation, key) DO UPDATE SET request_hash = EXCLUDED.request_hash, job_id = EXCLUDED.job_id, created_at = now(), expires_at = EXCLUDED.expires_at`,
          [principal, kind, idemKey, hash, id, L.results.idempotencyHours]);
        return { job, existing: false };
      });
    },

    // The job an idempotency key already names for this principal and operation: { job }, { conflict } when the key
    // was used with another request, or null. Read-only; admission itself still decides under its lock (M6 review W4).
    async idempotentJob({ principal, kind, idemKey, hash }) {
      const k = (await q("SELECT request_hash, job_id FROM fcpi_platform.idempotency WHERE principal = $1 AND operation = $2 AND key = $3 AND expires_at > now()", [principal, kind, idemKey])).rows[0];
      if (!k) return null;
      if (k.request_hash !== hash) return { conflict: true };
      const job = (await q("SELECT * FROM fcpi_platform.job WHERE id = $1", [k.job_id])).rows[0];
      return job ? { job } : null;
    },
    getJob: async (id, principal) => (await q("SELECT * FROM fcpi_platform.job WHERE id = $1 AND principal = $2", [id, principal])).rows[0] ?? null,
    getJobAny: async (id) => (await q("SELECT * FROM fcpi_platform.job WHERE id = $1", [id])).rows[0] ?? null,
    events: async (id) => (await q("SELECT at, from_state, to_state, detail FROM fcpi_platform.job_event WHERE job_id = $1 ORDER BY at, id", [id])).rows,
    listJobs: async (principal, limit) => (await q("SELECT * FROM fcpi_platform.job WHERE principal = $1 ORDER BY created_at DESC LIMIT $2", [principal, limit])).rows,

    // The next job to submit upstream, claimed as SUBMITTING by this instance; null while another job
    // is active upstream or none is due.
    async claimNext(instance) {
      return tx(async (c) => {
        await c.query(`SELECT pg_advisory_xact_lock(${LOCK})`);
        // Waiting jobs whose cancellation was asked close first, whether or not another job holds the
        // upstream slot, so they stop counting against the admission caps.
        const cancelled = (await c.query("SELECT id FROM fcpi_platform.job WHERE state = 'RECEIVED' AND kind IN ('crawl', 'batch') AND cancel_requested_at IS NOT NULL FOR UPDATE SKIP LOCKED")).rows;
        for (const { id } of cancelled) await move(c, id, ["RECEIVED"], "CANCELLED", { finished_at: sql("now()"), results_expire_at: retention }, "cancelled before submission");
        // The single upstream slot is the core's (spec §23.1): the gateway's own extraction jobs never hold it.
        const active = (await c.query("SELECT count(*)::int AS n FROM fcpi_platform.job WHERE state = ANY($1) AND kind IN ('crawl', 'batch')", [UPSTREAM_ACTIVE])).rows[0].n;
        if (active >= L.admission.activeUpstreamJobs) return null;
        const next = (await c.query("SELECT id FROM fcpi_platform.job WHERE state = 'RECEIVED' AND kind IN ('crawl', 'batch') AND cancel_requested_at IS NULL AND next_dispatch_at <= now() ORDER BY created_at LIMIT 1 FOR UPDATE SKIP LOCKED")).rows[0];
        if (!next) return null;
        return move(c, next.id, ["RECEIVED"], "SUBMITTING", { submitter: instance, submit_started_at: sql("now()"), dispatch_attempts: sql("dispatch_attempts + 1") });
      });
    },
    markSubmitted: (id, upstreamId, deadlineMinutes, detail) => moveTx(id, ["SUBMITTING", "SUBMISSION_UNCERTAIN"], "QUEUED",
      { upstream_id: upstreamId, submitted_at: sql("now()"), deadline: sql("now() + $? * interval '1 minute'", [deadlineMinutes]) }, detail),
    markRejected: (id, httpStatus, code, message) => moveTx(id, ["SUBMITTING"], "FAILED",
      { http_status: httpStatus, error_code: code, error: message, finished_at: sql("now()"), results_expire_at: retention }, `rejected upstream: ${code}`),
    // Back to the queue: the request certainly never reached the core, or an uncertain one was
    // settled as absent. The next try waits 2^n seconds, at most a minute.
    markRequeued: (id, detail) => moveTx(id, ["SUBMITTING", "SUBMISSION_UNCERTAIN"], "RECEIVED",
      { submitter: null, next_dispatch_at: sql("now() + least(interval '60 seconds', interval '1 second' * power(2, least(dispatch_attempts, 6)))") }, detail),
    markUncertain: (id, detail) => moveTx(id, ["SUBMITTING"], "SUBMISSION_UNCERTAIN", {}, detail),
    // SUBMITTING rows nobody is submitting: a dispatch always ends (records its answer or throws)
    // inside its own step of the serial chain, so a row seen between steps was abandoned, by an
    // earlier process or by this one when a ledger write failed after the claim.
    async orphanSubmitting() {
      const ids = (await q("SELECT id FROM fcpi_platform.job WHERE state = 'SUBMITTING'")).rows.map((r) => r.id);
      for (const id of ids) await moveTx(id, ["SUBMITTING"], "SUBMISSION_UNCERTAIN", {}, "the submission's answer was never recorded");
      return ids.length;
    },
    uncertain: async (settleMs) => (await q(`SELECT *, (submit_started_at < now() - $1 * interval '1 millisecond') AS settled FROM fcpi_platform.job WHERE state = 'SUBMISSION_UNCERTAIN' ORDER BY created_at`, [settleMs])).rows,
    markerGroups: async (marker) => (await q("SELECT group_id, first_seen FROM fcpi_platform.upstream_groups_for_marker($1)", [marker])).rows,

    // overdue: past the deadline (the core is told to stop); stalled: still open graceMinutes after it.
    running: async (graceMinutes) => (await q("SELECT *, (deadline IS NOT NULL AND deadline < now()) AS overdue, (deadline IS NOT NULL AND deadline < now() - $1 * interval '1 minute') AS stalled FROM fcpi_platform.job WHERE state IN ('QUEUED', 'RUNNING') AND kind IN ('crawl', 'batch') ORDER BY created_at", [graceMinutes])).rows,

    // M5: the gateway's own extraction jobs (src/extract.mjs). One runs at a time: a RUNNING one (an earlier
    // process's, after a restart) is resumed first; otherwise the oldest RECEIVED one is claimed. Returns
    // the job with overdue set once its deadline has passed, or null.
    async claimExtract(instance, deadlineMinutes) {
      return tx(async (c) => {
        await c.query(`SELECT pg_advisory_xact_lock(${LOCK})`);
        const running = (await c.query("SELECT *, (deadline < now()) AS overdue FROM fcpi_platform.job WHERE state = 'RUNNING' AND kind = 'extract' ORDER BY created_at LIMIT 1")).rows[0];
        if (running) return running;
        const next = (await c.query("SELECT id FROM fcpi_platform.job WHERE state = 'RECEIVED' AND kind = 'extract' ORDER BY created_at LIMIT 1 FOR UPDATE SKIP LOCKED")).rows[0];
        if (!next) return null;
        const row = await move(c, next.id, ["RECEIVED"], "RUNNING", { submitter: instance, submitted_at: sql("now()"), dispatch_attempts: sql("dispatch_attempts + 1"),
          deadline: sql("now() + $? * interval '1 minute'", [deadlineMinutes]) }, "the gateway started the extraction");
        return row ? { ...row, overdue: false } : null;
      });
    },
    finishExtract: (id, to, f, detail) => moveTx(id, ["RUNNING"], to, {
      finished_at: sql("now()"), results_expire_at: retention, completed: f.completed ?? null, total: f.total ?? null,
      errors: f.errors ?? null, error_code: f.errorCode ?? null, error: f.error ?? null }, detail),
    documentKeys: async (id) => (await q("SELECT doc_key, ordinal, sha256, bytes FROM fcpi_platform.job_document WHERE job_id = $1 ORDER BY ordinal", [id])).rows,
    async progress(id, s) {
      await q("UPDATE fcpi_platform.job SET upstream_status = $2, completed = $3, total = $4, credits_used = $5, updated_at = now() WHERE id = $1",
        [id, s.status, s.completed, s.total, s.creditsUsed]);
      return moveTx(id, ["QUEUED"], "RUNNING", {}, `upstream reports ${s.status}`);
    },
    requestCancel: async (id) => (await q("UPDATE fcpi_platform.job SET cancel_requested_at = coalesce(cancel_requested_at, now()), updated_at = now() WHERE id = $1 RETURNING *", [id])).rows[0],
    cancelUnsubmitted: (id) => moveTx(id, ["RECEIVED"], "CANCELLED", { finished_at: sql("now()"), results_expire_at: retention }, "cancelled before submission"),
    cancelSent: (id) => q("UPDATE fcpi_platform.job SET cancel_sent_at = now(), updated_at = now() WHERE id = $1", [id]),
    finish: (id, to, f, detail) => moveTx(id, ["QUEUED", "RUNNING"], to, {
      finished_at: sql("now()"), results_expire_at: retention, upstream_status: f.status ?? null, completed: f.completed ?? null,
      total: f.total ?? null, credits_used: f.creditsUsed ?? null, errors: f.errors ?? null, error_code: f.errorCode ?? null, error: f.error ?? null }, detail),
    failLost: (id, code, message) => moveTx(id, ["QUEUED", "RUNNING"], "FAILED", { error_code: code, error: message, finished_at: sql("now()"), results_expire_at: retention }, message),

    async addDocuments(id, docs) {
      await tx(async (c) => {
        for (const d of docs) await c.query("INSERT INTO fcpi_platform.job_document (job_id, ordinal, doc_key, sha256, bytes) VALUES ($1, $2, $3, $4, $5) ON CONFLICT DO NOTHING", [id, d.ordinal, d.docKey, d.sha256, d.bytes]);
        await c.query("UPDATE fcpi_platform.job SET archived = (SELECT count(*) FROM fcpi_platform.job_document WHERE job_id = $1), updated_at = now() WHERE id = $1", [id]);
      });
    },
    archivedKeys: async (id) => new Set((await q("SELECT doc_key FROM fcpi_platform.job_document WHERE job_id = $1", [id])).rows.map((r) => r.doc_key)),
    documentsPage: async (id, skip, limit) => (await q("SELECT ordinal, sha256, bytes FROM fcpi_platform.job_document WHERE job_id = $1 AND ordinal >= $2 ORDER BY ordinal LIMIT $3", [id, skip, limit])).rows,
    documentCount: async (id) => (await q("SELECT count(*)::int AS n FROM fcpi_platform.job_document WHERE job_id = $1", [id])).rows[0].n,
    // The bytes every retained document holds, the measure the result quota caps (spec §21.3).
    archiveBytes: async () => Number((await q(STORED_BYTES)).rows[0].b),
    referenced: async (shas) => new Set((await q(CONTENT_TABLES.map((t) => `SELECT sha256 FROM fcpi_platform.${t} WHERE sha256 = ANY($1)`).join(" UNION "), [shas])).rows.map((r) => r.sha256)),

    // ---- M7: artifacts, the scrape cache, page versions and the webhook outbox ---------------------------
    // Each row names a file the archive already holds (written and fsynced before the rows commit). One answer's artifacts
    // commit together, so a capture that fails leaves none of its siblings behind (review S5).
    addArtifacts: (list) => tx(async (c) => {
      const rows = [];
      for (const a of list) rows.push((await c.query(`INSERT INTO fcpi_platform.artifact (id, principal, sha256, bytes, mime, width, height, truncated, expires_at)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, now() + $9 * interval '1 day') RETURNING *`, [a.id, a.principal, a.sha256, a.bytes, a.mime, a.width, a.height, a.truncated, L.results.retentionDays])).rows[0]);
      return rows;
    }),
    // An artifact by id for its principal only: another principal's is not found, as an unknown one is.
    getArtifact: async (id, principal) => (await q("SELECT *, (expires_at < now()) AS expired FROM fcpi_platform.artifact WHERE id = $1 AND principal = $2", [id, principal])).rows[0] ?? null,
    // A cached answer no older than maxAgeMs, for this principal and request only.
    cacheGet: async (principal, key, maxAgeMs) => (await q(`SELECT sha256, created_at FROM fcpi_platform.page_cache
      WHERE principal = $1 AND key = $2 AND expires_at > now() AND created_at >= now() - $3 * interval '1 millisecond'`, [principal, key, maxAgeMs])).rows[0] ?? null,
    cachePut: (principal, key, sha256, bytes, seconds) => q(`INSERT INTO fcpi_platform.page_cache (principal, key, sha256, bytes, expires_at) VALUES ($1, $2, $3, $4, now() + $5 * interval '1 second')
      ON CONFLICT (principal, key) DO UPDATE SET sha256 = EXCLUDED.sha256, bytes = EXCLUDED.bytes, created_at = now(), expires_at = EXCLUDED.expires_at`, [principal, key, sha256, bytes, seconds]),
    versionGet: async (principal, key) => (await q("SELECT * FROM fcpi_platform.page_version WHERE principal = $1 AND key = $2 AND expires_at > now()", [principal, key])).rows[0] ?? null,
    versionPut: (v) => q(`INSERT INTO fcpi_platform.page_version (principal, key, url, sha256, bytes, normalized_sha256, expires_at) VALUES ($1, $2, $3, $4, $5, $6, now() + $7 * interval '1 day')
      ON CONFLICT (principal, key) DO UPDATE SET url = EXCLUDED.url, sha256 = EXCLUDED.sha256, bytes = EXCLUDED.bytes, normalized_sha256 = EXCLUDED.normalized_sha256, scraped_at = now(), expires_at = EXCLUDED.expires_at`,
      [v.principal, v.key, v.url, v.sha256, v.bytes, v.normalizedSha256, L.results.retentionDays]),
    // Due events, leased for leaseS so a round that dies mid-delivery is retried after it rather than twice at once.
    claimWebhooks: async (limit, leaseS) => (await q(`UPDATE fcpi_platform.webhook_event SET next_at = now() + $2 * interval '1 second'
      WHERE id IN (SELECT id FROM fcpi_platform.webhook_event WHERE state = 'PENDING' AND next_at <= now() ORDER BY next_at LIMIT $1 FOR UPDATE SKIP LOCKED) RETURNING *`, [limit, leaseS])).rows,
    webhookDelivered: (id, status) => q("UPDATE fcpi_platform.webhook_event SET state = 'DELIVERED', attempts = attempts + 1, last_status = $2, last_error = NULL, delivered_at = now() WHERE id = $1 AND state = 'PENDING'", [id, status]),
    // A failed attempt: retried after retryBaseS × 2^(attempts - 1), and DEAD (kept, visible on the job's receipt) once
    // maxAttempts have failed or the failure is final.
    webhookFailed: (id, { status = null, error, maxAttempts, retryBaseS, final = false }) => q(`UPDATE fcpi_platform.webhook_event SET attempts = attempts + 1, last_status = $2, last_error = $3,
      state = CASE WHEN $6 OR attempts + 1 >= $4 THEN 'DEAD' ELSE 'PENDING' END, next_at = now() + $5 * power(2, attempts) * interval '1 second' WHERE id = $1 AND state = 'PENDING'`,
      [id, status, String(error).slice(0, 500), maxAttempts, retryBaseS, final]),
    // Not attempted (delivery suppressed, the delivering service unreachable): no attempt is counted.
    webhookDefer: (id, seconds, why) => q("UPDATE fcpi_platform.webhook_event SET next_at = now() + $2 * interval '1 second', last_error = $3 WHERE id = $1 AND state = 'PENDING'", [id, seconds, String(why).slice(0, 500)]),
    jobWebhooks: async (jobId) => (await q("SELECT id, type, state, attempts, last_status, last_error, created_at, delivered_at FROM fcpi_platform.webhook_event WHERE job_id = $1 ORDER BY created_at", [jobId])).rows,

    // Retention (spec §21.3): results past their seven days leave the manifest and the job becomes
    // EXPIRED; job metadata past thirty days goes; so do idempotency keys past their day. M7: artifacts, cached answers
    // and page versions past their own expiry go, and a job's webhook events go with its metadata.
    async sweep() {
      const expired = (await q("SELECT id FROM fcpi_platform.job WHERE results_expire_at < now() AND state = ANY($1)", [FINISHED])).rows.map((r) => r.id);
      for (const id of expired) await tx(async (c) => {
        await c.query("DELETE FROM fcpi_platform.job_document WHERE job_id = $1", [id]);
        await move(c, id, FINISHED, "EXPIRED", {}, "results passed their retention");
      });
      // One statement, so a job's row, events and documents go together or not at all.
      const old = await q(`WITH old AS (DELETE FROM fcpi_platform.job WHERE metadata_expire_at < now() AND NOT (state = ANY($1)) RETURNING id),
          ev AS (DELETE FROM fcpi_platform.job_event WHERE job_id IN (SELECT id FROM old)),
          doc AS (DELETE FROM fcpi_platform.job_document WHERE job_id IN (SELECT id FROM old)),
          hook AS (DELETE FROM fcpi_platform.webhook_event WHERE job_id IN (SELECT id FROM old))
        SELECT count(*)::int AS n FROM old`, [OPEN]);
      const keys = await q("DELETE FROM fcpi_platform.idempotency WHERE expires_at < now()");
      const m7 = {};
      for (const t of ["artifact", "page_cache", "page_version"]) m7[t] = (await q(`DELETE FROM fcpi_platform.${t} WHERE expires_at < now()`)).rowCount;
      return { expired: expired.length, deleted: old.rows[0].n, keys: keys.rowCount, ...m7 };
    },
    async summary() {
      const states = Object.fromEntries((await q("SELECT state, count(*)::int AS n FROM fcpi_platform.job GROUP BY state")).rows.map((r) => [r.state, r.n]));
      const bytes = Number((await q(STORED_BYTES)).rows[0].b);
      return { states, archiveBytes: bytes };
    },
  };
}
