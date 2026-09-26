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

// The next 429 cooldown (spec §9.3): the target's Retry-After when it gives one; otherwise 60 s,
// doubling up to an hour when the 429 recurs within an hour of the last cooldown's end. A short
// Retry-After cannot seed a bare cooldown below 60 s, and an old hour-long one is not kept for
// ever (review finding W14). sinceLastEndS: seconds since the last cooldown ended (negative while
// it lasts), or null when there was none.
export function nextCooldown(previousS, retryAfterS, sinceLastEndS = null) {
  if (retryAfterS !== null && retryAfterS !== undefined) return Math.max(1, Math.min(retryAfterS, 86400));
  const recurring = !!previousS && sinceLastEndS !== null && sinceLastEndS < 3600;
  return recurring ? Math.min(Math.max(previousS * 2, 60), 3600) : 60;
}

// The one order in which budget usage rows are locked: a category's periods by name (day before month),
// then the paid total's day.
export const lockOrder = (rows) => rows.sort((a, b) => (a.category === "_paid_total") - (b.category === "_paid_total") || a.period.localeCompare(b.period));

export class Store {
  constructor(config) {
    // A database that stops answering fails a request in seconds instead of holding its permit to the
    // deadline: 5 s to connect, 10 s per statement (review finding S13).
    this.pool = new pg.Pool({ ...config, max: 4, idleTimeoutMillis: 30000, connectionTimeoutMillis: 5000, statement_timeout: 10000, application_name: "fcpi-retrieval" });
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
      // The platform's daily cap is counted across all domains, so concurrent pacers of different
      // domains are serialised on one advisory lock before counting; otherwise each could see 199 and
      // go (CWE-362; review finding W4). Fixture navigations are outside the cap and do not wait.
      if (!fixture) await c.query("SELECT pg_advisory_xact_lock(hashtext('fcpi.direct_nav.day'))");
      // One statement creates or locks the row, so the prune cannot remove it between the two.
      const s = (await c.query(
        `INSERT INTO fcpi_retrieval.domain_state (domain) VALUES ($1) ON CONFLICT (domain) DO UPDATE SET domain = EXCLUDED.domain
         RETURNING holder, hold_until, last_nav_at, cooldown_until, cooldown_s, now() AS now`, [domain])).rows[0];
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

  // The gap runs from a navigation's end: the release stamps last_nav_at, so the next navigation to
  // the domain reaches the target at least the gap after this one's request and response, however
  // long its resolution, connection or browser start-up took (spec §10.2). The decision's own stamp
  // stays for a holder that dies, whose hold then lapses.
  async releaseDomain(domain, holder) {
    await this.pool.query("UPDATE fcpi_retrieval.domain_state SET holder = NULL, hold_until = NULL, last_nav_at = now() WHERE domain = $1 AND holder = $2", [domain, holder]);
  }

  async coolDown(domain, retryAfterS) {
    await this.#tx(async (c) => {
      const prev = (await c.query(
        `INSERT INTO fcpi_retrieval.domain_state (domain) VALUES ($1) ON CONFLICT (domain) DO UPDATE SET domain = EXCLUDED.domain
         RETURNING cooldown_s, extract(epoch FROM now() - cooldown_until)::float8 AS since_end`, [domain])).rows[0];
      const s = nextCooldown(prev.cooldown_s, retryAfterS, prev.since_end);
      await c.query("UPDATE fcpi_retrieval.domain_state SET cooldown_s = $2, cooldown_until = now() + ($2::int * interval '1 second') WHERE domain = $1", [domain, s]);
    });
  }

  // ---- provider budgets (spec §28.3) ---------------------------------------------------------------
  // Every writer of the usage rows takes them in one order (see lockOrder), so a reservation and a
  // settlement running at once never wait on each other's rows (review W2).
  // Reserves `amount` for one provider call before dispatch, against every period cap of its category
  // and, for a paid USD category, the paid total's daily cap. One transaction: each period row is
  // updated only while reserved + settled + amount stays within its cap, and PostgreSQL re-checks that
  // condition against the newest row version when concurrent callers queue on the row lock, so no race
  // passes a cap. Returns { reservation } for a new one, { existing } when the call key was already
  // reserved (a retried request), or { exhausted: { category, period, cap, used } }.
  async reserveBudget(r) {
    const periods = lockOrder([...Object.entries(r.caps).map(([period, cap]) => ({ category: r.category, period, cap })),
      ...(r.paidTotalCap !== null ? [{ category: "_paid_total", period: "day", cap: r.paidTotalCap }] : [])]);
    const EXHAUSTED = Symbol("exhausted");
    try {
      return await this.#tx(async (c) => {
        const prior = (await c.query("SELECT * FROM fcpi_retrieval.budget_reservation WHERE call_key = $1 FOR UPDATE", [r.callKey])).rows[0];
        // A released call never reached the provider and cost nothing: a retry may reserve it again.
        if (prior && prior.state !== "RELEASED") return { existing: prior };
        if (prior) await c.query("DELETE FROM fcpi_retrieval.budget_reservation WHERE id = $1", [prior.id]);
        const notices = [];
        for (const p of periods) {
          const start = p.period === "day" ? r.day : r.month;
          await c.query("INSERT INTO fcpi_retrieval.budget_usage (category, period, period_start) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING", [p.category, p.period, start]);
          const u = await c.query(
            `UPDATE fcpi_retrieval.budget_usage SET reserved = reserved + $4
             WHERE category = $1 AND period = $2 AND period_start = $3 AND reserved + settled + $4 <= $5
             RETURNING reserved, settled, notified`, [p.category, p.period, start, r.amount, p.cap]);
          if (u.rowCount === 0) {
            const used = (await c.query("SELECT reserved + settled AS used FROM fcpi_retrieval.budget_usage WHERE category = $1 AND period = $2 AND period_start = $3", [p.category, p.period, start])).rows[0];
            throw Object.assign(new Error("exhausted"), { [EXHAUSTED]: { category: p.category, period: p.period, cap: p.cap, used: Number(used?.used ?? 0) } });
          }
          const row = u.rows[0], total = Number(row.reserved) + Number(row.settled);
          // The notification threshold (spec §28.3: notify at 80%): crossed once per period row.
          if (!row.notified && p.cap > 0 && total >= r.notifyAt * p.cap) {
            await c.query("UPDATE fcpi_retrieval.budget_usage SET notified = true WHERE category = $1 AND period = $2 AND period_start = $3", [p.category, p.period, start]);
            notices.push({ category: p.category, period: p.period, used: total, cap: p.cap });
          }
        }
        const reservation = (await c.query(
          `INSERT INTO fcpi_retrieval.budget_reservation (id, call_key, logical_id, category, provider, subject, kind, unit, rate_card, request_hash, reserved, state, day_start, month_start, paid_total, periods)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, 'RESERVED', $12, $13, $14, $15) RETURNING *`,
          [r.id, r.callKey, r.logicalId, r.category, r.provider, r.subject, r.kind, r.unit, r.rateCard, r.requestHash, r.amount, r.day, r.month, r.paidTotalCap !== null, Object.keys(r.caps).sort()])).rows[0];
        return { reservation, notices };
      });
    } catch (e) {
      if (e[EXHAUSTED]) return { exhausted: e[EXHAUSTED] };
      // Two callers raced on one call key: the loser reads the winner's row.
      if (e.code === "23505") return { existing: (await this.pool.query("SELECT * FROM fcpi_retrieval.budget_reservation WHERE call_key = $1", [r.callKey])).rows[0] };
      throw e;
    }
  }

  // Moves a reservation out of RESERVED/UNCERTAIN: settled at its measured amount (with the call's
  // usage and stored result), or released when the call demonstrably never reached the provider.
  // The period rows give back the reservation and take the actual amount in the same transaction: the rows
  // the reservation took, in the one lock order reservations use. A settlement that still loses a lock wait
  // is tried once more, since a paid answer must not be lost to it (review W2).
  async #close(id, to, actual, fields = {}) {
    try { return await this.#closeOnce(id, to, actual, fields); } catch (e) {
      if (e.code !== "40P01" && e.code !== "40001") throw e;
      return this.#closeOnce(id, to, actual, fields);
    }
  }
  async #closeOnce(id, to, actual, fields) {
    return this.#tx(async (c) => {
      const res = (await c.query("SELECT * FROM fcpi_retrieval.budget_reservation WHERE id = $1 FOR UPDATE", [id])).rows[0];
      if (!res || !["RESERVED", "UNCERTAIN"].includes(res.state)) return null;
      const taken = res.periods ?? (await c.query("SELECT period FROM fcpi_retrieval.budget_usage WHERE category = $1 AND ((period = 'day' AND period_start = $2) OR (period = 'month' AND period_start = $3))",
        [res.category, res.day_start, res.month_start])).rows.map((x) => x.period);
      const rows = lockOrder([...taken.map((period) => ({ category: res.category, period })), ...(res.paid_total ? [{ category: "_paid_total", period: "day" }] : [])]);
      for (const p of rows) {
        await c.query(`UPDATE fcpi_retrieval.budget_usage SET reserved = GREATEST(reserved - $4, 0), settled = settled + $5
          WHERE category = $1 AND period = $2 AND period_start = $3`, [p.category, p.period, p.period === "day" ? res.day_start : res.month_start, res.reserved, actual]);
      }
      return (await c.query(`UPDATE fcpi_retrieval.budget_reservation SET state = $2, actual = $3, usage = $4, result = $5, detail = $6, settled_at = now() WHERE id = $1 RETURNING *`,
        [id, to, actual, fields.usage ? JSON.stringify(fields.usage) : null, fields.result === undefined ? null : JSON.stringify(fields.result), fields.detail ?? null])).rows[0];
    });
  }
  settleBudget(id, actual, fields) { return this.#close(id, "SETTLED", actual, fields); }
  releaseBudget(id, detail) { return this.#close(id, "RELEASED", 0, { detail }); }
  // An outcome nobody can know (the request was sent and no answer came): the whole reservation stays
  // counted, and the call key is never sent again (spec §24.2).
  async markBudgetUncertain(id, detail) {
    await this.pool.query("UPDATE fcpi_retrieval.budget_reservation SET state = 'UNCERTAIN', detail = $2 WHERE id = $1 AND state = 'RESERVED'", [id, detail]);
  }
  async budgetUsage(day, month) {
    return (await this.pool.query("SELECT category, period, period_start::text AS period_start, reserved::float8 AS reserved, settled::float8 AS settled FROM fcpi_retrieval.budget_usage WHERE (period = 'day' AND period_start = $1) OR (period = 'month' AND period_start = $2) ORDER BY category, period",
      [day, month])).rows;
  }
  async reservationsFor(logicalId) {
    return (await this.pool.query("SELECT call_key, category, provider, subject, kind, unit, rate_card, reserved::float8 AS reserved, actual::float8 AS actual, state, usage, detail FROM fcpi_retrieval.budget_reservation WHERE logical_id = $1 ORDER BY created_at", [logicalId])).rows;
  }

  // ---- search (spec §13) ----------------------------------------------------------------------------
  async searchCacheGet(key) {
    return (await this.pool.query("SELECT response FROM fcpi_retrieval.search_cache WHERE key = $1 AND expires_at > now()", [key])).rows[0]?.response ?? null;
  }
  async searchCachePut(key, response, ttlS) {
    await this.pool.query(`INSERT INTO fcpi_retrieval.search_cache (key, response, expires_at) VALUES ($1, $2, now() + $3 * interval '1 second')
      ON CONFLICT (key) DO UPDATE SET response = EXCLUDED.response, created_at = now(), expires_at = EXCLUDED.expires_at`, [key, JSON.stringify(response), ttlS]);
  }
  // Admits one query to the backend if fewer than `perHour` went in the last hour, and counts it; the
  // count and the insert are serialised on an advisory lock, so concurrent queries cannot pass the cap.
  async admitSearchQuery(perHour) {
    return this.#tx(async (c) => {
      await c.query("SELECT pg_advisory_xact_lock(hashtext('fcpi.search.hour'))");
      const n = Number((await c.query("SELECT count(*) FROM fcpi_retrieval.search_query WHERE at > now() - interval '1 hour'")).rows[0].count);
      if (n >= perHour) return { admitted: false, count: n };
      await c.query("INSERT INTO fcpi_retrieval.search_query (outcome) VALUES ('sent')");
      return { admitted: true, count: n + 1 };
    });
  }

  // ---- complex-document parses (spec §15) ------------------------------------------------------------
  async parseCacheGet(key) {
    return (await this.pool.query("SELECT pages, markdown FROM fcpi_retrieval.parse_cache WHERE key = $1 AND expires_at > now()", [key])).rows[0] ?? null;
  }
  async parseCachePut({ key, owner, bytesSha256, parser, pages, markdown, days }) {
    await this.pool.query(`INSERT INTO fcpi_retrieval.parse_cache (key, owner, bytes_sha256, parser, pages, markdown, expires_at) VALUES ($1, $2, $3, $4, $5, $6, now() + $7 * interval '1 day')
      ON CONFLICT (key) DO UPDATE SET markdown = EXCLUDED.markdown, pages = EXCLUDED.pages, created_at = now(), expires_at = EXCLUDED.expires_at`, [key, owner, bytesSha256, parser, pages, markdown, days]);
  }

  // Bounded history: attempt rows and navigation counts older than their use are removed, and so is
  // a domain's pacing row once it holds nothing a decision reads: no live hold, no cooldown ended
  // within the hour that doubling looks back over, no navigation within direct_nav's two days
  // (review finding S5).
  async prune() {
    await this.pool.query("DELETE FROM fcpi_retrieval.direct_nav WHERE at < now() - interval '2 days'");
    await this.pool.query(
      `DELETE FROM fcpi_retrieval.domain_state WHERE (holder IS NULL OR hold_until < now())
         AND (cooldown_until IS NULL OR cooldown_until < now() - interval '1 hour') AND (last_nav_at IS NULL OR last_nav_at < now() - interval '2 days')`);
    await this.pool.query("DELETE FROM fcpi_retrieval.attempt WHERE started_at < now() - interval '30 days'");
    await this.pool.query("DELETE FROM fcpi_retrieval.acquisition WHERE updated_at < now() - interval '30 days'");
    await this.pool.query("DELETE FROM fcpi_retrieval.search_cache WHERE expires_at < now()");
    await this.pool.query("DELETE FROM fcpi_retrieval.search_query WHERE at < now() - interval '2 days'");
    await this.pool.query("DELETE FROM fcpi_retrieval.parse_cache WHERE expires_at < now()");
    // Usage records outlive the 30 days of job metadata (spec §21.3) so a month's spend stays explainable;
    // an unsettled reservation is never pruned, since it still counts against its cap.
    await this.pool.query("DELETE FROM fcpi_retrieval.budget_reservation WHERE created_at < now() - interval '90 days' AND state IN ('SETTLED', 'RELEASED')");
  }

  async close() { await this.pool.end(); }
}
