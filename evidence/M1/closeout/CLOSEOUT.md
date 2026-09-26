# M1 close-out — review findings closed before M2

The M1 review (`evidence/M1/review/REVIEW.md`) fixed R17–R19 and assigned the other findings to owners. This close-out closes every finding whose closure does not need something a later milestone's Scope or Implementation Work supplies, and re-verifies M1 on the changed stack. M1's accepted record (everything under `evidence/M1/` except `review/` and `closeout/`) is unchanged.

The close-out ran in two windows.

1. **Window 1 (2026-09-25 23:05–23:17Z).** It closed R5, R8, R10, R11 (PostgreSQL and RabbitMQ), R13, R14 and R16. It then had its own `/review-2` (two Opus 5.5 agents; the report and every finding's outcome are in `REVIEW.md` beside this file), which found two critical defects:
   - the first R11 design was escalable, because `fcpi_core` owned tables that the superuser's cron jobs change;
   - V23's journal window read local time as UTC, so it read an empty journal.

   The review also found several weaker claims.
2. **Window 2 (23:55Z–00:16Z).** It fixed all of those and re-collected the evidence, except two controls that could not recur once their change was in place:
   - the guard-absent probe (`before_*` in `raw/guard.txt`, 23:06:30Z);
   - NetworkManager's state before its file (`before_*` in `raw/nm.txt`, 23:06:30Z).

- **Snapshots:** BEFORE `snapshot-before.txt` (23:05:29Z, before any close-out change), AFTER `snapshot-after.txt` (00:15:55Z, the last action on the Pi). One boot throughout.
- **Audit window:** 23:57:35Z–00:15:52Z.
- **Deployed commit:** window 2 redeployed after each fix, and each transcript names the commit it ran at. From `raw/restore-fcpi-stack.txt` on, the Pi runs `f4d0cae`, and later commits change only evidence and documentation.
- **Checks:** `verification.json`, from `FCPI_M1_EVIDENCE=evidence/M1/closeout/ node scripts/m1/verify.mjs`, with every result at `code_dirty: false`.
  - **27 of 27 rerun checks pass:** V01–V14, V15 (live), V16–V27. V27 checks the saved review record, `REVIEW.md` beside this file.
  - **N00–N09 were not rerun.** They prove M1's throwaway proof stack, which the close-out did not touch.
- **M1's own record reproduces unchanged.** In default mode, the changed verifier reproduces all 27 non-live M1 results byte for byte and regenerates `evidence/M1/snapshot-diff.txt` identically. It also no longer lists the close-out checks there.

## Findings closed

| Finding | Change | Evidence | Check |
|---|---|---|---|
| R5 — the access bridge had no drop rule | `inet fcpi_guard` (`deploy/host/fcpi-guard.nft`) drops and counts forwarding in and out of `fcpi-access`, and new connections from it to the host; replies pass. `pi-init.sh` checks it with `nft -c`, installs it as `/etc/firecrawl-pi/fcpi-guard.nft` (outside the deploy tree, so a rollback deploy cannot remove it) and loads it, and dockerd's ExecStartPre loads it after the data check. The gateway also names its own DNS upstream, 192.0.2.1 (below). | `raw/guard.txt`, `raw/apply-gateway-dns.txt` | V20 |
| R8 — snapshots held only a ruleset hash | `scripts/m1/snapshot.sh` appends the nftables tables and chains and the forwarding switches (`pi-snapshot-net.sh`); M0's script is unchanged | both snapshots | V14, V25 |
| R10 — the gateway suite had only run on the workstation's Node | `pi-gateway-tests-pinned-node.sh` runs it in the pinned image, with no network | `raw/gateway-tests-pinned-node.txt` | V21 |
| R11 — the core's credentials (PostgreSQL and RabbitMQ parts) | `fcpi_core` holds SELECT, INSERT, UPDATE and DELETE on NuQ's tables and owns nothing; the superuser has no password. `pi-narrow-credentials.sh` migrates; `initdb/020-fcpi-core-role.sh` covers a new data directory. The RabbitMQ user `fcpi` has no tags, existing or at first boot. | `raw/narrow-credentials.txt`, `raw/credentials.txt`, `raw/fresh-init-proof.txt` | V22, V26, V07–V10, V13 |
| R13 — the dockerd gate was observed for 60 s only | The gate collector logs a timeline of docker's and fcpi-stack's states and the job queue. Its cause was found and fixed (below). | `raw/docker-gate.txt`, `raw/docker-gate-requires.txt` | V19, V17 |
| R14 — NetworkManager handled Docker's veths | `90-fcpi-unmanaged.conf` appends `veth*`, `fcpi-*` and `docker0` to `unmanaged-devices`. `pi-init.sh` checks both the merged configuration and the live device states. | `raw/nm.txt` | V23 |
| R16 — deploy never deleted on the Pi | After hash verification, `deploy.sh` removes files the archive lacks and every empty directory, and only then records the commit. It refuses tracked paths holding a newline or a backslash. | `raw/deploy-prune.txt` | V24 |

## What the evidence shows

- **Guard (R5).**
  - With no guard, the gateway container reached:
    - the host through the bridge address (TCP 53);
    - the host's LAN sshd;
    - a public address, through the bridge's NAT.
  - With the guard loaded, all three timed out, and the drops were counted (13 forwarded, 18 inbound, including the DNS attempts below).
  - Between the probe and the gate test, 0 further drops. From the gate test's reload to the end of the window, 0.
  - The rendered bridge name is the one the guard matches, and the installed copy equals the repository file.
- **DNS past the guard (found in window 2).**
  - With the guard loaded, the gateway still resolved `example.com`. Docker's embedded resolver reached the host's loopback resolver (Pi-hole) from the host's namespace, which the guard never sees.
  - The gateway now has `dns: [192.0.2.1]`. Its resolver still answers the project's own names, and forwards other names from the container's namespace, where the guard drops them.
  - Measured: before the setting, `example.com` resolves; after it, the lookup times out.
- **Credentials (R11).**
  - The first design made `fcpi_core` the owner of NuQ's schema. NuQ's pg_cron jobs update those tables as the superuser every 15 s, so an owner could attach a trigger the jobs would run with superuser rights (CWE-269).
  - Now the tables, the schema and the jobs (`postgres:36`) stay the superuser's. `fcpi_core` owns 0 objects, holds exactly the four DML privileges on all 4 NuQ tables, and has no CREATE on the schema. The pinned core's compiled `nuq.js` sends NuQ only DML and `pg_notify()`.
  - As `fcpi_core`:
    - a DML statement succeeds;
    - `CREATE FUNCTION nuq…` is refused ("permission denied for schema nuq");
    - `CREATE TRIGGER … ON nuq.queue_scrape` is refused ("permission denied for table queue_scrape").
  - The superuser has no password. pg_cron, the healthcheck and the collectors use the trusted local and loopback connections.
  - All three NuQ round-trip cases pass through the new role, and the sentinels survived a force-recreate.
  - The fresh-install paths ran in throwaway containers of the pinned images. On an empty data directory, `010-nuq.sql` ran, `020-fcpi-core-role.sh` was sourced and the `.psql` was ignored, with 0 errors and the same grants. On a first boot, the broker created `fcpi` with no tags (`{ok,[]}`).
- **dockerd gate (R13) and a defect it exposed.**
  - Window 2's first gate run (`raw/docker-gate-requires.txt`) showed why the gate never reached its start limit. `fcpi-stack.service` had `Requires=docker.service`, so systemd carried docker's automatic restart to it (t+2). Its ExecStop `docker compose stop` then waited on the socket of the dockerd being restarted until `TimeoutStopSec=180` (t+183), leaving fcpi-stack failed. Only then did docker fail twice more, reaching its start limit at t+190.
  - Any dockerd restart while the stack ran would have stalled the same way.
  - `fcpi-stack.service` now `Wants` docker, keeping the ordering without passing restarts on. The rerun shows the result:
    - systemd reaches StartLimitBurst in 6 s (3 attempts, each failing the data check);
    - fcpi-stack stays active, with no restart job;
    - there is no dockerd process and no project process at any one-second sample.
  - The restore revived all 6 containers healthy, left fcpi-stack active, and reloaded the guard.
  - V12's mount-check branches, rerun because fcpi-stack changed, all still fail closed, and the stack restarts healthy.
- **NetworkManager (R14).**
  - Before the file, NetworkManager showed all 14 Docker interfaces as "connected (externally)". After it, all 14 are unmanaged.
  - The merged configuration's `unmanaged-devices` is the file's value.
  - From the first reload (23:07:38 UTC) to the end of window 2, the journal has 238 lines, 236 of them about Docker's interfaces (the positive control), with 0 activations, 0 DHCP transactions and 0 wlan0 state changes.
  - The root cause is in the host's netplan-generated NetworkManager fragment. Its device section `match-device=type:ethernet` with `managed=1` covers every Ethernet-type device, veths included, so NetworkManager offered them the idle `netplan-eth0` profile.
- **Deploy (R16).** A planted file and its directory were removed after hash verification. The Pi then held exactly the 255 archived files plus `.fcpi-source-commit`.

## Unrelated state

The attributed diff is in `snapshot-diff.txt` (V14): **0 changes to unrelated state** and 56 project lines. They are:

- six replaced containers, with their scopes, root filesystems and network namespaces;
- the `fcpi_guard` table and its two chains;
- the ruleset hash;
- `nft_ct`, which the guard's conntrack match loads;
- the SSH session scopes.

The forwarding switches and the boot ID are unchanged. V25 shows that the close-out started from M1's AFTER state.

## Rolling back across the close-out

A deploy of a commit from before the close-out leaves the guard in place: its ruleset is under `/etc/firecrawl-pi` and its drop-in stays installed. The credentials do not roll back by deploy alone. The old Compose file logs the core in as `postgres` over TCP, and the superuser now has no password. Before `docker compose up` on such a commit:

1. On the Pi, pipe `\set pw` plus `ALTER ROLE postgres PASSWORD :'pw';` into `psql -U postgres` inside nuq-postgres, with the value read from `postgres_password` over stdin, the way `pi-narrow-credentials.sh` passes it.
2. Copy `postgres_password` into `core_postgres_password` (owner 0:0, mode 0600).

## Deviations and notes

- **One public connection.** The guard's positive control (window 1, before the audit window) made one TCP connection from the gateway to a public address (1.1.1.1:443). No Cloud or retrieval endpoint was contacted.
- **Identifiers.** In `raw/deploy-prune.txt`, `raw/lan-probe.txt`, `raw/stack.txt` and `raw/stack-final.txt`, the Pi's LAN address and SSH target were replaced after collection by `<pi-lan-address>` and `<pi-ssh-target>`. The close-out adds no identifier occurrence (R21).
- **Bugs found while running, all fixed:**
  - the migration queried a replaced container ID;
  - the egress audit exited 1 on an empty NetworkManager attribution;
  - V23 counted the collector's `end` line as a device;
  - V14 attributed `nft_ct` to the runtime;
  - the fresh proof's readiness wait hit the pipefail and SIGPIPE trap, and `pg_isready` had no user name;
  - psql printed command tags into the probe.

## Still owned by later milestones

| Finding | Owner | What it needs from that milestone |
|---|---|---|
| R1, R2, R3, R4, R6, R7 | M2 | The patch series, the retrieval adapter and its attempt budget, SSRF ownership, M2's corpus and its own evidence window |
| R9 | M3 | Receipts and result retention |
| R11 (Redis `default` user) | M8 | The command set of a representative workload, measured in M8's soak |
| R12 | M8 | `fcpi status`, where a non-project container would be reported |
| R15 | M8 | Card-write measurements under M8's soak |
| R20, R21 | none | No action (REVIEW.md) |

## For M2

- **Snapshots.** Take them with `scripts/m1/snapshot.sh`. M2's BEFORE compares with `evidence/M1/closeout/snapshot-after.txt`.
- **The guard.** `inet fcpi_guard` closes the gateway's bridge. M2's retrieval and browser egress rules go beside it, and V20's probe must keep passing. Any container M2 gives a non-internal network gets its own DNS upstream the same way, or its lookups bypass the guard.
- **Credentials.**
  - The core connects as `fcpi_core`, with DML only.
  - Anything that needs DDL on NuQ runs as the superuser through the local socket, never through the core.
  - V15 hashes six live secrets.
- **Host services.** NetworkManager leaves Docker's interfaces alone. A dockerd restart no longer stalls on fcpi-stack. `deploy.sh` removes files dropped from Git.
