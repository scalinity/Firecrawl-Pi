# AFTER snapshot against BEFORE (CLAUDE.md §33.1)

`snapshot-after.txt` (2026-10-21 01:21Z, after the seventh release's cutover and the deploy of its commit) is compared with `snapshot-before-patch.txt` (00:24Z, the new operating system before any change made on it; its own comparison with the old system is in `snapshot-before-patch-attribution.md`). Both are read as the milestone verifiers read them (every section but `meta` compared as sets of lines).

## What differs

| Section | BEFORE-only / AFTER-only | Cause |
|---|---|---|
| `meta` | 1 / 1 | The time. |
| `docker_ps` | 4 / 4 | The four services the cutover recreated (`firecrawl-core`, `retrieval-service`, `access-gateway`, `mcp-gateway`): new container ids; the three service images are the rebuilt digests (`b8599a51…`, `469849c0…`, `a2024202…`, from `62e06882…`, `e189de75…`, `b4f9277b…`) and the core runs the same API image (`c2585732…`). The other eleven containers are identical. |
| `systemd_running` | 5 / 5 | Four `docker-<container id>.scope` units of the recreated containers (new ids) on each side, and one SSH session scope (`session-2118` to `session-2739`). |
| `ss_listen` | 1 / 1 | The process id of the `docker-proxy` behind the gateway's loopback publication (127.0.0.1:3380), new since the gateway was recreated; the listener set (address, port, program) is identical. |
| `findmnt` | 13 / 13 | The same four containers' overlay root filesystems (`/var/lib/docker/rootfs/overlayfs/*`) and `/run/docker/netns/*` entries: new snapshot and namespace ids. |

After removing process ids, file-descriptor numbers, 64-hex ids, image digests and namespace ids, twelve lines are left: the time on each side, the SSH session scope on each side, and the four overlay root filesystems on each side, whose lower-layer paths name the recreated containers' image layers. No listener, mount, unit or firewall rule that belongs to the project or to another service on the Pi differs in content.

## Firewall

The firewall is the same in every view taken before and after the cutover:

- the nft ruleset, which on this system holds only the project's `inet fcpi_guard` table: raw, canonical and guard hashes all `057aeb8f…` in `firewall-before-patch.txt` and `firewall-after.txt`;
- Docker's rules in the legacy iptables backend (where this system keeps them; see `snapshot-before-patch-attribution.md`): the snapshot's counter-stripped `iptables_legacy_sha256` is `b412eeb2…` on both sides, and complete `iptables-legacy-save` and `ip6tables-legacy-save` captures, with the chain packet counters normalized, taken just before the cutover and after it are identical in order and as sets (148 lines each, 88 of them rules). Recreating four services re-added their rules in the same order, so the order-insensitive comparison the nft fingerprint needed on the old system was not needed here.

The legacy captures hold container addresses and are kept out of the repository; the hashes above are what is recorded.

## What changed on the Pi during the session, for the record

Before the pause for the SD-card move: a backup and the three `retained-ecb8733` image tags. After it, in order: a backup and a restore test (`backup-patch.txt`, `restore-test-patch.txt`); the staging of candidate `e98fc5d5bcc3` and the build of the three service images from it (`image-build.txt`); the staging of `d4f04648c4f7` and `fcpi upgrade --plan` (`upgrade-plan-patch.json`); a deploy of `d4f04648c4f7` (`scripts/m1/deploy.sh`, which also removed six stale files the archive no longer holds, four of them named in its output as records of the sixth release that moved under `raw/release-6/`) and one cutover recreating the four services (`cutover.txt`, 37 seconds with new work held at the gateway); `fcpi verify functional` (`verify-functional.txt`, PASS); the live smoke and the post-cutover checks (`live-smoke.jsonl`, `post-cutover-checks.txt`); one scrape of a domain that needs the residential tier (`residential-check.txt`: a Decodo proxy charge of 120 micro-USD and one Zyte enhanced dispatch of 1,270 micro-USD, both settled); and the 30 cold documentation searches (`l01-live-docs.jsonl`, run from a copy of `l01.py` in the Pi's `/var/tmp` that also records each row's version constraint status; the copy is archived in `SI6/l01/`). No `/var/tmp/fcpi-si6-cutover.txt` was left from the sixth release; the three scratch files this release left in the Pi's `/var/tmp` (the cutover's output, the driver copy and its output) were removed once their repo copies matched byte for byte. At the end all 15 containers belong to the Compose project `fcpi`, none carries the `fcpi.transient` label, and no unit of the release's is left.
