## Code Review: post-M9 retrieval quality (43199b3..41c491f plus the held working-tree budget, Brave and spec changes)

### Summary
Reviewed 40 files (about 1,000 changed lines) with `/review-2`'s two fresh-context agents, DB1 (debugger) and CA1 (code-auditor), both on Opus 5.5 (the Agent tool's `opus` alias), as CLAUDE.md §5 requires; the skill's team tools were not available in this runtime, so the two agents ran as parallel background agents, each returning its `/review` block (a substitution of mechanism only, not of model). Neither found a critical issue; the home-IP rules hold and every spend path stays inside the transactional caps, but the held paid-dispatch change loses its off-switch on a restart, and several new paths need fixes or tests.

**Scope:**
- **Reviewed (diff-anchored, `git diff 43199b3 -- <file>`):** Tier 1 (full): `services/retrieval/src/{acquire,quality,store,policy,search,route,server}.mjs`, `services/access/server.mjs`, `services/access/src/{maplinks,outcome,config,routing}.mjs`, `services/mcp/src/tools.mjs`, `deploy/policies/{budget,egress,capabilities}.json`, `deploy/compose.yaml`, `deploy/compose.paid-dispatch-off.yaml` (untracked, full file), `deploy/searxng/settings.yml`; CA1 also `docs/FIRECRAWL_PI_SPEC.md` (changed hunks) and `scripts/ops/restore-procedure.txt` step 6. Tier 2 (skim): the changed tests, `tests/contracts/m3-gateway.test.mjs`, `scripts/retrieval-quality/*`.
- **Skipped:** the upstream Firecrawl core patch series, accepted milestone evidence, `scripts/m*/` historical verifiers (out of scope by the context block).
- **Not run by the reviewers:** test suite, linters, build (read-only review).

### 🔴 Critical Issues (Must Fix)
None.

### 🟡 Warnings (Should Fix)

