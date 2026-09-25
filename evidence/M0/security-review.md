# Version / security audit evidence — Firecrawl Pi baseline

Collected 2026-09-25 between 03:14Z and 03:23Z (UTC; local calendar date 2026-09-24).
Read-only: `npm view`, `gh api` (GitHub REST), `curl` to public JSON endpoints (nodejs.org, NVD, OSV, Docker Hub, Blogger feed), and WebFetch of documentation pages. Nothing was installed, and no Firecrawl Cloud endpoint was contacted.

Everything below is a **candidate** for review. None of it changes the pinned baseline by itself.

---

## A. MCP protocol revision

| Source | Retrieved (UTC) | Fact |
|---|---|---|
| https://modelcontextprotocol.io/specification/versioning | 2026-09-25T03:14:49Z | "The **current** protocol version is [**2026-07-28**](/specification/2026-07-28/)." The revision statuses are "**Draft**: in-progress specifications, not yet ready for consumption. **Current**: the current protocol version, which is ready for use and may continue to receive backwards compatible changes. **Final**: past, complete specifications that will not be changed." |
| same page | same | "For interoperability with servers and clients that implement the handshake-based protocol revisions (`2025-11-25` and earlier), see Backward Compatibility" |
| https://modelcontextprotocol.io/specification | 2026-09-25T03:22Z | "based on the TypeScript schema in schema.ts (…/schema/2026-07-28/schema.ts)". All Learn More cards link to `/specification/2026-07-28/…`. No RC or newer revision is mentioned. |
| `gh api repos/modelcontextprotocol/modelcontextprotocol/releases`, `/tags`, `/contents/schema` | 2026-09-25T03:22:37Z | Releases: `2026-07-28` (2026-07-28T16:47:49Z, prerelease=false), `2026-07-28-RC` (2026-05-29, prerelease), `2025-11-25`, `2025-11-25-RC`, `2025-06-18`. Schema directories: `2024-11-05, 2025-03-26, 2025-06-18, 2025-11-25, 2026-07-28, draft`. |

**Conclusion:** `2026-07-28` is the current stable revision. No dated revision, RC tag or final release after 2026-07-28 exists. The only newer material is the rolling `draft` schema directory, which is marked "not yet ready for consumption".

---

## B. MCP TypeScript SDK

### B1. `@modelcontextprotocol/server` (retrieved 2026-09-25T03:14:42Z)

`npm view @modelcontextprotocol/server versions --json`:
```
["2.0.0-alpha.1","2.0.0-alpha.2","2.0.0-alpha.3","2.0.0-alpha.4","2.0.0-beta.1","2.0.0-beta.2","2.0.0-beta.3","2.0.0-beta.4","2.0.0-beta.5","2.0.0","2.1.0"]
```
`npm view @modelcontextprotocol/server dist-tags --json`: `{ "latest": "2.1.0" }`

`npm view @modelcontextprotocol/server@2.0.0 engines dependencies peerDependencies dist.integrity dist.tarball time --json`:
- engines: `{"node": ">=20"}`
- dependencies: `{"zod": "^4.2.0", "@modelcontextprotocol/core": "2.0.0"}`
- peerDependencies: none
- dist.integrity: `sha512-YhHWdHfpFMQfd0prsEnxKeS3Qz3ytIGmsS0sth4KDjnacIT7hxk6hXHkJ9KysxlkvTM+WZAtQbbcUhdoP4Hvtw==`
- dist.tarball: `https://registry.npmjs.org/@modelcontextprotocol/server/-/server-2.0.0.tgz`
- time: 2.0.0 = `2026-07-27T23:55:22.239Z`; 2.1.0 = `2026-09-23T15:45:32.276Z`

### B2. Companion packages

Monorepo layout at tag `@modelcontextprotocol/server@2.0.0`: `gh api repos/modelcontextprotocol/typescript-sdk/contents/packages?ref=@modelcontextprotocol/server@2.0.0` (03:14:49Z) returned `client, codemod, core-internal, core, middleware, server-legacy, server`. `packages/middleware` contains `express, fastify, hono, node`.

https://ts.sdk.modelcontextprotocol.io/v2/serving/http (retrieved ~03:15Z) names two packages for Node HTTP serving:
- `import { createMcpHandler, McpServer } from '@modelcontextprotocol/server';`
- `import { toNodeHandler, localhostHostValidation, localhostOriginValidation } from '@modelcontextprotocol/node';`
- "The factory runs once per HTTP request: a fresh instance serves every request, and the handler holds nothing between requests."

npm metadata (retrieved 2026-09-25T03:15:03Z):

