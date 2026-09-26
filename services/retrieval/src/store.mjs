// The retrieval service's durable state in PostgreSQL (schema fcpi_retrieval, role fcpi_retrieval,
// DML only; deploy/nuq-postgres/fcpi-retrieval-schema.sql): the attempt budget per logical page,
// the attempt log, the global permits and direct-egress pacing. Every decision that must hold
// across concurrent callers, restarts and NuQ requeues is one transaction here.
import pg from "pg";

// Direct-egress pacing (spec §10.2), as a pure function so the limits can be checked without a
// database. Returns { go: true } | { waitMs } | { failure }.
export function paceDecision({ now, state, hourCount, dayCount, limits }) {
  if (state.cooldown_until && state.cooldown_until > now) {
    const retryAfter = Math.ceil((state.cooldown_until - now) / 1000);
    return { failure: { class: "RATE_LIMITED", detail: "the domain is cooling down after a rate limit", retryable: true, retryAfter } };
  }
  // The caps come before any wait, so work the policy will refuse fails at once.
  if (limits.perDomainPerHour !== null && hourCount >= limits.perDomainPerHour) {
    return { failure: { class: "PROXY_REQUIRED", detail: `${limits.perDomainPerHour} direct navigations to this domain in the last hour; more needs approved proxy egress (M6)`, retryable: true, retryAfter: null } };
  }
  if (limits.platformPerDay !== null && dayCount >= limits.platformPerDay) {
    return { failure: { class: "PROXY_REQUIRED", detail: `${limits.platformPerDay} direct navigations across the platform today; more needs approved proxy egress (M6)`, retryable: true, retryAfter: null } };
  }
  if (state.holder && state.hold_until && state.hold_until > now) return { waitMs: Math.min(state.hold_until - now, 250) };
  if (state.last_nav_at && limits.minNavigationGapMs > 0) {
    const gap = state.last_nav_at.getTime() + limits.minNavigationGapMs - now.getTime();
    if (gap > 0) return { waitMs: gap };
  }
  return { go: true };
}

// The next 429 cooldown (spec §9.3): the target's Retry-After when it gives one, otherwise 60 s
// doubling on each recurrence up to an hour.
export function nextCooldown(previousS, retryAfterS) {
  if (retryAfterS !== null && retryAfterS !== undefined) return Math.max(1, Math.min(retryAfterS, 86400));
  return previousS ? Math.min(previousS * 2, 3600) : 60;
}

export class Store {
  constructor(config) {
    this.pool = new pg.Pool({ ...config, max: 4, idleTimeoutMillis: 30000, application_name: "fcpi-retrieval" });
    this.pool.on("error", () => {}); // an idle client's error surfaces on its next query
  }

  // One retrieval service runs per deployment, so at its start every lease and domain hold belongs
  // to a process that no longer exists: they are reclaimed rather than left to expire, so a restart
  // does not stall acquisitions for a lease period (review finding W3).
  async ready(permits) {
    await this.pool.query("SELECT 1");
    await this.pool.query("UPDATE fcpi_retrieval.permit SET holder = NULL, lease_until = NULL WHERE holder IS NOT NULL");
    await this.pool.query("UPDATE fcpi_retrieval.domain_state SET holder = NULL, hold_until = NULL WHERE holder IS NOT NULL");
    for (const [kind, n] of Object.entries(permits)) {
      await this.pool.query("INSERT INTO fcpi_retrieval.permit (kind, slot) SELECT $1, g FROM generate_series(0, $2::int - 1) g ON CONFLICT DO NOTHING", [kind, n]);
    }
  }