**Introduced in this changeset:**
1. **[R1] `waitFor > 0` sends non-HTML targets to Chromium** - `services/retrieval/src/acquire.mjs:579-580`  _(unique to DB1's lane)_
   - Problem: every `expect: "html"` page with a wait starts in `browserStep` with no HTTP attempt; the core sets `expect` from URL flags only, so an extensionless PDF URL arrives as html and fails on Chromium's download (NAVIGATION_FAILED/BROWSER_ERROR), and text/plain or JSON comes back wrapped in Chromium's `<pre>` viewer markup; under browser admission pressure every `waitFor` request fails RESOURCE_BUSY though HTTP could serve it.
   - Suggestion: when the render's main response is not HTML, or the navigation failed for a waits-start page, fall back to one HTTP attempt; test with an extensionless PDF and a text/plain fixture.
2. **[R2] A length-based (non-structural) JS shell loses its adequate HTTP answer when the browser step fails** - `services/retrieval/src/quality.mjs:142-146`, `services/retrieval/src/acquire.mjs:588`, `:566`  _(unique to DB1's lane)_
   - Problem: short script-heavy pages (Next.js App Router payloads, short pages with large analytics) now go to `browserStep`, and any browser-side failure (DIRECT_LIMIT on the extra navigation, RESOURCE_BUSY under pressure, RESOURCE_LIMIT on subresources) ends the page although the HTTP body was adequate before this change; in `enhancedStep` an enhanced `http` answer of such a page becomes RENDER_INCOMPLETE.
   - Suggestion: carry the HTTP answer of a non-structural shell and return it when the browser step fails for a reason other than the content itself; in `enhancedStep` fail only structural shells.
3. **[R3] `mapStartUrl` treats any dotted last segment as a file** - `services/access/src/maplinks.mjs:16`  _(unique to DB1's lane)_
   - Problem: `https://docs.python.org/3.12`, `https://github.com/vercel/next.js` and npm's `/package/socket.io` are directories, not files; the map widens to the parent and fills the limit with links outside the asked scope.
   - Suggestion: strip only page-file extensions (`/\.(?:s?html?|php\d?|aspx?|jspx?|cfm|cgi)$/i`); test the dotted-directory cases.
4. **[R4] The paid-dispatch off-switch is lost on any restart, and the rollback plan never applies it** - `deploy/compose.yaml:540`, `deploy/host/fcpi-stack.service`, `scripts/ops/plan.sh:96-98`, `scripts/ops/restore-procedure.txt` step 6, `docs/FIRECRAWL_PI_SPEC.md:964`  _(corroborated: both agents; DB1 as a suggestion, CA1 as a warning, merged at the higher severity)_
   - Problem: with `compose.yaml` defaulting `PI_PAID_DISPATCH_ENABLED: "true"`, the off state exists only as a per-command `-f compose.paid-dispatch-off.yaml`; a reboot during a restore window (the Wi-Fi watchdog reboots this host) starts `fcpi-stack.service` without it, so paid dispatch runs against a ledger restored from before the backup's later spend; `plan.sh`'s data-restore rollback assumes compose keeps paid dispatch off and never names the override, while the spec says the override covers a rollback.
   - Suggestion: make the off state the persistent default (a host-side switch the owner sets, moved aside by restore and rollback), so every start, boot included, fails closed until it is set.
5. **[R5] `deploy/versions.lock.json` no longer describes the running baseline (CLAUDE.md §22)** - `deploy/versions.lock.json`  _(unique to CA1's lane)_
   - Problem: three image digests, the policy and SearXNG settings hashes, `bulkPages`, the direct limits, the live engines, the proxy caps and the paid-dispatch line all differ from what runs or will run; `scripts/retrieval-quality/rebuild-images.sh` repins compose but not the lock, which backups record and `plan.sh` diffs.
   - Suggestion: regenerate those lock sections in the commit that lands the working-tree changes, and have the rebuild update the lock's image entries with compose's.
6. **[R6] The map's start-page fetch skips the `scrape` scope, can take the paid route, and ignores the caller's timeout** - `services/access/server.mjs:405-406` (precedent `:383-384`)  _(corroborated: both agents)_
   - Problem: the page fetch is an ordinary auto-route scrape, so a token with only the `map` scope acquires a page (review W7 made search's page acquisition need `scrape`), a challenged or edge-blocked start page escalates to the residential route, and the scrape runs up to `coreTimeoutMs` (110 s) whatever `timeout` the map asked for.
   - Suggestion: gate the page source on the `scrape` scope (sitemap only without it) and say in the map tool description that the start page is fetched like a scrape; pass the caller's `timeout`.
7. **[R7] Map moved from `upstream.forward` to `upstream.call` and lost its cancellation and Retry-After; error paths wait for the page** - `services/access/server.mjs:400-427`, `services/access/src/upstream.mjs:22-100`  _(only CA1 — DB1 was in scope but didn't flag)_
   - Problem: a client that leaves no longer cancels the core requests (both run up to 110 s holding a sync slot); a core 429's `Retry-After` is dropped; a fast core-map error still waits for the page scrape before it is answered.
   - Suggestion: give `upstream.call` an abort signal and abort the page scrape when the client closes or the core map fails; pass `retry-after` through.
8. **[R8] Brave on the residential route pays on every search and shares the cap that unblocks pages** - `deploy/policies/egress.json` (working tree), `services/retrieval/src/residential.mjs:313-322`, `deploy/policies/budget.json`  _(unique to CA1's lane)_
   - Problem: every search opens a Brave tunnel whether or not Yahoo answered; at an assumed 250 KB per answer and 60 searches an hour that is about $1.4 a day, which would exhaust the $0.50 day cap and leave challenged pages BUDGET_EXHAUSTED; partial answers are never cached; the search tool does not say it may spend.
   - Suggestion: give search tunnels their own small category, or query Brave only when Yahoo's answer falls short, and disclose possible spend.
9. **[R9] Scripts inside `<head>` are never counted, so the JSON-LD exclusion test cannot fail** - `services/retrieval/src/quality.mjs:36`, `:103`; `services/retrieval/test/quality.test.mjs:154`  _(corroborated: both agents; DB1 as a suggestion, CA1 as a warning)_
   - Problem: `walk()` skips the whole `head`, so head-placed data (`window.__INITIAL_STATE__`) never counts and the JSON-LD fixture (in `<head>`) gives `scriptChars` 0 with or without the exclusion (a check that cannot fail, CLAUDE.md §33.3).
   - Suggestion: count `<script>` contents inside `head` too; move the JSON-LD fixture into `<body>` and add a head-placed data script.
10. **[R10] New critical-path branches have no tests** - `services/access/server.mjs:409-423`, `:503-504`, `deploy/compose.paid-dispatch-off.yaml`, `services/mcp/src/tools.mjs:143`  _(corroborated: both agents)_
    - Problem: untested map branches (`pageError`, core-map failure while the page is pending, `MAP_PAGE_NOTE`, keeping or dropping the core's warning), the `/interact` warning drop, the paid-dispatch off-switch, and the `MD_LINK` no-backtracking claim; also `waitFor` with non-HTML content, a browser failure after a non-structural shell, dotted-directory map URLs and head-placed scripts.
    - Suggestion: add contract and unit tests for each.

### 🔵 Suggestions (Consider)

**Introduced in this changeset:**
1. **[R11] `retryAfter` is early when the window holds more navigations than the cap** - `services/retrieval/src/store.mjs:20`  _(corroborated: both agents)_
   - Current: unpaced `recordNavigation` rows (browser-followed redirects, action navigations) or a lowered limit leave count above the cap, so the oldest row leaving does not free a slot.
   - Better: use the (count − cap + 1)-th oldest row (`ORDER BY at OFFSET count − cap LIMIT 1`).
2. **[R12] The `/interact` filter deletes the whole warning** - `services/access/server.mjs:504`  _(corroborated: both agents)_
   - Current: any other advice joined into the same string is lost. Better: remove only the sentences about `/interact`.
3. **[R13] The SearXNG `/config` cache keeps a failed read for ten minutes, and concurrent searches each fetch it** - `services/retrieval/src/search.mjs:52-61`  _(unique to DB1's lane)_
   - Better: a short TTL for a failed read, and one in-flight read shared by concurrent searches.
4. **[R14] `fcpi.failed` counts the gateway's own notes as failed pages** - `services/access/src/outcome.mjs:29`  _(unique to DB1's lane)_
   - Current: `ARCHIVE_INCOMPLETE`, `UPSTREAM_ERRORS_LOST` and `ERRORS_TRUNCATED` (ids `fcpi:…`) each add one to `failed` though they stand for many pages or an unknown number. Better: report them apart from the page count.
5. **[R15] An edge "restrict access" page can be a user-agent or path rule, and two of them teach the domain a residential preference that keeps paying** - `services/retrieval/src/quality.mjs` (`EDGE_BLOCK_MARKERS`)  _(corroborated: both agents)_
   - Better: stop preferring the residential route for a domain where it is refused too, or record the trade-off in spec §9.5.
6. **[R16] With the global switch on, the other paid providers are held only by zero caps; `/readyz` reports the enhanced tier from `state()`, which skips caps** - `deploy/compose.yaml:540`, `services/retrieval/src/enhanced.mjs:71`, `services/retrieval/src/server.mjs:225`  _(unique to CA1's lane)_
   - Better: a per-provider dispatch allowlist; readiness from `availability()`.
7. **[R17] New browser starts can multiply Chromium use** - `services/retrieval/src/acquire.mjs:579-583`, `services/retrieval/src/quality.mjs:145`  _(unique to CA1's lane)_
   - Current: `waitFor` in a crawl's `scrapeOptions` renders every page; the length-based shell adds one render and one navigation per short script-heavy page. Better: limit `waitFor` browser starts to single scrapes, or record browser-start counts in evidence.
8. **[R18] Pacing queries run for residential navigations, whose counts are ignored** - `services/retrieval/src/store.mjs:147-151`  _(unique to CA1's lane)_
   - Better: skip both count queries when the navigation is not direct.
9. **[R19] MCP status drops `creditsUsed` silently** - `services/mcp/src/tools.mjs:204`  _(unique to CA1's lane)_
   - Better: document it, or keep `creditsUsed: null`.
10. **[R20] The spec's §9.1 flowchart shows volume going residential and omits `waitFor`** - `docs/FIRECRAWL_PI_SPEC.md:300-305`  _(unique to CA1's lane)_
    - Better: add the `DIRECT_LIMIT` edge and `waitFor` to the browser-first rule.
11. **[R21] The "no admitted job exceeds bulkPages" rule lives only in a test** - `services/access/src/config.mjs:106`  _(unique to CA1's lane)_
    - Better: enforce it in `checkManifest`.
12. **[R22] Nits** - `services/retrieval/src/quality.mjs:28` (`LOGIN_PATH =/`), `services/retrieval/src/store.mjs:109-110` (double blank line), `services/retrieval/src/acquire.mjs:389` (an edge refusal is reported as "a bot interstitial")  _(unique to CA1's lane)_

**Pre-existing:**
1. **[R23] [PRE-EXISTING] `ORCHESTRATION.html` embeds a stale spec snapshot** - `ORCHESTRATION.html`  _(unique to CA1's lane)_
   - Current: the embedded spec hash (`5271bb…`) already differed from HEAD (`2c90ad…`) after 43199b3. Better: refresh the snapshot, hashes and ranges in the commit that lands the spec edits (CLAUDE.md §33.4).

### ✅ Good Practices
- Past the allowance a page fails `DIRECT_LIMIT` on both the HTTP and browser steps with no residential leg; tests assert zero tunnels and an empty ledger, and `paceDecision`'s retry time is whole seconds, never 0 and never invented.
- Removing `escalateAtCap` and `setAttemptStrategy` closes the volume-to-paid path; the two `bulkPages` copies agree and are each validated at startup; `loadPolicy` still refuses an allowance looser than the spec, and `restore.jq` still forces paid dispatch off for restore tests.
- The new regexes (`MD_LINK`, `EDGE_BLOCK_MARKERS`, `RETRIEVAL`) use bounded quantifiers on delimiter-excluding classes; the edge-block markers fire only on a 403 with HTML and have negative controls.
- Browser learning needs a render showing at least twice the shell's text plus 100 characters, and both outcomes are tested.
- `jobOutcome` reads only the owner-bound job row, bounds detail and samples, and states `retryAt` as an instant; `mapWithPageLinks` decrements `syncInFlight` in a `finally` and catches the page scrape's rejection into a value.
- The grader redacts the tailnet host and never prints the MCP token.

### Verdict
[ ] ❌ Request Changes (critical issues)
[x] ⚠️ Approve with Suggestions
[ ] ✅ Approve

---

## Outcomes

Recorded after `/address`; each finding is fixed (with its commit) or rejected (with the evidence that it is not a defect). This post-M9 work has no later milestone to defer to. Every fix is deployed at `a1764d2` and verified by the final run: every Pi suite passes (`raw/pi-suites-4.txt`) and every graded test is A+ (`grade-2026-10-06T130238733Z.json`). Fixed: 21 findings and part (b) of R16. Rejected with evidence: R16 (a) and R17. Deferred: none.

| ID | Finding | Outcome |
| --- | --- | --- |
| R1 | `waitFor > 0` sends non-HTML targets to Chromium | Fixed, `e277ef7`: a page asked to wait gets one HTTP attempt after a browser-side failure or a main response that is not HTML (`NOT_A_PAGE`). |
| R2 | A length-based shell loses its adequate HTTP answer when the browser step fails | Fixed, `e277ef7`: the HTTP answer is kept and served when the render fails for the browser's own reasons, never after a rendered block, denial or shell. |
| R3 | `mapStartUrl` treats any dotted last segment as a file | Fixed, `b5a612a`: only a page extension names a file; `/3.12`, `next.js` and `socket.io` map under their own path. |
| R4 | The paid-dispatch off-switch is lost on restart; rollback never applies it | Fixed, `e5f4696`: the switch is the optional host file `/etc/firecrawl-pi/paid-dispatch.env` (`fcpi paid on\|off`), so every start without it runs paid dispatch off; restore and rollback move it aside before anything starts (`tests/contracts/paid-dispatch-switch.test.mjs`). |
| R5 | The version lock no longer describes the running baseline | Fixed, `2eaa672` and `a5677a0` (a rebuild sets each image's lock entry with its compose digest, every build tagged with its commit) and `0110661` (the policy-derived entries recomputed from the committed policies). |
| R6 | The map's start-page fetch skips the `scrape` scope, can take the paid route, ignores the caller's timeout | Fixed, `fc64b24`: the page source needs the `scrape` scope (else `pageError: SCRAPE_SCOPE_REQUIRED`, sitemap alone), keeps the map's timeout, and the map tool says how the page is fetched. |
| R7 | Map lost cancellation and Retry-After; error paths wait for the page | Fixed, `fc64b24`: `upstream.call` takes an abort signal and returns headers; a departed client cancels both requests, a failed core map ends the page fetch, and a 429's Retry-After passes on. |
| R8 | Brave on the residential route pays on every search | Fixed, `0673cca` (fallback engines are asked only when the home connection's engines failed or answered fewer than ten after a second page) and `11e4ea3` (no live fallback engine: through the residential route Brave answered SearXNG 429 at 12:24:51Z and 12:30:21Z and DuckDuckGo its CAPTCHA, so a search spends nothing). |
| R9 | Scripts inside `<head>` are never counted; the JSON-LD exclusion test cannot fail | Fixed, `6327127`: the head's inline scripts are read in one forward pass, JSON-LD still excluded; the test now fails without the exclusion. |
| R10 | New critical-path branches have no tests | Fixed: `fc64b24` (map scope, timeout, failed page fetch, no sitemap links, warning kept and dropped, 429 with Retry-After, cut page fetch, departed client, narrowed `/interact` warning), `e5f4696` (the paid-dispatch switch), `9d86deb` (the link pattern's linearity, CWE-1333), `e277ef7` (`waitFor` on a non-HTML target, a failed render after a non-structural shell), `b5a612a` (dotted directories), `6327127` (head-placed scripts). `deploy/compose.paid-dispatch-off.yaml` no longer exists. |
| R11 | `retryAfter` is early when the window holds more navigations than the cap | Fixed, `937700e`: the retry time comes from the (count − cap + 1)-th oldest navigation, tested against real SQL (`m6-store.test.mjs`). |
| R12 | The `/interact` filter deletes the whole warning | Fixed, `fc64b24`: only the advice to use `/interact` is removed. |
| R13 | The `/config` cache keeps a failed read ten minutes; concurrent searches each fetch it | Fixed, `51ee448`: a failed read is kept thirty seconds and concurrent searches share one read. |
| R14 | `fcpi.failed` counts the gateway's own notes | Fixed, `72c5b2d`: notes (`fcpi:…` ids) are listed in `fcpi.notes`; `failed` counts pages. |
| R15 | Edge-refusal learning can keep paying where the residential route is refused too | Fixed, `50ac998`: the trade-off is recorded in spec §9.5, as the review offered: one refused residential attempt per page (an edge refusal page is a few KB, about $0.00004 at $4/GB) until the preference expires, within the transactional caps. |
| R16 | Other paid providers held only by zero caps; `/readyz` reads `state()`, which skips caps | (a) Rejected: a zero cap refuses before anything is sent. `services/retrieval/test/m7-enhanced.test.mjs:262-276` turns paid dispatch on with the committed zero caps and asserts `BUDGET_EXHAUSTED`, `ENHANCED_REQUIRED` and zero provider calls. `budget.json`'s per-category caps are the owner's per-provider approval, so an allowlist would be a second copy of it. (b) Fixed, `a863062`: `/readyz` reports each paid tier from `availability()`. Before it, the live answer read Zyte `available: true` with its caps at zero; at deployed `a1764d2` it reads Zyte `available: false, reason: BUDGET_EXHAUSTED`, with the residential tier, whose caps have room, still available as the positive control (`raw/readyz-after.txt`). |
| R17 | New browser starts can multiply Chromium use | Rejected: one browser page runs at a time (one browser permit; `services/retrieval/src/policy.mjs` refuses to start with `PI_MAX_BROWSER_PAGES` other than 1, spec §23.1), so an extra render waits rather than runs beside another; `waitFor` on a crawl is the caller's request for each page. The grade records every page's strategies (`acquisitions`): in the final run (`grade-2026-10-06T130238733Z.json`), 3 of 51 pages started the browser: one JS page after its HTTP shell, one `waitFor` and one screenshot; 47 stayed on HTTP. |
| R18 | Pacing queries run for residential navigations | Fixed, `937700e`: a residential navigation reads neither window. |
| R19 | MCP status drops `creditsUsed` silently | Fixed, `9d86deb`: the status tools say `creditsUsed` is left out when the core counts none. |
| R20 | The §9.1 flowchart shows volume going residential and omits `waitFor` | Fixed, `50ac998`: the flowchart shows `DIRECT_LIMIT` (never residential), the held/proxy-first/learned-block route, the edge refusal and the requested wait. |
| R21 | The "no admitted job exceeds bulkPages" rule lives only in a test | Fixed, `688df34`: `checkManifest` refuses a manifest whose largest crawl or batch exceeds `limits.proxy.bulkPages`. |
| R22 | Nits | Fixed, `381f8b7`: `LOGIN_PATH =` regains its space, the double blank line is gone, and an edge refusal is reported with its own detail instead of "a bot interstitial". |
| R23 | [Pre-existing] `ORCHESTRATION.html` embeds a stale spec snapshot | Fixed, `50ac998` (snapshot, hashes and ranges refreshed with the spec edits) and `170251b`, `09662f3` (the refresh tool escapes every `<`, reads the page afresh for each hash length, and stops on a displayed hash that does not match its file). The second fix is the cause of the milestones document's displayed hash being stale since `ba79c6d`: a refresh that changed the spec too rewrote the milestones' embedded hash in place of its displayed one. |