| Package | Released with 2.0.0 | 2.0.0 engines | 2.0.0 deps / peers | 2.0.0 integrity | Later release |
|---|---|---|---|---|---|
| @modelcontextprotocol/core | 2.0.0 (2026-07-27T23:55:21.808Z) | node >=20 | zod ^4.2.0 | `sha512-pJCEwGG7Lfr/+PQp9ZTwKXNeO5wzbfKL7H3MYpCorM4oFBoQrdjnBgEoqG+RjhsvS1FKrDbKux+M1HhlnGWqcA==` | 2.1.0 (2026-09-23) |
| @modelcontextprotocol/node | 2.0.0 (2026-07-27T23:55:17.622Z) | node >=20 | dep `@hono/node-server ^1.19.9`; peers `hono ^4.11.4`, `@modelcontextprotocol/server ^2.0.0` | `sha512-Y4hAC2XdGDUdDOCbLDOCA4+aL3NUldjsOWlDL/YwpAxrPhRm1xHd7lZ+mLacvZ9t3PaH28wgNoaLQGrIk1P2pg==` | 2.1.0 (2026-09-23; peer server ^2.1.0) |
| @modelcontextprotocol/client | 2.0.0 (2026-07-27T23:55:22.113Z) | node >=20 | zod, jose ^6.1.3, cross-spawn ^7.0.5, eventsource ^3.0.2, pkce-challenge ^5.0.0, eventsource-parser ^3.0.0, core 2.0.0 | `sha512-8f1OghQ2rjzIOfqgUCP+8GiUWqRs89njoWLNqAe8kWmDePv3s1fZXseej+QXemssEuuOvLLmLO/kqM3IQHtISw==` | 2.1.0 |
| @modelcontextprotocol/server-legacy | 2.0.0 | node >=20 | zod, cors, raw-body, content-type, pkce-challenge, express-rate-limit, core 2.0.0; peer express ^4.18 \|\| ^5 | `sha512-LnffC1BSqFMHtMQxEz92lqDpHWma+ErV3ghdHDgdkCyYzVcCYKcUT5loq4kflty+Bf9C9qjJqbnphyBWyCqo8Q==` | 2.1.0 |
| @modelcontextprotocol/hono | 2.0.0 | node >=20 | peers hono ^4.11.4, server ^2.0.0 | `sha512-lKCSXRusLxpX63G+6og9ewcRkqVbjB2xSxpvU/VJhxcUkpvGgpDrmcgNRQ4dTapGr8AspNFdRBdmJc500Vhl/A==` | 2.0.1 (2026-09-23; peer server ^2.1.0) |
| @modelcontextprotocol/express | 2.0.0 | node >=20 | dep cors; peers express, server ^2.0.0 | `sha512-Snlr8j9FR9LcVvEJPF7qJ7d5zTL4Bes2dk7RcacN9eSZ7OLohwxqhEvWu1+UxELyScgLbLLOdeVEGdwKI1iwVQ==` | 2.0.1 (2026-09-23) |
| @modelcontextprotocol/fastify | 2.0.0 | node >=20 | peers fastify ^5.2.0, server ^2.0.0 | `sha512-x41AmyQ+olgAjX8EBkVpCztxIcWaInUlVpEatUBSWINZAmTnQYSYqOp9eigb7dxE2W+CtzhP1H+9uUgHRxJPVg==` | none |

2.1.0 integrities: core `sha512-YdFj5gMRHr0gYNAhTbQDgjLHiEJdIAUYxomhKseUNye7ZGlISQmUoLh2sveFFCiQ7j2YMffT1kgSND0FSfIFjQ==`; node `sha512-6xg3iWVcOfiL8Y7rI6xUqXD0lI2AY5q3djsa/cOi1IJUSwx06t0gvhSwU/6mIIohrFlt40/ANUG56DQ0HLhILQ==`. The server 2.1.0 integrity was not queried.

No 2.0.x patch releases exist for server, core, node or client. The only later release is **2.1.0** (minor, 2026-09-23). hono and express moved to 2.0.1.

### B3. What 2.1.0 changed (GitHub release notes, `gh api repos/modelcontextprotocol/typescript-sdk/releases`, retrieved 2026-09-25T03:15:25Z)

Release `@modelcontextprotocol/server@2.1.0`, published 2026-09-23T15:43:11Z. The fixes that matter for security and correctness:

