# Review: M9 final remediation, `f72333f..179b139`

## Summary
I read the supplied diff and the enclosing source, plus the callers I needed (`ssrf.mjs` refusal details, `budget.mjs` validator and periods, `m2/pi-retrieval-tests.sh`, `m9/regression.mjs`, and the `m2/verify.mjs` phase parser and aggregate). I used 10 lookups and ran nothing.

The classification change matches the stated intent:
- **Where the class comes from:** only from the attempt's own SSRF_DENIED/CLOUD_DENIED proxy refusals. HTTP matches on the exact URL hash. HTTPS matches on the CONNECT authority, and only when the main-frame navigation actually failed. Page text is never used.
- **Initial redirects:** redirect hops skip Playwright's route callback, so they reach the proxy. An HTTP refusal comes back as a 403 page at the refused URL (`page.url()`), which matches the hash. An HTTPS refusal makes `goto` throw; `navigationUrl` (taken from the redirected request's `request` event) is then matched against the `host:443` CONNECT record.
- **Post-load redirects (BR09/BR10):** these first navigate to the same host's `/redirect`, so the route allows them. HTTPS relies on the `requestfailed` tunnel witness plus `chrome-error://chromewebdata/`.
- **Hashes stay internal.** `urlHash` is stripped from `proxyDenied` (`services/retrieval/src/acquire.mjs:524`). It is absent from failures, logs and attempt rows; the only consumer of `denied` is in `acquire.mjs`.
- **Unchanged:** blocking, routing, sandbox, attempt budget, provider and pacing code. `navigationFailure` only changes the result's class.
- **Refusal logs (`proxy.mjs:65-80`):** they now carry only the host, even before target parsing. The CONNECT authority, including its port, passes the host regex unchanged. The `ssrf.mjs:118-147` details contain only scheme, host or address.
- **M9 policy:** `budget.mjs:44` requires `paidTotal.caps` to be exactly `["day"]`, so the old generator (with a month total) would have been rejected. The fix is correct. Budget periods are UTC (`budget.mjs:173-176`).
- **The new contract test** runs the actual jq expression through `loadBudgetPolicy`. The validator does not compare `validationExpiresAt` to the current time, so the fixed 2026-10-03 grant is not a time bomb.

What has not been checked: none of the browser behaviour above has run in real Chromium. The browser change is not deployed, the final isolated suite and the real redirect matrix have not run, and the broad Mac full-suite failure is not a PASS. Unit tests and fixtures do not prove Chromium behaviour (`chrome-error` commit, `ERR_TUNNEL_CONNECTION_FAILED` text, redirect `request` events).

## Critical Issues
None found.

## Warnings
1. **Introduced (verifier wiring): AC25 cannot pass through the standard M9 collection.**
   - `scripts/m9/verify.mjs:24` now makes AC25 depend on M2 check `S03`, whose input is `rt-browser-redirect.txt` (`scripts/m2/verify.mjs:418`).
   - `scripts/m9/regression.mjs:6` still collects only `['static','browser']` for M2, so S03 will always be missing its input.
   - This fails closed (no false PASS), but the held validation run would report AC25 failed for a missing file rather than a real result.
   - Fix: `const phases=group==='M2'?['static','browser','browser-redirect']:…`. This works with the `domain_route` reset at `regression.mjs:11`, because the phase warms its own browser-first hint (`retrieval-e2e.mjs:112`).

2. **Pre-existing (M9 bounds): a window that crosses a UTC month boundary can exceed the fixed cumulative caps.**
   - Category caps are `{day,month}` equal to the grant, and `paidTotal` is day-only (`scripts/m9/validation.sh:13`). Periods are UTC calendar day and month (`budget.mjs:173-176`).
   - The consent check allows `expires_at` up to now+3600 (`validation.sh:11`). A window started after about 23:00 UTC on the last day of a month resets every month cap and the total's day cap partway through.
   - Result: up to 2× OpenAI 20000, Decodo/Zyte 100000 each, total 220000 micro-USD, and parser 20 credits. The "fixed cumulative" owner caps are broken.
   - Crossing a day boundary inside one month is still bounded, because the category month caps sum to 220000.
   - Minimal guard, added to the `jq -e` consent predicate: `and ((.expires_at|fromdateiso8601|strftime("%Y-%m-%d")) == (now|floor|strftime("%Y-%m-%d")))`. This also keeps the day-only total within one period.

