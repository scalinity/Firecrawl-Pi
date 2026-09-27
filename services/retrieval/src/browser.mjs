// Client for the browser worker (services/browser). A render gets its own proxy session, so every
// request Chromium makes for it passes this service's proxy under that attempt's credential; the
// session is closed when the render ends, whatever the outcome, and its counters (requests, bytes,
// refused targets) come back with the result. The worker's failure is the browser tier's failure
// only: direct HTTP never depends on it.
// The body as text, or null (and the stream cancelled) once it passes cap bytes.
async function readCapped(res, cap) {
  if (Number(res.headers.get("content-length")) > cap) { await res.body?.cancel().catch(() => {}); return null; }
  const reader = res.body.getReader(), chunks = [];
  let n = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return Buffer.concat(chunks).toString("utf8");
    n += value.length;
    if (n > cap) { await reader.cancel().catch(() => {}); return null; }
    chunks.push(value);
  }
}

// M7: the most the captures of one render may hold in all, decoded (the worker enforces it; spec §12 bounds each at 10 MiB).
export const EXTRAS_MAX_BYTES = 16 * 1048576;

export function makeBrowserClient({ url, token, proxyServer, sessions, getPolicy }) {
  async function health() {
    try {
      const r = await fetch(new URL("/healthz", url), { signal: AbortSignal.timeout(2000) });
      return r.ok ? await r.json() : { ok: false };
    } catch { return { ok: false }; }
  }

  async function call({ attemptId, url: target, deadline, waitFor, userAgent, signal, hooks }, cred) {
    const policy = getPolicy();
    const remaining = deadline - Date.now();
    try {
      const res = await fetch(new URL("/render", url), {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({
          attemptId, url: target, deadlineMs: Math.max(remaining - 500, 1000), waitForMs: waitFor, userAgent,
          proxy: { server: proxyServer, username: cred.username, password: cred.password },
          limits: { maxSubresources: policy.browser.maxSubresources, contextMaxMs: policy.browser.contextMaxMs, maxHtmlChars: policy.maxBodyBytes },
          // M7: the screenshot and the action subset, already validated to spec §12's bounds (acquire.mjs).
          hooks: hooks ?? { screenshot: null, actions: [] },
        }),
        signal: AbortSignal.any([AbortSignal.timeout(Math.max(remaining + 5000, 6000)), ...(signal ? [signal] : [])]),
      });
      if (res.status !== 200) return { ok: false, failure: { class: "BROWSER_UNAVAILABLE", detail: `the browser worker answered HTTP ${res.status}`, retryable: true, retryAfter: null } };
      // The worker bounds the document; this bounds its reply too, before parsing, however the
      // worker behaves (JSON escaping may double the characters, plus the result's other fields). M7: a render with extras
      // may also carry its captures (at most EXTRAS_MAX_BYTES, base64) and its content captures (as long as the page).
      const text = await readCapped(res, (hooks ? 4 : 2) * policy.maxBodyBytes + (hooks ? Math.ceil((EXTRAS_MAX_BYTES * 4) / 3) : 0) + 1024 * 1024);
      if (text === null) return { ok: false, failure: { class: "SIZE_LIMIT", detail: "the browser worker's reply exceeds the page limit", retryable: false, retryAfter: null } };
      const r = JSON.parse(text);
      return r.ok === true ? r : { ...r, ok: false, failure: { retryable: true, retryAfter: null, ...r.failure } };
    } catch {
      const cancelled = signal?.aborted === true;
      return { ok: false, failure: { class: cancelled ? "CANCELLED" : "BROWSER_UNAVAILABLE", detail: cancelled ? "the caller cancelled the acquisition" : "the browser worker could not be reached", retryable: !cancelled, retryAfter: null } };
    }
  }

  async function render(args) {
    const policy = getPolicy();
    // The main document and its redirects pass the proxy too, hence the margin over the subresources. On the
    // residential route (M6) the session chains through the attempt's leg, and its bytes stop at the leg's reservation.
    const maxBytes = args.upstream ? Math.min(policy.browser.maxSubresourceBytes, args.upstream.meter.cap) : policy.browser.maxSubresourceBytes;
    const cred = sessions.open(args.attemptId, { expiresAt: args.deadline, maxBytes, maxRequests: policy.browser.maxSubresources + 20, fixture: args.fixture === true, upstream: args.upstream ?? null });
    let result;
    try { result = await call(args, cred); } finally { result = { ...result, proxy: sessions.close(args.attemptId) }; }
    return result;
  }

  return { health, render };
}
