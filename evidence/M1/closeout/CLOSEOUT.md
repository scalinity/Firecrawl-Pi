# M1 close-out — review findings closed before M2

The M1 review (`evidence/M1/review/REVIEW.md`) fixed R17–R19 and assigned the rest to owners. This close-out closes every finding whose closure did not need something a later milestone supplies, re-verifies M1 against the changed stack, and leaves M1's accepted record (`evidence/M1/` outside `review/` and `closeout/`) unchanged.

- **Window:** BEFORE snapshot 2026-09-25 23:05:29Z, AFTER snapshot 23:17:39Z, one boot. The audit window ran 23:08:07Z–23:17:38Z. Deployed commits: `0c454c5`, then `0db5a8d` (its only change is a fix to the migration script's final evidence line).
- **Checks:** `verification.json`, written by `FCPI_M1_EVIDENCE=evidence/M1/closeout/ node scripts/m1/verify.mjs`.
  - 24 checks were rerun on this evidence: V01–V11 and V13–V25. All 24 pass.
  - N00–N09 were not rerun. They prove M1's throwaway proof stack, which this work did not touch.
  - V12 was not rerun either. The data-check script and its unit are unchanged, and its bind validation covered the two new binds at every start in the window (`binds=10 create_host_path=false`).
- **M1's own record reproduces unchanged.** In default mode the changed verifier gives byte-identical results for all 27 non-live M1 checks and regenerates `evidence/M1/snapshot-diff.txt` identically. The new checks are NOT_RUN there.

## Findings closed

| Finding | Change | Evidence | Check |
|---|---|---|---|
| R5 — the access bridge had no drop rule | `deploy/host/fcpi-guard.nft` drops and counts forwarding in and out of `fcpi-access` and new connections from it to the host, keeping replies. It is loaded by dockerd's ExecStartPre after the data check (`20-fcpi-guard.conf`), and by `pi-init.sh`. | `raw/guard.txt` | V20 |
| R8 — snapshots held only a ruleset hash | `scripts/m1/snapshot.sh` appends nftables tables and chains and the forwarding switches (`pi-snapshot-net.sh`); M0's script is unchanged | `snapshot-before.txt`, `snapshot-after.txt` | V14, V25 |
| R10 — the gateway suite had only run on the workstation's Node | `pi-gateway-tests-pinned-node.sh` runs it inside the pinned image, with no network | `raw/gateway-tests-pinned-node.txt` | V21 |
| R11 — the core's credentials (PostgreSQL and RabbitMQ parts) | Role `fcpi_core` owns the NuQ schema with its own password (`fcpi-core-role.psql`, migration `pi-narrow-credentials.sh`, initdb script for new data directories). The RabbitMQ user `fcpi` has no tags, for existing and first-boot users. | `raw/narrow-credentials.txt`, `raw/credentials.txt` | V22, V07–V10, V13 |
| R13 — the dockerd gate was observed for 60 s only | The gate collector samples every second for up to 180 s and records NRestarts and Result | `raw/docker-gate.txt` | V19, V17 |
| R14 — NetworkManager handled Docker's veths | `90-fcpi-unmanaged.conf` leaves `veth*`, `fcpi-*` and `docker0` unmanaged; `pi-init.sh` installs it and reloads NetworkManager's config | `raw/nm.txt` | V23 |
| R16 — deploy never deleted on the Pi | `deploy.sh` removes files the archive lacks, after hash verification | `raw/deploy-prune.txt` | V24 |

Measured results:

- **Guard (R5).**
  - Without the guard, the gateway container reached the host through the bridge address (TCP 53), the host's LAN address (sshd) and a public address through the bridge's NAT.
  - With it, all three timed out, and the drops were counted: 3 forwarded, 6 inbound.
  - From the guard's reload at the gate test's restore to the end of the window, it counted 0 drops.
  - The gateway still served the fixture (200, exact Markdown).
- **Credentials (R11).**
  - `fcpi_core` has no superuser, role, database, replication or RLS-bypass rights, and owns the NuQ schema and all 4 NuQ tables and 2 enums.
  - The only TCP sessions are `fcpi_core`'s.
  - The core's password differs from the superuser's, and the core's container receives neither superuser secret.
  - All three NuQ round-trip cases passed through the new role, and the sentinels survived a force-recreate of all six containers.
  - The broker restarted with the new first-boot setting and kept its AMQP permissions (`fcpi .* .* .*`).
- **dockerd gate (R13).**
  - With the data check failing, no dockerd process and no project process appeared in any one-second sample over 180 s.
  - systemd did not exhaust StartLimitBurst. After the first failure it queued one automatic restart (`activating/auto-restart-queued`, NRestarts=1), and that restart did not run within the window.
  - The gate holds either way. Why the restart stayed queued was not investigated; the missing-mount test in M8 observes the same unit.
- **NetworkManager (R14).**
  - Before the change, NetworkManager showed all 14 Docker interfaces as "connected (externally)"; after the reload, all 14 were unmanaged.
  - Across the window (two recreations and a dockerd restart) it started 0 activations and 0 DHCP transactions on them.
  - wlan0 never changed state.
  - As a result, the audit's host-delivered IPv4 from the internal bridges fell to 0; M1's window had NetworkManager DHCP broadcasts there.
- **Deploy (R16).** A planted file and its directory were removed after hash verification, and the Pi held exactly the 231 archived files plus `.fcpi-source-commit`.

## Unrelated state

The attributed diff is `snapshot-diff.txt` (V14). It shows **0 changes to unrelated state**. The project changes it attributes are:

- six replaced containers, with their scopes, root filesystems and network namespaces;
- the `fcpi_guard` table and its two chains;
- the ruleset hash;
- `nft_ct`, which the guard's conntrack match loads;
- the audit's SSH session scopes.

The forwarding switches are unchanged, and the boot ID is unchanged. V25 shows that this close-out started from M1's AFTER state: only SSH scopes and the snapshot's new sections differ.

## Deviations and notes

- **One public connection.** The guard's positive control made one TCP connection from the gateway container to a public address (1.1.1.1:443). It ran deliberately, before the audit window opened, and no Cloud or retrieval endpoint was contacted.
- **Identifiers.** In `raw/deploy-prune.txt`, `raw/lan-probe.txt`, `raw/stack.txt` and `raw/stack-final.txt`, the Pi's LAN address and SSH target were replaced after collection by `<pi-lan-address>` and `<pi-ssh-target>` (6 occurrences). The close-out therefore adds no identifier occurrence (R21).
- **Bugs found while running.**
  - `pi-narrow-credentials.sh` queried the PostgreSQL container ID from before the Compose change (fixed in `0db5a8d`).
  - The egress audit's `read` exited 1 when NetworkManager had no veth lines to report (fixed in `90b8265`).
  - V23 counted the collector's `end` line as a device (fixed in `2e16ad2`).
  - V14 attributed `nft_ct` to the container runtime (fixed in `0662cc2`).

## Still owned by later milestones

| Finding | Owner | Why it cannot close now |
|---|---|---|
| R1, R2, R3, R4, R6, R7 | M2 | The patch series, the retrieval adapter and its attempt budget, SSRF ownership, M2's own corpus, and M2's own evidence window |
| R9 | M3 | Receipts and result retention do not exist before M3 |
| R11 (Redis `default` user) | M8 | Narrowing it needs the command set of a representative workload, which M8's soak first runs |
| R12 | M8 | The guard belongs in `fcpi status`, which M8 builds |
| R15 | M8 | Which write settings matter depends on card writes measured under M8's soak |
| R20, R21 | none | No action (see REVIEW.md) |

## For M2

- **The guard.**
  - `inet fcpi_guard` closes the gateway's bridge.
  - M2's egress design adds its retrieval and browser rules beside it, and keeps `fcpi-access` closed.
  - `V20`'s probe (`scripts/m1/pi-guard-probe.sh`) shows the pattern for positive controls.
- **Snapshots.** Take them with `scripts/m1/snapshot.sh`. M2's BEFORE compares with `evidence/M1/closeout/snapshot-after.txt`.
- **Credentials.** The core connects as `fcpi_core`. V15 hashes six live secrets.
- **NetworkManager.** It no longer touches Docker's interfaces, so M2's egress audit attributes no DHCP noise.
- **Deploy.** `deploy.sh` now removes files dropped from Git.