- **#2698 (7b781ed), request-body size limit.** Quote: "Read Streamable HTTP request bodies with a size limit. Every SDK-owned body read — `WebStandardStreamableHTTPServerTransport` (and the Node transport built on it), `createMcpHandler`, `toNodeHandler`, and `createMcpHonoApp`'s JSON pre-parse — now stops at 4 MiB by default … and answers `413 Payload Too Large` before anything is parsed. … JSON-RPC batch arrays are limited to 100 messages; a longer batch is answered `400` / `-32600` and none of it is dispatched." It also says "`createMcpHonoApp` and `createMcpExpressApp` now run their Host/Origin validation before the JSON body parser." The same change ships in node 2.1.0, hono 2.0.1 and express 2.0.1. **Implication: in 2.0.0 the SDK reads request bodies with no size limit and does not bound batch length.**
- **#2590 (75dc7ea), missing header accepted.** Quote: "Reject a modern (2026-07-28) POST that omits the required `MCP-Protocol-Version` header. `createMcpHandler` accepted a request whose body carried a valid per-request `_meta` envelope but whose `MCP-Protocol-Version` header was absent: the request was classified modern, dispatched, and answered `200` — tool handlers ran." This bears directly on the project's rule to "reject malformed modern requests".
- **#2613, `Mcp-Name` header for tasks requests.** "`createMcpHandler` now answers a modern (2026-07-28) `tasks/get` / `tasks/update` / `tasks/cancel` POST that omits `Mcp-Name` … with `400` / `-32020`."
- **#2654, request id `0`.** "`notifications/cancelled` carrying id `0` was ignored, and the in-flight handler ran to completion with its `AbortSignal` never fired."
- **#1624, new feature.** Request-time OAuth `scopeChallenge` / `requireScopes`.
- **#2494, stdio EOF handling.** Not relevant to HTTP.

The v1 line got a parallel fix: `1.30.1` (2026-09-23), "fix(server): read HTTP request bodies with a size limit and bound JSON-RPC batch length (#2717)".

### B4. Advisories (retrieved 2026-09-25T03:15:41Z–03:15:51Z)

- `gh api repos/modelcontextprotocol/typescript-sdk/security-advisories` lists 3, all for `@modelcontextprotocol/sdk` (v1):
  - GHSA-345p-7cg4-v4c7 / CVE-2026-25536 (high, 2026-02-04): "Sharing server/transport instances can leak cross-client response data". Affects >=1.10.0 <=1.25.3; fixed in 1.26.0.
  - GHSA-cqwc-fm46-7fff / CVE-2026-0621 (high, 2026-01-07): ReDoS in UriTemplate. Affects <1.25.2.
  - GHSA-w48q-cv73-mx4w / CVE-2025-66414 (high, 2025-12-02): DNS rebinding protection disabled by default. Affects <1.24.0.
- `gh api "/advisories?ecosystem=npm&affects=@modelcontextprotocol/server"` returned **no results**. The same query for node, core, client, hono and express also returned none.
- `gh api "/advisories?ecosystem=npm&affects=@modelcontextprotocol/sdk"` returned the same 3 advisories (global IDs GHSA-345p-7cg4-v4c7, GHSA-8r9q-7v3j-jr4g, GHSA-w48q-cv73-mx4w).
- OSV (`api.osv.dev/v1/query`) for server, node and core at 2.0.0 returned `{}` (nothing).

**Assessment (candidate):** No advisory exists against the v2 packages. However, 2.1.0 fixes two server-side weaknesses in 2.0.0 that were never published as advisories: request bodies read with no limit and batches of any length (memory denial of service on an 8 GB Pi), and modern requests accepted without `MCP-Protocol-Version`. Moving the pin from 2.0.0 to 2.1.0 for server, core and node is a candidate for review. If the pin stays at 2.0.0, the gateway must enforce its own body-size limit and required-header check.

---

## C. Firecrawl

### C1. Tag identity (retrieved 2026-09-25T03:18:56Z–03:19:02Z)
- `git/ref/tags/v2.11.162` → annotated tag object `ebfe595c…`, which dereferences to commit `7666c1f9ae8720a6bba271e0f60b6a217f8a5210`, tagger date `2026-07-30T20:47:43Z`. **This matches the pin.**
- The latest tag is `v2.11.402` (`be51e710cb8352c7e90d3fb76716b4f6519d6354`, commit date 2026-09-24T16:41:56Z). `compare v2.11.162...v2.11.402`: ahead_by **348** commits.
- The latest formal GitHub Release is `v2.11.0` (2026-06-19).

