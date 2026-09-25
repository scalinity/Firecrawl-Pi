# M0 interpretation — read-only audit and frozen baseline

Audit window 2026-09-25 03:15Z–04:00Z (UTC); re-check window after the B1 reboot 06:23Z–06:34Z. Target `danny@pi.local` (158.205.34.18). Upstream `firecrawl/firecrawl` v2.11.162 → `7666c1f9ae8720a6bba271e0f60b6a217f8a5210`.

- **Machine-readable record:** `audit.json`.
- **Checks:** `verification.json`.
- **Lockfile:** `deploy/versions.lock.json`, whose values come from `sources/`.
- **Stored only as SHA-256 values:** the board serial, machine-id, MAC addresses and the home egress IP.
- **Where state lives:** the milestone state and the owner-input register are held in `docs/FIRECRAWL_PI_MILESTONES.md`. This file carries the evidence and reasoning behind them.

**State: ACCEPTED.** The host fits the proposed budget, and the memory cgroup controller is active after the owner-approved B1 change, so container memory caps are enforceable. The separate review decided D1–D6 (`review/DECISIONS.md`). V01–V08 pass on evidence captured after the B1 reboot.

## 1. Host-fit verdict

| Measure (raw source: P1 `pi-audit.txt`) | Value |
|---|---|
| MemTotal | 8,255,888 kB = **8,062.39 MiB** |
| MemAvailable | 7,901,136 kB = 7,715.95 MiB |
| Existing usage (MemTotal − MemAvailable) | **346.44 MiB** |
| Container caps (spec §22) + host reserve | 6,432 + 1,024 = **7,456 MiB** |
| Headroom | **+259.95 MiB → fits** |
| Root free space vs 20 GiB | 54,830,821,376 B = **51.06 GiB ≥ 20 GiB** |
| Free inodes (root) | 3,648,806 of 3,692,928 |

- **Existing workload:** Pi-hole FTL, Mosquitto, dnscrypt-proxy, fail2ban, three owner air-quality services (`airdb`, `airlogger`, `airmonitor`), avahi, NetworkManager/wpa_supplicant, and polkit (started on demand during the Wi-Fi recovery). Load 0.00.
- **OOM kills:** none in the retained journal, which starts 2026-09-25T03:07:37Z and covers four boots. It is size-limited, so it cannot speak for earlier uptime.
- **Limits of the fit figure:** it is arithmetic from idle samples with a thin margin. The pre-reboot figure was 21 MiB lower (325.17 MiB usage, 281.22 MiB headroom), which is the scale of normal idle variation. Per-unit memory is now readable: `system.slice` measured 350.7 MB current and 360.7 MB peak (P1 `unit_memory`). `/tmp` and `/dev/shm` are RAM-backed tmpfs of up to 4 GiB each. M2 and M8 replace this estimate with measurement.
- **If a shortfall appears later:** spec §22's first remedy is to reduce overlapping work, and the second is to reduce optional resident services. M0 rebalanced no cap.

**B1 — memory controller (resolved).** The firmware adds `cgroup_disable=memory` to the kernel command line; `/boot/firmware/cmdline.txt` does not contain it. With the owner's approval, `cgroup_enable=memory` was appended to `cmdline.txt` and the host rebooted once (`b1/APPLIED.md`). The kernel applies the later token, so `/proc/cmdline` now carries both, enable last. The cgroup v2 controllers are `cpuset cpu io memory pids`, and the root delegates `cpu memory pids` to its children. `CONFIG_MEMCG=y` is built in. Docker can therefore enforce `mem_limit` for the spec §22 caps, the browser-crash isolation of CLAUDE.md §14, and M1's "effective cgroup caps" check.

- **Rollback:** `sudo cp -p /boot/firmware/cmdline.txt.pre-B1 /boot/firmware/cmdline.txt` and reboot.
- **Reboot side effects:** new process and socket identities; `polkit.service` resident. `b1/reboot-diff.txt` attributes every line. The host stayed off the LAN for 53 minutes because its stored Wi-Fi key no longer matched the owner's network; that is unrelated to B1 (`b1/APPLIED.md`).

