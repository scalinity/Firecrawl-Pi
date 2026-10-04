## Code Review: M2 redirect-classification remediation

### Summary
I reviewed the six-file candidate against base `f72333f` by reading code only. I did not run any tests, builds or commands.

The patch is narrowly scoped. For a plain `http://` redirect, a refusal is matched by a hash of the exact URL. That hash is computed in `services/retrieval/src/proxy.mjs:65-73,162`, and the matcher in `services/retrieval/src/acquire.mjs:491-501` compares it against the browser's main-frame target.

`https://` redirects are refused when the proxy is asked to open the connection (`CONNECT`), and that refusal carries no URL. They are matched by host and port instead, and only when the navigation failed (`NAVIGATION_FAILED`). Page text is never consulted.

Several things are unchanged:
- **Policy and routing:** SSRF policy, provider routing, pacing, attempt reservation, budgets and the browser sandbox.
- **Cancellation and timeouts:** these keep their own classes, because the matcher only runs on a 403 page or `NAVIGATION_FAILED`.
- **Older workers:** a worker that doesn't send `navigationUrl` falls back to `finalUrl`, which is still correct for HTTP redirects.
- **Fallbacks:** nothing new is retried, because `browserStep` already ended the page on any failure.

I found one way a hostile page can still make a blocked subresource look like a main-frame failure, and one spec deviation in how the new hash leaves the service. Neither weakens a security boundary.

### Critical Issues (Must Fix)
None

### Warnings (Should Fix)

**W1. A page's later navigation attempt plus a blocked subresource can still produce a fake main-frame `SSRF_DENIED`** (`services/browser/src/server.mjs:240-242,264`; `services/retrieval/src/acquire.mjs:491-499`)

- **Cause:** for successful renders, `navigationUrl` is the *last* main-frame request seen, not the URL of the response whose 403 status is being classified.
- **Why later requests count:** the `request` listener keeps updating after `goto` returns, during settling and actions. Playwright fires `request` for a request before the route handler runs, so it also fires for off-host navigations that the route then aborts (line 231).
- **Trace:**
  1. A browser render targets the public page `http://evil.example/`. The server answers **403** with `<img src="http://10.0.0.5/x"><script>setTimeout(()=>location.href="http://10.0.0.5/x",50)</script>`.
  2. The image request reaches the proxy and is refused. The proxy records `{host:"10.0.0.5", class:"SSRF_DENIED", urlHash:H("http://10.0.0.5/x")}`.
  3. While the page settles, the script's navigation fires the `request` event, so `navigationUrl = "http://10.0.0.5/x"`. The route then aborts it as off-host, so the main frame never reached the proxy.
  4. The worker returns `ok:true, status:403` with that `navigationUrl`. In `acquire`, the URL hash matches and the result becomes `navigationFailure = SSRF_DENIED`.
- **Wrong outcome:** the page's own 403 (`ACCESS_DENIED`) is reported as a main-frame `SSRF_DENIED`, and the detail text says the main frame was refused. This is exactly the "blocked subresource invents a main-frame failure" case the contract rules out. It is still a terminal failure either way, so this is a misclassification and false security signal, not a bypass.
- **Fix:** correlate with the URL of the response that supplied the status.

```js
// services/browser/src/server.mjs:264
      ok: true, finalUrl: page.url(), navigationUrl: response?.url() ?? navigationUrl, status: response?.status() ?? 0, contentType: response?.headers()["content-type"] ?? null, html, redirects,
```

For a redirect, `response` is the final response of the `goto` chain, so a proxied HTTP refusal still correlates to the refused URL. The failure path (line 272) only produces `NAVIGATION_FAILED` from `goto`, so it can keep the listener value.

**W2. An unkeyed SHA-256 of the full URL, query string included, now leaves the retrieval service** (`services/retrieval/src/proxy.mjs:69-71`; `services/retrieval/src/acquire.mjs:522`)

- **Spec:** `docs/FIRECRAWL_PI_SPEC.md:833` says to use a keyed hash when correlation is needed, because "even plain URL hashes can be guessable".
- **Where it goes:** `denied.urlHash` is a plain SHA-256. On every successful browser result it goes out in `proxyDenied`, which is part of the response the core receives. Private subresource URLs are low-entropy, so the hash is easy to reverse by guessing, despite the comment "without retaining URL/query text".
- **Why it doesn't need to:** the hash is only needed inside this process for the comparison.
- **Fix (smallest):** keep the hash internal.

```js
// services/retrieval/src/acquire.mjs:522
            subresources: r.subresources, proxyDenied: (r.proxy?.denied ?? []).map(({ urlHash, ...d }) => d), ...(hooks ? { screenshot: r.screenshot ?? null, actions: r.actions ?? null } : {}) }) };
```

**W3. The browser-side change has no executed evidence.** No tests exist under `services/browser/` at all. The 57 focused tests inject `navigationUrl` and `proxy.denied` as fakes. None of them exercise:
- Chromium firing `request` for redirect hops;
- the main-frame identity check (`req.frame() === page.mainFrame()`);
- an HTTP-proxy 403 being committed as the page;
- a refused `CONNECT` surfacing as `net::ERR_TUNNEL_CONNECTION_FAILED`.

The `browser-redirect` group in `scripts/m2/retrieval-e2e.mjs` has not been run. Until the isolated Pi suite runs it, BR01–BR08 are unverified, and the broad Mac run is not a PASS.

### Suggestions (Consider)
- **Pre-existing, outside the authorized scope:** a same-host navigation *after* load that redirects to a private address is refused by the proxy. The render still returns `ok:true` with the status of the earlier `goto` response, the proxy's refusal text as the body, and a private `finalUrl`. This happens because `status` comes from the stale `goto` response (`server.mjs:248,264`). It's worth a separate owner decision. This patch neither causes nor fixes it, and W1's fix leaves it as it is.
- **Weak public-redirect control:** BR08 (`scripts/m2/retrieval-e2e.mjs:121-123`) only redirects within the same host. Redirects skip the worker's off-host route check, so a cross-host public redirect is the meaningful "still usable" case. One option is `${M2}/redirect?to=http://m1.fixture.fcpi.test:8080/static.html`.
- **Group not wired up:** `browser-redirect` isn't in the phase list in `scripts/m2/pi-retrieval-tests.sh:4`, and `scripts/m2/verify.mjs` has no criterion for it. Without that, the collector won't fail on a wrong class.
- **Precedence is now locked in by a test:** the HTTPS case pins `navigationFailure` ahead of `providerFailure` (`upstreamFailure` set alongside the denial). That's defensible, since the refused `CONNECT` never reaches a provider leg, but the review record should state it as a deliberate choice.

### Good Practices
- HTTP refusals are matched by exact URL, which stops one blocked same-host subresource (for example `/asset`) from failing the page. The negative test at `acquire.test.mjs:214-215` covers this.
- The host-and-port fallback is limited to failed `https:` navigations and to records with no URL hash, so a plain-HTTP subresource on the same host can't match it.
- Cancellation, timeout and size/action failures keep their own classes, and the cancellation case has a negative test.
- The worker's failure result carries `navigationUrl`, so a `goto` that throws can still be attributed.
- The new failure is non-retryable and adds no attempts, fallback, pacing or provider calls. The tests assert one attempt, no permits left held, and no direct hits.

### Verdict
**Approve with Suggestions.** Apply the one-line fixes for W1 and W2 before landing. This approval is conditional on the isolated Pi suite, including the `browser-redirect` group, actually passing (W3).