### C2. Repository advisories (`gh api repos/firecrawl/firecrawl/security-advisories`, 2026-09-25T03:15:51Z)
| GHSA | CVE | Severity | Published | Summary | Affected → patched |
|---|---|---|---|---|---|
| GHSA-3p54-jg6f-68r8 | CVE-2026-72904 | high | 2026-07-29 | "Arbitrary file read via JSON Schema $ref expansion" | docker:firecrawl < 2.11.32 → 2.11.32 |
| GHSA-7843-ffpq-5f9p | CVE-2026-72905 | critical | 2026-07-29 | "RCE via /scrape with changeTracking format's git-diff mode and an attacker-controlled website" | < 2.11.31 → 2.11.31 |
| GHSA-p2wg-prhf-jx79 | CVE-2025-57818 | high | 2025-08-26 | SSRF via malicious webhook | < 2.0.1 |
| GHSA-vjp8-2wgg-p734 | CVE-2024-56800 | high | 2024-12-30 | SSRF via malicious scrape target | < 1.1.1 |

**None of these was published after 2026-07-30.** The two most recent (2026-07-29) are fixed in 2.11.31 and 2.11.32, both earlier than v2.11.162.

### C3. NVD (`services.nvd.nist.gov/rest/json/cves/2.0?keywordSearch=firecrawl`, 2026-09-25T03:16Z; details 03:18:24Z)
5 results:
- CVE-2024-56800 and CVE-2025-57818: old, fixed.
- **CVE-2026-32857** (published 2026-03-26): "Firecrawl version 2.8.0 and prior contain a server-side request forgery (SSRF) protection bypass vulnerability in the Playwright scraping service where network policy validation is applied only to the initial user-supplied URL and not to subsequent redirect destinations." The vendor states no fixed version, and no CPE ranges are given. The affected range is stated as ≤2.8.0.
- CVE-2026-72904 (NVD published 2026-08-10): "Prior to 2.11.32 … This issue is fixed in version 2.11.32." Not applicable to v2.11.162.
- CVE-2026-72905 in NVD: status **Rejected**, with "Rejected reason: Further research determined the issue is not a vulnerability." The GHSA is still listed as published/critical. Either way, it was fixed in 2.11.31.
- **CVE-2026-85606** (published 2026-09-04; GHSA-q267-2jg6-m7vc, high): "firecrawl-mcp-server 3.20.2 contains an arbitrary local file read vulnerability in the firecrawl_parse tool that accepts unconstrained filePath arguments". This affects the **firecrawl-mcp-server** npm product, not the self-hosted API image. The project builds its own MCP server on the official SDK, so it does not apply unless firecrawl-mcp-server is adopted.

The GitHub global advisory DB, filtered to advisories published after 2026-07-30 with "firecrawl" in the text (03:16Z), matched only GHSA-q267-2jg6-m7vc (above) and an unrelated Flowise advisory.

### C4. Security-relevant upstream commits after v2.11.162 without an advisory (`gh api repos/firecrawl/firecrawl/commits?sha=v2.11.402&since=2026-07-30T20:47:43Z`, 03:19Z)
- `58d0c8ebb6` (2026-09-09), PR #4581, "fix(api): re-check blocklist on post-redirect URL for all scrape job types". Quote: "A clean, admitted URL that redirects to a blocklisted domain … bypassed the blocklist entirely on standalone scrape and batch scrape jobs … The worker already had a post-redirect re-check of the final URL, but it sat inside the `crawl_id` branch". This covers the domain blocklist, not IP/SSRF. Still relevant to the spec's redirect-revalidation requirement: v2.11.162 has the gap on single and batch scrape.
- `aeb5da9b1d` (2026-09-20), PR #4707, "fix: scope saved-result authorization". It touches `apps/api/src/services/alexandria/retrieve.ts`, a Cloud-side feature. Likely not relevant to self-host.
- About a dozen "fix(security): resolve pnpm audit failures" dependency bumps (2026-08-03 to 2026-09-24), plus `f179c2f5e2` js-yaml (GHSA-5p4m-2wfm-xmqj) and `6aad7f291f` fflate (test-suite only).
- `apps/api/audit-ci.jsonc` at **v2.11.162** allowlists `GHSA-v2v4-37r5-5v8g` (ip-address XSS, medium). At **v2.11.402** it also allowlists **`GHSA-mwp4-54f8-5fhr` / CVE-2026-69192 (high, published 2026-08-03)**: "ip-address: Address4 decodes leading-zero octets as decimal while resolvers decode them as octal, allowing SSRF and trust-boundary bypass" (ip-address ≤10.3.0 → 10.3.1). In v2.11.162, `ip-address@6.4.0` comes in transitively through `geoip-country`. Firecrawl's direct IP dependency is `ipaddr.js ^2.2.0`. **This is not fixed upstream at any tag.** PR #4754 (2026-09-24): "latest `geoip-country` still depends on `ip-address` 6.x … waiting on upstream".

