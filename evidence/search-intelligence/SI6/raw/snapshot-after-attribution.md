# AFTER snapshot against BEFORE (CLAUDE.md §33.1)

`snapshot-after.txt` (2026-10-20, after the third release's cutover and the deploy of `25e3593`) is compared with this session's `snapshot-before.txt`, taken before the first change. Both are read as the milestone verifiers read them (every section but `meta`, SSH session scopes removed, lines sorted): 338 keyed lines before, 337 after; 23 lines only in BEFORE and 22 only in AFTER. The boot id is the same in both (`boot_id_sha256` `3e74999e…`): the Pi did not reboot.

## What differs

| Section | BEFORE-only / AFTER-only | Cause |
|---|---|---|
| `docker_ps` | 4 / 4 | The four services the three releases recreated (`firecrawl-core`, `retrieval-service`, `access-gateway`, `mcp-gateway`): new container ids and image digests (the three rebuilt service images and the core's new image). The other containers (PostgreSQL, Redis, RabbitMQ, the browser worker, SearXNG, the fixtures) are unchanged. |
| `findmnt` | 13 / 13 | The same four containers' overlay root filesystems, `/run/docker/netns/*` and `/var/lib/docker/rootfs/overlayfs/*` entries: new snapshot and namespace ids. |
| `ss_listen` | 1 / 1 | The process id of the `docker-proxy` behind the gateway's loopback publication (127.0.0.1:3380), new since the gateway was recreated; the listener set (address, port, program) is identical. |
| `systemd_running` | 5 / 4 | Four `docker-<container id>.scope` units of the recreated containers (new ids), and the heartbeat timer explained below. |

After removing process ids, file-descriptor numbers, 64-hex ids, image digests, namespace ids and overlay ids, no line is left in AFTER and one in BEFORE:

- **`fcpi-heartbeat.timer` (BEFORE only).** A timer unit's sub-state is `running` only while its service is executing, and the heartbeat service runs for a moment each minute, so whether one snapshot lists the timer depends on when it was sampled. The unit never stopped: `systemctl` on the Pi reports it active with `ActiveEnterTimestamp` 2026-10-19 22:17:16 EDT (the boot's start), listed with the incident, tick and probe timers, its last run 21 seconds before its next.

No listener, mount, unit or firewall rule that belongs to the project or to another service on the Pi differs in content.

## Firewall

`firewall-after.txt` equals `firewall-before.txt` apart from its time: the raw ruleset hash `b8fdb7a5…`, the canonical hash `895355e8…`, the same four order-insensitive chains (`ip filter/DOCKER-CT`, `ip filter/DOCKER-INTERNAL`, `ip6 filter/ts-input`, `ip raw/PREROUTING`) and the project's own `inet fcpi_guard` table `f291c0ce…`.

## What changed on the Pi during the session, for the record

Deploys of committed code (`scripts/m1/deploy.sh`), the last of `25e3593`; one cutover attempt that refused and changed nothing (`raw/release-1/cutover-attempt1-refused.txt`) and three cutovers recreating the four services (`raw/cutover.txt`, `raw/release-1/cutover.txt`, `raw/release-2/cutover.txt`), three builds of the three service images on the Pi from staged candidates and one load of the API image, the `retained-*` image tags, three backups (`raw/backup-before.txt`, `raw/release-2/backup-patch.txt`, `raw/backup-patch.txt`) and one restore test, the new provider keys under `/etc/firecrawl-pi/secrets` (`raw/keys.txt`), and the retrieval schema's additive change (`domain_route.blocked_until`). The live run's scratch directory under `/var/tmp` and its transient systemd unit were removed. No transient container is left (`docker ps -a --filter label=fcpi.transient` is empty).
