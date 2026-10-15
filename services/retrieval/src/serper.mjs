// Google results through Serper's existing credit allocation. No retries, purchases,
// alternate provider, or LLM calls; an uncertain dispatch retains its reservation.
import { createHash, randomUUID } from "node:crypto";
import { Breaker, periodStarts, rateCardFor } from "./budget.mjs";
import { providerRequest, readCredential } from "./provider.mjs";
import { Denied } from "./ssrf.mjs";

export function makeSerper({ store, getBudget, getPolicy, providersDir, resolvePublic, lookupFixture, log, request = providerRequest }) {
  const breakers = new Map();
  const breakerFor = (name) => breakers.get(name) ?? breakers.set(name, new Breaker(getBudget().breaker)).get(name);
  return {
    selected: () => getBudget().searching?.defaultSearch ?? null,
    breakerState: (name) => breakerFor(name).state(),
    async search(q, language, { signal: callerSignal, timeoutMs } = {}) {
      const configuredTimeout = getBudget().searching?.requestTimeoutMs ?? 7000;
      const timeout = AbortSignal.timeout(Math.max(1, Math.min(timeoutMs ?? configuredTimeout, configuredTimeout)));
      const signal = callerSignal ? AbortSignal.any([callerSignal, timeout]) : timeout;
      const fail = (cls) => new Denied(cls, "Google search through Serper is unavailable");
      if (signal.aborted) throw fail(callerSignal?.aborted ? "CANCELLED" : "SEARCH_PROVIDER_TIMEOUT");
      let onAbort;
      const aborted = new Promise((_, reject) => {
        onAbort = () => reject(fail(callerSignal?.aborted ? "CANCELLED" : "SEARCH_PROVIDER_TIMEOUT"));
        signal.addEventListener("abort", onAbort, { once: true });
      });
      // The work may finish admission/DNS after the caller's deadline. Its own cancellation
      // checks prevent a late send and close an unsent reservation once admission returns.
      const work = (async () => {
        const b = getBudget(), subject = b.searching?.defaultSearch, s = b.searches?.[subject];
        if (!s) throw fail("SEARCH_PROVIDER_DISABLED");
        if (signal.aborted) throw fail(callerSignal?.aborted ? "CANCELLED" : "SEARCH_PROVIDER_TIMEOUT");
        const p = b.providers[s.provider], c = b.categories[s.category], card = rateCardFor(b, subject);
        if (!card) throw fail("SEARCH_RATE_CARD_MISSING");
        const key = readCredential(providersDir, p.credential);
        if (!key) throw fail("BLOCKED_CREDENTIAL");
        const breaker = breakerFor(s.provider);
        if (!breaker.admit()) throw fail("SEARCH_PROVIDER_BREAKER_OPEN");
        const id = randomUUID(), body = Buffer.from(JSON.stringify({ q, num: 10, ...(language === "auto" ? {} : { hl: language.split("-")[0].toLowerCase() }) }));
        const requestHash = createHash("sha256").update(body).digest("hex");
        let reservation, sent = false, closed = false;
        try {
          const r = await store.reserveBudget({ id, callKey: `search:${id}`, logicalId: id, category: s.category, provider: s.provider,
            subject, kind: "search", unit: "credits", rateCard: card.id, requestHash, amount: card.creditsPerSearch,
            ...periodStarts(), caps: c.caps, lifetimeCap: b.searching.allocationCredits, paidTotalCap: null, notifyAt: b.notifyAtFraction });
          if (!r.reservation) throw fail("SEARCH_CREDITS_EXHAUSTED");
          reservation = r.reservation;
          if (signal.aborted) throw Object.assign(fail("SEARCH_PROVIDER_TIMEOUT"), { sent: false });
          for (const notice of r.notices ?? []) log({ event: "budget_threshold", ...notice });
          const response = await request({ baseUrl: p.baseUrl, path: "/search", headers: { "X-API-KEY": key, "content-type": "application/json", accept: "application/json" }, body,
            timeoutMs: Math.min(timeoutMs ?? b.searching.requestTimeoutMs, b.searching.requestTimeoutMs), maxBytes: b.searching.maxResponseBytes,
            getPolicy, resolvePublic, lookupFixture, signal, authorize: () => !signal?.aborted });
          sent = true;
          if (response.status !== 200) throw fail(`SEARCH_PROVIDER_HTTP_${response.status}`);
          let data;
          try { data = JSON.parse(response.body.toString("utf8")); } catch { throw fail("SEARCH_PROVIDER_INVALID_RESPONSE"); }
          if (!Array.isArray(data?.organic) || data.credits !== 1) throw fail("SEARCH_PROVIDER_INVALID_RESPONSE");
          const results = data.organic.flatMap((x) => {
            try {
              const u = new URL(x.link);
              if (!["http:", "https:"].includes(u.protocol) || u.username || u.password || x.link.length > 2048) return [];
              return [{ url: x.link, title: typeof x.title === "string" ? x.title.slice(0, 500) : "", content: typeof x.snippet === "string" ? x.snippet.slice(0, 2000) : "" }];
            } catch { return []; }
          }).slice(0, 10);
          if (data.organic.length && !results.length) throw fail("SEARCH_PROVIDER_INVALID_RESPONSE");
          await store.settleBudget(reservation.id, 1, { usage: { credits: 1 }, detail: "Serper Google search" });
          closed = true;
          breaker.success();
          log({ event: "search_provider", provider: s.provider, logical_id: id, query_sha256: requestHash, credits: 1, outcome: "results" });
          return results;
        } catch (e) {
          if (e.failureClass === "SEARCH_CREDITS_EXHAUSTED" || callerSignal?.aborted || (!reservation && e.failureClass)) breaker.success();
          else breaker.failure();
          if (reservation && !closed) {
            if (sent || e.sent !== false) await store.markBudgetUncertain(reservation.id, "search dispatch outcome unknown");
            else await store.releaseBudget(reservation.id, "search request not sent");
          }
          if (signal.aborted) throw fail(callerSignal?.aborted ? "CANCELLED" : "SEARCH_PROVIDER_TIMEOUT");
          throw fail(e.failureClass ?? e.code ?? "SEARCH_PROVIDER_ERROR");
        }
      })();
      try { return await Promise.race([work, aborted]); }
      finally { signal.removeEventListener("abort", onAbort); }
    },
  };
}