### C5. Self-host guide (https://docs.firecrawl.dev/contributing/self-host, retrieved ~03:18Z)
- It pins **v2.11.162**: "`git clone https://github.com/firecrawl/firecrawl.git`", "`cd firecrawl`", "`git checkout v2.11.162`".
- It does not reference a prebuilt image tag. It builds from source with "`docker compose up --build`".
- Security notes: "`USE_DB_AUTHENTICATION=false`" and the setup "disables API authentication and is not a production architecture". Before production it says to "add a supported authentication design, network access controls, and TLS".

**Assessment (candidate):** No Firecrawl advisory published after 2026-07-30 affects self-hosted v2.11.162. The two nearest advisories (2.11.31 and 2.11.32 fixes) are already included in the pin. Open items, none of which moving to v2.11.402 resolves by itself:
- CVE-2026-32857: redirect SSRF in the upstream playwright-service. No fixed version is stated.
- The post-redirect blocklist gap. Fixed upstream in #4581, after the pin.
- The transitive ip-address GHSA-mwp4-54f8-5fhr. Unfixed at every tag.

All three are within scope of the project's own SSRF and redirect-revalidation layer, which should normalize IP literals itself (including octal and leading-zero forms) and not rely on upstream checks. Cherry-picking #4581 into the patch series is a candidate.

---

## D. Node.js 22

`https://nodejs.org/dist/index.json`, retrieved 2026-09-25T03:18:12Z, v22 entries:
| version | date | lts | security | npm | openssl |
|---|---|---|---|---|---|
| **v22.23.3** | 2026-09-23 | Jod | false | 10.9.9 | 3.5.8 |
| v22.23.2 | 2026-07-28 | Jod | **true** | 10.9.8 | 3.5.7 |
| v22.23.1 | 2026-06-22 | Jod | false | 10.9.8 | 3.5.7 |
| v22.23.0 | 2026-06-17 | Jod | true | 10.9.8 | 3.5.7 |

https://nodejs.org/en/blog/vulnerability (~03:18Z), most recent posts: "Wednesday, July 29, 2026 Security Releases" (Jul 29, 2026) and "Thursday, June 18, 2026 Security Releases". **There is no security release post after 2026-07-30.**

https://nodejs.org/en/blog/vulnerability/july-2026-security-releases lists patched versions "Node.js v22.23.2, v24.18.1, v26.5.1". It lists 11 CVEs, 3 of them High (CVE-2026-56846, -56848, -58043). Most affect 22.x.

https://nodejs.org/en/blog/release/v22.23.3 (2026-09-23) is not marked as a security release. It updates root certificates to NSS 3.125, OpenSSL 3.5.8, Undici 6.28.1, npm 10.9.9 and ICU 78.3, and mentions no CVE.

**Assessment:** The minimum acceptable 22.x is **22.23.2**, because of the July 29 security release. The current LTS patch is **22.23.3**, which carries no CVE fixes but bundles OpenSSL 3.5.8. No unresolved Node 22 advisory was found after 2026-07-30. Choosing the newest 22.23.x is routine.

---

## E. PostgreSQL 17 and pg_cron

- https://www.postgresql.org/support/versioning/ (~03:19Z): "17 | 17.11 | Yes | September 26, 2024 | November 8, 2029". 18's current minor is 18.6. The page header says "PostgreSQL 19 Beta 4 was released on September 24, 2026".
- https://www.postgresql.org/about/news/postgresql-186-1711-1615-1519-1424-and-19-beta-3-released-3365/ (~03:19Z): publication date **2026-08-13**. "The PostgreSQL Global Development Group has released an update to all supported versions of PostgreSQL, including 18.6, 17.11, 16.15, 15.19, and 14.24". The release fixes **28 security vulnerabilities** (CVE-2026-6464 … CVE-2026-19385).
- https://www.postgresql.org/support/security/ (~03:19Z): every recent PG17 entry is fixed in **17.11**. Examples: CVE-2026-15741 "expression deparse allows SQL injection" (8.8); CVE-2026-16239 "type confusion in cursor CLOSE + DECLARE" (8.8); CVE-2026-14680 (8.8); CVE-2026-14679 "stack buffer overflow in argument match" (8.2); CVE-2026-19385 "pg_dump heap buffer overflow executes arbitrary code" (8.8, client).
- pg_cron (`gh api repos/citusdata/pg_cron/releases`, 03:20:01Z): latest **v1.6.8**, published 2026-09-08, "Add PostgreSQL 19 support", plus Windows/MinGW build changes. The previous release was v1.6.7 (2025-09-04). Repo security advisories: none returned. NVD keyword "pg_cron": totalResults 0.