## 2. Storage plan

- **Medium:** microSD is the only storage (`mmcblk0`, type SD, name SD64G, 64 GB, manufactured 04/2025). No NVMe or USB storage is attached.
- **Root filesystem:** ext4, UUID `15f4c6be-1102-4331-9904-f78e78afd1fd`, PARTUUID `29680333-02` (findmnt, lsblk and dumpe2fs agree). State is clean, with no error record. Lifetime writes stand at 137 GB, which is the wear baseline. The retained kernel log shows no mmc/ext4 error.
- **Data directory:** `/srv/firecrawl-pi/data` on that filesystem. `/srv`, `/opt`, `/etc` and `/var/lib` are all on it. None of `/opt/firecrawl-pi`, `/srv/firecrawl-pi`, `/etc/firecrawl-pi`, `/var/log/firecrawl-pi` or `/var/lib/docker` exists.
- **Fail-closed check for M1.** A oneshot unit, `fcpi-data-check.service`, runs before the project Compose unit, which requires it. It fails unless all three of these hold:
  1. `findmnt -n -o UUID --target /srv/firecrawl-pi/data` equals the expected UUID in `PI_DATA_MOUNT_ID`.
  2. `/srv/firecrawl-pi/data/.fcpi-data-id` matches the project data ID written at M1 initialisation.
  3. Every Compose bind mount uses `bind.create_host_path: false`, so Docker never creates a missing path on the root card.

  A dedicated device added later is mounted by `UUID=` with `nofail,x-systemd.device-timeout=10s` and `RequiresMountsFor=/srv/firecrawl-pi/data`, and the expected UUID changes to that device's. If the device is then absent, the path resolves to the root UUID and the check fails.
- **microSD pilot constraints** (spec §21.1):
  - override upstream `nuq.sql`'s `min_wal_size=4GB` / `max_wal_size=16GB` in project configuration;
  - keep retention short;
  - monitor writes against the 137 GB baseline;
  - keep swap as audited: 2 GiB zram (zstd). The existing zram writeback to `/var/swap` on the card (`rpi-zram-writeback.timer`, 4 pages written) is recorded and left unchanged.
- **Final unattended acceptance (M8)** needs evidence that the card copes. An SSD stays the spec's strong recommendation, but it is not required to proceed.

## 3. Network plan

**Exposure finding for 158.205.34.18: not directly reachable from the Internet, but reachable from the whole LAN.**

- **The LAN uses a public block that belongs to someone else.** RDAP places 158.205.34.0/24 with JPNIC (JP), while the host keeps America/New_York time.
- **The LAN is behind NAT.** The Pi's single IP-echo GET returned an egress address that differs from its interface address. The answer is stored only as a hash (see §7).
- **There is no global IPv6.**
- **Journal evidence is limited to about two hours.** In the retained sshd window (from 2026-09-24T22:06:08-04:00), 43 connection sources fall inside the interface subnet and 0 outside it. fail2ban records 0 failures and 0 bans. This is supporting evidence only; the NAT result is the primary one.
- **Router port forwards are unobserved.** They can only be seen from outside, which M0 does not probe. The project does not depend on the answer.

No packet filter is loaded. `nftables` 1.1.3 is installed, but no ruleset is loaded; iptables and ufw are absent. So all existing all-address listeners are exposed to the LAN:

- Pi-hole runs `listeningMode=ALL`, changed from the default `LOCAL`.
- Mosquitto has `allow_anonymous true` on ports 1883 and 9001.
- `airdb` listens on 8080.

These are the owner's services, left unchanged. Details are in `network-exposure.json`.

**Proposed ports.** V04 confirms they collide with no current listener, lie outside the ephemeral range 32768–60999, and bind only to loopback:

| Service | Binding |
|---|---|
| access-gateway (only host publication) | `127.0.0.1:3380/tcp` |
| Tailscale Serve (M3) | tailnet `:443` → `127.0.0.1:3380`. pihole-FTL holds `0.0.0.0:443`, so M3 verifies they coexist; the fallback is tailnet `:8443`, which is free |
| tailscaled WireGuard (M3) | its default `41641/udp`, which is free |
| Internal only, never published | 3002 core API, 3006+ NuQ workers, 5432, 6379, 5672, 8080 SearXNG, 3000 browser, 3100 retrieval, 3200 MCP, 3300 gateway (container side) |
| Project networks | `10.231.0.0/24` access, `10.231.1.0/24` core (internal), `10.231.2.0/24` browser; none overlaps a host route |

