# M8 interpretation — operations, resource stability, recovery and restore

**Evidence window.** The BEFORE snapshot was taken at 2026-09-27T23:12:44Z and the AFTER snapshot at 2026-10-02T23:01:01Z. The final window (window 5) started at 2026-10-01T21:55:05Z with `6366dd8` deployed:

- the fault run, 21:55:41Z to 22:27:34Z: 22 cases and the driven reboot at 22:26Z. `scripts/m8/window.sh` lets the soak start only when the fault run can pass, and it passed;
- the heap probe at 22:27:34Z, the fixture backup and its isolated restore test at 22:28:57Z, and the live proofs at 22:34:33Z: the off-device backup and restore, the ntfy notice and the VPS watchdog;
- the upgrade and rollback rehearsal at 22:50:05Z and the read-only plans at 22:53:04Z;
- the 24-hour paced soak, from 2026-10-01T22:53:57Z to 2026-10-02T22:53:57Z, then the collection and the close, 22:55:50Z to 23:01:11Z.

The Pi did not reboot during the soak. A tracked background task on the workstation stops after two hours. Once the soak had started, the window's remaining lines (the wait, the collection and the close, taken from `scripts/m8/window.sh` at `6366dd8` and identical by diff) therefore ran detached from 22:54:44Z. `work/window-24h.log` and `work/window-24h-finish.log` are the window's log.

**What ran.** The fifteen services all run under `fcpi.slice`:
- the retrieval image `0a087bd8890f` and the gateway image `a9fae8d26ce9`, both built on the Pi from `72ad844`;
- the browser worker `f05d6bc2e18c`, built from `dc11b35`;
- M7's patched API and MCP images;
- restic `0.18.0-1+b4`, the one host package M8 adds.

G01 ties every record to `6366dd8` and finds each image's source unchanged to HEAD. G02 runs the suites inside the running images: retrieval 183/183, ledger 6/6, gateway-m7 40/40, MCP 43/43, gateway unit 30/30, M3 contract 43/43, and 44 ops scripts parsed. The verifier ran at `286bb54` with no uncommitted code: 45 of 47 checks PASS, and B00 and X04 FAIL (§9). `deploy/versions.lock.json` was resolved from this window (`e6d53ad`).

**Earlier windows.** Four earlier windows and a pre-flight ran on code that their own evidence then changed. Each is kept as it was, in `window-1/` to `window-4/` and `preflight-5/`; REVIEW.md's F15–F30 give what each found and its fix.
- Window 1, verified at `e5064b2`: 39 PASS, 8 FAIL (F19–F21).
- Window 2, verified at `a8e4433`: 42 PASS, 5 FAIL. I07, S01 and S02 failed (F23–F25), and the watchdog defect F22 was found as the window started.
- Window 3, at `d7ab53f`, was stopped after a power cut (F27, F28).
- Window 4, at `63d2b04`, was stopped after its fault run failed on that cut's damage to the docker logs (F29).
- The pre-flight, at `66ac385` (38 PASS, 7 FAIL, 2 NOT_RUN, each expected for a 30-minute soak), went through a second power cut, which led to F30.

`window-3/` and `window-4/` are copies of `evidence/M8/` as it stood when each window stopped. Both windows stopped before they wrote their own soak and close records, so every file in their `raw/` that is byte-identical to `window-2/raw/` is window 2's, left in place: `soak.txt`, `stack.txt`, `status.json`, `suites.txt` and the other close records. Window 3 kept no soak record of its own: its own files are the fault run, heap, backups, live proofs, rehearsal and plans, and F27 gives what its stopped soak showed. Window 4's is `window-4/raw/soak-partial.txt`.

## 1. Host operations (H01–H04, X02)

**Swap and memory.** Every project container runs under `fcpi.slice`, which sets `MemorySwapMax=0`; systemd re-asserts it at every reload, closing M4's F2. The slice also sets `MemoryHigh` to 5,632 MiB: the measured 8,062 MiB `MemTotal`, less spec §22's 1 GiB reserve and about 1,100 MiB for the host's own services. H02 recreates a container across a reload, and its scope stays at 0. X02 requires the slice's 0 above all fifteen services and reports six fixture scopes whose own limit was lifted. That is the case the slice exists for: F9 records that no single systemd action reproduced the lift.

