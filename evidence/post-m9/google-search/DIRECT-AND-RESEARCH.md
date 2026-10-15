# Google direct checks and integration research

Recorded 2026-10-15. Source baseline: `3a5dbe8`.

## Measured behavior

The query was `Python 3.14 release notes`. These were explicit, bounded direct diagnostics; the production search policy was not changed.

| Check | Actual response | Useful results |
| --- | --- | --- |
| Pi host, Python HTTP client, Google `/wml/search`, Nokia user agent | HTTP 403, Google error page, 1637 bytes | FAIL |
| Pi host, Python HTTP client, normal Google `/search`, desktop user agent | HTTP 200, JavaScript bootstrap page, no result headings or official Python link | FAIL |
| Pi host network, installed SearXNG virtual environment's `curl_cffi`, `/wml/search`, Nokia user agent, `chrome99_android` impersonation | HTTP 403, same response hash as the first check | FAIL |
| Workstation, fresh isolated Chromium context, normal Google `/search`, JavaScript enabled | Final path `/sorry/index`, unusual-traffic page, zero result headings and zero matching official Python results | FAIL |

The third check used the existing container's filesystem and Python environment with the host network, via a short-lived `nsenter` process. It did not modify container networks, firewall rules, service configuration, or installed packages. The browser context was closed in `finally`. No CAPTCHA was answered. No paid provider or Firecrawl Cloud request was made by these diagnostics. The earlier residential-proxy refusal remains separately recorded in `verification.json`.

Probe preparation errors occurred before dispatch: system Python lacked the virtual environment's modules, and `trust_env` was initially supplied to the request rather than the session constructor. The corrected request used `Session(trust_env=False)`. These setup failures are not target responses.

These checks establish failure for the tested clients and paths. They do not establish that an ordinary existing browser session cannot search Google, or that every Google acquisition method fails. IP reputation, request characteristics, and Google endpoint behavior remain possible causes; their individual contributions were not isolated.

## What has worked elsewhere

1. **SearXNG's maintained HTTP client fix.** [PR 6620](https://github.com/searxng/searxng/pull/6620), merged September 4, 2026, moved the client to `curl_cffi` and selected `chrome99_android` for Google. It closes the reported [Nokia-user-agent failure](https://github.com/searxng/searxng/issues/6570). The running pinned image already contains that client and setting. The direct check above still failed, so installing that same fix is not an untried solution here. [Current engine documentation](https://docs.searxng.org/dev/engines/online/google.html) describes the Nokia XML endpoint; ordinary Google web results require JavaScript.
2. **A dedicated Google results API.** [Serper](https://serper.dev/) documents live Google results, including organic links, snippets and positions. Its advertised trial is 2500 queries without a card. Its starter purchase is $50 for 50000 queries, credits valid for six months, excluding applicable tax; this is a prepaid purchase, not a $1 entry purchase or a monthly subscription. This is the recommended next candidate for a small personal installation, subject to a real account/key and successful integration test. The recommendation is an inference from the documented contract and price, not a local success claim.
3. **The already-designed SearchAPI extension.** [SearchAPI's Google contract](https://www.searchapi.io/docs/google) returns Google results through `GET /api/v1/search?engine=google`. [Current pricing](https://www.searchapi.io/pricing) offers 100 trial requests and a $40/month developer plan with 10000 searches. The spec already permits a budgeted SearchAPI adapter; it is a documented candidate, not an implemented provider.
4. **Google's former Custom Search route is unsuitable for new setup.** [Google's own notice](https://developers.google.com/custom-search/v1/overview) says the Custom Search JSON API is closed to new customers and existing customers must transition by January 1, 2027. The old 100-free-queries-per-day recommendation must not be presented as currently open enrollment.

The practical integration is: Google results API -> normalize ranked URLs and snippets in the existing search adapter -> existing Firecrawl acquisition for selected pages. Keep query limits, caching, error classification and an explicit provider budget. Do not replace Firecrawl's crawler or silently use Cloud quota. No account, provider activation, trial consent, subscription, or purchase was performed.

## Firecrawl Cloud comparison

Firecrawl documents [managed advanced retrieval capabilities](https://docs.firecrawl.dev/contributing/open-source-or-cloud) separately from the open-source deployment. Its [current search explanation](https://www.firecrawl.dev/blog/mastering-firecrawl-search-endpoint) distinguishes its search index from services that scrape Google result pages. Cloud search capability alone therefore does not prove that the self-hosted SearXNG Google path works, nor that every Cloud search is a Google scrape. A live Cloud Google scrape was NOT_RUN.

## Close-out

Production remains Yahoo primary with Google configured but automatic dispatch disabled. No source, image, policy, budget, service, or firewall change was made. `ORCHESTRATION.html` needs no realignment: milestone states, runnable order, ownership, and its existing Google-unavailable assertion are unchanged. The remaining step is a credential-bound candidate API integration and live proof; neither vendor documentation nor a trial offer is that proof.
