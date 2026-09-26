# M2 review of record — /review-2

- **Method:** `/review-2` (CLAUDE.md §5), read-only, two agents in parallel: DB1 (debugger: logic, runtime, types, integration) and CA1 (code-auditor: architecture, quality, performance, security, data integrity). Both ran on **Opus 5.5** (the Agent tool's `opus` alias); no substitution. Their independence comes from fresh contexts: neither saw this session's transcript.
- **Date:** 2026-09-26, 04:58Z–05:22Z.
- **Range:** `191c146..6de7d94` on `main` (141 files, 26,493 insertions). Patches were read in context in a checkout of the series' result tree (`cd46160c`, upstream `7666c1f9` with `patches/` applied); paths below of the form `apps/api/…` are files in that tree, changed by the named patch.
- **Orchestrator checks:** before this report was written, the five critical findings were reproduced independently: the classifier's timings (128 KiB of `<!--` took 1,852 ms, 256 KiB took 7,517 ms), Node's parser accepting `HTTP/1.1 099` with `writeHead(99)` throwing `ERR_HTTP_INVALID_STATUS_CODE`, a short scripted page classified `js_shell`, and by reading the code, the unbounded `page.content()`/`res.json()` path and the first-hop-only pacing.
- **Adaptation:** the environment has no team-creation or task tools; both agents were spawned directly with the Agent tool and reported by message. Both confirmed shutdown requests were sent.

## Code Review: M2 — guarded retrieval integration and resource-safe browser

### Summary
Reviewed the M2 changeset with two specialist agents (1 debugger + 1 code-auditor, both on Opus 5.5). The security foundation holds: address classification, connection pinning against DNS rebinding, the atomic attempt budget, leased permits and the nftables network floor were all traced and found sound. But five critical defects on the request path must be fixed before acceptance: a quadratic classifier and an unguarded proxy status code that a hostile public page can use to freeze or crash the only acquisition path, unbounded rendered HTML, redirect targets that escape home-IP pacing and cooldowns, and short scripted pages wrongly failed as RENDER_INCOMPLETE.

**Scope (so the reader knows what was and wasn't reviewed):**
- **Large-changeset guard triggered** (141 files, 26k lines). Tier 1 (full review): `services/retrieval/src/*.mjs`, `services/browser/src/server.mjs`, `patches/0001`–`0005`, `deploy/compose.yaml`, `deploy/host/fcpi-guard.nft`, `deploy/host/fcpi-egress-local.sh`, `deploy/policies/egress.json`, `deploy/nuq-postgres/fcpi-retrieval-schema.sql` and its initdb script, `deploy/firecrawl-core/entrypoint.sh`, `scripts/m2/verify.mjs`, `scripts/m2/pi-init-m2.sh`. Tier 2 (skimmed for shape changes and criticals): the other `scripts/m2/*` collectors, `services/retrieval/test/*`, `tests/fixtures/m2/*`, the two Dockerfiles, `scripts/m2/build-seccomp.mjs`, the Dockerfile and package hunks of `patches/0006`. Tier 3 (acknowledged, not reviewed for content): the 68 files under `evidence/M2/`, `deploy/versions.lock.json`, `deploy/browser/seccomp.json`, the lockfiles, the `Cargo.lock` hunk of `patches/0006`. Confidence: high on Tier 1; false negatives possible in Tier 2; Tier 3 not reviewed. Tier 1 alone (about 3,900 lines) exceeded the skill's per-agent heuristic; it was reviewed anyway because CLAUDE.md §5 mandates this review for the milestone.
- **Out of scope per the review's context:** MCP, tokens and durable jobs (M3); paid providers and proxies (M6/M7); screenshot/action registration (M7); the close-out steps not yet done (spec §29 line 920 with the ORCHESTRATION.html refresh, the M2 status row, `evidence/M2/INTERPRETATION.md`, the AFTER snapshot, the final evidence re-collection, the held live public fetch).
- **Not run by the agents:** test suite, linters, builds. Both ran read-only `node -e` probes to time or confirm behaviour.

### 🔴 Critical Issues (Must Fix)

**Introduced in this changeset:**
1. **C1 — Quadratic classifier regexes let one hostile page freeze the retrieval service (CWE-1333)** - `services/retrieval/src/quality.mjs:24-28, 36-37, 59` _(corroborated: both agents)_
   - Problem: `visibleText` strips blocks with `/<(script|style|noscript|template|svg|head)\b[\s\S]*?<\/\1\s*>/gi`, comments with `/<!--[\s\S]*?-->/g` and tags with `/<[^>]+>/g`; `htmlSignals` uses `/<noscript\b[^>]*>([\s\S]*?)<\/noscript>/gi`. With openers that never close, each opener scans to the end of the body: time grows with openers × length.
   - Risk: a public URL answers 200 `text/html` with `"<!--".repeat(262144)` (1 MiB, under the 25 MiB cap) → `acquire.mjs:125` → `classify()` → `visibleText()` → about 2 minutes of blocked event loop on the workstation, longer on the Pi, hours at 25 MiB. The service's one event loop also runs the browser proxy, every deadline and cancellation timer and `/healthz`, so every acquisition stalls; `restart: unless-stopped` does not restart an unhealthy container. The browser branch classifies rendered HTML the same way. Independently flagged by both reviewers and reproduced by the orchestrator (1,852 ms at 128 KiB, 7,517 ms at 256 KiB).
   - Fix (the two proposals differ; both linear):
     DB1's proposal — one left-to-right scan over a bounded prefix:
     ```js
     const HIDDEN = new Set(["script", "style", "noscript", "template", "svg", "head"]);
     const CLASSIFY_MAX = 512 * 1024;
     export function visibleText(input) {
       const html = input.length > CLASSIFY_MAX ? input.slice(0, CLASSIFY_MAX) : input;
       const out = []; let i = 0;
       while (i < html.length) {
         const lt = html.indexOf("<", i);
         if (lt < 0) { out.push(html.slice(i)); break; }
         out.push(html.slice(i, lt), " ");
         if (html.startsWith("<!--", lt)) { const e = html.indexOf("-->", lt + 4); i = e < 0 ? html.length : e + 3; continue; }
         const gt = html.indexOf(">", lt + 1);
         if (gt < 0) break;
         const name = (/^<([a-z][a-z0-9]*)/i.exec(html.slice(lt, lt + 16)) ?? [])[1]?.toLowerCase();
         i = gt + 1;
         if (name && HIDDEN.has(name)) { const close = new RegExp(`</${name}\\s*>`, "ig"); close.lastIndex = i; i = close.exec(html) ? close.lastIndex : html.length; }
       }
       return out.join("").replace(/&(nbsp|#160);/gi, " ").replace(/\s+/g, " ").trim();
     }
     ```
     CA1's proposal — strip blocks with `indexOf`, remembering which tags never close:
     ```js
     const BLOCK_OPEN = /<(script|style|noscript|template|svg|head)\b|<!--/gi;
     function stripBlocks(html, onNoscript = null) {
       const lower = html.toLowerCase(), unclosed = new Set();
       let out = "", from = 0, m;
       BLOCK_OPEN.lastIndex = 0;
       while ((m = BLOCK_OPEN.exec(lower))) {
         const tag = m[1] ?? "!--";
         if (unclosed.has(tag)) continue;
         const close = lower.indexOf(tag === "!--" ? "-->" : `</${tag}`, BLOCK_OPEN.lastIndex);
         if (close === -1) { unclosed.add(tag); continue; }
         if (tag === "noscript" && onNoscript) onNoscript(html.slice(lower.indexOf(">", m.index) + 1, close));
         const end = tag === "!--" ? close + 3 : (lower.indexOf(">", close) + 1 || lower.length);
         out += html.slice(from, m.index) + " ";
         from = BLOCK_OPEN.lastIndex = end;
       }
       return out + html.slice(from);
     }
     // visibleText: stripBlocks(html).replace(/<[^<>]*>/g, " ") …; htmlSignals: noscript text via onNoscript;
     // emptyMount and the password test: [^<>]* instead of [^>]*, a bounded noscript group.
     ```
     Regression test: classify `"<!--".repeat(1 << 18)`, `"<a".repeat(1 << 19)`, `"<noscript>".repeat(1 << 17)`, `"<style>".repeat(200000)` each in under a second.

2. **C2 — A target status below 100 crashes the retrieval service through the browser proxy** - `services/retrieval/src/proxy.mjs:74` _(only DB1 — CA1 was in scope but didn't flag)_
   - Problem: in the plain-HTTP forward path, `res.writeHead(ur.statusCode, out)` runs inside the `up.on("response")` listener, outside the handler's try/catch. Node's parser accepts `HTTP/1.1 099` (statusCode 99) and `writeHead` throws `ERR_HTTP_INVALID_STATUS_CODE` below 100; nothing catches it and the service has no `uncaughtException` handler.
   - Risk: a public page classified as a JS shell loads `<script src="http://evil.example/x.js">` → Chromium sends it through the proxy → the target validates → the upstream answers `HTTP/1.1 099 X` → `writeHead(99)` throws in an event callback → the process exits. Every acquisition in flight fails; the URL and browser permits its rows hold stay leased for 120 s. Reproduced by the orchestrator.
   - Fix:
     ```js
     up.on("response", (ur) => {
       const out = {};
       for (const [k, v] of Object.entries(ur.headers)) if (!HOP.has(k)) out[k] = v;
       try {
         if (!(ur.statusCode >= 100 && ur.statusCode <= 599)) throw new Denied("PROXY_ERROR", `upstream status ${ur.statusCode}`);
         res.writeHead(ur.statusCode, out);
       } catch (e) {
         refuse(s, host, e); ur.destroy(); up.destroy();
         if (!res.headersSent) res.writeHead(502, { connection: "close" }).end(); else res.destroy();
         return;
       }
       ur.on("data", (c) => count(s, c.length, up, res.socket));
       ur.pipe(res);
     });
     ```

3. **C3 — Rendered HTML has no size limit between Chromium and the core (CWE-770, CWE-400)** - `services/browser/src/server.mjs:167`, `services/retrieval/src/browser.mjs:32`, `services/retrieval/src/acquire.mjs:158`, `apps/api/src/scraper/scrapeURL/engines/pi-resilient/index.ts:123` (patch 0003) _(unique to CA1's lane)_
   - Problem: direct bodies stop at `maxBodyBytes` (25 MiB) with SIZE_LIMIT; the rendered document does not. The worker serialises `page.content()`, the retrieval service buffers and parses it (`res.json()`), classifies and re-serialises it, and the core parses it again under `--max-old-space-size=256`. The proxy's byte counter limits network bytes only; a script can build any DOM without network.
   - Risk: `<div id="root"></div><script>document.getElementById('root').textContent='x'.repeat(1.5e8)</script>` → direct attempt `js_shell` → the render builds a ~150 MB document inside the browser's 1,536 MiB cap → ~150 MB of JSON crosses into the 448 MiB retrieval service, which holds several copies → the page is not refused with SIZE_LIMIT as a 25 MiB direct body is; the retrieval service or the core's NuQ worker is expected to die (not yet measured).
   - Fix:
     ```js
     // services/browser/src/server.mjs, before page.content()
     const maxHtml = Math.min(Number(r.limits?.maxHtmlBytes) || 25 * 1024 * 1024, 25 * 1024 * 1024);
     const size = await page.evaluate(() => document.documentElement?.outerHTML.length ?? 0);
     if (size > maxHtml) return { ok: false, failure: { class: "SIZE_LIMIT", detail: `rendered document of ${size} characters exceeds ${maxHtml}` }, subresources: counters, timings: { totalMs: Date.now() - started } };
     // services/retrieval/src/browser.mjs: send limits.maxHtmlBytes = policy.maxBodyBytes, and refuse a reply
     // whose content-length exceeds 2 × maxBodyBytes + 1 MiB before res.json().
     ```

4. **C4 — Pacing, 429 cooldowns and the daily cap see only the first hop; redirect targets escape the home-IP limits (CWE-799)** - `services/retrieval/src/acquire.mjs:63, 109-113, 130, 151`, `services/retrieval/src/httpfetch.mjs:125-148` _(corroborated: both agents)_
   - Problem: `pace()` paces and counts the requested URL's registrable domain; `guardedFetch` then follows up to 10 redirects to other domains unpaced (its `onHop` hook exists but no caller passes it). A 429 cools down the first domain, not the host that sent it (`coolDown(target…)`); the browser path and `/internal/fetch` never cool down at all. The browser attempt re-walks the chain from `req.url`, and its redirects and script navigations are validated by the proxy but not paced. Spec §10.2 limits requests per registrable domain; §8.4 lists redirects among the paths that must share domain pacing.
   - Risk: a batch of 50 short links on different shortener domains, all 301 to `news.example` → each acquisition paces its shortener only → both URL permits hit `news.example` together with no 2 s gap; none is counted in `direct_nav` under `news.example`, so its 20/hour cap never applies; when `news.example` answers 429 the cooldown lands on `bit.ly`, and the next link from `t.co` reaches `news.example` inside the window it asked for (CLAUDE.md §12). DB1 flagged the cooldown half independently.
   - Fix:
     ```js
     // acquire.mjs: pace every hop, one hold at a time
     const domainOf = (t) => (t.fixture ? t.host : (getDomain(t.host) ?? t.host));
     let current = paced.domain;
     try {
       httpRes = await guardedFetch({ /* …as now… */, onHop: async ({ hop, target: t }) => {
         const d = domainOf(t);
         if (hop === 0 || d === current) return;
         await store.releaseDomain(current, attemptId);
         const p = await pace(t, attemptId, deadline, signal);
         if (p.failure) { current = null; throw new Denied(p.failure.class, p.failure.detail); }
         current = p.domain;
       } });
     } finally { if (current) await store.releaseDomain(current, attemptId); }
     // the cooldown belongs to the host that answered 429, on every path
     if (verdict.verdict === "rate_limited") await store.coolDown(domainOf(parseTarget(httpRes.finalUrl, policy)), verdict.failure.retryAfter);
     // browser attempt: render the direct attempt's final URL; refuse cross-host main-frame navigations in the worker
     ```
     Add a fixture case where `m2` redirects to `pace` and check the `pace.` request gaps.

5. **C5 — Short or image-led pages that carry any script fail as RENDER_INCOMPLETE** - `services/retrieval/src/quality.mjs:67`, `services/retrieval/src/acquire.mjs:160` _(unique to DB1's lane)_
   - Problem: "scripts > 0 and fewer than 40 visible characters" marks a page a JS shell on length alone (with `<head>` text excluded). After its one render, the same rule fails the page RENDER_INCOMPLETE. Spec §9.2: "do not escalate just because it is short"; §9.4: no universal minimum character count.
   - Risk: `<head><title>Status</title><script src=/analytics.js></script></head><body><p>All systems operational.</p></body>` → direct attempt `js_shell (visible_chars=24; scripts=1)` → a render that leaves the DOM unchanged → `classify` again returns `js_shell` → RENDER_INCOMPLETE → the API returns an error instead of the page, after two home-IP navigations and a render. Reproduced by the orchestrator.
   - Fix:
     ```js
     // quality.mjs: mark which verdicts rest on structure
     if (s.noscriptAsksForJs && visible.length < 500) return { verdict: "js_shell", structural: true, reasons: [...reasons, "noscript asks for JavaScript"] };
     if (s.emptyMount && s.scripts > 0 && visible.length < 500) return { verdict: "js_shell", structural: true, reasons: [...reasons, "empty application mount point"] };
     if (s.scripts > 0 && visible.length < 200 && (s.loading || visible.length < 40)) return { verdict: "js_shell", structural: s.loading, reasons: [...reasons, "scripted page with almost no text"] };
     // acquire.mjs (browser path): only structural evidence fails a rendered page
     const shell = verdict?.verdict === "js_shell" && verdict.structural;
     ```
     Add fixtures for a short scripted page and an image-only page.

### 🟡 Warnings (Should Fix)

**Introduced in this changeset:**
1. **W1 — `/internal/fetch` and the search route skip the global URL permits, and each download gets a fresh budget** - `services/retrieval/src/acquire.mjs:181-217`, `services/retrieval/src/server.mjs:114-123`, `apps/api/src/scraper/scrapeURL/engines/pi-resilient/fetch.ts:37` (patch 0004) _(corroborated: both agents)_
   - Problem: `fetchOnce` and `/searxng` never take a `url` permit (spec §23.1: permits are shared across all paths); each download buffers up to 25 MiB in a 448 MiB service. `piFetch` sends a random `requestId`, so the `fetch:<id>` budget is new per call.
   - Suggestion: hold a URL permit around the fetch and the search; derive the fetch's logical id from the job or crawl id plus a hash of the URL.
2. **W2 — Cancellation is lost when the abort falls between steps** - `services/retrieval/src/httpfetch.mjs:77`, `services/retrieval/src/acquire.mjs:24, 72-76, 124, 135, 196-204` _(corroborated: both agents)_
   - Problem: `requestOnce` never checks `signal.aborted`, and an abort listener added to an already-aborted signal never fires; after a retry `sleep` the loop reserves a new attempt, `pace()` records a navigation and a full request is sent for a caller that is gone. `fetchOnce`'s own pacing loop has no abort check at all.
   - Suggestion: reject with CANCELLED before `http.request` when aborted; check the signal after each sleep and at the top of the pacing and permit loops.
3. **W3 — Permits and domain holds leak on errors, and every restart strands them for 120 s** - `services/retrieval/src/acquire.mjs:144-149, 154`, `services/retrieval/src/server.mjs:126` _(corroborated: both agents)_
   - Problem: `pace()` runs after `holdPermit("browser")` but outside the `try` that releases it; a throwing `releaseDomain` skips `releasePermit`; SIGTERM ends the pool under in-flight acquisitions; `Store.ready()` never reclaims rows after a restart.
   - Suggestion: move `pace()` inside the `try`, release each resource on its own (`Promise.allSettled`), clear this single instance's leases in `ready()`, drain before `pool.end()`.
4. **W4 — Race on the platform daily cap (CWE-362)** - `services/retrieval/src/store.mjs:123-126` _(corroborated: both agents)_
   - Problem: the day count is read under one domain's row lock; pacers for different domains can both see 199 and proceed.
   - Suggestion: `SELECT pg_advisory_xact_lock(hashtext('fcpi.direct_nav.day'))` before counting non-fixture navigations.
5. **W5 — The worker's one-render guard is a check-then-set across an async gap (CWE-362)** - `services/browser/src/server.mjs:202, 210` _(only CA1 — DB1 was in scope but didn't flag)_
   - Problem: `busy` is checked on headers and set after the body ends; two concurrent requests both pass, two contexts run and `ensureBrowser()` can launch twice.
   - Suggestion: check and set synchronously at the top of the `end` handler.
6. **W6 — Resource-limit cuts are reported as success, and the proxy has no request cap** - `services/retrieval/src/proxy.mjs:49-52, 57, 93`, `services/browser/src/server.mjs:151`, `services/retrieval/src/acquire.mjs:154-158` _(unique to CA1's lane)_
   - Problem: the byte cap destroys sockets silently and the 200-request cap aborts routes, yet `acquire` returns `ok`; `s.requests` is never limited, and WebSockets and preconnects bypass `context.route`.
   - Suggestion: fail RESOURCE_LIMIT when `overLimit > 0` or the byte cap was hit; cap requests per proxy session.
7. **W7 — The host-network check fails open while the list is missing (CWE-636)** - `services/retrieval/src/ssrf.mjs:77`, `services/retrieval/src/server.mjs:39`, `services/retrieval/src/proxy.mjs:62-64` _(unique to CA1's lane)_
   - Problem: `classifyAddress` defaults to an empty BlockList and `getPolicy()` returns `localCidrs: undefined` until the list loads; `acquire` and `fetchOnce` refuse then, but the proxy and `/searxng` validate without host networks — and this host's LAN is globally routable.
   - Suggestion: require `localCidrs`; answer 503 RETRIEVAL_NOT_READY from the proxy and search while it is missing.
8. **W8 — The home router's public address is not treated as local** - `deploy/host/fcpi-egress-local.sh:16-18`, `services/retrieval/src/ssrf.mjs:77-92`, `deploy/host/fcpi-guard.nft:36-38` _(unique to CA1's lane)_
   - Problem: the host-local list holds connected routes only; many routers answer or hairpin on their WAN address from the LAN side. Whether this router does is not recorded.
   - Suggestion: add the WAN address (measured since M0) to the list and the guard's set at every start, with an egress-probe case.
9. **W9 — New critical-path code has no unit tests** - `services/retrieval/test/*` _(unique to CA1's lane)_
   - Problem: `makeAcquirer`, `makeFetcher`, `validateAcquireRequest`, `decodeText`, `ProxySessions`, the proxy, `loadEnv`, `loadLocalCidrs` and `Store`'s SQL are covered only by the Pi integration phases; none of the criticals has a regression test.
   - Suggestion: unit-test the pure pieces and the proxy with loopback servers.
10. **W10 — A connection reset mid-body is UNSUPPORTED_CONTENT, so the same-tier retry never runs** - `services/retrieval/src/httpfetch.mjs:115-117` _(unique to DB1's lane)_
    - Problem: without content-encoding `sink === res`, and the UNSUPPORTED_CONTENT listener, registered first, settles a reset.
    - Suggestion: attach the decoding-error listener only to a decoder.
11. **W11 — HEAD and redirect responses fail SIZE_LIMIT on their declared length** - `services/retrieval/src/httpfetch.mjs:97-99` _(unique to DB1's lane)_
    - Problem: the declared-length check runs before the bodiless short-circuit; map's HEAD resolution fails for any page declaring more than 1 MiB, and each try counts a home-IP navigation.
    - Suggestion: check the declared length after the HEAD/redirect/204/304 short-circuit.
12. **W12 — A fire-and-forget `closeNow()` → `retire()` can kill the next render's browser** - `services/browser/src/server.mjs:46, 139-145` _(unique to DB1's lane)_
    - Problem: when `context.close()` hangs past 5 s, `retire()`'s `killStrays()` can SIGKILL a Chromium launched for the next request; the `disconnected` handler clears `browser` for any instance.
    - Suggestion: await the pending close in `finally`; clear `browser` only when the disconnected instance is the current one.
13. **W13 — The adapter drops the service's typed failure on non-200 replies** - `apps/api/src/scraper/scrapeURL/engines/pi-resilient/index.ts:116-121` (patch 0003) _(corroborated: both agents)_
    - Problem: 400 (e.g. `waitFor` above 15,000 ms, which upstream accepts to 60,000) and 503 RETRIEVAL_NOT_READY both surface as a generic RETRIEVAL_SERVICE_ERROR.
    - Suggestion: parse `failure` from the body as `piFetch` does; refuse `waitFor > 15000` up front as UNSUPPORTED_CAPABILITY.
14. **W14 — 429 cooldowns ignore the 60 s floor and never reset** - `services/retrieval/src/store.mjs:262` _(unique to DB1's lane)_
    - Problem: `nextCooldown` doubles the stored `cooldown_s`, which a prior Retry-After may have seeded low and which nothing resets; after `Retry-After: 1` the next bare 429 gets 2 s, not §9.3's 60 s, and a domain that once reached 3,600 s keeps it.
    - Suggestion: start from 60 s unless the previous cooldown ended recently; reset after a lapse or a success.
15. **W15 — Verifier checks that pass on missing or wrong evidence** - `scripts/m2/verify.mjs:381, 464, 503, 594, 637` _(corroborated: both agents)_
    - Problem: C02 passes when the process list or its times are missing (NaN comparisons); M03 passes when `cgroups_after` is missing (the rise is computed over its keys); X05 passes if `ALLOW_LOCAL_WEBHOOKS` appears anywhere in patch 0003, even a comment; S01 accepts any core-side 400 without checking that no attempt was spent; X01 leans on a counter that resets with each guard load and will count the held live fetch.
    - Suggestion: require the inputs each condition reads; match the exact refusal; require the SSRF/Cloud class and zero attempts on core-side cases; attribute accepted egress by destination.
16. **W16 — D1's admission accepts test (a) exactly where it says (a) is unreliable** - `scripts/m2/d1.mjs:45` _(unique to DB1's lane)_
    - Problem: `pass: a || b` admits a CVE whose fix was published after the bundled milestone branched on the version comparison alone; (b) covers V8 only. No current row hits it (both such rows pass (b)).
    - Suggestion: `pass: after_branch_point ? b : (a || b)`, failing closed for non-V8 rows after the branch point.

### 🔵 Suggestions (Consider)

**Introduced in this changeset:**
1. **S1 — The fixture exception is reachable from public input** - `services/retrieval/src/ssrf.mjs:117-122`, `deploy/policies/egress.json:38-48` _(unique to CA1's lane)_
   - Current: fixture hosts are allowed on every redirect hop and proxied request, so a public page can reach the fixture's `/redirect` and `/slow` endpoints, unpaced.
   - Better: honour fixture hosts only when the requested URL is itself a fixture.
2. **S2 — Duplicated pacing loop and dead code** - `services/retrieval/src/acquire.mjs:196-204, 219`, `services/retrieval/src/httpfetch.mjs:63, 84`, `services/retrieval/src/store.mjs:95-98` _(unique to CA1's lane)_
   - Current: `fetchOnce` copies the pacing loop and has drifted; `onPeer`, `Store.attemptsUsed` and the `isHtml` re-export are unused.
   - Better: reuse `pace()`; remove the unused code.
3. **S3 — Configuration checked too late** - `services/retrieval/src/policy.mjs:72`, `services/retrieval/src/server.mjs:42`, `services/browser/src/server.mjs:28` _(corroborated: both agents)_
   - Current: `permitLeaseMs` may be below the acquisition deadline; a token-hash file of the wrong length fails every request with a 500.
   - Better: require `permitLeaseMs ≥ acquisitionDeadlineMs + 30000`; check hash lengths at startup.
4. **S4 — Cookie Secure flag and SNI for IP literals** - `services/retrieval/src/httpfetch.mjs:35-50, 74` _(unique to CA1's lane)_
   - Current: the jar ignores `Secure` (CWE-614); `servername` is set for IP hosts (DEP0123).
   - Better: send Secure cookies only over https; omit `servername` for IP hosts.
5. **S5 — Data lifecycle** - `services/retrieval/src/acquire.mjs:16-17`, `services/retrieval/src/store.mjs:151-155`, `deploy/nuq-postgres/fcpi-retrieval-schema.sql` _(unique to CA1's lane)_
   - Current: `url_hmac` is keyed per process but stored durably; `domain_state` is never pruned; the daily count and the acquisition prune lack indexes.
   - Better: key the HMAC from a secret file; prune idle `domain_state`; add the indexes.
6. **S6 — Search failures look like empty results** - `patches/0005-search-without-direct-fallback.patch` _(unique to CA1's lane)_
   - Current: a backend failure returns `[]`.
   - Better: return a typed search failure (spec §13) — SearXNG and search behaviour are M5's.
7. **S7 — `sleep()` leaks abort listeners** - `services/retrieval/src/acquire.mjs:24` _(unique to DB1's lane)_
   - Current: every wait iteration adds a listener that is never removed.
   - Better: remove it when the timer fires.
8. **S8 — HEAD + 303 switches to GET** - `services/retrieval/src/httpfetch.mjs:145` _(unique to DB1's lane)_
   - Current: every 303 turns the verb into GET, so discovery downloads a body.
   - Better: keep HEAD as Fetch does.
9. **S9 — The local-network reload cannot see a change** - `deploy/compose.yaml:375`, `services/retrieval/src/server.mjs:27-38` _(unique to DB1's lane)_
   - Current: the file is replaced with `mv`, and a single-file bind mount keeps the old inode; the nft set is refreshed.
   - Better: bind-mount the directory.
10. **S10 — `x-fcpi-final-url` can throw for a raw non-Latin-1 URL** - `services/retrieval/src/server.mjs:100` _(unique to DB1's lane)_
    - Current: `writeHead` throws ERR_INVALID_CHAR above U+00FF, turning a fetched document into a 500.
    - Better: send `new URL(r.finalUrl).href`.
11. **S11 — The stall test records the wrong exit status** - `scripts/m2/pi-nuq-tests.sh:196, 200` _(unique to DB1's lane)_
    - Current: `exit=$?` follows `$(now)` in the same line.
    - Better: capture the kill's status first.
12. **S12 — NuQ listener start races** - `apps/api/src/services/worker/nuq.ts:144, 242` (patch 0002) _(unique to DB1's lane)_
    - Current: a waiter arriving during another start returns without falling back if that start fails; a close between `consume()` and publishing can publish a dead listener.
    - Better: share one start promise; check for a close before publishing.
13. **S13 — The PostgreSQL pool has no timeouts** - `services/retrieval/src/store.mjs:269` _(unique to DB1's lane)_
    - Current: no connection or statement timeout.
    - Better: set both.

### ✅ Good Practices
- Every DNS answer is validated and every connection pinned to the checked address (pinned lookup plus a peer check), closing DNS rebinding; IPv4 and IPv6 are classified in separate block lists, embedded IPv4 is unwrapped, and numeric hosts must be canonical.
- The attempt budget is one atomic conditional `UPDATE … RETURNING` with its insert in one transaction, so requeues and concurrent callers cannot pass four; permits are leased `SKIP LOCKED` slots that recover from a crashed holder, with slot 0 handled.
- Proxy credentials are per attempt, stored hashed, compared in constant time and closed with their sockets; `proxy-authorization` is never forwarded; CONNECT is limited to validated 443 tunnels.
- The network floor holds independently of the code: the core is internal-only, the guard mirrors the special ranges, drops IPv6 and admits DNS only to the host resolver, and every egress probe carries a local positive control.
- Secrets travel over stdin, are created by hard link, and only their hashes live in the services; the LAN address is redacted in collectors and scanned for by X10.
- The NuQ patches attach error listeners before any further await, close half-opened connections and fall back to PostgreSQL; patch 0006 pins every base by digest, checks the FoundationDB client's SHA-256 and builds with `cargo --locked`.
- Missing evidence yields NOT_RUN, and negative results sit beside positive controls.

### Verdict
[x] ❌ Request Changes (critical issues)
[ ] ⚠️ Approve with Suggestions
[ ] ✅ Approve

## Outcomes

Recorded by `/address` (CLAUDE.md §5): fixed with its commit, rejected with the evidence, or deferred to the later milestone that owns it with the reason.

| ID | Severity | Finding | Outcome | Commits |
|---|---|---|---|---|
| C1 | 🔴 | Quadratic classifier regexes | Pending /address | |
| C2 | 🔴 | Proxy crash on a status below 100 | Pending /address | |
| C3 | 🔴 | Rendered HTML unbounded | Pending /address | |
| C4 | 🔴 | Pacing and cooldowns see only the first hop | Pending /address | |
| C5 | 🔴 | Short scripted pages fail RENDER_INCOMPLETE | Pending /address | |
| W1 | 🟡 | Fetch and search skip URL permits; fetch budget per call | Pending /address | |
| W2 | 🟡 | Cancellation lost between steps | Pending /address | |
| W3 | 🟡 | Permit and hold leaks on errors and restarts | Pending /address | |
| W4 | 🟡 | Daily-cap race | Pending /address | |
| W5 | 🟡 | Worker busy check-then-set | Pending /address | |
| W6 | 🟡 | Resource-limit cuts reported as success; no proxy request cap | Pending /address | |
| W7 | 🟡 | Host-network check fails open while the list is missing | Pending /address | |
| W8 | 🟡 | Router WAN address not local | Pending /address | |
| W9 | 🟡 | Critical-path code without unit tests | Pending /address | |
| W10 | 🟡 | Mid-body reset classified UNSUPPORTED_CONTENT | Pending /address | |
| W11 | 🟡 | HEAD and redirects fail on declared length | Pending /address | |
| W12 | 🟡 | Fire-and-forget close can kill the next browser | Pending /address | |
| W13 | 🟡 | Adapter drops typed failures on non-200 | Pending /address | |
| W14 | 🟡 | Cooldown floor and reset | Pending /address | |
| W15 | 🟡 | Verifier checks that pass on missing or wrong evidence | Pending /address | |
| W16 | 🟡 | D1 test (a) after the branch point | Pending /address | |
| S1 | 🔵 | Fixture exception reachable from public input | Pending /address | |
| S2 | 🔵 | Duplicated pacing loop and dead code | Pending /address | |
| S3 | 🔵 | Configuration checked too late | Pending /address | |
| S4 | 🔵 | Cookie Secure flag and SNI for IP literals | Pending /address | |
| S5 | 🔵 | Data lifecycle | Pending /address | |
| S6 | 🔵 | Search failures look like empty results | Pending /address | |
| S7 | 🔵 | sleep() leaks abort listeners | Pending /address | |
| S8 | 🔵 | HEAD + 303 switches to GET | Pending /address | |
| S9 | 🔵 | Local-network reload cannot see a change | Pending /address | |
| S10 | 🔵 | Final-URL header throws for non-Latin-1 | Pending /address | |
| S11 | 🔵 | Stall test records the wrong exit status | Pending /address | |
| S12 | 🔵 | NuQ listener start races | Pending /address | |
| S13 | 🔵 | PostgreSQL pool without timeouts | Pending /address | |