**Assessment:** Any PostgreSQL 17 build earlier than **17.11** is affected by the 2026-08-13 batch of 28 CVEs, several rated 8.8. Pin **17.11** or later. This is a minor-version pin inside the selected major, so the baseline itself does not change. pg_cron has no advisory. v1.6.8 is the latest, and its notes show no security fixes.

---

## F. Redis

Releases (`gh api repos/redis/redis/releases`, 03:20:02Z). Security releases after 2026-07-30:
- **2026-08-17**: 8.10.1, 8.8.2, 8.6.6, 8.4.6, 8.2.9, 7.4.11, 7.2.16, 6.2.24. Examples from the 8.10.1 notes: "(CVE-2026-62356) Miscalculated buffer size in `CMSketch` RDB loading may lead to heap OOB write"; "A malicious RDB payload with an out-of-range `SLOT_INFO` slot id causes memory corruption during RDB loading, which may lead to Remote Code Execution"; "TLS client certificate authentication bypass: a Common Name containing an embedded NUL byte was truncated, allowing a client to authenticate as another (possibly privileged) ACL user"; "Use-after-free in the TLS pending-data list". The 7.4.11 notes add "#15478 ACL key permission bypass in `SORT`, `GEORADIUS`/`GEORADIUSBYMEMBER` and `XREAD`/`XREADGROUP`".
- **2026-09-17**: 8.10.2, 8.8.3, 8.6.7, 8.4.7, 8.2.10. Quotes: "#15673 Commands queued in a transaction could still access keys whose ACL permissions were revoked"; "#15722 The cluster bus protocol has no authentication of its own unless `tls-cluster` is enabled … new `cluster-bus-port-protected-mode` option". Also TimeSeries, RediSearch and Vector Sets crash fixes.
- Earlier: 8.10.0 GA on 2026-07-29, and a RESTORE-payload RCE batch on 2026-07-23 (8.8.1/8.6.5/8.4.5/8.2.8/7.4.10/7.2.15).
- Repo `security-advisories` returned nothing in the window. Redis publishes its security fixes through release notes.

Maintained lines (`SECURITY.md` on the default branch, 03:20:30Z): 8.10.x ✅, 8.8.x ✅, 8.6.x ✅, 8.4.x ✅, 8.2.x ✅, 8.0.x ❌, 7.4.x ✅, "7.2.x ✅ support extended till 7.4 end of support", 6.2.x "support extended".

Current patches: **8.10.2, 8.8.3, 8.6.7, 8.4.7, 8.2.10** (2026-09-17), and **7.4.11, 7.2.16, 6.2.24** (2026-08-17).

Docker Hub `library/redis` (03:20:20Z): tags 8.10.2, 8.8.3, 8.6.7, 8.4.7, 8.2.10, 7.4.11, 7.2.16 and 6.2.24 are all published with arm64. `latest`, `8` and `8.10` updated on 2026-09-21.

Licensing facts (`LICENSE.txt`):
- Default branch: "Starting with Redis 8, Redis Open Source is moving to a tri-licensing model … (a) the Redis Source Available License v2 (RSALv2); or (b) the Server Side Public License v1 (SSPLv1); or (c) the GNU Affero General Public License v3 (AGPLv3). Redis Open Source 7.2 and prior releases remain subject to the BSDv3 clause license".
- At tag 7.4.11: "Starting on March 20th, 2024, Redis follows a dual-licensing model … version 7.4 and subsequent releases … (RSALv2) or the Server Side Public License v1 (SSPLv1)". So 7.4 has no OSI option.
- Summary: 7.2.x is BSD-3, 7.4.x is RSALv2/SSPLv1, and 8.x is RSALv2/SSPLv1/AGPLv3.

**Assessment:** The Redis version is still open. Whichever line is chosen, its patch must be at least the 2026-09-17 release (8.x) or the 2026-08-17 release (7.x). Several fixes cover RDB/RESTORE-triggered memory corruption with possible RCE, plus ACL bypasses. In this deployment Redis is private and only Firecrawl reaches it, which reduces exposure. It does not remove it: the project handles untrusted scraped content, though that content does not reach Redis as RDB/RESTORE. No unresolved advisory was found against the current patch of any maintained line.

---

## G. RabbitMQ

