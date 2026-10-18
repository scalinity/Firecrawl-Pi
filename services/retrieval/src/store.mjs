// The retrieval service's durable state in PostgreSQL (schema fcpi_retrieval, role fcpi_retrieval,
// DML only; deploy/nuq-postgres/fcpi-retrieval-schema.sql): the attempt budget per logical page,
// the attempt log, the global permits and direct-egress pacing. Every decision that must hold
// across concurrent callers, restarts and NuQ requeues is one transaction here.
import pg from "pg";
import { observe } from "./route.mjs";

// Per-domain pacing (spec §10.2), as a pure function so the limits can be checked without a database. Returns
// { go: true } | { waitMs } | { failure }. The cooldown, the one navigation in flight and the gap hold on every
// route, since pacing applies across all egress IPs and clients; the hourly and daily caps count the home
// connection's navigations alone (direct: false for a residential navigation). Both caps are rolling windows:
// hourExit and dayExit are the time of the navigation whose leaving its window frees a slot (the window's oldest when it
// holds exactly the cap; a later one when it holds more, since unpaced navigations are recorded and a cap may be lowered).
export function paceDecision({ now, state, hourCount, dayCount, hourExit = null, dayExit = null, limits, direct = true }) {
  if (state.cooldown_until && state.cooldown_until > now) {
    const retryAfter = Math.ceil((state.cooldown_until - now) / 1000);
    return { failure: { class: "RATE_LIMITED", detail: "the domain is cooling down after a rate limit", retryable: true, retryAfter } };
  }
  // The caps come before any wait, so work the policy will refuse fails at once. Past them the page waits for the
  // window to free a navigation; it never moves to the residential route, which answers blocks, not volume (spec §10.2).
  const until = (exit, windowMs) => (exit ? Math.max(1, Math.ceil((exit.getTime() + windowMs - now.getTime()) / 1000)) : null);
  if (direct && limits.perDomainPerHour !== null && hourCount >= limits.perDomainPerHour) {
    return { failure: { class: "DIRECT_LIMIT", detail: `${limits.perDomainPerHour} direct navigations to this domain in the last hour, the home connection's allowance`, retryable: true, retryAfter: until(hourExit, 3600e3), directCap: "domain_hour" } };
  }
  if (direct && limits.platformPerDay !== null && dayCount >= limits.platformPerDay) {
    return { failure: { class: "DIRECT_LIMIT", detail: `${limits.platformPerDay} direct navigations across the platform in the last day, the home connection's allowance`, retryable: true, retryAfter: until(dayExit, 86400e3), directCap: "platform_day" } };
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
  // does not stall acquisitions for a lease period (review finding W3). A model call still RESERVED from before this
  // process started was in flight when the last one stopped: its outcome is unknown, so it is marked UNCERTAIN, which
  // the status lists, rather than held unseen. Returns how many were marked and what they hold.
  async ready(permits, startedAt = new Date()) {
    await this.pool.query("SELECT 1");
    // Search intelligence (spec §18.3): a search, documentation or decision operation still RESERVED was possibly sent by the
    // process that stopped; it is marked UNCERTAIN like a model call, never replayed or refunded.
    const swept = (await this.pool.query(`UPDATE fcpi_retrieval.budget_reservation SET state = 'UNCERTAIN', detail = 'the retrieval service stopped while the call was in flight'
      WHERE state = 'RESERVED' AND kind IN ('extract', 'repair', 'search', 'docs_search', 'docs_read', 'decision') AND created_at < $1 RETURNING kind, unit, reserved::float8 AS reserved`, [startedAt])).rows;
    await this.pool.query("UPDATE fcpi_retrieval.permit SET holder = NULL, lease_until = NULL WHERE holder IS NOT NULL");
    await this.pool.query("UPDATE fcpi_retrieval.domain_state SET holder = NULL, hold_until = NULL WHERE holder IS NOT NULL");
    for (const [kind, n] of Object.entries(permits)) {
      await this.pool.query("INSERT INTO fcpi_retrieval.permit (kind, slot) SELECT $1, g FROM generate_series(0, $2::int - 1) g ON CONFLICT DO NOTHING", [kind, n]);
    }
    // The model calls' micro-USD as before; the other operations by kind and unit, since their units differ.
    const models = swept.filter((r) => ["extract", "repair"].includes(r.kind));
    const operations = {};
    for (const r of swept.filter((x) => !["extract", "repair"].includes(x.kind))) {
      const k = `${r.kind}:${r.unit}`;
      operations[k] = { count: (operations[k]?.count ?? 0) + 1, reserved: (operations[k]?.reserved ?? 0) + r.reserved };
    }
    return { orphaned: models.length, orphanedReserved: models.reduce((n, r) => n + r.reserved, 0), orphanedOperations: operations };
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

  // One pacing decision for a navigation to `domain`; on { go } the navigation is recorded and the domain is
  // held by `holder` until released or holdMs passes. tier "residential" (M6) shares the domain's hold, gap and
  // cooldown with direct navigations, and is not counted against the home connection's caps.
  async paceDirect(domain, holder, limits, holdMs, fixture, tier = "direct") {
    const direct = tier === "direct";
    return this.#tx(async (c) => {
      // The platform's daily cap is counted across all domains, so concurrent pacers of different
      // domains are serialised on one advisory lock before counting; otherwise each could see 199 and
      // go (CWE-362; review finding W4). Fixture navigations are outside the cap and do not wait.
      if (!fixture && direct) await c.query("SELECT pg_advisory_xact_lock(hashtext('fcpi.direct_nav.day'))");
      // One statement creates or locks the row, so the prune cannot remove it between the two.
      const s = (await c.query(
        `INSERT INTO fcpi_retrieval.domain_state (domain) VALUES ($1) ON CONFLICT (domain) DO UPDATE SET domain = EXCLUDED.domain
         RETURNING holder, hold_until, last_nav_at, cooldown_until, cooldown_s, now() AS now`, [domain])).rows[0];
      // The caps count the home connection's navigations alone, so a residential navigation reads neither window.
      let hourCount = 0, dayCount = 0, hourExit = null, dayExit = null;
      if (direct) {
        hourCount = Number((await c.query(
          "SELECT count(*) FROM fcpi_retrieval.direct_nav WHERE domain = $1 AND at > now() - interval '1 hour'", [domain])).rows[0].count);
        dayCount = Number((await c.query(
          "SELECT count(*) FROM fcpi_retrieval.direct_nav WHERE NOT fixture AND at > now() - interval '1 day'")).rows[0].count);
        // At or past a cap, the navigation whose leaving frees a slot: the (count - cap + 1)-th oldest of its window.
        const cap = limits.perDomainPerHour, dcap = limits.platformPerDay;
        if (cap !== null && hourCount >= cap) hourExit = (await c.query(
          "SELECT at FROM fcpi_retrieval.direct_nav WHERE domain = $1 AND at > now() - interval '1 hour' ORDER BY at OFFSET $2 LIMIT 1", [domain, hourCount - cap])).rows[0]?.at ?? null;
        if (dcap !== null && dayCount >= dcap) dayExit = (await c.query(
          "SELECT at FROM fcpi_retrieval.direct_nav WHERE NOT fixture AND at > now() - interval '1 day' ORDER BY at OFFSET $1 LIMIT 1", [dayCount - dcap])).rows[0]?.at ?? null;
      }
      const d = paceDecision({ now: s.now, state: s, hourCount, dayCount, hourExit, dayExit, limits, direct });
      if (!d.go) return d;
      await c.query(
        "UPDATE fcpi_retrieval.domain_state SET holder = $2, hold_until = now() + ($3::int * interval '1 millisecond'), last_nav_at = now() WHERE domain = $1",
        [domain, holder, holdMs]);
      if (direct) await c.query("INSERT INTO fcpi_retrieval.direct_nav (domain, fixture) VALUES ($1, $2)", [domain, fixture]);
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
  // and, for a paid category, the paid total's daily cap in micro-USD: the amount times paidTotalRate (1 for
  // a micro-USD category, the rate card's micro-USD per credit for a parser). One transaction: each period row is
  // updated only while reserved + settled + amount stays within its cap, and PostgreSQL re-checks that
  // condition against the newest row version when concurrent callers queue on the row lock, so no race
  // passes a cap. Returns { reservation } for a new one, { existing } when the call key was already
  // reserved (a retried request), or { exhausted: { category, period, cap, used } }.
  // reportingPeriods (search intelligence, spec §18.1): periods totalled with no ceiling, for a category with no cap in them.
  // A period both capped and reported keeps its cap. The reservation records every period it drew on, so its settlement
  // returns exactly those rows.
  async reserveBudget(r) {
    const rate = r.paidTotalRate ?? 1;
    const capped = Object.entries(r.caps).map(([period, cap]) => ({ category: r.category, period, cap, amount: r.amount }));
    const reported = (r.reportingPeriods ?? []).filter((period) => !Object.hasOwn(r.caps, period)).map((period) => ({ category: r.category, period, cap: null, amount: r.amount }));
    const periods = lockOrder([...capped, ...reported,
      ...(r.paidTotalCap != null ? [{ category: "_paid_total", period: "day", cap: r.paidTotalCap, amount: Math.ceil(r.amount * rate) }] : [])]);
    const EXHAUSTED = Symbol("exhausted");
    try {
      return await this.#tx(async (c) => {
        if (r.lifetimeCap !== undefined) await c.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [`fcpi.allocation:${r.category}`]);
        const prior = (await c.query("SELECT * FROM fcpi_retrieval.budget_reservation WHERE call_key = $1 FOR UPDATE", [r.callKey])).rows[0];
        // A released call never reached the provider and cost nothing: a retry may reserve it again. The
        // released row is kept under a suffixed key, so what it was released for stays readable (review S4).
        if (prior && prior.state !== "RELEASED") return { existing: prior };
        if (prior) await c.query("UPDATE fcpi_retrieval.budget_reservation SET call_key = call_key || '#released-' || id WHERE id = $1", [prior.id]);
        if (r.lifetimeCap !== undefined) {
          const used = Number((await c.query(`SELECT COALESCE(SUM(CASE WHEN state = 'SETTLED' THEN actual WHEN state IN ('RESERVED', 'UNCERTAIN') THEN reserved ELSE 0 END), 0) AS used FROM fcpi_retrieval.budget_reservation WHERE category = $1`, [r.category])).rows[0].used);
          if (used + r.amount > r.lifetimeCap) throw Object.assign(new Error("exhausted"), { [EXHAUSTED]: { category: r.category, period: "allocation", cap: r.lifetimeCap, used } });
        }
        const notices = [];
        for (const p of periods) {
          const start = p.period === "day" ? r.day : r.month;
          await c.query("INSERT INTO fcpi_retrieval.budget_usage (category, period, period_start) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING", [p.category, p.period, start]);
          // A reporting-only period has no ceiling: the row counts the reservation and refuses nothing.
          const u = await c.query(
            `UPDATE fcpi_retrieval.budget_usage SET reserved = reserved + $4
             WHERE category = $1 AND period = $2 AND period_start = $3 AND ($5::bigint IS NULL OR reserved + settled + $4 <= $5)
             RETURNING reserved, settled, notified`, [p.category, p.period, start, p.amount, p.cap]);
          if (u.rowCount === 0) {
            const used = (await c.query("SELECT reserved + settled AS used FROM fcpi_retrieval.budget_usage WHERE category = $1 AND period = $2 AND period_start = $3", [p.category, p.period, start])).rows[0];
            throw Object.assign(new Error("exhausted"), { [EXHAUSTED]: { category: p.category, period: p.period, cap: p.cap, used: Number(used?.used ?? 0) } });
          }
          const row = u.rows[0], total = Number(row.reserved) + Number(row.settled);
          // The notification threshold (spec §28.3: notify at 80%): crossed once per period row. A reporting-only period has none.
          if (p.cap !== null && !row.notified && p.cap > 0 && total >= r.notifyAt * p.cap) {
            await c.query("UPDATE fcpi_retrieval.budget_usage SET notified = true WHERE category = $1 AND period = $2 AND period_start = $3", [p.category, p.period, start]);
            notices.push({ category: p.category, period: p.period, used: total, cap: p.cap });
          }
        }
        const reservation = (await c.query(
          `INSERT INTO fcpi_retrieval.budget_reservation (id, call_key, logical_id, category, provider, subject, kind, unit, rate_card, request_hash, reserved, state, day_start, month_start, paid_total, periods, paid_total_rate)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, 'RESERVED', $12, $13, $14, $15, $16) RETURNING *`,
          [r.id, r.callKey, r.logicalId, r.category, r.provider, r.subject, r.kind, r.unit, r.rateCard, r.requestHash, r.amount, r.day, r.month, r.paidTotalCap != null,
            [...new Set([...Object.keys(r.caps), ...reported.map((p) => p.period)])].sort(), rate])).rows[0];
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
      const rows = lockOrder([...taken.map((period) => ({ category: res.category, period, rate: 1 })),
        ...(res.paid_total ? [{ category: "_paid_total", period: "day", rate: Number(res.paid_total_rate) }] : [])]);
      for (const p of rows) {
        await c.query(`UPDATE fcpi_retrieval.budget_usage SET reserved = GREATEST(reserved - $4, 0), settled = settled + $5
          WHERE category = $1 AND period = $2 AND period_start = $3`, [p.category, p.period, p.period === "day" ? res.day_start : res.month_start,
          Math.ceil(Number(res.reserved) * p.rate), Math.ceil(actual * p.rate)]);
      }
      return (await c.query(`UPDATE fcpi_retrieval.budget_reservation SET state = $2, actual = $3, usage = $4, result = $5, detail = $6, settled_at = now() WHERE id = $1 RETURNING *`,
        [id, to, actual, fields.usage ? JSON.stringify(fields.usage) : null, fields.result === undefined ? null : JSON.stringify(fields.result), fields.detail ?? null])).rows[0];
    });
  }
  settleBudget(id, actual, fields) { return this.#close(id, "SETTLED", actual, fields); }
  releaseBudget(id, detail) { return this.#close(id, "RELEASED", 0, { detail }); }
  // An outcome nobody can know (the request was sent and no answer came): the whole reservation stays
  // counted, and the call key is never sent again (spec §24.2).
  async markBudgetUncertain(id, detail, usage = null) {
    await this.pool.query("UPDATE fcpi_retrieval.budget_reservation SET state = 'UNCERTAIN', detail = $2, usage = COALESCE($3, usage) WHERE id = $1 AND state = 'RESERVED'", [id, detail, usage ? JSON.stringify(usage) : null]);
  }

  // A call's reservation by its key, unless it was released (a released call never reached the provider; its row is kept
  // under a suffixed key, so it is not found here anyway).
  async reservationByCallKey(callKey) {
    return (await this.pool.query("SELECT * FROM fcpi_retrieval.budget_reservation WHERE call_key = $1 AND state <> 'RELEASED'", [callKey])).rows[0] ?? null;
  }

  // ---- proxy usage reconciliation (M6, reconcile.mjs) -------------------------------------------------------
  // One provider's rows of one UTC day: the bytes its proxy rows settled and measured while UNCERTAIN, the bytes earlier
  // reconciliations already charged (review C1: they are covered, never charged again), and how many proxy rows are
  // still RESERVED, whose bytes the provider may already report but the ledger does not yet hold.
  async proxyDay(provider, day) {
    const r = (await this.pool.query(`SELECT COALESCE(sum((usage->>'bytes')::bigint) FILTER (WHERE kind = 'proxy' AND state = 'SETTLED'), 0)::float8 AS settled,
        COALESCE(sum((usage->>'bytes')::bigint) FILTER (WHERE kind = 'proxy' AND state = 'UNCERTAIN'), 0)::float8 AS uncertain,
        COALESCE(sum((usage->>'bytes')::bigint) FILTER (WHERE kind = 'reconcile'), 0)::float8 AS adjusted,
        count(*) FILTER (WHERE kind = 'proxy' AND state = 'UNCERTAIN')::int AS n_uncertain, count(*) FILTER (WHERE kind = 'proxy' AND state = 'RESERVED')::int AS n_reserved
      FROM fcpi_retrieval.budget_reservation WHERE provider = $1 AND kind IN ('proxy', 'reconcile') AND day_start = $2`, [provider, day])).rows[0];
    return { settledBytes: r.settled, uncertainBytes: r.uncertain, adjustedBytes: r.adjusted, uncertain: r.n_uncertain, reserved: r.n_reserved };
  }
  // A charge the provider's report shows beyond what was measured: settled at once in each period its category caps
  // (and the paid total's day for a paid provider), past any cap, since it was already incurred. A period with no
  // usage row yet gets one, so a day nothing was reserved on still sees the charge (review W8).
  async recordAdjustment({ id, callKey, category, provider, subject, rateCard, amount, day, paidTotal, usage, periods: capped }) {
    const month = `${day.slice(0, 7)}-01`;
    await this.#tx(async (c) => {
      const periods = [];
      for (const [period, start] of [["day", day], ["month", month]].filter(([p]) => capped.includes(p))) {
        await c.query("INSERT INTO fcpi_retrieval.budget_usage (category, period, period_start) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING", [category, period, start]);
        await c.query("UPDATE fcpi_retrieval.budget_usage SET settled = settled + $4 WHERE category = $1 AND period = $2 AND period_start = $3", [category, period, start, amount]);
        periods.push(period);
      }
      if (paidTotal) {
        await c.query("INSERT INTO fcpi_retrieval.budget_usage (category, period, period_start) VALUES ('_paid_total', 'day', $1) ON CONFLICT DO NOTHING", [day]);
        await c.query("UPDATE fcpi_retrieval.budget_usage SET settled = settled + $2 WHERE category = '_paid_total' AND period = 'day' AND period_start = $1", [day, amount]);
      }
      await c.query(`INSERT INTO fcpi_retrieval.budget_reservation (id, call_key, logical_id, category, provider, subject, kind, unit, rate_card, request_hash, reserved, actual, state, day_start, month_start, paid_total, periods, usage, detail, settled_at)
        VALUES ($1, $2, $2, $3, $4, $5, 'reconcile', 'micro_usd', $6, 'reconcile', $7, $7, 'SETTLED', $8, $9, $10, $11, $12, 'the provider reported more bytes than were measured locally', now())`,
        [id, callKey, category, provider, subject, rateCard, amount, day, month, paidTotal, periods, JSON.stringify(usage)]);
    });
  }
  // Settles each UNCERTAIN proxy row of the day at the bytes it measured; costOf(bytes, subject) prices them.
  async settleUncertainProxy(provider, day, costOf) {
    const rows = (await this.pool.query("SELECT id, subject, (usage->>'bytes')::bigint AS bytes, reserved FROM fcpi_retrieval.budget_reservation WHERE provider = $1 AND kind = 'proxy' AND day_start = $2 AND state = 'UNCERTAIN'", [provider, day])).rows;
    let n = 0;
    for (const r of rows) {
      const cost = costOf(Number(r.bytes ?? 0), r.subject);
      if (cost === null) continue;
      if (await this.settleBudget(r.id, Math.min(cost, Number(r.reserved)), { usage: { bytes: Number(r.bytes ?? 0), reconciled: true }, detail: "settled at its measured bytes by reconciliation" })) n++;
    }
    return n;
  }
  async recordReconciliation({ provider, day, localBytes, providerBytes, adjustment, settledUncertain, detail }) {
    await this.pool.query("INSERT INTO fcpi_retrieval.proxy_reconciliation (provider, day, local_bytes, provider_bytes, adjustment_micro_usd, uncertain_settled, detail) VALUES ($1, $2, $3, $4, $5, $6, $7)",
      [provider, day, localBytes, providerBytes, adjustment, settledUncertain, detail]);
  }
  async budgetUsage(day, month) {
    return (await this.pool.query("SELECT category, period, period_start::text AS period_start, reserved::float8 AS reserved, settled::float8 AS settled FROM fcpi_retrieval.budget_usage WHERE (period = 'day' AND period_start = $1) OR (period = 'month' AND period_start = $2) ORDER BY category, period",
      [day, month])).rows;
  }
  // What calls of uncertain outcome hold in the month's caps, by category: a call sent whose answer never came keeps its whole
  // reservation and nothing settles it, so the status must show what is held.
  async uncertainHolds(month) {
    return (await this.pool.query("SELECT category, count(*)::int AS count, sum(reserved)::float8 AS reserved FROM fcpi_retrieval.budget_reservation WHERE state = 'UNCERTAIN' AND month_start = $1 GROUP BY category ORDER BY category", [month])).rows;
  }
  async reservationsFor(logicalId) {
    return (await this.pool.query("SELECT call_key, category, provider, subject, kind, unit, rate_card, reserved::float8 AS reserved, actual::float8 AS actual, state, usage, detail FROM fcpi_retrieval.budget_reservation WHERE logical_id = $1 ORDER BY created_at", [logicalId])).rows;
  }

  // ---- search (spec §13) ----------------------------------------------------------------------------
  async searchCacheGet(key) {
    return (await this.pool.query("SELECT response FROM fcpi_retrieval.search_cache WHERE key = $1 AND expires_at > now()", [key])).rows[0]?.response ?? null;
  }
  // Search intelligence: an entry with when it was stored and when it expires, so a recombination never outlives its inputs.
  async searchCacheEntry(key) {
    const row = (await this.pool.query("SELECT response, created_at, expires_at FROM fcpi_retrieval.search_cache WHERE key = $1 AND expires_at > now()", [key])).rows[0];
    return row ? { response: row.response, createdAt: row.created_at, expiresAt: row.expires_at } : null;
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

  // ---- domain routing (spec §9.5) and route holds (spec §10.2) ------------------------------------------------
  async routeRecord(domain) {
    return (await this.pool.query("SELECT * FROM fcpi_retrieval.domain_route WHERE domain = $1", [domain])).rows[0] ?? null;
  }
  // The one cheaper probe after a residential preference expired: claimed by one acquisition at a time, for
  // probeMinutes; true when this caller holds it.
  async claimProbe(domain, probeMinutes) {
    const r = await this.pool.query(`UPDATE fcpi_retrieval.domain_route SET probe_at = now(), updated_at = now()
      WHERE domain = $1 AND preferred = 'residential' AND expires_at <= now() AND (probe_at IS NULL OR probe_at <= now() - ($2::int * interval '1 minute'))
      RETURNING domain`, [domain, probeMinutes]);
    return r.rowCount === 1;
  }
  // Applies one observation (route.mjs observe) and the outcome counters in one transaction. The table holds at
  // most routing.maxRecords rows: a new row past the limit removes the least recently updated ones. last_reason
  // keeps the reason of the last change to what the record decides (the preference, the challenge count, the browser
  // start); an extension of an existing preference leaves it, so the record still says why the preference exists.
  async learnRoute(domain, obs, routing, { success = null, failureClass = null } = {}) {
    return this.#tx(async (c) => {
      // The row exists before it is locked, so concurrent first observations of a domain queue on it instead of each
      // starting from nothing and one overwriting the other (review S5).
      const created = (await c.query("INSERT INTO fcpi_retrieval.domain_route (domain) VALUES ($1) ON CONFLICT DO NOTHING", [domain])).rowCount === 1;
      const locked = (await c.query("SELECT * FROM fcpi_retrieval.domain_route WHERE domain = $1 FOR UPDATE", [domain])).rows[0];
      const cur = created ? null : locked;
      const change = obs ? observe(cur, obs, routing) : null;
      if (!cur && !change && success === null) return null;
      const next = { ...(cur ?? { preferred: null, set_at: null, expires_at: null, probe_at: null, challenges: 0, js_count: 0, prefer_browser: false, browser_expires_at: null, successes: 0, failures: 0 }), ...(change ?? {}) };
      if (success === true) { next.successes = Number(next.successes) + 1; next.last_success_at = new Date(); }
      if (success === false) { next.failures = Number(next.failures) + 1; next.last_failure_at = new Date(); next.last_failure_class = failureClass; }
      const row = (await c.query(
        `INSERT INTO fcpi_retrieval.domain_route (domain, preferred, set_at, expires_at, probe_at, challenges, js_count, prefer_browser, browser_expires_at,
           successes, failures, last_success_at, last_failure_at, last_failure_class, last_reason, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, now())
         ON CONFLICT (domain) DO UPDATE SET preferred = EXCLUDED.preferred, set_at = EXCLUDED.set_at, expires_at = EXCLUDED.expires_at, probe_at = EXCLUDED.probe_at,
           challenges = EXCLUDED.challenges, js_count = EXCLUDED.js_count, prefer_browser = EXCLUDED.prefer_browser, browser_expires_at = EXCLUDED.browser_expires_at,
           successes = EXCLUDED.successes, failures = EXCLUDED.failures, last_success_at = EXCLUDED.last_success_at, last_failure_at = EXCLUDED.last_failure_at,
           last_failure_class = EXCLUDED.last_failure_class, last_reason = COALESCE(EXCLUDED.last_reason, fcpi_retrieval.domain_route.last_reason), updated_at = now()
         RETURNING *`,
        [domain, next.preferred ?? null, next.set_at ?? null, next.expires_at ?? null, next.probe_at ?? null, next.challenges ?? 0, next.js_count ?? 0, next.prefer_browser === true,
          next.browser_expires_at ?? null, next.successes ?? 0, next.failures ?? 0, next.last_success_at ?? null, next.last_failure_at ?? null, next.last_failure_class ?? null,
          change && ["preferred", "challenges", "prefer_browser", "js_count"].some((k) => k in change) ? change.reason : null])).rows[0];
      // Past the bound, rows that decide nothing go first, the least recently updated of them; a learned preference is
      // evicted only when preferences alone fill the table (review S5).
      if (created) await c.query(`DELETE FROM fcpi_retrieval.domain_route WHERE domain IN (SELECT domain FROM fcpi_retrieval.domain_route
        ORDER BY (preferred IS NOT NULL OR prefer_browser) DESC, updated_at DESC OFFSET $1)`, [routing.maxRecords]);
      return { row, change };
    });
  }
  // A job's explicit, finite route hold: while it lasts every acquisition of those domains needs the residential
  // route (spec §10.2: bulk work starts on approved proxy egress). until is capped by the caller.
  async holdRoutes(jobId, domains, until, reason) {
    await this.#tx(async (c) => {
      for (const d of domains) {
        await c.query(`INSERT INTO fcpi_retrieval.route_hold (domain, job_id, reason, until) VALUES ($1, $2, $3, $4)
          ON CONFLICT (domain, job_id) DO UPDATE SET until = GREATEST(fcpi_retrieval.route_hold.until, EXCLUDED.until), reason = EXCLUDED.reason`, [d, jobId, reason, until]);
      }
    });
  }
  async releaseRoutes(jobId) {
    return (await this.pool.query("DELETE FROM fcpi_retrieval.route_hold WHERE job_id = $1", [jobId])).rowCount;
  }
  async routeHeld(domain) {
    return (await this.pool.query("SELECT job_id FROM fcpi_retrieval.route_hold WHERE domain = $1 AND until > now() LIMIT 1", [domain])).rowCount === 1;
  }

  // ---- provider availability (search intelligence, spec §15, §16) --------------------------------------------
  async availabilityRows() {
    return (await this.pool.query("SELECT * FROM fcpi_retrieval.provider_availability ORDER BY provider, profile")).rows;
  }
  // One provider account's state, replaced whole: what is observed now is the state.
  async setAvailability({ provider, profile = "default", state, reason = null, providerCode = null, retryAt = null, retryBasis = "unknown", credentialEpoch = null, contractFailures = 0, balance = null }) {
    return (await this.pool.query(`INSERT INTO fcpi_retrieval.provider_availability (provider, profile, state, reason, provider_code, observed_at, retry_at, retry_basis, credential_epoch, contract_failures, balance, updated_at)
      VALUES ($1, $2, $3, $4, $5, now(), $6, $7, $8, $9, $10, now())
      ON CONFLICT (provider, profile) DO UPDATE SET state = EXCLUDED.state, reason = EXCLUDED.reason, provider_code = EXCLUDED.provider_code, observed_at = now(), retry_at = EXCLUDED.retry_at,
        retry_basis = EXCLUDED.retry_basis, credential_epoch = EXCLUDED.credential_epoch, contract_failures = EXCLUDED.contract_failures, balance = COALESCE(EXCLUDED.balance, fcpi_retrieval.provider_availability.balance), updated_at = now()
      RETURNING *`, [provider, profile, state, reason, providerCode, retryAt, retryBasis, credentialEpoch, contractFailures, balance ? JSON.stringify(balance) : null])).rows[0];
  }

  // ---- search intelligence operational records (spec §21.1) ---------------------------------------------------
  // A logical execution's row: written when it is admitted, completed when it ends. The finish inserts too, so a lost start
  // costs nothing; a repeated finish replaces the same row.
  async searchRunStarted(r) {
    await this.pool.query(`INSERT INTO fcpi_retrieval.search_run (logical_id, request_id, principal_id, job_id, fingerprint, profile, selection, result_mode, accepted_at, versions)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) ON CONFLICT (logical_id) DO NOTHING`,
    [r.logicalId, r.requestId, r.principalId, r.jobId ?? null, r.fingerprint, r.profile, r.selection, r.resultMode, r.acceptedAt, JSON.stringify(r.versions)]);
  }
  async searchRunFinished(r) {
    await this.pool.query(`INSERT INTO fcpi_retrieval.search_run (logical_id, request_id, principal_id, job_id, fingerprint, profile, selection, result_mode, accepted_at, versions,
        completed_at, outcome, cache_mode, docs_active, docs_reason, ranking_mode, summary, trace, trace_truncated)
      VALUES ($1, $2, $3, $19, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18)
      ON CONFLICT (logical_id) DO UPDATE SET completed_at = EXCLUDED.completed_at, outcome = EXCLUDED.outcome, cache_mode = EXCLUDED.cache_mode, docs_active = EXCLUDED.docs_active,
        docs_reason = EXCLUDED.docs_reason, ranking_mode = EXCLUDED.ranking_mode, summary = EXCLUDED.summary, trace = EXCLUDED.trace, trace_truncated = EXCLUDED.trace_truncated`,
    [r.logicalId, r.requestId, r.principalId, r.fingerprint, r.profile, r.selection, r.resultMode, r.acceptedAt, JSON.stringify(r.versions), r.completedAt, r.outcome, r.cacheMode ?? null,
      r.docsActive ?? null, r.docsReason ?? null, r.rankingMode ?? null, r.summary ? JSON.stringify(r.summary) : null, r.trace ? JSON.stringify(r.trace) : null, r.traceTruncated === true, r.jobId ?? null]);
  }
  // Operation outcomes and transitions; an event id seen before is not written again.
  async searchEvents(events) {
    if (!events.length) return 0;
    const cols = ["event_id", "logical_id", "operation", "provider", "event_type", "observed_at", "started_at", "duration_ms", "queue_ms", "status", "reason", "code", "retry_at",
      "result_count", "eligible_count", "cache_origin", "dispatch_state", "detail"];
    const values = [], params = [];
    for (const e of events) {
      const row = [e.eventId, e.logicalId ?? null, e.operation ?? null, e.provider, e.type, e.observedAt, e.startedAt ?? null, e.durationMs ?? null, e.queueMs ?? null, e.status ?? null,
        e.reason ?? null, e.code ?? null, e.retryAt ?? null, e.resultCount ?? null, e.eligibleCount ?? null, e.cacheOrigin ?? null, e.dispatchState ?? null, e.detail ? JSON.stringify(e.detail) : null];
      values.push(`(${row.map((_, i) => `$${params.length + i + 1}`).join(", ")})`);
      params.push(...row);
    }
    return (await this.pool.query(`INSERT INTO fcpi_retrieval.search_event (${cols.join(", ")}) VALUES ${values.join(", ")} ON CONFLICT (event_id) DO NOTHING`, params)).rowCount;
  }
  // The daily reduction (spec §21.1): activity (runs and events) for the days from the watermark on, the watermark's own day
  // again since a run can finish after midnight, at most seven days a pass so a backlog is caught up in bounded steps within
  // the statement timeout; ledger-linked usage for the 89 days the ledger still holds whole (its rows go at 90), since a
  // reservation can settle or be reconciled long after its day. Each covered day is recomputed whole from its sources, so a
  // repeat changes nothing; usage comes from the ledger only, never from counting results, cache hits or shared callers, and
  // its dimension comes from the ledger row too (a search intelligence call key, search:<logical id>:<provider>:..., or
  // unlinked, with its category), so it does not change when the run it served is pruned.
  async reduceSearchDaily() {
    return this.#tx(async (c) => {
      await c.query("SELECT pg_advisory_xact_lock(hashtext('fcpi.search.reduction'))");
      const w = (await c.query("SELECT reduced_through::text AS w FROM fcpi_retrieval.search_reduction WHERE name = 'daily'")).rows[0]?.w ?? null;
      const { from, through } = (await c.query(`WITH f AS (SELECT COALESCE($1::date, LEAST((SELECT min(accepted_at AT TIME ZONE 'UTC')::date FROM fcpi_retrieval.search_run), (SELECT min(observed_at AT TIME ZONE 'UTC')::date FROM fcpi_retrieval.search_event)),
        (now() AT TIME ZONE 'UTC')::date - 1) AS d)
        SELECT d::text AS from, LEAST(d + 6, (now() AT TIME ZONE 'UTC')::date - 1)::text AS through FROM f`, [w])).rows[0];
      // A duration histogram key is the number of these edges (ms) at or below the duration: 0 is under 100 ms, 9 is 30 s or more.
      const buckets = "ARRAY[100, 250, 500, 1000, 2000, 4000, 8000, 15000, 30000]";
      if (from <= through) {
        await c.query("DELETE FROM fcpi_retrieval.search_daily WHERE day BETWEEN $1 AND $2 AND metric NOT LIKE 'usage.%'", [from, through]);
        // The days as UTC instants, so the time indexes serve the range.
        const inRange = (col) => `${col} >= ($1::date)::timestamp AT TIME ZONE 'UTC' AND ${col} < ($2::date + 1)::timestamp AT TIME ZONE 'UTC'`;
        await c.query(`WITH src AS (
            SELECT (accepted_at AT TIME ZONE 'UTC')::date AS day, profile || '/' || selection AS profile, '*' AS provider, 'runs.' || COALESCE(outcome, 'unfinished') AS metric,
              (extract(epoch FROM (completed_at - accepted_at)) * 1000)::bigint AS ms
              FROM fcpi_retrieval.search_run WHERE ${inRange("accepted_at")}
            UNION ALL SELECT (accepted_at AT TIME ZONE 'UTC')::date, profile || '/' || selection, '*', 'runs.cache_' || cache_mode, NULL
              FROM fcpi_retrieval.search_run WHERE cache_mode IS NOT NULL AND ${inRange("accepted_at")}
            UNION ALL SELECT (accepted_at AT TIME ZONE 'UTC')::date, profile || '/' || selection, '*', 'runs.docs_' || CASE WHEN docs_active THEN 'active' ELSE 'inactive' END, NULL
              FROM fcpi_retrieval.search_run WHERE docs_active IS NOT NULL AND ${inRange("accepted_at")}
            UNION ALL SELECT (e.observed_at AT TIME ZONE 'UTC')::date, COALESCE(r.profile || '/' || r.selection, 'process'), e.provider, e.event_type || '.' || COALESCE(e.status, 'unknown'), e.duration_ms::bigint
              FROM fcpi_retrieval.search_event e LEFT JOIN fcpi_retrieval.search_run r USING (logical_id) WHERE ${inRange("e.observed_at")}
          ), b AS (SELECT *, CASE WHEN ms IS NULL THEN NULL ELSE width_bucket(ms, ${buckets}) END AS bucket FROM src),
          h AS (SELECT day, profile, provider, metric, jsonb_object_agg(bucket::text, n) AS histogram
            FROM (SELECT day, profile, provider, metric, bucket, count(*) AS n FROM b WHERE bucket IS NOT NULL GROUP BY 1, 2, 3, 4, 5) x GROUP BY 1, 2, 3, 4)
          INSERT INTO fcpi_retrieval.search_daily (day, profile, provider, metric, n, total_ms, histogram)
          SELECT g.day, g.profile, g.provider, g.metric, g.n, g.total_ms, h.histogram
            FROM (SELECT day, profile, provider, metric, count(*) AS n, sum(ms) AS total_ms FROM b GROUP BY 1, 2, 3, 4) g LEFT JOIN h USING (day, profile, provider, metric)`, [from, through]);
      }
      await c.query("DELETE FROM fcpi_retrieval.search_daily WHERE day >= (now() AT TIME ZONE 'UTC')::date - 89 AND metric LIKE 'usage.%'");
      await c.query(`INSERT INTO fcpi_retrieval.search_daily (day, profile, provider, metric, n, amount)
        SELECT b.day_start, CASE WHEN b.call_key LIKE 'search:%:%:%' THEN 'search' ELSE 'unlinked' END || '/' || b.category, b.provider, 'usage.' || b.kind || '.' || b.unit || '.' || lower(b.state), count(*),
          sum(CASE b.state WHEN 'SETTLED' THEN COALESCE(b.actual, 0) WHEN 'RELEASED' THEN 0 ELSE b.reserved END)
          FROM fcpi_retrieval.budget_reservation b
          WHERE b.kind IN ('search', 'docs_search', 'docs_read', 'decision') AND b.day_start >= (now() AT TIME ZONE 'UTC')::date - 89
          GROUP BY 1, 2, 3, 4`);
      if (from <= through) await c.query(`INSERT INTO fcpi_retrieval.search_reduction (name, reduced_through) VALUES ('daily', $1)
        ON CONFLICT (name) DO UPDATE SET reduced_through = GREATEST(fcpi_retrieval.search_reduction.reduced_through, EXCLUDED.reduced_through), updated_at = now()`, [through]);
      return { from, through };
    });
  }

  // Bounded history: attempt rows and navigation counts older than their use are removed, and so is
  // a domain's pacing row once it holds nothing a decision reads: no live hold, no cooldown ended
  // within the hour that doubling looks back over, no navigation within direct_nav's two days
  // (review finding S5).
  // retainCategories: the categories whose reservations sum to a lifetime allocation (Serper's credits, spec §18.3): their
  // rows are kept whatever their age, since pruning them would return spent credits. Without it, search rows are kept, as before.
  async prune({ retainCategories = null } = {}) {
    await this.pool.query("DELETE FROM fcpi_retrieval.direct_nav WHERE at < now() - interval '2 days'");
    await this.pool.query(
      `DELETE FROM fcpi_retrieval.domain_state WHERE (holder IS NULL OR hold_until < now())
         AND (cooldown_until IS NULL OR cooldown_until < now() - interval '1 hour') AND (last_nav_at IS NULL OR last_nav_at < now() - interval '2 days')`);
    await this.pool.query("DELETE FROM fcpi_retrieval.attempt WHERE started_at < now() - interval '30 days'");
    await this.pool.query("DELETE FROM fcpi_retrieval.acquisition WHERE updated_at < now() - interval '30 days'");
    await this.pool.query("DELETE FROM fcpi_retrieval.search_cache WHERE expires_at < now()");
    await this.pool.query("DELETE FROM fcpi_retrieval.search_query WHERE at < now() - interval '2 days'");
    await this.pool.query("DELETE FROM fcpi_retrieval.parse_cache WHERE expires_at < now()");
    // M6: holds past their end, and routing records that neither prefer anything nor were touched in seven days.
    await this.pool.query("DELETE FROM fcpi_retrieval.route_hold WHERE until < now()");
    await this.pool.query(`DELETE FROM fcpi_retrieval.domain_route WHERE updated_at < now() - interval '7 days'
      AND (preferred IS NULL OR expires_at < now() - interval '7 days') AND NOT prefer_browser`);
    // Usage records outlive the 30 days of job metadata (spec §21.3) so a month's spend stays explainable;
    // an unsettled reservation is never pruned, since it still counts against its cap.
    if (retainCategories) await this.pool.query("DELETE FROM fcpi_retrieval.budget_reservation WHERE created_at < now() - interval '90 days' AND state IN ('SETTLED', 'RELEASED') AND NOT (category = ANY($1::text[]))", [retainCategories]);
    else await this.pool.query("DELETE FROM fcpi_retrieval.budget_reservation WHERE created_at < now() - interval '90 days' AND state IN ('SETTLED', 'RELEASED') AND kind <> 'search'");
    // A settled call's stored answer (page content) serves only a retry of its logical unit, so it goes after
    // the seven days that job results and parse caches keep; the amounts and usage stay (review W9).
    await this.pool.query("UPDATE fcpi_retrieval.budget_reservation SET result = NULL WHERE result IS NOT NULL AND settled_at < now() - interval '7 days'");
    // Search intelligence operational records (spec §21.1): runs 30 days, their candidate traces 14, daily aggregates 90;
    // detailed events 14 days. A run or event goes only once the daily reduction has moved past its day (strictly: the
    // watermark's own day is reduced again), so a stalled reduction never loses a source it will still recompute from. The
    // ledger rows they refer to keep their own retention.
    await this.pool.query("UPDATE fcpi_retrieval.search_run SET trace = NULL WHERE trace IS NOT NULL AND accepted_at < now() - interval '14 days'");
    await this.pool.query(`DELETE FROM fcpi_retrieval.search_run WHERE accepted_at < now() - interval '30 days'
      AND (accepted_at AT TIME ZONE 'UTC')::date < (SELECT reduced_through FROM fcpi_retrieval.search_reduction WHERE name = 'daily')`);
    await this.pool.query(`DELETE FROM fcpi_retrieval.search_event WHERE observed_at < now() - interval '14 days'
      AND (observed_at AT TIME ZONE 'UTC')::date < (SELECT reduced_through FROM fcpi_retrieval.search_reduction WHERE name = 'daily')`);
    await this.pool.query("DELETE FROM fcpi_retrieval.search_daily WHERE day < (now() AT TIME ZONE 'UTC')::date - 90");
  }

  async close() { await this.pool.end(); }
}
