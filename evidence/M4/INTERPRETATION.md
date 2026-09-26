# M4 interpretation — modern stateless MCP and tested compatibility

Evidence window 2026-09-26 15:14:08Z (BEFORE snapshot) to 18:04:01Z (AFTER snapshot), across one unplanned power-on reset at about 17:30Z (section 7). The final live runs ran on the boot after it, inside one guard-counter window, 17:58:49Z to 18:03:23Z, with the guard's table the same (handle 12) at both ends. The stack ran the code deployed at `e70e4ad`, with the MCP service on image `852d8293` and the access gateway on `a811a0b2`, both built on the Pi from `4fa7121`. Upstream `firecrawl/firecrawl` `7666c1f9ae8720a6bba271e0f60b6a217f8a5210` runs with M2's patch series.

- **Checks:** `verification.json`, written by `scripts/m4/verify.mjs` (27 checks), each recomputed from the raw transcripts in `raw/`. Every record names commit `db7e787`, which records M4 in the status register, with `code_dirty=false`. After the deployed `e70e4ad`, only the lock (`3ee8f00`) and the documents changed. G01 requires every deployed commit a record names, and each image's build commit, to match that commit's code.
- **Lockfile:** `deploy/versions.lock.json`, resolved from this evidence by `scripts/m4/build-lock.mjs`: both images, the MCP service's 17 locked packages, the SDK at 2.1.0 as D5 selects it, both protocol revisions as observed, and the capability manifest `717b7c77`.
- **Review:** `review/REVIEW.md`, the `/review-2` report of record (two agents, both on Opus 5.5). Its 23 findings are all fixed with their commits. Eight more found during M4 are recorded as F1–F8, each with an outcome.
- **BEFORE/AFTER:** `snapshot-before.txt`, `snapshot-after.txt` and the attributed diff `snapshot-diff.txt`, written by X04.
- **Redaction:** X05's 23 rules fire on their controls. It then compares the SHA-256 of 19 live secrets (10 of them client token files on the Pi) against 572 tracked and new files, with 0 findings. The Pi's LAN address, SSH target, tailnet names and Wi-Fi network appear only as placeholders such as `<pi-lan-address>`, `<pi-tailnet-name-host>` and `<wifi-ssid>`.

**State: ACCEPTED.** Every M4 acceptance criterion holds with evidence. 27 of 27 checks pass on the final window, 0 changes to unrelated host state remain unexplained, and what the reset put in doubt is re-established (H01).

## 1. The architecture chosen, and why

- **Its own service.** `/mcp` lives in a separate `mcp-gateway` container on an internal network, `fcpi_mcp`, whose only other member is the access gateway. Spec §7.1 lists MCP as a service that restarts and fails independently of REST. Two M4 tests need that: an MCP restart between crawl and status, and REST serving with MCP stopped. Neither could pass if MCP shared the REST process.
- **Behind the REST gateway.** The access gateway fronts `/mcp`, so Host and Origin checks, bearer authentication, the failure budget and the 1 MiB body cap all run before a byte reaches MCP (spec §17.2).
- **A client of REST, not a second boundary.** The MCP service calls the REST gateway with the caller's own token (spec §20.1). Scopes, limits, receipts and owner binding are therefore enforced once, at the REST boundary. MCP holds no database, no registry and no authority of its own.
- **Tools derived from the manifest.** Tool schemas come from `deploy/policies/capabilities.json`, whose `mcp` section names each tool's route and annotations. Search and extract are listed as omitted until their routes are served.
- **The official SDK's stateless factory.** `createMcpHandler` with `legacy: 'stateless'`, mounted through `toNodeHandler`, builds a fresh `McpServer` for every request. There is no session generator, event store or session map (K01).

## 2. Both protocol eras on the wire