https://www.rabbitmq.com/release-information (~03:20Z):
- 4.3: latest patch **4.3.6** (16 Sept 2026). Community support ends 30 Nov 2026.
- 4.2: latest patch 4.2.10 (17 Aug 2026). **Community support ended 31 Jul 2026**. Commercial support until 30 Jun 2030.
- 4.1: 4.1.8, community support ended 31 Jan 2026. 4.0: 4.0.9, ended 30 Apr 2025. 3.13: 3.13.7, ended 30 Sept 2024.
- Quote: "Older releases not listed in the table above are unsupported". "Long term support is available to the users who hold a valid commercial support license."

GitHub releases (03:20:42Z): public releases are v4.3.6 (2026-09-14), v4.3.5 (2026-08-17) and v4.3.4 (2026-07-23). The last public 4.2 release is **v4.2.9** (2026-07-20). No 4.4 tags exist. Docker Hub `library/rabbitmq` (03:20:51Z) publishes `4.3.6` and `4.3.6-management` with arm64. The `4.2` tag is at 4.2.9.

Advisories after 2026-07-30 (`gh api repos/rabbitmq/rabbitmq-server/security-advisories`):
- 2026-09-18, fixed in **4.3.6** (and 4.2.11, commercial only):
  - GHSA-j6hc-926v-qwq2 (medium): "STOMP consumers retain OAuth queue access after JWT expiration".
  - GHSA-6jvc-jx8w-m757 and GHSA-342v-cj47-c9g8 (low): stream vhost disclosure.
  - GHSA-5jgm-jxp7-gwjh (medium): "MQTT retained message store has no size or count limit" (<4.3.5).
- 2026-08-18, fixed in **4.3.5** / 4.2.10:
  - GHSA-cfqc-c682-93mm (high): "Web STOMP: compressed pre-authentication messages exhaust broker memory".
  - GHSA-h964-v5mf-22cq / CVE-2026-67419 (high): "Consecutive topic wildcards cause combinatorial routing work" (4.3 only).
  - GHSA-3526-xvv4-q9mr (medium): "administrator RCE through reflected Erlang distribution authentication".
  - GHSA-27gv-h5q6-cpwg (low): "policymaker RCE through federation-management".
  - GHSA-6xpg-rfmh-grhq (medium): STOMP pre-auth frame size.
  - GHSA-6gmw-wxch-cvvc (medium): shovel URI credential disclosure.
  - GHSA-6256-27fm-4rgr / CVE-2026-67421 (medium): stored HTML injection in management OAuth error handling.
  - GHSA-6588-rqcr-59pw (medium): AMQP 1.0 user-id bypass.
  - GHSA-6chv-gv3h-cvcj (medium): direct reply-to memory.
  - Plus low-severity MQTT and DLX issues.
- 2026-07-23 (before the window): CVE-2026-67414 and CVE-2026-67416, fixed in 4.3.4 / 4.2.10.

**Assessment:** **4.3.6** is the only community-supported patch that fixes every advisory listed. The 4.2 fixes (4.2.10 and 4.2.11) are commercial-only. Public 4.2.9 is affected by the 2026-08-18 and 2026-09-18 advisories. Selecting 4.3.x is indicated; 4.2 should not be selected. Community support for 4.3 ends 30 Nov 2026, which implies a series move (presumably to 4.4) within months; no 4.4 tag exists yet. Many of the advisories concern STOMP, MQTT, Web STOMP and management plugins. A plugin-minimal broker on a private network, AMQP 0-9-1 only, is exposed to fewer of them.

---

## H. Playwright and Chromium

- `npm view playwright dist-tags` (03:20:57Z): latest **1.63.0** (published 2026-09-04T22:45:21Z); next `1.64.0-alpha-2026-09-24`. Earlier releases: 1.62.1 (2026-07-30), 1.62.0 (2026-07-24).
- Release v1.63.0 "Browser Versions": "Chromium 153.0.8010.12", "Mozilla Firefox 155.0", "WebKit 26.6", "tested against … Google Chrome 153". Announcement: "🐧 On Linux arm64, Playwright now downloads the Chrome for Testing build of Chromium, the same build used on all other platforms." And "⚠️ Ubuntu 20.04 is not supported anymore."
- **What Firecrawl v2.11.162 actually uses** (03:21:07Z–03:21:20Z):
  - `apps/playwright-service-ts/package.json` has `"playwright": "^1.58.1"` and `"engines": {"node": ">=22.13.0"}`. The Dockerfile uses `FROM node:22-slim` and `pnpm exec playwright install chromium --with-deps`.
  - The lockfile resolves `playwright@1.58.1` / `playwright-core@1.58.1`. Its `browsers.json` gives chromium `"browserVersion": "145.0.7632.6"`, revision 1208.
