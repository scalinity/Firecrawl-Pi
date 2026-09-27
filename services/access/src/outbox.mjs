// The webhook outbox's delivery round (FIRECRAWL_PI_SPEC.md §31.3, AC20; M7). Events are written by the job
// transitions that raise them (store.mjs raise); this round takes the due ones, a few at a time under a lease, and
// hands each to the retrieval service, which alone may reach a network and signs every attempt (its webhook.mjs):
//   - delivered (a 2xx) → DELIVERED;
//   - refused or unreachable → retried after retryBaseSeconds × 2^(attempt - 1), DEAD after maxAttempts, and a DEAD
//     event stays on its job's receipt with its last status and error (the dead letter);
//   - a destination the egress policy no longer approves → DEAD at once;
//   - delivery suppressed (a restore, a rollback), no signing secret, or the retrieval service not reached, not ready
//     (503) or refusing the gateway's own token (401, 403) → not an attempt: the event waits, unchanged, and is tried
//     again later; any other answer from the retrieval service counts as a failed attempt, so an event that makes it
//     fail every time still ends DEAD (review S2).
// Delivery is at least once: a receiver deduplicates on the event id, the same on every attempt.
// One round's events, and the lease that covers them all at the retrieval service's delivery timeout (extractor.mjs).
const ROUND = 5, DELIVER_TIMEOUT_S = 20;
const LEASE_S = ROUND * DELIVER_TIMEOUT_S + 20;
const WAIT = new Set(["WEBHOOKS_SUPPRESSED", "NO_SIGNING_SECRET", "HTTP_503", "HTTP_401", "HTTP_403"]);
export function makeOutbox({ store, extractor, limits, log }) {
  const W = limits.webhooks;
  let timer = null, running = null;
  async function round() {
    for (const e of await store.claimWebhooks(ROUND, LEASE_S)) {
      let r;
      try { r = await extractor.webhookDeliver({ eventId: e.id, url: e.destination, body: e.body }); }
      catch (err) { await store.webhookDefer(e.id, 60, `the retrieval service was not reached (${err.code})`); log({ event: "webhook", id: e.id, action: "deferred", reason: err.code }); continue; }
      const a = r.status === 200 ? r.json : null;
      if (a?.delivered === true) { await store.webhookDelivered(e.id, a.status); log({ event: "webhook", id: e.id, type: e.type, action: "delivered", status: a.status, attempt: e.attempts + 1 }); continue; }
      const cls = a?.class ?? `HTTP_${r.status}`;
      if (WAIT.has(cls)) { await store.webhookDefer(e.id, 60, cls); log({ event: "webhook", id: e.id, action: "deferred", reason: cls }); continue; }
      const final = cls === "WEBHOOK_DESTINATION_NOT_APPROVED" || cls === "INVALID_REQUEST";
      await store.webhookFailed(e.id, { status: a?.status ?? null, error: `${cls}: ${a?.detail ?? r.json?.error ?? ""}`, maxAttempts: W.maxAttempts, retryBaseS: W.retryBaseSeconds, final });
      log({ event: "webhook", id: e.id, type: e.type, action: final || e.attempts + 1 >= W.maxAttempts ? "dead" : "retry", reason: cls, status: a?.status ?? null, attempt: e.attempts + 1 });
    }
  }
  const tick = () => { if (!running) running = round().catch((e) => log({ event: "webhook", action: "round_failed", error: e.message })).finally(() => { running = null; }); return running; };
  return {
    start() { timer = setInterval(tick, W.pollSeconds * 1000); tick(); },
    stop() { clearInterval(timer); timer = null; return running ?? Promise.resolve(); },
    tick,
  };
}
