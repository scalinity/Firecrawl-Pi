# Provider wire contracts, verified 2026-10-17

Method: WebFetch and WebSearch of public documentation and public GitHub source only. No provider
API was called. All sources were read on 2026-10-17. WebFetch returns a model-extracted rendering of
the page, so quoted strings are as extracted; anything load-bearing was re-read with a "copy
character-for-character" prompt where it mattered (marked "re-read").

Legend: **REQ** required, **OPT** optional, `T?` means the source marks the field optional/nullable.
"NOT ESTABLISHED by <source>" means the named source(s) do not state it; do not code against a guess.

---------------------------------------------------------------------------------------------------

## 1. Brave Web Search

### Sources read (2026-10-17)
- https://api-dashboard.search.brave.com/api-reference/web/search/get — read in three chunks
  (0–100k, 100k–200k, 200k–245k chars). Established: URL, auth header, every query parameter and
  limit, request headers, the full response schema with `?` optional markers, and the error schema
  for 404/422/429.
- https://api-dashboard.search.brave.com/documentation/guides/rate-limiting — rate-limit headers,
  units, 429, billing of successful requests only.
- https://api-dashboard.search.brave.com/app/documentation/web-search/query — exists ("Web Search"
  overview). count max 20, offset max 9, extra_snippets "up to 5 additional excerpts". No q limits.
- https://api-dashboard.search.brave.com/app/documentation/web-search/responses — exists but is the
  same overview: confirms `extra_snippets` appears on `web.results[]` items and
  `query.more_results_available`; no full model, no errors.
- WebSearch (official domains only) for 401/402/403 definitions: none found on Brave's own pages.

### Request
- `GET https://api.search.brave.com/res/v1/web/search` (reference: base `https://api.search.brave.com/res`, path `/v1/web/search`).
- Auth header: `x-subscription-token` (REQ, string): "The subscription token that was generated for the product." (HTTP header names are case-insensitive; `X-Subscription-Token` is the same header.)
- Optional request headers: `accept` (`application/json` default), `cache-control: no-cache` (best effort), `api-version` (`YYYY-MM-DD`, default latest), `user-agent`, `x-loc-lat`, `x-loc-long`, `x-loc-timezone`, `x-loc-city`, `x-loc-state`, `x-loc-state-name`, `x-loc-country`, `x-loc-postal-code`.

| Param | Type | Default | Limits / values | Notes |
|---|---|---|---|---|
| `q` | string | REQ | "Maximum of 600 characters and 75 words in the query." Cannot be empty. | Confirms the spec's 600 chars AND 75 words. |
| `count` | integer | 20 | 1–20, "The maximum is 20." | Applies to web results only; fewer may be returned. |
| `offset` | integer | 0 | 0–9 | Zero-based PAGE index, not item offset: "increment offset by 1 (for example, 0, 1, 2)". Pages may overlap. |
| `result_filter` | string | none | comma list of `discussions`,`faq`,`infobox`,`news`,`query`,`summarizer`,`videos`,`web`,`locations` | Omit = all types. `query` and `type` always included. |
| `extra_snippets` | string (as typed in reference) | none | guide says pass `true` | "up to 5 additional excerpts per search result". |
| `text_decorations` | boolean | `true` | | Highlight markers in display strings; send `false` to suppress. |
| `country` | string | `US` | 2-letter codes incl. `ALL` | |
| `search_lang` | string | `en` | fixed list | |
| `ui_lang` | string | `en-US` | | |
| `safesearch` | string | `moderate` | `off`,`moderate`,`strict` | |
| `spellcheck` | boolean | `true` | | Corrected query "is always used" and returned in `query.altered`. |
| `freshness` | string | empty | `pd`,`pw`,`pm`,`py`, or `YYYY-MM-DDtoYYYY-MM-DD` | |
| `operators` | boolean | `true` | | Whether search operators are applied. |
| `units`, `goggles`, `goggles_id` (deprecated), `summary`, `enable_rich_callback`, `include_fetch_metadata` | | | | not needed by the adapter |

### Response (200 "Successful Response")
Top level (all `object?` = OPT): `type` (string?), `query`, `web`, `mixed`, `discussions`, `news`,
`videos`, `locations`, `infobox`, `faq`, `summarizer`, `rich`. **`web` is `object?` — a valid 200 can
lack the `web` section** (adapter must treat absent `web` as zero results, not an error).

`query` object: `original` string **REQ** (only required member); OPT: `altered` string?,
`cleaned` string?, `spellcheck_off` bool?, `more_results_available` bool?, `bad_results` bool?,
`should_fallback` bool?, `is_navigational` bool?, `safesearch` bool?, `country` string?,
`language` object? (`main` string), `search_operators` object? (`applied` bool?, `cleaned_query`
string?, `sites` string[]?), `related_queries` string[]?, plus location/other flags.

`web` object: `type` string? (always `search`), `results` object[] **REQ**, `family_friendly` bool?.

`web.results[]` (SearchResult):
| Field | Type | |
|---|---|---|
| `title` | string | **REQ** |
| `url` | string | **REQ** |
| `description` | string? | OPT |
| `extra_snippets` | string[]? | OPT — "A list of extra alternate snippets for the web search result." |
| `page_age` | string? | OPT — "Published or last-modified date" (format NOT ESTABLISHED by reference) |
| `age` | string? | OPT — human-readable, e.g. "2 days ago" |
| `language` | string? | OPT |
| `profile` | object? | OPT — `name` string REQ, `url` string REQ, `long_name` string?, `img` string? |
| `meta_url` | object? | OPT — sub-fields for this path NOT ESTABLISHED by reference (on `deep_results.videos[].meta_url`: `scheme`,`netloc`,`favicon`,`path` string REQ, `hostname` string?) |
| `page_fetched` | string? | OPT |
| `fetched_content_timestamp` | int? | OPT |
| `family_friendly`, `is_source_local`, `is_source_both`, `is_live` | bool? | OPT |
| `type` | string? | always `search_result` |
| `subtype`, `content_type`, `cluster_type` | string? | OPT |
| `thumbnail`, `deep_results`, `schemas`, `location`, `video`, `movie`, `faq`, `qa`, `book`, `rating`, `article`, `product`, `product_cluster`, `cluster`, `creative_work`, `music_recording`, `review`, `recipe`, `software`, `organization`, `icons` | various, all OPT | ignore |

