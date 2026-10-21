# The host after the OS change, against before it (CLAUDE.md §33.1)

The Pi was moved to a new SD card with a new operating system on 2026-10-20/21: Kali GNU/Linux Rolling, kernel 6.12.34+rpt-rpi-2712, aarch64, hostname `pi`. `snapshot-before-migration.txt` (2026-10-20 17:52Z, the old system, before this session's first change) differs from the sixth release's `release-6/snapshot-after.txt` in five lines: the time, the sampled `fcpi-probe.timer` (a timer is listed only while its service runs) and the SSH session scope. `snapshot-before-patch.txt` (2026-10-21 00:24Z, the new system, before any change made on it) is the baseline of the seventh release and is compared with it here. The deployed commit (`2f55fee45906`), the version lock (`2e53fe4b6122`), the 15 containers, their ids and the three `retained-ecb8733` image tags are the same on both sides (`status-before-migration.txt`, `status-before-patch.txt`).

## What differs

| Section | before-only / now-only | Cause |
|---|---|---|
| `meta` | 2 / 2 | The time and the boot id (a new boot of a new system). |
| `systemd_running` | 2 / 14 | Gone: an SSH session scope and `systemd-udevd-control.socket`. New: the desktop session stack of this image (`lightdm`, `accounts-daemon`, `polkit`, `rtkit-daemon`, `user@116`, two session scopes), `rsyslog` and `syslog.socket`, `systemd-userdbd` and two `varlink` sockets, and `serial-getty@ttyAMA10`. |
| `systemd_enabled` | 5 / 35 | Gone: `apparmor`, `apt-daily` and `apt-daily-upgrade` timers, `rpi-eeprom-update`, `wpa_supplicant`. New: this image's own units (cloud-init's six, `enable-ssh`, `runonce`, `regenerate-ssh-host-keys`, `rpi-imager-fixup`, `copy-user-wpasupplicant`, `networking`, `NetworkManager-wait-online`), the desktop and its helpers (`lightdm`, `accounts-daemon`, `polkit-agent-helper.socket`, `bluetooth`, `hciuart`, `cups.path`, `pcscd.socket`, `tpm-udev.path`), and housekeeping timers (`sysstat-*`, `man-db`, `plocate-updatedb`, `e2scrub_all`, `phpsessionclean`, `band-prefer`). |
| `lsmod` | 24 / 39 | A different kernel build and module set. New: `ip_tables`, `iptable_filter`, `iptable_nat`, `iptable_mangle`, `iptable_raw` and the `ip6` equivalents, loaded because Docker's rules are in the legacy backend (below). Gone: `nft_compat`, `nft_chain_nat`. |
| `ss_listen` | 33 / 33 | The listener set is the same (address, port, program): the differences are process ids, the ephemeral ports of `avahi-daemon` and `tailscaled`, and this kernel printing the tailnet address with its `%tailscale0` scope. `sshd` on 22, `pihole-FTL`, `mosquitto` and `tailscaled` on the tailnet's 8443 are all present on both sides. |
| `findmnt` | 27 / 30 | The root filesystem is still `/dev/mmcblk0p2` ext4, now `rw,relatime,errors=remount-ro` where it was `rw,noatime`; the Docker network namespace mounts (new ids); the desktop session's `/run/user/116` and `gvfs` mounts, `/run/rpc_pipefs` and `serial-getty`'s credentials mount; and tmpfs sizes at this image's defaults. |
| `firewall` | 2 / 2 | The raw nft hash (`b8fdb7a5…` to `057aeb8f…`) and the legacy iptables hash (`SKIPPED` to `b412eeb2…`): see below. |
| `nft_tables`, `nft_chains` | 7 / 0 and 35 / 0 | Docker's tables and chains (`ip filter`, `ip nat`, `ip mangle`, `ip raw` and their `DOCKER*` chains) are no longer in nftables: see below. |

