# B1 remedy — applied

Owner approval: 2026-09-25, for the `cgroup_enable=memory` token and one reboot, accepting the Pi-hole DNS / MQTT outage.

| Step | UTC | Record |
|---|---|---|
| Pre-change snapshot | 2026-09-25T04:32:07Z | `snapshot-before.txt` (`scripts/m0/pi-snapshot.sh`). Against `../snapshot-after.txt` it differs only in the SSH `session-<n>.scope` line. |
| Pre-change state | 2026-09-25T04:31:37Z | `/proc/cmdline` carries `cgroup_disable=memory` (firmware-added); `/sys/fs/cgroup/cgroup.controllers` = `cpuset cpu io pids`. |
| Backup | 2026-09-25T04:32Z | `/boot/firmware/cmdline.txt.pre-B1` (`cp -p`), SHA-256 `7d49c4a6ae311513f8ac4d6666b36ff0ca70d62944948eef44d2d7d603853375`. |
| Edit | 2026-09-25T04:32Z | ` cgroup_enable=memory` appended to the single line of `/boot/firmware/cmdline.txt`, no trailing newline, as before. New SHA-256 `c259bd2d991306567aef85d2a3fc3f316c1fcd93a5162d75948761adec88bc0e`. No other token changed. |
| Reboot | 2026-09-25T04:32:54Z | `systemd-run --on-active=2 systemctl reboot`. |

**Confirmed by the M0 re-check (06:23Z–06:34Z):** `memory` is present in `/sys/fs/cgroup/cgroup.controllers` and delegated from the root (`subtree_control=cpu memory pids`); `/proc/cmdline` carries `cgroup_enable=memory` after `cgroup_disable=memory`; the owner services are active; V01–V08 pass with a fresh BEFORE/AFTER pair (`../verification.json`). `reboot-diff.txt` attributes every difference between the pre-change state and the re-check BEFORE.

**Rollback:** `sudo cp -p /boot/firmware/cmdline.txt.pre-B1 /boot/firmware/cmdline.txt` and reboot. If the host cannot be reached, apply the same copy with the card's FAT boot partition mounted on another machine.

## Post-reboot outage (not caused by B1)

The host booted but stayed off the LAN from 04:32:54Z to 05:26:22Z. The stored Wi-Fi credential no longer matched the owner's network `Terafab`, which had changed while the old association held. The kernel side of B1 was confirmed over a temporary Ethernet link to the workstation (05:21Z): `/proc/cmdline` carries `cgroup_disable=memory` then `cgroup_enable=memory`, and `/sys/fs/cgroup/cgroup.controllers` = `cpuset cpu io memory pids`, with no failed units and pihole-FTL, mosquitto and fail2ban active.

Owner-network changes made to restore Wi-Fi, which the M0 re-check must attribute rather than treat as drift:

- NetworkManager profile `Terafab`: the pre-shared key was replaced with the owner's current one (never written to the repository), and `802-11-wireless-security.pmf` is now explicitly `optional`. `key-mgmt` stays `wpa-psk`, and `ipv4.method` stays `auto`.
- A temporary profile `yol` was created and deleted; none remains.
- At reconnection the router's `Terafab` was 5 GHz only, on channel 100 (5500 MHz, DFS), at about -75 dBm. Join attempts failed with `status_code=16` until 05:26:22Z. The owner made no router change at that time; the network disappeared from scans for about a minute before the join succeeded, which points to a router-side restart of that network.
- WPA3 (SAE) does not work with this host's Wi-Fi chip (BCM4345/6, firmware 7.45.265): each SAE attempt logged `brcmf_cyw_mgmt_tx: TX Auth frame operation is failed: status=10` (kernel log, 05:08–05:09Z, `../raw/pi-audit-kernel-log.txt`). The profile therefore uses WPA2 against the router's WPA2/WPA3 mixed mode.
- The host regained `158.205.34.18/24` by DHCP on wlan0. A temporary eth0 link to the workstation (192.168.2.2/24 via macOS Internet Sharing) carried the diagnosis from 05:21Z; it was unplugged before the re-check, where eth0 reads NO-CARRIER, as in the original audit.