### Errors
Reference documents only **404, 422, 429** besides 200. Shared body schema (name not given):
```
{ "type": string?, "error": { "id": string REQ, "status": int REQ, "code": string REQ,
  "detail": string?, "meta": object? }, "time": int? }
```
(The reference's description of `error.status` says "expressed as a string value" but types it
`int`; parse leniently.)
- 401 / 402 / 403: NOT ESTABLISHED by the reference or any Brave-owned page found. Third-party
  reports (apidog blog, community.brave.app thread) say an invalid token surfaces with
  `error.code` `SUBSCRIPTION_TOKEN_INVALID` — one report with HTTP **422** — and that 429 carries
  `RATE_LIMITED` or `QUOTA_LIMITED` codes. Not official; classify by `error.code` first, status second.
- 429: "When you exceed your rate limit, the API will return a 429 status code and your request will fail."

### Rate limits / headers (guide)
- "Rate limits are enforced using a 1-second sliding window"; plans have per-second burst AND per-month quota "that must be respected simultaneously".
- `X-RateLimit-Limit` e.g. `1, 15000` (per-window maximums; monthly "0 for unlimited").
- `X-RateLimit-Policy` e.g. `1;w=1, 15000;w=2592000` — "Windows are always expressed in seconds."
- `X-RateLimit-Remaining` e.g. `0, 14523`.
- `X-RateLimit-Reset` e.g. `1, 1234567` — "expressed in seconds from now" (RELATIVE seconds). Confirmed.
- Lists are comma-separated and position-aligned across the four headers (shown by the examples).
- On 429: "check the X-RateLimit-Reset header to determine how long to wait before retrying."
- "The request count is increased when request is received." Whether a 429'd request consumes the per-second window: NOT ESTABLISHED.

### Billing
- "Only successful requests (non-error responses) are counted against your quota and billed." Confirmed.
- Per-request price: NOT ESTABLISHED by the pages read (not requested by the spec).

### Differences from the spec's claims
1. None on q (600 chars AND 75 words confirmed), count (max 20), reset units (relative seconds), aligned lists, success-only billing.
2. `offset` max is **9** (page index 0–9) — state the cap explicitly.
3. `extra_snippets` is typed `string` in the reference (guide passes `true`); send the literal `true`.
4. `meta_url` sub-fields on `web.results[]` are not specified by the reference; treat every member as optional.
5. 401/402/403 are not documented by Brave; only 404/422/429 are. Auth failure may come back as 422 (third-party report).

### NOT ESTABLISHED
- Official status/body for invalid token, quota exhaustion, plan not subscribed (401/402/403).
- `page_age` format; `meta_url` members on web results.
- Whether X-RateLimit-* headers are present on every 200 (guide implies, does not state).

---------------------------------------------------------------------------------------------------

## 2. Exa Search

### Sources read (2026-10-17)
- https://exa.ai/docs/reference/search.md — request fields, contents/highlights options, response top level, error list.
- https://exa.ai/docs/exa-spec.yaml — read in chunks (0–300k of 399k); established exact `CostDollarsOutput`, `SearchResultOutput`, `ErrorResponse` schemas.
- https://exa.ai/docs/search/highlights.md — highlights behaviour; no pricing, no `numSentences`.
- https://exa.ai/docs/admin/error-codes — status table and tag table (re-read).
- https://exa.ai/docs/reference/rate-limits — QPS limits, Retry-After.
- https://exa.ai/docs/admin/pricing.md — per-request and per-result prices (re-read twice).

### Request
- `POST https://api.exa.ai/search`, `Content-Type: application/json`.
- Auth: `x-api-key: <key>` **or** `Authorization: Bearer <key>`.

| Field | Type | Default / limits |
|---|---|---|
| `query` | string | **REQ**, minLength 1 |
| `type` | enum | default `auto`; `instant`,`fast`,`auto`,`deep-lite`,`deep`,`deep-reasoning` (open enum) |
| `numResults` | integer | default 10, min 1, max 100 (pricing page lists "requests above 25 results" as an Enterprise feature) |
| `includeDomains` / `excludeDomains` | string[] | max 1200 items each; hostnames, host/path prefixes, `*.subdomain` wildcards |
| `startPublishedDate` / `endPublishedDate` | string | ISO 8601 `date-time` |
| `startCrawlDate` / `endCrawlDate` | string | **Deprecated, ignored**, adds an `IGNORED_FIELD` warning |
| `category` | enum | `company`,`publication`,`news`,`personal site`,`financial report`,`people`; `company`/`people` reject published-date filters, `people` rejects `excludeDomains` → 400 |
| `userLocation` | string \| object | ISO 3166-1 alpha-2, or `{country, latitude, longitude}` |
| `moderation` | boolean | default `false` |
| `contents` | object | see below |
| `includeText` / `excludeText` / `context` | | deprecated |

`contents.highlights`: `boolean` (default `false`) or object:
- `maxCharacters` integer 1–1,000,000 ("caps highlight text per URL"); not compatible with `dynamic`.
- `query` string.
- `numSentences` — **deprecated**, mapped to ~1333 characters per sentence; use `maxCharacters`.
- `highlightsPerUrl` — **deprecated, ignored**.
- `verbosity` (`low`/`medium`/`high`) and `dynamic` boolean — beta, require header `Exa-Beta: dynamic-highlights-2026-08-28`.
- highlights.md: `highlights: true` is "the recommended default"; Exa "chooses how much text to return from each result based on its relevance". No default character count stated.
- Other `contents` members: `text`, `summary`, `extras`, `livecrawlTimeout` (ms, default 10000, max 90000), `maxAgeHours` (-1..720), `snapshotAsOf`, `subpages`, `subpageTarget`, deprecated `livecrawl`, `crawledBeforeDate`.

The spec's request `{query, type:"auto", numResults:20, contents:{highlights:{maxCharacters:1600}}}` is valid.

### Response (200)
`SearchResultsResponse` requires only `results`. Top level: `requestId`, `results`, `costDollars`,
`searchTime` (number, ms), `warnings`, `notices`, `resolvedSearchType` (deprecated, may be `""`),
`output` (synthesis only), `context` (deprecated). Response headers: `x-request-id`, `x-exa-queued`, `x-exa-queue-ms`.

`SearchResultOutput` (required: `title`, `url`; `additionalProperties: false`):
| Field | Type |
|---|---|
| `title` | string (REQ, not nullable) |
| `url` | string, format uri (REQ) |
| `id` | string |
| `publishedDate` | string, date-time (not nullable, but OPT) |
| `author` | string \| null |
| `highlights` | string[] |
| `highlightScores` | number[] (float) |
| `image`, `favicon` | string uri |
| `text`, `summary` | string |
| `subpages`, `entities`, `extras` | arrays/object |
**There is no `score` field** on search results.

`CostDollarsOutput` (no required list, `additionalProperties: false`):
```
{ total: number,
  search:   { neural: number, keyword: number },
  summary:  number,
  contents: { text: number, highlights: number, summary: number } }
```
No `breakDown`/`breakdown` key exists. All members OPT in the schema.

