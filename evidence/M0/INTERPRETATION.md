# M0 interpretation — read-only audit and frozen baseline

Audit window 2026-09-25 03:15Z–03:36Z (UTC). Target `danny@pi.local` (158.205.34.18). Upstream `firecrawl/firecrawl` v2.11.162 → `7666c1f9ae8720a6bba271e0f60b6a217f8a5210`. Machine-readable record: `audit.json`; checks: `verification.json`; lockfile: `deploy/versions.lock.json`. Identifiers are stored only as SHA-256 values: board serial, machine-id, MAC addresses and the home egress IP.

**State: BLOCKED.** The host fits the proposed budget on paper. It cannot enforce any container memory cap, because the kernel runs with the memory cgroup controller disabled (blocker B1). Six baseline decisions (D1–D6) also await the separate review. Clearing B1 does not by itself make M0 ACCEPTED; D1–D6 must be decided as well.

## 1. Host-fit verdict

| Measure (raw source) | Value |
|---|---|
| MemTotal (`/proc/meminfo`) | 8,255,888 kB = **8,062.39 MiB** |
| MemAvailable | 7,925,904 kB = 7,740.14 MiB |
| Existing usage (MemTotal − MemAvailable) | **322.25 MiB** |
| Container caps (spec §22) + host reserve | 6,432 + 1,024 = **7,456 MiB** |
| Headroom | **+284.14 MiB → fits** |
| Root free space vs 20 GiB | 54,828,019,712 B = **51.06 GiB ≥ 20 GiB** |
| Free inodes (root) | 3,648,813 of 3,692,928 |

Existing workload: Pi-hole FTL, Mosquitto, dnscrypt-proxy, fail2ban, three owner air-quality services (`airdb`, `airlogger`, `airmonitor`), avahi, NetworkManager/wpa_supplicant. Load 0.05; no OOM kill in the journal.

The fit is arithmetic from one idle sample, with a thin margin. Existing services' peaks cannot be measured, because per-unit `memory.peak` does not exist without the memory controller. `/tmp` and `/dev/shm` are RAM-backed tmpfs of up to 4 GiB each. M2 and M8 replace this estimate with measurement. If a shortfall appears then, spec §22's first remedy is to reduce overlapping work, and the second is to reduce optional resident services. M0 did not rebalance any cap.

**B1 — memory controller disabled (OS blocker).** The kernel command line carries `cgroup_disable=memory`, and the cgroup v2 controllers are `cpuset cpu io pids`. `/boot/firmware/cmdline.txt` does not contain the flag: the firmware adds it to the boot arguments. `CONFIG_MEMCG=y` is built in. Without the controller, Docker cannot enforce `mem_limit`, and the spec §22 caps, the browser-crash isolation of CLAUDE.md §14 and M1's "effective cgroup caps" check are all impossible.

- **Proposed remedy:** append `cgroup_enable=memory` to `/boot/firmware/cmdline.txt` and reboot once. That is the conventional Raspberry Pi kernel override; it must be verified by confirming `memory` appears in `/sys/fs/cgroup/cgroup.controllers`.
- **Rollback:** remove the token and reboot.
- **Why it needs the owner:** it edits the boot configuration and reboots a host that serves household DNS through Pi-hole. That is outside M0's read-only scope and outside project-owned state.

## 2. Storage plan

