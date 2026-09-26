# M2 interpretation — guarded retrieval integration and resource-safe browser

Evidence window 2026-09-26 01:01:17Z (BEFORE snapshot) to 07:35:44Z (AFTER snapshot), on one boot. The final corpus ran inside one guard-counter window, 06:53:57Z to 07:34:49Z, the guard's table the same (handle 37) at both ends, on the images the stack runs: the patched API `b0859fca`, the retrieval service `4abda4b8` and the browser worker `06db3f1a`. Upstream `firecrawl/firecrawl` `7666c1f9ae8720a6bba271e0f60b6a217f8a5210` with the six-patch series `c176f8c9…` (result tree `1b98286b`).

- **Checks:** `verification.json`, written by `scripts/m2/verify.mjs` (48 checks), each recomputed from the raw transcripts in `raw/`.
- **Lockfile:** `deploy/versions.lock.json`, resolved from this evidence by `scripts/m2/build-lock.mjs`.
- **Review:** `review/REVIEW.md`, the `/review-2` report of record (both agents on Opus 5.5): 34 findings, 33 fixed with their commits, S6 deferred to M5.
- **BEFORE/AFTER:** `snapshot-before.txt`, `snapshot-after.txt` and the attributed diff `snapshot-diff.txt`, written by X09.
- **Redaction:** X10 compares the SHA-256 of all nine live secrets against every tracked and new repository file (412 at the last run; 0 findings) after its 21 rules fire on their controls. Evidence that would carry the Pi's LAN address or SSH target has `<pi-lan-address>` and `<pi-ssh-target>` in their place.

**State: ACCEPTED.** Every M2 acceptance criterion holds with evidence: 48 of 48 checks pass on the final evidence window, and 0 changes to unrelated host state remain unexplained.

## 1. Browser proof (D2)

| Check | Result |
|---|---|
| B01 native | Kernel 6.18.34 on aarch64 with 16 KiB pages; all 13 Chromium binaries and both running worker processes are aarch64 (`e_machine` 183). |
| B02 alignment | Every LOAD segment is aligned to 0x10000; none below 0x4000. |
| B03 non-root | Every proof process runs as uid 3320; no unexpected capability; the worker drops ALL and is not privileged. |
| B04 sandbox | The control launch without namespaces fails ("sandboxing failed"); the proof launch succeeds with the sandbox on; the renderer sits three PID namespaces deep under two seccomp filters; the worker has its own seccomp profile. |
| B05–B07 | The fixture renders ("Rendered by script", its sentinel); closing leaves no Chrome process (7 before, 0 after); no uid-3320 process or transient container remains. |

## 2. D1 admission

Playwright 1.63.0, npm's latest at build, bundles Chromium 153.0.8010.12 (revision 1243). Chrome's release posts name 64 CVEs exploited in the wild; every one is admitted, and the lock lists all 64 with their results (D01). Two fixes were posted after milestone 153 branched: CVE-2026-85046 passes both tests; CVE-2026-87491 fails test (a) (first fixed in 153.0.8010.36) and passes test (b), its fix commit being an ancestor of the V8 revision 153.0.8010.12 pins, with no later commit on that branch naming the bug. For a fix posted after the branch point only test (b) counts (review finding W16), so a row outside V8 there would fail.

## 3. Build provenance (D4, D6)

- **API image (D02).** Built on the workstation's Colima VM natively for linux/arm64 (D6), with every step run (`no_cache=1`), from a clean checkout of `7666c1f9` with the series applied, at repository commit `0890682` with no uncommitted code, in 144 s. The image `b0859fca` carries `FCPI_PATCH_SERIES_SHA256=c176f8c9…` and `FIRECRAWL_BUILD_SHA=7666c1f9…`. Its three FROM lines are pinned by digest; Go 1.27.1 and Rust 1.98.1 print their versions; cargo runs `--locked`, pnpm `--frozen-lockfile`, apt from a fixed snapshot; the FoundationDB client passes its SHA-256. The patched image replaces the acquired one (Q7). Log: `raw/api-build.log`.
- **Service images (D03).** Built on the Pi from the deployed commit with `npm ci`: the retrieval service on `node:22.23.3-bookworm-slim` and the browser worker on `mcr.microsoft.com/playwright:v1.63.0-noble`, both by digest. Transcript: `raw/service-build.txt`.

## 4. Patch series

