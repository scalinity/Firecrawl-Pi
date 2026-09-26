# M3 interpretation — authorized REST, durable jobs and agent access

Evidence window 2026-09-26 08:21:36Z (BEFORE snapshot) to 13:08:18Z (AFTER snapshot), on one boot. The final live runs ran inside one guard-counter window, 12:51:31Z to 13:08:02Z, with the guard's table the same (handle 42) at both ends. The stack ran the code deployed at `5c4dbb4`, with the access gateway on image `5d814709`, built on the Pi from `2d0bb60`. Upstream `firecrawl/firecrawl` `7666c1f9ae8720a6bba271e0f60b6a217f8a5210` runs with M2's patch series (result tree `1b98286b`).

- **Checks:** `verification.json`, written by `scripts/m3/verify.mjs` (33 checks), each recomputed from the raw transcripts in `raw/`. Every record names commit `4405e0b`, which records M3 in the status register, with `code_dirty=false`; after the deployed `5c4dbb4`, only the lock (`5665c16`) and the documents changed. G01 requires every deployed commit a record names, and the image's build commit, to match that commit's code.
- **Lockfile:** `deploy/versions.lock.json`, resolved from this evidence by `scripts/m3/build-lock.mjs`: the gateway image, its 14 locked packages, the capability manifest `ccd319b0`, the platform schema and the pinned official client `@mendable/firecrawl-js@4.31.1`.
- **Review:** `review/REVIEW.md`, the `/review-2` report of record (three agents, all on Opus 5.5). It holds 53 findings, all fixed with their commits, and M1's R9, carried over and fixed.
- **BEFORE/AFTER:** `snapshot-before.txt`, `snapshot-after.txt` and the attributed diff `snapshot-diff.txt`, written by X04.
- **Redaction:** X05's 23 rules fire on their controls. It then compares the SHA-256 of 14 live secrets (nine fixed, every client token file on the Pi) against 498 tracked and new files, with 0 findings. The Pi's LAN address, SSH target, tailnet names and tailnet addresses appear only as `<pi-lan-address>`, `<pi-ssh-target>`, `<pi-tailnet-name-host>`, `<tailnet-address>` and the like.

**State: ACCEPTED.** Every M3 acceptance criterion holds with evidence. 33 of 33 checks pass on the final window, and 0 changes to unrelated host state remain unexplained.

## 1. The gateway contract

The capability manifest (`deploy/policies/capabilities.json`) is the one statement of the REST subset. The gateway validates every request against it, and `fcpi` and the client build their URLs from it.
- **Routes:** ten native routes are served, and twelve are declared not enabled, answered 501 with the reason.
- **Upstream shapes (R01):** each served route is registered at the pin with its shape, and so is each not-enabled one, all recomputed from the raw registrations.
- **The pinned client:** every call it makes on a served route's family is served or declared.
- **Options (A05):** 18 unsupported options get 400 UNSUPPORTED_OPTION, naming the option, before any work: retrieval attempts 962→962, receipts 106→106, 0 fixture hits. A scrape before them is the control.
- **Operations (A01):** a scrape, a map of the 12-page graph, a crawl archiving 12 documents and a batch with per-item outcomes all pass, through the gateway and through the pinned official client.

## 2. Authorization and the network boundary

- **Tokens (A03):** client tokens are stored only as hashes and compared in constant time. Missing, unknown, Basic-scheme and empty tokens get 401 with the gateway's own challenge, never a Cloud one. A read-only token gets 403 on every write.
- **Owner isolation (A03):** another principal's job answers exactly as an unknown id, with and without spoofed identity headers (N02). The owner's own list holds the job, as the control.
- **Revocation (A03):** a revoked token was refused 891 ms after revocation, with the gateway's start time unchanged.
- **Host and Origin (N01):** a foreign or rebinding Host gets 421, and a foreign or null Origin gets 403. No answer carries `Access-Control-Allow-Origin`, including the scrape and map answers forwarded from the core, whose own CORS middleware sets it.
- **Ports (N03, N04):** of 70 probes from four vantages, only the gateway's permitted paths open, and from the LAN all 19 project ports are closed, with SSH as the control. The only publication is `127.0.0.1:3380`.
- **Ledger access (N06):** the ledger's role has DML on its four tables and nothing else; it can only read the schema-version table. `pg_hba` admits only that role, and only to its database, from the platform subnet. Probed from that network, every other role is refused before authentication.
- **Limits (A04):** oversized and out-of-range requests get their exact refusals with no receipt left. Six held synchronous scrapes: four run and two get 503 with Retry-After. The unit and open-job caps refuse at 430 units and 20 jobs. Past the failure budget, unknown tokens get 429 while a valid one still works.
- **No Cloud (X01):** across the window, the guard accepted 0 web connections on the egress bridge. Every core instance's saved log classifies each Cloud line as a refusal or an echo. Both gateway containers' logs hold no Cloud host, token, Authorization value or target URL: 437 and 7 requests read, each log whole. The official client opened sockets only to the forward.

## 3. Durable receipts and the crash tests