- **Tailscale:** not installed. Installation and account association belong to M3.
- **Link:** the Pi is on Wi-Fi only, with no carrier on eth0. An owner `net-watchdog.timer` restarts wedged Wi-Fi every 2 minutes.
- **SSRF (M2):** the egress policy must deny 158.205.34.0/24 as local. The block is not RFC 1918, so a private-range check alone would miss it.
- **Docker (M1):** installing Docker loads netfilter modules and creates DOCKER chains. Record that change against this baseline, where no filter is loaded.
- **Privileges for M1:** danny has passwordless sudo and is not in the `docker` group. Use `sudo -n docker` rather than adding root-equivalent group membership.

## 4. Build plan

| Option | Evidence | Assessment |
|---|---|---|
| A. Acquire upstream's arm64 API image | `ghcr.io/firecrawl/firecrawl:2.11.162`, arm64 manifest `sha256:6157ce24…`, config `FIRECRAWL_BUILD_SHA=7666c1f9…` | No native build is needed for M1. It is built by a third party, so its provenance is the recorded build SHA, not a reproducible build. It does not cover M2's patch. |
| B. Build on the Mac (Apple M5 Pro, arm64) | node/npm/gh/jq present; no container runtime | Builds native linux/arm64 in a Linux VM, with no emulation. **Prerequisite:** a Linux arm64 container runtime on the Mac, which is an M1 install decision. Transfer with `docker save \| ssh … sudo docker load`. |
| C. Build natively on the Pi | 51.06 GiB free (≥ 20 GiB); 7,737 MiB available | Feasible on space. However, no memory cgroup can bound the build. The Rust (unpinned toolchain, no `Cargo.lock`, branch git deps), node-gyp (`foundationdb` addon) and Go compiles on 4 cores would compete with household DNS and add card wear. Spec §4 prefers another ARM64 machine in that case. |

Reproducibility gaps any source build must close:

- pin every `FROM` by digest (the lockfile does this);
- pin the Rust toolchain and commit a generated `Cargo.lock`;
- verify the FoundationDB client `.deb` against its published SHA-256 `a3c451dd…` (`sources/`), which upstream downloads unchecked;
- move Go off 1.24 (D4).

The NuQ image is a small layer (`postgres:17.11-trixie` plus pg_cron `1.6.8-1.pgdg13+2` from PGDG), so it builds acceptably on either machine.

## 5. Baseline decisions

The separate review decided D1–D6 in `review/DECISIONS.md`, which governs and records the canonical edits it made. The evidence and proposals below are M0's input to that review.

- **D1 — Browser version (security).**
  - *Evidence:* pinned Playwright 1.58.1 bundles Chromium 145.0.7632.6 (rev 1208), and its arm64 archives exist. Since 2026-07-30, Chrome stable has shipped 829 security fixes. Two V8 bugs were exploited in the wild: CVE-2026-85046 (fixed in 152.0.7977.82) and CVE-2026-87491 (fixed in 153.0.8010.36). Playwright 1.63.0 bundles 153.0.8010.12, which is still below that last fix.
  - *Proposal:* the browser worker is project-owned, not upstream's Playwright service, so choose its Playwright/Chromium pair in M2. Take the newest release whose Chromium is at or above 153.0.8010.36. If none exists yet, take the newest available, with the §20 isolation controls and the residual risk recorded. The package and its binary move together.