| Patch | SHA-256 (prefix) | What it changes |
|---|---|---|
| 0001 NuQ sender survives a broker outage | `38241b2c` | `startSender()` catches a refused connection and leaves the sender null; every caller already falls back to PostgreSQL (R2). |
| 0002 NuQ listener restarts after a broker outage | `8489318e` | The consumer is registered before the listener is published; restarts back off 250 ms–5 s; callers share one start, and a listener closed while starting is not published (R1; review finding S12). |
| 0003 pi-resilient engine adapter | `da924612` | The retrieval service as the only engine; the service's typed refusal ends the engine loop on every status; the profile refuses another engine or `ALLOW_LOCAL_WEBHOOKS`. |
| 0004 guarded auxiliary downloads | `776cf0dd` | Sitemaps, documents and redirect discovery through `/internal/fetch`; sitemap gunzip bounded at 50 MB. |
| 0005 search without direct fallback | `924735ea` | No direct DuckDuckGo fallback in the profile. |
| 0006 reproducible arm64 build | `c548cfed` | Digest-pinned bases, pinned toolchains, locked dependencies, the FoundationDB client's SHA-256. |

P01 recomputes every hash and the series hash, and finds all 12 call-site coverage entries covered. P02 follows each traced path to the adapter on the live stack: a crawl's 4 pages, robots.txt, 4 sitemaps with their own budget, the auxiliary fetches, 2 search results scraped through the backend, a PDF, and 13 refused subresources beside the pixel that reached its fixture.

## 5. Retrieval policy

- **Attempt budget (A01, A02; R3).** At most four attempts per logical page, however many times upstream or NuQ asks: three calls leave 2, 4 and 4 attempts, the third refused `ATTEMPT_BUDGET_EXHAUSTED`. A batch job stalled twice until NuQ's reaper requeued it saw 4 attempts over 3 runs, the third run spending none; the fixture counted 4 requests.
- **Direct pacing (A03).** Per registrable domain: one navigation at a time, a 2 s gap measured from the end of the previous navigation, 20 per hour and 200 per day across the platform. The pacing phase's 20 navigations reached the target at least 2,007 ms apart, three of them by redirect from another domain, and the 21st was refused `PROXY_REQUIRED` in 17 ms instead of waiting. Redirect hops are paced on their own domain (review finding C4), and a bare 429 cools its host down for 60 s, doubling while it recurs (W14).
- **Permits (A04).** Two URL acquisitions and one browser page at a time: three slow acquisitions took 4.1, 4.1 and 8.1 s, the third waiting for a permit; all permits were free afterwards.
- **Tiers (R01–R05).** Static pages never start Chromium (20 attempts, all direct HTTP, 0 renders, with the worker up). Script, delayed and cookie pages render (7 renders). Bad and short content is classified by structure (C5). Declared, decoded and rendered bodies over 25 MiB are `SIZE_LIMIT`, a slow target times out, three redirects are followed and twelve are refused. Screenshots, actions and stealth proxies are refused and never acquired.
- **Failure paths (C01–C03).** A caller that goes away cancels the fetch and the render (both `CANCELLED`), frees every permit and leaves no defunct process. Killing Chromium mid-render is `BROWSER_CRASHED`, the next render succeeds and no Chrome process older than the kill survives. With the worker stopped, a static page still succeeds and a script page fails `BROWSER_UNAVAILABLE`.

## 6. SSRF matrix

S01 sends 18 cases through the core and 18 straight to the service: a project container's private address, IPv4 and IPv6 loopback, the metadata address, a hex-encoded loopback, a project service name, the host's LAN, IPv4-mapped IPv6, a CGNAT/Tailnet address, a `file:` URL and a Firecrawl Cloud destination, and seven fixture redirects into those. Every one is refused, the core's own URL check answering `BAD_REQUEST` and the service `SSRF_DENIED` or `CLOUD_DENIED`; the redirects are refused at the hop. The phase's attempts are all accounted for: the control's one adequate fetch, 6 `SSRF_DENIED` and 1 `CLOUD_DENIED`. S02 refuses all 13 of the subresource fixture's private, numeric, Cloud and project-internal requests at the proxy, each log line naming its host and attempt, while the pixel control reaches its fixture. The unit suite pins DNS rebinding: each connection uses the one address it checked. Fixture hosts count only for work that began at a fixture (review finding S1).

## 7. Resources

| Service | memory.max | cpu.max | pids.max |
|---|---|---|---|
| firecrawl-core | 2,304 MiB | 2.25 | 512 |
| browser-worker | 1,536 MiB | 1.5 | 512 |
| nuq-postgres | 640 MiB | 0.75 | 128 |
| rabbitmq | 512 MiB | 0.5 | 256 |
| retrieval-service | 448 MiB | 0.6 | 128 |
| redis | 320 MiB | 0.35 | 64 |
| fixture-m2 | 192 MiB | 0.2 | 32 |
| access-gateway | 160 MiB | 0.3 | 64 |
| fixture | 64 MiB | 0.1 | 32 |