- **Medium:** microSD is the only storage: `mmcblk0`, type SD, name SD64G, 64 GB, manufactured 04/2025. No NVMe or USB storage is attached.
- **Filesystem:** root is ext4, UUID `15f4c6be-1102-4331-9904-f78e78afd1fd` (PARTUUID `29680333-02`), state clean, no error record. Lifetime writes stand at 137 GB, which is the wear baseline. The current boot shows no mmc/ext4 kernel errors.
- **Data location:** `/srv/firecrawl-pi/data` on that filesystem. `/srv`, `/opt`, `/etc` and `/var/lib` are all on it. None of `/opt/firecrawl-pi`, `/srv/firecrawl-pi`, `/etc/firecrawl-pi` or `/var/log/firecrawl-pi` exists. `/var/lib/docker` does not exist.
- **Fail-closed check for M1.** A oneshot unit, `fcpi-data-check.service`, is ordered `Before=` the project Compose unit and required by it. It fails unless all three of these hold:
  1. `findmnt -n -o UUID --target /srv/firecrawl-pi/data` equals `PI_DATA_MOUNT_ID`'s expected UUID.
  2. `/srv/firecrawl-pi/data/.fcpi-data-id` exists and matches the project data ID written at M1 initialisation.
  3. Every Compose bind mount uses `bind.create_host_path: false`, so Docker can never create a missing path on the root card.

  If a dedicated device is added later, it is mounted by `UUID=` with `nofail,x-systemd.device-timeout=10s` and `RequiresMountsFor=/srv/firecrawl-pi/data`, and the expected UUID changes to the new one. An absent device then resolves to the root UUID, and the check fails.
- **microSD pilot constraints** (spec §21.1):
  - Override upstream `nuq.sql`'s `min_wal_size=4GB` / `max_wal_size=16GB` in project configuration.
  - Keep retention short and monitor writes against the 137 GB baseline.
  - Leave swap as audited: 2 GiB zram (zstd). The pre-existing zram writeback to `/var/swap` on the card (`rpi-zram-writeback.timer`, 4 pages written so far) is recorded and not changed.
- **Final unattended acceptance (M8)** needs evidence that the card copes. An SSD remains the spec's strong recommendation, but it is not required to proceed.

## 3. Network plan

**Exposure finding for 158.205.34.18: not directly reachable from the Internet; reachable from the whole LAN.**

- The LAN 158.205.34.0/24 is numbered from a public block that RDAP places with JPNIC (JP), while the host keeps America/New_York time.
- The Pi's single IP-echo GET returned an egress address that differs from the interface address (stored as a hash only), so the LAN sits behind NAT.
- There is no global IPv6.
- The sshd journal shows 36 local-subnet sources and 0 outside ones, and fail2ban records 0 failures and 0 bans.
- Router port forwards can only be seen from outside and were not probed. The project does not depend on the answer.

Existing services bound to all addresses are therefore LAN-exposed, and no packet filter is loaded. `nftables` 1.1.3 is installed with no ruleset; iptables and ufw are absent.

- Pi-hole runs `listeningMode=ALL`, changed from the default `LOCAL`.
- Mosquitto has `allow_anonymous true` on 1883 and 9001.
- `airdb` listens on 8080.

These are the owner's services and M0 left them unchanged. Details: `network-exposure.json`.

**Proposed ports** (V04: no collision, not in the ephemeral range 32768–60999, loopback only):

| Service | Binding |
|---|---|
| access-gateway (only host publication) | `127.0.0.1:3380/tcp` |
| Tailscale Serve (M3) | tailnet `:443` → `127.0.0.1:3380`. pihole-FTL holds `0.0.0.0:443`, so coexistence is verified in M3; fallback is tailnet `:8443` (free) |
| tailscaled WireGuard (M3) | its default `41641/udp` (free) |
| Internal only, never published | 3002 core API, 3006+ NuQ workers, 5432, 6379, 5672, 8080 SearXNG, 3000 browser, 3100 retrieval, 3200 MCP, 3300 gateway container side |
| Project networks | `10.231.0.0/24` access, `10.231.1.0/24` core (internal), `10.231.2.0/24` browser: no overlap with host routes |

- **Tailscale:** not installed. Installation and account association belong to M3.
- **Link:** Wi-Fi only; eth0 has no carrier, and an owner `net-watchdog.timer` restarts wedged Wi-Fi every 2 minutes.
- **SSRF (M2):** the egress policy must deny 158.205.34.0/24 as local. A private-range check alone would miss it and expose the router and LAN hosts.
- **Docker (M1):** installing Docker will load netfilter modules and create DOCKER chains. Record that against this baseline, where no filter is loaded.
- **Privileges for M1:** danny has passwordless sudo and is not in the `docker` group. Use `sudo -n docker` rather than adding root-equivalent group membership.