- **D2 — 16 KiB-page kernel (native-build/runtime uncertainty).**
  - *Evidence:* `CONFIG_ARM64_16K_PAGES=y`, and only `kernel_2712.img` is present (no 4K `kernel8.img`). The pinned tree has no jemalloc. The Redis 7.x and 8.10 images build jemalloc with `--with-lg-page=16` on arm64 (`sources/redis-jemalloc-lg-page.txt`). Chromium's launch on this kernel is unproven.
  - *Proposal:* keep the 16K kernel. M1 proves each data/core image starts natively; M2 proves Chromium. The fallback (install `linux-image-rpi-v8`, set `kernel=kernel8.img`, reboot) needs owner approval and is used only if a mandatory component fails.
- **D3 — RabbitMQ series.**
  - *Evidence:* upstream Compose uses `rabbitmq:3-management` (3.13.7), whose community support has ended. 4.3.6 is the only community-supported series, until 2026-11-30 (`sources/rabbitmq-release-information.txt`), and it fixes the 2026-08 and 2026-09 advisories. NuQ declares only quorum queues plus one exclusive classic reply queue, and both are valid on 4.x (`source-review.json` S14).
  - *Proposal:* `rabbitmq:4.3.6` without the management plugin, gated by an M1 NuQ round-trip test.
- **D4 — Go build stage.**
  - *Evidence:* `golang:1.24` resolves to 1.24.13, and go.dev lists only 1.27.1 and 1.26.8 as supported.
  - *Proposal:* any project source build uses a supported Go (1.26.x), which `go.mod` permits. This is moot for M1 if D6 chooses option A.