A receipt commits before the answer, and the submission key travels in the upstream request's `origin`, so an answer lost in a crash is reconciled by marker, never resubmitted blindly.

| Test | Result |
|---|---|
| K1, core down (J01) | Acknowledged 200 with the receipt RECEIVED; submitted once when the core returned; SUCCEEDED with 3 documents. |
| K2, answer lost after the core created the job (J02) | SUBMITTING → SUBMISSION_UNCERTAIN → QUEUED by marker; one upstream job; the client's retry under its key got the same id. |
| K3, submission lost (J02) | Uncertain through the settle window (the native status answers 503 SUBMISSION_UNCERTAIN with the receipt), then submitted once; one upstream job. |
| K4 and K5, gateway or core killed mid-crawl (J03) | Both SUCCEEDED with 6 documents; K5's stalled page was retried within the attempt budget. |
| Every admitted job (J05) | 35 jobs listed from the ledger at each run's end: the 14 with an upstream id have exactly one upstream job carrying the key, read while NuQ held its rows; the 21 without have none. |

## 4. Idempotency, retention and pagination

- **Idempotency (J04):** the same key and body, even with its keys reordered, returns the same job, as two equal UUIDs. The same key with another body gets 409. Another principal gets its own job. A batch retried under its key, through the gateway and through the official client, keeps its id.
- **Pagination (A02):** a 12-page crawl read 5 at a time gives pages of 5, 5 and 2, whose `next` URLs name the private origin, the external id and advancing offsets. The cursors are upstream's native offsets, owner-bound by the principal-scoped lookup (spec §16.2).
- **Retention (J06, R9):** pg_cron's own cleaner deleted the NuQ rows, in a run that started after the expiry update. Redis's keys expired, the core was recreated, and the core answers 404. The gateway still serves every document, each hashing to its archive manifest and to the hash recorded when the job finished.
- **Persistence (X02):** after a force-recreate of all ten services, the sentinels, the ledger's rows (events and idempotency keys included), the archive and the registry are all unchanged.

## 5. Private serving

- **Tailnet (P02):** Tailscale Serve maps tailnet `:8443` to the gateway's loopback publication, with Funnel off. From the workstation over the tailnet, the Let's Encrypt certificate verifies for the machine's name (TLS 1.3). A read token gets 200 and no token 401, results name the tailnet origin, and a foreign Host gets 421.
- **Tailscale settings:** it holds the signing keyring's one key, and does not take the host's DNS, routes, an exit node or Tailscale SSH.
- **What a tailnet peer reaches:** the guard admits only `:8443` on `tailscale0`, and measured over the tailnet, none of the host's services answer (22, 53, 80, 443, 1883, 8080, 9001). tailscaled's own peer API (port 35237) answers: Tailscale's userspace network stack serves it before the host's firewall, and it is Tailscale's function, not a host service. Limiting it further would need a tailnet access policy, an optional owner step, not a gap in M3's boundary.
- **The workstation (P01):** the live runs and the official client ran on it (macOS) through an SSH forward that stayed up, and the gateway instance answering through the forward is the one the Pi's gateway container logged at its start.
- **Hosted reachability:** not configured, and recorded disabled. No account-supported hosted route was requested.

## 6. Resources

- **Samples (M01):** 19 memory samples cover every run and every point where a cgroup was about to be replaced.
- **Peaks:** the gateway's highest peak is 44 MiB of its 160 MiB cap, and the core's 1,870 MiB of 2,304.
- **Host:** its OOM-kill count stays 6 throughout, and MemAvailable stays above 5 GiB.
- **Those six earlier OOM kills** are Chromium's, killed inside the browser worker's capped cgroup at 06:57Z, before the window: M2's bound contained them. The browser's memory under load belongs to M8's resource-stability work.

## 7. Deferred findings

None. Every M3 finding is fixed with its commits, and M1's R9 is closed by M3's archive (J06).

## 8. Deviations, and what re-collection found

- **Review with three agents.** The owner approved a third agent for the changeset's size. TV1 reviewed the verification tooling, on the same model under the same read-only rules.
- **Held live step.** Tailscale Serve, whose certificate request publishes the machine name in Certificate Transparency logs, ran only after `/address` had fixed every finding.
- **Found during `/address`** (details in `review/REVIEW.md`):
  - oversized upstream answers were reported as resets;
  - M2's retrieval-role password step could log its password on error;
  - two client calls met a generic 404;
  - two bugs in the tailnet check.
- **Two collections.** The first full collection after `/address` (at `4efd86f`) found three more:
  - the ruleset record carried the node's tailnet addresses from Tailscale's rules;
  - X01's client control counted requests where the socket-level hook counts connections;
  - M01 read a gateway that K3 had already stopped as a breach.

  All three were fixed, and the whole window was collected again at `5c4dbb4`.
- **Records kept from their one-time events.** These are the Tailscale install and the host before it, and the first host initialisation. Re-running `apt-get install` would have upgraded an unpinned package.
- **M2's recorded ruleset** has two lines split by nft's stderr warning. X04's parser joins them before comparing rule by rule.
