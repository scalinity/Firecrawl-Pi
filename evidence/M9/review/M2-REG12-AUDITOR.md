I found no critical defects. The patch only changes the reported failure class for a main-frame request the proxy refused; blocking, routing and success paths are unchanged. I have two warnings and some smaller suggestions.

## Code Review: M2 redirect-classification remediation

### Summary
I checked the six-file candidate against base `f72333f` and traced how a refusal travels: the browser worker records the main-frame target, the proxy records the refusal, and the acquirer matches the two. I read the related code in `services/retrieval/src/browser.mjs`, `quality.mjs`, `store.mjs` and the core adapter patch.

- **HTTP redirects:** Chromium sends the proxy the same request URL that Playwright reports. Both sides run that URL through Node's URL parser, drop the fragment and hash it, so the two hashes are built the same way. This covers redis, metadata, loopback, mapped IPv6, service name and LAN targets.
- **HTTPS redirects:** a refused tunnel arrives as a failed navigation (`NAVIGATION_FAILED`). The patch matches it by host and port only, never by URL hash, and only when the browser's latest main-frame target was HTTPS. The host string the proxy records (e.g. `api.firecrawl.dev:443`, or the bracketed IPv6 form) matches what the acquirer computes, including for IPv6.
- **Page text:** classification never reads the page body, so a page that prints "fcpi: SSRF_DENIED" can't fake a refusal.
- **Unchanged behaviour:**
  - Cancellation, timeouts and crashes keep their own classes.
  - The browser step has no in-process retry or fallback, so attempts, pacing, provider routing and the browser sandbox are unchanged.
  - `navigationUrl` is never copied into the result's `finalUrl`.
  - Route learning still records the same success/failure counts; only `last_failure_class` changes, to the more accurate class.

**Evidence:** the 57 local focused tests are the only test evidence. The new acquirer tests feed in hand-made refusal entries, so they show the classification logic, not that the browser and proxy actually produce matching entries. The `browser-redirect` end-to-end group, the browser-worker behaviour and the isolated Pi suite have not run. The broad Mac run had environment failures and skips, and I don't count it as a pass.

### Critical Issues (Must Fix)
None

### Warnings (Should Fix)

**1. An unkeyed SHA-256 of the full URL is sent out of the retrieval service, which the spec forbids**
- **Where:** `services/retrieval/src/proxy.mjs:69-71` adds `urlHash` to every HTTP `SSRF_DENIED`/`CLOUD_DENIED` refusal. `services/retrieval/src/acquire.mjs:522` returns the refusal list unchanged as `proxyDenied` in every successful browser result on `/internal/acquire`.
- **Spec:** `docs/FIRECRAWL_PI_SPEC.md:833` says: "Hash sensitive URL components with a keyed hash when correlation is necessary; even plain URL hashes can be guessable."
- **Trace:** a public page includes `<img src="http://169.254.169.254/latest/meta-data/iam/security-credentials/?token=…">`. The proxy correctly refuses it, and the render succeeds. The response then carries an unkeyed SHA-256 of the full URL, including the query. That hash is open to dictionary attack, and the comment "without retaining URL/query text" overstates the protection.
- **Why it's unnecessary:** the match happens inside the same process (`browser.mjs:69` closes the session in-process), so the hash never needs to leave.
- **Smallest fix:**
```js
// services/retrieval/src/acquire.mjs:522
            subresources: r.subresources, proxyDenied: (r.proxy?.denied ?? []).map(({ urlHash, ...d }) => d), ...(hooks ? { screenshot: r.screenshot ?? null, actions: r.actions ?? null } : {}) }) };
```