## 4. Build plan

| Option | Evidence | Assessment |
|---|---|---|
| A. Acquire upstream's arm64 API image | `ghcr.io/firecrawl/firecrawl:2.11.162`, arm64 manifest `sha256:6157ce24…`, config `FIRECRAWL_BUILD_SHA=7666c1f9…` | No native build for M1. Built by a third party, so provenance is the recorded build SHA rather than a reproducible build. Does not cover M2's patch. |
| B. Build on the Mac (Apple M5 Pro, arm64) | node/npm/gh/jq present; no container runtime | Native linux/arm64 inside a Linux VM, with no emulation. **Prerequisite:** a Linux arm64 container runtime on the Mac, which is an M1 install decision. Transfer with `docker save \| ssh … sudo docker load`. |
| C. Build natively on the Pi | 51.06 GiB free (≥ 20 GiB); 7,740 MiB available | Feasible on space. However, no memory cgroup can bound the build; Rust (unpinned toolchain, no `Cargo.lock`, branch git deps), node-gyp (`foundationdb` addon) and Go compiles on 4 cores would compete with household DNS; and it adds card wear. Spec §4 prefers another ARM64 machine in that case. |

Reproducibility gaps any source build must close:

- pin every `FROM` by digest (the lockfile does this);
- pin the Rust toolchain and commit a generated `Cargo.lock`;
- verify the FoundationDB client `.deb` against its published SHA-256 `a3c451dd…`, which upstream downloads unchecked;
- move Go off 1.24 (D4).

A NuQ image is a small layer: `postgres:17.11-trixie` plus the pg_cron package. It builds acceptably on either machine.

## 5. Decisions awaiting the separate review

Each decision below is a change to the pinned baseline or a native-build uncertainty that later milestones inherit. M0 changed neither canonical document.

- **D1 — Browser version (security).** Pinned Playwright 1.58.1 bundles Chromium 145.0.7632.6 (rev 1208; arm64 archives exist). Chrome stable has shipped 829 security fixes since 2026-07-30, including two V8 bugs exploited in the wild: CVE-2026-85046, fixed in 152.0.7977.82, and CVE-2026-87491, fixed in 153.0.8010.36. Playwright 1.63.0 bundles 153.0.8010.12.
  - *Proposal:* the project-owned browser worker is not upstream's Playwright service, so choose its Playwright/Chromium pair in M2. Take the newest release whose Chromium is at or above 153.0.8010.36; if none exists yet, take the newest available, with the §20 isolation controls and the residual risk recorded. Package and binary move together.
- **D2 — 16 KiB-page kernel (native-build/runtime uncertainty).** `CONFIG_ARM64_16K_PAGES=y`, and only `kernel_2712.img` is present (no 4K `kernel8.img`). The pinned tree has no jemalloc. The Redis 7.x and 8.10 images build jemalloc with `--with-lg-page=16` on arm64. Chromium's launch on this kernel is unproven.
  - *Proposal:* keep the 16K kernel. M1 proves a native start of each data/core image, and M2 proves Chromium. The only fallback is installing `linux-image-rpi-v8` with `kernel=kernel8.img` and rebooting, which needs owner approval and is used only if a mandatory component fails.
- **D3 — RabbitMQ series.** Upstream Compose uses `rabbitmq:3-management` (3.13.7), whose community support has ended. 4.3.6 is the only community-supported series, until 2026-11-30, and fixes the 2026-08 and 2026-09 advisories (two rated high). NuQ declares only quorum queues plus one exclusive classic reply queue, both valid on 4.x (`source-review.json` S14).
  - *Proposal:* `rabbitmq:4.3.6` without the management plugin, gated by an M1 NuQ round-trip test.
- **D4 — Go build stage.** `golang:1.24` resolves to 1.24.13 and is out of support; go.dev lists 1.27.1 and 1.26.8.
  - *Proposal:* any project source build of the API uses a supported Go (1.26.x), which `go.mod`'s `go 1.23` / `toolchain go1.24.0` permits. This is moot for M1 if D6 chooses option A.
