# M6 interpretation — residential proxy and anti-bot routing policy

**Evidence window.** It runs from 2026-09-26 23:49:34Z (BEFORE snapshot) to 2026-09-27 03:00:38Z (AFTER snapshot), on one boot. The final evidence ran inside one guard-counter window from 02:50:25Z to the egress probe at 03:00:01Z, with the guard's table the same (handle 17) at both ends:

- the fixture phase, 02:50:26Z to 02:56:16Z;
- the live phase, 02:56:51Z to 02:56:52Z.

An earlier window (01:26Z) ran on the code the review was given; the review's remediation replaced every service image, so its raw records were collected again in this window and describe only the code below.

**What ran.** The stack ran the code deployed at `8530c3d`:

- the patched API image `5d503ca0`, built from `968a779` with patch series `4e802a78` (patch 0009 carries the scrape's proxy option to the retrieval service); the review changed no patch, so the image was not rebuilt;
- the retrieval, gateway and MCP images `6221e27c`, `c8b7848e` and `da62ede1`, built on the Pi from `8661527`;
- the guard `14703015` with the proxy-port rule, and the capability manifest `325a5792`.

**Artifacts.**

- **Checks:** `verification.json`, written by `scripts/m6/verify.mjs` at `47b2811`: 27 checks, each recomputed from the raw transcripts in `raw/`, every record with `code_dirty=false`. 25 PASS; the live checks L01 (proxied egress) and L02 (residential search engines) are BLOCKED_CREDENTIAL.
  - the fixture evidence is `raw/e2e-fixture.txt`, the live evidence `raw/e2e-live.txt`;
  - `raw/pi-init-m6.txt` and `raw/pi-up-m6.txt` are the first bring-up's transcripts; no check reads them. The remediation's rerun of both scripts reinstalled the guard file (only a comment changed), added the review's S10 index and recreated every service.
- **Lockfile:** `deploy/versions.lock.json`, resolved from this window by `scripts/m6/build-lock.mjs`: the four images, the patch series, the budget policy `8c3b9a62` with nine rate cards, the egress policy `4c6cd176`, the guard and the manifest.
- **Review:** `review/REVIEW.md`, the `/review-2` report of record (two agents, both on Opus 5.5): of its 32 findings, 31 are fixed with their commits and S9 is rejected with evidence from the pinned upstream source; M5's carried F11 is fixed (fixture-verified, its live proof BLOCKED_CREDENTIAL); nine more found during M6 are recorded as F1–F9, each fixed.
- **BEFORE/AFTER:** `snapshot-before.txt`, `snapshot-after.txt` and the attributed diff `snapshot-diff.txt`, written by X04: 0 lines unexplained, no reboot.
- **Redaction:** X05's 23 rules fire on their controls; it compares the SHA-256 of 31 live secrets (the fixture proxy's credential, 17 client token files) against 687 files, with 0 findings. No M6 file carries the Pi's LAN address, network or SSH target.

## 1. No spill onto the home connection (R03, R07, R11)

With the production selection (Decodo, no credential, paid dispatch off), every piece of protected work is refused before a target is reached: a stealth scrape and a proxy-first domain are PROXY_REQUIRED with no attempt; a bulk crawl and a bulk batch are 429 PROXY_REQUIRED and a local-only bulk crawl 400, with the receipt count unchanged (230 → 230). Beside them an ordinary scrape and a five-page crawl run directly, the positive controls. With the fixture proxy, a 25-page crawl and a 21-URL batch finish with all 28 of the bulk domain's requests, robots.txt included, through the proxy, under a hold released at the end. With the route gone again, the keyed bulk crawl replayed returns its own receipt while the same crawl under a new key is refused (the review's W4). Provider refusals and an unreachable provider open the breaker without touching the domain's routing record, and ordinary direct work goes on beside it (R07). The residential search engine goes through the proxy, and without the route SearXNG reports it as not answering rather than sending it directly (R11, M5's F11).

## 2. Escalation, learning and the failure rules (R04–R06, R12)

A script shell whose direct render is a challenge goes direct HTTP, direct browser, residential browser; a 403 or 200 challenge goes direct HTTP then residential HTTP. 401, an unknown 403 and 429 end after one attempt and never reach the provider; 500 gets one same-tier retry; a 429's cooldown holds on every route. Two consistent challenges set a 24-hour residential preference, and after it expires one probe goes direct and confirms the block. No acquisition passed three attempts (limit four). All 92 of the phase's acquisitions record their route fields.

## 3. Money (R08–R10)

Eight simultaneous reservations against a cap with room for three granted exactly three. 71 proxy rows were written, 67 settled and none left UNCERTAIN; an attempt past its byte reservation is SIZE_LIMIT with no retry.

Reconciliation compared the fixture proxy's report for the day (20,462,238 bytes) with the ledger's measurement (40,489,330 bytes) and charged nothing, since a report below the measurement leaves the measured charge standing. The gap is the fixture's, not the ledger's: the ledger holds both of the day's fixture runs, while `scripts/m6/pi-up-m6.sh` recreated `fixture-m6` between them and reset its in-memory counters. The review's C1 fix is what makes the repeated run safe: an earlier window's adjustment counts as measured, so nothing was charged twice.

## 4. Zero Cloud attempts and host posture (X01–X05, M01)

Across the window the guard accepted no web and no proxy-port connection (the fixture proxy is on the internal fixture network), the core's 24 saved logs classify every Cloud line, and the retrieval log's 227 lines name no Cloud host and carry no credential, bearer, Proxy-Authorization or session username. The fixture network is internal with no default route. Peak memory stayed within every service's cap (the core at 0.79 of its own), with at least 4,779 MiB available on the host. The one ruleset change since M5 is the proxy-port rule, attributed.

## 5. What remains

- **L01 and L02 are BLOCKED_CREDENTIAL.** They need a Decodo credential (a proxy-only user with a provider-side traffic limit, spec §10.3), an approved proxy budget and paid dispatch; none exists, and none may be inferred (CLAUDE.md §11). The live phase checked for them and made no request.
- **Decodo's reconciliation stays off** until an account used by this deployment alone is configured (`usageDedicated`, the review's W13).
- Nothing is deferred to a later milestone.
