# AFTER snapshot against BEFORE (CLAUDE.md §33.1)

`snapshot-after.txt` (2026-10-20, after the sixth release's cutover and the deploy of the final commit) is compared with this session's `snapshot-before.txt`, taken before the first change. Both are read as the milestone verifiers read them (every section but `meta`, SSH session scopes removed, lines sorted): 338 keyed lines before and after; 23 lines only in BEFORE and 23 only in AFTER. The boot id is the same in both (`boot_id_sha256` `3e74999e…`): the Pi did not reboot. The AFTER snapshots taken after the third to fifth releases are kept in `release-3/` to `release-5/`.

## What differs

| Section | BEFORE-only / AFTER-only | Cause |
|---|---|---|
| `docker_ps` | 4 / 4 | The four services the six releases recreated (`firecrawl-core`, `retrieval-service`, `access-gateway`, `mcp-gateway`): new container ids and image digests (the three rebuilt service images and the core's new image). The other containers (PostgreSQL, Redis, RabbitMQ, the browser worker, SearXNG, the fixtures) are unchanged. |
| `findmnt` | 13 / 13 | The same four containers' overlay root filesystems, `/run/docker/netns/*` and `/var/lib/docker/rootfs/overlayfs/*` entries: new snapshot and namespace ids. |
| `ss_listen` | 1 / 1 | The process id of the `docker-proxy` behind the gateway's loopback publication (127.0.0.1:3380), new since the gateway was recreated; the listener set (address, port, program) is identical. |
| `systemd_running` | 5 / 5 | Four `docker-<container id>.scope` units of the recreated containers (new ids) on each side, and two timers explained below. |

After removing process ids, file-descriptor numbers, 64-hex ids, image digests, namespace ids and overlay ids, one line is left on each side, both timers:

- **`fcpi-heartbeat.timer` (BEFORE only) and `fcpi-probe.timer` (AFTER only).** A timer unit's sub-state is `running` only while its service is executing, and these services run for a moment every minute or every few minutes, so whether one snapshot lists a timer depends on when it was sampled (the snapshots taken after the earlier releases list the tick and net-watchdog timers the same way: `release-4/` and `release-5/snapshot-after-attribution.md`). None of these timers stopped or was started during the session: `systemctl` on the Pi reports the heartbeat, tick, probe and `net-watchdog` timers active with `ActiveEnterTimestamp` 2026-10-19 22:17:16 EDT, the boot's start. `net-watchdog.timer` is the Pi's own host unit (`/opt/pi-host/netwatch`), not this project's, and is unchanged.

No listener, mount, unit or firewall rule that belongs to the project or to another service on the Pi differs in content.

## Firewall

`firewall-after.txt` equals `firewall-before.txt` apart from its time: the raw ruleset hash `b8fdb7a5…`, the canonical hash `895355e8…`, the same four order-insensitive chains (`ip filter/DOCKER-CT`, `ip filter/DOCKER-INTERNAL`, `ip6 filter/ts-input`, `ip raw/PREROUTING`) and the project's own `inet fcpi_guard` table `f291c0ce…`.

## What changed on the Pi during the session, for the record

Deploys of committed code (`scripts/m1/deploy.sh`), the last of the final commit; one cutover attempt that refused and changed nothing (`raw/release-1/cutover-attempt1-refused.txt`) and six cutovers recreating the four services (`raw/cutover.txt` and `raw/release-1/` to `raw/release-5/cutover.txt`), six builds of the three service images on the Pi from staged candidates and one load of the API image, the `retained-*` image tags (`raw/retained*.txt`), six backups and one restore test (`raw/backup-before.txt`, `raw/restore-test-before.txt`, `raw/backup-patch.txt` and `raw/release-2/` to `raw/release-5/backup-patch.txt`), the new provider keys under `/etc/firecrawl-pi/secrets` (`raw/keys.txt`), and the retrieval schema's additive change (`domain_route.blocked_until`). The live runs' scratch directories under `/var/tmp` and their transient systemd units were removed. No transient container is left (`docker ps -a --filter label=fcpi.transient` is empty).