### Errors (error-codes page; ErrorResponse schema)
Body (required: `requestId`, `error`, `tag`; additionalProperties false):
`{"requestId":"…","error":"Invalid request body | Validation error: …","tag":"INVALID_REQUEST_BODY"}`
`tag` is open-ended: "Unrecognized tags should be treated as generic errors for the HTTP status."

| Status | Meaning (quoted) | Tags |
|---|---|---|
| 400 | "The body, query parameters, headers, or combination of options is invalid." | `INVALID_REQUEST_BODY` |
| 401 | "The API key is missing or invalid." | `INVALID_API_KEY` |
| 402 | "Credits are exhausted or a spending budget was exceeded." | `NO_MORE_CREDITS`, `API_KEY_BUDGET_EXCEEDED`, `TEAM_BUDGET_EXCEEDED`; keyless x402 endpoints: `X402_PAYMENT_REQUIRED` |
| 403 | "…does not have access to the requested feature, or the request was blocked by policy." | `TEAM_BLOCKED`, `FEATURE_DISABLED` (search.md) |
| 404 | route/resource does not exist | |
| 429 | "Your API key, team, or network exceeded a rate or concurrency limit." | `RATE_LIMIT_EXCEEDED` |
| 500 | "An unexpected server error occurred." | |
| 503 | "Exa is temporarily over capacity (`SERVICE_OVERLOADED`) or unavailable. The request was not processed and is not billed." | `SERVICE_OVERLOADED` |
| 504 | "The request exceeded its processing deadline." | |
Quota (402 tags) vs rate (429) vs auth (401) vs policy (403) are distinct.

### Rate limits
- "Rate limits are measured in queries per second (QPS) and apply to your team as a whole, across all of its API keys."
- `/search`: "10 QPS"; deep types: "5 QPS".
- 429: "wait for `Retry-After` seconds when present, otherwise use exponential backoff." No other rate-limit headers documented.

### Pricing (pricing.md)
- `fast`/`auto`: "$7 / 1k requests"; `instant` "$4 / 1k"; deep-lite/deep "$12 / 1k"; deep-reasoning "$15 / 1k".
- "Each endpoint has a base price per request that includes up to 10 results."
- "The base price covers the first 10 results in a request; every result above 10 adds $1 / 1k results."
- `/contents`: "$1 / 1k pages, per content type". Whether highlights requested through `/search` `contents` are billed at that rate: NOT ESTABLISHED by pricing.md (it does not address `/search` contents). `costDollars.contents.highlights` exists, so read the per-call charge from `costDollars.total`.
- 20-result auto search, documented components: $0.007 base + 10 × $0.001 = **$0.017** per request, plus highlights at up to 20 × $0.001 = $0.020 IF billed at the contents rate (unestablished) → bound $0.017–$0.037.
- spec yaml `x-payment-info` for `/search`: min "0.007", max "0.015" (x402 pricing metadata; inconsistent with the $0.017 computation; not authoritative for keyed billing).
- Free tier: "$10 in credits", resets "to $10 on the first of every month".

### Differences from the spec's claims
1. `score` is not a result field; `highlightScores` (number[]) is the only score.
2. `costDollars` has no `breakdown`; shape is `{total, search{neural,keyword}, summary, contents{text,highlights,summary}}`.
3. Crawl-date filters are deprecated AND ignored (with an `IGNORED_FIELD` warning), not merely deprecated.
4. `numSentences` and `highlightsPerUrl` are deprecated (`highlightsPerUrl` ignored); `maxCharacters` is the supported option.
5. Error body is `{requestId, error, tag}` with all three required; `error` is a string, `tag` the machine code.
6. 403 (`TEAM_BLOCKED`/`FEATURE_DISABLED`) and 504 exist in addition to the spec's list; 503 is explicitly "not billed".

### NOT ESTABLISHED
- Whether highlights on `/search` are charged per result.
- Whether `requestId` is always present on 200 (schema does not require it).
- Any rate-limit header other than `Retry-After`.

---------------------------------------------------------------------------------------------------

## 3. DeepSeek Search

### Sources read (2026-10-17)
- https://api-docs.deepseek.com/guides/search/ — endpoint, auth, fields, operators, response,
  QPS, pricing, error table, error body example (re-read).
- https://api-docs.deepseek.com/api/search — reference schema: request constraints and the
  `results[]` item schema with required/nullable markers. Does not document non-200 responses or auth.

### Request
- `POST https://api.deepseek.com/v1/tools/search`; `Authorization: Bearer <DeepSeek API Key>`; `Content-Type: application/json`.

| Field | Type | Default | Limits |
|---|---|---|---|
| `query` | string | **REQ** | "must contain 1 to 128 Unicode characters", "cannot be all whitespace", supports operators |
| `count` | integer | 10 | "between 1 and 50" |
| `need_content` | boolean | `false` | when `false`, `content` "is always an empty string" |
| `ori_question` | string \| null | none | 1–128 characters; "`null` treated as not provided" |
| `localization` | string | `""` | "An optional IP address used to localize search results." |
"Unknown fields in the request body are ignored."