- **D5 — MCP SDK patch.** `@modelcontextprotocol/server@2.0.0` (node ≥20) is confirmed, and 2026-07-28 is still the current stable protocol. 2.1.0 (2026-09-23) adds 4 MiB body and 100-message batch caps (#2698) and rejects modern requests missing `MCP-Protocol-Version` (#2590). 2.0.0 does neither, yet the project contract requires both. No GHSA exists for the v2 packages.
  - *Proposal:* adopt server/core/node 2.1.0 for M4 and update the baseline row in both canonical documents.
- **D6 — M1 image source.** Spec §3.2 says to build from pinned source plus a patch series, while M1 permits "build or acquire".
  - *Proposal:* M1 acquires option A by digest, and builds the NuQ image from the pinned Dockerfile with a digest-pinned `FROM`. M2's patched image is built on the Mac (option B), with option C only as a fallback.

Selected without escalation, because they are same-major security patches: Node 22.23.3 (≥ security release 22.23.2), PostgreSQL 17.11 (fixes 28 CVEs), Redis 8.10.2-alpine (the floating `redis:alpine` resolves to it and it carries the Aug/Sep fixes), and SearXNG `2026.9.23-3cd69d30e`.

- **Firecrawl:** no post-2026-07-30 advisory affects v2.11.162. The self-host guide still pins it. v2.11.402 is not adopted.
- **Open upstream items at the pin**, handled by M2's SSRF layer and patch series:
  - `ip-address@6.4.0` (GHSA-mwp4-54f8-5fhr);
  - redirect-to-blocklist fix `58d0c8ebb6`, a cherry-pick candidate;
  - the unauthenticated `/admin/integration/*` proxy to `integrations.firecrawl.dev`. The gateway must never route `/admin/*`.

## 6. Owner input registered

- **B1:** approve adding `cgroup_enable=memory` to `/boot/firmware/cmdline.txt` and one reboot, stating a time when a short DNS/MQTT outage is acceptable.
- **B2:** is a fan fitted to the Pi, for example the Active Cooler? The fan header reads 0 rpm at PWM 75/255, which a tach-less fan and an absent fan produce identically. Idle 48.3 °C; `get_throttled=0x0` since boot; EXT5V 5.17 V; `usb_max_current_enable=1`.

## 7. Integrity and side effects

- **Diff:** BEFORE (03:15:30Z) and AFTER (03:36:18Z) differ only in the excluded `session-<n>.scope` lines; the boot ID is unchanged (V08).
- **Unavoidable effects of the audit's own access:**
  - SSH and sudo entries in the journal and auth log;
  - `user@1000.service` and `/run/user/1000` for the duration of each login (present in both snapshots);
  - one outbound HTTPS GET to `api.ipify.org`.
- **Module ambiguity:** `tcp_diag` and `inet_diag` are the two most recently loaded modules, and the BEFORE snapshot ran `ss` before reading `lsmod`. So M0 cannot tell whether its first `ss` loaded them, or an earlier `ss` did during the 2.3-day uptime. `udp_diag` does not exist for this kernel, so UDP queries could not load anything. These modules only serve socket-statistics queries; they change no port, service or rule. They were left loaded, because unloading them could remove state that predates M0.
- **Probe correction:** P1 checked tools with a PATH lacking `/usr/sbin`. P3 re-checked by explicit PATH and supersedes it: `nft`, `zramctl`, `dumpe2fs`, `sshd`, `losetup`, `iw` and `sysctl` are present. P1 also read `/proc/sys` through `sysctl`; P2 read those values directly.
- **Later milestones:** `pi-snapshot.sh` should read `lsmod` before running `ss`, and set PATH explicitly.

## Evidence index

`audit.json` · `verification.json` · `snapshot-{before,after,diff}.txt` · `raw/pi-audit{,-extra,-paths,-layout}.txt` · `network-exposure.json` · `runtime-candidates.json` · `source-review.json` · `upstream/` (findings, raw extracts) · `security-review.md` · `registry/` (index and arm64 manifest bytes, `digests.jsonl`) · `../../deploy/versions.lock.json`.
