# BEFORE snapshot against the previous AFTER (CLAUDE.md §33.1)

`snapshot-before.txt` (taken 2026-10-20 before any change by the search-intelligence cutover) is compared with the most recent committed AFTER snapshot, `evidence/playground/snapshot-after.txt` (2026-10-15). Both are read as the milestone verifiers read them (every section but `meta`, SSH session scopes removed, lines sorted). 338 keyed lines each; 61 lines differ on each side. Between the two snapshots the Pi was rebooted (the boot id differs; the owner rebooted it on 2026-10-19) and the release at `5d91186` was deployed (2026-10-17). Every difference is attributed below.

## What differs

After removing process ids, file-descriptor numbers, 64-hex container and snapshot ids, network-namespace ids and image digests, 8 lines remain on each side. The other 53 differ only in those fields.

| Line | Cause |
|---|---|
| `docker_ps` and `findmnt` lines of the access gateway, the MCP gateway and the retrieval service (container ids, image digests, `/run/docker/netns/*`, `/var/lib/docker/rootfs/overlayfs/*`) | The three services were redeployed at `5d91186` and the commits before it on 2026-10-17 (`git log` of `deploy/compose.yaml`), after the previous AFTER. New containers have new ids, namespaces and image digests. |
| `findmnt` of three overlay root filesystems (containerd snapshot numbers 4466/4541/4542 against 4747/4748/4749) | The same three containers: their image layers are newer snapshots. |
| `findmnt` `/proc/sys/fs/binfmt_misc` (autofs `pipe_ino` 4346 against 3765) | A per-boot inode number; the Pi rebooted. |
| `findmnt` `/sys/kernel/debug/tracing` (present only in the previous AFTER) | The kernel's tracefs mount, present while tracing was in use; not a project mount. |
| `ss_listen` `avahi-daemon` UDP ports (56372 and 51591 against 57324 and 54319) | Ephemeral ports chosen at each start; the Pi rebooted. |
| `swap_zram` | The same zram0 line, differing by trailing whitespace. |
| `ss_listen` process ids of every listener | New process ids after the reboot; the listener set (address, port, program) is otherwise identical. |
| `systemd_running` `fcpi-heartbeat.timer` (only in this BEFORE) | The unit was installed on 2026-09-28 (M8, `2c0bbf5`) and started at the boot of 2026-10-19 22:17 EDT; the previous AFTER was taken when it was not listed as running. Not a change by this work. |
| `nft_ruleset_sha256` (raw) | Docker re-orders its "drop direct access" rules in `table ip raw` when containers start, so the raw hash takes more than one value without a packet meeting a different rule. The canonical hash of this BEFORE, and the separate hash of the project's `inet fcpi_guard` table, are recorded in `firewall-before.txt`, and the AFTER is compared with them. The four order-insensitive chains are the four the project lists. |

No line is unexplained, and no listener, mount, unit or firewall rule that belongs to the project or to another service on the Pi differs in content.