3. **Unverified Chromium behaviour (introduced matching): a redirect target with userinfo may be classified falsely negative.**
   - Chromium never puts userinfo in the proxy request line, so the proxy's hash (`proxy.mjs:75`) is always credential-free.
   - If `page.url()` keeps the userinfo after a redirect to `http://u:p@169.254.169.254/`, the hashes in `acquire.mjs:494-500` will not match. The result would be ACCESS_DENIED instead of SSRF_DENIED. The network is still denied.
   - The same fact means the credential-bearing denied-subresource case in `acquire.test.mjs` cannot come from real Chromium traffic.
   - Recommendation: add one credential-bearing redirect case to the real matrix before relying on this.

4. **Pre-existing (not in this scope): an off-host post-load navigation can return `ok:true` with Chromium's error page.**
   - A script `location.href` to another host is a new navigation, so the route aborts it as off-host (`server.mjs` route callback). It never reaches the proxy.
   - If Chromium then commits `chrome-error://chromewebdata/` (the error text is `ERR_BLOCKED_BY_CLIENT`, not a tunnel error), `navigationFailure` stays null. The 200 status from the original `goto` response is then judged on the error-page HTML.
   - BR11 hides this only because its own status is 403 (`tests/fixtures/m2/server.mjs:44`). That fixture's script redirect never reaches the proxy, so it tests "unrelated denied subresource" and not navigation-hash matching.
   - Correctly, this is not policy-classified (no proxy refusal). It should be tracked separately, not fixed here.

## Suggestions
- S03 (`scripts/m2/verify.mjs:418-437`) checks only `actualRefusals.length >= 18` overall. Linking each case to a refusal from its own attempt (via `attempt_id`) would rule out a coincidental count.
- Neither the aggregate list at `scripts/m2/verify.mjs:638` nor S03 checks that the new phase stayed inside the egress guard window or caused no fixture or private hits. Network denial is established elsewhere, but adding the phase to that list is cheap.
- `tests/contracts/m9-validation-policy.test.mjs` exercises the generator but not the consent check at `validation.sh:11`. Feeding it an over-cap grant, an expired one, one expiring past now+3600 and a wrong source commit would cover that check. The test also needs `jq` on PATH (it fails closed without it).
- Known edge case: a document that requests its own URL, and whose host re-resolves to a private address in between (DNS rebinding), gets its usable page classified SSRF_DENIED (`acquire.mjs:499`). This is attacker-controlled self-harm and fails closed, so it is acceptable.

## Good Practices
- The class comes from actual proxy refusals of the attempt's own denied destination: an exact URL hash for HTTP; for HTTPS, a tunnel failure on the main frame plus a matching authority.
- An unrelated denied subresource cannot fail a usable public document or a page's own 403. The unit tests cover page text, unmatched refusals, NAVIGATION_FAILED and cancellation.
- The host-only refusal record is sanitized before parsing and covered by assertions on credentials and query.
- The policy test runs the real generator through the real production validator, and checks `paidDispatchActive` on both sides of the expiry.

## Verdict
**Approve with warnings.** There are no Critical findings.
- Fix W1 before collecting the held evidence. Otherwise AC25 cannot pass.
- Add the W2 guard before the single paid window (one jq clause).
- Before calling the remediation proven, still required: deploy the browser change, run the final isolated suite, and run the real Chromium redirect matrix (BR01–BR11, ideally with a credential-bearing case).