Operators ("The query is forwarded with its search syntax intact"): `site:` (multiple: "separate the
`site:` clauses with spaces and join them with `OR`"), `-site:`, `-term`, `-"phrase"`, `"phrase"`,
`lang:` (e.g. `lang:zh,en`), `after:` (e.g. `after:2025`), `before:` (e.g. `before:2026-06-01`).
Whether operator text counts toward 128: NOT ESTABLISHED explicitly; the limit is stated on the
`query` string, which carries the operators as text (inference: count them).

### Response (200)
`{ "results": [ … ] }` — `results` REQ; "A normal search with no matches returns an empty array."
Every item field is REQUIRED (present); three are nullable:
| Field | Type | Notes |
|---|---|---|
| `rerank_score` | number | 0–3 ("1.5 or higher is high quality" per reference) |
| `title` | string | |
| `url` | string | |
| `snippet` | string | ~100–200 chars, for UI |
| `summary` | string | ~600–800 chars, "intended to be read by a model" |
| `content` | string | empty when `need_content` false or unavailable |
| `site_name` | string \| null | |
| `site_icon` | string \| null | |
| `date` | string \| null | RFC 3339 UTC, null when unknown |
| `authority` | integer | -1..4; "`-1` means unknown"; ≥3 "highly authoritative" |

### Errors
OpenAI-compatible body; "The `param` field is always `null`." Example:
`{"error":{"message":"'count' must be between 1 and 50","type":"invalid_request_error","param":null,"code":"invalid_request_error"}}`
| Status | Meaning (quoted) |
|---|---|
| 400 | "The request headers or body are invalid, including malformed JSON or an invalid field value." |
| 401 | "The API key is missing or invalid." |
| 402 | "The account has insufficient balance." |
| 408 | "Reading the request body timed out." |
| 413 | "The request body is too large." |
| 429 | "The Search or Fetch QPS limit was exceeded." |
| 500 | "An internal server error occurred." |
| 504 | "A downstream request timed out." |
(403/404 listed for Fetch only.) Retry: "For HTTP 408, 429, or 5xx errors, wait and retry." "For HTTP 402, top up your account before retrying." "Do not retry other 4xx errors without changing the request."
`type`/`code` values for 401/402/429: NOT ESTABLISHED (only the 400 example is shown).

### Rate limits
- Search QPS **5**; "calculated at the account level, regardless of which API key is used." Over-limit → 429.
- No rate-limit or `Retry-After` header documented.

### Billing
- Search "$0.75" per 1,000 successful requests (= $0.00075/request). Confirmed.
- "A request is billable only when it returns HTTP 200 and produces a result." "Failed requests, empty search results, and timeouts are not billed." `count` "does not affect the per-request price."

### Differences from the spec's claims
1. `count` max is **50**.
2. 422 and 503 are NOT documented; documented set is 400/401/402/408/413/429/500/504.
3. Result item field names are `site_name` and `site_icon` (no `site` field); all ten fields always present, three nullable.
4. `localization` is an IP address string (not a locale/country code).
5. Additional operators exist: `-term`, `-"phrase"`, `lang:`, `after:`, `before:`, `OR` between `site:` clauses.
6. `ori_question` is also capped at 128 characters.

### NOT ESTABLISHED
- Whether operators count against 128 (stated only for the whole `query`).
- `error.type`/`error.code` strings for 401/402/429.
- Any rate-limit header.

---------------------------------------------------------------------------------------------------

## 4. Tavily Search

### Sources read (2026-10-17)
- https://docs.tavily.com/documentation/api-reference/endpoint/search — full request/response/error schema (re-read for credit and limit text).
- https://docs.tavily.com/documentation/rate-limits — RPM, Retry-After, 429.
- https://docs.tavily.com/documentation/api-credits — credits per depth, free credits, PAYG price.
- https://docs.tavily.com/documentation/api-reference/endpoint/usage — GET /usage schema.
- https://help.tavily.com/articles/8645538886-understanding-http-errors — 400/401/429/432/433/500 meanings.

### Request
- `POST https://api.tavily.com/search`; `Authorization: Bearer tvly-…`; `Content-Type: application/json`.

| Field | Type | Default | Values / limits |
|---|---|---|---|
| `query` | string | **REQ** | |
| `search_depth` | string | `basic` | `advanced` ("2 API Credits"), `basic`/`fast`/`ultra-fast` ("1 API Credit") |
| `chunks_per_source` | integer | 3 | 1–3; only for `advanced`,`basic`,`fast` |
| `max_results` | integer | 10 | 0–20 |
| `include_answer` | bool \| string | `false` | `true`,`false`,`basic`,`advanced` |
| `include_raw_content` | bool \| string | `false` | `true` (=markdown),`markdown`,`text` |
| `include_usage` | boolean | `false` | "Whether to include credit usage information in the response." |
| `include_published_date` | boolean | `false` | **exists**, beta: "Include a `published_date` field in each result." "Results with no detectable date return `null`." "Automatically enabled when `topic` is `news`." |
| `filter_by_published_date` | boolean | `false` | removes out-of-window and undated results; implies `include_published_date` |
| `auto_parameters` | boolean | `false` | "This uses 2 API credits per request. To avoid the extra cost, you can explicitly set `search_depth` to `basic`." |
| `include_domains` | string[] | `[]` | max 300 |
| `exclude_domains` | string[] | `[]` | max 150 |
| `include_domains_mode` | string | `restrict` | `restrict`,`prefer`; "Setting it without `include_domains` returns a 400 error." |
| `start_date` / `end_date` | string | null | `YYYY-MM-DD` |
| `time_range` | string | null | `day`,`week`,`month`,`year`,`d`,`w`,`m`,`y` |
| `topic` | string | `general` | `general`,`news`,`finance` |
| `country` | string | null | lowercase English country names (e.g. `united states`); only with `topic: general` |
| `language` / `filter_by_language` | string / boolean | null / false | ISO 639-1 or English name; filter requires `language` else 400 |
| `exact_match`, `safe_search`, `include_images`, `include_image_descriptions`, `include_favicon` | boolean | false | `safe_search` unsupported for `fast`/`ultra-fast` |
`days` is not in the current spec.

### Response (200)
Spec-required: `query`, `results`, `images`, `response_time`, `answer` (but `answer` only appears with `include_answer`).
- `results[]`: `title` string, `url` string, `content` string, `score` number, `raw_content` string|null (only with `include_raw_content`), `published_date` string|null (only with `include_published_date` or `topic: news`), `favicon` string, `images`, `id` string.
- `response_time`: number (float, seconds) — the spec example shows the STRING `'1.67'`; parse both.
- `usage`: object, example `{"credits": 1}`; sub-fields not formally defined ("Credit usage details for the request.").
- `request_id`: string. `auto_parameters`: object (only when requested).

### Errors (search reference + help article)
Body: `{"detail":{"error":"<message>"}}` (ApiError); 422 is FastAPI-style `{"detail":[{"type","loc","msg","input"}]}`.
| Status | Meaning | Class |
|---|---|---|
| 400 | invalid request parameters | request |
| 401 | "Unauthorized: missing or invalid API key." | auth |
| 422 | body validation failed | request |
| 429 | "Your request has been blocked due to excessive requests. Please reduce the rate of requests." + `Retry-After` (seconds) | rate |
| 432 | "Key limit or Plan Limit exceeded" — "This request exceeds your plan's set usage limit. Please upgrade your plan or contact support@tavily.com." | quota (plan or key) |
| 433 | "This request exceeds the pay-as-you-go limit. You can increase your limit on the Tavily dashboard." | quota (PAYG cap) |
| 500 | "Internal Server Error" | server |
403: "The specification doesn't define a 403 response" — NOT ESTABLISHED.

### Rate limits
- Development keys 100 RPM; production keys 1,000 RPM ("an active Paid Plan or PAYGO enabled"). Page does not name /search specifically.
- Only header documented: `Retry-After` (integer seconds; "use the value returned in the response"). Status 429.

### GET https://api.tavily.com/usage
- `Authorization: Bearer <key>`; optional header `X-Project-ID`.
- 200: `{ "key": { usage, limit, search_usage, extract_usage, crawl_usage, map_usage, research_usage },
  "account": { current_plan (string), plan_usage, plan_limit, paygo_usage, paygo_limit, search_usage,
  extract_usage, crawl_usage, map_usage, research_usage } }` — all integers except `current_plan`;
  no required list; `key.limit` description: "Returns null if unlimited" (schema types it plain integer).
- Errors documented: 401, 429 (`Retry-After` integer seconds). No numeric rate limit for /usage.

### Billing
- basic 1 credit, advanced 2 credits; `auto_parameters` 2 credits; "1,000 free API Credits every month"; PAYG "$0.008 per credit".
- Whether failed /search requests cost credits: NOT ESTABLISHED (stated only for Extract and Map: "never get charged" on failure).

### Differences from the spec's claims
1. `include_published_date` exists (beta) — and `filter_by_published_date` is a separate hard filter.
2. `include_domains_mode` exact name confirmed; values `restrict` (default) | `prefer`; 400 without `include_domains`.
3. 403 is not defined by Tavily's spec or help article.
4. `response_time` is typed number but exemplified as a string.
5. `country` takes lowercase English names, not ISO codes, and only applies to `topic: general`.
6. Advanced = 2 credits confirmed; `auto_parameters: true` also costs 2 credits.

### NOT ESTABLISHED
- 403 meaning; credit charge on failed search; formal `usage` sub-schema beyond `credits`.

---------------------------------------------------------------------------------------------------

## 5. Context7 v3 search

### Sources read (2026-10-17)
- https://context7.com/docs/search-api — overview: endpoint, params, `version` strictness sentence, 404 as empty, pricing (re-read character-for-character).
- https://context7.com/docs/api-guide — endpoints list, rate-limit headers, error-code table, error body.
- https://context7.com/docs/llms.txt — index; located the API reference page below.
- https://context7.com/docs/api-reference/search/search-documentation-in-one-request.md — the authoritative OpenAPI-derived reference (re-read for exact descriptions).
- https://context7.com/docs/openapi.json — **HTTP 404** (does not exist at that URL; so it cannot be checked for v3).
- https://raw.githubusercontent.com/upstash/context7/master/packages/sdk/src/commands/types.ts — SDK `SearchResponse`, `SearchOptions`.
- https://raw.githubusercontent.com/upstash/context7/master/packages/sdk/src/commands/get-context/types.ts — `ApiCodeSnippet`, `ApiInfoSnippet`.
- https://raw.githubusercontent.com/upstash/context7/master/packages/sdk/src/commands/search/index.ts — path `v3/search`, params.
- https://raw.githubusercontent.com/upstash/context7/master/packages/sdk/src/http/response.ts — error parsing and rate-limit header parsing.
- https://raw.githubusercontent.com/upstash/context7/master/packages/mcp/src/lib/api.ts — MCP server uses v2 only; no 402/503 handling.

### Request
- `GET https://context7.com/api/v3/search` (server `https://context7.com/api`, path `/v3/search`).
- Auth: `Authorization: Bearer ctx7sk…` (security is optional; keyless is "for testing only and are rate-limited by IP address").

| Param | Type | Constraints |
|---|---|---|
| `query` | string | **REQ**, minLength 1, maxLength 2000 |
| `library` | string[], `style: form`, `explode: true` (repeat the param) | maxItems **4**; each 1–120 chars; name (`next.js`) or ID (`/vercel/next.js`); a `@15` suffix acts as version for that library |
| `version` | string | pattern `^([Ll][Aa][Tt][Ee][Ss][Tt]\|[Vv]?[0-9]+([._][0-9]+){0,2}([-+][a-zA-Z0-9.-]+)?)$`; "`latest` (any case) is the same as no version." |
| `language` | string | 1–40 chars; soft preference |
| `type` | enum `json`\|`txt` | REST default **`txt`** (SDK defaults to `json`) |

`version` semantics: overview says "Strict with one library, a preference with several." The
reference's own description: with one library the API PREFERS docs matching that version and, when
it falls back to current docs, serves them and FLAGS the response (`X-Context7-Search-Status:
partial`, `X-Context7-Search-Reason: versionUnverified|versionPrerelease`,
`X-Context7-Search-Version: verified|prerelease|unverified`, and body `version.status`). So "strict"
does not mean a hard failure; the adapter must read the flags.

### Response 200 (`type=json`, `SearchContextResponse`)
```
{ codeSnippets: SearchCodeSnippet[]  (REQ),
  infoSnippets: SearchInfoSnippet[]  (REQ),
  rules?: { global: string[], libraries: [{ libraryId, libraryOwn: string[], libraryTeam: string[] }] },
  version?: { requested?: string, status: "verified"|"prerelease"|"unverified",
              libraries: [{ libraryId, requested, served: string|null, status }] } }
```
`SearchCodeSnippet` — reference REQUIRED: `codeTitle`, `codeDescription`, `codeLanguage`,
`codeTokens` (integer), `codeId` (string, source URL), `pageTitle`, `codeList` (`[{language, code}]`,
both REQ), `libraryId`; OPT: `isDynamic` boolean, `sourceFile` string. (SDK types mark `codeTokens?`
and `pageTitle?` optional — treat them as optional when parsing.)
`SearchInfoSnippet` — reference REQUIRED: `content`, `contentTokens` (integer), `libraryId`; OPT:
`pageId` (source URL), `breadcrumb`. (SDK marks `pageId` required and `contentTokens?` optional —
parse all but `content`/`libraryId` as optional.)
`rules` shape is ambiguous in the reference (allOf of two `rules` schemas); SDK: `rules?: { global:
string[]; libraries: {libraryId; libraryOwn: string[]; libraryTeam: string[]}[] }`.
`type=txt`: `text/plain`, layout not defined.

### Errors (reference; body `{ "error": <code string>, "message": <string> }`, both REQ)
| Status | `error` | Meaning |
|---|---|---|
| 400 | `validation_error`, `invalid_library_id` | invalid input / malformed library ID |
| 401 | `invalid_api_key` | key invalid or missing |
| 402 | `spending_limit_exceeded` | "Payment Required - the teamspace's configured monthly spending limit has been reached." Resets next billing month or owner raises it (quota) |
| 404 | `no_documentation_found` | "No documentation matched the question or library hints" — overview: treat as empty result |
| 429 | `rate_limit_exceeded` | rate |
| 503 | `search_failed` | "The search couldn't be completed." retry later |
The api-guide also lists 202/301 (`redirectUrl`)/403/409/422/500/504 for other endpoints.

### Rate limits / headers (429)
- `Retry-After`: integer, "Seconds until rate limit resets" (relative seconds).
- `RateLimit-Limit`, `RateLimit-Remaining`: integers.
- `RateLimit-Reset`: "Unix timestamp when limit resets" — ABSOLUTE; seconds vs milliseconds NOT ESTABLISHED (SDK `response.ts` stores the raw number, no unit; falls back to `x-ratelimit-*`). Prefer `Retry-After`.
- Request ID header: `x-request-id` (fallback `x-context7-request-id`) per SDK.

### Billing
- "Free: 1,000 calls per month." "Pro: 2,000 calls per month per seat, then $5 per 1,000 calls." (re-read; a WebSearch summary claimed 5,000/$10 — the page text says 2,000/$5).
- "Search API calls count as regular Context7 API calls."; api-guide: "Each Search API call counts as one request."

### Differences from the spec's claims
1. `openapi.json` at the given URL returns 404 — it neither includes nor omits v3; the v3 reference lives at `/docs/api-reference/search/search-documentation-in-one-request.md`.
2. `version` with one library is "strict" only in the overview; the reference says it falls back to current docs and flags it (headers + `version.status`), not an error.
3. `RateLimit-Reset` is an absolute Unix timestamp (units unstated), while `Retry-After` is relative seconds; header names are `RateLimit-*` (not `X-RateLimit-*`).
4. Required/optional members differ between the API reference and the SDK types (`codeTokens`, `pageTitle`, `pageId`, `contentTokens`, `breadcrumb`); parse defensively.
5. Extra fields exist: `isDynamic`, `sourceFile`, top-level `version`; additional 400 codes `validation_error`/`invalid_library_id`; 401 `invalid_api_key`; 429 code `rate_limit_exceeded`.
6. `query` maxLength 2000; `library` items maxLength 120; `language` maxLength 40.

### NOT ESTABLISHED
- `RateLimit-Reset` unit (s vs ms). Numeric rate limits per plan. Whether 404/402/503 calls count as billable calls.

---------------------------------------------------------------------------------------------------

## 6. Ref MCP

### Sources read (2026-10-17)
- https://docs.ref.tools/context/install/index — hosted URL, auth options, transport.
- https://ref.tools/mcp — returned a single marketing line ("Review the Plan before the Code."); nothing usable.
- https://docs.ref.tools/context/mcp/tools — tool names, params, descriptions; no output format.
- https://raw.githubusercontent.com/ref-tools/ref-tools-mcp/main/index.ts — legacy stdio server source; exact strings below (read twice, second time as code).
- https://raw.githubusercontent.com/ref-tools/ref-tools-mcp/main/README.md — "This repo contains the legacy stdio server."; hosted URL with `?apiKey=`; header `x-ref-api-key`.
- https://docs.ref.tools/usage/credits — 1 credit per search/read, 200 free credits, no balance API.
- https://docs.ref.tools/usage/pricing.md — plan prices.
- https://docs.ref.tools/llms.txt — index; no REST/balance/auth API pages exist.

### Transport and auth (hosted)
- URL: `https://api.ref.tools/mcp`; Streamable HTTP ("streamable HTTP server"; README "Streamable HTTP (recommended)").
- Auth alternatives: header `x-ref-api-key: YOUR_API_KEY`, or query `?apiKey=YOUR_API_KEY`, or neither → "your MCP client will initiate OAuth sign-in."

### Tools (hosted docs)
- `ref_search_documentation` — input `query` (string): "Your search query. Include programming language, framework, or library names for best results." Description: "Search across your indexed documentation resources."
- `ref_read_url` — input `url` (string): "The exact URL from a search result." Description: "Read the full content of a documentation URL. Can read URLs from search results or any URL from the web."
- Hosted output format, `outputSchema`, no-results text, and error behaviour: NOT ESTABLISHED by docs.ref.tools (the tools page states none of them). The hosted descriptions differ from the legacy source's, so the hosted server is a different implementation.

### Legacy implementation (index.ts) — exact strings
- Tool defs: `name: 'ref_search_documentation'`, `inputSchema {type:'object', properties:{query:{type:'string',…}}, required:['query']}`, `annotations: { readOnlyHint: true }`; `name: 'ref_read_url'`, `properties.url {type:'string', description:'The URL of the webpage to read.'}`, `required:['url']`, `annotations: { readOnlyHint: true }`. **No `outputSchema`** on either.
- Client `openai-mcp` renames tools to `search` / `fetch` and returns JSON text instead.
- Search success: one `text` content item PER doc, no separator, template:
  ```
  `overview: ${doc.overview || ''}
  url: ${doc.url}
  moduleId: ${doc.moduleId || ''}`
  ```
  (three lines, newline-separated, no indentation in the emitted text).
- No results (`data.docs.length === 0`): `{ content: [{ type: 'text', text: 'No results found' }] }`.
- Read success: `{ content: [{ type: 'text', text: data.content || '' }] }` (no truncation in source; README says hosted read can "return the most relevant 5k tokens").
- Errors — all returned as ordinary text content, **`isError` never set**:
  - No key: `'Ref is not correctly configured. Reach out to hello@ref.tools for help.'`
  - Search 401: `'Please verify your email at https://ref.tools/dashboard to search documentation'`
  - Read 401: `'Please verify your email at https://ref.tools/dashboard to read URLs'`
  - Search other: `` `Error during documentation search: ${message}` ``
  - Read other: `` `Error reading URL: ${message}` `` (`message` = axios `error.message`).
  - Unknown tool name: throws `McpError` `MethodNotFound`.
- Legacy backend: `GET https://api.ref.tools/search_documentation?query=<enc>` and `GET https://api.ref.tools/read?url=<enc>` with headers `X-Ref-Alpha` / `X-Ref-Api-Key` (and `mcp-session-id`). Response fields read: `docs[].overview`, `docs[].url`, `docs[].moduleId` (`title`, `content` only in the openai branch); read: `content`, `title`.

### Billing
- "`ref_search_documentation` and `ref_read_url` each cost 1 credit." "All accounts start with 200 free credits that never expire."
- Pro "$50/mo with 6,000 credits per month"; Max "$200/mo with 30,000 credits per month"; PAYG (Pro+) "$10 per 1,000 additional credits", charged at cycle end.
- Balance API: none documented; "you can view your usage at ref.tools/activity". Behaviour at zero credits: NOT ESTABLISHED.

### Differences from the spec's claims
1. Auth may be header `x-ref-api-key` OR query `apiKey` OR OAuth (the legacy REST backend uses `X-Ref-Api-Key`/`X-Ref-Alpha`, not the MCP endpoint).
2. The overview/url/moduleId format, the `No results found` sentinel and text-not-isError errors are facts about the LEGACY stdio repo only; the hosted server's output is undocumented.
3. Legacy search returns one content item per result (not one text blob with separators).
4. No balance API exists.

### NOT ESTABLISHED
- Hosted server: output text format, `outputSchema`/`structuredContent`, no-results sentinel, error signalling (isError or text), out-of-credit behaviour, rate limits.

---------------------------------------------------------------------------------------------------

## 7. OpenRouter Decisions (Jev)

### Sources read (2026-10-17)
- https://openrouter.ai/docs/api/api-reference/alphadecisions/submit-a-decisions-request — full request/response/error schema.
- https://openrouter.ai/typesafe/jev-1.14 — **HTTP 404** to WebFetch; also https://openrouter.ai/typesafe/jev-1.14-20261014 404.
- https://openrouter.ai/compare/typesafe/jev-1.14 — "$0.042/M tokens input", "$0/M tokens output".
- https://openrouter.ai/docs/guides/community/jev — model IDs, context length, 32,000-byte long-context threshold, output free, `usage.cost` (re-read).
- https://openrouter.ai/docs/guides/community/jev-tutorial — criteria shapes and answer semantics.
- https://raw.githubusercontent.com/OpenRouterTeam/skills/main/skills/openrouter-decisions/references/decisions-api.md — condensed schema; optional-field guidance.
- https://raw.githubusercontent.com/OpenRouterTeam/skills/main/skills/openrouter-decisions/references/decision-model-limits.md — behavioural limits only; no numbers.
- SDK model pages: …/client-sdks/typescript/models/decisionsrequest, decisionsresponse, decisionsscoreanswer, decisionsnoulanswer, decisionschoiceanswer, decisionsresponseusage.
- https://openrouter.ai/docs/cookbook/evaluate-and-optimize/jev-classification — $0.042/M at time of writing, 402 in-flight retry logic.
- https://openrouter.ai/docs/api-reference/limits.md — in-flight budget, `limit_source` values, 402/403/429 bodies, headers (re-read).
- WebSearch: listing snippet "Price $0.042 / $0 per 1M Context 262K Released Oct 14, 2026".

### Request
- `POST https://openrouter.ai/api/alpha/decisions` (overrides the global `/api/v1` server); `Authorization: Bearer <key>`; `Content-Type: application/json`.
- Body REQ: `model` (string), `state` (string | object | array; no length limit documented), `questions` (object: name → question; no key or count limit documented).
- OPT: `provider` (ProviderPreferences), `session_id` (≤256 chars), `trace` (`trace_id`,`trace_name`,`span_name`,`generation_name`,`parent_span_id` + extra keys), `user` (≤256 chars).
- Question variants (discriminator `type`; `instructions` REQ, string|object|array):
  - `score`: `criteria` REQ, **array, minItems 1**, items string|object|array — "ordered array, lowest level first".
  - `noul`: `criteria` REQ in the API reference — object with REQUIRED keys `"true"` and `"false"` (values string|object|array). (Skill file says "`noul.criteria` is optional"; the cookbook sends noul without criteria. Conflict — send it.)
  - `choice`: `criteria` REQ — object, any keys (option names) → description (string|object|array|null).
  - `box`: no `criteria` (image bounding box; Jev 1.14 only; 1.13 returns 400).
- Model IDs: `typesafe/jev-1.14` "is the current model"; `~typesafe/jev-latest` alias; `typesafe/jev-1.13` still available. Responses name the dated snapshot (e.g. `jev-1.14-20261014`).

### Response (200)
- REQ: `model` (string, "the exact build that answered"), `answers` (object), `usage`. OPT: `id` (string), `provider` (string).
- `usage`: `input_tokens` integer REQ, `output_tokens` integer REQ, `cost` number **OPT** in schema (guide: "Every Jev response includes a `usage.cost` field … in USD").
- `answers[key]`, discriminated by `type`:
  - `{type:"score", score: number REQ, confidence?: number, probabilities?: {[index string]: number}, legend?: {[index string]: string|object|array}}` — `score` is a probability-weighted position, "index `0` corresponding to the first criterion you listed"; probabilities keyed `"0"`,`"1"`,…; `legend` maps index → criterion text.
  - `{type:"noul", noul: number REQ}` — probability of yes, 0–1. No `confidence` / `probabilities`.
  - `{type:"choice", choice: string REQ, confidence?: number, probabilities?: {[option]: number}}`.
  - `{type:"box", box:{top,bottom,left,right} REQ, confidence?: number}`.
  - Skill: "`noul`, `choice`, and `score` are always present"; "The schema marks `probabilities`, `confidence`, and `legend` optional" — presence-check them.

### Errors
Envelope (all statuses): `{ "error": { "code": int REQ, "message": string REQ, "metadata": object|null OPT }, "openrouter_metadata"?: object|null, "user_id"?: string|null }`.
| Status | Reference meaning / example message |
|---|---|
| 400 | invalid parameters — "Invalid request parameters" |
| 401 | missing/invalid credentials — "Missing Authentication header" |
| 402 | insufficient credits or quota — "Insufficient credits. Add more using https://openrouter.ai/credits" |
| 403 | not permitted (also budget errors, below) |
| 404 | "Resource not found" |
| 413 | "Request payload too large" |
| 429 | "Rate limit exceeded" |
| 500 / 502 / 503 / 524 / 529 | server / "Provider returned error" / unavailable / edge timeout / provider overloaded |
(No 408 or 422 documented for this operation.)

402 `error.metadata.limit_source` (limits.md):
- `openrouter_in_flight_budget` with `"reason": "in_flight_budget_exhausted"` — TRANSIENT: "The response includes a Retry-After header; wait for it and retry." Can occur "with no request still running, while recent costs are settling." Example:
  `{"error":{"code":402,"message":"This request would exceed your available credits given your current in-flight requests. ...","metadata":{"reason":"in_flight_budget_exhausted","limit_source":"openrouter_in_flight_budget","remedy_hint":"Retry after your in-flight requests settle (see the Retry-After header). ..."}}}`
- `openrouter_credits` with `"reason": "weight_exceeds_budget"` — single request larger than the whole budget; "retrying will not help". Also "openrouter_credits means your balance cannot cover the request".
- `openrouter_key_limit` — "the API key's credit limit is exhausted."
- "branch on limit_source, not on the hint text"; `remedy_hint` is human text.
403 budget errors: `limit_source` `openrouter_guardrail_budget` | `openrouter_workspace_budget` | `openrouter_key_limit`, with `resets_at` (ISO 8601 UTC or null); "there is no Retry-After header".
429 body: `{"error":{"code":429,"message":"Rate limit exceeded","metadata":{"error_type":"rate_limit_exceeded"}}}`; error response carries `X-RateLimit-Limit`, `X-RateLimit-Remaining`, `X-RateLimit-Reset` (units NOT ESTABLISHED); `Retry-After` when providers gave a hint. "Successful inference responses do not include X-RateLimit-* headers."

### Limits
- "Context length is 262,144 tokens." — "the `state` you send plus the questions."
- "Requests with more than about 32,000 bytes of text, and every request with an image, run in TypeSafe's long-context mode" — "slower and less accurate".
- Questions per request, max state bytes, request size limit (413 threshold): NOT ESTABLISHED.
- Questions in one request "are answered in parallel and can't see each other's answers."

### Pricing
- `$0.042/M tokens input`, `$0/M tokens output` (compare page; cookbook "costs $0.042 per million input tokens" at time of writing). "Output tokens are free."
- In-flight budget "does not apply to requests to free models"; Jev is not free (input priced).

### Differences from the spec's claims
1. A fourth question type `box` exists (criteria-less, image bbox).
2. `noul.criteria` is REQUIRED by the API reference with exactly `"true"`/`"false"` keys (the skill doc calls it optional — conflict).
3. `score.criteria` must have at least one item; `choice.criteria` values may be null.
4. `noul` answers carry only `{type, noul}` — no `confidence`/`probabilities`.
5. `usage.cost` is optional in the schema despite the guide saying it is always included; `id` and `provider` are optional.
6. Error envelope also has optional `openrouter_metadata` and `user_id`; 402 has three `limit_source` values (only `openrouter_in_flight_budget` is retryable); budget exhaustion can be **403** with `openrouter_key_limit`/`openrouter_workspace_budget`/`openrouter_guardrail_budget`.
7. "~32k text bytes" is a long-context-mode threshold, not a hard limit; the hard context is 262,144 tokens.

### NOT ESTABLISHED
- Max questions per request; max bytes per request; `X-RateLimit-Reset` unit; whether a failed request is charged.

---------------------------------------------------------------------------------------------------

## 8. Serper

### Sources read (2026-10-17)
- https://serper.dev/ — read in two chunks (0–100k, 100k–110k). Marketing page: free tier, credit packs, QPS per pack, sample response keys. No endpoint, header, request fields, errors or docs links.
- https://serper.dev/playground — only a cookie banner (JS-rendered); nothing usable.
- WebSearch ×3 — no official Serper API reference or error documentation found; one report that serper.dev/pricing 404s.
- https://raw.githubusercontent.com/langchain-ai/langchain-community/main/libs/community/langchain_community/utilities/google_serper.py — THIRD-PARTY client source (secondary evidence only).

### Request (secondary evidence — no official reference found)
- `POST https://google.serper.dev/search` (LangChain: `f"https://google.serper.dev/{search_type}"`).
- Header `X-API-KEY: <key>`, `Content-Type: application/json` (LangChain).
- LangChain sends `q`, `gl`, `hl`, `num`, `tbs` as URL query parameters (`params=`), not a JSON body. Third-party guides describe a JSON body `{q, gl, hl, num, page}`. Which the server accepts officially: NOT ESTABLISHED.

### Response
- From serper.dev sample JSON: `organic[]` with `title`, `link`, `snippet`, `position`, and sometimes `sitelinks`, `date`, `attributes`; also `knowledgeGraph`, `peopleAlsoAsk`, `relatedSearches` (and `answerBox` per LangChain).
- `searchParameters`, `credits`: NOT ESTABLISHED by an official source (a third-party blog shows an illustrative top-level `credits: 1`).

### Errors
- NOT ESTABLISHED (no official status codes or bodies found; "Not enough credits" wording/status unverified).
- serper.dev: "When your credit balance reaches zero, we will stop accepting new queries." (mechanism unspecified).

### Rate limits / pricing (serper.dev)
- Free: "Get 2,500 free queries", "No credit card required."
- Packs: Starter "$50*" "50k credits ($1.00/1k)", 50 QPS; Standard "$375*" "500k credits ($0.75/1k)", 100 QPS; Scale "$1250*" "2.5M credits ($0.50/1k)", 200 QPS; Ultimate "$3750*" "12.5M credits ($0.30/1k)", 300 QPS. "Credits valid for 6 months."
- "Every time you receive successful responses to queries, we will deduct credits from your account balance." (success-only billing)
- Credits per query by `num` (third-party: 1 credit ≤10 results, 2 credits for 11–100): NOT ESTABLISHED officially.
- Rate-limit headers: NOT ESTABLISHED.

### Differences from the spec's claims
1. Endpoint, `X-API-KEY`, `{q, num, hl}` and `organic[]{title, link, snippet, position, date?}` are consistent with secondary sources, but no official reference confirms them.
2. The `credits` response field and all error codes/bodies are unconfirmed.

### NOT ESTABLISHED
- Official request encoding (JSON body vs query string), `credits` field, error statuses and bodies (400/401/403/429), credit cost per `num`, rate-limit headers.

---------------------------------------------------------------------------------------------------

## Cross-provider summary for the adapter

| Provider | Auth | Rate signal | Reset unit | Quota/budget signal | Billed on |
|---|---|---|---|---|---|
| Brave | `X-Subscription-Token` | 429 | `X-RateLimit-Reset` relative seconds (list) | not officially documented (3rd-party: `QUOTA_LIMITED`) | success only |
| Exa | `x-api-key` / Bearer | 429 `RATE_LIMIT_EXCEEDED` | `Retry-After` seconds | 402 `NO_MORE_CREDITS`/`API_KEY_BUDGET_EXCEEDED`/`TEAM_BUDGET_EXCEEDED` | 503 not billed; else per request + per result >10 |
| DeepSeek | Bearer | 429 | none documented | 402 insufficient balance | HTTP 200 with ≥1 result |
| Tavily | Bearer | 429 | `Retry-After` seconds | 432 plan/key limit, 433 PAYG limit | credits per depth; failed-search charge unstated |
| Context7 | Bearer | 429 `rate_limit_exceeded` | `Retry-After` seconds; `RateLimit-Reset` absolute Unix (unit unstated) | 402 `spending_limit_exceeded` | per call |
| Ref | `x-ref-api-key` / `?apiKey=` / OAuth | NOT ESTABLISHED | — | NOT ESTABLISHED (legacy: text, no isError) | 1 credit per search/read |
| OpenRouter Jev | Bearer | 429 (+402 `openrouter_in_flight_budget` transient) | `Retry-After`; X-RateLimit-Reset unit unstated | 402 `openrouter_credits`/`openrouter_key_limit`; 403 budgets | input tokens only |
| Serper | `X-API-KEY` (secondary) | NOT ESTABLISHED | — | NOT ESTABLISHED | "successful responses" |