- npm advisories for `playwright` (03:22:52Z): only GHSA-7mvr-c777-76hp / CVE-2025-59288 (high, <1.55.1: browser download without TLS verification). 1.58.1 is not affected.

Chrome Stable desktop security releases since 2026-07-30 (Blogger feed `chromereleases.googleblog.com/feeds/posts/default?published-min=2026-07-30`, retrieved 2026-09-25T03:21:31Z; counts are the posts' own "N security fixes" figure):
| Date (PT) | Linux version | Security fixes | In the wild |
|---|---|---|---|
| 2026-08-06 | 151.0.7922.108 | 41 | — |
| 2026-08-11 | 151.0.7922.137 | 5 | — |
| 2026-08-18 | 151.0.7922.169 | 15 | — |
| 2026-08-20 | 151.0.7922.173 | 7 | — |
| 2026-08-25 | 152.0.7977.64 (Chrome 152 promotion) | 327 | — |
| 2026-09-01 | 152.0.7977.75 | 26 | — |
| 2026-09-03 | 152.0.7977.82 | 12 | **"Google is aware that an exploit for CVE-2026-85046 exists in the wild."** (High, "Type confusion in V8") |
| 2026-09-08 | 153.0.8010.36 (Chrome 153 promotion) | 230 | **"Google is aware that an exploit for CVE-2026-87491 exists in the wild."** (listed as Medium, "Out of bounds write in V8") |
| 2026-09-15 | 153.0.8010.47 | 42 | — |
| 2026-09-17 | 153.0.8010.52 | 16 | — |
| 2026-09-22 | 154.0.8037.57 (Chrome 154 promotion) | 108 | — |

Total over the 11 Stable desktop posts: **829 security fixes**. **2 are marked exploited in the wild** (CVE-2026-85046 and CVE-2026-87491, both V8).

**Assessment (candidate):** The Chromium that Firecrawl v2.11.162 ships (Playwright 1.58.1 → Chromium 145.0.7632.6) is about nine major versions behind stable, with both in-the-wild V8 bugs unfixed. The retrieval browser renders untrusted pages, so this is the strongest argument in this audit for moving off a selected version. Even Playwright 1.63.0's Chromium 153.0.8010.12 is a lower build number than 153.0.8010.36, the first stable build to fix CVE-2026-87491. Version numbers alone cannot confirm whether that Chrome-for-Testing build carries the ITW fixes, so treat it as unverified. The spec keeps browser package and binary in lockstep, so any move means bumping the Playwright package. Sandbox, non-root execution and no arbitrary JS remain the mitigations the design already relies on.

---

## I. SearXNG

- Docker Hub `searxng/searxng` (03:22:12Z): tags are **date-based with a commit suffix**, `YYYY.M.D-<9-char git sha>` (e.g. `2026.9.23-3cd69d30e`, `2026.9.22-2ed96e6fc`), plus `latest`. Several tags are published per day. Every recent tag is a manifest list for **amd64, arm/v7, arm64**. Repo last updated 2026-09-23T15:25:52Z.
- `2026.9.23-3cd69d30e`: index digest `sha256:bcfaed4091d59f7ce85670bd701a2d0295872196dc19908a3965a8353b149f83`; arm64 digest `sha256:0c7b839d2050617618f151c0919260c156c701a812dc6404f1114fe43a0f0710`.
- https://docs.searxng.org/admin/installation-docker.html (~03:22Z): images at "`docker.io/searxng/searxng`" and "`ghcr.io/searxng/searxng`", described as mirrors of each other. The page shows tag examples such as "`2026.6.19-93f66bfb4`". It does not formally document the tag scheme or architectures; those facts come from the registry.
- `gh api repos/searxng/searxng/security-advisories` returned no entries.

**Conclusion:** linux/arm64 is published. Pin by date tag plus digest, not `latest`.

---

## Could not retrieve / limits
- server 2.1.0 `dist.integrity` was not queried; only core and node 2.1.0 integrities were recorded.
- WebFetch output is a model-summarized rendering of the page. Quotes marked as coming from WebFetch pages (MCP versioning, self-host guide, Node blog, PostgreSQL pages, RabbitMQ release page) are as returned by that tool. All GitHub, npm, NVD, OSV, Docker Hub and Chrome-feed data is raw API output.
- NVD records for CVE-2026-32857, -72904 and -85606 are in "Deferred" status with no CPE configurations.
- Whether Playwright 1.63.0's Chromium 153.0.8010.12 contains the fixes for CVE-2026-85046 and CVE-2026-87491 was not established.