**Containers and boot records.**
- H03 starts a container outside the project. `fcpi status` reports it and a notice opens; it clears when the container is gone (M1 R12).
- H04 finds fourteen boot records, among them one for each of the seven boots it requires one for. Each record was written at its own boot, while the journal still held the boot that had ended. This closes M7's F13.

**Tooling.** H01 finds the units, timers, slice, `/usr/local/bin/fcpi` and restic installed, and `fcpi verify ops` passes at `6366dd8`. The host tooling is bash, jq and curl, so no runtime is added to the host. The tick writes `/run/firecrawl-pi/admission/admission.json` on tmpfs. The gateway refuses new work with 503 `HOST_PRESSURE` while dispatch is paused, and the retrieval service refuses the browser tier while browser work is paused. An admission file older than 180 s is ignored and reported, so a stuck tick fails open rather than freezing admission.

## 2. Startup and reboot (R01–R03)

- **Driven reboot.** SSH came back after 56 s and the stack was ready 46 s after boot, well inside spec §24's five minutes, with no SSH action needed.
- **Docker restart.** The stack was ready after 15 s, and a crawl begun before the restart completed 12 of 12 pages.
- **Missing data mount.** With the data mount reported missing, dockerd refused to start (exit 1, three restarts) and no shadow entry appeared on the root filesystem. With the mount back, the stack was ready after 1 s and the data ID was unchanged.

## 3. The failure matrix (I01–I15)

**Process and data-service failures.**
- **MCP crash.** MCP came back alone after 5 s, and an existing job handle answered 200 (I01).
- **API child crash.** REST answered a typed 503 `UPSTREAM_UNAVAILABLE` and was ready again after 21 s (I02).
- **Worker death.** Status showed the worker down with the API up, as degraded rather than failed, and it recovered after 129 s (I03).
- **PostgreSQL down.** New durable work failed closed with 503 `PLATFORM_UNAVAILABLE`, and the job reconciled afterwards (I04).
- **Redis down.** A submission answered `SUBMISSION_UNCERTAIN` with its receipt, rather than a blind resubmission (I05).
- **RabbitMQ down.** Work was accepted and completed once the broker returned (I06).

**The browser (I07).** Chromium was killed as a render started (six processes). The answer was typed `BROWSER_CRASHED`, every permit was released, and the next render was served after 4 s. Before `784d342` the same kill left the worker busy for good (F23).

**Optional providers and the network.**
- **Search outage.** 503 `SEARCH_BACKEND_UNAVAILABLE` within 2 s, and an intentionally stopped SearXNG stayed stopped (I08).
- **Proxy outage.** Protected bulk work ended `PROXY_REQUIRED` and never left through the home IP (I09).
- **Model, parser and enhanced outage.** Each failed alone: an extract answered `PROVIDER_UNREACHABLE` while scraping still served (I10).
- **Network outage.** A public scrape failed typed as `DNS_FAILURE`, and the route recovered without a restart (I11).

**Host pressure.**
- **Disk.** New work was refused 503 `HOST_PRESSURE` (disk), and nothing was deleted (I12).
- **Memory.** At 671 MiB available, new work was refused 503 `HOST_PRESSURE` (memory), and nothing of the project was OOM-killed (I13).
- **Thermal.** Only browser work paused (`RESOURCE_BUSY`), and it was seen resuming (I14).

**The supervisor (I15).** It restarted a hung service three times without a notice, then opened one incident at the fourth hang. O01 names each of these failures separately in `fcpi status`.

## 4. The soak and resources (S01–S05, O04)

**The soak (S01).** Over 24.0 h there were 1,390 minute samples and no missed minute.
- **Requests.** 4,486 of 4,488 paced requests succeeded, across fifteen classes: static, status, JS, MCP list and scrape, search, PDF, map, extract, crawl, screenshot, batch and change detection. The two failures (static and status, at 07:31:57Z) fell inside the nightly backup's designed pause, which S01 places from the backup run's own start and end (F25).
- **Health.** There was no OOM kill and no throttle flag. The oldest queued job never waited, and the host never had less than 4,822 MiB available.
- **Latency (p95).** Static 104 ms, JS 1,794 ms, status 22 ms, MCP list 18 ms.
- **Log damage.** The one damaged log, `samples/2026-10-01.jsonl`, has 3,537 NUL bytes from window 3's power cut, and no line was dropped reading it.

