# M7 interpretation — enhanced retrieval and practical Cloud-gap closure

**Evidence window.** It runs from 2026-09-27 04:56:00Z (BEFORE snapshot) to 09:38:20Z (AFTER snapshot). The final evidence ran inside one guard-counter window from 09:12:29Z to the egress probe at 09:37:43Z, with the guard's table the same (handle 12) at both ends:

- the fixture phase, 09:12:30Z to 09:31:53Z;
- the live phase, 09:32:36Z to 09:33:23Z.

The host rebooted three times between the snapshots, each time by the owner's own Wi-Fi watchdog after a Wi-Fi loss (06:06Z, 06:54Z, 08:10Z), and never inside the final window. Earlier windows ran on code that the review, and then the evidence, changed; their raw records were collected again and describe only the code below.

**What ran.** The stack ran the code deployed at `ce09074`:

- the patched API image `ea5e60e2`, built on the workstation's Colima VM from `281ee68` with patch series `1b7eed63` (patch 0010 carries the enhanced route, the screenshot and action hooks and the owner tag); no later change touched a patch, so it was not rebuilt;
- the retrieval, gateway, MCP and browser-worker images `9c92d952`, `55a69dfa`, `d97a3198` and `6e3dd027`, built on the Pi from `b825e57`;
- the budget policy `5480507c` (twelve rate cards, the enhanced category at zero), the egress policy `552f3fae` and the capability manifest `5bed3fab`; the core with a 384 MiB heap ceiling per child inside a 2,560 MiB cap.

**Artifacts.**

- **Checks:** `verification.json`, written by `scripts/m7/verify.mjs` at `99333b8`: 28 checks, each recomputed from the raw transcripts in `raw/`, every record with `code_dirty=false`. 26 PASS; E05 (the live enhanced request) is BLOCKED_CREDENTIAL; X04 FAILS (section 5).
  - the fixture evidence is `raw/e2e-fixture.txt`, the live evidence `raw/e2e-live.txt`;
  - `raw/reboot.txt` is the close's reboot record, `raw/reboot-early.txt` the record made at 06:59Z while the journal still held the BEFORE boot, and `raw/reboot-0811-partial.txt` what survives of the record that tied the third reboot (section 5);
  - `raw/pi-init-m7.txt` and `raw/pi-up-m7.txt` are bring-up transcripts; no check reads them.
- **Lockfile:** `deploy/versions.lock.json`, resolved from this window by `scripts/m7/build-lock.mjs`.
- **Review:** `review/REVIEW.md`, the `/review-2` report of record (two agents, both on Opus 5.5): its 26 findings (15 warnings, 11 suggestions, no critical) are all fixed with their commits; M5's carried S1 is fixed; fourteen more found during M7 are F1–F14, twelve fixed, F10 and F13 deferred to M8.
- **BEFORE/AFTER:** `snapshot-before.txt`, `snapshot-after.txt` and the attributed diff `snapshot-diff.txt`, written by X04.
- **Redaction:** X05's 23 rules fire on their controls; it compares the SHA-256 of 35 live secrets (the webhook signing secret, the fixture enhanced provider's key, 19 client token files) against 741 files, with 0 findings. No M7 file carries the Pi's LAN address, network or SSH target.

## 1. One enhanced dispatch per page, inside the page's budget (E01–E04)

A direct 403 or 200 challenge with no residential route goes to one enhanced dispatch; a script shell goes direct HTTP, direct browser, then the enhanced browser request; a request for the enhanced tier alone makes one dispatch; the full waterfall is direct, residential, enhanced, within four attempts. No acquisition passed four attempts (67 acquisitions, 17 dispatch lines, 17 provider requests). The provider's own failures stay its own: a ban (520) is BLOCKED_PUBLIC_CONTENT and released free, a request with no answer is ENHANCED_UNCERTAIN and stays reserved, a 429 and a refused key are released free; the target's 404, 401 and 429 are the target's, the 429 cooling the domain for 30 s. With the production selection (Zyte, no key, paid dispatch off) the tier is refused before any request; fifteen racing reservations against the small fixture cap were all granted within it; the breaker opens after three counted failures, and direct and MCP scrapes go on.

## 2. Screenshots, actions and artifacts (B01–B04)

Screenshots are 1280 × 800 for the viewport and the page's height for a full page, the 25,000 px page clipped at 20,000 and marked truncated. Each capture is an artifact served to its principal alone (another principal's token gets the same 404 as an unknown id; past retention, 410). The action subset runs in order; a same-host click's document is counted against the domain, an off-host click fails as ACTION_FAILED, and everything outside the subset is refused before any work. Two incompressible captures of 7,521,127 bytes together were stored whole, a capture over the 8 MiB bound was refused as RESOURCE_LIMIT, and the core ran the whole window without a restart. A render past its deadline or with its browser killed leaves no Chromium process behind.

## 3. Cache, change detection and webhooks (C01–C03, W01–W02)

A scrape asked for the cache is stored and served as a hit only to the same principal and request within maxAge, with no attempt and no provider request; a plain scrape, other options, another principal, error pages and an expired entry are misses. The parse cache is scoped to the owner tag (M5's S1): a scan-only PDF is a hit for its principal and a fresh parse for another. Change detection reports new, same and changed with a diff; an error page and a challenge are NOT_COMPARED and replace nothing. Webhooks are delivered signed, retried to a third attempt, dead after five, refused for an unapproved destination, and held PENDING with no attempt while suppressed, then delivered when delivery is enabled again.

## 4. Zero Cloud attempts and host posture (X01–X03, X05, M01, L02)

Across the window the guard accepted 20 web connections, the live public sample's, and no proxy-port connection; the core's 27 saved logs classify every Cloud line; the retrieval logs' 178 lines name no Cloud host and carry no credential, signature or key. Every service peaked within its cap (the core at 0.762 of its 2,560 MiB), with at least 4,707 MiB available on the host. The public sample, run through the production selection the live phase set and recorded, was usable on 16 of 20 pages, direct HTTP being the only tier this deployment may use now: two pages are too short to count, and g2.com is refused before any attempt because its route learned to need the residential proxy.

## 5. What remains

- **E05 is BLOCKED_CREDENTIAL.** It needs a Zyte API key, an approved daily and monthly `enhanced` cap and paid dispatch for that run (register entry B5); none exists, and none may be inferred (CLAUDE.md §11). The live phase checked for them and made no request.
- **X04 fails, on evidence the session did not keep.** Every line that differs between the snapshots is attributed except six the third reboot made (avahi's two ephemeral UDP ports and the binfmt_misc automount). That reboot, at 08:10Z, was recorded twice as the watchdog's after a Wi-Fi loss, and a window's X04 passed on it. Neither full record was kept, and the journal, capped at 32 MiB, rotated its detail out; `raw/reboot-0811-partial.txt` holds what survives. No unrelated state is known to have changed. Durable reboot records are F13, deferred to M8.
- **The Wi-Fi losses (F10) go to M8.** Three losses ended in the watchdog's reboot. The last shows an inactivity disassociation and ten minutes of failed re-association on a DFS channel under the WORLD regulatory domain. The access point, the regulatory domain and the watchdog are the owner's; host stability over a long run is M8's.
- **M4's F1 stays with M8.** A 614 KB page aborted the core's API child at the 256 MiB heap. M7 raised the ceiling to 384 MiB (F11); M8's soak re-measures that threshold.