- **D5 — MCP SDK patch.**
  - *Evidence:* `@modelcontextprotocol/server@2.0.0` (node ≥20) is confirmed, and 2026-07-28 is still the current stable protocol. 2.1.0 (2026-09-23) adds 4 MiB body and 100-message batch caps (#2698), and rejects modern requests missing `MCP-Protocol-Version` (#2590). 2.0.0 has neither, yet the project contract requires both.
  - *Proposal:* adopt server/core/node 2.1.0 for M4, and update the baseline row in both canonical documents.
- **D6 — M1 image source.**
  - *Evidence:* spec §3.2 says to build from pinned source plus a patch series, while M1 permits "build or acquire".
  - *Proposal:* M1 acquires option A by digest, and builds the NuQ image from the pinned Dockerfile with a digest-pinned `FROM`. M2's patched image is built on the Mac (option B), with option C only as a fallback.

**Selected without escalation**, because each is a same-major security patch: Node 22.23.3 (at or above security release 22.23.2), PostgreSQL 17.11 (fixes 28 CVEs), Redis 8.10.2-alpine (the floating `redis:alpine` resolves to it, and it includes the Aug/Sep fixes) and SearXNG `2026.9.23-3cd69d30e`.

**Firecrawl:**

- No advisory published after 2026-07-30 affects v2.11.162, and the self-host guide still pins it. v2.11.402 is not adopted.
- Open items at the pin are handled by M2's SSRF layer and patch series:
  - `ip-address@6.4.0` (GHSA-mwp4-54f8-5fhr);
  - redirect-to-blocklist fix `58d0c8ebb6`;
  - the unauthenticated `/admin/integration/*` proxy to `integrations.firecrawl.dev`. The gateway must never route `/admin/*`.

## 6. Owner input

- **B1:** approved 2026-09-25 and applied (§1).
- **B2:** the owner states a fan is fitted. The probe cannot see it: in the first P1 run the fan was commanded (PWM 75/255) and read 0 rpm (git `m0-first-run:evidence/M0/raw/pi-audit.txt`), and the re-check caught it idle at 43.3 °C (PWM 0). Thermal checks therefore rely on temperature and `get_throttled` (`0x0` since boot), not rpm.
- **Still open, from the review:** yes or no to a Linux arm64 container runtime on the Mac, before M2's first build (D6).

## 7. Integrity, side effects and corrections

- **BEFORE vs AFTER:** the re-check pair, BEFORE (06:23:00Z) and AFTER (06:33:56Z, after the last Pi probe), match. They are compared as section-keyed sorted lines. Only `session-<n>.scope` lines are excluded, and the boot ID is unchanged (V08). The original audit pair (03:15:30Z / 04:00:17Z) also matched; it is in git history, and its AFTER is kept as `b1/snapshot-before.txt`.
- **Re-check window:** the first BEFORE attempt (06:22:35Z) loaded `tcp_diag` through its own `ss` query, as in the original audit, so BEFORE was retaken with it loaded. The window's only kernel log line is the once-per-boot `/proc/cgroups` notice at 06:28:32Z, from P1's first read of that file (P6).
- **Imager-id near-miss:** after the reboot, the retained kernel log reaches back to boot time, where the kernel prints the imager instance id. The first re-check P6 transcript carried it unmasked; it was overwritten before any commit, P6 now masks it on the Pi as P1 does, and P6 and AFTER were re-run. V07 gained an `imager-instance-id` rule, with a matching positive-control line.
- **Side effects of the audit's own access:**
  - SSH and sudo entries in the journal and auth log.
  - `user@1000.service` and `/run/user/1000` running for each login; both are present in both snapshots.
  - One outbound HTTPS GET to `api.ipify.org`.
  - One kernel log line at 03:18:44Z: *"/proc/cgroups lists only v1 controllers…"*. The kernel prints this once, the first time `/proc/cgroups` is read, and it was the first P1 run (P6 `pi-audit-kernel-log.txt`). The re-run did not print it again.
- **Module ambiguity:** `tcp_diag` and `inet_diag` are the two most recently loaded modules. The original BEFORE snapshot ran `ss` before reading `lsmod`, so M0 cannot tell whether its first `ss` loaded them or an earlier `ss` did during the 2.3-day uptime. `udp_diag` does not exist for this kernel.
  - These modules serve socket-statistics queries only, and they were left loaded: unloading could remove state that predates M0.
  - The snapshot now reads modules before `ss`, and the kernel log records no module-load event.
- **Egress echo provenance:** the P2 script version that sent the one permitted GET printed the raw answer. On the workstation, before any commit, the answer was replaced with its SHA-256 (`raw/pi-audit-extra-ipecho.txt` states this and names the producing script blob). The raw address was never committed. The probe now hashes on the Pi, and re-runs pass `FCPI_SKIP_IP_ECHO=1`.
- **Probe re-runs after review:**
  - P1 re-ran with the hardened `pi-audit.sh`: explicit PATH, a binfmt_misc mount check, `lsblk -P`, and on-Pi masking of link-local interface IDs and the imager instance id.
  - P2 re-ran without the echo.
  - The superseded first transcripts remain in git at tag `m0-first-run`.
  - `audit.json` records, per probe, the commit and SHA-256 of the script version that ran.
- **Machine-id near-miss:** the first run of the kernel-log probe captured the raw machine-id inside a journald directory path. That file was deleted before any commit, and the probe was re-run with the machine-id hashed on the Pi. V07 now checks every standalone 16- and 32-hex token against the recorded serial and machine-id hashes, so an identifier inside a path can no longer pass.
- **Identifiers deliberately retained:**
  - 158.205.34.18 and the /24 are functional: they are the target address and the SSRF deny-list input.
  - The time zone and US Wi-Fi regulatory domain carry the NAT inference.
  - File contents in git history before the commits "remove session scratchpad path from upstream findings" and "drop the workstation address and correct stale exposure facts" still hold a session scratchpad path, a link-local address, the imager instance id and the workstation's LAN address. No remote exists; the full-history scan required before any first push must remove them in a clone.

## Evidence index

- **Core records:** `audit.json` · `verification.json`
- **Snapshots:** `snapshot-{before,after,diff}.txt`
- **Raw transcripts:** `raw/pi-audit{,-extra,-extra-ipecho,-paths,-layout,-kernel-log}.txt`
- **Findings:** `network-exposure.json` · `runtime-candidates.json` · `source-review.json` · `security-review.md`
- **B1 record:** `b1/APPLIED.md` · `b1/snapshot-before.txt` (pre-change) · `b1/reboot-diff.txt` (attributed reboot changes)
- **Separate review:** `review/DECISIONS.md` · `review/sources/`
- **Saved retrievals:** `sources/` (lockfile backing) · `upstream/` (source findings, raw extracts) · `registry/` (index and arm64 manifest bytes, `digests.jsonl`)
- **Lockfile:** `../../deploy/versions.lock.json`