**Memory and the card (S02, S03).**
- **Memory (S02).** Every service stayed under 90 % of its cap; the core peaked highest, at 76 %. The project peaked at 3,409 MiB under the slice's 5,632 MiB. Spec §22's measured column equals these figures.
- **PostgreSQL's writes (S03).** The writer settings were measured for an hour each on the same paced workload. Under nuq.sql's server-class settings (A) PostgreSQL wrote 72.1 MiB/h to the card with 1,822 WAL flushes/h; under the kept settings (B) it wrote 65.2 MiB/h with 1,715 flushes/h. This closes M1's R15. WAL bytes are reported, not judged: these settings decide when WAL is flushed, not how much is generated (F8). The nightly REINDEX writes under 1 MB, so it is kept.
- **The project's total card writes.** In a boot's first 70 minutes the project wrote about 345 MB/h, mostly journald, containerd and dockerd health-check state (F7). That is the storage evidence spec §21.1 asks for.

**Redis, heap and the gateway.**
- **Redis (S04).** The core's Redis user is narrowed to the command set the build can issue, a union covering the 29 commands measured under load (M1 R11).
- **The core's heap (S05).** 225.8 MiB at rest. Pages of 400 KiB to 2,048 KiB each answered 200 with the heap unchanged, under the 384 MiB ceiling, closing M4's F1.
- **The gateway (O04).** It answered 4,536 requests over the window, none with 502.

## 5. Notices and observability (O01–O03, N01, N02)

- **Notices.** Incidents notify the owner's phone through the hosted ntfy.sh, on a private 64-hex topic held in the owner's login keychain, with no account, payment or mail credential. Each incident sends one notice when it opens and one when it clears (O02). N01 injected a temperature incident (`915cba86`): one opened and one cleared notice, each delivered once and both listed on ntfy's server. The owner confirmed receipt of the proof notices on the phone on 2026-09-28.
- **The external watchdog.** The owner's VPS watches the Pi's heartbeat for failures the Pi cannot report itself. N02 stopped the heartbeat at 22:39:38Z: the incident opened at 22:44:53Z with one urgent notice and cleared after the heartbeat returned at 22:47:55Z, with the fix for F22 in force.
- **Logs (O03).** No container log is over its bound, and the operations logs total 69.5 MB. `fcpi doctor`'s bundle is 105 KB in 47 files, with no secret found and its planted-secret self-test refused.

## 6. Backup and tested restore (K01–K03)

**Design.** Nightly restic backups quiesce only PostgreSQL, Redis and RabbitMQ, copying their data to staging on the data filesystem. Content-addressed artifacts are backed up live after the stack resumes. Secrets reach restic on stdin and are never staged in plaintext.

**Restore test.** It turns the restored Compose file into project `fcpi-restore`: every network internal and renamed, no ports, no egress, webhooks suppressed, paid dispatch off.

**Results.**
- **Fixture backup and restore (K01, K02).** K01's backup quiesced for 52 s, and K02's isolated restore passed every check in 74 s.
- **Off-device backup (K03).** The repository is on the owner's VPS, in an SFTP-only, chrooted account reached with the Pi's own key and a pinned host key. It holds two keys: the Pi's, and the owner's recovery key kept in the owner's macOS login keychain. The backup to it passed, and so did `fcpi restore-test` from it. B6 is cleared.

## 7. Upgrade and rollback (U01, U02)

**The rehearsal (U01).** It ran in isolation:
- a candidate configuration, and its revert;
- a candidate image that failed, and its rollback;
- a schema migration, its v4 refusal by the old code, and the restore to v3.

**The read-only plans (U02).** The upgrade plan from `6366dd8` to `19f047f` lists three changes, none of them schema-sensitive, and the rollback plan to `60945a7` needs no state restore.

**RabbitMQ.** It stays on 4.3.6: no 4.4 GA existed when checked on 2026-09-28 (D3). Community support for 4.3 ends on 2026-11-30.

## 8. Posture (X01, X02, X05, L03, V01)

