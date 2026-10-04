# M9 final remediation review: source 179b139, diff from f72333f

## Summary

I found no new Critical defect. I reviewed the supplied diff and source, and checked callers with nine read-only calls: `ssrf.mjs`, `store.mjs` `learnRoute`, the `budget.mjs` validator, the m2 fixture's `/redirect`, the `verify.mjs` helpers, the driver output fields, `pi-retrieval-tests.sh`, and every consumer of `proxy.denied` in the services. I ran no tests, builds or Chromium.

This is a code review, not runtime proof. The browser-worker changes are not deployed, and the updated isolated suite and the real browser redirect matrix (S03) have not run. Everything below about Chromium behaviour is my reasoning about Playwright and Chromium, not observed evidence. Those runs are still required before acceptance.

How each redirect case is classified, as I traced it:
- **HTTP redirect to a private host (initial or post-load):** Chromium follows the redirect without re-running the route handler. The proxy refuses it (`proxy.mjs:167`) and records a host-only entry plus an in-memory URL hash (`proxy.mjs:72-77`). Chromium commits the 403 at the private URL, so `page.url()` equals the refused URL. `acquire.mjs:497-501` matches the hash and returns `SSRF_DENIED`, non-retryable, in one `direct_browser` attempt.
- **HTTPS redirect to a private or Cloud host:** the proxy refuses the CONNECT, so Chromium reports `net::ERR_TUNNEL_CONNECTION_FAILED`.
  - Initial redirect: `goto` throws and is classed `NAVIGATION_FAILED`. The URL used for matching comes from the `request` listener (`server.mjs:240-242`).
  - Post-load redirect: the page lands on `chrome-error://chromewebdata/` and the browser reports the failed main-frame tunnel URL (`server.mjs:268`).
  - Matching is by `host:port` only, and only for refusals with no URL hash (CONNECT refusals). A policy refusal of a given `host:port` is deterministic, so this can't be confused with an unrelated failure except under DNS rebinding.
- **Class names:** `parseTarget` classes every BR destination as intended: credentials, ports, single-label names, reserved suffixes and ambiguous IPv6 forms all give `SSRF_DENIED`, and the Cloud check runs before the port check (`ssrf.mjs:122-147`).
- **Hashes stay inside retrieval:** URL hashes are removed from `proxyDenied` on success (`acquire.mjs:524`). They aren't returned on failure, and they aren't logged: the only other consumer is the matcher at `acquire.mjs:499`.
- **No routing change:** learning a failure only updates counters and `last_failure_class` (`store.mjs:396`). Blocking, pacing, attempt budgets and providers are unchanged.
- **Refusal logs:** the host-only sanitisation (`proxy.mjs:68-71`) strips path, query and credentials before target parsing, and keeps a CONNECT `host:port` intact.
- **M9 budget policy:** the validation policy matches the production validator. `paidTotal.caps` may only name `day` (`budget.mjs:44`), each paid category keeps `day` and `month` caps, parser is a monthly cap of 20, the parser rate card is 0, and `paidDispatchActive` honours the absolute expiry. The contract test extracts the actual jq expression and runs it through `loadBudgetPolicy`.

## Critical Issues

None introduced.

## Warnings

**W1 (pre-existing, reachable, made more visible by this change): a post-load navigation that the browser itself blocks still returns `ok:true` with Chromium's error page as content.**
- **Input:** a page served 200 that runs `location.href="http://169.254.169.254/"` (an off-host navigation, not via a same-host redirect).
- **Path:** the route handler aborts it as `blockedbyclient` (`server.mjs:229`), so it never reaches the proxy and no refusal exists. Chromium commits `chrome-error://chromewebdata/`. `failedTunnelUrl` stays null because the error text is `ERR_BLOCKED_BY_CLIENT`, so `navigationFailure` is null. `parseTarget("chrome-error://…")` throws and is swallowed. `classify` sees the original status 200 plus the error page's HTML.
- **Outcome:** `ok:true` with `finalUrl` set to `chrome-error://chromewebdata/` and the error page as the body. The network block is still correct.
- The same happens for an HTTPS post-load main-frame tunnel failure with no matching refusal (provider or TLS failures).
- BR11 (`tests/fixtures/m2/server.mjs:44`) runs exactly this navigation, but its original 403 status hides the problem; a 200 control would show it.
- Under the hard boundary (classify only from actual refusals), this can't become `SSRF_DENIED`. It should still not be a success. Minimal patch, held until separately authorised; it goes after `verdict.failure`, so a page's own 403 stays `ACCESS_DENIED`:
  ```js
  // acquire.mjs, in the failure chain after verdict.failure
  const errorPage = r.ok && finalUrl.startsWith("chrome-error:") ? { class: "NAVIGATION_FAILED", detail: "the main frame ended on the browser's error page", retryable: false, retryAfter: null } : null;
  const failure = navigationFailure ?? providerFailure ?? (!r.ok ? r.failure : limited ?? verdict.failure ?? errorPage ?? noShot ?? (shell ? … : null));
  ```