Caps are read from each container's cgroup (M01): 6,176 of §22's 6,432 MiB, no swap, the worker's shared memory 256 MiB.

- **Core before Chromium (M02; R6).** On a freshly created core, after the static, SSRF, budget and permits phases with no browser worker, the core peaked at 1,822 of 2,304 MiB (79.1%), under the 85% at which §22 asks for a rebalance.
- **Stress (M03).** A render allocating 512 MiB succeeds; no cgroup's `oom_kill` rises; host MemAvailable stayed at 4,566 MiB or more; the browser peaked at 704 MiB.
- **Over the cap (M04).** A page past the worker's cap is `RENDERER_CRASHED`: the kernel's memory-cgroup kill takes the renderer, `oom_kill` rises in the browser worker alone, PostgreSQL, Redis, RabbitMQ, the core and the gateway stay healthy, the next render succeeds, and MemAvailable stayed at 4,897 MiB or more.
- **A displayed 30-million-character document** exhausts the renderer's memory in layout before the worker can measure it; the same containment holds (`raw/rt-browser-huge-dom-visible.txt`). The size-bound case holds its text out of layout and is `SIZE_LIMIT` at 30,000,878 characters (R04).

## 8. The M1 findings M2 took

| Finding | Outcome |
|---|---|
| R1 (#4244) | The listen queue has its consumer back one second after the broker returns, and a new synchronous scrape returns (N02). Patch 0002 carries the fix. |
| R2 (PC-NUQ-CONNECT) | With restart policies off, the broker is stopped for 35 s: a synchronous scrape submitted during the outage completes through PostgreSQL in 619 ms, the core never restarts (restart count 0), and one after recovery completes through the reply queue (N01). Killing the worker mid-job is recorded: the synchronous client gets 408 after 60 s, the job fails after one stall, and a batch job completes on its requeued run (N03). |
| R3 | Four attempts across two NuQ requeues (A02). |
| R4 (`ALLOW_LOCAL_WEBHOOKS`) | Set by no service; the core joins no fixture network; the profile's configuration refuses it; the spec states that it stays unset in every profile (X05). |
| R6 | The core's peak before Chromium and the stress run (§7). |
| R7 | Every core instance's whole log is kept before it is replaced: 45 instance records across 9 captures, each Cloud and name-resolution line classified with its harness-start control, none unexplained (X01). |
| Q7 | The patched build of record replaces the acquired API image (D02). |

## 9. Deferred findings

S6 (search failures look like empty results) is deferred to M5: M2 routes search acquisition through the guarded policy (patch 0005) against a fixture backend, and telling a backend error from an empty result needs the real backend, SearXNG, which M5's Scope supplies; M5's Automated Verification names its controlled error and empty-result cases. No other finding is deferred.

## 10. Deviations, and what re-collection found

- **Found while re-collecting after `/address`, and fixed.** The pacing phase measured 1,981 ms between two redirect-arrived requests against the 2 s gap: the pacer stamped the gap when it decided, and the target sees a request only after its resolution and connection. The gap now runs from the end of the previous navigation (`f8cde91`). The huge-document fixture displayed its text, which exhausted the renderer before the size bound ran; the fixture now holds the text out of layout and the displayed run is kept (`4e0dad9`). X01 detected a guard reload only by dockerd's start, though `pi-init-m2.sh` reloads the guard too; it now compares the guard table's handle, which every load changes (`5afbbe9`). The egress collector read the router's address with a double-quoted sed pattern in which bash expanded `$#`, so it never probed that address; the pattern is single-quoted, and X03 now probes it (`735d8f3`).
- **Held live step.** The one live step, measuring the router's public address with one HTTPS request from the host to api.ipify.org (`scripts/m2/pi-wan-address.sh`, review finding W8), ran after `/address` and outside the corpus's egress bridge. Its first attempt returned no address, a transient failure kept as `raw/wan-address-first-attempt.txt`; the second measured the address M0 measured, added it to the local-network list and the guard's set, and the retrieval service's mounted copy showed the rewrite at once (review finding S9). M2's acceptance asks for controlled local tests only, so no public page was fetched.
- **Build host.** The API image is built on the workstation's Colima VM, natively for arm64, as D6 allows.