- **No Cloud attempts (X01).** Zero Firecrawl Cloud attempts: the guard's web-accepted and proxy-port counters did not move, and the core's logs were read (35 lines).
- **Network and container posture (X02).** One loopback publication, the gateway's at `127.0.0.1:3380`; fifteen cgroups under the slice.
- **Redaction (X05).** The scan compared 1,137 files with 40 live secret hashes, every positive control fired, and nothing was found. No M8 file holds the LAN address, the network, the SSH target or the VPS address.
- **The lock (L03).** It agrees with the running images.
- **The review record (V01).** It gives every finding an outcome.

## 9. B00 and X04

**B00.** M7's AFTER snapshot and M8's BEFORE snapshot are on different boots. The reboot between them happened before M8 existed, and the journal rotated it out before M8 could keep a record (F5's journal churn). Six lines that change at every boot therefore cannot be tied to it: two avahi listeners on ephemeral UDP ports removed and two added, and the binfmt_misc automount's pipe inode changed. Every other line is attributed. The check is not weakened, and the gap is recorded as an honest FAIL.

**X04.** It compares BEFORE with AFTER and attributes 135 lines to the project and the collector's own SSH sessions. It leaves twelve unexplained, none of them the project's:

- **Six from the owner's PiHost tooling.** It was installed outside the project on 2026-10-01, between windows 3 and 4. Mosquitto moved its open listener from `0.0.0.0:1883` to `127.0.0.1:1883` and added remote listeners on 1884 (IPv4 and IPv6) and 9001 (IPv6), following PiHost's design of open on localhost and a password for remote clients; `pihost-backup.timer` was enabled. PiHost also replaced the Wi-Fi watchdog with its netwatch, set journald to 256 MiB and added a nightly backup at 06:45 UTC; these leave no snapshot line.
- **Six that change at every boot.** Avahi's ephemeral UDP ports and the binfmt_misc automount's pipe inode. X04 attributes such lines only when every boot between the snapshots was an orderly watchdog reboot or the driven reboot. This window's chain also includes the owner's restart at the Pi (2026-09-29T17:37Z, after six minutes of total Wi-Fi loss) and two power cuts (2026-10-01T04:42Z, a failing plug since replaced; about 21:05Z, an extension cable since fixed), which leave no orderly shutdown to tie.

**Why the checks are not changed.** Attributing PiHost's lines would mean changing the verifier or the owner-session collector. Both live under `scripts/`, and G01 requires those paths to be unchanged since the deployed commit, so the change would invalidate the window it explains.

**The guard.** X04's guard checks pass: no rule has changed since M7, the installed guard is the repository's, and the ruleset is tied to AFTER.

**Other host changes in the window.** These came from outside the project's files:
- **The Wi-Fi band (owner-approved).** On 2026-10-01 at about 01:58Z the Pi's one Wi-Fi connection was set to 2.4 GHz (`802-11-wireless.band=bg`). On 5 GHz channel 100, at -76 dBm, it had lost 10–63 % of packets, the cause behind M7's F10 and the 2026-09-29 outage. It now runs at about -60 dBm with no loss. To revert, set the band to empty and bring the connection up again.
- **Journal churn.** The owner's ChatGPT/Codex remote-SSH helper opens about three SSH sessions a minute, which fills the journal (F5). It is the owner's to change, and the boot record makes the project independent of it.

## 10. What remains

- **M9's entry gate.** It needs M5's E05 and D03, M6's L01 and L02 and M7's E05 run live. Each waits on the owner's input (B3, B4, B5) and needs a live run, not code.
- **What M9 takes on.**
  - F13: the M1, M3, M6 and M7 tools that still read the core's Redis URL in its M1 shape.
  - The two owner-requested additions its Scope names, whose requirements are in `work/M9-ONBOARDING-REQUIREMENT.md` and `work/M9-INCIDENT-AGENT-REQUIREMENT.md`.
- **RabbitMQ 4.3.** Its community support ends on 2026-11-30. Moving to 4.4 waits on a 4.4 GA; the check is due before that date.
- **Pushing main.** The remote holds the M8 checkpoint branch `m8-pre-evidence-checkpoint` at `72ad844`, scanned in full history (`work/prepush/`); `main` was last pushed at M4. Before `main` is pushed, the commits after `72ad844` need the same scan: `node evidence/M8/work/prepush/history-scan.mjs "$PWD" 72ad844 HEAD`, run after the evidence is committed.