Identical: `docker_activation` (dockerd's start gate), `docker_ps`, `swap_zram`, `forwarding` and the top section.

## Firewall

On this system `iptables` points at `iptables-legacy` (the alternative is in manual mode, with `iptables-nft` the best version), and Docker (29.8.1, "Firewall Backend: iptables") puts its rules there. Neither `nft -s list ruleset` nor `scripts/host/pi-firewall.sh` sees them: `firewall-before-patch.txt` reports the same hash `057aeb8f…` for the raw ruleset, the canonical one and the guard table, and no order-insensitive chain, because the ruleset holds exactly one table, `inet fcpi_guard`. The record of Docker's rules is the snapshot's `iptables_legacy_sha256` (`b412eeb2…`; 67 filter, 14 nat, 7 mangle and 5 raw lines).

The project's own table was compared with `deploy/host/fcpi-guard.nft` rule for rule: the same 11 forward rules and 9 input rules in the same order, the same `egress_special_v4` ranges, and `egress_local_v4` filled in at start by `fcpi-egress-local.sh` from the host's own networks. Its hash differs from the old system's (`f291c0ce…`) although no rule does; the listing's other inputs are the elements of `egress_local_v4`, filled in from the host's networks, and this nft version's rendering, and the record cannot separate the two. What Docker's legacy rules do, read directly: `FORWARD` policy `DROP`; one `DNAT` for the gateway (`! -i fcpi-access`, port 3380 to 3300, bound to loopback); three `DROP` rules in the raw table's `PREROUTING` that guard direct access to container addresses; one `DOCKER-USER` rule. `docker ps` shows only the gateway published, on the loopback address.

`lan-probe-after-migration.txt` (from the workstation, a LAN neighbour): every project port closed (14 of 14), `sshd` on 22 open as the positive control.

## The project's host invariants (CLAUDE.md §33.1)

- **dockerd's start is gated:** `docker.service.d` holds `10-fcpi-data-check`, `20-fcpi-guard` (`nft -f /etc/firecrawl-pi/fcpi-guard.nft`), `30-fcpi-egress-local` and `40-fcpi-docker-log-repair`; the `docker_activation` section is identical.
- **The gateway's bridge stays closed:** the guard's `access_forward_*` and `access_input_new_dropped` rules are loaded (the input drop had counted 24 packets).
- **NetworkManager leaves Docker alone:** `90-fcpi-unmanaged.conf` is present with `veth*`, `fcpi-*` and `docker0`; `nmcli` lists the bridges `unmanaged`; `wlan0` is the connected uplink.
- **`fcpi-stack.service` Wants `docker.service`** and Requires `fcpi-data-check.service`; it is enabled.
- **Secrets:** `/etc/firecrawl-pi/secrets` is 0700 root; 75 of its 76 files are 0600 and the other is `backup/ssh_ed25519.pub`, a public key at 0644 from 2026-09-28; owners are the service uids and root.
- **Not re-verified here:** the core's DML-only database role and each container's DNS upstream (compose settings that did not change) are exercised by `fcpi verify functional` after the cutover.

## Settings of this system worth knowing

- `sshd`: `PasswordAuthentication no`, `PermitRootLogin no`, `PubkeyAuthentication yes`. The host key is the old system's (the pinned known-hosts entry accepted it).
- Time: `America/New_York`, NTP synchronised.
- AppArmor is not active (`/sys/module/apparmor/parameters/enabled` is `N`, `lsm` is `capability`). The earlier snapshots list only `apparmor.service` as enabled and say nothing of whether the module was active, so there is no baseline to call this a change. The project's containers are confined by seccomp (builtin), `no-new-privileges`, all capabilities dropped, a read-only root and no privileged mode.
- The root filesystem no longer mounts `noatime`, so file reads now cause writes on the SD card.
- A desktop session (`lightdm`) is running, with no listener of its own in `ss_listen`. Host memory available was 4,996 MiB at the baseline (4,834 MiB before the move).

## What was done on the Pi

Before the move, on the old system: `fcpi backup` (`backup-pre-migration.txt`) and the three `retained-ecb8733` image tags (`retained-release-6.txt`). On the new system, in this order: the read-only collection above; `fcpi backup` (`backup-patch.txt`, PASS); `fcpi restore-test` (`restore-test-patch.txt`, PASS: 1,293 files, 0 mismatched, the restored version lock matches the backup's, 271 s, no transient container left); staging the candidate `e98fc5d5bcc3` and building the three service images from it (`image-build.txt`).