  async #tx(fn) {
    const c = await this.pool.connect();
    try {
      await c.query("BEGIN");
      const r = await fn(c);
      await c.query("COMMIT");
      return r;
    } catch (e) {
      await c.query("ROLLBACK").catch(() => {});
      throw e;
    } finally {
      c.release();
    }
  }

  // The logical page's row, created on first sight with its absolute deadline; a later call can
  // only shorten the deadline, never extend it.
  async openAcquisition(logicalId, urlHmac, deadline) {
    const r = await this.pool.query(
      `INSERT INTO fcpi_retrieval.acquisition (logical_id, url_hmac, deadline) VALUES ($1, $2, $3)
       ON CONFLICT (logical_id) DO UPDATE SET deadline = LEAST(fcpi_retrieval.acquisition.deadline, EXCLUDED.deadline), updated_at = now()
       RETURNING first_seen, deadline, attempts`, [logicalId, urlHmac, deadline]);
    return r.rows[0];
  }

  // Reserve one attempt of the budget before dispatch. Null when the budget is spent.
  async reserveAttempt({ logicalId, attemptId, requestId, purpose, strategy, domain, maxAttempts }) {
    return this.#tx(async (c) => {
      const r = await c.query(
        `UPDATE fcpi_retrieval.acquisition SET attempts = attempts + 1, updated_at = now()
         WHERE logical_id = $1 AND attempts < $2 RETURNING attempts`, [logicalId, maxAttempts]);
      if (r.rowCount === 0) return null;
      const ordinal = r.rows[0].attempts;
      await c.query(
        `INSERT INTO fcpi_retrieval.attempt (attempt_id, logical_id, ordinal, request_id, purpose, strategy, domain)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`, [attemptId, logicalId, ordinal, requestId, purpose, strategy, domain]);
      return ordinal;
    });
  }

  async finishAttempt(attemptId, { outcome, targetStatus = null, bytes = null, subresources = null }) {
    await this.pool.query(
      `UPDATE fcpi_retrieval.attempt SET finished_at = now(), outcome = $2, target_status = $3, bytes = $4, subresources = $5 WHERE attempt_id = $1`,
      [attemptId, outcome, targetStatus, bytes, subresources]);
  }

  async attemptsUsed(logicalId) {
    const r = await this.pool.query("SELECT attempts FROM fcpi_retrieval.acquisition WHERE logical_id = $1", [logicalId]);
    return r.rows[0]?.attempts ?? 0;
  }

  // A free slot of `kind` (never held, or its lease expired), taken for leaseMs. Null when all are held.
  async takePermit(kind, holder, slots, leaseMs) {
    const r = await this.pool.query(
      `UPDATE fcpi_retrieval.permit SET holder = $2, lease_until = now() + ($4::int * interval '1 millisecond')
       WHERE (kind, slot) = (SELECT kind, slot FROM fcpi_retrieval.permit
                             WHERE kind = $1 AND slot < $3 AND (holder IS NULL OR lease_until < now())
                             ORDER BY slot LIMIT 1 FOR UPDATE SKIP LOCKED)
       RETURNING slot`, [kind, holder, slots, leaseMs]);
    // The slot number, or null: slot 0 is a real slot, so callers compare with null.
    return r.rows.length ? r.rows[0].slot : null;
  }

  async releasePermit(kind, holder) {
    await this.pool.query("UPDATE fcpi_retrieval.permit SET holder = NULL, lease_until = NULL WHERE kind = $1 AND holder = $2", [kind, holder]);
  }

  // One pacing decision for a direct navigation to `domain`; on { go } the navigation is recorded
  // and the domain is held by `holder` until released or holdMs passes.
  async paceDirect(domain, holder, limits, holdMs, fixture) {
    return this.#tx(async (c) => {
      await c.query("INSERT INTO fcpi_retrieval.domain_state (domain) VALUES ($1) ON CONFLICT DO NOTHING", [domain]);
      const s = (await c.query(
        "SELECT holder, hold_until, last_nav_at, cooldown_until, cooldown_s, now() AS now FROM fcpi_retrieval.domain_state WHERE domain = $1 FOR UPDATE", [domain])).rows[0];
      const hourCount = Number((await c.query(
        "SELECT count(*) FROM fcpi_retrieval.direct_nav WHERE domain = $1 AND at > now() - interval '1 hour'", [domain])).rows[0].count);
      const dayCount = Number((await c.query(
        "SELECT count(*) FROM fcpi_retrieval.direct_nav WHERE NOT fixture AND at > now() - interval '1 day'")).rows[0].count);
      const d = paceDecision({ now: s.now, state: s, hourCount, dayCount, limits });
      if (!d.go) return d;
      await c.query(
        "UPDATE fcpi_retrieval.domain_state SET holder = $2, hold_until = now() + ($3::int * interval '1 millisecond'), last_nav_at = now() WHERE domain = $1",
        [domain, holder, holdMs]);
      await c.query("INSERT INTO fcpi_retrieval.direct_nav (domain, fixture) VALUES ($1, $2)", [domain, fixture]);
      return d;
    });
  }

  // A navigation that happened without a pacing decision (a redirect only the browser followed):
  // counted, so the domain's and the platform's caps stay true.
  async recordNavigation(domain, fixture) {
    await this.pool.query("INSERT INTO fcpi_retrieval.direct_nav (domain, fixture) VALUES ($1, $2)", [domain, fixture]);
  }

  async releaseDomain(domain, holder) {
    await this.pool.query("UPDATE fcpi_retrieval.domain_state SET holder = NULL, hold_until = NULL WHERE domain = $1 AND holder = $2", [domain, holder]);
  }

  async coolDown(domain, retryAfterS) {
    await this.#tx(async (c) => {
      await c.query("INSERT INTO fcpi_retrieval.domain_state (domain) VALUES ($1) ON CONFLICT DO NOTHING", [domain]);
      const prev = (await c.query("SELECT cooldown_s FROM fcpi_retrieval.domain_state WHERE domain = $1 FOR UPDATE", [domain])).rows[0].cooldown_s;
      const s = nextCooldown(prev, retryAfterS);
      await c.query("UPDATE fcpi_retrieval.domain_state SET cooldown_s = $2, cooldown_until = now() + ($2::int * interval '1 second') WHERE domain = $1", [domain, s]);
    });
  }

  // Bounded history: attempt rows and navigation counts older than their use are removed.
  async prune() {
    await this.pool.query("DELETE FROM fcpi_retrieval.direct_nav WHERE at < now() - interval '2 days'");
    await this.pool.query("DELETE FROM fcpi_retrieval.attempt WHERE started_at < now() - interval '30 days'");
    await this.pool.query("DELETE FROM fcpi_retrieval.acquisition WHERE updated_at < now() - interval '30 days'");
  }

  async close() { await this.pool.end(); }
}
