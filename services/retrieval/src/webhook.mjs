// Webhook delivery (FIRECRAWL_PI_SPEC.md §31.3, AC20). The gateway keeps the outbox (event ids, retries, dead letters)
// in its ledger; it cannot reach a network itself, so each attempt comes here, where egress is policed:
//   - the destination must be one of the egress policy's webhooks.destinations, exactly; none is by default, and a job
//     cannot ask for another (the gateway asks check() before it accepts one);
//   - it is reached as a provider is (provider.mjs): the name validated and resolved (public addresses only, a listed
//     fixture on its fixture network), the connection made to exactly that address, TLS verified, no redirect followed,
//     the answer read to a small cap, within the policy's timeout;
//   - each attempt is signed afresh: x-fcpi-timestamp (Unix seconds), x-fcpi-event-id (the event's own id, the same on
//     every attempt, for the receiver to deduplicate), and x-fcpi-signature "v1=" + HMAC-SHA256 over
//     "<timestamp>.<event id>.<body>" with the shared secret. A receiver checks the signature, refuses a timestamp far
//     from its clock, and acknowledges an event id it has seen again without acting twice (delivery is at least once);
//   - while PI_WEBHOOK_DELIVERY is "suppressed" (a restore, a rollback) nothing is sent and the gateway keeps the event.
// Only a 2xx answer is a delivery; anything else, and any failure to connect, is a failed attempt the gateway retries.
import { createHmac } from "node:crypto";
import { providerRequest, ProviderError } from "./provider.mjs";

export function makeWebhooks({ getPolicy, resolvePublic, lookupFixture, getSecret, delivery, log }) {
  const approved = (url) => typeof url === "string" && getPolicy().webhooks.destinations.includes(url);

  // Whether a job may name this destination; answered before its receipt is written.
  function check(url) {
    if (!approved(url)) return { allowed: false, reason: getPolicy().webhooks.destinations.length ? "NOT_APPROVED" : "NONE_APPROVED" };
    if (!getSecret()) return { allowed: false, reason: "NO_SIGNING_SECRET" };
    return { allowed: true, reason: null, delivery };
  }

  // One attempt. Resolves { delivered, status, class?, detail? }.
  async function deliver({ eventId, url, body }) {
    if (typeof eventId !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(eventId)) return { delivered: false, class: "INVALID_REQUEST", detail: "eventId must be a UUID" };
    if (typeof body !== "string" || Buffer.byteLength(body) > 65536) return { delivered: false, class: "INVALID_REQUEST", detail: "body must be a string of at most 64 KiB" };
    if (delivery !== "enabled") return { delivered: false, class: "WEBHOOKS_SUPPRESSED", detail: "webhook delivery is suppressed (PI_WEBHOOK_DELIVERY)" };
    if (!approved(url)) return { delivered: false, class: "WEBHOOK_DESTINATION_NOT_APPROVED", detail: "the destination is not in the egress policy's webhooks.destinations" };
    const secret = getSecret();
    if (!secret) return { delivered: false, class: "NO_SIGNING_SECRET", detail: "the webhook signing secret is absent" };
    const timestamp = String(Math.floor(Date.now() / 1000));
    const signature = createHmac("sha256", secret).update(`${timestamp}.${eventId}.`).update(body).digest("hex");
    const u = new URL(url);
    const started = Date.now();
    try {
      const r = await providerRequest({ baseUrl: u.origin, path: u.pathname, method: "POST", body: Buffer.from(body), timeoutMs: getPolicy().webhooks.timeoutMs, maxBytes: 65536,
        headers: { "content-type": "application/json", "user-agent": "fcpi-webhooks/1", "x-fcpi-event-id": eventId, "x-fcpi-timestamp": timestamp, "x-fcpi-signature": `v1=${signature}` },
        getPolicy, resolvePublic, lookupFixture });
      const delivered = r.status >= 200 && r.status < 300;
      log({ event: "webhook_attempt", event_id: eventId, status: r.status, delivered, ms: Date.now() - started });
      return delivered ? { delivered: true, status: r.status } : { delivered: false, status: r.status, class: "WEBHOOK_REFUSED", detail: `the receiver answered HTTP ${r.status}` };
    } catch (e) {
      if (!(e instanceof ProviderError)) throw e;
      // PROVIDER_DENIED: the destination's name resolved where this deployment may not go (spec §20.2).
      const cls = e.code === "PROVIDER_DENIED" ? "SSRF_DENIED" : "WEBHOOK_UNREACHABLE";
      log({ event: "webhook_attempt", event_id: eventId, status: null, delivered: false, failure: cls, ms: Date.now() - started });
      return { delivered: false, status: null, class: cls, detail: e.message };
    }
  }
  return { check, deliver };
}