- **2026-07-28 (P01):** an explicitly pinned SDK client made 17 exchanges, all POST: `server/discover`, `tools/list` and real `tools/call` scrape, crawl and status calls, with no initialize. None of 35 raw answers carries a session header, and the crawl's receipt ends SUCCEEDED.
- **2025-11-25 (P06):** a raw initialize and the SDK's 2025-era client both negotiated 2025-11-25, over 15 exchanges and 12 legacy tool calls, through the SDK's stateless compatibility.
- **Malformed modern requests (P02):** 9 cases (missing, malformed or mismatched headers and bodies) are refused with JSON-RPC errors. None reached the server factory, and none was downgraded; the control reached it on the modern leg.
- **JSON and request-scoped SSE (P03):** a plain call answers `application/json`, and a call with a progress token streams `notifications/progress` then its result, locally and over the tailnet.
- **Cancellation (P04):** a modern request's abort reaches the gateway as 499, and a cancelled crawl ends CANCELLED with no slow page started after the cancel. A 2025-era cancel notification cannot reach a stateless request (F3, rejected with evidence).
- **Deterministic catalog (P05):** 10 tools, with the same SHA-256 on every listing.
- **Real clients (R01):** Claude Code 2.1.283 on Haiku 4.5 spoke 2026-07-28. Codex CLI 0.157.1 on gpt-6-luna negotiated 2025-06-18, which the SDK's stateless compatibility serves. Each, configured from `deploy/clients/` with a token scoped to read, scrape and crawl over the tailnet, scraped the fixture's sentinel and started a crawl that finished SUCCEEDED with both pages archived. Neither sent a session header. These are actual target-client results, kept apart from the SDK fixtures. A hosted ChatGPT connector was not tested; hosted access stays conditional at M9.

## 3. Authorization, Host and Origin

- **Refused before MCP (A01):** a missing, unknown or Basic-scheme token gets 401, a foreign Host 421, a foreign or null Origin 403, and an oversized body 413. The MCP service logged none of the 7 refused requests, so each was refused before it.
- **Spoofed identity headers (A01):** a client's own `x-fcpi-*` headers are replaced by the validated identity. A read-only token's scrape comes back as the gateway's 403 INSUFFICIENT_SCOPE, as a tool error, while its read works. No answer carries `Access-Control-Allow-Origin` (38 checked).
- **Owner isolation (P07):** two independent clients with different principals overlapped for 81 ms. Another principal's job answers 404, identical to an unknown id.
- **Network posture (X03):** `fcpi_mcp` is internal and isolated, with no IPv6, and the only publication is the gateway's `127.0.0.1:3380`.
- **The MCP service's reach (X01):** it has no default route and resolves no name, so it reaches only the gateway.

## 4. Job handles across restart and reconnect

- **New TCP connection (P08):** each of 6 status calls for one crawl ran on its own connection, and the crawl completed.
- **MCP restart (P09):** a crawl started on MCP instance `8dad731b` was read to completion on instance `eeeb2e8f`, after a restart between the two. An SDK client carried across the restart also completed.

## 5. REST independence

- **REST keeps serving (P10):** with the MCP container stopped, `/mcp` answers 503 MCP_UNAVAILABLE in 2.2 s, and a REST crawl runs to completion.
- **Payload bound (A02):** a page over the 256 KiB tool bound returns 261,649 bytes, with the cut field marked, and 46,340 bytes cut.
- **Observability (O01):** the MCP service's own log records every exchange, serve and tool call with revision, method, validated client and principal, and outcome. No token, target URL or content pattern appears, and every tool call matches a gateway record.
- **No Cloud (X01):** across the window, the guard accepted 0 web connections from the egress bridge, and every core instance's saved log classifies each Cloud line.

## 6. Resources

- **Samples (M01):** 14 samples cover every phase and both deliberate MCP restarts. The highest peaks are MCP 55.6 MiB of 192, gateway 36.6 MiB of 160 and core 1,822 MiB of 2,304. No cgroup records an OOM kill, and every swap limit is 0 at the end.
- **The MCP memory envelope (M02):** four concurrent reads at the 4 MiB answer cap peak at 131.5 MiB, under 80% of the 192 MiB cap, with a 96 MiB heap ceiling. The first measurement, at the old 8 MiB cap, is the one OOM kill of this milestone: at 16:28:22Z a throwaway probe container was killed inside its own 512 MiB cgroup. That measurement led to W4's fixes. The reset in section 7 set the host's OOM-kill counter back to 0, so M01 reads 0 on this boot.

## 7. The unplanned reset