**W2 (introduced, possible missed classification, not a leak): a redirect target with credentials may not match.**
- Chromium sends the proxy an absolute-form request line without the `user:pass@`, so the proxy hashes the URL without credentials (`proxy.mjs:73-75`). If Chromium's committed `page.url()` keeps the credentials, the hashes differ and `http://u:p@10.0.0.1/` is reported as `ACCESS_DENIED` (from the proxy's 403) instead of `SSRF_DENIED`.
- The unit test (`acquire.test.mjs`, the credentialed-hash case) covers only the reverse direction, which the design requires.
- **Action:** add a credentialed private redirect row to the real browser matrix and record the class Chromium actually produces. No code change is needed if it fails safe as `ACCESS_DENIED`.

**W3 (introduced, timing dependency): post-load classification depends on the navigation finishing before the content is captured.**
- A post-load redirect that starts after `settle()` completes (for example a 9 s timer) can either race `page.content()`, giving `BROWSER_ERROR` from a destroyed execution context, or return the original document as `ok:true`. In both cases the network block still holds.
- BR09 and BR10 use a 100 ms delay, so S03 only proves the early case. Document this bound in the evidence rather than claiming "all post-load redirects".

## Suggestions

1. **S03 doesn't tie refusals to the BR attempts** (`scripts/m2/verify.mjs`, S03 `actualRefusals`). The check `actualRefusals.length >= 18` counts every `proxy_denied` event in the phase, including BR11's image. It's adequate because an attempt can only end with a denial class through a refusal, but it is not a join. If attempt ids can be added to the attempts query, check that each BR `-rs` attempt has its own refusal event.
2. **S03 checks the core strategy only in aggregate** (`denied.every(a => a.strategy === "direct_browser")`). If the core's scrape path ever started on `direct_http`, S03 would fail closed (a false negative, not a false PASS). That's acceptable; just note it when reading a failure.
3. **Budget window can cross a UTC month boundary** (pre-existing, `scripts/m9/validation.sh:13`). If the up-to-60-minute consent window spans the boundary, the day and month counters both reset, so the "fixed cumulative" caps could be spent twice. That's not reachable on today's date, but a one-line consent guard would close it: `(.expires_at[0:7]) == (now|todate[0:7])`.
4. **DNS rebinding** can make a usable public document classify itself as `SSRF_DENIED`: the page fetches its own URL after its host re-resolves to a private address, and the hashes match. That's arguably the correct class; I'm noting it because it is the only way a usable document can lose its result.
5. **Unused field:** `navigationUrl` on the success result (`server.mjs:267`) isn't used by retrieval except as a fallback. It's harmless, but it is one more full URL crossing the worker boundary.

## Good Practices

- Classification is based on actual proxy refusals, never page text, and the tests include page-text and unmatched-refusal controls (`acquire.test.mjs`).
- The HTTPS fallback match requires `!d.urlHash`, so an HTTP refusal can't satisfy an HTTPS authority match.
- Policy denials are non-retryable and never add a direct retry or fallback (asserted with `fx.hits.length === 0`).
- The refusal-record sanitisation runs before any parsing and is tested with credential and query sentinels; CONNECT keeps its `host:port`.
- The contract test runs the deployed jq expression rather than a copy, and covers both sides of the expiry boundary.
- Retrieval tolerates an older browser worker: a missing `navigationUrl` or `navigationFailure` lands in the `catch`, which leaves the result unclassified.

## Verdict

**Approve the code, with acceptance gated on held work.** There are no Critical findings in the diff. W1 is pre-existing and out of scope unless separately authorised. W2 and W3 should be checked in the real Chromium matrix rather than fixed now. Before the evidence can be called a PASS, the final isolated suite and a deployed-browser S03 run are still needed. The broad Mac full-suite run failed (missing Pi-only mounts and Postgres) and is not a PASS.
