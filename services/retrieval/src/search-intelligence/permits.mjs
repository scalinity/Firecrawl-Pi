// Outbound capacity for search intelligence (docs/FIRECRAWL_PI_SEARCH_INTELLIGENCE_SPEC.md §14.1): lightweight permits that
// bound how many provider requests are open at once, apart from the browser and URL-acquisition permits, which they never
// touch. A request takes every key it needs at once (the global pool, its provider's, its search's) or waits; waiting
// consumes the caller's own deadline and ends unsent when the caller cancels. Waiters are served fairly across searches:
// the waiter whose search holds the fewest permits goes first, then the oldest, so a many-scope documentation search cannot
// monopolize the pool. A Ref session's receive stream takes a stream slot of its own, never a request permit, so open
// sessions cannot deadlock the tool calls they wait for.
import { ProviderError } from "../provider.mjs";

// A wait that ran out of time for capacity, not for the provider: reported as capacity_unavailable.
const capacityTimeout = (detail) => Object.assign(new ProviderError("PROVIDER_TIMEOUT", detail, { sent: false, timedOut: true }), { capacity: true });

export class PermitPool {
  constructor() { this.held = new Map(); this.bySearch = new Map(); this.waiters = []; this.seq = 0; }
  #fits(keys) { return keys.every(({ key, limit }) => (this.held.get(key) ?? 0) < limit); }
  #take(keys, searchId) {
    for (const { key } of keys) this.held.set(key, (this.held.get(key) ?? 0) + 1);
    this.bySearch.set(searchId, (this.bySearch.get(searchId) ?? 0) + 1);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      for (const { key } of keys) this.held.set(key, this.held.get(key) - 1);
      this.bySearch.set(searchId, this.bySearch.get(searchId) - 1);
      if (!this.bySearch.get(searchId)) this.bySearch.delete(searchId);
      this.#drain();
    };
  }
  #drain() {
    for (;;) {
      const ready = this.waiters.filter((w) => this.#fits(w.keys));
      if (!ready.length) return;
      ready.sort((a, b) => (this.bySearch.get(a.searchId) ?? 0) - (this.bySearch.get(b.searchId) ?? 0) || a.seq - b.seq);
      const w = ready[0];
      this.waiters.splice(this.waiters.indexOf(w), 1);
      w.grant(this.#take(w.keys, w.searchId));
    }
  }
  // keys: [{ key, limit }]. Resolves to a release function; rejects unsent on cancellation or the deadline.
  acquire(keys, searchId, { signal = null, deadlineAt = null } = {}) {
    if (signal?.aborted) return Promise.reject(new ProviderError("CANCELLED", "the caller cancelled", { sent: false }));
    if (!this.waiters.length && this.#fits(keys)) return Promise.resolve(this.#take(keys, searchId));
    return new Promise((resolve, reject) => {
      let timer = null;
      const w = { keys, searchId, seq: this.seq++ };
      const done = () => { clearTimeout(timer); signal?.removeEventListener("abort", onAbort); };
      const leave = (e) => { const i = this.waiters.indexOf(w); if (i >= 0) { this.waiters.splice(i, 1); done(); reject(e); } };
      const onAbort = () => leave(new ProviderError("CANCELLED", "the caller cancelled while waiting for capacity", { sent: false }));
      w.grant = (release) => { done(); resolve(release); };
      signal?.addEventListener("abort", onAbort, { once: true });
      if (deadlineAt !== null) timer = setTimeout(() => leave(capacityTimeout("the deadline passed while waiting for capacity")), Math.max(0, deadlineAt - Date.now()));
      this.waiters.push(w);
      this.#drain();
    });
  }
  snapshot() { return { held: Object.fromEntries([...this.held].filter(([, n]) => n > 0)), waiting: this.waiters.length }; }
}

// A process-wide token bucket (DeepSeek's documented Search QPS): a search waits for its token within its own deadline.
export class TokenBucket {
  constructor(perSecond, now = () => Date.now()) { this.rate = perSecond; this.tokens = perSecond; this.at = now(); this.now = now; this.queue = Promise.resolve(); }
  #refill() { const t = this.now(); this.tokens = Math.min(this.rate, this.tokens + ((t - this.at) / 1000) * this.rate); this.at = t; }
  take({ signal = null, deadlineAt = null } = {}) {
    const turn = this.queue.then(async () => {
      for (;;) {
        if (signal?.aborted) throw new ProviderError("CANCELLED", "the caller cancelled while waiting for the provider's rate", { sent: false });
        this.#refill();
        if (this.tokens >= 1) { this.tokens -= 1; return; }
        const wait = Math.ceil(((1 - this.tokens) / this.rate) * 1000);
        if (deadlineAt !== null && Date.now() + wait > deadlineAt) throw capacityTimeout("the provider's rate leaves no slot before the deadline");
        await new Promise((r) => setTimeout(r, wait));
      }
    });
    this.queue = turn.catch(() => {});
    return turn;
  }
}

// The deployment's pools, built from the egress policy's intelligence limits.
export function makePermits(limits) {
  const api = new PermitPool(), decisions = new PermitPool(), streams = new PermitPool();
  return {
    api: (provider, searchId, opts) => api.acquire([{ key: "api", limit: limits.apiPermits.total }, { key: `provider:${provider}`, limit: limits.apiPermits.perProvider }], searchId, opts),
    decision: (searchId, opts) => decisions.acquire([{ key: "jev", limit: limits.decisionPermits.total }, { key: `search:${searchId}`, limit: limits.decisionPermits.perSearch }], searchId, opts),
    refStream: (searchId, opts) => streams.acquire([{ key: "ref-stream", limit: limits.refStreams.total }, { key: `search:${searchId}`, limit: limits.refStreams.perSearch }], searchId, opts),
    deepseek: new TokenBucket(limits.deepseekQps),
    snapshot: () => ({ api: api.snapshot(), decisions: decisions.snapshot(), refStreams: streams.snapshot() }),
  };
}