- **What happened (F7, `raw/reboot.txt`):** at 17:22:19Z, during the SDK phase, the Pi's Wi-Fi disconnected on its own side, and its scans stopped finding the access point, which stayed up for the workstation. At 17:28:49Z the Wi-Fi chip's SDIO bus went down, and its driver was reloaded. The journal ends at 17:29:45Z with no shutdown sequence. The next boot, at 17:30:50Z, came up on kernel 6.18.50, which the owner's upgrade had staged (F4). The firmware's reset register reads 0x1000, the power-on reset. There was no sudo command, login or session after the loss, and no undervoltage in either boot's kernel log. Whether power was interrupted is a physical fact these records cannot settle.
- **Recovery through the gated start:** the data check passed, the guard loaded, dockerd and `fcpi-stack` came up, and all 11 containers were healthy with no restart.
- **Data after the unclean stop (`raw/after-reset.txt`):**
  - PostgreSQL's WAL redo completed in 0.19 s.
  - M3's sentinel reads back from PostgreSQL, Redis and RabbitMQ.
  - Both crawls admitted in the broken window finished SUCCEEDED, and no job in the ledger is open.
  - All 347 archive files match their names, and all 286 live documents have their file.
- **Log files cut by the power loss:** the power loss left one NUL-damaged line in PostgreSQL's container log, and `docker logs` silently skips what follows it. The final window recreated every container before any log scan, so every scan read a log written after the reset.
- **D2 and Chromium on the new kernel (F4):** the kernel keeps 16 KiB pages. M2's Chromium checks B01–B07 pass on it, recorded beside M2's accepted evidence in `evidence/M2/kernel-6.18.50/`. The proof's stray-process count now leaves out the running worker's own processes; M2's recorded proof still reads 0.
- **The gap it exposed (F8):** at boot, dockerd's drop-in ran `fcpi-egress-local.sh` before Wi-Fi was up. It exited, and the containers started for 7 s with the guard's local-network set empty. The script now fills the set from the networks it last recorded. That is proven in a throwaway network namespace, before installation (exit 1, empty set) and after, and the host's set matches the file.
- **The snapshots (X04):** BEFORE and AFTER are on different boots. X04 accepts that only because the reboot record ties BEFORE's boot to the journal's previous boot and AFTER's to the current one. It then attributes the reset's own 24 changed lines narrowly:
  - modules rebuilt for the new kernel;
  - mounts with only their options changed;
  - avahi's ephemeral ports;
  - M1's runtime-only audit tables;
  - polkit, which is not enabled at boot.

  Without the record, X04 fails. An enabled unit that stopped stays unexplained, as a negative control showed.
- **The window re-run:** SDK, cancel, restart and stopped phases and the memory probe had failed for want of the host. The whole window then ran again on the new boot, from a fresh bring-up.
- **H01:** the check requires all of the above.

## 8. Deferred findings

- **F1, to M8:** a 614 KB page aborts the core's API process at its 256 MiB heap cap, while 400 KiB passes. The MCP retry path is closed (W9); the heap budget is M8's resource work.
- **F2, to M8:** a systemd reload lifts every container's swap limit until the container is recreated. M4's bring-up recreates every container, and M01 and H01 require every limit at 0; keeping the limits across reloads is host lifecycle, M8's Scope.

Nothing is deferred to M5.

## 9. Deviations, and what re-collection found

- **Review:** two agents on Opus 5.5, at the owner's request with the orchestrator's own pass beside them.
- **Held live steps:** the real-client runs used the owner's model accounts, as the owner approved for M4 (Claude Code on Haiku, Codex on gpt-6-luna), and ran only after `/address`.
- **Found while collecting:**
  - Codex refused the crawl because nothing granted it the prompt's tools (F5).
  - S12's fix held serving instances in a module-level map, which K01 refused (F6).
  - The reset (F7), which exposed F8.
- **The owner's work on the Pi during the window:** an `apt upgrade`. It staged kernel 6.18.50 (F4), and its systemd reloads lifted the swap limits (F2); the snapshot diff attributes it through `raw/owner-session.txt`.
- **A benign race in the stack record:** a PostgreSQL backend that exited mid-read left one empty line in the process-ELF section. No M4 check reads that section.