**2. The URL being matched and the status gate can describe different navigations, and a refused main frame can still be returned as success (pre-existing, made visible by this patch)**
- **Where:** `services/browser/src/server.mjs:240-242` updates `navigationUrl` on every later main-frame request. But `r.status` is the status of the first navigation (`page.goto`), and `acquire.mjs:491` only checks when that status is 403.
- **Trace:**
  1. A browser-first public page returns 200, then after load runs `location = "/r"`.
  2. That same-host request passes the route check, and `/r` redirects with 302 to `http://10.0.0.1/`.
  3. The proxy refuses it with 403 and records a matching `urlHash`.
  4. The page now shows the proxy's refusal text, and `page.url()` is `http://10.0.0.1/`, but `r.status` is still 200.
  5. `classify` sees about 17 visible characters of HTML with no scripts and returns `adequate`.
  6. The acquisition returns `ok: true` with body `fcpi: SSRF_DENIED` and a private `finalUrl`. No private bytes leak, but the refused main frame is reported as success, which is the same misclassification this regression is about.
- **Mirror case:** the same JS after a real public 403 is relabelled `SSRF_DENIED`.
- **Scope:** this behaviour predates the patch, and the observed failure (redirects during the initial navigation) is fixed without it. Fixing it changes the outcome of 200 results, so it needs your consent first: either widen this item or log it as a separate regression.
- **Smallest fix, if approved:** match the document the result actually describes (on success, `finalUrl` is `page.url()`), with no status gate:
```js
// services/retrieval/src/acquire.mjs:491-493
          if (r.ok || r.failure?.class === "NAVIGATION_FAILED") {
            try {
              const nav = new URL(r.ok ? r.finalUrl : r.navigationUrl);
```
  The observed 403 redirect cases still match, because there `page.url()` equals the redirect target.
  - **Residual gap:** a later HTTPS navigation that fails lands on `chrome-error://chromewebdata/` and still wouldn't match.

**3. Gaps in what the tests prove (not code defects, but they limit the evidence)**
- No proxy test checks the shape of an `SSRF_DENIED`/`CLOUD_DENIED` tunnel refusal. The acquirer test builds `${hostname}:443` itself (`services/retrieval/test/acquire.test.mjs:176`), so the host-and-port match is never checked against what the proxy really records.
- Nothing tests that Playwright fires `request` for redirected main-frame requests before `goto` rejects. Only the unrun `BR01`–`BR08` group would show that.
- The "unrelated blocked subresource" check is mock-only. Re-running the existing real subresource case (`scripts/m2/verify.mjs:320`) alongside BR08 on the Pi would be the real negative control.

### Suggestions (Consider)
- **Clear credentials before hashing.** Clearing `url.username` and `url.password` on both sides would stay correct even if Chromium's request line drops credentials that Playwright's `request.url()` keeps. A mismatch only falls back to the old `ACCESS_DENIED`, so it fails closed.
- **Fix a misleading test row.** `services/retrieval/test/acquire.test.mjs:166` labels the public address `45.33.20.9` as `SSRF_DENIED`. The refusal is hand-fed, so it proves nothing about policy; use a private, LAN or Tailnet example instead.
- **Pre-existing, out of scope:** `services/retrieval/src/proxy.mjs:102-103,175-176` pass the full request URL, query included, as `target_host` to the refusal list and the `proxy_denied` log. That also conflicts with `docs/FIRECRAWL_PI_SPEC.md:833`; worth recording separately.

### Good Practices
- The class comes only from refusals the proxy actually recorded and is gated to the two policy classes, so page text and the worker can't invent it.
- The two paths use different matching: exact URL hash for HTTP, host and port only for HTTPS and only when the target is HTTPS. This stops an HTTP subresource refusal on the same host from failing an HTTP page.
- The policy failure is non-retryable and takes priority over provider failures and resource limits, and it is recorded on the attempt row. `CANCELLED`, `TIMEOUT` and crash classes keep their own handling.
- `navigationUrl` is used only for matching. The result's `finalUrl`, redirects, the redirect-navigation counting and learning inputs are unchanged.
- The patch is minimal: no changes to SSRF policy, provider routing, pacing, budgets or browser capability, and no paid provider calls.

### Verdict
**Approve with Suggestions.** The approval covers the code only. Before close-out: apply Warning 1, decide the scope of Warning 2, and get passing results from the `browser-redirect` group (BR01–BR08) and the isolated Pi suite. Until those runs pass, M9-REG-12 isn't verified.
